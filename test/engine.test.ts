import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunner, RunRequest, RunResult } from "../src/agent/runner.js";
import { type RepositoryConfig, parseConfig } from "../src/config.js";
import { SessionManager } from "../src/engine/session-manager.js";
import { preparationHash } from "../src/engine/preparation.js";
import { SessionStore, newRecord } from "../src/engine/store.js";
import { CliGitWorkspace, type Forge, runShell } from "../src/git/workspace.js";
import { PR_DESCRIPTION_HEADING, PR_DESCRIPTION_SCHEMA, STORY_OUTPUT_SCHEMA, type StoryOutcome } from "../src/ralph/prompt.js";
import { buildStoryIssueBody } from "../src/ralph/story-body.js";
import { silentLogger } from "../src/logger.js";
import type { AttachmentFetcher } from "../src/linear/attachments.js";
import type { GitHubReview, GitHubReviewClient, ReviewComment, ReviewSubmitted } from "../src/github/reviews.js";
import type { ChangeRequestRef, CiClient, CiFailedJob, CiStatus } from "../src/git/ci.js";
import { FakeLinear } from "./fakes.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function makeRepo(opts: { remote?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "cyralph-test-"));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	execFileSync("git", ["init", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", origin, repo], { stdio: "ignore" });
	sh(repo, "config", "user.email", "t@example.com");
	sh(repo, "config", "user.name", "Test");
	sh(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "hi\n");
	sh(repo, "add", ".");
	sh(repo, "commit", "-m", "init");
	sh(repo, "push", "-u", "origin", "main");
	if (opts.remote === false) sh(repo, "remote", "remove", "origin");
	return { root, origin, repo };
}

class TestGit extends CliGitWorkspace {
	prs: string[] = [];
	/** Commits on the branch each time a PR/MR was opened (to check when it happened). */
	prOpenedAtCommits: number[] = [];
	/** Simulates a PR opened outside the orchestrator (e.g. by the agent via `gh`). */
	externalPr = false;
	/** Simulates the forge CLI being unusable (e.g. `glab` not logged in). */
	preflightProblem: string | undefined;
	forgeOpts: Array<Record<string, unknown> | undefined> = [];
	/** Title and body each PR/MR was opened with. */
	opened: Array<{ title: string; body: string }> = [];
	updates: Array<{ title?: string; body?: string; ready?: boolean }> = [];
	/** PR/MR number per `origin`: the first repository's is 7, another repository's 8, and so on. */
	private numbers = new Map<string, number>();
	private opens = new Set<string>();
	override async forge(cwd: string, opts?: Parameters<CliGitWorkspace["forge"]>[1]): Promise<Forge | undefined> {
		this.forgeOpts.push(opts);
		const real = await super.forge(cwd, opts);
		if (!real) return undefined;
		const origin = (await this.remoteUrl(cwd)) ?? cwd;
		if (!this.numbers.has(origin)) this.numbers.set(origin, 7 + this.numbers.size);
		const number = this.numbers.get(origin) ?? 7;
		const url = real.kind === "gitlab" ? `https://git.example.com/acme/app/-/merge_requests/${number}` : `https://github.com/acme/app/pull/${number}`;
		const found = () => (this.opens.has(origin) || this.externalPr ? { url, number } : undefined);
		return {
			kind: real.kind,
			cli: real.cli,
			term: real.term,
			agentInstructions: (o) => real.agentInstructions(o),
			preflight: async () => this.preflightProblem,
			find: async () => found(),
			ensure: async (dir, o) => {
				this.prs.push("created");
				this.opens.add(origin);
				this.opened.push({ title: o.title, body: o.body });
				this.prOpenedAtCommits.push(Number(sh(dir, "rev-list", "--count", `origin/${o.baseBranch}..HEAD`).trim()));
				return { url, number };
			},
			update: async (_dir, _pr, o) => {
				this.updates.push(o);
			},
		};
	}
}

/** Serves fake PNGs for upload URLs; `fail` makes specific URLs return 401. */
class FakeFetcher implements AttachmentFetcher {
	calls: string[] = [];
	fail = new Set<string>();
	async download(url: string) {
		this.calls.push(url);
		if (this.fail.has(url)) return { ok: false, status: 401, contentType: "", error: "HTTP 401" };
		return { ok: true, status: 200, contentType: "image/png", data: Buffer.from(`PNG:${url}`) };
	}
}

/** Implements a story by writing `<storyId>.txt`; can be told to fail specific attempts. */
class ScriptedRunner implements AgentRunner {
	calls: RunRequest[] = [];
	/** Sessions that wrote a PR/MR title and description (kept out of `calls`). */
	describeCalls: RunRequest[] = [];
	/** Structured result of a describe session; undefined = it fails. */
	description: { title: string; body: string } | undefined = {
		title: "Add task priorities with badges and sorting",
		body: "Tasks get a priority.\n\n**Breaking changes**: none.",
	};
	failFirst = new Set<string>();
	neverComplete = new Set<string>();
	/** Custom behaviour per story id, by how many times that story has run (1 = first); undefined = the default. */
	script = new Map<string, (req: RunRequest, run: number) => Promise<RunResult | undefined> | RunResult | undefined>();
	async run(req: RunRequest): Promise<RunResult> {
		if (req.prompt.includes(PR_DESCRIPTION_HEADING)) {
			this.describeCalls.push(req);
			if (this.description === undefined) return { output: "", isError: true, aborted: false, errorMessage: "error_during_execution" };
			return { output: "Looked at the diff.", structured: this.description, isError: false, aborted: false, costUsd: 0.05 };
		}
		this.calls.push(req);
		const id = /## Your Task: (\S+)/.exec(req.prompt)?.[1] ?? "unknown";
		const run = this.calls.filter((c) => c.prompt.includes(`## Your Task: ${id} `)).length;
		const scripted = await this.script.get(id)?.(req, run);
		if (scripted) return scripted;
		req.onEvent?.({ type: "tool", name: "Write", input: { file_path: `${id}.txt` } });
		if (this.neverComplete.has(id) || this.failFirst.delete(id)) {
			writeFileSync(join(req.cwd, `${id}.partial`), "wip\n");
			return { ...outcome("incomplete", "I got stuck on the migration."), costUsd: 0.1 };
		}
		writeFileSync(join(req.cwd, `${id}.txt`), `${id}\n`);
		// Git config for commits made by the engine inside the worktree.
		return { ...outcome("complete", `Implemented ${id}.`), costUsd: 0.25 };
	}
}

/** A story session that ended with this structured result (its summary doubles as the final message). */
function outcome(status: StoryOutcome["status"], summary: string, extra: Partial<StoryOutcome> = {}): RunResult {
	return { output: summary, structured: { status, summary, followUps: [], ...extra }, isError: false, aborted: false };
}

function setup(
	overrides: Record<string, unknown> = {},
	repoOpts: { remote?: boolean } = {},
	extra: { repo?: Record<string, unknown>; config?: Record<string, unknown>; github?: GitHubReviewClient; ci?: CiClient } = {},
) {
	const { root, repo, origin } = makeRepo(repoOpts);
	const config = parseConfig(
		{
			repositories: [{ id: "app", name: "app", repositoryPath: repo, baseBranch: "main", ...extra.repo }],
			ralph: { maxAttemptsPerStory: 2, ...overrides },
			...extra.config,
		},
		join(root, "config.json"),
	);
	const linear = new FakeLinear();
	const runner = new ScriptedRunner();
	const git = new TestGit();
	const store = new SessionStore(join(root, "sessions.json"));
	const fetcher = new FakeFetcher();
	const manager = new SessionManager({ config, linear, runner, git, shell: runShell, log: silentLogger, attachments: fetcher, github: extra.github, ci: extra.ci }, store);
	return { root, repo, origin, config, linear, runner, git, store, manager, fetcher };
}

function ralphEpic(linear: FakeLinear) {
	const epic = linear.add({ title: "Task Priority System", identifier: "ENG-1", branchName: "eng-1-task-priority", description: "PRD overview" });
	const s1 = linear.add({
		title: "Add priority field",
		identifier: "ENG-2",
		parentId: epic.id,
		priority: 2,
		subIssueSortOrder: 0,
		description: buildStoryIssueBody({ description: "store priority", acceptanceCriteria: ["column exists"] }),
	});
	const s2 = linear.add({
		title: "Show badge",
		identifier: "ENG-3",
		parentId: epic.id,
		priority: 2,
		subIssueSortOrder: 1,
		description: buildStoryIssueBody({ description: "badge", acceptanceCriteria: ["badge"] }),
	});
	const s3 = linear.add({
		title: "Sort by priority",
		identifier: "ENG-4",
		parentId: epic.id,
		priority: 3,
		subIssueSortOrder: 2,
		description: buildStoryIssueBody({ description: "sort", acceptanceCriteria: ["sorted"] }),
	});
	// ENG-3 is blocked by ENG-2, so despite equal priority order is ENG-2, ENG-3, then ENG-4.
	linear.blocks.set(s2.id, [s1.id]);
	return { epic, s1, s2, s3 };
}

// Engine commits inside worktrees; give git an identity for those.
beforeEach(() => {
	process.env.GIT_AUTHOR_NAME = "cyralph";
	process.env.GIT_AUTHOR_EMAIL = "cyralph@example.com";
	process.env.GIT_COMMITTER_NAME = "cyralph";
	process.env.GIT_COMMITTER_EMAIL = "cyralph@example.com";
});

