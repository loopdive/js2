---
id: 5300
title: "from-ast: a direct call to an overloaded function has no exact AST-site plan — demotes `call-graph-closure` / `[unpatched-slot]` (the fifth masked issue-3519 test)"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [5262, 3519, 3521, 3518]
requested_by: ttraenkler/orchestrator
---

# Re-diagnosed while un-masking #5262

PR #5530 ([#5262](5262-ir-outcome-accounting-precedence-masks-root-cause.md))
restored four of the five skipped `issue-3519` tests. The fifth —
`counts only executable overload implementations…` — is **not** an accounting
failure. Re-measured with the accounting fix applied it fails on

```
ir/from-ast: direct call to "overloaded" has no exact AST-site plan in run
→ [unpatched-slot]
```

Source: `src/ir/from-ast.ts:6520-6526`. The direct-call lowering requires
`cx.directCalls.get(expr)` to hold a plan for the exact call-site node; when
the callee is a TypeScript **overloaded** function (one or more overload
signatures plus one implementation), the call-graph planner records the plan
against a different node (or against the implementation declaration's
signature rather than the resolved overload), so the site lookup misses and
the unit demotes with `call-graph-closure`. The test's skip comment was
rewritten in place in #5530 to name this cause so the next reader is not sent
back to #5262.

First step for the implementer: establish **which** of the two mechanisms
it is — plan keyed on the wrong node, or plan never created for overloaded
callees — by dumping `cx.directCalls` keys for the fixture; the fix differs.

## Acceptance criteria

1. The fifth `issue-3519` test un-skipped and green; its cause recorded as
   measured (which mechanism).
2. `check:ir-fallbacks`: the `call-graph-closure` unintended bucket must not
   grow; if the planner change moves any playground file, record the per-file
   delta with `--verbose`.
3. Byte identity for programs with no overloaded callees (per-row sha256 on the
   dogfood corpus, both lanes); pinned test red on base; equivalence shards
   clean by name.
4. `check:ir-only` READY not regressed.

## Conflict surface

`src/ir/from-ast.ts` (direct-call lowering) and the call-graph planner that
fills `directCalls` (find via `directCalls` writers in `src/ir/`). Disjoint
from the R2 accounting files.

## Implementation Plan

Written 2026-09-03 by the Fable lane from a read of `src/ir/imported-functions.ts`,
`src/ir/ast-lowering-plans.ts`, `src/ir/integration.ts` and `src/ir/from-ast.ts`
at `origin/main` `68246a740c`. The "which mechanism" question in the issue body
is answered by source, but the implementer must still confirm it by the probe
in step 1 before changing anything.

### Mechanism (reasoned from source; confirm in step 1)

The plan is **never created**, not keyed on the wrong node. Resolution chain
for `overloaded(value)` inside `run`:

1. `from-ast.ts:6520` — `cx.directCalls.get(expr)` misses → demote
   `call-graph-closure` with the "no exact AST-site plan" message.
2. `cx.directCalls` is filled by `makeIrDirectCallReconciler.collect`
   (`integration.ts:2235-2270`), which merges
   `collectIrDirectCallLoweringPlansByIdentity` (source units) and
   `collectIrDirectCallLoweringPlans` (compatibility targets).
3. The identity path (`ast-lowering-plans.ts:274`) calls
   `resolver.resolveTopLevelFunctionValueTarget(node.expression)`.
