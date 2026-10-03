import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { SessionManager } from "../src/engine/session-manager.js";
import {
	type ReviewSubmitted,
	buildReviewRequest,
	classifyGitHubWebhook,
	githubRepoSlug,
	isReviewBot,
	parsePullRequestUrl,
	signGitHubBody,
	verifyGitHubWebhook,
} from "../src/github/reviews.js";
import { silentLogger } from "../src/logger.js";
import { createWebhookServer } from "../src/server.js";

const payload = {
	action: "submitted",
	repository: { full_name: "Acme/App" },
	pull_request: { number: 7, html_url: "https://github.com/Acme/App/pull/7", state: "open", head: { ref: "eng-1-x", sha: "abc" } },
	review: { id: 5, user: { login: "cubic-dev-ai[bot]" }, state: "COMMENTED", body: "1 issue", commit_id: "abc", html_url: "https://github.com/Acme/App/pull/7#pullrequestreview-5" },
};

describe("GitHub review webhooks", () => {
	it("verifies sha256 signatures", () => {
		const body = Buffer.from(JSON.stringify(payload));
		expect(verifyGitHubWebhook(body, signGitHubBody(body, "s"), "s").ok).toBe(true);
		expect(verifyGitHubWebhook(body, signGitHubBody(body, "x"), "s")).toEqual({ ok: false, reason: "invalid signature" });
		expect(verifyGitHubWebhook(body, undefined, "s")).toEqual({ ok: false, reason: "missing signature" });
	});

	it("only classifies submitted reviews, never comments", () => {
		const event = classifyGitHubWebhook("pull_request_review", payload);
		expect(event).toMatchObject({ kind: "review_submitted", repo: "acme/app", prNumber: 7, headRef: "eng-1-x", headSha: "abc", prOpen: true });
		expect(event.kind === "review_submitted" && event.review).toMatchObject({ id: 5, author: "cubic-dev-ai[bot]", state: "commented" });
		expect(classifyGitHubWebhook("pull_request_review", { ...payload, action: "edited" }).kind).toBe("ignored");
		expect(classifyGitHubWebhook("issue_comment", { action: "created" }).kind).toBe("ignored");
		expect(classifyGitHubWebhook("pull_request_review_comment", { action: "created" }).kind).toBe("ignored");
	});

	it("matches bots, repository slugs and PR URLs", () => {
		expect(isReviewBot("cubic-dev-ai[bot]", ["cubic-dev-ai[bot]"])).toBe(true);
		expect(isReviewBot("Cubic-Dev-AI[bot]", ["cubic-dev-ai"])).toBe(true);
		expect(isReviewBot("octocat", ["cubic-dev-ai[bot]"])).toBe(false);
		for (const url of ["https://github.com/Acme/App", "https://github.com/acme/app.git", "git@github.com:acme/app.git", "ssh://git@github.com/acme/app.git"]) {
			expect(githubRepoSlug(url)).toBe("acme/app");
		}
		expect(githubRepoSlug("/tmp/x/origin.git")).toBeUndefined();
		expect(parsePullRequestUrl("https://github.com/Acme/App/pull/7")).toEqual({ repo: "acme/app", number: 7 });
		expect(parsePullRequestUrl("https://git.example.com/a/b/-/merge_requests/7")).toBeUndefined();
	});

	it("builds a request listing the inline comments", () => {
		const text = buildReviewRequest({
			review: { id: 5, author: "cubic-dev-ai[bot]", state: "commented", body: "Summary here" },
			comments: [{ path: "src/a.ts", line: 3, body: "Null check" }, { path: "README.md", body: "Typo" }],
			prNumber: 7,
			prUrl: "https://github.com/acme/app/pull/7",
			branch: "eng-1-x",
		});
		expect(text).toContain("Summary here");
		expect(text).toContain("1. `src/a.ts:3`\nNull check");
		expect(text).toContain("2. `README.md`\nTypo");
		expect(text).toContain("Don't comment on, reply to, or resolve the review on GitHub.");
	});

	it("serves POST /github-webhook only when a secret is configured", async () => {
		const seen: ReviewSubmitted[] = [];
		const manager = { handleReview: async (e: ReviewSubmitted) => void seen.push(e) } as unknown as SessionManager;
		const body = JSON.stringify(payload);
		const post = async (secret: string | undefined, sig: string, event = "pull_request_review") => {
			const server = createWebhookServer({ webhookSecret: "lin", githubWebhookSecret: secret, manager, log: silentLogger });
			await new Promise<void>((r) => server.listen(0, r));
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/github-webhook`;
			const res = await fetch(url, { method: "POST", body, headers: { "x-hub-signature-256": sig, "x-github-event": event } });
			await new Promise((r) => setTimeout(r, 20));
			server.close();
			return res.status;
		};
		expect(await post(undefined, signGitHubBody(body, "gh"))).toBe(404);
		expect(await post("gh", signGitHubBody(body, "nope"))).toBe(401);
		expect(await post("gh", signGitHubBody(body, "gh"), "issue_comment")).toBe(200);
		expect(seen).toHaveLength(0);
		expect(await post("gh", signGitHubBody(body, "gh"))).toBe(200);
		expect(seen).toEqual([expect.objectContaining({ kind: "review_submitted", prNumber: 7 })]);
	});
});
