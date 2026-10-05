import { describe, expect, it, vi } from "vitest";

type Msg = { uuid: string; message: { content: string } };
let behaviour: "separate-turns" | "folded" | "no-structured-output" = "separate-turns";
let lastOptions: Record<string, unknown> | undefined;

// A fake SDK query: answers each streamed user message with a result frame.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: ({ prompt, options }: { prompt: AsyncIterable<Msg>; options: Record<string, unknown> }) =>
		(async function* () {
			lastOptions = options;
			const it = prompt[Symbol.asyncIterator]();
			const first = await it.next();
			if (first.done) return;
			let pending: Msg[] = [first.value];
			while (pending.length) {
				const batch = pending;
				pending = [];
				yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: `working on ${batch.map((m) => m.message.content).join(" + ")}` }] } };
				// Give the test a chance to inject while the turn is in flight.
				await new Promise((r) => setTimeout(r, 20));
				if (behaviour === "folded") {
					// Messages sent mid-turn are folded into this turn's result.
					const extra = await Promise.race([it.next(), new Promise<null>((r) => setTimeout(() => r(null), 5))]);
					if (extra && !extra.done) batch.push(extra.value);
				}
				if (behaviour === "no-structured-output") {
					yield { type: "result", subtype: "error_max_structured_output_retries", is_error: true, session_id: "claude-1", total_cost_usd: 0.01, num_turns: 5, terminal_reason: "structured_output_retry_exhausted" };
					return;
				}
				yield {
					type: "result",
					subtype: "success",
					structured_output: options.outputFormat ? { answered: batch.map((m) => m.message.content) } : undefined,
					is_error: false,
					result: `answered ${batch.map((m) => m.message.content).join(" + ")}`,
					session_id: "claude-1",
					total_cost_usd: 0.01,
					num_turns: 1,
					user_message_uuids: batch.map((m) => m.uuid),
				};
				const next = await it.next();
				if (!next.done) pending.push(next.value);
			}
		})(),
}));

const { ClaudeAgentRunner } = await import("../src/agent/runner.js");

function start(runner: InstanceType<typeof ClaudeAgentRunner>, outputSchema?: Record<string, unknown>) {
	let inject: ((t: string) => boolean) | undefined;
	const done = runner.run({
		outputSchema,
		prompt: "story",
		cwd: process.cwd(),
		permissionMode: "bypassPermissions",
		abortSignal: new AbortController().signal,
		onInjector: (fn) => {
			inject = fn;
		},
	});
	return { done, inject: (t: string) => inject?.(t) ?? false, hasInjector: () => inject !== undefined };
}

describe("ClaudeAgentRunner streaming input", () => {
	it("keeps the session open until an injected message is answered", async () => {
		behaviour = "separate-turns";
		const r = start(new ClaudeAgentRunner());
		await new Promise((res) => setTimeout(res, 5));
		expect(r.inject("follow-up")).toBe(true);
		const result = await r.done;
		expect(result.output).toBe("answered follow-up");
		expect(result.sessionId).toBe("claude-1");
		expect(r.hasInjector()).toBe(false);
		expect(r.inject("too late")).toBe(false);
	});

	it("does not hang when the injected message is folded into the running turn", async () => {
		behaviour = "folded";
		const r = start(new ClaudeAgentRunner());
		await new Promise((res) => setTimeout(res, 5));
		r.inject("folded");
		const result = await r.done;
		expect(result.output).toBe("answered story + folded");
	});

	it("finishes after one turn when nothing is injected", async () => {
		behaviour = "separate-turns";
		const result = await start(new ClaudeAgentRunner()).done;
		expect(result.output).toBe("answered story");
	});

});

describe("ClaudeAgentRunner structured output", () => {
	const schema = { type: "object", properties: { answered: { type: "array" } } };

	it("asks for the JSON schema and returns the last turn's structured result, also with injected messages", async () => {
		behaviour = "separate-turns";
		const r = start(new ClaudeAgentRunner(), schema);
		await new Promise((res) => setTimeout(res, 5));
		r.inject("guidance");
		const result = await r.done;
		expect(lastOptions?.outputFormat).toEqual({ type: "json_schema", schema });
		expect(result.structured).toEqual({ answered: ["guidance"] });
		expect(result.isError).toBe(false);
	});

	it("passes no output format without a schema", async () => {
		behaviour = "separate-turns";
		const result = await start(new ClaudeAgentRunner()).done;
		expect(lastOptions).not.toHaveProperty("outputFormat");
		expect(result.structured).toBeUndefined();
	});

	it("reports an agent that never produced valid structured output as an error", async () => {
		behaviour = "no-structured-output";
		const result = await start(new ClaudeAgentRunner(), schema).done;
		expect(result).toMatchObject({ isError: true, errorMessage: "error_max_structured_output_retries", structured: undefined });
	});
});
