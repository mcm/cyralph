/**
 * The Ralph loop, driven by a Linear agent session:
 *
 *   load epic -> prepare worktree -> repeat { pick next ready story -> fresh agent session ->
 *   read its structured result -> run verify commands -> commit/push/PR -> mark story Done }
 *
 * Every agent session starts from a clean worktree: whatever a session leaves uncommitted is stashed
 * under a `cyralph: …` label, recorded on the session, and offered back when its story runs again.
 *
 * Linear sub-issues are the tracker, the agent session is the
 * activity log, and the session plan shows story checklist progress.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityReporter } from "../agent/activity.js";
import { type AgentRunner, requestSystemAppend } from "../agent/runner.js";
import { type Config, type RepositoryConfig, allowPreparationFor } from "../config.js";
import type { CiClient } from "../git/ci.js";
import type { CommandResult, Forge, GitWorkspace } from "../git/workspace.js";
import type { GitHubReviewClient } from "../github/reviews.js";
import { type LoadedEpic, loadEpic, openRootBlockers } from "../linear/epic-loader.js";
import {
	type AttachmentEntry,
	type AttachmentFetcher,
	type AttachmentSource,
	attachmentsForStory,
	collectAttachments,
	formatAttachments,
} from "../linear/attachments.js";
import type { IssueSummary, LinearGateway, PlanStep } from "../linear/gateway.js";
import type { Logger } from "../logger.js";
import { ensureProgressFile, extractCodebasePatterns, readProgress, recentProgressEntries } from "../ralph/progress.js";
import {
	DEFAULT_STORY_TEMPLATE,
	type FollowUp,
	type OfferedStash,
	PR_DESCRIPTION_SCHEMA,
	PR_DESCRIPTION_SYSTEM_APPEND,
	REQUEST_OUTPUT_SCHEMA,
	STORY_OUTPUT_SCHEMA,
	asksForPushOrPullRequest,
	buildPullRequestPrompt,
	buildRequestPrompt,
	buildStoryPrompt,
	readPullRequestDescription,
	readRequestResult,
	readStoryOutcome,
	uniqueCommands,
} from "../ralph/prompt.js";
import { blockedStories, isEpicComplete, isStoryDone, selectNextStory } from "../ralph/selection.js";
import { type Epic, type Story, dependencyLabel, externalIdOf } from "../ralph/types.js";
import { PREPARATION_OPTIONS, eligiblePreparations, preparationHash, preparationQuestion } from "./preparation.js";
import { describeRouting, routeIssue, routeStory, selectionValue } from "./routing.js";
import { ROUTED_BY_SELECTION, type RepoLane, type SessionRecord, type SessionStatus, hasPendingRequests, lanesOf, moveToRepository } from "./store.js";

export interface EngineDeps {
	config: Config;
	linear: LinearGateway;
	runner: AgentRunner;
	git: GitWorkspace;
	shell: (command: string, cwd: string) => Promise<CommandResult>;
	log: Logger;
	/** Downloads Linear uploads (screenshots etc.) for prompts; omitted = attachments aren't fetched. */
	attachments?: AttachmentFetcher;
	/** Reads automated PR reviews from GitHub; omitted = reviews are acted on without inline comments, and not polled. */
	github?: GitHubReviewClient;
	/** Reads CI pipelines of cyralph's PRs/MRs; omitted = CI failures aren't polled. */
	ci?: CiClient;
}

export interface EngineRun {
	record: SessionRecord;
	reporter: ActivityReporter;
	abortSignal: AbortSignal;
	/** Persist the record (called after every state change). */
	persist: () => Promise<void>;
	/** Reserve the worktree for this run; false if another live session is using it. */
	claimWorktree?: (path: string) => boolean;
	/** Linear uploads gathered for this run (set by the engine). */
	attachments?: AttachmentEntry[];
	/** Receives the live session's message injector (and the repository it works in) while an agent session runs. */
	setInjector?: (inject: ((text: string) => boolean) | undefined, repoId?: string) => void;
	/** Worktrees prepared during this run, by repository id (set by the engine). */
	workspaces?: Map<string, Workspace>;
}

/** Label of a stash entry cyralph makes: `cyralph: <epic> <story or session> <reason>`. */
export function stashLabel(epic: string, reason: string, owner?: string): string {
	return `cyralph: ${epic}${owner ? ` ${owner}` : ""} ${reason}`;
}

/** The SDK's result subtype when the agent never produced output matching the schema. */
const STRUCTURED_RETRIES_EXHAUSTED = "error_max_structured_output_retries";

/** Why an agent session errored, for feedback and the thread. */
function sessionError(errorMessage: string | undefined): string {
	return errorMessage === STRUCTURED_RETRIES_EXHAUSTED
		? `it never produced a structured result matching the JSON schema (${STRUCTURED_RETRIES_EXHAUSTED})`
		: `it errored (${errorMessage ?? "unknown error"})`;
}

/** Tell the user an epic moved to another repository, and where its earlier work stays. */
export function leftBehindNote(left: RepoLane, oldName: string | undefined, newName: string): string {
	const from = `\`${oldName ?? left.repoId}\``;
	const work = [left.branch && `branch \`${left.branch}\``, left.prUrl && `${prLabel(left.prUrl)} ${left.prUrl}`].filter(Boolean);
	return `Routing now sends this to \`${newName}\` instead of ${from}, so I'm working there.${work.length ? ` The earlier work in ${from} stays as it is (${work.join(", ")}); I won't touch it again.` : ""}`;
}

/** A repository the run works in: its config, its lane in the session record, and its worktree. */
export interface Workspace {
	repo: RepositoryConfig;
	lane: RepoLane;
	worktree: string;
}

const MAX_FEEDBACK = 6000;
/** Times one story may pause for follow-ups it filed before a further round counts as a failed attempt. */
const MAX_FOLLOW_UP_ROUNDS = 3;

/** "Start anyway": outside blockers and manual steps no longer gate any story. */
function dropOutsideBlockers(epic: Epic): void {
	const manual = new Set(epic.stories.filter((s) => s.manual).map((s) => s.key));
	for (const s of epic.stories) s.dependsOn = s.dependsOn.filter((d) => !externalIdOf(d) && !manual.has(d));
}

function tail(text: string, n: number): string {
	return text.length > n ? `…${text.slice(-n)}` : text;
}

function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

function quote(text: string): string {
	return text
		.trim()
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
}

const FOLLOW_UP_MARK = "Filed by cyralph while working on";

function followUpFooter(story: Story): string {
	return `_${FOLLOW_UP_MARK} ${story.storyId}._`;
}

export function planFor(epic: Epic, current?: Story, exhausted: ReadonlySet<string> = new Set()): PlanStep[] {
	return epic.stories.map((s) => ({
		content: `${s.storyId}: ${s.title}${s.elsewhere ? " (manual: no repository here)" : s.manual ? " (manual)" : s.repo ? ` (in ${s.repo.name})` : ""}`,
		status:
			s.status === "completed"
				? "completed"
				: s.status === "cancelled" || exhausted.has(s.key)
					? "canceled"
					: current?.key === s.key
						? "inProgress"
						: "pending",
	}));
}

/**
 * PR/MR body: the agent-written description of the deliverable, or a plain fallback without one. The
 * Linear link is only a footnote, since readers of a public repository may not be able to open it.
 */
export function prBody(epic: Epic, description?: string): string {
	const linear = epic.url ? `[${epic.identifier}](${epic.url})` : epic.identifier;
	return [description?.trim() || `Implements ${epic.title}.`, "", "---", `Linear: ${linear} · _Opened by cyralph._`].join("\n");
}

/** PR/MR title: the issue identifier, then the agent's summary of the change (or the issue title without one). */
export function prTitle(epic: Epic, summary?: string): string {
	return `${epic.identifier}: ${summary?.trim() || epic.title}`;
}

/** "Merge request" for GitLab URLs, "Pull request" otherwise. */
export function prLabel(url: string): string {
	return /\/-\/merge_requests\//.test(url) ? "Merge request" : "Pull request";
}

export class EpicEngine {
	/**
	 * @param forgeProblems Sessions that already reported why a PR/MR can't be opened (don't repeat it
	 *   every story). Shared across engines, since a config reload starts a new one.
	 */
	constructor(
		private readonly deps: EngineDeps,
		private readonly forgeProblems = new Set<string>(),
	) {}

