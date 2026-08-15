---
id: 4479
title: "ES5 standalone: plain-object property-descriptor attribute semantics — defineProperty/defineProperties/create/gOPD on $Object receivers (~90 rows)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: standalone-gap
related: [3251, 1113, 1334, 1460, 1462, 4426]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. built-ins/Object bucket = 122 ES≤5 standalone failures; the plain-object descriptor lane is the dominant coherent slice."
---

# #4479 — plain-object descriptor attribute semantics

## Problem

`built-ins/Object` carries 122 ES≤5 standalone failures; the dominant slice
is §8.12.9/§15.2.3.6-7 semantics on PLAIN `$Object` receivers: attributes
(`writable`/`enumerable`/`configurable`) are not stored or enforced, gOPD
answers wrong shapes, `Object.create(proto, props)` ignores descriptors.
Measured signatures: `result !== true` (7), `Expected "a === 10", actually 0`
(5), `foo descriptor value should be undefined` (4), `Expected obj[0] to
equal 0, actually null` (3), plus a long tail of one-offs in
`defineProperty` (52 files), `defineProperties` (26), `create` (12),
`getOwnPropertyDescriptor`, `prototype/` rows.

**Scope boundary (load-bearing):** #3251 (in-progress, another lane) owns the
ARRAY-index overlay — `$Vec` receivers, per-index descriptor storage. This
issue is the `$Object` (and object-literal struct) receiver lane ONLY. Do not
touch `$Vec` dispatch; where a test needs both, fix the `$Object` half and
record the `$Vec` half as #3251's.

The stale issues #1113/#1334/#1460/#1462 described this lane in older terms;
this issue supersedes them (cite in their files if you close them).

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`).
   Bucket the ~90 non-array rows yourself into: (a) attribute ENFORCEMENT on
   write/delete/enumerate, (b) gOPD answer shape, (c) `Object.create` with
   props, (d) accessor descriptors (get/set installation), (e) redefinition
   validation (§8.12.9 rejections → TypeError).
2. Read the existing storage first: how `$Object` stores properties today
   (`src/codegen/array-object-proto.ts`, the `__obj_*` runtime natives, the
   #1888/#4455 accessor-install machinery — accessors on class prototypes
   ALREADY store get/set pairs; the pattern likely generalizes). Find where
   `Object.defineProperty` lowers (grep `defineProperty` under src/codegen/).
3. Design the smallest attribute store that covers (a)+(b): most tests need
   attributes REMEMBERED and ENFORCED at the `$Object` write/read/delete
   sites plus gOPD. A per-property flags side-slot on the `$Object` property
   table is the obvious shape; measure its cost on the no-descriptor fast
   path (byte-identity on modules that never call defineProperty is the
   control).
4. Slice the work: land (a)+(b) first (bulk of rows), then (c), then (e).
   (d) accessors reuse #4455's install path.
5. Acceptance floor: ≥45 of the ~90 non-array rows flip; zero regressions in
   `built-ins/Object` scoped sweep + object-literal equivalence per-file
   subset; byte-identity control on descriptor-free modules.

## Acceptance criteria

- ≥45 rows flip standalone in `built-ins/Object/{defineProperty,
  defineProperties,create,getOwnPropertyDescriptor}` excluding array-index
  files; zero regressions; residuals recorded with owners (#3251 for $Vec).
