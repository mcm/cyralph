/**
 * Posts agent activities to a Linear agent session, serialized so they appear in order,
 * and never throws into the engine (Linear hiccups must not kill a long epic run).
 */
import type { ActivityContent, ActivityOptions, LinearGateway, PlanStep } from "../linear/gateway.js";
import type { Logger } from "../logger.js";
import type { RunnerEvent } from "./runner.js";

const MAX_BODY = 8000;
const MAX_PARAM = 300;

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function summarizeToolInput(name: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const i = input as Record<string, unknown>;
	const pick = (...keys: string[]) => keys.map((k) => i[k]).find((v) => typeof v === "string") as string | undefined;
	switch (name) {
		case "Bash":
			return truncate(pick("command") ?? "", MAX_PARAM);
		case "Read":
		case "Write":
		case "Edit":
		case "NotebookEdit":
			return pick("file_path", "notebook_path") ?? "";
		case "Glob":
		case "Grep":
			return truncate(`${pick("pattern") ?? ""}${i.path ? ` in ${String(i.path)}` : ""}`, MAX_PARAM);
		case "WebFetch":
			return pick("url") ?? "";
		case "WebSearch":
			return pick("query") ?? "";
		case "Task":
		case "Agent":
			return truncate(pick("description", "prompt") ?? "", MAX_PARAM);
		default:
			return truncate(JSON.stringify(input), MAX_PARAM);
	}
}

export class ActivityReporter {
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly linear: LinearGateway,
		private readonly sessionId: string,
		private readonly log: Logger,
	) {}

	private post(content: ActivityContent, ephemeral?: boolean, extra?: Omit<ActivityOptions, "ephemeral">): Promise<void> {
		if ("body" in content) content = { ...content, body: truncate(content.body, MAX_BODY) };
		const opts = ephemeral === undefined && !extra ? undefined : { ...(ephemeral !== undefined && { ephemeral }), ...extra };
		this.chain = this.chain
			.then(() => this.linear.createActivity(this.sessionId, content, opts))
			.catch((err: unknown) => this.log.warn(`activity post failed for session ${this.sessionId}: ${String(err)}`));
		return this.chain;
	}

	thought(body: string, ephemeral?: boolean) {
		return this.post({ type: "thought", body }, ephemeral);
	}
	action(action: string, parameter: string, result?: string) {
		return this.post({ type: "action", action, parameter, ...(result !== undefined && { result }) }, result === undefined);
	}
	response(body: string) {
		return this.post({ type: "response", body });
	}
	error(body: string) {
		return this.post({ type: "error", body });
	}
	elicitation(body: string) {
		return this.post({ type: "elicitation", body });
	}
	/** An elicitation Linear renders as a picker of `options`. */
	select(body: string, options: string[]) {
		return this.post({ type: "elicitation", body }, undefined, { signal: "select", signalMetadata: { options: options.map((value) => ({ value })) } });
	}

	plan(steps: PlanStep[]): Promise<void> {
		this.chain = this.chain
			.then(() => this.linear.updateSessionPlan(this.sessionId, steps))
			.catch((err: unknown) => this.log.warn(`plan update failed for session ${this.sessionId}: ${String(err)}`));
		return this.chain;
	}

	externalUrl(label: string, url: string): Promise<void> {
		this.chain = this.chain
			.then(() => this.linear.addSessionExternalUrl(this.sessionId, label, url))
			.catch((err: unknown) => this.log.warn(`external url update failed: ${String(err)}`));
		return this.chain;
	}

	/** Mirror the agent's stream into the session: text as thoughts, tool calls as ephemeral actions. */
	onRunnerEvent = (event: RunnerEvent): void => {
		if (event.type === "text") void this.thought(event.text);
		else if (event.type === "tool" && event.name !== "TodoWrite") void this.action(event.name, summarizeToolInput(event.name, event.input));
	};

	flush(): Promise<void> {
		return this.chain;
	}
}
