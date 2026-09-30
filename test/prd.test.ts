import { describe, expect, it } from "vitest";
import { parsePrdFromText, parsePrdJson, parsePrdMarkdown, parseQualityGates } from "../src/ralph/prd.js";
import { buildStoryIssueBody, parseStoryIssueBody, parseStoryTitle } from "../src/ralph/story-body.js";

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

describe("story issue body (ralph-tui Linear format)", () => {
	it("round-trips", () => {
		const body = buildStoryIssueBody({ storyId: "US-003", ralphPriority: 2, description: "Do it", acceptanceCriteria: ["x", "y"] });
		const parsed = parseStoryIssueBody(body);
		expect(parsed).toMatchObject({ storyId: "US-003", ralphPriority: 2, description: "Do it", acceptanceCriteria: ["x", "y"], hasRalphMetadata: true });
	});

	it("treats plain descriptions as description + checklist", () => {
		const parsed = parseStoryIssueBody("Fix the thing\n\n- [ ] it works\n- [x] tests");
		expect(parsed.hasRalphMetadata).toBe(false);
		expect(parsed.description).toContain("Fix the thing");
		expect(parsed.acceptanceCriteria).toEqual(["it works", "tests"]);
	});

	it("parses story titles", () => {
		expect(parseStoryTitle("US-001: Add field")).toEqual({ storyId: "US-001", title: "Add field" });
		expect(parseStoryTitle("Plain title")).toEqual({ title: "Plain title" });
	});
});
