import { describe, expect, it } from "vitest";
import { moveToRepository, newRecord } from "../src/engine/store.js";

describe("moveToRepository", () => {
	it("drops the old main lane and promotes the epic's lane in the new repository", () => {
		const record = newRecord("s", "i");
		Object.assign(record, { repoId: "web", branch: "eng-1", worktreePath: "/wt/web", prUrl: "https://github.com/o/web/pull/1", prNumber: 1, reviewRounds: 2 });
		record.pendingRequests = ["push"];
		record.lanes = { api: { repoId: "api", branch: "eng-1", worktreePath: "/wt/api", pendingRequests: ["fix CI"] } };

		const left = moveToRepository(record, "api");
		expect(left).toEqual({ repoId: "web", branch: "eng-1", worktreePath: "/wt/web", prUrl: "https://github.com/o/web/pull/1", prNumber: 1, reviewRounds: 2 });
		expect(record).toMatchObject({ repoId: "api", branch: "eng-1", worktreePath: "/wt/api", pendingRequests: ["push", "fix CI"] });
		expect(record.prUrl).toBeUndefined();
		expect(record.reviewRounds).toBeUndefined();
		expect(record.lanes).toBeUndefined();
	});

	it("does nothing for the same repository, and starts clean without one", () => {
		const record = newRecord("s", "i");
		expect(moveToRepository(record, "api")).toBeUndefined();
		expect(record.repoId).toBe("api");
		record.branch = "b";
		expect(moveToRepository(record, "api")).toBeUndefined();
		expect(record.branch).toBe("b");
	});
});