describe("epic engine (end to end with fakes + real git)", () => {
	it("works every story in dependency order, one commit per story, and marks children done", async () => {
		const t = setup();
		const { epic, s1, s2, s3 } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "sess-1", issueId: epic.id });
		await t.manager.idle();

		const order = t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);
		expect(order).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
		for (const s of [s1, s2, s3]) expect(t.linear.issues.get(s.id)?.stateType).toBe("completed");
		expect(t.linear.issues.get(epic.id)?.stateType).toBe("started");

		const record = t.store.get("sess-1");
		expect(record?.status).toBe("completed");
		expect(record?.prUrl).toBe("https://github.com/acme/app/pull/7");
		expect(t.linear.urls).toEqual([{ label: "Pull request", url: "https://github.com/acme/app/pull/7" }]);

		const wt = record?.worktreePath ?? "";
		const log = sh(wt, "log", "--format=%s", "main..HEAD").trim().split("\n");
		expect(log).toEqual(["feat(ENG-4): Sort by priority", "feat(ENG-3): Show badge", "feat(ENG-2): Add priority field"]);
		// Pushed to origin.
		expect(sh(t.origin, "rev-parse", "eng-1-task-priority").trim()).toBe(sh(wt, "rev-parse", "HEAD").trim());

		// Prompts carry PRD context and progress file.
		expect(t.runner.calls[1]?.prompt).toContain("- [x] ENG-2: Add priority field");
		expect(t.runner.calls[0]?.additionalDirectories?.[0]).toContain(join("epics", "ENG-1"));

		const final = t.linear.bodies("response").at(-1);
		expect(final).toContain("all 3 stories of **ENG-1**");
		expect(t.linear.plans.at(-1)?.every((p) => p.status === "completed")).toBe(true);
		expect(t.linear.comments.filter((c) => c.body.startsWith("✅ Completed by cyralph"))).toHaveLength(3);
		expect(t.linear.activities.some((a) => a.content.type === "action" && a.ephemeral)).toBe(true);
	});

	it("retries with feedback, sets aside exhausted stories, and resumes on guidance", async () => {
		const t = setup();
		const { epic, s2 } = ralphEpic(t.linear);
		t.runner.failFirst.add("ENG-4");
		t.runner.neverComplete.add("ENG-2");

		await t.manager.handle({ kind: "created", sessionId: "sess-2", issueId: epic.id });
		await t.manager.idle();

		const ids = t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);
		// ENG-2 twice (exhausted), ENG-3 blocked by it, ENG-4 fails once then succeeds.
		expect(ids).toEqual(["ENG-2", "ENG-2", "ENG-4", "ENG-4"]);
		expect(t.runner.calls[1]?.prompt).toContain("I got stuck on the migration.");
		expect(t.store.get("sess-2")?.status).toBe("awaiting_input");
		const ask = t.linear.bodies("elicitation").at(-1) ?? "";
		expect(ask).toContain("ENG-2: Add priority field** failed 2 attempts");
		expect(ask).toContain("**ENG-3** is blocked by ENG-2");
		// Partial work of every unfinished attempt was stashed, so none of it leaks into ENG-4's commit.
		// ENG-4's own stash from its failed first attempt was offered to the retry and dropped once it committed.
		const wt = t.store.get("sess-2")?.worktreePath ?? "";
		expect(sh(wt, "show", "--stat", "--format=", "HEAD")).not.toContain("ENG-2");
		expect(sh(wt, "show", "--stat", "--format=", "HEAD")).not.toContain("ENG-4.partial");
		expect(t.runner.calls[3]?.prompt).toContain("cyralph: ENG-1 ENG-4 incomplete");
		const stashes = sh(wt, "stash", "list");
		expect(stashes).toContain("cyralph: ENG-1 ENG-2 incomplete");
		expect(stashes).toContain("cyralph: ENG-1 ENG-2 exhausted");
		expect(stashes).not.toContain("ENG-4");

		// Human replies with guidance; the loop resumes with a fresh attempt budget.
		t.runner.neverComplete.clear();
		await t.manager.handle({ kind: "prompted", sessionId: "sess-2", issueId: epic.id, body: "The column should be nullable." });
		await t.manager.idle();
		expect(t.store.get("sess-2")?.status).toBe("completed");
		const resumed = t.runner.calls.slice(4);
		expect(resumed.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1])).toEqual(["ENG-2", "ENG-3"]);
		expect(resumed[0]?.prompt).toContain("- The column should be nullable.");
		expect(t.linear.issues.get(s2.id)?.stateType).toBe("completed");
	});

	it("sets a story that reports it is blocked aside without retrying, until a reply", async () => {
		const t = setup({ maxAttemptsPerStory: 3 });
		const { epic, s1 } = ralphEpic(t.linear);
		t.runner.script.set("ENG-2", (req, run) => {
			if (run > 1) return undefined;
			expect(req.outputSchema).toBe(STORY_OUTPUT_SCHEMA);
			writeFileSync(join(req.cwd, "ENG-2.partial"), "wip\n");
			// The result decides, not signals quoted in the message text.
			return { ...outcome("blocked", "The database credentials are missing."), output: "The database credentials are missing.\n<promise>COMPLETE</promise>" };
		});

		await t.manager.handle({ kind: "created", sessionId: "sess-b", issueId: epic.id });
		await t.manager.idle();

		const ids = t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);
		// One attempt only; ENG-3 depends on it, ENG-4 still runs.
		expect(ids).toEqual(["ENG-2", "ENG-4"]);
		const record = t.store.get("sess-b");
		expect(record?.status).toBe("awaiting_input");
		expect(t.linear.issues.get(s1.id)?.stateType).not.toBe("completed");
		expect(t.linear.bodies("thought").join("\n")).toContain("ENG-2 is blocked; setting it aside without retrying (partial work stashed)");
		const ask = t.linear.bodies("elicitation").at(-1) ?? "";
		expect(ask).toContain("**ENG-2: Add priority field** is blocked, so I didn't retry it");
		expect(ask).toContain("The database credentials are missing.");
		expect(ask).not.toContain("failed 3 attempts");
		const wt = record?.worktreePath ?? "";
		expect(sh(wt, "log", "--format=%s", "main..HEAD")).not.toContain("ENG-2");

		// A reply unblocks it: the story runs again with the reply as guidance.
		await t.manager.handle({ kind: "prompted", sessionId: "sess-b", issueId: epic.id, body: "Credentials are in .env now." });
		await t.manager.idle();
		expect(t.store.get("sess-b")?.status).toBe("completed");
		const resumed = t.runner.calls.slice(2);
		expect(resumed.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1])).toEqual(["ENG-2", "ENG-3"]);
		expect(resumed[0]?.prompt).toContain("The previous session reported it was blocked");
		expect(resumed[0]?.prompt).toContain("- Credentials are in .env now.");
		// Its partial work was stashed under its label, offered to the next run, and dropped once ENG-2 committed.
		expect(resumed[0]?.prompt).toContain("cyralph: ENG-1 ENG-2 blocked");
		expect(sh(wt, "stash", "list")).toBe("");
	});

	it("doesn't mark a story done when its commit fails, and retries it with the hook's output", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		writeFileSync(join(t.repo, ".git", "hooks", "pre-commit"), '#!/bin/sh\nif [ -f ENG-2.lint ]; then echo "lint: ENG-2 is not formatted" >&2; exit 1; fi\n', { mode: 0o755 });
		t.runner.script.set("ENG-2", (req, run) => {
			if (run === 1) writeFileSync(join(req.cwd, "ENG-2.lint"), "unformatted\n");
			else rmSync(join(req.cwd, "ENG-2.lint"), { force: true });
			return undefined;
		});

		await t.manager.handle({ kind: "created", sessionId: "sess-c", issueId: epic.id });
		await t.manager.idle();

		const ids = t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);
		expect(ids).toEqual(["ENG-2", "ENG-2", "ENG-3", "ENG-4"]);
		expect(t.runner.calls[1]?.prompt).toContain("committing the work failed");
		expect(t.runner.calls[1]?.prompt).toContain("lint: ENG-2 is not formatted");
		// Marked Done once, after the commit that went through.
		expect(t.linear.comments.filter((c) => c.body.startsWith("✅ Completed by cyralph"))).toHaveLength(3);
		expect(t.linear.issues.get(s1.id)?.stateType).toBe("completed");
		const wt = t.store.get("sess-c")?.worktreePath ?? "";
		expect(sh(wt, "log", "--format=%s", "main..HEAD").trim().split("\n")).toEqual([
			"feat(ENG-4): Sort by priority",
			"feat(ENG-3): Show badge",
			"feat(ENG-2): Add priority field",
		]);
		expect(sh(wt, "status", "--porcelain")).toBe("");
	});

	it("doesn't mark a story done while files stay uncommitted after its commit, and sets it aside once out of attempts", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		// A hook that writes a file after staging, so every commit of ENG-2 leaves the worktree dirty.
		writeFileSync(
			join(t.repo, ".git", "hooks", "pre-commit"),
			"#!/bin/sh\nif git diff --cached --name-only | grep -qx ENG-2.txt; then date +%s%N > coverage.out; fi\n",
			{ mode: 0o755 },
		);
		t.runner.script.set("ENG-2", (req, run) => {
			writeFileSync(join(req.cwd, "ENG-2.txt"), `ENG-2 run ${run}\n`);
			return outcome("complete", "Implemented ENG-2.");
		});

		await t.manager.handle({ kind: "created", sessionId: "sess-d", issueId: epic.id });
		await t.manager.idle();

		const ids = t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);
		// ENG-2 exhausts its attempts, ENG-3 waits on it, ENG-4 still runs.
		expect(ids).toEqual(["ENG-2", "ENG-2", "ENG-4"]);
		expect(t.runner.calls[1]?.prompt).toContain("these files were still uncommitted");
		expect(t.runner.calls[1]?.prompt).toContain("coverage.out");
		expect(t.linear.issues.get(s1.id)?.stateType).not.toBe("completed");
		expect(t.linear.comments.some((c) => c.body.startsWith("✅ Completed by cyralph") && c.issueId === s1.id)).toBe(false);
		expect(t.store.get("sess-d")?.status).toBe("awaiting_input");
		expect(t.linear.bodies("elicitation").at(-1) ?? "").toContain("ENG-2: Add priority field** failed 2 attempts");
		// The leftovers were stashed, so ENG-4's commit doesn't sweep them in.
		const wt = t.store.get("sess-d")?.worktreePath ?? "";
		expect(sh(wt, "show", "--stat", "--format=", "HEAD")).not.toContain("coverage.out");
		expect(sh(wt, "stash", "list")).toContain("cyralph: ENG-1 ENG-2 exhausted");
		expect(sh(wt, "status", "--porcelain")).toBe("");
	});

	it("materializes a PRD in the description into sub-issues with Linear metadata", async () => {
		const t = setup();
		const epic = t.linear.add({
			title: "Dark mode",
			identifier: "ENG-50",
			description: `# PRD: Dark Mode\n\n## Quality Gates\n- \`true\` - always passes\n\n## User Stories\n\n### US-001: Theme tokens\n**Description:** tokens\n\n**Acceptance Criteria:**\n- [ ] tokens exist\n\n### US-002: Toggle\n**Priority:** 2\n\n**Depends on:** US-001\n\n**Acceptance Criteria:**\n- [ ] toggle works\n`,
		});
		await t.manager.handle({ kind: "created", sessionId: "sess-3", issueId: epic.id });
		await t.manager.idle();
		const children = await t.linear.getChildren(epic.id);
		expect(children.map((c) => c.title)).toEqual(["Theme tokens", "Toggle"]);
		expect(children.map((c) => c.description).join("\n")).not.toMatch(/Ralph|US-00/);
		expect(children.map((c) => [c.priority, c.subIssueSortOrder])).toEqual([
			[3, 0],
			[2, 1],
		]);
		expect(t.linear.blocks.get(children[1]?.id ?? "")).toEqual([children[0]?.id]);
		expect(children.every((c) => c.stateType === "completed")).toBe(true);
		expect(t.runner.calls[0]?.prompt).toContain("- `true`");
	});

	it("fails a story whose verify command fails even if the agent claims completion", async () => {
		const t = setup();
		t.config.repositories[0]!.verifyCommands = ["test -f VERIFIED"];
		const issue = t.linear.add({ title: "Fix login bug", identifier: "ENG-70", description: "Users can't log in.\n\n- [ ] login works" });
		await t.manager.handle({ kind: "created", sessionId: "sess-4", issueId: issue.id });
		await t.manager.idle();
		expect(t.runner.calls).toHaveLength(2);
		expect(t.runner.calls[1]?.prompt).toContain("verification command `test -f VERIFIED` failed");
		expect(t.store.get("sess-4")?.status).toBe("awaiting_input");
		// Single-issue epics never get auto-closed.
		expect(t.linear.issues.get(issue.id)?.stateType).toBe("started");
	});

	it("runs a check that is both a quality gate and a verify command once, and tells the agent it needn't", async () => {
		const t = setup();
		const log = join(mkdtempSync(join(tmpdir(), "cyralph-verify-")), "runs");
		const check = `echo run >> ${log}`;
		t.config.repositories[0]!.verifyCommands = [check];
		t.config.repositories[0]!.runPrdQualityGates = true;
		const issue = t.linear.add({
			title: "Fix login bug",
			identifier: "ENG-71",
			description: `Users can't log in.\n\n- [ ] login works\n\n## Quality Gates\n- \`${check}\`\n- \`true\`\n`,
		});
		await t.manager.handle({ kind: "created", sessionId: "sess-dedupe", issueId: issue.id });
		await t.manager.idle();
		expect(readFileSync(log, "utf8")).toBe("run\n");
		const [gates = "", checked = ""] = t.runner.calls[0]?.prompt.split("### Checked by the Orchestrator") ?? [];
		// runPrdQualityGates hands every gate to the orchestrator, so none is left for the agent.
		expect(gates).not.toContain("### Quality Gates");
		expect(checked).toContain(`- \`${check}\``);
		expect(checked).toContain("- `true`");
	});

	it("focuses on one story when a story issue is delegated directly", async () => {
		const t = setup();
		const { s3 } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "sess-5", issueId: s3.id });
		await t.manager.idle();
		expect(t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1])).toEqual(["ENG-4"]);
		expect(t.store.get("sess-5")?.status).toBe("completed");
		expect(existsSync(join(t.store.get("sess-5")?.worktreePath ?? "", "ENG-4.txt"))).toBe(true);
	});

	it("opens the PR only once every story of the epic is complete, not after the first push", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "pr-1", issueId: epic.id });
		await t.manager.idle();
		expect(t.git.prs).toEqual(["created"]);
		expect(t.git.prOpenedAtCommits).toEqual([3]);
		expect(t.linear.bodies("thought")).toContain("Opened a pull request: https://github.com/acme/app/pull/7");
	});

	it("doesn't open a PR for a delegated story that leaves the epic unfinished", async () => {
		const t = setup();
		const { s3 } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "pr-2", issueId: s3.id });
		await t.manager.idle();
		expect(t.store.get("pr-2")?.status).toBe("completed");
		expect(t.git.prs).toEqual([]);
		expect(t.store.get("pr-2")?.prUrl).toBeUndefined();
		expect(t.linear.bodies("response").at(-1)).toContain("will be opened once every story of the epic is complete");
	});

	it("opens a draft PR after the first push with openPullRequestEarly", async () => {
		const t = setup({ openPullRequestEarly: true });
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "pr-3", issueId: epic.id });
		await t.manager.idle();
		expect(t.git.prOpenedAtCommits).toEqual([1]);
		expect(t.linear.bodies("thought")).toContain("Opened a draft pull request: https://github.com/acme/app/pull/7");
	});

	it("titles and describes the PR from the branch's changes, without the story list", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		t.linear.issues.get(epic.id)!.url = "https://linear.app/acme/issue/ENG-1";
		await t.manager.handle({ kind: "created", sessionId: "pr-4", issueId: epic.id });
		await t.manager.idle();
		expect(t.runner.describeCalls).toHaveLength(1);
		const describe = t.runner.describeCalls[0]!;
		expect(describe.outputSchema).toBe(PR_DESCRIPTION_SCHEMA);
		expect(describe.prompt).toContain("git diff origin/main...HEAD");
		expect(describe.prompt).toContain("Do NOT list the user stories");
		expect(describe.prompt).not.toContain("US-001");
		expect(describe.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit"]));
		expect(t.git.opened).toEqual([
			{
				title: "ENG-1: Add task priorities with badges and sorting",
				body: "Tasks get a priority.\n\n**Breaking changes**: none.\n\n---\nLinear: [ENG-1](https://linear.app/acme/issue/ENG-1) · _Opened by cyralph._",
			},
		]);
		// Opened by this run already: only marked ready, not described a second time.
		expect(t.git.updates).toEqual([{ ready: true }]);
		expect(t.store.get("pr-4")?.totalCostUsd).toBeCloseTo(0.8);
	});

	it("falls back to a plain title and description when the describe session fails", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		t.runner.description = undefined;
		await t.manager.handle({ kind: "created", sessionId: "pr-5", issueId: epic.id });
		await t.manager.idle();
		expect(t.git.opened).toEqual([{ title: "ENG-1: Task Priority System", body: expect.stringMatching(/^Implements Task Priority System\.\n/) }]);
		expect(t.git.opened[0]?.body).not.toContain("US-00");
		expect(t.linear.bodies("error")).toEqual([]);
	});

	it("rewrites an early PR's title and description once the epic is complete", async () => {
		const t = setup({ openPullRequestEarly: true });
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "pr-6", issueId: epic.id });
		await t.manager.idle();
		expect(t.git.opened).toHaveLength(1);
		// Opened after the first story, then left alone until the last one, then rewritten from the whole branch.
		expect(t.runner.describeCalls).toHaveLength(2);
		expect(t.git.updates).toEqual([{ title: "ENG-1: Add task priorities with badges and sorting", body: t.git.opened[0]?.body, ready: true }]);
	});

	it("can be told not to run a describe session", async () => {
		const t = setup({ describePullRequest: false });
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "pr-7", issueId: epic.id });
		await t.manager.idle();
		expect(t.runner.describeCalls).toHaveLength(0);
		expect(t.git.opened[0]?.title).toBe("ENG-1: Task Priority System");
	});

	it("stops a running session on a stop signal", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		let release: () => void = () => {};
		t.runner.run = async (req) => {
			t.runner.calls.push(req);
			await new Promise<void>((r) => {
				release = r;
				req.abortSignal.addEventListener("abort", () => r());
			});
			return { output: "", isError: false, aborted: req.abortSignal.aborted };
		};
		await t.manager.handle({ kind: "created", sessionId: "sess-6", issueId: epic.id });
		await new Promise((r) => setTimeout(r, 300));
		expect(t.manager.isActive("sess-6")).toBe(true);
		await t.manager.handle({ kind: "prompted", sessionId: "sess-6", body: "stop" });
		await t.manager.idle();
		release();
		expect(t.store.get("sess-6")?.status).toBe("stopped");
		expect(t.runner.calls).toHaveLength(1);
		expect(t.store.get("sess-6")?.attempts).toEqual({ [[...t.linear.issues.values()].find((i) => i.identifier === "ENG-2")?.id ?? ""]: 0 });
		expect(readFileSync(join(t.root, "sessions.json"), "utf8")).toContain('"stopped"');
	});
});

describe("blocking / blocked-by relations", () => {
	const taskOrder = (t: ReturnType<typeof setup>) => t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);

	it("parks an epic that is blocked by another issue and resumes when the blocker is done (Issue webhook)", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		const blocker = t.linear.add({ title: "Design review", identifier: "ENG-99", stateType: "started" });
		t.linear.blocks.set(epic.id, [blocker.id]);

		await t.manager.handle({ kind: "created", sessionId: "b-1", issueId: epic.id });
		await t.manager.idle();
		expect(t.runner.calls).toHaveLength(0);
		const rec = t.store.get("b-1");
		expect(rec?.status).toBe("blocked");
		expect(rec?.waitingOn).toEqual([{ id: blocker.id, identifier: "ENG-99" }]);
		expect(rec?.worktreePath).toBeUndefined();
		expect(t.linear.issues.get(epic.id)?.stateType).toBe("unstarted");
		expect(t.linear.bodies("elicitation").at(-1)).toContain("**ENG-1** is blocked on **ENG-99**");

		// Unrelated state changes and non-resolving transitions don't wake it.
		await t.manager.handle({ kind: "issue_state", issueId: blocker.id, stateType: "unstarted", removed: false });
		await t.manager.idle();
		expect(t.store.get("b-1")?.status).toBe("blocked");

		t.linear.issues.get(blocker.id)!.stateType = "completed";
		await t.manager.handle({ kind: "issue_state", issueId: blocker.id, identifier: "ENG-99", stateType: "completed", removed: false });
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
		expect(t.store.get("b-1")?.status).toBe("completed");
		expect(t.linear.bodies("thought")).toContain("ENG-99 is done. Re-checking blockers and resuming.");
	});

	it("runs unblocked stories first, parks on an outside blocker of one story, and resumes via reconcile", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		const api = t.linear.add({ title: "Ship API v2", identifier: "API-7", stateType: "started" });
		// ENG-2 waits on another team's issue; ENG-3 depends on ENG-2; ENG-4 is free.
		t.linear.blocks.set(s1.id, [api.id]);

		await t.manager.handle({ kind: "created", sessionId: "b-2", issueId: epic.id });
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-4"]);
		expect(t.store.get("b-2")?.status).toBe("blocked");
		expect(t.store.get("b-2")?.waitingOn).toEqual([{ id: api.id, identifier: "API-7" }]);
		expect(t.linear.bodies("elicitation").at(-1)).toContain("1/3 stories are done; the rest are waiting on **API-7**");
		expect(t.runner.calls[0]?.prompt).toContain("ENG-2: Add priority field (depends on API-7)");

		// The webhook was missed; the periodic reconcile notices the blocker closed.
		await t.manager.reconcileParked();
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-4"]);
		t.linear.issues.get(api.id)!.stateType = "canceled";
		await t.manager.reconcileParked();
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-4", "ENG-2", "ENG-3"]);
		expect(t.store.get("b-2")?.status).toBe("completed");
		expect(t.store.get("b-2")?.waitingOn).toEqual([]);
	});

	it("honours blocked-by on a plain issue, and 'start anyway' overrides it", async () => {
		const t = setup();
		const issue = t.linear.add({ title: "Fix login bug", identifier: "ENG-70", description: "- [ ] login works" });
		const blocker = t.linear.add({ title: "Upgrade auth lib", identifier: "ENG-71" });
		t.linear.blocks.set(issue.id, [blocker.id]);

		await t.manager.handle({ kind: "created", sessionId: "b-3", issueId: issue.id });
		await t.manager.idle();
		expect(t.store.get("b-3")?.status).toBe("blocked");
		expect(t.runner.calls).toHaveLength(0);

		await t.manager.handle({ kind: "prompted", sessionId: "b-3", issueId: issue.id, body: "Start anyway, the upgrade isn't needed" });
		await t.manager.idle();
		expect(t.runner.calls).toHaveLength(1);
		expect(t.store.get("b-3")?.status).toBe("completed");
		expect(t.store.get("b-3")?.guidance).toEqual([]);
	});

	it("parks a directly delegated story on its unfinished sibling and wakes when the sibling is done", async () => {
		const t = setup();
		const { s1, s2 } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "b-4", issueId: s2.id });
		await t.manager.idle();
		expect(t.runner.calls).toHaveLength(0);
		expect(t.store.get("b-4")?.status).toBe("blocked");
		expect(t.store.get("b-4")?.waitingOn).toEqual([{ id: s1.id, identifier: "ENG-2" }]);

		t.linear.issues.get(s1.id)!.stateType = "completed";
		// Issue webhooks may omit the state; the manager looks it up.
		await t.manager.handle({ kind: "issue_state", issueId: s1.id, removed: false });
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-3"]);
		expect(t.store.get("b-4")?.status).toBe("completed");
	});

	it("skips a story labelled manual, parks on it, and resumes its dependents once a person completes it", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		// ENG-2 is a manual step (label matched case-insensitively); ENG-3 depends on it; ENG-4 is free.
		t.linear.issues.get(s1.id)!.labels = ["Manual"];

		await t.manager.handle({ kind: "created", sessionId: "man-1", issueId: epic.id });
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-4"]);
		expect(t.store.get("man-1")?.status).toBe("blocked");
		expect(t.store.get("man-1")?.waitingOn).toEqual([{ id: s1.id, identifier: "ENG-2" }]);
		expect(t.linear.bodies("elicitation").at(-1)).toContain("1/3 stories are done; the rest are waiting on **ENG-2**");
		expect(t.linear.bodies("thought").join("\n")).toContain("**ENG-2** is a manual step for a person");
		expect(t.runner.calls[0]?.prompt).toContain("ENG-2: Add priority field (manual step for a person, not for you)");
		expect(t.linear.plans.at(-1)?.[0]?.content).toBe("ENG-2: Add priority field (manual)");

		// The person finishes the manual step in Linear.
		t.linear.issues.get(s1.id)!.stateType = "completed";
		await t.manager.handle({ kind: "issue_state", issueId: s1.id, identifier: "ENG-2", stateType: "completed", removed: false });
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-4", "ENG-3"]);
		expect(t.store.get("man-1")?.status).toBe("completed");
	});

	it("uses the configured manual labels, and 'start anyway' runs dependents without doing the manual step", async () => {
		const t = setup({ manualLabels: ["needs-human"] });
		const { epic, s1, s3 } = ralphEpic(t.linear);
		t.linear.issues.get(s1.id)!.labels = ["needs-human"];
		t.linear.issues.get(s3.id)!.labels = ["manual"]; // not a manual label in this config

		await t.manager.handle({ kind: "created", sessionId: "man-2", issueId: epic.id });
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-4"]);
		expect(t.store.get("man-2")?.status).toBe("blocked");

		await t.manager.handle({ kind: "prompted", sessionId: "man-2", issueId: epic.id, body: "start anyway" });
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["ENG-4", "ENG-3"]);
		// The manual step itself is still left to a person.
		expect(t.store.get("man-2")?.waitingOn).toEqual([{ id: s1.id, identifier: "ENG-2" }]);
	});

	it("ignores a parent epic that lists its own child as a blocker", async () => {
		const t = setup();
		const { epic, s3 } = ralphEpic(t.linear);
		t.linear.blocks.set(epic.id, [s3.id]);
		await t.manager.handle({ kind: "created", sessionId: "b-5", issueId: epic.id });
		await t.manager.idle();
		expect(t.store.get("b-5")?.status).toBe("completed");
	});
});

