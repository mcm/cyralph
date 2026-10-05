/**
 * Turn a Linear issue into a Ralph Epic.
 *
 * Detection order:
 *  1. Issue has sub-issues             -> "children" epic: each sub-issue is a story.
 *  2. Description contains a PRD       -> "prd" epic; optionally materialized into sub-issues
 *     (markdown user stories or prd.json)  with Linear priority, sub-issue order and "blocks" relations.
 *  3. Otherwise                        -> "single" epic: the issue itself is the only story.
 *
 * Delegating a *story* issue (sub-issue of an epic) yields that epic, focused on the one story.
 *
 * Stories are described by Linear's own fields only: identifier, title, priority, sub-issue order,
 * state, labels and "blocks" relations. Title prefixes (`US-001: …`) and body metadata are not parsed.
 */
import { type ParsedPrd, parsePrdFromText, parseQualityGates } from "../ralph/prd.js";
import { buildStoryIssueBody, linearPriorityFor, parseStoryIssueBody, storyRank, stripLegacyMetadata } from "../ralph/story-body.js";
import { EXTERNAL_DEP_PREFIX, type Epic, type Story, type StoryStatus } from "../ralph/types.js";
import type { IssueSummary, LinearGateway } from "./gateway.js";

const DONE_TYPES = new Set(["completed", "canceled"]);

export function statusFromStateType(stateType: string): StoryStatus {
	switch (stateType) {
		case "completed":
			return "completed";
		case "canceled":
			return "cancelled";
		case "started":
			return "in_progress";
		default:
			return "open";
	}
}

export interface LoadedEpic {
	epic: Epic;
	/** When the delegated issue was a single story of a larger epic. */
	focusStoryKey?: string;
	/** Stories created in Linear during this load. */
	materialized: number;
}

export interface LoadOptions {
	materializeStories: boolean;
	/** Labels marking a story issue as a manual step (case-insensitive). */
	manualLabels?: string[];
}

export function isManualIssue(issue: Pick<IssueSummary, "labels">, manualLabels: readonly string[] = []): boolean {
	const wanted = new Set(manualLabels.map((l) => l.toLowerCase()));
	return issue.labels.some((l) => wanted.has(l.toLowerCase()));
}

const PREPARE_INFO = "cyralph-prepare";

/**
 * The commands in every ```cyralph-prepare fenced block of a markdown text, in order: one per non-empty
 * line, trimmed. Fences follow CommonMark (``` or ~~~, at least three, closed by the same character at
 * least as long); an unclosed block runs to the end of the text.
 */
export function parsePreparation(text: string): string[] {
	const commands: string[] = [];
	let fence: { char: string; length: number; prepare: boolean } | undefined;
	for (const line of text.split(/\r?\n/)) {
		if (!fence) {
			const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
			if (open?.[1]) fence = { char: open[1][0] ?? "`", length: open[1].length, prepare: open[2]?.toLowerCase() === PREPARE_INFO };
			continue;
		}
		const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
		if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) {
			fence = undefined;
			continue;
		}
		const command = line.trim();
		if (fence.prepare && command) commands.push(command);
	}
	return commands;
}

/** The fields of a story that come straight from its Linear issue. */
function linearStory(issue: IssueSummary, body = parseStoryIssueBody(issue.description)) {
	return {
		key: issue.id,
		storyId: issue.identifier,
		title: issue.title.trim(),
		description: body.description,
		acceptanceCriteria: body.acceptanceCriteria,
		priority: storyRank(issue.priority, body.legacyRalphPriority),
		...(issue.subIssueSortOrder !== undefined && { sortOrder: issue.subIssueSortOrder }),
		issueId: issue.id,
		identifier: issue.identifier,
		url: issue.url,
		sourceText: stripLegacyMetadata(issue.description),
		projectName: issue.projectName,
		teamKey: issue.teamKey,
		labels: issue.labels,
	};
}

async function storyFromIssue(
	linear: LinearGateway,
	issue: IssueSummary,
	epicKeys: Set<string>,
	external: Record<string, string>,
	manualLabels: readonly string[],
): Promise<Story> {
	const body = parseStoryIssueBody(issue.description);
	const blockers = await linear.getBlockers(issue.id);
	const dependsOn: string[] = [];
	for (const b of blockers) {
		if (epicKeys.has(b.id)) dependsOn.push(b.id);
		// External blockers only matter while they are still open.
		else if (!DONE_TYPES.has(b.stateType)) {
			dependsOn.push(`${EXTERNAL_DEP_PREFIX}${b.id}`);
			external[b.id] = b.identifier;
		}
	}
	const manual = isManualIssue(issue, manualLabels);
	// Preparation is only ever offered for manual stories: blocks anywhere else are plain text.
	const preparation = manual ? parsePreparation(stripLegacyMetadata(issue.description)) : [];
	return {
		...linearStory(issue, body),
		dependsOn,
		status: statusFromStateType(issue.stateType),
		...(manual && { manual: true }),
		...(preparation.length > 0 && { preparation }),
	};
}

