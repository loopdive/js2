---
id: 5350
title: "ES2015 standalone super property access — r1: class [[HomeObject]] read, dynamic-key base-before-key, extends null, uninitialised this, object-literal super calls"
status: in-progress
sprint: current
created: 2026-09-05
updated: 2026-09-06
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
# 2026-09-06 (r1 review round): the whole change-set is these three files.
# `new-super.ts` carries the r1 super-read lowering (steps 1-5) — restated here
# because the lane's growth was covered only by OTHER issues' grants, which is a
# stranded grant the moment CI diffs the merge preview. `literals.ts` and
# `dynamic-proto.ts` grow by the §B.3.1 `__proto__:` arm and its prescan mark
# (review finding F1): a colon-`__proto__` literal now links its runtime
# [[Prototype]] instead of storing an own property, which is what makes
# `super.m()` over such a literal answer node instead of throwing an escaping
# TypeError. Both additions sit in the module that owns the mechanism.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/literals.ts
  - src/codegen/dynamic-proto.ts
  # 2026-09-06 (r3): +1 line — the nested-`super(...)` arm's flag store. The
  # mechanism lives in new-super.ts; only the one-line call site is here.
  - src/codegen/expressions/calls.ts
# 2026-09-06 (r3 review round): the S1 runtime this-initialised flag adds two
# call sites outside the two modules already granted above — one line each,
# storing 1 into `__super_done` right after a `super(...)` lowering returns.
# `compileClassBodiesInner` also takes the one-time `ensureSuperInitializedFlagLocal`
# pre-scan call that must run before the constructor body is compiled. Both are
# additions to functions that are already far over the 300-LOC threshold; the
# alternative — wrapping `compileSuperCall` so the store has a single home —
# registers a 387-LOC "new over-budget function" for what is only a rename, so
# the call-site form is the smaller change.
func-budget-allow:
  - src/codegen/expressions/new-super.ts
  - src/codegen/literals.ts
  - src/codegen/dynamic-proto.ts
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/expressions/calls.ts::compileCallExpression
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

## 2026-09-05 r1 implementation (Opus)

Branch `wf5350` off the wave-5 integration branch (`claude/es6-test262-standalone-g10c7u`
@4324022bd5 = origin/main @2257b950ee + the wave-5 plans). Five commits, one per plan
step, each carrying its own measurement.

### What landed

| Step | Commit | Mechanism |
| --- | --- | --- |
| 1 | `6796fd1b8d` | Class methods get their [[HomeObject]]: `compileStandaloneObjectLiteralSuperPropertyRead` generalised into a shared `compileStandaloneSuperPropertyRead` taking home-object and receiver EMITTERS; the class caller materialises `C.prototype` through `emitLazyProtoGet` (#5195 `$Object` singleton). Wired at the two final-default positions only, AFTER the parent-accessor and struct-field walks. |
| 2 | `dc02c17b6f` | `super[<dynamic key>]` reads for real, with GetSuperBase spilled to a local BEFORE ToPropertyKey runs. |
| 3 | `f38e235725` | `class C extends null` — the super base is null, so the read is a TypeError; a BASE class stays on its `undefined`-shaped default. |
| 4 | `1e45f94a7f` | (a) the #2709 `super[super()]` guard now runs on the READ path too; (b) a derived-constructor `super.x` with no lexically preceding `super()` is a ReferenceError; plus a correction to step 1 (see below). |
| 5 | `375e7a72f8` | An object literal's `super.m(args)` is INVOKED via `__apply_closure(fn, thisValue, argsCarrier)` with the call-time receiver, instead of leaving a typed default. Plus `tests/issue-5350-super-property-r1.test.ts`. |

### Rows (`run-test262-paths.mts --isolate --standalone`, base = origin/main @2257b950ee with its own bundle + eval provider)

Base: 13/13 fail. Lane: **5 pass, 8 fail**.

| Row | base | lane |
| --- | --- | --- |
| `prop-dot-cls-null-proto.js` | fail | **pass** |
| `prop-expr-cls-null-proto.js` | fail | **pass** |
| `prop-expr-uninitialized-this-getvalue.js` | fail | **pass** |
| `prop-dot-obj-ref-this.js` | fail | **pass** |
| `prop-expr-obj-ref-this.js` | fail | **pass** |
| `prop-dot-cls-val.js` | fail («null») | fail («null») |
| `prop-expr-cls-val.js` | fail («null») | fail («null») |
| `prop-dot-cls-val-from-arrow.js` | fail («null») | fail («null») |
| `prop-expr-cls-val-from-arrow.js` | fail («null») | fail («null») |
| `prop-expr-getsuperbase-before-topropertykey-getvalue.js` | fail («null») | fail («undefined») |
| `prop-poisoned-underscore-proto.js` | fail («null») | fail («null») |
| `prop-dot-cls-this-uninit.js` | fail | fail |
| `prop-expr-cls-this-uninit.js` | fail | fail |

The plan projected 13 rows. Five landed. The eight that did not are blocked by
defects OUTSIDE this lowering, each isolated with a probe rather than inferred:

1. **A block-scoped class method's write to a captured `var` of the enclosing
   function is dropped** — pre-existing, present identically on origin/main, and
   it has nothing to do with `super`. `.tmp/w5350/q26.ts` is the whole repro:
   `fromA = 'a'` inside `C.prototype.method()` where `C` sits in an `if (1) { }`
   block and `fromA` is declared outside it. base **2** (`fromA` still
   `undefined`), lane **2**, node 22 **1**.
   This is why the four `prop-{dot,expr}-cls-val{,-from-arrow}.js` rows and the
   two `prop-{dot,expr}-cls-this-uninit.js` rows still fail: `wrapTest` puts
   every test body inside `try { }`, so EVERY row's class is block-scoped, and
   all six store their observation in an outer `var` (`fromA`, `caught`). The
   super read itself is now correct in that shape — `.tmp/w5350/q25.ts` performs
   the same two-level chain read from a block-scoped class and answers **6**
   (both reads right), matching node.
   The plan's proof for step 1 (probe `p19`) was FUNCTION-scoped, which is why
   this did not surface in planning.
2. **`prop-expr-getsuperbase-before-topropertykey-getvalue.js`** moved «null» →
   «undefined» (the read now happens) and is blocked twice over: the row's key
   variable is captured by a lifted object-literal method and reads as absent
   inside it (`.tmp/w5350/q33.ts`), and node 22 itself answers `"bad"` for this
   row (`.tmp/w5350/row1b.mjs`) — it evaluates ToPropertyKey before
   GetSuperBase, so this row cannot be validated against the node oracle at all.
3. **`prop-poisoned-underscore-proto.js`** is unchanged; its first assertion is
   an object-literal `super['constructor']` reaching `Object`, which the read
   declines on today.

### Regression caught and fixed inside the lane

Step 1 as first committed made `class D extends Object { … super.y … }` throw a
TypeError where node answers `undefined`: a builtin parent has no §15.7.14
step-6 link out of `D.prototype`, so `__getPrototypeOf` answered nullish and the
RequireObjectCoercible guard fired. Step 4's probe caught it; the class arm now
also requires the PARENT to own a `$Object` prototype. `.tmp/w5350/q52.ts`:
base **36**, step-1-only **73** (the regression), lane **37**, node 22 **37**.

### Pins

`tests/issue-5350-super-property-r1.test.ts` — six cases, one per step plus two
regression guards (a BASE class's `super.x` must not throw; a derived read after
`super()`, and one in an arrow written before it, must still answer). Every case
asserts `result.imports` is `[]`. Green on node 22.22.2 and node 25.9.0,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks --poolOptions.forks.singleFork=true`.

Named class pins re-run green on this branch: `issue-3024-static-super-arity`,
`issue-3522-super-accessor`, `issue-5195-es2015-class-r2`,
`issue-5195-r3-heritage-check`, `issue-5195-r3-restricted-properties`,
`issue-5195-r3-review`, `issue-5309-child-field-shadows-parent-method`,
`issue-5312-uninitialised-field-reads-undefined`,
`issue-5318-r4-computed-accessor-keys` — 309 tests, 0 failures.

### Byte-identity outside standalone

`compile()` on three probe shapes (`q23.ts` class chain, `q61.ts` object-literal
super call, `q40.ts` `extends null` + base class), sha256 of `.binary`, lane vs
base:

| probe | host | wasi | standalone |
| --- | --- | --- | --- |
| q23 | identical `ac355d7c…` | identical `385d6200…` | changed |
| q61 | identical `bf7b0786…` | identical `bb336190…` | changed |
| q40 | identical `e68b3193…` | identical `3a021e4b…` | changed |

`src/ir/select.ts` is untouched — the whole change-set is
`src/codegen/expressions/new-super.ts` plus the new test file.

### Gates

Run bare, exit status read directly, after the last src edit:
`check-loc-budget` (also with `LOC_GATE_BASE=origin/main`), `check-func-budget`
(same), `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
`check:speculative-rollback`, `check:stack-balance`, `check:codegen-fallbacks`,
`check:any-box-sites`, TS7 `--noEmit -p tsconfig.ts7.json`, `pnpm lint` — all 0.

`oracle-ratchet` needed work rather than a grant: the step-4 throw hooks first
added three `getTypeAtLocation` sites. Both super-access functions now take ONE
hoisted checker query and every arm answers from it, a NET −7. The LOC and
function budgets carry a dated `loc-budget-allow` / `func-budget-allow` grant
for `src/codegen/expressions/new-super.ts` in this issue's own frontmatter (the
whole change is in that one file). No `scripts/*-baseline.json` was touched.

