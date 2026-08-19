---
horizon: m
id: 4037
title: "ESLint: `new K(...x)` needs the up-front-reserved $ObjVecArr type, which was not reserved"
status: done
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
assignee: ttraenkler/claude
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: spread
goal: npm-library-support
sprint: 78
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [53, 1282, 2026, 4033]
---

# #4037 — `$ObjVecArr` not reserved for a module that needs dynamic `new K(...x)`

## Problem

One of the blockers now preventing an ESLint binary, surfaced once the hard
codegen abort chain (#4018, #4019, #4027, #4028, #4033) was cleared:

```text
Dynamic `new K(...x)` runtime-argv needs the up-front-reserved $ObjVecArr type
(#2026 #53), which was not reserved for this module.
```

Three occurrences on the ESLint package entry.

## Analysis

`$ObjVecArr` must be reserved **up front** — before the module's type table is
finalised — for any module that will lower a dynamic `new K(...spread)`. The
reservation decision and the lowering that depends on it disagree: the lowering
runs, the type was never reserved, and the compile reports the mismatch.

Likely the reservation scan does not consider the construct in whatever position
ESLint uses it (e.g. inside a nested function, a class method, or reached only
through the multi-source body loop), so the up-front pass misses it while the
body pass still emits it.

## Acceptance criteria

- A reduced fixture reproduces the message without ESLint.
- The reservation scan and the lowering agree: any module whose bodies can emit
  a dynamic `new K(...x)` reserves `$ObjVecArr` up front.
- ESLint's package entry no longer reports this diagnostic.
- Note whether the reservation is safe to make unconditionally — an always-on
  reservation costs one type-table entry and would remove the whole class of
  disagreement, which may be preferable to widening the scan.

## Root cause (2026-08-02) — missing multi-source parity, not a scan gap

The single-source path reserves the type:

```ts
if (sourceContainsClass(ast.sourceFile)) reserveObjVecArrType(ctx);
```

`generateMultiModule` had **no such call at all**. So the reservation never
happened for ANY multi-source graph, and every dynamic `new K(...x)` in one hit
the guard. The guard's own comment called itself "defensive — every class-bearing
source reserves it", which was true only of the single-source path.

## Fix

`generateMultiModule` reserves when **any** source declares a class, gated the
same way so class-free graphs stay byte-identical, and placed before
`collectDeclarations` (hence before any body compiles) so the type index is fixed
at one deterministic point for every pass that reads it.

## Verification

`tests/issue-4038-jsdoc-nameless-param.test.ts` compiles a cross-module
`new K(...args)`, instantiates it and asserts `run() === 3`.

The ESLint graph's three `$ObjVecArr` diagnostics are gone.

**Caveat on the test's strength**: the rung passes on the unfixed base too,
because a statically-resolvable `new K(...)` takes the static path rather than
the runtime-argv one. Two attempts at a small graph that forces the dynamic path
(ternary-selected constructor in TS, and an `any`-typed constructor factory in
JS) also failed to reproduce. The real evidence for this fix is the ESLint graph
itself; the rung guards the runtime behaviour rather than the defect. Naming a
fast reproducer is the follow-up.
