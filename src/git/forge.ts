/**
 * Code-hosting "forges": where pull/merge requests live. GitHub uses the `gh` CLI, GitLab
 * (gitlab.com or self-hosted) uses `glab`. Like Cyrus, the CLI is chosen per repository.
 */
import { type CommandResult, run } from "./workspace.js";

export type ForgeKind = "github" | "gitlab";

export interface PullRequestInfo {
	url: string;
	number?: number;
}

export interface Forge {
	kind: ForgeKind;
	/** CLI binary, e.g. "gh". */
	cli: string;
	/** "pull request" / "merge request". */
	term: string;
	/** Problem that will stop PR/MR operations (CLI missing, not logged in), or undefined if ready. */
	preflight(cwd: string): Promise<string | undefined>;
	/** An open PR/MR for the branch, if any. Never creates one. */
	find(cwd: string, branch: string): Promise<PullRequestInfo | undefined>;
	/** Find or create a draft PR/MR. Throws with the CLI's error output if creation fails. */
	ensure(cwd: string, opts: { branch: string; baseBranch: string; title: string; body: string }): Promise<PullRequestInfo>;
	update(cwd: string, pr: PullRequestInfo, opts: { title?: string; body?: string; ready?: boolean }): Promise<void>;
	/** Instructions for an agent handling a "open a PR/MR" request. */
	agentInstructions(opts: { branch: string; baseBranch: string; titlePrefix: string }): string;
}

