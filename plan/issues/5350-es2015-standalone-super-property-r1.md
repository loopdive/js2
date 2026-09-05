---
id: 5350
title: "ES2015 standalone super property access — r1: class [[HomeObject]] read, dynamic-key base-before-key, extends null, uninitialised this, object-literal super calls"
status: in-progress
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: m
feasibility: medium
model: opus
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: super
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [4688, 5195, 3594, 3522, 2046, 5316, 4444]
---

## Problem

38 rows under `language/expressions/super/` are non-pass in the ES2015
standalone baseline (2026-09-05; 56 pass). A read-only investigation
(scratch `.tmp/w5/super/`, probes `p2`-`p20.js`, driver `run.mts`, WAT dumper
`wat.mts`) found one dominant defect: **`super.<x>` in a CLASS method has no
runtime prototype lookup**. `compileSuperPropertyAccess`
(`src/codegen/expressions/new-super.ts:1277`) resolves `super.<name>` only
through three static tables (parent accessors `ctx.classAccessorSet`, parent
struct fields `ctx.structFields`, parent methods) and otherwise emits a
type-shaped default (`ref.null.extern` / `f64.const 0` / `i32.const 0`,
L1398-1409). A property put on the parent prototype at runtime
(`A.prototype.fromA = 'a'`) is invisible, so `super.fromA` compiles to a literal
null — the `Expected SameValue(«null», «"a"»)` bucket verbatim (WAT `p2.wat:6402`:
three instructions). The object-literal twin was fixed by #4688
(`compileStandaloneObjectLiteralSuperPropertyRead`, L1211: `__getPrototypeOf(home)`
→ RequireObjectCoercible → `__reflect_get_receiver(base, key, this)`) and only
lacks the class [[HomeObject]] input — which exists since #5195 as the `$Object`
prototype singleton (`emitLazyProtoGet(ctx, fctx, className)`,
`expressions/extern.ts:302`). Proof: the lowering written as source
(`Reflect.get(Object.getPrototypeOf(C.prototype), 'fromA', this)`) answers `'a'`
on the base tree with `imports: []` (probe `p19`).

Super WRITES (`super.x = v`, 9 rows) write nowhere and never throw (probe `p10`)
because standalone has no receiver-aware [[Set]] — that native is being built by
#5316 r5 step 6 (`__reflect_set_receiver`) and is NOT built here.

## Implementation Plan — r1 (2026-09-05, Fable lane; Opus-medium implements)

All gated on `ctx.standalone` exactly as L1216 does; wasi and host untouched.
Steps independent, ordered by rows-per-risk.

1. **Class methods get their [[HomeObject]] (4 clean rows, +2 after the eval
   bridge).** Generalise `compileStandaloneObjectLiteralSuperPropertyRead`
   (L1211) to take an `emitHomeObject: () => boolean` instead of reading the
   `SUPER_HOME_OBJECT_CAPTURE_NAME` local (L1230-1235); object-literal callers
   pass the existing `local.get`, the class caller passes
   `() => emitLazyProtoGet(ctx, fctx, currentClassName)`. Wire it in exactly two
   places: L1398 (immediately before the final default in
   `compileSuperPropertyAccess`) and L1556 (same position in
   `compileSuperElementAccess`) — AFTER the parent-accessor walk (L1497-1515)
   and struct-field walk (L1517-1555), so `tests/issue-3522-super-accessor.test.ts:407-419`
   keeps its single static call. Receiver: the `this` LOCAL when
   `fctx.localMap.get("this")` exists (`local.get` + `extern.convert_any`),
   never `__current_this` in a class method; a static method (no `this` local)
   keeps today's default. Restrict to `parentClassName !== undefined` — do NOT
   touch the `!parentClassName` arms at L1306/L1484: a base class's prototype
   `$Object` has a null [[Prototype]] today (probe `p18`), so the coercible
   guard would turn every base-class `super.x` (must be `undefined`) into a
   TypeError. Check `standaloneClassProtoObjectApplies(ctx, currentClassName)`
   BEFORE committing to the runtime lowering (re-entrancy guard
   `protoObjectsInProgress`, `class-proto-object.ts:120/204`; builtin-parent
   subclasses like `extends Map` return false and keep the
   `emitSuperExternMethodCall` route). Call `flushLateImportShifts` at the two
   points the #4688 arm does (L1221, L1256). Rows: `prop-{dot,expr}-cls-val.js`,
   `prop-{dot,expr}-cls-val-from-arrow.js`.
