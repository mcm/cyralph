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
