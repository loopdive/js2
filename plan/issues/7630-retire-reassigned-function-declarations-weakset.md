---
id: 7630
title: "Retire `ctx.reassignedFunctionDeclarations`: one liveness source for reassigned functions"
status: ready
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: codegen
goal: core-semantics
depends_on: [7530, 7627]
related: [7530, 7627]
---

# #7630 — retire the reassigned-function WeakSet

Follow-up of #7627, filed at PRV-7620 round 3.

## Problem

After #7530 a reassigned top-level function is a live binding in #7470's table: `ModuleBinding.liveFunction` is
`"assigned"` or `"eval"`. #7627 adds the queries `liveFunctionBindingOf` / `isLiveFunctionDeclaration`
(`src/codegen/module-binding-liveness.ts`) over that binding.

The older `ctx.reassignedFunctionDeclarations` (`WeakSet<ts.FunctionDeclaration>`, `context/types.ts:3196`, filled
by `registerReassignedFunctionGlobals`, `index.ts:9221`) stays a second source of the same fact. It is read at these
sites, as found by `grep` at `ada18e6bb6`:

- `ir-overlay-preparation.ts:136`
- `multi-prepared-module-init-census.ts:281`
- `module-namespace-value.ts:491`
- `function-member-closure-planning.ts:288`
- `ir-imported-call-planning.ts:61` and `:99`
- `ir-prepared-free-functions.ts:522`
- `property-access.ts:3480`
- `identifiers.ts:1173`

#7627 moves `identifiers.ts:878` over. The two sources agree by construction today, but two sources can drift.

## Acceptance criteria

- **One source.**
  - Every reader asks `isLiveFunctionDeclaration` (or `liveFunctionBindingOf` where only `"assigned"` matters).
  - The WeakSet field and its fill in `registerReassignedFunctionGlobals` are deleted.
  - `grep reassignedFunctionDeclarations src` is empty.
- **Pin (red → green on the refactor's own guard).** A test asserts that, for each corpus program, the set of
  declarations the old WeakSet held equals the set `isLiveFunctionDeclaration` answers true for. It runs on the base
  before the deletion, and it is then deleted with the WeakSet.
- **gc output byte-identical** on #7530's three corpora (`sample3.txt`, `eval-sample.txt`, `reassign-sample.txt`),
  lodash-es and `tests/equivalence/`, base vs new, gc and standalone, IR on and off.
- **Code quality.** No new predicate. `src/ir` changes only where an IR-planning reader moves to the shared query.
  The budget gates pass.
