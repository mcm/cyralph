/**
 * Core Ralph domain types.
 *
 * An Epic is a ralph-tui style PRD: a named body of work split into small,
 * independently completable user stories with priorities and dependencies.
 * In Linear an epic is a parent issue; each story is (usually) a child issue.
 */

export type StoryStatus = "open" | "in_progress" | "completed" | "cancelled";

export interface Story {
	/** Stable key used for dependency resolution within an epic (Linear issue id, or story id for in-memory stories). */
	key: string;
	/** Ralph story id, e.g. "US-001". Falls back to the Linear identifier for non-ralph children. */
	storyId: string;
	title: string;
	description: string;
	acceptanceCriteria: string[];
	/** Ralph priority: lower = sooner. 1-based. */
	priority: number;
	/** Keys of stories (or `external:<identifier>` markers) that must be completed first. */
	dependsOn: string[];
	status: StoryStatus;
	notes?: string;
	/** Present when the story is backed by a Linear issue. */
	issueId?: string;
	identifier?: string;
	url?: string;
}

export type EpicKind =
	/** Parent issue with child story issues (ralph-tui `convert --to linear` output). */
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
	branchName: string;
	/** Shell commands the PRD requires to pass for every story. */
	qualityGates: string[];
	stories: Story[];
}

export const EXTERNAL_DEP_PREFIX = "external:";
