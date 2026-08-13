---
id: 4265
title: "`Function.prototype`, ES5 standalone: bucket diagnosis — `ToString` of a callable answers `[object Object]`, an object-literal method call does not bind `this`, and most `toString` residue is a MISSING function value, not a wrong string"
status: in-progress
sprint: current
created: 2026-08-09
updated: 2026-08-13
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: function-prototype
goal: es5
related: [4096, 3117, 1888, 1463, 2660, 2928, 4190, 4203, 4246, 4269]
assignee: "ttraenkler/senior-dev"
origin: "ES5-standalone-90 program, `Function.prototype` bucket. First diagnosis of this bucket."
---

# #4265 — `built-ins/Function/prototype`, standalone: signature breakdown and root causes

## Measurement

All 309 files under `built-ins/Function/prototype`, sequential
`runTest262File(…, "standalone")`, **runtime-eval tier: REFUSAL**
(`--refusal-only`, key `53838e1372b11156`). The 47 `dynamic code evaluation is
not supported` entries are an artefact of that tier and would mostly pass under
`TEST262_FULL_RUNTIME_EVAL=1`; they are excluded from every root-cause count
below and are identical in both arms.

Base (`upstream/main` e1aeff7c2): **152 pass / 148 fail / 9 compile_error.**

| sub-directory | fail | CE | eval-refusal | pass |
| --- | --- | --- | --- | --- |
| `toString` | 44 | 0 | 1 | 35 |
| `bind` | 23 | 5 | 0 | 72 |
| `Symbol.hasInstance` | 11 | 0 | 0 | **0** |
| `apply` | 9 | 0 | 22 | 17 |
| `call` | 5 | 0 | 22 | 22 |
| everything else | 12 | 4 | 2 | 6 |

## Root causes, with evidence

### RC-1 — `ToString` of a CALLABLE answers `[object Object]` (FIXED, +0 here)

§13.15.3 `"" + f` runs ToPrimitive(f, string), which reaches
`Function.prototype.toString` (§20.2.3.5) — never
`Object.prototype.toString`. The standalone concat cascade
(`compileNativeConcatOperand`) had no callable arm, so a function operand fell
through to `$__any_to_string`, whose terminal is the literal `"[object Object]"`.

Fixed in `src/codegen/callable-to-string.ts` +
`src/codegen/string-ops.ts`: a **statically** callable operand (the checker
reports call or construct signatures) emits §20.2.3.5 step 3's NativeFunction
form. Verified: `"" + plain` and `"" + ClassValue` were `[object Object]`, now
`function () { [native code] }`; a class INSTANCE, an object literal, an array
and a user `toString` are all unchanged.

**Measured effect on this bucket: 0.** Stated plainly because it is the
load-bearing finding for whoever picks this up: the failing population does its
stringification **inside the harness**, in
`assertToStringOrNativeFunction(fn, expected) { const actual = "" + fn; … }`,
where `fn` is an untyped parameter. `any` has no call signatures, so a static
predicate can never see it. Regression-checked at 0/0 over
`built-ins/Function/prototype` (309), `language/expressions/addition` (48) and
`language/expressions/concatenation` (5).

**The remaining 15 need the RUNTIME arm**, in `$__any_to_string`'s terminal
(`objectOrErrorTag`, `src/codegen/native-strings.ts`): `ref.test` the value
against the funcref-wrapper ROOT struct
(`getFuncRefWrapperRootTypeIdx`) and against `objectRuntimeTypes.proxyTypeIdx`
with a callable target, and answer NativeFunction before the object tag. Both
type indices are already in `ctx`; what is unverified is whether every closure
representation actually subtypes that root, which is the one thing to measure
before building it.

### RC-2 — `toString` residue splits three ways, and only one third is a STRING defect

The 44 `toString` failures all report
`Conforms to NativeFunction Syntax: <actual>`. Bucketed by `<actual>`:

| actual | files | meaning |
| --- | --- | --- |
| `"[object Object]"` | **15** | the value IS the function; the STRING is wrong — RC-1's runtime arm. All 10 `proxy-*` files + all 5 `class-{declaration,expression}-*`. |
| `"undefined"` | **19** | the value could not be OBTAINED. Class getters/setters via `getOwnPropertyDescriptor`, class-expression methods, async/generator methods, computed-name methods. |
| `"null"` | **8** | ditto. Static class methods, private static methods, `AsyncFunction`/`GeneratorFunction`/`AsyncGenerator` constructor results. |

