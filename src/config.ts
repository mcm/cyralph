/**
 * Configuration (default: ~/.cyralph/config.json). Shaped after Cyrus' EdgeConfig so
 * existing Cyrus users will find it familiar.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const RepositoryConfigSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** Local clone that worktrees are created from. */
	repositoryPath: z.string(),
	baseBranch: z.string().default("main"),
	/** Where per-epic git worktrees are created. Defaults to <stateDir>/worktrees/<repo id>. */
	workspaceBaseDir: z.string().optional(),
	/** Route issues from these Linear team keys (e.g. ["ENG"]) to this repo. */
	teamKeys: z.array(z.string()).optional(),
	/** Route issues carrying any of these labels to this repo. */
	routingLabels: z.array(z.string()).optional(),
	/** Route issues in these Linear projects (by name) to this repo. Cyrus calls this `projectKeys`. */
	projectKeys: z.array(z.string()).optional(),
	/** Alias of `projectKeys`. */
	projectNames: z.array(z.string()).optional(),
	/** Repository web URLs, used to match `[repo=...]` tags and in the repository picker (as in Cyrus). */
	githubUrl: z.string().optional(),
	gitlabUrl: z.string().optional(),
	/** Set false to keep a repository configured but never route to it. */
	isActive: z.boolean().optional(),
	/**
	 * Commands the orchestrator runs itself after the agent signals completion.
	 * A story only passes when all of these exit 0. PRD quality gates are always given to the agent.
	 */
	verifyCommands: z.array(z.string()).optional(),
	/** Also execute the PRD's own Quality Gates commands as verifyCommands. */
	runPrdQualityGates: z.boolean().default(false),
	/**
	 * Where PRs/MRs live. Auto-detected from the `origin` URL: github.com = GitHub; gitlab.com, any
	 * `gitlabHosts` entry, or a host containing "gitlab" = GitLab. Set this for other self-hosted hosts.
	 */
	forge: z.enum(["github", "gitlab"]).optional(),
	/**
	 * Self-hosted GitLab URL for `glab` (sets GITLAB_HOST), e.g. "https://git.example.com". Only needed
	 * when glab can't infer it from the remote (SSH aliases, custom SSH ports).
	 */
	gitlabHost: z.string().optional(),
	/** Shell command run once in a fresh worktree (e.g. "pnpm install"). */
	setupCommand: z.string().optional(),
	model: z.string().optional(),
	allowedTools: z.array(z.string()).optional(),
	disallowedTools: z.array(z.string()).optional(),
	appendInstruction: z.string().optional(),
	/** Custom story prompt template (Handlebars subset, see src/ralph/prompt.ts). */
	promptTemplatePath: z.string().optional(),
});
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;

export const LinearConfigSchema = z.object({
	/** OAuth access token for the agent app (actor=app). Env: LINEAR_ACCESS_TOKEN. */
	accessToken: z.string().optional(),
	refreshToken: z.string().optional(),
	/** Webhook signing secret from the Linear OAuth app. Env: LINEAR_WEBHOOK_SECRET. */
	webhookSecret: z.string().optional(),
	/** OAuth app credentials, only needed for `cyralph auth`. */
	clientId: z.string().optional(),
	clientSecret: z.string().optional(),
	workspaceId: z.string().optional(),
	workspaceName: z.string().optional(),
});

export const RalphConfigSchema = z.object({
	/** Iterations (agent sessions) a single story may take before it is set aside. */
	maxAttemptsPerStory: z.number().int().positive().default(3),
	/** Hard cap on iterations for one run of an epic. 0 = unlimited. */
	maxIterationsPerRun: z.number().int().nonnegative().default(50),
	/** When a PRD sits in an issue description, create child story issues for it in Linear (ralph-tui format). */
	materializeStories: z.boolean().default(true),
	/** Commit after each completed story. */
	commitPerStory: z.boolean().default(true),
	/** Push after each completed story (and open a draft PR after the first push). */
	pushPerStory: z.boolean().default(true),
	/** Open a PR/MR with the forge CLI (`gh` for GitHub, `glab` for GitLab). */
	createPullRequest: z.boolean().default(true),
	/** Mark the PR ready for review once every story is complete. */
	markPrReadyWhenComplete: z.boolean().default(true),
	/** Workflow state type to move the epic issue to when every story is complete (null = leave it). */
	epicCompletedStateType: z.enum(["started", "completed"]).nullable().default(null),
	/** Name of a specific workflow state for the epic on completion (e.g. "In Review"); overrides the type. */
	epicCompletedStateName: z.string().optional(),
});