	async run(ctx: EngineRun): Promise<SessionStatus> {
		const { config, linear, log } = this.deps;
		const { record, reporter } = ctx;

		let loaded: LoadedEpic;
		try {
			// A mention only reads the epic for context; it never creates story issues.
			const materializeStories = record.mode === "epic" && config.ralph.materializeStories;
			loaded = await loadEpic(linear, record.issueId, { materializeStories, manualLabels: config.ralph.manualLabels });
		} catch (err) {
			await reporter.error(`Could not load the issue from Linear: ${String(err)}`);
			return "failed";
		}
		const { epic } = loaded;
		record.identifier = epic.identifier;
		// Re-check the forge CLI every run: the user may have installed or logged in since.
		for (const key of this.forgeProblems) if (key.startsWith(`${record.sessionId}:`)) this.forgeProblems.delete(key);
		record.focusStoryKey ??= loaded.focusStoryKey;
		for (const s of epic.stories) if (record.completedKeys.includes(s.key)) s.status = "completed";

		if (record.mode === "request") return this.runRequestOnly(ctx, epic);

		let rootBlockers: Array<{ id: string; identifier: string }> = [];
		if (record.ignoreBlockers) {
			// A human said to go ahead: outside blockers and manual steps no longer gate any story.
			dropOutsideBlockers(epic);
		} else {
			// Blocked-by on the epic (or plain issue) itself gates the story work, as in Cyrus.
			rootBlockers = await openRootBlockers(linear, epic);
			// Direct requests (e.g. "push and open a PR") aren't story work, so they still run.
			if (rootBlockers.length > 0 && !hasPendingRequests(record)) {
				return this.park(ctx, epic, rootBlockers, `**${epic.identifier}** is blocked`);
			}
		}
		record.waitingOn = [];

		const issue = await linear.getIssue(epic.issueId);
		const repo = await this.resolveRepo(ctx, issue);
		if (!repo) return "awaiting_input";
		this.routeStories(ctx, epic);

		await reporter.thought(this.describeEpic(epic, loaded, repo, record.routedBy));

		ctx.workspaces = new Map();
		const main = await this.workspaceFor(ctx, epic, repo);
		if (!("worktree" in main)) return main.status;

		const progressFile = join(config.stateDir, "epics", epic.identifier, "progress.md");
		await ensureProgressFile(progressFile, `${epic.identifier}: ${epic.title}`);
		await this.gatherAttachments(ctx, epic);
		await this.warnIfForgeUnusable(ctx, main);

		if (rootBlockers.length > 0) {
			const requestOutput = await this.runAllRequests(ctx, epic, progressFile);
			if (requestOutput) await reporter.thought(requestOutput);
			await this.adoptPullRequests(ctx, epic);
			return this.park(ctx, epic, rootBlockers, `**${epic.identifier}** is still blocked`);
		}

		if (!["started", "completed"].includes(issue.stateType)) {
			await linear.setIssueState(epic.issueId, { type: "started" }).catch((e: unknown) => log.warn(String(e)));
		}

		// Which stories this run may touch: a focused run also works the follow-ups its story turned up.
		const inScope = (s: Story) => !record.focusStoryKey || s.key === record.focusStoryKey || (record.followUpKeys ?? []).includes(s.key);
		const exhausted = () =>
			new Set(epic.stories.filter((s) => (record.attempts[s.key] ?? 0) >= config.ralph.maxAttemptsPerStory).map((s) => s.key));

		await reporter.plan(planFor(epic, undefined, exhausted()));

		let iterations = 0;
		const cap = config.ralph.maxIterationsPerRun;
		while (!ctx.abortSignal.aborted) {
			if (cap > 0 && iterations >= cap) break;
			// Issues filed under the epic while the run goes on (by a story, or by a person) join it.
			if (iterations > 0) await this.refreshStories(ctx, epic);
			const outOfScope = epic.stories.filter((s) => !inScope(s)).map((s) => s.key);
			const skip = new Set([...exhausted(), ...outOfScope]);
			const story = selectNextStory(epic.stories, skip);
			if (!story) break;
			// A story routed to another repository works in that repository's own worktree and branch.
			const storyRepo = (story.repo && this.repoById(story.repo.id)) || repo;
			const fresh = !ctx.workspaces.has(storyRepo.id);
			const ws = await this.workspaceFor(ctx, epic, storyRepo);
			if (!("worktree" in ws)) return ws.status;
			if (fresh) await this.warnIfForgeUnusable(ctx, ws);
			iterations++;
			await this.runStory({ ctx, epic, story, ws, progressFile, exhausted });
		}

		// Instructions no story iteration picked up (e.g. "push and open a PR" on a finished epic)
		// run as a direct request, the way Cyrus handles an @mention.
		const requestOutput = ctx.abortSignal.aborted ? undefined : await this.runAllRequests(ctx, epic, progressFile);

		return this.finish({ ctx, epic, inScope, exhausted: exhausted(), hitCap: cap > 0 && iterations >= cap, requestOutput });
	}

	private repoById(id: string | undefined): RepositoryConfig | undefined {
		return id ? this.deps.config.repositories.find((r) => r.id === id) : undefined;
	}

	/**
	 * Route each story of a sub-issue epic on its own signals (see `routeStory`). A story that belongs
	 * in another configured repository is worked there; one that belongs in a repository this cyralph
	 * doesn't have is left to a person, exactly like a story labelled manual.
	 */
	private routeStories(ctx: EngineRun, epic: Epic): void {
		if (epic.kind !== "children") return;
		const { record } = ctx;
		for (const s of epic.stories) {
			if (s.manual) continue;
			const route = routeStory(this.deps.config.repositories, { description: s.sourceText, labels: s.labels, projectName: s.projectName, teamKey: s.teamKey }, epic);
			if (route.type === "unroutable") {
				s.manual = true;
				s.elsewhere = route.reason;
			} else if (route.type === "selected" && route.repo.id !== record.repoId) {
				s.repo = { id: route.repo.id, name: route.repo.name, routedBy: describeRouting(route) };
			}
		}
	}

	/**
	 * The repository for this session (Cyrus routing: tags, labels, project, team, catch-all), routed
	 * again on every run so a config or issue change moves the epic. A repository a human picked stays
	 * while it's configured, and so does the current one when routing would otherwise have to ask.
	 * Returns undefined after asking the user to pick one when nothing matches.
	 */
	private async resolveRepo(ctx: EngineRun, epicIssue: IssueSummary): Promise<RepositoryConfig | undefined> {
		const { record, reporter } = ctx;
		const repos = this.deps.config.repositories;
		const withBase = (r: RepositoryConfig) => (record.baseBranchOverride ? { ...r, baseBranch: record.baseBranchOverride } : r);
		const current = record.repoId ? repos.find((r) => r.id === record.repoId && r.isActive !== false) : undefined;
		if (current && record.routedBy === ROUTED_BY_SELECTION) return withBase(current);

		// The delegated issue first (a story may carry its own tag/labels), then its epic.
		const delegated = record.issueId === epicIssue.id ? epicIssue : await this.deps.linear.getIssue(record.issueId);
		const issues = delegated.id === epicIssue.id ? [epicIssue] : [delegated, epicIssue];
		const routed = routeIssue(repos, issues);
		if (routed.type === "needs_selection") {
			if (current) return withBase(current);
			record.repoSelection = routed.candidates.map((r) => r.id);
			await ctx.persist();
			await reporter.select(
				"Which repository should I work in for this issue?\n\n(Add a `[repo=name]` tag, a routing label, or team/project routing in the config to skip this next time.)",
				routed.candidates.map(selectionValue),
			);
			return undefined;
		}
		const left = moveToRepository(record, routed.repo.id);
		if (left) await reporter.thought(leftBehindNote(left, this.repoById(left.repoId)?.name, routed.repo.name));
		record.routedBy = describeRouting(routed);
		record.baseBranchOverride = routed.baseBranch;
		await ctx.persist();
		return withBase(routed.repo);
	}

	/**
	 * The worktree for a repository this run works in, prepared once per run. The session's main
	 * repository keeps its branch and PR/MR on the record itself; any other gets a lane in `record.lanes`.
	 */
	private async workspaceFor(ctx: EngineRun, epic: Epic, repo: RepositoryConfig): Promise<Workspace | { status: SessionStatus }> {
		ctx.workspaces ??= new Map();
		const spaces = ctx.workspaces;
		const known = spaces.get(repo.id);
		if (known) return known;
		const { record } = ctx;
		let lane: RepoLane = record;
		if (repo.id !== record.repoId) {
			record.lanes ??= {};
			lane = record.lanes[repo.id] ??= { repoId: repo.id };
		}
		const worktree = await this.prepareWorkspace(ctx, epic, repo, lane);
		if (typeof worktree !== "string") {
			if (lane !== record && !lane.branch) delete record.lanes?.[repo.id];
			return worktree;
		}
		const ws = { repo, lane, worktree };
		spaces.set(repo.id, ws);
		return ws;
	}

