---
id: 7354
title: "Prepared IR path, milestone 1: the test262 harness prelude compiles and a positive test passes"
status: ready
sprint: current
created: 2026-11-16
updated: 2026-11-16
priority: critical
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
goal: ir-full-coverage
depends_on: []
related: [7188, 2949, 3526, 3527, 3518, 7106, 7349, 7350, 7352]
# 2026-11-16 (slice R): src/compiler.ts +1, the import of the Prepared presentation
# policy (`preparedPresentationPolicy`), which replaces the inline `{ backend, target }`
# policy literal in place; the policy and the provider census live in their own
# module, src/compiler/prepared-provider-census.ts.
loc-budget-allow:
  - src/compiler.ts
---

# #7354 — Prepared IR path, milestone 1

## Problem

Program goal, as decided by the project lead on 2026-11-16: **100 % of ES5
test262 passes on the IR-only path, and "the IR-only path" is the Prepared
whole-program path** (`TEST262_COMPILER_PATH=ir`, front door
`wholeProgram: { kind: "prepared-program-required", version: 1 }`). It is the
figure the site publishes, and since #7262 it is measured on every merge to
`main`.

That path passes no positive test today. Every test is compiled behind the
same prelude (`scripts/test262-fyi-runtime.js` + `harness/assert.js` +
`harness/sta.js`, about 320 lines), and the Prepared path refuses the prelude
at its first gap. Nothing in a test body can be measured until the prelude
compiles.

The Prepared path shares only `lowerFunctionAstToIr` (`src/ir/from-ast.ts`)
with the ordinary pipeline. It does not use the selector or the
codegen-backed resolver (`src/ir/integration.ts`, about 115 hooks; the
Prepared resolver in `src/ir/program-source.ts` supplies about 6). So files
with zero legacy units in the ordinary pipeline, and the foundations #7349,
#7350 and #7352 as built so far, do not move this figure.

## Measured

Standalone, 2026-11-16, main `636331310e` / `85eb0403af`. Records (session
scratch, not in the repository): `irgap/research.md`, `irgap/design.md`.

- CI run 43822939252: ES5 415 pass / 9,029, 0 fail, 8,614 compile errors.
- Local sample through the real runner (411 ES5 rows): 14 pass, 397 compile
  errors. All 14 passes are `negative:` tests (a compile failure is their
  expected outcome). All 397 errors carry the gap "top-level global storage
  needs a numeric source classification"
  (`src/compiler/ir-program-presentation.ts:326`).
- Relaxing one gap at a time in a throwaway prototype reaches, in order:
  untyped parameter contracts, a home for script `var`s, `JSON` not in scope,
  `String()` calls, void-typed results, function objects with properties,
  `new` on a plain function, dynamic `+`, caught values, `console` /
  `globalThis`, dynamic object literals, missing runtime declarations
  (`__ir_dyn_add`, `__objvec_new`), string policies that the presentation
  entry never switches on, and then a gate that protects soundness: the
  Prepared physical layer has no dynamic-value carrier outside host async
  (`src/ir/program/host-async-dynamic.ts`).
- Behind the milestone (numeric stand-in harness, every measurement
  relaxation on): 4 of 396 positive bodies pass. First gaps of the rest:
  about 100 rows are covered by this milestone's slices, 49 are an artefact
  of the stand-in, about 240 are gaps of the test bodies (built-in calls,
  `var` nested in top-level code, RegExp, closures, a long tail). So the test
  bodies are the larger wall; this milestone makes them measurable.

## Implementation Plan

### Target structure

- **One dynamic value, the existing one.** A dynamic value on the Prepared
  path is what it is in the ordinary standalone pipeline: an `externref` that
  wraps a GC reference (number or boolean box, native string, native object
  or closure, the `$undefined` singleton). The pure builders in
  `src/runtime/wasmgc/values/*` are already used by legacy codegen and by the
  Prepared resources in `src/backend/wasmgc/resources/*`.
  - Rejected: a new IR-owned tagged value for the Prepared path. It would be
    a second representation beside the boxes and strings the Prepared
    resources already hold.
  - Rejected: routing through `src/ir/prepared-dynamic-support.ts`; it needs
    the legacy codegen context.
- **Dynamic operations become pure builders with manifest declarations.** The
  bodies that legacy codegen emits on demand (`src/codegen/dyn-ops.ts`, the
  `any-helpers` family: strict and loose equality, `typeof`, ToNumber,
  ToString, `+`, relational compares, member get/set, call) move into
  `src/runtime/wasmgc/values/` as pure builders. Legacy then calls the same
  builder, and the Prepared path declares it as a runtime callable
  (`src/ir/runtime/dynamic-value-callables.ts`, shaped like
  `ordinary-object-callables.ts`) selected by a manifest policy beside
  `numberBoundary`. One mechanism; legacy loses its private copy.