const DELEGATION_BODY = "This thread is for an agent session with cyralph.";

describe("mentions, delegation and replies (Cyrus semantics)", () => {
	const isRequest = (c: RunRequest) => c.prompt.includes("## Request from your team");
	const storyIds = (t: ReturnType<typeof setup>) =>
		t.runner.calls.filter((c) => !isRequest(c)).map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);

	/** Request sessions answer with a fixed summary and report a Claude session id. */
	function answerRequests(t: ReturnType<typeof setup>, output = "Done as asked.") {
		const original = t.runner.run.bind(t.runner);
		let n = 0;
		t.runner.run = async (req) => {
			if (!isRequest(req)) return original(req);
			t.runner.calls.push(req);
			return { output, structured: { summary: output }, isError: false, aborted: false, sessionId: `claude-req-${++n}` };
		};
	}

	it("ignores Linear's delegation note: delegation works the epic with no request or guidance", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "m-1", issueId: epic.id, commentBody: DELEGATION_BODY });
		await t.manager.idle();
		expect(storyIds(t)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
		expect(t.runner.calls.some(isRequest)).toBe(false);
		expect(t.store.get("m-1")?.guidance).toEqual([]);
		expect(t.runner.calls[0]?.prompt).not.toContain("This thread is for an agent session");
	});

	it("a mention only does what it asks, even with stories left (no story loop, no Linear changes)", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		answerRequests(t, "The epic has 3 open stories; ENG-2 is next.");
		await t.manager.handle({ kind: "created", sessionId: "m-2", issueId: epic.id, commentBody: "@cyralph what's left on this epic?" });
		await t.manager.idle();
		expect(storyIds(t)).toEqual([]);
		expect(t.runner.calls.filter(isRequest)).toHaveLength(1);
		expect(t.runner.calls[0]?.prompt).toContain("> what's left on this epic?");
		expect(t.runner.calls[0]?.prompt).toContain("## Status: 0/3 stories complete");
		expect(t.linear.issues.get(epic.id)?.stateType).toBe("unstarted");
		expect(t.linear.issues.get(s1.id)?.stateType).toBe("unstarted");
		expect(t.store.get("m-2")?.mode).toBe("request");
		expect(t.git.prs).toEqual([]); // a question never opens a PR
		expect(t.linear.bodies("response").at(-1)).toBe("The epic has 3 open stories; ENG-2 is next.");
	});

	it("`/ralph` in a mention opts into the story loop, with the rest of the comment as guidance", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "m-3", issueId: epic.id, commentBody: "@cyralph /ralph use the existing Priority enum" });
		await t.manager.idle();
		expect(storyIds(t)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
		expect(t.runner.calls[0]?.prompt).toContain("- use the existing Priority enum");
		// The first story consumed it, so no extra request session runs.
		expect(t.runner.calls.some(isRequest)).toBe(false);
		expect(t.store.get("m-3")?.pendingRequests).toEqual([]);
	});

	it("push + PR on a finished epic whose remote was added later (the MOD-50 case)", async () => {
		const t = setup({}, { remote: false });
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "m-4", issueId: epic.id, commentBody: DELEGATION_BODY });
		await t.manager.idle();
		expect(t.linear.bodies("error")).toEqual([]);
		expect(t.git.prs).toEqual([]);

		sh(t.repo, "remote", "add", "origin", t.origin);
		answerRequests(t, "Pushed the branch and opened https://github.com/acme/app/pull/7.");
		t.git.externalPr = true; // the agent ran `gh pr create`
		await t.manager.handle({
			kind: "created",
			sessionId: "m-5",
			issueId: epic.id,
			commentBody: "@minecraftmodscyralph there is now a git remote, git@github.com:acme/app.git, can you push and create a PR?",
		});
		await t.manager.idle();
		const req = t.runner.calls.at(-1);
		expect(isRequest(req!)).toBe(true);
		expect(req?.systemAppend).toContain("You may use git");
		expect(req?.prompt).toContain("> there is now a git remote, git@github.com:acme/app.git, can you push and create a PR?");
		expect(req?.prompt).toContain(`Git remote \`origin\`: \`${t.origin}\``);
		expect(req?.prompt).toContain("## Status: 3/3 stories complete");
		expect(req?.prompt).toContain("gh pr create --base main --head eng-1-task-priority");
		expect(t.store.get("m-5")?.prUrl).toBe("https://github.com/acme/app/pull/7");
		expect(t.linear.bodies("response").at(-1)).toBe("Pushed the branch and opened https://github.com/acme/app/pull/7.");
	});

	it("re-delegating a finished epic pushes commits a later-added remote doesn't have", async () => {
		const t = setup({}, { remote: false });
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "m-6", issueId: epic.id, commentBody: DELEGATION_BODY });
		await t.manager.idle();
		sh(t.repo, "remote", "add", "origin", t.origin);
		await t.manager.handle({ kind: "created", sessionId: "m-7", issueId: epic.id, commentBody: DELEGATION_BODY });
		await t.manager.idle();
		const wt = t.store.get("m-7")?.worktreePath ?? "";
		expect(sh(t.origin, "rev-parse", "eng-1-task-priority").trim()).toBe(sh(wt, "rev-parse", "HEAD").trim());
		expect(t.store.get("m-7")?.prUrl).toBe("https://github.com/acme/app/pull/7");
	});

	it("follow-up replies to a mention resume the same Claude conversation", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		answerRequests(t);
		await t.manager.handle({ kind: "created", sessionId: "m-8", issueId: epic.id, commentBody: "@cyralph summarise the PRD" });
		await t.manager.idle();
		await t.manager.handle({ kind: "prompted", sessionId: "m-8", issueId: epic.id, body: "Shorter please" });
		await t.manager.idle();
		const reqs = t.runner.calls.filter(isRequest);
		expect(reqs.map((r) => r.resume)).toEqual([undefined, "claude-req-1"]);
		expect(reqs[1]?.prompt).toContain("> Shorter please");
		expect(reqs[1]?.prompt).not.toContain("> summarise the PRD");
		expect(storyIds(t)).toEqual([]);
	});

	it("a reply on a finished delegated session runs as a direct request", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "m-9", issueId: epic.id, commentBody: DELEGATION_BODY });
		await t.manager.idle();
		const before = t.runner.calls.length;
		await t.manager.handle({ kind: "prompted", sessionId: "m-9", issueId: epic.id, body: "Add a CHANGELOG entry for this epic" });
		await t.manager.idle();
		const after = t.runner.calls.slice(before);
		expect(after.map(isRequest)).toEqual([true]);
		expect(after[0]?.prompt).toContain("> Add a CHANGELOG entry for this epic");
	});

	it("a reply on a parked (blocked) epic runs as a request and the session stays parked", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		const blocker = t.linear.add({ title: "Design review", identifier: "ENG-99" });
		t.linear.blocks.set(epic.id, [blocker.id]);
		await t.manager.handle({ kind: "created", sessionId: "m-10", issueId: epic.id, commentBody: DELEGATION_BODY });
		await t.manager.idle();
		expect(t.store.get("m-10")?.status).toBe("blocked");
		await t.manager.handle({ kind: "prompted", sessionId: "m-10", issueId: epic.id, body: "summarise the plan in the PR description" });
		await t.manager.idle();
		expect(t.runner.calls.map(isRequest)).toEqual([true]);
		expect(t.store.get("m-10")?.status).toBe("blocked");
		expect(t.linear.bodies("elicitation").at(-1)).toContain("is still blocked on **ENG-99**");
	});

	it("mentions ignore blockers (they aren't story work)", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		const blocker = t.linear.add({ title: "Design review", identifier: "ENG-98" });
		t.linear.blocks.set(epic.id, [blocker.id]);
		answerRequests(t);
		await t.manager.handle({ kind: "created", sessionId: "m-11", issueId: epic.id, commentBody: "@cyralph what does ENG-3 need?" });
		await t.manager.idle();
		expect(t.runner.calls.map(isRequest)).toEqual([true]);
		expect(t.store.get("m-11")?.status).toBe("completed");
	});

	it("replies and mentions are delivered into a running story session", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		const injected: string[] = [];
		let release: () => void = () => {};
		const original = t.runner.run.bind(t.runner);
		t.runner.run = async (req) => {
			if (/## Your Task: ENG-2/.test(req.prompt) && injected.length === 0) {
				req.onInjector?.((text) => {
					injected.push(text);
					return true;
				});
				await new Promise<void>((r) => {
					release = r;
				});
				req.onInjector?.(undefined);
			}
			return original(req);
		};
		await t.manager.handle({ kind: "created", sessionId: "m-12", issueId: epic.id, commentBody: DELEGATION_BODY });
		await new Promise((r) => setTimeout(r, 300));
		await t.manager.handle({ kind: "prompted", sessionId: "m-12", issueId: epic.id, body: "Use a smallint column" });
		await t.manager.handle({ kind: "created", sessionId: "m-13", issueId: epic.id, commentBody: "@cyralph how is it going?" });
		expect(injected).toEqual(["Use a smallint column", "how is it going?"]);
		expect(t.linear.bodies("thought")).toContain("Passed this to the agent that's working right now.");
		expect(t.linear.activities.some((a) => a.sessionId === "m-13" && a.content.type === "response")).toBe(true);
		release();
		await t.manager.idle();
		// Delivered live, so it is not re-run as a request; later stories still see it as guidance.
		expect(t.runner.calls.some(isRequest)).toBe(false);
		expect(t.runner.calls.find((c) => /## Your Task: ENG-3/.test(c.prompt))?.prompt).toContain("- Use a smallint column");
	});

	it("keeps push/MR requests away from a running story agent and handles them directly", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		const injected: string[] = [];
		let release: () => void = () => {};
		const original = t.runner.run.bind(t.runner);
		t.runner.run = async (req) => {
			if (/## Your Task: ENG-2/.test(req.prompt) && !injected.includes("held")) {
				injected.push("held");
				req.onInjector?.((text) => {
					injected.push(text);
					return true;
				});
				await new Promise<void>((r) => {
					release = r;
				});
				req.onInjector?.(undefined);
			}
			return original(req);
		};
		await t.manager.handle({ kind: "created", sessionId: "m-15", issueId: epic.id, commentBody: DELEGATION_BODY });
		await new Promise((r) => setTimeout(r, 300));
		await t.manager.handle({ kind: "prompted", sessionId: "m-15", issueId: epic.id, body: "Please use glab to create an MR" });
		expect(injected).toEqual(["held"]);
		release();
		await t.manager.idle();
		// Not story guidance (story agents may not push), but a direct request once the stories are done.
		expect(t.runner.calls.find((c) => /## Your Task: ENG-3/.test(c.prompt))?.prompt).not.toContain("create an MR");
		expect(t.runner.calls.filter(isRequest).map((c) => c.prompt)).toEqual([expect.stringContaining("> Please use glab to create an MR")]);
		expect(t.store.get("m-15")?.pendingRequests).toEqual([]);
	});

	it("a bare mention with no instruction does nothing", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "m-14", issueId: epic.id, commentBody: "@cyralph" });
		await t.manager.idle();
		expect(t.runner.calls).toHaveLength(0);
		expect(t.linear.bodies("response").at(-1)).toContain("Nothing to do");
	});
});

describe("GitHub vs GitLab forges", () => {
	// Fetching from the fake GitLab host must fail fast rather than try the network.
	beforeEach(() => {
		process.env.GIT_SSH_COMMAND = "false";
	});
	afterEach(() => {
		delete process.env.GIT_SSH_COMMAND;
	});
	const isRequest = (c: RunRequest) => c.prompt.includes("## Request from your team");

	function gitlabSetup(remote = "git@git.example.com:acme/app.git") {
		const t = setup();
		t.config.gitlabHosts = ["git.example.com"];
		// The fetch URL (what forge detection reads) is the GitLab one; pushes go to the local bare repo.
		sh(t.repo, "remote", "set-url", "origin", remote);
		sh(t.repo, "remote", "set-url", "--push", "origin", t.origin);
		return t;
	}

	it("opens a merge request (not a PR) for a self-hosted GitLab remote", async () => {
		const t = gitlabSetup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "f-1", issueId: epic.id });
		await t.manager.idle();
		expect(t.store.get("f-1")?.prUrl).toBe("https://git.example.com/acme/app/-/merge_requests/7");
		expect(t.linear.urls).toEqual([{ label: "Merge request", url: "https://git.example.com/acme/app/-/merge_requests/7" }]);
		expect(t.linear.bodies("thought")).toContain("Opened a merge request: https://git.example.com/acme/app/-/merge_requests/7");
		expect(t.linear.bodies("response").at(-1)).toContain("Merge request: https://git.example.com/acme/app/-/merge_requests/7");
		expect(t.git.forgeOpts.at(-1)).toMatchObject({ gitlabHosts: ["git.example.com"] });
	});

	it("tells a GitLab request agent to use glab", async () => {
		const t = gitlabSetup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "f-2", issueId: epic.id, commentBody: "@cyralph open an MR" });
		await t.manager.idle();
		const req = t.runner.calls.find(isRequest);
		expect(req?.prompt).toContain("glab mr create --source-branch eng-1-task-priority --target-branch main");
		expect(req?.prompt).toContain("- Merge request: none opened yet");
		expect(req?.prompt).not.toContain("gh pr create");
	});

	it("stops to ask when the CLI isn't usable, then opens the MR when told to retry", async () => {
		const t = gitlabSetup();
		t.git.preflightProblem = "`glab` is not logged in (run `glab auth login --hostname git.example.com`).";
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "f-3", issueId: epic.id });
		await t.manager.idle();
		// Warned once up front, not after every story.
		const notes = t.linear.bodies("thought").filter((b) => b.includes("glab auth login"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("Heads up: I'll need `glab` to open the merge request");
		// The run ends on a question, not a success report.
		expect(t.store.get("f-3")?.prUrl).toBeUndefined();
		expect(t.store.get("f-3")?.status).toBe("awaiting_input");
		const ask = t.linear.bodies("elicitation").at(-1) ?? "";
		expect(ask).toContain("I can't open a merge request: `glab` is not logged in");
		expect(ask).toContain("reply here");
		expect(t.linear.bodies("response").some((b) => b.startsWith("Finished"))).toBe(false);

		// The user logs in and asks for the MR: the orchestrator retries, without re-running stories.
		t.git.preflightProblem = undefined;
		const before = t.runner.calls.filter((c) => !isRequest(c) && /## Your Task/.test(c.prompt)).length;
		await t.manager.handle({ kind: "prompted", sessionId: "f-3", issueId: epic.id, body: "Please use glab to create an MR" });
		await t.manager.idle();
		expect(t.runner.calls.filter((c) => !isRequest(c) && /## Your Task/.test(c.prompt))).toHaveLength(before);
		expect(t.store.get("f-3")?.prUrl).toBe("https://git.example.com/acme/app/-/merge_requests/7");
		expect(t.store.get("f-3")?.status).toBe("completed");
		expect(t.linear.bodies("response").at(-1)).toContain("Merge request: https://git.example.com/acme/app/-/merge_requests/7");
	});

	it("doesn't re-run a finished plain issue when the thread asks for the MR", async () => {
		const t = gitlabSetup();
		t.git.preflightProblem = "`glab` is not installed on the cyralph host.";
		const issue = t.linear.add({ title: "Fix the login bug", identifier: "ENG-80", branchName: "eng-80-login" });
		await t.manager.handle({ kind: "created", sessionId: "f-4", issueId: issue.id });
		await t.manager.idle();
		expect(t.store.get("f-4")?.status).toBe("awaiting_input");
		expect(t.linear.bodies("elicitation").at(-1)).toContain("`glab` is not installed");

		t.git.preflightProblem = undefined;
		await t.manager.handle({ kind: "prompted", sessionId: "f-4", issueId: issue.id, body: "Please use glab to create an MR" });
		await t.manager.idle();
		const stories = t.runner.calls.filter((c) => /## Your Task/.test(c.prompt));
		expect(stories).toHaveLength(1);
		const req = t.runner.calls.filter(isRequest);
		expect(req).toHaveLength(1);
		expect(req[0]?.prompt).toContain("> Please use glab to create an MR");
		expect(t.store.get("f-4")?.status).toBe("completed");
		expect(t.store.get("f-4")?.prUrl).toBe("https://git.example.com/acme/app/-/merge_requests/7");
	});

	it("passes per-repo forge overrides through", async () => {
		const t = setup();
		t.config.repositories[0]!.forge = "gitlab";
		t.config.repositories[0]!.gitlabHost = "https://git.internal:8443";
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "f-4", issueId: epic.id });
		await t.manager.idle();
		expect(t.git.forgeOpts.at(-1)).toMatchObject({ forge: "gitlab", gitlabHost: "https://git.internal:8443" });
		expect(t.store.get("f-4")?.prUrl).toContain("/-/merge_requests/");
	});
});