	/** Create/reuse the epic's worktree in a repository. Returns its path, or the status to end the run with. */
	private async prepareWorkspace(ctx: EngineRun, epic: Epic, repo: RepositoryConfig, lane: RepoLane): Promise<string | { status: SessionStatus }> {
		const { config } = this.deps;
		const { reporter } = ctx;
		try {
			const ws = await this.deps.git.prepare({
				repositoryPath: repo.repositoryPath,
				workspaceBaseDir: repo.workspaceBaseDir ?? join(config.stateDir, "worktrees", repo.id),
				branch: lane.branch ?? epic.branchName,
				baseBranch: repo.baseBranch,
			});
			if (ctx.claimWorktree && !ctx.claimWorktree(ws.path)) {
				await reporter.elicitation(
					`Another cyralph session is already working on \`${ws.branch}\`${lane === ctx.record ? "" : ` in \`${repo.name}\``}. Reply here once it finishes and I'll pick up.`,
				);
				return { status: "awaiting_input" };
			}
			lane.branch = ws.branch;
			lane.worktreePath = ws.path;
			await ctx.persist();
			if (ws.created && repo.setupCommand) {
				await reporter.action("Setup", repo.setupCommand);
				const r = await this.deps.shell(repo.setupCommand, ws.path);
				if (r.code !== 0) await reporter.thought(`Setup command failed (continuing):\n\n\`\`\`\n${tail(r.stderr || r.stdout, 2000)}\n\`\`\``);
			}
			return ws.path;
		} catch (err) {
			await reporter.error(`Could not prepare the git worktree${lane === ctx.record ? "" : ` in \`${repo.name}\``}: ${String(err)}`);
			return { status: "failed" };
		}
	}

	/**
	 * An @mention: like Cyrus, act only on what the comment asks, with the epic as context. No story
	 * loop, no Linear state changes, and blockers don't apply. `/ralph` in the comment opts into the loop.
	 */
	private async runRequestOnly(ctx: EngineRun, epic: Epic): Promise<SessionStatus> {
		const { config, linear } = this.deps;
		const { record, reporter } = ctx;
		if (!hasPendingRequests(record)) {
			await reporter.response("Nothing to do: the mention didn't include a request. Delegate the issue to me to work the epic.");
			return "completed";
		}
		const repo = await this.resolveRepo(ctx, await linear.getIssue(epic.issueId));
		if (!repo) return "awaiting_input";
		ctx.workspaces = new Map();
		const main = await this.workspaceFor(ctx, epic, repo);
		if (!("worktree" in main)) return main.status;
		const progressFile = join(config.stateDir, "epics", epic.identifier, "progress.md");
		await ensureProgressFile(progressFile, `${epic.identifier}: ${epic.title}`);
		await this.gatherAttachments(ctx, epic);

		const output = await this.runAllRequests(ctx, epic, progressFile);
		if (ctx.abortSignal.aborted) {
			await reporter.response("Stopped.");
			return "stopped";
		}
		await this.adoptPullRequests(ctx, epic);
		await reporter.response(this.withPullRequestLinks(record, output ?? "Done."));
		return "completed";
	}

	/** Run each lane's pending requests in its own worktree, the main repository first. Returns their summaries. */
	private async runAllRequests(ctx: EngineRun, epic: Epic, progressFile: string): Promise<string | undefined> {
		const outputs: string[] = [];
		const spaces = await this.laneWorkspaces(ctx, epic, (l) => (l.pendingRequests?.length ?? 0) > 0);
		for (const ws of spaces) {
			if (ctx.abortSignal.aborted) break;
			const output = await this.runRequests({ ctx, epic, ws, progressFile });
			if (output) outputs.push(spaces.length > 1 || ws.lane !== ctx.record ? `**${ws.repo.name}**: ${output}` : output);
		}
		return outputs.length ? outputs.join("\n\n") : undefined;
	}

	/** Workspaces of the session's lanes that pass `want`, preparing worktrees this run hasn't used yet. */
	private async laneWorkspaces(ctx: EngineRun, epic: Epic, want: (lane: RepoLane) => boolean): Promise<Workspace[]> {
		const { record } = ctx;
		const out: Workspace[] = [];
		const main = record.repoId ? ctx.workspaces?.get(record.repoId) : undefined;
		if (main && want(record)) out.push(main);
		for (const [id, lane] of Object.entries(record.lanes ?? {})) {
			if (!want(lane)) continue;
			const repo = this.repoById(id);
			if (!repo) {
				this.deps.log.warn(`${record.identifier ?? record.sessionId}: repository ${id} is no longer configured; skipping its branch`);
				continue;
			}
			const ws = await this.workspaceFor(ctx, epic, repo);
			if ("worktree" in ws) out.push(ws);
		}
		return out;
	}

	/** Run a lane's pending requests as one direct agent session in its worktree. Returns its summary for the thread. */
	private async runRequests(args: { ctx: EngineRun; epic: Epic; ws: Workspace; progressFile: string }): Promise<string | undefined> {
		const { ctx, epic, ws, progressFile } = args;
		const { repo, lane, worktree } = ws;
		const { config, runner, git } = this.deps;
		const { reporter } = ctx;
		const requests = [...(lane.pendingRequests ?? [])];
		if (requests.length === 0) return undefined;

		const where = lane === ctx.record ? "" : ` in \`${repo.name}\``;
		await reporter.thought(requests.length === 1 ? `Working on your request${where}.` : `Working on your ${requests.length} requests${where}.`);
		const branch = lane.branch ?? epic.branchName;
		const forge = await this.forgeFor(worktree, repo);
		const historyRewrite = repo.historyRewrite ?? config.ralph.historyRewrite;
		const prompt = buildRequestPrompt({
			epic,
			requests,
			historyRewrite,
			branch,
			baseBranch: repo.baseBranch,
			remoteUrl: await git.remoteUrl(worktree),
			prUrl: lane.prUrl,
			progressFile,
			qualityGates: uniqueCommands([...epic.qualityGates, ...(repo.verifyCommands ?? [])]),
			forgeInstructions: forge?.agentInstructions({
				branch,
				baseBranch: repo.baseBranch,
				titlePrefix: `${epic.identifier}: `,
			}),
			prTerm: forge?.term,
			attachments: formatAttachments(ctx.attachments ?? []),
		});
		await this.startClean(ctx, epic, ws, "request");
		const runOnce = (resume?: string) =>
			runner.run({
				prompt,
				cwd: worktree,
				additionalDirectories: this.agentDirs(progressFile, epic),
				model: repo.model ?? config.model,
				fallbackModel: config.fallbackModel,
				allowedTools: repo.allowedTools,
				disallowedTools: repo.disallowedTools,
				permissionMode: config.permissionMode,
				abortSignal: ctx.abortSignal,
				onEvent: reporter.onRunnerEvent,
				onInjector: (inject) => ctx.setInjector?.(inject, repo.id),
				systemAppend: requestSystemAppend(historyRewrite),
				resume,
				outputSchema: REQUEST_OUTPUT_SCHEMA,
			});
		// Follow-ups continue the previous request conversation, like Cyrus resuming its Claude session.
		let result = await runOnce(lane.requestClaudeSessionId);
		if (result.isError && lane.requestClaudeSessionId && !result.sessionId && !ctx.abortSignal.aborted) {
			this.deps.log.warn(`could not resume request session ${lane.requestClaudeSessionId}; starting fresh`);
			result = await runOnce(undefined);
		}
		if (result.sessionId) lane.requestClaudeSessionId = result.sessionId;
		ctx.record.totalCostUsd += result.costUsd ?? 0;
		// The agent commits what it means to keep; anything else is set aside so the next session starts clean.
		const stashed = await this.stash(ctx, epic, ws, "unfinished", { owner: "request" });
		if (result.aborted) return undefined; // keep the requests pending for the next run
		lane.pendingRequests = (lane.pendingRequests ?? []).filter((r) => !requests.includes(r));
		await ctx.persist();
		const read = result.isError ? undefined : readRequestResult(result.structured);
		const note = stashed ? `\n\nThe session left uncommitted changes, which I stashed as \`${stashed.slice(0, 10)}\`.` : "";
		if (!read || "problem" in read) {
			const why = read ? `it ended without a valid structured result (${read.problem})` : sessionError(result.errorMessage);
			return `I ran into an error working on your request: ${why}.\n\n${tail(result.output, 2000)}`.trim() + note;
		}
		return (read.summary || "Done.") + note;
	}

	/** The session's PR/MR links not already in `text`, appended one per line (named by repository when there are several). */
	private withPullRequestLinks(record: SessionRecord, text: string): string {
		const lanes = lanesOf(record).filter((l) => l.prUrl);
		const links = lanes
			.filter((l) => l.prUrl && !text.includes(l.prUrl))
			.map((l) => `${prLabel(l.prUrl ?? "")}${lanes.length > 1 ? ` (${this.repoById(l.repoId)?.name ?? l.repoId})` : ""}: ${l.prUrl}`);
		return links.length ? `${text}\n\n${links.join("\n")}` : text;
	}

	private attachmentsDir(epic: Epic): string {
		return join(this.deps.config.stateDir, "attachments", epic.identifier);
	}

	/** Extra directories the agent may read: the progress log and downloaded attachments. */
	private agentDirs(progressFile: string, epic: Epic): string[] {
		return [join(progressFile, ".."), ...(this.deps.attachments ? [this.attachmentsDir(epic)] : [])];
	}

	/**
	 * Download files uploaded to Linear (pasted screenshots, mockups, PDFs) referenced by the epic, its
	 * stories, their comments, and the session thread, so prompts can point the agent at local copies.
	 */
	private async gatherAttachments(ctx: EngineRun, epic: Epic): Promise<void> {
		const fetcher = this.deps.attachments;
		if (!fetcher) return;
		const { linear, log } = this.deps;
		const { record, reporter } = ctx;
		const sources: AttachmentSource[] = [{ label: `${epic.identifier} description`, text: epic.description }];
		const comments = async (issueId: string) =>
			linear.getComments(issueId).catch((e: unknown) => {
				log.warn(`comments for ${issueId}: ${String(e)}`);
				return [];
			});
		for (const c of await comments(epic.issueId)) sources.push({ label: `comment on ${epic.identifier}${c.author ? ` by ${c.author}` : ""}`, text: c.body });
		for (const s of epic.stories) {
			if (!s.issueId || s.issueId === epic.issueId) continue;
			sources.push({ label: s.storyId, text: s.sourceText ?? s.description, storyKey: s.key });
			if (s.status === "completed" || s.status === "cancelled") continue;
			for (const c of await comments(s.issueId)) sources.push({ label: `comment on ${s.storyId}${c.author ? ` by ${c.author}` : ""}`, text: c.body, storyKey: s.key });
		}
		for (const t of [...record.guidance, ...record.pendingRequests]) sources.push({ label: "Linear thread", text: t });

		const entries = await collectAttachments({ sources, dir: this.attachmentsDir(epic), fetcher }).catch((e: unknown) => {
			log.warn(`attachment download failed: ${String(e)}`);
			return [] as AttachmentEntry[];
		});
		ctx.attachments = entries;
		const failed = entries.filter((e) => !e.path);
		if (failed.length > 0) {
			await reporter.thought(
				`I couldn't download ${failed.length} of ${entries.length} attachment(s) from Linear, so I can't see them:\n\n${failed
					.map((e) => `- ${e.title ?? e.url} (${e.sources.join(", ")}): ${e.error}`)
					.join("\n")}`,
			);
		} else if (entries.length > 0) {
			log.info(`${epic.identifier}: ${entries.length} attachment(s) available`);
		}
	}

	/** GitHub (`gh`) or GitLab (`glab`) for this repo's `origin`; undefined without a remote. */
	private forgeFor(worktree: string, repo: RepositoryConfig): Promise<Forge | undefined> {
		return this.deps.git.forge(worktree, { forge: repo.forge, gitlabHost: repo.gitlabHost, gitlabHosts: this.deps.config.gitlabHosts });
	}

