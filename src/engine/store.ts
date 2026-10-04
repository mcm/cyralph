/**
 * Durable per-agent-session state. Story completion itself lives in Linear (the tracker);
 * this only keeps what Linear cannot: attempts, feedback, guidance, workspace and PR.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionStatus = "queued" | "running" | "awaiting_input" | "blocked" | "completed" | "stopped" | "failed";

/**
 * - "epic": delegated work, which runs the Ralph loop over the epic's stories.
 * - "request": an @mention, which only acts on what the comment asks (as Cyrus does), with the epic as context.
 */
export type SessionMode = "epic" | "request";

/**
 * One repository an epic works in: its branch, worktree and PR/MR, and the requests (review findings,
 * CI failures) to work on there. The session record is the lane of its main repository; stories routed
 * to other repositories get a lane each in `lanes`.
 */
export interface RepoLane {
	repoId?: string;
	branch?: string;
	worktreePath?: string;
	prUrl?: string;
	prNumber?: number;
	/** The PR was seen closed or merged; it is no longer polled for reviews. */
	prClosed?: boolean;
	/** Whether the closed PR was merged (false: closed without merging); set when cyralph checked. */
	prMerged?: boolean;
	/** GitHub review ids already seen (acted on, skipped as stale, or over the round limit). */
	handledReviewIds?: number[];
	/** Automated reviews acted on for this PR (capped by `github.maxReviewRounds`). */
	reviewRounds?: number;
	/** PR/MR head commits whose failed CI was seen (acted on, or over the round limit). */
	handledCiShas?: string[];
	/** Failed CI pipelines acted on for this PR/MR (capped by `ci.maxFixRounds`). */
	ciFixRounds?: number;
	/** Claude session of the last direct request, resumed for follow-ups so the agent keeps its history. */
	requestClaudeSessionId?: string;
	/** Requests not yet acted on, run as a direct request session in this lane's worktree. */
	pendingRequests?: string[];
}

export interface SessionRecord extends RepoLane {
	sessionId: string;
	issueId: string;
	identifier?: string;
	status: SessionStatus;
	mode: SessionMode;
	/** How the repository was chosen (for the session log), e.g. "label `backend`". */
	routedBy?: string;
	/** Base branch from a `[repo=name#branch]` tag. */
	baseBranchOverride?: string;
	/** Repository ids offered in a pending "which repository?" elicitation. */
	repoSelection?: string[];
	/** Repositories other than `repoId` that stories of the epic routed to, by repository id. */
	lanes?: Record<string, RepoLane>;
	/** Iterations spent per story key. */
	attempts: Record<string, number>;
	/** Stories whose agent reported `<promise>BLOCKED</promise>`: set aside without retries until a reply. */
	blockedKeys?: string[];
	/** Why the last attempt of a story failed, fed into the next attempt. */
	lastFeedback: Record<string, string>;
	/** Follow-up instructions from the Linear session, included in every prompt. */
	guidance: string[];
	/**
	 * Instructions (from the @mention comment or replies) not yet acted on. A story iteration that
	 * saw them as guidance consumes them; otherwise they run as a direct request session.
	 */
	pendingRequests: string[];
	/** Completed story keys for in-memory ("prd" kind) epics that were not materialized. */
	completedKeys: string[];
	focusStoryKey?: string;
	/** Stories filed during this session as follow-ups of a story; a focused run works them too. */
	followUpKeys?: string[];
	/** Times each story was paused to wait on follow-ups it turned up (capped, so it can't loop forever). */
	followUpRounds?: Record<string, number>;
	/** Open issues (outside the epic) the run is parked on; resolving any of them wakes the session. */
	waitingOn: Array<{ id: string; identifier: string }>;
	/** A human said to start despite open blockers. */
	ignoreBlockers?: boolean;
	totalCostUsd: number;
	createdAt: string;
	updatedAt: string;
}

/** Every repository lane of a session: its main repository (the record itself) first. */
export function lanesOf(record: SessionRecord): RepoLane[] {
	return [record, ...Object.values(record.lanes ?? {})];
}

/** Whether any lane has requests waiting for a direct request session. */
export function hasPendingRequests(record: SessionRecord): boolean {
	return lanesOf(record).some((l) => (l.pendingRequests?.length ?? 0) > 0);
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
		mode: "epic",
		attempts: {},
		lastFeedback: {},
		guidance: [],
		pendingRequests: [],
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
			for (const r of data.sessions ?? []) this.records.set(r.sessionId, { ...r, mode: r.mode ?? "epic", waitingOn: r.waitingOn ?? [], pendingRequests: r.pendingRequests ?? [] });
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

	/** Resolves once every save so far is on disk. */
	flush(): Promise<void> {
		return this.writing.catch(() => {});
	}
}