describe("repository routing in sessions", () => {
	function twoRepos() {
		const t = setup();
		const second = makeRepo();
		const base = t.config.repositories[0]!;
		t.config.repositories[0] = { ...base, id: "api", name: "platform/api", routingLabels: ["backend"] };
		t.config.repositories.push({ ...base, id: "web", name: "platform/web", repositoryPath: second.repo, routingLabels: ["frontend"], workspaceBaseDir: join(second.root, "wt") });
		return t;
	}

	it("routes by label and says so in the session", async () => {
		const t = twoRepos();
		const { epic } = ralphEpic(t.linear);
		t.linear.issues.get(epic.id)!.labels = ["frontend"];
		await t.manager.handle({ kind: "created", sessionId: "rt-1", issueId: epic.id });
		await t.manager.idle();
		expect(t.store.get("rt-1")?.repoId).toBe("web");
		expect(t.linear.bodies("thought").some((b) => b.includes("Working in `platform/web` (routed by label `frontend`)"))).toBe(true);
	});

	it("asks which repository when nothing matches, then continues with the reply", async () => {
		const t = twoRepos();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "rt-2", issueId: epic.id });
		await t.manager.idle();
		expect(t.runner.calls).toHaveLength(0);
		const ask = t.linear.activities.find((a) => a.signal === "select");
		expect(ask?.content).toMatchObject({ type: "elicitation" });
		expect(ask?.signalMetadata).toEqual({ options: [{ value: "platform/api" }, { value: "platform/web" }] });
		expect(t.store.get("rt-2")?.status).toBe("awaiting_input");

		// An unmatched reply re-asks; a matching one picks the repo and starts.
		await t.manager.handle({ kind: "prompted", sessionId: "rt-2", issueId: epic.id, body: "mobile" });
		expect(t.linear.activities.filter((a) => a.signal === "select")).toHaveLength(2);
		await t.manager.handle({ kind: "prompted", sessionId: "rt-2", issueId: epic.id, body: "platform/web" });
		await t.manager.idle();
		expect(t.store.get("rt-2")).toMatchObject({ repoId: "web", routedBy: "your selection", status: "completed" });
		expect(t.store.get("rt-2")?.guidance).toEqual([]); // the selection isn't story guidance
		expect(t.runner.calls).toHaveLength(3);

		// Re-delegating the same issue keeps the chosen repository without asking again.
		await t.manager.handle({ kind: "created", sessionId: "rt-3", issueId: epic.id });
		await t.manager.idle();
		expect(t.store.get("rt-3")?.repoId).toBe("web");
		expect(t.linear.activities.filter((a) => a.signal === "select")).toHaveLength(2);
	});

	it("routes a re-delegated epic again after the config changes, leaving the old repository's work alone", async () => {
		const t = twoRepos();
		const { epic } = ralphEpic(t.linear);
		t.linear.issues.get(epic.id)!.labels = ["frontend"];
		await t.manager.handle({ kind: "created", sessionId: "rt-5", issueId: epic.id });
		await t.manager.idle();
		const first = t.store.get("rt-5");
		expect(first).toMatchObject({ repoId: "web", status: "completed" });
		const oldBranch = first?.branch;
		expect(oldBranch).toBeTruthy();

		// `frontend` was the wrong label for web: the fixed config sends it to api.
		const [api, web] = t.config.repositories as [RepositoryConfig, RepositoryConfig];
		t.manager.setConfig({ ...t.config, repositories: [{ ...api, routingLabels: ["backend", "frontend"] }, { ...web, routingLabels: ["web"] }] });
		await t.manager.handle({ kind: "created", sessionId: "rt-6", issueId: epic.id });
		await t.manager.idle();
		const moved = t.store.get("rt-6");
		expect(moved).toMatchObject({ repoId: "api", routedBy: "label `frontend`" });
		expect(moved?.worktreePath).not.toBe(first?.worktreePath);
		expect(moved?.prUrl).not.toBe(first?.prUrl);
		expect(moved?.lanes).toBeUndefined();
		expect(t.linear.bodies("thought").some((b) => b.includes("Routing now sends this to `platform/api` instead of `platform/web`") && b.includes(`branch \`${oldBranch}\``))).toBe(true);
	});

	it("keeps a repository a human picked, and the current one when routing would have to ask", async () => {
		const t = twoRepos();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "rt-7", issueId: epic.id });
		await t.manager.idle();
		await t.manager.handle({ kind: "prompted", sessionId: "rt-7", issueId: epic.id, body: "platform/web" });
		await t.manager.idle();
		expect(t.store.get("rt-7")).toMatchObject({ repoId: "web", status: "completed" });

		// A label routing to api now matches, but the human's pick wins.
		t.linear.issues.get(epic.id)!.labels = ["backend"];
		await t.manager.handle({ kind: "created", sessionId: "rt-8", issueId: epic.id });
		await t.manager.idle();
		expect(t.store.get("rt-8")).toMatchObject({ repoId: "web", routedBy: "your selection" });

		// Routed by label to api; once the label is gone routing can't decide, so it stays in api.
		const other = t.linear.add({ title: "Other", identifier: "ENG-20", branchName: "eng-20-other", description: "do it", labels: ["backend"] });
		await t.manager.handle({ kind: "created", sessionId: "rt-9", issueId: other.id });
		await t.manager.idle();
		expect(t.store.get("rt-9")?.repoId).toBe("api");
		t.linear.issues.get(other.id)!.labels = [];
		await t.manager.handle({ kind: "created", sessionId: "rt-10", issueId: other.id });
		await t.manager.idle();
		expect(t.store.get("rt-10")?.repoId).toBe("api");
		expect(t.linear.activities.filter((a) => a.signal === "select")).toHaveLength(1);
	});

	it("applies a [repo=name#branch] base branch override to new epic branches", async () => {
		const t = twoRepos();
		const { epic } = ralphEpic(t.linear);
		const wsRepo = t.config.repositories[0]!.repositoryPath;
		sh(wsRepo, "checkout", "-q", "-b", "release-2");
		writeFileSync(join(wsRepo, "RELEASE"), "2\n");
		sh(wsRepo, "add", ".");
		sh(wsRepo, "commit", "-qm", "release branch");
		sh(wsRepo, "checkout", "-q", "main");
		t.linear.issues.get(epic.id)!.description = "PRD overview\n\n\\[repo=api#release-2\\]";
		await t.manager.handle({ kind: "created", sessionId: "rt-4", issueId: epic.id });
		await t.manager.idle();
		const rec = t.store.get("rt-4");
		expect(rec).toMatchObject({ repoId: "api", baseBranchOverride: "release-2" });
		expect(existsSync(join(rec?.worktreePath ?? "", "RELEASE"))).toBe(true);
		expect(t.linear.bodies("thought").some((b) => b.includes("based on `release-2`"))).toBe(true);
	});
});

describe("epics whose stories span repositories", () => {
	/** `api` (project API) is the epic's repository; `web` (project Web) is a second one with its own origin. */
	function crossRepo(extra: { ci?: CiClient; web?: boolean } = {}) {
		const t = setup({}, {}, { ci: extra.ci });
		const second = makeRepo();
		const base = t.config.repositories[0]!;
		t.config.repositories[0] = { ...base, id: "api", name: "platform/api", projectKeys: ["API"] };
		if (extra.web !== false) {
			t.config.repositories.push({ ...base, id: "web", name: "platform/web", repositoryPath: second.repo, projectKeys: ["Web"], workspaceBaseDir: join(second.root, "wt") });
		}
		const ids = ralphEpic(t.linear);
		for (const i of [ids.epic, ids.s1, ids.s2, ids.s3]) t.linear.issues.get(i.id)!.projectName = "API";
		t.linear.issues.get(ids.s2.id)!.projectName = "Web";
		return { ...t, ...ids, second };
	}
	const taskOf = (c: RunRequest) => /## Your Task: (\S+)/.exec(c.prompt)?.[1];

	it("works a story whose project routes to another repository there, on its own branch and PR", async () => {
		const t = crossRepo();
		await t.manager.handle({ kind: "created", sessionId: "x-1", issueId: t.epic.id });
		await t.manager.idle();

		const record = t.store.get("x-1");
		expect(record?.status).toBe("completed");
		const apiWt = record?.worktreePath ?? "";
		const webWt = record?.lanes?.web?.worktreePath ?? "";
		expect(webWt).toContain(join(t.second.root, "wt"));
		expect(t.runner.calls.map((c) => [taskOf(c), c.cwd])).toEqual([
			["ENG-2", apiWt],
			["ENG-3", webWt],
			["ENG-4", apiWt],
		]);
		const webPrompt = t.runner.calls[1]?.prompt ?? "";
		expect(webPrompt).toContain("Repository: `platform/web`");
		expect(t.runner.calls[0]?.prompt).not.toContain("Repository: `");
		expect(t.runner.calls[0]?.prompt).toContain("ENG-3: Show badge (in platform/web)");

		// Each repository's commits stay in its own branch and reach its own origin.
		expect(existsSync(join(webWt, "ENG-3.txt"))).toBe(true);
		expect(existsSync(join(apiWt, "ENG-3.txt"))).toBe(false);
		expect(sh(webWt, "log", "--format=%s", "main..HEAD").trim()).toBe("feat(ENG-3): Show badge");
		expect(sh(apiWt, "log", "--format=%s", "main..HEAD").trim().split("\n")).toEqual(["feat(ENG-4): Sort by priority", "feat(ENG-2): Add priority field"]);
		expect(sh(t.second.repo, "ls-remote", "origin")).toContain("refs/heads/eng-1-task-priority");

		expect(record?.prUrl).toBe("https://github.com/acme/app/pull/7");
		expect(record?.lanes?.web?.prUrl).toBe("https://github.com/acme/app/pull/8");
		expect(t.linear.urls.map((u) => u.url)).toEqual(["https://github.com/acme/app/pull/7", "https://github.com/acme/app/pull/8"]);
		expect(t.linear.bodies("thought").some((b) => b.includes("**ENG-3** belongs in `platform/web` (routed by project Web), so I'll work it there"))).toBe(true);
		expect(t.linear.comments.find((c) => c.issueId === t.s2.id)?.body).toContain("on `eng-1-task-priority` in `platform/web`");
		const response = t.linear.bodies("response").at(-1) ?? "";
		expect(response).toContain("Pull request (platform/api): https://github.com/acme/app/pull/7");
		expect(response).toContain("Pull request (platform/web): https://github.com/acme/app/pull/8");
		expect(t.linear.plans.at(-1)?.map((p) => p.content)).toContain("ENG-3: Show badge (in platform/web)");
	});

	it("opens no PR in the epic's repository when every story went to another one", async () => {
		const t = crossRepo();
		for (const s of [t.s1, t.s3]) t.linear.issues.get(s.id)!.stateType = "completed";
		await t.manager.handle({ kind: "created", sessionId: "x-2", issueId: t.epic.id });
		await t.manager.idle();
		const record = t.store.get("x-2");
		expect(record?.status).toBe("completed");
		expect(t.runner.calls.map(taskOf)).toEqual(["ENG-3"]);
		expect(record?.prUrl).toBeUndefined();
		expect(record?.lanes?.web?.prUrl).toBe("https://github.com/acme/app/pull/8");
		expect(t.git.prs).toEqual(["created"]);
	});

	it("treats a story whose project no repository here covers like a manual step", async () => {
		const t = crossRepo({ web: false });
		t.linear.blocks.set(t.s3.id, [t.s2.id]); // ENG-4 needs ENG-3
		await t.manager.handle({ kind: "created", sessionId: "x-3", issueId: t.epic.id });
		await t.manager.idle();

		expect(t.runner.calls.map(taskOf)).toEqual(["ENG-2"]);
		const record = t.store.get("x-3");
		expect(record?.status).toBe("blocked");
		expect(record?.waitingOn).toEqual([{ id: t.s2.id, identifier: "ENG-3" }]);
		expect(record?.lanes).toBeUndefined();
		expect(t.linear.issues.get(t.s2.id)?.stateType).toBe("unstarted");
		expect(
			t.linear
				.bodies("thought")
				.some((b) => b.includes("**ENG-3** isn't in a repository I have (it's in project Web, which no repository here is set up for), so I'll treat it like a manual step")),
		).toBe(true);
		expect(t.linear.plans.at(-1)?.map((p) => p.content)).toContain("ENG-3: Show badge (manual: no repository here)");
		expect(t.git.prs).toEqual([]);

		// Someone does ENG-3 elsewhere: its dependent runs and the epic finishes.
		t.linear.issues.get(t.s2.id)!.stateType = "completed";
		await t.manager.handle({ kind: "issue_state", issueId: t.s2.id, stateType: "completed", removed: false });
		await t.manager.idle();
		expect(t.runner.calls.map(taskOf)).toEqual(["ENG-2", "ENG-4"]);
		expect(t.store.get("x-3")?.status).toBe("completed");
		expect(t.git.prs).toEqual(["created"]);
	});

	it("hands each PR's failed CI to a request in that PR's own worktree", async () => {
		const ci = new FakeCi();
		const t = crossRepo({ ci });
		await t.manager.handle({ kind: "created", sessionId: "x-4", issueId: t.epic.id });
		await t.manager.idle();
		const record = t.store.get("x-4");
		const before = t.runner.calls.length;

		ci.result = failed("head1");
		ci.logs.set(1, "FAIL");
		await t.manager.pollCi();
		await t.manager.idle();
		const requests = t.runner.calls.slice(before);
		expect(requests.map((c) => c.cwd).sort()).toEqual([record?.worktreePath, record?.lanes?.web?.worktreePath].sort());
		const web = requests.find((c) => c.cwd === record?.lanes?.web?.worktreePath)?.prompt ?? "";
		expect(web).toContain("pull request #8 (https://github.com/acme/app/pull/8) failed on `head1`");
		const after = t.store.get("x-4");
		expect(after?.lanes?.web).toMatchObject({ ciFixRounds: 1, handledCiShas: ["head1"], pendingRequests: [] });
		expect(after).toMatchObject({ ciFixRounds: 1, handledCiShas: ["head1"], pendingRequests: [] });
		expect(t.linear.bodies("thought").some((b) => b.includes("Working on your request in `platform/web`."))).toBe(true);
	});
});

describe("history rewrites on request (rebase)", () => {
	const isRequest = (c: RunRequest) => c.prompt.includes("## Request from your team");

	it("lets an explicit rebase request rewrite the epic branch with --force-with-lease", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "h-1", issueId: epic.id, commentBody: "@cyralph please rebase this branch onto main" });
		await t.manager.idle();
		const req = t.runner.calls.find(isRequest);
		expect(req?.prompt).toContain("git rebase origin/main");
		expect(req?.prompt).toContain("git push --force-with-lease origin eng-1-task-priority");
		expect(req?.prompt).toContain("don't substitute a merge");
		expect(req?.systemAppend).toContain("That is allowed here.");
		expect(req?.systemAppend).not.toContain("Never rewrite published history");
	});

	it("can be disabled per repository, in which case the agent explains and offers a merge", async () => {
		const t = setup();
		t.config.repositories[0]!.historyRewrite = "never";
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "h-2", issueId: epic.id, commentBody: "@cyralph rebase onto main" });
		await t.manager.idle();
		const req = t.runner.calls.find(isRequest);
		expect(req?.prompt).toContain("History rewrites (rebase, squash, force-push) are disabled for this repository");
		expect(req?.prompt).not.toContain("--force-with-lease");
		expect(req?.systemAppend).toContain("Never rewrite published history");
	});

	it("story sessions still never touch git history or pushes", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "h-3", issueId: epic.id });
		await t.manager.idle();
		expect(t.runner.calls.every((c) => c.systemAppend === undefined)).toBe(true); // story runs use RALPH_SYSTEM_APPEND
		expect(t.runner.calls[0]?.prompt).toContain("Do NOT create git commits or push");
	});
});

