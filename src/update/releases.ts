/**
 * Release bookkeeping shared by the supervisor and the updater.
 *
 * Builds of newer commits live in `<stateDir>/releases/<sha>` (git worktrees of the checkout cyralph
 * was installed from). `state.json` says which one the supervisor should run:
 *
 * - `current`  : the release to run. Absent = the install checkout's own `dist/`.
 * - `previous` : what to roll back to if `current` crashes right after starting (no `dir` = the checkout).
 * - `pending`  : `current` hasn't stayed up long enough yet to count as good.
 * - `failed`   : commits that failed to build or crashed on start; never tried again.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Release {
	sha: string;
	/** Release worktree; undefined = the install checkout itself. */
	dir?: string;
}

export interface ReleaseState {
	current?: Release;
	previous?: Release;
	pending?: boolean;
	failed: string[];
}

/** Exit code the worker uses to ask the supervisor for a restart into the new release. */
export const RESTART_EXIT_CODE = 75;

/** Root of the running cyralph package (works from `dist/update/` and `src/update/`). */
export function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function releasesDir(stateDir: string): string {
	return join(stateDir, "releases");
}

export function pidFile(stateDir: string): string {
	return join(stateDir, "cyralph.pid");
}

function stateFile(stateDir: string): string {
	return join(releasesDir(stateDir), "state.json");
}

export async function loadReleaseState(stateDir: string): Promise<ReleaseState> {
	try {
		const data = JSON.parse(await readFile(stateFile(stateDir), "utf8")) as Partial<ReleaseState>;
		return { ...data, failed: data.failed ?? [] };
	} catch {
		return { failed: [] };
	}
}

export async function saveReleaseState(stateDir: string, state: ReleaseState): Promise<void> {
	const file = stateFile(stateDir);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await rename(`${file}.tmp`, file);
}

/** Read-modify-write, since the supervisor and the worker both write the file. */
export async function updateReleaseState(stateDir: string, change: (state: ReleaseState) => void): Promise<ReleaseState> {
	const state = await loadReleaseState(stateDir);
	change(state);
	await saveReleaseState(stateDir, state);
	return state;
}

/** The release to run: `current` if its build is still there, else the install checkout. */
export function releaseToRun(state: ReleaseState, sourceDir: string): { script: string; release?: Release } {
	const current = state.current;
	if (current?.dir && existsSync(join(current.dir, "dist", "cli.js"))) return { script: join(current.dir, "dist", "cli.js"), release: current };
	return { script: join(sourceDir, "dist", "cli.js") };
}

/** Make `release` current, keeping what ran before as the rollback target until it proves itself. */
export function promote(state: ReleaseState, release: Release, runningSha: string): void {
	state.previous = state.current?.dir ? state.current : { sha: runningSha };
	state.current = release;
	state.pending = true;
}

/** `current` crashed right after starting: mark it failed and go back to `previous`. */
export function rollBack(state: ReleaseState): Release | undefined {
	const bad = state.current;
	if (bad && !state.failed.includes(bad.sha)) state.failed.push(bad.sha);
	state.current = state.previous?.dir ? state.previous : undefined;
	state.previous = undefined;
	state.pending = false;
	return bad;
}
