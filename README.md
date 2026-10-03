# cyralph

A [Cyrus](https://github.com/cyrusagents/cyrus)-style Linear agent that executes
[ralph-tui](https://github.com/subsy/ralph-tui) PRD epics.

You delegate a Linear issue to it, the same way you would with Cyrus. If the issue is a Ralph epic,
cyralph runs the **Ralph loop** on it. It picks the next ready user story and gives it to a fresh
Claude session. It verifies the result and commits it, marks the story's Linear issue Done, and moves
on until the epic is finished. Progress streams into the Linear agent session. The session plan shows
the story checklist, and the epic branch grows one commit per story. The PR is opened once the whole
epic is complete, so CI doesn't run for every half-finished story.

```
Linear: delegate ENG-1 "Task Priority System" to @cyralph
  └─ webhook AgentSessionEvent.created ─► cyralph
       ├─ load epic: sub-issues ENG-2..ENG-4 (+ "blocks" relations = dependencies)
       ├─ git worktree on the epic branch
       └─ loop:
            next ready story (in-progress first → Linear priority → sub-issue order; deps done)
            → fresh Claude Agent SDK session with PRD + progress log + one story
            → final message ends with <promise>COMPLETE</promise>?  → run verifyCommands
            → commit "feat(ENG-3): …" → push → sub-issue ► Done
            → otherwise retry with the failure fed back (max N attempts, then set aside)
       └─ all done → open PR (ready for review) → response in the session
          stuck    → elicitation in the session; your reply becomes guidance and resumes the loop
```

## What counts as a "ralph epic"

An epic is a parent issue whose sub-issues are its stories. Everything cyralph needs about a story
comes from Linear's own fields, not from title prefixes or body markup:

| Story property | Linear field |
| --- | --- |
| Name in plans, prompts and commits | The issue identifier (`ENG-12`) and title, as-is |
| Order | **Priority** (Urgent first, *No priority* last), then the sub-issues' manual order in the parent |
| Dependencies | **Blocks** relations (to siblings, or to issues outside the epic) |
| Done / in progress | Workflow state type (completed or canceled = done, started = in progress) |
| Manual step for a person | A label from `ralph.manualLabels` |
| Acceptance criteria | Checkboxes in the description (an `## Acceptance Criteria` section if present) |

| Delegated issue | Behaviour |
| --- | --- |
| **Parent issue with sub-issues** | Each sub-issue is a story, as above. |
| **Issue whose description contains a PRD**: ralph-tui-prd markdown (`### US-001: …`, `**Priority:**`, `**Depends on:**`, `## Quality Gates`) or a `prd.json` (inline or in a ```` ```json ```` block) | cyralph creates a sub-issue per story: the story title as the title, the description and acceptance criteria as the body, the PRD priority as the Linear priority (1 Urgent … 4+ Low), the PRD order as the sub-issue order, and dependencies as blocks relations. Then it runs as above. Set `ralph.materializeStories: false` to run the stories in memory instead. |
| **A sub-issue** of an epic | It loads the parent epic for context, runs only that story on the epic's branch, and then stops. |
| **Any other issue** | It is treated as a one-story epic (a plain Cyrus-like run). The issue is not auto-closed. |

Epics created by ralph-tui (`convert --to linear`) or by older cyralph versions still load. Their
`US-001:` title prefixes are left in the title, and their `## Ralph Metadata` section is dropped from
the story text. Its `Ralph Priority` is used only for a sub-issue that has no Linear priority; set a
priority in Linear to override it. cyralph no longer writes either marker.

A `> Branch: \`name\`` line in the PRD sets the branch. Otherwise the branch is Linear's
`branchName` for the epic issue.

## Linear session UX

- **Plan**: `agentSession.plan` mirrors the story checklist (pending, in progress, completed, or
  set aside).
- **Activities**:
  - Claude's text is posted as *thoughts*.
  - Tool calls are posted as ephemeral *actions*.
  - Story start and finish, retries and verification are posted as *thoughts*.
  - The end of a run is posted as a *response* (done) or an *elicitation* (needs you).
- **Pull request**: attached to the session as an external link.
- **Replies to the session**:
  - `stop` (or the stop button) aborts the current iteration. An interrupted attempt doesn't count.
  - Anything else is a follow-up. See *Delegation, @mentions and replies* below.
- **Re-delegation**: re-delegating the same issue creates a new session. It keeps the branch, the PR
  and the guidance, and skips stories that are already done.

### Delegation, @mentions and replies

These follow Cyrus:

- **Delegating** an issue to the agent works the epic with the Ralph loop. Linear also attaches a
  system note to delegations (*"This thread is for an agent session…"*). Like Cyrus, cyralph uses it
  to tell delegations from mentions and otherwise ignores it.
- **An @mention** does only what the comment asks, with the epic as context: its stories and
  their status, the branch, `origin`, the PR and the PRD. It doesn't start the story loop, change
  Linear issue states or create story issues, and blockers don't apply. That one agent session may
  commit, push the epic branch and use the forge CLI (`gh` or `glab`), and its final message becomes the response. For
  example:
  > @cyralph there is now a git remote, git@github.com:me/app.git, can you push and create a PR?

  If you **explicitly ask** for a rebase, squash or amend, the agent rewrites the epic branch and
  pushes it with `git push --force-with-lease`. It never rewrites history on its own initiative,
  and it never force-pushes the base branch or any other branch. If someone else pushed in the
  meantime, the lease is rejected and the agent reports it instead of overwriting their work. To
  disable rewrites, set `"historyRewrite": "never"` under `ralph` or on a repository. The agent then
  says it can't and offers a merge instead.

  Add **`/ralph`** to a mention (`/label-based-prompt`, Cyrus's spelling, also works) to have it
  work the epic like a delegation. The rest of the comment then becomes story guidance.
- **Replies in a session:**
  - If an agent is running right now (a story, or a request), the reply is **delivered into that
    live session**, as Cyrus streams follow-ups. On an epic it also becomes guidance for later
    stories. A mention on an epic that is being worked is handed to that running agent too.
  - If nothing is running, a reply to a mention continues **the same Claude conversation** (the
    session is resumed). A reply to a delegated epic resumes the loop with the reply as guidance and
    a fresh attempt budget. If no story runs, for example because the epic is finished or blocked,
    the reply runs as a direct request in that session.
- **As a safety net** for delegated epics, when the epic finishes cyralph pushes any commits
  `origin` doesn't have yet, and opens or links the PR. With no remote, stories are committed
  locally without push errors.

## Images and other attachments

Files uploaded to Linear (pasted screenshots, mockups, PDFs) are downloaded with cyralph's Linear
token, as Cyrus does, into `<stateDir>/attachments/<EPIC-ID>/`, and listed in the prompt so the
agent opens them with the Read tool, which shows images to Claude. They are collected from:

- the epic's description and comments (shared with every story);
- each story issue's body and comments (only in that story's prompt);
- @mention and reply text in the session.

Linear's expiring `?signature=` is stripped, and the plain upload URL is fetched with the token.
Files are named after the title Linear stores with them (e.g. `pavilion_contact_sheet.png`), or
get an extension from their content type. They are cached by URL across runs, with at most 20 new
downloads per run. If a download fails, the session says so, and the prompt tells the agent not to
guess what the file shows.

## Blocking / blocked-by

Linear **blocks** relations decide what can run. "A blocks B" and "B is blocked by A" are the same
relation seen from either side, so it doesn't matter which issue you added the link from.

| Relation | Effect |
| --- | --- |
| Story blocked by another story **in the epic** | Becomes a story dependency. It is picked only once the blocker is Done or Canceled, and it becomes eligible during the same run as soon as the blocker finishes. |
| Story blocked by an **open issue outside the epic** | The story is held. Unblocked stories run first. If nothing else can run, the session is **parked** on that issue. |
| **The epic issue itself** (or a plain delegated issue) blocked by an open issue | Nothing starts: no worktree is created and the issue's state isn't changed. The session is parked. A parent that lists its own child as a blocker is ignored. |
| A story delegated on its own whose sibling prerequisite isn't done | Parked on that sibling. |
| Story issue labelled **manual** (any label in `ralph.manualLabels`, default `["manual"]`, case-insensitive) | A step for a person. The agent never works it. Stories that depend on it are held as if blocked by an outside issue: other stories run first, then the session is parked on the manual story until someone moves it to Done or Canceled. |

A parked session posts *"…blocked on **ENG-99**. I'll start automatically when it's done or
canceled."* It wakes when any issue it waits on is completed, canceled or deleted. Every wake
re-reads the blockers from Linear, so a wake that turns out to be early just parks again. What
triggers a wake:

- **Issue webhooks.** Enable the *Issues* resource type on the OAuth app's webhook.
- **A fallback poll** every `blockerPollMinutes` (default 10), plus a check at startup. This covers
  webhooks missed during downtime.
- **A reply of `start anyway`** (or "ignore the blockers"), which runs without waiting on outside
  blockers or manual stories. Other story-to-story dependencies inside the epic still apply, and the
  manual stories themselves are still left to a person.

## Ralph semantics kept from ralph-tui

- **One story per session.** Each story runs in a fresh context. The PRD, the progress log and the
  repo are the memory.
- **Progress log.** The log lives at `<stateDir>/epics/<EPIC-ID>/progress.md`, with a
  `## Codebase Patterns` section at the top. The agent appends learnings after each story. Patterns
  and the last 5 entries are injected into each prompt.
- **Completion requires `<promise>COMPLETE</promise>`** in the agent's *final* message. A zero exit
  code is not enough, and neither is mentioning the tag partway through.
- **Error strategy.** A failed story is retried with feedback, then skipped after
  `maxAttemptsPerStory`. Its partial work is `git stash`ed so the next story starts clean. Stories
  that depend on it are reported as blocked.
- **The prompt template** follows ralph-tui's JSON tracker template (PRD, then patterns, then one
  story, then workflow, then stop condition). You can override it with `promptTemplatePath`, which
  supports a Handlebars subset: `{{var}}` and `{{#if}}…{{else}}…{{/if}}`. See `src/ralph/prompt.ts`
  for the variables.

What cyralph adds on top:

- **Verification the orchestrator owns.** `verifyCommands` (and optionally the PRD's quality gates,
  via `runPrdQualityGates`) run after the agent claims completion. A failing command fails the
  attempt, and its output goes into the retry.
- **Git is also owned by the orchestrator.** The agent is told not to commit. cyralph commits once
  per story, pushes, and opens or updates the PR/MR with `gh` or `glab` (see *GitHub and GitLab*).

## GitHub and GitLab

Git itself (worktrees, commits, pushes) works with any host. Pull and merge requests are opened per
repository with the matching CLI:

| `origin` host | Forge | CLI | Opens |
| --- | --- | --- | --- |
| `github.com` (or anything not GitLab) | GitHub | `gh` | draft pull request |
| `gitlab.com`, a host in `gitlabHosts`, or a host with `gitlab` in its name (e.g. `gitlab.corp.com`) | GitLab | `glab` | draft merge request |

The PR/MR is opened only when every story of the epic is complete (and marked ready right away when
`ralph.markPrReadyWhenComplete` is on). Stories are still pushed as they finish, but no PR/MR exists
yet to trigger CI on each push. Delegating one story of an unfinished epic pushes it without opening a
PR/MR. A PR/MR that already exists, such as one a direct request opened, is updated after every story.
Set `ralph.openPullRequestEarly: true` to get the old behaviour: a draft opens after the first pushed story.

For a **self-hosted GitLab** whose hostname doesn't contain "gitlab", list it in the top-level
`gitlabHosts`, or set `"forge": "gitlab"` on the repository:

```json
{
  "gitlabHosts": ["git.example.com"],
  "repositories": [
    { "id": "api", "name": "platform/api", "repositoryPath": "/srv/code/api", "baseBranch": "main" },
    { "id": "web", "name": "platform/web", "repositoryPath": "/srv/code/web", "forge": "gitlab",
      "gitlabHost": "https://git.example.com" }
  ]
}
```

`gitlabHost` (it sets `GITLAB_HOST` for `glab`) is only needed when `glab` can't work out the
instance from the remote, for example an SSH alias from `~/.ssh/config` or a custom SSH port.

On the cyralph host, log the CLI in once: `glab auth login --hostname git.example.com` (or
`gh auth login`). If the CLI is missing or not logged in, cyralph says so in the session
(*"Commits are pushed to `…`, but I can't open a merge request: …"*) and doesn't skip the step
silently. Sessions link the result as **Merge request** or **Pull request**, and the agent in a
request session is told which CLI to use.

### Automated PR reviews (Cubic)

When a review bot such as [Cubic](https://cubic.dev) submits a **review** on a pull request cyralph
opened, cyralph works through it: it reads the review's summary and inline comments, fixes what's
right, runs the quality gates, and pushes to the PR branch. Progress shows up in the epic's Linear
session. Only submitted reviews (`pull_request_review`) count; plain PR and issue comments are
never acted on, and cyralph doesn't post anything on the PR itself.

```json
{
  "github": {
    "webhookSecret": "…",
    "reviewBots": ["cubic-dev-ai[bot]"],
    "reviewPollMinutes": 5,
    "maxReviewRounds": 3
  },
  "repositories": [{ "id": "app", "respondToReviews": true, "…": "…" }]
}
```

- **Webhook (one per cyralph instance).** Add a GitHub webhook (on a repository, an organization,
  or a GitHub App) pointing at `https://<public-host>/github-webhook`, content type
  `application/json`, with the secret in `github.webhookSecret` (or `GITHUB_WEBHOOK_SECRET`), and
  select only **Pull request reviews**. The payload's `repository.full_name` picks the configured
  repository (by `githubUrl`, else the clone's `origin` remote).
- **Polling.** Without a webhook secret, cyralph checks its own open pull requests every
  `reviewPollMinutes` with `gh api`, using the same `gh auth login` it uses to open PRs.
- `respondToReviews` turns this off per repository (it defaults to on).
- Only the newest bot review of the PR's current head commit is acted on, each review once. The bot
  re-reviews every push, so after `maxReviewRounds` reviews on one PR cyralph stops and says so in
  the session. Stopped sessions are left alone.

### CI failures (GitHub Actions, GitLab CI)

cyralph watches the CI of the pull/merge requests it opened. Once the pipeline of a PR/MR's current
head commit has finished and failed, it hands the failed jobs (names, links and the tail of each
log) to the epic's Linear session, and the agent finds the cause, fixes it, runs the quality gates,
and pushes to the branch so CI runs again. A failure the agent judges unrelated to the branch (a
flaky test, an outage) is reported in the session instead of "fixed".

```json
{
  "ci": { "pollMinutes": 5, "maxFixRounds": 3 },
  "repositories": [{ "id": "app", "respondToCiFailures": true, "…": "…" }]
}
```

- **Polling only.** Every `pollMinutes` (0 turns it off) cyralph asks the forge, with the same CLI
  login it uses for PRs/MRs: GitHub Actions workflow runs of the head commit through `gh api` (failed
  steps' logs via `gh run view --log-failed`), and the MR's head pipeline through `glab api` (job
  traces; jobs with `allow_failure` are ignored). Pipelines still running are checked again later.
- Each failed head commit is acted on once. After `maxFixRounds` failed pipelines on one PR/MR,
  cyralph stops and says so in the session.
- While a session for the epic is running or queued it may push again, so its CI is checked on a
  later poll. Stopped sessions and closed or merged PRs/MRs are left alone.
- `respondToCiFailures` turns this off per repository (it defaults to on).

## Setup

1. **Create a Linear OAuth app.** In Linear, go to *Settings → API → OAuth applications*.
   - Callback URL: `http://localhost:3458/oauth/callback`
   - Enable **webhooks**, point them at `https://<public-host>/linear-webhook`, and tick
     **Agent session events** and **Issues**. Issues events are how parked sessions learn that
     their blockers have resolved.
   - Note the client ID, client secret and webhook signing secret.
2. **Configure.** Copy `examples/config.example.json` to `~/.cyralph/config.json` and fill it in.
   Each repository needs a local clone at `repositoryPath`. For PRs/MRs, install `gh` (GitHub) or
   `glab` (GitLab) and authenticate
   it.
3. **Install and authorize.**
   ```bash
   npm install && npm run build
   node dist/cli.js auth     # open the printed URL as a workspace admin (actor=app install)
   ```
   This saves an app token and a refresh token into the config. Tokens refresh on start and every
   12 hours.
4. **Expose and start.**
   ```bash
   cloudflared tunnel --url http://localhost:3457   # or ngrok, or a real host
   node dist/cli.js start
   ```
5. **Use it.** Delegate an epic to the agent in Linear, or @mention it on the epic.

Claude authentication works the same way as for Claude Code: `ANTHROPIC_API_KEY` or a logged-in
`claude`. The default `permissionMode` is `bypassPermissions`, because runs are unattended. Run it
somewhere you are comfortable giving an agent shell access to, as you would with Cyrus.

### Self-update

`cyralph start` keeps itself up to date with the branch its checkout is on, so you don't have to
update each instance by hand:

1. Every `autoUpdate.intervalMinutes` (default 30) it fetches that branch from `origin`.
2. A new commit is checked out as a git worktree under `<stateDir>/releases/<sha>` and built and
   tested there with `autoUpdate.buildCommands` (default `npm ci`, `npm run build`, `npm test`).
   The running build and your checkout are not touched. A commit that fails is skipped until the
   branch moves on.
3. Once it passes, cyralph stops starting new sessions and waits for running ones to finish.
   Webhooks keep being accepted, and new work is queued. Then it restarts into the new build.
4. On startup, cyralph picks up sessions that were queued or interrupted, whether by an update or a
   crash, from the last 24 hours.

`cyralph start` does this by running the agent as a child process. It restarts the agent into the
new build, and if a new build exits within a minute of starting, it rolls back to the previous one
and marks the commit as failed. A crash later on is restarted with backoff. SIGINT and SIGTERM are
passed on, so it runs the same way under a terminal, tmux or systemd.

```bash
cyralph update      # check now instead of waiting for the next interval
```

```json
{ "autoUpdate": { "enabled": true, "intervalMinutes": 30, "remote": "origin", "branch": "main",
                  "buildCommands": ["npm ci", "npm run build", "npm test"] } }
```

`branch` defaults to the checkout's current branch. Set `"enabled": false` to turn self-update off.
`cyralph start` then runs the agent directly, as it did before. Changes to the supervisor itself
(`src/update/supervisor.ts`) take effect only when you restart `cyralph start` yourself.

### Other commands

```bash
cyralph inspect examples/prd-task-priority.md   # parse a PRD file: stories, deps, next story
cyralph inspect ENG-123                         # same for a Linear issue (read-only)
cyralph run ENG-123                             # run the loop from the terminal, no webhooks
```

### Repository routing

Routing follows Cyrus's priorities. The delegated issue is checked first, then its epic (for a
story delegated on its own):

1. **Description tag**: `[repo=platform/api]`, `[repo=api#release-2]` (base branch override),
   or unbracketed `repo=api` / `repos=api,web`. Linear's escaped `\[repo=…\]` also works. A tag
   matches a repository's `id`, `name`, the last segment of its name, or its `githubUrl`/`gitlabUrl`.
2. **`routingLabels`**: any label on the issue (case-insensitive).
3. **`projectKeys`** (alias `projectNames`): the issue's Linear project.
4. **`teamKeys`**: the issue's team, then the identifier prefix (`ENG-123` gives `ENG`).
5. **Catch-all**: the first repository with no routing configuration at all.

If nothing matches, the session asks *"Which repository should I work in?"* with a picker (Linear's
`select` elicitation) and continues once you answer. You can pick an option, or reply with a name or
a number. With only one repository configured, it is used without asking. The choice is sticky for
the issue, including on re-delegation, and the first thought says how the repo was chosen, e.g.
*"Working in `platform/web` (routed by label `frontend`)…"*. Set `"isActive": false` to keep a
repository configured but never route to it.

```json
{
  "repositories": [
    { "id": "api", "name": "platform/api", "repositoryPath": "/srv/api", "baseBranch": "main",
      "routingLabels": ["backend"], "teamKeys": ["API"], "gitlabUrl": "https://git.example.com/platform/api" },
    { "id": "web", "name": "platform/web", "repositoryPath": "/srv/web", "baseBranch": "main",
      "routingLabels": ["frontend"], "projectKeys": ["Website"] }
  ]
}
```

A `#branch` override only affects a newly created epic branch. An existing branch keeps its
history. Unlike Cyrus, one issue routes to **one** repository. If several match, the first wins,
in priority order and then config order.

## Development

```bash
npm test          # vitest: parsers, selection, prompt, webhooks, and an end-to-end engine
                  # run against a fake Linear and a real git repo + bare origin
npm run typecheck
npm run lint      # biome (lint only; formatting is not enforced)
npm run check     # every CI gate: lint, typecheck, test, build
```

CI (`.github/workflows/ci.yml`) runs `npm run lint`, `typecheck`, `test`, `build` and
`npm audit --omit=dev --audit-level=high` on every pull request (and pushes to `main`),
on Node 22, 24 and 26.

Layout:

- `src/ralph`: PRD parsing (markdown and prd.json), story issue bodies, selection,
  the prompt and the progress log.
- `src/linear`: the gateway (`@linear/sdk`), epic loading and materializing, webhook
  verification and classification, and OAuth.
- `src/engine`: the Ralph loop (`epic-engine.ts`), session routing, concurrency and stop
  (`session-manager.ts`), state (`store.ts`) and routing.
- `src/agent`: the Claude Agent SDK runner and the Linear activity reporter.
- `src/update`: self-update (`updater.ts`), the supervisor behind `cyralph start` (`supervisor.ts`)
  and the release bookkeeping it shares (`releases.ts`).
- `src/git`: the worktree per epic branch, plus commit, stash and push (`workspace.ts`), and GitHub/GitLab PRs and MRs (`forge.ts`).