describe("Linear attachments (images in issues)", () => {
	const UP = "https://uploads.linear.app/9aa27def/d172798b";
	/** SCHEM-32's description, as Linear returns it: an image-only body with a signed src. */
	const schem32 = `\n<linear-image>{"type":"image","attrs":{"src":"${UP}/365d683b?signature=eyJhbGciOi.abc.def","title":"pavilion_contact_sheet.png","width":1440,"height":1894}}</linear-image>`;

	it("downloads an image-only issue's upload (signature stripped) and points the agent at it", async () => {
		const t = setup();
		const issue = t.linear.add({ title: "Static renders from multiple angles", identifier: "SCHEM-32", description: schem32 });
		await t.manager.handle({ kind: "created", sessionId: "a-1", issueId: issue.id });
		await t.manager.idle();
		expect(t.fetcher.calls).toEqual([`${UP}/365d683b`]);
		const file = join(t.config.stateDir, "attachments", "SCHEM-32", "pavilion_contact_sheet.png");
		expect(readFileSync(file, "utf8")).toBe(`PNG:${UP}/365d683b`);
		const prompt = t.runner.calls[0]?.prompt ?? "";
		expect(prompt).toContain("### Attachments");
		expect(prompt).toContain(`- **pavilion_contact_sheet.png** (from SCHEM-32 description): \`${file}\``);
		expect(prompt).toContain("Open each one with the Read tool");
		expect(t.runner.calls[0]?.additionalDirectories).toContain(join(t.config.stateDir, "attachments", "SCHEM-32"));

		// A later run reuses the cached file instead of downloading again.
		await t.manager.handle({ kind: "created", sessionId: "a-2", issueId: issue.id });
		await t.manager.idle();
		expect(t.fetcher.calls).toHaveLength(1);
	});

	it("scopes story images to their story, shares epic/thread images, and reads comments", async () => {
		const t = setup();
		const { epic, s2 } = ralphEpic(t.linear);
		t.linear.issues.get(epic.id)!.description = `PRD overview\n\n![architecture.png](${UP}/arch)`;
		t.linear.issues.get(s2.id)!.description += `\n\n![badge mockup](${UP}/badge?signature=x)`;
		t.linear.commentsByIssue.set(epic.id, [{ body: `Colour reference: ${UP}/palette`, author: "Ana" }]);
		await t.manager.handle({ kind: "created", sessionId: "a-3", issueId: epic.id, commentBody: DELEGATION_BODY });
		await t.manager.idle();
		const byStory = (id: string) => t.runner.calls.find((c) => c.prompt.includes(`## Your Task: ${id}`))?.prompt ?? "";
		for (const id of ["ENG-2", "ENG-3", "ENG-4"]) {
			expect(byStory(id)).toContain("architecture.png");
			expect(byStory(id)).toContain("(from comment on ENG-1 by Ana)");
		}
		expect(byStory("ENG-3")).toContain("**badge mockup** (from ENG-3)");
		expect(byStory("ENG-3")).toContain("badge mockup.png");
		expect(byStory("ENG-2")).not.toContain("badge mockup");
		expect(byStory("ENG-4")).not.toContain("badge mockup");
	});

	it("includes images from an @mention and reports failed downloads instead of guessing", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		t.fetcher.fail.add(`${UP}/broken`);
		await t.manager.handle({
			kind: "created",
			sessionId: "a-4",
			issueId: epic.id,
			commentBody: `@cyralph does this screenshot match? ![screenshot.png](${UP}/shot) ![old.png](${UP}/broken)`,
		});
		await t.manager.idle();
		const req = t.runner.calls.find((c) => c.prompt.includes("## Request from your team"))?.prompt ?? "";
		expect(req).toContain("## Attachments");
		expect(req).toContain("**screenshot.png** (from Linear thread)");
		expect(req).toContain("**old.png** (from Linear thread): could not be downloaded (HTTP 401). Don't guess");
		expect(t.linear.bodies("thought").some((b) => b.includes("I couldn't download 1 of 2 attachment(s)") && b.includes("old.png"))).toBe(true);
	});
});


describe("restarts (self-update drain and resume)", () => {
	it("drains: finishes running work, keeps new work queued, and the next process resumes it", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		const other = t.linear.add({ title: "Fix the typo", identifier: "ENG-9", description: "typo in README" });
		await t.manager.handle({ kind: "created", sessionId: "d-1", issueId: epic.id });
		const drained = t.manager.drain();
		await t.manager.handle({ kind: "created", sessionId: "d-2", issueId: other.id });
		await drained;
		expect(t.store.get("d-1")?.status).toBe("completed");
		expect(t.store.get("d-2")?.status).toBe("queued");
		expect(t.runner.calls.some((c) => c.prompt.includes("Fix the typo"))).toBe(false);
		expect(t.linear.bodies("thought").some((b) => b.includes("restarting for an update"))).toBe(true);

		// The next process loads the same store and picks the queued session up.
		const store = new SessionStore(join(t.root, "sessions.json"));
		await store.load();
		const next = new SessionManager({ config: t.config, linear: t.linear, runner: t.runner, git: t.git, shell: runShell, log: silentLogger, attachments: t.fetcher }, store);
		await next.resumeInterrupted();
		await next.idle();
		expect(store.get("d-2")?.status).toBe("completed");
		expect(t.runner.calls.some((c) => c.prompt.includes("Fix the typo"))).toBe(true);
		expect(store.get("d-1")?.status).toBe("completed"); // finished work isn't re-run
	});

	it("resumes a session a crash left running, but not one that has been stale for days", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		const old = t.linear.add({ title: "Ancient", identifier: "ENG-8" });
		const fresh = newRecord("r-1", epic.id, "ENG-1");
		fresh.status = "running";
		await t.store.save(fresh);
		const stale = newRecord("r-2", old.id, "ENG-8");
		stale.status = "running";
		await t.store.save(stale);
		stale.updatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
		await t.manager.resumeInterrupted();
		await t.manager.idle();
		expect(t.store.get("r-1")?.status).toBe("completed");
		expect(t.store.get("r-2")?.status).toBe("running");
		expect(t.linear.activities.some((a) => a.sessionId === "r-1" && "body" in a.content && a.content.body.includes("cyralph restarted"))).toBe(true);
	});
});

class FakeReviews implements GitHubReviewClient {
	open = true;
	headSha = "head1";
	list: GitHubReview[] = [];
	comments = new Map<number, ReviewComment[]>();
	async pullRequest() {
		return { open: this.open, headRef: "eng-1-task-priority", headSha: this.headSha, url: PR_URL };
	}
	async reviews() {
		return this.list;
	}
	async reviewComments(_repo: string, _n: number, id: number) {
		return this.comments.get(id) ?? [];
	}
}

const PR_URL = "https://github.com/acme/app/pull/7";
const CUBIC = "cubic-dev-ai[bot]";

function cubicReview(id: number, opts: Partial<GitHubReview> = {}): GitHubReview {
	return { id, author: CUBIC, state: "commented", body: "cubic found 1 issue", commitId: "head1", submittedAt: `2026-10-03T10:00:0${id % 10}Z`, ...opts };
}

function reviewEvent(review: GitHubReview, opts: Partial<ReviewSubmitted> = {}): ReviewSubmitted {
	return { kind: "review_submitted", repo: "acme/app", prNumber: 7, prUrl: PR_URL, prOpen: true, headRef: "eng-1-task-priority", headSha: "head1", review, ...opts };
}

/** A finished epic with PR #7 open, ready to receive reviews. */
async function reviewedEpic(extra: { repo?: Record<string, unknown>; config?: Record<string, unknown> } = {}) {
	const github = new FakeReviews();
	const t = setup({}, {}, { repo: { githubUrl: "https://github.com/acme/app", ...extra.repo }, config: extra.config, github });
	const { epic } = ralphEpic(t.linear);
	await t.manager.handle({ kind: "created", sessionId: "rv-1", issueId: epic.id });
	await t.manager.idle();
	expect(t.store.get("rv-1")?.prUrl).toBe(PR_URL);
	const before = t.runner.calls.length;
	const requestPrompts = () => t.runner.calls.slice(before).map((c) => c.prompt);
	return { ...t, github, requestPrompts };
}

describe("automated PR reviews", () => {
	it("works through a bot review's inline comments on the epic branch", async () => {
		const t = await reviewedEpic();
		t.github.comments.set(11, [{ path: "src/a.ts", line: 3, body: "Possible null dereference" }]);
		await t.manager.handleReview(reviewEvent(cubicReview(11)));
		await t.manager.idle();
		const prompts = t.requestPrompts();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("cubic-dev-ai[bot] submitted an automated review of pull request #7");
		expect(prompts[0]).toContain("`src/a.ts:3`");
		expect(prompts[0]).toContain("Possible null dereference");
		expect(prompts[0]).toContain("push `eng-1-task-priority`");
		expect(t.linear.bodies("thought").some((b) => b.includes("reviewed the pull request with 1 comment. Working through it."))).toBe(true);
		expect(t.store.get("rv-1")?.reviewRounds).toBe(1);

		// The same review again (a redelivery, or the poller) is not acted on twice.
		await t.manager.handleReview(reviewEvent(cubicReview(11)));
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(1);
	});

	it("ignores other reviewers, other PRs, stale commits, and repositories that opted out", async () => {
		const t = await reviewedEpic();
		await t.manager.handleReview(reviewEvent(cubicReview(21, { author: "octocat" })));
		await t.manager.handleReview(reviewEvent(cubicReview(22), { prUrl: "https://github.com/acme/app/pull/99", prNumber: 99, headRef: "someone-else" }));
		await t.manager.handleReview(reviewEvent(cubicReview(23), { repo: "acme/other" }));
		await t.manager.handleReview(reviewEvent(cubicReview(24, { commitId: "old" })));
		await t.manager.handleReview(reviewEvent(cubicReview(25), { prOpen: false }));
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(0);
		expect(t.store.get("rv-1")?.prClosed).toBe(true);

		const off = await reviewedEpic({ repo: { respondToReviews: false } });
		await off.manager.handleReview(reviewEvent(cubicReview(26)));
		await off.manager.idle();
		expect(off.requestPrompts()).toHaveLength(0);
	});

	it("stops after maxReviewRounds and says so in the session", async () => {
		const t = await reviewedEpic({ config: { github: { maxReviewRounds: 1 } } });
		await t.manager.handleReview(reviewEvent(cubicReview(31)));
		await t.manager.idle();
		t.github.headSha = "head2";
		await t.manager.handleReview(reviewEvent(cubicReview(32, { commitId: "head2" }), { headSha: "head2" }));
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(1);
		expect(t.linear.bodies("response").some((b) => b.includes("leaving this one for a person"))).toBe(true);
	});

	it("polls open PRs for the newest bot review of the head commit when there is no webhook", async () => {
		const t = await reviewedEpic();
		t.github.list = [cubicReview(41, { author: "octocat" }), cubicReview(42, { commitId: "old" }), cubicReview(43), cubicReview(44)];
		await t.manager.pollReviews();
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(1);
		expect(t.store.get("rv-1")?.handledReviewIds).toEqual(expect.arrayContaining([43, 44]));
		await t.manager.pollReviews();
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(1);

		t.github.open = false;
		await t.manager.pollReviews();
		expect(t.store.get("rv-1")?.prClosed).toBe(true);
	});
});

class FakeCi implements CiClient {
	statusCalls: string[] = [];
	result: CiStatus = { open: true, headSha: "head1", state: "pending", failedJobs: [] };
	logs = new Map<number, string>();
	/** Set once the PR/MR is merged, at this head commit. */
	mergedAt: string | undefined;
	async status(ref: ChangeRequestRef) {
		this.statusCalls.push(ref.url);
		return { ...this.result };
	}
	async state() {
		return this.mergedAt ? { open: false, merged: true, headSha: this.mergedAt } : { open: this.result.open, merged: false, headSha: this.result.headSha };
	}
	async jobLog(_ref: ChangeRequestRef, job: CiFailedJob) {
		const log = this.logs.get(job.id);
		if (log === undefined) throw new Error("log expired");
		return log;
	}
}

function failed(headSha: string, jobs: CiFailedJob[] = [{ id: 1, name: "CI / test", url: "https://github.com/acme/app/actions/runs/5/job/1" }]): CiStatus {
	return { open: true, headSha, state: "failed", pipelineUrl: "https://github.com/acme/app/actions/runs/5", failedJobs: jobs };
}

/** A finished epic with PR #7 open, whose CI is polled. */
async function ciEpic(extra: { repo?: Record<string, unknown>; config?: Record<string, unknown> } = {}) {
	const ci = new FakeCi();
	const t = setup({}, {}, { repo: extra.repo, config: extra.config, ci });
	const { epic } = ralphEpic(t.linear);
	await t.manager.handle({ kind: "created", sessionId: "ci-1", issueId: epic.id });
	await t.manager.idle();
	expect(t.store.get("ci-1")?.prUrl).toBe(PR_URL);
	const before = t.runner.calls.length;
	const requestPrompts = () => t.runner.calls.slice(before).map((c) => c.prompt);
	return { ...t, ci, requestPrompts };
}

describe("CI failures", () => {
	it("hands a failed pipeline's jobs and logs to the epic's session, once per head commit", async () => {
		const t = await ciEpic();
		// Still running or green: nothing to do.
		await t.manager.pollCi();
		t.ci.result = { open: true, headSha: "head1", state: "success", failedJobs: [] };
		await t.manager.pollCi();
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(0);

		t.ci.result = failed("head1");
		t.ci.logs.set(1, "FAIL test/a.test.ts\nExpected 2, got 3");
		await t.manager.pollCi();
		await t.manager.idle();
		const prompts = t.requestPrompts();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("The GitHub Actions checks for pull request #7 (https://github.com/acme/app/pull/7) failed on `head1`");
		expect(prompts[0]).toContain("### CI / test");
		expect(prompts[0]).toContain("Expected 2, got 3");
		expect(prompts[0]).toContain("push `eng-1-task-priority`");
		expect(t.linear.bodies("thought").some((b) => b.includes("CI failed on the pull request (`head1`: `CI / test`). Working on a fix."))).toBe(true);
		const record = t.store.get("ci-1");
		expect(record?.ciFixRounds).toBe(1);
		expect(record?.handledCiShas).toEqual(["head1"]);
		expect(record?.pendingRequests).toEqual([]);

		// The same failed commit on the next poll is not acted on again.
		await t.manager.pollCi();
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(1);

		// A new push that fails again is; a job whose log can't be read is still reported.
		t.ci.result = failed("head2", [{ id: 2, name: "CI / build" }]);
		await t.manager.pollCi();
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(2);
		expect(t.requestPrompts()[1]).toContain("(no log available)");
	});

	it("stops after maxFixRounds and says so in the session", async () => {
		const t = await ciEpic({ config: { ci: { maxFixRounds: 1 } } });
		t.ci.result = failed("head1");
		await t.manager.pollCi();
		await t.manager.idle();
		t.ci.result = failed("head2");
		await t.manager.pollCi();
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(1);
		expect(t.linear.bodies("response").some((b) => b.includes("leaving this one for a person"))).toBe(true);
		// Said once, not on every poll.
		await t.manager.pollCi();
		expect(t.linear.bodies("response").filter((b) => b.includes("leaving this one for a person"))).toHaveLength(1);
	});

	it("skips repositories that opted out, stopped sessions, and closed PRs", async () => {
		const off = await ciEpic({ repo: { respondToCiFailures: false } });
		off.ci.result = failed("head1");
		await off.manager.pollCi();
		await off.manager.idle();
		expect(off.ci.statusCalls).toHaveLength(0);
		expect(off.requestPrompts()).toHaveLength(0);

		const t = await ciEpic();
		await t.manager.handle({ kind: "prompted", sessionId: "ci-1", body: "stop" });
		t.ci.result = failed("head1");
		await t.manager.pollCi();
		await t.manager.idle();
		expect(t.requestPrompts()).toHaveLength(0);

		const closed = await ciEpic();
		closed.ci.result = { ...failed("head1"), open: false };
		await closed.manager.pollCi();
		await closed.manager.idle();
		expect(closed.requestPrompts()).toHaveLength(0);
		expect(closed.store.get("ci-1")?.prClosed).toBe(true);
		await closed.manager.pollCi();
		expect(closed.ci.statusCalls).toHaveLength(1);
	});
});

