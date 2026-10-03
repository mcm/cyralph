/**
 * Automated pull request reviews on GitHub (e.g. Cubic). Only *submitted reviews* are acted on
 * (`pull_request_review`), never plain PR or issue comments.
 *
 * Reviews arrive either as a signed GitHub webhook (`X-Hub-Signature-256`, one secret per cyralph
 * instance, routed to a repository by the payload's `repository.full_name`) or, when no secret is
 * configured, by polling the pull requests cyralph opened with `gh api`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { run } from "../git/workspace.js";

export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
export const GITHUB_EVENT_HEADER = "x-github-event";

export interface GitHubReview {
	id: number;
	/** Reviewer login, e.g. "cubic-dev-ai[bot]". */
	author: string;
	/** Lowercase: "commented", "changes_requested", "approved", ... */
	state: string;
	body: string;
	/** Commit the review was made on. */
	commitId?: string;
	url?: string;
	submittedAt?: string;
}

export interface ReviewComment {
	path: string;
	line?: number;
	body: string;
}

export interface PullRequestState {
	open: boolean;
	headRef: string;
	headSha: string;
	url: string;
}

/** A submitted review on a pull request, from the webhook or from polling. */
export interface ReviewSubmitted {
	kind: "review_submitted";
	/** "owner/name", lowercase. */
	repo: string;
	prNumber: number;
	prUrl: string;
	prOpen: boolean;
	headRef: string;
	headSha?: string;
	review: GitHubReview;
}

export type GitHubWebhookEvent = ReviewSubmitted | { kind: "ignored"; reason: string };

/** Reads reviews through the GitHub API (`gh api`, using the host's `gh auth login`). */
export interface GitHubReviewClient {
	pullRequest(repo: string, prNumber: number): Promise<PullRequestState | undefined>;
	reviews(repo: string, prNumber: number): Promise<GitHubReview[]>;
	reviewComments(repo: string, prNumber: number, reviewId: number): Promise<ReviewComment[]>;
}

