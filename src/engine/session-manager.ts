/**
 * Routes Linear agent session events to epic runs.
 *
 * - `created`  : acknowledge immediately (Linear expects an activity within seconds), then queue a run.
 * - `prompted` : "stop" aborts the run; anything else is guidance. While running it is picked up by the
 *                next story iteration; when paused it resets exhausted stories and resumes the loop.
 */
import { ActivityReporter } from "../agent/activity.js";
import type { AgentWebhookEvent } from "../linear/webhook.js";
import { isStartAnywayRequest, isStopRequest } from "../linear/webhook.js";
import type { EngineDeps } from "./epic-engine.js";
import { EpicEngine } from "./epic-engine.js";
import { PARKED, type SessionRecord, type SessionStore, newRecord } from "./store.js";

const RESOLVED_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Linear always fills `agentSession.comment.body`; for a delegation (not an @mention) it holds a
 * system note containing this marker. Cyrus uses the same check to tell the two apart.
 */
export const AGENT_SESSION_MARKER = "This thread is for an agent session";
/** In a mention or reply, opts into running the epic's story loop (`/label-based-prompt` is Cyrus' spelling). */
const LOOP_COMMAND = /(^|\s)\/(ralph|label-based-prompt)\b/i;

export function parseInstruction(body: string | undefined): { text: string; wantsLoop: boolean } {
	const raw = (body ?? "").trim();
	const wantsLoop = LOOP_COMMAND.test(raw);
	const text = raw
		.replace(LOOP_COMMAND, " ")
		.replace(/^\s*@[\w.-]+[,:]?\s*/, "")
		.trim();
	return { text, wantsLoop };
}

interface Active {
	abort: AbortController;
	done: Promise<void>;
}

export class SessionManager {
	private readonly engine: EpicEngine;
	private readonly active = new Map<string, Active>();
	private readonly queue: string[] = [];
	/** Branch/issue currently being worked, to avoid two sessions fighting over one worktree. */
	private readonly busyIssues = new Map<string, string>();
	/** Worktree path -> session id; an epic session and a story session share one branch. */
	private readonly busyWorktrees = new Map<string, string>();
	private readonly toldQueued = new Set<string>();
	/** Delivers a message into the agent session currently running for a cyralph session. */
	private readonly injectors = new Map<string, (text: string) => boolean>();

	constructor(
		private readonly deps: EngineDeps,
		private readonly store: SessionStore,
	) {
		this.engine = new EpicEngine(deps);
	}

	private reporter(sessionId: string) {
		return new ActivityReporter(this.deps.linear, sessionId, this.deps.log);
	}

	async handle(event: AgentWebhookEvent): Promise<void> {
		if (event.kind === "created") return this.onCreated(event);
		if (event.kind === "prompted") return this.onPrompted(event);
		if (event.kind === "issue_state") {
			if (this.store.waitingOnIssue(event.issueId).length === 0) return;
			// Issue webhooks don't always carry the state type; ask Linear when missing.
			let stateType = event.stateType;
			if (!event.removed && !stateType) stateType = (await this.deps.linear.getIssue(event.issueId)).stateType;
			if (event.removed || (stateType && RESOLVED_STATE_TYPES.has(stateType))) {
				await this.onIssueResolved(event.issueId, event.removed ? "was deleted" : stateType === "canceled" ? "was canceled" : "is done");
			}
		}
	}

	/** A blocker was completed/canceled/deleted: wake every session parked on it. */
	async onIssueResolved(issueId: string, how = "is done"): Promise<void> {
		for (const record of this.store.waitingOnIssue(issueId)) {
			const blocker = record.waitingOn.find((w) => w.id === issueId);
			record.waitingOn = record.waitingOn.filter((w) => w.id !== issueId);
			await this.store.save(record);
			await this.reporter(record.sessionId).thought(`${blocker?.identifier ?? "A blocking issue"} ${how}. Re-checking blockers and resuming.`);
			this.enqueue(record);
		}
	}

