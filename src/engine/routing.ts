import type { RepositoryConfig } from "../config.js";
import type { IssueSummary } from "../linear/gateway.js";

const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());

/**
 * Pick the repository for an issue, Cyrus-style: an explicit `[repo=<id|name>]` tag in the
 * description wins, then routing labels, then project, then team key, then the first repository.
 */
export function selectRepository(repos: RepositoryConfig[], issue: IssueSummary): RepositoryConfig {
	const tag = /\[repo=([^\]\s]+)\]/i.exec(issue.description)?.[1]?.toLowerCase();
	const labels = lower(issue.labels);
	const match =
		(tag && repos.find((r) => r.id.toLowerCase() === tag || r.name.toLowerCase() === tag)) ||
		repos.find((r) => lower(r.routingLabels).some((l) => labels.includes(l))) ||
		(issue.projectName && repos.find((r) => lower(r.projectNames).includes(issue.projectName?.toLowerCase() ?? ""))) ||
		repos.find((r) => lower(r.teamKeys).includes(issue.teamKey.toLowerCase())) ||
		repos[0];
	if (!match) throw new Error("No repositories configured");
	return match;
}
