---
id: 7366
title: "An uninitialised `number | undefined` module global or class field reads `0` instead of `undefined`"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-19
completed: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7360, 4489, 5312]
---

# #7366 — an uninitialised `number | undefined` f64 slot starts as `0`

## Problem

Found while fixing #7360. A `number | undefined` value in an f64 slot carries `undefined` as the
`UNDEF_F64_BITS` sentinel, and #7360 made `??`/`??=` read it. Two slot kinds never get the sentinel when the
program leaves them uninitialised; they start as `0`:

```ts
let g: number | undefined;
export function main(): number { return g === undefined ? 1 : 2; } // node 1; we return 2
class C { a: number | undefined; }
new C().a === undefined; // node true; we answer false
```

Measured on `claude/7360-nullish-f64` (80908eb248), default and `--target standalone` alike:

| slot | before |
| --- | --- |
| module `let g: number \| undefined;` (`===`, `??`, `typeof`) | reads `0` |
| module `var g: number \| undefined;` (top level, in a block, read before the declaration) | reads `0` |
| never-initialised field `a: number \| undefined` (public, private, subclass, read in the constructor before its assignment) | reads `0` |
| local `let`/`var`, closure-captured local, optional field `a?: number`, static field | correct already |

## Cause

- **Module globals.** `registerModuleGlobal` gives an f64 global the constant initializer `f64.const 0`. The
  #4489 prologue seed (`declarations/module-var-undefined-seed.ts`) writes `undefined` into a `var`'s slot
  before the first statement, but only into externref slots; it records the f64 case as a residual.
- **Fields.** `FieldDef.undefinedDefault` (the sentinel default) was set only for an optional field
  (`a?: number`), not for one whose type admits `undefined`.

## Implementation Plan

Legacy codegen only (no `src/ir/` change).

- **One predicate.** Both fixes ask #7360's `f64MayHoldUndefined` (`value-tags.ts`; its node parameter is
  widened from `ts.Expression` to `ts.Node` so a declaration name can be passed).
- **Module globals — `declarations/module-var-undefined-seed.ts`, next to the #4489 seed.**
  `emitModuleF64UndefinedSeeds` stores the sentinel into each initializer-less module-scope `var` (same region
  walk as #4489, same Script-record exclusion) and top-level `let` whose f64 global can hold `undefined`. It runs in
  the module-init prologue right after the externref seed. A global initializer is a constant expression and
  `f64.const` cannot carry the signaling-NaN bits reliably, so the value is stored, not initialised.
  `moduleInitPrologueMayEmit` asks the same target list (`moduleF64UndefinedSeedGlobals`), so the routes that cannot
  run the prologue still refuse instead of dropping the seed.
- **Reuse, not a second walk.** `recordScriptVarBindingNames`'s region walk becomes
  `forEachScriptVarDeclaration` in `source-scan-predicates.ts`; the name set and the f64 seed both use it.
- **Fields — `uninitialised-field-undefined.ts`.** `fieldStartsUndefined(ctx, declaration, fieldType)` replaces
  the two copies of the `questionToken && !initializer && f64` test in `class-bodies.ts`: optional, or typed to
  admit `undefined`, never initialised.
- **`let`.** The TDZ flag still guards reads before the declaration; the seed is the value its `let g;` binds.
- **Quality criterion.** One predicate for "this f64 slot may hold `undefined`" (shared with #7360), one region
  walk, one field-default test; no new sentinel emitter.

## Result (2026-11-19)

- `tests/issue-7366-uninitialised-f64-undefined.test.ts`: 18 programs × gc/standalone, answers from node.
  Before: 26 of 36 fail (13 shapes); after: 36/36. Plain `number` slots, locals, optional and static fields were
  already right and stay so.
- Byte identity: 100 test262 files × gc/standalone, binaries identical (200/200); their untyped `var`s use
  externref slots, which this change does not touch.
- Gates: loc/func budget (also with `LOC_GATE_BASE=origin/main`), coercion sites, oracle ratchet, dead exports
  pass.
