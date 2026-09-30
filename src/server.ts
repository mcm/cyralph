/**
 * Minimal HTTP server: `POST /linear-webhook` (signed Linear webhooks) and `GET /health`.
 * Webhooks are acknowledged immediately and processed asynchronously.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { SessionManager } from "./engine/session-manager.js";
import { SIGNATURE_HEADER, classifyWebhook, verifyWebhook } from "./linear/webhook.js";
import type { Logger } from "./logger.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

export function createWebhookServer(opts: { webhookSecret: string; manager: SessionManager; log: Logger }): Server {
	const { webhookSecret, manager, log } = opts;
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
		if (req.method !== "POST" || (url.pathname !== "/linear-webhook" && url.pathname !== "/webhook")) {
			return send(res, 404, { error: "not found" });
		}
		let raw: Buffer;
		try {
			raw = await readBody(req);
		} catch {
			return send(res, 413, { error: "body too large" });
		}
		const sig = req.headers[SIGNATURE_HEADER];
		const verified = verifyWebhook(raw, Array.isArray(sig) ? sig[0] : sig, webhookSecret);
		if (!verified.ok) {
			log.warn(`rejected webhook: ${verified.reason}`);
			return send(res, 401, { error: verified.reason });
		}
		const event = classifyWebhook(verified.payload);
		send(res, 200, { ok: true });
		if (event.kind === "ignored") {
			log.debug(`ignored webhook: ${event.reason}`);
			return;
		}
		log.info(`agent session ${event.kind}: ${event.sessionId}`);
		manager.handle(event).catch((err: unknown) => log.error(`webhook handling failed: ${String(err)}`));
	});
}
