/**
 * Linear webhook verification and AgentSessionEvent classification.
 *
 * Linear signs the raw request body with HMAC-SHA256 (hex) in the `linear-signature` header
 * and includes `webhookTimestamp` (ms) in the payload for replay protection.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "linear-signature";
const MAX_CLOCK_SKEW_MS = 60_000;

export function signBody(rawBody: Buffer | string, secret: string): string {
	return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhook(
	rawBody: Buffer,
	signature: string | undefined,
	secret: string,
	now = Date.now(),
): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
	if (!signature) return { ok: false, reason: "missing signature" };
	const expected = Buffer.from(signBody(rawBody, secret), "hex");
	const given = Buffer.from(signature, "hex");
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
		return { ok: false, reason: "invalid signature" };
	}
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
	} catch {
		return { ok: false, reason: "invalid JSON" };
	}
	const ts = payload.webhookTimestamp;
	if (typeof ts === "number" && Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
		return { ok: false, reason: "stale webhook timestamp" };
	}
	return { ok: true, payload };
}

export type AgentWebhookEvent =
	| {
			kind: "created";
			sessionId: string;
			issueId: string;
			issueIdentifier?: string;
			promptContext?: string;
			commentBody?: string;
			creatorName?: string;
	  }
	| {
			kind: "prompted";
			sessionId: string;
			issueId?: string;
			body: string;
			signal?: string;
			authorName?: string;
	  }
	| { kind: "ignored"; reason: string };

function obj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

export function classifyWebhook(payload: Record<string, unknown>): AgentWebhookEvent {
	if (payload.type !== "AgentSessionEvent") return { kind: "ignored", reason: `type ${String(payload.type)}` };
	const session = obj(payload.agentSession);
	const sessionId = str(session.id);
	if (!sessionId) return { kind: "ignored", reason: "no agent session id" };
	const issue = obj(session.issue);
	const issueId = str(session.issueId) ?? str(issue.id);

	if (payload.action === "created") {
		if (!issueId) return { kind: "ignored", reason: "agent session without an issue" };
		return {
			kind: "created",
			sessionId,
			issueId,
			issueIdentifier: str(issue.identifier),
			promptContext: str(payload.promptContext),
			commentBody: str(obj(session.comment).body),
			creatorName: str(obj(session.creator).name),
		};
	}
	if (payload.action === "prompted") {
		const activity = obj(payload.agentActivity);
		const content = obj(activity.content);
		return {
			kind: "prompted",
			sessionId,
			issueId,
			body: str(content.body) ?? "",
			signal: str(activity.signal),
			authorName: str(obj(activity.user).name),
		};
	}
	return { kind: "ignored", reason: `action ${String(payload.action)}` };
}

export function isStopRequest(event: Extract<AgentWebhookEvent, { kind: "prompted" }>): boolean {
	return event.signal === "stop" || /^\s*stop(\s+session|\s+working)?[\s.!?]*$/i.test(event.body);
}
