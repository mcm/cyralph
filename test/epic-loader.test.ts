import { describe, expect, it } from "vitest";
import { loadEpic } from "../src/linear/epic-loader.js";
import { sortStories } from "../src/ralph/selection.js";
import { FakeLinear } from "./fakes.js";

const LEGACY_BODY = (id: string, prio: number) =>
	`## Ralph Metadata\n- **Story ID:** ${id}\n- **Ralph Priority:** ${prio}\n\n## Description\nDo ${id}\n\n## Acceptance Criteria\n- [ ] ${id} works`;

describe("loadEpic (Linear metadata only)", () => {
	it("orders stories by Linear priority, then sub-issue order, using identifiers and plain titles", async () => {
		const linear = new FakeLinear();
		const epic = linear.add({ title: "Epic", identifier: "ENG-10" });
		linear.add({ title: "Low", identifier: "ENG-11", parentId: epic.id, priority: 4, subIssueSortOrder: 0 });
		linear.add({ title: "Unprioritized", identifier: "ENG-12", parentId: epic.id, priority: 0, subIssueSortOrder: 1 });
		linear.add({ title: "Urgent second", identifier: "ENG-13", parentId: epic.id, priority: 1, subIssueSortOrder: 3 });
		linear.add({ title: "Urgent first", identifier: "ENG-14", parentId: epic.id, priority: 1, subIssueSortOrder: 2 });
		const { epic: loaded } = await loadEpic(linear, epic.id, { materializeStories: false });
		expect(sortStories(loaded.stories).map((s) => `${s.storyId} ${s.title}`)).toEqual([
			"ENG-14 Urgent first",
			"ENG-13 Urgent second",
			"ENG-11 Low",
			"ENG-12 Unprioritized",
		]);
	});

	it("still reads epics created in the ralph-tui format, without exposing its markers", async () => {
		const linear = new FakeLinear();
		const epic = linear.add({ title: "Old epic", identifier: "ENG-20" });
		linear.add({ title: "US-002: Second", identifier: "ENG-21", parentId: epic.id, description: LEGACY_BODY("US-002", 2) });
		linear.add({ title: "US-001: First", identifier: "ENG-22", parentId: epic.id, description: LEGACY_BODY("US-001", 1) });
		const { epic: loaded } = await loadEpic(linear, epic.id, { materializeStories: false });
		const first = loaded.stories.find((s) => s.identifier === "ENG-22");
		expect(first).toMatchObject({ storyId: "ENG-22", priority: 1, description: "Do US-001", acceptanceCriteria: ["US-001 works"] });
		expect(first?.sourceText).not.toContain("Ralph Metadata");
		expect(loaded.stories.find((s) => s.identifier === "ENG-21")?.priority).toBe(2);
	});

	it("treats any delegated sub-issue as a story of its parent's epic", async () => {
		const linear = new FakeLinear();
		const epic = linear.add({ title: "Epic", identifier: "ENG-30" });
		const story = linear.add({ title: "Plain sub-issue", identifier: "ENG-31", parentId: epic.id });
		linear.add({ title: "Sibling", identifier: "ENG-32", parentId: epic.id });
		const loaded = await loadEpic(linear, story.id, { materializeStories: false });
		expect(loaded.epic.identifier).toBe("ENG-30");
		expect(loaded.focusStoryKey).toBe(story.id);
		expect(loaded.epic.stories).toHaveLength(2);
	});
});