	/**
	 * Fallback for missed webhooks (downtime, Issue webhooks not enabled): look up the state of every
	 * blocker parked sessions wait on and wake the ones that resolved. Run at startup and periodically.
	 */
	async reconcileParked(): Promise<void> {
		const ids = new Set(
			this.store
				.all()
				.filter((r) => PARKED.has(r.status))
				.flatMap((r) => r.waitingOn.map((w) => w.id)),
		);
		for (const id of ids) {
			try {
				const issue = await this.deps.linear.getIssue(id);
				if (RESOLVED_STATE_TYPES.has(issue.stateType)) await this.onIssueResolved(id, issue.stateType === "canceled" ? "was canceled" : "is done");
			} catch (err) {
				// Deleted or no longer visible: stop waiting on it.
				this.deps.log.warn(`blocker ${id} lookup failed (${String(err)}); treating as resolved`);
				await this.onIssueResolved(id, "is no longer accessible");
			}
		}
	}

	private async onCreated(event: Extract<AgentWebhookEvent, { kind: "created" }>) {
		const reporter = this.reporter(event.sessionId);
		void reporter.thought("Picked this up. Reading the epic and its stories…", true);

		const record = this.store.get(event.sessionId) ?? newRecord(event.sessionId, event.issueId, event.issueIdentifier);
		// Carry learnings forward when an issue is re-delegated in a new session.
		const previous = this.store.latestForIssue(event.issueId);
		if (previous && previous.sessionId !== record.sessionId) {
			record.branch ??= previous.branch;
			record.prUrl ??= previous.prUrl;
			record.prNumber ??= previous.prNumber;
			record.guidance = [...previous.guidance];
			record.completedKeys = [...previous.completedKeys];
		}
		const isMention = !!event.commentBody?.trim() && !event.commentBody.includes(AGENT_SESSION_MARKER);
		if (isMention) {
			const { text, wantsLoop } = parseInstruction(event.commentBody);
			// Like Cyrus: a mention addresses its comment; only delegation (or `/ralph`) works the epic.
			record.mode = wantsLoop ? "epic" : "request";
			if (text) {
				if (wantsLoop) record.guidance.push(text);
				record.pendingRequests.push(text);
			}
			// The epic is being worked right now: hand the mention to that live agent.
			if (!wantsLoop && text && this.injectIntoIssue(event.issueId, text)) {
				await this.store.save(record);
				await reporter.response("Passed this to the agent that's working on this epic right now; it will answer in that session.");
				return;
			}
		}
		await this.store.save(record);
		this.enqueue(record);
	}

	private async onPrompted(event: Extract<AgentWebhookEvent, { kind: "prompted" }>) {
		const reporter = this.reporter(event.sessionId);
		const record = this.store.get(event.sessionId) ?? (event.issueId ? newRecord(event.sessionId, event.issueId) : undefined);
		if (!record) {
			await reporter.response("I don't have any state for this session.");
			return;
		}

		if (isStopRequest(event)) {
			const active = this.active.get(record.sessionId);
			const queuedAt = this.queue.indexOf(record.sessionId);
			if (queuedAt >= 0) this.queue.splice(queuedAt, 1);
			record.status = "stopped";
			await this.store.save(record);
			if (active) {
				active.abort.abort();
				await reporter.thought(`Stopping${event.authorName ? ` (requested by ${event.authorName})` : ""}…`);
			} else {
				await reporter.response("Stopped.");
			}
			return;
		}

		const { text, wantsLoop } = parseInstruction(event.body);
		if (isStartAnywayRequest(text)) {
			record.ignoreBlockers = true;
			record.waitingOn = [];
		} else if (text) {
			// Running: deliver into the live agent session, as Cyrus streams follow-ups.
			const inject = this.injectors.get(record.sessionId);
			if (inject?.(text)) {
				if (record.mode === "epic") record.guidance.push(text); // later stories should know too
				await this.store.save(record);
				await reporter.thought("Passed this to the agent that's working right now.");
				return;
			}
			if (record.mode === "epic") record.guidance.push(text);
			record.pendingRequests.push(text);
		}
		if (wantsLoop && record.mode === "request") {
			record.mode = "epic";
			record.guidance.push(...record.pendingRequests.filter((r) => !record.guidance.includes(r)));
		}
		if (this.active.has(record.sessionId)) {
			await this.store.save(record);
			await reporter.thought(
				record.mode === "epic"
					? "Got it. I'll apply this from the next story iteration, or handle it directly once the stories are done."
					: "Got it. I'll handle this as soon as the current step finishes.",
			);
			return;
		}
		// Paused/finished/stopped: guidance earns every set-aside story a fresh set of attempts.
		record.attempts = {};
		await this.store.save(record);
		await reporter.thought("On it.");
		this.enqueue(record);
	}

