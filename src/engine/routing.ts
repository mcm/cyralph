/**
 * Repository routing, following Cyrus' RepositoryRouter priorities:
 *
 *   1. description tag   `[repo=name]`, `[repo=name#branch]`, `repo=a,b#branch` (Linear may escape `\[`)
 *   2. routing labels    any of the issue's labels in `routingLabels`
 *   3. project           the issue's project name in `projectKeys`
 *   4. team              the issue's team key in `teamKeys` (then the identifier prefix, e.g. ENG-12 -> ENG)
 *   5. catch-all         a repository with no routing configuration at all
 *   otherwise            ask in Linear which repository to use (or the only configured repository)
 *
 * The delegated issue is consulted first, then its epic (for a story delegated on its own). Each story
 * of an epic is then routed on its own signals (`routeStory`), so one epic can span repositories.
 */
import type { RepositoryConfig } from "../config.js";
import type { IssueSummary } from "../linear/gateway.js";

export type RoutingMethod = "description-tag" | "label" | "project" | "team" | "team-prefix" | "catch-all" | "only-repository";

export type RoutingResult =
	| { type: "selected"; repo: RepositoryConfig; method: RoutingMethod; detail?: string; baseBranch?: string }
	| { type: "needs_selection"; candidates: RepositoryConfig[] };

export interface RepoTag {
	repo: string;
	branch?: string;
}

