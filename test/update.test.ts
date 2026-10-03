import { type ChildProcess, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, runShell } from "../src/git/workspace.js";
import { silentLogger } from "../src/logger.js";
import { type Release, type ReleaseState, RESTART_EXIT_CODE, loadReleaseState, promote, releaseToRun, rollBack, saveReleaseState } from "../src/update/releases.js";
import { supervise } from "../src/update/supervisor.js";
import { Updater, detectInstall } from "../src/update/updater.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A bare origin, an install checkout of it, and a second clone to push new commits from. */
function makeInstall() {
	const root = mkdtempSync(join(tmpdir(), "cyralph-update-"));
	const origin = join(root, "origin.git");
	const install = join(root, "install");
	const dev = join(root, "dev");
	execFileSync("git", ["init", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", origin, dev], { stdio: "ignore" });
	for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "Test"], ["commit.gpgsign", "false"]]) git(dev, "config", k as string, v as string);
	writeFileSync(join(dev, "build.sh"), "mkdir -p dist && echo 'console.log(1)' > dist/cli.js\n");
	git(dev, "add", ".");
	git(dev, "commit", "-m", "v1");
	git(dev, "push", "-u", "origin", "main");
	execFileSync("git", ["clone", origin, install], { stdio: "ignore" });
	const commit = (file: string, body: string, msg: string) => {
		writeFileSync(join(dev, file), body);
		git(dev, "add", ".");
		git(dev, "commit", "-m", msg);
		git(dev, "push", "origin", "main");
		return git(dev, "rev-parse", "HEAD");
	};
	return { root, install, stateDir: join(root, "state"), commit, runningSha: git(install, "rev-parse", "HEAD") };
}

function updater(t: ReturnType<typeof makeInstall>, buildCommands = ["bash build.sh"]) {
	const ready: Release[] = [];
	const u = new Updater({
		stateDir: t.stateDir,
		sourceDir: t.install,
		runningSha: t.runningSha,
		remote: "origin",
		branch: "main",
		buildCommands,
		run,
		shell: runShell,
		log: silentLogger,
		onReady: async (r) => void ready.push(r),
	});
	return { u, ready };
}

describe("updater", () => {
	it("does nothing while the branch hasn't moved", async () => {
		const t = makeInstall();
		const { u, ready } = updater(t);
		expect(await u.check()).toBe("up-to-date");
		expect(ready).toEqual([]);
	});

	it("builds a new commit in its own worktree and hands it over", async () => {
		const t = makeInstall();
		const sha = t.commit("feature.txt", "new\n", "v2");
		const { u, ready } = updater(t);
		expect(await u.check()).toBe("ready");
		expect(ready).toEqual([{ sha, dir: join(t.stateDir, "releases", sha) }]);
		expect(existsSync(join(t.stateDir, "releases", sha, "dist", "cli.js"))).toBe(true);
		expect(existsSync(join(t.stateDir, "releases", sha, "feature.txt"))).toBe(true);
		// The install checkout itself is untouched.
		expect(git(t.install, "rev-parse", "HEAD")).toBe(t.runningSha);
		expect(existsSync(join(t.install, "feature.txt"))).toBe(false);
	});

	it("remembers a commit that fails its checks and skips it until the branch moves on", async () => {
		const t = makeInstall();
		const bad = t.commit("build.sh", "exit 3\n", "broken build");
		const { u, ready } = updater(t);
		expect(await u.check()).toBe("failed");
		expect((await loadReleaseState(t.stateDir)).failed).toEqual([bad]);
		expect(existsSync(join(t.stateDir, "releases", bad))).toBe(false);
		expect(await u.check()).toBe("skipped");
		const fixed = t.commit("build.sh", "mkdir -p dist && touch dist/cli.js\n", "fix build");
		expect(await u.check()).toBe("ready");
		expect(ready.map((r) => r.sha)).toEqual([fixed]);
	});

	it("follows the install checkout's branch, and is off for a detached checkout", async () => {
		const t = makeInstall();
		expect(await detectInstall({ sourceDir: t.install, run, log: silentLogger })).toEqual({ runningSha: t.runningSha, branch: "main" });
		git(t.install, "checkout", "--detach");
		expect(await detectInstall({ sourceDir: t.install, run, log: silentLogger })).toBeUndefined();
		expect(await detectInstall({ sourceDir: t.root, run, log: silentLogger })).toBeUndefined();
	});
});

