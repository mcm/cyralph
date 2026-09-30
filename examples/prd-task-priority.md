[PRD]
# PRD: Task Priority System

> Branch: `ralph/task-priority`

## Overview
Add priority levels to tasks so users can focus on what matters most.

## Goals
- Users can set and see a priority on every task
- Task lists can be sorted by priority

## Quality Gates
These commands must pass for every user story:
- `pnpm typecheck` - Type checking
- `pnpm lint` - Linting

For UI stories, also include:
- Verify in browser using dev-browser skill

## User Stories

### US-001: Add priority field to database
**Description:** As a developer, I need to store task priority so it persists across sessions.

**Acceptance Criteria:**
- [ ] Add priority column: 1-4 (default 2)
- [ ] Migration runs successfully

### US-002: Show priority badge on task cards
**Description:** As a user, I want to see each task's priority at a glance.

**Depends on:** US-001

**Acceptance Criteria:**
- [ ] Badge shows P1–P4 with distinct colours
- [ ] Badge is visible on every task card

### US-003: Sort task list by priority
**Description:** As a user, I want to sort my tasks by priority.

**Priority:** P2
**Depends on:** US-001

**Acceptance Criteria:**
- [ ] "Sort by priority" option in the list toolbar
- [ ] Ties are broken by creation date

## Non-Goals
- Priority-based notifications
[/PRD]
