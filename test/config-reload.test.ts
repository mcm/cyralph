import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { ConfigReloader } from "../src/config-reload.js";
import type { Logger } from "../src/logger.js";

function recordingLogger() {
	const lines: string[] = [];
	const log: Logger = {
		info: (m) => lines.push(`info ${m}`),
		warn: (m) => lines.push(`warn ${m}`),
		error: (m) => lines.push(`error ${m}`),
		debug: () => {},
	};
	return { log, lines };
}

const base = { linear: { webhookSecret: "s" }, repositories: [{ id: "app", name: "app", repositoryPath: "./app" }] };

async function setup(raw: Record<string, unknown> = base) {
	const dir = mkdtempSync(join(tmpdir(), "cyralph-reload-"));
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(raw));
	const initial = await loadConfig(path);
	const { log, lines } = recordingLogger();
	const applied: Config[] = [];
	const reloader = new ConfigReloader({
		path,
		initial,
		log,
		debounceMs: 20,
		apply: (next) => void applied.push(next),
		validate: (c) => (c.linear.webhookSecret ? undefined : "linear.webhookSecret is required"),
	});
	const write = (r: Record<string, unknown>) => writeFileSync(path, JSON.stringify(r));
	return { dir, path, initial, reloader, applied, lines, write };
}

describe("config reloader", () => {
	it("applies a valid change and ignores saves that change nothing", async () => {
		const t = await setup();
		await t.reloader.start();
		expect(await t.reloader.reload()).toBe(false); // file unchanged since start
		t.write({ ...base, model: "sonnet", maxConcurrentSessions: 4 });
		expect(await t.reloader.reload()).toBe(true);
		expect(t.reloader.config.model).toBe("sonnet");
		expect(t.applied.map((c) => c.maxConcurrentSessions)).toEqual([4]);
		expect(t.lines.some((l) => l.startsWith("info config reloaded") && l.includes("model") && l.includes("maxConcurrentSessions"))).toBe(true);
		t.reloader.stop();
	});

	it("keeps the old config when the new file is malformed or invalid, and says why", async () => {
		const t = await setup();
		await t.reloader.start();
		writeFileSync(t.path, "{ not json");
		expect(await t.reloader.reload()).toBe(false);
		t.write({ ...base, maxConcurrentSessions: 0 });
		expect(await t.reloader.reload()).toBe(false);
		t.write({ ...base, linear: {} });
		expect(await t.reloader.reload()).toBe(false);
		expect(t.reloader.config).toBe(t.initial);
		expect(t.applied).toEqual([]);
		const errors = t.lines.filter((l) => l.startsWith("error config reload rejected"));
		expect(errors).toHaveLength(3);
		expect(errors[1]).toContain("maxConcurrentSessions");
		expect(errors[2]).toContain("linear.webhookSecret is required");
		// Fixing the file applies it.
		t.write({ ...base, model: "sonnet" });
		expect(await t.reloader.reload()).toBe(true);
		t.reloader.stop();
	});

	it("keeps port, stateDir and autoUpdate until a restart and logs that", async () => {
		const t = await setup();
		await t.reloader.start();
		t.write({ ...base, port: 9999, stateDir: "./elsewhere", autoUpdate: { enabled: false }, model: "sonnet" });
		expect(await t.reloader.reload()).toBe(true);
		const c = t.reloader.config;
		expect(c.model).toBe("sonnet");
		expect(c.port).toBe(t.initial.port);
		expect(c.stateDir).toBe(t.initial.stateDir);
		expect(c.repositories[0]?.workspaceBaseDir).toBe(t.initial.repositories[0]?.workspaceBaseDir);
		expect(c.autoUpdate).toEqual(t.initial.autoUpdate);
		expect(t.lines).toContain("warn config: port, stateDir, autoUpdate changed but only take effect after a restart");
		t.reloader.stop();
	});

	it("keeps the old config when applying it throws", async () => {
		const t = await setup();
		const reloader = new ConfigReloader({
			path: t.path,
			initial: t.initial,
			log: recordingLogger().log,
			apply: () => {
				throw new Error("boom");
			},
		});
		t.write({ ...base, model: "sonnet" });
		expect(await reloader.reload()).toBe(false);
		expect(reloader.config).toBe(t.initial);
	});

	it("notices edits on its own, including editors that save by renaming over the file", async () => {
		const t = await setup();
		await t.reloader.start();
		const tmp = join(t.dir, ".config.json.swp");
		writeFileSync(tmp, JSON.stringify({ ...base, model: "sonnet" }));
		renameSync(tmp, t.path);
		await expect.poll(() => t.reloader.config.model, { timeout: 2000 }).toBe("sonnet");
		t.write({ ...base, model: "haiku" });
		await expect.poll(() => t.reloader.config.model, { timeout: 2000 }).toBe("haiku");
		expect(t.applied).toHaveLength(2);
		t.reloader.stop();
	});
});
