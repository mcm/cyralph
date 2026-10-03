import { describe, expect, it } from "vitest";
import { parsePrdFromText, parsePrdJson, parsePrdMarkdown, parseQualityGates } from "../src/ralph/prd.js";
import { buildStoryIssueBody, linearPriorityFor, parseStoryIssueBody, storyRank, stripLegacyMetadata } from "../src/ralph/story-body.js";

const PRD = `[PRD]
# PRD: Task Priority System

> Branch: \`ralph/task-priority\`

## Overview
Add priority levels to tasks so users can focus on what matters.

## Goals
- Ship it

## Quality Gates
These commands must pass for every user story:
- \`pnpm typecheck\` - Type checking
- \`pnpm lint\` - Linting

For UI stories, also include:
- Verify in browser using dev-browser skill

## User Stories

### US-001: Add priority field to database
**Description:** As a developer, I need to store task priority.

**Acceptance Criteria:**
- [ ] Add priority column: 1-4 (default 2)
- [ ] Migration runs successfully

### US-002: Show priority badge
**Description:** As a user, I want to see priority at a glance.
It should be colourful.

**Priority:** P1
**Depends on:** US-001

**Acceptance Criteria:**
- [ ] Badge renders on each card

## Functional Requirements
- FR-1: something
[/PRD]`;

describe("parsePrdMarkdown", () => {
	it("parses the ralph-tui-prd skill format", () => {
		const prd = parsePrdMarkdown(PRD);
		expect(prd).not.toBeNull();
		expect(prd?.name).toBe("Task Priority System");
		expect(prd?.branchName).toBe("ralph/task-priority");
		expect(prd?.description).toContain("Add priority levels");
		expect(prd?.qualityGates).toEqual(["pnpm typecheck", "pnpm lint"]);
		expect(prd?.stories.map((s) => s.id)).toEqual(["US-001", "US-002"]);
		const [a, b] = prd?.stories ?? [];
		expect(a?.acceptanceCriteria).toEqual(["Add priority column: 1-4 (default 2)", "Migration runs successfully"]);
		expect(a?.description).toBe("As a developer, I need to store task priority.");
		expect(b?.priority).toBe(1);
		expect(b?.dependsOn).toEqual(["US-001"]);
		expect(b?.description).toContain("colourful");
		// Functional requirements must not leak into the last story.
		expect(b?.acceptanceCriteria).toEqual(["Badge renders on each card"]);
	});

	it("returns null without user stories", () => {
		expect(parsePrdMarkdown("# Just a bug\n\nIt crashes.")).toBeNull();
	});
});

describe("parsePrdJson / parsePrdFromText", () => {
	const json = {
		name: "Task Priority System",
		branchName: "ralph/task-priority",
		userStories: [
			{ id: "US-001", title: "DB", acceptanceCriteria: ["a"], priority: 1, passes: true, dependsOn: [] },
			{ id: "US-002", title: "UI", priority: 2, passes: false, dependsOn: ["US-001"] },
		],
	};

	it("parses prd.json", () => {
		const prd = parsePrdJson(JSON.stringify(json));
		expect(prd?.stories[0]?.passes).toBe(true);
		expect(prd?.stories[1]?.dependsOn).toEqual(["US-001"]);
	});

	it("finds prd.json in a fenced block of an issue description", () => {
		const prd = parsePrdFromText(`Here is the plan:\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`);
		expect(prd?.source).toBe("json");
		expect(prd?.stories).toHaveLength(2);
	});

	it("falls back to markdown", () => {
		expect(parsePrdFromText(PRD)?.source).toBe("markdown");
	});

	it("extracts quality gates standalone", () => {
		expect(parseQualityGates(PRD)).toEqual(["pnpm typecheck", "pnpm lint"]);
	});
});

describe("story issue body", () => {
	it("round-trips without ralph markers", () => {
		const body = buildStoryIssueBody({ description: "Do it", acceptanceCriteria: ["x", "y"] });
		expect(body).not.toMatch(/Ralph|US-/);
		expect(parseStoryIssueBody(body)).toEqual({ description: "Do it", acceptanceCriteria: ["x", "y"] });
	});

	it("treats plain descriptions as description + checklist", () => {
		const parsed = parseStoryIssueBody("Fix the thing\n\n- [ ] it works\n- [x] tests");
		expect(parsed.description).toContain("Fix the thing");
		expect(parsed.acceptanceCriteria).toEqual(["it works", "tests"]);
		expect(parsed.legacyRalphPriority).toBeUndefined();
	});

	it("strips a legacy Ralph Metadata section, keeping its priority only as a fallback", () => {
		const legacy = "## Ralph Metadata\n- **Story ID:** US-001\n- **Ralph Priority:** 2\n\n## Description\nDo it\n\n## Acceptance Criteria\n- [ ] x";
		expect(parseStoryIssueBody(legacy)).toEqual({ description: "Do it", acceptanceCriteria: ["x"], legacyRalphPriority: 2 });
		expect(stripLegacyMetadata(legacy)).toBe("## Description\nDo it\n\n## Acceptance Criteria\n- [ ] x");
	});

	it("ranks by Linear priority, then legacy priority, then last", () => {
		expect(storyRank(1)).toBe(1);
		expect(storyRank(4, 1)).toBe(4);
		expect(storyRank(0, 2)).toBe(2);
		expect(storyRank(0)).toBe(5);
		expect([1, 2, 3, 4, 9].map(linearPriorityFor)).toEqual([1, 2, 3, 4, 4]);
	});
});
