/**
 * Ralph task selection: pick the highest-priority open story whose dependencies are all done.
 * Mirrors ralph-tui's tracker semantics (in-progress first, then priority ascending).
 */
import type { Story } from "./types.js";

const DONE = new Set(["completed", "cancelled"]);

export function isStoryDone(story: Story): boolean {
	return DONE.has(story.status);
}

export function isStoryReady(story: Story, stories: Story[]): boolean {
	if (isStoryDone(story)) return false;
	const byKey = new Map(stories.map((s) => [s.key, s]));
	return story.dependsOn.every((dep) => {
		const s = byKey.get(dep);
		// Unknown/external blockers are resolved by the loader: anything left unresolved blocks.
		return s ? isStoryDone(s) : false;
	});
}

function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function sortStories(stories: Story[]): Story[] {
	return [...stories].sort(
		(a, b) =>
			Number(b.status === "in_progress") - Number(a.status === "in_progress") ||
			a.priority - b.priority ||
			naturalCompare(a.storyId, b.storyId),
	);
}

export function selectNextStory(stories: Story[], exclude: ReadonlySet<string> = new Set()): Story | undefined {
	return sortStories(stories).find((s) => !exclude.has(s.key) && isStoryReady(s, stories));
}

export function isEpicComplete(stories: Story[]): boolean {
	return stories.every(isStoryDone);
}

/** Open stories that can never become ready given the excluded (exhausted) set. */
export function blockedStories(stories: Story[], exclude: ReadonlySet<string>): Story[] {
	const byKey = new Map(stories.map((s) => [s.key, s]));
	const memo = new Map<string, boolean>();
	const reachable = (s: Story, seen: Set<string>): boolean => {
		if (isStoryDone(s)) return true;
		if (exclude.has(s.key) || seen.has(s.key)) return false;
		const cached = memo.get(s.key);
		if (cached !== undefined) return cached;
		seen.add(s.key);
		const ok = s.dependsOn.every((d) => {
			const dep = byKey.get(d);
			return dep ? reachable(dep, seen) : false;
		});
		seen.delete(s.key);
		memo.set(s.key, ok);
		return ok;
	};
	return stories.filter((s) => !isStoryDone(s) && !exclude.has(s.key) && !reachable(s, new Set()));
}
