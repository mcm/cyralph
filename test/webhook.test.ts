import { describe, expect, it } from "vitest";
import { classifyWebhook, isStopRequest, signBody, verifyWebhook } from "../src/linear/webhook.js";

describe("verifyWebhook", () => {
	const secret = "s3cret";
	const now = 1_700_000_000_000;
	const body = Buffer.from(JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: now }));

	it("accepts a valid signature", () => {
		expect(verifyWebhook(body, signBody(body, secret), secret, now).ok).toBe(true);
	});
	it("rejects bad or missing signatures", () => {
		expect(verifyWebhook(body, signBody(body, "other"), secret, now).ok).toBe(false);
		expect(verifyWebhook(body, undefined, secret, now).ok).toBe(false);
		expect(verifyWebhook(body, "zz", secret, now).ok).toBe(false);
	});
	it("rejects stale timestamps", () => {
		expect(verifyWebhook(body, signBody(body, secret), secret, now + 5 * 60_000)).toEqual({ ok: false, reason: "stale webhook timestamp" });
	});
});

describe("classifyWebhook", () => {
	it("classifies created", () => {
		const e = classifyWebhook({
			type: "AgentSessionEvent",
			action: "created",
			agentSession: { id: "sess", issue: { id: "iss", identifier: "ENG-1" }, comment: { body: "@cyralph go" } },
		});
		expect(e).toMatchObject({ kind: "created", sessionId: "sess", issueId: "iss", issueIdentifier: "ENG-1", commentBody: "@cyralph go" });
	});

	it("classifies prompted and stop", () => {
		const e = classifyWebhook({
			type: "AgentSessionEvent",
			action: "prompted",
			agentSession: { id: "sess", issueId: "iss" },
			agentActivity: { content: { type: "prompt", body: "Stop." }, signal: null },
		});
		expect(e.kind).toBe("prompted");
		if (e.kind === "prompted") expect(isStopRequest(e)).toBe(true);
		const s = classifyWebhook({
			type: "AgentSessionEvent",
			action: "prompted",
			agentSession: { id: "sess" },
			agentActivity: { content: { body: "please use pnpm" }, signal: "stop" },
		});
		if (s.kind === "prompted") expect(isStopRequest(s)).toBe(true);
	});

	it("ignores other events", () => {
		expect(classifyWebhook({ type: "Issue", action: "update" }).kind).toBe("ignored");
	});
});
