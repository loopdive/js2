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
# 2026-11-16 (slices V and G): src/ir/program-source.ts +2, the import of
# `irOwnedScriptVarHome` and the `scriptVarHome` resolver option that passes it; the
# classifier and its reads proof live in src/ir/module-binding-script-var-home.ts and
# src/ir/module-binding-script-var.ts. (ir-program-presentation.ts shrinks by 3.)
# 2026-11-16 (slice D1, review round 1): src/ir/from-ast.ts +10, two named
# declines the Prepared producer reaches because it has no selector (`**` on a
# dynamic operand, a value-position prefix `++`/`--`); they replace invariant
# crashes in place and sit in the arms that own them. ir-program-presentation.ts
# +1: D1's internal externref callable contract admission in the ABI join.
# 2026-11-17 (slice Str): ir-program-presentation.ts +1, the native-string arm of the
# same internal-callable admission (`carried`), written beside D1's externref arm.
loc-budget-allow:
  - src/compiler.ts
  - src/ir/program-source.ts
  - src/ir/from-ast.ts
  - src/compiler/ir-program-presentation.ts
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
- **Census (review rounds 1–2: fail-closed in both directions, every check tested).** `checkResourceDemand` used
  to refuse every runtime provider. `runtimeCensus` now joins the selected providers and the completed support
  population one to one, and answers the native setup's slots (or refuses).
  - **One join of the support population** (`supportPopulationJoins`): every row's completed slot carries the row's
    signature, and the rows' (slot index, key) pairs equal the receipts' as a multiset — no receipt joins nothing,
    none joins twice, no row lacks its receipt. Remainders and natives are rows of the same shape. A provider is
    first checked against its canonical catalogue entry (`preparedIrDataMismatch`; dependency- and
    capability-free runtime callable).
  - **The native setup is authenticated from its own plan, not a list of names.** Declarations and published
    bindings join one to one by key; each binding resolves to a completed slot of its declaration's space.
    Function declarations become support rows with their declared signature (type keys resolved to the native
    type slots); global slots carry their declared type and mutability.
  - **Runtime callables and native providers:** each runtime-bound function is named by its runtime symbol, and
    those symbols equal the selected native providers' symbols (sorted, so duplicates on either side refuse).
    Every other native function is a dependency the setup plan declares.
  - **Reference values (`referenceDemand`, one walk).** With an authenticated native setup, its type and global
    slots are exempt and every other reference must name a native type slot (struct/array types and globals
    outside the setup may carry none); without one, any non-defaultable reference refuses. A native setup always
    asks for the detached finalization.
  - **Removed as implied (round 2):** distinct provider ids, distinct receipt indices, distinct row keys and the
    binding count (all implied by the multiset join and the key bijection), the catalogue-uniqueness test (ids
    are unique in the catalogue), the `""` runtime sentinel, and the "setup but no native rows" clause (its
    function receipts then join no row).
  - **Removed as implied (round 3):** the separate missing-slot check (a binding without a function slot has no
    signature, so the signature comparison refuses it), the "runtime-callable" kind check (implementations are
    joined as data, `{ kind: "runtime-callable", symbol }`, to the plan's runtime callables), and the "type key
    resolves" checks (an unresolved key stays a key, which never equals a completed slot type).
  - `physicalCallableMatches` moved to `src/compiler/prepared-physical-signature.ts` (shared with the async checks);
    the detached-finalization map is now `detachedPresentations`.
  - `preparedPresentationPolicy` is the single place the presentation's runtime policy is chosen; D1 adds its
    boolean and undefined policies there.
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
- **Census refusal tests** (`vi.mock` wrappers over the real census on `try { throw 5; } catch (e) {}`; each
  alters one input: providers, receipts, the accepted native setup plan, the census target, or the answered slots).
  Mutation sweep (round 3, 21 checks swept): 20 fail at least one test when deleted alone. The one survivor is
  main's remainder resource join, now written as implementation equality instead of symbol equality; it belongs
  with the nine remainder checks moved verbatim from main
  (`remainderRows`: resource count, unique resource, ABI entry, callable contract, declaration feature,
  structural reference key, contract params/results) are pre-existing and, as on main, have no failing-remainder
  test; they are left unchanged. The emission itself cannot be altered: its own reservation census refuses a
  changed function, global or type first.
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

- **Reference globals are accepted only as native-setup slots** (`__strlit_0`, `__pow10_f64`, `__undefined` today).
  The string pool and string-constant policy are not selected; slice S owns them.
- **The widening lift without a native setup** (mutation of the `!setup` guard) is not reachable from a test: on
  standalone a reference value always comes with the native setup, and hosts/WASI refuse the box earlier.
- **D1.** The census reads the native setup from `nativeStrings` (declarations and bindings). D1's resources join
  as long as they are published there.

## V and G result

Status 2026-11-16. Branch `claude/7354-vg`, built on `claude/7354-r` (merged up to `0a77aa57d9`; the comparisons below were measured against R at `15c6513ce7`, whose later
commits touch only the census and its test).

### Built

- **V — an IR-owned home for a script `var`.** The Prepared resolver now passes its own `scriptVarHome`
  (`irOwnedScriptVarHome`, new `src/ir/module-binding-script-var-home.ts`) through the existing resolver option in
  `program-source.ts`. It returns the existing `IrScriptVarHome` vocabulary, so the resolver (`scriptVarHomeOf`,
  `directTopLevelDeclaration`) is unchanged. It answers `typed` only, and only when:
  - the checker type is `number` or `boolean`;
  - the declaration's file is the program's only source (review round 1, below);
  - the binding has exactly one declaration (see "Named gaps");
  - the name is not `undefined`, `NaN` or `Infinity` (non-writable globals: the initializer never stores);
  - `scriptVarReadsFollowInitializer` (new, in `src/ir/module-binding-script-var.ts`, beside
    `scriptVarUseFollowsDeclaration`) holds.
- **Hoisting soundness — refuse unless proven.** A typed global has no `undefined`; a read of the hoisted binding
  would answer `0`/`false` where JS answers `undefined`. So every read must either run after the declaring
  top-level statement (module-init after it, or inside a function or class created after it), or sit in a top-level
  function declaration that nothing before the statement can call. "Can call" is name-based: the function's name
  spelled anywhere outside the function (reference, member name, string) other than in code that runs after the
  statement, or an escaping global object (`sourceMayWriteGlobalObject`), counts as a call. `eval`/`Function`
  anywhere (`sourceRunsDynamicCode`) declines. A same-named reference the checker binds to another declaration
  (a parameter, a local) is not a read; a plain `x = v` only writes.
- **Not shared with legacy's `scriptVarHome`.** Legacy reads back the carrier of the `__mod_<name>` slot its own
  allocation chose, and its typed slot reads an unwritten binding as `0` (its pre-init analysis,
  `moduleVarDirectPreInitValueIsObserved`, skips reads in functions and positions by the name, so `var x = x + 1`
  passes it). A shared core would either change legacy's output or inherit those answers.
- **G — internal globals.** `capturePresentation` raises "top-level global storage needs a numeric source
  classification" only for an `export var` that is not numeric. Any other top-level global is the IR's own storage,
  as #7188 S1's internal functions. `export { b }` of a non-numeric global is still refused at the export join (its
  witness must be numeric). The #7188 residual about the `exported` predicate does not apply: the capture visits only
  top-level statements and reads the statement's own `export` modifier, so a `namespace` member is never a row.