- **One lowering handle.** `IrDynamicLowering` (`src/ir/backend/handles.ts`)
  gets a second implementation backed by reserved Prepared resources, wired
  in `fillPrimaryBody` (`src/ir/program-consumer.ts`) beside `emitStringConst`.
  from-ast is unchanged: it already lowers through the handle.
- **Presentation narrows to the real host boundary**, as #7188 S1 did for
  internal functions: a declaration or global that is not exported has no
  host contract and is presented with the IR's own storage. No second
  presentation path, no second classifier.
- **Each seam sits beside its existing sibling** (table in `irgap/design.md`
  §2): the carrier arm beside `nativeStringCarrier` in
  `physicalSignatureConverter`; the provider census beside `checkMixedDemand`;
  parameter contracts in `prepareSourceFunctionSignatures`; the script `var`
  home as a pure checker-and-use classifier that returns the existing
  `IrScriptVarHome`.

### Slices

Each slice has a smallest proving program, compiled through the strict
Prepared entry and run. Order: P, V, G (cheap, unblock everything), D1 (the
core), R, S, D2, D3, then C, B, F, and M last.

| slice | content | proving program |
| --- | --- | --- |
| P | Sound parameter and result contracts: an untyped or JSDoc-typed parameter is dynamic; call-site type propagation counts callers in top-level code or is not used. Today `h(v)` is typed boolean from `g(true)` although top-level code calls `h(0.5)`; it fails closed, and must stay sound when the gate opens. | `function h(v){return v} function g(b){return h(b)} g(true); h(0.5);` |
| V | An IR-owned home for a script `var` (typed, string or dynamic), with no legacy `scriptVarHome`. | `var x = 1; x = x + 1;` |
| G | Present non-exported, non-numeric globals with the IR's own storage (#7188 S4). | `var s = "a";` |
| D1 | The carrier arm in the physical plan, a standalone dynamic-unit plan, and `resolveDynamicLowering` with box, unbox, tag test, `undefined`, `typeof`, strict equality on reserved resources. | `function id(v){return v} var a = id(1); var b = id("x");` |
| R | The presentation's provider census accepts authenticated providers, references and the string pool; fix the receipt failure after `finalizePipelineModule` once a native type is reserved ("altered type descriptor"). | `if (1 !== 1) throw 1;` |
| S | String policies switched on in the presentation request; joins for equality, length and compare (today only constants and concatenation). | `var s = "ab"; if (s !== "ab" \|\| s.length !== 2) throw 1;` |
| D2 | Dynamic arithmetic, relational compares and `+` as pure builders with declarations. | `function f(a,b){return a+b} f(1,"x")` |
| D3 | Dynamic call and argument vectors. | `function t(fn){ fn(); } t(function(){})` |
| C | A caught value is dynamic; dynamic object literals. | `assert.throws` shape |
| B | Built-in globals in the Prepared resolver: `JSON`, `String()`, `Object.prototype.toString.call`, `globalThis`, `console`. | `assert.js` `formatIdentityFreeValue` |
| F | Function objects: a function as a value, properties on it (`assert.X = function`), `new` on a plain function with `this`, `instanceof`. | `sta.js` `Test262Error`, `assert.sameValue` |
| M | The real prelude plus `assert.sameValue(1, 1);` passes in the real runner. | — |

Slices C, B and F need the resolver hooks the ordinary pipeline gets from
legacy codegen. Each is built as a pure, backend-independent resolver that
both pipelines can ask, so the function-value, built-in-global and
object-literal mechanisms of #7349, #7350 and #7352 are built once. Their
plans are revised when this milestone reaches them.

### After the milestone

Run the full ES5 corpus on the Prepared path and tally the first gap of every
row. That tally, not the ordinary pipeline's census, orders the next work.

### Hazards to prove per slice

1. **Legacy byte drift.** Moving a helper body into a pure builder must leave
   standalone and JS-environment output of the ordinary pipeline
   byte-identical. Compare bytes on at least 300 files per slice.
2. **Fail-closed stays fail-closed.** Every gate that is narrowed keeps
   refusing what it cannot present. Each slice adds refusal probes beside the
   acceptance probes, and mutation-checks the narrowed guard as #7188 S1 did.
3. **Soundness before reach.** Slice P lands before any slice that makes
   dynamic parameters reachable.
