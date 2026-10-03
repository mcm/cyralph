/**
 * The narrow slice of Linear the agent needs, behind an interface so the engine can be
 * tested without the network. `SdkLinearGateway` implements it with @linear/sdk.
 */
import { AgentActivitySignal, IssueRelationType, LinearClient } from "@linear/sdk";

export interface IssueSummary {
	id: string;
	identifier: string;
	title: string;
	description: string;
	url: string;
	branchName: string;
	teamId: string;
	teamKey: string;
	stateType: string;
	stateName: string;
	labels: string[];
	projectName?: string;
	parentId?: string;
	assigneeId?: string;
}

export interface IssueComment {
	body: string;
	author?: string;
	createdAt?: string;
}

export interface Blocker {
	id: string;
	identifier: string;
	stateType: string;
}

export type ActivityContent =
	| { type: "thought"; body: string }
	| { type: "action"; action: string; parameter: string; result?: string }
	| { type: "response"; body: string }
	| { type: "error"; body: string }
	| { type: "elicitation"; body: string };

export interface ActivityOptions {
	ephemeral?: boolean;
	/** e.g. "select" with `signalMetadata: { options: [{ value }] }` renders a picker in Linear. */
	signal?: "select" | "auth" | "stop" | "continue";
	signalMetadata?: Record<string, unknown>;
}

export interface PlanStep {
	content: string;
	status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface LinearGateway {
	getIssue(idOrIdentifier: string): Promise<IssueSummary>;
	getChildren(issueId: string): Promise<IssueSummary[]>;
	/** Comments on an issue (oldest first), for context such as uploaded screenshots. */
	getComments(issueId: string): Promise<IssueComment[]>;
	/** Issues that block the given issue ("X blocks this"). */
	getBlockers(issueId: string): Promise<Blocker[]>;
	createIssue(input: {
		teamId: string;
		title: string;
		description: string;
		parentId?: string;
		priority?: number;
		projectName?: string;
	}): Promise<IssueSummary>;
	/** `blockerId` blocks `blockedId`. */
	createBlocksRelation(blockerId: string, blockedId: string): Promise<void>;
	/** Move to the team's first workflow state of this type (or the named state). */
	setIssueState(issueId: string, target: { type?: string; name?: string }): Promise<void>;
	addComment(issueId: string, body: string): Promise<void>;
	createActivity(sessionId: string, content: ActivityContent, opts?: ActivityOptions): Promise<void>;
	updateSessionPlan(sessionId: string, plan: PlanStep[]): Promise<void>;
	addSessionExternalUrl(sessionId: string, label: string, url: string): Promise<void>;
}

export class SdkLinearGateway implements LinearGateway {
	private client: LinearClient;
	private readonly statesByTeam = new Map<string, Array<{ id: string; name: string; type: string; position: number }>>();

	constructor(accessToken: string) {
		this.client = new LinearClient({ accessToken });
	}

	/** Swap in a refreshed OAuth token. */
	setAccessToken(accessToken: string): void {
		this.client = new LinearClient({ accessToken });
	}

	async viewerOrganization(): Promise<{ id: string; name: string }> {
		const org = await this.client.organization;
		return { id: org.id, name: org.name };
	}

	private async summarize(issue: Awaited<ReturnType<LinearClient["issue"]>>): Promise<IssueSummary> {
		const [team, state, labels, project] = await Promise.all([issue.team, issue.state, issue.labels(), issue.project]);
		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title,
			description: issue.description ?? "",
			url: issue.url,
			branchName: issue.branchName,
			teamId: team?.id ?? "",
			teamKey: team?.key ?? "",
			stateType: state?.type ?? "unstarted",
			stateName: state?.name ?? "",
			labels: labels.nodes.map((l) => l.name),
			projectName: project?.name,
			parentId: issue.parentId ?? undefined,
			assigneeId: issue.assigneeId ?? undefined,
		};
	}

	async getIssue(idOrIdentifier: string): Promise<IssueSummary> {
		return this.summarize(await this.client.issue(idOrIdentifier));
	}

	async getChildren(issueId: string): Promise<IssueSummary[]> {
		const parent = await this.client.issue(issueId);
		// fetchNext() appends the next page to `nodes` on the same connection.
		const conn = await parent.children({ first: 100 });
		while (conn.pageInfo.hasNextPage) await conn.fetchNext();
		const unique = [...new Map(conn.nodes.map((n) => [n.id, n])).values()];
		return Promise.all(unique.map((n) => this.summarize(n)));
	}

	async getComments(issueId: string): Promise<IssueComment[]> {
		const issue = await this.client.issue(issueId);
		const conn = await issue.comments({ first: 100 });
		const out: IssueComment[] = [];
		for (const c of conn.nodes) {
			const user = await c.user;
			out.push({ body: c.body, author: user?.name, createdAt: c.createdAt.toISOString() });
		}
		return out.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
	}

	async getBlockers(issueId: string): Promise<Blocker[]> {
		const issue = await this.client.issue(issueId);
		const rels = await issue.inverseRelations({ first: 100 });
		const out: Blocker[] = [];
		for (const rel of rels.nodes) {
			if (rel.type !== IssueRelationType.Blocks) continue;
			const blocker = await rel.issue;
			if (!blocker) continue;
			const state = await blocker.state;
			out.push({ id: blocker.id, identifier: blocker.identifier, stateType: state?.type ?? "unstarted" });
		}
		return out;
	}