export const ConfigSchema = z.object({
	port: z.number().int().default(3457),
	/** Public base URL for OAuth callbacks (e.g. an ngrok/cloudflared URL). */
	baseUrl: z.string().optional(),
	/** Where session state, progress logs and worktrees live. */
	stateDir: z.string().optional(),
	model: z.string().default("opus"),
	fallbackModel: z.string().optional(),
	maxConcurrentSessions: z.number().int().positive().default(2),
	/** Hostnames of self-hosted GitLab instances (e.g. ["git.example.com"]), so their remotes use `glab`. */
	gitlabHosts: z.array(z.string()).default([]),
	/**
	 * How often to re-check blockers of parked sessions, as a fallback for missed Issue webhooks.
	 * 0 disables polling (startup reconciliation still runs).
	 */
	blockerPollMinutes: z.number().nonnegative().default(10),
	/** Claude Agent SDK permission mode. Agents run unattended, so edits must not prompt. */
	permissionMode: z.enum(["bypassPermissions", "acceptEdits", "dontAsk", "auto"]).default("bypassPermissions"),
	linear: LinearConfigSchema.prefault({}),
	ralph: RalphConfigSchema.prefault({}),
	repositories: z.array(RepositoryConfigSchema).min(1),
});
export type Config = z.infer<typeof ConfigSchema> & { stateDir: string; configPath: string };

export function defaultConfigPath(): string {
	return process.env.CYRALPH_CONFIG ?? join(process.env.CYRALPH_HOME ?? join(homedir(), ".cyralph"), "config.json");
}

export function parseConfig(raw: unknown, configPath: string): Config {
	const parsed = ConfigSchema.parse(raw);
	const baseDir = dirname(resolve(configPath));
	const stateDir = resolve(baseDir, parsed.stateDir ?? ".");
	const env = process.env;
	return {
		...parsed,
		configPath: resolve(configPath),
		stateDir,
		linear: {
			...parsed.linear,
			accessToken: env.LINEAR_ACCESS_TOKEN ?? parsed.linear.accessToken,
			webhookSecret: env.LINEAR_WEBHOOK_SECRET ?? parsed.linear.webhookSecret,
			clientId: env.LINEAR_CLIENT_ID ?? parsed.linear.clientId,
			clientSecret: env.LINEAR_CLIENT_SECRET ?? parsed.linear.clientSecret,
		},
		repositories: parsed.repositories.map((r) => ({
			...r,
			repositoryPath: resolve(baseDir, r.repositoryPath),
			workspaceBaseDir: resolve(baseDir, r.workspaceBaseDir ?? join(stateDir, "worktrees", r.id)),
			promptTemplatePath: r.promptTemplatePath ? resolve(baseDir, r.promptTemplatePath) : undefined,
		})),
	};
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<Config> {
	const text = await readFile(configPath, "utf8");
	return parseConfig(JSON.parse(text), configPath);
}

/** Persist Linear credentials obtained by `cyralph auth` back into the config file. */
export async function saveLinearCredentials(
	configPath: string,
	creds: { accessToken: string; refreshToken?: string; workspaceId?: string; workspaceName?: string },
): Promise<void> {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		await mkdir(dirname(configPath), { recursive: true });
	}
	const linear = (raw.linear as Record<string, unknown> | undefined) ?? {};
	raw.linear = { ...linear, ...creds };
	await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