**27 of the 44 are not `toString` bugs at all** — they are missing
property-access results on class prototypes/constructors and on accessor
descriptors. Anyone staffing "Function.prototype.toString" should read that
table first; fixing stringification cannot move them.

For the 10 `proxy-*` files the NativeFunction answer is not an approximation:
a Proxy has no `[[SourceText]]`, so §20.2.3.5 step 3 makes it the **only**
conforming answer.

### RC-3 — an object-literal method call does not bind `this` (NOT FIXED, unfiled before now)

Confirmed by isolated probe, standalone script goal:

```js
var obj = { x: 42, m: function () { return this.x; } };
obj.m();          // NOT 42
obj.m.call(obj);  // 42            ← the composition works
typeof this;      // "object"      ← `this` is bound to SOMETHING, just not obj
```

Mechanism: the callable-field call path in
`src/codegen/expressions/calls-closures.ts` (the `closureInfo` /
`getOrCreateFuncRefWrapperTypes` arms) pushes **the closure ref itself** as the
lifted function's first parameter — that slot is the closure's `self`
environment, not the ECMAScript `this`. Nothing threads the receiver. #4096
built exactly the missing composition (`__apply_closure(F, T, args)`) for the
EXPANDO shape (`o.f = function(){}`) and deliberately narrowed itself to
members "some `<expr>.<name> = …` assignment could have stored", so a member
declared in the object literal is not claimed by it.

**How much of this bucket it accounts for: a minority, but a real one.** The
`apply`/`call` residue includes
`The value of this["…"] is expected to be "…"` (`S15.3.4.3_A3_T6`,
`S15.3.4.4_A3_T6`) and `The value of obj.touched is expected to be true`
(`S15.3.4.3_A5_T6`, `S15.3.4.4_A5_T6`) — receiver-threading failures of exactly
this shape. Its real value is outside this bucket: `obj.m()` is the single most
common shape in ordinary JavaScript, so this is a correctness hole far wider
than the 63 files that motivated the investigation. **Recommend filing the fix
as its own issue at high priority rather than folding it into a
`Function.prototype` push.**

### RC-4 — `Symbol.hasInstance`: 11 files, 0 passing

`Function.prototype[Symbol.hasInstance]` is not implemented as a real function.
Signatures: `Cannot convert undefined or null to object` (`length.js`,
`name.js`), `[object Object] should be an own property` (`prop-desc.js`), and
six `dereferencing a null pointer` runtime errors in the `value-*` /
`this-val-*` files. A whole-subdirectory greenfield; needs OrdinaryHasInstance
plus the property descriptor.

### RC-5 — `bind`: 23 fail + 5 CE, several distinct mechanisms

Not one defect. In descending size: five `15.3.4.5-2-*` files trap with
`dereferencing a null pointer`; three `instance-name*` files read `undefined`
for the bound function's `name`; two `instance-length-*` read `NaN` for
`length`; four need `Reflect.construct` with a distinct NewTarget (a standalone
refusal today); one reports `Function.prototype.bind is not yet implemented in
--target standalone`. Worth splitting before staffing.

### RC-6 — the `length` / `name` / `prop-desc` cluster is the DELETE half, not the getter

Confirming the prior wave's lead: `gOPD(fn, "length").configurable` is already
`true`. The failures (`length should be an own property`,
`caller should be an own property`, `arguments should be an own property`,
`name descriptor …`) are in `verifyProperty`'s delete-and-recheck half — the
property cannot actually be deleted and re-defined on the function object.

## What landed here

Only RC-1's static arm (see above), plus its regression tests. It is included
because it is a real §20.2.3.5 violation with a proved-zero blast radius, not
because it moves this bucket — it does not.

- `src/codegen/callable-to-string.ts` (new)
- `src/codegen/string-ops.ts` (`compileNativeConcatOperand`)
- `tests/es5-standalone-callable-tostring.test.ts`

## Acceptance criteria

- [x] Signature breakdown of all 309 files, with the eval-tier artefact
      separated out.
- [x] RC-1 static arm implemented, tested, 0 regressions over 362 measured files.
- [x] RC-3 confirmed by isolated probe and its mechanism located to a named
      function.
- [ ] RC-1 runtime arm (`$__any_to_string` callable test) — 15 files.
- [ ] RC-3 receiver threading for object-literal methods — file separately.
- [ ] RC-4 `Symbol.hasInstance` — 11 files.
- [ ] RC-5 `bind` — split first.

## Implementation Plan

### Focused ES5 `apply`/`call` scope (2026-08-13)

