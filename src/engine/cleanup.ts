/**
 * Questions about a merged epic's leftovers, asked in its Linear session as select elicitations:
 * stash entries nobody applied, and a branch with commits the merge doesn't contain.
 */
import type { CleanupRequest } from "./store.js";

export const PUSH_STASHES = "Push to a branch on origin";
export const DROP_STASHES = "Drop";
export const PUSH_BRANCH = "Push to origin";
export const DELETE_BRANCH = "Delete";

/** Default for `unmergedBranchTimeoutMinutes`. */
export const UNMERGED_BRANCH_TIMEOUT_MINUTES = 60;

export function cleanupOptions(request: CleanupRequest): [string, string] {
	return request.kind === "stashes" ? [PUSH_STASHES, DROP_STASHES] : [PUSH_BRANCH, DELETE_BRANCH];
}

/** Branch on `origin` that keeps an epic's leftover stash entries. */
export function stashBranch(epicIdentifier: string): string {
	return `cyralph/stash/${epicIdentifier.toLowerCase()}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Match a reply to a pending cleanup question, like a repository selection: the option's value (what
 * Linear sends for a picked option), its 1-based number when only one question is open, or a short reply
 * with a word that only one open option has ("drop", "delete", "push"). Newer questions win. Undefined: not an answer.
 */
export function matchCleanupAnswer(reply: string, pending: readonly CleanupRequest[]): { request: CleanupRequest; option: string } | undefined {
	const text = norm(reply);
	if (!text) return undefined;
	const newestFirst = [...pending].reverse();
	for (const request of newestFirst) {
		const option = cleanupOptions(request).find((o) => norm(o) === text);
		if (option) return { request, option };
	}
	const only = pending.length === 1 ? pending[0] : undefined;
	if (only && /^[12]$/.test(text)) return { request: only, option: cleanupOptions(only)[Number(text) - 1] ?? "" };
	// A longer reply is guidance that happens to use one of these words, not an answer.
	const words = new Set(text.split(" "));
	if (words.size > 3) return undefined;
	const hits = newestFirst.flatMap((request) =>
		cleanupOptions(request)
			.filter((o) => words.has(norm(o).split(" ")[0] ?? ""))
			.map((option) => ({ request, option })),
	);
	return hits.length === 1 ? hits[0] : undefined;
}
