/**
 * One Ralph iteration = one fresh Claude Agent SDK session on one story.
 *
 * Input is streamed, so replies from the Linear thread can be delivered into the live session
 * (like Cyrus does) instead of waiting for the next iteration.
 */
import { randomUUID } from "node:crypto";
import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type RunnerEvent =
	| { type: "text"; text: string }
	| { type: "tool"; name: string; input: unknown }
	| { type: "tool_result"; isError: boolean; text: string }
	| { type: "system"; text: string };

export interface RunRequest {
	prompt: string;
	cwd: string;
	additionalDirectories?: string[];
	model?: string;
	fallbackModel?: string;
	allowedTools?: string[];
	disallowedTools?: string[];
	permissionMode: "bypassPermissions" | "acceptEdits" | "dontAsk" | "auto";
	abortSignal: AbortSignal;
	onEvent?: (event: RunnerEvent) => void;
	/** Replaces the story-mode system prompt addition (e.g. for direct requests). */
	systemAppend?: string;
	/** Claude session id to resume (keeps the earlier conversation). */
	resume?: string;
	/**
	 * Called with a function that delivers a message into the live session (or `undefined` once
	 * the session can no longer take input). The function returns false if it was too late.
	 */
	onInjector?: (inject: ((text: string) => boolean) | undefined) => void;
}

/** If an injected message never gets answered, stop waiting for it after this long. */
const INJECTION_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Async-iterable message queue used as streaming input to `query()`. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
	private items: SDKUserMessage[] = [];
	private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
	closed = false;

	push(msg: SDKUserMessage): void {
		if (this.closed) return;
		const w = this.waiting;
		if (w) {
			this.waiting = undefined;
			w({ value: msg, done: false });
		} else this.items.push(msg);
	}

	close(): void {
		this.closed = true;
		const w = this.waiting;
		this.waiting = undefined;
		w?.({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item) return Promise.resolve({ value: item, done: false });
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.waiting = resolve;
				});
			},
		};
	}
}

function userMessage(text: string, uuid: string, priority?: "next"): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		uuid: uuid as SDKUserMessage["uuid"],
		...(priority && { priority }),
		origin: { kind: "human" },
	};
}

export interface RunResult {
	/**
	 * The agent's final message. The completion signal is only honoured here, so an agent
	 * that merely mentions `<promise>COMPLETE</promise>` mid-run does not end the story.
	 */
	output: string;
	isError: boolean;
	aborted: boolean;
	sessionId?: string;
	costUsd?: number;
	numTurns?: number;
	errorMessage?: string;
}

export interface AgentRunner {
	run(req: RunRequest): Promise<RunResult>;
}

/** System prompt addition: the orchestrator owns git and Linear bookkeeping. */
export const RALPH_SYSTEM_APPEND = `You are "cyralph", an autonomous engineer working a Linear epic one user story at a time (the Ralph loop).
- Work only on the single story you are given; other stories get their own sessions.
- Never run git commit, git push, or open pull requests: the orchestrator handles version control and Linear updates.
- Be precise and verifiable. Only emit <promise>COMPLETE</promise> when the story truly meets its acceptance criteria.`;

export type HistoryRewritePolicy = "when-asked" | "never";

/** System prompt addition for direct requests from the Linear thread (Cyrus-style @mentions). */
export function requestSystemAppend(historyRewrite: HistoryRewritePolicy = "when-asked"): string {
	const rewrite =
		historyRewrite === "when-asked"
			? "- Don't rewrite history on your own initiative. When the request explicitly asks for it (rebase, squash, amend, reword), do it on the epic branch and push with `git push --force-with-lease`. That is allowed here."
			: "- Never rewrite published history or force-push in this repository. If asked to rebase or squash, explain that it is disabled here and offer to merge the base branch instead.";
	return `You are "cyralph", an autonomous engineer responding to a request in a Linear agent session about a PRD epic.
- Do what the request asks. You may use git (commit, push) and the repository's forge CLI (gh for GitHub, glab for GitLab, as named in the prompt) when the request calls for it.
- Only push the epic branch you are on. Never push to, or force-push, the base branch or any other branch.
${rewrite}
- Your final message is posted to the Linear thread: summarise what you did, with links (e.g. the PR/MR URL).`;
}

