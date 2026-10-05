import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliGitWorkspace } from "../src/git/workspace.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function configure(repo: string) {
	sh(repo, "config", "user.email", "t@example.com");
	sh(repo, "config", "user.name", "Test");
	sh(repo, "config", "commit.gpgsign", "false");
}

describe("worktrees in empty repositories", () => {
	it("gives a freshly cloned empty repository its first commit and pushes it", async () => {
		const root = mkdtempSync(join(tmpdir(), "cyralph-ws-"));
		const origin = join(root, "origin.git");
		const repo = join(root, "repo");
		execFileSync("git", ["init", "--bare", "-b", "main", origin]);
		execFileSync("git", ["clone", origin, repo], { stdio: "ignore" });
		configure(repo);

		const ws = await new CliGitWorkspace().prepare({ repositoryPath: repo, workspaceBaseDir: join(root, "ws"), branch: "epic/one", baseBranch: "main" });

		expect(ws.created).toBe(true);
		const initial = sh(origin, "rev-parse", "refs/heads/main");
		expect(sh(ws.path, "rev-parse", "HEAD")).toBe(initial);
		expect(sh(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("epic/one");
		expect(sh(ws.path, "ls-tree", "HEAD")).toBe("");
	});

	it("gives a local-only empty repository its first commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "cyralph-ws-"));
		const repo = join(root, "repo");
		execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
		configure(repo);

		const ws = await new CliGitWorkspace().prepare({ repositoryPath: repo, workspaceBaseDir: join(root, "ws"), branch: "epic/one", baseBranch: "main" });

		expect(sh(ws.path, "rev-parse", "HEAD")).toBe(sh(repo, "rev-parse", "refs/heads/main"));
	});

	it("still fails when a repository with commits is missing its base branch", async () => {
		const root = mkdtempSync(join(tmpdir(), "cyralph-ws-"));
		const repo = join(root, "repo");
		execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
		configure(repo);
		writeFileSync(join(repo, "README.md"), "hi\n");
		sh(repo, "add", ".");
		sh(repo, "commit", "-m", "init");

		await expect(
			new CliGitWorkspace().prepare({ repositoryPath: repo, workspaceBaseDir: join(root, "ws"), branch: "epic/one", baseBranch: "develop" }),
		).rejects.toThrow(/base branch `develop` doesn't exist/);
		expect(() => sh(repo, "rev-parse", "--verify", "refs/heads/develop")).toThrow();
	});
});

describe("stash entries by SHA", () => {
	it("finds its own entry among others, drops it after indexes shift, and pushes entries to a branch with their untracked files", async () => {
		const root = mkdtempSync(join(tmpdir(), "cyralph-stash-"));
		const origin = join(root, "origin.git");
		const repo = join(root, "repo");
		execFileSync("git", ["init", "--bare", "-b", "main", origin]);
		execFileSync("git", ["clone", origin, repo], { stdio: "ignore" });
		configure(repo);
		writeFileSync(join(repo, "README.md"), "hi\n");
		sh(repo, "add", ".");
		sh(repo, "commit", "-m", "init");
		sh(repo, "push", "-u", "origin", "main");
		const git = new CliGitWorkspace();

		expect(await git.stashAll(repo, "cyralph: E-1 S-1 blocked")).toBeUndefined();
		writeFileSync(join(repo, "README.md"), "changed\n");
		writeFileSync(join(repo, "new.txt"), "untracked\n");
		const mine = await git.stashAll(repo, "cyralph: E-1 S-1 blocked");
		writeFileSync(join(repo, "other.txt"), "other\n");
		const other = await git.stashAll(repo, "cyralph: E-2 S-9 blocked");
		const list = await git.listStashes(repo);
		expect(list.map((e) => [e.sha, e.ref, e.label])).toEqual([
			[other, "stash@{0}", "cyralph: E-2 S-9 blocked"],
			[mine, "stash@{1}", "cyralph: E-1 S-1 blocked"],
		]);

		await git.pushStashes(repo, "cyralph/stash/e-1", list.filter((e) => e.sha === mine));
		expect(sh(origin, "show", "cyralph/stash/e-1:README.md")).toBe("changed");
		expect(sh(origin, "show", "cyralph/stash/e-1:new.txt")).toBe("untracked");
		expect(sh(origin, "log", "-1", "--format=%s", "cyralph/stash/e-1")).toBe("cyralph: E-1 S-1 blocked");

		// Dropping by SHA uses the entry's current index, which moved when the other one went first.
		expect(await git.dropStash(repo, other ?? "")).toBe(true);
		expect(await git.dropStash(repo, mine ?? "")).toBe(true);
		expect(await git.dropStash(repo, mine ?? "")).toBe(false);
		expect(await git.listStashes(repo)).toEqual([]);
	});
});
