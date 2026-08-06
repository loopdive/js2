---
id: 4179
title: "top-level `with` statements are silently DROPPED from __module_init — the entire body never executes (collection allow-list gap, #2992/#3592/#3615 family)"
status: in-review
assignee: ttraenkler/W6-dynamic-scope
sprint: current
created: 2026-08-06
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: with-statement
goal: standalone-gap
related: [2663, 1387, 3025, 2992, 3592, 3615, 4133]
# The two collection arms live in collectDeclarations' module-init loop by
# necessity (the allow-list IS that function); the growth is 2 predicates +
# short pointers, not barrel spill.
loc-budget-allow:
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
origin: "2026-08-06 W6-dynamic-scope — probing the 30 S11.13.2_A5.*_T2/_T3 residuals L4 handed off as a 'module-scope struct-slot observability gap' (#2659 family). The observability frame was WRONG: the with body never ran at all."
---

# #4179 — top-level `with` never reaches `__module_init`

## TL;DR (root cause)

`collectDeclarations`' module-init collection (`src/codegen/declarations.ts`,
the source-order loop at ~1598) is an **allow-list of statement kinds**, and
`ts.WithStatement` was not in it. A module-level

```js
with (scope) { x *= 3; }
```

matched no arm and was **silently dropped**: no code emitted, body never
executed. Disassembly evidence: `__module_init` for a module whose only
statements were `var sB2 = mk(); with (sB2 || null) { x = 55; }` contained
exactly ONE instruction (`global.set (call $mk)`).

The same `with` inside a function body always worked — `compileStatement` →
`compileWithStatement` handles all three tiers (#1387 literal, #3025 W1
struct-typed, #2663 Tier-2 dynamic). This is the exact shape of the prior
collection-gap fixes: #2992 (top-level `delete`), #3592 (top-level `throw`),
#3615 (top-level bare property read).

## What the wrong frame was (measured, so nobody re-derives it)

L4's handoff attributed the `_T2`/`_T3` failures to the #2659 module-scope
struct-slot vs sidecar observability gap ("the RMW routes correctly, but the
final `scope.x` read-back still runs the getter"). Measured on current main
before this fix:

- the getter was **alive** at read-back (`scope.x === 2`) — i.e. the RMW read
  never invoked it, the `delete this.x` never ran, the write never happened;
- a side-channel probe (`with (s3) { capture(y); }`) showed the **call never
  executed** — not a storage-divergence symptom, an execution-never-happened
  symptom;
- direct member protocol on the same receivers (getter run, delete, recreate,
  read-back) is fully correct at module scope — the substrate was never the
  binding constraint for these tests.

Real substrate gaps that DO exist but were not the constraint here (left
open, see "Not fixed here"): `__extern_has` and `__extern_set` have no
closed-struct field arms (`__extern_set`'s is #4098 G1 stage 2 by design).

## Fix

Two arms in `src/codegen/declarations.ts`:

1. `ts.isWithStatement(stmt)` added to the control-flow collection allow-list
   (collects the statement into `ctx.moduleInitStatements`).
2. `walkModuleStmtForVars` recurses into `stmt.statement` for a
   `WithStatement`, so `with (o) { var v = …; }` hoists `v` to module scope.

Byte-identical for any module without a top-level `with`. The IR module-init
planner already includes `with` in its population and demotes to legacy
(body-shape rejection), so no IR-path interaction.

## Measured result (standalone, in-process runner + #4162 provider shim)

- Lever list (308 files, `.tmp/levers/W5-dynamic-scope.txt`): **1 → 41 (+40)**.
  Both `scope.x/innerScope.x Actual: NaN` buckets (15+15, the whole
  `S11.13.2_A5.*` / update-expression `_T2`/`_T3` families) flipped to pass.
- Full with-exposure population (391 files): **115 → 150 (+35 net)** — 45
  fixes, 10 pass→fail all of which are vacuous passes converting to honest
  verdicts (5 Tier-2 refusal compile_errors, 3 standalone-Proxy, 2
  @@unscopables edges). Itemized in `plan/agent-context/W6-dynamic-scope.md`.

## Not fixed here

- `__extern_has` has no closed-struct field arm — a struct-backed receiver
  that reaches Tier-2 (non-provable target shapes like `with (s || null)`)
  still misses HasBinding and cascades outward. Tier-1 W1 covers the dominant
  `var o = {…}; with (o)` pattern, so this is a narrow residue.
- `__extern_set` closed-struct write-through is #4098 G1 stage 2 (ordering
  law from #4010: deletability before visibility before write-through) — not
  touched here.
