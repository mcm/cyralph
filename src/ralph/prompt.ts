/**
 * Per-story prompt, modelled on ralph-tui's JSON tracker template: full PRD context first,
 * then codebase patterns, then exactly one story, then the workflow and stop condition.
 *
 * Custom templates use a Handlebars-compatible subset: `{{var}}`, `{{#if var}}...{{else}}...{{/if}}`.
 */
import { type Epic, type Story, dependencyLabel } from "./types.js";

export const COMPLETE_PATTERN = /<promise>\s*COMPLETE\s*<\/promise>/i;

export interface PromptContext {
	epic: Epic;
	story: Story;
	progressFile: string;
	codebasePatterns?: string;
	recentProgress?: string;
	/** Output of failed quality gates / previous failed attempt for this story. */
	previousAttemptFeedback?: string;
	/** Follow-up instructions from humans in the Linear agent session. */
	guidance?: string[];
	attempt: number;
	maxAttempts: number;
	/** Extra instructions from repository config. */
	appendInstruction?: string;
}

export const DEFAULT_STORY_TEMPLATE = `You are working through a PRD epic from Linear, one user story per session.
Each session starts with a fresh context: the PRD, the progress log and the repository are your memory.

## PRD: {{epicTitle}} ({{epicIdentifier}})
### Progress: {{completedCount}}/{{totalCount}} stories complete

{{#if prdOverview}}
<prd-document>
{{prdOverview}}
</prd-document>

{{/if}}
### All Stories
{{storyList}}

{{#if codebasePatterns}}
## Codebase Patterns (Study These First)
{{codebasePatterns}}

{{/if}}
## Your Task: {{storyId}} - {{storyTitle}}
{{#if storyIdentifier}}Linear issue: {{storyIdentifier}}{{#if storyUrl}} ({{storyUrl}}){{/if}}
{{/if}}
{{#if storyDescription}}
### Description
{{storyDescription}}

{{/if}}
{{#if acceptanceCriteria}}
### Acceptance Criteria
{{acceptanceCriteria}}

{{/if}}
{{#if notes}}
### Notes
{{notes}}

{{/if}}
{{#if qualityGates}}
### Quality Gates (must pass before you signal completion)
{{qualityGates}}

{{/if}}
{{#if guidance}}
## Guidance From Your Team (follow this)
{{guidance}}

{{/if}}
{{#if previousAttemptFeedback}}
## Previous Attempt (attempt {{attempt}} of {{maxAttempts}})
The previous attempt at this story did not complete. Fix the problems below:

{{previousAttemptFeedback}}

{{/if}}
{{#if recentProgress}}
## Recent Progress
{{recentProgress}}

{{/if}}
## Workflow
1. Study the PRD context above to understand the bigger picture.
2. Read the progress log at \`{{progressFile}}\` for status, learnings and gotchas.
3. Implement ONLY this story ({{storyId}}), satisfying every acceptance criterion. Do not start other stories.
4. Run the quality gates and fix any failures.
5. Do NOT create git commits or push. The orchestrator commits after verifying the story.
6. Document learnings (see below).
7. Signal completion.

## Before Completing
APPEND to \`{{progressFile}}\`:
\`\`\`
## [{{currentDate}}] - {{storyId}}: {{storyTitle}}
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
\`\`\`
If you discovered a **reusable pattern**, also add it to the \`## Codebase Patterns\` section at the TOP of that file.
{{#if appendInstruction}}

{{appendInstruction}}
{{/if}}

## Stop Condition
If the story is already implemented (e.g. by a previous session), verify it meets the acceptance criteria and signal completion immediately.
Only when every acceptance criterion is met and the quality gates pass, end your final message with:
<promise>COMPLETE</promise>
If you are blocked and cannot complete the story, explain precisely why and do NOT output the completion signal.
`;

type Vars = Record<string, string | number | undefined>;

