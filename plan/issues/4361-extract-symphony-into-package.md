---
id: 4361
title: "Extract scripts/symphony.mjs (66 KB, untested) into packages/symphony — redo against current main"
status: ready
sprint: current
created: 2026-08-10
updated: 2026-08-10
priority: medium
horizon: l
feasibility: medium
task_type: refactor
area: tooling
goal: maintainability
related: [4334, 3288]
---

# Extract the symphony orchestrator — redo, do not merge #4334

Salvaged from #4334, closed as unmergeable but **not superseded**. The idea is
worth doing; that branch's diff is not.

`scripts/symphony.mjs` is a **66 KB single-file orchestrator** with **no test at
all** on main. #4334 proposed splitting it into `packages/symphony/` with
`lib/{orchestrator,workflow,dispatch-state,yaml,util}.mjs`, its own
`package.json`, LICENSE/README, and a 192-line test suite.

## Why #4334 could not be merged forward

- **`packages/symphony/` does not exist on main** — only `packages/js2wasm/`.
  It was never a merge; it introduces a layout that never landed.
- **The orchestrator moved 10 substantive commits** since the branch's
  2026-07-03 base, none cosmetic: continuation-slice isolation on fresh
  branches, retry preservation after idle continuation (#3288),
  prerequisite-branch rolling between owners (#3288), scoped sprint
  dependencies (#3288), Porffor backend workflow scoping (#3288), multi-slice
  continuation, PR discovery from agent branches, agent-PR reconciliation.
- The PR **deletes 740 lines from that exact file while renaming it**, so git
  sees a rename+modify conflict with substantial changes on both sides.
  Resolving it means hand-porting those 10 commits into a new module layout —
  re-implementation wearing a merge's clothing, with a live orchestrator as the
  blast radius.
- `plan/method/symphony-service.md` also conflicts: main has since grown an
  "Agent Lanes" section (Codex/Claude lanes, `claude-channel`, `.mcp.json`
  wiring) the branch's older doc has no notion of.

## What to carry over — the shape, not the diff

1. The `lib/` split (`orchestrator` / `workflow` / `dispatch-state` / `yaml` /
   `util`), re-derived from **today's** `scripts/symphony.mjs`.
2. **`tests/symphony.test.ts`** — arguably the most valuable artefact in #4334
   and worth lifting **first and independently of the refactor**. A 66 KB
   orchestrator driving agent dispatch, branch rolling and PR reconciliation
   currently has zero coverage; landing tests against the current file would
   also de-risk the extraction by giving it something to verify against.

Reference for the intended structure: branch `codex-symphony-npm-package`
(#4334). Do not merge it.

## Suggested order

1. Land `tests/symphony.test.ts` against the **current** `scripts/symphony.mjs`,
   adapting as needed.
2. Then extract into `packages/symphony/`, with those tests as the safety net.
