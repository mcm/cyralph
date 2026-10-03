/**
 * Self-update: watch the branch cyralph was installed from, build new commits off to the side, and
 * hand a passing build to `onReady` (which drains the agent and restarts into it).
 *
 * The running build is never touched: each commit is checked out as a git worktree under
 * `<stateDir>/releases/<sha>` and built and tested there. A commit that fails is remembered and
 * skipped until the branch moves on.
 */
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "../git/workspace.js";
import type { Logger } from "../logger.js";
import { type Release, loadReleaseState, releasesDir, updateReleaseState } from "./releases.js";

export interface UpdaterOptions {
	stateDir: string;
	/** The git checkout cyralph was installed from. */
	sourceDir: string;
	/** Commit of the build running now. */
	runningSha: string;
	remote: string;
	branch: string;
	buildCommands: string[];
	run: (cmd: string, args: string[], cwd: string, timeoutMs?: number) => Promise<CommandResult>;
	shell: (command: string, cwd: string, timeoutMs?: number) => Promise<CommandResult>;
	log: Logger;
	/** Called with a release that built and passed its checks. */
	onReady: (release: Release) => Promise<void>;
}

const BUILD_TIMEOUT_MS = 30 * 60_000;

function tail(text: string, lines = 30): string {
	return text.trim().split("\n").slice(-lines).join("\n");
}

export type CheckResult = "up-to-date" | "skipped" | "failed" | "ready" | "busy";

export class Updater {
	private checking = false;
	private ready = false;
	private readonly toldSkipped = new Set<string>();

	constructor(private readonly opts: UpdaterOptions) {}

	/** Fetch the branch; if it moved, build the new commit and hand it over. */
	async check(): Promise<CheckResult> {
		if (this.checking || this.ready) return "busy";
		this.checking = true;
		try {
			return await this.checkOnce();
		} finally {
			this.checking = false;
		}
	}

	private async checkOnce(): Promise<CheckResult> {
		const { sourceDir, remote, branch, runningSha, log } = this.opts;
		const fetched = await this.opts.run("git", ["fetch", "--quiet", remote, branch], sourceDir);
		if (fetched.code !== 0) {
			log.warn(`update check: git fetch ${remote} ${branch} failed: ${fetched.stderr.trim()}`);
			return "failed";
		}
		const sha = (await this.opts.run("git", ["rev-parse", "FETCH_HEAD"], sourceDir)).stdout.trim();
		if (!sha || sha === runningSha) return "up-to-date";
		const state = await loadReleaseState(this.opts.stateDir);
		if (state.failed.includes(sha)) {
			if (!this.toldSkipped.has(sha)) log.warn(`update check: ${sha.slice(0, 7)} failed before; waiting for a newer commit on ${branch}`);
			this.toldSkipped.add(sha);
			return "skipped";
		}

		log.info(`update: ${remote}/${branch} is at ${sha.slice(0, 7)} (running ${runningSha.slice(0, 7)}); building it`);
		const release = await this.build(sha, [state.current?.dir, state.previous?.dir]);
		if (!release) {
			await updateReleaseState(this.opts.stateDir, (s) => {
				if (!s.failed.includes(sha)) s.failed.push(sha);
			});
			return "failed";
		}
		log.info(`update: ${sha.slice(0, 7)} built and passed its checks`);
		this.ready = true;
		await this.opts.onReady(release);
		return "ready";
	}

	private async build(sha: string, keep: Array<string | undefined>): Promise<Release | undefined> {
		const { sourceDir, stateDir, log } = this.opts;
		const dir = join(releasesDir(stateDir), sha);
		await this.prune([...keep, dir]);
		if (existsSync(dir)) await this.removeWorktree(dir); // a half-finished earlier attempt
		const added = await this.opts.run("git", ["worktree", "add", "--detach", "--force", dir, sha], sourceDir);
		if (added.code !== 0) {
			log.error(`update: couldn't check out ${sha.slice(0, 7)}: ${added.stderr.trim()}`);
			return undefined;
		}
		for (const command of this.opts.buildCommands) {
			const r = await this.opts.shell(command, dir, BUILD_TIMEOUT_MS);
			if (r.code !== 0) {
				log.error(`update: \`${command}\` failed for ${sha.slice(0, 7)}; staying on the current version.\n${tail(`${r.stdout}\n${r.stderr}`)}`);
				await this.removeWorktree(dir);
				return undefined;
			}
		}
		if (!existsSync(join(dir, "dist", "cli.js"))) {
			log.error(`update: ${sha.slice(0, 7)} built without dist/cli.js; staying on the current version`);
			await this.removeWorktree(dir);
			return undefined;
		}
		return { sha, dir };
	}

	/** Remove release worktrees other than the ones still needed. */
	private async prune(keep: Array<string | undefined>): Promise<void> {
		const root = releasesDir(this.opts.stateDir);
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			const dir = join(root, e.name);
			if (e.isDirectory() && !keep.includes(dir)) await this.removeWorktree(dir);
		}
	}

	private async removeWorktree(dir: string): Promise<void> {
		await this.opts.run("git", ["worktree", "remove", "--force", dir], this.opts.sourceDir);
		await rm(dir, { recursive: true, force: true });
		await this.opts.run("git", ["worktree", "prune"], this.opts.sourceDir);
	}
}

/** Work out what to track from the install checkout. Undefined (with a reason logged) = can't self-update. */
export async function detectInstall(opts: {
	sourceDir: string;
	branch?: string;
	run: UpdaterOptions["run"];
	log: Logger;
}): Promise<{ runningSha: string; branch: string } | undefined> {
	const { sourceDir, run, log } = opts;
	const sha = await run("git", ["rev-parse", "HEAD"], sourceDir);
	if (sha.code !== 0) {
		log.warn(`self-update is off: ${sourceDir} isn't a git checkout`);
		return undefined;
	}
	const branch = opts.branch ?? (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], sourceDir)).stdout.trim();
	if (!branch || branch === "HEAD") {
		log.warn(`self-update is off: ${sourceDir} is on a detached HEAD; set autoUpdate.branch to choose a branch`);
		return undefined;
	}
	return { runningSha: sha.stdout.trim(), branch };
}
