/**
 * Per-story prompt, modelled on ralph-tui's JSON tracker template: full PRD context first,
 * then codebase patterns, then exactly one story, then the workflow and stop condition.
 *
 * Custom templates use a Handlebars-compatible subset: `{{var}}`, `{{#if var}}...{{else}}...{{/if}}`.
 */
import { type Epic, type Story, dependencyLabel } from "./types.js";

export const COMPLETE_PATTERN = /<promise>\s*COMPLETE\s*<\/promise>/i;
/** The agent hit an obstacle a retry can't get past: the story is set aside without further attempts. */
export const BLOCKED_PATTERN = /<promise>\s*BLOCKED\s*<\/promise>/i;

/** At most this many follow-up issues are filed from one story session. */
export const MAX_FOLLOW_UPS = 10;

/**
 * Commands with duplicates dropped (compared with whitespace collapsed), first occurrence kept. A command
 * that's both a PRD quality gate and a repository verify command should only run once.
 */
export function uniqueCommands(commands: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const cmd of commands) {
		const key = normalizeCommand(cmd);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(cmd.trim());
	}
	return out;
}

function normalizeCommand(cmd: string): string {
	return cmd.trim().replace(/\s+/g, " ");
}

export interface FollowUp {
	title: string;
	description: string;
	/** Work for a person (`manual` attribute): filed with the manual label so no agent attempts it. */
	manual?: boolean;
}

/**
 * Follow-up issues a story agent asks the orchestrator to file, written in its final message as
 * `<follow-up title="…">description</follow-up>` blocks, with a `manual` (or `manual="true"`)
 * attribute for work only a person can do.
 */