	/** Key of a lane in `forgeProblems`: the problem is reported once per session and repository. */
	private problemKey(ctx: EngineRun, ws: Workspace): string {
		return `${ctx.record.sessionId}:${ws.repo.id}`;
	}

	/**
	 * Tell the user up front when the forge CLI can't open the PR/MR this run will need (not installed,
	 * not logged in), so they can fix it while the stories run. The final PR/MR step checks again.
	 */
	private async warnIfForgeUnusable(ctx: EngineRun, ws: Workspace): Promise<void> {
		const { reporter } = ctx;
		if (!this.deps.config.ralph.createPullRequest || ws.lane.prUrl) return;
		const forge = await this.forgeFor(ws.worktree, ws.repo);
		const problem = forge ? await forge.preflight(ws.worktree).catch(() => undefined) : undefined;
		if (!forge || !problem) return;
		this.forgeProblems.add(this.problemKey(ctx, ws));
		const where = ws.lane === ctx.record ? "" : ` in \`${ws.repo.name}\``;
		await reporter.thought(
			`Heads up: I'll need \`${forge.cli}\` to open the ${forge.term}${where} when the work is done, but ${lowerFirst(problem)}\n\nI'll keep working; fix it on the cyralph host before I finish and I'll open the ${forge.term} then.`,
		);
	}

	/** Pick up PRs/MRs the agent opened itself (e.g. via a direct request) so the session links them. Never opens one. */
	private async adoptPullRequests(ctx: EngineRun, epic: Epic): Promise<void> {
		const { reporter } = ctx;
		for (const { repo, lane, worktree } of await this.laneWorkspaces(ctx, epic, (l) => !l.prUrl && !!l.branch)) {
			const forge = await this.forgeFor(worktree, repo);
			const pr = forge && lane.branch ? await forge.find(worktree, lane.branch).catch(() => undefined) : undefined;
			if (!pr) continue;
			lane.prUrl = pr.url;
			lane.prNumber = pr.number;
			await ctx.persist();
			await reporter.externalUrl(prLabel(pr.url), pr.url);
		}
	}

