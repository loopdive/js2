---
id: 4460
title: "Static member read off a class EXPRESSION yields null at runtime while typeof/length fold to the function"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
assignee: ttraenkler/dev-4460-class-expr-static
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: class-expression
goal: standalone-gap
related: [4455, 4440, 3976]
origin: "2026-08-15 ES5-standalone session — #4455 R1, narrowed out of #4440 R1's wrong gOPD grouping. Probe evidence in plan/issues/4455-class-proto-accessor-gopd.md R1."
loc-budget-allow:
  # No new subsystem: the fix ROUTES a second receiver shape into the static-
  # member emission that already existed in this file, so the code has to land
  # where that emission lives.
  #  - property-access-dispatch.ts +79: the `ClassName.<prop>` band's body is
  #    lifted VERBATIM into `emitClassStaticMemberRead` (net 0 — the lines move,
  #    they are not rewritten) and the new 20-line
  #    `tryClassExpressionStaticMemberRead` arm is added. The remaining ~59 are
  #    the two doc comments recording WHY the read was null and why the
  #    receiver is compiled through a scratch body. Byte-identity of the
  #    extraction is proved, not asserted: `prove-emit-identity.mjs` is
  #    IDENTICAL 60/60 across gc/standalone/wasi/linear.
  #  - property-access.ts +8: one dispatch-band call site plus its import and
  #    the two-line rationale. `compilePropertyAccess` IS the band sequence;
  #    there is no other place a new band can be reached from.
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access.ts
---

# #4460 — class-expression static member read is null at runtime

## Problem

`var m1 = class { static m(x = 42) {} }.m` — a static member read directly
off a class EXPRESSION value — evaluates to **`null` at runtime**, while
`typeof m1` folds to `"function"` and `m1.length` folds to `0` at compile
time. Probe output, one module (recorded in #4455 R1):

```
typeof=function | ===undefined:false | ===null:true
call THREW TypeError: Cannot access property on null or undefined
hasOwn:false
```

The same class written as a DECLARATION passes:
`class C { static m(x = 42) {} } var m1 = C.m` works —
`language/statements/class/static-method-length-dflt.js` is green while
`language/expressions/class/static-method-length-dflt.js` fails. The
failing test dies on `__getOwnPropertyDescriptor`'s §19.1.2.8 ToObject
guard firing on the null.

**The real bug is the compile-time/runtime disagreement**: the checker
folds `typeof`/`length` from the static type while the value carrier for
the class-expression's static member produces null. The failing test262
row is one symptom; any consumer that passes the value onward (callbacks,
`Function.prototype.call`, gOPD) hits the null.

## Where to look

- Class-expression lowering vs. class-declaration lowering: find where a
  declaration's static members get their carrier (the `__class_<C>` value
  #3976 discusses; `src/codegen/expressions/new-super.ts`
  `emitDynamicNewFallback` `ref.test`s `$ClassName` structs) and diff what
  the EXPRESSION form emits for a member read on the immediate value.
- The fold sites: whatever answers `typeof (class {...}).m` as
  `"function"` and `.length` as `0` at compile time — those folds are
  reading the checker while the runtime read produces null, i.e. the two
  disagree on whether the member exists. Either the runtime carrier must
  produce the function value, or the folds must stop claiming it does.
- #4455's accessor-install machinery (`class-proto-accessors.ts`) is NOT
  involved — R1 explicitly disproved the gOPD grouping.

## Implementation Plan

1. Reproduce with the #4455 R1 probe shape in `.tmp/`:
   `var m1 = class { static m(x = 42) {} }.m; return typeof m1` plus the
   null-identity checks. Confirm declaration form passes, expression form
   nulls. Capture `.tmp/base-*.ts` revert copies at first edit.
2. Read the emitted WAT for both forms; find where the expression form's
   member read lowers (likely a missing arm: the class-expression value is
   not the `$ClassName` carrier the static-member read expects, or the
   read happens before static members are installed).
3. Fix at the emission site so the expression-form read yields the same
   function value the declaration form does.
4. Verify: probe passes both forms;
   `language/expressions/class/static-method-length-dflt.js` flips via
   `.tmp/run-one.mts`; scoped standalone run over
   `language/expressions/class/` for collateral; pins for #4455/#4440
   stay green.

## Acceptance criteria

- Expression-form static member read yields the callable function value
  (call succeeds, `=== null` false).
- `language/expressions/class/static-method-length-dflt.js` passes
  standalone; no regressions in `language/expressions/class/` scoped run.

## Root cause

`compilePropertyAccess` (`src/codegen/property-access.ts`) reaches the
static-member emission only through `tryIdentifierNamespaceAndStaticReceiverRead`
(`property-access-dispatch.ts`), whose whole `ClassName.<prop>` band sits inside
`if (ts.isIdentifier(staticReceiver))`. A class EXPRESSION written in place is
not an identifier, so `class { static m() {} }.m` matched **no band at all** and
fell through the entire ladder to `finalizeStructAndDynamicMemberGet`, which has
no shape for it and emits `ref.null.extern` — measured directly by instrumenting
the two ends of the ladder (`PROBE4460 classexpr receiver, prop= m` →
`PROBE4460 -> finalizeStructAndDynamicMemberGet m`). Nothing about the class was
missing: the body was already collected under a synthetic name
(`__anonClass_0`, `declarations.ts` `registerClassExpression`) with
`$__anonClass_0_m` emitted as a real function, and a direct CALL
`class { static m(x) { return 9; } }.m(0)` already answered **9** on base
(`calls.ts:686` has a `ClassExpression` case) — only the VALUE read had no
carrier. Meanwhile `typeof` and `.length` are folded from the checker's static
type, which correctly reports a function of length 0, so the two halves
disagreed: `typeof m1 === "function"` and `m1.length === 0` at compile time,
`m1 === null` at run time. `language/expressions/class/static-method-length-dflt.js`
then died in `propertyHelper.js` on §19.1.2.8 ToObject, while its
`language/statements/class/` twin passed through the identifier band.