4. That resolver's `targetForSymbol` (`imported-functions.ts:367-394`)
   collects the symbol's `FunctionDeclaration`s and **returns `undefined`
   when there is not exactly one** (L372-375, comment: "Overload sets and
   declaration merging are outside this exact slice"). The fixture has two —
   one signature, one implementation — so no target, no plan.
5. The compatibility path only fires for targets whose binding is not `unit`
   (`integration.ts:2231`), so it cannot rescue a same-file source unit.

Unit *inventory* is already right: the terminal for the overload set is the
bodied declaration (the `!declaration.body` guard at `integration.ts:1760`
and the `terminal(result)` list the test expects — `["overloaded", "run"]`).
Only the call-site plan is missing.

### Change

In `targetForSymbol` (`imported-functions.ts`), admit an **overload set** under
these exact conditions, otherwise keep returning `undefined`:

- all `FunctionDeclaration`s of the symbol live in the **same** source file
  (already required per-declaration below; make it a set-level check);
- exactly **one** has a `body` — that is `declaration`; every other one is
  a bodiless overload signature (no `declare` modifier, not in a `.d.ts`);
- `target.valueDeclaration === declaration` (the existing L387 guard, now
  meaningful: TS sets `valueDeclaration` to the implementation);
- the signatures are **lowering-compatible**: every overload signature has
  the same parameter count and the same `ctx.oracle`-resolved IR parameter
  and return types as the implementation. This keeps the direct-call
  signature check at `ast-lowering-plans.ts:295-296`
  (`closureSignatureEquals(retained.signature, expectedSignature)`) honest —
  the IR emits ONE callable, so a call resolved by TS to a narrower overload
  must still land on the implementation's physical signature. A set whose
  overloads differ in arity or IR type is **refused with a new, precise
  reason** (`overload-signature-divergent`, recorded via the existing
  R2 withdrawal vocabulary or the from-ast demote reason — pick the channel
  the sibling `call-graph-closure` uses so `check:ir-fallbacks` buckets it).

Do not touch `collectIrDirectCallLoweringPlans` or the reconciler; the plan
flows through them unchanged once the resolver returns a target.

### Measurement order

1. **Probe on base** (`.tmp/probe-5300.ts`): compile the fixture from
   `tests/issue-3519-ir-outcomes.test.ts:265-277` with `trackIrOutcomes` and
   dump (a) the `directCalls` map keys for `run` (patch a temporary
   `console.error` at `integration.ts:2267`, not committed) and (b) the
   return of `targetForSymbol` for the `overloaded` identifier. Expected:
   (a) empty for the `overloaded(value)` site, (b) `undefined` from L375.
   Record it in the PR body; if (b) returns a target, the mechanism is
   different and the plan must be re-derived before any edit.
2. Capture base copies of `imported-functions.ts` at first edit.
3. Implement; un-skip the fifth `issue-3519` test; run it → green.
4. Add the divergent-overload negative case (see tests) → refused with the
   new reason, not `call-graph-closure`.
5. `pnpm run check:ir-fallbacks -- --verbose` before/after: the
   `call-graph-closure` unintended bucket must not grow; if any playground
   file now admits an overloaded callee, record the per-file delta. If a
   bucket shrinks, use `--update-on-decrease` and prettier-format the baseline.
6. Byte identity: per-row sha256 over the 34-case dogfood corpus and the
   playground examples, gc + standalone; every row without an overloaded
   callee identical. Rows that move (a program with an overload set that now
   prepares) listed explicitly with the before/after outcome code.
7. Equivalence, 8 shards by name; `check:ir-only` READY not regressed;
   full ratchet chain with `LOC_GATE_BASE=origin/main`.

### Tests

- Un-skip `counts only executable overload implementations and ignores
  ambient signatures` (red on base, proven by the skip's own history and
  re-measured in step 1).
- New `tests/issue-5300-overload-call-site-plan.test.ts`:
  (a) same-file overload set with compatible signatures → `run` reaches
  `emitted` and the `overloaded(value)` site carries a direct-call plan (assert
  via the outcome ledger's prepared/emitted row, not via internals);
  (b) overload set whose second signature has a different arity
  (`function f(a: number): number; function f(a: number, b: number): number;
  function f(a: number, b?: number) {…}`) → refused with the new precise
  reason; (c) `declare function ambient` still ignored. (a) and (b) red on
  base by construction ((b) currently reads `call-graph-closure`).

### Budget and conflict surface

`src/ir/imported-functions.ts` (+~25 LOC, grant in this issue's frontmatter
with dated rationale), one test file, the un-skipped test. Disjoint from the
R2 accounting files and from #5297/#5299. No oracle-ratchet impact if the
signature comparison reuses `ctx.oracle.signatureOf` — do not call
`checker.getTypeAtLocation` directly.
