# cyralph

A [Cyrus](https://github.com/cyrusagents/cyrus)-style Linear agent that executes
[ralph-tui](https://github.com/subsy/ralph-tui) PRD epics.

You delegate a Linear issue to it, the same way you would with Cyrus. If the issue is a Ralph epic,
cyralph runs the **Ralph loop** on it. It picks the next ready user story and gives it to a fresh
Claude session. It verifies the result and commits it, marks the story's Linear issue Done, and moves
on until the epic is finished. Progress streams into the Linear agent session. The session plan shows
the story checklist, and a draft PR grows one commit per story.

```
Linear: delegate ENG-1 "Task Priority System" to @cyralph
  └─ webhook AgentSessionEvent.created ─► cyralph
       ├─ load epic: children US-001..US-003 (+ "blocks" relations = dependencies)
       ├─ git worktree on the epic branch
       └─ loop:
            next ready story (in-progress first → priority → story id; deps done)
            → fresh Claude Agent SDK session with PRD + progress log + one story
            → final message ends with <promise>COMPLETE</promise>?  → run verifyCommands
            → commit "feat(US-002): …" → push → draft PR → child issue ► Done
            → otherwise retry with the failure fed back (max N attempts, then set aside)
       └─ all done → PR ready for review → response in the session
          stuck    → elicitation in the session; your reply becomes guidance and resumes the loop
```

## What counts as a "ralph epic"

cyralph accepts the layouts ralph-tui itself produces. They are interchangeable, so an epic created
with `ralph-tui convert --to linear` runs as-is, and cyralph's own sub-issues also work with ralph-tui.

| Delegated issue | Behaviour |
| --- | --- |
| **Parent issue with child issues** (ralph-tui `convert --to linear` layout) | Each child is a story. The `## Ralph Metadata` body gives `Story ID` and `Ralph Priority`, and `## Acceptance Criteria` gives the checkboxes. Linear **blocks** relations are the dependencies. Child state is the `passes` flag. |
| **Issue whose description contains a PRD**: ralph-tui-prd markdown (`### US-001: …`, `**Depends on:**`, `## Quality Gates`) or a `prd.json` (inline or in a ```` ```json ```` block) | cyralph splits it into child story issues in ralph-tui format, with blocks relations, and then runs as above. Set `ralph.materializeStories: false` to run the stories in memory instead. |
| **A single story issue** of an epic | It loads the parent epic for context, runs only that story on the epic's branch, and then stops. |
| **Any other issue** | It is treated as a one-story epic (a plain Cyrus-like run). The issue is not auto-closed. |

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
  - Anything else is **guidance**. It goes into every later story prompt. If the run is paused, it
    also resets the attempt budget of stories that were set aside and resumes the loop.
- **Re-delegation**: re-delegating the same issue creates a new session. It keeps the branch, the PR
  and the guidance, and skips stories that are already done.

## Blocking / blocked-by

Linear **blocks** relations decide what can run. "A blocks B" and "B is blocked by A" are the same
relation seen from either side, so it doesn't matter which issue you added the link from.

| Relation | Effect |
| --- | --- |
| Story blocked by another story **in the epic** | Becomes a story dependency. It is picked only once the blocker is Done or Canceled, and it becomes eligible during the same run as soon as the blocker finishes. |
| Story blocked by an **open issue outside the epic** | The story is held. Unblocked stories run first. If nothing else can run, the session is **parked** on that issue. |
| **The epic issue itself** (or a plain delegated issue) blocked by an open issue | Nothing starts: no worktree is created and the issue's state isn't changed. The session is parked. A parent that lists its own child as a blocker is ignored. |
| A story delegated on its own whose sibling prerequisite isn't done | Parked on that sibling. |

A parked session posts *"…blocked on **ENG-99**. I'll start automatically when it's done or
canceled."* It wakes when any issue it waits on is completed, canceled or deleted. Every wake
re-reads the blockers from Linear, so a wake that turns out to be early just parks again. What
triggers a wake:

- **Issue webhooks.** Enable the *Issues* resource type on the OAuth app's webhook.
- **A fallback poll** every `blockerPollMinutes` (default 10), plus a check at startup. This covers
  webhooks missed during downtime.
- **A reply of `start anyway`** (or "ignore the blockers"), which runs without waiting on outside
  blockers. Story-to-story dependencies inside the epic still apply.

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
  per story, pushes, and opens or updates the PR with `gh`.

## Setup

1. **Create a Linear OAuth app.** In Linear, go to *Settings → API → OAuth applications*.
   - Callback URL: `http://localhost:3458/oauth/callback`
   - Enable **webhooks**, point them at `https://<public-host>/linear-webhook`, and tick
     **Agent session events** and **Issues**. Issues events are how parked sessions learn that
     their blockers have resolved.
   - Note the client ID, client secret and webhook signing secret.
2. **Configure.** Copy `examples/config.example.json` to `~/.cyralph/config.json` and fill it in.
   Each repository needs a local clone at `repositoryPath`. For PRs, install `gh` and authenticate
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

### Other commands

```bash
cyralph inspect examples/prd-task-priority.md   # parse a PRD file: stories, deps, next story
cyralph inspect ENG-123                         # same for a Linear issue (read-only)
cyralph run ENG-123                             # run the loop from the terminal, no webhooks
```

### Repository routing

The checks run in this order, as in Cyrus:
1. A `[repo=<id|name>]` tag in the description.
2. `routingLabels`.
3. `projectNames`.
4. `teamKeys`.
5. The first repository.

## Development

```bash
npm test          # vitest: parsers, selection, prompt, webhooks, and an end-to-end engine
                  # run against a fake Linear and a real git repo + bare origin
npm run typecheck
```

Layout:

- `src/ralph`: PRD parsing (markdown and prd.json), the ralph-tui story body format, selection,
  the prompt and the progress log.
- `src/linear`: the gateway (`@linear/sdk`), epic loading and materializing, webhook
  verification and classification, and OAuth.
- `src/engine`: the Ralph loop (`epic-engine.ts`), session routing, concurrency and stop
  (`session-manager.ts`), state (`store.ts`) and routing.
- `src/agent`: the Claude Agent SDK runner and the Linear activity reporter.
- `src/git`: the worktree per epic branch, plus commit, stash, push and `gh` PRs.