/** `[repo=x]`, `\[repo=x#branch\]`, `repo=a,b#branch`, `repos=a,b` (deduplicated, first wins). */
export function parseRepoTags(description: string | undefined): RepoTag[] {
	if (!description) return [];
	const values: string[] = [];
	for (const m of description.matchAll(/\\?\[repos?=([a-zA-Z0-9_\-/.#,]+)\\?\]/g)) if (m[1]) values.push(m[1]);
	for (const m of description.matchAll(/(?:^|\s)repos?=([a-zA-Z0-9_\-/.#,]+)/gm)) if (m[1]) values.push(m[1]);
	const tags: RepoTag[] = [];
	for (const value of values) {
		const hash = value.indexOf("#");
		const branch = hash >= 0 ? value.slice(hash + 1) || undefined : undefined;
		for (const repo of (hash >= 0 ? value.slice(0, hash) : value).split(",").map((r) => r.trim()).filter(Boolean)) {
			if (!tags.some((t) => t.repo.toLowerCase() === repo.toLowerCase())) tags.push(branch ? { repo, branch } : { repo });
		}
	}
	return tags;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");

/** A tag names a repo by id, name, the last path segment of its name, or its GitHub/GitLab URL. */
export function tagMatchesRepo(tag: string, repo: RepositoryConfig): boolean {
	const t = norm(tag);
	const names = [repo.id, repo.name, repo.name.split("/").pop() ?? ""].map(norm);
	if (names.includes(t)) return true;
	return [repo.githubUrl, repo.gitlabUrl].some((u) => u && (norm(u) === t || norm(u).endsWith(`/${t}`)));
}

function hasRoutingConfig(r: RepositoryConfig): boolean {
	return Boolean(r.teamKeys?.length || r.routingLabels?.length || r.projectKeys?.length || r.projectNames?.length);
}

export function routeIssue(repos: RepositoryConfig[], issues: IssueSummary[]): RoutingResult {
	const active = repos.filter((r) => r.isActive !== false);
	const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());

	// 1. Description tags
	for (const issue of issues) {
		for (const tag of parseRepoTags(issue.description)) {
			const repo = active.find((r) => tagMatchesRepo(tag.repo, r));
			if (repo) return { type: "selected", repo, method: "description-tag", detail: `[repo=${tag.repo}]`, baseBranch: tag.branch };
		}
	}
	// 2. Routing labels (the delegated issue's own labels before its epic's)
	for (const issue of issues) {
		const lowerLabels = lower(issue.labels);
		for (const repo of active) {
			const hit = lower(repo.routingLabels).find((l) => lowerLabels.includes(l));
			if (hit) return { type: "selected", repo, method: "label", detail: issue.labels[lowerLabels.indexOf(hit)] };
		}
	}
	// 3. Project
	for (const issue of issues) {
		const project = issue.projectName?.toLowerCase();
		if (!project) continue;
		const repo = active.find((r) => [...lower(r.projectKeys), ...lower(r.projectNames)].includes(project));
		if (repo) return { type: "selected", repo, method: "project", detail: issue.projectName };
	}
	// 4. Team key, then identifier prefix
	for (const issue of issues) {
		const repo = issue.teamKey && active.find((r) => lower(r.teamKeys).includes(issue.teamKey.toLowerCase()));
		if (repo) return { type: "selected", repo, method: "team", detail: issue.teamKey };
	}
	for (const issue of issues) {
		const prefix = issue.identifier.split("-")[0]?.toLowerCase();
		const repo = prefix && active.find((r) => lower(r.teamKeys).includes(prefix));
		if (repo) return { type: "selected", repo, method: "team-prefix", detail: prefix.toUpperCase() };
	}
	// 5. Catch-all
	const catchAll = active.find((r) => !hasRoutingConfig(r));
	if (catchAll) return { type: "selected", repo: catchAll, method: "catch-all" };
	if (active.length === 1 && active[0]) return { type: "selected", repo: active[0], method: "only-repository" };
	return { type: "needs_selection", candidates: active };
}

export function describeRouting(r: Extract<RoutingResult, { type: "selected" }>): string {
	switch (r.method) {
		case "description-tag":
			return `description tag \`${r.detail}\``;
		case "label":
			return `label \`${r.detail}\``;
		case "project":
			return `project ${r.detail}`;
		case "team":
		case "team-prefix":
			return `team ${r.detail}`;
		case "catch-all":
			return "catch-all repository";
		case "only-repository":
			return "only configured repository";
	}
}

/** What a repository is called in the selection elicitation (and how a reply is matched back). */
export function selectionValue(repo: RepositoryConfig): string {
	return repo.githubUrl || repo.gitlabUrl || repo.name;
}

/** Match a reply to a repository selection: the option value, id, name, or 1-based number. */
export function matchSelection(reply: string, candidates: RepositoryConfig[]): RepositoryConfig | undefined {
	const text = reply.trim();
	const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (n >= 1 && n <= candidates.length) return candidates[n - 1];
	return (
		candidates.find((r) => norm(selectionValue(r)) === norm(text)) ??
		candidates.find((r) => tagMatchesRepo(text, r)) ??
		candidates.find((r) => norm(text).includes(norm(r.name)))
	);
}

/** Back-compat helper: route and fall back to the first repository. */
export function selectRepository(repos: RepositoryConfig[], issue: IssueSummary): RepositoryConfig {
	const r = routeIssue(repos, [issue]);
	const repo = r.type === "selected" ? r.repo : repos[0];
	if (!repo) throw new Error("No repositories configured");
	return repo;
}

/** Where one story of an epic goes, judged by the routing signals it doesn't share with the epic. */
export type StoryRoute =
	| { type: "epic" }
	| { type: "selected"; repo: RepositoryConfig; method: RoutingMethod; detail?: string }
	| { type: "unroutable"; reason: string };

/**
 * Route a story of an epic. Only the story's own signals count, in the usual order: a repo tag, a
 * routing label, a project other than the epic's, a team other than the epic's. A story without any
 * stays in the epic's repository. A repo tag or a different project that no repository here matches
 * means the story belongs to a repository this cyralph doesn't have (teams and labels often span
 * repositories, so they never make a story unroutable).
 */
export function routeStory(
	repos: RepositoryConfig[],
	story: { description?: string; labels?: string[]; projectName?: string; teamKey?: string },
	epic: { projectName?: string; teamKey?: string },
): StoryRoute {
	const active = repos.filter((r) => r.isActive !== false);
	const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());

	const tags = parseRepoTags(story.description);
	for (const tag of tags) {
		const repo = active.find((r) => tagMatchesRepo(tag.repo, r));
		if (repo) return { type: "selected", repo, method: "description-tag", detail: `[repo=${tag.repo}]` };
	}
	if (tags.length) return { type: "unroutable", reason: `its \`[repo=${tags.map((t) => t.repo).join(",")}]\` tag names no repository here` };

	const labels = lower(story.labels);
	for (const repo of active) {
		const hit = lower(repo.routingLabels).find((l) => labels.includes(l));
		if (hit) return { type: "selected", repo, method: "label", detail: story.labels?.[labels.indexOf(hit)] };
	}

	const project = story.projectName;
	if (project && project.toLowerCase() !== epic.projectName?.toLowerCase()) {
		const repo = active.find((r) => [...lower(r.projectKeys), ...lower(r.projectNames)].includes(project.toLowerCase()));
		if (repo) return { type: "selected", repo, method: "project", detail: project };
		return { type: "unroutable", reason: `it's in project ${project}, which no repository here is set up for` };
	}

	const team = story.teamKey;
	if (team && team.toLowerCase() !== epic.teamKey?.toLowerCase()) {
		const repo = active.find((r) => lower(r.teamKeys).includes(team.toLowerCase()));
		if (repo) return { type: "selected", repo, method: "team", detail: team };
	}
	return { type: "epic" };
}
