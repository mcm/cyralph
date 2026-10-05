/**
 * Preparation of manual stories: the exact commands of a manual story's ```cyralph-prepare blocks,
 * run in the epic worktree only after a person says "Run it" in the epic's session.
 */
import { createHash } from "node:crypto";
import { isStoryDone, sortStories } from "../ralph/selection.js";
import type { Epic, Story } from "../ralph/types.js";
import type { PreparationRequest, SessionRecord } from "./store.js";

export const PREPARATION_RUN = "Run it";
export const PREPARATION_MYSELF = "I'll do it myself";
export const PREPARATION_LATER = "Not yet";
export const PREPARATION_OPTIONS = [PREPARATION_RUN, PREPARATION_MYSELF, PREPARATION_LATER];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Match a reply to the pending preparation question: an option's value (what Linear sends for a picked
 * option) or its 1-based number. Anything else isn't an answer.
 */
export function matchPreparationAnswer(reply: string): string | undefined {
	const text = norm(reply);
	if (/^[123]$/.test(text)) return PREPARATION_OPTIONS[Number(text) - 1];
	return PREPARATION_OPTIONS.find((o) => norm(o) === text);
}

/** A reply asking to offer a manual story's preparation again, even after it ran or was declined. */
export function isRerunPreparationRequest(reply: string): boolean {
	return norm(reply) === "rerun preparation";
}

/** Hash of a story's parsed commands, so an approval is bound to the commands that were shown. */
export function preparationHash(commands: string[]): string {
	return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
}

/**
 * Manual stories whose preparation can be offered now, in story order: open, with commands, every
 * blocker done, and not answered yet in this session.
 */
export function eligiblePreparations(epic: Epic, record: Pick<SessionRecord, "preparationHandled">): Story[] {
	const byKey = new Map(epic.stories.map((s) => [s.key, s]));
	const handled = new Set(record.preparationHandled ?? []);
	return sortStories(epic.stories).filter(
		(s) =>
			s.manual &&
			!s.elsewhere &&
			(s.preparation?.length ?? 0) > 0 &&
			!isStoryDone(s) &&
			!handled.has(s.key) &&
			s.dependsOn.every((d) => {
				const dep = byKey.get(d);
				// External blockers stay in `dependsOn` only while they are open.
				return dep ? isStoryDone(dep) : false;
			}),
	);
}

/** `text` in a Markdown code block that no backtick run inside it can close. */
export function fenced(text: string, info = ""): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${info}\n${text}\n${fence}`;
}

/** The body of the approval picker. */
export function preparationQuestion(story: Story, request: Pick<PreparationRequest, "branch" | "headSha">, commands: string[], lead?: string): string {
	const name = `**${story.storyId}: ${story.title}**`;
	return [
		lead,
		`${name} is a manual step with preparation commands. Should I run them now, in the epic's worktree on \`${request.branch}\` at \`${request.headSha.slice(0, 7)}\`?`,
		fenced(commands.join("\n"), "sh"),
		`**${PREPARATION_RUN}** runs them one at a time and stops at the first failure; **${PREPARATION_MYSELF}** leaves them to you; **${PREPARATION_LATER}** keeps the question open. Either way, the rest of ${story.storyId} stays with a person.`,
	]
		.filter(Boolean)
		.join("\n\n");
}
