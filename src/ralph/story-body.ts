/**
 * Story issue bodies. Everything cyralph needs to order and track a story lives in Linear's own
 * fields (identifier, priority, sub-issue order, state, labels, "blocks" relations); the body is
 * just the work itself:
 *
 *   What to build, in prose.
 *
 *   ## Acceptance Criteria
 *   - [ ] First criterion
 *
 * Issues created by ralph-tui (or by older cyralph versions) also carry a `## Ralph Metadata`
 * section with a story id and priority. It is stripped from the story text; its priority is read
 * only as a fallback for issues that have no Linear priority set (see `legacyRalphPriority`).
 */

/** Sort rank of a story with no priority: after every prioritized story, like Linear's own priority sort. */
export const NO_PRIORITY_RANK = 5;

export interface StoryBody {
	description: string;
	acceptanceCriteria: string[];
	/** `Ralph Priority` from a legacy `## Ralph Metadata` section, if any. */
	legacyRalphPriority?: number;
}

const SECTION_HEADINGS = new Set(["ralph metadata", "description", "acceptance criteria", "test plan"]);

export function buildStoryIssueBody(params: { description: string; acceptanceCriteria: string[] }): string {
	const lines = [params.description.trim(), "", "## Acceptance Criteria"];
	if (params.acceptanceCriteria.length === 0) {
		lines.push("*No acceptance criteria defined.*");
	} else {
		for (const c of params.acceptanceCriteria) lines.push(`- [ ] ${c}`);
	}
	return lines.join("\n").trim();
}

function splitSections(body: string): Map<string, string> {
	const sections = new Map<string, string>();
	let heading = "";
	let buf: string[] = [];
	for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
		const m = /^## (.+)$/.exec(line);
		if (m?.[1] && SECTION_HEADINGS.has(m[1].trim().toLowerCase())) {
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

/** The body without a legacy `## Ralph Metadata` section. */
export function stripLegacyMetadata(body: string): string {
	return body.replace(/\r\n/g, "\n").replace(/^## Ralph Metadata[ \t]*\n[\s\S]*?(?=^## |(?![\s\S]))/im, "").trim();
}

export function parseStoryIssueBody(body: string | undefined | null): StoryBody {
	if (!body?.trim()) return { description: "", acceptanceCriteria: [] };
	const sections = splitSections(body);
	const meta = sections.get("ralph metadata");
	const prio = meta ? /Ralph Priority[:\s*]*\**\s*(\d+)/i.exec(meta)?.[1] : undefined;
	const acSection = sections.get("acceptance criteria");
	const lead = sections.get("") ?? "";
	return {
		// A `## Description` section when there is one, else the text before the first known section.
		description: sections.get("description") ?? (acSection !== undefined || meta !== undefined ? lead : body.trim()),
		acceptanceCriteria: acSection !== undefined ? parseChecklist(acSection) : parseChecklist(body),
		...(prio && { legacyRalphPriority: Number.parseInt(prio, 10) }),
	};
}

/**
 * A story's sort rank (lower = sooner) from its Linear priority (1 Urgent … 4 Low, 0 No priority).
 * Stories with no Linear priority fall back to a legacy `Ralph Priority`, else sort last.
 */
export function storyRank(linearPriority: number | undefined, legacyRalphPriority?: number): number {
	if (linearPriority && linearPriority > 0) return linearPriority;
	return legacyRalphPriority ?? NO_PRIORITY_RANK;
}

/** Linear priority for a PRD story priority (1 = highest): 1 Urgent, 2 High, 3 Medium, 4+ Low. */
export function linearPriorityFor(prdPriority: number): number {
	return Math.min(4, Math.max(1, Math.round(prdPriority)));
}
