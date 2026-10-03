/**
 * CI pipelines of the pull/merge requests cyralph opened: GitHub Actions workflow runs (`gh api`) and
 * GitLab pipelines (`glab api`). Neither forge reliably reaches a self-hosted agent with webhooks for
 * this, so cyralph polls: once the pipeline of a PR/MR's head commit has finished and failed, the
 * failed jobs and the tails of their logs are handed to the epic's session to fix.
 */
import type { ForgeKind } from "./forge.js";
import { run } from "./workspace.js";

/** A pull request (GitHub) or merge request (GitLab), parsed from its web URL. */
export interface ChangeRequestRef {
	forge: ForgeKind;
	/** Web origin, e.g. "https://github.com" or "https://git.example.com:8443". */
	origin: string;
	/** "owner/name" on GitHub, the full project path ("group/sub/project") on GitLab. */
	project: string;
	number: number;
	url: string;
}

export interface CiFailedJob {
	/** Job id on the forge, used to read its log. */
	id: number;
	name: string;
	url?: string;
	/** Set when the job is the run itself (e.g. a GitHub workflow that failed to start). */
	noLog?: boolean;
}

export interface CiStatus {
	open: boolean;
	headSha: string;
	/** "none": no pipeline for the head commit (yet). "pending": still running or queued. */
	state: "none" | "pending" | "success" | "failed";
	pipelineUrl?: string;
	failedJobs: CiFailedJob[];
}

export interface CiClient {
	/** CI state of the PR/MR's current head commit; undefined when the PR/MR can't be read. */
	status(ref: ChangeRequestRef): Promise<CiStatus | undefined>;
	/** Log of a failed job (plain text, may be long). */
	jobLog(ref: ChangeRequestRef, job: CiFailedJob): Promise<string>;
}

/** GitHub `.../owner/name/pull/7` or GitLab `.../group/project/-/merge_requests/7`. */
export function parseChangeRequestUrl(url: string | undefined): ChangeRequestRef | undefined {
	if (!url) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const path = parsed.pathname.replace(/\/+$/, "");
	const gitlab = /^\/(.+?)\/-\/merge_requests\/(\d+)/.exec(path);
	if (gitlab?.[1] && gitlab[2]) return { forge: "gitlab", origin: parsed.origin, project: gitlab[1], number: Number(gitlab[2]), url };
	const github = /^\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(path);
	if (github?.[1] && github[2]) return { forge: "github", origin: parsed.origin, project: github[1].toLowerCase(), number: Number(github[2]), url };
	return undefined;
}

function obj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
function list(v: unknown, key?: string): Record<string, unknown>[] {
	const items = key ? obj(v)[key] : v;
	return (Array.isArray(items) ? items : []).map(obj);
}

const GITHUB_FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const GITLAB_PENDING = new Set(["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled"]);

/** Strip ANSI colours and GitLab's collapsible-section markers from a job log. */
export function cleanLog(text: string): string {
	return (
		text
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
			.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
			.replace(/section_(start|end):\d+:[^\r\n]*?\r/g, "")
			.replace(/\r\n?/g, "\n")
	);
}

/** `gh` for GitHub Actions, `glab` for GitLab CI; both must be logged in on the cyralph host, as they already are for opening PRs/MRs. */
export class CliCiClient implements CiClient {
	private async cli(ref: ChangeRequestRef, args: string[], json = true): Promise<unknown> {
		const isGitLab = ref.forge === "gitlab";
		const cmd = isGitLab ? "glab" : "gh";
		const host = new URL(ref.origin).host;
		// Point the CLI at the PR/MR's own host (GitHub Enterprise, self-hosted GitLab).
		const env: Record<string, string> | undefined = isGitLab ? { GITLAB_HOST: ref.origin } : host !== "github.com" ? { GH_HOST: host } : undefined;
		const r = await run(cmd, args, process.cwd(), 120_000, env);
		if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
		return json ? (JSON.parse(r.stdout) as unknown) : r.stdout;
	}

	async status(ref: ChangeRequestRef): Promise<CiStatus | undefined> {
		return ref.forge === "gitlab" ? this.gitlabStatus(ref) : this.githubStatus(ref);
	}

	async jobLog(ref: ChangeRequestRef, job: CiFailedJob): Promise<string> {
		if (job.noLog) return "";
		if (ref.forge === "gitlab") return cleanLog(String(await this.cli(ref, ["api", `projects/${encodeURIComponent(ref.project)}/jobs/${job.id}/trace`], false)));
		// Only the failed steps' output: much shorter than the whole job log.
		return cleanLog(String(await this.cli(ref, ["run", "view", "--job", String(job.id), "--log-failed", "-R", ref.project], false)));
	}

