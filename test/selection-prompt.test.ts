import { describe, expect, it } from "vitest";
import { extractCodebasePatterns, recentProgressEntries } from "../src/ralph/progress.js";
import { BLOCKED_PATTERN, COMPLETE_PATTERN, buildPullRequestPrompt, buildStoryPrompt, parseFollowUps, parsePullRequestDescription, renderTemplate, uniqueCommands } from "../src/ralph/prompt.js";
import { blockedStories, isEpicComplete, selectNextStory } from "../src/ralph/selection.js";
import type { Epic, Story } from "../src/ralph/types.js";

const story = (key: string, over: Partial<Story> = {}): Story => ({
	key,
	storyId: key,
	title: `Story ${key}`,
	description: "",
	acceptanceCriteria: [],
	priority: 3,
	dependsOn: [],
	status: "open",
	...over,
});

describe("selectNextStory", () => {
	it("respects dependencies and priority", () => {
		const stories = [story("US-001", { priority: 2 }), story("US-002", { priority: 1, dependsOn: ["US-001"] }), story("US-003", { priority: 3 })];
		expect(selectNextStory(stories)?.key).toBe("US-001");
		stories[0]!.status = "completed";
		expect(selectNextStory(stories)?.key).toBe("US-002");
	});

	it("prefers in-progress work and honours exclusions", () => {
		const stories = [story("US-001", { priority: 1 }), story("US-002", { priority: 5, status: "in_progress" })];
		expect(selectNextStory(stories)?.key).toBe("US-002");
		expect(selectNextStory(stories, new Set(["US-002"]))?.key).toBe("US-001");
	});

	it("breaks priority ties by Linear sub-issue order before the id", () => {
		const stories = [story("ENG-2", { sortOrder: 3 }), story("ENG-3", { sortOrder: -1 }), story("ENG-4"), story("ENG-5", { priority: 2 })];
		expect(selectNextStory(stories)?.key).toBe("ENG-5");
		stories[3]!.status = "completed";
		expect(selectNextStory(stories)?.key).toBe("ENG-3");
		stories[1]!.status = "completed";
		expect(selectNextStory(stories)?.key).toBe("ENG-2");
	});

	it("treats external blockers as unsatisfied", () => {
		expect(selectNextStory([story("A", { dependsOn: ["external:ENG-9"] })])).toBeUndefined();
	});

	it("never selects manual stories, and their dependents wait for them", () => {
		const stories = [story("US-001", { priority: 1, manual: true }), story("US-002", { priority: 1, dependsOn: ["US-001"] }), story("US-003", { priority: 5 })];
		expect(selectNextStory(stories)?.key).toBe("US-003");
		stories[2]!.status = "completed";
		expect(selectNextStory(stories)).toBeUndefined();
		stories[0]!.status = "completed";
		expect(selectNextStory(stories)?.key).toBe("US-002");
	});

	it("orders story ids naturally", () => {
		expect(selectNextStory([story("US-010"), story("US-002")])?.key).toBe("US-002");
	});

	it("finds transitively blocked stories", () => {
		const stories = [story("A"), story("B", { dependsOn: ["A"] }), story("C", { dependsOn: ["B"] }), story("D")];
		expect(blockedStories(stories, new Set(["A"])).map((s) => s.key)).toEqual(["B", "C"]);
		expect(isEpicComplete(stories)).toBe(false);
	});
});