/** Render the Handlebars-compatible subset. Unknown vars render as empty. */
export function renderTemplate(template: string, vars: Vars): string {
	const truthy = (k: string) => {
		const v = vars[k];
		return v !== undefined && v !== "" && v !== 0;
	};
	// Innermost-first resolution of {{#if}} blocks handles nesting.
	const ifBlock = /\{\{#if\s+(\w+)\}\}((?:(?!\{\{#if\s)[\s\S])*?)\{\{\/if\}\}/;
	let out = template;
	for (let m = ifBlock.exec(out); m; m = ifBlock.exec(out)) {
		const [whole, key = "", body = ""] = m;
		const [thenPart, elsePart = ""] = body.split("{{else}}");
		out = out.slice(0, m.index) + (truthy(key) ? thenPart : elsePart) + out.slice(m.index + whole.length);
	}
	return out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => String(vars[k] ?? "")).replace(/\n{3,}/g, "\n\n");
}

const STATUS_MARK: Record<Story["status"], string> = {
	completed: "[x]",
	cancelled: "[-]",
	in_progress: "[~]",
	open: "[ ]",
};

export function formatStoryList(epic: Epic, current?: Story): string {
	return epic.stories
		.map((s) => {
			const deps = s.dependsOn.map((d) => dependencyLabel(epic, d));
			const depText = deps.length ? ` (depends on ${deps.join(", ")})` : "";
			const here = current?.key === s.key ? "  <- current" : "";
			return `- ${STATUS_MARK[s.status]} ${s.storyId}: ${s.title}${depText}${here}`;
		})
		.join("\n");
}

export function buildStoryPrompt(ctx: PromptContext, template = DEFAULT_STORY_TEMPLATE): string {
	const { epic, story } = ctx;
	const completed = epic.stories.filter((s) => s.status === "completed" || s.status === "cancelled").length;
	const vars: Vars = {
		epicTitle: epic.title,
		epicIdentifier: epic.identifier,
		epicUrl: epic.url,
		prdOverview: epic.kind === "single" ? undefined : epic.description.trim() || undefined,
		completedCount: completed,
		totalCount: epic.stories.length,
		storyList: formatStoryList(epic, story),
		codebasePatterns: ctx.codebasePatterns,
		storyId: story.storyId,
		storyTitle: story.title,
		storyIdentifier: story.identifier,
		storyUrl: story.url,
		storyDescription: story.description.trim() || undefined,
		acceptanceCriteria: story.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n") || undefined,
		notes: story.notes,
		qualityGates: epic.qualityGates.map((g) => `- \`${g}\``).join("\n") || undefined,
		guidance: ctx.guidance?.length ? ctx.guidance.map((g) => `- ${g.replace(/\n/g, "\n  ")}`).join("\n") : undefined,
		previousAttemptFeedback: ctx.previousAttemptFeedback,
		attempt: ctx.attempt,
		maxAttempts: ctx.maxAttempts,
		recentProgress: ctx.recentProgress,
		progressFile: ctx.progressFile,
		currentDate: new Date().toISOString().slice(0, 10),
		appendInstruction: ctx.appendInstruction,
	};
	return renderTemplate(template, vars).trim();
}

export interface RequestPromptContext {
	epic: Epic;
	requests: string[];
	branch: string;
	baseBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	progressFile: string;
	qualityGates: string[];
}

/**
 * Prompt for a direct request from the Linear thread (an @mention or reply that no story
 * iteration picked up), e.g. "push and open a PR". Like Cyrus, the agent acts on it itself.
 */
export function buildRequestPrompt(ctx: RequestPromptContext): string {
	const { epic } = ctx;
	const done = epic.stories.filter((s) => s.status === "completed" || s.status === "cancelled").length;
	const prd = epic.kind === "single" ? "" : epic.description.trim();
	const lines = [
		`You are working on Linear ${epic.identifier}: ${epic.title}.`,
		epic.kind === "single"
			? `It is implemented on branch \`${ctx.branch}\` (base \`${ctx.baseBranch}\`) in this git worktree.`
			: `It is a PRD epic implemented one story per commit on branch \`${ctx.branch}\` (base \`${ctx.baseBranch}\`) in this git worktree.`,
		"",
		`## Status: ${done}/${epic.stories.length} stories complete`,
		formatStoryList(epic),
		"",
		`- Git remote \`origin\`: ${ctx.remoteUrl ? `\`${ctx.remoteUrl}\`` : "none configured"}`,
		`- Pull request: ${ctx.prUrl ?? "none opened yet"}`,
		`- Progress log (learnings from earlier sessions): \`${ctx.progressFile}\``,
		...(ctx.qualityGates.length ? [`- Quality gates: ${ctx.qualityGates.map((g) => `\`${g}\``).join(", ")}`] : []),
		...(prd ? ["", "<prd-document>", prd.length > 6000 ? `${prd.slice(0, 6000)}\n…` : prd, "</prd-document>"] : []),
		"",
		"## Request from your team",
		...ctx.requests.map((r) => `> ${r.trim().replace(/\n/g, "\n> ")}\n`),
		"## How to handle it",
		"- This is a direct request, not a story. Do what it asks, and nothing beyond it.",
		`- You may commit, and push \`${ctx.branch}\` to \`origin\` (\`git push -u origin ${ctx.branch}\`), when the request calls for it. Never force-push and never push to \`${ctx.baseBranch}\`.`,
		`- For a pull request: check \`gh pr view ${ctx.branch}\` first; if none exists, \`gh pr create --base ${ctx.baseBranch} --head ${ctx.branch} --title "${epic.identifier}: ${epic.title.replace(/"/g, "'")}"\` with a body summarising the stories. Use \`--draft\` unless all stories are complete.`,
		"- If you change code, run the quality gates and commit with a clear message.",
		"- If the request is ambiguous or can't be done (e.g. missing credentials), say exactly what's missing instead of guessing.",
		"- Finish with a short summary for the Linear thread of what you did, including any PR URL.",
	];
	return lines.join("\n").trim();
}
