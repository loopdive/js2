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
# 2026-11-19 (slice Fa): src/ir/from-ast.ts +33, the Prepared function-value arms
# beside their siblings: the `dynamicClosureSignature` / `staticFunctionValue`
# resolver hooks, the static closure kept on a script var's `moduleGlobal` scope
# entry and its call arm, and `argumentIntoDynamic`, which the direct and the
# closure call now share (the direct call's inline copy is gone). The contracts
# live in src/ir/source-dynamic-contracts.ts. src/ir/program-consumer.ts +2: the
# realm-slot record (O1's) also carries the realm's source-closure types and
# invocation population (`nativeRealmCompletedSlots`, native-realm.ts).
# ir-program-presentation.ts +1: `native`, the ABI join's admission of a lifted
# closure body's `__self`.
# 2026-11-19 (slice Fb): src/ir/from-ast.ts +20 more (+57 with Fa): a call through a
# script var in any position on the Prepared lane, the function-value box of a
# module-slot store (`boxForDynamicModuleStorage` reuses `argumentIntoDynamic`), and
# `preparedFunctionValues`, the one lane predicate the three arms share. The call
# itself lives in src/ir/function-object-lowering.ts (`applyNativeClosureCall`), the
# dispatch selection in native-invocation-requirements.ts.
# 2026-11-19 (realm join, slice O step O1): src/ir/program-consumer.ts, the emission wiring of the realm's
# source-object family: the second `reconcileNativeCallBindings` call (the reconciler itself is the renamed, shared
# invocation one), the realm-slot record on the emission observation with its one reader `emittedNativeRealmSlots`
# (the record lives beside the consumer-private observation map; the slot computation, `nativeRealmCompletedSlots`,
# lives in native-realm.ts) and the imports. The two native binding lists fold through `plannedNativeCallBindings`
# (program-physical-plan.ts) instead of growing each.
loc-budget-allow:
  - src/ir/program-consumer.ts
  - src/ir/program-physical-plan.ts
  - src/compiler.ts
  - src/ir/program-source.ts
  - src/ir/from-ast.ts
  - src/compiler/ir-program-presentation.ts
import-cycles-allow:
  - backend->ir: 119 # 2026-11-17 (#7354 Str review 2): the native string length emitter reads the selected carrier field through the shared preparedStringLenProvider (ir/runtime/intrinsic-preparation.ts) instead of re-implementing it
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

## Fa — function values: creation and storage (2026-11-19)

Lane S4, branch `claude/7354-fa` from `origin/main` `ee3fcdd610` (H, T, X, Str on main).

### Implementation Plan

Measured first (main `ee3fcdd610`, strict Prepared entry, standalone): `var f = function (v) { return v; }` stops in
from-ast ("module-level closure binding 'f' not in module-init Slice 2 scope", "closure params must have
annotations"). Even an annotated closure (`const f = (v: number): number => v` in a `.ts`) stops, at presentation,
with three gaps: the lifted body's callable contract (its `__self` is a closure), the runtime census (a closure pulls
in the #3518 native realm: function objects, their property storage and the invocation substrate, about 70 support
functions the census does not know), and reference widening of the realm and closure types. The backend itself
works: with the three gaps skipped the annotated program validates and answers like node.

Target structure, one concern per module:

| concern | module | reuses | removes |
| --- | --- | --- | --- |
| the all-dynamic closure contract, and "this `var` holds its initializer's closure" | `src/ir/source-dynamic-contracts.ts` (beside the parameter and result contracts) | `scriptVarWrites`, `isTopLevelStatementDeclaration`, the source-scope predicates | — |
| lowering | `src/ir/from-ast.ts`: one resolver hook in `lowerClosureExpression`, the dynamic-home store the planned closure already has, a static-closure call arm beside the local-closure arm | `lowerClosureExpressionWithSignature`, `functionObjectDynamicValue` (the one function-value projection), `lowerClosureCall` | the direct call's inline argument boxing becomes `argumentIntoDynamic`, shared with the closure call |
| carrier form | `src/ir/program/dynamic-value-legalization.ts`: closure / callable signatures, `closure.new`, `closureSubtype`; the projection's `__ir_dyn_call_box` of a packed callable is the carrier itself; closure allocation sites re-typed | `carrierOf`, `coerce.to_externref` (as the string arm) | — |
| certified setup | O1's realm-slot join (`nativeRealmCompletedSlots` → `emittedNativeRealmSlots` → `runtimeCensus`): the realm's slots also carry its source-closure types and the closure invocation population | the owners' own inventories (`nativeClosureReservationInventory`, `nativeInvocationFunctions`) | Fa's first cut had its own consumer record and census parameter; merged onto O1's join it is one more owner of the same record |
| presentation | `ir-program-presentation.ts`: the ABI join admits a closure | the census unchanged from O1 | — |

No new representation: the value is the existing closure struct (`closure.new`), boxed by the existing projection;
no new intrinsic, provider, host import or census table row.