describe("prompt", () => {
	const epic: Epic = {
		kind: "children",
		issueId: "e",
		identifier: "ENG-1",
		title: "Task Priority",
		description: "The PRD body",
		branchName: "ralph/x",
		qualityGates: ["pnpm lint"],
		stories: [story("US-001", { status: "completed" }), story("US-002", { dependsOn: ["US-001"], acceptanceCriteria: ["badge shows"] })],
	};

	it("renders the full story prompt", () => {
		const p = buildStoryPrompt({
			epic,
			story: epic.stories[1]!,
			progressFile: "/tmp/p.md",
			guidance: ["use tailwind"],
			previousAttemptFeedback: "lint failed",
			attempt: 2,
			maxAttempts: 3,
		});
		expect(p).toContain("## Your Task: US-002 - Story US-002");
		expect(p).toContain("1/2 stories complete");
		expect(p).toContain("- [x] US-001");
		expect(p).toContain("(depends on US-001)  <- current");
		expect(p).toContain("- [ ] badge shows");
		expect(p).toContain("- `pnpm lint`");
		expect(p).toContain("- use tailwind");
		expect(p).toContain("lint failed");
		expect(p).toContain("<prd-document>\nThe PRD body");
		expect(p).not.toMatch(/\{\{/);
	});

	it("leaves quality gates the orchestrator runs to the orchestrator", () => {
		const gated: Epic = { ...epic, qualityGates: ["pnpm lint", "pnpm  test", "pnpm typecheck", "pnpm lint"] };
		const p = buildStoryPrompt({
			epic: gated,
			story: gated.stories[1]!,
			progressFile: "/tmp/p.md",
			attempt: 1,
			maxAttempts: 3,
			verifyCommands: ["pnpm test", "pnpm build", "pnpm build"],
		});
		const [gates = "", checked = ""] = p.split("### Checked by the Orchestrator");
		expect(gates).toContain("- `pnpm lint`\n- `pnpm typecheck`\n\n");
		expect(gates).not.toContain("pnpm  test");
		expect(checked).toContain("- `pnpm test`\n- `pnpm build`\n\n");
		expect(p.match(/`pnpm lint`/g)).toHaveLength(1);

		const all = buildStoryPrompt({ epic: gated, story: gated.stories[1]!, progressFile: "/tmp/p.md", attempt: 1, maxAttempts: 3, verifyCommands: ["pnpm lint", "pnpm test", "pnpm typecheck"] });
		expect(all).not.toContain("### Quality Gates");
		expect(all).toContain("### Checked by the Orchestrator");
	});

	it("drops duplicate commands, ignoring whitespace", () => {
		expect(uniqueCommands([" pnpm test", "pnpm  test", "", "pnpm lint", "pnpm test"])).toEqual(["pnpm test", "pnpm lint"]);
	});

	it("supports nested if/else in custom templates", () => {
		expect(renderTemplate("{{#if a}}A{{#if b}}B{{/if}}{{else}}none{{/if}}", { a: "1", b: "" })).toBe("A");
		expect(renderTemplate("{{#if a}}A{{else}}none{{/if}}", {})).toBe("none");
	});

	it("detects the completion signal", () => {
		expect(COMPLETE_PATTERN.test("done\n<promise> COMPLETE </promise>")).toBe(true);
		expect(COMPLETE_PATTERN.test("not yet")).toBe(false);
		expect(BLOCKED_PATTERN.test("can't reach the API\n<promise> blocked </promise>")).toBe(true);
		expect(BLOCKED_PATTERN.test("<promise>COMPLETE</promise>")).toBe(false);
	});
});

describe("PR/MR description", () => {
	it("asks for the deliverable from the diff, with the issue as background only", () => {
		const epic: Epic = { kind: "children", issueId: "e", identifier: "ENG-1", title: "Task Priority", description: "The PRD body", branchName: "b", qualityGates: [], stories: [story("US-001")] };
		const p = buildPullRequestPrompt({ epic, branch: "b", baseBranch: "main", prTerm: "merge request", progressFile: "/tmp/p.md" });
		expect(p).toContain("ready for a merge request into `main`");
		expect(p).toContain("<issue-background>\nThe PRD body\n</issue-background>");
		expect(p).toContain("git diff origin/main...HEAD");
		expect(p).toContain("**Breaking changes**");
		expect(p).toContain("**Decisions**");
		expect(p).not.toContain("US-001");
	});

	it("parses the last title and description blocks", () => {
		const out = 'Draft: <pr-title>x</pr-title>\nFinal:\n<pr-title>\n "Add task  priorities" \n</pr-title>\n<pr-description>\n## Summary\nAdds priorities.\n</pr-description>';
		expect(parsePullRequestDescription(out)).toEqual({ title: "Add task priorities", body: "## Summary\nAdds priorities." });
		expect(parsePullRequestDescription("<pr-title>t</pr-title>")).toBeUndefined();
		expect(parsePullRequestDescription("<pr-title> </pr-title><pr-description>b</pr-description>")).toBeUndefined();
	});
});

describe("progress log", () => {
	const log = `# Ralph Progress Log

## Codebase Patterns (Study These First)
- Use zod for all config

---

## [2026-01-01] - US-001: DB
- did it
---

## [2026-01-02] - US-002: UI
- did that
---
`;
	it("extracts patterns and recent entries", () => {
		expect(extractCodebasePatterns(log)).toBe("- Use zod for all config");
		const recent = recentProgressEntries(log, 1);
		expect(recent).toContain("US-002");
		expect(recent).not.toContain("US-001");
	});
});

describe("parseFollowUps", () => {
	it("reads follow-up blocks, drops repeats by title, and caps the count", () => {
		const out = 'Found things.\n<follow-up title="Fix A">\nA is broken.\n- [ ] A works\n</follow-up>\n<follow-up title="fix a">dup</follow-up>\n<FOLLOW-UP title=" Fix B ">B</FOLLOW-UP>';
		expect(parseFollowUps(out)).toEqual([
			{ title: "Fix A", description: "A is broken.\n- [ ] A works" },
			{ title: "Fix B", description: "B" },
		]);
		expect(parseFollowUps(Array.from({ length: 15 }, (_, i) => `<follow-up title="T${i}">x</follow-up>`).join(""))).toHaveLength(10);
		expect(parseFollowUps("<promise>COMPLETE</promise>")).toEqual([]);
	});
});