export const REQUEST_SYSTEM_APPEND = requestSystemAppend("when-asked");

function textOfToolResult(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : ""))
			.join("\n");
	}
	return "";
}

export class ClaudeAgentRunner implements AgentRunner {
	async run(req: RunRequest): Promise<RunResult> {
		const abortController = new AbortController();
		const onAbort = () => abortController.abort();
		if (req.abortSignal.aborted) abortController.abort();
		req.abortSignal.addEventListener("abort", onAbort, { once: true });

		const options: Options = {
			cwd: req.cwd,
			model: req.model,
			fallbackModel: req.fallbackModel,
			abortController,
			additionalDirectories: req.additionalDirectories,
			allowedTools: req.allowedTools,
			disallowedTools: req.disallowedTools,
			permissionMode: req.permissionMode,
			allowDangerouslySkipPermissions: req.permissionMode === "bypassPermissions",
			systemPrompt: { type: "preset", preset: "claude_code", append: req.systemAppend ?? RALPH_SYSTEM_APPEND },
			settingSources: ["project", "local"],
			...(req.resume && { resume: req.resume }),
		};

		// Streaming input: the session stays open until every message we sent has been answered.
		const input = new InputQueue();
		const outstanding = new Set<string>();
		const send = (text: string, priority?: "next") => {
			const id = randomUUID();
			outstanding.add(id);
			input.push(userMessage(text, id, priority));
		};
		send(req.prompt);
		let idleTimer: NodeJS.Timeout | undefined;
		const finishInput = () => {
			if (idleTimer) clearTimeout(idleTimer);
			req.onInjector?.(undefined);
			input.close();
		};
		req.onInjector?.((text) => {
			if (input.closed) return false;
			send(text, "next");
			return true;
		});
		abortController.signal.addEventListener("abort", finishInput, { once: true });

		const texts: string[] = [];
		let result: RunResult = { output: "", isError: false, aborted: false };
		try {
			for await (const msg of query({ prompt: input, options }) as AsyncIterable<SDKMessage>) {
				if (idleTimer) {
					clearTimeout(idleTimer);
					idleTimer = undefined;
				}
				if (msg.type === "assistant" && !msg.parent_tool_use_id) {
					for (const block of msg.message.content) {
						if (block.type === "text" && block.text.trim()) {
							texts.push(block.text);
							req.onEvent?.({ type: "text", text: block.text });
						} else if (block.type === "tool_use") {
							req.onEvent?.({ type: "tool", name: block.name, input: block.input });
						}
					}
				} else if (msg.type === "user" && !msg.parent_tool_use_id) {
					const content = msg.message.content;
					if (Array.isArray(content)) {
						for (const block of content) {
							if (typeof block === "object" && block.type === "tool_result") {
								req.onEvent?.({
									type: "tool_result",
									isError: block.is_error === true,
									text: textOfToolResult(block.content),
								});
							}
						}
					}
				} else if (msg.type === "result") {
					result = {
						output: msg.subtype === "success" ? msg.result : (texts[texts.length - 1] ?? ""),
						isError: msg.is_error,
						aborted: false,
						sessionId: msg.session_id,
						costUsd: msg.total_cost_usd,
						numTurns: msg.num_turns,
						errorMessage: msg.subtype === "success" ? undefined : msg.subtype,
					};
					// Which of our messages this turn answered; older producers don't say, so assume all.
					const answered = msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : [...outstanding]);
					for (const id of answered) outstanding.delete(id);
					if (outstanding.size === 0 || result.isError) finishInput();
					else idleTimer = setTimeout(finishInput, INJECTION_IDLE_TIMEOUT_MS);
				}
			}
		} catch (err) {
			const aborted = req.abortSignal.aborted;
			return {
				output: texts[texts.length - 1] ?? "",
				isError: !aborted,
				aborted,
				sessionId: result.sessionId,
				errorMessage: err instanceof Error ? err.message : String(err),
			};
		} finally {
			finishInput();
			req.abortSignal.removeEventListener("abort", onAbort);
		}
		if (!result.output) result.output = texts[texts.length - 1] ?? "";
		return { ...result, aborted: req.abortSignal.aborted };
	}
}