This section supersedes the earlier refusal-tier diagnosis **only for the ES5
`Function.prototype.{apply,call}` cluster**. Define the exact population by
intersecting the runner's edition-manifest index for ES5 with the two directory
prefixes and excluding the Intl402 manifest. Cross-check the resulting 85 paths
against source frontmatter with:

```sh
rg -l '^es5id:' test262/test/built-ins/Function/prototype/{apply,call} | sort
```

The `es5id:` search is a consistency check, not the cohort definition. Assert
that the manifest contains exactly 85 unique paths before comparing results.
A prior assigned snapshot reports standalone QuickJS at **43 pass / 42
nonpass**, with 38 of the 42 containing `Function` or `new Function`; the
corresponding host snapshot is **30 pass / 55 nonpass**, with 48 of 55 containing
those constructs. A separate cached standalone artifact reports **41/44** and
also contains 38 Function-constructor failures. These artifacts have different
provenance and are not interchangeable; do not infer the two-row delta. Before
Terra edits, measure and archive a fresh exact-main (`8a2baecf3`) 85-row baseline
in both lanes, including commit, manifest hash, provider artifact hash, and
engine/tier metadata. That fresh artifact becomes the acceptance baseline.

### Root-cause proof

The primary defect is planning/emission drift, not a missing `apply`/`call`
dispatcher:

1. `sourceUsesRuntimeEvalBoundary` (~3536) and
   `callUsesRuntimeEvalBoundary` (~3585) in `src/codegen/index.ts` classify an
   unshadowed global `Function(...)` as a
   runtime boundary only when at least one argument is not a string literal.
   That answer controls IR demotion, `runtimeEvalCallableBoundaryEnabled`, and
   `runtimeEvalGlobalFunctionBindings`.
2. `tryStaticFunctionCtorCall` (~1763) in
   `src/codegen/expressions/eval-inline.ts` is deliberately best-effort.
   `synthesizeStaticNewFunction` (~1533) rejects a literal body containing `this`
   because an AOT-spliced function cannot model sloppy global `this`; emission
   then falls through to `emitStandaloneDynamicFunctionRuntime` and imports
   `js2wasm:runtime-eval.__runtime_new_function`.
3. A current-base probe with
   `Function("this.field = 1")(); return globalThis.field` proves the mismatch
   in emitted WAT: the provider import and result-envelope decode are present,
   but the following `globalThis.field` read contains no `$RuntimeEvalValue`
   test. Making the body a non-literal enables the pre-scan flag and adds that
   decode. This rejects the alternative that the provider was never entered.
4. In `scripts/quickjs-eval-provider.mjs`,
   `__runtime_apply_interpreted` (~3179) invokes the QuickJS function and mirrors
   fresh realm globals through `qjsMirrorRealmProperty` (~1634). A primitive is stored in the
   caller's shared global object as `__runtime_eval_wrap_result(value)`, i.e. a
   canonical carrier, not a caller-local primitive. This explains the observed
   `[object Object]` values.
5. `emitRuntimeEvalResultUnwrap` (~536,
   `src/codegen/expressions/runtime-eval-provider.ts`) already decodes call
   results, and `fillApplyClosure` (~5440,
   `src/codegen/object-runtime.ts`) plus `fillClosureMethodCall` (~766,
   `src/codegen/closure-props.ts`) already route callable
   `.apply`/`.call` through `__apply_closure`. Do **not** add another dispatcher;
   it would duplicate working invocation logic and would not repair the later
   shared-property read.

The four non-dynamic failures have two separate causes and must not be credited
to the runtime-eval change:

- `apply/S15.3.4.3_A3_T6` and `call/S15.3.4.4_A3_T6`: the function-literal
  fast path in `compileCallExpression` (~6961,
  `src/codegen/expressions/calls.ts`)
  inlines `.apply(null)` / `.call(null)` into its enclosing constructor.
  `planInlinedReceiver` (~81) in
  `src/codegen/expressions/inlined-call-receiver.ts` rejects a nullish receiver,
  so `ThisKeyword` resolves the outer constructor's `this`; an isolated probe
  writes to the constructed instance instead of the sloppy global object.
- `apply/S15.3.4.3_A1_T2` and `call/S15.3.4.4_A1_T2`:
  `tryIdentifierNamespaceAndStaticReceiverRead` (~1715,
  `src/codegen/property-access-dispatch.ts`) represents standalone
  `Function.prototype` as `$NativeProto`, then
  `tryCompileFnctorPrototypeAssign` (~216,
  `src/codegen/expressions/fnctor-prototype.ts`) stores it as
  `FACTORY.prototype`. Instance
  prototype lookup follows `$Object.$proto`, so the assigned `$NativeProto`
  cannot supply inherited callable `apply`/`call`. A current-base probe returns
  `typeof obj.apply !== "function"`. This is a prototype-representation defect,
  not provider behavior.

