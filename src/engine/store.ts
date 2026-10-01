/**
 * Durable per-agent-session state. Story completion itself lives in Linear (the tracker);
 * this only keeps what Linear cannot: attempts, feedback, guidance, workspace and PR.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionStatus = "queued" | "running" | "awaiting_input" | "blocked" | "completed" | "stopped" | "failed";

export interface SessionRecord {
	sessionId: string;
	issueId: string;
	identifier?: string;
	status: SessionStatus;
	repoId?: string;
	branch?: string;
	worktreePath?: string;
	prUrl?: string;
	prNumber?: number;
	/** Iterations spent per story key. */
	attempts: Record<string, number>;
	/** Why the last attempt of a story failed, fed into the next attempt. */
	lastFeedback: Record<string, string>;
	/** Follow-up instructions from the Linear session, included in every prompt. */
	guidance: string[];
	/** Completed story keys for in-memory ("prd" kind) epics that were not materialized. */
	completedKeys: string[];
	focusStoryKey?: string;
	/** Open issues (outside the epic) the run is parked on; resolving any of them wakes the session. */
	waitingOn: Array<{ id: string; identifier: string }>;
	/** A human said to start despite open blockers. */
	ignoreBlockers?: boolean;
	totalCostUsd: number;
	createdAt: string;
	updatedAt: string;
}

/** Statuses in which a session may be woken by a blocker resolving. */
export const PARKED = new Set<SessionStatus>(["blocked", "awaiting_input"]);

export function newRecord(sessionId: string, issueId: string, identifier?: string): SessionRecord {
	const now = new Date().toISOString();
	return {
		sessionId,
		issueId,
		identifier,
		status: "queued",
		attempts: {},
		lastFeedback: {},
		guidance: [],
		completedKeys: [],
		waitingOn: [],
		totalCostUsd: 0,
		createdAt: now,
		updatedAt: now,
	};
}

export class SessionStore {
	private records = new Map<string, SessionRecord>();
	private writing: Promise<void> = Promise.resolve();

	constructor(private readonly file: string) {}

	async load(): Promise<void> {
		try {
			const data = JSON.parse(await readFile(this.file, "utf8")) as { sessions?: SessionRecord[] };
			for (const r of data.sessions ?? []) this.records.set(r.sessionId, { ...r, waitingOn: r.waitingOn ?? [] });
		} catch {
			// first run
		}
	}

	get(sessionId: string): SessionRecord | undefined {
		return this.records.get(sessionId);
	}

	all(): SessionRecord[] {
		return [...this.records.values()];
	}

	/** Parked sessions waiting on the given blocker issue. */
	waitingOnIssue(issueId: string): SessionRecord[] {
		return this.all().filter((r) => PARKED.has(r.status) && r.waitingOn.some((w) => w.id === issueId));
	}

	/** Most recent session for an issue (a re-delegation creates a new session on the same issue). */
	latestForIssue(issueId: string): SessionRecord | undefined {
		return this.all()
			.filter((r) => r.issueId === issueId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
	}

	save(record: SessionRecord): Promise<void> {
		record.updatedAt = new Date().toISOString();
		this.records.set(record.sessionId, record);
		const snapshot = JSON.stringify({ sessions: this.all() }, null, 2);
		this.writing = this.writing.then(async () => {
			await mkdir(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp`;
			await writeFile(tmp, snapshot, "utf8");
			await rename(tmp, this.file);
		});
		return this.writing;
	}
}
