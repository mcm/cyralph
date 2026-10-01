import type { ActivityContent, ActivityOptions, Blocker, IssueSummary, LinearGateway, PlanStep } from "../src/linear/gateway.js";

let seq = 0;

export class FakeLinear implements LinearGateway {
	issues = new Map<string, IssueSummary>();
	/** blocked id -> blocker ids */
	blocks = new Map<string, string[]>();
	comments: Array<{ issueId: string; body: string }> = [];
	activities: Array<{ sessionId: string; content: ActivityContent; ephemeral?: boolean; signal?: string; signalMetadata?: Record<string, unknown> }> = [];
	plans: PlanStep[][] = [];
	urls: Array<{ label: string; url: string }> = [];

	add(partial: Partial<IssueSummary> & { title: string }): IssueSummary {
		const id = partial.id ?? `id-${++seq}`;
		const issue: IssueSummary = {
			id,
			identifier: partial.identifier ?? `ENG-${seq}`,
			description: "",
			url: `https://linear.app/x/issue/${id}`,
			branchName: partial.branchName ?? `eng-${seq}-branch`,
			teamId: "team",
			teamKey: "ENG",
			stateType: "unstarted",
			stateName: "Todo",
			labels: [],
			...partial,
		};
		this.issues.set(id, issue);
		return issue;
	}

	private find(idOrIdentifier: string): IssueSummary {
		const i = this.issues.get(idOrIdentifier) ?? [...this.issues.values()].find((x) => x.identifier === idOrIdentifier);
		if (!i) throw new Error(`no issue ${idOrIdentifier}`);
		return i;
	}

	async getIssue(id: string) {
		return { ...this.find(id) };
	}
	async getChildren(id: string) {
		return [...this.issues.values()].filter((i) => i.parentId === id).map((i) => ({ ...i }));
	}
	async getBlockers(id: string): Promise<Blocker[]> {
		return (this.blocks.get(id) ?? []).map((b) => {
			const i = this.find(b);
			return { id: i.id, identifier: i.identifier, stateType: i.stateType };
		});
	}
	async createIssue(input: Parameters<LinearGateway["createIssue"]>[0]) {
		return this.add({ title: input.title, description: input.description, parentId: input.parentId, teamId: input.teamId });
	}
	async createBlocksRelation(blocker: string, blocked: string) {
		this.blocks.set(blocked, [...(this.blocks.get(blocked) ?? []), blocker]);
	}
	async setIssueState(id: string, target: { type?: string; name?: string }) {
		const i = this.find(id);
		if (target.type) i.stateType = target.type === "canceled" ? "canceled" : target.type;
		if (target.name) i.stateName = target.name;
	}
	async addComment(issueId: string, body: string) {
		this.comments.push({ issueId, body });
	}
	async createActivity(sessionId: string, content: ActivityContent, opts?: ActivityOptions) {
		this.activities.push({ sessionId, content, ephemeral: opts?.ephemeral, signal: opts?.signal, signalMetadata: opts?.signalMetadata });
	}
	async updateSessionPlan(_s: string, plan: PlanStep[]) {
		this.plans.push(plan);
	}
	async addSessionExternalUrl(_s: string, label: string, url: string) {
		this.urls.push({ label, url });
	}

	bodies(type: ActivityContent["type"]): string[] {
		return this.activities.filter((a) => a.content.type === type).map((a) => ("body" in a.content ? a.content.body : ""));
	}
}
