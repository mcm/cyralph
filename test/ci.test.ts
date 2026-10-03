import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliCiClient, buildCiFailureRequest, cleanLog, parseChangeRequestUrl } from "../src/git/ci.js";

describe("CI change request URLs", () => {
	it("parses GitHub pull requests and GitLab merge requests (nested groups, custom ports)", () => {
		expect(parseChangeRequestUrl("https://github.com/Acme/App/pull/7")).toEqual({
			forge: "github",
			origin: "https://github.com",
			project: "acme/app",
			number: 7,
			url: "https://github.com/Acme/App/pull/7",
		});
		expect(parseChangeRequestUrl("https://git.example.com:8443/platform/team/api/-/merge_requests/12")).toMatchObject({
			forge: "gitlab",
			origin: "https://git.example.com:8443",
			project: "platform/team/api",
			number: 12,
		});
		expect(parseChangeRequestUrl("https://github.com/acme/app/issues/7")).toBeUndefined();
		expect(parseChangeRequestUrl("not a url")).toBeUndefined();
		expect(parseChangeRequestUrl(undefined)).toBeUndefined();
	});

	it("strips ANSI colours and GitLab section markers from logs", () => {
		expect(cleanLog("section_start:1700000000:step_script\r\u001b[0K\u001b[31mFAIL\u001b[0m test/a.test.ts\r\n")).toBe("FAIL test/a.test.ts\n");
	});
});

describe("CI failure request", () => {
	it("lists failed jobs with the tail of their logs and how to ship the fix", () => {
		const ref = parseChangeRequestUrl("https://github.com/acme/app/pull/7");
		if (!ref) throw new Error("unparsed");
		const text = buildCiFailureRequest({
			ref,
			headSha: "abcdef1234567",
			branch: "eng-1-x",
			pipelineUrl: "https://github.com/acme/app/actions/runs/1",
			jobs: [
				{ id: 1, name: "CI / test", url: "https://github.com/acme/app/actions/runs/1/job/1", log: `${"x".repeat(5000)}\nExpected 2, got 3` },
				{ id: 2, name: "CI / build", noLog: true },
			],
		});
		expect(text).toContain("The GitHub Actions checks for pull request #7 (https://github.com/acme/app/pull/7) failed on `abcdef1`");
		expect(text).toContain("push `eng-1-x`");
		expect(text).toContain("Don't skip, disable or weaken tests");
		expect(text).toContain("### CI / test (https://github.com/acme/app/actions/runs/1/job/1)");
		expect(text).toContain("Expected 2, got 3");
		expect(text).not.toContain("x".repeat(4500));
		expect(text).toContain("### CI / build\n(no log available)");
		expect(text).toContain("gh run view --job <id> --log-failed -R acme/app");
	});

	it("speaks GitLab for merge requests", () => {
		const ref = parseChangeRequestUrl("https://gitlab.com/g/p/-/merge_requests/3");
		if (!ref) throw new Error("unparsed");
		const text = buildCiFailureRequest({ ref, headSha: "1234567890", branch: "b", jobs: [{ id: 9, name: "test / unit", log: "boom" }] });
		expect(text).toContain("The GitLab CI pipeline for merge request !3");
		expect(text).toContain("jobs/<id>/trace");
	});
});

