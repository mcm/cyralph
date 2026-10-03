/**
 * `cyralph start` runs this small supervisor, which runs the agent as a child process:
 *
 * - exit 75 (the agent drained itself for an update) → start again, now on the new release;
 * - a new release that dies within `confirmAfterMs` → mark it failed and roll back to the previous one;
 * - a crash after that → restart with backoff; a crash on start of a known-good build → give up;
 * - a clean exit (0) stops the supervisor too; SIGINT/SIGTERM are passed on and it exits with the agent;
 * - SIGUSR2 is passed on, and asks the agent for an update check.
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Logger } from "../logger.js";
import { RESTART_EXIT_CODE, loadReleaseState, pidFile, releaseToRun, rollBack, updateReleaseState } from "./releases.js";

export interface SupervisorOptions {
	stateDir: string;
	sourceDir: string;
	/** Arguments for the agent, e.g. ["start", "--config", path]. */
	args: string[];
	log: Logger;
	confirmAfterMs?: number;
	/** Seam for tests. */
	spawnAgent?: (script: string, args: string[], env: NodeJS.ProcessEnv) => import("node:child_process").ChildProcess;
	sleep?: (ms: number) => Promise<void>;
}

const defaultSpawn: NonNullable<SupervisorOptions["spawnAgent"]> = (script, args, env) =>
	spawn(process.execPath, [script, ...args], { stdio: "inherit", env });

/** Resolves with the exit code the supervisor should exit with. */
export async function supervise(opts: SupervisorOptions): Promise<number> {
	const { stateDir, sourceDir, log } = opts;
	const confirmAfterMs = opts.confirmAfterMs ?? 60_000;
	const spawnAgent = opts.spawnAgent ?? defaultSpawn;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	let child: import("node:child_process").ChildProcess | undefined;
	let stopping = false;
	const forward = (signal: NodeJS.Signals) => () => {
		if (signal !== "SIGUSR2") stopping = true;
		child?.kill(signal);
	};
	const handlers = (["SIGINT", "SIGTERM", "SIGUSR2"] as const).map((s) => [s, forward(s)] as const);
	for (const [s, h] of handlers) process.on(s, h);
	await mkdir(stateDir, { recursive: true });
	writeFileSync(pidFile(stateDir), `${process.pid}\n`);

	let backoffMs = 5_000;
	try {
		for (;;) {
			const state = await loadReleaseState(stateDir);
			const { script, release } = releaseToRun(state, sourceDir);
			log.info(`supervisor: starting cyralph${release ? ` ${release.sha.slice(0, 7)}` : ""}`);
			const startedAt = Date.now();
			const env = { ...process.env, CYRALPH_SUPERVISED: "1", CYRALPH_SOURCE_DIR: sourceDir, CYRALPH_RELEASE_SHA: release?.sha ?? "" };
			const proc = spawnAgent(script, opts.args, env);
			child = proc;
			let confirmed = !state.pending;
			const confirm = state.pending
				? setTimeout(() => {
						confirmed = true;
						void updateReleaseState(stateDir, (s) => {
							if (s.current?.sha === release?.sha) s.pending = false;
						}).then(() => log.info(`supervisor: ${release?.sha.slice(0, 7) ?? "build"} is up and running; keeping it`));
					}, confirmAfterMs)
				: undefined;
			const code = await new Promise<number>((resolve) => {
				proc.once("exit", (c, signal) => resolve(c ?? (signal ? 128 : 1)));
				proc.once("error", (err) => {
					log.error(`supervisor: couldn't start cyralph: ${String(err)}`);
					resolve(1);
				});
			});
			clearTimeout(confirm);
			child = undefined;
			// A signal we passed on, or the agent shutting down cleanly on its own (e.g. it was sent SIGTERM).
			if (stopping || code === 0) return code;
			if (code === RESTART_EXIT_CODE) {
				backoffMs = 5_000;
				continue;
			}
			const upFor = Date.now() - startedAt;
			if (!confirmed && release) {
				const after = await updateReleaseState(stateDir, (s) => void rollBack(s));
				log.error(`supervisor: ${release.sha.slice(0, 7)} exited with ${code} right after starting; rolled back to ${after.current?.sha.slice(0, 7) ?? "the installed checkout"}`);
				continue;
			}
			if (upFor < confirmAfterMs) {
				log.error(`supervisor: cyralph exited with ${code} on startup; not restarting`);
				return code;
			}
			if (upFor > 10 * 60_000) backoffMs = 5_000;
			log.warn(`supervisor: cyralph exited with ${code}; restarting in ${Math.round(backoffMs / 1000)}s`);
			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
		}
	} finally {
		for (const [s, h] of handlers) process.off(s, h);
		rmSync(pidFile(stateDir), { force: true });
	}
}