- `isValueReference` (`src/shared/intrinsic-prototype-writes.ts`) is now exported and used for the reads scan, so
  `src/ir` gains no import edge to `src/checker` (the import-cycle gate counted `ir->checker` 7 → 8 with
  `checker/binder.ts`'s twin).

### Measured

- `tests/issue-7354-vg-script-var-home.test.ts`, 39 tests. Acceptance programs run through the strict Prepared entry,
  each twice (the JS value returns, a wrong value throws): `var x = 1; x = x + 1;`; a var read and written from a
  function and from top-level code; a var read by a function declared above it and called after it; `var b = true;
  b = !b;`; a var written by a function before its declaration runs. G: an internal `let` boolean behind a numeric
  export runs; `export var b = true`, `export { b }` and `export { b as alias }` are refused; `export var x = 1` still
  exports.
- Refusal probes: a call before the initializer, a call through another hoisted function, a read in the own
  statement, a repeated `var`, a `var` without initializer, a string var, `s++` on a string var, `var Infinity = 1`,
  and the TypeScript form; plus 19 unit cases of the reads proof.
- Mutation check: 17 mutations (each guard of the reads proof, the classifier's type, repeat and non-writable
  guards, the capture gap in both directions, the export-join witness) each fail at least one test.
- Ordinary-pipeline bytes: the 411-row list, base sources swapped into the same tree. 396 files compiled per target,
  all byte-identical on the JS environment and on `--target standalone`; 16 are compile errors on both trees, 15
  skipped (negative, raw, module).
- Existing tests: `test262-prepared-entry`, `test262-prepared-runtime`, #7188, R and this file: 144/144 (after merging R
  `0a77aa57d9`).
  `issue-3518*` / `issue-3526*` (307 files, base and new sources swapped into the same tree, 3 forks on a loaded box):
  4,724 failing tests on base, 4,743 on this branch, the same set except 31 tests in three files that timed out on
  one side only (`native-invocation-consumer`, `void-closure-results` on this branch; `native-ref-cell-consumer` on
  base). Run alone on this branch, those three files pass 82/82.
- Real runner, 411-row sample (`l420.txt`), wasmgc standalone:
  - negatives unchanged: 14 pass, 1 compile error;
  - first-gap tally: **394 rows stop at "function X has an unresolved parameter contract" (slice P)**, 2 at the
    switch-case lexical binding (as before). By function, over the 396 positive rows: `isNegativeZero` 347,
    `verifyProperty` 47, `isConstructor` 1, `__consolePrintHandle__` 1. The G/V gap is gone from the sample.
- Gates: typecheck; loc (one dated grant: `program-source.ts` +2, the import and the option;
  `ir-program-presentation.ts` shrinks by 3); func; coercion-sites; oracle-ratchet; dead-exports; import-cycles;
  compiler-boundaries inventory (new module classified); ir-dialect.

### Named gaps (refused, not built here)

- **String home** (`var s = "a"`): slice S (the presentation selects no string policy).
- **Dynamic home** (`var u; u = 1`, `var print = function …`): slice D1 (no Prepared dynamic carrier).
- **Repeated `var`** (`var x = 1; var x = 2;`): the startup plan gives every declarator its own binding id, so a
  second declaration has no single storage. Before this slice it was refused as `not-direct`; giving it a home
  without changing the plan reaches a Prepared invariant, so the classifier declines it.