describe("cleanup after a merge", () => {
	const branchExists = (repo: string, branch: string) => sh(repo, "branch", "--list", branch).trim() !== "";

	async function mergedEpic(extra: { repo?: Record<string, unknown> } = {}) {
		const t = await ciEpic(extra);
		const record = t.store.get("ci-1");
		const path = record?.worktreePath ?? "";
		expect(existsSync(path)).toBe(true);
		const head = sh(path, "rev-parse", "HEAD").trim();
		return { ...t, path, head, epicId: record?.issueId ?? "" };
	}

	it("removes the worktree and local branch once the issue is done after its PR merged", async () => {
		const t = await mergedEpic();
		// Done while the PR is still open (e.g. moved by hand): nothing is removed.
		await t.manager.handle({ kind: "issue_state", issueId: t.epicId, stateType: "completed", removed: false });
		expect(existsSync(t.path)).toBe(true);

		t.ci.mergedAt = t.head;
		await t.manager.handle({ kind: "issue_state", issueId: t.epicId, stateType: "completed", removed: false });
		expect(existsSync(t.path)).toBe(false);
		expect(branchExists(t.repo, "eng-1-task-priority")).toBe(false);
		expect(sh(t.repo, "worktree", "list")).not.toContain(t.path);
		const record = t.store.get("ci-1");
		expect(record?.worktreePath).toBeUndefined();
		expect(record?.prMerged).toBe(true);
		expect(t.linear.bodies("response").some((b) => b.includes("was merged, so I removed its worktree and the local branch `eng-1-task-priority`"))).toBe(true);
		// The note is the session's last activity and a response, so Linear sees the session complete
		// again instead of waiting on it until it calls it "Stopped responding".
		expect(t.linear.activities.at(-1)?.content.type).toBe("response");
	});

	it("cleans up when polling sees the PR merged, as a fallback for a missed webhook", async () => {
		const t = await mergedEpic();
		t.ci.mergedAt = t.head;
		t.ci.result = { ...t.ci.result, open: false };
		await t.manager.pollCi();
		expect(existsSync(t.path)).toBe(false);

		const later = await mergedEpic();
		later.ci.mergedAt = later.head;
		await later.manager.cleanupMerged();
		expect(existsSync(later.path)).toBe(false);
		expect(branchExists(later.repo, "eng-1-task-priority")).toBe(false);
	});

	it("keeps the worktree only when the PR was closed unmerged or the repository opted out", async () => {
		const closed = await mergedEpic();
		closed.ci.result = { ...closed.ci.result, open: false };
		await closed.manager.cleanupMerged();
		expect(existsSync(closed.path)).toBe(true);
		expect(closed.store.get("ci-1")?.prMerged).toBe(false);

		const off = await mergedEpic({ repo: { cleanupMergedWorktrees: false } });
		off.ci.mergedAt = off.head;
		await off.manager.cleanupMerged();
		expect(existsSync(off.path)).toBe(true);
	});

	const selects = (t: { linear: FakeLinear }) => t.linear.activities.filter((a) => a.signal === "select");
	const optionsOf = (a: ReturnType<typeof selects>[number] | undefined) => (a?.signalMetadata?.options as Array<{ value: string }> | undefined)?.map((o) => o.value);
	const bodyOf = (a: ReturnType<typeof selects>[number] | undefined) => (a && "body" in a.content ? a.content.body : "");

	it("stashes a dirty worktree, removes it, and asks about the stash: no answer keeps it, Push stores it on origin", async () => {
		const t = await mergedEpic();
		t.ci.mergedAt = t.head;
		writeFileSync(join(t.path, "notes.txt"), "wip\n");
		await t.manager.cleanupMerged(t.epicId);
		expect(existsSync(t.path)).toBe(false);
		expect(branchExists(t.repo, "eng-1-task-priority")).toBe(false);
		expect(sh(t.repo, "stash", "list")).toContain("cyralph: ENG-1 cleanup");
		expect(t.linear.bodies("response").some((b) => b.includes("removed its worktree and the local branch") && b.includes("uncommitted changes are stashed"))).toBe(true);

		const ask = selects(t).at(-1);
		expect(bodyOf(ask)).toContain("1 stashed change from ENG-1 was never applied");
		expect(optionsOf(ask)).toEqual(["Push to a branch on origin", "Drop"]);
		expect(t.store.get("ci-1")?.cleanupRequests).toMatchObject([{ kind: "stashes", repoId: "app" }]);

		// No answer: nothing happens, however long it takes.
		await t.manager.expireCleanupRequests(Date.now() + 365 * 24 * 60 * 60_000);
		expect(sh(t.repo, "stash", "list")).toContain("cyralph: ENG-1 cleanup");
		// A reply that isn't an answer is handled as usual and leaves the question open.
		await t.manager.handle({ kind: "prompted", sessionId: "ci-1", issueId: t.epicId, body: "Please push the stash to the branch and also update the docs" });
		await t.manager.idle();
		expect(t.store.get("ci-1")?.cleanupRequests).toHaveLength(1);

		await t.manager.handle({ kind: "prompted", sessionId: "ci-1", issueId: t.epicId, body: "Push to a branch on origin" });
		expect(sh(t.repo, "stash", "list")).not.toContain("cyralph: ENG-1 cleanup");
		expect(sh(t.origin, "log", "--format=%B", "cyralph/stash/eng-1")).toContain("cyralph: ENG-1 cleanup");
		expect(sh(t.origin, "show", "cyralph/stash/eng-1:notes.txt")).toBe("wip\n");
		expect(t.store.get("ci-1")?.cleanupRequests).toEqual([]);
		expect(t.store.get("ci-1")?.stashes?.some((e) => e.reason === "cleanup")).toBe(false);
		expect(t.linear.bodies("response").at(-1)).toContain("Pushed 1 stashed change to `cyralph/stash/eng-1` on origin");
	});

	it("drops leftover stashes of the epic when told to, and never touches other entries", async () => {
		const t = await mergedEpic();
		t.ci.mergedAt = t.head;
		writeFileSync(join(t.repo, "other.txt"), "someone else's\n");
		sh(t.repo, "stash", "push", "--include-untracked", "-m", "cyralph: ENG-9 ENG-10 blocked");
		writeFileSync(join(t.path, "notes.txt"), "wip\n");
		await t.manager.cleanupMerged(t.epicId);
		expect(bodyOf(selects(t).at(-1))).toContain("1 stashed change from ENG-1 was never applied");

		await t.manager.handle({ kind: "prompted", sessionId: "ci-1", issueId: t.epicId, body: "drop" });
		const left = sh(t.repo, "stash", "list");
		expect(left).not.toContain("cyralph: ENG-1 cleanup");
		expect(left).toContain("cyralph: ENG-9 ENG-10 blocked");
		expect(sh(t.origin, "branch", "--list", "cyralph/stash/*").trim()).toBe("");
		expect(t.linear.bodies("response").at(-1)).toContain("Dropped 1 stashed change from ENG-1.");
	});

	/** A merged epic whose branch got another commit after the merge. */
	async function aheadEpic(extra: { repo?: Record<string, unknown> } = {}) {
		const t = await mergedEpic(extra);
		t.ci.mergedAt = t.head;
		writeFileSync(join(t.path, "more.txt"), "more\n");
		sh(t.path, "add", ".");
		sh(t.path, "-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-m", "after merge");
		const tip = sh(t.path, "rev-parse", "HEAD").trim();
		await t.manager.cleanupMerged();
		expect(existsSync(t.path)).toBe(false);
		expect(branchExists(t.repo, "eng-1-task-priority")).toBe(true);
		expect(t.linear.bodies("response").some((b) => b.includes("removed its worktree, but kept the local branch `eng-1-task-priority`"))).toBe(true);
		return { ...t, tip };
	}

	it("removes the worktree of a branch with unmerged commits, keeps the branch, and pushes it when told to", async () => {
		const t = await aheadEpic();
		const ask = selects(t).at(-1);
		expect(bodyOf(ask)).toContain("`eng-1-task-priority` has 1 commit that wasn't merged");
		expect(optionsOf(ask)).toEqual(["Push to origin", "Delete"]);

		await t.manager.handle({ kind: "prompted", sessionId: "ci-1", issueId: t.epicId, body: "Push to origin" });
		expect(sh(t.origin, "rev-parse", "eng-1-task-priority").trim()).toBe(t.tip);
		expect(branchExists(t.repo, "eng-1-task-priority")).toBe(false);
		expect(t.linear.bodies("response").at(-1)).toContain("Pushed `eng-1-task-priority` to origin and deleted the local branch.");
	});

	it("deletes the kept branch when told to, or once nobody answers in time", async () => {
		const told = await aheadEpic();
		await told.manager.handle({ kind: "prompted", sessionId: "ci-1", issueId: told.epicId, body: "Delete" });
		expect(branchExists(told.repo, "eng-1-task-priority")).toBe(false);
		expect(sh(told.origin, "rev-parse", "eng-1-task-priority").trim()).not.toBe(told.tip);

		const quiet = await aheadEpic();
		await quiet.manager.expireCleanupRequests(Date.now() + 59 * 60_000);
		expect(branchExists(quiet.repo, "eng-1-task-priority")).toBe(true);
		await quiet.manager.expireCleanupRequests(Date.now() + 61 * 60_000);
		expect(branchExists(quiet.repo, "eng-1-task-priority")).toBe(false);
		expect(quiet.store.get("ci-1")?.cleanupRequests).toEqual([]);
		expect(quiet.linear.bodies("response").at(-1)).toContain("Nobody answered within 60 minutes, so I deleted the local branch `eng-1-task-priority`");

		const custom = await aheadEpic({ repo: { unmergedBranchTimeoutMinutes: 5 } });
		expect(bodyOf(selects(custom).at(-1))).toContain("within 5 minutes");
		await custom.manager.expireCleanupRequests(Date.now() + 4 * 60_000);
		expect(branchExists(custom.repo, "eng-1-task-priority")).toBe(true);
		await custom.manager.expireCleanupRequests(Date.now() + 6 * 60_000);
		expect(branchExists(custom.repo, "eng-1-task-priority")).toBe(false);
		expect(custom.linear.bodies("response").at(-1)).toContain("Nobody answered within 5 minutes");
	});

	it("keeps pending cleanup questions across a restart and still answers them", async () => {
		const t = await mergedEpic();
		t.ci.mergedAt = t.head;
		writeFileSync(join(t.path, "notes.txt"), "wip\n");
		writeFileSync(join(t.path, "more.txt"), "more\n");
		sh(t.path, "add", "more.txt");
		sh(t.path, "-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-m", "after merge");
		await t.manager.cleanupMerged();
		expect(t.store.get("ci-1")?.cleanupRequests?.map((r) => r.kind)).toEqual(["stashes", "branch"]);
		await t.store.flush();

		// A new process reads the questions back from disk.
		const store = new SessionStore(join(t.root, "sessions.json"));
		await store.load();
		const manager = new SessionManager({ config: t.config, linear: t.linear, runner: t.runner, git: t.git, shell: runShell, log: silentLogger, ci: t.ci }, store);
		// "Push" alone is ambiguous with both questions open; the option values aren't.
		await manager.handle({ kind: "prompted", sessionId: "ci-1", issueId: t.epicId, body: "Drop" });
		expect(sh(t.repo, "stash", "list")).not.toContain("cyralph: ENG-1 cleanup");
		expect(branchExists(t.repo, "eng-1-task-priority")).toBe(true);
		await manager.handle({ kind: "prompted", sessionId: "ci-1", issueId: t.epicId, body: "Push to origin" });
		expect(branchExists(t.repo, "eng-1-task-priority")).toBe(false);
		expect(sh(t.origin, "log", "--format=%s", "eng-1-task-priority")).toContain("after merge");
		expect(store.get("ci-1")?.cleanupRequests).toEqual([]);
		await manager.idle();
	});
});

describe("config reload", () => {
	it("keeps the running epic on the config it started with; new runs use the reloaded one", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		const run = t.runner.run.bind(t.runner);
		let reloaded = false;
		t.runner.run = async (req) => {
			if (!reloaded && !req.prompt.includes(PR_DESCRIPTION_HEADING)) {
				reloaded = true;
				t.manager.setConfig({ ...t.config, model: "reloaded-model" });
			}
			return run(req);
		};
		await t.manager.handle({ kind: "created", sessionId: "sess-1", issueId: epic.id });
		await t.manager.idle();
		expect(t.runner.calls.map((c) => c.model)).toEqual(["opus", "opus", "opus"]);

		const other = t.linear.add({ title: "Another task", identifier: "ENG-9", branchName: "eng-9-other", description: "do it" });
		await t.manager.handle({ kind: "created", sessionId: "sess-2", issueId: other.id });
		await t.manager.idle();
		expect(t.runner.calls.slice(3).map((c) => c.model)).toContain("reloaded-model");
		expect(t.runner.calls.slice(3).every((c) => c.model === "reloaded-model")).toBe(true);
	});
});

describe("issues filed during a run", () => {
	const order = (t: ReturnType<typeof setup>) => t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);
	const done = (summary: string, followUps: StoryOutcome["followUps"] = []): RunResult => outcome("complete", summary, { followUps });

	it("works sub-issues a validation story filed itself, then re-runs the validation story", async () => {
		const t = setup();
		const { epic, s3 } = ralphEpic(t.linear);
		t.runner.script.set("ENG-4", (_req, run) => {
			if (run > 1) return undefined;
			// The agent files the problems it found in Linear itself (e.g. with its own Linear tools).
			for (const id of ["UI-21", "UI-22"]) {
				const issue = t.linear.add({ title: `Fix ${id}`, identifier: id, parentId: epic.id, priority: 3 });
				t.linear.blocks.set(s3.id, [...(t.linear.blocks.get(s3.id) ?? []), issue.id]);
			}
			return outcome("incomplete", "Validation found two problems; filed UI-21 and UI-22.");
		});

		await t.manager.handle({ kind: "created", sessionId: "sess-f1", issueId: epic.id });
		await t.manager.idle();

		expect(order(t)).toEqual(["ENG-2", "ENG-3", "ENG-4", "UI-21", "UI-22", "ENG-4"]);
		const record = t.store.get("sess-f1");
		expect(record?.status).toBe("completed");
		// Waiting on its follow-ups didn't use up an attempt.
		expect(record?.attempts[s3.id]).toBe(1);
		expect(t.runner.calls.at(-1)?.prompt).toContain("this story waited for UI-21, UI-22");
		expect(t.linear.bodies("thought").join("\n")).toContain("**ENG-4** needs **UI-21**, **UI-22** done first");
		expect(t.linear.bodies("response").at(-1)).toContain("all 5 stories of **ENG-1**");
	});

	it("files the result's follow-ups as sub-issues that block the story, works them, and re-runs the story", async () => {
		const t = setup();
		const { epic, s3 } = ralphEpic(t.linear);
		t.runner.script.set("ENG-4", (req, run) => {
			if (run > 1) return undefined;
			expect(req.prompt).toContain("Add one entry per item to `followUps`");
			return {
				...outcome("incomplete", "Two things are broken.", {
					followUps: [
						{ title: "Fix the badge colour", description: "Wrong colour.\n- [ ] badge is red", manual: false },
						{ title: "Handle empty lists", description: "Crashes.", manual: false },
					],
				}),
				aborted: false,
			};
		});

		await t.manager.handle({ kind: "created", sessionId: "sess-f2", issueId: epic.id });
		await t.manager.idle();

		const children = await t.linear.getChildren(epic.id);
		const filed = children.filter((c) => c.title === "Fix the badge colour" || c.title === "Handle empty lists");
		expect(filed).toHaveLength(2);
		expect(filed[0]?.description).toContain("- [ ] badge is red");
		expect(filed[0]?.description).toContain("Filed by cyralph while working on ENG-4");
		expect(t.linear.blocks.get(s3.id)).toEqual(filed.map((f) => f.id));
		expect(order(t)).toEqual(["ENG-2", "ENG-3", "ENG-4", ...filed.map((f) => f.identifier), "ENG-4"]);
		expect(t.store.get("sess-f2")?.status).toBe("completed");
		for (const f of filed) expect(t.linear.issues.get(f.id)?.stateType).toBe("completed");
		const thoughts = t.linear.bodies("thought").join("\n");
		expect(thoughts).toContain(`Filed ${filed.map((f) => `**${f.identifier}**`).join(", ")} as new stories of **ENG-1**, blocking **ENG-4**`);
		expect(thoughts).not.toContain("joined **ENG-1**");
	});

	it("files a manual follow-up for a person: never runs it, and the story waits until it's done", async () => {
		const t = setup();
		const { epic, s3 } = ralphEpic(t.linear);
		t.runner.script.set("ENG-4", (req, run) => {
			if (run > 1) return undefined;
			expect(req.prompt).toContain("set `manual: true`");
			return {
				...outcome("blocked", "I need access.", {
					followUps: [{ title: "Grant the bot access to the registry", description: "Add cyralph to the registry.", manual: true }],
				}),
				aborted: false,
			};
		});

		await t.manager.handle({ kind: "created", sessionId: "sess-fm", issueId: epic.id });
		await t.manager.idle();

		const filed = (await t.linear.getChildren(epic.id)).find((c) => c.title === "Grant the bot access to the registry");
		expect(filed?.labels).toEqual(["manual"]);
		expect(t.linear.blocks.get(s3.id)).toEqual([filed?.id]);
		// No agent turn is spent on the manual step, and ENG-4 isn't re-run while it's open.
		expect(order(t)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
		expect(t.store.get("sess-fm")?.attempts[s3.id]).toBe(0);
		const thoughts = t.linear.bodies("thought").join("\n");
		expect(thoughts).toContain(`**${filed?.identifier}** is a manual step for a person (labelled \`manual\`)`);
		expect(thoughts).toContain(`**${filed?.identifier}** is a manual step for a person, so ENG-4 runs again once it's done.`);
		expect(thoughts).not.toContain("I'll work it next");
		expect(t.store.get("sess-fm")?.status).toBe("blocked");
		expect(t.store.get("sess-fm")?.waitingOn).toEqual([{ id: filed?.id, identifier: filed?.identifier }]);

		// The person does the manual step in Linear; ENG-4 runs again.
		t.linear.issues.get(filed!.id)!.stateType = "completed";
		await t.manager.handle({ kind: "issue_state", issueId: filed!.id, identifier: filed!.identifier, stateType: "completed", removed: false });
		await t.manager.idle();
		expect(order(t)).toEqual(["ENG-2", "ENG-3", "ENG-4", "ENG-4"]);
		expect(t.store.get("sess-fm")?.status).toBe("completed");
	});

	it("adds follow-ups from a completed story as new stories without blocking it", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		t.runner.script.set("ENG-2", (req, run) => {
			if (run > 1) return undefined;
			writeFileSync(join(req.cwd, "ENG-2.txt"), "x\n");
			return done("Done.", [{ title: "Add an index on priority", description: "Slow queries.", manual: false }]);
		});

		await t.manager.handle({ kind: "created", sessionId: "sess-f3", issueId: epic.id });
		await t.manager.idle();

		const filed = (await t.linear.getChildren(epic.id)).find((c) => c.title === "Add an index on priority");
		expect(filed).toBeDefined();
		expect(t.linear.blocks.get(s1.id)).toBeUndefined();
		expect(order(t)).toContain(filed?.identifier);
		expect(t.store.get("sess-f3")?.status).toBe("completed");
		expect(t.linear.bodies("response").at(-1)).toContain("all 4 stories of **ENG-1**");
	});

	it("picks up a sub-issue a person adds to the epic while the run is going", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		t.runner.script.set("ENG-2", (req) => {
			t.linear.add({ title: "Also export priorities", identifier: "ENG-90", parentId: epic.id, priority: 4 });
			writeFileSync(join(req.cwd, "ENG-2.txt"), "x\n");
			return done("Done.");
		});

		await t.manager.handle({ kind: "created", sessionId: "sess-f4", issueId: epic.id });
		await t.manager.idle();

		expect(order(t)).toEqual(["ENG-2", "ENG-3", "ENG-4", "ENG-90"]);
		expect(t.linear.bodies("thought").join("\n")).toContain("A new story joined **ENG-1**: **ENG-90** Also export priorities");
		expect(t.linear.plans.at(-1)?.map((p) => p.content)).toContain("ENG-90: Also export priorities");
	});

	it("a directly delegated story works the follow-ups it files, but not other siblings", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		t.runner.script.set("ENG-2", (_req, run) =>
			run === 1 ? outcome("incomplete", "Blocked by the migration tool.", { followUps: [{ title: "Fix the migration tool", description: "It drops columns.", manual: false }] }) : undefined,
		);

		await t.manager.handle({ kind: "created", sessionId: "sess-f5", issueId: s1.id });
		await t.manager.idle();

		const filed = (await t.linear.getChildren(epic.id)).find((c) => c.title === "Fix the migration tool");
		expect(order(t)).toEqual(["ENG-2", filed?.identifier, "ENG-2"]);
		expect(t.store.get("sess-f5")?.status).toBe("completed");
	});

	it("stops pausing a story that keeps turning up more work and counts its attempts", async () => {
		const t = setup({ maxAttemptsPerStory: 1 });
		const { epic } = ralphEpic(t.linear);
		t.runner.script.set("ENG-4", (_req, run) => outcome("incomplete", "More work.", { followUps: [{ title: `Problem ${run}`, description: "More.", manual: false }] }));

		await t.manager.handle({ kind: "created", sessionId: "sess-f6", issueId: epic.id });
		await t.manager.idle();

		// Three rounds of follow-ups, then the fourth counts as its one attempt and it's set aside.
		expect(order(t).filter((id) => id === "ENG-4")).toHaveLength(4);
		expect(t.store.get("sess-f6")?.status).toBe("awaiting_input");
		expect(t.linear.bodies("elicitation").at(-1)).toContain("ENG-4: Sort by priority** failed 1 attempts");
		expect((await t.linear.getChildren(epic.id)).filter((c) => c.title.startsWith("Problem "))).toHaveLength(4);
	});
});

