/**
 * Routes Linear agent session events to epic runs.
 *
 * - `created`  : acknowledge immediately (Linear expects an activity within seconds), then queue a run.
 * - `prompted` : "stop" aborts the run; anything else is guidance. While running it is picked up by the
 *                next story iteration; when paused it resets exhausted stories and resumes the loop.
 */
import { ActivityReporter } from "../agent/activity.js";
import type { AgentWebhookEvent } from "../linear/webhook.js";
import { isStopRequest } from "../linear/webhook.js";
import type { EngineDeps } from "./epic-engine.js";
import { EpicEngine } from "./epic-engine.js";
import { type SessionRecord, type SessionStore, newRecord } from "./store.js";

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
		const instruction = event.commentBody?.trim();
		if (instruction && !/^@\S+$/.test(instruction)) record.guidance.push(instruction);
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

		const text = event.body.trim();
		if (text) record.guidance.push(text);
		if (this.active.has(record.sessionId)) {
			await this.store.save(record);
			await reporter.thought("Got it. I'll apply this from the next story iteration onward.");
			return;
		}
		// Paused/finished/stopped: guidance earns every set-aside story a fresh set of attempts.
		record.attempts = {};
		await this.store.save(record);
		await reporter.thought("Resuming the epic with your guidance.");
		this.enqueue(record);
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