describe("release state", () => {
	it("promotes a release with the running build as the rollback target, and rolls back", () => {
		const state: ReleaseState = { failed: [] };
		promote(state, { sha: "b", dir: "/r/b" }, "a");
		expect(state).toEqual({ current: { sha: "b", dir: "/r/b" }, previous: { sha: "a" }, pending: true, failed: [] });
		promote(state, { sha: "c", dir: "/r/c" }, "b");
		expect(state.previous).toEqual({ sha: "b", dir: "/r/b" });
		expect(rollBack(state)?.sha).toBe("c");
		expect(state).toEqual({ current: { sha: "b", dir: "/r/b" }, previous: undefined, pending: false, failed: ["c"] });
	});

	it("runs the install checkout when the current release's build is missing", () => {
		expect(releaseToRun({ current: { sha: "x", dir: "/nope" }, failed: [] }, "/src").script).toBe("/src/dist/cli.js");
	});
});

/** A stand-in for the agent process; `exits` says how each start ends. */
function fakeAgents(exits: Array<number | "wait">) {
	const starts: Array<{ script: string; env: NodeJS.ProcessEnv }> = [];
	const spawnAgent = (script: string, _args: string[], env: NodeJS.ProcessEnv) => {
		starts.push({ script, env });
		const child = new EventEmitter() as ChildProcess;
		child.kill = (() => {
			setImmediate(() => child.emit("exit", 0, null));
			return true;
		}) as ChildProcess["kill"];
		const exit = exits.shift();
		if (exit !== "wait" && exit !== undefined) setTimeout(() => child.emit("exit", exit, null), 5);
		return child;
	};
	return { starts, spawnAgent };
}

function releaseDir(stateDir: string, sha: string) {
	const dir = join(stateDir, "releases", sha);
	mkdirSync(join(dir, "dist"), { recursive: true });
	writeFileSync(join(dir, "dist", "cli.js"), "");
	return dir;
}

describe("supervisor", () => {
	const base = () => {
		const root = mkdtempSync(join(tmpdir(), "cyralph-sup-"));
		return { stateDir: join(root, "state"), sourceDir: join(root, "src"), args: ["start"], log: silentLogger, sleep: async () => {} };
	};

	it("restarts into the new release when the agent exits to update", async () => {
		const o = base();
		const dir = releaseDir(o.stateDir, "b");
		const agents = fakeAgents([RESTART_EXIT_CODE, 0]);
		let n = 0;
		const code = await supervise({
			...o,
			confirmAfterMs: 0,
			spawnAgent: (script, args, env) => {
				// The first agent promotes release b before exiting with 75.
				if (n++ === 0) void saveReleaseState(o.stateDir, { current: { sha: "b", dir }, previous: { sha: "a" }, pending: false, failed: [] });
				return agents.spawnAgent(script, args, env);
			},
		});
		expect(code).toBe(0);
		expect(agents.starts.map((s) => s.script)).toEqual([join(o.sourceDir, "dist", "cli.js"), join(dir, "dist", "cli.js")]);
		expect(agents.starts[1]?.env.CYRALPH_RELEASE_SHA).toBe("b");
		expect(agents.starts[0]?.env.CYRALPH_SUPERVISED).toBe("1");
	});

	it("rolls back a new release that dies right after starting", async () => {
		const o = base();
		const dir = releaseDir(o.stateDir, "b");
		await saveReleaseState(o.stateDir, { current: { sha: "b", dir }, previous: { sha: "a" }, pending: true, failed: [] });
		const agents = fakeAgents([1, 2]);
		const code = await supervise({ ...o, confirmAfterMs: 60_000, spawnAgent: agents.spawnAgent });
		// b crashed → back to the checkout, which then also fails on start → give up with its code.
		expect(agents.starts.map((s) => s.env.CYRALPH_RELEASE_SHA)).toEqual(["b", ""]);
		expect(code).toBe(2);
		const state = await loadReleaseState(o.stateDir);
		expect(state.failed).toEqual(["b"]);
		expect(state.current).toBeUndefined();
	});

	it("passes SIGTERM to the agent and exits with it", async () => {
		const o = base();
		const agents = fakeAgents(["wait"]);
		const done = supervise({ ...o, spawnAgent: agents.spawnAgent });
		await new Promise((r) => setTimeout(r, 20));
		process.emit("SIGTERM");
		expect(await done).toBe(0);
		expect(existsSync(join(o.stateDir, "cyralph.pid"))).toBe(false);
	});
});

describe("supervisor restarts", () => {
	it("restarts an agent that crashes after running a while", async () => {
		const root = mkdtempSync(join(tmpdir(), "cyralph-sup-"));
		const agents = fakeAgents([1, 0]);
		const code = await supervise({ stateDir: join(root, "state"), sourceDir: root, args: ["start"], log: silentLogger, sleep: async () => {}, confirmAfterMs: 0, spawnAgent: agents.spawnAgent });
		expect(agents.starts).toHaveLength(2);
		expect(code).toBe(0);
	});
});
