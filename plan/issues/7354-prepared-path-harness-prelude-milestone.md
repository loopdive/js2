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
# 2026-11-16 (slice D1, review round 1): src/ir/from-ast.ts +6, two named
# declines the Prepared producer reaches because it has no selector (`**` on a
# dynamic operand, a value-position prefix `++`/`--`); they replace invariant
# crashes in place and sit in the arms that own them. ir-program-presentation.ts
# +1: D1's internal externref callable contract admission in the ABI join.
# 2026-11-17 (slice H, review round 1): src/ir/program-physical-plan.ts +2, the
# import of `storesUndefinedFirst` and the source-global arm that admits a null
# default only when the module-init stores `undefined` first (the check lives in
# src/ir/program/dynamic-value-legalization.ts beside the store it checks).
# 2026-11-17 (slice Str, merge onto H): src/compiler/ir-program-presentation.ts +1,
# `inCall`, the ABI join's admission of a native string in an internal callable
# contract (string parameters and results), beside H's `carried` it extends.
# 2026-11-19 (realm join, slice O step O1): src/ir/program-consumer.ts, the emission wiring of the realm's
# source-object family: the second `reconcileNativeCallBindings` call (the reconciler itself is the renamed, shared
# invocation one), the realm-slot record on the emission observation with its one reader `emittedNativeRealmSlots`
# (the record lives beside the consumer-private observation map; the slot computation, `nativeRealmCompletedSlots`,
# lives in native-realm.ts) and the imports. The two native binding lists fold through `plannedNativeCallBindings`
# (program-physical-plan.ts) instead of growing each.
# 2026-11-17 (slice Str2): src/compiler.ts +1, `...preparedNumberFormatOptions(...)` in the Prepared
# backend options: the number formatter's physical policy, chosen in the census module beside
# `preparedPresentationPolicy` (same import line).
# 2026-11-19 (slice O, step O3): src/ir/program-source.ts +12, the compiler-supplied `codeStrictness` input on
# IrProgramSourceInput (its doc and field) and `sourceCodeStrictness`, the helper that turns it into the lowering's
# `functionCodeStrict`, so `prepareIrProgramSources` grows by one spread line, not past its budget; src/compiler.ts
# +2, the import and the one `codeStrictness:` row of the preparation input (the strictness itself lives in
# src/compiler/prepared-code-strictness.ts); src/ir/from-ast.ts +3, the externref receiver of a member write taking
# the read's carrier box.
# 2026-11-21 (slices M1 + M2, corrected after review): the figures above are per slice. Against main this PR grows
# src/ir/program-source.ts by 0 and src/ir/from-ast.ts by 16 (three lowering arms: `isRawExternrefReceiver`, the
# member write's externref receiver, the object-literal box in `boxConcreteToDynamic`).
loc-budget-allow:
  - src/ir/program-consumer.ts
  - src/ir/program-physical-plan.ts
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

