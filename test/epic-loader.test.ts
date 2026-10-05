import { describe, expect, it } from "vitest";
import { loadEpic, parsePreparation } from "../src/linear/epic-loader.js";
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

describe("preparation blocks", () => {
	const fence = "```";
	const manualStory = (description: string) => async () => {
		const linear = new FakeLinear();
		const epic = linear.add({
			title: "Epic",
			identifier: "ENG-40",
			description: `Context\n\n${fence}cyralph-prepare\necho epic-level\n${fence}`,
		});
		linear.add({ title: "Smoke test", identifier: "ENG-41", parentId: epic.id, labels: ["Manual"], description });
		linear.add({ title: "Agent work", identifier: "ENG-42", parentId: epic.id, description });
		const { epic: loaded } = await loadEpic(linear, epic.id, { materializeStories: false, manualLabels: ["manual"] });
		return { manual: loaded.stories.find((s) => s.identifier === "ENG-41"), agent: loaded.stories.find((s) => s.identifier === "ENG-42") };
	};

	it("reads one block from a manual story, dropping blank lines", async () => {
		const { manual } = await manualStory(
			`## Description\nPush to staging first.\n\n${fence}cyralph-prepare\ngit fetch origin\n\n   \ngit push --force origin HEAD:staging\n${fence}\n\nThen check the site.`,
		)();
		expect(manual?.manual).toBe(true);
		expect(manual?.preparation).toEqual(["git fetch origin", "git push --force origin HEAD:staging"]);
	});

	it("joins every block in order and ignores other code blocks", async () => {
		const { manual } = await manualStory(
			`${fence}cyralph-prepare\nfirst\n${fence}\n\n${fence}sh\nnot a command\n${fence}\n\n~~~~cyralph-prepare\nsecond\n${fence}\nthird\n~~~~`,
		)();
		expect(manual?.preparation).toEqual(["first", "second", fence, "third"]);
	});

	it("ignores blocks in non-manual stories and the epic description", async () => {
		const { agent } = await manualStory(`${fence}cyralph-prepare\nrm -rf build\n${fence}`)();
		expect(agent?.manual).toBeUndefined();
		expect(agent).not.toHaveProperty("preparation");
	});

	it("leaves preparation unset for a manual story without a block", async () => {
		const { manual } = await manualStory(`Check the site by hand.\n\n${fence}sh\necho hi\n${fence}`)();
		expect(manual?.manual).toBe(true);
		expect(manual).not.toHaveProperty("preparation");
	});
});

describe("parsePreparation", () => {
	it("returns nothing for text without blocks", () => {
		expect(parsePreparation("plain text\n```\ncode\n```")).toEqual([]);
	});

	it("runs an unclosed block to the end of the text", () => {
		expect(parsePreparation("```cyralph-prepare\r\na\r\nb")).toEqual(["a", "b"]);
	});
});