4. **No invalid Wasm.** A slice is done only when its programs validate and
   run, not when they are presented.

### Constraints

- Standalone and the native targets only; no new host imports;
  JS-environment output byte-identical.
- No test verdict regresses in any edition on the ordinary pipeline.
- No copy of legacy helpers: a body is moved and shared, not duplicated.
- The IR code-quality rule applies; no budget grant beyond a dated, justified
  one.

## Acceptance criteria

Per slice:

1. The proving program and its variants compile through the strict Prepared
   entry, validate and run with the right result; refusal probes still
   refuse.
2. Ordinary-pipeline bytes identical (standalone and JS environment) on at
   least 300 files; the equivalence gate and `issue-tests` unchanged.
3. The 411-row sample through the real runner: no row passes that should not
   (negatives unchanged), and the first-gap tally is reported.

Milestone:

4. The real prelude plus `assert.sameValue(1, 1);` passes in the real runner
   on wasmgc standalone.
5. A full ES5 run on the Prepared path is recorded with its first-gap tally.

Code quality:

6. One dynamic value representation and one `IrDynamicLowering` contract; the
   legacy on-demand helper and the Prepared provider share one builder.
7. Each new arm sits beside the sibling named in the plan, in the same shape.
8. A fresh-context adversarial review per slice records its verdict in the PR
   body.

## D1 result (2026-11-16)

Branch `claude/7354-d1`, stacked on slice R. Decisions taken before the
slice (they override the plan text above where they differ):

1. **Option B, one legalization pass.** The Prepared backend binds runtime
   functions only through semantic intrinsics, so
   `src/ir/program/dynamic-value-legalization.ts` rewrites the dynamic
   operations into intrinsics and every `dynamic` type into `externref`. The
   source producer runs it on each lowered function when the source policy is
   wasmgc standalone (`legalizeSourceDynamicValues`), so every later stage
   (runtime projection, validator replay, clock witness, physical plan) sees an
   ordinary externref program and `program/runtime-manifest.ts`,
   `runtime-validation.ts` and `runtime-abi.ts` stay byte-identical (they are
   complete-source pins of the #3518/#3525 relocation receipts; a first cut ran
   the pass in the projection and broke 150 receipt tests). `from-ast.ts` is
   unchanged and there is no second `IrDynamicLowering`. This replaces the
   plan's "second `IrDynamicLowering` implementation" bullet.
2. **The D1 set.** `box` from f64/i32 to `js.number.box`, a Boolean-tagged box
   to `js.boolean.box`; `unbox` NumberF64/Boolean to `js.number.unbox` /
   `js.boolean.unbox`; `tag.test` NumberF64/Boolean/Undefined to
   `js.value.is_number` / `js.value.is_boolean` / `js.extern.is_undefined`;
   `dyn.undefined` to `js.value.undefined`; strict `dyn.eq` to
   `js.value.strict_eq` (+ `i32.eqz` for `!==`). Added beyond the list:
   `dyn.to_number` to `js.number.unbox`, because `__unbox_number` is exactly
   ToNumber over the admitted values (number, boolean, `undefined` gives NaN);
   from-ast emits no numeric unbox, so this is how a dynamic value becomes a
   number again (`v * 2`). Everything else refuses as "dynamic operation X has
   no Prepared intrinsic": loose `==`, `tag.test` Null/NumberI32/String/Object,
   ToBoolean, `typeof`, member access, a box of any non-primitive (strings
   included), `coerce.to_externref`, and a dynamic type nested in a composite.
   A front-end dynamic helper call (`__ir_dyn_add`, …) has no runtime
   declaration and would reach `prepareIrProgramRuntimeCallables` as an
   invariant; the pass refuses it by the same name.
   - Soundness rests on the admitted set: only numbers, booleans and
     `undefined` enter a dynamic value. Strict equality therefore has no BigInt
     or string arm; the slice that admits strings must pass the string arm.
   - New providers live in `src/ir/runtime/dynamic-value-callables.ts` (one
     native standalone arm each, no policy); the four ids join the closed lists
     the `js.boolean.*` family uses. The provider-row comparison that the
     ordinary-object family carried is now one helper
     (`canonical-provider-mismatch.ts`) both families call.
   - The `undefined` probe is the legacy body moved to `buildIsUndefinedBody`
     (`primitive-layouts.ts`); legacy calls it with its previous arguments.
     Strict equality is its own pure body (`strict-equality-body.ts`: number
     payloads by `f64.eq`, Boolean payloads, else identity). A first cut
     parameterised `buildObjectSameValueBody` instead, but that file and its
     options interface are pinned by the #3518 replay receipts
     (`same-value-nan-correction.ts`, the BigInt carrier port) and called by
     four test helpers; folding the two dispatches is left for a cleanup that
     re-pins those receipts. `__extern_strict_eq` is untouched.
   - Boolean unbox from a dynamic value is unreachable from source today; if it
     arrives it meets the existing keyed-Get proof gate in
     `selectNativeBooleans` and refuses, and the presentation does not select
     `booleanBoundary.unbox`.