- **Nested `var`** (in a block or `for` head): unchanged. These are already module-init locals on the base. A `for`
  head's var read after the loop runs correctly; a block's var read outside the block, or any nested var read from a
  function, is refused ("identifier … is not in scope").
- **`var x = 1, y = x`** and a TypeScript `var x: number;` assigned later: refused (statement granularity; no
  initializer).

### Observed, not acted on

- **Slice P is now the first gap of the whole sample.** The harness helpers `isNegativeZero` and `verifyProperty`
  (and `isConstructor`, the console shim's print handle) have untyped parameters, and the Prepared signature pass
  (`prepareSourceFunctionSignatures`) resolves no contract for them.

### Review round 1

An adversarial review returned NOT MET: one soundness must-fix and six should-fixes. Fix commit `1032759ec5`.

1. **Must-fix — reads in another script were invisible.** The proof walked only the declaration's file, but every
   script of a program shares one global scope. Three `compileMulti` programs (`a.js` runs first and reads `x`
   through a hoisted function, through top-level code, or through an unguarded call; `test.js` declares `var x = 1`)
   compiled and ran with `x` reading `0`. Fixed with the simplest sound rule: `irOwnedScriptVarHome(checker,
   sourceFiles)` answers only when the declaration's file is the program's only source. **Signature change**: the
   classifier gains the `sourceFiles` parameter (the resolver has no other way to see the program's files); the
   proof `scriptVarReadsFollowInitializer` now takes a `NamedVariableDeclaration` (finding 4). The test262 runner
   assembles prelude and test into one source, so the goal metric does not move: the 411-row sample is unchanged
   (below). The three programs, in `.js` and `.ts`, are tests now (refused). The rule is conservative by design: if
   the harness prelude ever becomes its own source file, every typed home is refused.
2. **Outermost owner untested.** The hoisting function is now found structurally — the top-level statement that is a
   function declaration (`ts.findAncestor(node.parent, isHoistedFunction)`) — so there is no innermost/outermost
   choice left to get wrong. Test added: `var r = f()(); var x = 1; function f() { return function () { return x;
   }; }` is refused.
3. **Surviving mutants.** The `isDeclarationFile` filter: killed by a new acceptance test, `var length = 1` (the lib
   declares `length` too). The `name === undefined` guard: kept and killed by a proof test, `export default
   function () { return x; } var x = 1;` (an importer in a cycle runs it first). The `|| !symbol?.declarations…`
   clause in `isRead`: deleted. It was unreachable — a value reference to the name always resolves to the global
   in a file that declares it — except for a shorthand property, where the checker answers the PROPERTY symbol;
   that made `var o = { x }; var x = 1;` a proven program (unsound). The read now asks the shorthand's value symbol;
   test added.
4. **Dead or duplicate code.** The identifier check is now done once, in the classifier, through a type guard that
   hands the proof a `NamedVariableDeclaration`. `(owner ?? node).pos` is `node.pos`; `outermostCallableOwner` and
   its class arm are gone with it. `isHoistedFunction`'s top-level restriction stays: it is what makes a nested
   declaration a non-hoisted one, and a test now kills its removal (a nested `function g` inside an expression
   created after the var, while a top-level `g` is called before it). It also now sees through labels: a labelled
   top-level `function` is hoisted too, and before this round `var r = f(); var x = 1; l: function f() { return x;
   }` was a proven program at the proof level (the compiler refused it on a TS diagnostic). Test added.
5. **Structure.** `scriptVarUseFollowsDeclaration` and the typed home's position test now share one helper,
   `placedAfter(node, statementEnd, defers)`: the certified homes defer every function and class, the typed home
   only a hoisted function. Ordinary output is byte-identical (below). **Rebutted: one dynamic-code predicate.** The
   two answer different questions. `hasDynamicScope` (writes collector, ordinary pipeline) asks whether a name may
   resolve outside checker identity (`with`, direct `eval`); the reads proof asks whether code the walk cannot see
   may run (`eval` by any route, `Function`). `with` needs no predicate of its own in the proof because of the
   read rule, not the walk: inside `with` the checker resolves no symbol for `x`, so `isRead` counts a spelling
   whose symbol does not resolve as a read (round 2 — round 1 counted it as not a read, so the proof accepted `var
   o = {}; with (o) { x; } var x = 1;`, masked end to end only by TS error 2410 and the IR's refusal of `with`).
   Proof tests: `with` before the declaration refused, after it proven. `hasDynamicScope` misses `Function(…)` and
   indirect `eval`, so neither predicate can replace the other; a union in the writes collector would change the
   ordinary pipeline's output.
6. **Cost.** `spellingsOf` indexes every identifier and string literal of a file once (a `WeakMap` keyed by source
   file, like `qualifiesCache`); the proof and `callableBefore` read the one name's list instead of walking the
   file.
7. Recorded under "Known gaps" below.

Round 2 (review verdict MET, three items): the unresolved-symbol read rule above; a precision test pinning
`callableBefore`'s deferral to hoisted functions only (`var x = 1; var g = function () { f(); }; function f() {
return x; }` is proven — deferring every callable survived the sweep before); the sole-source sentence in finding 1.
The call test needs no such rule: it matches spellings by text, never by symbol. `isRead` belongs to the proof,
whose only caller is the Prepared classifier, so no ordinary-pipeline caller is affected. Mutants on the changed
lines (unresolved-as-read deleted, resolved-binding deleted, `isCallable` deferral): all killed; 51 tests pass.

Evidence:

- `tests/issue-7354-vg-script-var-home.test.ts`: 49 tests pass. Mutation sweep over every boolean guard of the two
  modules' V code (28 mutants, each deleted or weakened alone): 26 killed. Two survivors, both typed-shape
  assumptions: the classifier's `isNamedVariableDeclaration` (a `BindingElement` or a pattern declarator never
  passes the proof's own top-level-statement check; the guard narrows the type the proof takes) and the
  `ts.isIdentifier` filter on spellings (a string literal never resolves to the binding's symbol, so `isRead`
  already answers false; the guard narrows the type `isValueReference` takes).
- Acceptance probes re-run through the strict Prepared entry against node: every accepted program returns node's
  answer; the reviewer's multi-file repros A–D are refused.
- Ordinary-pipeline bytes against `origin/claude/7354-r` (its tree extracted beside this one): 597 test262 files
  (the sample's 419 paths plus the reviewer's 188) and 92 probe programs in two forms, default JS target and
  `--target standalone`: 791 rows each, all identical (555 test262 binaries per target, the rest compile errors on
  both).
- Prepared tests (`test262-prepared-entry`, `test262-prepared-runtime`, #7188, R census, this file): 154/154.
- 411-row sample through the real runner: 394 at "function X has an unresolved parameter contract", 2 at the
  switch-case lexical binding, negatives 14 pass and 1 compile error — unchanged.
- Gates: typecheck, loc, func, coercion-sites, oracle-ratchet, dead-exports, import-cycles, compiler-boundaries
  inventory.

### Known gaps

- **`export default <expression>`** on the Prepared path compiles and exports nothing: `let b = true; export default
  b;` (which G lets through) and `let b = 1; export default b;` (which already did on main). Not for this slice; the
  issue is filed separately.

## P result

Status 2026-11-16. Branch `claude/7354-p`: `claude/7354-vg` + `claude/7354-d1` (merged up to `3d0c7995c5` and
`08fcfa7b82`) + P.

### Rule chosen

**On the native lane (internal, synchronous, wasmgc standalone) a parameter without a TypeScript annotation is the
dynamic value, always.** No call-site proof. Why this one and not "count top-level callers in propagation":

- Propagation (`buildIrUnitTypeMap`) misses more than top-level callers: calls with missing arguments (`f()` makes `v`
  `undefined`), calls through values, and `arguments`. Counting module-init callers alone is still unsound; a sound
  typed rule needs all of those proofs plus every source of a multi-file program. Changing the shared propagation
  would also move ordinary-pipeline output.
- It buys nothing on the target: a call-site census of every untyped harness parameter (`fyi-runtime`, `assert.js`,
  `sta.js`, `propertyHelper.js`, `isConstructor.js`) finds none that a proof could type. Each one receives `any` or
  several types, has short calls, or its function is used as a value (`assert`, `Test262Error`, `verifyProperty`,
  `compareArray`, `formatIdentityFreeValue`, …). The typed variant is a later optimisation, not a soundness need.
- JSDoc is not checked at runtime, so `@param {number}` is treated exactly like no annotation.

**Unannotated results.** Propagated results were computed from the unsound parameter types (`return v` came out
`void` or `boolean`). On the same lane an unannotated result that the body returns is dynamic when the checker
cannot vouch for it: the checker says `any`, a JSDoc `@returns` names it, or the body can also run off its end
(`undefined`). Any other unannotated result keeps the producer's inference, which the middle end already validates
against the lowered body (a disagreement is a refusal, never a conversion).

### Built

- `src/ir/source-dynamic-contracts.ts`: the one contract arm. `sourceDynamicParameter` answers `dynamic` for an
  unannotated parameter on the native lane (it now takes the parameter alone; the annotation is read from it);
  `sourceDynamicResult` gains `uncheckedResult` beside the annotated-`any` arm. Both use D1's `dynamicLane`, so an
  exported function keeps its old contract, and both feed the signatures `legalizeSourceDynamicValues` reads: an
  untyped parameter triggers the legalization exactly as an explicit `any` does (one trigger rule).
- `src/ir/program-source.ts`: asks the arm first for every parameter; no growth (8 lines changed, net 0).
- Other lanes are unchanged: they keep the propagated parameter type, which from-ast checks at every direct call
  (a mismatch refuses, as the repro did).

### Measured

- `tests/issue-7354-p-parameter-contracts.test.ts`, 19 tests. Acceptance, each run twice (node's answers return, one
  wrong answer throws): the repro without its JSDoc (`g(true)` → false, `h(0.5)` → false, `h(0)` → true); `id` with a
  number, a boolean and `undefined` from top level and from a function; `sq(n)` only ever passed numbers (dynamic,
  `*` converts back); recursion; a parameter reassigned to `true`; a missing argument; a body that runs off its end;
  a local copied from a parameter; `@returns {void}` on a body with no value; `isNegativeZero` (runs — it is not
  blocked by any dynamic operation). Refusals: ToBoolean (the repro's original `v ? 1 : 2`, `dyn.truthy`),
  `arguments` (`dyn.arguments_length`), an extra argument (arity), a call through a value (`var g = f`, no home), a
  JSDoc `{number}` parameter given a boolean through `any`, a JSDoc `@returns {number}` over an untyped value, the gc
  target (no carrier: unresolved contract), and a caller in another script or another module (`compileMulti`;
  refused before the contract matters — the contract reads no call site, so another source cannot unsettle it).
- Mutation check: 6 mutations (parameter arm off; parameter arm on every lane; result `any` off; JSDoc `@returns`
  off; fall-out off; the returns-a-value guard off) each fail at least one test.
- Ordinary-pipeline bytes: the 411-row list, base sources swapped into the same tree: 404 files compiled per target,
  byte-identical on the JS environment and on `--target standalone` (8 compile errors on both, 15 skipped).
  Measured at `e61ea49d0b`; P's later edits stay inside `source-dynamic-contracts.ts` and `program-source.ts`, which
  only the Prepared producer imports (`program-preparation.ts`), so the ordinary pipeline does not load them.
- Existing tests: prepared-entry, prepared-runtime, #7188, R, D1, V/G and P: 190/190.
  `issue-3518*`/`issue-3526*` (307 files): 4,722 failing tests on the base (P's two files
  swapped back), 4,724 with P; the sets differ only in three files with test timeouts on a loaded box
  (`native-invocation-consumer`, `native-mixed-object-access`, `void-closure-results`). Re-run alone with P, the
  differing tests pass; the remaining failures there are timeouts (35–45 s each) that also fail on the base..
- Real runner, 411-row sample: negatives unchanged (14 pass, 1 compile error). **No row
  stops at "unresolved parameter contract" any more** (394 before). New first-gap tally over the 396 positive rows:
  - 393 × "module binding X has no exact typed storage: not-direct": `print` 345 (`scripts/test262-fyi-runtime.js:4`,
    `var print = function (value) { … }` — a function expression), `__isArray` 43 (`harness/propertyHelper.js:27`,
    `var __isArray = Array.isArray;` — a built-in member), `__globalObject` 5 (`harness/fnGlobalObject.js:9`,
    `var __globalObject = Function("return this;")();` — the global object). Slices F and B, not a dynamic home:
    D1's carrier admits only numbers, booleans and `undefined`.
  - 2 × the switch-case lexical binding (as before), 1 × "callable annotation in DD_operator requires exact required
    parameter declarations".
- Operator sweep (69 forms × 7 values, an untyped parameter in a JS function, against node): no wrong answer. Correct:
  unary `-`/`+`, `-`, `*`, `/`, `%`, `===`/`!==`, relational, bitwise and shifts, `,`, `v++;`/`v--;` statements,
  `-=`/`*=`, a dynamic local, calls passing the parameter on. Named refusals: ToBoolean (`!`, `?:`, `if`, `&&`,
  `||`), `typeof`, dynamic `+`/`+=`, loose equality, `~`, `??`, a dynamic value into a typed local or `Math.abs`,
  `isNaN`/`String`/`Number`, member reads, array/object literals, `switch`. **Two crashes (invariant errors), both
  shared with an explicit `any` and handed to D1's rework:** `**` with a dynamic operand and prefix `++v`.
- D1 names P depends on: `dynamicLane`, `checkerAny`, `annotatedAny`, `legalizeSourceDynamicValues` (trigger), and the
  intrinsics source programs reach: `js.number.box`, `js.number.unbox`, `js.boolean.box`, `js.value.strict_eq`,
  `js.value.undefined`, `js.extern.is_undefined`. Not reached by any probe: `js.value.is_number`,
  `js.value.is_boolean`, `js.boolean.unbox`.
- Gates: typecheck, loc, func, coercion-sites, oracle-ratchet, dead-exports, import-cycles, compiler-boundaries
  inventory.

### Test pins updated by P

- `tests/issue-7354-d1-dynamic-carrier.test.ts` (on the merge with D1 `368c41b7c4`): two pins encoded the propagation
  rule P replaces. `function id(x) { return x; }` with `id(3) + 1` relied on a propagated number parameter; under P the
  result is dynamic, so the test now reaches the number through ToNumber (`id(3) * 1 + 1`). "an inferred `any` result"
  stays refused no more: `function f(v: any) { return v; }` returns the dynamic value, so it moved from the refusal
  list to a run.

### Named gaps (refused, not built here)

- **Unbracketed JSDoc `number`/`string`/`boolean` parameter or `@returns`.** from-ast (`resolveIrType`) treats such a
  JSDoc tag as authoritative and refuses the dynamic contract ("type override (dynamic) disagrees with annotation").
  Sound. A Prepared-only from-ast option "JSDoc is not a contract" is a possible later slice (the ordinary pipeline
  relies on the rule, so it must stay opt-in). In the sample it would matter for the 47 rows that include
  `propertyHelper.js` (`verifyCallableProperty`'s `@param {number} functionLength`), once those rows get that far.
- **Dynamic `var` home** (`var x; x = 1`): the resolver already binds a `dynamic` home, but the physical plan refuses
  a dynamic global ("global x carries non-scalar IR type dynamic; … references global x that the plan cannot
  reserve"). It needs a globals arm in D1's legalization and physical carrier (`externref` global) and an `undefined`
  initial value (the `$undefined` singleton, which is not a constant expression today). Follow-up slice.
- **A parameterless function with an unannotated boolean result** (`function k(){ return 1 === 1; }`): the propagated
  result lowers without the `boolean` flag and the presentation join refuses ("source declaration and prepared
  callable slots disagree"). Predates P (same on the base); a function with a parameter is not joined, so harness
  helpers do not meet it.

### After the final re-merge (V/G `2081dd516c`, D1 `368c41b7c4`)

- Tests of R, D1, V/G, P, prepared entry/runtime and #7188 pass (D1's two timeouts under load pass alone, 46/46).
- Operator sweep: still no wrong answer; the two crash families are now D1's named refusals (`'**' on a dynamic
  operand`, `value-position prefix update`). Intrinsics reached are unchanged (the six listed above).
- 411-row sample: 0 rows at "unresolved parameter contract"; 393 at "not-direct" (`print` 345, `__isArray` 43,
  `__globalObject` 5); negatives 14 pass.
- Ordinary-pipeline bytes against `origin/main`: 404 files per target, identical on the JS environment and
  `--target standalone` (8 compile errors on both, 15 skipped).
- Gates: typecheck, loc, func, coercion-sites, oracle-ratchet, dead-exports, import-cycles, boundaries inventory.
- issue-3518\*/3526\* were not re-run after this merge (last run: on D1 `08fcfa7b82`, above).

## Str result

Status 2026-11-17. Branch `claude/7354-str` on `claude/7354-p` (`1995dd6ef2`). Steps 1 and 2 of the slice are built;
steps 3–5 (dynamic `+`, ToString/`String(x)`, `typeof`) are the follow-up slice Str2 (lead decision, below).

### Built

- **Step 1 — typed strings through the presentation.**
  - `preparedPresentationPolicy` selects native string constants, equality, length and concatenation on wasmgc
    standalone (not the relational compare: it has no join).
  - The string value plan (`native-string-values.ts`) joins `string.eq` to the lazy `__str_equals` resource
    (`native-string-equality.ts`, reused as is) and `string.len` to the carrier's length field.
    `native-string-output-requirements.ts` no longer refuses those two kinds.
  - One `preparedNativeStringResolver(tx, pack, unitId)` realises an owner's string operations; `fillPrimaryBody`
    spreads it (program-consumer.ts shrinks by 11 lines).
  - R's census: a storage provider (`native-global` literal, `carrier-field` length) is answered by the setup's
    literal storage or string carrier type; a provider the IR reaches through its own instruction (`string.eq`,
    `string.concat`) by the setup function named after the provider's symbol. Every other setup function stays a
    declared dependency, as before.
  - The ABI join admits a native string in an internal callable contract on standalone, beside D1's externref arm.
- **Step 2 — a string in the dynamic value.**
  - The legalization boxes a string as `coerce.to_externref` (the externref that wraps it), the ordinary standalone
    carrier.
  - `nativeStringsReachCarrier(demands)` (`native-string-value-demands.ts`): a native string can reach the carrier
    only through an executable `coerce.to_externref` of a string (its box, a thrown string). When it can, strict
    equality takes the shared SameValue builder's string arm (code units through flatten + `__str_equals`), which
    D1 left off; otherwise its body is unchanged.

### Differences from the brief and why

- **No typed string home for a script `var`.** V's classifier can answer the existing `"string"` home soundly with
  the same reads proof (tried), but the physical plan has no string global ("global s carries non-scalar IR type
  string") — the same globals arm H builds for dynamic. Left to H/merge; proven with function locals.
- **A reassigned typed string local** is refused by from-ast ("has no slot representation"): the Prepared resolver
  has no `resolveString` slot type. Not built (a resolver seam, not a join).
- **Step 3 needs a second body** (`__ir_dyn_add` = `emitAnyAddFromExternTemps`, entangled with the legacy object
  runtime); per the lead: Str2 builds a Prepared-native add from shared pure builders.

### Measured

- `tests/issue-7354-str-strings.test.ts` (16 tests): typed string locals, concatenation, a non-ASCII literal,
  `throw "x"` caught and escaping, strings out of `try`/`catch`; a string through an untyped parameter compared
  with literals, numbers and `undefined`; fresh concatenations equal by code units through `any`; StringToNumber.
  Refusals: compare, reassigned string local, script string var, gc target, ToBoolean, `==`, a method call.
- Sweep (strict entry, against node): 11 operations (`===`, `!==`, against a typed string / number, `* 1`, `- 0`,
  unary `+`/`-`, `< 2`, `>= 0`) × 19 values (numbers incl. NaN, ±0, ±Infinity; booleans; `undefined`; 9 strings
  incl. `""`, `" 3 "`, `"0x10"`, `"-0"`, `"Infinity"`) × 4 positions (top level, function, value, condition):
  44/44 correct. Named gaps for dynamic `+`, `typeof`, `!`, `==`; zero invariant errors, zero invalid Wasm.
- Ordinary-pipeline bytes, base sources swapped into the same tree: 396 files of the 411-row list compiled, identical
  on the JS environment and `--target standalone` (8 compile errors on both, 15 skipped).
- Prepared bytes: every module the prepared-entry/runtime, #7188, R, D1, P and V/G tests instantiate (66) is
  identical; the one new module is Str's census program.
- Pins (base vs this branch, failing sets): the 22 #3518/#7139 files that import a touched module, and the changed
  root tests: identical failing sets except the pins below. Pre-existing on the base (same sets): the core
  vocabulary seam (source hash of `src/ir/ast-lowering-plans.ts`), semantic-verification ownership (`effects.ts`),
  string-boundary-const (5), number-format requirements (2), realm requirements (1), and 626 receipt tests in the
  validator/helper policy-evolution and semantic-provider-boundary files.
- Pins updated: R (`throw "x"` → the compare refusal; Str census tests), D1 (object box refusal; member read names
  `dyn.member_get`; `selectNativeDynamicValues` signal), `issue-3518-native-string-output-requirements`
  (string length is a value-plan join, no output use).
- 411-row sample: unchanged — 393 × not-direct (`print` 345, `__isArray` 43, `__globalObject` 5), 2 × switch-case
  binding, 1 × `DD_operator`; negatives 14 pass.
- Mutation survivors: the `string` kind check and the projection-view check of `nativeStringsReachCarrier` (today
  every executable `coerce.to_externref` carries a string and the program view mirrors the projection).
- Gates: typecheck, loc, func, coercion-sites, oracle-ratchet, dead-exports, import-cycles, boundaries inventory.

### Known gaps and hand-over (Str2)

- Every emitted string literal/concat re-authenticates the whole native string plan (`emitPreparedNativeStringLiteral`
  → `requireCompletedNativeStringValues` → `ownerFor` → `assertNativeStringValueReservationInput` →
  `planNativeStringValuePhysical` → `assertNativeStringOutputRequirementsCurrent`, twice per literal). Profile of a
  20-string-op program: 38.5 s total, 24.6 s in `emitPreparedNativeStringLiteral`, 16.9 s in the re-plan.
- Number formatting is a runtime-support batch, which the presentation refuses (`ir-program-presentation.ts`
  `checkResourceDemand`, "source and prepared runtime must independently prove no async/support demand").

## Perf result (2026-11-17)

Branch `claude/7354-perf` on `claude/7354-str`. Change in `src/backend/wasmgc/program/native-string-values.ts` only
(plus `tests/issue-7354-perf-string-authentication.test.ts`).

### Why every emit re-planned, and what replaces it

`ownerFor` is #3518 fail-closed machinery: before any use of a string pack it proves the retained reservation input
(demands with the whole program, plan, value/output/invocation/realm requirements) is still what was authenticated —
by comparing the demands to a frozen snapshot and re-running the whole plan (`assertNativeStringValueReservationInput`).
That proof is a pure function of the retained input (the issue registries it consults — value plans, output
requirements, invocation and realm requirements — are append-only and keyed by fresh frozen objects). So:

- `isImmutablePreparedIrValue(owner.input)` walks the retained input once: every reachable object must be frozen
  plain data (Object/null/Array prototype, data properties only, no functions) or a frozen collection of prepared
  data. Freezing cannot be undone, so the answer is permanent.
- The answer is computed BEFORE the checks run on the first use; if it is `true` and the checks pass, the owner is
  `settled` and later uses skip the snapshot comparison and the re-plan. No key, no cache: input that cannot change
  cannot go stale. Input that can still change (any unfrozen part) is re-authenticated at every use exactly as before.
- Unchanged per use: the realm-literal identity check (it reads the caller's live input object), the inventories, the
  completion checks of every sub-pack, and the physical layout audit.
- The Prepared producers hand over fully frozen input (measured on the probe program: everything reachable is frozen).
- Also: an emit checked the pack twice (`requireCompletedNativeStringValues` then `ownerFor` again with nothing in
  between); it now checks once (`completedOwner`). The per-row `tx.physicalIndex` loops are one `tx.physicalIndices`
  call (same state, ownership and layout checks; one layout audit instead of one per row).
- The predicate sits beside its only check, not in `src/ir/program/data.ts`: that file and
  `tests/issue-3518-program-ownership-runtime-seam.test.ts` are full-file historical pins.

### Measurements (compile time through the strict Prepared entry, one line = literal + concat + length + `===`)

| lines | base (s) | after (s) |
| ----: | -------: | --------: |
|     5 |      8.6 |       5.8 |
|    20 |     71.9 |      16.5 |
|    50 |    436.0 |      49.9 |
|   100 |        — |     133.4 |
|   200 |        — |     428.2 |

CPU profile, 20 lines: base 66.8 s profiled (`ownerFor` 43.0 s, re-plan 29.9 s); after 18.9 s (`ownerFor` 1.7 s,
re-plan 0.7 s once). The goal (20 lines under 3 s, flat per-op cost) is NOT met: the remaining per-emit cost is the
physical layout audit. One literal emit runs `PhysicalModuleReservations.#verifyLayout` 63 times (each sub-pack's
`requireCompleted*` re-checks its dependencies, each with its own audit), and each audit snapshots every filled
function and global, so it grows with the module — still quadratic. That audit authenticates mutable module storage,
so it cannot be keyed or memoised; it is a different mechanism (the transaction's) and is left for its own slice.
Measured experiment (not committed): bracketing the completion check with one audit before and one after and
skipping the nested audits brings 20 lines to 5.7 s (emit 0.65 s); the rest is one-time plan authentication
(`preparedIrDataMismatch`/`hasNativeCollectionState` on freshly re-collected demands, ~2.7 s).

### Proofs

- Non-staleness: every refusal test of `tests/issue-3518-native-string-*` and the value-chain consumers fails the
  same set as base; new tests refuse demands and plan mutated between two emits and after several emits, show the
  physical audit still refuses an altered global after settling, and pin the predicate on 18 value shapes.
- Prepared bytes identical to base for the 43 distinct programs of `issue-7354-str-strings`, `test262-prepared-entry`
  and `test262-prepared-runtime`; ordinary pipeline identical on 200 test262 files × (default, standalone).
- Failing sets equal to base in all 42 related test files (3518 native-string ×24, realm, number-format, promise,
  ownership seam, provider-boundary, policy-evolution, …).
- Mutation survivors: the FrozenSet content walk (no public way to build a FrozenSet with mutable content; kept so
  the predicate does not depend on that) and `owner.settled = settles` (deleting it only costs time).

### Same pattern nearby

- `emitStringEquals`/`emitStringLen`/concat go through the same `completedOwner` — covered.
- `requireCompletedNativeValues` → `assertNativeValueResourcePlan` re-derives the value plan from the program at
  every call (~0.07 s over 20 lines here: cheap today, same shape, not fixed).
- `readNativeRealmLiteralInput` → `assertNativeRealmRequirementsCurrent` recalculates the realm catalog per use when a
  realm is present (not on this path's string programs; not fixed).

### Step 2 (2026-11-17): the physical audit count, the tuple scans, one copy fact

What changed:

- `PhysicalModuleReservations.audited(check)` (`src/wasm/physical/module-reservations.ts`). It runs a read-only
  check with the nested layout audits skipped and one audit after it. Two facts make that sound:
  - every ledger mutation (`#require`) inside the check is refused;
  - the check's result is returned only after the trailing audit passes.

  So whatever the check read was the audited layout, or the call fails. `completedOwner` (every string emit) uses it:
  one audit per emit instead of 63. There is no entry audit: an earlier change is caught by the trailing one.
- Literal tuple matching (`sameDemandTuple`, used by planning's all-pairs ambiguity check and by every emit's plan
  scan) compares value, owner and alloc with `Object.is` before the deep comparison. That was quadratic in the
  literal count, and every deep comparison of fresh objects paid four thrown collection-slot probes.
- `immutableCopy` (`src/ir/program/data.ts`) records "no collection slot" for each null-prototype record it creates,
  instead of probing for it later. That is a permanent fact of a fresh `Object.create(null)`.

The frozen-entry design was evaluated and not applied. `fillOwnedFunction` already makes bodies permanent, but no
producer was moved:

- Resource bodies (flatten, scanner, values, literals, equality, dynamic values): fixtures compare
  `structuredClone(module)` with `toStrictEqual`, which the owned private-prototype arrays fail (#3518 getter
  invocation).
- Source primary bodies: `rejects an already-filled source body mutation` expects the audit refusal, not a
  TypeError.
- The remainder helper: its test spies on `fillFunction`.

After the count fix, the body share of the audit was small (0.2 s at 20 lines), so (b) was not needed.

| lines | base 4318ee (s) | step 1 (s) | step 2 (s) |
| ----: | --------------: | ---------: | ---------: |
|     5 |             8.6 |        5.8 |        2.7 |
|    20 |            71.9 |       16.5 |        4.4 |
|    50 |           436.0 |       49.9 |        9.8 |
|   100 |               — |      133.4 |       19.0 |
|   200 |               — |      428.2 |       45.4 |

Synthetic program with 100 string literals/concats spread over 25 functions: 137.3 s on base, 7.1 s now, same bytes.

The targets (20 lines < 3 s, 200 lines < 20 s, flat per line) are not met. Per-line cost still rises from ~0.13 s
to ~0.26 s. CPU profile at 100 lines (30 s profiled):

- `hasNativeCollectionState` 8.4 s: probes on freshly computed objects in `preparedIrDataMismatch`. The callers are
  one-time currentness checks that re-derive and compare the whole program: object access, census, value plan,
  output requirements.
- `planNativeStringValuePhysical` 7.7 s: runs four times per compile (two setup derivations, the reservation check,
  the settle pass).
- The audit itself 6.9 s: one per emit, plus `physicalIndex` and inventory audits outside the scope. Each audit is
  O(module), so the cost is still quadratic in the literal count.

The next levers are those re-derivations (share one derivation per immutable program rather than re-deriving per
component) and the audit's O(module) walk. Neither is a change to this module alone.

Proofs:

- Failing sets equal base for 112 test files touching the changed modules, in chunks of 4. One base-only failure
  under load (object-key-foundation) passes alone.
- Prepared bytes are identical for the 43 programs. Ordinary bytes are identical on 200 test262 files × (default,
  standalone).
- New tests:
  - a filled global altered after 5 emits is refused;
  - an extra population slot is refused;
  - a write injected between the check and its trailing audit (through a vitest module mock of the literal
    completion check) is refused;
  - a ledger mutation inside `audited` is refused;
  - a literal tuple that differs only in its storage reference is refused.
- Mutation survivors are all performance-only: skipping nested audits, the `audited` wrapper in `completedOwner`,
  the three primitive prefilters (implied by the deep comparison) and the copy-brand fact.
