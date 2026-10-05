/**
 * Routes Linear agent session events to epic runs.
 *
 * - `created`  : acknowledge immediately (Linear expects an activity within seconds), then queue a run.
 * - `prompted` : "stop" aborts the run; anything else is guidance. While running it is picked up by the
 *                next story iteration; when paused it resets exhausted stories and resumes the loop.
 */
import { join, resolve, sep } from "node:path";
import { ActivityReporter } from "../agent/activity.js";
import type { Config, RepositoryConfig } from "../config.js";
import { type ChangeRequestRef, type CiStatus, buildCiFailureRequest, parseChangeRequestUrl } from "../git/ci.js";
import { type ReviewSubmitted, buildReviewRequest, githubRepoSlug, isReviewBot, parsePullRequestUrl } from "../github/reviews.js";
import type { AgentWebhookEvent } from "../linear/webhook.js";
import { isStartAnywayRequest, isStopRequest } from "../linear/webhook.js";
import type { EngineDeps } from "./epic-engine.js";
import { EpicEngine, leftBehindNote, stashLabel } from "./epic-engine.js";
import { asksForPushOrPullRequest } from "../ralph/prompt.js";
import type { StashEntry } from "../git/workspace.js";
import {
	DELETE_BRANCH,
	DROP_STASHES,
	PUSH_BRANCH,
	PUSH_STASHES,
	UNMERGED_BRANCH_TIMEOUT_MINUTES,
	cleanupOptions,
	matchCleanupAnswer,
	stashBranch,
} from "./cleanup.js";
import { matchSelection, selectionValue } from "./routing.js";
import { type CleanupRequest, PARKED, ROUTED_BY_SELECTION, type RepoLane, type SessionRecord, type SessionStore, lanesOf, moveToRepository, newRecord } from "./store.js";

