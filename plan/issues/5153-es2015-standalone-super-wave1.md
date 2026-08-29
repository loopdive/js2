---
id: 5153
title: "ES2015 standalone: super conformance wave 1"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/class-bodies.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/spread-arguments-call.ts
  - src/codegen/object-runtime.ts
  - src/codegen/js-errors.ts
---

# #5153 — ES2015 standalone: `super` conformance wave 1

## Problem

All 51 `language/expressions/super/*` tests in the ES2015 work package fail on
the standalone target (re-verified 2026-08-28 against head via
`npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-super-current-fails.txt`:
50 FAIL + 1 COMPILE_ERROR, zero already-fixed). Root cause across most of the
bucket: `super` is compiled by **static** resolution (compile-time
class-parent maps, struct fields, funcMap) and silently emits a **default
value** (`ref.null.extern` / `f64.const 0`) whenever static resolution misses —
so dynamically-added prototype properties, receiver-threaded `this`,
spec-mandated TypeError/ReferenceError throws, spread-argument iterator
protocol, and abrupt completions are all lost. The runtime machinery to fix
this already exists (#3976 class-proto `$Object` sidecars, #4688 runtime super
reads for object literals, #5093 spread-with-`arguments` call lowering); wave 1
wires the class-method `super` paths onto it. 51 tests is one of the largest
single-directory blocks left on the road to 100% ES2015 standalone.

Growth allowance (2026-08-28): the files in `loc-budget-allow` above are the
exact lowering sites named in the plan below — new runtime lanes in
`new-super.ts`, spread/`arguments`/error wiring in `class-bodies.ts`, a super
write arm in `assignment.ts`, possible receiver-aware `[[Set]]` helper growth
in `object-runtime.ts`/`runtime.ts`, and reuse-driven adjustments in
`spread-arguments-call.ts`/`js-errors.ts`.

## Current failure clusters

Target list: `/home/user/js2/.tmp/es2015/wp-super-current-fails.txt` (51 paths,
identical to `wp-super-fails.txt` — nothing healed since the baseline).
Probes referenced below live in `/home/user/js2/.tmp/probes5153/` (run with
`npx tsx .tmp/probes5153/run-probes.mts <abs-path>.js`).

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| A | `super(...spread)` skips the iterator protocol; ctor `arguments` object missing | 14 | `src/codegen/class-bodies.ts:compileSuperCall` (~L3714-3775): runtime spread → `evaluateArgumentForSideEffects` + default-padded params + argc 0 — never calls GetIterator/IteratorStep/IteratorValue. Separately, the direct-new ctor body never calls `emitArgumentsObject` (methods do at class-bodies.ts:2853; only the Promise host-ctor arm at :3375 does for ctors) | call-spread-err-sngl-err-itr-step.js, call-spread-err-mult-err-itr-get-get.js, call-spread-sngl-iter.js |
| B | Class-method super reads/calls resolve statically, miss the runtime proto chain and the live receiver | 12 | `src/codegen/expressions/new-super.ts:compileSuperPropertyAccess` (L1038) and `compileSuperMethodCallCore` (L848): accessor-set/struct-field/funcMap walk, then emit a **default** (null/0). No runtime `[[HomeObject]]` → `__getPrototypeOf` → `__reflect_get_receiver` lane for class methods (only object literals have one, #4688 at L977). `super.m()` off `C.prototype.method()` gets a null struct `this` | prop-dot-cls-val.js, prop-dot-cls-ref-this.js, prop-expr-obj-ref-this.js |
| C | Missing spec throws: null/undefined super base → TypeError, uninitialized `this` → ReferenceError, second `super()` → ReferenceError, non-ctor proto → TypeError | 10 | Same default-emitting fallbacks as B (`new-super.ts`), plus `class-bodies.ts:compileSuperCall` never guards double-`super()` or a dynamically re-pointed non-constructor parent. `compileStandaloneObjectLiteralSuperPropertyRead` (#4688) does not RequireObjectCoercible its `__getPrototypeOf` result (probe p5-throw.js: caught=undefined) | prop-dot-obj-null-proto.js, prop-expr-cls-unresolvable.js, prop-dot-cls-this-uninit.js, call-bind-this-value-twice.js, call-proto-not-ctor.js |
| E | `super.x =` write path: no strict TypeError on failed [[Set]], no non-strict receiver-own-property define | 6 | No super arm in `src/codegen/expressions/assignment.ts` at all (grep `SuperKeyword` — zero hits); writes fall into generic paths that neither thread the receiver nor report [[Set]] failure. §6.2.3.2 PutValue steps 6.b-c unimplemented for super references | prop-dot-cls-ref-strict.js, prop-dot-obj-ref-strict.js, prop-dot-obj-ref-non-strict.js |
| D | `super[keyExpr]` with a non-static key never evaluates the key (abrupt completions lost) | 4 | `new-super.ts:compileSuperElementAccess` (L1178): `propName === undefined` branch emits a type-shaped default **without compiling `argumentExpression`**, so a throwing key expression / ToPropertyKey never runs | prop-expr-obj-err.js, prop-expr-cls-key-err.js |
| F | `super()` to a plain-function parent: no [[Construct]] this-override, ctor-throw not propagated | 3 | `class-bodies.ts:compileSuperCall`: fnctor-parent bridge is host-only (`!(ctx.standalone||ctx.wasi)` guard ~L3680); standalone falls to `evaluateArgumentForSideEffects` and returns. Parent return-object-overrides-`this` explicitly "out of scope" per the L3800 comment | call-expr-value.js, call-bind-this-value.js, call-construct-error.js |
| G | Deferred/out-of-wave | 2 | realm.js — cross-realm `$262.createRealm` semantics; call-construct-invocation.js — COMPILE_ERROR, the deliberate #3371 standalone Reflect.construct NewTarget refusal | realm.js, call-construct-invocation.js |

Cluster B breakdown: 8 value-reads (`*-cls-val`, `*-val-from-arrow`,
`*-val-from-eval` — the 4 from-eval variants additionally need the
QuickJS runtime-eval tier to see the super binding, see step B3) + 4
receiver tests (`*-ref-this`).

## Implementation Plan

Ordered by test yield, descending. Every new lowering must be host-free in
standalone mode (the runner FAILS any test whose module emits host imports —
`standaloneHostImportError`); route helpers through `ensureObjectRuntime` /
`ensureLateImport`-to-native like the neighboring #4688/#3976 code does. All
new type queries via `ctx.oracle` (src/checker/oracle.ts), never
`ctx.checker.getTypeAtLocation` directly (oracle-ratchet gate) — the existing
`checker.*` calls in `new-super.ts` are grandfathered; do not add new ones.

### Step A — `super(...spread)` iterator protocol + ctor `arguments` (14 tests)

1. In `class-bodies.ts:compileSuperCall`, regular-parent arm (~L3714): replace
   the runtime-spread fallback (evaluate-for-side-effects + default pad +
   argc 0) with the #5093 helper
   `compileSpreadCallArgsWithArguments(...)`
   (`src/codegen/expressions/spread-arguments-call.ts:84`) targeting
   `${parentClassName}_init`. It flattens via `emitSetExtrasArgv` (evaluating
   each argument exactly once, iterator protocol included), binds formals,
   sets `__argc`/`__extras_argv`. Fall back to `compileSpreadCallArgs`
   (`expressions/extern.ts:853`) when its preconditions fail. Evidence the
   protocol machinery is correct: probe p4b-spread-fn.js (`f(...customIter)`
   on a plain function) PASSES today; the same lowering reaches parity for
   `super(...)`. Mind the trailing `self` param of `_init`: it is pushed
   AFTER the user args (see the existing `local.get selfLocal` at ~L3776) —
   pass `paramOffset`/param-slicing accordingly (`paramTypes` there already
   strips it).
2. Give class constructors an `arguments` object: in the direct-new ctor body
   compile (the `_init`/`_new` split, class-bodies.ts ~L2081-2100), mirror the
   method arm at class-bodies.ts:2853 — `if (needsImplicitArgumentsObject(ctor))
   emitArgumentsObject(ctx, fctx, ctorParamTypes, paramOffset, /*unmapped*/ true)`
   (class bodies are strict code). Probe p3b-args.js shows `arguments.length`
   is `undefined` even for a plain `new Q(7,8,9)` — this sub-fix alone flips
   nothing in this bucket without A.1, but A.1's two `call-spread-*-iter.js`
   tests assert `arguments.length`/`arguments[i]` in the parent ctor, so both
   halves are required. Also confirm `ctx.funcUsesArguments.add(...)` is
   recorded for `_init` so `maybeSetArgcForKnownCall` at super() call sites
   seeds `__argc` (compileSuperCall already calls it at ~L3773).
3. The 12 `call-spread-err-*` tests only need the iterator-protocol abrupt
   completions to surface (poisoned `Symbol.iterator` get/call, poisoned
   `next`/`step`/`value`); they should all flip from A.1 alone. Verify with
   the probe before touching anything else.

### Step B — runtime super reads for class methods, receiver-aware (12 tests)

1. Generalize the #4688 lane: in `new-super.ts:compileSuperPropertyAccess`
   (L1038) and `compileSuperElementAccess` (L1178), BEFORE each
   default-emitting fallback (the base-class branch at ~L1068, the
   end-of-function fallback at ~L1160, and the elementAccess twins), add a
   standalone lane that mirrors `compileStandaloneObjectLiteralSuperPropertyRead`
   (L977) but with the CLASS home object: the #3976 prototype sidecar for
   `resolveEnclosingClassName(fctx)` (from `ctx.protoGlobals`, materialized by
   `emitStandaloneClassProtoObject` /
   `expressions/extern.ts:emitStandaloneClassProtoObject` call at
   extern.ts:268). Emit `__getPrototypeOf(<own proto sidecar>)` →
   `__reflect_get_receiver(proto, key, <receiver>)`. Keep the existing static
   accessor/struct-field fast paths FIRST — only replace the default-value
   fallbacks, so currently-passing typed code keeps its lowering (order
   preservation; do not regress the 7 spot-check tests).
2. Receiver: use the struct `this` when present AND non-null, else
   `__current_this` (`ensureCurrentThisGlobal`, the established standalone
   dynamic-dispatch carrier — see the #2637 comment in the #4688 helper).
   Probe p2-proto-this.js: instance call already binds `this` correctly; the
   prototype-invoked call (`C.prototype.method()`) yields null — that is the
   `*-ref-this` failure. Same receiver rule applies to
   `compileSuperMethodCallCore` (L848): when the static funcMap dispatch
   misses OR the invocation is receiver-dynamic, lower `super.m(args)` as
   runtime read of `m` + call-with-receiver via the receiver-aware call path
   (`expressions/call-receiver-method.ts:compileReceiverMethodCall` — the
   same file #4688 touched); the object-literal branch of
   `compileSuperMethodCallCore` (`evalArgsAndDefault` when no enclosing class,
   L856) is what returns null for `prop-*-obj-ref-this` and must take this
   lane too.
3. Prerequisite to verify FIRST (cheap, one probe): dynamic writes
   `A.prototype.x = 'a'` must land where `__getPrototypeOf`-chained reads
   look. Probe p7b-protowrite.js shows `A.prototype.x = 'a'; A.prototype.x`
   reads back `undefined` today — find where that write lands (suspects:
   assignment path routing to the legacy defaulted struct via
   `expressions/extern.ts:emitLazyProtoGet` instead of the #3976 `$Object`
   sidecar, or a dropped `__extern_set`). Without this, B.1 reads resolve the
   chain (probe p6 confirms `Object.getPrototypeOf(B.prototype) === A.prototype`
   passes) but find no properties. This sub-fix likely also flips tests
   outside this work package (inherited dynamic props, probe p6's
   `inst.x` read).
4. The 4 `*-val-from-eval` tests run `super.fromA` inside direct `eval` —
   the QuickJS runtime-eval tier needs the home object + receiver threaded
   into the eval activation. Do this LAST within B; if the eval-tier plumbing
   turns out to be Lane-A territory (runtime-eval goal per
   plan/method/lane-partition.md), split it out as a follow-up issue rather
   than blocking the wave — 4 tests.
5. The 2 `*-val-from-arrow` tests need the class-method arrow to capture the
   super binding; `closures.ts` already has `SUPER_HOME_OBJECT_CAPTURE_NAME`
   plumbing (closures.ts:175, :3215) from #4688 — extend the capture trigger
   to arrows inside class methods, seeding the class proto sidecar as the
   captured home object.

### Step C — spec throws (10 tests)

1. RequireObjectCoercible in every runtime super-read lane (B lanes AND the
   existing #4688 object-literal lane): after `__getPrototypeOf`, if the base
   is null/undefined → `emitThrowTypeError` (`src/codegen/js-errors.ts:` —
   `emitThrowJsError` family, standalone-safe). Flips the 4 `*-null-proto`
   and, together with B's runtime lane (which makes the access actually
   evaluate), the 2 `*-unresolvable` tests.
2. Uninitialized-`this` ReferenceError (2 `*-this-uninit` tests): in a
   DERIVED ctor, a super property access lexically before the first `super()`
   statement must throw ReferenceError (`emitThrowReferenceError`,
   js-errors.ts:119). A lexical position check inside the ctor body is
   sufficient for both tests (the access is in straight-line code before
   `super()`); do NOT attempt a full runtime this-TDZ in this wave.
3. Double `super()` ReferenceError (call-bind-this-value-twice.js): track a
   per-ctor i32 `__super_called` local in derived ctors; second `super()` →
   `emitThrowReferenceError`. Guard emission to derived ctors that contain
   ≥2 lexical `super()` sites or a `super()` under try/catch, to keep the
   common single-call ctor lowering byte-identical.
4. Non-constructor proto TypeError (call-proto-not-ctor.js):
   `Object.setPrototypeOf(C, parseInt)` then `new C()` → arguments still
   evaluate, then TypeError. This requires the super() dispatch to consult
   the DYNAMIC parent when the class object's proto was re-pointed — check
   `dynamic-proto.ts`'s hierarchy bookkeeping for whether re-pointing is even
   recorded for class objects in standalone; if not, a narrow arm — "class
   object's proto global was overwritten with a non-constructor → throw at
   super()" — covers the test. Keep it AFTER argument evaluation
   (ArgumentsListEvaluation order is asserted).

### Step E — `super.x =` write path (6 tests)

Add a super arm to the assignment lowering (`expressions/assignment.ts` —
currently zero `SuperKeyword` hits): lower `super.x = v` / `super[k] = v` as
receiver-aware `[[Set]]`: base = `__getPrototypeOf(<home object>)`, receiver =
current `this`. Reuse the strict-set layering in
`src/codegen/object-runtime-strict-set.ts` (`__reflect_set` returns the
[[Set]] boolean; strict wrapper throws TypeError on false) for the 4
`*-ref-strict` tests; in non-strict (sloppy) code, [[Set]] with a receiver
that lacks the property defines it as an own property of the RECEIVER
(§10.1.9.2 OrdinarySetWithOwnDescriptor) and silently no-ops on a frozen
receiver — that is exactly the 2 `*-ref-non-strict` assertions. If
`__reflect_set` does not yet take a distinct receiver parameter, add a
`__reflect_set_receiver` native to the object runtime
(`src/codegen/object-runtime.ts`), modeled on `__reflect_get_receiver`
(object-runtime.ts:~2158) — native definition, no host import.

### Step D — `super[keyExpr]` dynamic keys (4 tests)

In `compileSuperElementAccess` (new-super.ts:1178): in the
`propName === undefined` branch, stop emitting a bare default. Compile
`expr.argumentExpression` (so its abrupt completion propagates — that alone
flips the 4 `*-err`/`*-key-err` tests), coerce to a property key (ToPropertyKey
via the existing dynamic-key machinery `dyn-read.ts` uses), then feed the
runtime read lane from step B with the runtime key instead of a string
constant. Same for the element form of the write path in step E.

### Step F — plain-function parent `super()` (3 tests)

`class Child extends Parent` where `Parent` is a `function` declaration:
extend the fnctor-parent branch in `compileSuperCall` (~L3680, currently
host-only) with a standalone arm: call the fnctor with `this` = the allocated
derived receiver (the fnctor is in `ctx.funcMap` — `fnctorAncestorOfClass`
resolves it), propagate its throw (call-construct-error.js needs nothing more
than actually CALLING it), and honor return-override: if the parent returns an
object, that object becomes `this` for the rest of the ctor and the completion
value of `new` (call-expr-value.js asserts `value = super()` IS that object;
call-bind-this-value.js asserts `this` after `super()` IS it). Return-override
means the derived `this` must be re-bound after `super()` — mirror how
`_init`'s own return value is already threaded for the direct-construction
path ("constructor-return-override plumbing", see the comment at the end of
compileSuperCall ~L3798). This is the highest-complexity/lowest-count step —
do it last; if re-binding `this` across the ctor body is too invasive, land
call-construct-error.js (throw propagation only) and file the residual.

### Out of scope for this wave (2 tests)

- `realm.js` — needs `$262.createRealm` cross-realm object identity; not a
  super bug.
- `call-construct-invocation.js` — intentional COMPILE_ERROR from the #3371
  standalone Reflect.construct NewTarget refusal; do not "fix" by weakening
  that guard.

### What NOT to do

- No new host imports without a standalone fallback — the runner fails the
  whole test on any host import in standalone mode. All helpers must be
  native (`ensureObjectRuntime` / defined-function route).
- Never edit `tests/test262-runner.ts`, skip lists, or
  `scripts/*baseline*.json`.
- Do not replace the static super fast paths (accessor set, struct fields,
  funcMap dispatch) — add the runtime lane only where the code currently
  emits a silent default. The 7 tests in
  `.tmp/es2015/wp-super-passing-spotcheck.txt` and the equivalence suite are
  the order-preservation checks.
- Do not add new raw `ctx.checker.*` type queries in touched code — use
  `ctx.oracle` (oracle-ratchet gate).
- Do not hand-refresh `scripts/ir-fallback-baseline.json` unless a gate
  legitimately reports a decrease (`--update-on-decrease`).

## Acceptance criteria

- All 51 paths in `/home/user/js2/.tmp/es2015/wp-super-current-fails.txt` pass
  via `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-super-current-fails.txt`
  (the 2 cluster-G tests may instead be explicitly re-dispositioned in this
  issue file with a one-line reason each if the wave lands without them).
- Every test in `/home/user/js2/.tmp/es2015/wp-super-passing-spotcheck.txt`
  (7 paths) still passes.
- Ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports` (also with
  `LOC_GATE_BASE` at upstream-main tip).
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## References

- #4688 — object-literal runtime super reads (done); the lane this wave
  generalizes to class methods. Related there: #2671, #3594, #4444.
- #3976 — standalone class prototypes as real `$Object` sidecars (done); the
  home-object representation step B stands on.
- #5093 — `compileSpreadCallArgsWithArguments` (done); step A's helper.
- #1551 — super() argument-evaluation order (done); step A must preserve its
  ArgumentListEvaluation guarantees.
- #3371 — standalone Reflect.construct NewTarget refusal (done); source of the
  call-construct-invocation.js COMPILE_ERROR (cluster G).
- #3024 — static-super receiver modeling gap (noted in
  compileSuperPropertyAccess's L1090 comment); adjacent, not covered here.
- #1965 — `super(args)` as a real `${parent}_init` call; the frame step A and
  F extend.
- #1054 — derived-class indirect-eval supercall (done); prior art for the
  eval-tier super plumbing in step B.4.
