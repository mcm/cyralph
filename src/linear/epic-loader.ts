/**
 * Turn a Linear issue into a Ralph Epic.
 *
 * Detection order:
 *  1. Issue has child issues          -> "children" epic (ralph-tui `convert --to linear` layout).
 *  2. Description contains a PRD       -> "prd" epic; optionally materialized into child issues
 *     (markdown user stories or prd.json)  using ralph-tui's story body format + "blocks" relations.
 *  3. Otherwise                        -> "single" epic: the issue itself is the only story.
 *
 * Delegating a *story* issue (child of an epic) yields that epic, focused on the one story.
 */
import { type ParsedPrd, parsePrdFromText, parseQualityGates } from "../ralph/prd.js";
import { buildStoryIssueBody, parseStoryIssueBody, parseStoryTitle } from "../ralph/story-body.js";
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
}

async function storyFromIssue(linear: LinearGateway, issue: IssueSummary, epicKeys: Set<string>): Promise<Story> {
	const body = parseStoryIssueBody(issue.description);
	const titled = parseStoryTitle(issue.title);
	const blockers = await linear.getBlockers(issue.id);
	const dependsOn: string[] = [];
	for (const b of blockers) {
		if (epicKeys.has(b.id)) dependsOn.push(b.id);
		// External blockers only matter while they are still open.
		else if (!DONE_TYPES.has(b.stateType)) dependsOn.push(`${EXTERNAL_DEP_PREFIX}${b.identifier}`);
	}
	return {
		key: issue.id,
		storyId: body.storyId ?? titled.storyId ?? issue.identifier,
		title: titled.title,
		description: body.description,
		acceptanceCriteria: body.acceptanceCriteria,
		priority: body.ralphPriority,
		dependsOn,
		status: statusFromStateType(issue.stateType),
		issueId: issue.id,
		identifier: issue.identifier,
		url: issue.url,
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
		branchName: prd?.branchName || issue.branchName,
		qualityGates: prd?.qualityGates.length ? prd.qualityGates : parseQualityGates(issue.description),
	};
}

async function loadChildrenEpic(linear: LinearGateway, parent: IssueSummary, children: IssueSummary[]): Promise<Epic> {
	const keys = new Set(children.map((c) => c.id));
	const stories = await Promise.all(children.map((c) => storyFromIssue(linear, c, keys)));
	const prd = parsePrdFromText(parent.description);
	return { ...epicBase(parent, prd), kind: "children", stories };
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

/** Create one child issue per PRD story plus blocking relations, mirroring `ralph-tui convert --to linear`. */
export async function materializePrd(linear: LinearGateway, parent: IssueSummary, prd: ParsedPrd): Promise<IssueSummary[]> {
	const created = new Map<string, IssueSummary>();
	for (const s of prd.stories) {
		const issue = await linear.createIssue({
			teamId: parent.teamId,
			parentId: parent.id,
			title: `${s.id}: ${s.title}`,
			description: buildStoryIssueBody({
				storyId: s.id,
				ralphPriority: s.priority,
				description: s.description,
				acceptanceCriteria: s.acceptanceCriteria,
			}),
			priority: Math.min(4, Math.max(0, s.priority - 1)),
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
	const body = parseStoryIssueBody(issue.description);
	const titled = parseStoryTitle(issue.title);
	return {
		...epicBase(issue, null),
		kind: "single",
		stories: [
			{
				key: issue.id,
				storyId: body.storyId ?? titled.storyId ?? issue.identifier,
				title: titled.title,
				description: body.description,
				acceptanceCriteria: body.acceptanceCriteria,
				priority: body.ralphPriority,
				dependsOn: [],
				// The delegated issue is the work item; never treat it as already done.
				status: "open",
				issueId: issue.id,
				identifier: issue.identifier,
				url: issue.url,
			},
		],
	};
}

export async function loadEpic(linear: LinearGateway, issueId: string, opts: LoadOptions): Promise<LoadedEpic> {
	const issue = await linear.getIssue(issueId);

	const children = await linear.getChildren(issue.id);
	if (children.length > 0) {
		return { epic: await loadChildrenEpic(linear, issue, children), materialized: 0 };
	}

	// A story delegated on its own: load its parent epic and focus on it.
	if (issue.parentId) {
		const parent = await linear.getIssue(issue.parentId);
		const siblings = await linear.getChildren(parent.id);
		const parentPrd = parsePrdFromText(parent.description);
		const isRalphStory = parseStoryIssueBody(issue.description).hasRalphMetadata || parseStoryTitle(issue.title).storyId;
		if (isRalphStory || parentPrd) {
			return { epic: await loadChildrenEpic(linear, parent, siblings), focusStoryKey: issue.id, materialized: 0 };
		}
	}

	const prd = parsePrdFromText(issue.description);
	if (prd) {
		if (opts.materializeStories) {
			const created = await materializePrd(linear, issue, prd);
			const epic = await loadChildrenEpic(linear, issue, await linear.getChildren(issue.id));
			return { epic, materialized: created.length };
		}
		return { epic: { ...epicBase(issue, prd), kind: "prd", stories: inMemoryStories(prd) }, materialized: 0 };
	}

	return { epic: singleStoryEpic(issue), materialized: 0 };
}