function epicBase(issue: IssueSummary, prd: ParsedPrd | null): Omit<Epic, "kind" | "stories"> {
	return {
		issueId: issue.id,
		identifier: issue.identifier,
		title: prd?.name && prd.name !== "Untitled PRD" ? prd.name : issue.title,
		// The full PRD document is the epic's context in every story prompt.
		description: issue.description || prd?.description || "",
		url: issue.url,
		teamId: issue.teamId,
		projectName: issue.projectName,
		teamKey: issue.teamKey,
		branchName: prd?.branchName || issue.branchName,
		qualityGates: prd?.qualityGates.length ? prd.qualityGates : parseQualityGates(issue.description),
	};
}

async function loadChildrenEpic(linear: LinearGateway, parent: IssueSummary, children: IssueSummary[], manualLabels: readonly string[] = []): Promise<Epic> {
	const keys = new Set(children.map((c) => c.id));
	const externalIssues: Record<string, string> = {};
	const stories = await Promise.all(children.map((c) => storyFromIssue(linear, c, keys, externalIssues, manualLabels)));
	const prd = parsePrdFromText(parent.description);
	return { ...epicBase(parent, prd), kind: "children", stories, externalIssues };
}

function inMemoryStories(prd: ParsedPrd): Story[] {
	return prd.stories.map((s) => ({
		key: s.id,
		storyId: s.id,
		title: s.title,
		description: s.description,
		acceptanceCriteria: s.acceptanceCriteria,
		priority: s.priority,
		dependsOn: s.dependsOn,
		status: s.passes ? "completed" : "open",
		notes: s.notes,
	}));
}

/**
 * Create one sub-issue per PRD story. The PRD's ids, priorities and order become Linear metadata:
 * priority, sub-issue order and "blocks" relations. Titles and bodies carry no ralph markers.
 */
export async function materializePrd(linear: LinearGateway, parent: IssueSummary, prd: ParsedPrd): Promise<IssueSummary[]> {
	const created = new Map<string, IssueSummary>();
	for (const [i, s] of prd.stories.entries()) {
		const issue = await linear.createIssue({
			teamId: parent.teamId,
			parentId: parent.id,
			title: s.title,
			description: buildStoryIssueBody({ description: s.description, acceptanceCriteria: s.acceptanceCriteria }),
			priority: linearPriorityFor(s.priority),
			subIssueSortOrder: i,
			projectName: parent.projectName,
		});
		created.set(s.id, issue);
		if (s.passes) await linear.setIssueState(issue.id, { type: "completed" });
	}
	for (const s of prd.stories) {
		const blocked = created.get(s.id);
		for (const dep of s.dependsOn) {
			const blocker = created.get(dep);
			if (blocker && blocked) await linear.createBlocksRelation(blocker.id, blocked.id);
		}
	}
	return [...created.values()];
}

function singleStoryEpic(issue: IssueSummary): Epic {
	return {
		...epicBase(issue, null),
		kind: "single",
		// The delegated issue is the work item; never treat it as already done.
		stories: [{ ...linearStory(issue), dependsOn: [], status: "open" }],
	};
}

/**
 * Open issues blocking the epic issue itself (or the plain issue, for single-issue epics).
 * Its own stories never count: "parent blocked by child" just means "do the children first".
 */
export async function openRootBlockers(linear: LinearGateway, epic: Epic): Promise<Array<{ id: string; identifier: string }>> {
	const own = new Set(epic.stories.map((s) => s.issueId).filter(Boolean));
	const blockers = await linear.getBlockers(epic.issueId);
	return blockers.filter((b) => !own.has(b.id) && !DONE_TYPES.has(b.stateType)).map(({ id, identifier }) => ({ id, identifier }));
}

export async function loadEpic(linear: LinearGateway, issueId: string, opts: LoadOptions): Promise<LoadedEpic> {
	const issue = await linear.getIssue(issueId);

	const children = await linear.getChildren(issue.id);
	if (children.length > 0) {
		return { epic: await loadChildrenEpic(linear, issue, children, opts.manualLabels), materialized: 0 };
	}

	// A sub-issue delegated on its own is one story of its parent's epic: load the epic and focus on it.
	if (issue.parentId) {
		const parent = await linear.getIssue(issue.parentId);
		const siblings = await linear.getChildren(parent.id);
		return { epic: await loadChildrenEpic(linear, parent, siblings, opts.manualLabels), focusStoryKey: issue.id, materialized: 0 };
	}

	const prd = parsePrdFromText(issue.description);
	if (prd) {
		if (opts.materializeStories) {
			const created = await materializePrd(linear, issue, prd);
			const epic = await loadChildrenEpic(linear, issue, await linear.getChildren(issue.id), opts.manualLabels);
			return { epic, materialized: created.length };
		}
		return { epic: { ...epicBase(issue, prd), kind: "prd", stories: inMemoryStories(prd) }, materialized: 0 };
	}

	return { epic: singleStoryEpic(issue), materialized: 0 };
}
