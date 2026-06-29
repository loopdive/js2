---
id: 2827
title: "Statusline + dashboard kanban ignore `sprint: current` (unfinished #2751 acceptance criterion)"
parent: 2751
related: [2751, 2750]
status: done
created: 2026-06-29
completed: 2026-06-29
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: chore
area: tooling
goal: maintainability
sprint: current
horizon: s
architect_spec: done
---

# #2827 — Statusline + dashboard kanban ignore `sprint: current`

The rolling budget-window model (#2751) made `sprint: current` the **live work**
window and numbered `sprint: {N}` the **frozen retrospective**. The budget half
landed (the statusline caches `rate_limits.seven_day` → `~/.claude/js2wasm-budget.json`,
read by `budget-status.mjs` / `freeze-sprint.mjs`), but the **sprint-progress
rendering** in both the terminal statusline and the website dashboard/kanban was
never updated — they still recognize **numbered** sprints only and silently drop
`sprint: current`.

This is the still-**unchecked** #2751 acceptance criterion:
> `sprint: current` is a documented, validated sprint value; tooling/dashboard
> handle it. (#2751, body lines 120-122 + acceptance box line 138)

#2751 was marked `status: done` before this was implemented.

**Tooling-only; deferred behind the codegen conformance push — not on the
critical path. The lead/user schedule it.**

## Evidence (verified on current main, 2026-06-29)

There are **99** issues tagged `sprint: current` right now; neither surface
shows any of them.

### 1. Terminal statusline — shows a frozen sprint, ignores the live window

`scripts/statusline-sprint.mjs` recognizes only numeric `sprint: N`:

- primary remote grep is `^(sprint: [0-9]|status: )` (line 52) and the parse is
  `/^sprint:\s*(\d+)/` (line 80) → `sprint: current` never matches;
- "current sprint = highest non-inactive **numbered** sprint" (lines 126-127);
- the local-tree fallback explicitly skips non-numeric:
  `if (!/^\d+$/.test(sprintRaw)) continue;` (line 175).

Live proof: `node scripts/statusline-sprint.mjs --porcelain` → **`67 23 40`**, so
the badge renders **`s67 23/40`** (frozen sprint 67's retrospective) while the 99
`sprint: current` issues are invisible. The badge consumer is
`.claude/statusline-command.sh:338-356` (sprint progress bar), gated to
`branch == main && not in a worktree` (line 305) — i.e. the tech-lead view.

The **budget chips** (`wkly %` / `d left`) are correct and unaffected — they come
from `.claude/statusline-command.sh:140-148` writing the budget cache. Only the
**sprint badge** is stale.

### 2. Website dashboard / roadmap kanban — drops `sprint: current` entirely

`website/dashboard/build-data.js:222-223`:

```js
const sprintNumber = extractSprintNumberFromLabel(issue.sprint);
if (!Number.isFinite(sprintNumber)) continue;   // "current" → null → NaN → dropped
```

(`extractSprintNumber` is `String(name).match(/(\d+)/)` — `"current"` has no
digit → `null`.) So every `sprint: current` issue is excluded from
`sprints.json`. And the frontend `website/dashboard/index.html` filters
`Number.isFinite(s.sprintNumber)` everywhere (lines 901, 912-913, 929, 989) and
`getLatestActiveSprint` picks the highest non-closed **number** — so the kanban
renders the last frozen numbered sprint as if it were active, with no column for
the live window.

`issues.json` (build-data.js:232) writes every issue regardless of sprint, so
individual issue pages are unaffected — this is purely the sprint-bucketed
roadmap/kanban view.

## Implementation Plan

Two independent parts; either can ship alone.

### Part A — statusline current-window badge

**File: `scripts/statusline-sprint.mjs`**

- **Remote scan** (`sprintFromRemote`, lines 45-132): widen the grep at line 52 to
  also match the literal: `^(sprint: [0-9]|sprint: current|status: )`. In the
  per-file parse (lines 79-86) add a `current` flag when the value is `current`
  (alongside the numeric `file.sprint`). Build a separate `current` bucket
  ({total, done}) in the loop at 113-121.
- **Local fallback** (`scanFlatTree`, lines 158-183): stop skipping `current` at
  line 175 — bucket `sprintRaw === "current"` into the same current bucket.
- **Selection** (lines 125-131 / `currentSprintLocal`): when the `current`
  bucket is non-empty, it **wins** — emit it as the active window. Numbered
  sprints remain the fallback only when there is no `current` work (preserves
  behaviour for repos/branches still on the numbered model).
- **Porcelain output** (line 254): keep the `N done total` shape but use a
  sentinel/label for the current window so the shell can distinguish it — e.g.
  emit `cur <done> <total>` (string token) or reuse the next-free-N that
  `freeze-sprint.mjs` would assign as the window number. Pick one and update the
  consumer accordingly.

**File: `.claude/statusline-command.sh`** (sprint badge block, lines 305-357)

- Accept the new porcelain token: if `sprint_n` is the `cur`/sentinel token,
  render the label as `cur <done>/<total>` (or `s⟳ …`) instead of `s<N>`. The
  progress bar math (lines 338-356) is unchanged. Leave the `wkly`/`d left` chips
  as-is.

Edge cases: zero `current` issues (fresh post-freeze window) → fall back to the
highest numbered sprint (current behaviour); a branch with neither → the existing
`sprints.json` last-resort path (lines 242-243) still applies.

### Part B — dashboard synthetic active-window sprint

**File: `website/dashboard/build-data.js`** (issue→sprint bucketing, lines 222-228)

- Replace the unconditional `continue` on non-finite sprint with: when
  `issue.sprint === "current"`, route the issue into a dedicated **current-window
  bucket** (e.g. keyed by a high sentinel number, or a separate
  `currentIssueIds` set). Keep `continue` only for genuinely unbucketed values
  (`Backlog`, `0`, unset).
- In the sprint-object assembly (the `writeFileSync(... "sprints.json" ...)` path
  around lines 258-368) emit one extra entry for the current window:
  `{ sprintNumber: <next-free-N or sentinel>, isCurrent: true, isClosed: false,
  isPlanning: false, issueIds, completedIssueIds }`. Use the same lowest-free-N
  rule as `freeze-sprint.mjs` so the label matches what the next freeze will
  produce (cosmetic but consistent).

**File: `website/dashboard/index.html`** (sprint selection / kanban)

- Include the current-window entry in the `Number.isFinite(s.sprintNumber)`
  filters (lines 901, 912-913, 929, 989) — either give the synthetic entry a
  finite sentinel number, or add an `|| s.isCurrent` clause.
- `getLatestActiveSprint` (lines 909-915): **prefer** the `isCurrent` window when
  present, so the kanban defaults to the live window and groups its issues by
  status column. Numbered sprints remain selectable in the sprint dropdown as the
  frozen history.

Edge cases: dedupe — a `done` issue that exists both as `sprint: current` and in
a frozen `sprints/N.md` snapshot must not double-count (the existing
highest-priority-status dedupe at build-data.js:173-181 should cover it; verify).

## Acceptance criteria

- `node scripts/statusline-sprint.mjs --porcelain` reports the live `current`
  window (its done/total over the 99 `sprint: current` issues), not frozen sprint
  67; the rendered badge shows the current window.
- The dashboard kanban shows the `sprint: current` window as the active board
  (issues grouped by status), with numbered sprints still browsable as frozen
  history; no `sprint: current` issue is silently dropped from `sprints.json`.
- Ticks the outstanding #2751 acceptance box ("tooling/dashboard handle
  `sprint: current`").
- No regression for repos/branches still on the numbered-only model (empty
  `current` bucket → previous behaviour).

## Resolution (implemented in this PR)

Both halves landed together (issue file + source):

- **Statusline** (`scripts/statusline-sprint.mjs`): added a `current` bucket —
  the remote grep and local scan now recognize `sprint: current`, and when any
  `current` work exists it is emitted as the active window with the `cur` token
  (`--porcelain` → `cur <done> <total>`); numbered sprints remain the fallback
  when there is no `current` work. `.claude/statusline-command.sh` renders the
  badge label as `cur <done>/<total>` for the non-numeric token (numeric
  sprints still render `s<N> …`), and its `sprints.json` last-resort fallback
  emits `cur` for the `isCurrent` entry. Budget chips (`wkly`/`d left`)
  unchanged.
- **Dashboard** (`website/dashboard/build-data.js`): `sprint: current` issues are
  routed into a synthetic active-window sprint object
  (`{ name:"current", sprintNumber: maxNumbered+1, isCurrent:true,
  isClosed:false, isPlanning:false, issueIds, completedIssueIds }`) appended to
  `sprints.json` instead of being dropped. `website/dashboard/index.html`:
  `getLatestActiveSprint` prefers the `isCurrent` window and the sprint dropdown
  labels it `current`; the existing `Number.isFinite(sprintNumber)` filters
  already include it (the synthetic carries a finite number).

In-lane tooling; no dependency on codegen / substrate work. Numbered-sprint
fallback preserved (empty `current` bucket → previous behaviour).