2. **Dynamic-key super element read: base before key (2 rows).** In the
   `propName === undefined` arm (L1435-1459) stop dropping the key: emit the
   home object → `__getPrototypeOf` FIRST, spill the base to a local, then the
   key + `emitToPropertyKeyOnce`, then `emitSuperBaseCoercibleGuard` and
   `__reflect_get_receiver(base, key, this)` (both `-getsuperbase-before-
   topropertykey-*` rows assert GetSuperBase precedes ToPropertyKey; the key's
   `toString` mutates the home object's prototype). Rows:
   `prop-expr-getsuperbase-before-topropertykey-getvalue.js`,
   `prop-poisoned-underscore-proto.js`.
3. **`class C extends null`: super read is a TypeError (2 rows).** Narrow arm
   ahead of the `!parentClassName` default at L1306 and L1484: when the
   enclosing class's heritage expression is the literal `null`,
   `emitThrowTypeError(ctx, fctx, "Cannot read properties of null (super base)")`.
   Record the general fix (base-class `D.prototype.[[Prototype]] ===
   Object.prototype`, `class-proto-object.ts:243-260`) as a separate issue.
   Rows: `prop-{dot,expr}-cls-null-proto.js`.
4. **Uninitialised `this` in a derived constructor (3 rows).** (a) call the
   existing `emitSuperUninitializedThisGuard(ctx, fctx, expr.argumentExpression)`
   (`helpers.ts:381`) at the top of `compileSuperElementAccess` (L1422),
   mirroring `assignment.ts:5522` — row `prop-expr-uninitialized-this-getvalue.js`.
   (b) extend the guard with a second trigger: in a derived constructor, a
   `super.<x>` READ not lexically preceded by any `super()` call in the
   constructor's statement list is unconditionally a ReferenceError; when a
   `super()` appears earlier (even inside `if`/loops) keep today's behaviour —
   conservative in the safe direction, never invert it. Rows:
   `prop-{dot,expr}-cls-this-uninit.js`.
5. **Object-literal `super.m()` (2 rows).** `compileSuperMethodCallCore`
   (L1059-1163) bails at L1086 for object literals; before
   `evalArgsAndDefault()`, obtain the method value with step 1's read
   (`__reflect_get_receiver(getPrototypeOf(home), name, this)`) and invoke it
   with `this` = the current receiver through the `__extern_method_call` /
   `__js2_call_fn_method_argc_N` path `emitSuperExternMethodCall` (L1000-1043)
   already uses. Respect the `selfOffset` / no-pad contract (L1118-1127,
   `tests/issue-3024-static-super-arity.test.ts`). Rows:
   `prop-{dot,expr}-obj-ref-this.js`.
6. **Record, do not build:** super WRITE (9 rows; needs #5316 r5 step 6's
   `__reflect_set_receiver` — then a `super` target arm in
   `compilePropertyAssignment`/`compileElementAssignment` after the static
   accessor-setter dispatch, §13.15.2 order base → key → RHS → Set, and a strict-
   mode TypeError on a false status via `isStrictContext`); the `C.prototype`
   narrowing to the instance struct (`ref.test` fails against the #5195 `$Object`,
   `p9.wat`; blocks `prop-{dot,expr}-cls-ref-this.js`); the eval [[HomeObject]]
   bridge (4 `-from-eval` rows); derived-`super()` this-rebinding (4 rows);
   `super(...spread)` arity (4 rows); `call-construct-invocation.js` (#3371).

Measurement protocol: base = `git archive origin/main` (linked deps, rebuilt
bundle + eval provider after the last src edit); node 22 oracle, node 25 for
changed test files; reuse `.tmp/w5/super/*.js` + `run.mts`; rows via
`run-test262-paths.mts --isolate --standalone`. Controls (zero rows lost by
set-diff): every ES2015 row under `language/expressions/super` (94),
`language/statements/class` + `language/expressions/class` (~700 — the class
pins `tests/issue-5195*.test.ts`, `issue-5309`, `issue-5312`, `issue-5318-r4-*`,
`issue-3522-super-accessor`, `issue-3024-static-super-arity` must stay green),
and `language/expressions/object` (~260).

## Acceptance criteria

- 13 rows (steps 1-5) pass; the from-eval and cls-ref-this rows are NOT counted.
- Zero rows lost across the three controls; the pins above green on node 22
  and node 25 at 4G single fork.
- Byte-identical: every non-standalone target; the parent-accessor arm (one
  static call, no `call_ref`/`ref.test`/`__box_number`, `issue-3522` pin) and the
  struct-field arm; `src/ir/select.ts` untouched (selector outcome codes pinned).
- Behaviour change accepted and measured: PARENT_FIELD `super.label` moves from
  `ref.null.extern` to the prototype lookup's `undefined` (= node).
- Pins in `tests/issue-5350-super-property-r1.test.ts` (standalone,
  `result.imports` `[]`) for every step and for the base-class `super.x`
  staying `undefined` without a throw.
- Gates green bare and with `LOC_GATE_BASE=origin/main`; grants here.

## Lane protocol

As in #5316/#5318: fresh worktree of the session branch, commit per step with
the measurement in the body, `Model: Claude Opus 5 Medium`, never push/PR/
enqueue; append `## 2026-09-05 r1 implementation (Opus)` with rows base→lane,
control set-diffs, gates, residuals with mechanisms.
