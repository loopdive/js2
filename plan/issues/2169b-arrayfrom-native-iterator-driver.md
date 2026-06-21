---
id: 2169b
title: "Standalone Array.from(<native array iterator>) — __iterator driver struct.new index desync (invalid struct index)"
status: done
sprint: 64
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
assignee: ttraenkler/sdev-iter
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: iterators-collections
goal: standalone-mode
parent: 2169
---

# Standalone `Array.from(<native array iterator>)` — `__iterator` struct.new index desync

## Problem

On standalone (`--target wasi`), `Array.from(x)` over **any native array
iterator** VALIDATE-FAILs:

```ts
Array.from([10, 20].values()); // VFAIL: __iterator failed: invalid struct index: 34
Array.from([10, 20].keys()); // VFAIL: invalid struct index: 34
Array.from([10, 20].entries()); // VFAIL: invalid struct index: 37
Array.from([10, 20]); // OK (plain array — does not go through __iterator)
Array.from(new Set([7])); // separate VFAIL: struct.new need 4 got 2 (Set path — out of scope, #2162)
```

`[...arr.values()]` array-spread is fine (#2162b path); only the `Array.from`
consumer routes the canonical externref `$Vec` through the native `__iterator`
driver, which is where the break is. **Not entries-specific** — `.values()` /
`.keys()` fail identically (the index differs only because entries registers
extra `$ObjVec` types).

## Root cause (CONFIRMED — shared-array aliasing → DCE double-remap)

`buildIteratorBody` (`src/codegen/iterator-native.ts`) returns the `__iterator`
body as `{ op:"if", then: vecArm, else: elseArm }`, and on the vec-only
registration path (`deps === undefined`, the body that ships for `Array.from`)
`elseArm = vecArm` — **the SAME `Instr[]` array object**, so the SAME
`struct.new $__IterRec` instruction object is referenced by BOTH `then` and
`else`.

DCE (`eliminateDeadImports`) removes dead types and mutates each function body
**in place** via `remapTypeIdxInBody` (`dead-elimination.ts`). Its walk visits the
shared `struct.new` instruction TWICE (once via `then`, once via `else`) and
applies the type remap each time. The remap table `tR` happens to contain a
CHAIN — `46→40` AND `40→34` — so the two in-place applications compose:
`46 → tR.get(46)=40 → tR.get(40)=34`. The body lands at `struct.new 34`
(`$__box_boolean_struct`, a 1-field struct) while the `$__IterRec` type-def —
remapped once via `surv.map(remapTD)` reading the original — correctly lands at
`40`(/32 after later compaction). V8: `invalid struct index` (4 fields pushed at
a 1-field struct).

Object-identity probe (single compile, body tagged): DCE-entry body=`[46,46]`,
`tR.get(46)=40`, `tR.get(40)=34`; SAME body object after DCE's loop=`[34,34]`;
emit=same body, `[34,34]`. Confirms one shared array, double-applied.

This is the [[reference_no_rebuild_helper_body_at_finalize]] family. The
**localized** fix (what this PR does): a `buildVecArm()` factory so `then` and the
`deps===undefined` `else` each get a FRESH array + FRESH `struct.new` object —
DCE then walks two distinct instructions, each remapped exactly once. Non-iterator
paths are WAT-byte-identical (the change only differs where the chained-remap type
shape exists). `buildIteratorNextBody`'s `vecStep` is NOT aliased (its `...vecStep`
spread and `else: vecStep` are mutually-exclusive `!deps` branches), so no fix
needed there.

**Latent root hazard (flagged separately, NOT fixed here):**
`remapTypeIdxInBody`'s in-place chained remap is non-idempotent — ANY aliased
body double-remaps. The durable fix is to make the DCE body remap idempotent
(skip an instruction already mapped this pass), but that changes the global DCE
remap contract → architect-routed follow-on, not this PR.

## Honest scope (this PR)

The de-alias **fixes the `__iterator` driver miscompile** (the VALIDATE-FAIL).
It is byte-identical elsewhere and unblocks the native-iterator path. It does
**NOT** by itself make `Array.from(<native iterator>)` zero-host: once the driver
validates, `Array.from(iter)` routes through the `__array_from` **host import**
(`index.ts:1626`, "host `Array.from`"). Making standalone
`Array.from(<native iterator>)` zero-host needs a **native `__array_from`** that
drains the now-valid `__iterator` — a separate, larger producer slice (the
original #2169 scope; dev-typed's stale claim). Filed as the follow-on.

## Scope

In scope: `Array.from(<native array iterator>)` (`.values()`/`.keys()`/
`.entries()`). Out of scope: `Array.from(new Set(...))` (Set producer, separate
`struct.new need 4 got 2` bug → #2162 Map/Set lane); the Map-iterator producer
(`[...m.entries()]`/bare `[...map]`, #2162 / task #8).

## Regression-guard strategy (REQUIRED, before AND after)

- WAT-diff a plain `Array.from([1,2])` (the non-iterator path) byte-identical.
- Full local iterator/spread/destructure suites (issue-2169-_, issue-42-_,
  for-of-\*, basic/array-rest-destructuring).
- `pnpm run check:ir-fallbacks` OK. Hard floor-gate the standalone HW shard.
- Helpers BY NAME (#2191). No funcIdx captured before a later import-adding phase.

## Source

Root-caused 2026-06-18 (sdev-iter), filed as a distinct issue from the landed
#2169 native-array-iterator slice (whose dev-typed claim is stale: no remote
branch, no PR). This is a separate `__iterator`-driver type-index desync, not the
#2169 producer work.