## Fix

`src/codegen/property-access-dispatch.ts`

1. `emitClassStaticMemberRead(ctx, fctx, resolvedClass, propName)` — the
   `ClassName.<prop>` band's body lifted out VERBATIM (static-prop global incl.
   the #2020 inherited walk · `prototype` · `constructor` · static method via
   `emitFuncRefAsClosure` · instance-method placeholder · static accessor).
   `tryIdentifierNamespaceAndStaticReceiverRead` now calls it, so the
   declaration path is the same code, not a copy that can drift.
2. `tryClassExpressionStaticMemberRead` — new band for a class-expression
   receiver. It resolves the class through `ctx.anonClassExprNames` (falling
   back to a named class expression's own name), builds the member read into a
   **scratch body** first so it can decline having emitted nothing, then
   compiles the class expression itself and drops the value — preserving the
   §15.7.1 effects that live in `compileClassExpression` (own-name TDZ
   ReferenceError, static-`prototype` TypeError) — and appends the read. The
   scratch body stays on `fctx.savedBodies` across that compile so a late import
   added while compiling the receiver still shifts its func indices.

`src/codegen/property-access.ts` — the new band is invoked immediately after the
identifier band.

The extraction is byte-neutral by measurement, not by argument:
`npx tsx scripts/prove-emit-identity.mjs` (baseline on base, `check` with the
fix) reports **IDENTICAL — all 60 (file,target) emits match** across
gc/standalone/wasi/linear.

## Test Results

All numbers below are from runs executed on this branch, on this box, on
2026-08-15. Base = `602aee7` with `src/codegen/property-access{,-dispatch}.ts`
reverted from `.tmp/base-*.ts` copies; fixed = the same tree with the change
applied. Nothing here is carried over from an artifact.

**Targeted files** (`.tmp/run-one.mts` → the real `runTest262File`, `standalone`):

| file                                                       | base | fixed |
| ---------------------------------------------------------- | ---- | ----- |
| `language/expressions/class/static-method-length-dflt.js`  | fail (`TypeError: Cannot convert undefined or null to object`) | **pass** |
| `language/statements/class/static-method-length-dflt.js`   | pass | pass  |
| probe: expression form, null/typeof/length/call             | fail (`m1 === null`) | **pass** |
| probe: declaration form (control)                           | pass | pass  |

**Scoped standalone sweep, `language/expressions/class`** — 464 files: every
top-level `*.js` (261) plus every file under `method-static`,
`gen-method-static`, `async-method-static`, `async-gen-method-static`,
`accessor-name-static` (203). Same list, same runner, both arms
(`.tmp/sweep.mts`, 3 shards):

| arm   | pass    | fail | compile_error |
| ----- | ------- | ---- | ------------- |
| base  | 287     | 170  | 7             |
| fixed | **288** | 169  | 7             |

Per-file diff: **1 flip to pass** (`static-method-length-dflt.js`), **0 other
changes** — no regressions and no collateral flips.

**Suites** (fixed tree): `tests/issue-4460.test.ts` 9/9 · `tests/issue-4440.test.ts`
14/14 · `tests/class-expressions.test.ts`, `tests/issue-1594b.test.ts`,
`tests/issue-1602.test.ts` green · equivalence gate shards 1/8 and 3/8 both
"No new equivalence regressions" · `typecheck`, `lint`, `prettier --check`,
`check-oracle-ratchet`, `check-func-budget`, `check-coercion-sites`,
`audit-legacy-reachability --check` all clean; `check-loc-budget` needs the
`loc-budget-allow:` key above (granted, both files listed).

`tests/issue-4455.test.ts` does not exist on this branch's base — #4455's work
had not landed — so that pin could not be run; `tests/issue-4440.test.ts` was.

## Residuals

Two adjacent gaps were MEASURED on both arms (`.tmp/probe2.mts`, identical base
and fixed) and are **not** caused or fixed by this change. They are pinned as
same-answer invariants in `tests/issue-4460.test.ts` rather than left silent:

1. **`.prototype` value read is nullish for BOTH forms.**
   `class C { m(){} } C.prototype` → nullish, `var C = class { m(){} };
   C.prototype` → nullish, `class { m(){} }.prototype` → nullish. Standalone
   `emitLazyProtoGet` does not materialise a prototype object here. The
   expression form now reaches exactly the same emission as the declaration
   form, so fixing the declaration form fixes both.
2. **Fused static CALL through a class-expression-bound identifier answers 0.**
   `var C = class { static m(x) { return 9; } }; C.m(0)` → 0, while the
   declaration form → 9 and the read-then-call form `var f = C.m; f(0)` → 9.
   This is a call-dispatch gap (the value READ is correct), unrelated to the
   property-access ladder this issue fixes.

Also unfixed by design: `tests/class-expression.test.ts` fails 8/8 on this
branch's base and 8/8 with the fix — identical failures, pre-existing, untouched.

Not attempted: the 4,061-file full recursive `language/expressions/class` tree.
The 464-file scoped set covers every static-member subdirectory plus the whole
top level; the remaining files are instance-side (`method/`, `dstr/`,
`elements/`, `accessor-name-inst/`) and cannot reach the new band, which
requires a `ClassExpression` receiver.
