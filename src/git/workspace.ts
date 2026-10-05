/**
 * Git worktree per epic branch, plus commit/push helpers. PR/MR operations live in forge.ts
 * (`gh` for GitHub, `glab` for GitLab), like Cyrus' verify-and-ship flow.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Forge, type ForgeKind, createForge, detectForgeKind } from "./forge.js";

export type { Forge, ForgeKind, PullRequestInfo } from "./forge.js";

const execFileP = promisify(execFile);

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function run(
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs = 10 * 60_000,
	env?: Record<string, string>,
): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileP(cmd, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 32 * 1024 * 1024,
			...(env && { env: { ...process.env, ...env } }),
		});
		return { code: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
		return {
			code: typeof e.code === "number" ? e.code : 1,
			stdout: e.stdout ?? "",
			// A missing binary (ENOENT) has empty stderr; keep the message so callers can tell.
			stderr: e.stderr || e.message || String(err),
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


export interface GitWorkspace {
	prepare(opts: { repositoryPath: string; workspaceBaseDir: string; branch: string; baseBranch: string }): Promise<PreparedWorkspace>;
	/** Stage everything and commit; returns the commit sha, or undefined when there was nothing to commit. */
	commitAll(cwd: string, message: string): Promise<string | undefined>;
	/** Paths `git status` still reports as changed or untracked (ignored files excluded). */
	uncommittedChanges(cwd: string): Promise<string[]>;
	/** URL of the `origin` remote, if one is configured. */
	remoteUrl(cwd: string): Promise<string | undefined>;
	/** True when `origin` exists and the branch has commits it doesn't have yet. */
	needsPush(cwd: string, baseBranch: string): Promise<boolean>;
	/** True when the branch has commits its base branch doesn't (on `origin` when it has the base). */
	hasCommits(cwd: string, baseBranch: string): Promise<boolean>;
	/** Set aside uncommitted work (including untracked files) so the next story starts clean. */
	stashAll(cwd: string, message: string): Promise<boolean>;
	push(cwd: string, branch: string): Promise<void>;
	/**
	 * Remove a worktree and its local branch once their work was merged. Nothing is removed while the
	 * worktree has uncommitted changes or the branch has commits `mergedSha` doesn't contain; the
	 * reason is returned instead.
	 */
	removeWorkspace(opts: { repositoryPath: string; path: string; branch: string; mergedSha?: string }): Promise<string | undefined>;
	/** The PR/MR host for this worktree's `origin` (undefined when there is no remote). */
	forge(cwd: string, opts?: { forge?: ForgeKind; gitlabHosts?: string[]; gitlabHost?: string }): Promise<Forge | undefined>;
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
			let remoteBase = hasRemote && (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${opts.baseBranch}`], repo)).code === 0;
			if (!remoteBase && (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${opts.baseBranch}`], repo)).code !== 0) {
				// A brand-new repository has no commits, and a worktree needs one to branch from.
				await this.createInitialCommit(repo, opts.baseBranch, hasRemote);
				remoteBase = hasRemote;
			}
			const start = remoteBase ? `origin/${opts.baseBranch}` : opts.baseBranch;
			await gitOrThrow(["worktree", "add", "--no-track", "-b", branch, path, start], repo);
		}
		return { ...base, created: true };
	}

	/**
	 * Give an empty repository its first (empty) commit on `baseBranch`, pushed to `origin` when there
	 * is one. A repository that already has commits elsewhere is left alone: its base branch is just
	 * missing, which is a configuration mistake rather than something to paper over.
	 */
	private async createInitialCommit(repo: string, baseBranch: string, hasRemote: boolean): Promise<void> {
		const refs = await gitOrThrow(["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes"], repo);
		if (refs) throw new Error(`base branch \`${baseBranch}\` doesn't exist in ${repo}${hasRemote ? " or on origin" : ""}`);
		const emptyTree = await gitOrThrow(["hash-object", "-t", "tree", "/dev/null"], repo);
		const sha = await gitOrThrow(["commit-tree", emptyTree, "-m", "Initial commit"], repo);
		// The empty old value makes this fail rather than overwrite a branch created in the meantime.
		await gitOrThrow(["update-ref", `refs/heads/${baseBranch}`, sha, ""], repo);
		if (hasRemote) await gitOrThrow(["push", "origin", `refs/heads/${baseBranch}:refs/heads/${baseBranch}`], repo);
	}

	async commitAll(cwd: string, message: string): Promise<string | undefined> {
		await gitOrThrow(["add", "-A"], cwd);
		if ((await git(["diff", "--cached", "--quiet"], cwd)).code === 0) return undefined;
		await gitOrThrow(["commit", "-m", message], cwd);
		return gitOrThrow(["rev-parse", "HEAD"], cwd);
	}

	async uncommittedChanges(cwd: string): Promise<string[]> {
		const r = await git(["status", "--porcelain", "--untracked-files=all"], cwd);
		if (r.code !== 0) throw new Error(`git status failed: ${r.stderr.trim() || r.stdout.trim()}`);
		return r.stdout.split("\n").filter((l) => l.trim());
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

	async hasCommits(cwd: string, baseBranch: string): Promise<boolean> {
		const hasRemoteBase = (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`], cwd)).code === 0;
		const count = await git(["rev-list", "--count", `${hasRemoteBase ? `origin/${baseBranch}` : baseBranch}..HEAD`], cwd);
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

	async removeWorkspace(opts: { repositoryPath: string; path: string; branch: string; mergedSha?: string }): Promise<string | undefined> {
		const repo = opts.repositoryPath;
		const hasWorktree = existsSync(join(opts.path, ".git"));
		const tip = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${opts.branch}`], repo);
		if (!hasWorktree && tip.code !== 0) return undefined;
		if (hasWorktree) {
			const status = await git(["status", "--porcelain"], opts.path);
			if (status.code !== 0) return `\`git status\` failed in ${opts.path}: ${status.stderr.trim()}`;
			if (status.stdout.trim()) return "the worktree has uncommitted changes";
		}
		const heads = [hasWorktree ? (await git(["rev-parse", "HEAD"], opts.path)).stdout.trim() : "", tip.code === 0 ? tip.stdout.trim() : ""].filter(Boolean);
		if (opts.mergedSha) {
			const merged = opts.mergedSha;
			// The merged head may only be on the remote (e.g. pushed by someone else).
			if ((await git(["cat-file", "-e", `${merged}^{commit}`], repo)).code !== 0) await git(["fetch", "origin"], repo);
			for (const head of heads) {
				if (head !== merged && (await git(["merge-base", "--is-ancestor", head, merged], repo)).code !== 0) {
					return `\`${opts.branch}\` has commits that weren't merged`;
				}
			}
		}
		if (hasWorktree) await gitOrThrow(["worktree", "remove", "--force", opts.path], repo);
		await git(["worktree", "prune"], repo);
		if (tip.code === 0) await gitOrThrow(["branch", "-D", opts.branch], repo);
		return undefined;
	}

	async forge(cwd: string, opts: { forge?: ForgeKind; gitlabHosts?: string[]; gitlabHost?: string } = {}): Promise<Forge | undefined> {
		const remote = await this.remoteUrl(cwd);
		if (!remote) return undefined;
		return createForge(detectForgeKind(remote, opts), { gitlabHost: opts.gitlabHost });
	}
}
