import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunner, RunRequest, RunResult } from "../src/agent/runner.js";
import { parseConfig } from "../src/config.js";
import { SessionManager } from "../src/engine/session-manager.js";
import { SessionStore } from "../src/engine/store.js";
import { CliGitWorkspace, type Forge, runShell } from "../src/git/workspace.js";
import { buildStoryIssueBody } from "../src/ralph/story-body.js";
import { silentLogger } from "../src/logger.js";
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
	/** Simulates a PR opened outside the orchestrator (e.g. by the agent via `gh`). */
	externalPr = false;
	/** Simulates the forge CLI being unusable (e.g. `glab` not logged in). */
	preflightProblem: string | undefined;
	forgeOpts: Array<Record<string, unknown> | undefined> = [];
	override async forge(cwd: string, opts?: Parameters<CliGitWorkspace["forge"]>[1]): Promise<Forge | undefined> {
		this.forgeOpts.push(opts);
		const real = await super.forge(cwd, opts);
		if (!real) return undefined;
		const url = real.kind === "gitlab" ? "https://git.example.com/acme/app/-/merge_requests/7" : "https://github.com/acme/app/pull/7";
		const found = () => (this.prs.length || this.externalPr ? { url, number: 7 } : undefined);
		return {
			kind: real.kind,
			cli: real.cli,
			term: real.term,
			agentInstructions: (o) => real.agentInstructions(o),
			preflight: async () => this.preflightProblem,
			find: async () => found(),
			ensure: async () => {
				this.prs.push("created");
				return { url, number: 7 };
			},
			update: async () => {},
		};
	}
}

/** Implements a story by writing `<storyId>.txt`; can be told to fail specific attempts. */
class ScriptedRunner implements AgentRunner {
	calls: RunRequest[] = [];
	failFirst = new Set<string>();
	neverComplete = new Set<string>();
	async run(req: RunRequest): Promise<RunResult> {
		this.calls.push(req);
		const id = /## Your Task: (\S+)/.exec(req.prompt)?.[1] ?? "unknown";
		req.onEvent?.({ type: "tool", name: "Write", input: { file_path: `${id}.txt` } });
		if (this.neverComplete.has(id) || this.failFirst.delete(id)) {
			writeFileSync(join(req.cwd, `${id}.partial`), "wip\n");
			return { output: "I got stuck on the migration.", isError: false, aborted: false, costUsd: 0.1 };
		}
		writeFileSync(join(req.cwd, `${id}.txt`), `${id}\n`);
		// Git config for commits made by the engine inside the worktree.
		return { output: `Implemented ${id}.\n<promise>COMPLETE</promise>`, isError: false, aborted: false, costUsd: 0.25 };
	}
}

function setup(overrides: Record<string, unknown> = {}, repoOpts: { remote?: boolean } = {}) {
	const { root, repo, origin } = makeRepo(repoOpts);
	const config = parseConfig(
		{
			repositories: [{ id: "app", name: "app", repositoryPath: repo, baseBranch: "main" }],
			ralph: { maxAttemptsPerStory: 2, ...overrides },
		},
		join(root, "config.json"),
	);
	const linear = new FakeLinear();
	const runner = new ScriptedRunner();
	const git = new TestGit();
	const store = new SessionStore(join(root, "sessions.json"));
	const manager = new SessionManager({ config, linear, runner, git, shell: runShell, log: silentLogger }, store);
	return { root, repo, origin, config, linear, runner, git, store, manager };
}

