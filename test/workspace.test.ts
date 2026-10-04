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
