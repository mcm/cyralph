import { describe, expect, it } from "vitest";
import { allowPreparationFor, parseConfig } from "../src/config.js";

const repo = { id: "app", name: "app", repositoryPath: "/tmp/app", baseBranch: "main" };

describe("allowPreparation", () => {
	it("defaults to true under ralph", () => {
		const config = parseConfig({ repositories: [repo] }, "/tmp/config.json");
		expect(config.ralph.allowPreparation).toBe(true);
		expect(allowPreparationFor(config, config.repositories[0] ?? {})).toBe(true);
	});

	it("uses ralph.allowPreparation when the repository doesn't override it", () => {
		const config = parseConfig({ repositories: [repo], ralph: { allowPreparation: false } }, "/tmp/config.json");
		expect(allowPreparationFor(config, config.repositories[0] ?? {})).toBe(false);
	});

	it("lets a repository override ralph.allowPreparation either way", () => {
		const off = parseConfig({ repositories: [{ ...repo, allowPreparation: false }] }, "/tmp/config.json");
		expect(allowPreparationFor(off, off.repositories[0] ?? {})).toBe(false);
		const on = parseConfig({ repositories: [{ ...repo, allowPreparation: true }], ralph: { allowPreparation: false } }, "/tmp/config.json");
		expect(allowPreparationFor(on, on.repositories[0] ?? {})).toBe(true);
	});

	it("rejects a non-boolean value", () => {
		expect(() => parseConfig({ repositories: [repo], ralph: { allowPreparation: "yes" } }, "/tmp/config.json")).toThrow();
	});
});