	async createIssue(input: Parameters<LinearGateway["createIssue"]>[0]): Promise<IssueSummary> {
		let projectId: string | undefined;
		if (input.projectName) {
			const projects = await this.client.projects({ filter: { name: { eq: input.projectName } }, first: 1 });
			projectId = projects.nodes[0]?.id;
		}
		const payload = await this.client.createIssue({
			teamId: input.teamId,
			title: input.title,
			description: input.description,
			parentId: input.parentId,
			priority: input.priority,
			projectId,
		});
		const issue = await payload.issue;
		if (!issue) throw new Error(`Linear did not return the created issue "${input.title}"`);
		return this.summarize(issue);
	}

	async createBlocksRelation(blockerId: string, blockedId: string): Promise<void> {
		await this.client.createIssueRelation({ issueId: blockerId, relatedIssueId: blockedId, type: IssueRelationType.Blocks });
	}

	private async teamStates(teamId: string) {
		let states = this.statesByTeam.get(teamId);
		if (!states) {
			const conn = await this.client.workflowStates({ filter: { team: { id: { eq: teamId } } }, first: 100 });
			states = conn.nodes.map((s) => ({ id: s.id, name: s.name, type: s.type, position: s.position }));
			states.sort((a, b) => a.position - b.position);
			this.statesByTeam.set(teamId, states);
		}
		return states;
	}

	async setIssueState(issueId: string, target: { type?: string; name?: string }): Promise<void> {
		const issue = await this.client.issue(issueId);
		const team = await issue.team;
		if (!team) return;
		const states = await this.teamStates(team.id);
		const state =
			(target.name && states.find((s) => s.name.toLowerCase() === target.name?.toLowerCase())) ||
			(target.type && states.find((s) => s.type === target.type));
		if (!state || state.id === issue.stateId) return;
		await this.client.updateIssue(issueId, { stateId: state.id });
	}

	async addComment(issueId: string, body: string): Promise<void> {
		await this.client.createComment({ issueId, body });
	}

	async createActivity(sessionId: string, content: ActivityContent, opts?: ActivityOptions): Promise<void> {
		const signals = {
			select: AgentActivitySignal.Select,
			auth: AgentActivitySignal.Auth,
			stop: AgentActivitySignal.Stop,
			continue: AgentActivitySignal.Continue,
		} as const;
		await this.client.createAgentActivity({
			agentSessionId: sessionId,
			content,
			...(opts?.ephemeral !== undefined && { ephemeral: opts.ephemeral }),
			...(opts?.signal && { signal: signals[opts.signal] }),
			...(opts?.signalMetadata && { signalMetadata: opts.signalMetadata }),
		});
	}

	async updateSessionPlan(sessionId: string, plan: PlanStep[]): Promise<void> {
		// `plan` is typed as a JSONObject in the SDK but the API takes the step array.
		await this.client.updateAgentSession(sessionId, { plan: plan as unknown as Record<string, unknown> });
	}

	async addSessionExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
		await this.client.updateAgentSession(sessionId, { addedExternalUrls: [{ label, url }] });
	}
}

/**
 * For `cyralph run`: real Linear reads/writes, but session activity goes to the console
 * because there is no agent session outside a webhook-driven delegation.
 */
export class ConsoleSessionGateway implements LinearGateway {
	constructor(
		private readonly inner: LinearGateway,
		private readonly print: (line: string) => void = (l) => console.log(l),
	) {}
	getIssue = (id: string) => this.inner.getIssue(id);
	getChildren = (id: string) => this.inner.getChildren(id);
	getBlockers = (id: string) => this.inner.getBlockers(id);
	getComments = (id: string) => this.inner.getComments(id);
	createIssue = (input: Parameters<LinearGateway["createIssue"]>[0]) => this.inner.createIssue(input);
	createBlocksRelation = (a: string, b: string) => this.inner.createBlocksRelation(a, b);
	setIssueState = (id: string, t: { type?: string; name?: string }) => this.inner.setIssueState(id, t);
	addComment = (id: string, body: string) => this.inner.addComment(id, body);
	async createActivity(_sessionId: string, content: ActivityContent, opts?: ActivityOptions): Promise<void> {
		const options = (opts?.signalMetadata?.options as Array<{ value: string }> | undefined)?.map((o, i) => `\n  ${i + 1}. ${o.value}`).join("") ?? "";
		const text = content.type === "action" ? `${content.action} ${content.parameter}${content.result ? ` -> ${content.result}` : ""}` : content.body;
		this.print(`[${content.type}] ${text}${options}`);
	}
	async updateSessionPlan(_sessionId: string, plan: PlanStep[]): Promise<void> {
		const mark = { pending: " ", inProgress: "~", completed: "x", canceled: "-" } as const;
		this.print(`[plan]\n${plan.map((p) => `  [${mark[p.status]}] ${p.content}`).join("\n")}`);
	}
	async addSessionExternalUrl(_sessionId: string, label: string, url: string): Promise<void> {
		this.print(`[link] ${label}: ${url}`);
	}
}
