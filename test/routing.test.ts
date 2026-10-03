import { describe, expect, it } from "vitest";
import { RepositoryConfigSchema, type RepositoryConfig } from "../src/config.js";
import { matchSelection, parseRepoTags, routeIssue, tagMatchesRepo } from "../src/engine/routing.js";
import type { IssueSummary } from "../src/linear/gateway.js";

const repo = (r: Partial<RepositoryConfig> & { id: string }): RepositoryConfig =>
	RepositoryConfigSchema.parse({ name: r.id, repositoryPath: `/code/${r.id}`, ...r });

const issue = (i: Partial<IssueSummary> = {}): IssueSummary => ({
	id: "i1",
	identifier: "ENG-1",
	title: "t",
	description: "",
	url: "",
	branchName: "b",
	teamId: "team",
	teamKey: "ENG",
	stateType: "unstarted",
	stateName: "Todo",
	labels: [],
	priority: 0,
	...i,
});

describe("parseRepoTags (Cyrus syntax)", () => {
	it("handles bracketed, escaped, unbracketed, multiple and #branch forms", () => {
		expect(parseRepoTags("Work in [repo=api]")).toEqual([{ repo: "api" }]);
		expect(parseRepoTags("Work in \\[repo=platform/api#release-2\\]")).toEqual([{ repo: "platform/api", branch: "release-2" }]);
		expect(parseRepoTags("repos=api,web#develop")).toEqual([
			{ repo: "api", branch: "develop" },
			{ repo: "web", branch: "develop" },
		]);
		expect(parseRepoTags("see https://x.dev/?repo=nope and [repo=api] [repo=API]")).toEqual([{ repo: "api" }]);
	});

	it("matches tags by id, name, last name segment, or repo URL", () => {
		const r = repo({ id: "svc", name: "platform/api", gitlabUrl: "https://git.example.com/platform/api" });
		for (const t of ["svc", "platform/api", "api", "https://git.example.com/platform/api.git"]) expect(tagMatchesRepo(t, r)).toBe(true);
		expect(tagMatchesRepo("web", r)).toBe(false);
	});
});

describe("routeIssue priorities", () => {
	const api = repo({ id: "api", routingLabels: ["backend"], teamKeys: ["ENG"] });
	const web = repo({ id: "web", routingLabels: ["frontend"], projectKeys: ["Website"] });
	const ops = repo({ id: "ops", teamKeys: ["OPS"] });

	it("description tag beats labels, and carries a base branch override", () => {
		const r = routeIssue([api, web], [issue({ description: "[repo=web#next]", labels: ["backend"] })]);
		expect(r).toMatchObject({ type: "selected", method: "description-tag", baseBranch: "next" });
		expect(r.type === "selected" && r.repo.id).toBe("web");
	});

	it("routing labels (case-insensitive) beat project and team", () => {
		const r = routeIssue([api, web], [issue({ labels: ["Frontend"], projectName: "Other" })]);
		expect(r.type === "selected" && [r.repo.id, r.method, r.detail]).toEqual(["web", "label", "Frontend"]);
	});

	it("routes by project (projectKeys or projectNames), then team, then identifier prefix", () => {
		expect(routeIssue([api, web], [issue({ projectName: "website" })])).toMatchObject({ type: "selected", method: "project" });
		expect(routeIssue([web, ops], [issue({ teamKey: "OPS" })])).toMatchObject({ type: "selected", method: "team" });
		const r = routeIssue([web, ops], [issue({ teamKey: "X", identifier: "OPS-9" })]);
		expect(r.type === "selected" && [r.repo.id, r.method]).toEqual(["ops", "team-prefix"]);
	});

	it("checks a delegated story's own labels/tags before its epic's", () => {
		const story = issue({ id: "s", labels: ["frontend"] });
		const epic = issue({ id: "e", labels: ["backend"] });
		const r = routeIssue([api, web], [story, epic]);
		expect(r.type === "selected" && r.repo.id).toBe("web");
	});

	it("uses a catch-all repo, the only repo, or asks", () => {
		const catchAll = repo({ id: "misc" });
		expect(routeIssue([web, catchAll], [issue({ teamKey: "X", identifier: "X-1" })])).toMatchObject({ method: "catch-all" });
		expect(routeIssue([web], [issue({ teamKey: "X", identifier: "X-1" })])).toMatchObject({ method: "only-repository" });
		const r = routeIssue([web, ops], [issue({ teamKey: "X", identifier: "X-1" })]);
		expect(r.type).toBe("needs_selection");
		expect(r.type === "needs_selection" && r.candidates.map((c) => c.id)).toEqual(["web", "ops"]);
	});

	it("skips inactive repositories", () => {
		const r = routeIssue([repo({ id: "old", routingLabels: ["backend"], isActive: false }), api], [issue({ labels: ["backend"] })]);
		expect(r.type === "selected" && r.repo.id).toBe("api");
	});
});

describe("matchSelection", () => {
	const a = repo({ id: "api", name: "platform/api", gitlabUrl: "https://git.example.com/platform/api" });
	const b = repo({ id: "web", name: "platform/web" });
	it("matches the option value, name, id, or number", () => {
		expect(matchSelection("https://git.example.com/platform/api", [a, b])).toBe(a);
		expect(matchSelection("platform/web", [a, b])).toBe(b);
		expect(matchSelection("web", [a, b])).toBe(b);
		expect(matchSelection("2", [a, b])).toBe(b);
		expect(matchSelection("the platform/api one please", [a, b])).toBe(a);
		expect(matchSelection("mobile", [a, b])).toBeUndefined();
	});
});