### Changes

#### 1. Make the runtime-eval plan IR-owned and conservative

**New file: `src/ir/runtime-eval-boundary-plan.ts`**

- Add backend-neutral immutable types:

  ```ts
  type IrRuntimeEvalSiteKind =
    | "direct-eval"
    | "indirect-eval"
    | "function-constructor"
    | "intrinsic-value"
    | "provider-definition";

  interface IrRuntimeEvalSite {
    sourceId: string;
    start: number;
    end: number;
    kind: IrRuntimeEvalSiteKind;
    providerDisposition: "required" | "may-fallback" | "provided";
    literalSource?: string;
  }

  interface IrRuntimeEvalBoundaryPlan {
    sites: readonly IrRuntimeEvalSite[];
    providerMayExecute: boolean;
    sharedRealmMayContainCanonicalValues: boolean;
    callableBoundaryRequired: boolean;
    unknownDynamicSource: boolean;
    dynamicSourceFragments: readonly string[];
  }
  ```

- Implement `buildIrRuntimeEvalBoundaryPlan(sourceFiles, oracle)`. Model this
  after the semantic inventories in `src/ir/with-environment.ts` and
  `src/ir/module-init-plan.ts`; do not put Wasm type indices or instructions in
  the plan.
- Classify **every** unshadowed global `Function(...)` and
  `new Function(...)` site as `may-fallback`, including all-literal calls.
  Static synthesis can decline for `this`, a strict directive, unsupported
  syntax, or a failed hoist, so literals do not prove that the provider is
  unreachable. Keep direct/indirect eval, first-class intrinsic values, and
  provider definitions at least provider-potential according to their existing
  oracle classifications.
- Derive `sharedRealmMayContainCanonicalValues` from provider reachability, not
  from reassigned function globals. `callableBoundaryRequired` remains the
  projection used for callback/function transport. Preserve
  `unknownDynamicSource` and `dynamicSourceFragments` so live globals can be
  widened with the same precision as today.

**File: `src/codegen/context/types.ts`**

- Add `runtimeEvalBoundaryPlan?: IrRuntimeEvalBoundaryPlan` to
  `CodegenContext`. The optional form permits existing unit-test contexts; a
  production standalone module that can emit a provider call must always have
  a plan.

**File: `src/codegen/index.ts`**

- In `generateModule`, build the plan once immediately after
  `createCodegenContext` (~4247), before signature/type planning, and attach it to the
  context. Build the equivalent graph-wide plan in `generateMultiModule` so a
  provider site in one source file enables decode for shared state read in
  another.
- Replace the three independent uses of `sourceUsesRuntimeEvalBoundary`: IR
  whole-unit demotion in `planIrOverlay` (~2639), assignment of
  `runtimeEvalCallableBoundaryEnabled`, and the scan in
  `registerReassignedFunctionGlobals` (~6821). Make the old helper a thin projection of
  the plan or delete it; delete `callUsesRuntimeEvalBoundary` as a second source
  of truth.
- Pass the plan to `registerReassignedFunctionGlobals`. Continue using its
  `unknownDynamicSource` / `dynamicSourceFragments` projection for live-global
  widening; `runtimeEvalGlobalFunctionBindings` may remain for that purpose,
  but it must no longer gate canonical-value decoding.
- Add an assertion or diagnostic when emission attempts a provider fallback at
  a site the plan marked unreachable. Never mutate the plan after Wasm
  signatures/types have been selected.

This ownership is required for backend neutrality: WasmGC lowers the semantic
boundary to `$RuntimeEvalValue`; linear/Porffor backends may choose an equivalent
carrier, or explicitly reject a provider-required site. They must not inherit a
WasmGC AST heuristic as an implicit contract.

#### 2. Decode every value freshly read from provider-shared storage

**File: `src/codegen/global-environment.ts`**

- Add `runtimeEvalSharedValueReadsEnabled(ctx)`, based on
  `ctx.runtimeEvalBoundaryPlan.sharedRealmMayContainCanonicalValues` and the
  diagnostic kill switch below. Reuse the existing
  `emitRuntimeEvalSharedValueUnwrap`; do not duplicate the kind ladder.