	private async githubStatus(ref: ChangeRequestRef): Promise<CiStatus | undefined> {
		const pr = obj(await this.cli(ref, ["api", `repos/${ref.project}/pulls/${ref.number}`]));
		const headSha = str(obj(pr.head).sha);
		if (!headSha) return undefined;
		const open = pr.state === "open";
		const runs = list(await this.cli(ref, ["api", `repos/${ref.project}/actions/runs?head_sha=${headSha}&per_page=100`]), "workflow_runs");
		// A workflow triggered again for the same commit (push and pull_request, a manual re-run) counts once: its newest run.
		const latest = new Map<string, Record<string, unknown>>();
		for (const r of runs) {
			const key = `${String(r.workflow_id ?? r.name)}:${String(r.event)}`;
			const seen = latest.get(key);
			if (!seen || Number(r.id) > Number(seen.id)) latest.set(key, r);
		}
		const current = [...latest.values()];
		const base = { open, headSha, failedJobs: [] as CiFailedJob[] };
		if (current.length === 0) return { ...base, state: "none" };
		if (current.some((r) => r.status !== "completed")) return { ...base, state: "pending" };
		const failed = current.filter((r) => GITHUB_FAILED.has(String(r.conclusion)));
		if (failed.length === 0) return { ...base, state: "success" };
		const failedJobs: CiFailedJob[] = [];
		for (const r of failed) {
			const runName = str(r.name) ?? "workflow";
			const jobs = list(await this.cli(ref, ["api", `repos/${ref.project}/actions/runs/${String(r.id)}/jobs?per_page=100`]), "jobs").filter((j) =>
				GITHUB_FAILED.has(String(j.conclusion)),
			);
			if (jobs.length === 0) failedJobs.push({ id: Number(r.id), name: runName, url: str(r.html_url), noLog: true });
			for (const j of jobs) failedJobs.push({ id: Number(j.id), name: `${runName} / ${str(j.name) ?? "job"}`, url: str(j.html_url) });
		}
		return { ...base, state: "failed", pipelineUrl: str(failed[0]?.html_url), failedJobs };
	}

	private async gitlabStatus(ref: ChangeRequestRef): Promise<CiStatus | undefined> {
		const project = encodeURIComponent(ref.project);
		const mr = obj(await this.cli(ref, ["api", `projects/${project}/merge_requests/${ref.number}`]));
		const headSha = str(mr.sha);
		if (!headSha) return undefined;
		const open = mr.state === "opened";
		const pipeline = obj(mr.head_pipeline);
		const base = { open, headSha, failedJobs: [] as CiFailedJob[], pipelineUrl: str(pipeline.web_url) };
		const status = str(pipeline.status);
		if (!status || (str(pipeline.sha) && pipeline.sha !== headSha)) return { ...base, state: "none" };
		if (GITLAB_PENDING.has(status)) return { ...base, state: "pending" };
		if (status === "success") return { ...base, state: "success" };
		// canceled, skipped, manual: nothing failed that cyralph should fix.
		if (status !== "failed") return { ...base, state: "none" };
		const jobs = list(await this.cli(ref, ["api", `projects/${project}/pipelines/${String(pipeline.id)}/jobs?scope[]=failed&per_page=100`]));
		const failedJobs: CiFailedJob[] = jobs
			.filter((j) => j.allow_failure !== true)
			.map((j) => ({ id: Number(j.id), name: `${str(j.stage) ? `${str(j.stage)} / ` : ""}${str(j.name) ?? "job"}`, url: str(j.web_url) }));
		// A failure only in a downstream (child) pipeline has no failed job here; point at the pipeline instead.
		if (failedJobs.length === 0) failedJobs.push({ id: Number(pipeline.id), name: "pipeline", url: base.pipelineUrl, noLog: true });
		return { ...base, state: "failed", failedJobs };
	}
}

const MAX_JOBS = 5;
const MAX_LOG = 4000;

/** The request handed to the agent for one failed pipeline. */
export function buildCiFailureRequest(args: {
	ref: ChangeRequestRef;
	headSha: string;
	branch: string;
	pipelineUrl?: string;
	jobs: Array<CiFailedJob & { log?: string }>;
}): string {
	const { ref, headSha, branch, pipelineUrl, jobs } = args;
	const what = ref.forge === "gitlab" ? `merge request !${ref.number}` : `pull request #${ref.number}`;
	const ci = ref.forge === "gitlab" ? "GitLab CI pipeline" : "GitHub Actions checks";
	const more =
		ref.forge === "gitlab"
			? `\`glab ci view\` / \`glab api projects/${encodeURIComponent(ref.project)}/jobs/<id>/trace\``
			: `\`gh run view --job <id> --log-failed -R ${ref.project}\``;
	const lines = [
		`The ${ci} for ${what} (${ref.url}) failed on \`${headSha.slice(0, 7)}\`${pipelineUrl ? ` (${pipelineUrl})` : ""}. Fix it on \`${branch}\`:`,
		`- Find the cause in the failed jobs below (${more} shows full logs) and reproduce it locally where you can.`,
		"- Fix the code, tests or CI configuration at fault. Don't skip, disable or weaken tests or checks just to make it pass.",
		"- If the failure has nothing to do with this branch (a flaky test, an infrastructure or network problem), don't change code for it; say so in your summary.",
		`- Run the quality gates, commit, and push \`${branch}\` so CI runs again.`,
		"",
		"Failed jobs:",
	];
	for (const job of jobs.slice(0, MAX_JOBS)) {
		lines.push("", `### ${job.name}${job.url ? ` (${job.url})` : ""}`);
		const log = job.log?.trim();
		if (log) lines.push("```", log.length > MAX_LOG ? `…${log.slice(-MAX_LOG)}` : log, "```");
		else lines.push("(no log available)");
	}
	if (jobs.length > MAX_JOBS) lines.push("", `(${jobs.length - MAX_JOBS} more failed jobs not shown.)`);
	return lines.join("\n").trim();
}