	private describeEpic(epic: Epic, loaded: LoadedEpic, repo: RepositoryConfig, routedBy?: string): string {
		const done = epic.stories.filter(isStoryDone).length;
		const kind =
			epic.kind === "single"
				? "a single issue (no PRD structure found), so I'll treat it as one story"
				: `a Ralph epic with ${epic.stories.length} stories (${done} already done)`;
		const via = routedBy ? ` (routed by ${routedBy})` : "";
		const lines = [`**${epic.identifier}** is ${kind}. Working in \`${repo.name}\`${via} on branch \`${epic.branchName}\`, based on \`${repo.baseBranch}\`.`];
		if (loaded.materialized > 0) lines.push(`Created ${loaded.materialized} story sub-issues from the PRD in the description.`);
		if (loaded.focusStoryKey) {
			const s = epic.stories.find((x) => x.key === loaded.focusStoryKey);
			lines.push(`This issue is one story of the epic, so I'll only work on ${s?.storyId ?? "it"}.`);
		}
		const open = epic.stories.filter((s) => !isStoryDone(s));
		for (const s of open.filter((x) => x.repo)) {
			const pr = this.deps.config.ralph.createPullRequest ? " and its own pull/merge request" : "";
			lines.push(`**${s.storyId}** belongs in \`${s.repo?.name}\` (routed by ${s.repo?.routedBy}), so I'll work it there, on its own branch${pr}.`);
		}
		for (const s of open.filter((x) => x.elsewhere)) {
			lines.push(
				`**${s.storyId}** isn't in a repository I have (${s.elsewhere}), so I'll treat it like a manual step: I won't work it, and stories that depend on it wait until it's done.`,
			);
		}
		const manual = open.filter((s) => s.manual && !s.elsewhere);
		if (manual.length) {
			lines.push(
				`${manual.map((s) => `**${s.storyId}**`).join(", ")} ${manual.length === 1 ? "is a manual step" : "are manual steps"} for a person: I won't work ${manual.length === 1 ? "it" : "them"}, and stories that depend on ${manual.length === 1 ? "it" : "them"} wait until ${manual.length === 1 ? "it's" : "they're"} done.`,
			);
		}
		if (epic.qualityGates.length) lines.push(`Quality gates: ${epic.qualityGates.map((g) => `\`${g}\``).join(", ")}`);
		return lines.join("\n\n");
	}

	private async runStory(args: {
		ctx: EngineRun;
		epic: Epic;
		story: Story;
		ws: Workspace;
		progressFile: string;
		exhausted: () => Set<string>;
	}): Promise<void> {
		const { ctx, epic, story, ws, progressFile } = args;
		const { repo, worktree } = ws;
		const { config, linear, runner, log } = this.deps;
		const template = repo.promptTemplatePath ? await readFile(repo.promptTemplatePath, "utf8") : DEFAULT_STORY_TEMPLATE;
		// Each check runs once: the agent is told which ones the orchestrator runs, so it skips those.
		const verifyCommands = uniqueCommands([...(repo.verifyCommands ?? []), ...(repo.runPrdQualityGates ? epic.qualityGates : [])]);
		const { record, reporter } = ctx;
		const max = config.ralph.maxAttemptsPerStory;
		const depsBefore = new Set(story.dependsOn);
		const attempt = (record.attempts[story.key] ?? 0) + 1;
		record.attempts[story.key] = attempt;
		await ctx.persist();

		if (story.issueId && epic.kind !== "single" && story.status === "open") {
			await linear.setIssueState(story.issueId, { type: "started" }).catch((e: unknown) => log.warn(String(e)));
		}
		story.status = "in_progress";
		await reporter.plan(planFor(epic, story, args.exhausted()));
		await reporter.thought(`▶️ **${story.storyId}: ${story.title}** (attempt ${attempt}/${max})`);

		// Whatever an earlier session left behind is set aside first, so this story's commit holds only its work.
		await this.startClean(ctx, epic, ws, story.storyId);
		const pendingAtStart = [...record.pendingRequests];
		const progress = await readProgress(progressFile);
		const prompt = buildStoryPrompt(
			{
				epic,
				story,
				progressFile,
				codebasePatterns: extractCodebasePatterns(progress),
				recentProgress: recentProgressEntries(progress, 5),
				previousAttemptFeedback: record.lastFeedback[story.key],
				guidance: record.guidance.slice(-10),
				attempt,
				maxAttempts: max,
				appendInstruction: repo.appendInstruction,
				attachments: formatAttachments(attachmentsForStory(ctx.attachments ?? [], story.key)),
				followUps: epic.kind === "children",
				repository: story.repo?.name,
				verifyCommands,
				stashes: await this.offeredStashes(ctx, ws, story),
			},
			template,
		);

		const result = await runner.run({
			prompt,
			cwd: worktree,
			additionalDirectories: this.agentDirs(progressFile, epic),
			model: repo.model ?? config.model,
			fallbackModel: config.fallbackModel,
			allowedTools: repo.allowedTools,
			disallowedTools: repo.disallowedTools,
			permissionMode: config.permissionMode,
			abortSignal: ctx.abortSignal,
			onEvent: reporter.onRunnerEvent,
			onInjector: (inject) => ctx.setInjector?.(inject, repo.id),
			outputSchema: STORY_OUTPUT_SCHEMA,
		});
		record.totalCostUsd += result.costUsd ?? 0;
		if (!result.aborted) {
			// The story prompt carried these as guidance, so they've been acted on. Push/PR requests stay
			// pending for the direct request step: story agents aren't allowed to do them.
			record.pendingRequests = record.pendingRequests.filter((r) => !pendingAtStart.includes(r) || asksForPushOrPullRequest(r));
		}

		if (result.aborted) {
			record.attempts[story.key] = attempt - 1; // an interrupted attempt doesn't count
			await this.stash(ctx, epic, ws, "stopped", { story });
			await ctx.persist();
			return;
		}

		// The structured result alone decides the outcome; the message text is only shown.
		const read = result.isError ? undefined : readStoryOutcome(result.structured);
		const outcome = read && "outcome" in read ? read.outcome : undefined;
		if (outcome?.appliedStashes?.length) this.markApplied(ws, story, outcome.appliedStashes);
		const blocked = outcome?.status === "blocked";
		const complete = outcome?.status === "complete";
		const summary = outcome?.summary.trim() || result.output.trim();

		// Blocked work worth keeping is committed when it passes the checks, and stashed otherwise.
		const kept = blocked && outcome?.commit ? await this.commitBlockedWork({ ctx, epic, story, ws, verifyCommands, summary: outcome.commit.summary }) : undefined;

		if (
			await this.handleFollowUps({ ctx, epic, story, summary, followUps: outcome?.followUps ?? [], complete, depsBefore, attempt, exhausted: args.exhausted })
		) {
			await this.stash(ctx, epic, ws, "follow-up", { story });
			return;
		}

		let feedback: string | undefined;
		if (result.isError) {
			feedback = `The previous session failed: ${sessionError(result.errorMessage)}. Last message:\n\n${quote(tail(result.output, 2000))}`;
		} else if (!outcome) {
			feedback = `The previous session ended without a valid structured result (${read && "problem" in read ? read.problem : "none"}). End the session with a result matching the JSON schema you are given. Its final message was:\n\n${quote(tail(result.output, 3000))}`;
		} else if (blocked) {
			feedback = `The previous session reported it was blocked. Its summary was:\n\n${quote(tail(summary, 3000))}`;
		} else if (!complete) {
			feedback = `The previous session reported the story incomplete. Its summary was:\n\n${quote(tail(summary, 3000))}`;
		} else {
			const failed = await this.verify(ctx, verifyCommands, worktree);
			if (failed) {
				feedback = `The agent reported the story complete, but the verification command \`${failed.cmd}\` failed (exit ${failed.code}):\n\n\`\`\`\n${tail(failed.output, MAX_FEEDBACK)}\n\`\`\``;
			}
		}

		let sha: string | undefined;
		if (!feedback && config.ralph.commitPerStory) {
			const committed = await this.commitStory(epic, story, worktree);
			if (committed.feedback) feedback = committed.feedback;
			else sha = committed.sha;
		}

		if (feedback) {
			record.lastFeedback[story.key] = feedback;
			if (blocked) {
				// Another attempt can't get past it: use up the budget so the story waits for a person.
				record.attempts[story.key] = Math.max(attempt, max);
				record.blockedKeys = [...new Set([...(record.blockedKeys ?? []), story.key])];
			}
			await ctx.persist();
			const reason = blocked ? "blocked" : attempt >= max ? "exhausted" : !outcome ? "error" : complete ? "unverified" : "incomplete";
			// Nothing uncommitted carries over: the next session starts clean, and this story's next one is offered the stash.
			const stashed = (await this.stash(ctx, epic, ws, reason, { story })) ?? kept?.stashed;
			if (blocked || attempt >= max) {
				story.status = story.issueId ? "in_progress" : "open";
				const lead = blocked
					? `🚧 ${story.storyId} is blocked; setting it aside without retrying`
					: `⚠️ ${story.storyId} did not complete after ${attempt} attempts; setting it aside`;
				const saved = kept?.sha ? ` (work so far committed as \`${kept.sha.slice(0, 10)}\`)` : stashed ? " (partial work stashed)" : "";
				await reporter.thought(`${lead}${saved}.\n\n${feedback}`);
			} else {
				const saved = stashed ? " Its changes are stashed and offered to the next attempt." : "";
				await reporter.thought(`${story.storyId} attempt ${attempt} did not complete; retrying with feedback.${saved}\n\n${tail(feedback, 1500)}`);
			}
			await reporter.plan(planFor(epic, undefined, args.exhausted()));
			return;
		}

		// The story's work is committed: its stash entries are in the commit or deliberately left out.
		if (sha) await this.dropStoryStashes(ctx, ws, story);
		await this.completeStory({ ctx, epic, story, ws, sha, summary });
	}

	/** Run the verify commands in order; the first that fails, if any. */
	private async verify(ctx: EngineRun, commands: string[], worktree: string): Promise<{ cmd: string; code: number; output: string } | undefined> {
		for (const cmd of commands) {
			await ctx.reporter.action("Verify", cmd);
			const r = await this.deps.shell(cmd, worktree);
			await ctx.reporter.action("Verify", cmd, r.code === 0 ? "passed" : `failed (exit ${r.code})`);
			if (r.code !== 0) return { cmd, code: r.code, output: `${r.stdout}\n${r.stderr}`.trim() };
		}
		return undefined;
	}

	/**
	 * Commit the work of a story whose agent reported it blocked and asked to keep its changes, as
	 * `wip(<storyId>): <summary>`, once the verify commands pass; push it like a completed story. When a
	 * check fails (or the commit does), the work is stashed instead. The story stays blocked either way.
	 */
	private async commitBlockedWork(args: {
		ctx: EngineRun;
		epic: Epic;
		story: Story;
		ws: Workspace;
		verifyCommands: string[];
		summary: string;
	}): Promise<{ sha?: string; stashed?: string }> {
		const { ctx, epic, story, ws, verifyCommands, summary } = args;
		const { config, git } = this.deps;
		const { reporter } = ctx;
		const { worktree } = ws;
		if (!config.ralph.commitPerStory) return {};
		if ((await git.uncommittedChanges(worktree).catch(() => [])).length === 0) return {};
		const failed = await this.verify(ctx, verifyCommands, worktree);
		if (failed) {
			const stashed = await this.stash(ctx, epic, ws, "blocked", { story });
			await reporter.thought(
				`${story.storyId}'s work so far didn't pass \`${failed.cmd}\` (exit ${failed.code}), so I stashed it${stashed ? ` (\`${stashed.slice(0, 10)}\`)` : ""} instead of committing it.`,
			);
			return { stashed };
		}
		let sha: string | undefined;
		try {
			sha = await git.commitAll(worktree, `wip(${story.storyId}): ${summary}\n\nEpic: ${epic.identifier} ${epic.title}`);
		} catch (e) {
			const stashed = await this.stash(ctx, epic, ws, "blocked", { story });
			await reporter.thought(`Committing ${story.storyId}'s work so far failed, so I stashed it instead:\n\n\`\`\`\n${tail(String(e), 1500)}\n\`\`\``);
			return { stashed };
		}
		if (!sha) return {};
		await this.dropStoryStashes(ctx, ws, story);
		// Anything the commit didn't take (rewritten by a hook, say) is set aside, offered again next time.
		const stashed = await this.stash(ctx, epic, ws, "blocked", { story });
		await reporter.thought(`Committed ${story.storyId}'s work so far as \`${sha.slice(0, 10)}\` (\`wip(${story.storyId}): ${summary}\`).`);
		await this.publishStoryCommit(ctx, epic, ws, sha);
		return { sha, stashed };
	}

	/** Push a story's commit and keep the PR/MR in step, when `pushPerStory` is on and there is a remote. */
	private async publishStoryCommit(ctx: EngineRun, epic: Epic, ws: Workspace, sha: string | undefined): Promise<void> {
		const { config, git } = this.deps;
		const { lane, worktree } = ws;
		// No remote yet is fine: commits stay local and are pushed once `origin` exists.
		if (!sha || !config.ralph.pushPerStory || !lane.branch || !(await git.remoteUrl(worktree))) return;
		try {
			await git.push(worktree, lane.branch);
			await this.syncPullRequest(ctx, epic, ws, { ready: false, open: config.ralph.openPullRequestEarly, final: false });
		} catch (err) {
			await ctx.reporter.error(`Push failed: ${String(err)}`);
		}
	}

	/**
	 * Stash what a session left uncommitted under a `cyralph: …` label and record the entry on the lane:
	 * with the story whose work it is, or as the epic's when no story owns it. Returns the entry's SHA.
	 */
	private async stash(ctx: EngineRun, epic: Epic, ws: Workspace, reason: string, by: { story?: Story; owner?: string }): Promise<string | undefined> {
		// Without per-story commits, finished stories' work stays uncommitted in the worktree on purpose.
		if (!this.deps.config.ralph.commitPerStory) return undefined;
		const label = stashLabel(epic.identifier, reason, by.story?.storyId ?? by.owner);
		let sha: string | undefined;
		try {
			sha = await this.deps.git.stashAll(ws.worktree, label);
		} catch (err) {
			this.deps.log.warn(`${epic.identifier}: could not stash "${label}": ${String(err)}`);
			await ctx.reporter.error(`I couldn't stash the uncommitted changes in \`${ws.worktree}\` ("${label}"): ${String(err)}`);
			return undefined;
		}
		if (!sha) return undefined;
		ws.lane.stashes = [...(ws.lane.stashes ?? []), { sha, label, ...(by.story && { storyKey: by.story.key }), reason, createdAt: new Date().toISOString() }];
		await ctx.persist();
		return sha;
	}

	/** Before an agent session: stash anything left in the worktree (`pre-run`), so the session starts clean. */
	private async startClean(ctx: EngineRun, epic: Epic, ws: Workspace, owner: string): Promise<void> {
		const sha = await this.stash(ctx, epic, ws, "pre-run", { owner });
		if (sha) await ctx.reporter.thought(`The worktree had uncommitted changes from an earlier session, so I stashed them first (\`${sha.slice(0, 10)}\`).`);
	}

	/** Unapplied stash entries recorded for a story that are still in the stash list (the rest are forgotten). */
	private async offeredStashes(ctx: EngineRun, ws: Workspace, story: Story): Promise<OfferedStash[]> {
		const mine = (ws.lane.stashes ?? []).filter((e) => e.storyKey === story.key);
		if (mine.length === 0) return [];
		let live: Set<string>;
		try {
			live = new Set((await this.deps.git.listStashes(ws.worktree)).map((e) => e.sha));
		} catch (err) {
			this.deps.log.warn(`could not list stashes in ${ws.worktree}: ${String(err)}`);
			return [];
		}
		const gone = mine.filter((e) => !live.has(e.sha));
		if (gone.length) {
			ws.lane.stashes = (ws.lane.stashes ?? []).filter((e) => !gone.includes(e));
			await ctx.persist();
		}
		return mine.filter((e) => live.has(e.sha) && !e.applied).map((e) => ({ sha: e.sha, label: e.label, date: e.createdAt }));
	}

	/** Note the story's stash entries its agent applied (by full or abbreviated SHA), so they aren't offered again. */
	private markApplied(ws: Workspace, story: Story, shas: string[]): void {
		const wanted = shas.map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 7);
		for (const e of ws.lane.stashes ?? []) {
			if (e.storyKey === story.key && wanted.some((x) => e.sha.startsWith(x))) e.applied = true;
		}
	}

	/** Drop every stash entry recorded for a story (its work is committed), leaving all other entries alone. */
	private async dropStoryStashes(ctx: EngineRun, ws: Workspace, story: Story): Promise<void> {
		const mine = (ws.lane.stashes ?? []).filter((e) => e.storyKey === story.key);
		if (mine.length === 0) return;
		const dropped = new Set<string>();
		for (const e of mine) {
			try {
				await this.deps.git.dropStash(ws.worktree, e.sha);
				dropped.add(e.sha);
			} catch (err) {
				this.deps.log.warn(`could not drop stash ${e.sha} (${e.label}): ${String(err)}`);
			}
		}
		ws.lane.stashes = (ws.lane.stashes ?? []).filter((e) => !dropped.has(e.sha));
		await ctx.persist();
	}

	/**
	 * Commit a verified story, then make sure the worktree is clean. A commit that fails (say a git hook
	 * rejects it) or files left over afterwards (changed by a hook, inside a nested repository, or simply
	 * uncommittable) mean the story isn't done: it gets feedback like a failed verification instead, so
	 * nothing is marked Done while work sits uncommitted in the worktree.
	 */
	private async commitStory(epic: Epic, story: Story, worktree: string): Promise<{ sha?: string; feedback?: string }> {
		const { git } = this.deps;
		const ref = story.identifier && story.identifier !== story.storyId ? ` [${story.identifier}]` : "";
		const subject = epic.kind === "single" ? `${epic.identifier}: ${story.title}` : `feat(${story.storyId}): ${story.title}${ref}`;
		let sha: string | undefined;
		try {
			sha = await git.commitAll(worktree, `${subject}\n\nEpic: ${epic.identifier} ${epic.title}`);
		} catch (e) {
			return {
				feedback: `The agent reported the story complete and verification passed, but committing the work failed:\n\n\`\`\`\n${tail(String(e), MAX_FEEDBACK)}\n\`\`\`\n\nFix what stops the commit (for example a git hook that rejects it). Don't commit yourself: the orchestrator commits once the story completes.`,
			};
		}
		let left: string[];
		try {
			left = await git.uncommittedChanges(worktree);
		} catch (e) {
			return { sha, feedback: `The story's work was committed, but checking the worktree for uncommitted files failed: ${String(e)}` };
		}
		if (left.length === 0) return { sha };
		const shown = left.slice(0, 50).join("\n") + (left.length > 50 ? `\n… and ${left.length - 50} more` : "");
		return {
			sha,
			feedback: `The agent reported the story complete, but after the orchestrator committed the story these files were still uncommitted (\`git status --porcelain\`):\n\n\`\`\`\n${shown}\n\`\`\`\n\nThe worktree must be clean when the story is done. Files that belong to the story must be committable (not inside a nested git repository, not rewritten by a git hook after staging); anything else should be deleted, or added to \`.gitignore\` if it's generated. Don't commit yourself: the orchestrator commits once the story completes.`,
		};
	}

	/**
	 * File the story session's `followUps` as sub-issues of the epic (blocking the story when it didn't
	 * complete), then re-read the epic. Returns true when the story now waits on issues filed during its
	 * session, through its result or by the agent itself: the attempt doesn't count, those issues are
	 * worked first (or waited for, outside the epic), and the story runs again once they're done.
	 */
	private async handleFollowUps(args: {
		ctx: EngineRun;
		epic: Epic;
		story: Story;
		/** The session's summary of its work. */
		summary: string;
		followUps: FollowUp[];
		complete: boolean;
		depsBefore: ReadonlySet<string>;
		attempt: number;
		exhausted: () => Set<string>;
	}): Promise<boolean> {
		const { ctx, epic, story, summary, complete, depsBefore, attempt } = args;
		if (epic.kind !== "children") return false;
		const { record, reporter } = ctx;
		const requested = args.followUps;
		if (requested.length > 0) await this.fileFollowUps(ctx, epic, story, requested, !complete);
		if (complete) return false;

		await this.refreshStories(ctx, epic);
		const byKey = new Map(epic.stories.map((s) => [s.key, s]));
		const current = byKey.get(story.key);
		const added = (current?.dependsOn ?? []).filter((d) => {
			const dep = byKey.get(d);
			return !depsBefore.has(d) && !(dep && isStoryDone(dep));
		});
		if (added.length === 0) return false;
		const round = (record.followUpRounds?.[story.key] ?? 0) + 1;
		// A story that keeps turning up more work falls back to counting attempts, so it can't loop forever.
		if (round > MAX_FOLLOW_UP_ROUNDS) return false;
		record.followUpRounds = { ...record.followUpRounds, [story.key]: round };
		record.attempts[story.key] = attempt - 1;
		const inEpic = added.filter((d) => byKey.has(d));
		record.followUpKeys = [...new Set([...(record.followUpKeys ?? []), ...inEpic])];
		const names = added.map((d) => dependencyLabel(epic, d));
		record.lastFeedback[story.key] =
			`The previous session found work that had to be done first, so this story waited for ${names.join(", ")}. That work is finished now: check every acceptance criterion again. The previous session's summary was:\n\n${quote(tail(summary, 2000))}`;
		await ctx.persist();

		const bold = (ids: string[]) => ids.map((d) => `**${dependencyLabel(epic, d)}**`).join(", ");
		const outside = added.filter((d) => !byKey.has(d));
		const forAgent = inEpic.filter((d) => !byKey.get(d)?.manual);
		const forPerson = inEpic.filter((d) => byKey.get(d)?.manual);
		const lines = [`⏸️ **${story.storyId}** needs ${bold(added)} done first.`];
		if (forAgent.length) lines.push(`I'll work ${forAgent.length === inEpic.length ? (forAgent.length === 1 ? "it" : "them") : bold(forAgent)} next and then run ${story.storyId} again.`);
		if (forPerson.length) {
			lines.push(
				`${bold(forPerson)} ${forPerson.length === 1 ? "is a manual step" : "are manual steps"} for a person, so ${story.storyId} runs again once ${forPerson.length === 1 ? "it's" : "they're"} done.`,
			);
		}
		if (outside.length) {
			lines.push(
				`${bold(outside)} ${outside.length === 1 ? "isn't a sub-issue" : "aren't sub-issues"} of **${epic.identifier}**, so ${story.storyId} also waits until ${outside.length === 1 ? "it's" : "they're"} done.`,
			);
		}
		await reporter.thought(lines.join(" "));
		await reporter.plan(planFor(epic, undefined, args.exhausted()));
		return true;
	}

	/** Create sub-issues of the epic for follow-up work a story turned up; `blocking` makes them block that story. */
	private async fileFollowUps(ctx: EngineRun, epic: Epic, story: Story, followUps: FollowUp[], blocking: boolean): Promise<void> {
		const { linear, log } = this.deps;
		const parent = await linear.getIssue(epic.issueId).catch(() => undefined);
		const teamId = parent?.teamId ?? epic.teamId;
		if (!teamId) {
			log.warn(`${epic.identifier}: no team to file follow-ups in`);
			return;
		}
		const open = new Map(epic.stories.filter((s) => !isStoryDone(s)).map((s) => [s.title.toLowerCase(), s]));
		// A manual follow-up carries the first manual label, so the epic loader treats it as a step for a person.
		const manualLabel = this.deps.config.ralph.manualLabels[0];
		const filed: string[] = [];
		const forPerson: string[] = [];
		const failed: string[] = [];
		for (const f of followUps) {
			try {
				// A retry that reports the same follow-up again reuses the open issue filed the first time.
				const existing = open.get(f.title.toLowerCase());
				const issue = existing?.issueId
					? { id: existing.issueId, identifier: existing.storyId }
					: await linear.createIssue({
							teamId,
							parentId: epic.issueId,
							title: f.title,
							description: `${f.description}\n\n${followUpFooter(story)}`.trim(),
							priority: story.priority <= 4 ? story.priority : 0,
							// In the story's project, so a follow-up of a story in another repository routes there too.
							projectName: story.projectName ?? parent?.projectName,
							...(f.manual && manualLabel && { labels: [manualLabel] }),
						});
				if (blocking && story.issueId && issue.id !== story.issueId && !story.dependsOn.includes(issue.id)) {
					await linear.createBlocksRelation(issue.id, story.issueId);
				}
				filed.push(`**${issue.identifier}**`);
				if (f.manual) {
					if (manualLabel) forPerson.push(`**${issue.identifier}**`);
					else log.warn(`${issue.identifier}: filed as a manual follow-up, but no manual label is configured (ralph.manualLabels)`);
				}
			} catch (err) {
				log.warn(`could not file follow-up "${f.title}": ${String(err)}`);
				failed.push(`"${f.title}"`);
			}
		}
		const lines: string[] = [];
		if (filed.length) {
			lines.push(
				`Filed ${filed.join(", ")} as ${filed.length === 1 ? "a new story" : "new stories"} of **${epic.identifier}**${blocking ? `, blocking **${story.storyId}**` : ""}.`,
			);
		}
		if (forPerson.length) {
			lines.push(
				`${forPerson.join(", ")} ${forPerson.length === 1 ? "is a manual step" : "are manual steps"} for a person (labelled \`${manualLabel}\`): I won't work ${forPerson.length === 1 ? "it" : "them"}.`,
			);
		}
		if (failed.length) lines.push(`I couldn't file ${failed.join(", ")} in Linear.`);
		if (lines.length) await ctx.reporter.thought(lines.join(" "));
	}

	/**
	 * Re-read the epic's sub-issues from Linear, so issues filed while the run goes on join it and new
	 * blockers are honoured. Stories this run completed stay completed (in case marking them Done failed).
	 */
	private async refreshStories(ctx: EngineRun, epic: Epic): Promise<void> {
		if (epic.kind !== "children") return;
		const { config, linear, log } = this.deps;
		const { record, reporter } = ctx;
		let fresh: Epic;
		try {
			fresh = (await loadEpic(linear, record.issueId, { materializeStories: false, manualLabels: config.ralph.manualLabels })).epic;
		} catch (err) {
			log.warn(`${epic.identifier}: could not refresh stories from Linear: ${String(err)}`);
			return;
		}
		if (fresh.kind !== "children" || fresh.issueId !== epic.issueId) return;
		const old = new Map(epic.stories.map((s) => [s.key, s]));
		for (const s of fresh.stories) if (old.get(s.key)?.status === "completed") s.status = "completed";
		epic.stories = fresh.stories;
		epic.externalIssues = fresh.externalIssues;
		this.routeStories(ctx, epic);
		if (record.ignoreBlockers) dropOutsideBlockers(epic);

		const added = fresh.stories.filter((s) => !old.has(s.key));
		if (added.length === 0) return;
		// Follow-ups cyralph filed itself were already announced.
		const others = added.filter((s) => !s.sourceText?.includes(FOLLOW_UP_MARK));
		if (others.length) {
			await reporter.thought(
				`${others.length === 1 ? "A new story" : `${others.length} new stories`} joined **${epic.identifier}**: ${others.map((s) => `**${s.storyId}** ${s.title}`).join(", ")}.`,
			);
		}
		const max = config.ralph.maxAttemptsPerStory;
		await reporter.plan(planFor(epic, undefined, new Set(epic.stories.filter((s) => (record.attempts[s.key] ?? 0) >= max).map((s) => s.key))));
	}

	private async completeStory(args: { ctx: EngineRun; epic: Epic; story: Story; ws: Workspace; sha?: string; summary: string }) {
		const { ctx, epic, story, ws, sha, summary } = args;
		const { lane } = ws;
		const { linear, log } = this.deps;
		const { record, reporter } = ctx;

		story.status = "completed";
		delete record.lastFeedback[story.key];
		// Plain issues have no Linear state to read back (their issue stays open for review), so remember
		// completion here: a follow-up in the thread must not re-run the finished story.
		if ((!story.issueId || epic.kind === "single") && !record.completedKeys.includes(story.key)) record.completedKeys.push(story.key);
		await ctx.persist();

		if (story.issueId && epic.kind !== "single") {
			await linear.setIssueState(story.issueId, { type: "completed" }).catch((e: unknown) => log.warn(String(e)));
			const where = `\`${lane.branch}\`${lane === record ? "" : ` in \`${ws.repo.name}\``}`;
			const note = [`✅ Completed by cyralph${sha ? ` in \`${sha.slice(0, 10)}\`` : ""} on ${where}.`, "", tail(summary, 4000)].join("\n");
			await linear.addComment(story.issueId, note).catch((e: unknown) => log.warn(String(e)));
		}

		await this.publishStoryCommit(ctx, epic, ws, sha);
		const done = epic.stories.filter(isStoryDone).length;
		await reporter.thought(`✅ **${story.storyId}** complete${sha ? ` (\`${sha.slice(0, 10)}\`)` : ""}. ${done}/${epic.stories.length} stories done.`);
	}

	/**
	 * Keep a lane's PR/MR in step with its branch. `open` allows opening a new one; without it only an
	 * existing PR/MR is updated, so a half-finished epic doesn't burn CI on every pushed story. `final` (the
	 * epic is complete) rewrites the title and description from the finished branch. Returns why a PR/MR
	 * that should have been opened wasn't (forge CLI missing or not logged in, or creation failed).
	 */
	private async syncPullRequest(
		ctx: EngineRun,
		epic: Epic,
		ws: Workspace,
		opts: { ready: boolean; open: boolean; final: boolean },
	): Promise<string | undefined> {
		const { config } = this.deps;
		const { reporter } = ctx;
		const { repo, lane, worktree } = ws;
		if (!config.ralph.createPullRequest || !lane.branch) return undefined;
		const forge = await this.forgeFor(worktree, repo);
		if (!forge) return undefined; // no remote to open a PR/MR against yet
		let described: Promise<{ title: string; body: string } | undefined> | undefined;
		const describe = () => {
			described ??= this.describePullRequest(ctx, epic, ws, forge);
			return described;
		};
		const created = !lane.prUrl;
		if (created) {
			if (!opts.open) return undefined;
			// Say why there is no PR/MR instead of silently skipping it (the thought once per run; the
			// caller turns the returned problem into a question for the user).
			const problem = await forge.preflight(worktree);
			if (problem) {
				const why = `I can't open a ${forge.term}: ${problem}`;
				const key = this.problemKey(ctx, ws);
				if (!this.forgeProblems.has(key)) {
					this.forgeProblems.add(key);
					await reporter.thought(`Commits are pushed to \`${lane.branch}\`${lane === ctx.record ? "" : ` in \`${repo.name}\``}, but ${why}`);
				}
				return why;
			}
			const text = await describe();
			let pr: { url: string; number?: number };
			try {
				pr = await forge.ensure(worktree, {
					branch: lane.branch,
					baseBranch: repo.baseBranch,
					title: prTitle(epic, text?.title),
					body: prBody(epic, text?.body),
				});
			} catch (err) {
				this.forgeProblems.add(this.problemKey(ctx, ws));
				const why = `Couldn't open a ${forge.term} with \`${forge.cli}\`: ${tail(String(err instanceof Error ? err.message : err), 1500)}`;
				await reporter.error(why);
				return why;
			}
			lane.prUrl = pr.url;
			lane.prNumber = pr.number;
			await ctx.persist();
			await reporter.externalUrl(prLabel(pr.url), pr.url);
			await reporter.thought(`Opened a ${opts.ready ? "" : "draft "}${forge.term}: ${pr.url}`);
		}
		// Rewrite the title and description only from a successful description: a failed one keeps what's there.
		const text = opts.final && !created ? await describe() : undefined;
		const edit = text ? { title: prTitle(epic, text.title), body: prBody(epic, text.body) } : {};
		if (lane.prUrl && (text || opts.ready)) await forge.update(worktree, { url: lane.prUrl, number: lane.prNumber }, { ...edit, ready: opts.ready });
		return undefined;
	}

	/**
	 * Title and description for a lane's PR/MR, written by a short read-only agent session from the
	 * branch's changes. Undefined when disabled or when the session fails (callers fall back to a plain one).
	 */
	private async describePullRequest(ctx: EngineRun, epic: Epic, ws: Workspace, forge: Forge): Promise<{ title: string; body: string } | undefined> {
		const { config, runner, log } = this.deps;
		const { record, reporter } = ctx;
		const { repo, lane, worktree } = ws;
		if (!config.ralph.describePullRequest || !lane.branch || ctx.abortSignal.aborted) return undefined;
		const progressFile = join(config.stateDir, "epics", epic.identifier, "progress.md");
		await reporter.thought(`Writing the ${forge.term} title and description${lane === record ? "" : ` for \`${repo.name}\``}.`);
		await this.startClean(ctx, epic, ws, "pr-description");
		const result = await runner
			.run({
				prompt: buildPullRequestPrompt({ epic, branch: lane.branch, baseBranch: repo.baseBranch, prTerm: forge.term, progressFile }),
				cwd: worktree,
				additionalDirectories: this.agentDirs(progressFile, epic),
				model: repo.model ?? config.model,
				fallbackModel: config.fallbackModel,
				allowedTools: repo.allowedTools,
				disallowedTools: [...(repo.disallowedTools ?? []), "Write", "Edit", "NotebookEdit"],
				permissionMode: config.permissionMode,
				abortSignal: ctx.abortSignal,
				systemAppend: PR_DESCRIPTION_SYSTEM_APPEND,
				outputSchema: PR_DESCRIPTION_SCHEMA,
			})
			.catch((e: unknown) => {
				log.warn(`${forge.term} description session failed: ${String(e)}`);
				return undefined;
			});
		await this.stash(ctx, epic, ws, "unfinished", { owner: "pr-description" });
		if (!result) return undefined;
		record.totalCostUsd += result.costUsd ?? 0;
		const text = result.isError || result.aborted ? undefined : readPullRequestDescription(result.structured);
		if (!text) log.warn(`no ${forge.term} description from the agent (${result.errorMessage ?? "no valid structured result"}); using a plain one`);
		return text;
	}

	/**
	 * Push a lane's branch (commits that never reached a remote, e.g. origin was added after the stories
	 * ran) and open or update its PR/MR. Returns what went wrong, if anything.
	 */
	private async publishLane(ctx: EngineRun, epic: Epic, ws: Workspace, all: boolean): Promise<string | undefined> {
		const { config, git, log } = this.deps;
		const { reporter } = ctx;
		const { repo, lane, worktree } = ws;
		let problem: string | undefined;
		if (config.ralph.pushPerStory && lane.branch) {
			try {
				if (await git.needsPush(worktree, repo.baseBranch)) await git.push(worktree, lane.branch);
			} catch (err) {
				problem = `Push failed: ${String(err)}`;
				await reporter.error(problem);
			}
		}
		try {
			// A repository none of the stories committed to (they all went elsewhere) gets no PR/MR.
			if (!lane.prUrl && !(await git.hasCommits(worktree, repo.baseBranch))) return problem;
			// A PR/MR is only opened for a finished epic; a delegated story that leaves others open just pushes.
			problem ??= await this.syncPullRequest(ctx, epic, ws, {
				ready: all && config.ralph.markPrReadyWhenComplete,
				open: all || config.ralph.openPullRequestEarly,
				final: all,
			});
		} catch (err) {
			log.warn(`PR sync failed: ${String(err)}`);
		}
		return problem;
	}

	private async finish(args: {
		ctx: EngineRun;
		epic: Epic;
		inScope: (s: Story) => boolean;
		exhausted: Set<string>;
		hitCap: boolean;
		/** Summary from a direct request session, posted as the outcome. */
		requestOutput?: string;
	}): Promise<SessionStatus> {
		const { ctx, epic, inScope, exhausted, hitCap, requestOutput } = args;
		const { config, linear, log } = this.deps;
		const { record, reporter } = ctx;
		await reporter.plan(planFor(epic, undefined, exhausted));

		if (ctx.abortSignal.aborted) {
			await reporter.response(`Stopped. Progress so far is on \`${record.branch}\`; delegate or reply to resume.`);
			return "stopped";
		}

		// A manual story whose preparation can run now is asked about instead of parking or finishing.
		const prepare = await this.nextPreparation(ctx, epic);
		const scoped = epic.stories.filter(inScope);
		const cost = record.totalCostUsd > 0 ? ` (≈$${record.totalCostUsd.toFixed(2)} of agent usage)` : "";
		if (isEpicComplete(scoped)) {
			const all = isEpicComplete(epic.stories);
			const spaces = await this.laneWorkspaces(ctx, epic, (l) => !!l.branch);
			const problems: string[] = [];
			for (const ws of spaces) {
				const problem = await this.publishLane(ctx, epic, ws, all);
				if (problem) problems.push(spaces.length > 1 ? `In \`${ws.repo.name}\`: ${problem}` : problem);
			}
			if (all && epic.kind !== "single" && (config.ralph.epicCompletedStateName || config.ralph.epicCompletedStateType)) {
				await linear
					.setIssueState(epic.issueId, { name: config.ralph.epicCompletedStateName, type: config.ralph.epicCompletedStateType ?? undefined })
					.catch((e: unknown) => log.warn(String(e)));
			}
			const what = scoped.length === 1 ? `**${scoped[0]?.storyId}**` : `all ${scoped.length} stories of **${epic.identifier}**`;
			if (problems.length) {
				// The work is done but the PR/MR step isn't: stop and ask rather than report success.
				await reporter.elicitation(
					[
						requestOutput,
						`Finished ${what} on \`${record.branch}\`${cost}, but the last step didn't happen. ${problems.join("\n\n")}`,
						"Please fix that on the cyralph host, then reply here (for example `open the MR`) and I'll retry.",
					]
						.filter(Boolean)
						.join("\n\n"),
				);
				return "awaiting_input";
			}
			const deferred =
				!lanesOf(record).some((l) => l.prUrl) && !all && config.ralph.createPullRequest && !config.ralph.openPullRequestEarly
					? " The pull/merge request will be opened once every story of the epic is complete."
					: "";
			const outcome = this.withPullRequestLinks(record, requestOutput ?? `Finished ${what} on \`${record.branch}\`${cost}.${deferred}`);
			if (prepare) {
				await reporter.thought(outcome);
				return this.askPreparation(ctx, epic, prepare);
			}
			await reporter.response(outcome);
			return "completed";
		}

		if (requestOutput) await reporter.thought(requestOutput);
		await this.adoptPullRequests(ctx, epic);

		const byKey = new Map(epic.stories.map((s) => [s.key, s]));
		const isOpen = (d: string) => {
			const s = byKey.get(d);
			return !s || !isStoryDone(s);
		};
		// Outside issues and manual steps that hold up the remaining in-scope stories (directly or via another story).
		const waitingOn = new Map<string, string>();
		const waitForManual = (s: Story | undefined) => {
			if (s?.manual && s.issueId && !isStoryDone(s)) waitingOn.set(s.issueId, s.identifier ?? s.storyId);
		};
		for (const s of scoped.filter((x) => !isStoryDone(x))) {
			waitForManual(s);
			for (const d of s.dependsOn) {
				const ext = externalIdOf(d);
				if (ext) waitingOn.set(ext, dependencyLabel(epic, d));
				waitForManual(byKey.get(d));
			}
		}
		const blockerChain = (s: Story, seen = new Set<string>()): void => {
			for (const d of s.dependsOn) {
				const dep = byKey.get(d);
				if (!dep || isStoryDone(dep) || seen.has(d)) continue;
				seen.add(d);
				for (const dd of dep.dependsOn) {
					const ext = externalIdOf(dd);
					if (ext) waitingOn.set(ext, dependencyLabel(epic, dd));
					waitForManual(byKey.get(dd));
				}
				blockerChain(dep, seen);
			}
		};
		for (const s of scoped.filter((x) => !isStoryDone(x))) blockerChain(s);
		// A focused (single-story) run can't do its sibling prerequisites itself: wait for them too.
		if (record.focusStoryKey) {
			for (const d of byKey.get(record.focusStoryKey)?.dependsOn ?? []) {
				const dep = byKey.get(d);
				if (dep?.issueId && !isStoryDone(dep) && !exhausted.has(dep.key)) waitingOn.set(dep.issueId, dep.identifier ?? dep.storyId);
			}
		}
		record.waitingOn = [...waitingOn].map(([id, identifier]) => ({ id, identifier }));

		const stuck = scoped.filter((s) => exhausted.has(s.key));
		if (!hitCap && stuck.length === 0 && record.waitingOn.length > 0) {
			const done = scoped.filter(isStoryDone).length;
			const lead = `${done}/${scoped.length} stories are done; the rest are waiting`;
			if (prepare) {
				// Still parked on the manual steps: marking one done wakes the session as usual.
				await ctx.reporter.plan(planFor(epic));
				const names = record.waitingOn.map((b) => `**${b.identifier}**`).join(", ");
				return this.askPreparation(ctx, epic, prepare, `${lead} on ${names}.`);
			}
			return this.park(ctx, epic, record.waitingOn, lead);
		}

		const lines: string[] = [];
		if (hitCap) lines.push(`I reached the per-run iteration cap (${config.ralph.maxIterationsPerRun}).`);
		for (const s of stuck) {
			const problem = tail(record.lastFeedback[s.key] ?? "unknown", 1500);
			lines.push(
				record.blockedKeys?.includes(s.key)
					? `**${s.storyId}: ${s.title}** is blocked, so I didn't retry it:\n\n${problem}`
					: `**${s.storyId}: ${s.title}** failed ${record.attempts[s.key]} attempts. Last problem:\n\n${problem}`,
			);
		}
		const blocked = blockedStories(scoped, exhausted);
		for (const s of blocked) {
			const why = s.dependsOn.filter(isOpen).map((d) => dependencyLabel(epic, d));
			lines.push(`**${s.storyId}** is blocked by ${why.join(", ")}.`);
		}
		if (record.focusStoryKey && lines.length === 0) {
			const s = byKey.get(record.focusStoryKey);
			if (s && !isStoryDone(s)) lines.push(`**${s.storyId}** is waiting on dependencies that aren't done yet.`);
		}
		const done = scoped.filter(isStoryDone).length;
		await reporter.elicitation(
			[
				`Paused with ${done}/${scoped.length} stories complete on \`${record.branch}\`${cost}.`,
				...lines,
				record.waitingOn.length
					? `I'll also resume on my own when ${record.waitingOn.map((w) => w.identifier).join(", ")} is done.`
					: "",
				"Reply with guidance (it will be added to every story prompt) and I'll retry, or say `stop`.",
			]
				.filter(Boolean)
				.join("\n\n"),
		);
		return "awaiting_input";
	}

	/**
	 * The manual story whose preparation to ask about next, in story order, keeping the one already asked
	 * about while it can still run. A question whose story can't run anymore (done, blocked again) is
	 * dropped. With `allowPreparation: false` every such story is left to a person and nothing is asked.
	 */
	private async nextPreparation(ctx: EngineRun, epic: Epic): Promise<Story | undefined> {
		const { record, reporter } = ctx;
		const eligible = eligiblePreparations(epic, record);
		const pending = record.preparationRequest;
		if (pending && !eligible.some((s) => s.key === pending.storyKey)) {
			record.preparationRequest = undefined;
			await ctx.persist();
		}
		const repo = this.repoById(record.repoId);
		if (!repo || eligible.length === 0) return undefined;
		if (!allowPreparationFor(this.deps.config, repo)) {
			record.preparationHandled = [...(record.preparationHandled ?? []), ...eligible.map((s) => s.key)];
			record.preparationRequest = undefined;
			await ctx.persist();
			for (const s of eligible) {
				await reporter.thought(
					`Preparation is disabled (\`allowPreparation: false\`), so I won't offer to run the preparation commands of **${s.storyId}**: they're yours to do, with the rest of the step.`,
				);
			}
			return undefined;
		}
		return eligible.find((s) => s.key === record.preparationRequest?.storyKey) ?? eligible[0];
	}

	/**
	 * Ask in the session whether to run a manual story's preparation commands, bound to the commands and
	 * the worktree `HEAD` shown. The epic branch is pushed first, so `origin` has the commit shown.
	 */
	private async askPreparation(ctx: EngineRun, epic: Epic, story: Story, lead?: string): Promise<SessionStatus> {
		const { git } = this.deps;
		const { record, reporter } = ctx;
		const repo = this.repoById(record.repoId);
		if (!repo) return "awaiting_input";
		const ws = await this.workspaceFor(ctx, epic, repo);
		if (!("worktree" in ws)) return ws.status;
		const branch = ws.lane.branch ?? epic.branchName;
		try {
			if (await git.needsPush(ws.worktree, ws.repo.baseBranch)) await git.push(ws.worktree, branch);
		} catch (err) {
			await reporter.error(`Push failed before asking about the preparation of ${story.storyId}: ${String(err)}`);
		}
		const commands = story.preparation ?? [];
		record.preparationRequest = {
			storyKey: story.key,
			storyId: story.storyId,
			repoId: repo.id,
			branch,
			headSha: await git.headSha(ws.worktree),
			commandsHash: preparationHash(commands),
			askedAt: new Date().toISOString(),
		};
		await ctx.persist();
		await reporter.select(preparationQuestion(story, record.preparationRequest, commands, lead), PREPARATION_OPTIONS);
		return "awaiting_input";
	}

	/** Park the session until an outside blocker is resolved (Issue webhook or poll wakes it). */
	private async park(ctx: EngineRun, epic: Epic, blockers: Array<{ id: string; identifier: string }>, lead: string): Promise<SessionStatus> {
		ctx.record.waitingOn = blockers;
		await ctx.persist();
		await ctx.reporter.plan(planFor(epic));
		const names = blockers.map((b) => `**${b.identifier}**`).join(", ");
		await ctx.reporter.elicitation(
			`${lead} on ${names}. I'll start automatically when ${blockers.length > 1 ? "any of them is" : "it's"} done or canceled.\n\nReply \`start anyway\` to ignore the blockers, or \`stop\` to cancel.`,
		);
		return "blocked";
	}
}