/** Fake `gh` and `glab` on PATH, answering from JSON fixtures keyed by their arguments. */
describe("CliCiClient", () => {
	const dir = mkdtempSync(join(tmpdir(), "cyralph-ci-"));
	const path = process.env.PATH;
	const fixtures: Record<string, unknown> = {};
	const write = () => writeFileSync(join(dir, "fixtures.json"), JSON.stringify(fixtures));

	beforeAll(() => {
		for (const cli of ["gh", "glab"]) {
			const script = `#!/usr/bin/env node
const f = require(${JSON.stringify(join(dir, "fixtures.json"))});
const key = ${JSON.stringify(cli)} + " " + process.argv.slice(2).join(" ") + (process.env.GITLAB_HOST ? " @" + process.env.GITLAB_HOST : "");
if (!(key in f)) { process.stderr.write("no fixture: " + key); process.exit(1); }
const v = f[key];
process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
`;
			writeFileSync(join(dir, cli), script);
			chmodSync(join(dir, cli), 0o755);
		}
		process.env.PATH = `${dir}:${path}`;
	});
	afterAll(() => {
		process.env.PATH = path;
	});

	it("reports GitHub Actions failures of the head commit, newest run per workflow", async () => {
		const ref = parseChangeRequestUrl("https://github.com/acme/app/pull/7");
		if (!ref) throw new Error("unparsed");
		fixtures["gh api repos/acme/app/pulls/7"] = { state: "open", head: { sha: "head1", ref: "b" } };
		fixtures["gh api repos/acme/app/actions/runs?head_sha=head1&per_page=100"] = {
			workflow_runs: [
				{ id: 1, workflow_id: 10, event: "pull_request", name: "CI", status: "completed", conclusion: "success" },
				{ id: 2, workflow_id: 10, event: "pull_request", name: "CI", status: "completed", conclusion: "failure", html_url: "https://gh/run/2" },
				{ id: 3, workflow_id: 11, event: "pull_request", name: "Lint", status: "completed", conclusion: "success" },
			],
		};
		fixtures["gh api repos/acme/app/actions/runs/2/jobs?per_page=100"] = {
			jobs: [
				{ id: 20, name: "test", conclusion: "failure", html_url: "https://gh/job/20" },
				{ id: 21, name: "build", conclusion: "success" },
			],
		};
		fixtures["gh run view --job 20 --log-failed -R acme/app"] = "test\tRun tests\t\u001b[31mFAIL\u001b[0m a.test.ts\n";
		write();
		const ci = new CliCiClient();
		const status = await ci.status(ref);
		expect(status).toEqual({
			open: true,
			headSha: "head1",
			state: "failed",
			pipelineUrl: "https://gh/run/2",
			failedJobs: [{ id: 20, name: "CI / test", url: "https://gh/job/20" }],
		});
		expect(await ci.jobLog(ref, status?.failedJobs[0] ?? { id: 0, name: "" })).toBe("test\tRun tests\tFAIL a.test.ts\n");

		// A newer run of the workflow is still going: wait for it.
		fixtures["gh api repos/acme/app/actions/runs?head_sha=head1&per_page=100"] = {
			workflow_runs: [
				{ id: 2, workflow_id: 10, event: "pull_request", status: "completed", conclusion: "failure" },
				{ id: 4, workflow_id: 10, event: "pull_request", status: "in_progress", conclusion: null },
			],
		};
		write();
		expect((await ci.status(ref))?.state).toBe("pending");
		fixtures["gh api repos/acme/app/actions/runs?head_sha=head1&per_page=100"] = { workflow_runs: [] };
		write();
		expect((await ci.status(ref))?.state).toBe("none");
	});

	it("reports GitLab pipeline failures, ignoring jobs allowed to fail", async () => {
		const ref = parseChangeRequestUrl("https://git.example.com/platform/api/-/merge_requests/12");
		if (!ref) throw new Error("unparsed");
		const host = " @https://git.example.com";
		fixtures[`glab api projects/platform%2Fapi/merge_requests/12${host}`] = {
			state: "opened",
			sha: "s1",
			head_pipeline: { id: 99, sha: "s1", status: "failed", web_url: "https://git.example.com/platform/api/-/pipelines/99" },
		};
		fixtures[`glab api projects/platform%2Fapi/pipelines/99/jobs?scope[]=failed&per_page=100${host}`] = [
			{ id: 5, name: "unit", stage: "test", web_url: "https://git.example.com/j/5", allow_failure: false },
			{ id: 6, name: "audit", stage: "test", allow_failure: true },
		];
		fixtures[`glab api projects/platform%2Fapi/jobs/5/trace${host}`] = "section_start:1:script\r\u001b[0Kboom\n";
		write();
		const ci = new CliCiClient();
		const status = await ci.status(ref);
		expect(status).toMatchObject({ open: true, headSha: "s1", state: "failed", failedJobs: [{ id: 5, name: "test / unit", url: "https://git.example.com/j/5" }] });
		expect(await ci.jobLog(ref, { id: 5, name: "test / unit" })).toBe("boom\n");

		fixtures[`glab api projects/platform%2Fapi/merge_requests/12${host}`] = { state: "merged", sha: "s1", head_pipeline: { id: 99, sha: "s1", status: "running" } };
		write();
		expect(await ci.status(ref)).toMatchObject({ open: false, state: "pending" });
	});
});