/** Host of a git remote URL: `git@host:g/p.git`, `ssh://git@host:2222/g/p.git`, `https://host/g/p.git`. */
export function remoteHost(remoteUrl: string): string | undefined {
	const url = remoteUrl.trim();
	const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)/.exec(url);
	if (scp && !/^[a-z+]+:\/\//i.test(url)) return scp[1]?.toLowerCase();
	try {
		return new URL(url).hostname.toLowerCase() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Pick the forge for a repository: an explicit `forge` setting wins; otherwise github.com is GitHub,
 * and gitlab.com, any configured `gitlabHosts`, or a host containing "gitlab" is GitLab.
 */
export function detectForgeKind(remoteUrl: string | undefined, opts: { forge?: ForgeKind; gitlabHosts?: string[] } = {}): ForgeKind {
	if (opts.forge) return opts.forge;
	const host = remoteUrl ? remoteHost(remoteUrl) : undefined;
	if (!host) return "github";
	const gitlabHosts = (opts.gitlabHosts ?? []).map((h) => remoteHost(h) ?? h.toLowerCase());
	if (host === "gitlab.com" || gitlabHosts.includes(host) || /(^|[.-])gitlab([.-]|$)/.test(host)) return "gitlab";
	return "github";
}

function missingOrUnauthenticated(r: CommandResult, cli: string, loginHint: string): string | undefined {
	if (r.code === 0) return undefined;
	const out = `${r.stderr}\n${r.stdout}`.trim();
	if (/ENOENT|not found|No such file/i.test(out) && !/auth|token|log/i.test(out)) {
		return `\`${cli}\` is not installed on the cyralph host.`;
	}
	return `\`${cli}\` is not logged in (${loginHint}).\n\n\`\`\`\n${out.slice(-600)}\n\`\`\``;
}

function lastUrl(text: string, pattern: RegExp): string | undefined {
	return [...text.matchAll(pattern)].map((m) => m[0]).pop();
}

/** How an agent should write a PR/MR it opens itself (the orchestrator's own PRs/MRs follow the same rules). */
function describeChange(titlePrefix: string): string {
	return `a title of the form "${titlePrefix}<summary of the change itself>" and a description of the deliverable written for reviewers who can't see Linear: what it does and why, notable changes, and any breaking changes or judgement calls. Don't list the user stories.`;
}

export class GitHubForge implements Forge {
	kind = "github" as const;
	cli = "gh";
	term = "pull request";

	async preflight(cwd: string): Promise<string | undefined> {
		return missingOrUnauthenticated(await run("gh", ["auth", "status"], cwd), "gh", "run `gh auth login`");
	}

	async find(cwd: string, branch: string): Promise<PullRequestInfo | undefined> {
		const r = await run("gh", ["pr", "view", branch, "--json", "url,number,state"], cwd);
		if (r.code !== 0) return undefined;
		const data = JSON.parse(r.stdout) as { url: string; number: number; state?: string };
		return data.state === "CLOSED" ? undefined : { url: data.url, number: data.number };
	}

	async ensure(cwd: string, opts: { branch: string; baseBranch: string; title: string; body: string }): Promise<PullRequestInfo> {
		const existing = await this.find(cwd, opts.branch);
		if (existing) return existing;
		const r = await run(
			"gh",
			["pr", "create", "--draft", "--base", opts.baseBranch, "--head", opts.branch, "--title", opts.title, "--body", opts.body],
			cwd,
		);
		const url = lastUrl(r.stdout, /https?:\/\/\S+\/pull\/\d+/g);
		if (r.code !== 0 || !url) throw new Error((r.stderr || r.stdout).trim() || "gh pr create failed");
		return { url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined };
	}

	async update(cwd: string, pr: PullRequestInfo, opts: { title?: string; body?: string; ready?: boolean }): Promise<void> {
		const edits = [...(opts.title !== undefined ? ["--title", opts.title] : []), ...(opts.body !== undefined ? ["--body", opts.body] : [])];
		if (edits.length) await run("gh", ["pr", "edit", pr.url, ...edits], cwd);
		if (opts.ready) await run("gh", ["pr", "ready", pr.url], cwd);
	}

	agentInstructions(o: { branch: string; baseBranch: string; titlePrefix: string }): string {
		return `For a pull request (GitHub, \`gh\`): check \`gh pr view ${o.branch}\` first; if none exists, \`gh pr create --base ${o.baseBranch} --head ${o.branch} --title "<title>"\` with ${describeChange(o.titlePrefix)} Use \`--draft\` unless all stories are complete.`;
	}
}

export class GitLabForge implements Forge {
	kind = "gitlab" as const;
	cli = "glab";
	term = "merge request";

	/** `host` pins the GitLab instance (sets GITLAB_HOST), for remotes behind SSH aliases or custom ports. */
	constructor(private readonly host?: string) {}

	private glab(args: string[], cwd: string) {
		return run("glab", args, cwd, undefined, this.host ? { GITLAB_HOST: this.host } : undefined);
	}

	async preflight(cwd: string): Promise<string | undefined> {
		const args = ["auth", "status", ...(this.host ? ["--hostname", remoteHost(this.host) ?? this.host] : [])];
		const hint = `run \`glab auth login${this.host ? ` --hostname ${remoteHost(this.host) ?? this.host}` : ""}\``;
		return missingOrUnauthenticated(await this.glab(args, cwd), "glab", hint);
	}

	async find(cwd: string, branch: string): Promise<PullRequestInfo | undefined> {
		const r = await this.glab(["mr", "view", branch, "--output", "json"], cwd);
		if (r.code !== 0) return undefined;
		try {
			const data = JSON.parse(r.stdout) as { web_url?: string; iid?: number; state?: string };
			if (!data.web_url || data.state === "closed") return undefined;
			return { url: data.web_url, number: data.iid };
		} catch {
			return undefined;
		}
	}

	async ensure(cwd: string, opts: { branch: string; baseBranch: string; title: string; body: string }): Promise<PullRequestInfo> {
		const existing = await this.find(cwd, opts.branch);
		if (existing) return existing;
		const r = await this.glab(
			[
				"mr",
				"create",
				"--draft",
				"--source-branch",
				opts.branch,
				"--target-branch",
				opts.baseBranch,
				"--title",
				opts.title,
				"--description",
				opts.body,
				"--yes",
			],
			cwd,
		);
		const url = lastUrl(`${r.stdout}\n${r.stderr}`, /https?:\/\/\S+\/-\/merge_requests\/\d+/g);
		if (r.code !== 0 || !url) throw new Error((r.stderr || r.stdout).trim() || "glab mr create failed");
		return { url, number: Number(/merge_requests\/(\d+)/.exec(url)?.[1]) || undefined };
	}

	async update(cwd: string, pr: PullRequestInfo, opts: { title?: string; body?: string; ready?: boolean }): Promise<void> {
		const ref = pr.number !== undefined ? String(pr.number) : pr.url;
		const edits = [...(opts.title !== undefined ? ["--title", opts.title] : []), ...(opts.body !== undefined ? ["--description", opts.body] : [])];
		if (edits.length) await this.glab(["mr", "update", ref, ...edits, "--yes"], cwd);
		if (opts.ready) await this.glab(["mr", "update", ref, "--ready", "--yes"], cwd);
	}

	agentInstructions(o: { branch: string; baseBranch: string; titlePrefix: string }): string {
		const env = this.host ? `GITLAB_HOST=${this.host} ` : "";
		return `For a merge request (GitLab, \`glab\`): check \`${env}glab mr view ${o.branch}\` first; if none exists, \`${env}glab mr create --source-branch ${o.branch} --target-branch ${o.baseBranch} --title "<title>" --description "<description>" --yes\`, with ${describeChange(o.titlePrefix)} Add \`--draft\` unless all stories are complete.`;
	}
}

export function createForge(kind: ForgeKind, opts: { gitlabHost?: string } = {}): Forge {
	return kind === "gitlab" ? new GitLabForge(opts.gitlabHost) : new GitHubForge();
}