export function parseFollowUps(output: string): FollowUp[] {
	const out: FollowUp[] = [];
	for (const m of output.matchAll(/<follow-up((?:\s+[\w-]+(?:\s*=\s*"[^"]*")?)*)\s*>([\s\S]*?)<\/follow-up>/gi)) {
		const attrs = new Map<string, string>();
		for (const a of (m[1] ?? "").matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g)) attrs.set((a[1] ?? "").toLowerCase(), a[2] ?? "");
		const title = (attrs.get("title") ?? "").trim();
		if (!title || out.some((f) => f.title.toLowerCase() === title.toLowerCase())) continue;
		const manual = attrs.has("manual") && !/^(false|no|0)$/i.test((attrs.get("manual") ?? "").trim());
		out.push({ title, description: (m[2] ?? "").trim(), ...(manual && { manual: true }) });
	}
	return out.slice(0, MAX_FOLLOW_UPS);
}

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
	/** Markdown list of downloaded Linear attachments (see formatAttachments). */
	attachments?: string;
	/** The orchestrator files `<follow-up>` blocks as sub-issues of the epic (Linear-backed epics only). */
	followUps?: boolean;
	/** The story's repository, when it isn't the epic's main one. */
	repository?: string;
	/**
	 * Commands the orchestrator runs itself after the agent signals completion. Quality gates among them
	 * aren't repeated as the agent's to run, so each check runs once.
	 */
	verifyCommands?: string[];
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
{{#if repository}}Repository: \`{{repository}}\`. This story belongs in this repository rather than the epic's main one, and this worktree is a checkout of it: make every change here.
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
{{#if attachments}}
### Attachments
Files attached in Linear (screenshots, mockups, documents). Open each one with the Read tool (it shows images) before you start, and treat them as part of the spec:
{{attachments}}

{{/if}}
{{#if qualityGates}}
### Quality Gates (must pass before you signal completion)
{{qualityGates}}

{{/if}}
{{#if verifyCommands}}
### Checked by the Orchestrator
The orchestrator runs these itself after you signal completion and sends any failure back to you, so you don't need to run them as a final check (run one earlier only if you need its output while working):
{{verifyCommands}}

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
If you are blocked by something another attempt can't get past (missing access or credentials, an unavailable service, a decision only a person can make), explain precisely why and what would unblock you, and end your final message with:
<promise>BLOCKED</promise>
The story is then set aside without retries until someone replies. If the story is just unfinished, leave out both signals and it gets another attempt.
{{#if followUps}}

## Follow-up Work
If you find work this story needs that is outside its scope (bugs elsewhere, missing pieces, problems a validation turns up), don't create Linear issues yourself and don't leave it as a note. Put one block per item in your final message, and the orchestrator files each as a new story (a sub-issue of {{epicIdentifier}}):
<follow-up title="Short imperative title">
What is wrong, where, and what done looks like (acceptance criteria as \`- [ ]\` checkboxes).
</follow-up>
- If {{storyId}} can't be completed until they are fixed, leave out the completion signal. They will block {{storyId}}, be worked first, and then {{storyId}} runs again.
- If {{storyId}} is complete anyway, add the completion signal too, and they join the epic as new stories.
- If an item is work only a person can do (granting access, changing settings in an outside service, a decision), mark it manual: \`<follow-up title="…" manual>\`. It is filed for a person and never attempted by an agent; stories it blocks wait until a person marks it done.
{{/if}}
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
			const manual = s.manual ? " (manual step for a person, not for you)" : s.repo ? ` (in ${s.repo.name})` : "";
			return `- ${STATUS_MARK[s.status]} ${s.storyId}: ${s.title}${manual}${depText}${here}`;
		})
		.join("\n");
}

export function buildStoryPrompt(ctx: PromptContext, template = DEFAULT_STORY_TEMPLATE): string {
	const { epic, story } = ctx;
	const completed = epic.stories.filter((s) => s.status === "completed" || s.status === "cancelled").length;
	const verifyCommands = uniqueCommands(ctx.verifyCommands ?? []);
	const checked = new Set(verifyCommands.map(normalizeCommand));
	const qualityGates = uniqueCommands(epic.qualityGates).filter((g) => !checked.has(normalizeCommand(g)));
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
		qualityGates: qualityGates.map((g) => `- \`${g}\``).join("\n") || undefined,
		verifyCommands: verifyCommands.map((g) => `- \`${g}\``).join("\n") || undefined,
		guidance: ctx.guidance?.length ? ctx.guidance.map((g) => `- ${g.replace(/\n/g, "\n  ")}`).join("\n") : undefined,
		previousAttemptFeedback: ctx.previousAttemptFeedback,
		attempt: ctx.attempt,
		maxAttempts: ctx.maxAttempts,
		recentProgress: ctx.recentProgress,
		progressFile: ctx.progressFile,
		currentDate: new Date().toISOString().slice(0, 10),
		appendInstruction: ctx.appendInstruction,
		attachments: ctx.attachments,
		followUps: ctx.followUps ? "yes" : undefined,
		repository: ctx.repository,
	};
	return renderTemplate(template, vars).trim();
}

/**
 * Does a message from the thread ask to push the branch or open/update the PR/MR? Story agents may not do
 * that (the orchestrator owns git), so such requests are handled as direct requests instead of guidance.
 */
export function asksForPushOrPullRequest(text: string): boolean {
	return /\b(push|pull[- ]request|merge[- ]request|PR|MR|glab|gh)\b/i.test(text);
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
	/** Forge-specific PR/MR instructions (see Forge.agentInstructions); omitted without a remote. */
	forgeInstructions?: string;
	/** "pull request" or "merge request". */
	prTerm?: string;
	/** May an explicit request rewrite the epic branch's history? Default "when-asked". */
	historyRewrite?: "when-asked" | "never";
	/** Markdown list of downloaded Linear attachments. */
	attachments?: string;
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
		`- ${capitalize(ctx.prTerm ?? "pull request")}: ${ctx.prUrl ?? "none opened yet"}`,
		`- Progress log (learnings from earlier sessions): \`${ctx.progressFile}\``,
		...(ctx.qualityGates.length ? [`- Quality gates: ${uniqueCommands(ctx.qualityGates).map((g) => `\`${g}\``).join(", ")}`] : []),
		...(prd ? ["", "<prd-document>", prd.length > 6000 ? `${prd.slice(0, 6000)}\n…` : prd, "</prd-document>"] : []),
		...(ctx.attachments
			? ["", "## Attachments", "Files attached in Linear. Open the ones relevant to the request with the Read tool (it shows images):", ctx.attachments]
			: []),
		"",
		"## Request from your team",
		...ctx.requests.map((r) => `> ${r.trim().replace(/\n/g, "\n> ")}\n`),
		"## How to handle it",
		"- This is a direct request, not a story. Do what it asks, and nothing beyond it.",
		`- You may commit, and push \`${ctx.branch}\` to \`origin\` (\`git push -u origin ${ctx.branch}\`), when the request calls for it. Never push to \`${ctx.baseBranch}\` or any other branch.`,
		(ctx.historyRewrite ?? "when-asked") === "when-asked"
			? `- History rewrites are allowed on \`${ctx.branch}\` when the request asks for one. For a rebase: \`git fetch origin && git rebase origin/${ctx.baseBranch}\`, resolve conflicts, run the quality gates, then \`git push --force-with-lease origin ${ctx.branch}\`. Do the rebase that was asked for; don't substitute a merge. If the lease is rejected (someone else pushed), stop and report it instead of overwriting their work.`
			: `- History rewrites (rebase, squash, force-push) are disabled for this repository. If the request asks for one, say so and offer to merge \`${ctx.baseBranch}\` into \`${ctx.branch}\` instead.`,
		...(ctx.forgeInstructions ? [`- ${ctx.forgeInstructions}`] : ["- There is no `origin` remote yet, so pushing or opening a pull/merge request isn't possible until one is added."]),
		"- If you change code, run the quality gates and commit with a clear message.",
		"- If the request is ambiguous or can't be done (e.g. missing credentials), say exactly what's missing instead of guessing.",
		`- Finish with a short summary for the Linear thread of what you did, including any ${ctx.prTerm ?? "pull request"} URL.`,
	];
	return lines.join("\n").trim();
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface PullRequestPromptContext {
	epic: Epic;
	branch: string;
	baseBranch: string;
	/** "pull request" or "merge request". */
	prTerm: string;
	progressFile: string;
}

/** Marks a describe-the-PR session (tests and logs tell it apart from story/request sessions by this). */
export const PR_DESCRIPTION_HEADING = "## Write the title and description";

/** System prompt addition for the read-only session that writes a PR/MR title and description. */
export const PR_DESCRIPTION_SYSTEM_APPEND = `You are "cyralph", writing the title and description of a pull/merge request for work that is already committed.
- Only read: inspect the repository and git history. Don't edit files, commit, push, or run gh/glab.
- Your final message must contain the <pr-title> and <pr-description> blocks the prompt asks for.`;

/**
 * Prompt for a short session that reads the branch's changes and writes the PR/MR title and
 * description. Readers of the PR/MR may not have access to Linear, and the story breakdown is
 * workflow structure, so the agent describes the deliverable itself.
 */
export function buildPullRequestPrompt(ctx: PullRequestPromptContext): string {
	const { epic, baseBranch, prTerm } = ctx;
	const background = epic.description.trim();
	return [
		`The branch \`${ctx.branch}\` in this git worktree is ready for a ${prTerm} into \`${baseBranch}\`. It implements "${epic.title}".`,
		"",
		...(background
			? [
					`Background from the issue tracker (for context only; readers of the ${prTerm} can't see it):`,
					"<issue-background>",
					background.length > 6000 ? `${background.slice(0, 6000)}\n…` : background,
					"</issue-background>",
					"",
				]
			: []),
		`Notes from the sessions that did the work (decisions, gotchas) are in \`${ctx.progressFile}\`, if it exists.`,
		"",
		PR_DESCRIPTION_HEADING,
		`1. Study what actually changed: \`git log --reverse --format='%s%n%b' origin/${baseBranch}..HEAD\` and \`git diff origin/${baseBranch}...HEAD\` (use \`${baseBranch}\` instead of \`origin/${baseBranch}\` if that ref doesn't exist), reading files where the diff alone isn't clear.`,
		`2. Write a title and description for the ${prTerm} that a reviewer with no access to the issue tracker can follow:`,
		"   - Title: one line, imperative mood, at most ~70 characters, summarising the change itself. No issue identifiers or prefixes.",
		"   - Description (markdown): open with a short summary of what the change delivers and why. Then the notable changes, grouped by area, in a few bullets.",
		"   - Add a **Breaking changes** section if behaviour, configuration, APIs or data formats change incompatibly, saying what users must do. Omit it otherwise.",
		"   - Add a **Decisions** section for judgement calls, trade-offs or deviations from the request that a reviewer should know about. Omit it if there were none.",
		"   - Do NOT list the user stories, story IDs, progress or the development process. They are workflow structure, not part of the deliverable. Don't link the issue tracker; that is added for you.",
		"   - Be concrete and concise; don't pad with generic statements or restate the diff line by line.",
		"3. Don't change any files.",
		"",
		"End your final message with exactly these two blocks:",
		"<pr-title>The title</pr-title>",
		"<pr-description>",
		"The markdown description",
		"</pr-description>",
	].join("\n");
}

/** The title and description from a describe session's final message, if it produced both. */
export function parsePullRequestDescription(output: string): { title: string; body: string } | undefined {
	const title = [...output.matchAll(/<pr-title>([\s\S]*?)<\/pr-title>/gi)].pop()?.[1]?.replace(/\s+/g, " ").trim();
	const body = [...output.matchAll(/<pr-description>([\s\S]*?)<\/pr-description>/gi)].pop()?.[1]?.trim();
	if (!title || !body) return undefined;
	return { title: title.replace(/^["'`]+|["'`]+$/g, "").slice(0, 200), body };
}