- Keep `emitRuntimeEvalGlobalRead`'s existing unwrap (~363) and audit it under
  the same predicate.

**Files: `src/codegen/property-access-dispatch.ts`,
`src/codegen/property-access.ts`**

- Replace every `runtimeEvalGlobalFunctionBindings === true` guard around a
  read-side unwrap with `runtimeEvalSharedValueReadsEnabled(ctx)`. This includes
  `tryGlobalThisAndProcessRead` (~1597) after `__extern_get` and all generic
  externref element/property-read branches in `compileElementAccessBody`
  (~4512).
- Apply the helper exactly once, immediately after a value is loaded from
  provider-shared realm storage and before JS operations or coercion. Do not
  decode local values, decode `emitRuntimeEvalResultUnwrap` a second time, or
  add a second carrier wrapper on writes. A non-carrier externref must be
  identity-preserved.

The canonical ABI is already defined by
`src/codegen/runtime-eval-boundary.ts`:

- kind `0` reference, `1` undefined, `2` null, `3` number, `4` boolean,
  `5` string, `6` bigint;
- `$RuntimeEvalValue { kind i32, i32val i32, f64val f64, i64val i64,
  refval externref }`;
- `buildRuntimeEvalValueUnwrap` (~279) first preserves the original externref, then
  `any.convert_extern` + `ref.test $RuntimeEvalValue`; a carrier is cast and
  reconstructed as caller-local primitives/boxes, while a non-carrier returns
  unchanged.

Use that implementation for the IR shape:

```wasm
;; value just loaded from provider-shared storage
local.set $shared
local.get $shared
any.convert_extern
ref.test $RuntimeEvalValue
if (result externref)
  local.get $shared
  any.convert_extern
  ref.cast $RuntimeEvalValue
  ;; switch kind; ref/string -> refval; undefined/null -> caller sentinel;
  ;; number/boolean/bigint -> caller-local box
else
  local.get $shared
end
```

#### 3. Correct the two nullish inline-receiver tests

**Files: `src/codegen/expressions/inlined-call-receiver.ts`,
`src/codegen/expressions/calls.ts`**

- Extend `InlinedReceiverBinding` / `planInlinedReceiver` with an explicit
  nullish mode when the inlined function body reads its own `this`. Always
  shadow, then restore, an outer `fctx.localMap["this"]` for this inline.
- For a sloppy callee and a proven `null`, `undefined`, or absent receiver,
  evaluate the original receiver for side effects, emit the global receiver via
  the existing `emitUnboundThis(ctx, fctx, fnExpr)` helper, and store it in the
  inline's temporary `this` local. Keep the existing primitive reshape path for
  non-nullish primitives.
- For a strict callee, preserve explicit `null` versus the undefined singleton;
  follow `explicit-null-receiver.ts`. Restore the previous binding through
  `releaseInlinedReceiver` on success and failure paths. Do not special-case
  `ThisKeyword` globally.

This is the narrow follow-up to #4246, which fixed non-nullish inlined
receivers and explicitly left this pair outstanding. It reuses the receiver
substrate from #4190/#4203 rather than reopening those completed issues.

#### 4. Give standalone `Function.prototype` one real prototype object

**Files: `src/codegen/property-access-dispatch.ts`,
`src/codegen/array-object-proto.ts`,
`src/codegen/expressions/fnctor-prototype.ts`**

- In `tryIdentifierNamespaceAndStaticReceiverRead`, lower the value
  `Function.prototype` to the existing identity-stable `$Object` singleton from
  `emitFunctionPrototypeObjectSingleton` (~2226), not a `$NativeProto` brand
  token.
- Initialize that singleton's own `apply` and `call` data properties as callable
  method closures using the existing native-method closure/property-definition
  machinery. Their bodies must reuse `__apply_closure` for callable receivers
  and the existing non-callable TypeError path; an object inheriting these
  methods is not itself callable, so invoking `obj.apply(...)` must throw a
  caller-local, catchable `TypeError`.
- Keep assignments through `tryCompileFnctorPrototypeAssign` on the ordinary
  `$Object.$proto` chain. Do not teach instance lookup a second `$NativeProto`
  chain. Preserve identity with `Object.getPrototypeOf(f) ===
  Function.prototype` and existing generator/function prototype users.

### Edge cases and controls

- A literal Function body containing `this` is provider-potential even when
  static synthesis succeeds in another source shape. A shadowed local named
  `Function` is not.
