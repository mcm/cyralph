/**
 * One Ralph iteration = one fresh Claude Agent SDK session on one story.
 */
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

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

/** System prompt addition for direct requests from the Linear thread (Cyrus-style @mentions). */
export const REQUEST_SYSTEM_APPEND = `You are "cyralph", an autonomous engineer responding to a request in a Linear agent session about a PRD epic.
- Do what the request asks. You may use git (commit, push) and the GitHub CLI (gh) when the request calls for it.
- Only push the epic branch you are on. Never force-push, rewrite published history, or push to the base branch.
- Your final message is posted to the Linear thread: summarise what you did, with links (e.g. the PR URL).`;

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
		};

		const texts: string[] = [];
		let result: RunResult = { output: "", isError: false, aborted: false };
		try {
			for await (const msg of query({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
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
				}
			}
		} catch (err) {
			const aborted = req.abortSignal.aborted;
			return {
				output: texts[texts.length - 1] ?? "",
				isError: !aborted,
				aborted,
				errorMessage: err instanceof Error ? err.message : String(err),
			};
		} finally {
			req.abortSignal.removeEventListener("abort", onAbort);
		}
		if (!result.output) result.output = texts[texts.length - 1] ?? "";
		return { ...result, aborted: req.abortSignal.aborted };
	}
}
