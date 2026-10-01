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
	| {
			/** An issue changed workflow state (or was deleted); may unblock parked sessions. */
			kind: "issue_state";
			issueId: string;
			identifier?: string;
			/** Workflow state type from the payload, when present ("completed", "canceled", ...). */
			stateType?: string;
			removed: boolean;
	  }
	| { kind: "ignored"; reason: string };

function obj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function classifyIssueWebhook(payload: Record<string, unknown>): AgentWebhookEvent {
	const data = obj(payload.data);
	const issueId = str(data.id);
	if (!issueId) return { kind: "ignored", reason: "issue webhook without id" };
	const removed = payload.action === "remove";
	const stateChanged = payload.action === "update" && "stateId" in obj(payload.updatedFrom);
	if (!removed && !stateChanged) return { kind: "ignored", reason: "issue update without state change" };
	return { kind: "issue_state", issueId, identifier: str(data.identifier), stateType: str(obj(data.state).type), removed };
}

export function classifyWebhook(payload: Record<string, unknown>): AgentWebhookEvent {
	if (payload.type === "Issue") return classifyIssueWebhook(payload);
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

/** "start anyway", "ignore the blockers", "go ahead anyway"… */
export function isStartAnywayRequest(body: string): boolean {
	return /\b(start|go|proceed|run|work on it|go ahead)\s+anyway\b|\bignore\s+(the\s+)?block(er|ers|ing|ed)?\b/i.test(body);
}

export function isStopRequest(event: Extract<AgentWebhookEvent, { kind: "prompted" }>): boolean {
	return event.signal === "stop" || /^\s*stop(\s+session|\s+working)?[\s.!?]*$/i.test(event.body);
}