3. **Numeric mode.** `selectNativeDynamicValues` (one predicate) puts the
   native string value plan into its existing numeric mode when the projection
   has any `js.value.*` intrinsic or a natively bound `js.extern.is_undefined`;
   `resources/native-dynamic-values.ts` adds `__js_strict_eq`,
   `__js_undefined` and `__extern_is_undefined` beside the value and Boolean
   resources. The Boolean predicate pair is reserved whenever strict equality
   or the Boolean tag test needs it. The `primitive-only` resource plan was not
   widened (per the handover it has no production caller).
4. **`any` contracts.** `src/ir/source-dynamic-contracts.ts` now holds every
   `any`-contract rule of the Prepared source producer (the host async arm,
   moved unchanged, and the native arm: an explicitly annotated `any`
   parameter or result of an internal (non-exported) synchronous wasmgc
   standalone function; an exported `any` keeps its existing contract, the
   source Boolean `any` result or the Phase 1 refusal), plus
   `resolveDynamic`; `program-source.ts` shrank by 37 lines. Untyped and JSDoc
   parameters stay refused (slice P). The presentation's ABI join admits an
   internal `externref` callable contract on standalone (the legalized dynamic
   value); an exported `any` contract stays refused.
5. **`typeof`** stays a named gap (`dyn.typeof`), with a refusal probe.
6. **Stacked on R.** `preparedPresentationPolicy` additionally selects native
   Boolean boxing and the native `undefined` probe; the `js.value.*` providers
   need no policy. The census (`nativeProviderJoins`) accepts all new providers
   unchanged; `checkResourceDemand` and `emittedSupportFunctionReceipts` were
   not touched.

Proof: `tests/issue-7354-d1-dynamic-carrier.test.ts` (15 tests) compiles
through the strict Prepared entry, validates and runs: number/boolean/
`undefined` through `function id(v: any): any`, `===`/`!==` between them,
`+0 === -0`, `NaN !== NaN`, `1 !== true`, one helper called with three tags,
ToNumber back to a number; refusal probes for loose equality, the null tag
test, ToBoolean, dynamic `+`, member reads, `typeof`, an exported `any`
contract and the gc target; three direct tests of the pass.

### Test pins updated by D1 (closed lists a new intrinsic family changes)

Measured against `origin/main` b29a0f7380: the failing-test sets of every
`tests/issue-3518*`/`issue-3526*` file and every test naming a touched file
match main's exactly after these updates.

- `tests/issue-3518-core-vocabulary-seam.test.ts`: `INTRINSIC_IDS` 39 → 43,
  `DYNAMIC_VALUE_INTRINSIC_IDS` in the canonical value list and the composed
  order (the facade `src/ir/intrinsics.ts` forwards it like its siblings).
- `tests/issue-3518-semantic-verification-ownership.test.ts`: successor pin of
  `INTRINSIC_DEFINITIONS` (51cd8b09…), with a new predecessor-chain step that
  removes exactly the four `js.value.*` rows to re-derive the #6921 pin
  (b763d963…), which then re-derives the original; catalogue length 39 → 43.
  Same mechanism #6921 used for `js.boolean.unbox`.
- `tests/helpers/ir-historical-runtime-reconstruction.ts`: the reviewed
  declaration order of `src/ir/runtime/contracts/intrinsics.ts` gains
  `DYNAMIC_VALUE_RUNTIME_FEATURES` / `DynamicValueRuntimeFeature` after the
  extern rows.
- `tests/issue-3526-string-boundary-const.test.ts`: the empty-parameter
  signature rows are the string storage rows plus `native.js.value.undefined`
  (also a value: nothing goes in).
- `tests/issue-3518-native-boolean-consumer.test.ts`,
  `tests/issue-3518-native-getter-resource-join.test.ts`: the binder is now
  `nativeIntrinsicAbiBindings` (Boolean plus dynamic-value intrinsics) and its
  refusals say "native intrinsic ABI".

## Coordination