describe("never losing blocked work", () => {
	const ids = (t: ReturnType<typeof setup>) => t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);
	const wtOf = (t: ReturnType<typeof setup>, sessionId: string) => t.store.get(sessionId)?.worktreePath ?? "";
	const filesOf = (wt: string, ref: string) => sh(wt, "show", "--name-only", "--format=", ref).trim().split("\n");
	const shaFor = (prompt: string, label: string) => new RegExp(`\`([0-9a-f]{40})\` ${label}`).exec(prompt)?.[1];

	it("stashes a story's work when it ends blocked after filing a follow-up (the TOOL-31 case), and offers it back", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		t.runner.script.set("ENG-4", (req, run) => {
			if (run > 1) return undefined;
			writeFileSync(join(req.cwd, "ENG-4.fix"), "half a fix\n");
			return outcome("blocked", "Needs the migration tool fixed first.", {
				followUps: [{ title: "Fix the migration tool", description: "It drops columns.", manual: false }],
			});
		});

		await t.manager.handle({ kind: "created", sessionId: "tool-31", issueId: epic.id });
		await t.manager.idle();

		const followUp = (await t.linear.getChildren(epic.id)).find((c) => c.title === "Fix the migration tool");
		expect(ids(t)).toEqual(["ENG-2", "ENG-3", "ENG-4", followUp?.identifier, "ENG-4"]);
		const wt = wtOf(t, "tool-31");
		// The follow-up's commit holds only its own work, not ENG-4's leftovers.
		const log = sh(wt, "log", "--format=%H %s", "main..HEAD").trim().split("\n");
		const followUpCommit = log.find((l) => l.includes(followUp?.identifier ?? "?"))?.split(" ")[0] ?? "";
		expect(filesOf(wt, followUpCommit)).toEqual([`${followUp?.identifier}.txt`]);
		// ENG-4's second run was offered the stash; once ENG-4 committed, the entry was dropped.
		const second = t.runner.calls.at(-1)?.prompt ?? "";
		expect(shaFor(second, "cyralph: ENG-1 ENG-4 follow-up")).toBeDefined();
		expect(sh(wt, "stash", "list")).toBe("");
		expect(sh(wt, "status", "--porcelain")).toBe("");
		expect(t.store.get("tool-31")?.status).toBe("completed");
	});

	it("commits a blocked story's work as wip when it asks to and the checks pass, pushes it, and keeps the story blocked", async () => {
		const t = setup({}, {}, { repo: { verifyCommands: ["test -f ENG-2.partial"] } });
		const { epic, s1 } = ralphEpic(t.linear);
		t.runner.script.set("ENG-2", (req) => {
			writeFileSync(join(req.cwd, "ENG-2.partial"), "wip\n");
			return outcome("blocked", "The database credentials are missing.", { commit: { summary: "Add the priority column migration" } });
		});

		await t.manager.handle({ kind: "created", sessionId: "wip-1", issueId: epic.id });
		await t.manager.idle();

		const wt = wtOf(t, "wip-1");
		const commits = sh(wt, "log", "--format=%s%n%b---", "main..HEAD");
		expect(commits.match(/^wip\(/gm)).toHaveLength(1);
		expect(commits).toContain("wip(ENG-2): Add the priority column migration\nEpic: ENG-1 Task Priority System\n");
		expect(filesOf(wt, sh(wt, "log", "--format=%H", "--grep=^wip(ENG-2)", "main..HEAD").trim())).toEqual(["ENG-2.partial"]);
		// Pushed like a completed story, and the story is still blocked.
		expect(sh(t.origin, "rev-parse", "eng-1-task-priority").trim()).toBe(sh(wt, "rev-parse", "HEAD").trim());
		expect(t.linear.issues.get(s1.id)?.stateType).not.toBe("completed");
		expect(t.store.get("wip-1")?.blockedKeys).toEqual([s1.id]);
		expect(t.linear.bodies("thought").join("\n")).toContain("ENG-2 is blocked; setting it aside without retrying (work so far committed as");
		expect(sh(wt, "stash", "list")).toBe("");
		expect(sh(wt, "status", "--porcelain")).toBe("");
	});

	it("stashes a blocked story's work instead when a check fails, and says which one", async () => {
		const t = setup({}, {}, { repo: { verifyCommands: ["test ! -f ENG-2.partial"] } });
		const { epic } = ralphEpic(t.linear);
		t.runner.script.set("ENG-2", (req) => {
			writeFileSync(join(req.cwd, "ENG-2.partial"), "wip\n");
			return outcome("blocked", "The database credentials are missing.", { commit: { summary: "Add the priority column migration" } });
		});

		await t.manager.handle({ kind: "created", sessionId: "wip-2", issueId: epic.id });
		await t.manager.idle();

		const wt = wtOf(t, "wip-2");
		expect(sh(wt, "log", "--format=%s", "main..HEAD")).not.toContain("wip(");
		expect(sh(wt, "stash", "list")).toContain("cyralph: ENG-1 ENG-2 blocked");
		expect(t.linear.bodies("thought").join("\n")).toContain("ENG-2's work so far didn't pass `test ! -f ENG-2.partial` (exit 1), so I stashed it");
		expect(sh(wt, "status", "--porcelain")).toBe("");
	});

	it("uses up an attempt when a session ends without a valid structured result, and says why", async () => {
		const t = setup({ maxAttemptsPerStory: 3 });
		const { epic, s1 } = ralphEpic(t.linear);
		t.runner.script.set("ENG-2", (req, run) => {
			if (run === 1) return { output: "Done.\n<promise>COMPLETE</promise>", isError: false, aborted: false };
			if (run === 2) return { output: "", isError: true, aborted: false, errorMessage: "error_max_structured_output_retries" };
			if (run === 3) expect(req.prompt).toContain("never produced a structured result matching the JSON schema (error_max_structured_output_retries)");
			return undefined;
		});

		await t.manager.handle({ kind: "created", sessionId: "so-1", issueId: epic.id });
		await t.manager.idle();

		expect(ids(t).slice(0, 3)).toEqual(["ENG-2", "ENG-2", "ENG-2"]);
		expect(t.runner.calls[1]?.prompt).toContain("ended without a valid structured result (no structured result)");
		expect(t.store.get("so-1")?.attempts[s1.id]).toBe(3);
		expect(t.linear.issues.get(s1.id)?.stateType).toBe("completed");
	});

	it("stashes a dirty worktree before any session with a pre-run label, so the next commit holds only its story", async () => {
		const t = setup({ maxIterationsPerRun: 1 });
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "pre-1", issueId: epic.id });
		await t.manager.idle();
		const wt = wtOf(t, "pre-1");
		writeFileSync(join(wt, "stray.txt"), "left behind\n");

		await t.manager.handle({ kind: "prompted", sessionId: "pre-1", issueId: epic.id, body: "keep going" });
		await t.manager.idle();
		expect(ids(t)).toEqual(["ENG-2", "ENG-3"]);
		expect(sh(wt, "stash", "list")).toContain("cyralph: ENG-1 ENG-3 pre-run");
		expect(filesOf(wt, "HEAD")).toEqual(["ENG-3.txt"]);
		// Not the story's own work, so it isn't offered to it (or dropped with it).
		expect(t.runner.calls[1]?.prompt).not.toContain("## Stashed Work");
		expect(t.store.get("pre-1")?.stashes).toMatchObject([{ label: "cyralph: ENG-1 ENG-3 pre-run", reason: "pre-run" }]);
		expect(t.store.get("pre-1")?.stashes?.[0]).not.toHaveProperty("storyKey");

	});

	it("stashes a dirty worktree before a request session too", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "pre-2", issueId: epic.id });
		await t.manager.idle();
		const wt = wtOf(t, "pre-2");
		writeFileSync(join(wt, "stray.txt"), "left behind\n");

		await t.manager.handle({ kind: "created", sessionId: "pre-3", issueId: epic.id, commentBody: "@cyralph rename the badge component" });
		await t.manager.idle();
		const request = t.runner.calls.find((c) => c.prompt.includes("## Request from your team"));
		expect(request?.outputSchema).toBeDefined();
		const stashes = sh(wt, "stash", "list");
		expect(stashes).toContain("cyralph: ENG-1 request pre-run");
		// What the request session itself left uncommitted is stashed afterwards.
		expect(stashes).toContain("cyralph: ENG-1 request unfinished");
		expect(sh(wt, "status", "--porcelain")).toBe("");
	});

	it("offers a story only its own stash entries, and drops only those once it commits", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		// Another epic's entry in the stash list every worktree of the repository shares.
		writeFileSync(join(t.repo, "other.txt"), "another epic\n");
		sh(t.repo, "stash", "push", "--include-untracked", "-m", "cyralph: ENG-9 ENG-10 blocked");
		t.runner.neverComplete.add("ENG-2");
		t.runner.failFirst.add("ENG-4");
		t.runner.script.set("ENG-4", (req, run) => {
			if (run === 1) return undefined;
			const sha = shaFor(req.prompt, "cyralph: ENG-1 ENG-4 incomplete") ?? "";
			execFileSync("git", ["stash", "apply", sha], { cwd: req.cwd, stdio: "ignore" });
			writeFileSync(join(req.cwd, "ENG-4.txt"), "ENG-4\n");
			return outcome("complete", "Implemented ENG-4 on top of the stash.", { appliedStashes: [sha.slice(0, 12)] });
		});

		await t.manager.handle({ kind: "created", sessionId: "offer-1", issueId: epic.id });
		await t.manager.idle();

		expect(ids(t)).toEqual(["ENG-2", "ENG-2", "ENG-4", "ENG-4"]);
		const eng2 = t.runner.calls[1]?.prompt ?? "";
		const eng4 = t.runner.calls[3]?.prompt ?? "";
		expect(eng2).toContain("cyralph: ENG-1 ENG-2 incomplete");
		expect(eng2).not.toContain("ENG-9");
		expect(eng4).toContain("cyralph: ENG-1 ENG-4 incomplete");
		expect(eng4).not.toContain("cyralph: ENG-1 ENG-2");
		expect(eng4).not.toContain("ENG-9");

		const wt = wtOf(t, "offer-1");
		expect(filesOf(wt, "HEAD").sort()).toEqual(["ENG-4.partial", "ENG-4.txt"]);
		const left = sh(wt, "stash", "list");
		expect(left).not.toContain("ENG-4");
		expect(left).toContain("cyralph: ENG-1 ENG-2 incomplete");
		expect(left).toContain("cyralph: ENG-1 ENG-2 exhausted");
		expect(left).toContain("cyralph: ENG-9 ENG-10 blocked");
		expect(t.store.get("offer-1")?.stashes?.map((e) => e.reason)).toEqual(["incomplete", "exhausted"]);
	});
});

