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
# 2026-11-19 (RV7320 round 1): the `for (let g: number | undefined; …)` head seed is a small helper next to
# `compileForStatement` (+17 in loops.ts, so the 586-line function grows by one call, not by the arm), and the
# "module init has work" test in `compileDeclarations` must count the f64 seeds (+2 in declarations.ts: an import and
# one wrapped line; +1 in the function, which already sits at its ceiling).
loc-budget-allow:
  - src/codegen/statements/loops.ts
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/declarations.ts::compileDeclarations
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
| local `let`/`var`, closure-captured local, optional field `a?: number` | correct already |

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

## Review round 1 (RV7320, 2026-11-19, on 76b75507f7) — verdict BLOCKER

| finding | answer |
| --- | --- |
| MUST-FIX: `class A { a: number \| undefined } class B extends A { y = 2 }` gives `new B()` `__tag` 0 (`instanceof B` false, A's method dispatched, `b.a ?? 7` throws); pre-existing for `a?: number` bases. | **Fixed at the root.** `fixupStructNewArgCounts` (`fixups.ts`) counts the default values in front of a `struct.new` by walking back over constants, and it treated `f64.reinterpret_i64` as the end of the run. The sentinel default `i64.const UNDEF_F64_BITS; f64.reinterpret_i64` was therefore never counted, the struct looked short by every field before it, and the pad it inserted shifted the tag. A converter (`ref.as_non_null`, `f64.reinterpret_i64`) rewrites the value under it and is now skipped like `ref.as_non_null` always was; the emission is unchanged. `tests/issue-7366-derived-class-field-default.test.ts`: `a: number \| undefined` and `a?: number` fields, 1–3 levels deep, uninitialised field first or last, checking `instanceof` along the chain, override dispatch, the field reading `undefined` and a later assignment, gc + standalone. |
| `class C { a: number \| undefined; y = 2 }` still reads 0. | **Fixed** by the same rewrite. |
| Module vars in non-entry files are not seeded. | **Fixed:** `moduleF64UndefinedSeedGlobals` walks every source of the graph (`ctx.callableSourceFiles`), because one `__module_init` runs them all. Tests: a `let` / `var` of an imported file, `let`s of three files. |
| A top-level `for (let g: number \| undefined; …)` and a hoisted `var g: number \| undefined = 5` read before its initializer still read 0. | **Fixed:** every module-scope `var` is seeded, initialised or not (§9.1.1.4.18 creates it holding `undefined`; the initializer only assigns later), and a `for (let …)` head without an initializer binds the sentinel (`compileForStatement`), at top level and in functions, re-entered and captured. |
| Static `C.a ?? 7` reads 0 although the issue said statics were correct. | **Fixed; the claim was wrong.** `collectClassDeclaration` records a static whose type admits `undefined` (`fieldStartsUndefined`), and the prologue seed stores its sentinel; the module-init "has work" test asks for these seeds, since such a static has no init statement. Tests: `??`, `typeof`, later assignment, private, inherited, read by a later static initializer, class expression, imported class. |

Measured on this round: the two #7366 test files go from 90 failing of 178 (base 76b75507f7) to 178/178. The
#7360 test stays green. Neighbouring class and module-var suites (`class-*`, `classes`, `inheritance`,
`instanceof`, `es5-standalone-instanceof`, `issue-2949`, `issue-4204`, `issue-5312*`, `issue-4489*`, `issue-6894*`)
have the identical failing set on base and head (6 of 193). The 100-file test262 sample is byte-identical
(200/200).
