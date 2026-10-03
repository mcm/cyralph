import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { SessionManager } from "../src/engine/session-manager.js";
import type { AgentWebhookEvent } from "../src/linear/webhook.js";
import { signBody } from "../src/linear/webhook.js";
import { silentLogger } from "../src/logger.js";
import { createWebhookServer } from "../src/server.js";

describe("webhook server", () => {
	it("verifies signatures and dispatches agent session events", async () => {
		const seen: AgentWebhookEvent[] = [];
		const manager = { handle: async (e: AgentWebhookEvent) => void seen.push(e) } as unknown as SessionManager;
		const server = createWebhookServer({ webhookSecret: "sec", manager, log: silentLogger });
		await new Promise<void>((r) => server.listen(0, r));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/linear-webhook`;
		const body = JSON.stringify({
			type: "AgentSessionEvent",
			action: "created",
			webhookTimestamp: Date.now(),
			agentSession: { id: "s1", issue: { id: "i1", identifier: "ENG-1" } },
		});
		const bad = await fetch(url, { method: "POST", body, headers: { "linear-signature": signBody(body, "nope") } });
		expect(bad.status).toBe(401);
		const ok = await fetch(url, { method: "POST", body, headers: { "linear-signature": signBody(body, "sec") } });
		expect(ok.status).toBe(200);
		await new Promise((r) => setTimeout(r, 20));
		expect(seen).toEqual([expect.objectContaining({ kind: "created", sessionId: "s1", issueId: "i1" })]);
		server.close();
	});

	it("checks webhooks against the current secret, so a reloaded one applies", async () => {
		const manager = { handle: async () => {} } as unknown as SessionManager;
		let secret = "old";
		const server = createWebhookServer({ webhookSecret: () => secret, manager, log: silentLogger });
		await new Promise<void>((r) => server.listen(0, r));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/linear-webhook`;
		const body = JSON.stringify({ type: "Unknown", webhookTimestamp: Date.now() });
		const post = (key: string) => fetch(url, { method: "POST", body, headers: { "linear-signature": signBody(body, key) } });
		expect((await post("old")).status).toBe(200);
		secret = "new";
		expect((await post("old")).status).toBe(401);
		expect((await post("new")).status).toBe(200);
		server.close();
	});
});
