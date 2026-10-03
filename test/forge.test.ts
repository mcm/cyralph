import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubForge, GitLabForge, detectForgeKind, remoteHost } from "../src/git/forge.js";

describe("forge detection", () => {
	it("parses hosts from scp, ssh and https remotes", () => {
		expect(remoteHost("git@git.example.com:group/app.git")).toBe("git.example.com");
		expect(remoteHost("ssh://git@git.example.com:2222/group/app.git")).toBe("git.example.com");
		expect(remoteHost("https://gitlab.com/group/sub/app.git")).toBe("gitlab.com");
		expect(remoteHost("https://GitHub.com/a/b")).toBe("github.com");
	});

	it("detects GitHub, GitLab, configured self-hosted GitLab, and honours overrides", () => {
		expect(detectForgeKind("git@github.com:a/b.git")).toBe("github");
		expect(detectForgeKind("git@gitlab.com:a/b.git")).toBe("gitlab");
		expect(detectForgeKind("https://gitlab.corp.example.com/a/b.git")).toBe("gitlab");
		expect(detectForgeKind("git@code.example.com:a/b.git")).toBe("github");
		expect(detectForgeKind("git@code.example.com:a/b.git", { gitlabHosts: ["code.example.com"] })).toBe("gitlab");
		expect(detectForgeKind("git@code.example.com:a/b.git", { gitlabHosts: ["https://code.example.com"] })).toBe("gitlab");
		expect(detectForgeKind("git@gitlab.com:a/b.git", { forge: "github" })).toBe("github");
		expect(detectForgeKind("git@github.example.org:a/b.git")).toBe("github");
		expect(detectForgeKind("git@mygitlabserver.example:a/b.git")).toBe("github"); // only whole-word "gitlab"
	});
});

/** Puts a fake CLI on PATH that logs its args (and GITLAB_HOST) and replies per subcommand. */
function fakeCli(name: string, script: string) {
	const dir = mkdtempSync(join(tmpdir(), "cyralph-cli-"));
	const log = join(dir, "calls.log");
	writeFileSync(
		join(dir, name),
		`#!/usr/bin/env bash\necho "GITLAB_HOST=$GITLAB_HOST $*" >> "${log}"\n${script}\n`,
	);
	chmodSync(join(dir, name), 0o755);
	return { dir, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

describe("GitLabForge (glab)", () => {
	const originalPath = process.env.PATH;
	afterEach(() => {
		process.env.PATH = originalPath;
	});

	it("finds, creates (draft), updates and readies merge requests", async () => {
		const cli = fakeCli(
			"glab",
			`case "$1 $2" in
  "mr view") if [ -f "$(dirname "$0")/created" ]; then echo '{"web_url":"https://git.example.com/acme/app/-/merge_requests/12","iid":12,"state":"opened"}'; else echo "no open merge request" >&2; exit 1; fi ;;
  "mr create") touch "$(dirname "$0")/created"; echo "Creating draft merge request for b into main in acme/app"; echo "https://git.example.com/acme/app/-/merge_requests/12" ;;
  "auth status") echo "Logged in to git.example.com" ;;
  *) ;;
esac`,
		);
		process.env.PATH = `${cli.dir}:${originalPath}`;
		const forge = new GitLabForge("https://git.example.com");
		const cwd = cli.dir;
		expect(await forge.preflight(cwd)).toBeUndefined();
		expect(await forge.find(cwd, "b")).toBeUndefined();
		const mr = await forge.ensure(cwd, { branch: "b", baseBranch: "main", title: "ENG-1: T", body: "body" });
		expect(mr).toEqual({ url: "https://git.example.com/acme/app/-/merge_requests/12", number: 12 });
		// Second ensure finds the existing MR instead of creating another.
		expect(await forge.ensure(cwd, { branch: "b", baseBranch: "main", title: "ENG-1: T", body: "body" })).toEqual(mr);
		await forge.update(cwd, mr, { body: "new body", ready: true });
		await forge.update(cwd, mr, { title: "ENG-1: Better", body: "described" });

		const calls = cli.calls();
		expect(calls.every((c) => c.startsWith("GITLAB_HOST=https://git.example.com "))).toBe(true);
		expect(calls).toContain("GITLAB_HOST=https://git.example.com auth status --hostname git.example.com");
		expect(calls.filter((c) => c.includes("mr create"))).toEqual([
			"GITLAB_HOST=https://git.example.com mr create --draft --source-branch b --target-branch main --title ENG-1: T --description body --yes",
		]);
		expect(calls).toContain("GITLAB_HOST=https://git.example.com mr update 12 --description new body --yes");
		expect(calls).toContain("GITLAB_HOST=https://git.example.com mr update 12 --ready --yes");
		expect(calls).toContain("GITLAB_HOST=https://git.example.com mr update 12 --title ENG-1: Better --description described --yes");
	});

	it("reports a failed create with glab's error output", async () => {
		const cli = fakeCli("glab", `[ "$1 $2" = "mr create" ] && { echo "ERROR: 403 Forbidden" >&2; exit 1; }; exit 1`);
		process.env.PATH = `${cli.dir}:${originalPath}`;
		await expect(new GitLabForge().ensure(cli.dir, { branch: "b", baseBranch: "main", title: "t", body: "b" })).rejects.toThrow("403 Forbidden");
	});

	it("explains a missing or logged-out CLI", async () => {
		process.env.PATH = mkdtempSync(join(tmpdir(), "cyralph-empty-"));
		expect(await new GitLabForge().preflight(process.cwd())).toBe("`glab` is not installed on the cyralph host.");
		const cli = fakeCli("glab", `echo "git.example.com: no token found" >&2; exit 1`);
		process.env.PATH = `${cli.dir}:${originalPath}`;
		expect(await new GitLabForge("git.example.com").preflight(cli.dir)).toContain("run `glab auth login --hostname git.example.com`");
	});
});

describe("GitHubForge (gh)", () => {
	const originalPath = process.env.PATH;
	beforeEach(() => {
		process.env.PATH = originalPath;
	});
	afterEach(() => {
		process.env.PATH = originalPath;
	});

	it("creates a draft PR and parses its URL", async () => {
		const cli = fakeCli(
			"gh",
			`case "$1 $2" in
  "pr view") exit 1 ;;
  "pr create") echo "https://github.com/acme/app/pull/9" ;;
esac`,
		);
		process.env.PATH = `${cli.dir}:${originalPath}`;
		const pr = await new GitHubForge().ensure(cli.dir, { branch: "b", baseBranch: "main", title: "t", body: "x" });
		expect(pr).toEqual({ url: "https://github.com/acme/app/pull/9", number: 9 });
		expect(cli.calls().at(-1)).toBe("GITLAB_HOST= pr create --draft --base main --head b --title t --body x");
		await new GitHubForge().update(cli.dir, pr, { title: "ENG-1: Better", body: "described", ready: true });
		expect(cli.calls().slice(-2)).toEqual(["GITLAB_HOST= pr edit https://github.com/acme/app/pull/9 --title ENG-1: Better --body described", "GITLAB_HOST= pr ready https://github.com/acme/app/pull/9"]);
	});
});
