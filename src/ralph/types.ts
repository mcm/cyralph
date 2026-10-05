/**
 * Core Ralph domain types.
 *
 * An Epic is a named body of work split into small, independently completable user stories
 * with priorities and dependencies. In Linear an epic is a parent issue and each story is a
 * sub-issue; priority, order, state and dependencies come from Linear's own fields.
 */

export type StoryStatus = "open" | "in_progress" | "completed" | "cancelled";

export interface Story {
	/** Stable key used for dependency resolution within an epic (Linear issue id, or story id for in-memory stories). */
	key: string;
	/** How the story is referred to: its Linear identifier (e.g. "ENG-12"), or the PRD story id for in-memory stories. */
	storyId: string;
	title: string;
	description: string;
	acceptanceCriteria: string[];
	/** Sort rank, lower = sooner: Linear priority 1 (Urgent) … 4 (Low), 5 for no priority; or the PRD priority. */
	priority: number;
	/** Tie-break after priority: the story's position among the epic's sub-issues in Linear (`subIssueSortOrder`). */
	sortOrder?: number;
	/** Keys of stories (or `external:<identifier>` markers) that must be completed first. */
	dependsOn: string[];
	status: StoryStatus;
	notes?: string;
	/** A manual step done by a person (labelled with `ralph.manualLabels`): never given to the agent. */
	manual?: boolean;
	/**
	 * Why the story is treated as manual although it isn't labelled so: it belongs in a repository this
	 * cyralph has no access to (e.g. "project `Docs`, which no repository here is set up for").
	 */
	elsewhere?: string;
	/**
	 * Preparation commands from the ```cyralph-prepare blocks of a manual story's description, one per
	 * command, in order. Run only with a person's approval; never set on non-manual stories.
	 */
	preparation?: string[];
	/** A repository other than the epic's that the story routed to (its own worktree, branch and PR/MR). */
	repo?: { id: string; name: string; routedBy: string };
	/** The story issue's routing fields: its Linear project, team and labels. */
	projectName?: string;
	teamKey?: string;
	labels?: string[];
	/** The full Linear issue body (for finding uploaded files outside the Description section). */
	sourceText?: string;
	/** Present when the story is backed by a Linear issue. */
	issueId?: string;
	identifier?: string;
	url?: string;
}

export type EpicKind =
	/** Parent issue with sub-issues as stories. */
	| "children"
	/** A PRD (markdown or prd.json) embedded in the issue description, not yet split into issues. */
	| "prd"
	/** A plain issue with no PRD structure: treated as a one-story epic. */
	| "single";

export interface Epic {
	kind: EpicKind;
	issueId: string;
	identifier: string;
	title: string;
	description: string;
	url?: string;
	teamId?: string;
	/** The epic issue's Linear project and team, which its stories inherit for routing unless they differ. */
	projectName?: string;
	teamKey?: string;
	branchName: string;
	/** Shell commands the PRD requires to pass for every story. */
	qualityGates: string[];
	stories: Story[];
	/** Open issues outside the epic that block one of its stories: Linear id -> identifier (e.g. "ENG-99"). */
	externalIssues?: Record<string, string>;
}

/** Story dependency marker for a blocker outside the epic: `external:<linear issue id>`. */
export const EXTERNAL_DEP_PREFIX = "external:";

export function externalIdOf(dep: string): string | undefined {
	return dep.startsWith(EXTERNAL_DEP_PREFIX) ? dep.slice(EXTERNAL_DEP_PREFIX.length) : undefined;
}

/** Human label for a dependency: the story id within the epic, or the external issue identifier. */
export function dependencyLabel(epic: Epic, dep: string): string {
	const ext = externalIdOf(dep);
	if (ext) return epic.externalIssues?.[ext] ?? ext;
	return epic.stories.find((s) => s.key === dep)?.storyId ?? dep;
}