Quality criterion: no second closure path in from-ast (the contract only supplies a signature to the existing
lowering); no copy of the argument boxing; the census takes no second join (the closure resources are owners of
O1's realm-slot record); no second authentication pass.

### Result

Built as planned. Behaviour:

- An unannotated function expression (no default, rest, pattern, generator or async) on the native lane is a
  closure with the all-dynamic signature; its body runs off its end into `undefined` like a dynamic-result function.
- Stored into a script `var`'s dynamic home it is the boxed closure (identity kept: `g === f`, `h() === f`,
  `f(f) === f`); passed to an untyped parameter it boxes the same way; thrown, the catch binding is it.
- A top-level `var f = function …` written nowhere else, in a single-source program that runs no unspelled code and
  does not let the global object escape, holds that closure from its declaration on; a module-init call placed
  after the declaration is the closure's direct `closure.call` (the prelude's `print(…)`).
- Every other call through a value (from another function, before the declaration, after a second store) still
  refuses by name: that is slice Fb.
- Admitted value set (D1's soundness note, updated): a function value under strict equality is compared by identity,
  ToBoolean true, ToNumber NaN (no own `valueOf` yet), the `undefined` probe false.

Proof: `tests/issue-7354-fa-function-values.test.ts` (acceptance: each program returns with node's answer and throws
with a wrong one; refusals pinned by name; the legalization arms). Pin updated: H's "holding a function expression"
refusal (it runs now).

### Named gaps (refused, not built here)

- A function declaration read as a value (`assert`, `compareArray`, `Test262Error` in the prelude) — `identifier
  "id" is not in scope`. It needs one closure per declaration (identity) created before the first statement: a
  trampoline lifted body and a home global the module-init prologue fills. Next step of this lane (stacked).
- A call through a value whose callee is not static (slice Fb); a call with a missing or an extra argument on the
  static call (`closure call arity mismatch`); a closure returned from a closure (`concrete return needs a dynamic
  box`); a captured local written after the closure is created; `this` / `arguments` / properties (slice C);
  `typeof` of a function value (Str2's `typeof` must answer `"function"` for it); an arrow function or a parameter
  default (no all-dynamic contract).

### Review round 1 (RV7309, BLOCKER on ab4040fced)

Fixes made on Opus (lead's decision) after a Fable subagent stopped on a rate limit; realm head cd03504321 merged
first.

| finding | answer | proof |
| --- | --- | --- |
| M1: writing a parameter inside an all-dynamic function expression was an invariant crash out of `compile()` | Fixed: the body seeds a slot for every written parameter through `lowerMutableParameterStorage`, the helper a declaration's reassigned parameter already uses (`writtenParameterSlots`); the planned member closure's inline copy of that seeding is gone too | runs: `if (a === undefined) a = 3`, `a++`/`b--`/`b -= 2`, a written parameter in a function's local closure; named refusals: `+=` (dynamic `+`), a nested closure reading or writing it, `arguments` aliasing, a closure assigned to it |
| M2: `staticFunctionValue` answered true for `this.f =`, `globalThis.f =` / `globalThis["f"] =`, Annex B block functions | Fixed with one shared proof: `bindingIsUniqueAndNeverWritten` (the name's only binding site in the file, never assigned, no eval/with) and `sourceMayWriteBindingUnseen` (no unspelled code, no reflective route, no member of that name written on any object), plus "the global object does not escape". `sourceMayWriteBindingUnseen` replaces the identical three-predicate conjunction in `wrapper-construction.ts` and `always-undefined-binding.ts` (one proof, three users) | contract unit tests pin each route: `this.f` (top level and in a function), `globalThis.f`, `globalThis["f"]`, a block-level function, a function in an `if`, `f.constructor("…")()`, a shadowing binding |
| retype accepted any live site | `retypeClosure`: only a live closure site, typed by the closure type | registry test |
| `inCall` admitted a closure anywhere | Narrowed: only a closure body's first parameter (`__self`); a closure anywhere else in a contract still refuses | presentation test |
| `holdsDynamicClosure` duplicated `bindsCatch` | One walker `holds(node, match)` with the two matchers | — |
| the H2 refusal read "not in scope" | Says what it means: a closure reading a local of its enclosing function declared after the closure is created | H2 pin |
| kind invariant (b): an object literal's closure member entered the carrier outside `admit` | The legalization's coerce arm admits a packed callable as `function` through `admit` | legalization unit test |
| (found while checking the #3518 suites) a closure inside a descriptor literal got the all-dynamic signature | `ownedByDescriptorLiteral` (one predicate, used by the contract and by from-ast's descriptor branch): the checker's signature wins | the three issue-3518 getter files pass again; contract unit test |
| kind invariant (a), (c) | S3's lines in the realm PR (#7312): S3 writes them against an exported kind predicate there; Fa re-points them at `admit` when it merges that head | — |

Verified on the rework head: typecheck, loc, func (also against `origin/main`), coercion, oracle-ratchet,
dead-exports, import-cycles, compiler-boundaries pass; 420 tests (the Fa file, #7354 H/H2/X/P/D1/O, prepared
entry/runtime, the three issue-3518 getter files) all pass.

### Compile time

A program with one closure compiles in about 22 s through the strict entry on a 4-core box (one with no closure:
under 1 s). About 17.5 s of it is the realm emission that main already pays for an annotated closure before it
refuses at presentation; the census's emission re-authentication passes (`emittedSupportFunctionReceipts`, several
per presentation) are most of the rest. This is the realm's `#verifyLayout` cost (Perf lane), not this slice's code:
the closure owners add no authentication pass.


## Realm join (2026-11-19, branch `claude/7354-realm` from `origin/main`)

The native realm of #3518 (`src/backend/wasmgc/program/native-realm.ts`) is reserved for any program with a
`js.object.*` use, a `Number(v)` use or source closures, but nothing let such a program present: the physical plan
had no arm that binds a source call to a realm function, and the Prepared runtime census joined only the native
string and formatter setups. This branch builds the shared join, and its first row, the source objects of slice O
(step O1). Lane S4 (slice Fa) adds the closure/invocation owner as one more row.

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

## Fb — calls through a dynamic value (2026-11-19)

Branch `claude/7354-fb`, stacked on `claude/7354-fa`.

### Implementation Plan

Measured first (on Fa's head): `function t(fn){ return fn(2); } t(function (x) { return x * 2; })` already reaches
from-ast's one dynamic-call path (`lowerDynamicValueCall` → `applyDynamicCallee`, function-object-lowering.ts), which
emits the ordinary pipeline's runtime helpers (`__objvec_new/push`, `__is_callable`, `__new_TypeError`,
`__apply_closure`); the legalization refuses at `__ir_dyn_call_argument`. The #3518 native dispatcher
`js.closure.call:N` already does IsCallable and throws the TypeError itself (`buildClosureInvocationFailure`), but
its planner (`native-invocation-requirements.ts`) admits only a callee that is a packed `closure.new` of the same unit
(built for `f.call` on a known closure), and the dispatch entries are those callees' units only.

| concern | module | reuses | removes |
| --- | --- | --- | --- |
| the call | `function-object-lowering.ts`: on the Prepared lane `applyDynamicCallee` emits one `js.closure.call:N(receiver, callee, …args)` over carrier operands | `functionObjectDynamicValue`, `irClosureMethodReference`, `coerce.to_externref` of a dynamic value (O1) | the runtime-helper sequence on this lane |
| a dynamic callee | `native-invocation-requirements.ts`: a method use whose callee is no packed allocation is a `dynamicCallee` use; every source closure must be dispatchable (fixed parameters, carrier slots), else a named gap | `calculate`, `external` | — |
| dispatch | `native-source-closure-callables.ts` `resolveEntries`: a dynamic use selects every source unit; `native-invocation.ts` `entries`: one arm per distinct signature | `resolveSourceEntries` | the per-closure duplicate arms |
| result | legalization: `__ir_dyn_call_box` of any externref is the carrier (Fa's arm, widened from packed callables) | Fa's arm | — |
| script vars | from-ast: a call through a dynamic home in any position on the lane; a function value stored by assignment | `isStatementDynamicModuleCall` (ordinary lane only now), `argumentIntoDynamic` | — |

Quality criterion: one call path for a non-static callee on the lane (the same `lowerDynamicValueCall`), no second
dispatcher, one lane predicate in from-ast.

**Dispatcher or `call_ref` at the call site** (lead's question, measured on this branch, one dynamic call, n
closures `var cI = function (x) { return x; }`, strict Prepared entry, standalone):

| n | module bytes before dedupe | after | compile |
| ---: | ---: | ---: | ---: |
| 1 | 23,588 | 23,588 | 26 s |
| 10 | 24,628 | 24,097 | 52 s (static calls only: 38 s) |
| 50 | 29,424 | 26,533 | 277 s |

The `js.closure.call:N` dispatcher already is a `call_ref` through the closure struct's own funcref, behind a
`ref.test` of the allocation type and the lifted func type; what grew with every closure was one identical arm per
closure. Its arms are now one per distinct (allocation type, lifted signature): every all-dynamic closure of one
arity shares one. The remaining growth is the closures' own bodies and allocations. The dispatcher stays the one call
path because it does what a call site cannot without copying it everywhere: IsCallable and the catchable TypeError,
the saved/restored `currentThis` / `argc` / extra-argument protocol (`this` and `arguments` of slice C), `undefined`
for missing arguments by the callee's arity, and it is where the realm's builtin function objects (S5) and construct
(S11) are added as rows. Compile time is the realm's quadratic reservation audit (S6, #7365), not the dispatch.

### Result

`function t(fn){ return fn(2); } if (t(function (x) { return x * 2; }) !== 4) throw 1;` validates and runs through the
strict Prepared entry. Missing arguments read `undefined`, extra ones are dropped, a non-callable value (number,
`undefined`) throws a catchable TypeError, a script var is called from another function and after a second store.
Proof: `tests/issue-7354-fb-dynamic-calls.test.ts`.

Named gaps: a dynamic call in a program with no source closure (no dispatcher: `js.closure.call:N needs runtime
function materialization`), spread arguments, `new`, method calls and `fn.call` / `fn.apply` on a dynamic value
(slice C), a receiver other than `undefined` (`this`, slice C).