export function signGitHubBody(rawBody: Buffer | string, secret: string): string {
	return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyGitHubWebhook(
	rawBody: Buffer,
	signature: string | undefined,
	secret: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
	if (!signature) return { ok: false, reason: "missing signature" };
	const expected = Buffer.from(signGitHubBody(rawBody, secret));
	const given = Buffer.from(signature);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid signature" };
	try {
		return { ok: true, payload: JSON.parse(rawBody.toString("utf8")) as Record<string, unknown> };
	} catch {
		return { ok: false, reason: "invalid JSON" };
	}
}

function obj(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function toReview(r: Record<string, unknown>): GitHubReview | undefined {
	const id = r.id;
	const author = str(obj(r.user).login);
	if (typeof id !== "number" || !author) return undefined;
	return {
		id,
		author,
		state: (str(r.state) ?? "").toLowerCase(),
		body: str(r.body) ?? "",
		commitId: str(r.commit_id),
		url: str(r.html_url),
		submittedAt: str(r.submitted_at),
	};
}

export function classifyGitHubWebhook(event: string | undefined, payload: Record<string, unknown>): GitHubWebhookEvent {
	if (event !== "pull_request_review") return { kind: "ignored", reason: `event ${String(event)}` };
	if (payload.action !== "submitted") return { kind: "ignored", reason: `review ${String(payload.action)}` };
	const pr = obj(payload.pull_request);
	const head = obj(pr.head);
	const repo = str(obj(payload.repository).full_name);
	const review = toReview(obj(payload.review));
	const prNumber = pr.number;
	const prUrl = str(pr.html_url);
	const headRef = str(head.ref);
	if (!repo || !review || typeof prNumber !== "number" || !prUrl || !headRef) return { kind: "ignored", reason: "incomplete review payload" };
	return {
		kind: "review_submitted",
		repo: repo.toLowerCase(),
		prNumber,
		prUrl,
		prOpen: pr.state === "open",
		headRef,
		headSha: str(head.sha),
		review,
	};
}

/** Whether a login is one of the configured review bots ("cubic-dev-ai" also matches "cubic-dev-ai[bot]"). */
export function isReviewBot(login: string, bots: string[]): boolean {
	const bare = (s: string) => s.trim().toLowerCase().replace(/\[bot\]$/, "");
	return bots.some((b) => bare(b) === bare(login));
}

/** "owner/name" from a GitHub web or git URL (https, ssh, scp-style), lowercase. */
export function githubRepoSlug(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const path = url
		.trim()
		.replace(/^[a-z+]+:\/\/[^/]+\//i, "")
		.replace(/^[^@/]+@[^:]+:/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const m = /^([^/\s]+)\/([^/\s]+)$/.exec(path);
	return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

/** Repository slug and number of a GitHub pull request URL. */
export function parsePullRequestUrl(url: string | undefined): { repo: string; number: number } | undefined {
	const m = url ? /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url) : null;
	return m?.[1] && m[2] ? { repo: m[1].toLowerCase(), number: Number(m[2]) } : undefined;
}

const MAX_SUMMARY = 3000;
const MAX_COMMENT = 1500;
const MAX_COMMENTS = 25;

function clip(text: string, n: number): string {
	const t = text.trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** The request handed to the agent for one review. */
export function buildReviewRequest(args: { review: GitHubReview; comments: ReviewComment[]; prNumber: number; prUrl: string; branch: string }): string {
	const { review, comments, prNumber, prUrl, branch } = args;
	const lines = [
		`${review.author} submitted an automated review of pull request #${prNumber} (${review.url ?? prUrl}). Work through its findings on \`${branch}\`:`,
		"- Fix each finding that is correct. Skip any that are wrong or not worth changing, and say why in your summary.",
		`- Run the quality gates, commit, and push \`${branch}\` so the pull request updates.`,
		"- Don't comment on, reply to, or resolve the review on GitHub.",
	];
	if (review.body.trim()) lines.push("", "Review summary:", clip(review.body, MAX_SUMMARY));
	if (comments.length) {
		lines.push("", "Inline comments:");
		comments.slice(0, MAX_COMMENTS).forEach((c, i) => {
			lines.push(`${i + 1}. \`${c.path}${c.line ? `:${c.line}` : ""}\``, clip(c.body, MAX_COMMENT), "");
		});
		if (comments.length > MAX_COMMENTS) lines.push(`(${comments.length - MAX_COMMENTS} more comments not shown; see the review on GitHub.)`);
	}
	return lines.join("\n").trim();
}

/** `gh api` client; `gh` must be logged in on the cyralph host, as it already is for opening PRs. */
export class GhReviewClient implements GitHubReviewClient {
	private async api(path: string): Promise<unknown> {
		const r = await run("gh", ["api", path], process.cwd(), 60_000);
		if (r.code !== 0) throw new Error(`gh api ${path} failed: ${(r.stderr || r.stdout).trim()}`);
		return JSON.parse(r.stdout) as unknown;
	}

	async pullRequest(repo: string, prNumber: number): Promise<PullRequestState | undefined> {
		const pr = obj(await this.api(`repos/${repo}/pulls/${prNumber}`));
		const head = obj(pr.head);
		const headRef = str(head.ref);
		const headSha = str(head.sha);
		const url = str(pr.html_url);
		if (!headRef || !headSha || !url) return undefined;
		return { open: pr.state === "open", headRef, headSha, url };
	}

	async reviews(repo: string, prNumber: number): Promise<GitHubReview[]> {
		const list = await this.api(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
		return (Array.isArray(list) ? list : []).map((r) => toReview(obj(r))).filter((r): r is GitHubReview => !!r);
	}

	async reviewComments(repo: string, prNumber: number, reviewId: number): Promise<ReviewComment[]> {
		const list = await this.api(`repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments?per_page=100`);
		return (Array.isArray(list) ? list : []).flatMap((c) => {
			const o = obj(c);
			const path = str(o.path);
			const line = typeof o.line === "number" ? o.line : typeof o.original_line === "number" ? o.original_line : undefined;
			return path ? [{ path, line, body: str(o.body) ?? "" }] : [];
		});
	}
}
