---
horizon: s
id: 4019
title: "Self-referential types recurse until the stack dies in the IR object-shape walk"
status: done
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
assignee: ttraenkler/claude
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: bug
area: compiler, codegen
language_feature: type-mapping
goal: npm-library-support
sprint: 78
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1169, 1282, 3672, 4001, 4018]
---

# #4019 — cycle guard for the IR object-shape walk

## Problem

With #4018 fixed, the ESLint `linter.js` compile advanced and then aborted on:

```text
Codegen error: Maximum call stack size exceeded
```

An opaque hard error with no indication of where it came from, and no binary.
Raising `--stack-size` to 8000 did **not** help (526 s, identical failure) —
which is the tell that the recursion is unbounded rather than merely deep.

## Root cause

`objectIrTypeFromTsType` and `tsTypeToFieldIr` in `src/codegen/index.ts` call
each other with no cycle detection:

- `objectIrTypeFromTsType` walks a type's properties and calls
  `tsTypeToFieldIr` for each,
- `tsTypeToFieldIr` calls `objectIrTypeFromTsType` back for any
  `TypeFlags.Object`.

A self-referential type — `interface Node { parent: Node }`, and its many
structural equivalents throughout real npm `.d.ts` files — descends forever.
Captured stack (repeating pair, trimmed):

```text
RangeError: Maximum call stack size exceeded
    at isDeclareContext (src/checker/type-mapper.ts:202:21)
    at isExternalDeclaredClass (src/checker/type-mapper.ts:164:11)
    at objectIrTypeFromTsType (src/codegen/index.ts:1110:7)
    at tsTypeToFieldIr (src/codegen/index.ts:1144:45)
    at objectIrTypeFromTsType (src/codegen/index.ts:1126:21)
    at tsTypeToFieldIr (src/codegen/index.ts:1144:45)
    …
```

The `RangeError` is caught by the codegen `try`/`catch`, relabelled
`Codegen error: …` and aborts the whole compile — so one recursive interface
anywhere in a dependency graph takes the entire program down.

## Fix

Thread a path-scoped `onPath: Set<ts.Type>` through both functions. Re-entering
a type already on the current descent returns `null`.

`null` is the established "the IR cannot represent this — fall back to legacy"
signal, and it is the **correct answer on the merits**, not just a safety valve:
`IrObjectShape` is a finite, flat field list, so a cyclic type has no finite
expansion to produce.

The set is **path-scoped** — the type is removed on the way out — so a type
reached twice through two sibling fields is still expanded normally. Only a
genuine cycle is rejected. A visited-ever set would have silently widened the IR
fallback surface for ordinary shared types.

## Verification

`tests/issue-4018-ambient-tdz-and-type-cycles.test.ts` — three cycle shapes
(direct self-reference, mutual recursion, three-cycle) plus two guard-on-the-guard
rungs.

Non-vacuity confirmed on the unfixed base: all three cycle rungs fail there with
`expected [ Array(1) ] to deeply equal []`, the array holding the
`Maximum call stack size exceeded` error.

The two guard-on-the-guard rungs deliberately pass on **both** sides — an
over-aggressive cycle check is a silent coverage/correctness loss rather than a
crash, so they are checked by **running** the module, not merely compiling it:

- an acyclic shape shared by two sibling fields computes `5`,
- a cyclic shape routed to the legacy fallback still computes `10`.

Behaviour is the oracle here because `irCompiledFuncs` is empty for both shapes
and so cannot discriminate which lowering path ran — stated explicitly in the
test rather than left as an implied stronger claim.

## Follow-up

The `Maximum call stack size exceeded` diagnostic carried no location. A
`RangeError` escaping into the generic codegen catch is always a compiler bug,
and reporting it without the throwing site cost a full instrumented re-run to
localise. Worth attaching the stack (or at least the innermost `src/` frame) to
that diagnostic under a debug flag.
