/**
 * Reloads the config file when it changes, without a restart.
 *
 * The file's directory is watched (editors often save by writing a new file and renaming it over the
 * old one, which a watch on the file itself would lose). Changes are debounced, then the new file is
 * parsed and validated; an invalid file is logged and the running config stays in place. Runs already
 * in progress keep the config they started with: consumers swap in the new object for new work only.
 *
 * A few settings are bound at startup (the listening port, the state directory, self-update). A change
 * to one of those keeps its old value until the next restart and is logged as needing one.
 */
import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { type Config, parseConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Top-level settings that only take effect on restart. */
export const RESTART_ONLY_KEYS = ["port", "stateDir", "autoUpdate"] as const;

export interface ConfigReloaderOptions {
	path: string;
	initial: Config;
	log: Logger;
	/** Called with the validated new config. Throwing keeps the old config. */
	apply: (next: Config, prev: Config) => void | Promise<void>;
	/** Extra checks beyond the schema; return a reason to reject the new config. */
	validate?: (next: Config) => string | undefined;
	debounceMs?: number;
	/** Injected for tests. */
	readText?: (path: string) => Promise<string>;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Names of the restart-only settings that differ between two configs. */
export function restartOnlyChanges(prev: Config, next: Config): string[] {
	return RESTART_ONLY_KEYS.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
}

export class ConfigReloader {
	private current: Config;
	private lastHash: string | undefined;
	private watcher: FSWatcher | undefined;
	private timer: NodeJS.Timeout | undefined;
	/** Serialises reloads so two quick saves can't apply out of order. */
	private chain: Promise<unknown> = Promise.resolve();
	private readonly readText: (path: string) => Promise<string>;

	constructor(private readonly opts: ConfigReloaderOptions) {
		this.current = opts.initial;
		this.readText = opts.readText ?? ((p) => readFile(p, "utf8"));
	}

	get config(): Config {
		return this.current;
	}

	async start(): Promise<void> {
		this.lastHash = await this.readText(this.opts.path).then(hash, () => undefined);
		const file = basename(this.opts.path);
		try {
			this.watcher = watch(dirname(this.opts.path), (_event, name) => {
				if (name === null || name.toString() === file) this.schedule();
			});
			this.watcher.on("error", (err) => this.opts.log.warn(`config watch failed (send SIGHUP to reload): ${String(err)}`));
			this.watcher.unref();
		} catch (err) {
			this.opts.log.warn(`can't watch ${this.opts.path} for changes (send SIGHUP to reload): ${String(err)}`);
		}
	}

	stop(): void {
		this.watcher?.close();
		this.watcher = undefined;
		clearTimeout(this.timer);
	}

	/** Debounced reload, for bursts of file events from one save. */
	schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.reload(), this.opts.debounceMs ?? 500);
		this.timer.unref();
	}

	/** Reload now. Resolves true when a new config was applied. */
	reload(opts: { force?: boolean } = {}): Promise<boolean> {
		const next = this.chain.then(() => this.doReload(opts.force ?? false));
		this.chain = next.catch(() => undefined);
		return next;
	}

	private async doReload(force: boolean): Promise<boolean> {
		const { path, log } = this.opts;
		let text: string;
		try {
			text = await this.readText(path);
		} catch (err) {
			// Mid-save (deleted before the rename) or really gone: either way, keep what we have.
			log.warn(`config reload skipped: can't read ${path}: ${String(err)}`);
			return false;
		}
		const digest = hash(text);
		if (!force && digest === this.lastHash) return false;

		const prev = this.current;
		let next: Config;
		let restart: string[];
		try {
			const raw = JSON.parse(text) as Record<string, unknown>;
			next = parseConfig(raw, path);
			restart = restartOnlyChanges(prev, next);
			// Keep the state directory the process started with: sessions, worktrees and update state live
			// there. Re-parse so paths derived from it (the default workspaceBaseDir) follow the old one too.
			if (next.stateDir !== prev.stateDir) next = parseConfig({ ...raw, stateDir: prev.stateDir }, path);
		} catch (err) {
			log.error(`config reload rejected, keeping the running config: ${describeError(err)}`);
			this.lastHash = digest;
			return false;
		}
		next = { ...next, port: prev.port, autoUpdate: prev.autoUpdate };
		const problem = this.opts.validate?.(next);
		if (problem) {
			log.error(`config reload rejected, keeping the running config: ${problem}`);
			this.lastHash = digest;
			return false;
		}

		try {
			await this.opts.apply(next, prev);
		} catch (err) {
			log.error(`config reload failed to apply, keeping the running config: ${describeError(err)}`);
			this.lastHash = digest;
			return false;
		}
		this.current = next;
		this.lastHash = digest;
		log.info(`config reloaded from ${path}${changedSummary(prev, next)}; new work uses it, running sessions keep the config they started with`);
		if (restart.length) log.warn(`config: ${restart.join(", ")} changed but only take${restart.length === 1 ? "s" : ""} effect after a restart`);
		return true;
	}
}

function describeError(err: unknown): string {
	if (err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown[] }).issues)) {
		return (err as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues
			.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
			.join("; ");
	}
	return err instanceof Error ? err.message : String(err);
}

/** " (changed: model, repositories)" for the top-level keys that differ, or "" when nothing visibly did. */
function changedSummary(prev: Config, next: Config): string {
	const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof Config>;
	const changed = [...keys].filter((k) => k !== "configPath" && JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
	return changed.length ? ` (changed: ${changed.join(", ")})` : "";
}