Branch `claude/7354-d1`, on `main` after slice R (PR #7268) landed. Decisions
(they override the plan text above where they differ; review round 1 below
records what changed after the adversarial review):

1. **Option B, one legalization pass.** The Prepared backend binds runtime
   functions only through semantic intrinsics, so
   `src/ir/program/dynamic-value-legalization.ts` rewrites the dynamic
   operations into intrinsics and every `dynamic` type into `externref`. The
   source producer runs it on every function it lowers on the wasmgc standalone
   lane when the program has a native `any` contract
   (`legalizeSourceDynamicValues`); a function without a dynamic value is
   returned unchanged. Every later
   stage (runtime projection, validator replay, clock witness, physical plan)
   sees an ordinary externref program, and `program/runtime-manifest.ts`,
   `runtime-validation.ts` and `runtime-abi.ts` stay byte-identical (they are
   complete-source pins of the #3518/#3525 relocation receipts; a first cut ran
   the pass in the projection and broke 150 receipt tests). There is no second
   `IrDynamicLowering`; this replaces the plan's bullet for it.
2. **The D1 set.** `box` of an f64 to `js.number.box`, a Boolean-tagged box to
   `js.boolean.box`; `unbox` NumberF64 and `dyn.to_number` to `js.number.unbox`
   (`__unbox_number` is exactly ToNumber over the admitted values: number,
   boolean, `undefined` gives NaN); `tag.test` Undefined to
   `js.extern.is_undefined`; `dyn.undefined` to `js.value.undefined`; strict
   `dyn.eq` to `js.value.strict_eq` (+ `i32.eqz` for `!==`). Everything else
   refuses as "dynamic operation X has no Prepared intrinsic": loose `==`, every
   other tag test or unbox, ToBoolean, `typeof`, member access, a box of
   anything but an f64 number or a Boolean (strings included),
   `coerce.to_externref` of a dynamic value (`Number(v)`, `throw v`), a dynamic
   type left in a composite, and a front-end dynamic helper (`__ir_dyn_add`, …),
   which has no runtime declaration.
   - Soundness rests on the admitted set: only numbers, booleans and
     `undefined` enter a dynamic value. Strict equality therefore needs no
     BigInt or string arm; the slice that admits strings must add the string
     arm (`buildObjectSameValueBody` already has it).
   - Providers live in `src/ir/runtime/dynamic-value-callables.ts` (one native
     standalone arm each, no policy): `js.value.strict_eq` (`__js_strict_eq`)
     and `js.value.undefined` (`__js_undefined`, a nullary call with its own
     signature). The provider-row comparison is one helper
     (`canonical-provider-mismatch.ts`) for the ordinary-object and dynamic-value
     families.
   - `__js_strict_eq` is `buildObjectSameValueBody` with the number rule
     `number-equal` and no BigInt arm; `__extern_is_undefined` is the legacy
     body moved to `buildIsUndefinedBody` (`primitive-layouts.ts`).
3. **The one flow rule.** A dynamic value leaves the dynamic domain only
   through an operation the legalization expresses or refuses by name, or by a
   conversion the source writes (`+v`, `v * 2`, `v - 1`, bitwise and relational
   operators, `===`). An `any` expression whose contextual type is not `any`
   (a typed result, a typed parameter, a typed binding, a typed literal member)
   would cross into that type with no conversion the source wrote, and the
   Prepared path has no checked unbox yet: it refuses as "a dynamic value flows
   into T without a conversion (Site)". The rule runs after lowering, only for
   a declaration whose lowered functions carry a dynamic value (a checker `any`
   the IR types concretely, such as an untyped parameter with a propagated
   number type, is no dynamic value). Typed locals, assignments, conditional
   branches, typed literal members and Boolean parameters already refuse while
   lowering, each by its own from-ast name. The ordinary pipeline's ToNumber at
   typed call arguments (`from-ast.ts`, #2949 S5.P) is unchanged and is never
   reached on Prepared, because the rule refuses those programs.
4. **Numeric mode.** `selectNativeDynamicValues` puts the native string value
   plan into its existing numeric mode when the projection needs strict
   equality, the `undefined` value, or a natively bound `js.extern.is_undefined`;
   `resources/native-dynamic-values.ts` adds `__js_strict_eq`, `__js_undefined`
   and `__extern_is_undefined` beside the value and Boolean resources. Strict
   equality reserves the Boolean predicate pair. The `primitive-only` resource
   plan was not widened (it has no production caller).
5. **`any` contracts.** `src/ir/source-dynamic-contracts.ts` holds every
   `any`-contract rule of the Prepared source producer (the host async arm,
   moved unchanged, and the native arm: an explicitly annotated `any` parameter
   or result of an internal synchronous wasmgc standalone function; an exported
   `any` keeps its existing contract, the source Boolean `any` result or the
   Phase 1 refusal), the flow rule and `resolveDynamic`. Untyped and JSDoc
   parameters stay refused (slice P). The presentation's ABI join admits an
   internal `externref` callable contract on standalone.
6. **On R.** `preparedPresentationPolicy` also selects native Boolean boxing and
   the native `undefined` probe; the census authenticates the new providers
   unchanged.

Proof: `tests/issue-7354-d1-dynamic-carrier.test.ts` (49 tests) compiles through
the strict Prepared entry, validates and runs: number/boolean/`undefined`
through `function id(v: any): any`; `===` and `!==` over every ordered pair of
`1, -0, 0, NaN, 1.5, true, false, undefined` against JavaScript; one helper
with three tags; written conversions back to a number; a branch join and a
conditional; a dynamic block argument; a propagated-number
untyped parameter staying numeric; the flow rule skipping a declaration without a dynamic value; a result-only `any` contract. Refusals: every typed flow, loose equality,
the null tag test, ToBoolean, dynamic `+`, member reads, `typeof`, `**` on
either side, a value-position prefix update, a thrown dynamic value, a dynamic
object field, an inferred `any` result, an exported `any`, the gc target.
Direct tests of the pass (each guard), of the `undefined` probe selection and
of the policy. `tests/issue-7354-r-provider-census.test.ts` gains R's census on
a D1 program: dropping or renaming either `js.value.*` provider, or renaming
either native resource, refuses.

Measured (ordinary bytes at cc8e8eca7c, the rest at 368c41b7c4; the later
commits touch only the Prepared source producer, tests and this file):

- Ordinary pipeline bytes against `origin/main` (965e3d77eb, R included): 366
  test262 files (R's 170-file list plus `Object.is`, strict (in)equality,
  `Array.prototype.includes`, every tenth `Object.defineProperty`,
  exponentiation and prefix-increment files) × {standalone, JS environment}: 732
  results identical, 44 compile errors on both trees, 0 throws.
- Prepared bytes against `origin/main`: the 31 `any`-free programs of
  `test262-prepared-*`, #7188 and R's tests × {standalone, gc, wasi}: 93
  results identical.
- Probe sweep (`.tmp/rv/sweep.mts`, 438 programs: 24 binary operators × left,
  right and numeric context, 6 unary, 4 updates, 15 compound assignments both
  ways, 6 condition positions, typed results, locals, assignments, parameters,
  `Math` arguments, conditionals, literals, `Number()`, `+v`, template, switch,
  throw; each with 3, `true` and `undefined`): 201 equal node, 235 named
  refusals, 0 wrong answers, 0 invalid Wasm. Two crashes remain, both
  `const o: { a: any } = { a: 3 }` — the Prepared object-literal crash that
  `const o = { a: 1 }` reproduces on `origin/main` without any `any` (Known
  gaps). The reviewer's 200 probes: 88 equal node (the whole pairwise `===`
  matrix), 111 named refusals, the same object-literal crash.
- 411-row ES5 sample through the real runner: `.tmp/myrun.sh` on `l420.txt`, wasmgc
  standalone: 14 pass, all 14 `negative:` tests (unchanged), 397 compile
  errors; first gap: 394 "top-level global storage needs a numeric source
  classification" (slices V/G, not on this branch's base), 2 "switch-case
  lexical binding", 1 parse error. No row passes that should not.
- Pin sets: the 335 files of `tests/issue-3518*`, `tests/issue-3526*`, the
  reviewer's pin-referencing list and R's census test, on this branch and on
  a `git worktree` of `origin/main` 965e3d77eb (the main this branch merged),
  in chunks of 25 with 2 forks. Both trees fail about 5,000 tests (source
  receipts that main itself fails today); the 24 files whose sets differed
  were re-run alone on both trees. After that: one test of
  `issue-3518-native-invocation-consumer` fails on main and passes here
  (timing; it flips between runs), and the 3 tests of
  `issue-3518-native-string-number-source-admission` that failed here were
  caused by removing the contract gate, which is restored (item 8; that file
  now passes in full). No other difference.
- Mutation sweep (`.tmp/mut2.json`, 43 single-guard mutants of the pass, the
  contracts, the flow rule, the two from-ast declines, the resources, the
  providers, the ABI reader demand and the number rule; each run against this
  file, R's census test and `issue-3518-boolean-return-boundary`, the
  #3527 async-carrier tests for the lane gate): 43 killed, 0 survivors; the
  unmutated control fails nothing. The contract gate is killed by
  `issue-3518-native-string-number-source-admission` (item 8).

### Review round 1 (2026-11-16)

Verdict NOT MET; four must-fixes and six should-fixes. Each, what was done,
and the evidence:

1. *An `any` returned from a `number` function crashed* (`return[0] type
   externref not assignable`). Fixed by the flow rule (decision 3): it refuses
   as "a dynamic value flows into number without a conversion
   (ReturnStatement)". Tests: typed result, typed result of `main`, typed
   result in a branch.
2. *`**` on an `any` operand crashed* (`#4787 ... lost their exact
   checker-proven number types`). `**` has no dynamic lowering, and the
   Prepared producer has no selector to keep a dynamic operand away from the
   #4787 claim invariant: `emitExactNumericExponentiation` now declines
   "'**' on a dynamic operand" first (the ordinary selector never claims one,
   so ordinary output is unchanged, measured above). Slice P's sweep found a
   second crash of the same kind: a value-position prefix `++`/`--` (on any
   operand, `any` or not) reached the #2135 capability guard; `lowerPrefixUnary`
   now declines "value-position prefix update" first. Tests for both.
3. *A dynamic value passed to a `number`/`boolean` parameter was converted
   silently* (`f(id(true))` answered 1, node 0). Refused by the flow rule
   (number) and by from-ast's own argument check (boolean); the ordinary
   pipeline's ToNumber at call arguments is untouched. Written conversions
   (`+v`, `v * 2`, `f(+v)`) still run (tests).
4. *The strict-equality body was a copy.* Folded:
   `ObjectSameValueResources` gains an optional `numberEquality:
   "number-equal"` and an optional BigInt arm (`typeofBigIdx` with `bigint`,
   or neither); every legacy caller passes the same fields and gets
   byte-identical bodies (checked on the builder output for the carrier,
   legacy-i64 and string-less variants, and by the byte run above).
   `strict-equality-body.ts` is deleted. The #3518 receipts replay through one
   new hash-checked inverse step, `beforeStrictEqualityFold`
   (`tests/helpers/same-value-nan-correction.ts`, 9 spans, current
   ba1d144b… → the NaN-corrected 32b7cba6…; round 2 named the SameValue
   number arm `sameValueNumbers` beside `numberEqual`, which keeps 9 spans:
   the interface split and the re-indented arm are the bulk either way), which `beforeSameValueNaNCorrection`
   applies first, so the BigInt-port fixture is unchanged.
5. *`js.value.undefined` borrowed the storage-global signature.* It has its own
   `NULLARY_TO_EXTERNREF_INTRINSIC_SIGNATURE` (module-local in
   `core/intrinsics.ts`). The #3526 pin again states that the rows carrying
   `EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE` are exactly the four string-storage
   rows; it also pins that the one other empty-parameter row is the
   `undefined` call with its own signature. The two `manifest.ts` comments now
   say "the VALUE signature" instead of "the only empty-parameter signature",
   which a nullary call makes untrue.
6. *Arms without a source producer.* Removed: `js.value.is_number`,
   `js.value.is_boolean` (intrinsic, feature, provider, symbol, ABI rows, the
   Boolean-reader demand), the Boolean unbox arm and the i32 box arm. Disabling
   the i32 arm changed none of eight i32-producing probes (bitwise results,
   loop counters, `type i32`); slice P's sweep reached none of the four either.
   The pass now refuses those operations by name (direct tests).
7. *`canonicalProviderMismatch` covers 2 of 5 copies; the pass used an async
   helper.* The pass now takes SSA types from a neutral
   `irValueTypes` (`src/ir/analysis/value-types.ts`). The other three provider
   comparisons are not folded: `vectorProviderMismatch` and
   `nativeAsyncProviderMismatch` are source-hash pinned by the #3518 historical
   reconstruction (`tests/issue-3518-historical-runtime-reconstruction.test.ts`),
   and `numberRemainderProviderMismatch` compares with `sameData`, not JSON, so
   folding it changes behaviour. Both are Known gaps below.
8. *The native-contract gate has no test.* Kept, now with evidence: a first
   cut removed it, and `tests/issue-3518-native-string-number-source-admission.test.ts`
   then failed 3 tests (a string boxed into a dynamic value under unary `+`
   on a program without an `any` contract, which the existing path handles;
   the pass refused it as "box of a non-primitive value"). That file is the
   test that fails without the gate; the docblock names it.
9. *Mutation survivors.* New direct tests for every guard of the pass, the
   `undefined` probe selection, the policy, the census, the flow rule and the
   declines; see the mutation sweep above. The exported-`any` guard (C1) was a
   false survivor: `tests/issue-3518-boolean-return-boundary.test.ts` kills it
   (15 failures), because an exported `any` result keeps the source Boolean
   `any` contract.
10. This section.

### Test pins updated by D1 (closed lists a new intrinsic family changes)

- `tests/issue-3518-core-vocabulary-seam.test.ts`: `INTRINSIC_IDS` 39 → 41,
  `DYNAMIC_VALUE_INTRINSIC_IDS` in the canonical value list and the composed
  order (the facade `src/ir/intrinsics.ts` forwards it like its siblings).
- `tests/issue-3518-semantic-verification-ownership.test.ts`: successor pin of
  `INTRINSIC_DEFINITIONS` (a17fd837…) with a predecessor-chain step that
  removes exactly the two `js.value.*` rows to re-derive the #6921 pin
  (b763d963…), which then re-derives the original; catalogue length 39 → 41;
  the new `NULLARY_TO_EXTERNREF_INTRINSIC_SIGNATURE` declaration (d570d72d…),
  denominator 93 → 94.
- `tests/helpers/ir-historical-runtime-reconstruction.ts`: the reviewed
  declaration orders gain `DYNAMIC_VALUE_RUNTIME_FEATURES` /
  `DynamicValueRuntimeFeature` (`runtime/contracts/intrinsics.ts`) and
  `NULLARY_TO_EXTERNREF_INTRINSIC_SIGNATURE` (`core/intrinsics.ts`).
- `tests/issue-3526-string-boundary-const.test.ts`: restored to "the VALUE
  signature's rows are the string storage rows", plus the `undefined` call row
  (item 5).
- `tests/helpers/same-value-nan-correction.ts`,
  `tests/native-same-value-nan-payload.test.ts`: the fold's inverse step
  (item 4).
- `tests/issue-3518-native-boolean-consumer.test.ts`,
  `tests/issue-3518-native-getter-resource-join.test.ts`: the binder is
  `nativeIntrinsicAbiBindings` and refuses as "native intrinsic ABI".

### Known gaps (D1)

- **Object literals on Prepared.** `const o = { a: 1 }; return o.a` fails to
  lower ("resolver cannot lower object<a:f64>") on `origin/main`; with an
  `any` field it is the same crash. Slice C/F territory.
- **Provider comparisons and SSA type maps.** Three families keep their own
  canonical-provider comparison (item 7) and about ten modules a private
  `valueTypesOf`; folding them needs reviewed replay steps for #3518 receipts.
  Filed as [#7355](7355-ir-runtime-provider-and-ssa-type-helper-folds.md).
- **Flow rule granularity.** The rule is gated per declaration, not per
  expression: a checker `any` that the IR typed concretely (`h(2)` with an
  untyped `h`) still refuses when the same declaration also lowered a dynamic
  value (pinned by a test; node answers 13). Asking the lowered IR type per
  expression needs an AST-to-IR value map the producer does not keep.
- **Checked unbox.** A dynamic value for a typed parameter or result refuses;
  a later slice may add a checked unbox that converts or throws on a mismatch.

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
cannot vouch for it: the checker says `any`, or the body can also run off its end (`undefined`). (A JSDoc
`@returns` arm was removed in review round 1, below.) Any other unannotated result keeps the producer's inference, which the middle end already validates
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

### Review round 1

Adversarial review of `1995dd6ef2`: quality NOT MET, no soundness failure. Fixed on `claude/7354-p`, one commit
each, then D1's reworked head `29d0576590` merged in.

1. **JSDoc `@returns` arm deleted** from `uncheckedResult`. It duplicated D1's implicit-flow rule and refused
   correct programs. `/** @returns {number} */ function f(n){return n*1}` with `f(true)` and `/** @returns
   {boolean} */ function f(n){return n===1}` with `f(1)` now run and match node (1, true); `@returns {number}`
   over an unconverted `n` still refuses at the flow rule ("a dynamic value flows into number without a
   conversion (ReturnStatement)"). The message-pin test is replaced by these three.
2. `legalizeSourceDynamicValues`'s comment no longer cites "an untyped parameter with a propagated number type"
   (impossible since P).
3. `uncheckedResult` takes the body; its only caller refuses a body-less declaration first.
4. **Export by name:** `dynamicLane` reads the `export` modifier only (which also covers `export default`). A
   function exported by name (`function f(x){…} export {f}`) keeps the native contract and the presentation's
   export join refuses it ("source unit, export ABI and actual function-space export must join exactly"). The
   comment now says so; both refusals are pinned by tests.
5. **Mutation survivors killed** by direct tests of the contracts: an untyped parameter of a host async
   function has no dynamic contract (`lane === "native"`), and an annotated non-`any` result whose body runs
   off its end keeps its annotation (`declaration.type ?`). Each fails with its mutant applied.

Merge of D1 `29d0576590`: conflicts only in `legalizeSourceDynamicValues`'s comment (D1's text, P's trigger and
last sentence) and this file (all result sections kept). **Pins updated:** D1's two flow-rule tests used
`function h(x)` as a propagated-number declaration; under P it is dynamic and `x + 1` refuses as a dynamic add.
`h` takes `x: number` now; the second test pinned the known gap P removes (a concretely typed checker `any` beside
a dynamic value) and now runs (node 13).

Measured on the merge: typecheck and every gate, also with `LOC_GATE_BASE` = D1's tip; tests of R, V/G, D1, P,
prepared entry/runtime and #7188: 235/237 before the pin update, the two being those pins; D1 re-run after it 49/49. `changed-root-tests.sh` (interpreter engine):
`issue-3518-core-vocabulary-seam` is a changed root here (D1 edits it) and fails 4 tests, red on main until PR
#7278; not patched. Of the other roots, `issue-3518-semantic-verification-ownership` (1, the `effects.ts`
receipt) and `issue-3526-string-boundary-const` (5) fail identically on D1's tip `29d0576590`, so not P's; the
rest pass.

### Review round 2: MET

Review of `f9385ba314`: MET, no must-fix, no surviving mutant. The three should-fixes are closed:

1. `uncheckedResult`'s comment overstated D1's flow rule. What holds: where the checker reads a JSDoc `@returns`,
   it is the returned value's contextual type, so a value that may be dynamic is refused at the `return`; where
   the checker does not attach the tag (in `function id(v){return v} /** @returns {number} */ function f(n){return
   id(n)}` the comment follows a statement on its line), f's result is typed from its body, `id`'s `any`, and is
   dynamic through the checker-`any` arm. So the program is sound by that arm, not by the flow rule; it runs and
   answers node's `true` (test, right and wrong answer). The same program with the tag on its own line still
   refuses at the flow rule.
2. The file header's broken wrap at "Other unannotated results" is fixed.
3. `export { f as g }` with an untyped parameter is pinned: refused by the export join.

Measured: typecheck and gates; P and D1 tests 76/76.

## Slice ladder after P (measured 2026-11-16)

Replaces the order of slices S, D2, D3, C, B and F in the table above. Source:
a complete census of the prelude on slice P's branch (`23d4da567e`: V, G, D1
and P together), which lists every refusal in the three prelude files, not
only the first (session scratch `irgap/f-design.md`).

**Prelude gaps by mechanism** (sites in `test262-fyi-runtime.js`, `assert.js`
and `sta.js`):

| mechanism | sites |
| --- | ---: |
| strings into the dynamic value (concatenation, literals, compares) | about 40 |
| built-in globals (`globalThis` 22, `String()` 7, `JSON`, `console`, `Object.prototype.toString.call`, `Array.prototype.map.call`, error constructors, `eval`) | 39 |
| a function declaration read as a value (`assert`, `compareArray`, `Test262Error`) | 23 |
| throw and catch with a dynamic value | 17 |
| an unannotated function expression as a value | 16 |
| dynamic member read / write | about 16 / 3 |
| property write / read-and-call on a function object | 10 / 9 |
| `new` on a plain function / `this` / `instanceof` | 10 / 4 / 2 |
| call through a dynamic value or local | 10 |
| `typeof` / ToBoolean / `=== null` | 9 / 8 / 2 |
| object literal | 4 |
| dynamic home for a script `var` | 2 |

A passing `assert.sameValue(1, 1)` runs only `sameValue` and `_isSameValue`,
but module-init runs every top-level statement and the whole prelude must
compile.

**Slices**, each a whole mechanism, proved by a smallest program through the
strict Prepared entry that validates and runs:

| slice | content | depends on | proving program |
| --- | --- | --- | --- |
| H | A dynamic home for every script `var` without a proven typed home: an `externref` global, `undefined` stored by the module-init prologue, the D1 carrier for globals; also the resolver's value-kind arm that refuses `var x = {…}` and array literals before the home is asked. | D1 | `var x; x = 1; if (x !== 1) throw 1;` |
| T | ToBoolean, the `=== null` tag test, `typeof` over the admitted values (its string result needs Str). | D1 | `function f(v){ return !v; } if (f(0) !== true \|\| f(1) !== false) throw 1;` |
| X | Throw and catch with a dynamic value; the catch binding is dynamic; rethrow. | D1 | `function g(v){ try { throw v; } catch (e) { return e; } } if (g(1) !== 1) throw 1;` |
| Str | Strings in the dynamic value: box a native string, the string arm of strict equality, dynamic `+` and `+=`, `String(x)`, `typeof` results, the string policies of the presentation. | D1 | `function f(a,b){ return a + b; } if (f("a", 1) !== "a1") throw 1;` |
| Fa | Function values, creation and storage: unannotated closures with P's all-dynamic signature, a declaration as a value, the closure into a dynamic slot, presentation of the closure setup. | H | `var print = function (v) { return v; }; if (print(1) !== 1) throw 1;` |
| O | Objects as dynamic values: an object literal as a native ordinary object, dynamic member get and set, TypeError on `undefined` / `null`. | H | `var o = { a: 1 }; o.b = 2; if (o.a + o.b !== 3) throw 1;` |
| Fb | Dynamic call: a call through a value onto the existing closure-call intrinsics, a native IsCallable and its TypeError; a direct typed call when the callee is static. | Fa | `function t(fn){ return fn(2); } if (t(function (x) { return x * 2; }) !== 4) throw 1;` |
| C | Function objects: properties, `prototype` / `name` / `length`, `this`, `new F()`, `instanceof`, `.constructor`. | Fa, Fb, O | `sta.js` `Test262Error`; `assert.x = function(){return 1}; assert.x() === 1` |
| B | The built-in globals the prelude names. | Str, O | `assert.js` `formatIdentityFreeValue` |
| M | The real prelude plus `assert.sameValue(1, 1);` passes in the real runner. | all | |

H, T, X and Str need only D1 and run in parallel. Fa and O follow H and run in
parallel. Fb follows Fa; C follows Fa, Fb and O; B's parts follow their value
kinds.

**Function values on this path** (decided): a function value is the existing
closure struct (funcref, arity, property bag), typed `closure<sig>` while the
callee is statically known and the D1 `externref` once it reaches a dynamic
slot. A static callee is called directly; any other call goes through one
legalization arm onto the existing `js.closure.call:N` / apply-vector
intrinsics, whose dispatch body legacy already shares. `this` reads the
`currentThis` global that dispatcher sets; properties live in a native
ordinary object held in the bag; `new` is create-with-prototype plus a call.
Each is an intrinsic with a native provider: no host import and no second
representation.

**Why H is first** (simulated on the 404 positive rows of the sample):

- Making `print` alone presentable moves its 351 rows only to the next global
  (`$262`).
- With a dynamic home wherever V refuses, no row stops at `print`, `$262`,
  `__isArray` or `__globalObject`: 255 stop at ToBoolean in `isPrimitive`
  (slice T), 118 at object or array literals the resolver refuses before the
  home is asked (H's second arm), 23 at a `propertyHelper.js` direct call.
- The simulation stops before the physical plan, so H's global carrier and
  the module-init store of `undefined` are unmeasured.

**Behind the prelude** (stand-in harness with dynamic parameters, 404 positive
rows): 10 pass, 379 compile errors, 14 crashes. First gaps: 256 dynamic
script-var home (object literal 78, `Array.isArray` read 46, call result 32,
no initialiser 23, string 19, array 18), about 43 built-in globals and
constructors, 28 calls through a value, about 53 others. The mechanisms that
finish the prelude are about 85 % of the first per-test work.

**Found on the way, to be filed as their own issues:** an object literal
inside a function throws an emission invariant error on this path, and 13
rows with `eval` throw "certified global eval lost an owning predicate".

### Prepared gap: the `arguments` object (28 files, census 2026-11-19)

Belongs with slice C. Owner: the slice-C lane (S11), after C1. No separate
issue.

**What refuses.** The Prepared path has no `arguments` object. Only
`arguments.length` is built, as the entry-time count (#7106 S1e).

- `arguments` in any other position: `lowerExprUnchecked`,
  `src/ir/from-ast.ts`, identifier arm, refuses
  `ir/from-ast: identifier "arguments" is not in scope in <function>`
  (`body-shape-rejected`).
- `arguments.length`: admitted by `lowerPropertyAccess` (`from-ast.ts`), then
  refused by `legalizeDynamicValues`
  (`src/ir/program/dynamic-value-legalization.ts`):
  `dynamic operation dyn.arguments_length has no Prepared intrinsic`.
- A direct call with more arguments than formals:
  `ir/from-ast: call to f has 2 args, expected 0` (`call-arity-unsupported`,
  `lowerCall`, `from-ast.ts`); the extra arguments are what `arguments[i]`
  reads.

Already there: the closure-call path publishes the count and the extra
arguments (`__argc`, `__extras_argv`; `buildClosureMethodArgumentState`,
`src/runtime/wasmgc/values/closure-invocation-bodies.ts`), and an under-arity
direct call publishes `__argc` when the callee reads `arguments`
(`planUnderArityDirectCall`, `directCallPublishesArgc`).

**Measured** on main `ee3fcdd610`, 2026-11-19, stand-in harness, first gap per
file (`plan/log/es5-ir-only-census-2026-11-19.md`, section 1.2 row 28; list
`plan/log/es5-ir-only-census-2026-11-19-lists/arguments-object.tsv`):

- **28 files** stop first at `identifier "arguments" is not in scope`:
  `language/arguments-object` 18, `language/expressions` 6 (`call` 2, the four
  update operators 1 each), `language/statements/function` 3,
  `built-ins/Object/getPrototypeOf` 1.
- By the first use in the refusing function:

  | first use | files |
  | --- | ---: |
  | index write `arguments[i] = v` (4 of them then `++` / `--` on the element) | 8 |
  | index read `arguments[i]` (2 then write a property of the element, 1 then `delete arguments[1]`) | 5 |
  | `arguments` as a value (`return arguments`) | 5 |
  | `arguments.callee` (read 2, `.callee.caller` 2, write 1) | 5 |
  | another member: `.hasOwnProperty("callee" / "length")` 2, `.constructor.prototype` 1, `.length = v` 1 | 4 |
  | a script `var arguments` read inside a function | 1 |

- Samples:

  | file | function | first use |
  | --- | --- | --- |
  | `language/arguments-object/10.6-10-c-ii-1.js` | `foo` | `arguments[0] === 1 && arguments[1] === 'str'` (mapped to the formals) |
  | `language/arguments-object/10.5-7-b-2-s.js` | `_10_5_7_b_2_fun` | `arguments[7] = 12` (an index past the supplied arguments) |
  | `language/arguments-object/S10.6_A1.js` | `f1` | `return arguments` |
  | `language/arguments-object/S10.6_A4.js` | `f1` | `return arguments.callee` |
  | `language/arguments-object/S10.6_A3_T1.js` | `f1` | `arguments.hasOwnProperty("callee")` |
  | `language/expressions/call/S11.2.4_A1.1_T2.js` | `f_arg` | `return arguments`, then `f_arg().length`, `f_arg()[0]` |
  | `language/expressions/postfix-increment/11.3.1-2-3.js` | `testcase` | `arguments[1] = 7; arguments[1]++` |
  | `language/statements/function/S13_A15_T5.js` | `__func` | `var arguments = THE_ANSWER;` at script level, `return arguments` in the function |

- **The same mechanism in the "other" list** (`other.tsv`, not in the 28):
  `dyn.arguments_length` 9 files (`language/arguments-object` 3,
  `language/statements/function` 4, `language/types/list` 2) and an over-arity
  direct call 2 (`language/expressions/call/S11.2.4_A1.4_T1.js`, `_T2.js`).
- **Behind another first gap:** 327 of the 8,717 positive files name
  `arguments` in their own code (comments and strings removed). Largest
  groups: built-in call or method 90, script `var` from an IIFE result 39, call
  through a value 36, object literal 34, function expression as a value 29;
  the 19 `built-ins/Object/defineProperties` files of the no-initialiser list
  are `var arg; (function fun() { arg = arguments; }());`. 2 pass.
- Probes through the strict Prepared entry (same tree):
  `function f() { return arguments[0]; }`, `typeof arguments` and
  `var a = arguments` refuse with the identifier message;
  `function f() { return arguments.length; }` with `dyn.arguments_length`;
  `function f() { return 1; } f(1, 2)` with the arity message.

**Done when:** each sample compiles through the strict Prepared entry,
validates and runs with node's answer (as reduced programs while the files
need other slices); the 28 files and the 11 of the "other" list, re-measured
with `scripts/ir-census/prepared-census.mts --harness stand-in`, move past
these gaps; no file of the census moves to an earlier gap; one `arguments`
representation serves the direct-call and the closure-call path (no second
count / extras protocol, no arm specific to the Prepared path).

## H result

Status 2026-11-17. Branch `claude/7354-h` on `claude/7354-p` (merged up to `1995dd6ef2`).

### Built

- **The dynamic home.** `irOwnedScriptVarHome` (`src/ir/module-binding-script-var-home.ts`) answers `dynamic`
  for every script `var` V cannot prove typed, when the lane has the carrier (wasmgc standalone); the typed
  home is kept where proven. Still no home: a repeated `var`, a program of several sources, the non-writable
  global names, the gc target. A JS property declaration on the binding (`Object.defineProperty(obj, …)`,
  `o.p = v`) is no longer taken for a second declaration (the resolver's own `isJsPropertyDeclarationTarget`,
  now exported): that, not a value-kind arm, was the "not-direct" of `var obj = {}` (53 sample rows). The
  resolver's value-kind arm needed no change: given the home, `var o = {…}` already reaches the initializer.
- **Globals arm of the D1 pass.** `legalizeDynamicGlobals` (`src/ir/program/dynamic-value-legalization.ts`)
  types each dynamic global as the `externref` carrier and prepends to its storage owner (the script's
  module-init) `js.value.undefined` + `global.set` for each such global. Physical plan: a source global may be
  `externref` (it is always this carrier); consumer default initializer `ref.null extern` (never read: the
  module-init store runs first). Chosen over "null is undefined" because `__extern_is_undefined` and strict
  equality test the `$AnyValue` undefined singleton, which null is not. Presentation: a global contract and an
  internal callable slot may be the carrier (one `dynamic` predicate beside `carried`).
- **Provenance** (`src/ir/source-dynamic-provenance.ts`, new). The checker types `var z = 3` as number even
  when it holds `undefined`, and so every value read from such a home and passed on (a local, a returned value,
  a call result, another var, `?:`/`,`/`=`, `||`/`&&`/`??`/`+`). One per-program analysis answers "may this
  value be the dynamic value": memoised, a cycle counts as dynamic, a binding's own read in its own stores
  (`x = x + 1`) does not. Every checker-typed decision asks it: the typed home needs every store typed; an
  unannotated result is dynamic when a returned value may be (P's rule, extended); D1's implicit-flow rule now
  checks `carries` instead of checker `any`, at the outermost value-passing expression, and a store into a
  binding that itself carries is no flow. Without this the brief's `function f() { return z; }` was an
  invariant exception (`return[0] type externref not assignable to declared result f64`).
- **One contracts object.** `programDynamicContracts(checker, policy, sourceFiles)`
  (`src/ir/source-dynamic-contracts.ts`) returns `scriptVarHome`, `carries`, `parameter`, `result`,
  `resolver`, `legalize`; program-source asks only it (it shrinks by 6 lines). `sourceDynamicParameter`,
  `sourceDynamicResult`, `sourceDynamicResolver` and `legalizeSourceDynamicValues` are module-private now.

### For slices O and Fa

A new value kind needs no home work: the home is already `dynamic` and the store is lowered by from-ast into
the carrier. Plug in at the store: from-ast's box of the new kind to `dynamic` plus a legalization arm for it
(`box of a non-primitive value` today), and add the kind's producers to `carries` if their checker type is
not `any` (a call of a function value, a member read). Hand-over messages measured:
`var o = {a: 1}` → `proven dynamic binding 'o' initializer has no supported carrier`; `var arr = [1]` →
`resolver cannot register vec for array literal`; `var s = "x"` → `dynamic operation box of a non-primitive
value has no Prepared intrinsic`; `var f = function () {}` → `module-level closure binding 'f' not in
module-init Slice 2 scope`; `var g = Math.max` → `identifier "Math" is not in scope`;
`function id(v){…} var g = id` → `identifier "id" is not in scope`.

### Measured

- `tests/issue-7354-h-script-var-dynamic-home.test.ts`, 40 tests: 20 programs run twice (node's answer
  returns, a wrong one throws) — the brief's programs, a var holding number→boolean→undefined, reads in and
  writes from functions both ways, typed beside dynamic, `var x = 1, y = x`, call results, locals, the store
  forms, a store cycle, a for-head var; refusals by name for each case above, the gc target, two scripts, typed
  flows (`Math.abs`, a typed local, TypeScript annotated result/parameter), `+`, ToBoolean, `export var`; an
  ES module var stays typed; unit tests of the globals arm. R census: 4 tests (the `undefined` provider dropped
  or renamed, `__js_undefined` renamed → refused).
- Sweep: 3 declaration forms (no initializer, hoisted read, written by a function) × 9 values (±0, 1, NaN,
  ±Infinity, true, false, undefined) × 12 operations × 5 positions = 1,620 programs against node: 908 correct
  (each also throws on a wrong answer), 712 named gaps (254 the parameterless-function slot join P recorded,
  162 ToBoolean, 135 `typeof`, 135 dynamic `+`, 26 TypeScript diagnostics), 0 wrong, 0 invariant errors,
  0 invalid Wasm. A rerun of 1,086 rows gave identical verdicts.
- Mutation check: 38 mutants; 27 killed by H's tests, `x = x + 1`'s self exception by VG/D1. Removed as
  implied (each survived): the dynamic home's top-level restriction (the producer makes globals only for
  top-level statements), the flow rule's initializer arm, the conditional-test exclusion, the join's
  `exported` test. Survivors kept, with reason: lexical exclusion in provenance (a let the proof rejects is
  read under a TDZ check, which refuses); pending values of locals and results (a local's first store fixes its
  IR type; recursive results are checker `any`); non-value and unknown stores (for-in/of, patterns, `with`,
  `eval` refuse elsewhere); returns of nested functions (nested closures refuse).
- Ordinary-pipeline bytes, the 419-path sample list against the base tree: 396 files byte-identical on the JS
  environment and `--target standalone`, 8 compile errors on both, 15 skipped. Prepared bytes, every program
  literal of `test262-prepared-entry`, `-runtime`, #7188 and R tests (42, as .js and .ts): identical except the
  new H census program (refused on the base).
- Existing tests: prepared-entry, prepared-runtime, #7188, R, D1, V/G, P and H: 265/265 (before the last
  property-declaration commit; H and V/G re-run after it: 85/85). `issue-3518*`/`3526*` not run: H adds no
  intrinsic, provider or resource.
- Gates: typecheck, loc (no grant: program-source −6, presentation ±0, consumer ±0, physical plan +1 at its
  ceiling), func, coercion-sites, oracle-ratchet, dead-exports, import-cycles, boundaries inventory (new module
  classified).
- Real runner, 411-row sample: negatives unchanged (14 pass). First gap over the 397 failing rows:
  332 `dyn.truthy` (ToBoolean, slice T — the message names no function; the simulation put it in
  `isPrimitive`), 47 `direct call to "String"` in `verifyProperty` (propertyHelper.js), 12 `not-direct` (all
  repeated `var`s: `x` 5, `y` 2, `result`, `fin`, `__result`, `object`, and `var Infinity`), 1 `print` direct
  call in `__consolePrintHandle__`, 1 `unknown class "Test262Error"` in `isConstructor`, 2 switch-case
  lexical binding, 1 `DD_operator` callable annotation, 1 TypeScript parse error. No row stops at `print`,
  `$262`, `__isArray` or `__globalObject` storage. More reach ToBoolean than simulated (332 vs 255): the
  object-literal rows (`obj` & co.) also run the prelude first and stop there.

### Pins updated

- `issue-7354-vg-script-var-home.test.ts`: the refusals that H now runs moved to H's file; the TypeScript
  hoisted read now refuses at the flow rule.
- `issue-7354-p-parameter-contracts.test.ts`: `var g = id` now refuses at the declaration read (Fa).

### Known gaps

- The brief's `var a = 1; var b = a; b = undefined;` is a TypeScript error (`Type 'undefined' is not
  assignable to type 'number'`) that the strict entry refuses before H; tested as `var b; b = a; …`.
- Repeated `var` and multi-source programs: no home (startup plan / per-script module-init).
- A parameterless function returning a dynamic comparison hits P's slot-join gap.

### Review round 1 (H)

Adversarial review of `f510ec7691` against `1995dd6ef2`: NOT MET. First P's review fixes and D1's rework were
merged in (`14ffa8c311`; the legalization trigger is D1's native contract, which a script var's dynamic home now
also is, so `legalize` takes the signatures and the globals). Then:

1. **Must-fix: fail-open provenance.** It answered "typed" for every kind it did not model, and read a local's
   stores through `scriptVarWrites`, which drops block-scoped initializers: `function k() { const a = x; return
   a; }` kept an f64 result over a carrier body and `compile()` threw an invariant error. Now every expression
   and binding kind not modelled may be dynamic. Modelled, each with a test a wrong answer fails: checker `any`,
   script vars (through the classifier, which now answers only for script vars), locals, annotated parameters,
   calls of source functions, `?:`, `,`, `=`, `||`/`&&`/`??` (and assignments), `+`/`+=`, the other binary
   operators, number and Boolean literals, prefix operators, a binding's own read in its stores. Kinds no program
   on this path reaches typed (members, ambient callees, strings, objects, closures, postfix values, catch and
   ambient bindings) were tried as modelled kinds, survived mutation, and fall to the default instead. The five
   repros run and match node.
2. **One authority for a local** (from-ast): it types a local from the value it is created with and refuses a
   later store of another type, so the provenance answers from that first value (`undefined` without an
   initializer); stated in the code.
3. **One return walker**: `someReturnedValue` (`src/ir/function-returns.ts`), used by `irFunctionBodyReturnsValue`
   (select.ts shrinks by 10) and the result contract.
4. The presentation calls `nativeDynamicLane` (exported) instead of repeating the target check.
5. The physical plan admits a null default only when `storesUndefinedFirst` finds the owner's entry block opening
   with the `undefined` store into that global (dated +2 loc grant for program-physical-plan.ts).
6. A TypeScript annotation other than `any` keeps the typed home (or none). `var g: number = 0; function s(v:
   any) { g = v; }` now refuses as on the base, at the binding ("module binding g has no exact typed storage:
   unsupported", the resolver's retype arm), not at the `0`.
7. **Not fixed, recorded for slice O:** `var o = 1; Object.defineProperty(o, 'p', {});` throws
   `IrProgramDriverInvariantError` from `unadmittedObjectDefineProperty` (`src/ir/from-ast.ts`, ~9210): from-ast
   treats an unadmitted define as selector drift, and the Prepared path has no selector. Turning it into a
   refusal there would weaken the ordinary pipeline's drift check; the Prepared producer needs its own admission
   for `Object` statics (slice O). It was reachable before H with a literal target.

Measured after the fixes (`d635f3be69`):

- Tests: H 63, and V/G, P, D1, R, prepared entry/runtime, #7188: 235, all pass.
- Mutation sweep over the changed analysis (31 mutants): all killed except fail-closed defaults (the pending
  answers of locals and results, `?? true` without a write list, non-value stores, and the fall-through kinds).
- Sweep, now with a `const` local position: 1,944 programs, 1,014 correct, 930 named gaps (381 P's
  parameterless slot join, 189 ToBoolean, 162 `typeof`, 162 dynamic `+`, 36 TypeScript diagnostics), 0 wrong,
  0 invariant errors.
- Ordinary-pipeline bytes against `f9385ba314` (P), 180 sample files: identical on both targets, all compiled.
- 411-row sample: negatives 14 pass; 333 ToBoolean, 47 `String` direct call in `verifyProperty`, 12 repeated-var
  `not-direct`, 2 switch-case binding, 1 `print` call, 1 `Test262Error`, 1 parse error.
- Gates (also with the base at P): typecheck, loc, func, coercion-sites, oracle-ratchet, dead-exports,
  import-cycles, boundaries inventory. `changed-root-tests.sh`: `issue-3518-core-vocabulary-seam` red (main,
  PR #7278); `issue-3518-semantic-verification-ownership` and `issue-3526-string-boundary-const` fail exactly as
  on D1's tip; the others pass.

### Review round 2 (H)

Review of `52ca249b28`: NOT MET on one must-fix. D1 `d87fe37e23` (main's #7357 red-pin fixes) was merged into P
(`53f7b492c2`) and P into H first; then:

1. **Must-fix: `var o = 1; Object.defineProperty(o, 'p', {})` threw** from-ast's drift invariant out of
   `compile()`. The classifier now exempts only a member write (`o.p = v`, `o[k] = v`, `isMemberWriteDeclaration`,
   moved to `src/shared/binding-writes.ts` and shared with the resolver's predicate, whose answers are unchanged)
   and still counts the `Object.defineProperty` call as a second declaration: the binding has no home and the
   program refuses as "not-direct". Tested, with the member-write form keeping its home. **Cost, handed to slice
   O:** the `var obj = {}; Object.defineProperty(obj, …)` rows of the sample stop at "not-direct" again (52 `obj`,
   plus `proto`, `o`, `arr`, … — 84 rows in all) until O admits `Object` statics on this path; O then drops the
   call form from the declaration count. Known pre-existing crash for O, not fixed here: the literal form
   `Object.defineProperty(1, 'p', {})` throws the same invariant on the base.
2. **`storesUndefinedFirst` deleted.** It accepted the store in any function, and no test could reach an
   `externref` source global without the globals arm's prologue: the arm is that global's only producer and
   prepends the store in the storage owner itself (unit test). The physical plan states this.
3. **Annotated var.** Claim and behaviour now agree: an annotation other than `any` gives the typed home or none,
   and an `any` store into it is refused by the resolver's retype rule naming the binding ("unsupported"). H's own
   tests pin both refusals, killing the `storesDynamic && !annotated` mutant.
4. **Fail-open survivors, rebutted.** The code answers "may be dynamic" in all three; only the mutants that answer
   "typed" survive, because no program on this path observes them: a non-variable binding read as a value (a
   function, a class, a binding element) and a call of anything but a source function (a member, an ambient or
   a value callee) are refused by from-ast before their type matters, and a pending local needs an initializer
   that reaches the local itself (a closure or a TDZ read). The self-read exception is now killed by H's own file
   (`var y = 1; y = y + 1`).

Measured: H 66 and V/G, P, D1, R, prepared entry/runtime, #7188 tests 303/303; typecheck and gates;
`changed-root-tests.sh` green; sweep 1,944 programs, 1,014 correct, 0 wrong, 0 invariant errors; ordinary bytes
on 100 further sample files identical on both targets (92 compiled, 8 compile errors on both).

### Review round 3: MET

Review of `36c1b42ac9`: MET, no must-fix; the three survivors and the deletion accepted. Then `origin/main`
(`e48947ccb8`, with D1 #7277 and P #7283) was merged in. Final 411-row sample: negatives 14 pass; 282 ToBoolean,
84 "not-direct" (the `Object.defineProperty` bindings above and the repeated vars), 26 `String` direct call in
`verifyProperty`, 2 switch-case binding, 1 `Test262Error`, 1 parse error, 1 `print` call.

### Known gaps (H)

- **The physical plan admits any `externref` source global.** After the legalization a dynamic global's type is a
  plain `externref`; neither the ABI contract nor its intent keeps a dynamic marker, so keying the admission on
  it needs new plumbing. Today the globals arm is the only producer (it stores `undefined` first). The slice that
  adds another reference-typed source global must carry a marker (or its own default) and narrow this arm.
- `Object.defineProperty` on a script var: no home until slice O (above).
- Repeated `var` and multi-source programs: no home.
- **Hand-over for a later "hoisted var" slice:** a function-local `var` repeated anywhere in its function refuses
  ("redeclaration of 'x'"); one slot per `var` name per function, declared at the entry, would admit it (15 of
  the 411 sample files contain a repeated `var`). See "Follow-up: hoisted `var` declaration without initializer".

### Follow-up: hoisted `var` declaration without initializer

A review after H found a wrong answer: `var x;` without initializer inside a loop body was reset to `undefined` on
every iteration (`function f(v){ var r = 0; for (…) { var x; if (i === 0) x = v; else r = x * 1; } return r; }`
answered `undefined`, node 5).

- **Cause.** `lowerUninitializedVar` (`src/ir/from-ast.ts`) wrote the slot's `undefined` at the declaration
  statement. In JavaScript the declaration is hoisted and a `var x;` without initializer is no write, so a loop
  that runs it again must keep the value. The ordinary pipeline never lowers such a declaration in a loop: its
  selector (`uninitializedVarIsDynamicUndefined`, `src/ir/select.ts`) claims `var x;` only outside loops. The
  Prepared path has no selector and reached it.
- **Where it exists.** On `origin/main` (`f1903049a7`) already, for a loop `var x;` whose read flows into a
  dynamic result (a typed first store `x = 5`, a boolean, a TypeScript `any` function): node returns, ours threw.
  H widened the reach (a dynamic `return r`, `x * 1`, script loops in the module-init): 14 of the 30 family probes
  were wrong on H, 3 on main.
- **Fix.** The slot of a `var x;` in a loop of its own function (or script) takes its `undefined` once, before
  the loop: `IrFunctionBuilder.emitAtBlockHead` (`src/ir/builder.ts`) prepends to the open block. A loop under
  construction collects its body in a buffer and becomes one instruction of that block (no block is terminated
  inside a buffer), so the head of the open block runs once, before the loop, and dominates every read (a read
  after the loop is out of scope). Outside a loop the declaration runs once, before every read (a read before it is out of scope and refuses
  by name), so it keeps its place — that is the arm the ordinary pipeline reaches, so its bytes do not change. The
  loop test is one shared helper, `isInLoopOfOwnFunction` (`src/shared/var-declaration-lists.ts`), which the
  selector's inline walk now calls. The builder's three slot lookups became one `slotDef` (room for the new
  method within the size budget).
- **Measured.** Family probes (for / while / do bodies, nested loops, `switch` / `try` / `try…catch` / labelled
  block in a loop, labelled `continue`, a typed and a boolean first store, a read in the first iteration, a loop
  after an early return, script `for` / `while` loops, TypeScript): all equal node. Named refusals: a read after
  the declaring loop or before the declaration (`identifier "x" is not in scope`), a re-declaration after an
  assignment (`redeclaration of 'x'`, script: `has no exact typed storage: not-direct`), a script loop var read by
  a function (not a module binding: `identifier "g" is not in scope in h`), closures (`must have a return type
  annotation`). Ordinary bytes identical on 100 test262 files (loops with `var` declarations, `&&` / `||`) × default
  and `--target standalone` plus six direct programs (instrumented: the non-loop arm is reached, the loop arm
  never); Prepared bytes identical on 15 unaffected programs × both targets. Mutations: the loop guard (15 tests
  fail), the selector's loop guard (`issue-7106-uninitialized-var` fails). Expected survivors, reasoned and not
  run: prepending vs appending to the open block, and the helper's stop at a nested function — both equivalent on
  the Prepared path (any place before the loop is right); the second would only change what the ordinary selector
  claims. A first version prepended to block 0 (the function entry); writing into the open block instead survived
  every test, including a loop after an early return (block 0 already finished), so the simpler form was kept.
- Tests: `tests/issue-7354-h2-hoisted-var-declaration.test.ts`.

#### Review round 1

NOT MET on one must-fix, fixed here.

- **Must-fix: a repeated `var x;` in another block opened a second slot** that started at `undefined` (also wrong
  on main): `if (v === 5) { var x; x = v; } var x; return x * 1` and the same with two loops, a loop and a
  declaration after it, both arms of an `if` in a loop, and two script loops. from-ast binds a `var` in its own
  block, so only a repeat in an enclosing scope met the "redeclaration" check. **Fix:** every `var` whose name has
  another binding in its function or script (a second `var` at any block depth, a parameter, a function, class,
  catch or lexical declaration) refuses as "redeclaration of 'x'". The count is the selector's own binding count
  (`collectBindings` in `src/ir/function-local-var.ts`, now shared by `collectIrSafeVarDeclarationLists` and the new
  `isRepeatedVarBinding`); a script var with a module home is exempt (its repeat is the same global,
  `isRedeclaredModuleVar`; deleting the exemption fails the #7106 lever L tests). One slot per name (hoisting
  every `var` to the entry) was not chosen: the typed, SSA, i32-promoted and captured `var` arms would each need
  it, which is more than this fix should carry. The ordinary pipeline never lowers a repeated `var` (its selector
  claims only lists with a binding count of 1), so its bytes do not change.
- **Cost:** `for (var i = 0; …) {} for (var i = 0; …) {}` in a function compiled correctly before (each head
  initializes its slot) and now refuses. The prelude has no repeated `var` (0 found by the same predicate), and every
  positive row of the 411-row sample stops in the prelude today, so no row's first gap moves; 15 of the sample's
  test files contain a repeated `var` and will stop there once they get past the prelude.
- **Family** (each a named refusal, `redeclaration of '<name>'`, tested): repeats across sibling and nested
  blocks, loop then after the loop, two loops, both `if`/`else` arms in a loop, `try`/`catch`/`finally`, a repeat
  with an initializer in a block, a repeat of a parameter, two `for (var i …)` heads, two script loops. Refused
  earlier by other named gaps: blocks as non-tail statements, a `switch` on a dynamic value, a function
  declaration beside a `var` of its name (TypeScript's "Duplicate identifier"). Single declarations unchanged.
- **Mutation sweep follow-ups:** the loop guard (store before the loop only in a loop) has no observable effect on
  the Prepared path — outside a loop both places are right; it keeps the ordinary pipeline's in-place code (and
  bytes), stated in `lowerUninitializedVar`'s comment. The helper's stop at a nested function is what makes its
  answer correct (a nested function's `var` runs once per call); removing it is unobservable on the Prepared path
  (the inner function's own block head is also before the loop) and only makes the ordinary selector more
  conservative — no test kills it. `push` vs `unshift` is equivalent. The selector's loop exclusion is killed by
  `tests/issue-7106-uninitialized-var.test.ts`.
- Proofs re-run: ordinary bytes identical on the 100 files × 2 targets and on the 18 repeated-`var` programs;
  Prepared bytes identical on the 15 unaffected programs; gates (also with the base at main); H, V/G, P, D1, R,
  prepared entry/runtime, #7188, #7106 uninitialized/lever L/L2, #3765 pass.

#### Review round 2: MET

No wrong answer, no invariant error. Two tests added for surviving mutants: a repeated script `var` with a module
home is claimed and runs on the ordinary pipeline (deleting the module-binding exemption fails it), and two
sibling-block `let x` bindings still compile and run (deleting the "`var` lists only" guard fails it). Accepted
equivalent mutants: not counting parameters (`cx.scope.has` refuses a repeated parameter first), the loop guard
and the nested-function stop (both above), `push` vs `unshift`.

**Follow-up, not built here:** the refusal costs reach — two `for (var i = 0; …)` heads in one function were
correct before and now refuse. The reviewer's untested narrowing: refuse a repeat only when one of its
declarations has no initializer, or is a `for-in` / `for-of` head or a pattern. The complete answer is one slot
per `var` name per function (see Known gaps (H)).

### Follow-up: unused `&&` / `||` keeps its right operand

The slice-T review found a wrong answer that predates T: a `&&` / `||` whose value is unused dropped its right
operand (`a > 0 && boom(b);` never called `boom`; node throws, ours returned). Root cause and fix are their own
issue, **#7359** (`plan/issues/7359-dce-keeps-effectful-value-if.md`), because the ordinary pipeline had the same
wrong answer in plain TypeScript on both targets.

- **Cause.** A logical expression lowers to a value `if` (`lowerLogicalAndOr`, `src/ir/from-ast.ts`), the only
  buffer-bearing IR kind missing from `isSideEffecting`, so DCE and the lowerer judged it by its kind alone and
  dropped it, call and all, when its result was unused. `?:` in statement position was correct because
  `lowerDiscardedExpression` lowers it to an `if.stmt`; an unread `const r = c ? f() : 0` was wrong too.
- **Fix.** One rule in `isSideEffecting` (`src/ir/analysis/effects.ts`): an instruction that runs nested buffers is
  as side-effecting as what it runs. The statement-level control kinds stay always-kept; an `if` with pure arms is
  still dropped.
- **Siblings checked.** `?:` statement (`if.stmt`, correct before), unread `?:` local (wrong before, fixed), comma
  (its left operand is lowered as a discarded expression, correct), loops / `try` / `switch` / labelled blocks
  (always kept), optional call `c?.m();` (correct before and after, ordinary). `x ?? f()` with
  `x: number | undefined` is wrong on the ordinary pipeline in value position too (`return x ?? inc()` gives NaN,
  node 7): the legacy path stores `number | undefined` as f64 — a different defect, reported, not touched here.
- **Measured.** Prepared: `tests/issue-7354-h3-unused-logical-operand.test.ts`, 9 forms × 6 positions × (counter,
  throw), 108 tests, 74 fail on main. Ordinary sweep (generated, 429 programs × default and standalone): 0 wrong
  after, the same Prepared rows run or refuse by name (`no exact typed storage`, `__ir_dyn_add has no Prepared
  intrinsic`, `__new_ReferenceError` for a typed counter — so the Prepared counter is a local the right operand
  assigns). Ordinary bytes on 300 test262 files × 2 targets and the 13 playground examples × 2 targets: identical
  (the JS test262 shapes do not reach the IR value `if` with an unused result). Prepared bytes identical on the 22
  compiling rows of 14 unaffected programs × gc / standalone (the prepared-entry/runtime numeric programs, `&&` /
  `||` in value, return and condition position, a pure unused `&&` and `?:`, a `?:` statement, h2 loops); they
  change for the repro programs, where the unused effectful `if` is now kept. Equivalence files on logical /
  conditional / optional / DCE shapes (23 files): failing set equals `scripts/equivalence-baseline.json`.

## T and X result

Status 2026-11-17. Branch `claude/7354-tx` on `claude/7354-p` (`1995dd6ef2`): T `5310a38b13`, X `01fd76c26c`.

### Built

- **T, ToBoolean.** New intrinsic `js.value.to_boolean` (`(externref) -> i32`), added to every closed list the
  same way as `js.value.strict_eq` (vocabulary, `INTRINSIC_DEFINITIONS`, runtime features, provider ids,
  `dynamic-value-callables.ts` symbol `__is_truthy`, `nativeIntrinsicRows` role `to-boolean`,
  `native-dynamic-values.ts` row and fill). The legacy `__is_truthy` body moved unchanged into the pure builder in
  `src/runtime/wasmgc/values/primitive-layouts.ts` (`buildToBooleanBody`/`buildToBooleanLocals`); legacy
  `registry/imports.ts` calls it with its old arguments (149 lines shorter), the Prepared fill calls it with
  `$AnyValue` (so `undefined` is falsy), the number and Boolean boxes, and no BigInt or string arm (`-1`).
  Legalization arm: `dyn.truthy` → `js.value.to_boolean`.
- **T, `null`.** The representation is the ordinary standalone pipeline's: the carrier's null reference
  (`ref.null extern`); `undefined` stays the non-null `$AnyValue` singleton. So strict equality (its null arm),
  the `undefined` probe (false for null) and ToNumber (`__unbox_number`: null → 0) are exact with no change. The
  native lane's resolver now answers `dynamicCarrierIsExternref: () => true` (`sourceDynamicResolver`), which
  turns on from-ast's existing dynamic `null` literal (`box` tagged Null) and `=== null` (`tag.test` Null).
  Legalization arms: a Null-tagged box → `const null externref`; `tag.test` Null → `unary ref.is_null`.
- **T, consequence.** The same flag makes from-ast read the catch binding as the dynamic value. Its checker
  type is `unknown` (strict), so the D1 flow rule (`refuseImplicitDynamicFlows`) now treats `unknown` like
  `any`: `catch (e) { return e as number; }` refuses by name ("flows into number … (AsExpression)") instead of
  reaching a middle-end invariant ("early.return value type externref not assignable to declared result f64").
- **X.** `coerce.to_externref` of a dynamic value whose result a `throw` consumes (found by a deep walk of the
  function, nested buffers included) is kept: over the legalized `externref` operand it lowers to nothing. Any
  other coercion of a dynamic value still refuses. P's result rule counts `unknown` like `any`, so a function
  that returns its catch binding has a dynamic result.
- `&&`/`||` needed nothing: from-ast already yields the operand (`(0 || 5) === 5`, `(1 && true) === true`,
  `(undefined || undefined) === undefined` are tested).

Names other slices can rely on: intrinsic `js.value.to_boolean`, provider `native.js.value.to_boolean`, resource
`__is_truthy` (role `values/to-boolean`), builder `buildToBooleanBody`. `null` needs no new intrinsic: it is
`ref.null extern` in the carrier. **Str must pass the string type as `anyStringTypeIdx` in the
`native-dynamic-values.ts` ToBoolean fill** once strings enter the carrier, or `""` reads truthy.

Soundness of the dynamic catch binding: the payload is whatever was thrown. In an accepted Prepared program that
is a dynamic value, a boxed number (`numericThrow`) or `null`; strings refuse (`js.string.const is unavailable`),
a typed Boolean throw refuses ("throw val not in slice 9"), objects do not compile (see gaps). A slice that makes
a new value throwable must give the dynamic operations its arm.

### Measured

- Tests (round 1 counts): `tests/issue-7354-t-truthiness-null.test.ts` (34), `tests/issue-7354-x-dynamic-throw.test.ts` (48),
  each accepted program run with node's answer (returns) and a wrong one (throws). With D1, P, V/G, R: all pass.
- Sweeps against node, through the strict entry: T 1584 programs (`!v`, `!!v`, `?:`, `&&`, `||`, `=== null`,
  `!== null`, `null === v`, `=== undefined`, `if`, `if (!v)`, `while`, `for`, `do-while` × 11 values incl. NaN,
  ±0, ±Infinity, booleans, undefined, null × returned / local / condition / top level), 1584 correct, 0 gaps.
  X 231 programs (return the caught value, rethrow through nested try/catch/finally, two calls up, top level,
  ToBoolean / identity / undefined / null test of `e`, literal throws, finally runs, uncaught escape), 227
  correct, 4 named gaps (typed `throw true/false`). Zero invariant errors, zero invalid Wasm.
- Mutation check (14 mutations, each alone): 13 killed. Survivor: `internalizeOnce` on the Prepared fill (true and
  false are both correct; it only chooses whether the operand is internalized once or twice).
- Ordinary pipeline: 320 test262 files (the ES5 sample list) byte-identical on the default JS target and on
  `--target standalone` against the base, 312 compiled per target, 8 compile errors on both.
- Prepared bytes, 37 program literals of prepared-entry/runtime, #7188 and R tests × {entry.ts, test.js} ×
  {standalone, gc}: identical except one, R's base `catch (e) { return e as number; }`, now the named refusal
  above (R's test program changed to `catch (e: any) { return e * 1; }`, which the base refused).
- Changed root tests vs `origin/main` (the `quality` job's set): the same 10 failures on the base and with T/X
  (`core-vocabulary-seam` 4 × "complete source SHA256/length mismatch: src/ir/ast-lowering-plans.ts",
  `semantic-verification-ownership` `effectsOf` hash, `string-boundary-const` 5 host-lane import positions).
- Real runner, 411-row sample: negatives unchanged (14 pass, 1 compile error); first gap unchanged: 393 ×
  "not-direct" (`print`, `__isArray`, `__globalObject`), 2 switch-case, 1 callable annotation. T and X sit
  behind slice H's gap; the stepped-past tally was not run.
- Gates: typecheck, loc, func, coercion-sites, oracle-ratchet, dead-exports, import-cycles.

### Test pins updated

- `issue-3518-core-vocabulary-seam`: `INTRINSIC_IDS` 41 → 42 (two places).
- `issue-3518-semantic-verification-ownership`: `INTRINSIC_DEFINITIONS` successor pin a17fd837… → bc21ec2c…; the
  D1 predecessor step removes the three `js.value.*` rows (re-derives b763d963… unchanged); catalogue 41 → 42.
- `issue-7354-d1-dynamic-carrier`: ToBoolean, null tag test and thrown-value refusals removed (expressed now);
  `selectNativeDynamicValues` gains `toBoolean: false`.
- `issue-7354-p-parameter-contracts`: the ToBoolean refusal removed. `issue-7354-r-provider-census`: the census
  program also tests ToBoolean and its provider/resource drop/rename; `twoNatives` as above.

### Named gaps and not verified

- `typeof v` refuses "dynamic operation dyn.typeof has no Prepared intrinsic" (Str); `isPrimitive` stops there.
- `v == null` refuses in from-ast ("bare 'null' in non-reference context (f64)"); other loose equality refuses
  as `dyn.eq (loose)`.
- A boolean (i32) result passed to a dynamic parameter was refused in from-ast; fixed in review round 1 (the
  Boolean result contract below).
- Pre-existing on the base: `throw {}` throws `PreparedIrProgramInvariantError` out of `compile()` ("resolver
  cannot lower object<>"); pinned in the X test.
- No program in the sweeps, the tests or the review probes reaches a `coerce.to_externref` of a dynamic value
  that a `throw` does not consume (its other from-ast producers — string concatenation, function-object keys,
  host boundaries — refuse earlier on this lane). The rule is tested on hand-built IR only.

### Review round 1

Adversarial review at `bbab057818`: T MET, X MET, no must-fix. Should-fixes:

1. **Catch-binding payload assumption — fixed (pinned).** Every throw site that could reach a Prepared catch was
   listed: user `throw` (dynamic, boxed number, `null` admitted; string → `js.string.const is unavailable`;
   Boolean → "throw val not in slice 9"; object → emission invariant, pre-existing), from-ast TDZ
   `__new_ReferenceError` (refused: "needs runtime function materialization"), from-ast `__new_TypeError`
   (dynamic call and member read refuse earlier), runtime bodies (all construct a TypeError — an Error object,
   for which every dynamic operation the carrier has is exact: truthy, identity, not `undefined`/`null`,
   ToNumber NaN — except `vector-grow-store.ts`'s `ref.null extern`, unreachable: no vector compiles). Each is
   pinned in `tests/issue-7354-x-dynamic-throw.test.ts`; the invariant is stated at `sourceDynamicResolver`,
   where the binding becomes dynamic.
2. **Other paths of the carrier flag — fixed.** Each refuses today, with a test in the T file: a dynamic for-in
   head ("dynamic for-in runtime is unavailable"), a function-object property write (`identifier "g" is not in
   scope` — functions are not values yet), a primitive wrapper's ToPrimitive (`unknown class "Number"`), the
   `parseInt` externref boundary in `stringToNumber` ("direct call to "parseInt" has no exact AST-site plan").
3. **Stale strict-equality comment — fixed** (`null` is in the admitted set; the body's null arm).
4. **`buildToBooleanBody` style — fixed.** An absent arm is `undefined` (like `buildIsUndefinedBody`), no `as`
   casts; ordinary bytes identical on 50 files, then on all 320, both targets.
5. **`return e === 3` refused by the join — fixed.** Cause: not the catch binding. An unannotated result the
   checker types Boolean lowered (through the propagation shared with the ordinary pipeline) to a plain `i32`,
   and the presentation's source-declaration join requires the Boolean carrier; `function f(){ return 1 === 1; }`
   failed the same way on the base (P's named gap). `sourceDynamicResult` now answers the Boolean carrier for
   such a result on the native lane. Both programs run (right answer returns, wrong throws), and a Boolean
   result now also flows into a dynamic parameter (`same(f(0), true)`).
6. **Source test for the coercion rule — rebutted:** no source program reaches a non-throw use (above).
7. **Proofs the restart cut — done.** 3518/3526, all 316 files on HEAD `8a3583bf67` in 8-file chunks (3 slow
   files run alone; `native-invocation-consumer` and `native-mixed-object-access` exceed the 10-minute
   foreground cap and were not completed), the base (`1995dd6ef2`, swapped into the tree) on the 120 files that
   fail on HEAD: identical failing sets except `native-source-closure-consumer`, where both sides lose different
   35–40 s `STACK_TRACE_ERROR` timeouts under load. Note: `origin/claude/7354-p` moved during the session (P's
   review rounds), so the earlier base runs were redone against `1995dd6ef2`; with it,
   `native-string-number-source-admission` fails the same 3 tests on base and HEAD (fixed on P's newer head).
   `changed-root-tests.sh` stops at `core-vocabulary-seam`'s 4 pre-existing failures ("complete source
   SHA256/length mismatch: src/ir/ast-lowering-plans.ts", same on the base, fixed on D1's newer head); the other
   10 changed root files were run directly and fail only the base's tests.

Verdict MET; every should-fix fixed or rebutted.

### After the merge onto H (`36c1b42ac9`)

- Port onto `programDynamicContracts`: the `resolver` entry gains `dynamicCarrierIsExternref`; the Boolean result
  contract is `sourceBooleanResult`, asked by `result()` after the dynamic one (the provenance still asks only the
  dynamic one); the `unknown`-as-untyped rule is dropped: H's provenance already answers "may be dynamic" for a
  catch binding (a local without an initializer), which covers both the result contract and the flow rule. Two
  additions beside their siblings: the legalization also runs for roots that bind a catch (a program whose only
  dynamic value is a catch binding has no dynamic contract), and the flow rule's `passedOn` treats the operands of
  `||`/`&&` like a comma's result (T makes them yield an operand). H tests updated: `x || 0`, a returned catch
  binding and a returned `null` run now instead of refusing.
- Tests: T 34, X 48, H 66, P, D1, V/G, R, prepared entry/runtime, #7188 pass; `changed-root-tests.sh`: all 10
  files pass. Gates against the H tip pass. Ordinary bytes: 100 files × 2 targets identical to the H head. Sweeps:
  T 1584/1584, X 227 + 4 named gaps.
- 411-row sample: negatives 14 pass. First gap over 396 positives: 282 × "dynamic operation dyn.typeof has no
  Prepared intrinsic" (`isPrimitive`, `harness/assert.js:21`, the prelude's first `typeof`); 84 × "module binding X
  has no exact typed storage: not-direct" (`obj` 52, `x` 5, `proto` 4, `o` 4, `arr` 3, …); 27 × "direct call to
  "String" has no exact AST-site plan in verifyProperty"; 2 × switch-case lexical binding; 1 × "unknown class
  "Test262Error" in isConstructor".

### Review round 2 (delta after the port onto H)

**Must-fix: a Boolean (typed) left operand with a dynamic right operand in a VALUE position yielded a Boolean.**
`function f(b, c) { return (b > 1) && c; }` answered `f(5, 7) === true` (node: 7); the same for `||`, `!a || c`,
`!(a && b) || c`, `(b > 1) && (c || d)` and TypeScript `n > 1 && c` / `n > 1 || c` with `c: any`.

- **Cause** (the reviewer's reading, confirmed): `lowerLogicalAndOr` (`src/ir/from-ast.ts`) takes its `i32` path
  whenever the left operand is not dynamic and ToBooleans a dynamic right operand there even outside a condition.
  Before T that ToBoolean had no intrinsic and refused by name; T's `js.value.to_boolean` made the wrong path run.
  The `&&` case was wrong before the port; the `||` cases were reopened by the `passedOn` logical arm of the
  implicit-flow rule (which is right: an operand of `&&`/`||` is the expression's value).
- **Fix:** the position the lowering already knows decides. Only a boolean position (the `i32` hint: an `if` /
  loop condition, `?:` test, `!`, a Boolean result) ToBooleans the right operand. In a value position a dynamic
  right operand stays the value, the typed left operand is boxed into the carrier (`logicalOperandCarrier`, which
  the dynamic-left arm's right operand now shares), and the result selects one of them (`emitLogicalSelect`, moved
  to the new `src/ir/logical-select.ts` and shared by all three arms). Each operand is evaluated once, the right one
  only in its arm. A nested logical right operand gets the carrier hint in a value position, exactly like the left
  one (`operandHint`, one rule for both sides). A typed number operand still refuses by name ("requires bool
  operands"); the dynamic result flowing into a typed position refuses by name (`assignment to "r" (f64) got
  dynamic`). `src/ir/from-ast.ts` shrinks by 12 lines.
- **Ordinary pipeline:** it reaches `lowerLogicalAndOr` in value positions (instrumented: dynamic hints in
  `Test262Error`, `isEnumerable`, f64 hints in `<module-init>`), but never with a typed left and a dynamic right
  operand there — the same programs compile on the ordinary pipeline and answer like node (checked: `(b > 1) && c`,
  `||`, `!a || c`, `n > 1 && c`, a nested right operand), through legacy. Bytes identical on 100 test262 files ×
  default and `--target standalone` plus 14 logical programs, against `b08580f01c` (the tx tip with the hoisted-var
  fix merged, before B).
- **Sweep** (`.tmp/sweep-b.mts`, not committed): left ∈ {typed Boolean `a > 0`, typed number, dynamic} × right ∈
  the same × {`&&`, `||`} × 9 positions (returned, assigned to a dynamic local, argument, `… || e`, `e && …`, `if`,
  `!(…)`, `?:` test, right operand with a side effect that throws), every value pair per program (dynamic: 0, -0,
  NaN, 1, true, false, undefined, null; number: 0, -0, NaN, 1): 162 programs, **88 equal node, 74 named
  refusals, 0 wrong, 0 invariant errors**. Refusals: 62 "operator requires bool operands" (a typed number
  operand), 12 "source Boolean return boundary requires actual canonical Boolean boxing" (`!(…)` returned from an
  `any` result). (-0 is checked with `!==`, which cannot tell it from 0.) A reduced sweep (Boolean/dynamic ×
  Boolean/dynamic × both operators × returned / chained / condition, 24 programs) is in the test file.
- **Mutations:** always ToBoolean the dynamic right operand → 15 tests fail; the `i32` hint for the right operand →
  the nested-right test fails; the value-select arm is the only path to an accepted value (removing it refuses).
  Survivor: `logicalOperandCarrier`'s refusal for the left operand (a typed left operand here is `i32`, which
  always has a carrier).

**Should-fix 1: `function f(n: number) { return n as unknown; }` refused as "call to f returned void used as
expression".** The ordinary pipeline's propagation types such a result void, so the function lowered as void and
the call failed later. Now an unannotated function with no result contract whose body returns a value refuses at
the declaration by name: "function f returns unknown, which has no Prepared result contract" (`object` for `as
unknown as object`) — `ProgramDynamicContracts.propagatedResult` in `src/ir/source-dynamic-contracts.ts`, called
where `src/ir/program-source.ts` used to fall back to void. A body that returns only `undefined` (type
`undefined`/`void`) stays void (pinned by #7188's internal-declaration tests). The dynamic result contract was not
widened to `unknown`: the implicit-flow rule would then refuse every `return` into the `unknown` context, so it is
not a clean fit. Cost: such a function called only as a statement compiled before (its value was dropped) and now
refuses.

**Should-fix 2: seven standalone programs that compiled on H changed Prepared bytes** (un-annotated functions
returning a Boolean, e.g. `function f(v) { return v === 1; }`). Measured on that program (H vs this branch, WAT
diff): the function body is identical; the only change is the type section — `f` gets its own function type
`(func (param externref) (result i32))` instead of sharing the structurally identical type of the runtime's
`__typeof_number` / `__unbox_boolean`, and the `<module-init>` / `__module_init` type indices shift by one. The
Boolean result contract makes the result a Boolean-branded `i32`, which the presentation keys separately from a
plain `i32`. The two types are structurally equal (one-entry recursion groups canonicalize to the same type), so
the behavior is unchanged; it is right because the result now carries its Boolean meaning to the caller (a caller
boxes it as a Boolean, not a number). Folding the duplicate type is a possible size clean-up, not a correctness
issue.

**Also:** the T test helpers yield one event-loop turn before each compile (`compileYielding`): the file now runs
long enough that vitest's worker RPC timed out between compiles. `tests/issue-7354-x-dynamic-throw.test.ts` and the
H test show the same unhandled RPC timeout under the current machine load on their base as well (all tests pass).

### Review round 3

**Verdict NOT MET on one must-fix, pre-existing on H:** a `&&` / `||` whose value is unused dropped its right
operand. `function f(a, b){ a > 0 && boom(b); return 0; } f(1, 1);` returned (node throws); the same with `||`, at
top level, in an unread local and with a counter (`inc` never ran). The reviewer confirmed value and condition
positions and evaluation order correct over a 270-program cross product; a `?:` statement was correct.

- **Cause and fix:** #7359 (the H follow-up record "unused `&&` / `||` keeps its right operand"): the value `if` was
  the only buffer-bearing IR kind `isSideEffecting` judged without its buffers, so DCE and the lowerer dropped it
  when its result was unused. It existed on main for typed TypeScript and on the ordinary pipeline; T made the
  dynamic forms reachable. Merged here from `claude/7354-logical-unused`.
- **Sweep** (`.tmp/tsweep.mts`, not committed): `&&` / `||` × left ∈ {typed Boolean `(a > 0)`, dynamic `a`, typed
  number `(a * 1)`} × right ∈ {dynamic `inc(b)`, typed Boolean `(inc(b) > 0)`, typed number `(inc(b) * 1)`} ×
  {statement, unread local, top level, loop body} × a ∈ {0, 1} × (counter, wrong counter, throwing call): 432
  programs, **240 equal node, 192 named refusals ("operator '&&' requires bool operands" — every typed number
  operand), 0 wrong**; without the fix 80 were wrong. Tests: "review round 3" in
  `tests/issue-7354-t-truthiness-null.test.ts` (both operators × Boolean / dynamic left × dynamic / Boolean right ×
  the four positions, counter and throw, plus the typed number refusal; 32 of them fail without the fix).
- **Merge with Str (main `f8cfc8c0ff`):** Str lets a native string reach the dynamic carrier, and T's ToBoolean body
  had no string arm (`function f(v){ return v ? 1 : 0; } f("")` answered 1 after a plain merge). ToBoolean now takes
  the string arm (empty is falsy) whenever the value lane carries native strings
  (`src/backend/wasmgc/resources/native-dynamic-values.ts`); the selection keeps Str's `strictEqStrings` beside T's
  `toBoolean`. Tests: "T after Str" (conditional, `if`, `||` operand, `!v` on `""` / `"a"`; all 4 fail without the
  arm).

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
- #3518 receipt/pin tests are red on main and hide new breakage (the Perf data.ts edit breaks six more receipts):
  [#7358](7358-3518-receipt-pin-tests-red-on-main.md), which must land before this stack is complete.
- Number formatting is a runtime-support batch, which the presentation refuses (`ir-program-presentation.ts`
  `checkResourceDemand`, "source and prepared runtime must independently prove no async/support demand").

### Review round 1

Adversarial review at `4318ee510f`: NOT MET (string semantics correct; the string provider census did not fail
closed). Fixed:

1. **Must-fix — the census joins string providers to their executable occurrences** (`stringProvidersJoin`,
   `prepared-provider-census.ts`). The step-1/2 rules (some literal global or string type exists; any setup function
   named after a provider symbol) are gone. Now:
   - the selected string providers equal, as a multiset, the string features the executable projection demands
     (the manifest's own scanners `irStringConstDemand`/`EqDemand`/`LenDemand`/`ConcatDemand`);
   - the literal provider: every executable `string.const` is one literal use of the plan, and each use names exactly
     one literal global or materializer by cache key;
   - the length provider: exactly one string carrier type, whose completed field at the provider's `fieldIndex` is an
     i32;
   - `__str_equals` / `__str_concat`: exactly the one setup function of the provider's role, by symbol;
   - the runtime-bound multiset excludes string providers; any other non-callable native provider refuses.
   Each case the review listed now refuses by name (16 new census tests; drop tests restored). Mutation sweep over the
   join (11 mutants: feature population, use count, use join, materializer arm, carrier count, carrier i32, owner
   join, owner count, non-string non-callable): all killed.
2. **Must-fix — `string.eq` / `string.len` emitters** share one helper with the concat emitter
   (`requireOwnerOccurrence`: an occurrence of the owner's executable projection that admits the request, provider
   included); `string.len` reads `fieldIndex` from the selected carrier-field provider.
3. Should-fixes: tests for `string.eq` without concat (needs the empty literal) and an oversized literal (materializer);
   the unreachable `!equality` clause and the redundant `standalone` check of the ABI string arm are gone (the +1 LOC
   grant on `ir-program-presentation.ts` is given back).

Evidence after the round: Str, R, D1, P, V/G, prepared-entry/runtime, #7188 tests pass; the 11 string-related
#3518 files pass (base: same); Prepared bytes of the 32 modules the Str and R tests instantiate are identical to
`4318ee510f`; ordinary bytes on 101 test262 files × 2 targets identical to the base; gates and
`changed-root-tests.sh` (interpreter engine) pass. The emitters' provider/owner checks have no test (Prepared attaches
no string provider, so only a forged emission request would reach them).

### Review round 2

Adversarial review at `82d6cb727c`: NOT MET (three forged setups passed the census, then threw
`invalid-presentation` out of `compile()`). Fixed at `b237a1dca9` + `a26c134013`:

1. **Must-fix 1 — forged setups refuse by name.**
   - **Why they threw.** R's mock returned a *new* plan object on every `emittedPhysicalSetupPlan` read, so any
     forgery the census accepted then failed the finalization's identity check (`plan !== record.plan`). In
     production the plan is one frozen object, so that check is not reachable from a setup. The mock now forges
     ONE object, like the emission's own plan. With that change, a forgery the census accepts presents the real,
     unaltered module (test: reversed reservation steps run and answer 3); it never throws.
   - **(a), (c) and the step further: identity join** (`nativeSlots`). Every binding the setup derives itself
     (anything that is not a runtime or intrinsic callable's) must be the binding its declaration's space and role
     derive under the runtime ABI anchor (`createIrBindingId` + `nativeRole`, the derivation of
     `irSupportFuncRef`/`irSupportGlobalRef`/`irSourceTypeRef`; the name is not part of the id). So every role the
     census reads is the one its completed slot was reserved under. Refused: equality↔flatten swap (a),
     equality↔concat swap, two literal globals swapped, the `""` literal's role stripped (c), flatten, copy-tree and
     a carrier subtype stripped. An intrinsic-bound setup function must be a by-instruction provider's slot (test:
     flatten rebound as an intrinsic and relabelled).
   - **Deviation from the decided fix: no separate signature join for eq/concat.** With the identity join, the eq
     slot is the one reserved as `[string-equality, equals]`, and `supportPopulationJoins` already requires its
     declared signature to be that slot's completed signature. A provider-signature check therefore cannot be broken
     by any forged setup; it would be an unkillable mutant, so it was not added. The carrier field's `i32` check was
     deleted for the same reason (it survived the mutation sweep).
   - **(b) literal uses join by value** (`literalUsesJoin`). The uses equal the executable `string.const`
     occurrences one to one (by `collectNativeStringValueDemands`, which replaces `countInstructions`). Each use's
     cache key must be the key its own occurrence's value and encoding select. `selectNativeLiteralDemand` is moved
     out of the planner, so planner and census share it. The key must name exactly one storage slot of the selected
     kind. Refused: one use repointed to another literal, all uses to one key, two uses exchanging occurrences, one
     occurrence used twice.
   - **Not joined: labels nothing consumes.** A literal global's *name* is one (it is not in the binding id; a
     renamed global is accepted and compiles the real module). The reservation steps and type shapes are others.
2. **Must-fix 2 — emitter checks tested.** `tests/issue-7354-str-emitter-requests.test.ts` (9 tests) issues forged
   requests through `preparedNativeStringResolver`: the wrong owner for eq/len/concat, another owner's occurrence, a
   foreign provider for each, and a host-selected length provider. Deleted because implied:
   - `!pack.equality`: an admitted `string.eq` implies the planned equality resource.
   - `selected.length === 1` and `field.carrier !== "string"`: the length emitter now uses
     `preparedStringLenProvider`, and the carrier is typed `"string"`.
3. **Should-fixes.**
   - The length emitter shares `preparedStringLenProvider`; this adds one `backend->ir` import edge, granted in the
     frontmatter.
   - `countInstructions` is gone.
   - `hasRole` is now data equality, so the `roleLen` survivor is gone.
   - `callableKind` is gone: the callable join compares the provider's implementation as data.
   - The `useOne` survivor is killed by a duplicated literal global on the same slot.
   - **Rebutted: sharing the manifest's demand→feature table.** `demandFeatures` is private to
     `src/ir/program/runtime-manifest.ts`, and the #3518 validator relocation receipts byte-pin that file. Exporting a
     wrapper failed 30 relocation tests, and re-pinning breaks its segment proofs. The census keeps its six scanner
     rows, now spelled with the family constants.

Evidence:
- Tests: Str (18), R (96), Str emitter (9), D1 (46), P + V/G (70), prepared-entry/runtime + #7188 (58) pass. The
  forks report a vitest `onTaskUpdate` RPC timeout under load on the slow string files; every test passed.
- At `82d6cb727c` with the stable mock, 12 of the new R tests fail (the forgeries are accepted there).
- 23 #3518 files: all files that import a changed module, plus the string equality/flatten/output/value files.
  Failing sets are equal to the base: c1-current-source 271, number-format 2, realm-requirements 1,
  validator-policy-evolution 143, validator-relocation 9, semantic-provider-boundary 349, helper-policy-evolution
  134. Every other file passes.
- Bytes against `82d6cb727c`:
  - Prepared: the 33 modules (30 distinct) the Str and R tests instantiate are identical.
  - Ordinary: 100 test262 files × {JS environment, standalone} are identical.
- Mutation sweep, 19 mutants, each run alone:
  - Census: 12 killed (identity off, runtime/intrinsic exemptions, intrinsic-owner, use population, value key,
    useOne, kind, carrier count, callable named, demanded population, role equality); carrier `i32` survived and
    was deleted.
  - Emitter: owner, eq/len/concat provider and length arm are killed.
  - **Survivor, justified:** `buffer.view === "projection"` in `requireOwnerOccurrence`. In every reachable program
    the program view carries the same string instructions as the projection, so no request can name an occurrence
    that only the program view has.
- Gates: typecheck, loc, func, coercion-sites, oracle-ratchet, dead-exports, import-cycles (grant), boundaries
  inventory, and `changed-root-tests.sh` (interpreter engine).

### Review round 3: MET

Fresh adversarial review at `50468e80c0` with the reviewer's own mock: MET, no must-fix.
- Every forgery is refused by the census itself.
- The dropped signature join and the dropped carrier-`i32` check are accepted as implied.
- The manifest-table rebuttal is accepted; the follow-up is #7358.
- Optional should-fix, not done: the census refusal names no join. Every census join, the string join included,
  answers `undefined`, and the presentation turns that into the one `runtime-demand` gap. Naming the failing join
  would change `runtimeCensus`'s result type and the gap call in `ir-program-presentation.ts`, which is at its size
  budget. That belongs to a census-wide change, not to the string join alone.

### Merged onto main (D1 reworked, P, H) — 2026-11-17

Merged `origin/main` `0409838769` into the branch.
- **Conflicts.** Three files:
  - The issue file: both sides kept.
  - `ir-program-presentation.ts`: string admission in internal callable contracts, as `inCall` beside H's `carried`
    (+1 line, granted in the frontmatter).
  - R's census test: H's describe and Str's describe are both kept.
- **Ported cleanly onto D1's rework.** `selectNativeDynamicValues(intrinsics, stringsCarried)` and the string arm in
  `buildObjectSameValueBody`'s three string parameters needed no change.
- **One port for H.** H's provenance (`carries`) now treats string literals as a typed kind, beside the number and
  Boolean literals. Without it, a literal passed to a typed string parameter refused as "a dynamic value flows into
  string".
- **A script `var` holding a string now works through H's dynamic home.** It equals node (two acceptance tests),
  and its `.length` refuses by name (`dyn.member_get`). H's "holding a string (slice Str)" refusal row is removed.

Evidence after the merge:
- Tests: Str (20), emitter-requests (9), R (100), D1 (49), P + V/G, H (65), prepared-entry/runtime + #7188 (58)
  pass. The vitest `onTaskUpdate` RPC timeout appears on the slow string files.
- `changed-root-tests.sh` (interpreter engine): every changed root file passes. The script hit the time cap before
  the last file, `str-strings`, which was run directly.
- Gates against the `origin/main` tip pass: loc and func (with `LOC_GATE_BASE`), coercion-sites, oracle-ratchet,
  dead-exports, import-cycles, boundaries inventory.
- Bytes against `origin/main`:
  - Ordinary: 100 test262 files × {JS environment, standalone} are identical.
  - Prepared: all 148 modules the D1, P, V/G, H, prepared-entry/runtime, #7188 and R tests instantiate on main are
    identical. The 5 extra modules are Str's string programs.
- String sweep (`.tmp/sweep.mts`): 286 programs, compared with node. They cover 16 dynamic-string operations × 4
  strings × {top level via the dynamic home, function, condition, loop across iterations with a sibling `while`},
  plus typed string expressions in a function and a loop.

| Outcome | Programs | Detail |
| --- | --- | --- |
| OK | 184 | equal to node |
| `dyn.truthy` (ToBoolean, slice T) | 32 | `&&`/`||` with a string operand in condition position |
| `operator '&&' requires bool operands` | 16 | from-ast, value position |
| `operator '\|\|' requires bool operands` | 16 | from-ast, value position |
| `dyn.typeof` | 16 | |
| `__ir_dyn_add` | 16 | dynamic `+`, slice Str2 |
| `source declaration and prepared callable slots disagree` | 6 | a .js function returning a Boolean of a typed string; numeric twins refuse the same way on main |

  Wrong answers: 0. Invariant errors: 0.
- 411-row sample: all 411 rows have the same status and first gap as `origin/main` (0 differ). The tally is 282
  `dyn.truthy`, 84 `module binding … has no exact typed storage`, 26 `String` call, 2 switch-case binding,
  1 `Test262Error`, 1 parse error, 1 `print`, and 14 negatives pass.

## Ty result

Status 2026-11-17. Branch `claude/7354-ty` on `claude/7354-tx` (`37366b4667`).

### Built

- **Step 1, `typeof v <op> "lit"` on the dynamic value.** from-ast lowers every such comparison (all four
  operators, both orders) as `string.eq(dyn.typeof v, string.const)`. `src/ir/program/typeof-comparisons.ts` finds
  them; one arm of `dynamic-value-legalization.ts` answers each with a tag test on `v` and drops the `typeof`
  result and literal when only those comparisons read them. A `typeof` result used any other way still refuses as
  `dyn.typeof` (slice Str2). Tag tests: "number" → new `js.value.is_number`, "boolean" → new `js.value.is_boolean`
  (bound to the native value / Boolean resources' existing `__typeof_number` / `__typeof_boolean`, no new
  resource), "undefined" → `js.extern.is_undefined`, "object" → `ref.is_null`; any other literal is constant.
- **Tie to the admitted kinds.** `TYPEOF_KIND` is keyed by the `typeof` answer and its values are the admitted
  kinds; the box arm admits a value only through `boxedKind()` typed by it. A slice admitting strings/objects must
  edit it (an object kind collides with `null` on "object"); until then an unanswered literal is constant false.
- **Step 2a, refactor (`fa01b1aa4c`).** from-ast's identifier-read chain is one pure classifier,
  `classifyIdentifierRead` (`src/ir/identifier-read.ts`); the read switches on it (from-ast −30 lines).
- **Step 2b, `typeof` of an absent global (`af18d626f0`).** The native lane's resolver states
  `unresolvedNameIsAbsent`: a name the program does not declare and not in `PREPARED_PROVIDED_GLOBALS` (`Number`,
  since `Number(v)` compiles). The classifier answers such a `typeof` operand `absent-global`; the read lowers it to
  the undefined value (step 1 answers the comparison) and the conditional fold answers "undefined" from the same
  classification, so assert.js's dead `JSON.stringify` arm is not lowered. The legalization also runs for roots
  holding such a `typeof`.
- **Semantics, stated:** this is THIS environment's answer (it provides no such global), not ECMAScript's — node
  says `typeof Math === "object"`. Sound because every value/member/call/`new` use of such a name refuses by name
  (pinned for every name of `AMBIENT_TYPEOF_TAGS`, the failure says to add the name to `PREPARED_PROVIDED_GLOBALS`),
  and the error is in the safe direction. The shape that could pass falsely (assertions all under
  `if (typeof X !== "undefined")`): 0 es5id files; in test/built-ins + test/language 11 files compare a global's
  `typeof`, of which 2 guard assertions (`Object/assign/target-Array.js` Proxy, `Error/isError/fake-errors.js`
  Symbol) and 7 skip one table row (ArrayBuffer immutable, Error stack).

### Differences from the brief

- `switch (typeof v)` with only literal cases and `var k = typeof v; k === "x"` are accepted (the same SSA
  comparisons; tested against node). Any non-literal case test refuses by name ("switch-case-test-nonliteral", review round 1; before it, only an all-non-literal switch refused).
- A typed operand (`typeof n` with `n` an f64 local) still refuses ("js.string.const is unavailable"), as on base.

### Measured

- Tests: `tests/issue-7354-ty-typeof-comparisons.test.ts` 67 (isPrimitive; per literal every operator × order ×
  9 values; side effects once; conditions, loops, `?:`, `&&`/`||`, switch, catch; refusals; absent globals, the
  table-driven pin, shadowing var/parameter/local, hoisted var, undeclared identifier, TDZ, cross-script
  declaration). R census +6 (providers dropped/renamed, `__typeof_number`/`__typeof_boolean` renamed). With D1, T,
  H, X, P, V/G, R, prepared entry/runtime, #7188, 3518 seam/ownership: 445 pass.
- Sweep: 566 programs (190 full + 376 sampled of 1,692: 9 literals × 10 values × operators × orders × 10
  positions) against node: 530 correct (right answer returns, wrong throws), 36 named gaps (typed script var →
  string const; TypeScript no-overlap errors), 0 wrong, 0 invariant, 0 invalid Wasm.
- Mutations: step 1 — 2 survivors found and killed by new tests (literal guard: `typeof v === typeof w` gave a
  wrong answer; the number-test resource selection); survivor kept: terminator use count (no source shape puts a
  `typeof` result in a terminator; a use count must be complete). Step 2 — all 7 guards killed (file/checker
  declaration checks gave wrong answers under mutation, now tested).
- Ordinary bytes: refactor identical on 313 test262 files (ES5 sample + Math, JSON, Number, global, identifiers,
  typeof, identifier-resolution) × JS and standalone; feature identical on 163 of them × 2. Prepared bytes of the
  refactor identical for 343 distinct programs of the 7354/7188/prepared tests × standalone/gc.
- Pins: 3518 core-vocabulary-seam 42 → 44; semantic-verification-ownership INTRINSIC_DEFINITIONS pin
  bc21ec2c… → 242fb237… (predecessor step also removes the two rows); D1's tag-test refusal now uses a String tag;
  T/D1 typeof refusals moved here. 3518/3526 base diff: the four pin files run on base and HEAD (evolution: same 117
  failures); the other ~300 files were run on HEAD only for about half (no base comparison) — not complete.
- 411-row sample: negatives 14 pass. After step 1: 282 moved from `dyn.typeof` (isPrimitive) to `identifier
  "JSON" is not in scope in formatIdentityFreeValue`. After step 2: 308 × `direct call to "String" has no exact
  AST-site plan` (282 in `formatIdentityFreeValue`, assert.js:29 `return String(value) + "n";`, 26 in
  `verifyProperty`); 84 × `module binding X has no exact typed storage: not-direct` (obj 52, x 5, proto 4, o 4, …);
  2 switch-case lexical binding; 1 `unknown class "Test262Error"` in isConstructor; 1 parse error; 1 `print`.

### Known gaps

- Pre-existing: an empty source program throws `PreparedIrProgramInvariantError` out of compile() on the Prepared
  standalone entry ("native string/value demands: missing complete owner population").
- `typeof Number` refuses by name (provided, real tag not wired).

### Review round 1 (Ty)

Adversarial review at `cb7aec7ab6`: NOT MET, one must-fix. Fixed at `9434ede322`:

1. **Must-fix: a switch mixing literal and non-literal case tests gave a wrong answer.** `lowerStringSwitchDispatch`
   compared only string-literal tests and skipped the rest (never compared, never evaluated); only the selector
   stopped it, and the Prepared path has none. The selector's case-test admission is now one predicate,
   `switchCaseTests` (`src/ir/switch-case-tests.ts`), asked by the selector and by from-ast's switch lowering, which
   refuses by name (`switch-case-test-nonliteral`, `-mixed`, `switch-multiple-defaults`); the two files' duplicate
   literal helpers fold into it (from-ast −18, select −48 lines). Siblings: the numeric dispatch with a non-constant
   case used to reach a plain producer-promise `Error` (an exception, not a refusal) and now refuses by name; a
   string switch with a numeric case was skipped the same way and is now `-mixed` (TypeScript also rejects most such
   programs). Tests: the repro (last), first, only, a call with a side effect, a numeric switch's non-literal case,
   default in the middle (runs like node). Mutation: deleting the refusal is killed.
2. **Catch-payload tie (should-fix): pin.** The catch binding enters the carrier without `boxedKind`; T's per-throw-site
   payload pins (`tests/issue-7354-x-dynamic-throw.test.ts`) now fail with a message pointing at `TYPEOF_KIND`.
3. **`tag.test` widening (should-fix): withdrawn.** The arm keeps only its sourced `undefined`/`null` probes; the number
   and Boolean tests come only from the `string.eq` arm; D1's number-tag refusal pin is restored.
4. **Fold asks the classifier only (should-fix): rebutted.** `ambientTypeofIdentifierTagFromAst` is not part of the
   identifier-read order: it answers the ordinary lane's host-provided `AMBIENT_TYPEOF_TAGS` (`isAmbientBinding`),
   which the read chain never resolves (on that lane the read of `JSON` itself is `unresolved`), and it decides before
   the operand is lowered (`typeof (JSON)` with parentheses is deliberately not folded there). Moving it into the
   classifier would make the read answer it too and change which resolver calls run on the ordinary lane; the Ty
   answer (`absent-global`) already comes only from the classifier.

Measured after the fixes: Ty 72, D1/T/X 126, H/R 134 tests pass; `changed-root-tests.sh` (vs main): 7 of 9 files
ran inside the 9-minute cap and pass, the other two (X, Ty) pass when run directly; `issue-2952-slice4/6` fail the same
16 tests on base and HEAD; typecheck, loc, func, coercion, oracle, dead-exports, import-cycles, boundaries pass;
ordinary bytes identical on 100 files (40 `language/statements/switch`, ES5 sample, typeof/identifier dirs) × JS and
standalone (77 compile per target, 23 compile errors on both).

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

### Review round 1 (2026-11-17)

- **Must-fix: forged frozen collection.** The predicate recognised FrozenMap/FrozenSet by prototype alone. Fixed in
  `src/ir/program/data.ts`:
  - The two classes get a private-field brand check (`#map in v` / `#set in v`).
  - New export `preparedIrFrozenCollectionMembers(v)` returns the members only for a branded instance with the exact
    prototype, frozen, with no own keys. A subclass carries the brand but has its own prototype, so it is refused.
    The frozen/no-own-keys checks are implied by brand plus exact prototype, because the constructor freezes `this`
    (mutation survivor).
  - `preparedIrDataMismatch`, `immutableCopy` and `freezePreparedIrRuntimeValue` use the brand instead of
    `instanceof`. This is a drop-in for genuine collections. A borrowed prototype is now a non-data object and is
    refused, so the reviewer's repro is refused at planning ("stale or mismatched demand census").
  - Tests: the repro; forged map and set twins over mutable storage; a bare object on the borrowed prototype; a
    branded subclass that overrides iteration.
- **SF1, re-entrancy:** `audited` restores the outer flag, so a nested check no longer re-opens the ledger. Test: the
  reviewer's probe.
- **SF2, `internFunctionType`:** appending a new type inside `audited` is refused. Cache hits stay allowed, since they
  are read-only. Test added.
- **SF3, comments and test names:** they now describe the single trailing audit.
- **SF4, the copy-brand fact in data.ts:** measured alone, it saves 20 lines 5.96 → 4.91 s and 50 lines 14.4 →
  10.0 s, so it is kept. data.ts has to change for the must-fix anyway.
  - Receipts that pin data.ts content: `tests/helpers/ir-runtime-program-relocation.json`, `ir-c1-authority.json`,
    `ir-ownership-evolution.ts`, `ir-runtime-program-policy-program-validator.json`,
    `ir-source-map-position-inventory-successor.json`, `ir-deno-post-position-main-successor.json`.
  - Their consuming tests (ownership seam, provider-boundary, policy-evolution) already fail on base, so the extra
    breakage is masked and these receipts need a refresh when the stack lands.
- **SF5, inherited fields:** a settled verdict now records the own-property state of `Object.prototype` and
  `Array.prototype` that it ran under. Any change re-runs full authentication. Requiring null-prototype records was
  tried and rejected: the prepared program is built from frozen `Object.prototype` records, so nothing would settle
  (20 lines took 29 s). Test: adding `Object.prototype.outputRequirements` after settling is refused ("unexpected
  output requirements"); removing it re-settles.
- **Results:**
  - The 24 `issue-3518-native-string-*` files plus str-strings fail the same set as base.
  - Prepared bytes are identical for the 43 programs. Ordinary bytes are identical on 100 files × 2 targets.
  - Scaling: 5 lines 2.9 s, 20 lines 4.9 s, 50 lines 10.7 s.
  - Mutants killed: re-entrant restore, intern guard, prototype state, map/set brand, map/set exact prototype, set
    member walk, and the brand in `immutableCopy` / `preparedIrDataMismatch` / `freezePreparedIrRuntimeValue`.
  - Survivors: the implied frozen/no-own-keys check, and the perf-only `owner.settled` assignment.

### Review round 2: MET (2026-11-17)

- `preparedIrFrozenCollectionMembers`: the frozen/no-own-keys check is dropped. Brand plus exact prototype suffice,
  because the constructor freezes `this` before anyone holds it.
- `sharedPrototypeState` now documents exactly what it tracks: the own properties of `Object.prototype` and
  `Array.prototype`. The Map/Set/iterator built-ins and `Function.prototype.call` are trusted, not tracked. Base has
  the same gap, because its per-use re-check reads through the same built-ins.
- The six data.ts receipt pins and the other red-on-main pin families are filed as
  [#7358](7358-3518-receipt-pin-tests-red-on-main.md) (priority high, sprint current). It must land before the #7354
  stack is complete.

### After the merge onto Str (2026-11-17)

Perf (`8e92e8c3cb`, built on Str `4318ee510f`) merged with the reviewed Str (`eeb2e28a24`, PR #7291), then with main
after #7291 landed. Main since the Str tip changed only benchmark artifacts and the LOC baseline.

What the port changed:

- One conflict in `native-string-values.ts`: Str had folded the concat emitter's occurrence scan into
  `requireOwnerOccurrence`, the shared check of concat, `string.eq` and `string.len`. Str's structure is kept. Its
  completion check (`requireCompletedNativeStringValues` and then `ownerFor` again) is now Perf's `completedOwner`. So
  every string emit (literal, concat, equality, length) runs one owner check, takes the settled-owner fast path, and
  does ONE `audited` layout audit. No check of either side is removed: Str's occurrence admission and Perf's realm
  identity, inventory and completion checks all still run on every emit.
- Issue file: Str's review sections first, Perf's after them; the frontmatter grants are Str's (Perf added none).
- `data.ts`, `module-reservations.ts` and the census test merged without conflict.

Scaling through the strict Prepared entry (one line = literal + concat + length + `===`, standalone):

| lines | before: Str `eeb2e28a24` (s) | after (s) |
| ----: | ---------------------------: | --------: |
|     5 |                          9.3 |       1.8 |
|    20 |                         76.4 |       3.6 |
|    50 |      not finished in 480 s |       7.7 |

Before and after produce the same binary at 5 and 20 lines.

Proofs:

- Gates: typecheck, LOC and function budgets with the base at the Str tip and at the main tip, coercion sites,
  oracle ratchet, dead exports and import cycles are all green.
- Tests pass: Perf, Str strings, Str emitter requests, R census (100), D1, P, V/G, H, H2, prepared entry and runtime,
  and #7188.
- The 24 `issue-3518-native-string-*` files, run in chunks of 4, fail the same 67 tests (same sets) as the Str tip.
- Prepared bytes are identical to the Str tip for all 90 compiles of the Str strings, prepared-entry and D1 test
  files: 45 binaries and the refusal messages of the rest.
- Ordinary bytes are identical on 60 test262 files × (default, standalone).
- Forgeries still refuse:
  - Perf's: a forged frozen map or set; a mutation after a nested `audited` returns; demands or plan changed between
    two emits.
  - Str's: swapping the names of `__str_equals` and `__str_concat` (the census has no equals/flatten swap); repointing
    a literal use to another literal's storage; stripping the role of the `""` literal global.
- `changed-root-tests.sh` (interpreter engine): green.

## T and X result

Status 2026-11-17. Branch `claude/7354-tx` on `claude/7354-p` (`1995dd6ef2`): T `5310a38b13`, X `01fd76c26c`.

### Built

- **T, ToBoolean.** New intrinsic `js.value.to_boolean` (`(externref) -> i32`), added to every closed list the
  same way as `js.value.strict_eq` (vocabulary, `INTRINSIC_DEFINITIONS`, runtime features, provider ids,
  `dynamic-value-callables.ts` symbol `__is_truthy`, `nativeIntrinsicRows` role `to-boolean`,
  `native-dynamic-values.ts` row and fill). The legacy `__is_truthy` body moved unchanged into the pure builder in
  `src/runtime/wasmgc/values/primitive-layouts.ts` (`buildToBooleanBody`/`buildToBooleanLocals`); legacy
  `registry/imports.ts` calls it with its old arguments (149 lines shorter), the Prepared fill calls it with
  `$AnyValue` (so `undefined` is falsy), the number and Boolean boxes, and no BigInt or string arm (`-1`).
  Legalization arm: `dyn.truthy` → `js.value.to_boolean`.
- **T, `null`.** The representation is the ordinary standalone pipeline's: the carrier's null reference
  (`ref.null extern`); `undefined` stays the non-null `$AnyValue` singleton. So strict equality (its null arm),
  the `undefined` probe (false for null) and ToNumber (`__unbox_number`: null → 0) are exact with no change. The
  native lane's resolver now answers `dynamicCarrierIsExternref: () => true` (`sourceDynamicResolver`), which
  turns on from-ast's existing dynamic `null` literal (`box` tagged Null) and `=== null` (`tag.test` Null).
  Legalization arms: a Null-tagged box → `const null externref`; `tag.test` Null → `unary ref.is_null`.
- **T, consequence.** The same flag makes from-ast read the catch binding as the dynamic value. Its checker
  type is `unknown` (strict), so the D1 flow rule (`refuseImplicitDynamicFlows`) now treats `unknown` like
  `any`: `catch (e) { return e as number; }` refuses by name ("flows into number … (AsExpression)") instead of
  reaching a middle-end invariant ("early.return value type externref not assignable to declared result f64").
- **X.** `coerce.to_externref` of a dynamic value whose result a `throw` consumes (found by a deep walk of the
  function, nested buffers included) is kept: over the legalized `externref` operand it lowers to nothing. Any
  other coercion of a dynamic value still refuses. P's result rule counts `unknown` like `any`, so a function
  that returns its catch binding has a dynamic result.
- `&&`/`||` needed nothing: from-ast already yields the operand (`(0 || 5) === 5`, `(1 && true) === true`,
  `(undefined || undefined) === undefined` are tested).

Names other slices can rely on: intrinsic `js.value.to_boolean`, provider `native.js.value.to_boolean`, resource
`__is_truthy` (role `values/to-boolean`), builder `buildToBooleanBody`. `null` needs no new intrinsic: it is
`ref.null extern` in the carrier. **Str must pass the string type as `anyStringTypeIdx` in the
`native-dynamic-values.ts` ToBoolean fill** once strings enter the carrier, or `""` reads truthy.

Soundness of the dynamic catch binding: the payload is whatever was thrown. In an accepted Prepared program that
is a dynamic value, a boxed number (`numericThrow`) or `null`; strings refuse (`js.string.const is unavailable`),
a typed Boolean throw refuses ("throw val not in slice 9"), objects do not compile (see gaps). A slice that makes
a new value throwable must give the dynamic operations its arm.

### Measured

- Tests (round 1 counts): `tests/issue-7354-t-truthiness-null.test.ts` (34), `tests/issue-7354-x-dynamic-throw.test.ts` (48),
  each accepted program run with node's answer (returns) and a wrong one (throws). With D1, P, V/G, R: all pass.
- Sweeps against node, through the strict entry: T 1584 programs (`!v`, `!!v`, `?:`, `&&`, `||`, `=== null`,
  `!== null`, `null === v`, `=== undefined`, `if`, `if (!v)`, `while`, `for`, `do-while` × 11 values incl. NaN,
  ±0, ±Infinity, booleans, undefined, null × returned / local / condition / top level), 1584 correct, 0 gaps.
  X 231 programs (return the caught value, rethrow through nested try/catch/finally, two calls up, top level,
  ToBoolean / identity / undefined / null test of `e`, literal throws, finally runs, uncaught escape), 227
  correct, 4 named gaps (typed `throw true/false`). Zero invariant errors, zero invalid Wasm.
- Mutation check (14 mutations, each alone): 13 killed. Survivor: `internalizeOnce` on the Prepared fill (true and
  false are both correct; it only chooses whether the operand is internalized once or twice).
- Ordinary pipeline: 320 test262 files (the ES5 sample list) byte-identical on the default JS target and on
  `--target standalone` against the base, 312 compiled per target, 8 compile errors on both.
- Prepared bytes, 37 program literals of prepared-entry/runtime, #7188 and R tests × {entry.ts, test.js} ×
  {standalone, gc}: identical except one, R's base `catch (e) { return e as number; }`, now the named refusal
  above (R's test program changed to `catch (e: any) { return e * 1; }`, which the base refused).
- Changed root tests vs `origin/main` (the `quality` job's set): the same 10 failures on the base and with T/X
  (`core-vocabulary-seam` 4 × "complete source SHA256/length mismatch: src/ir/ast-lowering-plans.ts",
  `semantic-verification-ownership` `effectsOf` hash, `string-boundary-const` 5 host-lane import positions).
- Real runner, 411-row sample: negatives unchanged (14 pass, 1 compile error); first gap unchanged: 393 ×
  "not-direct" (`print`, `__isArray`, `__globalObject`), 2 switch-case, 1 callable annotation. T and X sit
  behind slice H's gap; the stepped-past tally was not run.
- Gates: typecheck, loc, func, coercion-sites, oracle-ratchet, dead-exports, import-cycles.

### Test pins updated

- `issue-3518-core-vocabulary-seam`: `INTRINSIC_IDS` 41 → 42 (two places).
- `issue-3518-semantic-verification-ownership`: `INTRINSIC_DEFINITIONS` successor pin a17fd837… → bc21ec2c…; the
  D1 predecessor step removes the three `js.value.*` rows (re-derives b763d963… unchanged); catalogue 41 → 42.
- `issue-7354-d1-dynamic-carrier`: ToBoolean, null tag test and thrown-value refusals removed (expressed now);
  `selectNativeDynamicValues` gains `toBoolean: false`.
- `issue-7354-p-parameter-contracts`: the ToBoolean refusal removed. `issue-7354-r-provider-census`: the census
  program also tests ToBoolean and its provider/resource drop/rename; `twoNatives` as above.

### Named gaps and not verified

- `typeof v` refuses "dynamic operation dyn.typeof has no Prepared intrinsic" (Str); `isPrimitive` stops there.
- `v == null` refuses in from-ast ("bare 'null' in non-reference context (f64)"); other loose equality refuses
  as `dyn.eq (loose)`.
- A boolean (i32) result passed to a dynamic parameter was refused in from-ast; fixed in review round 1 (the
  Boolean result contract below).
- Pre-existing on the base: `throw {}` throws `PreparedIrProgramInvariantError` out of `compile()` ("resolver
  cannot lower object<>"); pinned in the X test.
- No program in the sweeps, the tests or the review probes reaches a `coerce.to_externref` of a dynamic value
  that a `throw` does not consume (its other from-ast producers — string concatenation, function-object keys,
  host boundaries — refuse earlier on this lane). The rule is tested on hand-built IR only.

### Review round 1

Adversarial review at `bbab057818`: T MET, X MET, no must-fix. Should-fixes:

1. **Catch-binding payload assumption — fixed (pinned).** Every throw site that could reach a Prepared catch was
   listed: user `throw` (dynamic, boxed number, `null` admitted; string → `js.string.const is unavailable`;
   Boolean → "throw val not in slice 9"; object → emission invariant, pre-existing), from-ast TDZ
   `__new_ReferenceError` (refused: "needs runtime function materialization"), from-ast `__new_TypeError`
   (dynamic call and member read refuse earlier), runtime bodies (all construct a TypeError — an Error object,
   for which every dynamic operation the carrier has is exact: truthy, identity, not `undefined`/`null`,
   ToNumber NaN — except `vector-grow-store.ts`'s `ref.null extern`, unreachable: no vector compiles). Each is
   pinned in `tests/issue-7354-x-dynamic-throw.test.ts`; the invariant is stated at `sourceDynamicResolver`,
   where the binding becomes dynamic.
2. **Other paths of the carrier flag — fixed.** Each refuses today, with a test in the T file: a dynamic for-in
   head ("dynamic for-in runtime is unavailable"), a function-object property write (`identifier "g" is not in
   scope` — functions are not values yet), a primitive wrapper's ToPrimitive (`unknown class "Number"`), the
   `parseInt` externref boundary in `stringToNumber` ("direct call to "parseInt" has no exact AST-site plan").
3. **Stale strict-equality comment — fixed** (`null` is in the admitted set; the body's null arm).
4. **`buildToBooleanBody` style — fixed.** An absent arm is `undefined` (like `buildIsUndefinedBody`), no `as`
   casts; ordinary bytes identical on 50 files, then on all 320, both targets.
5. **`return e === 3` refused by the join — fixed.** Cause: not the catch binding. An unannotated result the
   checker types Boolean lowered (through the propagation shared with the ordinary pipeline) to a plain `i32`,
   and the presentation's source-declaration join requires the Boolean carrier; `function f(){ return 1 === 1; }`
   failed the same way on the base (P's named gap). `sourceDynamicResult` now answers the Boolean carrier for
   such a result on the native lane. Both programs run (right answer returns, wrong throws), and a Boolean
   result now also flows into a dynamic parameter (`same(f(0), true)`).
6. **Source test for the coercion rule — rebutted:** no source program reaches a non-throw use (above).
7. **Proofs the restart cut — done.** 3518/3526, all 316 files on HEAD `8a3583bf67` in 8-file chunks (3 slow
   files run alone; `native-invocation-consumer` and `native-mixed-object-access` exceed the 10-minute
   foreground cap and were not completed), the base (`1995dd6ef2`, swapped into the tree) on the 120 files that
   fail on HEAD: identical failing sets except `native-source-closure-consumer`, where both sides lose different
   35–40 s `STACK_TRACE_ERROR` timeouts under load. Note: `origin/claude/7354-p` moved during the session (P's
   review rounds), so the earlier base runs were redone against `1995dd6ef2`; with it,
   `native-string-number-source-admission` fails the same 3 tests on base and HEAD (fixed on P's newer head).
   `changed-root-tests.sh` stops at `core-vocabulary-seam`'s 4 pre-existing failures ("complete source
   SHA256/length mismatch: src/ir/ast-lowering-plans.ts", same on the base, fixed on D1's newer head); the other
   10 changed root files were run directly and fail only the base's tests.

Verdict MET; every should-fix fixed or rebutted.

### After the merge onto H (`36c1b42ac9`)

- Port onto `programDynamicContracts`: the `resolver` entry gains `dynamicCarrierIsExternref`; the Boolean result
  contract is `sourceBooleanResult`, asked by `result()` after the dynamic one (the provenance still asks only the
  dynamic one); the `unknown`-as-untyped rule is dropped: H's provenance already answers "may be dynamic" for a
  catch binding (a local without an initializer), which covers both the result contract and the flow rule. Two
  additions beside their siblings: the legalization also runs for roots that bind a catch (a program whose only
  dynamic value is a catch binding has no dynamic contract), and the flow rule's `passedOn` treats the operands of
  `||`/`&&` like a comma's result (T makes them yield an operand). H tests updated: `x || 0`, a returned catch
  binding and a returned `null` run now instead of refusing.
- Tests: T 34, X 48, H 66, P, D1, V/G, R, prepared entry/runtime, #7188 pass; `changed-root-tests.sh`: all 10
  files pass. Gates against the H tip pass. Ordinary bytes: 100 files × 2 targets identical to the H head. Sweeps:
  T 1584/1584, X 227 + 4 named gaps.
- 411-row sample: negatives 14 pass. First gap over 396 positives: 282 × "dynamic operation dyn.typeof has no
  Prepared intrinsic" (`isPrimitive`, `harness/assert.js:21`, the prelude's first `typeof`); 84 × "module binding X
  has no exact typed storage: not-direct" (`obj` 52, `x` 5, `proto` 4, `o` 4, `arr` 3, …); 27 × "direct call to
  "String" has no exact AST-site plan in verifyProperty"; 2 × switch-case lexical binding; 1 × "unknown class
  "Test262Error" in isConstructor".

### Review round 2 (delta after the port onto H)

**Must-fix: a Boolean (typed) left operand with a dynamic right operand in a VALUE position yielded a Boolean.**
`function f(b, c) { return (b > 1) && c; }` answered `f(5, 7) === true` (node: 7); the same for `||`, `!a || c`,
`!(a && b) || c`, `(b > 1) && (c || d)` and TypeScript `n > 1 && c` / `n > 1 || c` with `c: any`.

- **Cause** (the reviewer's reading, confirmed): `lowerLogicalAndOr` (`src/ir/from-ast.ts`) takes its `i32` path
  whenever the left operand is not dynamic and ToBooleans a dynamic right operand there even outside a condition.
  Before T that ToBoolean had no intrinsic and refused by name; T's `js.value.to_boolean` made the wrong path run.
  The `&&` case was wrong before the port; the `||` cases were reopened by the `passedOn` logical arm of the
  implicit-flow rule (which is right: an operand of `&&`/`||` is the expression's value).
- **Fix:** the position the lowering already knows decides. Only a boolean position (the `i32` hint: an `if` /
  loop condition, `?:` test, `!`, a Boolean result) ToBooleans the right operand. In a value position a dynamic
  right operand stays the value, the typed left operand is boxed into the carrier (`logicalOperandCarrier`, which
  the dynamic-left arm's right operand now shares), and the result selects one of them (`emitLogicalSelect`, moved
  to the new `src/ir/logical-select.ts` and shared by all three arms). Each operand is evaluated once, the right one
  only in its arm. A nested logical right operand gets the carrier hint in a value position, exactly like the left
  one (`operandHint`, one rule for both sides). A typed number operand still refuses by name ("requires bool
  operands"); the dynamic result flowing into a typed position refuses by name (`assignment to "r" (f64) got
  dynamic`). `src/ir/from-ast.ts` shrinks by 12 lines.
- **Ordinary pipeline:** it reaches `lowerLogicalAndOr` in value positions (instrumented: dynamic hints in
  `Test262Error`, `isEnumerable`, f64 hints in `<module-init>`), but never with a typed left and a dynamic right
  operand there — the same programs compile on the ordinary pipeline and answer like node (checked: `(b > 1) && c`,
  `||`, `!a || c`, `n > 1 && c`, a nested right operand), through legacy. Bytes identical on 100 test262 files ×
  default and `--target standalone` plus 14 logical programs, against `b08580f01c` (the tx tip with the hoisted-var
  fix merged, before B).
- **Sweep** (`.tmp/sweep-b.mts`, not committed): left ∈ {typed Boolean `a > 0`, typed number, dynamic} × right ∈
  the same × {`&&`, `||`} × 9 positions (returned, assigned to a dynamic local, argument, `… || e`, `e && …`, `if`,
  `!(…)`, `?:` test, right operand with a side effect that throws), every value pair per program (dynamic: 0, -0,
  NaN, 1, true, false, undefined, null; number: 0, -0, NaN, 1): 162 programs, **88 equal node, 74 named
  refusals, 0 wrong, 0 invariant errors**. Refusals: 62 "operator requires bool operands" (a typed number
  operand), 12 "source Boolean return boundary requires actual canonical Boolean boxing" (`!(…)` returned from an
  `any` result). (-0 is checked with `!==`, which cannot tell it from 0.) A reduced sweep (Boolean/dynamic ×
  Boolean/dynamic × both operators × returned / chained / condition, 24 programs) is in the test file.
- **Mutations:** always ToBoolean the dynamic right operand → 15 tests fail; the `i32` hint for the right operand →
  the nested-right test fails; the value-select arm is the only path to an accepted value (removing it refuses).
  Survivor: `logicalOperandCarrier`'s refusal for the left operand (a typed left operand here is `i32`, which
  always has a carrier).

**Should-fix 1: `function f(n: number) { return n as unknown; }` refused as "call to f returned void used as
expression".** The ordinary pipeline's propagation types such a result void, so the function lowered as void and
the call failed later. Now an unannotated function with no result contract whose body returns a value refuses at
the declaration by name: "function f returns unknown, which has no Prepared result contract" (`object` for `as
unknown as object`) — `ProgramDynamicContracts.propagatedResult` in `src/ir/source-dynamic-contracts.ts`, called
where `src/ir/program-source.ts` used to fall back to void. A body that returns only `undefined` (type
`undefined`/`void`) stays void (pinned by #7188's internal-declaration tests). The dynamic result contract was not
widened to `unknown`: the implicit-flow rule would then refuse every `return` into the `unknown` context, so it is
not a clean fit. Cost: such a function called only as a statement compiled before (its value was dropped) and now
refuses.

**Should-fix 2: seven standalone programs that compiled on H changed Prepared bytes** (un-annotated functions
returning a Boolean, e.g. `function f(v) { return v === 1; }`). Measured on that program (H vs this branch, WAT
diff): the function body is identical; the only change is the type section — `f` gets its own function type
`(func (param externref) (result i32))` instead of sharing the structurally identical type of the runtime's
`__typeof_number` / `__unbox_boolean`, and the `<module-init>` / `__module_init` type indices shift by one. The
Boolean result contract makes the result a Boolean-branded `i32`, which the presentation keys separately from a
plain `i32`. The two types are structurally equal (one-entry recursion groups canonicalize to the same type), so
the behavior is unchanged; it is right because the result now carries its Boolean meaning to the caller (a caller
boxes it as a Boolean, not a number). Folding the duplicate type is a possible size clean-up, not a correctness
issue.

**Also:** the T test helpers yield one event-loop turn before each compile (`compileYielding`): the file now runs
long enough that vitest's worker RPC timed out between compiles. `tests/issue-7354-x-dynamic-throw.test.ts` and the
H test show the same unhandled RPC timeout under the current machine load on their base as well (all tests pass).

### Review round 3

**Verdict NOT MET on one must-fix, pre-existing on H:** a `&&` / `||` whose value is unused dropped its right
operand. `function f(a, b){ a > 0 && boom(b); return 0; } f(1, 1);` returned (node throws); the same with `||`, at
top level, in an unread local and with a counter (`inc` never ran). The reviewer confirmed value and condition
positions and evaluation order correct over a 270-program cross product; a `?:` statement was correct.

- **Cause and fix:** #7359 (the H follow-up record "unused `&&` / `||` keeps its right operand"): the value `if` was
  the only buffer-bearing IR kind `isSideEffecting` judged without its buffers, so DCE and the lowerer dropped it
  when its result was unused. It existed on main for typed TypeScript and on the ordinary pipeline; T made the
  dynamic forms reachable. Merged here from `claude/7354-logical-unused`.
- **Sweep** (`.tmp/tsweep.mts`, not committed): `&&` / `||` × left ∈ {typed Boolean `(a > 0)`, dynamic `a`, typed
  number `(a * 1)`} × right ∈ {dynamic `inc(b)`, typed Boolean `(inc(b) > 0)`, typed number `(inc(b) * 1)`} ×
  {statement, unread local, top level, loop body} × a ∈ {0, 1} × (counter, wrong counter, throwing call): 432
  programs, **240 equal node, 192 named refusals ("operator '&&' requires bool operands" — every typed number
  operand), 0 wrong**; without the fix 80 were wrong. Tests: "review round 3" in
  `tests/issue-7354-t-truthiness-null.test.ts` (both operators × Boolean / dynamic left × dynamic / Boolean right ×
  the four positions, counter and throw, plus the typed number refusal; 32 of them fail without the fix).
- **Merge with Str (main `f8cfc8c0ff`):** Str lets a native string reach the dynamic carrier, and T's ToBoolean body
  had no string arm (`function f(v){ return v ? 1 : 0; } f("")` answered 1 after a plain merge). ToBoolean now takes
  the string arm (empty is falsy) whenever the value lane carries native strings
  (`src/backend/wasmgc/resources/native-dynamic-values.ts`); the selection keeps Str's `strictEqStrings` beside T's
  `toBoolean`. Tests: "T after Str" (conditional, `if`, `||` operand, `!v` on `""` / `"a"`; all 4 fail without the
  arm).

### Review round 4: MET

T MET, X MET at `838688fd5f`, no must-fix.

- **Strings and ToBoolean:** 120 string-ToBoolean programs equal node — values `""`, `"a"`, `" "`, `"0"`, `"false"`,
  `"\0"` and a 3000-character string × positions `if`, `!`, `!!`, `?:`, `while`, `&&` / `||` as condition and as
  value. The reviewer found no path by which a string reaches ToBoolean without the string arm. X with strings is
  correct.
- **Census:** forgeries of the `to_boolean` provider, of `__is_truthy` and of the five string type rows are refused
  by name.
- **Re-runs:** the 94 T probes and the 127 X probes of the earlier rounds, no regression. Both mutants of the string
  arm are killed.

Should-fixes, both recorded under "Known gaps (T and X)" below:

- (a) the confusing refusal of an `any`-annotated local holding a string or a number;
- (b) the "redeclaration of 'e'" refusal of a catch parameter that shadows a `var`.

### Known gaps (T and X)

- **(a) An `any` local outside every dynamic contract refuses without naming its cause.** `function g(c: number):
  number { let v: any = c > 0 ? "" : 1; return v ? 1 : 2; } if (g(1) !== 2) throw 1;` (`test.ts`, standalone)
  refuses "wasmgc:standalone physical setup cannot be materialized (1 gap): body g has no accepted host async dynamic
  carrier". The same refusal is on main without T (checked on `c105fc1cc0`).
  - **Cause:** `legalizeSourceDynamicValues` (`src/ir/source-dynamic-contracts.ts`) legalizes a program only when it
    has a dynamic contract: an `any` / untyped parameter or result, a dynamic script `var`, or a catch binding. That
    gate is deliberate — from-ast also boxes values into dynamic ones internally in programs without a contract
    (pinned by `issue-3518-native-string-number-source-admission`). Here the only dynamic value is an annotated
    local, so `g` stays unlegalized. The first stage that sees the leftover dynamic type is the host async planner
    (`src/ir/program/host-async-dynamic.ts`), and its message is about host async frames.
  - **Why not fixed here:** naming the cause means making the contract gate recognise an `any`-annotated local and
    then re-sweeping the flow rule over such locals. That is a change of the gate, not of one message. Rewording only
    the planner's message would still not say what caused it.
  - Without `: any`, or in a `.js` file, from-ast refuses earlier by name: "ternary branches have different types
    (string vs f64)".
- **gc target, pre-existing: an invariant error out of `compile()`.** `var c = 1; let v: any = c > 0 ? "" : 1; if
  (v) throw 1;` (`t.ts`, target `gc`) throws `IrProgramDriverInvariantError` "ir/from-ast: #5092 dynamic carrier is
  unavailable or incompatible in <module-init>". The same happens on `c105fc1cc0` (main plus #7359, without T). The
  same program on standalone compiles and answers like node. Found while checking (a); not touched here.
- **(b) A catch parameter shadowing a `var` refuses.** `function f(v){ var e = 5; try { throw v; } catch (e) { }
  return e; }` refuses "redeclaration of 'e'". This comes from the hoisted-var fix (#7290): a catch parameter counts
  as a second binding of the `var` name. It belongs to the "one slot per `var` name per function" follow-up (see
  Known gaps (H)) and is left unchanged.


## Slice O: Implementation Plan (2026-11-19)

Branch `claude/7354-o` on `claude/7354-perf2` (`503ff2cb4d`). Lead decision of 2026-11-19: option A, in four steps
O1 to O4 (these are this slice's steps, not #7352's parked ordinary-pipeline slice of the same name).

### What exists, measured on the base

- `var o = { a: 1 }` (script level) refuses: "proven dynamic binding 'o' initializer has no supported carrier".
- `function f(){ var o = { a: 1 }; return o.a; }` is accepted and then fails at emission: "resolver cannot lower
  object<a:f64>" (the closed-struct `object.new` the ordinary selector would have refused; the "object literal inside
  a function throws an emission invariant error" of the P census).
- `var o; o.x` refuses: "dynamic operation dyn.member_get has no Prepared intrinsic".
- The source contracts `js.object.{create-default, create-null, create-with-prototype, define-data, define-accessor,
  define-attributes, get, has}` (`src/ir/runtime/ordinary-object-callables.ts`) are declared, but none materializes:
  an accessor literal fails with "intrinsic callable js.object.get … needs runtime function materialization"
  (`program-physical-plan.ts`, the fall-through of the required-callable loop). There is no `set`.
- The realm (`src/backend/wasmgc/program/native-realm.ts`) is reserved whenever a program has a `js.object.*` use.
  Its builtin-object kernel (`native-builtin-functions.ts`) already owns the object protocol the source needs:
  `objectPrototype` (the realm's Object.prototype, initialized on first use), `lookup` / `get` over ordinary
  `$Object`s and builtin function objects (status + value, accessor entries dispatched through `method0`),
  `has`; the storage pack owns `createWithPrototype`; the descriptor pack owns `defineData`. With no source
  closures the realm builds its own closure population (`beginRealm`), so a program without closures needs nothing
  from slice Fa.
- `reserveNativeObjectGetResources` and the provenance gaps in `native-object-access-requirements.ts` belong to an
  older design (static creation provenance per receiver). #3518 has no live claim (released 2026-09-03).

### Target structure

- **One public object family on the realm, one binding arm.** A new resource module
  `src/backend/wasmgc/resources/native-source-objects.ts` reserves, inside the realm kernel's reservation, one
  public function per `js.object.*` feature the program uses, with exactly the declared signature. Each is a thin
  adapter over the kernel/storage/descriptor function that already implements it (bodies in a pure builder module
  `src/runtime/wasmgc/values/source-object-bodies.ts`):
  - `create-default` = `createWithPrototype(objectPrototype())` (an explicit Object.prototype link, so the kernel's
    lookup never meets the "implicit prototype" state);
  - `define-data` = the descriptor pack's `defineData` (CreateDataProperty on the literal's fresh object);
  - `get` = kernel `get`, status folded (absent answers `undefined`; status 2/3 cannot occur for a receiver
    built by `create-default`, and the adapter makes that a trap with a named invariant comment);
  - O3 adds `set` = OrdinarySet here, beside `get`.
- **Plan side.** `program-physical-plan.ts`: the required-callable loop's fall-through gains one arm for the
  ordinary-object family, fed by a binding list built like `nativeInvocationAbiBindings` (one row per distinct
  call route, resource key `<realm key>:source-object:<feature>`). The two binding builders share one helper
  (`nativeCallableAbiBindings`) instead of a second copy.
- **Consumer side.** `program-consumer.ts`: `reconcileInvocationBindings` becomes the one
  `reconcileNativeBindings(rows, functions, context)` used for invocation and source-object rows.
- **Front end (O1).** The Prepared resolver's ordinary-object plan (`src/frontend/builtins/prepare-ordinary-object-access.ts`)
  extends from accessor literals to data-only literals; from-ast's existing `lowerOrdinaryDescriptorLiteral` (renamed
  `lowerOrdinaryObjectLiteral`, it already lowers data members through `define-data` with mask 191) builds them. No
  second literal lowering.
- **Dynamic value (O2).** `dynamic-value-legalization.ts` gains the `object` carrier kind as one row in each
  `Record<CarrierKind, …>` table (`KIND_TEST`, `TO_STRING_ARM`, `ADD_ROLE`, typeof answer). A box of an ordinary
  object is the externref itself. Its kind test is a new `js.value.is_object` intrinsic in the dynamic-value
  family (`dynamic-value-callables.ts`, one row). `+` and ToString on an object refuse by name until
  ToPrimitive exists (the table row says so).
- **Member access (O3/O4).** `dyn.member_get` / `dyn.member_set` legalize to one kind chain built by the existing
  `kindChain`: `undefined`/`null` → TypeError (`emitThrowTypeErrorIfNullish`'s message), object →
  `js.object.get`/`set`, a primitive kind → refusal by name at legalization ("member read of a primitive needs
  its wrapper prototype"), recorded as the next gap for slice B / #7350.

### Reused, and what duplicate goes

- Reused: the realm kernel's object protocol, the storage and descriptor packs, the dynamic-value tables and
  `kindChain`, `lowerOrdinaryDescriptorLiteral`, the invocation binding builder and reconciliation.
- Removed duplicate: the per-family binding builder/reconciler pair becomes one parameterised pair. The static
  provenance gaps that the runtime-typed adapters make obsolete are deleted, not bypassed (each named in the step's
  commit).

### Acceptance

- O1: `function f(){ var o = { a: 1 }; return o.a; } if (f() !== 1) throw 1;` validates and runs through the
  strict entry; a wrong answer throws; node agrees.
- O2: `var o = { a: 1 }; if (o.a !== 1) throw 1;` at script level.
- O3: the ladder's program `var o = { a: 1 }; o.b = 2; if (o.a + o.b !== 3) throw 1;`.
- O4: `var o; o.x` throws a catchable TypeError; `var s = "a"; s.length` refuses by name.
- Each step: refusals left pinned by name in `tests/issue-7354-o-objects.test.ts`; mutation checks on every new
  table row and arm; ordinary-pipeline bytes identical on the 100-file sample × JS and standalone; the 411-row
  sample tallied before and after.
- Code quality: one binding arm and one reconciler for every native callable family; one row per kind in each
  dynamic-value table; no adapter re-implements a kernel algorithm; no file or function over its budget without a
  dated grant.

### O2–O4 design, revised (2026-11-19, after O1)

- **The object kind.** `CarrierKind` gains `object`, last in `KIND_ORDER`, so every total chain reaches it untested.
  Its kind test is the complement of the others (`KIND_TEST.object = "complement"`: no other admitted kind), exact
  because the admitted set is exact; a later kind (Fa's `function`) gets its own test and leaves the complement
  right. `typeof` answers `"object"` for `null` and `object` (the `string.eq` arm tests the union). A box of a value
  whose producer is `js.object.create-default` is the object kind; any other reference still refuses.
- **ToPrimitive of an ordinary object, with a checked precondition.** OrdinaryToPrimitive of an object built by
  `create-default` on the realm's pristine Object.prototype, in a program that stores no callable into an object and
  defines no own `toString` / `valueOf`, answers `"[object Object]"` for every hint (ToNumber: NaN). The legalization
  asks one program-wide predicate (`objectsArePlain`): no `define-accessor`, no callable value stored by
  `define-data` / `set`, every defined or set key a string constant other than `toString` / `valueOf`, and no
  producer of a realm object other than `create-default`. When it does not hold, the object arm of ToString, `+` and
  ToNumber refuses by name. The arm is also keyed on the kind table: a compile-time assertion that `CarrierKind` has
  no callable kind fails the build when Fa adds one, so the arm cannot outlive its precondition silently.
- **Member read (O4).** `dyn.member_get(receiver, key)` with a constant key legalizes to one kind chain over the
  receiver: `undefined` / `null` throw a TypeError (the source `__new_TypeError` call binds the realm errors pack's
  constructor, one more realm-served row); `object` is `js.object.get(receiver, key, receiver)`; a primitive answers
  `undefined` when the key names no property of its wrapper prototype or Object.prototype (a fixed list from the
  specification, plus `length` and array indices for strings) under the same pristine-prototype precondition, and
  refuses by name otherwise. A non-constant key refuses by name.
- **Member write (O3).** `js.object.set` = OrdinarySet on the realm (a contract beside `get`, an adapter over the
  kernel's lookup and the descriptor pack's define); the same receiver chain, a primitive receiver refusing by name.
- **Catch.** The program-wide throw rule applies only where the program binds a catch: a TypeError thrown from a
  member read is no carrier kind, so a program that also catches refuses by name until an error kind exists.

- **for-in (O5, #7377).** `for (k in o)` over an ordinary object (188 files in the ES5 sample) is its own lane,
  stacked on `claude/7354-o` after O3: it enumerates the realm object's own enumerable string keys in insertion order
  under the same pristine-prototype precondition, and refuses by name otherwise.

### O4 result (2026-11-19, `claude/7354-o` 53357b3b9f)

- Built as designed above, in `src/ir/program/dynamic-member-read.ts`. The prototype key lists are in
  `builtin-prototype-keys.ts`, and the gap error is in a leaf, `dynamic-value-gap.ts`, so `legalizationBuilders`
  stays under its function budget. The source `__new_TypeError` call is the contract `js.object.create-type-error`,
  served by the realm errors pack's existing constructor.
- The get adapter traps only on an unknown carrier (status 3); an incomplete parent (status 2) reads `undefined`,
  because every key the realm's prototypes would hold refuses at the call site.
- Integration (lead, 2026-11-19): the perf2 base's `backend->ir` edge (`native-string-values.ts` ->
  `settled-verdict.ts`) is granted in this file's frontmatter, and `settled-verdict.ts` is classified. `ProgramObjects`
  and `NO_OBJECTS` live in `dynamic-value-kinds.ts`, so the clean `ir-program` modules do not reach the
  frontend-side predicate `source-plain-objects.ts`.
- Open for whichever of O and Ty (#7327) lands second: the Str2 pin "typeof String" in
  `tests/issue-7354-str2-to-string.test.ts` still expects `identifier "String" is not in scope`. After Ty, it
  answers from the realm table.

### O2b: runtime-guarded ToPrimitive (plan, 2026-11-19, branch `claude/7354-o-toprim` from `claude/7354-o` 0c7109594b)

Why: on the harness prelude the static plainness rule (`programObjects`) never holds (61 reasons on assert.js +
sta.js + propertyHelper.js + compareArray.js), so every ToPrimitive of the object kind refuses. Among them are
assert.js `message += …` and sameValue's `1 / a`.

Semantics (§7.1.1, OrdinaryToPrimitive §7.1.1.1), decided at run time:

- No admitted carrier kind is callable. The carrier's coercion gate refuses a callable property value (a getter, a
  function value), so a conversion method the object holds is never callable, and OrdinaryToPrimitive skips it
  (step 2.b). An absent one is the realm's Object.prototype method: `valueOf` answers the object, which is not
  primitive and so is skipped too, and `toString` answers `"[object Object]"`.
- So for every hint the answer is: HasProperty(o, "toString") ? TypeError : `"[object Object]"`. ToNumber of it is
  NaN, and `+` concatenates it. `valueOf` cannot change the answer until a callable kind exists.
- A compile-time kind pin in the builder fails the build when Fa admits a callable kind. The arm then has to Get and
  Call the method in hint order. No unreachable abort arm is emitted for a callable method.
- "Absent" means kernel lookup status 0, or 2, a miss at the realm's Object.prototype, which does not hold the
  specification's properties yet. Status 3 traps, as in the get adapter.
- `@@toPrimitive` (step 2) is reachable only by naming `Symbol`. Such a program refuses by name: "ToPrimitive of an
  object in a program that names 'Symbol'".
- The TypeError the legalization synthesizes (this arm, and O4's nullish member read) is thrown through
  `js.object.create-type-error` in a program without a catch. In a program that catches, a catch would read it as a
  dynamic value, and no carrier kind holds an error yet. So the program fails loudly there, through
  `js.object.uncatchable-type-error`: an interim (lead, 2026-11-19), never a wrong answer, only a failure. It
  replaces O4's refusal "member read … of a possibly nullish value in a program that catches".
- **Follow-up.** Lane S13 (`claude/7354-shared-exn`, from `claude/7354-o` 0c7109594b) builds one exception tag
  shared by realm and source throws. Once it lands, a source `catch` catches realm errors, and the one helper
  (`typeError` in `dynamic-realm-calls.ts`) throws in catching programs too. Then `js.object.uncatchable-type-error`
  and its realm row are deleted. That is a one-place change: no other code synthesizes a TypeError. #7368's
  catch-guarded "REALM_REJECTING" path can move onto the same helper; its signature is
  `typeError(builders, message, catches) → IrInstr[]`.

Target structure:

- `src/ir/program/ordinary-to-primitive.ts` (new, beside `dynamic-member-read.ts`) is the one OrdinaryToPrimitive
  builder. The `object` rows of `TO_STRING_ARM` and `TO_NUMBER_ARM` (renamed `"plain-object"` → `"to-primitive"`)
  call it; ToNumber reads its string as NaN. It also carries the kind pin.
- `src/ir/program/dynamic-realm-calls.ts` (new) is the one `js.object.*` call builder (it replaces dynamic-member-read's
  local `call`) and the one synthesized-TypeError helper (throw, or the uncatchable failure in a catching program).
- The realm adds two rows to `ROWS` in `native-source-objects.ts`, with bodies in `source-object-bodies.ts`:
  `js.object.has`, an adapter over the kernel's `has` (status 1 → true, 0 and 2 → false, every status ≥ 3 traps,
  exactly like the get adapter, so B2b's status 4 is never read as absent), and the new
  contract `js.object.uncatchable-type-error` (`[] → []`, body `unreachable`).
  - It is a call contract, not an intrinsic as first proposed. Every intrinsic is certified pure
    (`analysis/intrinsics.ts`, `effects.ts`), so dead-code and GVN passes could drop or merge a trap whose result is
    unused.
- `ProgramObjects` keeps one walk and returns the answers its consumers ask:
  - `present` (the object kind is admitted);
  - `namesSymbol` (ToPrimitive);
  - `unplain`, the first way code can reach a built-in prototype: it names a prototype global, or reads
    `prototype` / `__proto__`. The field keeps its O2 name, so S5's B2b (which adds a field) merges cleanly.
  The O4 member read keeps that last gate, now on its primitive arm only: the object arm is the realm's exact [[Get]].
  The ToPrimitive-only reasons go: literal members, function values, member writes, `toString` / `valueOf` keys.
  The checker parameter goes with them.
- `plainObjectRefusal` and `plainObjectToPrimitive` are deleted.

Reused: `kindChain`, `branch`, `text`, the realm kernel's `has` / lookup, the errors pack's TypeError, and the
source-object `ROWS` binding arm. Duplicate removed: the TypeError construction in `dynamic-member-read.ts`, now
the shared helper, and its local call builder.

Acceptance:

- `""+o`, `o+"!"`, `+o`, `1/o` on a plain object, in a program that is not plain by the old rule (it names
  `String`), give node's answer.
- `message += " "` on a string-valued dynamic value in a program that builds objects gives node's answer.
- `{toString: undefined}` and `{toString: 1}` throw a TypeError where node does (no catch). `{valueOf: 1}` gives
  `"[object Object]"`.
- The same TypeError cases in a catching program trap (WebAssembly.RuntimeError).
- The Symbol refusal is pinned by name.
- Mutations: the arm treats a present `toString` as absent; the Symbol refusal is removed; the arm skips the
  `valueOf` read (an equivalent mutant by construction, see above).
- Code quality: one OrdinaryToPrimitive builder for ToString, ToNumber and `+`; one realm-call builder and one
  synthesized-TypeError helper for both arms that raise one; one row per realm contract; no function or file over
  budget; ordinary-pipeline bytes identical.
### O3 plan (2026-11-19, `claude/7354-o3` from `claude/7354-o` 0c7109594b)

Measured on the base (Prepared entry, standalone): `var o = { a: 1 }; o.b = 2; …` refuses "property assignment on
dynamic is not in slice 4"; `function s(v){ v.k = 3; } …` the same; `function f(){ var o = { a: 1 }; o.a = 2; … }`
refuses "property assignment on externref is not in slice 4", and a read of such a function-local object without a
typed plan refuses "box of a non-primitive value" (the box arm admits an object only under the Object tag).

- **Contract (`js.object.set`).** One declaration in `ordinary-object-callables.ts` and one manifest row, appended
  after `create-type-error`: `(object, key, value, receiver) → boolean`, OrdinarySet (§10.1.9.2). The realm serves it
  as one adapter row in `native-source-objects.ts` (`ROWS`), its body in `source-object-bodies.ts` beside `get`. No
  kernel function is OrdinarySet over an ordinary `$Object` (the kernel's `writeOwn` works on builtin-function bags),
  so the body composes the kernel's `lookup` (the same walk `get` uses) and the descriptor pack's public define: a
  writable data entry, or none found, is CreateDataProperty on the receiver (mask 191). Under O's plain-objects
  precondition every own property of a source object is writable, enumerable and configurable (a literal's
  define-data or this set), so that define and OrdinarySet's `{ [[Value]] }` define agree. Its other answers (a
  setter call, `false` for a read-only property) and an unknown carrier trap, like `get`'s status 3: no plain
  program reaches them.
- **Legalization arm.** `dynamic-member-read.ts` becomes `dynamic-member-access.ts`: one chain for both accesses,
  `MEMBER_READ_ARM` becomes `MEMBER_ACCESS_ARM` (GetV and PutValue both throw for a nullish base, go to the object's
  internal method for an object, and to the wrapper prototypes for a primitive). The shared part (the constant key,
  the plain-objects refusal, the nullish TypeError with its catch refusal, the Object.prototype key refusal, the
  chain) is written once; each access supplies only its object call, its primitive arm and its result type. An
  object write needs no failure branch: every key that could make OrdinarySet answer `false` refuses at compile time.
- **A write to a primitive (revised while building).** Refusing it by name, as first planned, refuses every write
  through a dynamic receiver of unknown kind, the proving program's `o.b = 2` on a script var included. With pristine
  prototypes the wrapper's [[Set]] answers `false` for every key a plain program writes (no setter but `__proto__`'s,
  which is unplain; data properties are read only or land on a receiver that is no object), so PutValue is a no-op in
  sloppy code and a TypeError in strict code: the arm reads `dyn.member_set`'s `sloppy` bit, and the strict TypeError
  takes the nullish arm's throw, with the same refusal in a program that catches.
- **Prepared emits `dyn.member_set`** (coordinator decision of 2026-11-19, replacing a move of
  `is-strict-function.ts`, whose path hash-pinned receipts name). `IrProgramSourceInput` gains one compiler-supplied
  input, `codeStrictness(node)` for a function or a source file's code; `src/compiler/prepared-code-strictness.ts`
  builds it from `isStrictContext` with the `inferModuleStrictArguments` option, the call the ordinary pipeline's
  `irFunctionCodeStrictness` makes, so `src/ir` imports no codegen helper. The producer sets `functionCodeStrict`
  from it through one helper (`sourceCodeStrictness`), so `prepareIrProgramSources` does not grow past its budget.
  Lane S11 derives its `this` binding from the same input later. from-ast's externref receiver of a member write
  takes the read's arm (box onto the carrier), so the function-local object case writes too, and the box arm admits
  an object by its producer (`js.object.create-default`) whatever the box's tag.
- **Typed-read soundness.** No change: the reference scan already drops a written binding's typed plan. One run
  test pins it (`o.a = 2; return o.a` answers 2).
- **Code-quality acceptance.** One member-access chain and one arm table for reads and writes (no second key/receiver
  walk); one adapter row for the new contract; no adapter re-implements the kernel's lookup; one definition of code
  strictness, which `src/ir` receives as an input; no function or file over its budget without a dated grant.

### O3 result (2026-11-19, `claude/7354-o3`)

- The proving program `var o = { a: 1 }; o.b = 2; if (o.a + o.b !== 3) throw 1;` returns through the strict
  Prepared entry, standalone; with `===` it throws; node agrees. Also run: an own member overwritten, a member added
  to `{}`, a write through an unannotated parameter, a nested object's member, a function-local object's written
  member (reads 2, not the initializer's 1), a sloppy write to a primitive (ignored); a write to `undefined`, to
  `null` and (strict) to a primitive throws. `tests/issue-7354-o3-member-write.test.ts`, which also drives the set
  adapter's Wasm body over a stub lookup.
- Named refusals: a computed key ("dyn.member_set with a computed key"), an Object.prototype key, and a write that
  may throw (nullish, or strict on a primitive) in a program that catches.
- Pins moved: O's "O3: a member write" (now runs); H's "given a property by a member write" (now a run row); D1's
  "a dynamic object field" (the read of a function-local object now boxes it by its producer, so it runs).
- Mutations, each failing its tests: the object arm calling `js.object.get` (the right answers throw); the nullish
  arm answering without its throw (the nullish writes return); the `sloppy` bit inverted (the sloppy primitive write
  throws, the strict one returns).
- Ordinary-pipeline output byte-identical on the 13 playground examples and 11 member-write snippets (strict and
  sloppy, dynamic, untyped, literal, accessor-literal, catch-binding, open-carrier, script-var and element writes),
  each default and standalone.

### O2b result (2026-11-19, `claude/7354-o-toprim`)

- Built as planned above. The one builder is `ordinary-to-primitive.ts`. `dynamic-realm-calls.ts` holds `realmCall`
  and `typeError(builders, message, catches)`. The realm rows are `js.object.has` and
  `js.object.uncatchable-type-error`.
- After the merge onto O3, `dynamic-member-access.ts` takes the helper for reads and writes (its copy of the TypeError
  and its two catch refusals go). The prototype gate sits on the primitive arm of both accesses.
- Programs that run and agree with node (tests/issue-7354-o2b-to-primitive.test.ts):
  - `""+o`, `o+"!"`, `+o` and `1/o` in a program that names `Object`;
  - `message += " "` on a string in a program that builds objects;
  - `{ valueOf: 1 }`.
- TypeError cases that throw as node does: `{ toString: undefined }` and `+{ toString: 1 }`. The same in a program
  that catches traps (WebAssembly.RuntimeError), as do O4's nullish read and O3's throwing writes there.
- The `Symbol` refusal is pinned by name. The has adapter is pinned on statuses 0/1/2 and traps on 3, 4, 0x7fffffff
  and -1.
- Mutations, each failing its tests:
  - a held `toString` treated as absent: 3 tests fail;
  - the Symbol refusal removed: 1 test fails;
  - `valueOf` probed instead of `toString`: 3 tests fail.
  "The arm skips the `valueOf` read" is an equivalent mutant: there is no `valueOf` read while no kind is callable.
- Ordinary-pipeline bytes are identical against `claude/7354-o` 0c7109594b on the 13 playground examples, default
  and standalone (26 hashes).
- 411-row sample (`TEST262_COMPILER_PATH=ir`, standalone):
  - every run passes 20: integration 94abeb8347, the integration with O merged (`9426e5e1c2`), and that plus O2b
    (local merge, not pushed).
  - Before O2b, the first gap of 301 rows is "ToPrimitive of an object (an object property holds a function)".
    After it, those same 301 rows stop at "dyn.json_stringify has no Prepared intrinsic". That is assert.js:27,
    `JSON.stringify(value)` in `formatIdentityFreeValue`, the prelude's only `JSON.stringify`. ToNumber of the
    object kind (`isNegativeZero`'s `1 / value`, line 17) no longer stops it.
  - The other first gaps are unchanged ("module binding … has no exact typed storage", `assert` not in scope in
    `verifyProperty`).
- **For the integration merge.** The integration admits Fa's `function` kind, so the kind pin in
  `ordinary-to-primitive.ts` fails the build there, as designed. The local measurement merge resolved it like this:
  - read each held `toString` / `valueOf`, and test it with `js.value.is_function`;
  - if either is callable, fail loudly, because calling it needs Call on a function value;
  - otherwise keep the arm's answer.

  Fa's `TO_NUMBER_ARM.function: "nan"` sits beside the object row's `"to-primitive"`. The integration's
  `ProgramKinds` carries `catches`, which the builder takes as it is.

## Realm join (2026-11-19, branch `claude/7354-realm` from `origin/main`)

The native realm of #3518 (`src/backend/wasmgc/program/native-realm.ts`) is reserved for any program with a
`js.object.*` use, a `Number(v)` use or source closures, but nothing let such a program present: the physical plan
had no arm that binds a source call to a realm function, and the Prepared runtime census joined only the native
string and formatter setups. This branch builds the shared join, and its first row, the source objects of slice O
(step O1). Lane S4 (slice Fa) adds the closure/invocation owner as one more row.

Review round 2 (RV7312, branch `claude/7354-realm-r2b`): the property-key fold moved to
`src/shared/property-key-fold.ts`, so the resolver and the lowering share it and `{ ['a']: 3 }` runs again; both
carrier rules ask one predicate (`carrierKind`: dynamic, string, boundary-boxed number or Boolean, `null`), and the
throw rule binds only a program with a catch binding; the reference scan sees `{ o }` shorthand references and has
resolver-level tests; the #3525 allocation and method-key pins and the #3518 callable-contract pin follow the new
shape.

### Built

- **Census join.** The consumer records the physical indices of the realm's completed functions, types and globals
  (`nativeRealmCompletedSlots` in native-realm.ts, read through `emittedNativeRealmSlots` in program-consumer.ts),
  authenticated by the realm's own `requireCompletedNativeRealmBootstrap`. `runtimeCensus`
  (`src/compiler/prepared-provider-census.ts`) excludes those functions from the support-receipt join and adds the
  types and globals to the native setup's slots, so the presentation's widening finalization owns them.
- **One call-binding builder and reconciler.** `nativeInvocationAbiBindings` became a caller of
  `nativeCallAbiBindings` (native-invocation-abi.ts); `reconcileInvocationBindings` became
  `reconcileNativeCallBindings`, used for invocation and source-object rows; the two consumer lists of native binding
  families read `plannedNativeCallBindings` (program-physical-plan.ts).
- **Source objects (O1).** `native-source-objects.ts` serves the `js.object.*` contracts on the realm:
  `define-data` binds the descriptor pack's public define as it is; `create-default`
  (`createWithPrototype(objectPrototype())`, an explicit Object.prototype link) and `get` (the kernel's [[Get]], its
  incomplete states unreachable) are adapters in `source-object-bodies.ts`. `native-source-object-abi.ts` builds
  the plan rows; a contract without a provider is a plan gap by name. The Prepared resolver
  (`prepare-ordinary-object-access.ts`) makes every literal it owns an ordinary object (the Prepared backend has no
  closed object struct: this replaces the "resolver cannot lower object<…>" emission crash) and plans typed reads
  of a data-only literal whose binding is only read as `o.k`. Member values cross into the object through the
  number-boundary boxes (`boundaryBox` in from-ast, shared with `throw`), so a literal adds no dynamic value.
- **Carrier rules.** `coerce.to_externref` of a dynamic value keeps (the carrier is the native value an object
  property stores, as it is the exception payload); every throw of the program must be a carrier-admitted value
  (`refuseUnadmittedThrows`, run over every function on the native dynamic lane, after legalization so its own gaps
  keep their names), so an object cannot reach a catch binding before the carrier admits objects.

### Measured

- Proving program `function f(){ var o = { a: 1 }; return o.a; } if (f() !== 1) throw 1;` through the strict entry,
  standalone: validates and returns; with `!== 2` it throws; node agrees. `tests/issue-7354-o-objects.test.ts`.
- Pins updated: D1 "a typed literal property" (now D1's flow rule), "a dynamic object field" (now the untyped member
  read), D1/X "dynamic externref coercion" (now kept); X object throws (now "throw of a value outside the dynamic
  carrier's kinds").

### Compile time: the reservation audit is quadratic (for the perf lane)

With the realm in the module one compile of the proving program takes about 18 s (33 s on a loaded box). A CPU
profile (`node --cpu-prof`) of that one compile, after a warm-up compile:

| ms (inclusive) | entry |
| ---: | --- |
| 16,006 | `PhysicalModuleReservations#verifyLayout` (`src/wasm/physical/module-reservations.ts`) |
| 11,588 | `#snapshot` / `dataText` |
| 8,743 | `physicalIndex` |
| 6,342 | `fillNativeRealmResources` |
| 3,842 | `requireOwner` (native-object-descriptors.ts) |
| 3,799 | `#matchesFunction` / `matchesPhysicalDataSnapshot` |

`#verifyLayout` re-snapshots every reservation record on each `physicalIndex()` call unless an outer `audited(…)`
covers it, and the realm's fill and owner checks call `physicalIndex` thousands of times, so the cost grows with the
square of the reserved resources. Reproducer: `.tmp/prof.mts` pattern, i.e. compile the proving program above twice
through `src/test262/test262-prepared-entry.ts` (options `wholeProgram: prepared-program-required`, `wasmgc`,
`standalone`, `allowJs`) and profile the second.

### Review round 3 (2026-11-19): APPROVE on 39b631a9c6, then the exception-handling fix

- **Mixed exception handling (found by S4 on CI's Node 25).** A realm module whose program has a user `try` mixed the
  legacy `try … catch_all … rethrow` of three realm bodies with the `try_table` the user `try` lowers to. Node 25
  (V8) rejects such a module at validation; Node 22 accepts it, and no #7312 test compiled a program with a `try`.
  - Fix: on `claude/7354-realm-eh`, the realm bodies switch to `buildStandardTryTable` on the module tag (#6641).
  - Guard: `tests/issue-7354-realm-eh.test.ts` asserts the module text has no legacy EH instruction beside the
    `try_table`, so it holds on any Node.
  - A search of src found no other legacy-EH emitter on the Prepared path: the IR emitter already turns `rethrow 0`
    into `throw` inside a `try_table`, and the legacy sites left are in `src/codegen/` (the ordinary pipeline).
- **Filed:** the IR-side source-object planner that would leave `native-invocation-abi.ts` one concern (#7407).
- **Open nits (non-blocking):**
  - A parenthesized literal receiver (`({a: 4, b: 5}).b`) refuses ("box of a non-primitive value"). Unwrapping the
    parentheses in the resolver alone is NOT enough: the program then compiles but answers wrong (both the right and
    the wrong comparison throw), so the read lowering must peel the same parentheses. It needs its own test pair.
  - Gap details read awkwardly inside the generic wrapper ("dynamic operation throw of a value … has no Prepared
    intrinsic"); a gap could carry its own sentence.
  - `nativeRealmReservationInventory` records `owner.inventory` as a side effect of a query; a separate record step
    would be clearer.
- **Reviewer notes on the EH fix (non-blocking, APPROVE on f4c7cb8256):**
  - The realm guards catch only the module's exception tag. That is enough while the realm runs standalone only; a
    realm in a JavaScript environment would also see host exceptions and would need `catch_all_ref`/`throw_ref`.
  - The decoder test's `catch_all` pattern would also flag a legitimate `try_table` `catch_all` clause; it should
    match only the legacy `(catch_all` form once a realm body uses one.
- **Timeout (lead decision).** `tests/issue-3518-ordinary-object-runtime-providers.test.ts` "empty void closure
  bodies" ×2 run at 90 s instead of the global 35 s. Each case compiles a realm program twice (≈36 s locally, ≈39.5 s
  on CI). Restore the default once #7397, #7398 and #7365 land; #7397's issue file carries that as an acceptance line.

## Str2 result (2026-11-18, partial: steps (a) and (b) of four)

Branch `claude/7354-str2` = `claude/7354-tx` + Ty + Perf (merges keep every result section) + the commits below.
Stopped before the census admission of the number formatter, by the lead's rule ("stop after (b) if (c) needs more
than L"): (c) needs five presentation joins, listed under Known gaps.

Built:
- Merge join (Ty x Str): `TYPEOF_KIND` lists the string kind; `typeof v === "string"` is a tag test, new intrinsic
  `js.value.is_string` -> dynamic-value resource `__typeof_string`, body the new shared `buildExternRefTestBody`
  (`src/runtime/wasmgc/values/primitive-layouts.ts`), which the ordinary `__typeof_string` and BigInt `typeof` now
  compose too (same ops). Object-literal throw tested with `typeof` pinned at its invariant error (Known gaps).
- (a) `String(v)`: `prepareConversionResolvers` (`src/frontend/builtins/prepare-number-conversion.ts`, one body
  shared with the `Number(v)` plan) answers `isAmbientStringBinding` for the callee of a direct lib call; from-ast's
  existing `tryLowerAmbientStringToStringCall` lowers it. The `String` plan is not invalidated by an escape (the
  prelude has `String: globalThis.String` and `map.call(a, String)`): every rebinding refuses by name on this closed
  path (pinned), and any source file declaring `String` loses the plan (the checker reports a script's
  `function String` as the lib's; without the file check that was a wrong answer). `String` joins
  `PREPARED_PROVIDED_GLOBALS`. Typed Number::toString (`IR_NUMBER_TO_STRING_FN`: `String(1)`, a template's number)
  is retargeted to the one formatter binding `async.native.number-to-string` (`src/ir/program/number-to-string-target.ts`;
  the "async" in the name is historical — renaming it means renaming the hash-pinned declaration in
  `src/ir/runtime/native-async-callables.ts` and `IR_ASYNC_NUMBER_TO_STRING_FN`, #7358 territory). It used to be an
  invariant error out of compile() (templates did this on base already); now a named presentation refusal. The
  Prepared backend options carry the formatter's integer policy (`preparedNumberFormatOptions`, one env reading
  shared with codegen: `numberToStringIntegerBeforeScratch`).
- (b) `dyn.to_string` -> an IR `if` chain in the legalization, table `TO_STRING_ARM` (a Record over `CarrierKind`;
  the last kind is reached untested because the chain is total): string -> new intrinsic `js.value.as_string`
  (resource `__js_as_string`, `any.convert_extern; ref.cast AnyString`, string result resolved by type key in the
  recipe and the ABI join); number -> `js.number.unbox` + direct call to the formatter binding; boolean ->
  ToBoolean (its payload, no unbox policy) choosing "true"/"false"; undefined/null -> their names (string
  allocation sites from the source registry, now passed to the legalization). `v` is one SSA value; the chain has
  no effect of its own, so DCE of an unused result cannot drop an operand evaluation. Verified with the number arm
  stubbed locally; as committed, every `dyn.to_string` refuses at the presentation by name.

Measurements: 411-row sample (14 negatives pass every time): base 308 x `String` no plan (282
`formatIdentityFreeValue`, 26 `verifyProperty`); after (a) and after (b) 282 x `dyn.typeof has no Prepared intrinsic`
(`formatIdentityFreeValue`'s `switch (value === null ? 'null' : typeof value)`, assert.js:25 — a bare `typeof` value,
step 4), 84 module binding not-direct, 26 `assert` not in scope (`verifyProperty`). Ordinary bytes identical on 310
files (180 of the sample, String/typeof/template/addition dirs) x JS and standalone (13 CE on both). Tests: all
slice tests, prepared entry/runtime, #7188, #7359, 3518 pins green. Pins: INTRINSIC_IDS 44 -> 46; INTRINSIC_DEFINITIONS
successor -> c9f06f27 (predecessor step removes the two new rows); declaration receipt + EXTERNREF_TO_STRING (94 -> 95);
D1 selection pin; D1/P call sites pass an allocation registry.

Lane (lead's question): `mixed` is decided by captured callables with a Promise result; a sync program that calls the
formatter is not mixed, so it goes through `checkResourceDemand`. `checkMixedDemand` refuses any mixed program
outside wasmgc:host, so no async program presents on the standalone Prepared path; on the host target a mixed program
skips the census (host lane, sunset) — not reproduced here.

Known gaps: (c) census admission of the formatter. A sync `String(x)` program meets five presentation gaps: 3 x
"promise/reference callable contracts require an explicit boundary producer" (the kernels' scratch `support-ref`
contracts in `checkAbiExports`), "nondefaultable reference widening needs a separately authenticated physical
post-state", the census ("host provider or async demand ..."), and "source and prepared runtime must independently
prove no async/support demand" (`runtimeSupport.batches`). `String()` (no argument) refuses ("no exact AST-site plan").
Object-literal throw: invariant error out of compile() ("resolver cannot lower object<a:f64>"), pinned. Mutation:
the declaration file check, the retarget and the string tag test are killed by tests; the ToString arms,
`__js_as_string` and the string carrier in the ABI join cannot run until (c) and are unverified survivors.

### Str2 step 4: `typeof` as a value (2026-11-18)

A `dyn.typeof` that is not consumed by a literal comparison materializes its answer string with the same kind chain
as ToString (`kindChain` in `src/ir/program/dynamic-value-legalization.ts`; arms `TYPEOF_NAME[kind]`, i.e.
`TYPEOF_KIND` read backwards, so `typeof null` is "object" and a new kind cannot be missed). Proven against node
(right answer returns, wrong throws): every carrier value returned / in a local / as an argument / at top level,
`"x" + typeof v`, `typeof v === k`, `typeof a === typeof b` (same kind, other kind, null vs undefined), a local also
compared with a literal, loop iterations, the prelude's `switch (value === null ? 'null' : typeof value)`, statement
position and an unread local with a throwing operand (the throw still happens). Prepared bytes of 14 unaffected
programs (numeric, dynamic, throw, script var, typeof comparison, strings, loops; 11 compile, 3 refuse with the same
message) identical against the branch base 33f5e33878. Mutations killed: answer table inverted, chain cut one kind
short, the `String` declaration file check. Survivors: removing the `consumed` skip (only adds a dead chain);
`node.parent.expression === node` in `isAmbientStringBinding` (an argument `String` refuses as a value read anyway).
A Ty "like JavaScript" program (`"object"`) timed out at 35 s once inside a combined two-file run under load; it
takes 15 s alone, and the whole Ty file passes alone.

411-row sample after step 4 (14 negatives pass): 282 x "dynamic operation __ir_dyn_add has no Prepared intrinsic"
(first: `harness/assert.js:27`, `'"' + value + '"'` in `formatIdentityFreeValue`'s string arm), 84 x "module binding X
has no exact typed storage: not-direct" (`obj` 52, `x` 5, `proto` 4, `o` 4, `arr` 3), 26 x `ir/from-ast: identifier
"assert" is not in scope` (`verifyProperty`), 2 x switch-case lexical binding, 1 x `unknown class "Test262Error"`.
Dynamic `+` is not local: its number arm needs ToString's formatter, i.e. Str2-c.

### Hand-over: admitting the number formatter (Str2-c)

A sync `String(x)` (or `typeof`-free `"" + n`) program now reaches the formatter through one binding,
`async.native.number-to-string` (`src/ir/program/number-to-string-target.ts`), and meets five presentation gaps.

1. 3 x "promise/reference callable contracts require an explicit boundary producer" —
   `src/compiler/ir-program-presentation.ts:467-471` (`checkAbiExports`): every callable ABI entry's params/results
   must pass `inCall` (number, the dynamic externref, or `string`). The formatter kernels' entries
   (`numberFormatRadixSupportDeclarations`, `src/ir/program/formatter-support.ts:45-49`: `__nfd_new` result,
   `__nfd_get`/`__nfd_set`/`__nfd_fin` first param) carry the scratch type `support-ref`
   (`number-format-radix:scratch`, the string owner's mutable i16 data array). "Explicit boundary producer" names no
   existing mechanism: the only bypass is `mixed` (`!mixed &&` on the same line). Smallest sound admission: `inCall`
   also accepts a `support-ref` equal (data identity) to the canonical scratch type of the program's entry anchor,
   and only on an entry whose ref is one of the canonical kernel refs (binding identity) — the predicate in the
   census module, one call in the presentation. Not: admitting `support-ref` generally, or classifying the program
   as mixed.
2. "nondefaultable reference widening needs a separately authenticated physical post-state" — line 708-712,
   `referenceDemand` (line 226): any function local/body/type using a `ref` outside the census's `NativeSetupSlots`
   (types/globals) counts. It fires because the census returned nothing; with the string owner alone (slice R/Str),
   `nativeRows` hands its authenticated type/global slots back and the string refs are exempt. Admission: the census
   also returns the formatter setup's authenticated type slots (the Ryu table type) and globals (Ryu
   `inverse`/`powers`) — downstream of 3. Not: exempting `ref`s by type shape.
3. "host provider or async demand is outside this numeric presentation contract" — line 673-681, `runtimeCensus`
   (`src/compiler/prepared-provider-census.ts`, `nativeRows`/`supportPopulationJoins`) returns undefined: (a) the
   provider `native.async.number-to-string` (`src/ir/runtime/native-async-callables.ts:82`, runtime-callable
   `__ir_number_toString_native`) is answered by no runtime-bound setup function — its setup binding is
   intrinsic-bound (`nativeFormatterSetup`, `src/ir/program-physical-plan.ts:840-940`, association
   `native-to-string`, origin "intrinsic"); (b) the formatter setup (`emittedPhysicalSetupPlan(emission)
   .nativeNumberFormat`: finalize, `__nfd_*`, trap, radix-body, radix-thunk, Ryu, `number_toString`, adapter) has
   support receipts but no census rows; (c) `nativeSlots` accepts only runtime/intrinsic or anchor-derived bindings,
   while the kernels and radix-body are `support` refs with the canonical declarations' own binding ids. Admission:
   run `nativeSlots` over the formatter setup too, accepting a `support` binding only when its id equals the
   canonical declaration's (`numberFormatRadixSupportDeclarations(anchor)` kernels / implementation); rows for each
   function (slot + signature + receipt, the same `supportPopulationJoins`); answer the provider with the unique
   declaration of role `["number-format","native-to-string"]` whose reference equals the canonical adapter
   declaration's ref, and require the provider iff a direct formatter call exists (`irNumberFormatDemandOwners`);
   authenticate the scratch entry (type slot = the string owner's data type slot, as
   `planNativeNumberFormatScratch` does at physical-plan time). Forgeries: drop/add/duplicate/swap/relabel each row,
   the provider, the scratch. Not: joining by function name.
4. "source and prepared runtime must independently prove no async/support demand" — line 683-688: any
   `program.runtimeSupport.batches` refuses. Replace only the batch half (keep asyncPlan/asyncRuntime/asyncFunctions):
   exactly one batch, kind `number-format-radix-v1`, its declarations equal to
   `numberFormatRadixSupportDeclarations(batch.sourceId)` with `sourceId` the runtime ABI anchor, its implementation
   body's unit = the setup's `support.unitId` and its emitted slot = the census-authenticated radix-body row, its
   `demandOwners` = the program's formatter-calling units, and admitted only when 3 authenticated the setup.
5. The wasmgc:host async lane is not a consumer to reuse: `mixed` (captured Promise-result callables, line 846)
   skips `checkResourceDemand` (line 873) and the ABI contract check (line 467), and `checkMixedDemand` (line 1175)
   requires wasmgc:host, while the support batch requires wasmgc:standalone
   (`src/frontend/builtins/prepare-number-format.ts:22`). So no program presents the formatter today; on standalone no
   async program presents at all; on host a mixed program presents without the census (host lane, being retired).
   The name `async.native.number-to-string` is historical; a rename touches the hash-pinned declarations (#7358).

### Str2-c result (2026-11-18): the number formatter is admitted; dynamic `+` not started

Step 1 of the brief only (formatter admission). Step 2 (dynamic `+` / `+=`) is not started: step 1 was about L, the
brief's stop rule applies. Head after this section: see the branch.

Built (`src/compiler/prepared-formatter-census.ts`, new, 143 lines; `prepared-provider-census.ts` +54;
`ir-program-presentation.ts` unchanged in size, one call per gap):

| Hand-over gap | How it is admitted |
| --- | --- |
| 3 census | `nativeRows` runs `nativeSlots` over the formatter setup too (one slot population for both setups, one row per function, the same `supportPopulationJoins`). A kernel / radix-body function keeps the batch's support binding id (`canonicalSupportRole`; a type or global with a kernel role stays setup-derived). The provider: the setup's unique `["number-format","native-to-string"]` role, bound to the adapter's intrinsic reference, answers the adapter's canonical provider (by feature, `formatterJoins`) — no function-name join; the existing provider/answer population comparison then requires it selected exactly once. Demand: `irNumberFormatDemandOwners(program.ir.functions)`; without demand no batch is admitted. New, for both setups: one declaration per completed slot (a second declaration on a Ryu type/global slot was accepted before). |
| 2 widening | Falls out of 3: the formatter setup's type/global slots (Ryu table type, `inverse`, `powers`) join the census's `NativeSetupSlots`. |
| 1 ABI | `callableCarried(program, contract, carried)` (census module): a `support-ref` is carried only when it equals the canonical scratch type (data) on a contract whose reference is a canonical kernel's (data). |
| 4 support batch | `unjoinedSupport(program, native)`: a batch is admitted only beside native slots the census answered; the census (`batchJoins`) requires exactly one batch, kind `number-format-radix-v1`, `sourceId` = runtime ABI anchor, scratch / kernels / implementation declaration = `numberFormatRadixSupportDeclarations(anchor)`, body unit = canonical owner unit = the setup's `support.unitId`, `support.reference` canonical, `support.bindingId` = the radix-body slot's entry, `demandOwners` = the program's formatter-calling units. asyncPlan/asyncRuntime/asyncFunctions checks unchanged. |
| scratch | The string setup binds its data type twice when it carries `formatterScratch`; `formatterScratchBinding` accepts exactly the canonical scratch reference plus the setup's own derived reference (`{kind:"source", bindingId: owned}`), with `formatterScratch` equal to the canonical scratch type; the slot is the data declaration's (one declaration per slot does the rest). |

Deviations from the hand-over, and why: no kernel/adapter binding-id or name join — the mutation sweep showed the
emission's support receipt join (slot + key + signature) already refuses every such forgery, so those checks were
deleted as implied (rule: survivors are deleted when implied); the adapter answers its provider by feature
instead of by the declaration's name. Gap 4 is checked inside the census (one call in the presentation).

Proofs:
- Acceptance (`tests/issue-7354-str2c-formatter-census.test.ts`, `tests/issue-7354-str2-to-string.test.ts`; right
  answer returns, wrong throws, node agrees): typed `String(n)`, `String(v)` over number / -0 / NaN / -Infinity /
  1e21 / 0.1 / boolean / undefined / null / string, a template literal's number, a loop across iterations, the
  formatter alone (string layout setup), unused `String(h(v))` still throws from `h`.
- Number sweep against node: 265 numbers (powers of ten 1e-10..1e25 and ±, 1.5eN, 2^31/2^32/±2^53 ±5, subnormals,
  max, round-trip decimals, 80 random) × {dynamic `String(v)`, typed `String(n)`}: 0 wrong.
- Forgeries (census replayed on one compiled program; six categories also end to end through compile(), refusal
  by name, no exception): for each of the 16 formatter rows (5 kernels, radix body, radix thunk, finalize,
  to-string, adapter, 6 Ryu) drop the binding, drop the row (end to end), duplicate, add a second row, relabel,
  move to another key; 8 binding swaps; adapter reference / runtime-bound; support binding / unit / reference;
  Ryu global mutability; kernel signature; Ryu type/global relabelled as a kernel; scratch: absent, nullability,
  either binding dropped, derived duplicated, both canonical, derived under another id, on another entry,
  relabelled, present without a formatter; provider dropped / duplicated / renamed / feature relabelled / replaced;
  receipts dropped / duplicated / swapped; batch zero / two / kind / source / scratch / kernel dropped / kernels
  swapped / implementation declaration / implementation unit / no or extra demand owner, a batch on a
  formatter-free program; `support-ref` on the radix body, another support type / nullability on a kernel, a
  kernel contract under a foreign reference. 173 tests.
- Mutation sweep over every new check (52 mutations): 0 survivors after deleting the implied ones listed above
  (`unjoinedSupport`'s `&& !native` is killed by R's numeric-only program).
- Prepared bytes of 11 previously accepted programs (numeric, throw, box, strings, dynamic, typeof, typeof
  comparison, script var, loop, string ternary, `String("ab")`) and one refusal: identical against bc71ae2e9b.
  A program without a formatter call selects no formatter provider and has no batch (tested).
- Ordinary pipeline: 100 test262 files of the sample × {JS, standalone}: bytes identical against bc71ae2e9b
  (the change is Prepared-presentation only).
- Gates: typecheck, loc, func, coercion, oracle ratchet, dead exports, import cycles, compiler-boundaries inventory
  (new module registered): pass. Tests green: str2c, Str2, R, prepared entry/runtime, #7188, D1, P, VG, X, T, Str,
  Str emitter, H, H2, H3, Ty, Perf (each file run alone or in small groups; every run printed vitest's
  `Timeout calling "onTaskUpdate"` RPC error under machine load, with all tests passing). No intrinsic, provider
  or resource added, so no pinned closed list changed.

411-row sample: 14 negatives pass; first gap unchanged by design — 282 × "dynamic operation __ir_dyn_add has no
Prepared intrinsic" (`harness/assert.js:27`, `'"' + value + '"'`), 52 × module binding `obj` not-direct
(+ `x` 5, `proto` 4, `o` 4, `arr` 3, others ≤2), 26 × `identifier "assert" is not in scope in verifyProperty`,
2 × switch-case lexical binding, 1 × `unknown class "Test262Error"` (isConstructor).

Not verified: compile time of a prelude-sized test that reaches the formatter (none does until dynamic `+`);
`--utf8-storage` with the formatter; multi-file (`compileMulti`) formatter programs. The census forgeries replay
the census on captured inputs (end-to-end for one per category); the census test file takes ~4 min.

Hand-over for step 2 (dynamic `+`): every ToString arm now runs, so `+` can be expanded in
`dynamic-value-legalization.ts` beside `dyn.to_string` from existing pieces — `js.value.is_string` on both
operands, `kindChain`/`toStringArm` + `string.concat`, else `js.number.unbox` (ToNumber) + `f64.add` + `js.number.box`
— needing no new intrinsic, census row or pin. The brief asks for one intrinsic with a native provider instead;
its body would have to call the formatter, i.e. a dependency of the dynamic-value resources on the formatter setup
that this census does not authenticate yet. The cost to weigh: the IR expansion inlines two five-arm chains per
site (282 prelude rows hit `+` sites; measure compile time first).

### Str2-c step 2 (2026-11-18): dynamic `+` and `+=`

**Compile time is the headline finding: it grows roughly quadratically with the number of dynamic `+` sites.**
Measured in-process through the strict entry, standalone:

| program | compile | module size |
| --- | --- | --- |
| 1 site, both operands unknown | 6.0 s | 23,635 B |
| 5 sites, both unknown | 24.6 s | 24,391 B |
| 20 sites, both unknown | 235 s | 27,312 B |
| 1 site, string + unknown | 4.5 s | 23,092 B |
| 20 sites, string + unknown | 224 s | 26,754 B |

The module grows only about 190 B per site; the time is the emission's per-occurrence string-literal audit. Each
ToString chain carries four literal occurrences ("true", "false", "undefined", "null"), and each occurrence
re-authenticates the native string output plan. Profile of 6 unknown + unknown sites (36 s total), top inclusive
entries:

| ms | entry |
| --- | --- |
| 21,094 | `assertNativeStringOutputRequirementsCurrent` |
| 17,337 | `checkCompletedOwner` / `completedOwner` (`native-string-values.ts`) |
| 15,304 | `emitStringConst` → `emitPreparedNativeStringLiteral` |
| 11,773 | `authenticateCensus` |
| 13,587 self | `hasNativeCollectionState` (`data.ts`) |

Not fixed in this step, as instructed. No sample test compiles past assert.js yet, so no sample test pays this
cost today. A prelude-sized test that reaches emission will, and will take far longer than 15 s.

Built:
- The legalization expands the front end's `__ir_dyn_add` (the binary `+` and both `+=` arms) in
  `src/ir/program/dynamic-value-legalization.ts`, through one builder, `addition`, beside `dyn.to_string`. No new
  intrinsic, provider or census row.
- If either operand is a string, the addition concatenates `kindChain`/`toStringArm` (the chain `dyn.to_string`
  uses, no second copy), then `string.concat` and `coerce.to_externref`. Otherwise it boxes
  `js.number.unbox(l) + js.number.unbox(r)`.
- The operands are the call's SSA arguments, so each is evaluated once, left before right.
- `ADD_ROLE` is a `Record` over `CarrierKind` (concat for string, numeric for every other kind). It ties
  ToPrimitive-is-identity to the admitted kinds: a slice that admits an object kind must add a row here.
- Known kinds come from the box that defines an operand (`boxedKind`), or from an earlier concatenation's result,
  which is a known string. The effect:
  - a known string side concatenates with no test;
  - only a side that may hold a string is tested (`js.value.is_string`, `i32.or` over both);
  - a typed number or boolean side takes only its own ToString arm;
  - `"a" + v + "b"` formats `v` once and tests nothing.
- Typed + typed is unchanged. The function's builders moved to `legalizationBuilders` (function-budget split).
  `IR_DYN_ADD_FN` moved to the shared leaf `src/shared/contracts/dynamic-add-helper.ts`; codegen re-exports it, so
  there is no new codegen→ir edge.

Proofs (`tests/issue-7354-str2c-dynamic-add.test.ts`; right answer returns, wrong throws, node agrees):
- **Cross product.** 13 values {1, 0, -0, NaN, -Infinity, 1.5, true, false, undefined, null, "", "a", " 12 "}
  squared, i.e. 169 pairs, returned from a function. Each result is checked by kind and value, including the sign
  of zero and NaN.
- **Other positions.** Every 13th pair at top level over dynamic globals; every 3rd pair as a condition.
- **Known kinds.** Typed number / string / boolean on either side; the literal + dynamic + literal shape.
- **Order and loops.** Left-before-right evaluation, once each; the assert.js message shape with « »;
  `formatIdentityFreeValue`'s string arm; `String(value) + "n"`; `+=` from number to string on a dynamic var;
  `+=` across loop iterations with the kind changing; nested loops with sibling if/else blocks; switch and
  try/catch/finally.
- **Unused results.** An unused sum, an unread local and an unread `+=` still run their operands, and a throwing
  operand still throws.
- **Typed + typed.** Keeps its answer.
- **Pins updated** (own commit): D1's "dynamic +" refusal row is removed (D1's unused `add` helper with it); H's
  "added to" refusal becomes a run.

Mutations:
- Killed: ADD_ROLE.string set to numeric; the `i32.or` over both tests dropped; the string-test filter inverted.
- Survivors, as these are performance shortcuts rather than correctness checks:
  - the concat-without-test shortcut;
  - recording a concatenation's result as a known string.
- Survivor reached by no program today: the `tested.length === 0` sum. Both operands would need a known
  non-string kind, and the front end always passes one unboxed dynamic operand.
- Not run: a full sweep over every condition. Each run of this test file costs minutes.

Refusals left, by name:
- `ir/from-ast: '+' operands not provably both-number or string-concatenable (unprovable/…)` for:
  - the results of untyped calls (`f(1) + f(2)`);
  - a dynamic script global written from a function (`g = g + "x"`).
  Both are pinned in the test file. The front end makes a `+` dynamic only over operands it knows are dynamic.
- `dyn.member_get` (the next gap, below).

Gates: typecheck, loc, func, coercion, oracle ratchet, dead exports, import cycles, compiler-boundaries inventory —
pass.

Tests: str2c dynamic-add (all, run in groups), Str2, Ty, Str, Str emitter, H, H2, H3, D1, P, VG, X, T, Perf, R,
prepared entry/runtime, #7188, #7223 equivalence — pass. `tests/issue-2949-s5-5-dyn-arith.test.ts` "`+` stays
EXCLUDED…" fails identically on bc71ae2e9b (pre-existing; its `x - "a"` expectation, unrelated).

Bytes: ordinary pipeline is identical on 100 sample files × JS and standalone. Prepared bytes of the 12 programs
are identical to bc71ae2e9b.

411-row sample (14 negatives pass):

| rows | first gap |
| --- | --- |
| 282 | "dynamic operation dyn.member_get has no Prepared intrinsic" — moved off `__ir_dyn_add` and still on `harness/assert.js:27`: the other arm of `typeof JSON !== "undefined" ? JSON.stringify(value) : '"' + value + '"'`, i.e. the `JSON.stringify` read |
| 52 | module binding `obj` not-direct |
| 26 | `identifier "assert" is not in scope in verifyProperty` |
| 5 | `x` not-direct |
| 4 | `proto` not-direct |
| 4 | `o` not-direct |
| 3 | `arr` not-direct |
| 2 | switch-case lexical binding |
| 1 | `unknown class "Test262Error"` |

Compile time per row is still small (median 38 ms, max 743 ms), because every row stops in legalization, before
emission.

Not verified:
- The full 15-value cross product: 1/0 and "1" were dropped to keep the test runnable.
- The test file's total runtime: about 12 minutes in groups here, which is too heavy for CI until the literal
  audit cost is fixed.
- `--utf8-storage`.
- `compileMulti`.

### Review round 1 (Str2)

Verdict was NOT MET: no wrong answers, but the formatter census accepted forged setups (compile() SUCCESS) whose
roles or binding references alone were altered. Each finding, fixed or rebutted:

| Finding | Resolution |
| --- | --- |
| Kernel roles not checked (new/get, set/fin, get/trap swapped; trap relabelled `new`) | Fixed. `formatterSetupJoins` (`src/compiler/prepared-formatter-census.ts`): the formatter setup's declarations must EQUAL the recipe the runtime ABI anchor, the string owner and the accepted number-format policy determine (`declareNativeNumberFormatResources(nativeNumberFormatResourceInput(anchor, stringKey, integerBeforeScratch))`), so every row's role, name, signature / type and mutability is pinned, one row per role. |
| Binding references not checked (kernel references swapped, radix body under `new`'s reference, Ryu inverse/powers swapped) | Fixed, same join: the setup's bindings, as (resource key, entry id, reference) triples, must equal exactly one triple per canonical declaration — the canonical callable's entry and reference for kernels, radix body and adapter (`numberFormatSetupAssociations`, `src/ir/program/formatter-support.ts`, now the one table the physical plan binds from too), the setup-derived binding (`internalNativeBinding`, now exported) for every other row. Bijective by construction (sorted population equality). |
| One join, table-driven, not per-row special cases | `nativeRows` runs the join before `nativeSlots` over the formatter setup; `nativeSlots` takes a `canonical` flag and skips its derived-id check there, so the join is the only identity check of formatter bindings. `canonicalSupportRole` (the kernel exemption that let roles slip) and the adapter role/reference checks in `formatterJoins` are deleted (implied). Slots, signatures and receipts stay the census's existing joins. The scratch pair is also pinned to the canonical scratch entry id (both bindings). |
| Forgeries field by field | `tests/issue-7354-str2c-formatter-census.test.ts`, block "every field of every formatter row is joined by identity", generated from the row table: role, entry id, reference, slot, signature, receipt of each of the 16 rows, forged alone to another real row's value (93) and to a value no row has (88); the same-shape pair (Ryu inverse/powers, the only one) swapped in role / entry id / reference (3); the review's repros (7); a formatter setup injected into a formatter-free program (1); one end to end through compile() per field (6). Scratch: each binding's entry id alone (2), a structurally equal but distinct scratch type (1). 202 new, 375 in the file; the 173 earlier forgeries still refuse. |
| Mutation sweep over the join | 6 mutations, 0 survivors: declaration equality (35 tests fail), binding comparison (35), reference dropped from the triple (36), entry id dropped (1: the same-shape entry-id swap, the only forgery no slot/receipt join catches), scratch entry ids (1), the `canonical` flag ignored (acceptance fails). |
| Should-fix: dead `tested.length === 0` sum | Deleted. Probed: every `+` whose operands would both be known non-string kinds (`null + 1`, `true + null`, `null + true + v`, ...) refuses in from-ast first (`'+' operands not provably ...`). Comment at the site says why a test always exists. |
| Should-fix: `dyn.to_string` re-spelled `stringOf` | It calls `stringOf`, which reads the operand's known kinds. (Corrected in review round 2: the byte claim "the 19 previously accepted probe programs are unchanged" was false for one class; see there.) |
| Should-fix: `legalizationBuilders` ~170 lines | Split by concern: `knownKinds` (proven kinds, `learn`), `chainBuilders` (fresh values, intrinsics, kind tests, ToString / typeof chains, `stringOf`), `additionBuilder` (the dynamic `+`). |
| Should-fix: `dynamic-add-helper.ts` one-constant module | Kept, with the reason in its doc: codegen imports nothing from the IR and a clean IR module (`ir-program` layer) nothing from codegen (`dyn-ops.ts`, where the siblings live, is `mixed-needs-split`), so the name both read needs a shared leaf; `in-operator-helper.ts` is the same pattern. `src/ir/core/runtime-symbols.ts` would add the first codegen→ir/core edge. |
| Should-fix: `String()` | Answers "" (`tryLowerAmbientStringToStringCall`, from-ast net zero lines). The ordinary selector never admits a zero-argument `String` call (`ambientStringToStringCall`), so only the Prepared path reaches it; ordinary bytes of `String()` probes are identical. |
| Should-fix: literal `String(null)` / `String(undefined)` | Same arm. The refusal came from a program with no dynamic contract: from-ast boxes the literal into the dynamic value and the legalization never ran, so the physical plan met a `dynamic` type ("no accepted host async dynamic carrier"). `legalizeSourceDynamicValues` now also legalizes a function holding `dyn.to_string` (`convertsBoxedLiteralToString`); `String(null)` then takes only the null arm. |

Known limit, pinned by a test: a slot is the completed emission's own binding-index record, the root every census
join reads. Two globals of one shape exchanged in that record (Ryu inverse/powers) leave no second record to
contradict it; a function has its support receipt, a global has none.

Proof: Prepared bytes of 19 previously accepted programs and one refusal identical to 649e432d35 (2 more, `String(null)` in a
condition and `String()`, compile only now); ordinary bytes identical on 100 test262 files of the sample × {JS,
standalone} and on the 22 probe programs × {JS, standalone}. Tests pass: formatter census (in two groups), to-string,
Ty, R, D1, T, X, Str, Str emitter, Perf, H, P, #7359, #3518 ×2, prepared entry/runtime, #7188, dynamic add (in
groups; "at top level pairs chunk 0" times out at its 150 s limit on this branch AND on 649e432d35 under load,
~165 s both, and passes with the limit raised). Gates: typecheck, loc, func (also against origin/main's tip),
coercion, oracle ratchet, dead exports, import cycles, compiler-boundaries inventory.

### Review round 2 (Str2)

Verdict was NOT MET: no wrong answers (37 programs), but `formatterSetupJoins` compared only (resource key, entry
id, reference) per binding and never read `resources.input`, `resources.scratch`, `resources.supportUnitId` or
`support`. Each finding, fixed or rebutted:

| Finding | Resolution |
| --- | --- |
| The join reads only part of each row (accepted: a formatter binding's `entry.intent` / `slotSpace` / `slotPolicy`; `support.resourceKey` / `params` / `results`; `resources.input.key` / `integerBeforeScratch`; `supportUnitId`; `scratch` removed) | Fixed. `derivedFormatterSetup` (`src/compiler/prepared-formatter-census.ts`) builds the WHOLE setup the physical plan derives (`nativeFormatterSetup`): the recipe and its input from the anchor, the string owner key and the policy; the scratch (the string setup's data declaration, the canonical scratch reference, its prepared ABI entry); every binding in the producer's order with its full entry (the program's ABI entry for an associated callable, `internalNativeBinding` at `nativeSupplementalOrder(program) + string declarations + index` for every other row — `nativeSupplementalOrder` now exported); the support function. `formatterSetupJoins` deep-equals the setup to it (`preparedIrDataMismatch`). The support checks in `batchJoins` are deleted (implied). |
| Same-shape Ryu globals exchanged in the binding-index record (accepted, test locked the hole in) | Fixed, detected: `ryuTablesJoin` compares each Ryu table global's emitted initializer with `nativeRyuTableInitializers(tableTypeIdx)` (`src/backend/wasmgc/resources/native-number-ryu.ts`, now the one builder the fill uses too). The test is now a refusal. |
| Same-signature functions (`values/box-number` ↔ `number-format/to-string`) with index AND receipt swapped together (accepted) | Ruled harmless, kept as a named known-limit test. Both records are snapshots `recordEmissionObservation` (`src/ir/program-consumer.ts`) takes after the module is complete: the binding index from the sealed ABI map, the receipts from the reservations. Every call and global index in the module was resolved from those reservations, which the join pins by resource key, before either record existed; the records are read only by the presentation's checks. A forgery of both records changes no byte, and nothing in the module disagrees with it short of comparing function bodies. |
| Dead policy argument; `TypeError` with no policy (`numberFormat!`) | The policy determines the recipe input and the radix body (`integerBeforeScratch` selects the pre- or post-scratch integer return, `number-format-bodies.ts`), so it is compared: the derived input carries it, and `resources.input` must equal it. An absent policy or an empty string-owner key refuses (undefined derived setup), never throws. |
| False byte claim in round 1 | Corrected. Measured on 15 string / dynamic probe programs (2 refuse on both), 649e432d35 vs this branch: bytes changed for exactly one class, a `String(x)` whose dynamic operand has a proven string kind — `String(s + "x")` with an untyped `s`, and `var w = v + ""; String(w)` — because the `dyn.to_string` arm now reads the known kinds (`stringOf`) and emits only the string arm. Both still answer like node. Unchanged: `String(v)` on an unknown kind, `typeof`-narrowed `String(v)`, `"" + v`, `String(v + 1)`, `String(String(v))`, `typeof v`, dynamic `a + b`, typed `String(n * 1)`, script-var `String(x)`. |
| `convertsBoxedLiteralToString` matched any `dyn.to_string` and then legalized every function | Renamed `convertsDynamicToString` (`src/ir/source-dynamic-contracts.ts`), breadth justified (every ToString of the dynamic value needs the legalization on this lane, whatever boxed its operand); without a dynamic contract only the functions holding one are legalized, since no dynamic value crosses a function boundary there. Prepared bytes of 15 formatter-free typed programs identical to 649e432d35; the 15 probe programs identical to a87363c48d. |

Leaf forgery: `refuses every leaf of the setup forged alone` walks the captured setup's object graph (532 leaves:
strings +":forged", numbers +1, booleans negated) and requires the join to refuse each; 0 accepted, 0 exemptions.
The named round-2 repros, the flipped / absent policy and the empty string-owner key go through the census replay
(refused, no exception). Mutation sweep (8): join disabled, policy replaced by the constant `true`, each half of the
input guard, the guard deleted, Ryu join disabled, string setup treated as canonical (`nativeSlots(..., true)`;
killed by R's census test) — all killed. Survivors, deleted: the formatter-presence test in `formatterJoins` (a
missing setup has no Ryu table slots) and the producer's existing-entry arm in the derived bindings (no formatter
program plans such an entry; one that did now refuses).

Proof: formatter census 390 (two groups), to-string 43, dynamic add 29 of 30 (the known slow "at top level pairs
chunk 0" not run), R 113, Str + Str emitter + D1 72, T + X 161. Gates: typecheck, loc and func (also against
origin/main 89e4748241), coercion, oracle ratchet, dead exports, import cycles, compiler-boundaries inventory.

## Perf2 result (2026-11-19)

Branch `claude/7354-perf2` on `claude/7354-str2` @ 649e432d35. Compile time of string emission on the Prepared path
is now linear in the number of string sites; no check was removed or weakened, output is byte-identical.

### Call chains found, and what replaced each

| Cost centre (6 dynamic `+` sites, base 36 s profiled) | Who called it per emit, and why it was safe to stop | Now |
| --- | --- | --- |
| `assertNativeStringOutputRequirementsCurrent` 21 s | every emit → `completedOwner` → output pack `ownerFor` → `checkPlan` → full re-derivation (census re-collection + three whole-demands compares). A pure function of the issued requirements and options. | settled per issued record (`checkUnlessSettled`); a fresh derivation is settled at issue when its requirements and options are immutable (`settledAtIssue`: the derivation is its own re-derivation) |
| `authenticateCensus` 12 s | every output-requirements derivation (14 per compile, all on ONE demands object) | once per demands object (`PreparedIrSettledChecks`) |
| `assertNativeNumberFormatRequirementsCurrent`, `assertNativeObjectAccessRequirementsCurrent`, `assertNativeStringValueReservationInput` | same shape: whole re-derivation per call (12 / 1 / 3 per compile) | number format: settled per requirements (the input's `integerBeforeScratch` is compared outside, it is the only input field not carried by the requirements); object access: settled at issue; reservation input: settled per input object |
| `AllocSiteRegistry.fromSnapshot` (75 validated deep copies per compile, 5 throwing slot probes per record) | the four censuses (string demands, formatter support, ref cells, source closures) only `resolve` through it | `preparedAllocationSites` (`src/ir/program/prepared-allocations.ts`): restored once per immutable snapshot, read-only interface |
| `PhysicalModuleReservations.#verifyLayout` per emit (O(module), the quadratic part) | literal emit: 3 audits (completion, inventory, index); receipt census: one audit per module function (O(F × module)) ×5 per compile | the whole lowering of a body runs in one `audited` scope (one trailing audit per body); the literal emit and the receipt census each take one audit |
| `hasNativeCollectionState` | throwing probes on every array | an Array exotic object answers without a probe (`data.ts`) |

One mechanism: `src/ir/program/settled-verdict.ts` holds the first Perf slice's predicate and prototype-state rule
(moved, not copied) and adds `checkUnlessSettled` (holder), `PreparedIrSettledChecks` (holders keyed by input
object; a check's result is `void`, the allocation restore's is the registry) and `settledAtIssue`.

Tried and withdrawn:
- a shared cached slot-probe module also used by `alloc-registry.ts`: that file is content-pinned by the relocation
  receipt (`issue-3518-allocation-runtime-seam` failed 6 tests); replaced by the restore-once view above.
- a "permanent initializer" audit skip with frozen literal initializers: an in-place write became a TypeError instead
  of the audit refusal (`issue-3518-native-string-error-resources`), and after the per-body audit it no longer measured
  above noise.

### Measurements (strict Prepared entry, standalone, second compile in the process; base = 649e432d35)

| program | base | after | bytes |
| --- | ---: | ---: | --- |
| 1 dynamic `+` site | 6.1 s | 2.0 s | identical |
| 5 sites | 30.5 s | 4.1 s | identical |
| 20 sites | 235 s (brief) | 11.7 s | — (base not re-run) |
| 50 sites | — | 26.3 s | — |
| 100 lines (literal + concat + length + `===`, in a function) | 15.0 s | 7.4 s | identical |
| 200 lines | 34.5 s | 15.5 s | identical |
| 400 lines | 83.9 s | 34.4 s | identical |

Per site ~0.5 s, flat from 5 to 50 sites; per line 74 / 78 / 86 ms (base 150 / 173 / 210 ms). Load average was
~2.5 from another agent during the after runs. `tests/issue-7354-str2c-dynamic-add.test.ts`: ~12 min → 206-230 s
(still over 3 min). The 1-site fixed cost is ~3 s of module loading plus ~2 s of one-time checks.

Profile of 20 sites after (12.6 s in the driver): materialization 6.7 s (emission 0.85 s of it), acceptance 4.0 s,
preparation 1.9 s; self time `hasNativeCollectionState` 4.1 s and `immutableCopy` 2.4 s spread over ~20 distinct
one-time whole-program compares and snapshot copies (`planNativeStringValuePhysical` ×3 compares, `assertPreparedIrProgram`
×5, …), the audit 1.2 s.

### Proofs

- Bytes: 539 distinct Prepared programs logged from Str, Str2, Str2-c census, Str2-c dynamic add, D1, T, X,
  prepared entry/runtime and #7188 test runs, replayed on base and after: 539 identical (465 binaries, 74 refusal
  messages). Ordinary pipeline: 100 test262 files of the sample × (JS, standalone): identical.
- Refusal sets: 43 files (the 24 `issue-3518-native-string-*`, module reservations, physical snapshot, allocation
  seam/replay, number format, object descriptors, realm, ref cells, source closures, ownership/abi seams, policy
  evolution, provider boundary, compiler boundaries, 3527 receipts, source maps): failing sets equal to base.
  R census (113) and Str2-c formatter census (173) pass.
- New `tests/issue-7354-perf2-settled-checks.test.ts` (12): mutable input re-checked every use; frozen input checked
  once and again after `Object.prototype` changes; immutability decided before the check; a throwing check never
  settles; one verdict per object (a copy is re-checked); unfrozen options changed after issue refused; a copied
  requirements record / object-access pack refused after the issued one settled; reordered census refused; a mutable
  allocation snapshot changed after a restore refused.
- Mutation sweep (14): all killed — prototype comparison, settle-always, decide-after-check, settle-at-issue always,
  options dropped from the settled input (both places), census keyed by program, number-format option check, and the
  withdrawn permanence predicate's guards. Survivors, performance-only: the per-body `audited` scope, the single-audit
  literal emit / receipt census, the array shortcut, the restore memo itself (killed by its identity test only).
- Gates: typecheck, loc and func budgets (merge-base and `origin/main`), coercion sites, oracle ratchet, dead exports,
  import cycles (grant: `backend->ir` 119 → 120, frontmatter), changed-root tests (interpreter engine). All 7354
  slice tests, prepared entry/runtime and #7188 pass.

### Still superlinear / not met

- 20 sites 11.7 s (goal ≤ 10 s). What remains is linear: ~20 one-time whole-program compares and copies with throwing
  slot probes on fresh records. The next lever is one derivation shared per immutable program (e.g. collecting the
  demand census once per program) and a non-throwing slot probe in `alloc-registry.ts` together with its receipt
  refresh (#7358).
- One O(module) audit per function body remains (quadratic in the number of functions, small constant).
- Not verified: the 20/50-site and 400-line outputs against base (base too slow), `--utf8-storage`, `compileMulti`.

### Str2 + Perf2 integrated (2026-11-19)

Branch `claude/7354-perf2`: Str2 (`1e12b62aac`), lane S2's Perf2 work (`84b8afbe41`) and `origin/main`
(`89e4748241`) merged into Perf2 (`2f3bb36368`).

Conflicts and ports:
- Str2 merge: only this file (both sides' sections kept). No settle port was needed: Str2's whole-value formatter
  join (`formatterSetupJoins`, `ryuTablesJoin`) runs in the presentation's provider census, once per compile, not in a
  per-use currentness check; Perf2's settled checks are untouched by it.
- S2 merge: `fillPreparedPrimaryUnit` had `tx.audited` around `lowerIrFunctionBody` on both sides (one kept);
  `tests/issue-7354-perf2-settled-checks.test.ts` was added on both sides — one file now, S2's five settled-verdict
  unit tests dropped as duplicates of this side's, its native value plan (2) and formatter/object-access over a
  changeable program (2) tests added (16 tests). Dynamic-add and Ty tests are S2's (Str2 never changed them).
  `assertNativeValueResourcePlan` settles at issue (S2) through the IR binding below.
- Main merge: no conflicts. PR 7263 had not landed, so `identifier-read.ts` needed no port.

Gate fix (import-cycles `backend->ir` 119 → 120 and the boundaries inventory): the mechanism moved to the contract
leaf `src/shared/contracts/settled-verdict.ts` (`preparedIrSettledVerdicts(collectionMembers)` →
`isImmutable`, `checkUnlessSettled`, `settledAtIssue`, `settledChecks`). Its one IR fact — which objects are genuine
frozen collections — is a parameter, because `data.ts` (which owns the brand) is pinned by the #3518 seam tests and
cannot move. `src/ir/program/settled-verdict.ts` binds it to `preparedIrFrozenCollectionMembers` for the IR modules;
`native-string-values.ts` binds it itself through `data.ts`, which it already imported, so no new backend→ir edge.
`PreparedIrSettledChecks` (class) became `settledChecks<Input, Output>()`. The `backend->ir: 120` grant is removed;
`compiler-boundaries.json` classifies the leaf (foundation) and `settled-verdict.ts` / `prepared-allocations.ts`
(ir-program), which were unclassified. Both gates green without grants.

Also: `tests/issue-7354-str2-to-string.test.ts` and `...-str2c-formatter-census.test.ts` exited 1 with every test
green ("Timeout calling onTaskUpdate"); both now yield a macrotask in `afterEach`, as S2 did for dynamic add.

Results on the integrated head:
- Gates (each bare): typecheck, loc, func (also with `LOC_GATE_BASE=origin/main`), coercion-sites, oracle-ratchet,
  dead-exports, import-cycles, compiler-boundaries `--mode inventory --base origin/main`: all exit 0.
- Tests (one file per command, VITEST_MAX_FORKS=1): all pass — to-string 43 (87 s), Ty 64 (131 s), dynamic add 31
  (229 s), formatter census 390 (154 s, incl. the 532-leaf forgery), perf2 settled 16, Perf 33, Str 19, Str emitter 9,
  R 113, D1 44, P 26, T 108 (192 s), X 53, H 65, V/G 45, prepared entry 44, runtime 8, #7188 6.
  `changed-root-tests` set (14 files, interpreter eval engine, the script's own invocation): all pass; over 3 minutes:
  dynamic add 226 s.
- Timing, N functions `f(a, b) { return a + b; }` called once each at top level, strict Prepared entry, standalone,
  second compile in the process (same program on both): Perf2 tip 2.3–2.4 / 5.4–5.7 / 32.8 s, integrated
  2.5–3.1 / 5.6–6.3 / 20.5 s for 1 / 5 / 20 sites; output bytes identical.
- Prepared bytes: 38 programs (Str2 String()/ToString, Ty, dynamic `+`/`+=`, D1, T, X, Str typed strings) identical to
  Str2 @ `1e12b62aac` (35 compiled, 3 identical named refusals).
- Ordinary pipeline: 100 test262 files of the ES5 sample, default and `--target standalone`, identical to
  `origin/main` (94 compiled, 6 CE on both, per target).
- 411-row sample (real runner, IR path, standalone): first-gap tally 282 `dyn.member_get has no Prepared intrinsic`,
  84 `module binding … has no exact typed storage: not-direct`, 26 `identifier "assert" is not in scope in
  verifyProperty`, 14 pass (negatives), 1 `unknown class "Test262Error"`, 1 `print` direct call, plus 3 rows whose
  parse error precedes `dyn.member_get`. The error text carries no source location (`L1:1`).
- Not verified: `--utf8-storage`, `compileMulti`, the gc target's Prepared bytes.
- Review (behaviour and code quality) at `de8a5e923b`: MET.
- Should-fix 1 closed (`cd34d67f40`): chain tests whose first pair is numeric (`a + b + c`, `a + b + c + d`); the
  mutant that learns every dynamic `+` result as a known string now fails them (illegal cast), reverted.
- Should-fix 2 closed (`1d9ef98203`): `additionBuilder(builders)` reads `kinds` / `allocations` from the chain
  builders instead of taking them again; Prepared bytes of 6 dynamic-add programs identical.

### Merge of `main` (realm + O1) into Perf2 (2026-11-20)

- Census: `nativeRows` takes the formatter setup, the realm's callables and the backend options; `answered` starts
  from the realm callables and the formatter's; `utf8Storage` is read from `backend`.
- Contracts: a program that binds a catch anywhere runs `refuseUnadmittedThrows` even when no function legalizes;
  O1's `coerce.to_externref` arm (`carrierKind`) replaces this branch's `thrown` set. The X test's duplicate
  "object-literal throw tested with typeof" (pinned at the old invariant error) is dropped: O1 refuses it by name.
- Kind answer, two functions, fold owed: `carrierKind` (now typed over `CarrierKind`) answers a value already in
  carrier form (dynamic / string type, `js.number.box` / `js.boolean.box`, the null constant, through coercions) and
  gates coercions and throws; `boxedKind` / `knownKinds` answer a `box` to the dynamic value (tag or operand) and a
  learned concatenation, to prune ToString / `typeof` / `+` chains. They read different stages of the same function
  (`box` before legalization, its intrinsics after), so one function needs a design pass, not a merge edit.

## F0 result (2026-11-20, branch `claude/7354-f0`, merged with main 052569d335)

**Built.** The strict Prepared front door drops unused top-level bindings before analysis by calling the existing
#3418 pass `elideDeadTopLevelBindings`. There is no second liveness walk.

- **Where:** `elideDeadBindings` in `src/test262/test262-prepared-entry.ts`, called by `present()` before
  `analyzeMultiSource`.
- **Same CI path:** the CI runner reaches this same `present()`. `scripts/compiler-bundle-entry.ts` re-exports
  `compile`/`compileMulti`/`createIncrementalCompiler` from this module, and `selected(options)` sends every
  `wholeProgram` request to `present()`. This settles §14's open point.
- **Gate:** the one shared predicate `deadBindingElisionApplies` (moved out of `compileSourceSync`; the ordinary
  compile now calls it too). It covers host-free targets, the native regime, and excludes
  `standaloneScriptVarBindings`.
- **One source only:** a graph of several sources keeps every binding, because a Script `var` of one source is
  visible to another.
- **Positions:** blanking is same-length, so positions are unchanged. The frontend-failure observation still
  reports the supplied text, because the runner hash-matches it against the job's source.
- **Ordinary pipeline:** it never reaches `present()`; `compileMulti`, including Temporal, goes through
  `src/index.ts`. It sees only the two soundness fixes below.

**Soundness of the pass (both callers).**

- **Droppable:** a top-level `var`/`let`/`const` statement where every declarator is a plain name and:
  - every initializer is function/arrow, a literal, `undefined`/`NaN`/`Infinity`/`globalThis`, an object or array
    literal of such values (no spread, shorthand or computed key; methods/accessors allowed), or `!`/`void`/parens
    of any of these;
  - and the name is never mentioned again outside a dropped statement (as an identifier, property name, string
    literal or literal eval text).
- **Keeps everything** when computed `eval`/`Function` source survives.
- **Never drops** function or class declarations.

Two wrong answers in the existing pass, fixed for both callers:

1. **`-`/`+`/`~` of a non-primitive.** These were treated as pure, but they run ToPrimitive.
   `var x = -{ valueOf() { throw 1; } }` was dropped; node throws. They are now pure only on a pure primitive
   operand (`isPurePrimitive`).
2. **Duplicate lexical declarations.** `let a = 1; let a = 2;` (and `var a; let a`, `let a, a`) is an early
   SyntaxError, but the pass dropped the pair because each statement is the other's only mention. The ordinary
   standalone and default compiles both accepted it on main. Now a name declared twice with a `let`/`const` among
   them keeps every declaration. `tests/test262-prepared-entry.test.ts` caught this.

**Known residual, shared with the ordinary compile.** The pass sees names, not reflection on the global object.
`globalThis[k]` with a computed key, `for (k in this)`, and `Object.keys(globalThis)` could observe a dropped
global `var`. The Prepared path refuses all three today (tested), so no answer is wrong yet. A slice that admits
global-object reflection must revisit this.

**Tests:** `tests/issue-7354-f0-dead-top-level-bindings.test.ts`, 38 tests against node:

- 9 accepted programs, each with a right and a wrong answer;
- 1 effect-throw pair;
- 17 kept-binding refusals;
- 3 global-reflection refusals;
- 3 duplicate-lexical early errors;
- the gc, linear, multi-source and frontend-text cases.

`tests/issue-3418.test.ts` gains 2 unit rows (purity and redeclaration). 13 of 14 mutations are killed. The
survivor is the JS/TS `ScriptKind` choice: a grammar difference produces a parse diagnostic, and the pass then
returns the source unchanged.

**Pins updated** (each probe's whole program was a dead binding, so it now compiles; each now reads its binding):

- H `var o = { a: 1 }` / `var arr = [1]` / `var f = function () {}`;
- Str2 `var g = globalThis`;
- #7364 `var r = /a/`, `preparedProgram("var x;")` and `("var x = 1;")`.

**Bytes (base main 052569d335, file-copy A/B):**

- Ordinary pipeline, 50 test262 files × {default, standalone} (100 rows, 14 CE): identical.
- 10 Temporal files through `compileWithTemporalGlobal`, standalone provider rebuilt by each compiler: identical,
  provider binary included.
- Prepared fixtures (`check:prepared-bytes` rows 0-399): 396 identical. The 4 that differ (rows 38, 49, 50, 51:
  `var x = 1; var x = 2;`, `var o = { a: 1 };`, `var arr = [1];`, `var f = function () {};`) contain only dead
  bindings and now emit the empty-program module.

**Sample (411 rows, real runner, standalone, base main vs branch):** the first-gap tally is identical. 14
negatives pass. 293 `dyn.member_get`, 73 `not-direct`, 26 `assert` in verifyProperty, 2 switch `f`, 1
`Test262Error`, 1 `print` (the runner's print hook names `print`, so the shim is kept there), 1 parse.

The shim was never a first gap in the runner (its TS diagnostics are skipped there). On the runner-assembled source
through the strict entry, base reports `Duplicate identifier 'print'` and
`Cannot find name '__js2wasm_global_script_eval'`. The branch no longer reports them, and a body that calls
`print` still refuses at `print`.

**Validator:** `#7354 O … refuses what the later steps build` trips the #7380 validator (`retains a dynamic type
after legalization`) on main without this change. That is a finding for slice O, not F0.

**Not verified:** a step-past (FD) census of the gaps after the first.

### Review round 1 (2026-11-20)

The verdict was correctness NOT MET: the elision failed open on the Prepared path. Each finding and what changed:

1. **Dropping a statement dropped the only evidence of its error.** Main refused the reviewer's 12 programs;
   F0 compiled them and returned while node throws (early errors inside function bodies, `+1n`, declarations of
   `undefined`/`NaN`/`Infinity`).
   - (a) **Fail closed (Prepared caller).** `elideDeadBindings` (`src/test262/prepared-dead-bindings.ts`) now
     runs on the analysis of the UNELIDED graph. It pins every statement holding a frontend error:
     - the TypeScript diagnostics (syntactic, and semantic unless skipped);
     - the ES early errors under the given, Script and Module goals (`sourceEarlyErrors`, now shared with
       `validatePipelineSource` in `src/compiler/prepared-pipeline-boundary.ts`).

     The pass takes the pins as `pinnedOffsets`. A graph the elision changes is analyzed a second time.
     Cost on the 411-row sample's `compile_ms`: median 44 → 52 ms, p90 74 → 90 ms (main vs branch, same runner).
   - **The runner skips semantic diagnostics,** so in runner mode the pins come from the ES early-error detector.
     It missed two of the reviewer's families on every pipeline; both are fixed in the detector:
     - duplicate labels inside a function or class body were never checked (`checkDuplicateLabels` stopped at
       the boundary);
     - a Script's top-level `let`/`const`/`class` of a restricted global is a SyntaxError in
       GlobalDeclarationInstantiation: new `checkRestrictedGlobalLexicals`, gated on the stated Script goal.

     `let undefined`, `const NaN` and `const undefined` were wrong on main's Prepared path in runner mode too,
     without elision.
   - (b) **Restricted globals, both callers:** a declaration of `undefined`/`NaN`/`Infinity` is never dropped
     (`RESTRICTED_GLOBAL_NAMES`, `src/compiler/early-errors/predicates.ts`).
   - (c) **BigInt, both callers:** `-`/`+`/`~` are pure only on an allow-list of primitive literals
     (`purePrimitiveKind`), and `+` not on a BigInt (`+1n`, `+(-1n)` throw). The old comment "ToNumeric runs no
     code" is gone.
   - **Ordinary caller:** it has the same hole, because it elides before its only analysis. Taking the
     diagnostics-aware rule needs a second parse plus detector walk on every standalone compile and its own
     byte proof, so it is filed as **#7445** with the programs.
2. **CI `changed-root-tests`.** The two unit rows moved into the F0 test file, and `tests/issue-3418.test.ts`
   is main's again.
3. **Script-kind duplication.** The Prepared caller now passes `multiFileScriptKind` straight through instead of
   re-mapping it.
4. **Standing hazard (confirmed by the reviewer):** programs that read the global object by computed name are
   wrong on the ordinary path on main and on this PR. The cases are `globalThis[k]`, `Object.keys(globalThis)`,
   for-in over `this`, `globalThis.eval(computed)`, `(function(){}).constructor(...)`, `toJSON`/`name`/`value` read
   through the global object. The Prepared path is safe only because it refuses them today. The programs are in
   #7445.
5. **CI `quality` (boundaries and import cycles).** The new file is classified in
   `scripts/compiler-boundaries.json` like its sibling. The pass reads `RESTRICTED_GLOBAL_NAMES` through
   `early-errors/index.ts`, so it adds no second edge into `src/compiler`.

**Proof.**

- **Tests:** `tests/issue-7354-f0-dead-top-level-bindings.test.ts` has 64 tests, all green, in the runner's
  options (semantic diagnostics skipped, Script goal stated):
  - 22 "refuses or throws as node does" rows (the reviewer's 12 plus 10);
  - 1 unstated-goal row.
- **Mutations:**

  | mutation | rows that fail |
  |---|---|
  | diagnostics pin removed | 5 |
  | restricted-name rule | 4 |
  | BigInt rule | 4 |
  | goal union | 1 |
  | label descent | 2 |
  | restricted-lexical rule | 3 |

- **Reviewer tables:** 77 + 37 programs on 4 lanes (Prepared standalone and gc, ordinary standalone and
  default). No Prepared lane is wrong, and there is no new wrong answer anywhere. The ordinary lanes lose 7 of
  main's wrong answers: `+` on a BigInt ×4, `-(-{valueOf})`, and two duplicate-lexical programs.
- **Bytes against main:**
  - Ordinary pipeline, 50 files × 2 targets: identical.
  - 10 Temporal rows: identical, provider included.
  - Prepared fixtures 0-399: the same 4 all-dead rows differ as before, the rest are identical.
- **Sample:** the first-gap tally is unchanged.

### Review round 2 (2026-11-20)

Quality was met. Correctness was not met, by one test262 regression.

**Finding.** `checkRestrictedGlobalLexicals` (added in round 1) turned
`language/global-code/decl-lex-restricted-global.js` into a compile error. That test is `let undefined;`,
`negative: phase: runtime`. CI's runner passes `scriptGoal`, so the row scored `compile_error` where main passes
on host and standalone. My earlier local sweeps did not pass `scriptGoal`, which is why they missed it.

The rule was wrong in kind: the SyntaxError belongs to GlobalDeclarationInstantiation, a run-time step of the
Script, not to the early errors. With no stated goal it also made an ordinary `let undefined;` throw at start,
which is wrong for a Module.

**Fix.**

- The rule is removed. The elision still never drops a declaration of `undefined`/`NaN`/`Infinity`.
- The pass, the IR script-var home (`src/ir/module-binding-script-var-home.ts`) and the bare-identifier write
  guard (`src/codegen/builtin-nonwritable-write.ts`) now read one set, `GLOBAL_CONSTANTS`
  (`src/shared/ambient-intrinsics.ts`, now exported). The fourth copy, `IMMUTABLE_GLOBAL_PROPERTY_NAMES` in
  `src/codegen/expressions/runtime-eval-provider.ts`, is unused; noted in #7445.
- `goalsOf` walks the early-error detector once for a stated goal, and only under the Script and Module goals for
  an unstated one.
- The labels comment now says why a function body restarts its label set.
- One more one-line detector fix: `checkDuplicateLabelsInBlock` now checks a function's body inside a class
  static block. The function/class boundary test both label walks repeated is now one predicate,
  `isLabelScopeBoundary`.

**Proof.**

- **F0 tests:** 67, green. They include a row pinning `decl-lex-restricted-global`'s shape on the ordinary compile
  with the Script goal (it compiles, and instantiation throws), and two detector rows for duplicate labels.
- **Restricted-lexical rows:** `let undefined = 1;`, `const NaN = 1;` and `const undefined = 1;` left the
  "refuses or throws" list. The Prepared path in runner mode compiles and returns them on main and here alike: a
  GlobalDeclarationInstantiation error it does not model (#7445). They stay covered by the never-elide unit row.
  `let Infinity;` refuses, as on main.
- **Runner sweep with `scriptGoal`:** the reviewer's 779 files (scratch patch of `tests/test262-runner.ts`,
  reverted), host. Verdicts are identical main vs branch, before and after the static-block fix.
  `decl-lex-restricted-global.js` passes on both, and on standalone.
- **Named test files, failures per side (main / branch):** issue-990 2 / 1, issue-3632 3 / 3, issue-2923 9 / 9,
  test262-prepared-entry 0 / 0.
- **Bytes:** ordinary 50 × 2 targets and 10 Temporal rows identical to main. Prepared fixtures: the same 4
  all-dead rows as before.

**Still accepted on main and here alike** (filed in #7445): `let {undefined} = {}`, `let [NaN] = []` and
`function NaN(){}` at the Script top level.

### Review round 3 (2026-11-21)

Quality was met and the round-2 blocker is fixed.

**Finding.** `goalsOf` treated `inferModuleStrictArguments: false` with no `scriptGoal` as a stated goal. That
option set only marks a Script top level, while the Script-only rules (`import.meta`, `export`) key on
`scriptGoal`. So `var g = function () { return import.meta; };` was elided and compiled on the Prepared path,
while node throws a SyntaxError and main and round 2 refused it.

**Fix: always walk both goals** (`GOAL_WALKS` in `src/test262/prepared-dead-bindings.ts`), instead of trusting a
stated goal. Even a stated Script goal is not enough: the Script walk tolerates one function level for the
runner's synthetic test wrapper, so `var g = function () { await 0; };` with `scriptGoal: true` was dropped too,
and node rejects it. Pinning an error the real goal lacks only keeps a dead binding.

**Detector fix, same family.** Under an explicit Module goal the detector missed `await` as a binding or label
inside a plain function (§13.1.1: `function f() { var await; }`). `checkReservedIdentifiers` now reports that in
binding and label positions only. Expression positions stay as they were, because TypeScript reads some top-level
AwaitExpressions (`await /x/`) as an identifier. A first, unrestricted version turned ~25 top-level-await rows into
compile errors and was narrowed.

| test262 module files mentioning `await` (305, runner with the goal patch, host) | main | branch |
|---|---:|---:|
| pass | 169 | 176 |
| compile_error | 38 | 38 |
| fail | 80 | 73 |
| skip | 18 | 18 |

The 7 new passes are negative rows: class/label/`var` named `await` in a Module. No row regresses.

**Tests (F0 file, 75 green):**

- the reviewer's program with `inferModuleStrictArguments: false` alone, with and without skipSemanticDiagnostics;
- a table over {`scriptGoal`: true, absent} × {`inferModuleStrictArguments`: true, false, absent}, whose dead
  binding is one of four programs:
  - Script-only (`import.meta`), refused wherever a Script is possible;
  - Module-only (`var await` in a function), refused wherever a Module is possible;
  - both-goals (`await 0` in a function), always refused;
  - legal, compiles everywhere.

**Mutations:**

| mutation | tests that fail |
|---|---|
| walk only the given options | 7 |
| drop the Module `await` rule | 3 |

**Byte difference the reviewer saw.** `language/types/number/S8.5_A4_T1.js` contains `var NaN;`. The pass now
keeps that declaration (never-elide rule), so its binary differs from main. It passes on both sides.

**Module-goal finding, recorded in #7445.** A dead `let undefined = 1;` on the ordinary compile under a stated
Module goal now meets the existing trap for a kept restricted declaration and throws at instantiation, where node
and main are fine. Restricting the never-elide rule to Script or unstated goals needs the goal threaded through
`elideWithIrIds` and both callers, not a two-line change, so it is in #7445 with the per-goal table. The body of
#7445 is corrected: `checkRestrictedGlobalLexicals` is gone, and the per-goal behaviour is now stated.

### Review round 4 (2026-11-21)

**Finding.** Round 3's `GOAL_WALKS` ran the Script walk on the SourceFile the real gate then validates. The
detector memoizes per node: `strictModeCache` and the Module-goal mark are a `WeakMap`/`WeakSet` keyed by node.
So the Module-goal gate read the Script walk's "not strict" answers, breaking the rule in `predicates.ts` that no
cached answer may predate the mark. Under the Module goal, `var l = 010;`, `function f(a, a) {}` and `'\07'`
compiled, and a dead `var d = function (a, a) {}` was elided. Two test262 module negatives
(`module-code/early-import-eval.js`, `early-import-as-eval.js`) lost their early-error refusal.

**Fix, structural.** Each walk parses the text afresh (`ts.createSourceFile`, same script kind) and discards the
parse (`frontendErrorOffsets`, `src/test262/prepared-dead-bindings.ts`). Both caches are keyed by node identity,
so a separate parse cannot write anything the real gate reads. The comment at the parse says why.

**Test seam and property test.** The strict entry's `compile` takes the elision as a test-only third parameter.
Five option sets: runner, unstated goal, `inferModuleStrictArguments: false` alone, Module goal, and Script with
semantic diagnostics. For every program of the F0 test file under each set, the gate's verdict with the elision
must equal its verdict with the identity, except where the bypassed compile was refused only by the backend. A
program the elision lets compile must then run as node runs it (Script sets).

| mutation | caught by |
|---|---|
| round 4's defect: walks back on the real SourceFile | 9 tests, among them the Module-goal property row |
| round 3's defect: walk only the given options | 10 tests, among them three property rows |

The four round-4 programs are rows too, refused under the Module goal with and without semantic diagnostics.

**Proof.**

- **F0 tests:** 88, green.
- **Module negatives,** run the IR-lane way (reviewer's `prepneg.mts`: worker options, assembled harness,
  standalone), 198 files on main, 873efed6e4 and the head:
  - `early-import-eval.js` and `early-import-as-eval.js` are `REF-FE:early` on all three;
  - the only changes are the 7 `await` negatives, from back-end to early refusal.
- **457-file A/B** (`scriptGoal` patch, standalone, main vs head): exactly 7 fail → pass (`class-name-ident-await*`
  ×4, `reserved-words/await-module`, `labeled/value-await-module*` ×2), 0 regressions.
- **Wrong answers:**
  - round-4 `await` programs, 46 × 14 lanes: no new wrong answer vs main on any lane. The 2 left on the Prepared
    lanes (M12, an `export` with no stated goal) are identical on main.
  - round-3 attack programs, 30 × 8 lanes: 0 wrong.
- **Early-error test files, failing tests per side (main / head):**

  | file | main | head |
  |---|---:|---:|
  | issue-990 | 2 | 1 |
  | issue-3632 | 3 | 3 |
  | issue-2923-eval-const-broaden | 9 | 9 |
  | 17 others | 0 | 0 |

  `test262-prepared-entry` is 44/44.
- **Bytes:** ordinary 50 × 2 targets identical to main; Prepared fixtures as before (the same 4 all-dead rows).
- **Cost** (30 rows of the 411-row sample, Prepared, Script, semantic skipped, median of 3):

  | tree | median | p90 |
  |---|---:|---:|
  | main | 33.1 ms | 66.7 ms |
  | 873efed6e4 | 35.2 ms | 90.4 ms |
  | head | 39.6 ms | 75.8 ms |

  The two extra parses cost a few ms per row.

**Quality.** `checkReservedIdentifiers` has its JSDoc back. Three shapes are still accepted under the Module goal,
as on main: `({await}) => 0`, `({await} = {})`, `var g = function await(){}`. They are in #7445. The detector is
otherwise untouched this round.


## M1 result (2026-11-20, branch `claude/7354-m1`)

Member read and write on the Prepared dynamic value for every carrier kind (number, boolean, string, undefined, null,
ordinary object), ToPrimitive of the object kind, `dyn.object_tag`, one exception tag. Base: PR 7349 (e0f173cfd0),
then `origin/main` 052569d335 (7349 + the #7380 validator and self-check switch) merged in.

### Ported (merge commits name the source; authored on the other lane's branches, unreviewed there)

| from | commits | content |
|---|---|---|
| `origin/claude/7354-o` @ e587829733 | O2 8ff5416556, O4 53357b3b9f, O3 14345199fe, O2b 9c052e9f40 / 8e8d651c30 | object kind, member read, member write (OrdinarySet), runtime-guarded OrdinaryToPrimitive, realm rows `set` / `has` / `create-type-error` |
| `origin/claude/7354-shared-exn` @ 048fdd1df7 | S13 667ecb196d | the realm kernel throws under the program's `__exn`; `catches` = "the program reads a catch binding" (`readsCatchPayload`) |

### Corrections

- **C1** `unplain` / `PROTOTYPE_GLOBALS` / `prototypeReach` deleted; `ProgramObjects` = `{present, namesSymbol}`. The
  premise (no Prepared program obtains a built-in prototype as a value) is `tests/issue-7354-m-prototype-premise.test.ts`
  (12 routes, exact texts); the slice that makes one compile must bring a gate back.
- **C2** one kind answer: `carrierKindOf(value, types, definitions, boxTag?)` in `dynamic-value-kinds.ts` (Boolean,
  null, dynamic, string, number, create-default object, through a coercion). `boxedKind` and `carrierKind` are gone;
  the box arm, `knownKinds`, the coercion rule and `refuseUnadmittedThrows` all call it.
- **C3** Object.prototype's keys are the catalog's: the catalog key reads (`realmStringKeys`, `OBJECT_PROTOTYPE_KEYS`,
  the accessor keys) moved from `src/ir/realm-keys.ts` (classified mixed-needs-split, which a clean ir-program module
  may not import) into the clean `builtin-prototype-keys.ts`; `realm-keys.ts` re-exports the two names its importers
  use. Wrapper-prototype lists stay as spec lists.
- **C4** 7349's `chainBuilders` / `knownKinds` / `additionBuilder` kept; O's or-chain `disjunction` replaces the
  addition's hand-written fold (same left fold, so object-free bytes are unchanged); ToString / ToNumber are
  `conversionBuilders`. The builders moved to `dynamic-value-chains.ts`: `dynamic-value-legalization.ts` is 355 lines
  (7349: 627).
- **C5** computed keys keep refusing (`dyn.member_get with a computed key`, `… member_set …`), pinned for `o[k]`,
  `o[k] = 1`, `v[0]`.
- **C6** every catalog accessor key of `%Object.prototype%` (`__proto__`) refuses in the primitive write arm, strict
  and sloppy: `member write '__proto__' of a <kind> needs Object.prototype's accessor`.
- **B-tag** `OBJECT_TAG: Record<CarrierKind, string>`; `dyn.object_tag` is a `kindChain` of `"[object X]"` texts over
  the kinds the value may hold; the object row refuses in a program that names `Symbol`.

### The TypeError rule (lead decision; replaces O2b's `js.object.uncatchable-type-error` trap, now deleted everywhere)

The legalization raises a TypeError itself for a nullish member read / write, a strict write to a primitive, and an
object whose `toString` is not callable (`typeError` in `dynamic-realm-calls.ts`, the one helper). In a program that
**reads a catch binding** (S13's `readsCatchPayload`: any use of the binding but as a rethrow operand, or a
destructuring pattern), that TypeError refuses at compile time:
`TypeError "<V8 message>" in a program that reads a caught value`. In every other program it is thrown under the one
exception tag: a catch that only binds or rethrows it catches it, and with no catch it ends the program as node's
uncaught TypeError does. Both sides are tested (`issue-7354-m-refusals`, `issue-7354-m-catch-and-tags`).

### Semantics as implemented (constant keys; §6 of the plan)

| receiver | read `v.k` | write `v.k = x` |
|---|---|---|
| undefined, null | TypeError (rule above) | TypeError (rule above) |
| object | realm [[Get]] (own value or `undefined`) | realm OrdinarySet |
| object, catalog key | refuse `member read 'k' needs Object.prototype's properties` | refuse `member write 'k' needs …` |
| number / boolean / string, wrapper or catalog key (string: also `length`, array index) | refuse `member read 'k' of a <kind> needs its wrapper prototype` | — |
| number / boolean / string, other key | `undefined` | sloppy: ignored; strict: TypeError; `__proto__`: refuse (C6) |
| any, computed key | refuse `dyn.member_get with a computed key` | refuse `dyn.member_set with a computed key` |

ToString / `+` / ToNumber of an object: `HasProperty(o, "toString")` ? TypeError : `"[object Object]"` (NaN for
ToNumber); `Symbol` named → refuse. `Object.prototype.toString.call(v)`: `[object Number|Boolean|String|Undefined|Null|Object]`.

### Proof

- Tests: `issue-7354-m-member-access` (5 batched programs, groups A, B), `-m-catch-and-tags` (6: C, D34, D35, E37 + C1,
  F40, F42-43), `-m-refusals` (40), `-m-prototype-premise` (12), `-m-sweep` (12: ten operations × 14 receiver kinds,
  a top-level script var, T/Ty/Str2-c/D1 with `{}`), helper `tests/helpers/prepared-node-agreement.ts`. Each §8
  program asserts node's `out` (returns) and a wrong one (throws). All pass, plus every O-lane test (o, o2, o2b, o3,
  o4, shared-exception-tag) and d1, h, h2, h3, x, t, ty, str, str-emitter, p.
- Pins moved (own commits): O4/O3/O2b/X trap pins → refusal pins (TypeError rule); O2 `"" + e` on a caught object →
  refusal pin; H "an object literal returned from an unannotated function" refused → runs (node-checked); O4 "a
  program that names a prototype global" refused (unplain) → runs; 3518 contracts pin drops the uncatchable row.
- Mutations (each deleted alone, tsx probe; all killed): carrierKindOf's object rule; each `MEMBER_ACCESS_ARM` row
  (6); the catalog-key refusal; the wrapper-key refusal; the computed-key refusal; C6; the `sloppy` bit (both
  directions); `namesSymbol` in B-tag and in ToPrimitive; each `OBJECT_TAG` row (6); the TypeError rule; the
  `complement` kind test. Survivors: none.
- Bytes (vs `origin/main` 052569d335): ordinary pipeline, 60 test262 files (Object.prototype.toString.call, catch
  bindings, member writes on any, `+`) × default + standalone: 120/120 identical. Prepared path: 250 programs without a
  member op or object literal extracted from the d1/t/ty/str*/x/p/h*/vg tests, 115 accepted, all identical.
- Gates (bare, exit 0): typecheck, loc and func budget (also with `LOC_GATE_BASE=origin/main`), coercion-sites,
  oracle-ratchet, dead-exports, import-cycles, compiler-boundaries inventory (the O merge had listed
  `settled-verdict.ts` twice). Ported growth granted by this file's frontmatter: from-ast +16 (O1-O3), program-source
  +14 (O3 strictness input), program-physical-plan +5 (S13), compiler.ts +2.

### Sample (411 ES5 rows, Prepared path, real prelude, after the main merge)

Before (`m1120/all-7349.jsonl`, the lead's run on e0f173cfd0): 293 `dyn.member_get`, 73 `not-direct`, 26 `assert` not
in scope in verifyProperty, 14 pass (negatives), 5 other. After: **293 `TypeError "Cannot convert object to primitive
value" in a program that reads a caught value`** (formatSimpleValue's `String(value)` on a value that may be an object
— PR 7355's `$262 = {…}` literal makes every row build objects — in a program whose catch reads `err`), 73
`not-direct`, 26 verifyProperty, 14 pass, the 5 others unchanged (2 of them now name the TypeError rule after their
parse note). Compile time per row: median 32 ms, max 861 ms (every row refuses before emission). On a 40-row subset
before the main merge the 24 member_get rows stopped at `… (reading 'name') in a program that reads a caught value`
instead. Step-past probe (prelude with the catch reading nothing): `identifier "assert" is not in scope in assert`, as
the plan predicted. Realm program compile: ~19 s on 7349, ~1.4 s after the main merge (~20 s with the validator on,
as under vitest).

### Not done / known

- **M2 must follow at once**: every row stops at the TypeError rule. M2 (error as a carrier kind, `js.object.is-error`,
  name/message reads, its ToString / typeof / object_tag) lifts the refusal; no tally change expected until Fa part 2.
- Pre-existing on 7349 (not M1): `function f(v){ v.a += 1; }` throws out of `compile()` ("internal capability
  violation — binary operator '+=' is capability-deferred …"); `v.a++`, `switch (v.k)`, a return inside try refuse in
  from-ast.
- No adversarial review run yet; plan §5 corrections done as listed.

### Corrections to the sections above (after the M1 review, 2026-11-21)

The M1 sections above describe the state at c417b11b1c and are wrong in three places:

- **A loss against main (review finding 1).** With M1's TypeError rule, a program with one object literal anywhere
  and a catch that reads its binding refused every ToString / ToNumber of an untyped value
  (`TypeError "Cannot convert object to primitive value" in a program that reads a caught value`), where main
  answered, e.g. `function g(){ var o = {a:1}; return o.a; } function f(v){ return +v; } var out = String(f(3)+g());
  try{throw 2}catch(e){out += typeof e}`. M1 did not land alone; M2 below is the fix, and the rule is gone.
- **Two exceptions out of `compile()`** (also on main): `function f(){ var o = {}; return o.a === undefined ? 1 : 0; }
  f();` (the #7380 validator's "retains a dynamic type after legalization") and `function f(v){ v.a += 1; }`
  ("internal capability violation"). Both fixed below.
- **"Every O-lane test passes" was not true**: `tests/issue-7354-o-objects.test.ts` "refuses what the later steps
  build" failed with the validator on (it fails on `origin/main` 052569d335 too: the test came with PR 7312, the
  validator after it, so main is red on it and this PR fixes it); the d1 test "reads a dynamic object field back"
  timed out at 35 s; several long files exited 1 on a vitest RPC timeout.

## M2 result (2026-11-21, same branch)

### Design as built

- **Kind `error`** (`src/ir/program/dynamic-value-kinds.ts`): a row in every `Record<CarrierKind, …>`, before
  `object` (which stays the complement): `TYPEOF_NAME` "object", `KIND_TEST` `js.object.is-error`, `TO_STRING_ARM`
  "error", `TO_NUMBER_ARM` "nan", `ADD_ROLE` concat, `OBJECT_TAG` "Error", `MEMBER_ACCESS_ARM` "error".
  `admittedKinds(program)` admits it where the program reads a catch binding (S13's `readsCatchPayload`), the one way a
  TypeError the legalization raises becomes a value.
- **Realm rows** (`native-source-objects.ts` `ROWS`, `source-object-bodies.ts`, `ordinary-object-callables.ts`,
  manifest): `js.object.is-error(value) -> i32` (`ref.test` of the realm's `$Error_struct`; a call contract, the
  layout is the realm's) and one parameterised `js.object.error-field(error, selector) -> externref` (name 1,
  message 0).
- **Builders** (`dynamic-value-chains.ts`): `kindTest`'s realm test; `errorField`; `concat`, shared with `+`; ToString
  of an error `name + ": " + message` (Error.prototype.toString, exact here: the realm's TypeError has name
  "TypeError" and a non-empty message, and no code can write either); `toNumber` over the kinds that convert.
- **Member access** (`dynamic-member-access.ts`): error arm reads `name` / `message` from the fields, `undefined` for
  any key Error.prototype and Object.prototype do not hold; `typeError` lost its `readsCaught` parameter.
- **Producer fixes** (finding 2): `legalizeSourceDynamicValues` (`source-dynamic-contracts.ts`) legalizes every function
  on the native lane (the "has a dynamic contract" gate, `convertsDynamicToString`, `readsTypeofOfAbsentGlobal`,
  `bindsCatch` and the dead `signatures` / `globals` parameters are gone); a function without a dynamic value is
  returned unchanged, so accepted programs keep their bytes. `assertNotDeferred` (`capability.ts`) refuses by name on
  the selector-less Prepared path (#7364 `unselected`): `binary operator '+=' is capability-deferred in f`.
- **One refusal form** (finding 5): `<access> of <receiver> needs <what the realm lacks>`, built once in
  `memberAccess`; the receiver is its kind, or "a value that may be" the kinds whose answer is missing, e.g.
  `member read 'toFixed' of a value that may be a number needs Number.prototype's properties`.

### What a program that reads a caught value still refuses

- A member **write** whose receiver may be the caught error: `member write 'k' of a value that may be an Error needs
  property storage on the realm's error`. A caught value may always be the error, so every dynamic member write in
  such a program refuses (M1 refused them too, by its rule).
- A read of an error's `constructor`, `toString`, `stack` or another Object.prototype key (`… needs Error.prototype's
  properties`).
- `Object.prototype.toString.call(e)` on the catch binding itself: `a dynamic value flows into unknown without a
  conversion (CallExpression)` (the checker types `e` as `unknown`; through a parameter it answers "[object Error]").

### Review findings

1. Fixed by M2; the review's two programs and six variants are node-checked
   (`tests/issue-7354-m2-objects-beside-catches.test.ts`).
2. Fixed (producer, above); `v.a += 1` is a named refusal (test in m-refusals). Test infrastructure: m-sweep is four
   files over `tests/helpers/member-access-sweep.ts`, each program over part of the receivers; the d1 test has 180 s.
   The exit 1 of m-catch-and-tags and the long O files was neither a hang nor plain load: a realm compile blocks the
   vitest worker for tens of seconds and vitest's RPC reply was left unread past its deadline ("Timeout calling
   onTaskUpdate"); the Prepared run helpers wait 25 ms before each compile (`yieldToRpc`).
3. program-source.ts: growth over main 0 (`sourceCodeStrictness` became one optional call at its call site; the
   legalize call shrank). program-physical-plan.ts: +1 (S13's realm condition, one wrapped line). from-ast.ts +16
   (O1-O3's own lowering arms: `isRawExternrefReceiver`, the member write's externref receiver, the object-literal box
   in `boxConcreteToDynamic`; they are from-ast's AST lowering and have no other home) and compiler.ts +2 (the
   import and the one `codeStrictness:` row of the Prepared preparation input, at the only place the compiler
   options are read) keep their grants. Leftovers done: `LegalizationProgram` is the one program type, `receiver` /
   `key` parameters dropped, the header rewritten, the unreachable `tag.test` Object arm deleted, realm-keys.ts no
   longer forwards (its six importers read builtin-prototype-keys.ts).
4. shared-exception-tag asserts behaviour (a realm TypeError thrown in one unit caught in another) and the tag
   section's entry count read off the binary; the 3518 provider count line and the contracts closed-list equality are
   gone (every manifest feature has its declaration; the table checks signatures).
5. Fixed (one form, above); every test that quoted a text was updated from a grep of the old wordings.

### Proof

Changed root test files (each run alone, `JS2WASM_EVAL_ENGINE=interpreter`, validator on as vitest sets it; the
`changed-root-tests.sh` list, 23 files, including the 3 it does not run itself):

| file | exit | time | tests |
|---|---|---|---|
| issue-3518-native-realm-source-integration | 0 | 286 s | 24 |
| issue-3518-ordinary-object-callable-contracts | 0 | 1 s | 43 |
| issue-3518-ordinary-object-runtime-providers | 0 | 102 s | 173 |
| issue-7354-d1-dynamic-carrier | 0 | 76 s | 44 |
| issue-7354-h-script-var-dynamic-home | 0 | 144 s | 64 |
| issue-7354-m-catch-and-tags | 0 | 331 s | 6 |
| issue-7354-m-member-access | 0 | 418 s | 5 |
| issue-7354-m-prototype-premise | 0 | 26 s | 12 |
| issue-7354-m-refusals | 0 | 75 s | 42 |
| issue-7354-m-sweep-1 | 0 | 279 s | 7 |
| issue-7354-m-sweep-2 | 0 | 269 s | 7 |
| issue-7354-m-sweep-3 | 0 | 215 s | 6 |
| issue-7354-m-sweep-4 | 0 | 230 s | 6 |
| issue-7354-m2-caught-errors | 0 | 302 s | 5 |
| issue-7354-m2-objects-beside-catches | 0 | 182 s | 3 |
| issue-7354-o-objects | 0 | 194 s | 13 |
| issue-7354-o2-object-values | 0 | 376 s | 11 |
| issue-7354-o2b-to-primitive | 0 | 295 s | 15 |
| issue-7354-o3-member-write | 0 | 361 s | 21 |
| issue-7354-o4-member-read | 0 | 460 s | 16 |
| issue-7354-shared-exception-tag | 0 | 205 s | 5 |
| issue-7354-str-strings | 0 | 37 s | 19 |
| issue-7354-x-dynamic-throw | 0 | 135 s | 60 |

(m-sweep-1/2/3/4, m-member-access, m-catch-and-tags, m2-objects-beside-catches, o-objects and
native-realm-source-integration ran before the refusal-wording commit 7f90831ddc, which changes no behaviour and
none of whose quoted texts they assert.)

- The reviewer's 327 probes (`/home/user/js2/.tmp/rv-m1/b1-b7`), re-run at 1f5a8ec0b3: 0 wrong answers, 0 traps,
  0 invalid modules, 0 exceptions out of compile(); against the reviewer's run at c417b11b1c, 17 refusals now answer
  as node and the 2 compile() exceptions are named refusals; none that answered refuses now.
- M2 mutations (each deleted alone, tsx probe; killed unless noted): the is-error test (killed in a program that also
  builds objects; with no object literal the error kind is the chain's last and untested), each M2 row of
  `TYPEOF_NAME`, `TO_STRING_ARM`, `ADD_ROLE`, `OBJECT_TAG`, `MEMBER_ACCESS_ARM`, `admittedKinds`' catch condition, the
  field selectors, `ERROR_OWN_KEYS`, the Error.prototype key refusal (by `e.stack`), the error write refusal.
  Survivors: `TO_NUMBER_ARM` error "nan" → "unbox" (the unboxer answers NaN for any other reference, so the two are
  equivalent here); the Object.prototype-key half of the error read refusal (implied: a caught value may always be a
  primitive, whose arm refuses those keys first).
- Bytes vs `origin/main` 052569d335: ordinary pipeline, 60 test262 files × default + standalone, 120/120 identical.
  Prepared: 194 programs without a member operation, object literal, throw or catch from the d1/t/ty/str*/x/p/h*/vg
  tests, 98 accepted, all identical.
- Gates (bare, exit 0): typecheck, loc and func budgets (also with `LOC_GATE_BASE=origin/main`), coercion-sites,
  oracle-ratchet, dead-exports, import-cycles, compiler-boundaries inventory in CI mode
  (`--mode inventory --base <merge base>`).

### Sample (411 ES5 rows, Prepared path, real prelude, at 1f5a8ec0b3)

| first gap | 7349 (`m1120/all-7349.jsonl`) | M1 (c417b11b1c) | M1 + M2 |
|---|---|---|---|
| `dyn.member_get` | 293 | 0 | 0 |
| M1's TypeError rule | 0 | 293 | 0 |
| `identifier "assert" is not in scope in assert` | 0 | 0 | 293 |
| `not-direct` | 73 | 73 | 73 |
| `assert` not in scope in verifyProperty | 26 | 26 | 26 |
| pass (negatives) | 14 | 14 | 14 |
| other | 5 | 5 | 5 |

Compile time per row: median 45 ms, p90 72 ms, max 907 ms (every row refuses before emission). As the plan
predicted, the 293 rows move to Fa part 2's "declaration read as a value".

## Slice F1a (steps 1–3) result (2026-11-21, branch `claude/7354-f1`; steps 4–6 are F1b)

Base: `claude/7354-m1` 333a3f2fc7, then `main` 69dbe732c3 merged in (M1, M2 and F0, PR 7362). Stopped before step 4 on
the plan's own Risk-1 rule (below).

**F1b (not built):** step 4 declarations read as values (`program-source-function-values.ts`, the trampoline unit, the
direct-plan-first call order), step 5 R7 (direct calls inside module-init closures), step 6 function-object
properties (kernel source-closure arm, `js.function.init`, `emitFunctionObjectInit`, `BUILTIN_REACHABLE_KEYS.function`).
Waits for the compile-time fix of closure programs (slice Perf3).

### Built

- **F0**: this branch first built its own (`withoutDeadBindings`, an early-error guard, `earlyErrorGoals`); after
  main's F0 (PR 7362, `src/test262/prepared-dead-bindings.ts`) landed, the merge dropped all of it for main's. Nothing
  of the branch's F0 is kept. Main's F0 test is adapted: its dropped closures read `this` (refused, C2), because a
  plain function expression is a value now and an unelided one would compile (slowly) instead of refusing.
- **Fa ported as content** (not its commits): the all-dynamic closure signature, `staticFunctionValue`, written
  parameter slots, N1, the closure-site re-typing. Corrections: (a) the one kind answer is `carrierKindOf` (callable →
  `function`; the `__ir_dyn_call_box` projection via `functionValueOperand`); the box arm and the projection share one
  `intoCarrier`; Fa's stricter "dynamic" rule was NOT folded in (every dynamic-typed value is produced by an admitted
  box or a legalized operation; the rule would refuse M1's member-read results); (b) exhaustive; (c) the carrier-type
  mapping moved to `src/ir/program/dynamic-carrier-types.ts`: the legalization is 347 lines (M1: 350).
- **The function kind**: a row in every table of `dynamic-value-kinds.ts` (typeof "function", test
  `js.value.is_function` from fa-ty, tag "Function", ToString/ToNumber via ToPrimitive, `+` concatenates, member
  access "object"), admitted only where the source creates a function value (`ProgramObjects.functions`).
- **D6** (`ordinary-to-primitive.ts`): Get in hint order (string for ToString, number for ToNumber and `+`); a callable
  method, and a function value's own ToPrimitive, end at the run-time abort `js.value.unsupported` (J's row: body
  `unreachable`). Without function values only `toString` is consulted, so those programs keep their bytes.
- **D4**: a member write of Object.prototype's writable data keys creates an own property; only `__proto__` refuses.
- A returned closure boxes as a function value (`argumentIntoDynamic`, shared with arguments).

### Found and fixed on the way

- An exception out of `compile()`: a module-init of ~20+ statements is chunked, and Fa's static closure value (an SSA
  value in the shared scope) was called from another chunk's function (`closure.call callee must be closure/callable
  IrType, got val`). The value is now used only in the body that built it; across chunks the call refuses by name.
- D6's first cut defined an SSA value twice (an arm reused its parent's result); caught by a probe, fixed.

### Not built (the plan's steps 4-6) and why

- **Risk 1 tripped** (plan §13: "if 30 closures exceed ~10 s, stop and hand the profile to the perf lane before step
  4"). Measured (tsx, validator off): `var cI = function (x) { return x; }` × 1 / 10 / 30 with one call each: 1.6 s /
  7.9 s / 43.6 s (the 30-closure run then hit the chunk exception above). Profile of the 10-closure program: 5.3 s of
  9.3 s in `assertNativeSourceClosureRequirementsCurrent` → `same` → `preparedIrDataMismatch` (structural
  re-comparison per body fill, `program-native-invocation.ts requireOwner`), i.e. quadratic self-checks, not F code.
  A program with one closure, one object, a catch and ~6 `+` took 196 s. Under vitest (validator on) one closure
  program costs 20-40 s.
- So declarations as values (step 4), R7 (step 5) and function-object properties (step 6) are not built. Until step 6
  a member read or write whose receiver may be a function value refuses by name: `member read 'k' of a value that may be
  a function needs the realm's function objects`.

### Proof

Tests (each a program through the strict Prepared entry, node's answer returns and a wrong one throws):
`issue-7354-f1-function-kind` (7), `-f1-to-primitive` (4), `-f1-function-expressions{,-2,-3}` (4/3/2), Fa's file (53).
After the main merge every test file this branch adds or modifies (18, incl. main's F0 test) ran in full, exit 0.
Existing pins changed: m-refusals (`__proto__` text; the `toString` write runs now), o3 (`isPrototypeOf` write runs),
h and str2 (refusal programs use their binding, F0), d1 (selection rows), o2 (`functions`), x (closure pack admitted;
Fa's stricter-rule test dropped), 3518 core vocabulary (48 ids), 3526 (two nullary calls).

Mutations (each alone): ToString hint → number, callable method skipped, function kind admitted everywhere, D4's
`!== "type-error"` (killed by m-refusals: without it the refusal names `undefined`/`null` among the receiver's kinds)
— all killed by a run. By the tests that pin them: each function row of TYPEOF_NAME / KIND_TEST / OBJECT_TAG, the
callable and projection rules of `carrierKindOf`, `intoCarrier`'s function case, the interim member refusal, the
chunk guard, the return box. Survivor, kept on purpose: the `!isCallable → ["toString"]` gating (answers equal; it
keeps the bytes of programs without function values; the reason is a comment at the line).

Bytes vs main 69dbe732c3: ordinary pipeline, 20 test262 files (Function/Object toString, typeof, function
expressions, addition) × default + standalone: 40/40 identical. `check:prepared-bytes` (804 rows): only row 149
differs (a closure reading a later-declared local now refuses by Fa's own name).

### Sample (411 rows, real prelude; at b9d8346b3d and again after the main merge, same tally)

| first gap | M1+M2 | F1 |
|---|---|---|
| `identifier "assert" is not in scope in assert` | 293 | 0 |
| `member read 'name' of a value that may be a function needs the realm's function objects` | 0 | 293 |
| `not-direct` | 73 | 73 |
| `assert` not in scope in verifyProperty | 26 | 26 |
| pass (negatives) | 14 | 14 |
| other | 5 | 5 |

The plan expected "unchanged" for F1; the prelude's function expressions admit the function kind, so its member reads
reach the interim refusal before `assert`. Step 6 (the realm's function objects) is what moves them.

## U0 result (2026-11-21, branch `claude/7354-u0` from `origin/main` 4468443785)

The runner rule of U-D7: on the Prepared lane a Wasm trap is never the expected throw.

- `scripts/test262-runtime-verdict.mjs` (new): `isWasmTrap(err)` (`WebAssembly.RuntimeError`; a
  `WebAssembly.Exception` is a JS throw and stays a throw), `runtimeNegativeThrowAccepted` (the matcher, moved
  verbatim from the worker, with the renderer passed in), `asyncRowVerdict`, and `renderHostError` (the
  worker's trap-frame rendering, moved verbatim so the test sees the real text).
- `scripts/test262-worker.mjs`: the lane is `preparedRequest !== undefined` (the job's `wholeProgram`
  request, which `tests/test262-shared.ts` sets exactly when `TEST262_COMPILER_PATH=ir`). Both throw arms
  (instantiate, `__module_init`) and the async drain use the module. The third site the plan named (the
  `test()` path) is the no-throw arm; it is reached only without the original harness, so its
  `!originalHarness || …` guard was always true and is now `isRuntimeNegative` alone.
- Async: with a completion marker and a drain error, a Prepared row fails as
  `async continuation threw after completion: …`. The Prepared drain is one module's ring and stops at its
  first throw, so the error came after `$DONE`.
- Tests: `scripts/test262-prepared-trap-verdict.test.mjs` (`node --test`, in the CI step beside
  `test262-prepared-frontend-report.test.mjs`), on a hand-encoded module with `$Test262Error` and
  `$assertThrows` frames. Removing the Prepared trap arm fails the two runtime-negative trap cases; removing
  the async arm fails the drain case; applying either arm to every lane fails the three non-Prepared pins.
- Other lanes: 20 standalone rows (10 runtime negatives, 10 positives) through `tests/test262-chunk-dynamic.test.ts`
  with the base worker and with this one: identical status and error text on all 20.
- Not measured: how many Prepared rows change (the lane refuses before emission on most rows today). The same
  hole on the other lanes is #7447.

## S result (2026-11-21, branch `claude/7354-s` from `claude/7354-m1` 333a3f2fc7)

A script `var` named as the first argument of `Object.defineProperty(v, …)` keeps its home on the Prepared path.
TypeScript's binder records that argument as a declaration of the binding; `irOwnedScriptVarHome` counted it as a
second declaration and withheld the home, so the program refused as `has no exact typed storage: not-direct`.

What changed:

- `src/shared/binding-writes.ts`: `isJsPropertyDeclarationTarget` (member write or first call argument) moved here
  from a private copy in `src/ir/module-bindings.ts`; both the resolver and the home classifier import it.
  `isMemberWriteDeclaration` is now module-private.
- `src/ir/module-binding-script-var-home.ts`: `own` skips every JS property declaration (the filter is gone); the
  comment states the current reason (#7364: from-ast refuses the unadmitted call by name).
- `src/ir/from-ast.ts` `tryLowerObjectStaticCall`: the sweep found `o.hasOwnProperty('p')` on a dynamic script var
  throwing an `IrInvariantError` out of `compile()` (reachable before S for any `var o = {}`). The throw is now
  `refuseUnselected`, line-neutral; the ordinary pipeline keeps the invariant.
- S-D5 (named reasons for the remaining `not-direct`) not done: the reason would have to travel through the
  `IrScriptVarHome | undefined` contract, `directTopLevelDeclaration` and `inspectDirectBinding`, more than a few lines.

Measurements:

- `tests/issue-7354-s-script-var-define-target.test.ts` (13 tests). Updated expectations: two rows in
  `tests/issue-7354-h-script-var-dynamic-home.test.ts`, one in `tests/issue-7354-m-refusals.test.ts`.
- Sweep: 1,296 programs (6 binding forms × 9 positions incl. before the declaration, try/finally, if/else, switch,
  nested loops × 12 operations × with/without an extra `Object.defineProperty`): 108 run with node's answer, 1,188
  named refusals; zero `not-direct`, invariant errors, exceptions out of `compile()`, invalid Wasm, traps.
- Mutation: restoring the filter fails 3 tests (top level, number var, before the declaration). A call inside a
  function refuses at the call either way, because that unit fails before module-init resolves the binding.
- `check:prepared-bytes`: rows 47 and 48 (the two `Object.defineProperty` programs) change from `not-direct` to the
  call's refusal; all other rows identical. Ordinary pipeline: 20 test262 files × default and standalone identical.
- ES5 sample (411 rows, real runner, base re-run on 333a3f2fc7): base 296 `identifier "assert" is not in scope in
  assert`, 73 not-direct, 26 verifyProperty, 2 other, 14 pass → head 346 / 1 / 47 / 3 / 14. The 72 rows that left
  `not-direct`: 50 to `assert`, 21 to `identifier "assert" is not in scope in verifyProperty`, 1
  (`15.2.3.6-3-41.js`) to `identifier "JSON" is not in scope in formatIdentityFreeValue`. The remaining
  `not-direct` is `var Infinity` (S8.5_A10_T1.js). Negatives: 14 pass, unchanged.

Not verified: that `n` in `var n = 1; Object.defineProperty(n, …)` keeps the typed (not dynamic) home — the program
refuses at the call before anything observable; the runnable `var Object = {}` proof of the plan refuses on the
checker's diagnostics (`Property 'defineProperty' is missing in type '{}'…`), not on a binding.

### Review round 1 (PR 7374; 314 probes: 0 wrong, 0 exceptions, 0 invalid Wasm; NOT MET on A1)

The sections above describe the state before this round where they differ; this list is current.

- **A1 (fixed).** ToString of a value that may only be a function refuses at compile time: `ToString of a function
  needs Function.prototype.toString` (`TO_STRING_ARM.function = "function-source"`, the refusal in `stringOf` when every
  kind the value may hold has that arm). The run-time abort stays an arm beside kinds that answer (a parameter, a
  caught value). To make "only a function" knowable, a script var whose home holds its own closure reads as that
  closure's function value in its module-init (from-ast's `moduleGlobal` read), and the kind proof (`knownKinds`)
  learns the function-value projection. ToNumber of a function is NaN, exact while a function value has no own
  `valueOf`/`toString` (`TO_NUMBER_ARM.function = "nan"`); `+` concatenates, so `f + 1` refuses with the ToString text.
- **A2 (ruling, comment).** An object's callable `toString`/`valueOf` stays the run-time abort: whether a property
  holds a function is a run-time fact of that object (comment at `skipUnlessCallable`).
- **B1 (fixed).** `MEMBER_ACCESS_ARM.function = "function-objects"` drives the member refusal; a receiver known to be a
  function now reads `member read 'k' of a function needs the realm's function objects`.
- **B2 (fixed).** Behaviour tests in `f1-function-kind` make each function row observable: `op(v){ return v + 1 }`
  over a number, a string and a function (ADD_ROLE), `str`/`num` over numbers, Booleans and a function (TO_STRING_ARM,
  TO_NUMBER_ARM), the caught function value, typeof / isPrimitive (TYPEOF_NAME, KIND_TEST), the tag test
  (OBJECT_TAG), the member refusals (MEMBER_ACCESS_ARM). Survivor: TO_NUMBER_ARM "nan" → "unbox" (the unboxer answers
  NaN for any reference, the M2 precedent).
- **B3 (fixed).** `functionValueOperand` lives in `src/ir/program/function-value-projection.ts`, the module that owns
  the `__ir_dyn_call_box` pattern on the Prepared side; the projection of anything but a packed callable refuses as
  `__ir_dyn_call_box of <value>, which is not a packed callable`.
- **B4 (fixed).** The no-closure-root branch of the function test is gone: the test is requested only where the
  source creates a function value, and such a program lowers a closure or refuses; no probe reached it (an IIFE, an
  uncalled function returning a closure, a dead closure in `if (false)`), so the case is a named resource failure.
- **B5 (fixed).** No growth against main in `from-ast.ts`, `program-source.ts`, `ir-program-presentation.ts`, and no
  grant: `unboundIdentifierDetail` moved to `identifier-read.ts`; Fa's `argumentIntoDynamic` moved to
  `function-object-lowering.ts` as `concreteIntoDynamic` (offsets the read arm above); the `__self` slice is
  `callableCarried`'s `closureUnit`; N1 lives in the Prepared script-var home classifier
  (`module-binding-script-var-home.ts`, same text). `functionValue.in` is an `IrFunctionBuilder`.
- **B6 (fixed).** The forged-IR legalization tests of the Fa file (and the closure-pack row of x's table) are deleted;
  every path they covered is reached by the source programs of the Fa and F1 files. The vocabulary count pins are a
  uniqueness check and "every id has its definition".

After the round (main ab820ab6d6 merged): every test file the branch adds or modifies, 18, ran in full, exit 0;
gates exit 0 (budgets with `LOC_GATE_BASE` = main: no growth); `check:prepared-bytes` vs main: only row 149 differs;
ordinary pipeline 20 files × 2 targets: 40/40 identical.

## Perf3 result (2026-11-21, branch `claude/7354-perf3` from `origin/main`; measured on `claude/7354-perf3-work`)

Compile time of closure programs on the Prepared path is linear again. The work branch is slice F1's head
(`48c9fce74c`, the first base where function expressions compile) plus the two fix commits; the fix commits touch no
F1 file and were cherry-picked onto `origin/main` unchanged. The timing table needs F1 (main refuses
`var c = function …`), so it was measured on the work branch; bytes and tests were checked on both branches.

### Measurements (strict Prepared entry, standalone, tsx, one compile at a time)

Program: `var cI = function (x) { return x; }; if (cI(I) !== I) throw 1;` for I < N. Switch off = production
(second compile in the process); switch on = `JS2WASM_VALIDATE_PREPARED=1` (first compile, single run).

| N | off, before | off, after | on, before | on, after |
| -: | ---------: | ---------: | ---------: | --------: |
|  1 |     0.99 s |     0.41 s |     21.8 s |    19.7 s |
|  5 |     4.16 s |     0.50 s |     25.8 s |    20.8 s |
| 10 |    10.13 s |     0.62 s |     37.6 s |    20.5 s |
| 20 |    32.28 s |     0.87 s |     72.9 s |    22.4 s |
| 30 |    68.30 s |     1.36 s |    127.5 s |    23.7 s |

The same binary before and after at every N. Off: ~0.03 s per closure, 30 closures = 3.3 × one closure. On: flat;
what remains there is the switch's layout audit (`#verifyLayout`, ~18 s of a realm compile, #7380 step 5c).

The "one closure, one object, a catch, about six `+`" program (reconstructed: `var o = {a:1}; var f = function (x)
{ return x + 1; }; … try { s = s + f(1) + "a" + 2 + "b" + 3; } catch (e) { … } var t = "x" + o + "y"; …`): before,
no compile finished within 280 s (F1 measured 196 s for its program); after the first commit 10.8 s; after both 3.4 s,
same binary. The real harness prelude (`assert.js` + `sta.js`) refuses at its first gap in 0.12 s (F1's interim
member-read refusal), so it is not measurable yet.

### Profile

Before (10 closures, 8.8 s compile): `assertNativeSourceClosureRequirementsCurrent` 5.8 s total, nearly all of it
`preparedIrDataMismatch`; `requireNativeSourceClosureTypes` 3.2 s (per use, from the resolvers and the invocation
owner check); `immutableCopy` 1.2 s self. The mixed program after the first commit (10.9 s): `immutableCopy`
7.3 s self, from the whole-program snapshots of `deriveNativeObjectAccessRequirements` (3.4 s, called once per
invocation-requirements derivation) and `deriveNativeStringOutputRequirements` (1.9 s).

After (30 closures, 3.25 s for two compiles): nothing above 0.6 s. The largest are one-time costs:
`preparedIrDataMismatch` 0.52 s (the emission's acceptance-record compare, the string-value plan), `immutableCopy`
0.49 s (the frozen copy in `acceptPreparedIrProgram`, the string reservation), the settled-verdict walk 0.44 s,
`planNativeStringValuePhysical` 0.43 s.

### Each site

| site | what it did | decision | why it may go |
| --- | --- | --- | --- |
| `assertNativeSourceClosureRequirementsCurrent` (13 call sites in 8 files) and its snapshot `WeakMap` | at each body fill and closure use: re-collect the demands, re-run the closure plan and compare both with snapshots | **deleted** | It can never fail. Both producers of a prepared program (`prepareTypedIrProgram`, the codec) freeze it whole, and `planNativeSourceClosureRequirements` now freezes the derived rows in place. So the requirements cannot come to disagree with the program they were derived from. The new test "issues requirements that no later step can change" pins that. A `{...copy}` of requirements is structurally the same plan, so it is equally correct. |
| `requireNativeSourceClosureTypes` inside `resolveNativeSourceClosure`, `resolveNativeSourceClosureShape`, `resolveNativeSourceRefCell`, `nativeSourceClosureRealmState`, `requireCompletedNativeSourceClosureState`, and the source-invocation `requireOwner` | at each use: a fresh physical plan, fresh capture layouts compared with the reserved types, carrier re-authentication | **reduced to the O(1) owner lookup** (`reservedOwner`) | The pack and its requirements are frozen, and the pack was reserved on this ledger by this compile. The re-check only re-proved that ledger storage was unchanged. That property belongs to the layout audit (behind the switch) and to stage 4 (`validate-module.ts`), and `WebAssembly.validate` still runs. The full function stays for its cross-module callers (realm, invocation, object realm, callables); they no longer show in the profile. |
| `sourceSnapshot` in `deriveNativeObjectAccessRequirements` | a deep copy of the whole demands (the whole program) per derivation, compared later | **deleted** | Same reason: the borrowed program is frozen. The currentness re-derivation that stays still refuses a mutable input whose requirements changed (perf2's test now expects that refusal's text). |
| `snapshot` in `deriveNativeStringOutputRequirements` | the same, per output derivation | **deleted** | Same; the metadata identity checks and the re-derivation stay. |

No check was made linear: the hot sites were all self-checks. No cache was added.

### Tests

Removed refusal assertions, each a forged-plan test that edited a `structuredClone`d (unfrozen) program after
planning. No validator stage covers "the program changed after planning": the property holds by construction
(frozen), and the new test pins that.
- `issue-3518-native-source-closure-requirements`: `rejects %s after issuing a current real source plan` (4 cases),
  replaced by the frozen-whole test.
- `issue-3518-native-ref-cell-resources`: `refuses a stale exact source before any cell reservation`.
- `issue-3518-native-prototype-seeder-bindings`: `rejects stale prototype issuer currentness after a genuine
  cloned-source positive`.
- `issue-3518-native-string-output-requirements`: `rejects in-place instruction mutation after successful
  derivation`; `preserves unknown allocation metadata and refuses its later mutation` keeps its preservation half.
- `issue-3518-native-string-output-resources`: `rejects stale borrowed input before reservation and on all later
  owner readers`.
- `issue-3518-native-object-get-owner`: the `capture` and `receiver` cases of `rejects stale actual %s provenance`.
- `issue-3518-native-object-realm-declarations`: `rechecks the original mutable projection before reusing public
  request or tag packets`.
- `issue-3518-native-realm-requirements`: `authenticates demand currentness before a literal cache hit`.
- `issue-7354-perf2-settled-checks`: the object-access case expects the refusal that now fires first ("missing
  complete owner population", as its formatter twin does).

Validator switch on (vitest), on this branch: every `tests/issue-7354-*` and `tests/issue-7380-*` file passes. The
one exception is `ty-typeof-comparisons` › "answers a caught null like JavaScript", which hits its 35 s timeout here
and also on `origin/main` (37.7 s there; load-dependent; the file is not modified here). Every modified test file
passes in full. Two tests in them were red on `origin/main` too:
- `issue-3518-native-prototype-seeder-bindings` › "refuses foreign-ledger descriptor token %s": deleted. It hands
  another compile's dependencies to the tail builder, a foreign-pack forgery that #7380 retires. It was red because
  its "module unchanged" `toStrictEqual` against a `structuredClone` saw the owned function data's `locals` with a
  private prototype instead of `Array` (vitest's pretty-format then crashed on the diff); the data was equal.
- `issue-3518-native-realm-requirements` › "retains the original genuine Number/object frontend preparation refusal":
  stale expectation. `js.number.from-value` now has a native provider, so `Number({})` prepares. The test now
  expects that, and that the realm selects the object's `js.object.create-default`.

Also green (this branch or the work branch, after both commits): invocation consumer, source callable
contract, closure parameter projections, ref-cell consumer, builtin functions, realm object layouts, realm source
integration, getter invocation, getter results, getter resource join, prototype requirements, number format, promise
inventory, output ABI join, string define-own, descriptor-wide BigInt, 3525 number remainder and source-map data,
7139 async scopes. F1's function-expression tests pass on the work branch.

### Bytes and gates

- `check:prepared-bytes`: identical on all 804 rows (688 binaries, the rest refusals) against `origin/main`, with
  the switch off and on. Also identical between the work branch and F1's head.
- Ordinary pipeline: 20 test262 files × (default, standalone) are identical against `origin/main` (38 compiled,
  2 compile errors on both sides).
- Gates (each run bare): typecheck, LOC, function budget, coercion sites, oracle ratchet, dead exports, import
  cycles, compiler boundaries (`--mode inventory --base origin/main`).

### Not verified, left

- Timing on `origin/main` itself: main compiles no multi-closure program yet, so its closure cost is shown only by
  the unchanged tests and bytes.
- `--utf8-storage` and `compileMulti` only through the corpus rows that use them.
- Next hottest, production: no single site. What is left is about ten one-time whole-program compares and copies
  (acceptance record, string-value plan, realm currentness `assertNativeRealmRequirementsCurrent`, which still
  re-derives per call, and the output metadata identity walk). These are #7380 step 5b.
- Next hottest, switch on: the layout audit (#7380 step 5c).

## Slice F1b result (2026-11-21, branch `claude/7354-f1b`; F1 plan steps 4–6)

Base: `claude/7354-f1` d78692b574 + `claude/7354-perf3`, then `main` a7afff3596 merged (both were in it).

### Built

- **Declarations as values (step 4)** — `src/ir/function-declaration-values.ts`. One walk
  (`functionDeclarationsReadAsValues`, answered once in `programDynamicContracts`) finds the top-level declarations an
  identifier reads other than as a callee. Each gets a `var`-like startup binding after the script's declarations
  (`module-init-plan.ts`) and an immutable home of type dynamic under the Function tag; `resolveBinding` finds it by
  `globalByDeclaration`, so a read is the existing module-binding read. The module-init makes each value before its
  first statement (`lowerModuleInitStatements` → `emitFunctionDeclarationValues`): a trampoline closure (a derived
  unit calling the declaration's unit, result boxed), its function object, the home store. A call of the name stays
  direct: from-ast asks the direct-call plan before the dynamic-home callee. Refusals: `function declaration 'F' read
  as a value is written` / `has a typed parameter` / `has a result the dynamic value does not carry` / `is in a script
  that runs no top-level code`. Single script source only (no row otherwise; ES modules excluded).
- **One "binding holds its declaration" predicate** — `bindingHoldsItsDeclaration` (shared/intrinsic-prototype-writes),
  used by Fa's `staticFunctionValue` and the declaration values. A member store of the binding's name counts only on
  `this` or a global-object name (`globalWrittenNames`), beside dynamic code, a reflective route and an escaping global
  object: `assert.compareArray = …` no longer blocks `compareArray`.
- **R7 (step 5)** — `src/ir/program-source-direct-calls.ts` (moved out of program-source): calls by name in top-level
  code and inside every unit's closures are planned under the enclosing terminal unit (the owner from-ast's lifted
  context keeps). The call graph is untouched (ordinary pipeline bytes).
- **Function objects (step 6)** — the kernel's source-closure arm (415e014df0, cherry-picked unchanged); a new
  `js.object.init-function` row of the js.object family (so no second realm call collection, a07d3317ec not needed),
  body `source-function-object-bodies.ts`: the bag, `length`, `name`, and for a constructor `prototype` with its
  `constructor`. `emitFunctionObjectInit` (function-object-lowering) has two callers: every closure literal on the
  native lane with native strings (`createsFunctionObjects`; accessors excluded) and each declaration value. Names:
  `functionObjectName` (shared/named-evaluation). The set adapter defines in a function's bag and answers `false` for
  a read-only property (was a trap); strict code throws a TypeError.
- **Kind rows** — `MEMBER_ACCESS_ARM.function = "function"` (reads refuse `BUILTIN_REACHABLE_KEYS.function`, the
  catalog's Function.prototype ∪ Object.prototype keys but `length`/`name`); `TO_NUMBER_ARM.function = "to-primitive"`
  (OrdinaryToPrimitive over the function: an own non-callable `toString` throws, a callable method is the D6 abort,
  otherwise NaN); `carrierKindOf` answers `function` for the Function tag (declaration homes); a function expression
  admits the object kind (its prototype). A closure stored as a member is its function value.
- from-ast −31 lines vs main (describeIrType moved to `describe-ir-type.ts`, a void-closure walk reuses
  `someReturnedValue`); program-source −10; no grant.

### Differs from the plan

- No `program-source-function-values.ts` beside program-source: the walk/rows/trampoline are one module the source
  producer, the module-init plan and the chunk lowering call.
- Plan D2's c-fn/c-int port: only 415e014df0; `js.function.*` became one js.object row; the c-calls refactor and the
  c-int wiring (in perf4's files) were not needed.
- Closures other than function expressions (arrows, methods) are function objects too: they become values (`o.m`), and
  a value without a bag would trap in the kernel.
- `typeof` and identity of a declaration value were already in F1a's rows; the Function tag makes a home read a known
  function, so `f.length` does not refuse as "may be a string".

### Proof

Tests (each file in full, exit 0): f1b-declaration-values 7/7, f1b-function-objects 8/8, f1-function-kind 16/16,
o3-member-write 21/21 (after the main merge); fa-function-values 47/47, f1-to-primitive + m-refusals 44/44,
f1-function-expressions{,-2} 7/7, 3518-ordinary-object-callable-contracts + x-dynamic-throw 102/102,
3518-ordinary-object-runtime-providers 187/187, 3518-native-builtin-functions 36/36, o2-object-values 12/12,
m-member-access 5/5, o4-member-read 16/16 (three `-t` runs), test262-prepared-entry + 7188 50/50,
m-prototype-premise 12/12 (before the main merge). r-provider-census: 117/117 tests pass but the run ends with
vitest's "Timeout calling onTaskUpdate" RPC error (exit 1) under load.

Sweep: 4 value forms × 14 operations × 5 positions (560 programs, node's answer and a wrong one): 436 agree, 124
named refusals, 0 wrong, 0 exceptions, 0 invalid Wasm. Regression set: those 560 + 71 hand programs on base and head:
no base-correct program changes; 3 head programs end at D6's run-time abort (an own callable `valueOf`/`toString`, F2).

Mutations killed (probe runs): each changed row of TO_NUMBER_ARM / MEMBER_ACCESS_ARM, the Function-tag rule, the
direct-first order, the prototype's object kind, init's constructor flag and name, the read-only `false`, the strict
check. Survivors: none found among those.

Bytes: ordinary pipeline 20 test262 files × default + standalone: identical. `check:prepared-bytes` vs base: 10 rows
differ — 53, 74, 581 now compile (declaration values), 180 refuses at the call through a value (F2) instead of the
read, 46/239/244/445/532/533 change bytes because the realm's kernel and set adapter changed (`match`'s source arm,
the bag redirect).

Sample (411 rows): 272 `unknown class "Test262Error" in assert` (C2), 73 `function declaration
'formatIdentityFreeValue' read as a value is written` (+1 with a parse error; these sources use `this` or a
reflective name), 41 `dynamic method .sameValue/3 has no brand-dispatch wrapper` (verifyProperty, F2), 6
`verifyProperty … is written`, 14 pass, 4 other.

### Not verified

- The other m/o/str/ty/t/h/d1/vg/p test files after the main merge (time); the census RPC timeout on base.
- Source maps with declaration values: the startup binding census check fails as it already does for nested `var`s.
- Calls through a declaration's value (`var g = f; g()`) — F2.

### Review round 1 (PR 7382, NOT MET at 1dc914867d; fixed on the branch)

- **B1 fixed.** The set adapter finds the property on the receiver's own storage first (the bag for a function,
  `findOrdinary`) and updates an own writable data property with `{ [[Value]] }` only; inherited/absent keys keep
  CreateDataProperty. A function's `prototype` (and a prototype's `constructor`) keeps its attributes; strict code no
  longer throws. Non-extensible receivers and accessors are reached by no source program on this branch (left to O1).
  Tests: `issue-7354-f1b-function-object-writes` (declaration / expression / named expression / inner closure,
  sloppy and strict, reads through a parameter; object literal updates). The o3 adapter unit harness (forged kernel
  answers) is replaced by these source programs.
- **B2 fixed.** A constant computed key (`['k']`, `[1]`) names its function (shared `propertyKeyFunctionName`); a
  key the compiler cannot evaluate refuses by name (`the name of a function under a computed key needs the key's
  value`) — unreachable today, the descriptor plan refuses such a key first. Chosen: refuse, not "unless `.name` is
  read". Codegen gets the same constant-key answer (was `""`).
- **Q1 fixed.** One §10.2.9 rule: codegen's `fnInstanceNameOf` delegates to `functionInstanceName`
  (shared/named-evaluation), keeping only its eval-synthesized `"anonymous"`; one length rule:
  `expectedArgumentCountOfParams` moved to `src/shared/`, used by both creation sites via one `emitFunctionObjectInit`
  that takes the function node. Default/rest parameters do not reach the lane (from-ast and the dynamic closure
  contract refuse them), so no `.length` test with them can run there. `carrierTag` is gone: the trampoline boxes
  (a Boolean under its tag) and `carrierKindOf` admits.
- **Q2 fixed.** `ordinaryToPrimitive`'s `kind` parameter removed.
- **Q3.** The result-carrier refusal is deleted. The accessor skip stays: an object-literal getter reaches it on the
  real entry (`var o = { get x() { return 1; } };` runs) and the 3518 runtime-providers getter test pins it.
- **Q4 fixed.** `src/shared/binding-holds-declaration.ts`; the scan exposes `globalObjectWriteRoutes`.
- **Q5 kept.** (i) The reflective clause guards `x.constructor` reaching `Function`, unreachable on this branch
  (every `.constructor` read refuses); C2 must re-examine it. (ii) The escape clause guards a write through the
  global object as a value, unreachable on this branch; the built-ins-as-values and `Object`-statics slices must
  re-examine it. (iii) Another binding of the name: the shared name-based proof (Fa); a symbol-based proof is not
  cheap.
- **Q6 fixed.** Refusal tests kill each predicate clause (`Function(...)`, `f.constructor(...)`, `return this`), the
  callee exclusion (`f()` beside an escaping `this` meets the `this` refusal, not the proof), and `ADD_ROLE.function`
  (an abort test in f1-function-kind).
- Main merged (cddf65be4d, Perf4's `try_table` helpers). `quality`'s Node-25 failure is main's; Node 25 not run here.

Re-measured on the merged head: every touched test file in full, exit 0; gates 0 (budgets also against main; from-ast
−32, program-source −10 vs main); prepared bytes vs main: the same 10 rows as above; regression set 652 programs:
no base-correct program changes, 3 D6 aborts; sample tally unchanged.

Ordinary pipeline: the 20-file byte check is identical to main, but B2 changes the ordinary pipeline too: a function
under a constant computed key (`{ ['k']: function () {} }`, a method `['k']() {}`, a class field `1 = function ()
{}`) is named by its key (`"k"`, `"1"`; was `""` or no metadata), so those programs' bytes and `.name` results change
(improvements). The reviewer measured 316 programs × 2 targets (no result that was right changed) and 113 test262
files (0 pass → fail).

Review round 2: `memberNameOf` and the class-field arm use `propertyKeyFunctionName`. Name tests run: issue-5157
default-export names, 4436, 4437, computed-props, issue-computed-props — pass; issue-4617 fails 2 tests on main
unchanged. Known limits (as on main): `o[1].name` read directly gives `""` in the ordinary pipeline while the same
function read through a parameter gives `"1"`; getter/setter, class-field and object-literal method names under
non-constant computed keys are wrong (`var k = "z"; ({ [k]() {} })` gives `""`, node `"z"`); passing a function read
under a numeric method key (`g(o[1])` for `{ [1]() {} }`, also `{ 1n() {} }`, `class C { 0x10() {} }`) traps with
"Cannot access property on null". Review round 3: the comments in `function-instance-meta-methods.ts` say what is
declined now (non-constant computed, BigInt, private); the second identical shorthand arm in `functionInstanceName`
is gone. "C2" in `binding-holds-declaration.ts` is the class slice of this issue (constructors, `new`, `.constructor`).

## Perf4 result (2026-11-21, branch `claude/7354-perf4` from `claude/7354-perf3` `db3c4a256f`)

The layout audit no longer runs per ledger query, and the realm requirements no longer re-derive per call. Two
commits; the closure timings were measured on `claude/7354-perf3-work` (F1 + Perf3) with both commits
cherry-picked (they apply unchanged; neither needs F1).

### Measurements (strict Prepared entry, standalone, tsx, one command at a time)

Realm programs: `obj` = `var o = {a: 1}; if (o.a !== 1) throw 1;`, `catch` = a try/catch that reads the caught
value. First compile in the process, then `obj` again (warm).

| program | on, before | on, after | off, before | off, after |
| --- | ---: | ---: | ---: | ---: |
| obj (first) | 23.5 s | 1.85 s | 1.39 s | 1.31 s |
| catch | 30.3 s | 2.01 s | 0.91 s | 0.78 s |
| obj (warm) | 20.8 s | 1.10 s | 0.45 s | 0.39 s |

Switch on: the audit itself went from 18.5 s (3,893 audits of 4.7 ms each over 71 types, 191 records, 81 functions)
to 0.06 s. A first realm compile with the switch on is now 1.4× the same compile off; a warm one 2.8× (the
remaining difference is the validator stages and settled-verdict walks, see "Left").

Switch off, N closures (`var cI = function (x) { return x; }; if (cI(I) !== I) throw 1;`), warm compile:

| N | before | after |
| -: | ---: | ---: |
| 30 | 1.36 s | 1.47 s |
| 60 | 2.89 s | 2.94 s |
| 120 | 6.47 s | 5.39 s |

Linear before and after (0.045 s per closure after); same binaries.

Test files, switch on, one file per run: `issue-7354-m-member-access` 417 s → 118 s, `issue-7354-m2-caught-errors`
355 s → 76 s.

### Each site

| site | what it did | decision | why |
| --- | --- | --- | --- |
| `#verifyLayout` in `#require`, `internFunctionType`, `physicalIndex`, `physicalIndices`, `assertCompletedReservation`, `fillOwnedFunction` (×2), `audited` | the whole O(module) layout audit on every ledger query, 3,893 times per realm compile | **once per phase boundary**: `freezeReservations`, `seal`, and the physical-module validator stage (`verifyEmittedLayout` in `ir-program-driver.ts`, after `assertPhysicalModule`) | Accidental repetition: nothing in between depends on the audit having run, and an alteration that persists is reported at the next boundary with the same text. The validator-stage call keeps post-emission alterations (before presentation) refused. |
| `audited` and its three callers (`program-consumer`, `program-native-invocation`, `native-string-values`) | batched the per-query audits and refused ledger mutation inside a check | **deleted** | Its only purpose was batching audits that no longer run per query; the "no mutation inside" flag guarded read-only code by construction. |
| `assertNativeRealmRequirementsCurrent` | per call: re-ran the whole realm derivation (`numberUses`, owners × occurrences) and compared it with the stored description | **deleted the re-derivation**; the issue check stays (a `WeakSet` lookup) | Can never fail: the pack is frozen and derived from a frozen program (both producers freeze it, Perf3). |
| `numberUses` | owners × occurrences scan | **made linear**: one pass groups the Number conversion calls by owner and view | Real logic, called once per derivation; the index is built from the frozen demands. |
| `ownerFor` (`native-string-values.ts`) | per emit: owner lookup, settled-verdict check, inventories | **left** | After the audit change it costs one settled-verdict authentication per compile (0.5 s at 120 closures, linear); the settled verdicts and their tests are #7380 step 5b. |
| one-time compares (`prepareNativeEmission`, `planNativeStringValuePhysical`, settled-verdict walk) | whole-program compares/copies once per compile | **left** | Linear and one-time; together about 2 s of the 120-closure warm compile. Step 5b. |

### Mutation proof (switch on, realm program with an object and a caught value, `.tmp/mutate.mts`)

| mutation | point | before | after |
| --- | --- | --- | --- |
| M1 flip `mutable` of the 5th reserved struct's field 0 | reserving | refused: `altered type descriptor native-realm…` | refused earlier, by the argument-vector pack check (`noncanonical argument carrier`) |
| M2 field 0 of the 5th struct → `f64` | reserving | (not run) | refused (`noncanonical argument carrier`) |
| M3 a filled function's `typeIdx` → another function's | 3rd fill | `altered function descriptor physical:string-number…` | same |
| M4 push into an earlier completed body | 10th fill | `altered completed function native-string-values…` | same |
| M5 a filled global's type → a ref to another owner's struct | 2nd global fill | `altered global descriptor ir-binding…` | same |
| M6 flip `mutable` of a reserved struct field | after seal | `altered type descriptor native-string-values…` (next query) | `prepared validator (physical module): … altered type descriptor native-string-values…` |
| M7 flip `mutable` of the last reserved struct's last field | 1st fill | `altered type descriptor native-realm…` | same |
| M8 that field → `f64` | 1st fill | `altered type descriptor native-realm…` | same |
| M0 no mutation | — | compiles | compiles |

What the audit no longer reports: an alteration that is undone again before the next boundary, and one made after
the physical-module validator stage (the presentation's later ledger reads used to audit).

### Tests

Assertions that expected the refusal at a query now expect it at the next boundary (`freezeReservations` or
`seal`), same text: `issue-3518-` builtin-request-literal-authentication, native-bigint-number-owner,
native-bigint-resources, native-builtin-functions, native-number-primitive-classifier, native-object-descriptor-resources,
native-object-get-owner, native-object-realm-declarations, native-object-storage-resources,
native-primitive-wrapper-storage, native-prototype-seeder-bindings, native-realm-object-layouts,
native-string-completion, native-string-flatten-resources, native-well-known-symbols,
native-authentication-performance, physical-snapshot-comparison; `issue-3527-` descriptor-snapshots,
owned-function-data, publication-snapshot-comparison, realm-completion-close; `issue-7354-perf-string-authentication`.
The snapshot-algorithm files keep every scalar/order/hole/getter case; their "after repeated successful audits"
step becomes one audit at the seal. "Preflights … without allocating" tests become "refuses by the end of
reservation" (the allocation-free preflight was the per-query audit). In `issue-3525-prepared-pipeline-presentation`
the two post-emission alterations are now refused by the validator stage (message prefixed `prepared validator
(physical module):`).

Deleted (each asserted the per-query or post-seal audit, a removed check):
- `issue-7354-perf-string-authentication`: `refuses a ledger mutation inside an audited check`, `keeps refusing
  ledger mutations after a nested audited check returns`, `refuses a new function type interned inside an audited check`.
- `issue-3518-physical-snapshot-comparison`: `batch indices cannot escape a failed private ledger state` (2 cases;
  the getter it relied on is read only by the audit).
- `issue-3525-prepared-number-remainder`: `rejects an unowned helper substitution through authenticated
  {wasmgc,linear} support receipts` (substitution after the emission and its validator stage).
- `issue-3525-prepared-wit-presentation`: `{wasmgc,linear}: genuine C failure poisons WIT authority …` (type changed
  after presentation preparation).
- `issue-3527-realm-completion-close`: the `sealed=true` attack cases (mutation after seal).
- `issue-3518-native-authentication-performance`: `audits once per batch …` became `never reads the public ordinal`.

Pre-existing reds fixed in modified files: `issue-3525-prepared-wit-presentation` — the two Promise tests whose
no-WIT compile is refused since #6979 keep only their WIT-refusal half; the file got the two-macrotask `afterEach`
yield (it exited 1 with `Timeout calling "onTaskUpdate"` on the base too). `issue-3518-native-object-descriptor-resources`
› `rejects a foreign exception token…` compared with `toStrictEqual` against a `structuredClone` (red on the base:
owned function data has a private array prototype) and now uses `toEqual`.

Switch on, every modified file and every `tests/issue-7354-*` / `tests/issue-7380-*` file passes in full (one or
two files per vitest run), plus `issue-3518-native-realm-requirements` and `issue-3518-module-reservations`.

### Bytes and gates

- `check:prepared-bytes`: all 804 rows identical, base vs head with the switch off, and head switch off vs on.
- Ordinary pipeline: 19 test262 files × (default, standalone) identical base vs head (the 20th path did not exist).
- Gates, each bare: typecheck, LOC, function budget, coercion sites, oracle ratchet, dead exports, import cycles,
  compiler boundaries (`--mode inventory --base db3c4a256f`).

### Not verified, left

- Base with the switch on over all 804 rows (only off; head on = head off, and the switch never changed bytes).
- M2 on the base.
- Next hottest, switch on: `preparedIrDataMismatch` in the validator stages and the native-emission compares
  (~2.5 s over 4 realm compiles). Switch off, 120 closures: `immutableCopy` / `freezePreparedIrValue` (2.2 s over two
  compiles), the settled-verdict walk (1.8 s, `ownerFor`'s first authentication among it), `prepareNativeEmission`'s
  compare (0.6 s). All one-time per compile; #7380 step 5b.

## Slice F2 result (2026-11-21, branch `claude/7354-f2`; F plan §7)

Base: `claude/7354-f1b` 1dc914867d; then `main` cddf65be4d (Perf4) and `claude/7354-f1b` ecf35485c1 (review round 1)
merged in.

### Built

- **The call ABI.** A call through a value on the Prepared lane (closures are function objects, `createsFunctionObjects`)
  is one `js.closure.call:N(receiver, callee, …args)` (`function-object-lowering.ts` `nativeClosureCall`), every
  operand a carrier, result a dynamic value (tested at run time like a parameter). The native dispatcher installs
  `receiver` in `__current_this` for the call (restored after, also on a throw), pads missing arguments with
  `undefined` and drops extras by the callee's arity, and throws its catchable TypeError ("Value is not callable",
  the realm's error layout) for anything that is no source closure. A bare call passes `undefined`; a method call the
  receiver. C2 binds `this` from `__current_this` at entry (C2-D2) — nothing more is needed from the call side.
- **Planner (ported from Fb, PR 7326, as content).** `native-invocation-requirements.ts`: a callee that is no packed
  allocation is a `dynamicCallee` use; every source closure must be dispatchable (fixed parameters, carrier
  parameters/result) or the program refuses by name; `native-source-closure-callables.ts` selects every source unit
  for such a use; `native-invocation.ts` shares one dispatcher arm per (allocation type, signature).
- **Method calls.** A method call on a dynamic receiver and an element-access call (`o["m"](…)`) are the member's
  [[Get]] on the once-evaluated receiver, then that call with the receiver as `this` (`lowerDynamicMemberCall`, the
  one body the codegen-plan path `lowerFunctionObjectMemberCall` also uses). Every arity; the `/2` brand-dispatch
  refusal and `__ir_dyn_method_call_N` are gone on this lane; the ordinary pipeline keeps brand dispatch.
- **Calls through a script var / declaration value.** The dynamic home is called in any position and from module-init
  (whose scope binds the home); Fa's static closure call stays for an exact-arity call, any other arity is the
  dispatcher's.
- **D6's call arm** (`ordinary-to-primitive.ts`): each method in hint order is Got; a callable one is called with the
  object as `this` (`js.closure.call:0`); a primitive result answers (`IS_OBJECT`, a new row table in
  `dynamic-value-kinds.ts`); a non-callable method or an object result goes on. The caller finishes the primitive
  (`ToPrimitiveAnswer`): ToString its string, ToNumber its number, `+` a carrier. `ADD_ROLE` object/function =
  "to-primitive": `+` takes both operands' ToPrimitive first (left, right), then concat/sum on primitives
  (`knownKinds` now records kind sets). `TO_STRING_ARM.function` = "to-primitive": an own `toString` answers; an
  absent one is the source-text abort at run time (was a compile-time refusal for a value known to be a function).
- **Refusals.** `call through a value with a spread argument`; `dynamic operation js.closure.call:N in a program that
  creates no function value has no Prepared intrinsic` (every such call would be the TypeError).
- **Perf (needed to make the slice runnable).** The promise census inside the invocation requirements kept its options
  unfrozen, so the pack never settled and every native string literal re-derived the whole invocation plan: a program
  with 15 method calls compiled in 45 s, now 8 s; the assert-shaped program 18 s → 5 s.
- **Quality.** from-ast −11 lines vs F1b (the binding call's body moved to `lowerBindingCall`; four copies of the
  `.replace(/_/g, "")` shape test became `isUnderscoreStripReplace`, select −5); legalization 347 lines (M1: 350); no
  grant.

### Differs from the plan

- Fb's `TESTED_AT_RUN_TIME` admission is not needed: the call's result is typed dynamic directly.
- Plan §11 text kept for programs with no closure became the legalization's own refusal (named, not a physical gap).
- A function's ToString now goes through ToPrimitive (plan §5's "F2: exact" for own methods); the compile-time
  refusal "ToString of a function needs Function.prototype.toString" is gone (F1 pins moved to the run-time abort).
- The not-callable TypeError message is the dispatcher's fixed "Value is not callable", not node's "x is not a
  function" (one literal in the dispatcher; behaviour and kind match).

### Proof

Tests (each file in full, exit 0, on the merged state): f2-calls-through-values + f1-function-kind 22/22, fa-function-values + m-refusals 85/85, x-dynamic-throw + 7363-prepared-eval-refusal 151/151,
f0-dead-top-level-bindings 88/88, f1b-function-object-writes + f1-to-primitive 6/6; before the F1b merge also
o2b-to-primitive + str2c-dynamic-add 47/47, f1b-declaration-values + f1b-function-objects 15/15,
3518-native-builtin-functions + m-refusals 77/77, 7106-ir-dynamic-method-wrapper + 7117 14/14. Pins moved: Fa (3 rows
now run), X and 7363 (the new refusal), M G45, F0 (the kept closure now reaches `this`). Node 25: not available on
this machine.

Sweep (`.tmp/f2/gen.mjs`): 6 callee forms (declaration value, expression, method on a function object, on an object,
object-literal method, element key) × 5 positions × arity 0–3 × fewer/equal/more arguments (extra-argument side
effects counted), plus non-callable callees through a parameter and as members, receiver-once and evaluation order:
68 programs (34 + wrong twins), all equal node. ToPrimitive probes 22 + calls/methods 19.

Regression (base F1b vs head, strict Prepared entry, node's answer): F1b's set 71 + 560 sweep + 109 F2 programs =
740: no base-correct program changes; 3 ABORT → OK (F1b's own callable `valueOf`/`toString` rows), 14 ABORT → OK,
83 REF → OK, 1 REF → ABORT (`"" + g`, g without own toString: the source-text abort), 0 wrong, 0 invalid Wasm,
0 exceptions.

Mutations (each alone, killed): `ADD_ROLE.object` → concat; `IS_OBJECT.error`/`.function` → false;
`TO_STRING_ARM.function` → name; the static closure's arity check; the lane routing of method calls / element calls
(tests); the no-function-value refusal (m-refusals). Removed as a survivor: a void-result guard on the static call (no
static value is void). Survivors by design: the dispatcher arm dedupe and the census freeze (equal output, perf).

Bytes: ordinary pipeline, 20 test262 files × default + standalone: identical. `check:prepared-bytes` (804 rows) vs
F1b: 3 rows differ — 180 now compiles (`var g = id; g(1)`, runs), 214 and 531 refuse by a new name.

### Sample (411 rows, real prelude)

272 `unknown class "Test262Error" in assert` (C2), 73 `function declaration 'formatIdentityFreeValue' read as a value is
written`, 41 `empty array 'failures' escapes before its element type is closed (verifyProperty)` (was `.sameValue/3`
brand dispatch: arrays, #7352), 6 `verifyProperty … is written`, 14 pass, 5 other.

### Not verified

- Node 25 (not installed here); the dispatcher's guard is a standard `try_table`, as every user `try` on this regime.
- The remaining existing m/o/str/ty/t/h/d1/vg/p test files and r-provider-census after the merges.
- Restoring `__current_this` (after a return, after a throw, across nested calls) cannot be observed until C2 admits
  `this` in a function body: C2's tests must cover it.
- Compile time: 20 closures plus a 20-term `+` chain took 80 s for one compile (68 s under the profiler). Cause: 47 s
  are `assertNativeInvocationRequirementsCurrent`, which re-collects the whole program's promise census
  (`assertNativePromiseSourceCensusCurrent` → `collectNativePromiseSourceCensus` + `preparedIrDataMismatch`) at every
  unsettled call — the invocation owner's `authenticate` / `requireOwner` and `resolveEntries` in
  `native-invocation.ts` / `native-source-closure-callables.ts` (perf lane).
- `var g = 1; g()` (a typed number home) refuses with the misleading `direct call to "g" has no exact AST-site plan`,
  unchanged from the base.
- Review round 1 (lead): findings 1-5 fixed — explicit dispatcher-arm key; one `packedCallable` helper; the binding
  call's doc names both lanes; the lane picks the call before any not-callable text is built; one lane predicate
  (`createsFunctionObjects`, read through the host).

## Perf5 result (2026-11-22, branch `claude/7354-perf5` from `claude/7354-f2` `1de4a6f2e7`)

The invocation requirements are no longer re-derived at every use. Two commits: `3e670a6858` (the per-use sites take
an O(1) issue check; the re-derivation runs once, in a new accepted-program validator stage) and `eac330ed5f` (that
check compares once; a seeded stale plan is refused only by that comparison).

### Measurements (strict Prepared entry, standalone, tsx, one command at a time, load 2–3 from another agent)

Program: `var cI = function (x) { return x; };` for I < N, then `var s = c0(0) + c1(1) + …;` (N calls, an N-term `+`
chain) and `if (s !== …) throw 1;`. `harness` = F2's `assert.sameValue` shape, `prelude` = F1b's stand-in prelude
(both from the tests). Each run after a 1-closure warm-up in the same process. Off = production; on =
`JS2WASM_VALIDATE_PREPARED=1`. "After" gives both commits' runs where they differ (noise: 20 closures measured 22.2 s
and 30.6 s off in two processes).

| program | off, before | off, after | on, before | on, after |
| --- | ---: | ---: | ---: | ---: |
| harness | 3.80 s | 1.37 / 1.39 s | 5.20 s | 2.87 / 2.59 s |
| prelude | 6.22 s | 1.78 / 1.72 s | 8.11 s | 3.75 / 3.37 s |
| N = 5 | 16.35 s | 4.53 / 4.18 s | 20.10 s | 9.57 / 8.55 s |
| N = 10 | 34.03 s | 9.48 / 10.11 s | 44.83 s | 21.17 / 18.56 s |
| N = 20 | 92.43 s | 24.26 / 22.20–30.57 s | 101.28 s | 46.07 / 47.62 s |

Same binary before and after in every cell. The real harness prelude still refuses at C2 (F2's sample), so a realm
prelude compile is not measurable yet; `harness`/`prelude` are the tests' stand-ins.

### Profile

Before (N = 10, 31 s compile under the profiler): `assertNativeInvocationRequirementsCurrent` 21.0 s inclusive (68 %),
20.5 s of it `assertNativePromiseSourceCensusCurrent` — its whole-program snapshot compare (`preparedIrDataMismatch`,
18.8 s) and a fresh census (4.1 s), at every use. Callers: `nativeStringInvocationRequirements` 4.4 s,
`selectNativeBooleans` 4.4 s, `authenticate` 3.5 s, `resolveEntries` 2.8 s, `planNativeInvocationInput` 2.3 s,
`nativeInvocationAbiBindings` 2.2 s, `prepareNativeProgramStringInput` 0.8 s, `prepareNativeEmission` 0.7 s.

After (N = 20, 20 s compile): no frame above 25 % with the per-use re-proof shape, so no third commit. Largest:
`immutableCopy` 5.0 s (one-time copies in `acceptPreparedIrProgram` and `reserveNativeStringValueResources`), the
settled-verdict immutability walk 5.6 s (2.3 s under `assertNativeStringValueReservationInput`), `ownerFor` 3.6 s,
`nativeCallAbiBindings` 3.1 s. Switch on (N = 10): the validator's invocation check costs 0.14 s; the on-only cost is
`hasNativeCollectionState` (6.0 s, the slot probes) and `same` in `native-string-values.ts` (4.1 s).

### Each site

| site | what it did | decision | why |
| --- | --- | --- | --- |
| `assertNativeInvocationRequirementsCurrent` at 8 uses (`authenticate`, `resolveEntries`, `nativeStringInvocationRequirements`, `planNativeInvocationInput`, `nativeInvocationAbiBindings`, `selectNativeBooleans`, `prepareNativeProgramStringInput`, `prepareNativeEmission`) | per use: the census's whole-program snapshot compare, a fresh census, a fresh derivation, two compares | **`assertNativeInvocationRequirementsIssued`** (a `WeakSet` lookup) | The pack and the program it was derived from are frozen (Perf3), so it cannot go stale between uses; the same argument Perf4 made for the realm requirements. |
| the re-derivation itself | — | **the accepted-program validator stage** (`verifyAcceptedNativeInvocation`, called by `runIrProgramDriver` after acceptance, under the switch): once per compile | The one place that compares. Checked by a probe: with the check made to throw, a compile with the switch on fails with `prepared validator (accepted program): …`, with it off compiles. |
| the census self-check inside it, and the snapshot `WeakMap` | a second compare (the census against its whole-program snapshot) and a snapshot equal to the frozen pack by construction | **deleted** from the invocation check; the snapshot became the issue `WeakSet` | One comparison: a fresh census's gap joins the fresh derivation, compared with the issued uses/gaps. `assertNativePromiseSourceCensusCurrent` stays for its own consumer (`observeNativeStringValueProducer`). The runtime-created gap text has one helper (`runtimeCreatedGaps`) for planning and checking. |

### Tests (each file alone, `VITEST_MAX_FORKS=1`, switch on)

| file | result |
| --- | --- |
| `issue-7354-f2-calls-through-values` | 10/10, exit 0 |
| `issue-7354-fa-function-values` | 44/44, exit 0 |
| `issue-3518-native-builtin-functions` | 36/36, exit 0 |
| `issue-3518-native-getter-invocation` (modified) | 43/43, exit 0 |
| `issue-3518-native-invocation-consumer` | 61/61, exit 0 |
| `issue-3518-native-object-get-owner` | 64/64, exit 0 |
| `issue-3518-builtin-request-literal-authentication` | 24/24, exit 0 |
| `issue-3525-public-prepared-driver` | 16/16, exit 0 |
| `issue-7364-prepared-empty-program` | 11/11, exit 0 |
| `issue-3518-native-getter-results` | 19/21, exit 1 — same 2 red on the base (`string.const runtime is unavailable`) |
| `issue-3518-native-getter-resource-join` | 13 + 2 skipped, 2 suites fail, exit 1 — same on the base (same error) |
| `issue-3518-native-object-realm-declarations` | 21/25, exit 1 — same 4 red on the base (same error) |
| `issue-3518-native-invocation-substrate` | 41/45, exit 1 — same 4 red on the base (post-completion mutation, Perf4's boundary audit) |
| `issue-3518-native-realm-requirements` | 24/25, exit 1 — same 1 red on the base (`js.object.init-function` realm row) |
| `issue-3518-native-realm-source-integration` | 22/24, exit 1 — same 2 red on the base |

Changes in `issue-3518-native-getter-invocation`:
- New: "the validator refuses requirements whose call population changed after planning" — a seeded invalid plan for
  the validator (#7380 acceptance 3): a source call made a non-invocation, which the derivation accepts, so only the
  comparison refuses it (`stale invocation source`). Kill check: with the comparison removed this case fails and the
  other 42 pass; before this case no test in the file noticed (the existing stale-provenance cases are refused by the
  derivation's own checks).
- "refuses changed function/global ownership/layout" were red on the base (Perf4 moved the ledger audit to the phase
  boundaries); they now expect the refusal at `freezeReservations` ("altered").

### Bytes and gates

- `check:prepared-bytes`: all 804 rows identical, base vs head, switch off; and base on vs head on (both commits).
- 109 F2 probe programs (`f2set.p`) and 71 F2 regression programs (`reg.p`) through the strict entry: identical
  (binary sha or refusal text).
- Ordinary pipeline: F2's 20 test262 files × (default, standalone) identical.
- Gates, each bare: typecheck, LOC, function budget (both also with `LOC_GATE_BASE` = main `d6a09c082d`), coercion
  sites, oracle ratchet, dead exports.

### Not verified, left

- Node 25 (CI's version) is not installed here.
- Compile time is still superlinear (5 → 10 → 20 closures: ×2.2, ×2.3–3). Candidate: `nativeCallAbiBindings` rebuilds
  the owner function's type map (`nativeAsyncCallableValueTypes`) per call use — 3.1 s (15 %) at N = 20, quadratic in
  calls per function. Not per-use re-proof, below the 25 % bar; next slice.
- The remaining one-time copies and settled walks (#7380 step 5b) and, switch on, the slot probes.
- No test proves the driver calls the validator stage (only the probe above); a stale plan cannot arise in a real
  compile, so such a test would need a forged plan.