	/** Deliver text into a live agent session working on this issue, if there is one. */
	private injectIntoIssue(issueId: string, text: string): boolean {
		const owner = this.busyIssues.get(issueId);
		const inject = owner ? this.injectors.get(owner) : undefined;
		return inject ? inject(text) : false;
	}

	private enqueue(record: SessionRecord) {
		if (this.active.has(record.sessionId) || this.queue.includes(record.sessionId)) return;
		record.status = "queued";
		void this.store.save(record);
		this.queue.push(record.sessionId);
		this.pump();
	}

	private pump() {
		while (this.active.size < this.deps.config.maxConcurrentSessions) {
			const idx = this.queue.findIndex((id) => {
				const r = this.store.get(id);
				return r && !this.busyIssues.has(r.issueId);
			});
			if (idx < 0) break;
			const [sessionId] = this.queue.splice(idx, 1);
			const record = sessionId ? this.store.get(sessionId) : undefined;
			if (record) this.start(record);
		}
		for (const id of this.queue) {
			if (this.toldQueued.has(id)) continue;
			this.toldQueued.add(id);
			void this.reporter(id).thought("Queued: waiting for a free agent slot.", true);
		}
	}

	private start(record: SessionRecord) {
		const abort = new AbortController();
		const reporter = this.reporter(record.sessionId);
		record.status = "running";
		this.busyIssues.set(record.issueId, record.sessionId);
		const done = (async () => {
			try {
				await this.store.save(record);
				const status = await this.engine.run({
					record,
					reporter,
					abortSignal: abort.signal,
					persist: () => this.store.save(record),
					setInjector: (inject) => {
						if (inject) this.injectors.set(record.sessionId, inject);
						else this.injectors.delete(record.sessionId);
					},
					claimWorktree: (path) => {
						const owner = this.busyWorktrees.get(path);
						if (owner && owner !== record.sessionId) return false;
						this.busyWorktrees.set(path, record.sessionId);
						return true;
					},
				});
				record.status = status;
			} catch (err) {
				record.status = "failed";
				this.deps.log.error(`session ${record.sessionId} crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
				await reporter.error(`cyralph hit an unexpected error: ${String(err)}`);
			} finally {
				await reporter.flush();
				await this.store.save(record);
				this.active.delete(record.sessionId);
				this.busyIssues.delete(record.issueId);
				this.toldQueued.delete(record.sessionId);
				this.injectors.delete(record.sessionId);
				for (const [path, owner] of this.busyWorktrees) if (owner === record.sessionId) this.busyWorktrees.delete(path);
				this.pump();
			}
		})();
		this.active.set(record.sessionId, { abort, done });
	}

	/** Resolves when all running sessions have finished (for tests and graceful shutdown). */
	async idle(): Promise<void> {
		while (this.active.size > 0) await Promise.all([...this.active.values()].map((a) => a.done));
	}

	async shutdown(): Promise<void> {
		for (const a of this.active.values()) a.abort.abort();
		await this.idle();
	}

	isActive(sessionId: string): boolean {
		return this.active.has(sessionId);
	}
}
