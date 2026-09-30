/**
 * Build/parse the Linear story issue body format used by ralph-tui's Linear tracker
 * (`ralph-tui convert --to linear`), so epics created by either tool are interchangeable.
 *
 *   ## Ralph Metadata
 *   - **Story ID:** US-001
 *   - **Ralph Priority:** 2
 *
 *   ## Description
 *   ...
 *
 *   ## Acceptance Criteria
 *   - [ ] First criterion
 */

export const DEFAULT_RALPH_PRIORITY = 3;

export interface StoryBody {
	storyId?: string;
	ralphPriority: number;
	description: string;
	acceptanceCriteria: string[];
	hasRalphMetadata: boolean;
}

const RALPH_HEADINGS = new Set(["ralph metadata", "description", "acceptance criteria", "test plan"]);

export function buildStoryIssueBody(params: {
	storyId: string;
	ralphPriority: number;
	description: string;
	acceptanceCriteria: string[];
}): string {
	const lines = [
		"## Ralph Metadata",
		`- **Story ID:** ${params.storyId}`,
		`- **Ralph Priority:** ${params.ralphPriority}`,
		"",
		"## Description",
		params.description,
		"",
		"## Acceptance Criteria",
	];
	if (params.acceptanceCriteria.length === 0) {
		lines.push("*No acceptance criteria defined.*");
	} else {
		for (const c of params.acceptanceCriteria) lines.push(`- [ ] ${c}`);
	}
	return lines.join("\n");
}

function splitSections(body: string): Map<string, string> {
	const sections = new Map<string, string>();
	let heading = "";
	let buf: string[] = [];
	for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
		const m = /^## (.+)$/.exec(line);
		if (m?.[1] && RALPH_HEADINGS.has(m[1].trim().toLowerCase())) {
			sections.set(heading, buf.join("\n").trim());
			heading = m[1].trim().toLowerCase();
			buf = [];
			continue;
		}
		buf.push(line);
	}
	sections.set(heading, buf.join("\n").trim());
	return sections;
}

export function parseChecklist(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*[-*]\s*\[[ xX]\]\s*(.+)$/.exec(line);
		if (m?.[1]) out.push(m[1].trim());
	}
	return out;
}

export function parseStoryIssueBody(body: string | undefined | null): StoryBody {
	if (!body?.trim()) {
		return { ralphPriority: DEFAULT_RALPH_PRIORITY, description: "", acceptanceCriteria: [], hasRalphMetadata: false };
	}
	const sections = splitSections(body);
	const meta = sections.get("ralph metadata");
	const hasRalphMetadata = meta !== undefined;
	const storyId = meta ? /Story ID[:\s*]*\**\s*(.+)/i.exec(meta)?.[1]?.trim().replace(/\*+$/, "").trim() : undefined;
	const prio = meta ? /Ralph Priority[:\s*]*\**\s*(\d+)/i.exec(meta)?.[1] : undefined;
	const acSection = sections.get("acceptance criteria");
	return {
		storyId: storyId || undefined,
		ralphPriority: prio ? Number.parseInt(prio, 10) : DEFAULT_RALPH_PRIORITY,
		// Non-ralph bodies: treat the whole body as the description.
		description: sections.get("description") ?? (hasRalphMetadata ? "" : body.trim()),
		acceptanceCriteria: acSection !== undefined ? parseChecklist(acSection) : parseChecklist(body),
		hasRalphMetadata,
	};
}

/** Title convention for story issues: "US-001: Add priority field". */
export const STORY_TITLE_PATTERN = /^\s*((?:US|[A-Z]{1,10})-\d+(?:\.\d+)*)\s*:\s*(.+)$/;

export function parseStoryTitle(title: string): { storyId?: string; title: string } {
	const m = STORY_TITLE_PATTERN.exec(title);
	return m?.[1] && m[2] ? { storyId: m[1], title: m[2].trim() } : { title: title.trim() };
}
