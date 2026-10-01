#!/usr/bin/env node
/**
 * cyralph: a Cyrus-style Linear agent that executes ralph-tui PRD epics story by story.
 *
 *   cyralph start               Run the webhook server (the agent)
 *   cyralph auth                Install the Linear agent app via OAuth (actor=app) and save the token
 *   cyralph inspect <prd|ISSUE> Show how a PRD file or Linear issue would be executed (read-only)
 *   cyralph run <ISSUE>         Run an epic once from the terminal, without webhooks
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { ActivityReporter } from "./agent/activity.js";
import { ClaudeAgentRunner } from "./agent/runner.js";
import { type Config, defaultConfigPath, loadConfig, saveLinearCredentials } from "./config.js";
import { EpicEngine, type EngineDeps } from "./engine/epic-engine.js";
import { SessionManager } from "./engine/session-manager.js";
import { SessionStore, newRecord } from "./engine/store.js";
import { CliGitWorkspace, runShell } from "./git/workspace.js";
import { loadEpic } from "./linear/epic-loader.js";
import { ConsoleSessionGateway, type LinearGateway, SdkLinearGateway } from "./linear/gateway.js";
import { authorizeUrl, exchangeCode, refreshToken } from "./linear/oauth.js";
import { createLogger } from "./logger.js";
import { parsePrdFromText } from "./ralph/prd.js";
import { formatStoryList } from "./ralph/prompt.js";
import { selectNextStory } from "./ralph/selection.js";
import type { Epic } from "./ralph/types.js";
import { createWebhookServer } from "./server.js";

const log = createLogger();

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

async function refreshIfPossible(config: Config, gateway?: SdkLinearGateway): Promise<string | undefined> {
	const { clientId, clientSecret, refreshToken: rt } = config.linear;
	if (!clientId || !clientSecret || !rt) return config.linear.accessToken;
	try {
		const t = await refreshToken({ clientId, clientSecret, refreshToken: rt });
		config.linear.accessToken = t.access_token;
		config.linear.refreshToken = t.refresh_token ?? rt;
		await saveLinearCredentials(config.configPath, { accessToken: t.access_token, refreshToken: config.linear.refreshToken });
		gateway?.setAccessToken(t.access_token);
		log.info("refreshed Linear access token");
		return t.access_token;
	} catch (err) {
		log.warn(`token refresh failed (using existing token): ${String(err)}`);
		return config.linear.accessToken;
	}
}

function requireToken(config: Config): string {
	if (!config.linear.accessToken) {
		throw new Error("No Linear access token. Run `cyralph auth` or set LINEAR_ACCESS_TOKEN.");
	}
	return config.linear.accessToken;
}

function deps(config: Config, linear: LinearGateway): EngineDeps {
	return { config, linear, runner: new ClaudeAgentRunner(), git: new CliGitWorkspace(), shell: runShell, log };
}

async function cmdStart(configPath: string) {
	const config = await loadConfig(configPath);
	await refreshIfPossible(config);
	const token = requireToken(config);
	if (!config.linear.webhookSecret) throw new Error("linear.webhookSecret (or LINEAR_WEBHOOK_SECRET) is required.");
	const gateway = new SdkLinearGateway(token);
	const store = new SessionStore(join(config.stateDir, "sessions.json"));
	await store.load();
	const manager = new SessionManager(deps(config, gateway), store);
	const server = createWebhookServer({ webhookSecret: config.linear.webhookSecret, manager, log });
	server.listen(config.port, () => log.info(`cyralph listening on :${config.port} (POST /linear-webhook)`));
	// Wake sessions whose blockers resolved while we were down, then keep polling as a webhook fallback.
	const reconcile = () => manager.reconcileParked().catch((e: unknown) => log.warn(`blocker reconcile failed: ${String(e)}`));
	void reconcile();
	const poll = config.blockerPollMinutes > 0 ? setInterval(reconcile, config.blockerPollMinutes * 60_000) : undefined;
	// Linear OAuth access tokens expire; refresh twice a day.
	const timer = setInterval(() => void refreshIfPossible(config, gateway), 12 * 60 * 60 * 1000);
	const shutdown = async () => {
		log.info("shutting down…");
		clearInterval(timer);
		if (poll) clearInterval(poll);
		server.close();
		await manager.shutdown();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

async function cmdAuth(configPath: string, args: string[]) {
	const config = await loadConfig(configPath).catch(() => undefined);
	const clientId = config?.linear.clientId ?? process.env.LINEAR_CLIENT_ID;
	const clientSecret = config?.linear.clientSecret ?? process.env.LINEAR_CLIENT_SECRET;
	if (!clientId || !clientSecret) throw new Error("Set linear.clientId/clientSecret in the config (or LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET).");
	const port = Number(flag(args, "port") ?? 3458);
	const redirectUri = flag(args, "redirect-uri") ?? `http://localhost:${port}/oauth/callback`;
	const state = randomBytes(16).toString("hex");
	console.log(`\nOpen this URL as a Linear workspace admin to install the agent:\n\n  ${authorizeUrl(clientId, redirectUri, state)}\n`);
	console.log(`(The OAuth app's callback URL must be ${redirectUri})\n`);

	await new Promise<void>((resolve, reject) => {
		const server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost:${port}`);
			if (url.pathname !== "/oauth/callback") return void res.writeHead(404).end();
			try {
				if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
				const code = url.searchParams.get("code");
				if (!code) throw new Error(url.searchParams.get("error") ?? "missing code");
				const token = await exchangeCode({ clientId, clientSecret, redirectUri, code });
				const org = await new SdkLinearGateway(token.access_token).viewerOrganization();
				await saveLinearCredentials(configPath, {
					accessToken: token.access_token,
					refreshToken: token.refresh_token,
					workspaceId: org.id,
					workspaceName: org.name,
				});
				res.writeHead(200, { "Content-Type": "text/plain" }).end(`cyralph installed in ${org.name}. You can close this tab.`);
				console.log(`Saved Linear credentials for workspace "${org.name}" to ${configPath}`);
				server.close();
				resolve();
			} catch (err) {
				res.writeHead(400, { "Content-Type": "text/plain" }).end(`OAuth failed: ${String(err)}`);
				server.close();
				reject(err);
			}
		});
		server.listen(port);
	});
}

function printEpic(epic: Epic) {
	console.log(`${epic.identifier}: ${epic.title}  [${epic.kind}]`);
	console.log(`branch: ${epic.branchName}`);
	if (epic.qualityGates.length) console.log(`quality gates: ${epic.qualityGates.join(" | ")}`);
	console.log(`\n${formatStoryList(epic)}`);
	const next = selectNextStory(epic.stories);
	console.log(`\nnext story: ${next ? `${next.storyId}: ${next.title}` : "(none ready)"}`);
}

async function cmdInspect(configPath: string, target: string | undefined) {
	if (!target) throw new Error("usage: cyralph inspect <prd.md|prd.json|ISSUE-ID>");
	const text = await readFile(target, "utf8").catch(() => undefined);
	if (text !== undefined) {
		const prd = parsePrdFromText(text);
		if (!prd) throw new Error(`No ralph user stories found in ${target}`);
		printEpic({
			kind: "prd",
			issueId: target,
			identifier: target,
			title: prd.name,
			description: prd.description,
			branchName: prd.branchName ?? "(from Linear issue)",
			qualityGates: prd.qualityGates,
			stories: prd.stories.map((s) => ({ ...s, key: s.id, storyId: s.id, status: s.passes ? "completed" : "open" })),
		});
		return;
	}
	const config = await loadConfig(configPath);
	const gateway = new SdkLinearGateway(requireToken(config));
	const { epic } = await loadEpic(gateway, target, { materializeStories: false });
	printEpic(epic);
}

async function cmdRun(configPath: string, target: string | undefined) {
	if (!target) throw new Error("usage: cyralph run <ISSUE-ID>");
	const config = await loadConfig(configPath);
	await refreshIfPossible(config);
	const linear = new ConsoleSessionGateway(new SdkLinearGateway(requireToken(config)));
	const store = new SessionStore(join(config.stateDir, "sessions.json"));
	await store.load();
	const sessionId = `cli-${target}`;
	const issue = await linear.getIssue(target);
	const record = store.get(sessionId) ?? newRecord(sessionId, issue.id, issue.identifier);
	record.attempts = {};
	const abort = new AbortController();
	process.on("SIGINT", () => abort.abort());
	const status = await new EpicEngine(deps(config, linear)).run({
		record,
		reporter: new ActivityReporter(linear, sessionId, log),
		abortSignal: abort.signal,
		persist: () => store.save(record),
	});
	record.status = status;
	await store.save(record);
	console.log(`\nfinished: ${status}`);
}

async function main() {
	const [, , command, ...args] = process.argv;
	const configPath = flag(args, "config") ?? defaultConfigPath();
	switch (command) {
		case "start":
			return cmdStart(configPath);
		case "auth":
			return cmdAuth(configPath, args);
		case "inspect":
			return cmdInspect(configPath, args.find((a) => !a.startsWith("--")));
		case "run":
			return cmdRun(configPath, args.find((a) => !a.startsWith("--")));
		default:
			console.log(`cyralph: Linear agent for ralph-tui PRD epics

Usage:
  cyralph start   [--config path]          Start the webhook server
  cyralph auth    [--port 3458]            Install the Linear agent app (OAuth, actor=app)
  cyralph inspect <prd-file|ISSUE-ID>      Show stories, dependencies and the next story
  cyralph run     <ISSUE-ID>               Run an epic from the terminal (no webhooks)

Config: ${defaultConfigPath()} (override with --config or CYRALPH_CONFIG)`);
	}
}

main().catch((err: unknown) => {
	log.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
