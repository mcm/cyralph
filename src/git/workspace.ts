/**
 * Git worktree per epic branch, plus commit/push/PR helpers. PRs are opened with the
 * GitHub CLI (`gh`) when available, like Cyrus' verify-and-ship flow.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function run(cmd: string, args: string[], cwd: string, timeoutMs = 10 * 60_000): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileP(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
		return { code: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
		return {
			code: typeof e.code === "number" ? e.code : 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? e.message ?? String(err),
		};
	}
}

export async function runShell(command: string, cwd: string, timeoutMs?: number): Promise<CommandResult> {
	return run("bash", ["-lc", command], cwd, timeoutMs);
}

async function git(args: string[], cwd: string): Promise<CommandResult> {
	return run("git", args, cwd);
}

async function gitOrThrow(args: string[], cwd: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout.trim();
}

export function sanitizeBranchName(name: string): string {
	return (
		name
			.trim()
			.replace(/[\s~^:?*[\\]+/g, "-")
			.replace(/\.{2,}/g, ".")
			.replace(/@\{/g, "-")
			.replace(/\/{2,}/g, "/")
			.replace(/^[-./]+|[-./]+$/g, "")
			.replace(/\.lock$/i, "") || "cyralph-work"
	);
}

export interface PreparedWorkspace {
	path: string;
	branch: string;
	baseBranch: string;
	created: boolean;
}

export interface PullRequestInfo {
	url: string;
	number?: number;
}

export interface GitWorkspace {
	prepare(opts: { repositoryPath: string; workspaceBaseDir: string; branch: string; baseBranch: string }): Promise<PreparedWorkspace>;
	/** Stage everything and commit; returns the commit sha, or undefined when there was nothing to commit. */
	commitAll(cwd: string, message: string): Promise<string | undefined>;
	/** URL of the `origin` remote, if one is configured. */
	remoteUrl(cwd: string): Promise<string | undefined>;
	/** True when `origin` exists and the branch has commits it doesn't have yet. */
	needsPush(cwd: string, baseBranch: string): Promise<boolean>;
	/** Set aside uncommitted work (including untracked files) so the next story starts clean. */
	stashAll(cwd: string, message: string): Promise<boolean>;
	push(cwd: string, branch: string): Promise<void>;
	/** An existing PR for the branch, if any (never creates one). */
	findPullRequest(cwd: string, branch: string): Promise<PullRequestInfo | undefined>;
	ensurePullRequest(cwd: string, opts: { branch: string; baseBranch: string; title: string; body: string }): Promise<PullRequestInfo | undefined>;
	updatePullRequest(cwd: string, pr: PullRequestInfo, opts: { body?: string; ready?: boolean }): Promise<void>;
}

export class CliGitWorkspace implements GitWorkspace {
	async prepare(opts: { repositoryPath: string; workspaceBaseDir: string; branch: string; baseBranch: string }): Promise<PreparedWorkspace> {
		const branch = sanitizeBranchName(opts.branch);
		const path = join(opts.workspaceBaseDir, branch.replace(/\//g, "__"));
		const base = { path, branch, baseBranch: opts.baseBranch };
		if (existsSync(join(path, ".git"))) return { ...base, created: false };

		await mkdir(opts.workspaceBaseDir, { recursive: true });
		const repo = opts.repositoryPath;
		const hasRemote = (await git(["remote", "get-url", "origin"], repo)).code === 0;
		if (hasRemote) await git(["fetch", "origin"], repo);

		// Branch already checked out in another worktree? Reuse it.
		const list = await gitOrThrow(["worktree", "list", "--porcelain"], repo);
		for (const block of list.split("\n\n")) {
			if (block.includes(`branch refs/heads/${branch}\n`) || block.endsWith(`branch refs/heads/${branch}`)) {
				const wt = /^worktree (.+)$/m.exec(block)?.[1];
				if (wt) return { path: wt, branch, baseBranch: opts.baseBranch, created: false };
			}
		}

		const localExists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
		const remoteExists =
			hasRemote && (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repo)).code === 0;
		if (localExists) {
			await gitOrThrow(["worktree", "add", path, branch], repo);
		} else if (remoteExists) {
			await gitOrThrow(["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`], repo);
		} else {
			const remoteBase = hasRemote && (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${opts.baseBranch}`], repo)).code === 0;
			const start = remoteBase ? `origin/${opts.baseBranch}` : opts.baseBranch;
			await gitOrThrow(["worktree", "add", "--no-track", "-b", branch, path, start], repo);
		}
		return { ...base, created: true };
	}

	async commitAll(cwd: string, message: string): Promise<string | undefined> {
		await gitOrThrow(["add", "-A"], cwd);
		if ((await git(["diff", "--cached", "--quiet"], cwd)).code === 0) return undefined;
		await gitOrThrow(["commit", "-m", message], cwd);
		return gitOrThrow(["rev-parse", "HEAD"], cwd);
	}

	async remoteUrl(cwd: string): Promise<string | undefined> {
		const r = await git(["remote", "get-url", "origin"], cwd);
		return r.code === 0 ? r.stdout.trim() || undefined : undefined;
	}

	async needsPush(cwd: string, baseBranch: string): Promise<boolean> {
		if (!(await this.remoteUrl(cwd))) return false;
		await git(["fetch", "origin"], cwd);
		const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
		const hasRemoteBase = (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`], cwd)).code === 0;
		const range = upstream.code === 0 ? "@{u}..HEAD" : `${hasRemoteBase ? `origin/${baseBranch}` : baseBranch}..HEAD`;
		const count = await git(["rev-list", "--count", range], cwd);
		return count.code === 0 && Number(count.stdout.trim()) > 0;
	}

	async stashAll(cwd: string, message: string): Promise<boolean> {
		const status = await gitOrThrow(["status", "--porcelain"], cwd);
		if (!status) return false;
		await gitOrThrow(["stash", "push", "--include-untracked", "-m", message], cwd);
		return true;
	}

	async push(cwd: string, branch: string): Promise<void> {
		await gitOrThrow(["push", "-u", "origin", branch], cwd);
	}

	async findPullRequest(cwd: string, branch: string): Promise<PullRequestInfo | undefined> {
		const existing = await run("gh", ["pr", "view", branch, "--json", "url,number,state"], cwd);
		if (existing.code !== 0) return undefined;
		const data = JSON.parse(existing.stdout) as { url: string; number: number; state?: string };
		return data.state === "CLOSED" ? undefined : { url: data.url, number: data.number };
	}

	async ensurePullRequest(
		cwd: string,
		opts: { branch: string; baseBranch: string; title: string; body: string },
	): Promise<PullRequestInfo | undefined> {
		const existing = await this.findPullRequest(cwd, opts.branch);
		if (existing) return existing;
		const created = await run(
			"gh",
			["pr", "create", "--draft", "--base", opts.baseBranch, "--head", opts.branch, "--title", opts.title, "--body", opts.body],
			cwd,
		);
		if (created.code !== 0) return undefined;
		const url = created.stdout.trim().split("\n").pop() ?? "";
		return url ? { url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined } : undefined;
	}

	async updatePullRequest(cwd: string, pr: PullRequestInfo, opts: { body?: string; ready?: boolean }): Promise<void> {
		if (opts.body !== undefined) await run("gh", ["pr", "edit", pr.url, "--body", opts.body], cwd);
		if (opts.ready) await run("gh", ["pr", "ready", pr.url], cwd);
	}
}