#7188 (slices S2 to S4) is claimed by `js2-17` since 2026-10-28 and #2949 by
`fable-lead` since 2026-08-21, both without recent activity. The decision and
a deadline of 2026-11-16 14:00Z are posted on the coordination PR #6583.
Until then this issue starts with D1 and R, which no claim covers; P, V and G
overlap #7188 S2 and S4 and start after the deadline or an answer.

## R result

Status 2026-11-16. Branch `claude/7354-r`, built on origin/main `46e4cf4030`, first commit `a37f0c8c00`.

### Built

- **Policy.** `preparedPresentationPolicy` lives in `src/compiler/prepared-provider-census.ts`. On wasmgc
  standalone, a Prepared presentation now selects the native number boundary (`__box_number` /
  `__unbox_number`). Every other target, and every other runtime family, keeps its default ("unsupported").
- **Provider census.** `checkResourceDemand` used to refuse every runtime provider. It now calls
  `providerCensusMatches`, which accepts a provider only if it matches the completed physical plan.
  A provider that matches nothing still refuses.
  - A **number remainder** is checked the same way as before.
  - A **native provider** is accepted only on standalone, and only if all of these hold:
    - the native setup has exactly one binding whose reference is the provider's runtime callable;
    - the completed emission resolves that binding to a function slot;
    - that slot has a completed support receipt.
  - **Without a native setup** the numeric contract is unchanged: every support function must be a remainder.
  - The remainder join and `physicalCallableMatches` moved into the new module. They were not otherwise changed.
- **Receipt failure ("altered type descriptor native-string-values…flat").**
  - Cause: `finalizePipelineModule` widened reference types in the authenticated emission module in place.
    The receipt check, run again after finalization, then saw an altered reserved type.
  - Fix: on standalone, an emission with reference types now goes through the existing detached finalization
    (`beginPreparedPresentationFinalization`). It widens a copy and authenticates the result, so the emission
    is never altered.
  - Hosts and WASI still refuse reference widening.

### Measured

- **Programs blocked only by R's two points.** These are the probes, all passing in
  `tests/issue-7354-r-provider-census.test.ts`. Each compiles through the strict prepared entry, validates and runs:
  - `if (1 !== 1) throw 1;`
  - `try { throw 1; } catch (e) {}`
  - `if (1 + 1 !== 2) throw 1;`
  - a `void` helper that throws its parameter;
  - `f(x)` that throws `x` (and `f(2)` does throw);
  - `x % 2` combined with a thrown `x` (a remainder plus the native box);
  - throw and catch inside an exported function.
- **Refusal probes.**
  - On gc and WASI the same throw program refuses: `js.number.box` is unavailable there.
  - `throw "x"` on standalone still refuses: the string-const policy is not selected.
  - A numeric-only program keeps the exact contract.
- **Mutation check.** With the detached-finalization switch removed, every acceptance test fails with
  "altered type descriptor … flat".
- **Ordinary-pipeline bytes.** I compared 330 sample files against base sources swapped into the same tree.
  - 301 compiled, the rest were skipped as negative, raw or module tests.
  - All 301 are byte-identical on both standalone and the JS environment.
- **Existing tests.**
  - `test262-prepared-entry`, `test262-prepared-runtime` and the #7188 test: 58/58 pass.
  - `issue-3518*` (only the files that reach the changed code, plus chunk 0): the failed-test sets are identical to base.
    The failures that exist are pre-existing: 953 / 44 / 52 / 11 per chunk on both trees.
- **Real runner, 411-row sample (`l420.txt`).**
  - Per-row results are identical to base (0 rows differ).
  - Negative tests are unchanged: 14 pass, 1 compile error.
  - First-gap tally: 394 rows stop at "top-level global X needs a numeric source classification" (slices G/V),
    2 rows at the switch-case lexical binding. So R moves no test262 row yet; the harness prelude stops at G/V first.
- **Gates.** These pass: typecheck; loc (one dated grant, `src/compiler.ts` +1 for the import); func; coercion-sites;
  oracle-ratchet; dead-exports; import-cycles; compiler-boundaries (new module classified); quality steps 1–26.

### Not verified

- **The census's rejection branch for a native provider is not reached by any source program today.**
  - On standalone, every provider a presentation can select (number box/unbox, remainders) has a native binding.
  - So the mutation "accept every native provider" is not caught by a test.
  - It is kept as fail-closed authentication. D1's dynamic providers will be the first to reach it.
- **The string pool / reference-global acceptance named in the plan row is not built.** Native string literals
  are globals, not pool entries. Slice S owns the string policies.
- **Assumption for D1.** The census looks for native bindings in `nativeStrings.bindings`. D1's string-free value
  plan must publish its bindings there, or extend `nativeProviderJoins` to read wherever it publishes them.