- Direct and indirect eval, aliased `Function`, multi-file imports, and provider
  definitions must produce one graph-wide plan. A module with no provider site
  must retain its current imports and WAT shape.
- A shared value may be undefined, null, number (including NaN/-0), boolean,
  bigint, string, function/reference, or an ordinary non-carrier externref.
  Decode carriers once; preserve non-carrier identity.
- Keep the already-passing `A3_T9`, `A5_T7`, apply `A7_T3/T4`, call
  `A6_T3/T4`, apply `A8_T4`, and call `A7_T4` cases as controls for nested
  eval, object receivers, constructor receivers, and non-constructability.
- Add focused tests for sloppy null and undefined, strict null and undefined,
  primitive and object receivers, an inline nested in a constructor, inherited
  `Function.prototype.apply/call`, direct callable use, and prototype identity.
- Add WAT assertions for a literal `Function("this.x=1")`: the provider import
  and result decode exist, and its later shared global read has exactly one
  carrier test. Add static-synthesis, shadowed-`Function`, non-carrier, and
  no-eval controls.

Suggested test ownership:

- `tests/issue-4265-runtime-eval-boundary-plan.test.ts` — plan and WAT contract;
- `tests/issue-4265-function-prototype-apply-call.test.ts` — the four
  non-dynamic cases and receiver/prototype controls;
- extend `tests/quickjs-eval-provider.test.ts` only for provider-side residuals,
  not for the leading compiler-plan fix.

### Diagnostics, A/B, and rollout

- Add narrow switch `JS2WASM_RUNTIME_EVAL_SHARED_READS=0`, default enabled. It
  must leave provider imports/calls intact and disable only the new plan's
  projection onto shared-read decoding, reverting to the legacy predicate.
  Existing `TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1` is useful only as a
  non-vacuity/link control and is not a semantic A/B switch.
- Add `JS2WASM_RUNTIME_EVAL_PLAN_DIAG=1` output listing sites, dispositions,
  graph-level projections, and decode-site counts. Keep it deterministic and
  free of absolute paths.
- Arm A applies to the **primary IR-plan/shared-read commit only**, before the
  independent receiver/prototype fixes: that candidate with shared reads
  disabled must be verdict/signature-identical to the freshly measured exact-base
  artifact. The switch cannot undo the two secondary fixes, so never demand
  full-cohort identity from a commit that contains them. Arm B: the primary
  candidate at its default over the identical 85-file manifest may claim only
  measured gains and must have zero pass-to-nonpass transitions or
  compile/runtime/timeout drift. Arm C: compare WAT for the focused probe;
  disabled has the legacy missing read decode, default has exactly one. With
  the provider disabled, dynamic cases must refuse/link-fail, proving that
  gains are not vacuous.
- Land in two reviewable commits if implementation risk warrants it: first the
  IR plan + shared-read decode, then the four independent AOT/prototype cases.
  Keep the switch for one full ES5 comparison cycle and remove it after the
  9,029-file gates are clean.

### Validation and acceptance

Before implementation, run the edition-index-derived exact 85-file manifest in
both host and standalone QuickJS lanes at exact main `8a2baecf3`; archive it as
the base. Delete/rebuild stale cache entries or pin and report their exact
artifact hash. Record the compiler commit, provider engine/tier, provider
artifact hash, and manifest hash.

Then run the exact **9,029 ES5 files per lane**, host and standalone QuickJS,
from the same candidate commit. Assert exactly one result row per manifest path,
no missing/duplicate/unexpected paths, no standalone forbidden host imports,
and provider provenance in the QuickJS log. Relative to same-base artifacts,
acceptance requires:

- zero pass-to-nonpass transitions in either lane;
- zero unexplained `compile_error`, `runtime_error`, or timeout drift;
- measured (not predicted) gains reported separately for the provider-plan
  slice and each of the four non-dynamic tests;
- no loss in the passing controls above; and
- the kill-switch arm verdict/signature-identical to the base for the provider
  slice.

Required repository gates:

```sh
pnpm run typecheck
pnpm run check:ir-fallbacks
JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag
```

The first slice is not expected to make all 38 Function-constructor failures
green. Residual argument/receiver membranes, primitive `this` boxing,
provider-created function prototype identity, and cross-realm error identity
belong to #2928. #4265 owns the compiler-side plan/read contract, the two
nullish AOT receiver cases, and the two `Function.prototype` inheritance cases.
#4269's completed object-literal receiver work and the completed #4190/#4203/
#4246 substrates are controls or dependencies, not work to reopen. Create no new
issue IDs from this implementation pass.
