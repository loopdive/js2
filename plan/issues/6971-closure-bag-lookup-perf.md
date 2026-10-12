---
id: 6971
title: "standalone: instances of an ON-DEMAND fnctor (escape-gate-unapproved constructor) have no `$bag` slot, so every one that grows a property is prepended to the never-pruned `$ClosurePropEntry` registry and every bag lookup walks it (Octane deltablue ~35 % in `__closure_bag_lookup`)"
status: in-progress
sprint: current
created: 2026-10-11
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: perf
area: compiler
language_feature: constructor-functions, expando-properties
goal: standalone-gap
related: [874, 4241, 6961, 6964, 6966, 6967, 6968]
# 2026-10-11: +2 lines in new-super.ts (one import, one call) and +1 line in
# compileNewFunctionDeclaration — the on-demand fnctor registration gets the same
# `appendInstanceBagSlot` the up-front reservation already applies (#6971).
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewFunctionDeclaration
---

# On-demand fnctor instances fall to the global closure-bag registry

Found by the Octane standalone triage (Session D, 2026-10-11). With #6966 in,
deltablue runs correctly on standalone but takes ~139–157 ms/rep (node: 73 µs),
so the harness times out.

## Profile (base = `c-octane-integ`, 30 reps, top self)

`__closure_bag_lookup` 35.3 %, `__extern_get` 16.7 %, `__obj_find` 5.1 %,
`__closure_bag_ensure` 4.9 %, `__is_closure_prop_carrier` 3.0 %. Callers of the
lookup: 17 % `__extern_set` inside `Constraint` (the superclass ctor writing
`this.strength` through the generic setter, reached via
`X.superConstructor.call(this, …)`), ~30 % `__extern_get`/`__instance_prop_get`,
~13 % `__carrier_bag_of`/`__carrier_bag_has`.

## Root cause — same shape as #6961 / #6964

`__closure_bag_lookup` / `__closure_bag_ensure` (`closure-props.ts`,
`fillCarrierBagHelpers`) answer a SLOTTED carrier with one `struct.get $bag`, and
every other carrier by walking a global singly linked `$ClosurePropEntry` list
from `closurePropHeadGlobal` with `ref.eq`. `ensure` prepends on a miss; nothing
ever removes an entry. #4241 step 1b gave the `$bag` slot to fnctors reserved
up front (`reserveFnctorStructTypes` → `appendInstanceBagSlot`), but the
ON-DEMAND registration in `new-super.ts` (a constructor the escape gate did not
approve) builds its struct from `deriveFnctorFields` alone — no slot.

Dumping the carrier split for deltablue (temporary debug print in
`fillClosurePropHelpers`) showed exactly those on-demand structs on the registry:
`__fnctor_EqualityConstraint`, `__fnctor_StayConstraint`,
`__fnctor_ScaleConstraint` (plus `__fnctor_Benchmark`, `__fnctor_BenchmarkSuite`,
`__Date`). deltablue builds thousands of constraint instances per rep with bare
`new EqualityConstraint(prev, v, …)` statements (the escape gate does not approve
them), and each one's superclass constructor writes `this.strength`,
`this.myOutput`, … through the generic setter → one new registry entry per
instance, kept forever. Every later bag lookup on any slotless receiver — and
every miss — walks the whole list.

## Fix

Call the same `appendInstanceBagSlot` on the on-demand path (exported from
`linear-type-reservations.ts`). The single allocation site
(`emitFnctorFieldInitializers`) iterates the field list and defaults an
`externref` to null, so the `struct.new` arity stays right with no other edit;
the bag helpers discover slotted instance carriers by the `$bag` field NAME over
`ctx.structFields`, which the on-demand path already populates. Standalone-only
(`appendInstanceBagSlot` returns on a non-standalone ctx), so host output is
byte-identical. Files: `src/codegen/linear-type-reservations.ts` (export + a
comment), `src/codegen/expressions/new-super.ts` (one call + import). Test:
`tests/issue-6971-ondemand-fnctor-bag-slot.test.ts` (the layout pin fails on
base; the semantic cases pass on both and match node).

Not done, deliberately: the registry itself stays for the remaining slotless
carriers (`__Date`, `__StandaloneRegExp`, eval AOT carrier). None of them is
allocated per-iteration in the measured benchmarks.

## Measurements (2026-10-11, 4-vCPU box shared with other agents — ±15 % noise)

Measured on a throwaway local branch = `c-octane-integ` + #6967/#6968
(`claude/standalone-raytrace-proto-fixes`) ± this commit, Script goal,
`inferModuleStrictArguments: false`, `runtimeEvalProvider: false`.

| deltablue standalone             | base             | head               |
| -------------------------------- | ---------------- | ------------------ |
| per-rep, 2 / 10 / 30 reps (ms)   | 121 / 137 / 159  | 92 / 112 / 100     |
| heap after gc, per 5-rep batch   | 6.3→8.2→10.0→11.9 MB (leaks ~0.37 MB/rep) | 4.9 MB flat |
| `__closure_bag_lookup` self      | 35.3 %           | 6.1 % (no walk)    |
| harness row (node-calibrated)    | skipped: timeout after 1800 s (658 reps — the registry grows with every rep, so a long run is superlinear) | pass, 703 reps, min 77.5 ms/run, score 79 (node 78047, min 75 µs) |

The harness default `--run-timeout 180` still skips the row (703 × ~80 ms × 6
calls); the head row above used `--run-timeout 900`.

raytrace is NOT this cause: `__closure_bag_lookup` is not in its profile, and its
per-rep time is unchanged (base 371/435 ms at 2/6 reps, head 397/470). Its
real problem is a separate leak — ~29 MB retained per rep, so the harness row
dies with a V8 heap OOM (SIGABRT). Minimized: a `Class.create`-style
constructor `function () { this.initialize.apply(this, arguments); }` retains
~400 B per construction (100 k constructions → +40 MB after gc, time per batch
growing); `apply(this, [a, b, c])` and `arguments[i]` reads do not leak. Needs
its own issue.

## Remaining (not this change)

Status stays `in-progress`: the dominant cost and the leak are gone, but deltablue
is still ~1000x node. After the fix the profile is general object-model dispatch: `__extern_get`
~27 % self (recursive prototype walk — deltablue methods live two or three
`Inheriter` levels up, and each level is a full `__extern_get` dispatch),
`__obj_find` ~8 %, `__closure_bag_lookup` ~6 % (now the slotted `ref.test`
chain, not a walk), `__is_closure_prop_carrier` ~5 % (a ~25-arm `ref.test`
chain), `__fnctor_proto_start` ~4 %. Per-rep time is flat across 2/10/40 reps,
so nothing grows any more. Closing the remaining ~1000x needs inline caching or
typed method dispatch on the prototype chain — an object-model change, out of
scope here.