/** A PR/MR cyralph opened: the session it belongs to and the repository lane it was opened from. */
interface LaneRef {
	record: SessionRecord;
	lane: RepoLane;
}

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
	/** Bound to the config at the time it was made; a run keeps the engine (and config) it started with. */
	private engine: EpicEngine;
	private readonly forgeProblems = new Set<string>();
	private readonly active = new Map<string, Active>();
	private readonly queue: string[] = [];
	/** Branch/issue currently being worked, to avoid two sessions fighting over one worktree. */
	private readonly busyIssues = new Map<string, string>();
	/** Worktree path -> session id; an epic session and a story session share one branch. */
	private readonly busyWorktrees = new Map<string, string>();
	private readonly toldQueued = new Set<string>();
	/** Delivers a message into the agent session currently running for a cyralph session, and the repository it works in. */
	private readonly injectors = new Map<string, { inject: (text: string) => boolean; repoId?: string }>();
	/** Webhook handlers still in flight, so a restart doesn't cut one off halfway. */
	private readonly handling = new Set<Promise<void>>();
	/** Set while waiting to restart for an update: nothing new starts, new work stays queued. */
	private draining = false;

	constructor(
		private deps: EngineDeps,
		private readonly store: SessionStore,
	) {
		this.engine = new EpicEngine(deps, this.forgeProblems);
	}

	/**
	 * Swap in a reloaded config. Runs already in progress keep the config they started with; queued and
	 * new work, polling and webhook handling use the new one.
	 */
	setConfig(config: Config): void {
		this.deps = { ...this.deps, config };
		this.engine = new EpicEngine(this.deps, this.forgeProblems);
		// maxConcurrentSessions may have gone up.
		this.pump();
	}

	private reporter(sessionId: string) {
		return new ActivityReporter(this.deps.linear, sessionId, this.deps.log);
	}

	/**
	 * Tell a session something that needs no further work. Linear marks a session active on any
	 * thought and expects a response to follow, so outside a run this is a response (completing the
	 * session again); otherwise the session sits active until Linear calls it "Stopped responding".
	 */
	private notify(sessionId: string, body: string): Promise<void> {
		const reporter = this.reporter(sessionId);
		const running = this.active.has(sessionId) || this.queue.includes(sessionId);
		return running ? reporter.thought(body) : reporter.response(body);
	}

	handle(event: AgentWebhookEvent): Promise<void> {
		const p = this.dispatch(event).finally(() => this.handling.delete(p));
		this.handling.add(p);
		return p;
	}

	private async dispatch(event: AgentWebhookEvent): Promise<void> {
		if (event.kind === "created") return this.onCreated(event);
		if (event.kind === "prompted") return this.onPrompted(event);
		if (event.kind === "issue_state") {
			const waiters = this.store.waitingOnIssue(event.issueId).length > 0;
			const merging = this.mergeCandidates(event.issueId).length > 0;
			if (!waiters && !merging) return;
			// Issue webhooks don't always carry the state type; ask Linear when missing.
			let stateType = event.stateType;
			if (!event.removed && !stateType) stateType = (await this.deps.linear.getIssue(event.issueId)).stateType;
			if (waiters && (event.removed || (stateType && RESOLVED_STATE_TYPES.has(stateType)))) {
				await this.onIssueResolved(event.issueId, event.removed ? "was deleted" : stateType === "canceled" ? "was canceled" : "is done");
			}
			// Done after its PR/MR merged: the worktree and branch aren't needed anymore.
			if (merging && stateType === "completed") await this.cleanupMerged(event.issueId);
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

	/**
	 * Newest session per PR/MR whose worktree is still on disk and whose PR/MR may have been merged
	 * (PRs/MRs known to be closed without merging are left alone).
	 */
	private mergeCandidates(issueId?: string): LaneRef[] {
		const latest = new Map<string, LaneRef>();
		for (const record of this.store.all()) {
			if (issueId && record.issueId !== issueId) continue;
			for (const lane of lanesOf(record)) {
				if (!lane.prUrl) continue;
				const seen = latest.get(lane.prUrl);
				if (!seen || record.updatedAt > seen.record.updatedAt) latest.set(lane.prUrl, { record, lane });
			}
		}
		return [...latest.values()].filter(({ lane }) => {
			const repo = this.deps.config.repositories.find((x) => x.id === lane.repoId);
			return lane.worktreePath && lane.branch && lane.prMerged !== false && repo && repo.cleanupMergedWorktrees !== false;
		});
	}

	/**
	 * Remove the worktree and local branch of each epic whose PR/MR was merged (for one issue, or all).
	 * Runs when the issue is marked done, when a PR/MR is seen closed, and periodically as a fallback.
	 * It never waits on a person and never leaves a worktree behind, yet loses nothing: a busy session is
	 * checked again later, uncommitted changes are stashed, a branch with unmerged commits is kept, and
	 * what to do with leftover stashes and such a branch is asked in the epic's session.
	 */
	async cleanupMerged(issueId?: string): Promise<void> {
		const { ci, config, git, log } = this.deps;
		if (!ci) return;
		for (const { record, lane } of this.mergeCandidates(issueId)) {
			const ref = parseChangeRequestUrl(lane.prUrl);
			const repo = config.repositories.find((x) => x.id === lane.repoId);
			const path = lane.worktreePath;
			const branch = lane.branch;
			if (!ref || !repo || !path || !branch) continue;
			// Work on the issue may still use the worktree; check again on a later pass.
			const sessions = this.store.all().filter((r) => r.issueId === record.issueId || lanesOf(r).some((l) => l.worktreePath === path));
			if (sessions.some((r) => this.active.has(r.sessionId) || this.queue.includes(r.sessionId) || this.busyIssues.has(r.issueId))) continue;
			if ([...this.busyWorktrees.keys()].includes(path)) continue;
			try {
				const state = await ci.state(ref);
				if (!state || state.open) continue;
				lane.prClosed = true;
				lane.prMerged = state.merged;
				await this.store.save(record);
				if (!state.merged) continue;
				const term = ref.forge === "gitlab" ? "merge request" : "pull request";
				// Only worktrees cyralph made: one the branch was already checked out in belongs to someone else.
				const baseDir = resolve(repo.workspaceBaseDir ?? join(config.stateDir, "worktrees", repo.id));
				const owned = resolve(path).startsWith(`${baseDir}${sep}`);
				if (!owned || branch === repo.baseBranch) {
					log.info(`not cleaning up ${path} (${branch}) after ${ref.url} merged: cyralph didn't create it`);
					await this.forgetWorktree(path);
					continue;
				}
				const epic = record.identifier ?? record.sessionId;
				const removed = await git.removeWorkspace({
					repositoryPath: repo.repositoryPath,
					path,
					branch,
					mergedSha: state.headSha,
					stashMessage: stashLabel(epic, "cleanup"),
				});
				if (removed.stashed) {
					lane.stashes = [...(lane.stashes ?? []), { sha: removed.stashed, label: stashLabel(epic, "cleanup"), reason: "cleanup", createdAt: new Date().toISOString() }];
				}
				await this.forgetWorktree(path);
				const stashedNote = removed.stashed ? ` Its uncommitted changes are stashed (\`${removed.stashed.slice(0, 10)}\`).` : "";
				if (removed.unmerged) {
					log.info(`removed ${path} after ${ref.url} merged; kept branch ${branch} (${removed.unmerged} unmerged commits)`);
					await this.notify(record.sessionId, `The ${term} ${ref.url} was merged, so I removed its worktree, but kept the local branch \`${branch}\`.${stashedNote}`);
				} else {
					log.info(`removed ${path} and branch ${branch}: ${ref.url} was merged`);
					await this.notify(record.sessionId, `The ${term} ${ref.url} was merged, so I removed its worktree and the local branch \`${branch}\`.${stashedNote}`);
				}
				await this.askAboutStashes(record, lane, repo);
				if (removed.unmerged) await this.askAboutBranch(record, repo, branch, removed.unmerged);
			} catch (err) {
				log.warn(`cleanup after ${ref.url} merged failed: ${String(err)}`);
			}
		}
	}

	/**
	 * Recorded stash entries of a lane that are still in its repository's stash list. Entries someone
	 * dropped or applied by other means are forgotten.
	 */
	private async liveStashes(record: SessionRecord, lane: RepoLane, repo: RepositoryConfig): Promise<StashEntry[]> {
		const recorded = lane.stashes ?? [];
		if (recorded.length === 0) return [];
		const live = await this.deps.git.listStashes(repo.repositoryPath);
		const kept = recorded.filter((e) => live.some((l) => l.sha === e.sha));
		if (kept.length !== recorded.length) {
			lane.stashes = kept;
			await this.store.save(record);
		}
		return live.filter((l) => kept.some((e) => e.sha === l.sha));
	}

	/** Post (or replace) a cleanup question in the session and keep it on the record until it's answered. */
	private async ask(record: SessionRecord, request: CleanupRequest, body: string): Promise<void> {
		const pending = (record.cleanupRequests ?? []).filter(
			(r) => !(r.kind === request.kind && r.repoId === request.repoId && (r.kind !== "branch" || request.kind !== "branch" || r.branch === request.branch)),
		);
		record.cleanupRequests = [...pending, request];
		await this.store.save(record);
		await this.reporter(record.sessionId).select(body, cleanupOptions(request));
	}

	/** After cleanup: ask what to do with the epic's stash entries nobody applied. */
	private async askAboutStashes(record: SessionRecord, lane: RepoLane, repo: RepositoryConfig): Promise<void> {
		const entries = await this.liveStashes(record, lane, repo);
		if (entries.length === 0) return;
		const epic = record.identifier ?? record.sessionId;
		const n = entries.length;
		await this.ask(
			record,
			{ kind: "stashes", repoId: repo.id, shas: entries.map((e) => e.sha), askedAt: new Date().toISOString() },
			[
				`${n} stashed change${n === 1 ? "" : "s"} from ${epic} ${n === 1 ? "was" : "were"} never applied:`,
				entries.map((e) => `- \`${e.sha.slice(0, 10)}\` ${e.label} (${e.date})`).join("\n"),
				`**${PUSH_STASHES}** keeps them on \`${stashBranch(epic)}\` (one commit each) and drops them here; **${DROP_STASHES}** drops them. Until you answer they stay in \`${repo.name}\`'s stash.`,
			].join("\n\n"),
		);
	}

	/** After cleanup: ask what to do with a kept branch whose commits weren't merged; it's deleted without an answer. */
	private async askAboutBranch(record: SessionRecord, repo: RepositoryConfig, branch: string, commits: number): Promise<void> {
		const minutes = repo.unmergedBranchTimeoutMinutes ?? UNMERGED_BRANCH_TIMEOUT_MINUTES;
		const now = Date.now();
		await this.ask(
			record,
			{ kind: "branch", repoId: repo.id, branch, commits, askedAt: new Date(now).toISOString(), deadline: new Date(now + minutes * 60_000).toISOString() },
			`\`${branch}\` has ${commits} commit${commits === 1 ? " that wasn't" : "s that weren't"} merged.\n\n**${PUSH_BRANCH}** pushes it to \`origin\` and then deletes it here; **${DELETE_BRANCH}** deletes it. Without an answer within ${minutes} minute${minutes === 1 ? "" : "s"} I'll delete it.`,
		);
	}

	/** Carry out the chosen answer to a cleanup question and confirm it in the session. */
	private async answerCleanup(record: SessionRecord, request: CleanupRequest, option: string): Promise<void> {
		const { config, git, log } = this.deps;
		const repo = config.repositories.find((r) => r.id === request.repoId);
		const done = async (message: string) => {
			record.cleanupRequests = (record.cleanupRequests ?? []).filter((r) => r !== request);
			await this.store.save(record);
			await this.notify(record.sessionId, message);
		};
		if (!repo) return done(`\`${request.repoId}\` isn't configured anymore, so I left everything as it is.`);
		const cwd = repo.repositoryPath;
		try {
			if (request.kind === "stashes") {
				const lanes = lanesOf(record).filter((l) => l.repoId === repo.id);
				const entries = (await git.listStashes(cwd)).filter((e) => request.shas.includes(e.sha));
				const epic = record.identifier ?? record.sessionId;
				if (option === PUSH_STASHES) await git.pushStashes(cwd, stashBranch(epic), entries);
				for (const e of entries) await git.dropStash(cwd, e.sha);
				for (const l of lanes) l.stashes = (l.stashes ?? []).filter((e) => !request.shas.includes(e.sha));
				const n = entries.length;
				const what = `${n} stashed change${n === 1 ? "" : "s"}`;
				return done(
					option === PUSH_STASHES
						? `Pushed ${what} to \`${stashBranch(epic)}\` on origin (one commit each) and dropped ${n === 1 ? "it" : "them"} here.`
						: `Dropped ${what} from ${epic}.`,
				);
			}
			if (option === PUSH_BRANCH) await git.push(cwd, request.branch);
			await git.deleteBranch(cwd, request.branch);
			return done(
				option === PUSH_BRANCH
					? `Pushed \`${request.branch}\` to origin and deleted the local branch.`
					: `Deleted the local branch \`${request.branch}\` with its ${request.commits} unmerged commit${request.commits === 1 ? "" : "s"}.`,
			);
		} catch (err) {
			log.warn(`cleanup answer "${option}" for ${record.identifier ?? record.sessionId} failed: ${String(err)}`);
			await this.notify(record.sessionId, `I couldn't do that (${option}): ${String(err)}\n\nAnswer again to retry.`);
		}
	}

	/**
	 * Delete kept branches whose question about unmerged commits got no answer in time, and say so in their
	 * sessions. Runs every minute; leftover stashes have no timeout.
	 */
	async expireCleanupRequests(now = Date.now()): Promise<void> {
		const { config, git, log } = this.deps;
		for (const record of this.store.all()) {
			for (const request of record.cleanupRequests ?? []) {
				if (request.kind !== "branch" || Date.parse(request.deadline) > now) continue;
				const repo = config.repositories.find((r) => r.id === request.repoId);
				const minutes = Math.round((Date.parse(request.deadline) - Date.parse(request.askedAt)) / 60_000);
				try {
					if (repo) await git.deleteBranch(repo.repositoryPath, request.branch);
				} catch (err) {
					// Retried on the next pass.
					log.warn(`could not delete ${request.branch} after its question timed out: ${String(err)}`);
					continue;
				}
				record.cleanupRequests = (record.cleanupRequests ?? []).filter((r) => r !== request);
				await this.store.save(record);
				await this.notify(
					record.sessionId,
					`Nobody answered within ${minutes} minute${minutes === 1 ? "" : "s"}, so I deleted the local branch \`${request.branch}\` with its ${request.commits} unmerged commit${request.commits === 1 ? "" : "s"}.`,
				);
			}
		}
	}

	/** Stop tracking a worktree that was removed (or isn't cyralph's to remove). */
	private async forgetWorktree(path: string): Promise<void> {
		for (const r of this.store.all()) {
			const lanes = lanesOf(r).filter((l) => l.worktreePath === path);
			if (lanes.length === 0) continue;
			for (const l of lanes) l.worktreePath = undefined;
			await this.store.save(r);
		}
	}

	/** A review was submitted on a GitHub pull request (from the webhook or from polling). */
	handleReview(event: ReviewSubmitted): Promise<void> {
		const p = this.onReview(event).finally(() => this.handling.delete(p));
		this.handling.add(p);
		return p;
	}

	private async onReview(event: ReviewSubmitted): Promise<void> {
		const { config, log } = this.deps;
		const { review } = event;
		const where = `${event.repo}#${event.prNumber} review ${review.id}`;
		if (!isReviewBot(review.author, config.github.reviewBots)) return log.debug(`ignoring ${where}: ${review.author} isn't a review bot`);
		const repo = await this.repoForSlug(event.repo);
		if (!repo) return log.debug(`ignoring ${where}: no configured repository`);
		if (repo.respondToReviews === false) return log.debug(`ignoring ${where}: respondToReviews is off for ${repo.id}`);
		const found = this.recordForPullRequest(repo.id, event);
		if (!found) return log.debug(`ignoring ${where}: not a pull request cyralph opened`);
		const { record, lane } = found;
		if (!event.prOpen) {
			lane.prClosed = true;
			await this.store.save(record);
			await this.cleanupMerged(record.issueId);
			return;
		}
		if (record.status === "stopped") return log.info(`ignoring ${where}: session ${record.identifier ?? record.sessionId} was stopped`);
		if (this.reviewHandled(event.prUrl, review.id)) return;
		lane.handledReviewIds = [...(lane.handledReviewIds ?? []), review.id];
		// A review of an older commit is out of date: cyralph has pushed since.
		if (review.commitId && event.headSha && review.commitId !== event.headSha) {
			await this.store.save(record);
			return log.info(`skipping ${where}: it reviewed ${review.commitId.slice(0, 7)}, not the current head`);
		}

		const reporter = this.reporter(record.sessionId);
		const rounds = lane.reviewRounds ?? 0;
		if (rounds >= config.github.maxReviewRounds) {
			await this.store.save(record);
			await this.notify(
				record.sessionId,
				`${review.author} reviewed ${event.prUrl} again. I've already worked through ${rounds} of its reviews on this pull request, so I'm leaving this one for a person.`,
			);
			return;
		}
		const comments = this.deps.github
			? await this.deps.github.reviewComments(event.repo, event.prNumber, review.id).catch((err: unknown) => {
					log.warn(`could not read comments of ${where}: ${String(err)}`);
					return [];
				})
			: [];
		if (comments.length === 0 && !review.body.trim()) {
			await this.store.save(record);
			return log.info(`skipping ${where}: nothing to act on`);
		}
		lane.reviewRounds = rounds + 1;
		const text = buildReviewRequest({ review, comments, prNumber: event.prNumber, prUrl: event.prUrl, branch: lane.branch ?? event.headRef });
		const what = `${review.author} reviewed the pull request${comments.length ? ` with ${comments.length} comment${comments.length === 1 ? "" : "s"}` : ""}`;
		log.info(`acting on ${where} for ${record.identifier ?? record.sessionId}`);

		// Delivered like a reply in the Linear thread: into the live agent (when it works in that repository),
		// after the current step, or as a new run.
		const live = this.injectors.get(record.sessionId);
		if (live && live.repoId === lane.repoId && live.inject(text)) {
			await this.store.save(record);
			await reporter.thought(`${what}. Passed it to the agent that's working right now.`);
			return;
		}
		lane.pendingRequests = [...(lane.pendingRequests ?? []), text];
		await this.store.save(record);
		if (this.active.has(record.sessionId)) {
			await reporter.thought(`${what}. I'll work through it as soon as the current step finishes.`);
			return;
		}
		await reporter.thought(`${what}. Working through it.`);
		this.enqueue(record);
	}

	/**
	 * Fallback when no GitHub webhook secret is configured: check the open pull requests cyralph opened
	 * for the newest bot review of their current head commit.
	 */
	async pollReviews(): Promise<void> {
		const { config, github, log } = this.deps;
		if (!github) return;
		for (const [prUrl, { record, lane }] of this.openPullRequests()) {
			if (!parsePullRequestUrl(prUrl)) continue;
			const repo = config.repositories.find((x) => x.id === lane.repoId);
			if (!repo || repo.respondToReviews === false || record.status === "stopped") continue;
			const pr = parsePullRequestUrl(prUrl);
			if (!pr) continue;
			try {
				const state = await github.pullRequest(pr.repo, pr.number);
				if (!state) continue;
				if (!state.open) {
					lane.prClosed = true;
					await this.store.save(record);
					await this.cleanupMerged(record.issueId);
					continue;
				}
				const fresh = (await github.reviews(pr.repo, pr.number))
					.filter((rv) => isReviewBot(rv.author, config.github.reviewBots) && rv.commitId === state.headSha && !this.reviewHandled(prUrl, rv.id))
					.sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
				const review = fresh.pop();
				if (!review) continue;
				// Only the newest review of the head commit is acted on; earlier ones on it are superseded.
				if (fresh.length) {
					lane.handledReviewIds = [...(lane.handledReviewIds ?? []), ...fresh.map((rv) => rv.id)];
					await this.store.save(record);
				}
				await this.handleReview({ kind: "review_submitted", repo: pr.repo, prNumber: pr.number, prUrl, prOpen: true, headRef: state.headRef, headSha: state.headSha, review });
			} catch (err) {
				log.warn(`review poll of ${prUrl} failed: ${String(err)}`);
			}
		}
	}

	/** Pull/merge requests cyralph opened that aren't known to be closed, each with its newest session. */
	private openPullRequests(): Map<string, LaneRef> {
		const latest = new Map<string, LaneRef>();
		for (const record of this.store.all()) {
			for (const lane of lanesOf(record)) {
				if (!lane.prUrl || lane.prClosed) continue;
				const seen = latest.get(lane.prUrl);
				if (!seen || record.updatedAt > seen.record.updatedAt) latest.set(lane.prUrl, { record, lane });
			}
		}
		return latest;
	}

	/**
	 * Check the CI (GitHub Actions, GitLab pipelines) of every open PR/MR cyralph opened. When the
	 * pipeline of the head commit has finished and failed, hand the failed jobs to the session to fix.
	 */
	async pollCi(): Promise<void> {
		const { config, ci, log } = this.deps;
		if (!ci) return;
		// Work on the issue is running or queued and may push again; check its CI on a later poll. Decided
		// before acting on any failure, so one session's PRs/MRs in several repositories are all checked.
		const busy = new Set(
			this.store
				.all()
				.filter((r) => this.active.has(r.sessionId) || this.queue.includes(r.sessionId) || this.busyIssues.has(r.issueId))
				.map((r) => r.sessionId),
		);
		for (const [prUrl, { record, lane }] of this.openPullRequests()) {
			const repo = config.repositories.find((x) => x.id === lane.repoId);
			if (!repo || repo.respondToCiFailures === false || record.status === "stopped") continue;
			if (busy.has(record.sessionId)) continue;
			const ref = parseChangeRequestUrl(prUrl);
			if (!ref) continue;
			try {
				const status = await ci.status(ref);
				if (!status) continue;
				if (!status.open) {
					lane.prClosed = true;
					await this.store.save(record);
					await this.cleanupMerged(record.issueId);
					continue;
				}
				if (status.state !== "failed" || this.ciHandled(prUrl, status.headSha)) continue;
				const p = this.onCiFailure({ record, lane }, ref, status).finally(() => this.handling.delete(p));
				this.handling.add(p);
				await p;
			} catch (err) {
				log.warn(`CI poll of ${prUrl} failed: ${String(err)}`);
			}
		}
	}

	private async onCiFailure({ record, lane }: LaneRef, ref: ChangeRequestRef, status: CiStatus): Promise<void> {
		const { config, ci, log } = this.deps;
		const sha = status.headSha.slice(0, 7);
		const term = ref.forge === "gitlab" ? "merge request" : "pull request";
		lane.handledCiShas = [...(lane.handledCiShas ?? []), status.headSha];
		const reporter = this.reporter(record.sessionId);
		const rounds = lane.ciFixRounds ?? 0;
		if (rounds >= config.ci.maxFixRounds) {
			await this.store.save(record);
			await this.notify(
				record.sessionId,
				`CI failed again on ${ref.url} (\`${sha}\`). I've already tried to fix CI ${rounds} time${rounds === 1 ? "" : "s"} on this ${term}, so I'm leaving this one for a person.`,
			);
			return;
		}
		const jobs = await Promise.all(
			status.failedJobs.map(async (job) => ({
				...job,
				log: ci
					? await ci.jobLog(ref, job).catch((err: unknown) => {
							log.warn(`could not read the log of ${job.name} on ${ref.url}: ${String(err)}`);
							return "";
						})
					: "",
			})),
		);
		lane.ciFixRounds = rounds + 1;
		const branch = lane.branch ?? "the pull request branch";
		lane.pendingRequests = [...(lane.pendingRequests ?? []), buildCiFailureRequest({ ref, headSha: status.headSha, branch, pipelineUrl: status.pipelineUrl, jobs })];
		await this.store.save(record);
		const names = jobs.map((j) => `\`${j.name}\``);
		const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
		log.info(`acting on failed CI of ${ref.url} at ${sha} for ${record.identifier ?? record.sessionId}`);
		await reporter.thought(`CI failed on the ${term} (\`${sha}\`: ${shown}). Working on a fix.`);
		this.enqueue(record);
	}

	/** Every lane of every session that opened this PR/MR (a re-delegation carries it forward). */
	private lanesForPullRequest(prUrl: string): RepoLane[] {
		const url = prUrl.toLowerCase();
		return this.store.all().flatMap((r) => lanesOf(r).filter((l) => l.prUrl?.toLowerCase() === url));
	}

	private ciHandled(prUrl: string, sha: string): boolean {
		return this.lanesForPullRequest(prUrl).some((l) => l.handledCiShas?.includes(sha));
	}

	private reviewHandled(prUrl: string, reviewId: number): boolean {
		return this.lanesForPullRequest(prUrl).some((l) => l.handledReviewIds?.includes(reviewId));
	}

	/** The configured repository a webhook's `owner/name` belongs to (its `githubUrl`, else its `origin` remote). */
	private async repoForSlug(slug: string): Promise<RepositoryConfig | undefined> {
		for (const repo of this.deps.config.repositories) {
			if (repo.isActive === false || repo.forge === "gitlab") continue;
			const remote = githubRepoSlug(repo.githubUrl) ?? githubRepoSlug(await this.deps.git.remoteUrl(repo.repositoryPath).catch(() => undefined));
			if (remote === slug) return repo;
		}
		return undefined;
	}

	/** The newest session (and its lane) whose pull request (or, before it was recorded, branch) this is. */
	private recordForPullRequest(repoId: string, event: ReviewSubmitted): LaneRef | undefined {
		const url = event.prUrl.toLowerCase();
		const mine = this.store.all().flatMap((record) => lanesOf(record).filter((l) => l.repoId === repoId).map((lane) => ({ record, lane })));
		const byUrl = mine.filter(({ lane }) => lane.prUrl?.toLowerCase() === url);
		const matches = byUrl.length ? byUrl : mine.filter(({ lane }) => !lane.prUrl && lane.branch === event.headRef);
		return matches.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt))[0];
	}

	private async onCreated(event: Extract<AgentWebhookEvent, { kind: "created" }>) {
		const reporter = this.reporter(event.sessionId);
		void reporter.thought("Picked this up. Reading the epic and its stories…", true);

		const record = this.store.get(event.sessionId) ?? newRecord(event.sessionId, event.issueId, event.issueIdentifier);
		// Carry learnings forward when an issue is re-delegated in a new session.
		const previous = this.store.latestForIssue(event.issueId);
		if (previous && previous.sessionId !== record.sessionId) {
			record.branch ??= previous.branch;
			// The repository the issue last worked in; the engine re-checks it against the current config.
			record.repoId ??= previous.repoId;
			record.routedBy ??= previous.routedBy;
			record.baseBranchOverride ??= previous.baseBranchOverride;
			record.prUrl ??= previous.prUrl;
			record.prNumber ??= previous.prNumber;
			record.handledReviewIds ??= previous.handledReviewIds;
			record.reviewRounds ??= previous.reviewRounds;
			record.handledCiShas ??= previous.handledCiShas;
			record.ciFixRounds ??= previous.ciFixRounds;
			// Stash entries of earlier sessions stay offered to their stories, and are cleaned up with the epic.
			record.stashes ??= previous.stashes && structuredClone(previous.stashes);
			// Branches and PRs/MRs in the other repositories the epic's stories routed to; their requests stay behind.
			if (previous.lanes && !record.lanes) {
				record.lanes = Object.fromEntries(
					Object.entries(previous.lanes).map(([id, { pendingRequests: _, requestClaudeSessionId: __, ...lane }]) => [id, structuredClone(lane)]),
				);
			}
			record.guidance = [...previous.guidance];
			// A re-delegated plain issue is new work, so its own earlier completion doesn't carry over.
			record.completedKeys = previous.completedKeys.filter((k) => k !== event.issueId);
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

		// Answer to a question about a merged epic's leftovers (stashes, unmerged commits).
		const answer = record.cleanupRequests?.length ? matchCleanupAnswer(text, record.cleanupRequests) : undefined;
		if (answer) {
			await this.answerCleanup(record, answer.request, answer.option);
			return;
		}

		// Answer to "Which repository should I work in?"
		if (record.repoSelection?.length) {
			const candidates = this.deps.config.repositories.filter((r) => record.repoSelection?.includes(r.id));
			const repo = matchSelection(text, candidates);
			if (!repo) {
				await reporter.select(`I couldn't match "${text}" to a repository. Which one should I use?`, candidates.map(selectionValue));
				return;
			}
			const left = moveToRepository(record, repo.id);
			record.routedBy = ROUTED_BY_SELECTION;
			record.repoSelection = undefined;
			await this.store.save(record);
			const oldName = left && this.deps.config.repositories.find((r) => r.id === left.repoId)?.name;
			await reporter.thought(left ? leftBehindNote(left, oldName, repo.name) : `Using \`${repo.name}\`.`);
			this.enqueue(record);
			return;
		}

		if (isStartAnywayRequest(text)) {
			record.ignoreBlockers = true;
			record.waitingOn = [];
		} else if (text) {
			// "Push" / "open the MR" is orchestrator work, not story guidance: a story agent may not push, so
			// it would only refuse. Keep it as a direct request, run once the stories are done.
			const orchestratorWork = record.mode === "epic" && asksForPushOrPullRequest(text);
			// Running: deliver into the live agent session, as Cyrus streams follow-ups.
			const inject = orchestratorWork ? undefined : this.injectors.get(record.sessionId)?.inject;
			if (inject?.(text)) {
				if (record.mode === "epic") record.guidance.push(text); // later stories should know too
				await this.store.save(record);
				await reporter.thought("Passed this to the agent that's working right now.");
				return;
			}
			if (record.mode === "epic" && !orchestratorWork) record.guidance.push(text);
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
		record.blockedKeys = [];
		await this.store.save(record);
		await reporter.thought("On it.");
		this.enqueue(record);
	}

	/** Deliver text into a live agent session working on this issue, if there is one. */
	private injectIntoIssue(issueId: string, text: string): boolean {
		const owner = this.busyIssues.get(issueId);
		const live = owner ? this.injectors.get(owner) : undefined;
		return live ? live.inject(text) : false;
	}

	private enqueue(record: SessionRecord) {
		if (this.active.has(record.sessionId) || this.queue.includes(record.sessionId)) return;
		record.status = "queued";
		void this.store.save(record);
		this.queue.push(record.sessionId);
		this.pump();
	}

	/**
	 * After a restart (an update, a crash), pick up sessions that were queued or mid-run. Records not
	 * touched within `maxAgeHours` are left alone, so a long-dead session doesn't wake up unasked.
	 */
	async resumeInterrupted(maxAgeHours = 24): Promise<void> {
		const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
		for (const record of this.store.all()) {
			if (record.status !== "queued" && record.status !== "running") continue;
			if (Date.parse(record.updatedAt) < cutoff) continue;
			const wasRunning = record.status === "running";
			this.deps.log.info(`resuming ${wasRunning ? "interrupted" : "queued"} session ${record.identifier ?? record.sessionId}`);
			if (wasRunning) await this.reporter(record.sessionId).thought("cyralph restarted. Picking this back up where it left off.");
			this.enqueue(record);
		}
	}

	/**
	 * Stop starting sessions and wait until every running one has finished and no webhook is still
	 * being handled. Work that arrives meanwhile stays queued in the store for the next process.
	 */
	async drain(): Promise<void> {
		this.draining = true;
		await this.idle();
		while (this.handling.size > 0) await Promise.allSettled([...this.handling]);
		await this.store.flush();
	}

	isDraining(): boolean {
		return this.draining;
	}

	private pump() {
		while (!this.draining && this.active.size < this.deps.config.maxConcurrentSessions) {
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
			void this.reporter(id).thought(
				this.draining ? "Queued: cyralph is restarting for an update and will start this right after." : "Queued: waiting for a free agent slot.",
				true,
			);
		}
	}

	private start(record: SessionRecord) {
		const abort = new AbortController();
		const reporter = this.reporter(record.sessionId);
		record.status = "running";
		this.busyIssues.set(record.issueId, record.sessionId);
		const pending = () => lanesOf(record).flatMap((l) => l.pendingRequests ?? []);
		const pendingAtStart = new Set(pending());
		const done = (async () => {
			try {
				await this.store.save(record);
				const status = await this.engine.run({
					record,
					reporter,
					abortSignal: abort.signal,
					persist: () => this.store.save(record),
					setInjector: (inject, repoId) => {
						if (inject) this.injectors.set(record.sessionId, { inject, repoId });
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
				// Requests that arrived after this run's request step ("I'll handle this as soon as the current
				// step finishes") get a run of their own instead of waiting for the next message.
				const arrived = pending().some((r) => !pendingAtStart.has(r));
				if (arrived && !abort.signal.aborted && record.status !== "failed" && record.status !== "stopped") this.enqueue(record);
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