describe("preparation of manual stories", () => {
	const PREP = "echo prepared > prepared.txt\ngit push --force origin HEAD:staging";
	const COMMANDS = ["echo prepared > prepared.txt", "git push --force origin HEAD:staging"];
	const withPrep = (text = PREP) => `Do the smoke test.\n\n\`\`\`cyralph-prepare\n${text}\n\`\`\`\n`;
	const selects = (t: ReturnType<typeof setup>) => t.linear.activities.filter((a) => a.signal === "select");
	const optionsOf = (a: ReturnType<typeof selects>[number] | undefined) =>
		(a?.signalMetadata?.options as Array<{ value: string }> | undefined)?.map((o) => o.value);
	const bodyOf = (a: ReturnType<typeof selects>[number] | undefined) => (a && "body" in a.content ? a.content.body : "");
	const ids = (t: ReturnType<typeof setup>) => t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);

	it("asks before parking on an unblocked manual story with preparation, pushes first, and survives a restart", async () => {
		// Without per-story pushes, origin only gets the branch from the push before asking.
		const t = setup({ pushPerStory: false });
		const { epic, s1 } = ralphEpic(t.linear);
		Object.assign(t.linear.issues.get(s1.id)!, { labels: ["Manual"], description: withPrep() });

		await t.manager.handle({ kind: "created", sessionId: "prep-1", issueId: epic.id });
		await t.manager.idle();

		expect(ids(t)).toEqual(["ENG-4"]);
		const record = t.store.get("prep-1");
		expect(record?.status).toBe("awaiting_input");
		// Still waiting on the manual step: a person marking it done wakes the session as before.
		expect(record?.waitingOn).toEqual([{ id: s1.id, identifier: "ENG-2" }]);
		const wt = record?.worktreePath ?? "";
		const head = sh(wt, "rev-parse", "HEAD").trim();
		expect(record?.preparationRequest).toMatchObject({
			storyKey: s1.id,
			storyId: "ENG-2",
			repoId: "app",
			branch: "eng-1-task-priority",
			headSha: head,
			commandsHash: preparationHash(COMMANDS),
		});
		expect(sh(t.origin, "rev-parse", "refs/heads/eng-1-task-priority").trim()).toBe(head);

		const asks = selects(t);
		expect(asks).toHaveLength(1);
		expect(optionsOf(asks[0])).toEqual(["Run it", "I'll do it myself", "Not yet"]);
		const body = bodyOf(asks[0]);
		expect(body).toContain("1/3 stories are done; the rest are waiting on **ENG-2**.");
		expect(body).toContain("**ENG-2: Add priority field**");
		expect(body).toContain(`\`eng-1-task-priority\` at \`${head.slice(0, 7)}\``);
		expect(body).toContain(`\`\`\`sh\n${COMMANDS.join("\n")}\n\`\`\``);
		// Nothing ran, and there's no plain park message besides the question.
		expect(existsSync(join(wt, "prepared.txt"))).toBe(false);
		expect(t.linear.bodies("elicitation").filter((b) => b.includes("I'll start automatically"))).toEqual([]);

		await t.store.flush();
		const reloaded = new SessionStore(join(t.root, "sessions.json"));
		await reloaded.load();
		expect(reloaded.get("prep-1")?.status).toBe("awaiting_input");
		expect(reloaded.get("prep-1")?.preparationRequest).toEqual(record?.preparationRequest);

		// The person does the step without answering: the question is dropped and the epic finishes.
		t.linear.issues.get(s1.id)!.stateType = "completed";
		await t.manager.handle({ kind: "issue_state", issueId: s1.id, identifier: "ENG-2", stateType: "completed", removed: false });
		await t.manager.idle();
		expect(ids(t)).toEqual(["ENG-4", "ENG-3"]);
		expect(t.store.get("prep-1")?.status).toBe("completed");
		expect(t.store.get("prep-1")?.preparationRequest).toBeUndefined();
		expect(selects(t)).toHaveLength(1);
	});

	it("asks instead of finishing when the run's stories are done and a manual story is unblocked", async () => {
		const t = setup();
		const { epic, s3 } = ralphEpic(t.linear);
		const manual = t.linear.add({ title: "Smoke test on staging", identifier: "ENG-5", parentId: epic.id, subIssueSortOrder: 3, labels: ["Manual"], description: withPrep() });
		t.linear.blocks.set(manual.id, [s3.id]);

		// Delegating ENG-4 works only ENG-4; that unblocks the manual ENG-5.
		await t.manager.handle({ kind: "created", sessionId: "prep-2", issueId: s3.id });
		await t.manager.idle();

		expect(ids(t)).toEqual(["ENG-4"]);
		const record = t.store.get("prep-2");
		expect(record?.status).toBe("awaiting_input");
		expect(record?.preparationRequest?.storyKey).toBe(manual.id);
		expect(t.linear.bodies("thought").some((b) => b.startsWith("Finished **ENG-4**"))).toBe(true);
		expect(t.linear.bodies("response")).toEqual([]);
		const asks = selects(t);
		expect(asks).toHaveLength(1);
		expect(bodyOf(asks[0])).toContain("**ENG-5: Smoke test on staging**");
		expect(bodyOf(asks[0])).toContain(`at \`${record?.preparationRequest?.headSha.slice(0, 7)}\``);
		expect(existsSync(join(record?.worktreePath ?? "", "prepared.txt"))).toBe(false);
	});

	it("mentions rerun preparation in the finished message while a manual story with preparation is open", async () => {
		const t = setup();
		const { epic, s3 } = ralphEpic(t.linear);
		const manual = t.linear.add({ title: "Smoke test on staging", identifier: "ENG-5", parentId: epic.id, subIssueSortOrder: 3, labels: ["Manual"], description: withPrep() });
		t.linear.blocks.set(manual.id, [s3.id]);
		await t.manager.handle({ kind: "created", sessionId: "prep-6", issueId: s3.id });
		await t.manager.idle();
		expect(selects(t)).toHaveLength(1);

		await t.manager.handle({ kind: "prompted", sessionId: "prep-6", issueId: s3.id, body: "I'll do it myself" });
		await t.manager.idle();

		expect(t.store.get("prep-6")?.status).toBe("completed");
		const finished = t.linear.bodies("response").filter((b) => b.startsWith("Finished **ENG-4**"));
		expect(finished).toHaveLength(1);
		expect(finished[0]).toMatch(/\n\nReply `rerun preparation` to be asked again about running the preparation commands of \*\*ENG-5\*\*\.$/);
	});

	it("doesn't mention rerun preparation in the finished message without a manual story with preparation", async () => {
		const t = setup();
		const { s3 } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "prep-7", issueId: s3.id });
		await t.manager.idle();

		const finished = t.linear.bodies("response").filter((b) => b.startsWith("Finished **ENG-4**"));
		expect(finished).toHaveLength(1);
		expect(finished[0]).not.toContain("rerun preparation");
	});

	it("asks about one manual story at a time, in story order", async () => {
		const t = setup();
		const { epic, s2, s3 } = ralphEpic(t.linear);
		// ENG-3 and ENG-4 are manual with preparation; ENG-3 comes first. ENG-2 runs.
		t.linear.blocks.delete(s2.id);
		Object.assign(t.linear.issues.get(s3.id)!, { labels: ["Manual"], description: withPrep("echo four") });
		Object.assign(t.linear.issues.get(s2.id)!, { labels: ["Manual"], description: withPrep("echo three") });

		await t.manager.handle({ kind: "created", sessionId: "prep-3", issueId: epic.id });
		await t.manager.idle();
		expect(ids(t)).toEqual(["ENG-2"]);
		expect(t.store.get("prep-3")?.preparationRequest?.storyKey).toBe(s2.id);
		expect(selects(t)).toHaveLength(1);
		expect(bodyOf(selects(t)[0])).toContain("echo three");
		expect(bodyOf(selects(t)[0])).not.toContain("echo four");

		// A reply that isn't an answer asks about the same story again.
		await t.manager.handle({ kind: "prompted", sessionId: "prep-3", issueId: epic.id, body: "what's this?" });
		await t.manager.idle();
		expect(t.store.get("prep-3")?.preparationRequest?.storyKey).toBe(s2.id);
		expect(bodyOf(selects(t)[1])).toContain("**ENG-3: Show badge**");

		// Once ENG-3's preparation is answered, ENG-4 is next.
		const record = t.store.get("prep-3");
		if (record) record.preparationHandled = [s2.id];
		await t.manager.handle({ kind: "prompted", sessionId: "prep-3", issueId: epic.id, body: "continue" });
		await t.manager.idle();
		expect(t.store.get("prep-3")?.preparationRequest?.storyKey).toBe(s3.id);
		expect(bodyOf(selects(t)[2])).toContain("**ENG-4: Sort by priority**");
		expect(bodyOf(selects(t)[2])).toContain("echo four");
	});

	it.each([
		["globally", { allowPreparation: false }, {}],
		["for the repository", {}, { allowPreparation: false }],
	])("doesn't ask when preparation is disabled %s, and leaves the step to a person", async (_how, ralph, repo) => {
		const t = setup(ralph, {}, { repo });
		const { epic, s1 } = ralphEpic(t.linear);
		Object.assign(t.linear.issues.get(s1.id)!, { labels: ["Manual"], description: withPrep() });

		await t.manager.handle({ kind: "created", sessionId: "prep-4", issueId: epic.id });
		await t.manager.idle();

		expect(selects(t)).toEqual([]);
		const record = t.store.get("prep-4");
		expect(record?.status).toBe("blocked");
		expect(record?.preparationRequest).toBeUndefined();
		expect(record?.preparationHandled).toEqual([s1.id]);
		expect(t.linear.bodies("thought")).toContain(
			"Preparation is disabled (`allowPreparation: false`), so I won't offer to run the preparation commands of **ENG-2**: they're yours to do, with the rest of the step.",
		);
		expect(t.linear.bodies("elicitation").at(-1)).toContain("1/3 stories are done; the rest are waiting on **ENG-2**");
		expect(t.linear.bodies("elicitation").at(-1)).not.toContain("rerun preparation");
		expect(existsSync(join(record?.worktreePath ?? "", "prepared.txt"))).toBe(false);
	});

	it("doesn't ask about a manual story without a cyralph-prepare block, or one still blocked", async () => {
		const t = setup();
		const { epic, s1, s2 } = ralphEpic(t.linear);
		t.linear.issues.get(s1.id)!.labels = ["Manual"];
		// ENG-3 has preparation but waits on the manual ENG-2.
		Object.assign(t.linear.issues.get(s2.id)!, { labels: ["Manual"], description: withPrep() });

		await t.manager.handle({ kind: "created", sessionId: "prep-5", issueId: epic.id });
		await t.manager.idle();

		expect(selects(t)).toEqual([]);
		expect(t.store.get("prep-5")?.status).toBe("blocked");
		expect(t.store.get("prep-5")?.preparationRequest).toBeUndefined();
	});

	describe("answers", () => {
		/** ENG-2 is manual with preparation; the epic asks about it and parks on it. */
		async function asked(prep = PREP, sessionId = "ans") {
			const t = setup();
			const { epic, s1 } = ralphEpic(t.linear);
			Object.assign(t.linear.issues.get(s1.id)!, { labels: ["Manual"], description: withPrep(prep) });
			await t.manager.handle({ kind: "created", sessionId, issueId: epic.id });
			await t.manager.idle();
			expect(selects(t)).toHaveLength(1);
			const wt = t.store.get(sessionId)?.worktreePath ?? "";
			const reply = async (body: string) => {
				await t.manager.handle({ kind: "prompted", sessionId, issueId: epic.id, body });
				await t.manager.idle();
				return t.store.get(sessionId);
			};
			return { t, epic, s1, wt, reply };
		}
		const preparedThoughts = (t: ReturnType<typeof setup>) => t.linear.bodies("thought").filter((b) => b.startsWith("Ran the preparation of"));

		it("Run it: runs the commands in order in the epic worktree, posts their output, records the SHA and parks as before", async () => {
			const { t, s1, wt, reply } = await asked();
			const head = sh(wt, "rev-parse", "HEAD").trim();
			const record = await reply("Run it");

			expect(readFileSync(join(wt, "prepared.txt"), "utf8")).toBe("prepared\n");
			expect(sh(t.origin, "rev-parse", "refs/heads/staging").trim()).toBe(head);
			const thoughts = t.linear.bodies("thought");
			expect(thoughts).toContain("`echo prepared > prepared.txt` (exit 0)");
			expect(thoughts.some((b) => b.startsWith("`git push --force origin HEAD:staging` (exit 0)\n\n```\n") && b.includes("staging"))).toBe(true);
			expect(preparedThoughts(t)).toEqual([
				`Ran the preparation of **ENG-2** at \`${head.slice(0, 7)}\`. The rest of ENG-2 is up to a person, who marks it done.`,
			]);
			expect(record?.preparedShas).toEqual({ [s1.id]: head });
			expect(record?.preparationHandled).toEqual([s1.id]);
			expect(record?.preparationRequest).toBeUndefined();
			// Parked on the manual step as today, not asked again; the step's Linear state is the person's.
			expect(record?.status).toBe("blocked");
			expect(record?.waitingOn).toEqual([{ id: s1.id, identifier: "ENG-2" }]);
			expect(t.linear.bodies("elicitation").at(-1)).toContain("1/3 stories are done; the rest are waiting on **ENG-2**. I'll start automatically");
			expect(t.linear.bodies("elicitation").at(-1)).toMatch(/Reply `start anyway`.*\n\nReply `rerun preparation` to be asked again about running the preparation commands of \*\*ENG-2\*\*\.$/s);
			expect(selects(t)).toHaveLength(1);
			expect(t.linear.issues.get(s1.id)?.stateType).toBe("unstarted");
		});

		it("Run it after HEAD moved: runs nothing and asks again with the new SHA", async () => {
			const { t, wt, reply } = await asked();
			sh(wt, "commit", "--allow-empty", "-m", "moved");
			const moved = sh(wt, "rev-parse", "HEAD").trim();
			const record = await reply("Run it");

			expect(existsSync(join(wt, "prepared.txt"))).toBe(false);
			expect(preparedThoughts(t)).toEqual([]);
			expect(record?.preparationRequest).toMatchObject({ headSha: moved, commandsHash: preparationHash(COMMANDS) });
			expect(record?.preparationRequest?.approvedAt).toBeUndefined();
			const again = selects(t);
			expect(again).toHaveLength(2);
			expect(optionsOf(again[1])).toEqual(["Run it", "I'll do it myself", "Not yet"]);
			expect(bodyOf(again[1])).toContain(`\`eng-1-task-priority\` (now at \`${moved.slice(0, 7)}\`) changed since I asked about the preparation of **ENG-2**, so I ran nothing.`);
			expect(bodyOf(again[1])).toContain(`at \`${moved.slice(0, 7)}\``);
			// The branch was pushed again before asking.
			expect(sh(t.origin, "rev-parse", "refs/heads/eng-1-task-priority").trim()).toBe(moved);

			// Approving what is shown now runs it.
			await reply("Run it");
			expect(existsSync(join(wt, "prepared.txt"))).toBe(true);
			expect(preparedThoughts(t)).toHaveLength(1);
		});

		it("Run it after the commands were edited: runs nothing and asks again with the new commands", async () => {
			const { t, s1, wt, reply } = await asked();
			t.linear.issues.get(s1.id)!.description = withPrep("echo edited > edited.txt");
			const record = await reply("Run it");

			expect(existsSync(join(wt, "prepared.txt"))).toBe(false);
			expect(existsSync(join(wt, "edited.txt"))).toBe(false);
			expect(record?.preparationRequest?.commandsHash).toBe(preparationHash(["echo edited > edited.txt"]));
			const again = selects(t);
			expect(again).toHaveLength(2);
			expect(bodyOf(again[1])).toContain("its commands changed since I asked about the preparation of **ENG-2**, so I ran nothing.");
			expect(bodyOf(again[1])).toContain("```sh\necho edited > edited.txt\n```");
		});

		it("stops at the first failing command, posts it, and asks again without retrying", async () => {
			// one.txt sits next to the worktree: a reply's direct request stashes untracked files in it.
			const { t, s1, wt, reply } = await asked("echo one >> ../one.txt\nsh -c 'echo boom >&2; exit 3'\necho never > never.txt");
			const one = join(wt, "..", "one.txt");
			const record = await reply("Run it");

			expect(readFileSync(one, "utf8")).toBe("one\n");
			expect(existsSync(join(wt, "never.txt"))).toBe(false);
			expect(t.linear.bodies("thought")).toContain("Preparation of **ENG-2** failed at `sh -c 'echo boom >&2; exit 3'` (exit 3).\n\n```\nboom\n```");
			const again = selects(t);
			expect(again).toHaveLength(2);
			expect(optionsOf(again[1])).toEqual(["Run it", "I'll do it myself", "Not yet"]);
			expect(bodyOf(again[1])).toContain(
				"`sh -c 'echo boom >&2; exit 3'` failed with exit 3, so I stopped there and didn't run the 1 command after it. Nothing is retried on its own.",
			);
			expect(record?.preparationRequest?.storyKey).toBe(s1.id);
			expect(record?.preparationRequest?.approvedAt).toBeUndefined();
			expect(record?.preparationHandled ?? []).toEqual([]);
			expect(record?.preparedShas).toBeUndefined();
			expect(record?.status).toBe("awaiting_input");

			// Waking up again (another reply) doesn't run anything by itself.
			await reply("thanks");
			expect(readFileSync(one, "utf8")).toBe("one\n");
			// Answering "Run it" again does.
			await reply("Run it");
			expect(readFileSync(one, "utf8")).toBe("one\none\n");
		});

		it("I'll do it myself: records the decline, runs nothing, never asks again and parks as before", async () => {
			const { t, s1, wt, reply } = await asked();
			// Typed with a curly apostrophe.
			const record = await reply("I’ll do it myself");

			expect(existsSync(join(wt, "prepared.txt"))).toBe(false);
			expect(record?.preparationHandled).toEqual([s1.id]);
			expect(record?.preparationRequest).toBeUndefined();
			expect(record?.preparedShas).toBeUndefined();
			expect(record?.status).toBe("blocked");
			expect(t.linear.bodies("elicitation").at(-1)).toContain("the rest are waiting on **ENG-2**. I'll start automatically");
			await reply("any news?");
			expect(selects(t)).toHaveLength(1);
			expect(t.linear.issues.get(s1.id)?.stateType).toBe("unstarted");
		});

		it("Not yet: runs nothing and leaves the question open", async () => {
			const { t, wt, reply } = await asked();
			const before = t.store.get("ans");
			const pending = structuredClone(before?.preparationRequest);
			const calls = t.runner.calls.length;
			const record = await reply("Not yet");

			expect(existsSync(join(wt, "prepared.txt"))).toBe(false);
			expect(record?.preparationRequest).toEqual(pending);
			expect(record?.status).toBe("awaiting_input");
			expect(t.runner.calls).toHaveLength(calls);
			expect(selects(t)).toHaveLength(1);
			expect(t.linear.bodies("response").at(-1)).toBe("OK, I won't run anything for **ENG-2** yet. The question stays open: answer it whenever you're ready.");

			// It can still be answered later.
			await reply("Run it");
			expect(existsSync(join(wt, "prepared.txt"))).toBe(true);
		});

		it("rerun preparation: asks again about a story whose preparation already ran or was declined", async () => {
			const { t, s1, wt, reply } = await asked("echo again >> again.txt");
			await reply("Run it");
			expect(readFileSync(join(wt, "again.txt"), "utf8")).toBe("again\n");
			expect(selects(t)).toHaveLength(1);

			let record = await reply("rerun preparation");
			expect(selects(t)).toHaveLength(2);
			expect(bodyOf(selects(t)[1])).toContain("**ENG-2: Add priority field**");
			expect(record?.preparationRequest?.storyKey).toBe(s1.id);
			expect(record?.preparationHandled).toEqual([]);
			expect(record?.guidance).toEqual([]);
			await reply("Run it");
			expect(readFileSync(join(wt, "again.txt"), "utf8")).toBe("again\nagain\n");

			await reply("rerun preparation");
			record = await reply("I'll do it myself");
			expect(record?.preparationHandled).toEqual([s1.id]);
			await reply("Rerun preparation.");
			expect(selects(t)).toHaveLength(4);
			expect(readFileSync(join(wt, "again.txt"), "utf8")).toBe("again\nagain\n");
		});

		it("handles any other reply as today and keeps the question pending", async () => {
			const { t, s1, wt, reply } = await asked();
			const record = await reply("please use the staging config");

			expect(existsSync(join(wt, "prepared.txt"))).toBe(false);
			expect(record?.guidance).toEqual(["please use the staging config"]);
			expect(t.linear.bodies("thought")).toContain("On it.");
			expect(record?.preparationRequest?.storyKey).toBe(s1.id);
			expect(record?.preparationRequest?.approvedAt).toBeUndefined();
			expect(selects(t)).toHaveLength(2);
			expect(bodyOf(selects(t)[1])).toContain("**ENG-2: Add priority field**");
			expect(record?.status).toBe("awaiting_input");
		});
	});
});