### Residuals, with mechanisms

- **Block-scoped class method → captured-`var` write is dropped** (defect 1
  above). This is the single largest blocker for this row family and is NOT a
  `super` defect; it wants its own issue. Repro `.tmp/w5350/q26.ts`, ten lines,
  no `super`.
- **A BASE class's `super.x` answers `ref.null.extern`, not `undefined`**
  (`.tmp/w5350/q40.ts` D-half: base 32, lane 32, node 16). Needs
  `D.prototype.[[Prototype]] === Object.prototype`
  (`class-proto-object.ts:243-260`) — the general fix the plan's step 3 asked to
  record separately.
- **Builtin-parent subclasses** (`extends Map`, `extends Object`) keep the
  historical default: no `$Object` prototype on the parent, so no chain to walk.
- **`super.x = v` (9 rows)** — not built, per plan step 6; needs #5316 r5's
  `__reflect_set_receiver`.
- **The `-from-eval` [[HomeObject]] bridge, `C.prototype` narrowing to the
  instance struct (`prop-{dot,expr}-cls-ref-this.js`), derived-`super()`
  this-rebinding, `super(...spread)` arity, `call-construct-invocation.js`
  (#3371)** — untouched, per plan step 6.
- **Object-literal `super.m()` on a MISS answers the old typed default, not
  §13.3.6's TypeError** — deliberate ("absent-not-wrong"): the reflective read
  does not see every prototype surface.
- **`super.m(...spread)` in an object literal** declines to the old arm; the
  args carrier is built by `__objvec_push` per argument and spreads were out of
  scope.

### Control not completed (integrator note, 2026-09-06)

The lane started a 1,089-row class/super control (`language/statements/class/*`, `language/expressions/class/*`, `language/expressions/object/*`, `.../class/subclass`, `.../class/definition`, `language/expressions/super`) three times; every run died mid-way on the shared box (only the tier headers were written) and the lane wedged waiting for the result file. The integrator stopped the lane at 05:20 UTC and committed this record from the lane's draft. The control is deferred to the integrated-tree sweep (fix tree vs the fresh standalone baseline, set-diff of non-pass paths) before the PR.

### Review round 1 (2026-09-06)

Fix round for the reviewer's two confirmed findings, on a fresh worktree of the
wave-5 integration branch with `wf5350` merged in. Two commits, one per finding.
Every number below was measured on this tree; "base" is this same tree with the
three source files reverted by file copy (`.tmp/base-*.ts`), bundle and eval
provider rebuilt — i.e. the lane's own behaviour.

#### F1 — `super` over a `__proto__:` object literal threw an escaping TypeError

**Root cause, one level below where the reviewer looked.** The lane did not
break these shapes; it made an existing hole audible. A NON-computed
`__proto__:` key (§B.3.1) sets the object's [[Prototype]] during literal
evaluation. `compileObjectLiteralWithAccessors` learned that in #5270 step 2 —
but the OPEN-`$Object` construction path (`compileObjectLiteralAsExternref`)
never did, and, worse, a literal carrying a colon-`__proto__` was not routed to
that path at all: it built as a CLOSED struct, which has no `$proto` field, so
`__object_setPrototypeOf`'s `ref.test $Object` fails and the link is dropped in
silence. Every chain walk over such a literal was therefore dead — long before
`super` entered the picture.

Fix (a) of the two the review proposed, in two parts:

- `src/codegen/dynamic-proto.ts` — `scanForDynamicProto` now marks a literal
  with a colon-`__proto__` as a proto-mutation RECEIVER, and its value as a
  #4163 proto-SOURCE. That reuses the whole #802 Slice-A promotion: the literal
  builds as an open `$Object` and `variables.ts` / `index.ts` type the binding
  slot externref in lockstep. Standalone-gated at the mark, because
  `nested-declarations.ts`'s capture-typing consumer of this set is not
  target-gated.
- `src/codegen/literals.ts` — `compileObjectLiteralAsExternref` gets the §B.3.1
  arm: `__object_setPrototypeOf(obj, v)` instead of storing an own property
  through `__extern_set`.

| probe | base (= lane) | this fix | node 22 |
| --- | --- | --- | --- |
| `h1b` `super.m()` over `{__proto__: proto, m(){…}}` | TypeError escapes | **3** | 3 |
| `i1` different method name | TypeError escapes | **3** | 3 |
| `h1` `super.m() + 1` | TypeError escapes | **4** | 4 |
| `h2` `super.m(2, 5)` | TypeError escapes | **7** | 7 |
| `h3` `super.who()` reading `this.tag` | TypeError escapes | **11** | 11 |
| `h1c` throw caught inside the method | 77 | **4** | 4 |
| `h1d` TypeError classified by the method | 91 | **3** | 3 |
| `h3b` inherited method, no `this` | TypeError escapes | **5** | 5 |
| `i3` `super.v` DATA read | TypeError escapes | **8** | 8 |
| `m3` TypeError classified by the caller | 91 | **3** | 3 |

Ordinary prototype-chain reads through such a literal improved with it, which is
the check that this is the real fix rather than a `super`-shaped patch:

| probe | base | this fix | node 22 |
| --- | --- | --- | --- |
| `x1` `Object.getPrototypeOf(o) === proto` (method literal) | 8 (false) | **7** | 7 |
| `x2` inherited `o.p()` | trap | **3** | 3 |
| `x3` `Object.getPrototypeOf(o) === proto` (data literal) | 8 (false) | **7** | 7 |
| `x4` same, method-bearing proto | 8 (false) | **7** | 7 |

#### F2 — the uninitialised-`this` guard false-positived on a loop back-edge

`superReadPrecedesSuperCall` threw unless some `super(...)` node ENDED before the
read's source position. Source position orders the text, not the execution: the
one construct that lets a textually later `super()` run first is a loop's
back-edge. The guard now declines when a loop (or a labelled statement, whose
`continue`/`break` targets one) encloses the read; forward-only branches
(`if` / `switch` / `try`) cannot re-run an earlier `super()`, and a `super()`
sitting in a branch before the read was already handled by the existing
preceded-by check, so they keep today's answer.

The plan's suggested shape — emit the #2709 `ref.is_null` runtime check on the
constructor's `this` local — is **not implementable as written**: a derived
constructor's `this` is `struct.new`-allocated at function entry
(`class-bodies.ts:2522`), so there is no null to test. Recorded rather than
silently substituted.

| probe | base (= lane) | this fix | node 22 |
| --- | --- | --- | --- |
| `n4` read on a `while(true)` back-edge | ReferenceError escapes | **5** | 5 |
| `n5` same, ReferenceError observed | 8 | **5** | 5 |
| `s1` straight-line read BEFORE `super()` | 8 | **8** (throw kept) | 8 |
| `g1`–`g4`, `g6` | 5 | 5 | 5 |
| `g5` read in a `try` whose `catch` calls `super()` | 0 | 0 | 9 (both wrong, unchanged) |
| `n1`, `n2`, `n3` | 5 / 4 / 5 | 5 / 4 / 5 | 5 / 4 / 8 (`n3` unchanged) |

#### F3 — refuted, recorded so a wider sweep does not re-open it

A class `super.x` whose parent-prototype property is installed at runtime
(`A.prototype.fromA = 5`) moved from base's `0` to `NaN`. It is **pre-existing
and not a `super` defect**: the ORDINARY read `new B().fromA` is `NaN` on both
trees. Do not read the `0` → `NaN` drift as new damage.

#### Full probe set, this tree vs the lane

All 73 reviewer probes (`.tmp/rev5350/p/*.ts`, standalone). Exactly 11 rows moved
— the F1 and F2 rows above — and every other row is identical to the lane,
including the ones that already equalled node. `l4`'s pre-existing `env::` import
and `h4`/`h5`'s pre-existing nulls are unchanged.

#### Byte identity (A/B on this tree, sha256 of `.binary`)

`host` and `wasi` are **byte-identical for every probe measured** (k1, k2, c4,
h1b, b5, x1, x3, i2, a2, f7). On `standalone` only the three probes whose source
contains a colon-`__proto__` move (h1b, x1, x3); literals without one — k1, k2,
c4, b5, i2, a2, f7 — are byte-identical there too.

#### Rows

- **53-row super control** (`ctrl53`, the reviewer's list), non-pass set-diff vs
  the lane's run: **zero lost, one gained** —
  `prop-expr-getsuperbase-before-topropertykey-getvalue.js` now passes (that row
  reads through a `__proto__:` literal). Lane 23 pass / 30 non-pass → this tree
  24 pass / 29 non-pass.
- **13 target rows**: the lane's 5 passes all kept, plus that same gained row =
  **6 pass**.
- **10 rows under `language/expressions/object` whose source contains
  `__proto__`** (the complete grep, not a sample), base vs this tree: identical —
  7 pass / 3 fail on both. The three failures (`__proto__-fn-name.js`,
  `__proto__-poisoned-object-prototype.js`, `computed-__proto__.js`) fail for
  reasons this change does not touch.

#### Pins

`tests/issue-5350-super-property-r1.test.ts` grows from 6 to 13 cases: four F1
cases (`super.m()` / a differently-named method / a `this`-dependent method /
`super.v` over a `__proto__:` literal) and three F2 cases (the back-edge read,
the same read proving no ReferenceError, and a straight-line pre-`super()` read
that must still throw). **13/13 green on node 22.22.2 AND node 25.9.0**, at
`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks
--poolOptions.forks.singleFork=true --dangerouslyIgnoreUnhandledErrors`.

Named suites re-run green on this tree, in ≤3-file batches: `issue-2709`,
`issue-1824-super-as-value`, `issue-3522-super-accessor` (38);
`issue-3024-static-super-arity`, `issue-5212-es2015-class-collection-super`,
`issue-5309-child-field-shadows-parent-method` (61);
`issue-5312-uninitialised-field-reads-undefined`, `issue-5195-es2015-class-r2`,
`issue-5195-r3-heritage-check` (151); `issue-5195-r3-restricted-properties`,
`issue-5195-r3-review`, `issue-3024` (34). Plus every other suite whose source
contains a colon-`__proto__` literal, since that lowering changed:
`issue-5270-es2015-expressions-r2`, `issue-4527-call-dyn-bridge`,
`issue-1058-generic-callback-result` (155); `closed-imports`, `safe-mode`,
`issue-4376-deno-primordials-runtime` (50).

#### Gates

Run bare, status read directly, after the last src edit: `check-loc-budget`,
`check-func-budget` (both also with `LOC_GATE_BASE=origin/main`),
`check-coercion-sites`, `check:oracle-ratchet` (net −7 `getTypeAtLocation`, −5
`ctx.checker`), `check:dead-exports`, `check:speculative-rollback`,
`check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, TS7
`--noEmit -p tsconfig.ts7.json`, `pnpm lint` — all 0.

One gate does NOT pass at the CI base and it is **not this change-set's**: with
`LOC_GATE_BASE=origin/main`, `check-loc-budget` fails on
`src/codegen/expressions/calls-closures.ts` (2726 > 2699). Measured with the
three source files reverted, it fails identically — the integration branch is
behind main's #5342, which shrank that file. It clears when the integration
branch merges `origin/main`.

Growth grants are restated in THIS issue's frontmatter (`loc-budget-allow` /
`func-budget-allow` for `new-super.ts`, `literals.ts`, `dynamic-proto.ts`) with a
dated rationale: the lane's `new-super.ts` growth was covered only by #3371's and
#5318's issue files, which is a stranded grant the moment CI diffs the merge
preview.

#### Residuals

Unchanged from the r1 record, plus:

- **`g5` / `n3`** — a `super` read inside a `try` whose handler calls `super()`
  still answers instead of throwing (node throws). Neither base nor this tree
  gets it right; making it right needs a runtime this-initialised flag the
  compiler does not have. Deliberately left alone: this round's rule change was
  narrowed to loops precisely so these two rows do not move.
- **The `__proto__:` literal now takes the open-`$Object` path in standalone.**
  That is the correct representation for a literal whose prototype is linked, but
  it IS a representation change for those literals: 10 test262 rows and six
  in-repo suites were measured across it, and standalone bytes move for exactly
  the literals that carry the key.
- **The 1,089-row class/super control the r1 record deferred is still deferred.**
  This round measured the 53-row super control, the 13 target rows and the 10
  `__proto__` object rows; the wide sweep belongs to the integrated-tree run
  before the PR.

#### Status after this round: still `in-progress`, deliberately

Both review findings are fixed and every control the round could run is clean,
but ONE acceptance criterion the plan states for the landed steps still does not
hold: **"13 rows (steps 1-5) pass"** — 6 do. The other eight are blocked by the
defect the r1 record isolated (a block-scoped class method's write to a captured
`var` of the enclosing function is dropped; repro `.tmp/w5350/q26.ts`, ten lines,
no `super`), which is pre-existing and not a `super` defect. The remaining
criteria hold: zero rows lost across the controls measured, pins green on node 22
and node 25, non-standalone bytes identical, `src/ir/select.ts` untouched, grants
in this file. Flipping to `done` would report a row count this tree does not
have, so the status stays `in-progress` until that blocker is filed and cleared
or the criterion is re-scoped.

### Review round 2 (2026-09-06)

Fix round for the round-1 reviewer's two confirmed regressions, on a fresh
worktree of the wave-5 integration branch with the round-1 fix branch merged in
(`worktree-wf_aa692654-801-1`, head `9348642c60`). Two commits, one per
regression. "r1" below is that merged tree measured directly; "lane" is
`wf_2c593ff3-433-3` (head `8d1542cf59`); "base" is that lane's `.tmp/base`
archive of `origin/main` `2257b950ee`; "node" is node 22 on the identical
source. Probes: the round-1 reviewer's `/home/user/js2/.tmp/rev5350b/p/*.ts`
plus the original `/home/user/js2/.tmp/rev5350/p/*.ts`, both run whole.

#### R1 — the back-edge narrowing suppressed genuine pre-`super()` reads

`superReadPrecedesSuperCall` returned `false` for ANY enclosing
`ts.isIterationStatement` or `ts.isLabeledStatement`, unconditionally. The
premise ("a loop's back-edge can carry a textually later `super()` over the
read") is right; the test was not, because it never asked whether that loop
contains a `super()` at all. A loop with none has no such edge, and a labelled
statement is not the case either — a labelled BLOCK is forward-only (`break lbl`
jumps out, never back) and a labelled LOOP is already an iteration statement.

The rule is now: throw iff **(a)** no `super(...)` ends before the read's
position **and (b)** no `super(...)` lies inside any ITERATION statement
enclosing the read. The labelled arm is gone.

| probe (standalone) | base | lane | r1 | this round | node 22 |
| --- | --- | --- | --- | --- | --- |
| `d02b` pre-super read in a `for` with no `super()` | 6 | 9 | 6 | **9** | 9 |
| `d10` same in a `while` | 6 | 9 | 6 | **9** | 9 |
| `d01b` same in a labelled block | 6 | 9 | 6 | **9** | 9 |
| `d01`, `d02` same, uncaught in `main` | 6 | throw | 6 | **throw** | ReferenceError |
| `q1`, `q2` ReferenceError probes | — | — | NaN | **91** | 91 |
| `q6`, `q8`, `q9` accessor variants | — | — | 5 | **91** | 91 |
| `n4`, `n5` `super()` inside the same loop, read on iteration 2 | 5 | 5 | 5 | **5** | 5 |
| `g1`–`g6`, `n1`–`n3` | — | — | unchanged | **unchanged** | — |

`g5` (0 vs node 9) and `n3` (5 vs node 8) stay where round 1 left them: both are
the pre-existing block-scoped-class capture defect, not a `super` defect.

**The round-1 review's host-byte observation was base drift, not a regression —
refuted here so it is not re-opened.** The reviewer recorded that round 1
"changed host bytes and gained an `env::__rethrow_host_exception` import" on
`d02b`/`d10`/`d01b` relative to the lane. It cannot have: round 1's only
`new-super.ts` change was the three-line iteration/labelled arm, reachable only
from `emitSuperUninitializedThisReadThrow`, which returns `undefined` unless
`ctx.standalone`; the `literals.ts` and `dynamic-proto.ts` additions are
`ctx.standalone`-gated too. The actual source is
`src/codegen/export-throw-boundary.ts`, which **does not exist in the lane tree
at all** (`grep -rl __rethrow_host_exception` finds it only on the integration
branch) — the import is integration-branch drift between the lane snapshot and
the branch round 1 was cut from. Measured against the right comparand, host and
wasi bytes for `k1 k2 c4 h1b b5 d02b d10 d01b` are **byte-identical to r1** on
both targets (`sha` equal on every row). `x1`/`x3` from the brief do not exist
in either reviewer probe directory and were not measurable.

#### R2 — `super.missing()` on a `__proto__:` literal answered `undefined`

A true side effect of F1, and one the first cut's own reasoning covers. It kept
a typed default rather than §13.3.6's TypeError, on the argument that the
compiler "cannot see the whole prototype surface". Once F1 linked the literal's
real prototype, the compiler CAN see it: the lookup resolves, to `undefined`,
and the default is no longer conservative — it is a wrong answer where node
throws, and the ordinary `o.missing()` on the same object threw on every tree
(control `c12`).

`compileStandaloneObjectLiteralSuperMethodCall` now runs the same guard
`buildResolvedCalleeGuard` splices into `__extern_method_call`: absent
(null/undefined via `__nullish_to_null`) plus the POSITIVE primitive brands
`__typeof_number` / `__typeof_string` / `__typeof_boolean`, after the arguments
per §13.3.6.2 step 5. Sharing that shape is the point — a callable the brand
classifier does not recognise can never be turned into a throw, and a
non-callable plain object still reaches `__apply_closure`'s legacy `undefined`,
exactly as on the ordinary path (#4221 declined the negative classifier). So
"a plain object throws" is deliberately NOT implemented: doing it here and not
on `o.missing()` would re-create the very divergence this fixes.

| probe (standalone) | base | lane | r1 | this round | node 22 |
| --- | --- | --- | --- | --- | --- |
| `c01` `super.missing()` over a `__proto__:` literal | 40 | 2\* | 40 | **2** | 2 |
| `c12` control, ordinary `o.missing()` | 2 | 2 | 2 | **2** | 2 |
| `h4` `super.nope()`, TypeError caught in the method | — | — | null | **4** | 4 |
| `o1` `super.nope()` over `setPrototypeOf` | — | — | 1 | **91** | 91 |
| `p9` `super.zz()` with an empty proto | — | — | null | **92** | 92 |
| `h1b` / `i1` / `i2` present super method | — | — | 3 | **3** | 3 |
| `h3` / `o3` / `o4` present super method | — | — | 11 | **11** | 11 |
| `c07` present super method, bytes move | 4 | 4 | 4 | **4** | 4 |

\* the lane's `2` was the nullish-base escape (F1), not a callable test — the
right answer for the wrong reason, which is why it read as a regression when F1
fixed the base.

Class `super.missing()` was measured on base FIRST, as asked, so the answer is
not attributed. `class B extends A` where `A` has no `missing`, `super.missing()`
caught in the method (`.tmp/cls.ts`, five lines) answers **40 (`undefined`) on
base, lane, r1 and this tree alike**, against node 22's **2 (TypeError)**. So
this is a **pre-existing gap, not a change** — the class arm does not share the
object-literal lowering, and nothing this round did moves it. It is left open
deliberately: widening the guard to the class arm is a separate change with its
own regression surface (a class `super.m()` resolving through the static tables
has different miss semantics), and none of it was measured here.

#### Controls

- **Full probe sweep, both sets, standalone, this tree vs r1**: exactly the
  R1/R2 rows above move. Every other row is byte-identical (`sha` equal); 174
  probes total (73 in `rev5350/p`, 101 in `rev5350b/p`).
- **Host + wasi**: byte-identical to r1 on the named subset (above).
- **53-row super control** (`run-test262-paths.mts --isolate ctrl53.txt
  --standalone`): `{ compile_error: 2, fail: 27, pass: 24 }` — the same counts
  AND the same non-pass path SET as r1. Zero lost; the row r1 gained over the
  lane is kept.
- **Target rows**: identical to r1 — 8 of the target list present in `ctrl53`
  pass, the same 8 paths.
- **Pins**: `tests/issue-5350-super-property-r1.test.ts` grows from 13 to 18
  cases (three ReferenceError shapes for R1, plus the TypeError miss and its
  present-method regression guard for R2). 18/18 green on node 22 AND node 25.
  Neighbours green in ≤3-file batches: issue-2709 + issue-1824-super-as-value +
  issue-3522-super-accessor (38), issue-3024-static-super-arity + issue-5212 +
  issue-5309 (61), issue-5312 + issue-5195-es2015-class-r2 +
  issue-5195-r3-heritage-check (151), issue-5195-r3-restricted-properties +
  issue-5195-r3-review (30), issue-5270-es2015-expressions-r2 +
  issue-4527-call-dyn-bridge + issue-1058-generic-callback-result (155),
  closed-imports + safe-mode + issue-4376-deno-primordials-runtime (50).
- **Gates**: the chained source ratchets bare and with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`, plus `check:speculative-rollback`,
  `check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, the
  TS7 typecheck and lint — all exit 0. Growth stays inside this file's existing
  `loc-budget-allow` / `func-budget-allow` grants (restated 2026-09-06 for the
  same three files; `new-super.ts` +568 over the merge base).

#### Status after this round: still `in-progress`, deliberately

Unchanged from round 1, and for the same reason. The plan's acceptance criterion
**"13 rows (steps 1-5) pass"** still does not hold — the same 6 of them do, and
the other 8 are blocked by the pre-existing block-scoped-class capture defect the
r1 record isolated (repro `.tmp/w5350/q26.ts`, ten lines, no `super`). This round
neither improved nor worsened that count; it removed two regressions the round-1
fix introduced. Every other criterion holds: zero rows lost across the controls
measured, pins green on node 22 and node 25, host/wasi bytes identical,
`src/ir/select.ts` untouched, grants in this file. The status stays
`in-progress` until that blocker is filed and cleared or the criterion is
re-scoped. The 1,089-row class/super sweep remains deferred to the
integrated-tree run before the PR.

### Review round 3 (2026-09-06)

Three findings from the round-2 review, all confirmed against node 22 before any
edit and all fixed. Comparisons are against the **round-2 tree**
(`wf_2df860c7-e4b-1` @ `0cd31c943b`) — the tree this round was cut from — because
comparing a fix tree against the older LANE snapshot produces false host-byte
positives (the round-2 record's own refutation, carried forward).

#### S1 — the loop rule was position-blind; the decision is now made at runtime

Round 2 suppressed the ReferenceError for **any** `super.x` read inside a loop
that also contains a `super(...)`, reasoning that the back-edge might have run
that `super()` already. It might, or might not, and **the two cases are the same
lexical shape**, so no lexical rule can score both:

- `for (let i = 0; i < 1; i++) { v = super.zz; super() }` — iteration 1 reads
  with `this` uninitialised. Node throws.
- `while (true) { if (i === 1) { v = super.zz; break } super(); i = 1 }` — the
  same textual read is reached on iteration 2, `this` long initialised. Node
  answers 5.

**Shipped: the RUNTIME flag** (not the position-aware static fallback). A derived
constructor whose body contains such a read allocates an i32 local
`__js2_super_done` — zero at entry, so no initialising store is needed — every
`super(...)` lowering stores 1 into it on return, and the read emits
`local.get; i32.eqz; if → <the same ReferenceError>` before falling through to
the ordinary read. Straight-line reads with no enclosing loop keep the
unconditional throw. The flag is allocated by a pre-scan run **before** the
constructor body compiles, because a `super(...)` is routinely lowered before the
read that motivates it, and it lives on the constructor's own `FunctionContext`,
which is what makes a nested class's `super()` structurally unable to set it.

Two secondary corrections fell out. Both `super()`-scans (the "already completed
textually" one and the "a loop can carry one back" one) now skip **nested
classes**: a nested `class C extends A { constructor(){ super() } }` initialises
C's `this`, never the enclosing constructor's. Nested **functions** are still
descended into, because `const f = () => super(); f();` really does initialise it.

Measured standalone — node 22 / base / lane / r1 / r2 / this:

| probe | shape | node | base | lane | r1 | r2 | this |
| --- | --- | --- | --- | --- | --- | --- | --- |
| xa13 | `for` … read; `super()` | 9 | 6 | 9 | 6 | 6 | **9** |
| xa12 | `while`, same shape | 9 | 6 | 9 | 6 | 6 | **9** |
| xa3 | `do-while`, read under an `if` | 9 | 6 | 9 | 6 | 6 | **9** |
| xa11 | only a NESTED class's `super()` in the loop | 9 | 6 | 9 | 6 | 6 | **9** |
| n4, n5 | read on iteration 2 | 5 | 5 | 5 | 5 | 5 | 5 |
| xa1 | `super()` in a nested loop, read on iteration 2 | 6 | — | — | — | 6 | 6 |
| xa6, xa7, xa9 | labelled / `switch` / `try` back-edges | 6 | — | — | 6 | 6 | 6 |
| xa2, xa4, xa5 | `super()` after the loop (incl. for-of / for-in) | 9 | — | — | 9 | 9 | 9 |
| xa10 | both halves in one module | 96 | — | — | 96 | 96 | 96 |
| **xa8** | read inside an ARROW inside the loop | 9 | — | — | 6 | 6 | **6 — residual** |

xa8 is left unfixed and is **not** a regression: the arrow compiles to a separate
wasm function and cannot read the flag local, and a lexical rule cannot help
either, since an arrow's position says nothing about when it runs.

#### S2 — the callee guard tested absence, not callability

Round 2's guard was absence (`__nullish_to_null` + `ref.is_null`) plus the three
POSITIVE primitive brands. A resolved super member that is a plain **object** or
a **class** matches none of those and fell through to `__apply_closure`'s legacy
`undefined` — the same silent answer the r2 guard existed to remove, for a
different carrier. It now runs a POSITIVE `__typeof_function` test, the module's
canonical standalone IsCallable predicate; the brand guard is kept verbatim as
the fallback for a module that never registered it.

| probe | shape | node | base | lane | r1 | r2 | this |
| --- | --- | --- | --- | --- | --- | --- | --- |
| xb6 | `super.v()`, `v` is `{ q: 1 }` | 2 | null | 2\* | null | null | **2** |
| xb7 | `v` is a class `K` | 2 | null | 2\* | null | null | **2** |

\* the lane's 2 was the nullish-base escape, not a callable check.

Regression half — every callable carrier still CALLS, each measured on its own
over a named `__proto__` prototype, identical on r2 and here: bound 11, arrow 12,
getter-returned function 13, function with an own `prototype` 14, generator
(returns an iterator) 21, async function (returns a promise) 31.

Two residuals, both **byte-identical to r2** and therefore pre-existing:
`Math.max` as the super member throws a TypeError (how a builtin function object
survives as a literal property value), and `super.missing?.()` answers 8 where
node answers 7 (probe xb12).

#### S3 — the guard never reached an object literal's ACCESSOR body

`emitObjectLiteralMethodFn` passes the literal's local into
`compileArrowAsClosure` as the synthetic [[HomeObject]]; its sibling
`emitObjectLiteralAccessorFn` passed nothing. So a getter/setter body found no
home-object local, the object-literal `super` arm declined entirely, and **both**
the r1 resolution and the r2/r3 callee guard were dead code for accessors. That
is why xd1 was byte-identical across r1 and r2 — a different lowering path from
the method arm those rounds fixed. The accessor arm now takes the same
`objLocal`, under the same "only a body that mentions `super`" narrowing.

| probe | shape | node | base | lane | r1 | r2 | this |
| --- | --- | --- | --- | --- | --- | --- | --- |
| xd1 | `get g() { return super.missing() }` | 2 | null | null | null | null | **2** |
| m4 | `get g() { return super.m() }`, `m` present | 3 | null | null | null | null | **3** |

#### Controls

- **Probes**: all **213** across the three sets (73 `rev5350/p`, 101
  `rev5350b/p`, 39 `rev5350c/p`), standalone, this tree vs round 2 vs node 22.
  **Exactly 8 answers move** — xa3, xa11, xa12, xa13, xb6, xb7, xd1, m4 — and all
  8 move from disagreeing with node to agreeing. Set-differenced against node:
  round 2 disagrees on 67 rows, this tree on 59, and the 59 are a strict subset —
  **zero rows newly disagree**.
- **Host + wasi**: byte-identical to round 2 on
  k1/k2/c4/h1b/b5/d02b/d10/d01b/xa13/xb6, both targets.
- **53-row super control** (`run-test262-paths.mts --isolate ctrl53.txt
  --standalone`): `{ compile_error: 2, fail: 27, pass: 24 }` — the same 29
  non-pass paths as round 2, zero lost. All 8 target rows present in `ctrl53`
  still pass. `language/expressions/object/getter-super-prop.js` still fails but
  now on a LATER assertion — the getter resolves; what remains is
  `Object.setPrototypeOf` after creation, outside this round's scope.
- **Pins**: `tests/issue-5350-super-property-r1.test.ts` grows 18 → **27** cases
  (four S1 shapes, three S2, two S3). Green on node 22 **and** node 25.
- **Neighbours**, ≤3-file batches, all green: issue-2709 + issue-1824 +
  issue-3522-super-accessor; issue-3024 + issue-5212 + issue-5309; issue-5312 +
  issue-5195-es2015-class-r2 + issue-5195-r3-heritage-check;
  issue-5195-r3-restricted-properties + issue-5195-r3-review + issue-5270;
  issue-4527 + issue-1058-generic-callback-result + closed-imports; safe-mode +
  issue-4376.
- **Every `class`/`super` suite under `tests/`** (97 files beyond the neighbour
  list), ≤3 per fork. 20 test cases fail across 5 files — and the **identical
  set of 20 fails on the round-2 tree**, so all are pre-existing on the
  integration branch: issue-1965-super-ctor-body,
  issue-3522-ir-nested-class-{expression-,}ownership,
  issue-3522-nested-class-static, issue-4618-class-capture-owner-isolation.
- **Gates**: the chained source ratchets bare and with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`, plus `check:speculative-rollback`,
  `check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, the
  TS7 typecheck and lint — all exit 0, run before each of the three commits.
  New grants in this file: `loc-budget-allow` for `calls.ts` (+1 line, the
  nested-`super(...)` arm's flag store) and `func-budget-allow` for
  `compileClassBodiesInner` (+5) and `compileCallExpression` (+1). The
  alternative — wrapping `compileSuperCall` so the store has one home —
  registers a 387-LOC "new over-budget function" for what is only a rename, so
  the call-site form is the smaller change.

#### Status after this round: still `in-progress`, deliberately

Unchanged, and for the same reason as rounds 1 and 2: the plan's acceptance
criterion "13 rows (steps 1-5) pass" still does not hold, and the 8 that do not
are blocked by the pre-existing block-scoped-class capture defect the r1 record
isolated. This round moved 8 probe answers onto node and lost nothing. The
1,089-row class/super sweep remains deferred to the integrated-tree run before
the PR.

### Review round 4 (2026-09-06)

One finding from the round-3 review, confirmed against node 22 before any edit
and fixed. Comparisons are against the **round-3 tree** (`wf_8d67119a-97b-1` @
`5571887f12`) for ANSWERS, and against **this same tree with the fix reverted**
(the `.tmp/new-super.base.ts` file-copy A/B) for BYTES — this round's branch
merges the integration head `b7199194da`, which carries landed work round 3 did
not, so cross-tree byte comparison would report ~3.9 kB of unrelated growth on
every probe and prove nothing.

#### S1 — the runtime flag was trusted where nothing could set it

r3 allocates an i32 local `__js2_super_done` in a derived constructor when some
`super.<x>` read sits in a loop that also contains a `super(...)`, and stores 1
into it at every `super(...)` lowering. `containsSuperCall` deliberately
descends into nested FUNCTIONS (only classes are skipped), so a loop whose only
`super()` sits inside an arrow also classified `"runtime"` — but the store is
emitted by `emitSuperInitializedFlagStore(fctx)` at the lowering site, and
inside the arrow `fctx` is the ARROW's `FunctionContext`, a separate wasm
function whose `superInitializedFlagLocal` is `undefined`. The store is a no-op,
the constructor's flag stays 0, and the guard fires on every iteration —
a ReferenceError node never raises.

**Shipped: option (b), classification made consistent with where the store can
be emitted.** Not option (a) (a captured ref cell): the flag has no TypeScript
binding to capture, so threading it through closure capture would mean
synthesising one and wiring it into the capture machinery — far beyond a few
dozen lines, and touching a mechanism (mutable closure captures) that every
class in the corpus depends on. Instead `containsSuperCall` gained a
`skipNestedFunctions` parameter, and the enclosing-loop scan now asks two
questions: is there a carrier this compiler can INSTRUMENT (a `super(...)`
lexically in the constructor's own body) — then `"runtime"`, the flag is
trustworthy; else is there a carrier at all — then `"never"`, leave the read
UNGUARDED. The "completes textually before the read" scan is unchanged and still
descends into nested functions, because `const f = () => super(); f();` written
before the read really does initialise `this`.

The recorded cost of option (b): a read that really is reached before a nested
function's `super()` runs stays unguarded and answers `undefined` instead of
throwing. That is wrong against node — and it is exactly round-2 and base
behaviour, wrong in the direction that invents nothing.

Measured standalone — node 22 / round-2 / round-3 / this:

| probe | shape | node | r2 | r3 | this |
| --- | --- | --- | --- | --- | --- |
| **s1c2** | `while(true)`, read on iter 2, loop's only `super()` in an ARROW | 6 | 6 | **9** | **6** |
| **s1c** | same, `while (i < 2)` with `i++` | 7 | NaN | **9** | **NaN** |
| s1c3 | same, `(() => { super(); })()` | 6 | 6 | 6 | 6 |
| s1c4 | same, but the read is `this.a` (not `super.`) | 6 | 6 | 6 | 6 |
| s1c0 | same, `super()` DIRECTLY in the loop | 7 | NaN | NaN | NaN |
| xa13 / xa12 / xa3 | read before a direct `super()` in the same loop | 9 | 6 | 9 | 9 |
| xa11 | only a NESTED class's `super()` in the loop | 9 | 6 | 9 | 9 |
| xa1 | `super()` in a nested LOOP, read on iteration 2 | 6 | 6 | 6 | 6 |
| n4, n5 | read on iteration 2, direct `super()` | 5 | 5 | 5 | 5 |
| xa8 | the read itself is inside an arrow, before `super()` | 9 | 6 | 6 | **6 — residual** |

s1c is the same regression as s1c2 wearing a different mask: r3's spurious throw
turned into 9, and removing it exposes the pre-existing `super.zz` → NaN defect
that s1c0 shows on **every** tree including base. Both rows now match round 2
exactly. xa8 is the round-3 residual, unchanged and not touched by this round:
the read compiles inside the arrow's own function, which carries neither the
flag nor the straight-line throw.

#### Controls

- **Probes**: all **277** across the four sets (73 `rev5350/p`, 101
  `rev5350b/p`, 39 `rev5350c/p`, 64 `rev5350d/p`), standalone. Two comparisons,
  because they answer different questions:
  - **vs the round-3 tree**, answers only: **exactly 2 rows move** — s1c2
    (9 → 6, onto node) and s1c (9 → NaN, back onto round 2). Every other row
    is answer-identical.
  - **same-tree A/B** (this branch with `new-super.ts` reverted to its merged
    state), bytes included: **exactly 3 of 277 modules differ** — s1c, s1c2 and
    s1c3. The first two are the answer moves; s1c3 keeps answer 6 and loses 533
    bytes, the guard and flag local it no longer allocates. **274 modules are
    byte-identical.** Cross-tree byte comparison is not used and is not
    meaningful here: this branch merges `b7199194da`, which adds ~3.9 kB of
    unrelated landed runtime to every standalone module.
- **Host + wasi**: same-tree A/B over k1/k2/c4/c04/h1b/b5/d02b/d10/d01b/xa13/
  xb6/s1c/s1c2/s1c3 — **byte-identical on both targets**, every row. The change
  is inside `if (!ctx.standalone) return` territory by construction, and this
  measures it rather than asserting it.
- **53-row super control** (`run-test262-paths.mts --isolate ctrl53.txt
  --standalone`): `{ compile_error: 2, fail: 25, pass: 26 }` — **27 non-pass, a
  strict subset of round 3's 29, nothing lost.** The two that now pass —
  `language/expressions/super/prop-{dot,expr}-obj-ref-strict.js` — are **not**
  this round's doing: they pass on the pre-fix tree as well (isolate re-run with
  `new-super.ts` reverted), so they are landed work carried in by the
  integration-head merge. Attribution matters here; the control's job is that
  nothing regressed, and nothing did.
- **Pins**: `tests/issue-5350-super-property-r1.test.ts` grows 27 → **30** cases
  — the arrow-`super()` loop (s1c2), the immediately-invoked-arrow form (s1c3),
  and the read-inside-an-arrow residual (xa8) pinned at the answer that ships.
  All three sources omit `A.prototype.zz` per the file's convention, so node 22
  answers 5 / 5 / 9 (measured, not inferred) where the probes answer 6 / 6 / 9;
  the third is the documented disagreement. **30/30 green on node 22 and on
  node 25.**
- **Neighbours**, ≤3-file batches, all green: issue-2709 + issue-1824-super-as-value
  + issue-3522-super-accessor (38); issue-3024 + issue-5212-es2015-class-collection-super
  + issue-5309 (54); issue-5312 + issue-5195-es2015-class-r2 +
  issue-5195-r3-heritage-check (151); issue-5195-r3-restricted-properties +
  issue-5195-r3-review + issue-5270 (63); issue-4527 +
  issue-1058-generic-callback-result + closed-imports (109); safe-mode +
  issue-4376-eval-alias-regression (28). Closure/capture suites were **not**
  run: option (b) does not touch closure capture, which is the reason that
  batch was conditional.
- **Gates**: the chained source ratchets bare **and** with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`, plus `check:speculative-rollback`,
  `check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, the
  TS7 typecheck and lint — all exit 0. **No new growth grants**: the change is
  confined to `src/codegen/expressions/new-super.ts`, already granted in this
  file's frontmatter since r1.

#### Status after this round: still `in-progress`

Unchanged, for the reason rounds 1-3 give: the plan's "13 rows (steps 1-5) pass"
criterion still does not hold, blocked by the pre-existing block-scoped-class
capture defect. This round removed a regression the previous one introduced and
banked one byte-size improvement; the corpus position is otherwise where round 3
left it.

### Review round 5 (2026-09-06, Fable lane)

The round-4 reviewer found one shape the r4 rule still mis-guards: a loop
holding BOTH a constructor-body `super()` and a nested-arrow `super()` (probe
e15 `if (useArrow) { const f = () => { super() }; f() } else { super() }`,
called with `useArrow = true`; e12 the branch form). r4 returned `"runtime"` on
the strength of the body carrier, but on the executed path the arrow's call is
the one that ran, its flag store cannot land, and the read threw on an
initialised `this` (node 6, base 6, r2 6, r3 9, r4 9).

Fix (`classifySuperUninitializedRead`, new helper
`containsSuperCallInNestedFunction`): one untrusted carrier anywhere in the
enclosing loops leaves the read UNGUARDED (`"never"`), whatever else the loop
contains; `"runtime"` only when every carrier is a constructor-body `super()`.

Measured, standalone, node 22 / r4 / r5 (probes `.tmp/rev5350e/p`,
`.tmp/rev5350c/p`, `.tmp/rev5350d/p`, `.tmp/rev5350/p`):

| probe | node | r4 | r5 |
| --- | --- | --- | --- |
| e15 mixed carrier (natural) | 6 | 9 | **6** |
| e12 mixed carrier (branch) | 6 | 9 | **6** |
| e2 e4 e5 e7 e8 e13 e14 e11 (nested-only carriers) | 6 | 6 | 6 |
| e10 e3 (read really reached before the arrow's super) | 9 | 6 | 6 — accepted residual, base parity |
| xa13 xa12 xa3 xa11 (body carrier, read before it) | 9 | 9 | 9 |
| xa1 xa2 n4 n5 s1c2 s1c3 | 6 9 5 5 6 6 | same | same |
| xa8 (read inside an arrow) | 9 | 6 | 6 — documented residual |

Pins: two added (mixed carrier → 5 with `super.zz` absent; body-only control
→ 9). Gates and the pin file green on node 22 and 25 (see the commit).

**Round-5 review verdict (accepted residual, not fixed).** The single reviewer
showed the r5 rule is a swap, not a strict improvement: a nested-function
carrier anywhere in the enclosing loops now also disarms reads whose own loop
has a body carrier that DID run first (f10 dead arrow, f3/f2b outer-loop arrow,
f11 = e15 with `useArrow = false`) — node throws ReferenceError, r4 threw, r5
answers the prototype value; base answered the same value. f11 and e15 are the
SAME source with a different constructor argument, so no static rule decides
them; only a flag the nested function's `super()` could also store would (the
captured-cell design r4 rejected on cost). Between the two errors the project
standard picks r5's: it never invents a throw on a valid program (e15/e12 are
valid, r4 threw), it only misses one on a program node rejects. Pinned as the
shipped answer (f11 → 5). Byte-identical to r4 on wasi and host for all 316
probes; standalone differs only on e12/e15/e16/f3/f10/f11; the 53-row control
is identical to r4.