function ralphEpic(linear: FakeLinear) {
	const epic = linear.add({ title: "Task Priority System", identifier: "ENG-1", branchName: "eng-1-task-priority", description: "PRD overview" });
	const s1 = linear.add({
		title: "US-001: Add priority field",
		identifier: "ENG-2",
		parentId: epic.id,
		description: buildStoryIssueBody({ storyId: "US-001", ralphPriority: 1, description: "store priority", acceptanceCriteria: ["column exists"] }),
	});
	const s2 = linear.add({
		title: "US-002: Show badge",
		identifier: "ENG-3",
		parentId: epic.id,
		description: buildStoryIssueBody({ storyId: "US-002", ralphPriority: 1, description: "badge", acceptanceCriteria: ["badge"] }),
	});
	const s3 = linear.add({
		title: "US-003: Sort by priority",
		identifier: "ENG-4",
		parentId: epic.id,
		description: buildStoryIssueBody({ storyId: "US-003", ralphPriority: 3, description: "sort", acceptanceCriteria: ["sorted"] }),
	});
	// US-002 depends on US-001, so despite equal priority order is 001, 002, then 003.
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
		expect(order).toEqual(["US-001", "US-002", "US-003"]);
		for (const s of [s1, s2, s3]) expect(t.linear.issues.get(s.id)?.stateType).toBe("completed");
		expect(t.linear.issues.get(epic.id)?.stateType).toBe("started");

		const record = t.store.get("sess-1");
		expect(record?.status).toBe("completed");
		expect(record?.prUrl).toBe("https://github.com/acme/app/pull/7");
		expect(t.linear.urls).toEqual([{ label: "Pull request", url: "https://github.com/acme/app/pull/7" }]);

		const wt = record?.worktreePath ?? "";
		const log = sh(wt, "log", "--format=%s", "main..HEAD").trim().split("\n");
		expect(log).toEqual(["feat(US-003): Sort by priority [ENG-4]", "feat(US-002): Show badge [ENG-3]", "feat(US-001): Add priority field [ENG-2]"]);
		// Pushed to origin.
		expect(sh(t.origin, "rev-parse", "eng-1-task-priority").trim()).toBe(sh(wt, "rev-parse", "HEAD").trim());

		// Prompts carry PRD context and progress file.
		expect(t.runner.calls[1]?.prompt).toContain("- [x] US-001: Add priority field");
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
		t.runner.failFirst.add("US-003");
		t.runner.neverComplete.add("US-001");

		await t.manager.handle({ kind: "created", sessionId: "sess-2", issueId: epic.id });
		await t.manager.idle();

		const ids = t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1]);
		// US-001 twice (exhausted), US-002 blocked by it, US-003 fails once then succeeds.
		expect(ids).toEqual(["US-001", "US-001", "US-003", "US-003"]);
		expect(t.runner.calls[1]?.prompt).toContain("I got stuck on the migration.");
		expect(t.store.get("sess-2")?.status).toBe("awaiting_input");
		const ask = t.linear.bodies("elicitation").at(-1) ?? "";
		expect(ask).toContain("US-001: Add priority field** failed 2 attempts");
		expect(ask).toContain("**US-002** is blocked by US-001");
		// Partial work of the exhausted story was stashed, so it doesn't leak into US-003's commit
		// (US-003's own partial work from its failed first attempt is kept for the retry).
		const wt = t.store.get("sess-2")?.worktreePath ?? "";
		expect(sh(wt, "show", "--stat", "--format=", "HEAD")).not.toContain("US-001");
		expect(sh(wt, "stash", "list")).toContain("cyralph: incomplete US-001 (ENG-1)");

		// Human replies with guidance; the loop resumes with a fresh attempt budget.
		t.runner.neverComplete.clear();
		await t.manager.handle({ kind: "prompted", sessionId: "sess-2", issueId: epic.id, body: "The column should be nullable." });
		await t.manager.idle();
		expect(t.store.get("sess-2")?.status).toBe("completed");
		const resumed = t.runner.calls.slice(4);
		expect(resumed.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1])).toEqual(["US-001", "US-002"]);
		expect(resumed[0]?.prompt).toContain("- The column should be nullable.");
		expect(t.linear.issues.get(s2.id)?.stateType).toBe("completed");
	});

	it("materializes a PRD in the description into ralph-format child issues", async () => {
		const t = setup();
		const epic = t.linear.add({
			title: "Dark mode",
			identifier: "ENG-50",
			description: `# PRD: Dark Mode\n\n## Quality Gates\n- \`true\` - always passes\n\n## User Stories\n\n### US-001: Theme tokens\n**Description:** tokens\n\n**Acceptance Criteria:**\n- [ ] tokens exist\n\n### US-002: Toggle\n**Depends on:** US-001\n\n**Acceptance Criteria:**\n- [ ] toggle works\n`,
		});
		await t.manager.handle({ kind: "created", sessionId: "sess-3", issueId: epic.id });
		await t.manager.idle();
		const children = await t.linear.getChildren(epic.id);
		expect(children.map((c) => c.title)).toEqual(["US-001: Theme tokens", "US-002: Toggle"]);
		expect(children[0]?.description).toContain("## Ralph Metadata");
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

	it("focuses on one story when a story issue is delegated directly", async () => {
		const t = setup();
		const { s3 } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "sess-5", issueId: s3.id });
		await t.manager.idle();
		expect(t.runner.calls.map((c) => /## Your Task: (\S+)/.exec(c.prompt)?.[1])).toEqual(["US-003"]);
		expect(t.store.get("sess-5")?.status).toBe("completed");
		expect(existsSync(join(t.store.get("sess-5")?.worktreePath ?? "", "US-003.txt"))).toBe(true);
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
		expect(taskOrder(t)).toEqual(["US-001", "US-002", "US-003"]);
		expect(t.store.get("b-1")?.status).toBe("completed");
		expect(t.linear.bodies("thought")).toContain("ENG-99 is done. Re-checking blockers and resuming.");
	});

	it("runs unblocked stories first, parks on an outside blocker of one story, and resumes via reconcile", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		const api = t.linear.add({ title: "Ship API v2", identifier: "API-7", stateType: "started" });
		// US-001 waits on another team's issue; US-002 depends on US-001; US-003 is free.
		t.linear.blocks.set(s1.id, [api.id]);

		await t.manager.handle({ kind: "created", sessionId: "b-2", issueId: epic.id });
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["US-003"]);
		expect(t.store.get("b-2")?.status).toBe("blocked");
		expect(t.store.get("b-2")?.waitingOn).toEqual([{ id: api.id, identifier: "API-7" }]);
		expect(t.linear.bodies("elicitation").at(-1)).toContain("1/3 stories are done; the rest are waiting on **API-7**");
		expect(t.runner.calls[0]?.prompt).toContain("US-001: Add priority field (depends on API-7)");

		// The webhook was missed; the periodic reconcile notices the blocker closed.
		await t.manager.reconcileParked();
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["US-003"]);
		t.linear.issues.get(api.id)!.stateType = "canceled";
		await t.manager.reconcileParked();
		await t.manager.idle();
		expect(taskOrder(t)).toEqual(["US-003", "US-001", "US-002"]);
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
		expect(taskOrder(t)).toEqual(["US-002"]);
		expect(t.store.get("b-4")?.status).toBe("completed");
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
			return { output, isError: false, aborted: false, sessionId: `claude-req-${++n}` };
		};
	}

	it("ignores Linear's delegation note: delegation works the epic with no request or guidance", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "m-1", issueId: epic.id, commentBody: DELEGATION_BODY });
		await t.manager.idle();
		expect(storyIds(t)).toEqual(["US-001", "US-002", "US-003"]);
		expect(t.runner.calls.some(isRequest)).toBe(false);
		expect(t.store.get("m-1")?.guidance).toEqual([]);
		expect(t.runner.calls[0]?.prompt).not.toContain("This thread is for an agent session");
	});

	it("a mention only does what it asks, even with stories left (no story loop, no Linear changes)", async () => {
		const t = setup();
		const { epic, s1 } = ralphEpic(t.linear);
		answerRequests(t, "The epic has 3 open stories; US-001 is next.");
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
		expect(t.linear.bodies("response").at(-1)).toBe("The epic has 3 open stories; US-001 is next.");
	});

	it("`/ralph` in a mention opts into the story loop, with the rest of the comment as guidance", async () => {
		const t = setup();
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "m-3", issueId: epic.id, commentBody: "@cyralph /ralph use the existing Priority enum" });
		await t.manager.idle();
		expect(storyIds(t)).toEqual(["US-001", "US-002", "US-003"]);
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
		await t.manager.handle({ kind: "created", sessionId: "m-11", issueId: epic.id, commentBody: "@cyralph what does US-002 need?" });
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
			if (/## Your Task: US-001/.test(req.prompt) && injected.length === 0) {
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
		expect(t.runner.calls.find((c) => /## Your Task: US-002/.test(c.prompt))?.prompt).toContain("- Use a smallint column");
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
		expect(t.linear.bodies("thought")).toContain("Opened a draft merge request: https://git.example.com/acme/app/-/merge_requests/7");
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

	it("says why no PR/MR was opened when the CLI isn't usable, once per run", async () => {
		const t = gitlabSetup();
		t.git.preflightProblem = "`glab` is not logged in (run `glab auth login --hostname git.example.com`).";
		const { epic } = ralphEpic(t.linear);
		await t.manager.handle({ kind: "created", sessionId: "f-3", issueId: epic.id });
		await t.manager.idle();
		const notes = t.linear.bodies("thought").filter((b) => b.includes("can't open a merge request"));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("glab auth login --hostname git.example.com");
		expect(t.store.get("f-3")?.prUrl).toBeUndefined();
		expect(t.store.get("f-3")?.status).toBe("completed");
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

