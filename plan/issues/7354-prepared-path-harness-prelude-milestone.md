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
# 2026-11-22 (slice H2): src/ir/program-source.ts +1, the checker argument of `functionDeclarationValues` (it asks
# `preparedBindingRewritten` instead of the deleted whole-program binding proof); from-ast.ts shrinks by 1.
# 2026-11-22 (slice P1): src/ir/program-consumer.ts +1, the one argument that tells the dispatcher's fill whether the
# realm holds built-in methods (its abort arm; the arm itself is in closure-method-body.ts), read from the realm
# requirements at the only place both owners meet; that line takes materializePhysicalProgram from 300 to 301 lines
# (func-budget-allow below). src/ir/from-ast.ts shrinks (the descriptor-definition lowering moved to
# open-object-carrier.ts).
func-budget-allow:
  - src/ir/program-consumer.ts::materializePhysicalProgram
loc-budget-allow:
  - src/ir/program-consumer.ts
  - src/ir/program-physical-plan.ts
  - src/compiler.ts
  - src/ir/program-source.ts
  - src/ir/from-ast.ts
  - src/compiler/ir-program-presentation.ts
import-cycles-allow:
  - ir->frontend: 9 # 2026-11-22 (#7354 U step 1): a split, no new dependency: the unit body producer moved from src/ir/program-source.ts to src/ir/program-source-units.ts with its frontend imports; both files still need frontend/boolean-return-boundary.ts, so that one edge is counted twice
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

## Slice C2 result (2026-11-22, branch `claude/7354-c2` from `claude/7354-f2` cebb122ea1; F2 review fixes 1de4a6f2e7 and `main` d6a09c082d merged)

`new`, `this` and `instanceof` on plain functions; C2-D1 first.

### Built

- **C2-D1** (`dynamic-member-access.ts`): an access refuses at compile time only when no kind the receiver may hold can
  answer; each lacking arm is the run-time abort (`js.value.unsupported`, shared as `abort` in `dynamic-value-chains.ts`).
  An object's read of an Object.prototype data key is `js.object.has ? get : abort`; `__proto__` keeps its refusal
  where no kind answers. An intrinsic is pure, so the abort's text is the arm's answer (an unused abort was dropped as
  dead code); a write's unread answer became the carrier for that reason.
- **Realm rows** (`native-source-objects.ts`, js.object family, no `js.function.*`): `js.object.inherits` (the
  OrdinaryHasInstance walk over ordinary links) and a row for the declared `js.object.create-with-prototype`.
  (Review: `js.object.is-constructor` and init's `hasConstruct` bit were deleted, see below.)
- **`js.closure.receiver`**: the invocation substrate's `__current_this`, beside `js.closure.undefined`;
  `closureInvocationKind` is now the one reading of the family's spellings (requirements, callables, string values).
- **Legalization** (`dynamic-function-operations.ts`, new, three one-line `expand` cases): `this` (strict: the receiver;
  sloppy: object kinds as is, else the abort — `IS_OBJECT`), `new` (the function-kind test is IsConstructor → TypeError
  `Value is not a constructor` after the arguments; one Get of `prototype` (`getPrototype`, shared with instanceof);
  link to an ordinary object (`isOrdinaryObject`) / abort for another object (`IS_OBJECT`) / else `create-default`; F2's
  `js.closure.call:N(obj, C, …)`; an `IS_OBJECT` result replaces the object), `instanceof` (callable right operand else
  TypeError; a non-object left is false before the Get; a non-object `prototype` is a TypeError; ordinary objects
  walk, function/error answer false by the M1 premise; a program naming `Symbol` refuses).
- **Producer**: `programDynamicContracts(input, …).codeStrictness` yields `functionCodeStrict` and, for a function on the
  native lane of a program that creates a function value and reads its own `this` (`readsAmbientThisGlobal`, moved to
  `src/shared/body-references-own-this.ts`), `ambientThisStrict`; function expressions get both through
  `closureCodeStrictness` (a closure's own strictness also fixes its member writes, which refused before). A direct call
  of a `this`-binding declaration refuses (`a direct call of F installs no receiver for its 'this'`) in
  `program-source-direct-calls.ts`, which now also takes the call-graph loop (offset). Where a closure binds its own
  `this`, a call of a closure local goes through the dispatcher, and Fa's static closure value declines.
- **from-ast**: `namesDynamicValue` gates `new` and `instanceof` (a dynamic local or a dynamic module home on the lane);
  `lowerDynamicConstruct` / `lowerDynamicInstanceOf` moved to `function-object-lowering.ts`; `liftClosureBody` binds
  `this` from one `ambientThisStrict` option (the closure options take `CodeStrictness`'s rows as they are). from-ast 17388 → 17364 lines, program-source 1838 → 1835 (vs 1de4a6f2e7), no grant.
- `new F` reads F as a value (`functionDeclarationsReadAsValues`), so F gets its declaration home. Before/after:
  `function F(){} var o = new F();` `unknown class "F" in <module-init>` → runs; `function F(){ return this; } F();`
  `'this' reference outside …` → `a direct call of F installs no receiver for its 'this'`; sta.js + `Test262Error('m')`
  `instanceof RHS class "Test262Error" has no projected shape` → the direct-call refusal.

### Differs from the plan

- No `construct:N` realm functions / `constructArities` / `readsReceiver`: the legalization emits F2's dispatcher call,
  which the planner picks up from the projection. No IR-level receiverless pass: the check is on the direct-call plans.
- Local closure calls: the plan named only Fa's static call; a closure local's direct call also skips the dispatcher
  (`function w(){ var f = function(){ 'use strict'; return this; }; return f(); }` answered the stale receiver): fixed
  by the program-wide `closuresBindReceivers` rule.
- `this` binds only where the program creates a function value: elsewhere nothing reaches the dispatcher, and a bound
  `this` met physical gaps.

### Proof

| file | exit | tests |
|---|---|---|
| issue-7354-c2-constructors (new; after review) | 0 | 19 |
| issue-7354-c2-this (new; after review) | 0 | 18 |
| issue-7354-m-refusals (after review) | 0 | 44 |
| issue-3518-ordinary-object-callable-contracts (after review) | 0 | 46 |
| issue-7354-m-refusals + 3518-ordinary-object-callable-contracts | 0 | 93 |
| issue-7354-m-prototype-premise + f1-function-kind | 0 | 24 |
| issue-7354-o3-member-write + str-strings | 0 | 32 |
| issue-7354-o4-member-read | 0 | 16 |
| issue-7354-f0-dead-top-level-bindings | 0 | 88 |
| issue-7354-fa-function-values + p-parameter-contracts | 0 | 44 + 26 |
| (unmodified) f1b-declaration-values, f2-calls-through-values + f1b-function-objects, x-dynamic-throw + f1b-function-object-writes | 0 | 11, 18, 62 |

Pins moved (step 1, C2-D1): m-refusals (M2 error constructor/stack/toString, B23/B24 wrapper keys, C6 `__proto__` on
primitives → aborts; the M2 strict write → node agreement; Object.prototype data keys off an object → aborts, `__proto__`
read/write stay refusals), m-prototype-premise (`v.__proto__`, `v.constructor` → aborts), o3 (writes beside a caught
error → node agreement), o4 and str (a string var's `length`, `o.toString` → aborts), f1-function-kind (`v.__proto__ =`
→ abort). Later: F0 (its refusing initializer reads `new.target`), Fa (`this` → abort), P (a call through a
declaration's value runs; that row was red on the F2 base already).

Sweep (`new`, `instanceof` left/right, `this` identity, `this.k` read/write, `.constructor`) × 9 values (declaration,
expression, object, 1, "s", undefined, null, caught TypeError, instance) × sloppy/strict, each in a loop, unused and
as a value: 126 programs, 108 node's answer, 18 the abort (`.constructor` of non-instances, writes to a caught error),
0 wrong, 0 invalid, 0 exceptions. Regression set (F2's 109 + 71 + 68, a quarter of its 560-sweep, 110 C2/D probes = 502)
on base and head: AGREE→AGREE 338, REF→REF 69, ABORT→ABORT 1, REF→AGREE 84, REF→ABORT 10; nothing that was right on
the base is anything else.

Mutations (each alone, probe run): killed — the ordinary-object rows (object/function/error, then a table), the any-kind
rule, the object arm's `has`, the strict bit, the receiverless refusal, the `Symbol` refusal, the closure-call
dispatcher rule, `new` as a value read, the no-function-kind construct shortcut, the function-prototype abort, the
non-object-prototype TypeError, the callable right-operand TypeError, both result arms of construct, a closure's code
strictness, and (review) Fa's static-closure decline: `'use strict'; … var x = o.m(); var g = function(a){…}; …
g('y')` answers the receiver `o.m()` left behind without it (c2-this). My earlier reason for that survivor ("the
module-init local guard comes first") was wrong: my probes simply had no method call before the static call. Removed in
review: is-constructor's bit read (unkillable: every function value is a constructor) and the `instanceof` shortcut for
a value of no object kind (`holds` folds it). No survivors left in the C2 code.

Bytes: ordinary pipeline, 22 test262 files (new, instanceof, this, function-code) × default + standalone: 44/44
identical vs F2 1de4a6f2e7 (again after review). `check:prepared-bytes` (804 rows) vs 1de4a6f2e7, after review round
2: 3 differ — 46 (the write chain's carrier answer, run on base and head with the same outcome; `__closure_receiver` is
reserved only where a unit reads the receiver, so 180 is identical again); 204 compiles and ends at the abort (was a
refusal, C2-D1); 214 refuses by a later name (`js.closure.call:1 in a program that creates no function value`). The
init-body rows 53, 74, 581 are identical again. Regression set re-run after review: the same counts.

Gates (bare, exit 0): typecheck, LOC and function budgets (also `LOC_GATE_BASE` = main d6a09c082d), coercion-sites,
oracle-ratchet, dead-exports, import-cycles, compiler-boundaries `--mode inventory --base d6a09c082d`
(`dynamic-function-operations.ts` classified clean ir-program; `body-references-own-this.ts` moved to src/shared).

### Review round 1 (PR 7389): rebuttals and known limits

- `BOOLEAN` in `dynamic-function-operations.ts` is not the chains' `TEST_RESULT`: that is an unbranded i32, while
  `dyn.instanceof`'s result and the realm's tests carry the Boolean brand; the branded constant of `boolean-brand.ts`
  is in a mixed module a clean ir-program module may not import, so the module keeps its one constant.
- `ORDINARY_CHAIN` is gone: `isOrdinaryObject` reads `MEMBER_ACCESS_ARM` ("object" — the kind whose access is the
  realm's ordinary [[Get]] / [[Set]]), one answer for "the realm's ordinary layout".
- `holds()` and the `typeof` comparison arm are not shared: the `typeof` arm folds against the admitted set, before a
  value's kinds are proven, and writes the comparison's own (possibly negated) result; `holds` folds against the
  value's proven kinds into a fresh test. Folding `typeof` by proven kinds would change the bytes and the tested kinds
  of every `typeof` program for no answer that changes.
- Known limit: C2-D1 turns some named compile-time gaps into run-time aborts when the kind analysis cannot rule out
  `undefined` (fixture row 204, `var s = "ab"; s.length`: the base refuses by name, the head aborts), so gap tallies
  carry less information.
- Known limit: `js.object.inherits` and `create-with-prototype` assume every object-kind value has the realm's
  ordinary layout (`ref.cast`); the first slice that admits arrays or Promises as the object kind must revisit both.
- Known limit: IsConstructor is the function-kind test because every function value on this lane is a constructor
  (the comment where `new` lowers states it); the slice that admits the first non-constructor function value adds the
  test, with a program that reaches it.

### Sample (411 rows, real prelude)

| first gap | F2 base | C2 |
|---|---|---|
| `unknown class "Test262Error" in assert` | 272 | 0 |
| `dyn.member_get with a computed key` (compareArray's `b[i]`, arrays #7352) | 0 | 271 (+2 behind a switch parse note) |
| `a direct call of f1 installs no receiver for its 'this'` (10.4.3-1-29-s) | 0 | 1 |
| `formatIdentityFreeValue … is written` | 73 | 73 (+1 parse note) |
| `empty array 'failures' escapes …` | 41 | 41 |
| `verifyProperty … is written` | 6 | 6 |
| pass (all negatives) | 14 | 14 |

No positive row passes. The step-past tally (behind `b[i]`) was not measured.

### Not verified

- Node 25 (not installed); no legacy exception instruction was hand-built (the dispatcher's own `try_table` guards).
- The other m/o/str2/ty/t/h/d1/vg tests and r-provider-census after the merges; the 3518 runtime-provider suites.
- The prelude's `assert.throws` verbatim (it stops at compareArray before `assert` can run).
## Perf5 result (2026-11-22, branch `claude/7354-perf5` from `claude/7354-f2` `1de4a6f2e7`)

The invocation requirements are no longer re-derived: every use checks only that the planner issued the pack, as
Perf4 did for the realm. The first two commits kept the re-derivation once per compile in a validator stage; review
round 1 deleted it (see the end of this section). The measurements below were taken with that stage present; it ran
only with the switch on (0.14 s at N = 10).

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

### Each site (final, after review round 1)

| site | what it did | decision | why |
| --- | --- | --- | --- |
| `assertNativeInvocationRequirementsCurrent` at 8 uses (`authenticate`, `resolveEntries`, `nativeStringInvocationRequirements`, `planNativeInvocationInput`, `nativeInvocationAbiBindings`, `selectNativeBooleans`, `prepareNativeProgramStringInput`, `prepareNativeEmission`) | per use: the census's whole-program snapshot compare, a fresh census, a fresh derivation, two compares | **`assertNativeInvocationRequirementsIssued`** (issue lookup) | The pack and the program it was derived from are frozen (Perf3), so it cannot go stale; Perf4's argument for the realm. |
| the re-derive-and-compare check itself and its snapshot `WeakMap` | — | **deleted**, with no validator stage | A stale plan cannot arise in a real compile, so a check for it is a defensive branch; #7380 §2 adds no currentness check. Perf3 and Perf4 deleted their siblings outright. |
| realm `assertNativeRealmRequirementsCurrent` (an issue lookup since Perf4) | — | **renamed `assertNativeRealmRequirementsIssued`** (18 references in 8 files, mechanical) | One name pattern for the two sibling checks. |
| the two `WeakSet` + fail bodies | the same shape twice | **one helper**, `issuedPacks(refusal)` in `src/ir/program/issued-packs.ts` (`issue` / `assertIssued`) | Both planners register through it; refusal texts unchanged. |

### Tests (each file alone, `VITEST_MAX_FORKS=1`, switch on)

After review round 1, merged with `main` `77631faba5`:

| file | result |
| --- | --- |
| `issue-3518-native-getter-invocation` (modified) | 37/37, exit 0 |
| `issue-7354-f2-calls-through-values` | 10/10, exit 0 |
| `issue-3518-native-realm-requirements` (renamed call) | 24/25, exit 1 — the same 1 red as on the F2 base (`js.object.init-function` realm row) |

Before review round 1 (commits `3e670a6858`, `eac330ed5f`, on the F2 base): fa-function-values 44/44,
native-builtin-functions 36/36, invocation-consumer 61/61, object-get-owner 64/64, builtin-request-literal-authentication
24/24, 3525-public-prepared-driver 16/16, 7364-prepared-empty-program 11/11 (all exit 0). Red there and identically
red on the F2 base: getter-results 2 (`string.const runtime is unavailable`), getter-resource-join 2 suites (same),
object-realm-declarations 4 (same), invocation-substrate 4 (post-completion mutation, Perf4's boundary audit),
realm-source-integration 2.

Changes in `issue-3518-native-getter-invocation`:
- Deleted: "refuses stale actual %s provenance after the paired positive" (5 cases) and its `mutableProgram` helper.
  Each edited a `structuredClone`d program after planning and asserted the deleted check (the forged-plan shape Perf3
  removed). The positive calls now use `assertNativeInvocationRequirementsIssued`.
- "refuses changed function/global ownership/layout" were red on the F2 base (Perf4 moved the ledger audit to the
  phase boundaries); they now expect the refusal at `freezeReservations` ("altered"). The reviewer confirmed these.

### Bytes and gates

- `check:prepared-bytes`, after review round 1: all 804 rows identical, `main` `77631faba5` vs head (file-copy A/B of
  the 11 changed files), switch off; head with the switch on equals main off.
- Before review round 1, vs the F2 base: the 804 rows (off and on), 109 F2 probe programs, 71 F2 regression programs,
  and F2's 20 test262 files × (default, standalone) through the ordinary pipeline, all identical.
- Gates, each bare: typecheck, dead exports, LOC and function budget with `LOC_GATE_BASE` = main `77631faba5`;
  before round 1 also coercion sites and oracle ratchet.

### Review round 1 (lead)

Correctness met (218 programs identical; 3,188 per-use checks, none stale or unfrozen; 85.7 → 21.0 s). Quality not
met, fixed: (1) the kept re-derive-and-compare check and its accepted-program stage are deleted; (2) the new
seeded-stale test is deleted (forged-plan shape); (3) one name pattern and one helper for the invocation and realm
issue checks.

### Not verified, left

- Node 25 (CI's version) is not installed here.
- Timings were not re-measured after round 1: the deleted stage ran only with the switch on.
- Compile time is still superlinear (5 → 10 → 20 closures: ×2.2, ×2.3–3). Candidate: `nativeCallAbiBindings` rebuilds
  the owner function's type map (`nativeAsyncCallableValueTypes`) per call use — 3.1 s (15 %) at N = 20, quadratic in
  calls per function. Not per-use re-proof, below the 25 % bar; next slice.
- The remaining one-time copies and settled walks (#7380 step 5b) and, switch on, the slot probes.

## Perf6 result (2026-11-22, branch `claude/7354-perf6` from `claude/7354-u` `4f8aa95b50`)

One compile of the real prelude (the runner's shim + `assert.js` + `sta.js`) + `assert(true);`, with the runner's
options, now takes ~7 s and fits a 512 MB heap; before it took ~24 s and ran out of memory at 1024 MB. Five commits,
one cause each; same binary after every one (sha256 `8c0401d9…6990e4ede`, 80,624 bytes, switch off and on).

### Measurements (tsx, strict Prepared entry, one compile per process, load 1–3 from other agents)

Peak = sampled `heapUsed` (includes uncollected garbage, so it depends on GC timing); the 512/1024 columns are the
real limit test (`--max-old-space-size`).

| commit | off | off peak | on | on peak | 512 MB | 1024 MB |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| base `4f8aa95b50` | 23.7 s | 1,517 MB | 51.3 s | 1,831 MB | OOM | OOM (Mark-Compact at 1,017 MB live) |
| `ae3f251568` copies return their own frozen products, one ancestor set | 16.9 s | 681 MB | 36.8 s | 724 MB | — | — |
| `9bd83f8501` settled verdicts / copies stop at known deeply frozen data | 15.6 s | 1,268 MB | 36.8 s | 1,262 MB | pass (18.5 s) | — |
| `83fad4e49f` Promise source census issued, path record deleted | 10.9 s | 807 MB | 31.5 s | 840 MB | — | — |
| `63925e7fb6` emission no longer re-plans the physical plan | 8.8 s | 689 MB | 27.5 s | 723 MB | — | — |
| `c25b421a5c` string plan checked as issued, not re-planned | 7.3 s | 473 MB | 20.8 s | 509 MB | pass off 7.8 s / on 22.1 s | (implied) |

Allocation (inspector sampling incl. collected objects) at the base: ~20 GB allocated per compile — whole-tree compares
5.4 GB, `immutableCopy` 5.2 GB (a fresh ancestor `Set` per node), `ownerFor` 4.5 GB, settled walks 3.2 GB.

### Each site

| site | what it did | decision | why |
| --- | --- | --- | --- |
| `immutableCopy` (`src/ir/program/data.ts`) | deep-copied values that were already its own frozen copies (the program's semantic part inside every snapshot), and allocated a copy of the ancestor set at every node | **returns a deeply frozen value as is**; one ancestor set (add/delete); body split into `copyChildren` | a copy of a deeply frozen copy is an equal tree; membership (`deeplyFrozen`) is permanent because freezing cannot be undone |
| `isImmutable` walk of the settled verdicts (`src/shared/contracts/settled-verdict.ts`) | re-walked the whole program under every holder (19 walks, 2.9 M nodes) | **stops at data the IR knows is deeply frozen** (`isDeeplyFrozenPreparedIrValue`, injected like `preparedIrFrozenCollectionMembers`); `freezePreparedIrRuntimeValue` records what it froze and skips it next time | same permanent fact; "freeze once, never re-walk" |
| Promise source census `paths` + `snapshots` + `assertNativePromiseSourceCensusCurrent` (`src/ir/program/native-promise-inventory.ts`) | recorded a path for every object of the program (416,741 rows, only read by the re-proof) and re-collected and compared the census at each use | **deleted**; `assertNativePromiseSourceCensusIssued` (`issuedPacks`) | the census is frozen and borrows a frozen program (Perf3/4/5's argument) |
| `prepareNativeEmission` re-plans (`src/ir/program-consumer.ts`) | re-ran `planPhysicalSetup` for source closures and async frames and compared; compared the string demands with a deep copy taken at acceptance (`nativeSnapshot`) | **deleted** | plan, program, options and string input are frozen. The formatter branch's re-plan stays (see below), and it covers the one mutable input of `planPhysicalSetup` |
| `assertNativeStringValueReservationInput`, `ownerFor`, `nativeStringSetup` (`native-string-values.ts`, `program-physical-plan.ts`) | re-planned the whole string plan (fresh census, plan, compare) at each check, plus a settled walk and a demand snapshot compare per `ownerFor` | **`assertNativeStringValuePlanIssued`**: the plan was issued by `planNativeStringValuePhysical` for exactly these demands, invocation requirements and realm literals, under these options (a `WeakMap` provenance lookup); the owner's snapshot and settlement are deleted | the plan and its demands are frozen and derived from a frozen program |

Not removed, reported: the formatter support body (`prepareNativeNumberFormat`) is **not frozen** (checked at run
time: `formatter.body` unfrozen), so its snapshot compare and the formatter re-plan in `prepareNativeEmission` guard
a real possibility of mutation between acceptance and fill. Freezing it at creation would let both go (~0.8 s here).

### Remaining profile (head, switch off, ~6.5 s inside `compile` under the profiler)

`acceptPreparedIrProgram` 2.8 s (of it the formatter's `planPhysicalSetup` 1.2 s, `prepareNativeProgramStringInput`
0.7 s), `materializePhysicalProgram` 3.0 s (lowering 1.6 s; per-emit completion inventories `completedOwner` →
`ownerFor` / `requireCompleted*` ~1.0 s across ~8 small checks), GC 1.4 s. No single check above 0.4 s self. Candidates
for a next slice: the per-emit completion inventories (`completedOwner`, once per string literal emit) and
freezing the formatter body.

### Bytes and tests

- Prelude binary identical after every commit, switch off and on.
- `check:prepared-bytes`: 804 rows identical base vs head (switch off), and head with the switch on (740 binaries,
  63 refusals, 1 throw on both).
- 46 varied programs (30 small programs × standalone + gc target, 12 of them again behind the real prelude, 4
  prelude + `assert*` bodies; `.tmp/perf6/progs.mts`): 76 outcomes identical base vs head.
- Ordinary pipeline: 20 test262 files × (default, standalone) identical base vs head (40 binaries).

Tests (each file alone, vitest, switch on):

| file | result |
| --- | --- |
| `issue-7354-perf-string-authentication` (modified) | 27/27 |
| `issue-7354-str-emitter-requests` | 9/9 |
| `issue-7380-prepared-validator` | 29/29 |
| `issue-3518-native-promise-inventory` (modified) | 28/28 |
| `issue-3518-native-boolean-consumer`, `-scanner-value-chain`, `-realm-requirements` | 12/12, 11/11, 25/25 |
| `issue-7354-f2-calls-through-values` | 8/10 — the same 2 red on the base (refusals now abort bodies, slice U) |
| `issue-7354-c2-this` | 16/17 — the same 1 red on the base |
| `issue-3518-native-string-value-materialization` | 11/15 — the same 4 red on the base (Perf4's boundary audit) |
| `issue-3518-native-getter-resource-join` | 2 suites red, same as on F2's base (`string.const runtime is unavailable`) |

Removed test cases (each mutated an issued plan or a census input after issue, the forged-plan shape #7380 retires):
`perf-string-authentication` › "refuses retained demands changed between two emits", "refuses a retained plan changed
between two emits", "refuses a plan changed after many emits"; `native-promise-inventory` › the `stale` half of
"preserves unused allocation provenance…" and of "checks … producer plan association…", and the two `census.paths`
assertions.

### Gates

typecheck; LOC and function budget (merge base and `LOC_GATE_BASE` = main `b24e71f5c0`); coercion sites; oracle
ratchet; dead exports — all pass. `check:compiler-boundaries:inventory` fails on `src/ir/abort-bodies.ts`
(unclassified target), slice U's new file, not this slice's; no new src file here.

### Not verified

- Node 25 (CI's) is not installed here; all numbers are local Node under tsx, not the runner's bundled worker.
- The 1024 MB column after the base is implied by the 512 MB pass, not run.
- The 512 MB column was not run for the first, third and fourth commits.

### Perf6 review round and follow-ups (same branch)

- Review fixes: runtime data is flagged deeply frozen only after the whole walk and only in the shapes the settled
  verdicts accept; the Promise producer observation checks the string plan's issue (options compared only where a
  caller holds its own) instead of re-planning; `issuedPacks` refuses with each planner's own error.
- (a) Partial: the formatter support body is frozen at creation and its snapshot copy/compares are gone. The manifest
  itself cannot be frozen in place (`support.providers` is a live `Map`), so the fresh-manifest compare and the
  formatter re-plan stay.
- (b) `preparedIrDataMismatch` answers equal at once for a deeply frozen value compared with itself.
- (c) Not done: the per-emit completion checks (`completedOwner`, ~0.8 s) read the mutable module ledger, which
  emission keeps writing between phases; only the boundary audit would cover a later change, so they stay.
- Prelude after these: off 6.2–7.3 s, on 18.7–19.5 s, both pass at 512 MB; binary and the 804 rows unchanged.

## Slice W plan (2026-11-22, branch `claude/7354-w` from `claude/7354-u` `f8fd70dc1c`)

**Blocker.** 41 of the 47 `propertyHelper.js` rows of the 420-row ES5 sample stop at
`IrInvariantError: #5092 then arm proved number but lowered as dynamic in isWritable` — thrown OUT of `compile()`
(not a compile_error row), at `var unlikelyValue = __isArray(obj) && name === "length" ? nonIndexNumericPropertyName : "unlikelyValue"`.

**Minimal repro** (strict Prepared entry, standalone):
```js
var e = f(1);
var n = 4294967295;
function f(a) { var u = a === 1 ? n : "x"; return u === "x"; }
```

**Cause.** The Prepared path is unselected, so from-ast's `mixedPrimitiveConditionalClaim` is the only #5092 proof. It
classifies each arm from the checker (`makeIrPrimitiveExpressionClassifier`: `n` is `number`, following its
initializer). But since #7354 H a script `var` without a proven typed home lives in the dynamic home whatever the
checker infers, and a read of it lowers to the dynamic value (`undefined` before its initializer runs — `f(1)` above
sees exactly that). The two answer different questions: the checker the declared type, from-ast the value's IR
representation. The proof is the wrong side; the invariant is right (its intent, #5092: a claimed shape whose arm
does not lower to the proved representation is a selector⇄builder desync). `tryLowerDynamicConditionalValue`, the
dynamic-carrier join that should own `c ? <dynamic> : <literal>`, misses the shape too: its arm test reads only
`cx.scope`, and a module home is not in scope. Without the invariant the builder's own `emitBox` guard throws
("re-boxing a dynamic value is invalid") — no wrong value or invalid Wasm is reachable, only the exception.

**Fix (two edits, one predicate).**
1. `bindingHoldsDynamic(name, cx)` in `from-ast.ts`: a dynamic slot, else the existing C2 `namesDynamicValue` (dynamic
   local, or on the Prepared lane the dynamic module home). `tryLowerDynamicConditionalValue`'s inline arm test is
   replaced by it, so `c ? n : "x"` is the D1 join: `n` passes as-is, `"x"` is boxed — JS's value both before and after
   the initializer.
2. `mixedPrimitiveConditionalClaim` refuses the claim when an arm MAY yield the dynamic value:
   `mayYieldCarrier(arm, bindingHoldsDynamic)`, a new export of `src/ir/analysis/carrier-expression.ts` — the "may"
   dual of the existing `producesCarrier` ("every value is the carrier"), built on the same `everyYieldedValue` and
   `isCarrierAddition`. It follows only what passes a value on (conditional arms, comma / `=` right side,
   `&&`/`||`/`??` operands, a carrier `+`, type projections), so `typeof n`, `-n`, `n === 1` stay claimable (their
   result has one representation whatever `n` holds). An unclaimed mixed arm such as `c ? n + 1 : "x"` reaches the
   generic tail's existing named refusal (`ternary branches have different types (dynamic vs string)`), an abort body
   under slice U's policy.

Reuses: `namesDynamicValue`, `everyYieldedValue`, `isCarrierAddition`, `skipOuterExpressions`. Removes: the
duplicate slot/local dynamic test in `tryLowerDynamicConditionalValue`. `from-ast.ts` grows by ~4 lines net,
`lowerCall` not touched. Ordinary pipeline: the module-home arm of `namesDynamicValue` is gated on the Prepared lane
(`createsFunctionObjects`), so only a dynamic local/slot arm can change there, and that today throws the same
invariant.

**Acceptance.** Behaviour: the repro gives node's value (both `f` calls), plus a wrong twin; `c ? n + 1 : "x"` is a
named abort; ≥80 probes base vs head against node — nothing right becomes anything else, 0 wrong, 0 exceptions;
ordinary pipeline byte-identical on 20 test262 files × default + standalone; `check:prepared-bytes`. Quality: one
binding predicate shared by the join and the claim, the walker beside its dual in `carrier-expression.ts`, no
`isWritable`/name special case, invariant untouched.

**Measured with the fix (uncommitted, approximate driver: `assert.js` + `sta.js` + includes + body through the strict
entry, standalone):** the 41 rows move from the exception to
`CE ir/from-ast: type override (dynamic) disagrees with annotation (f64) at param functionLength of verifyCallableProperty`
(a JSDoc `@param {number}` read as an annotation) — the next blocker for all 41. The other 6 rows stop earlier at
`function declaration 'formatIdentityFreeValue' read as a value is written`, unchanged.

## Slice W result (2026-11-22, branch `claude/7354-w`; W1 = `d9e4906343` + `9e0d351a50`)

**W1a — dynamic-home arm (`d9e4906343`).** As planned: `bindingHoldsDynamic` (from-ast) is the arm test of the D1
join and the leaf of the claim's new check; `mayYieldCarrier` sits beside `producesCarrier` in
`src/ir/analysis/carrier-expression.ts` and shares its walk (one `yieldsCarrier` / `yieldedValues` traversal with an
`every` / `some` quantifier; the "some" side additionally passes through `&&` / `||` / `??` and type projections).

**W1b — carrier equality brand (`9e0d351a50`).** The probes found a second route to the same invariant:
`c ? n === 1 : 7` — the bounded grammar proves the arm `boolean` (it is), but `emitDynEq`'s result was a bare `i32`,
so `irTypeIsBoolean` failed and the invariant was thrown out of `compile()`. The lowering was the wrong side here:
`dyn.eq` now carries the boolean brand, as its siblings `dyn.instanceof` and the dyn own-property test already did.
The brand is erasable under `irTypeEquals` (boolean-brand.ts), so no join or verifier changes.

**How invariants surface on this lane.** An `IrInvariantError` from from-ast reaches `runIrProgramDriver`, which
rethrows it as `IrProgramDriverInvariantError` by design ("Exceptions stay fatal"); no catch was added. After W1 no
probe reaches one.

| Proof | Result |
| --- | --- |
| `tests/issue-7354-w-dynamic-home-conditional.test.ts` (6, node agreement + wrong twin; refusal by text) | 6/6 head, 6/6 fail on base |
| 101 own probes (dynamic-home arms of every bounded kind × literal arms, try/catch/finally, loops, NaN / −0, `String`/`Number` wrappers), strict entry, base → head | exception 28 → 0; right 12 → 38; wrong 0 → 0; no right→other |
| Ordinary pipeline, 20 test262 files (10 propertyHelper rows + 10 of `l20`) × default + standalone | byte-identical |
| Ordinary pipeline, the 101 probes × default + standalone | byte-identical |
| `check:prepared-bytes` | pass |
| 2949-s5-2 / s5-3 / slice2 / slice3b, 4523, 6921, 7354-t, 7354-d1 | only the `dyn.eq` result-type pin changed (updated); the other failures are identical on the base (slice U's pending expectations) |

The 41 rows now stop at `CE ir/from-ast: type override (dynamic) disagrees with annotation (f64) at param
functionLength of verifyCallableProperty` (W2).

### W2 — a JSDoc tag is a comment (`a612dbe004`, after merging slice U `56d405c3ca`)

**Cause.** The native lane's parameter contract (`sourceDynamicParameter`) types a parameter only by a syntactic
annotation, so a `@param {number}` parameter is dynamic. Three readers took the tag as an annotation anyway:
from-ast's `resolveIrType` (via `effectiveIr{Param,Return}TypeNode` → "type override (dynamic) disagrees with
annotation (f64)"), provenance `bindingCarries` (a JSDoc parameter is checker `number`, so it "did not carry"), and
the implicit-flow rule (the tag is the argument's or the return's contextual type).

**Fix.** The rule is stated once, on `sourceDynamicParameter`; each reader consults the contract it produces.
`annotationUnder` (`select-expression-structure.ts`, beside `effectiveIr*TypeNode`) lets a dynamic contract win over
a JSDoc node for parameters and results; #7106's `jsDocExternref` special case is an instance of it and is removed.
`sourceDynamicProvenance` takes the parameter contract as a callback. The flow rule's `storedIntoCarrier` became
`landsInCarrier`: also the un-annotated initializer of a carrier binding, an argument for a dynamic-contract
parameter, a value returned from a dynamic-result function. A syntactic annotation keeps its contract and its flow
check (tested). `from-ast.ts` net +0 for W2.

| Proof | Result |
| --- | --- |
| `tests/issue-7354-w2-jsdoc-is-a-comment.test.ts` (7: `@param` / `@returns` / `@type` local / `@type` script var, with string, undefined and object callers — node agreement + wrong twin; a TS annotation still types and still refuses a dynamic argument) | 7/7; the `@param` and `@returns` cases fail on W1 head |
| W test file after the U merge | 6/6 |
| 101 W1 probes, strict entry | unchanged vs W1 (0 exceptions, 0 wrong) |
| Ordinary pipeline: 20 test262 files + 7 JSDoc programs (incl. #7106's bracketed / `{object}` / `{*}` params) + 101 probes, × default + standalone | byte-identical to W1 head |
| 7106-s1d-jsdoc-logical, 7272 isWritable, 7135, 7354 d1 / h / t / u-abort / u-prelude / m-refusals / f2 / c2-this / str2c | all pass |
| typecheck, LOC + func budget (merge base and `LOC_GATE_BASE` = main `2b9f6f6e48`), coercion sites, oracle ratchet, dead exports, boundaries inventory, `check:prepared-bytes` | pass |

**Tally.** All 41 rows now stop at `CE ir/from-ast: identifier "Array" is not in scope in <module-init>`; the other 6
`propertyHelper` rows still stop at `function declaration 'formatIdentityFreeValue' read as a value is written`
(approximate driver: `assert.js` + `sta.js` + includes + body through the strict entry, standalone, with the runner's
`skipSemanticDiagnostics` / `deferTopLevelInit`; not the runner itself).

**Found, not fixed.**
- Ordinary pipeline, wrong value: `/** @param {number} x */ export function h(x) { return x + 1; }` compiled with
  `compile(src, { fileName: "test.js", allowJs: true })` (default target): `h("a")` called from JS returns `NaN`
  (a number); node returns `"a1"`. With `skipSemanticDiagnostics: true` (the test262 runner's setting) an internal
  `f("a")` of the same function also returns `NaN`, and `typeof f("a")` is `"number"`. Standalone: not verified (my
  harness could not instantiate the standalone binary).
- Prepared: a `@type {number}` script var whose every store is typed still gets the f64 home from the tag, so
  `/** @type {number} */ var t = "s";` (semantic diagnostics off) is refused by name
  (`module binding 't' initializer is string but its global is f64`). A dynamic store moves it to the dynamic home
  and gives node's value (tested).

**Fatal invariants.** Unchanged by design (`runIrProgramDriver` rethrows). I know of no invariant site the Prepared
lane still reaches by construction; the remaining #5092 sites fire only under the env-gated tamper seams.

**W3 candidate (measured, not started).** `propertyHelper.js`'s module-init reads, in order: L27 `Array.isArray`;
L28 `Object.defineProperty`; L29 `Object.getOwnPropertyDescriptor`; L30 `Object.getOwnPropertyNames`;
L31 `Function.prototype.call.bind(Array.prototype.join)`; L32 `…bind(Array.prototype.push)`;
L33 `…bind(Object.prototype.hasOwnProperty)`; L34 `…bind(Object.prototype.propertyIsEnumerable)`;
L35 `Math.pow(2, 32) - 1`. Globals: `Array`, `Object`, `Function`, `Math`. Members: `Array.isArray`,
`Array.prototype.{join,push}`, `Object.{defineProperty,getOwnPropertyDescriptor,getOwnPropertyNames}`,
`Object.prototype.{hasOwnProperty,propertyIsEnumerable}`, `Function.prototype.call.bind`, `Math.pow`.

**Not verified.** Node 25 (CI's version) is not installed here; everything ran on local Node 22 under tsx. The 41-row
tally is from my driver, not the test262 runner.

### W review round (after the review of `ee578f61ad`; U `02f31edc4c` merged)

- **Q1 — one binding predicate.** `namesDynamicValue`, `bindingHoldsDynamic` and the leaf inside
  `expressionProducesDynamic` are now one `bindingHoldsDynamic(node, cx)` (local / slot / module global in scope,
  `this`, the Prepared module home out of scope). One `dynamicLeaves(cx)` factory feeds both `producesCarrier` and
  the claim's `mayYieldCarrier`; the `new` and `instanceof` arms use the same predicate. `from-ast.ts` is back at
  its baseline (no growth). Answers that changed, all from abort to node's value (each checked against node, before
  and after): `"x" + n` and `n + "y"` / `n + 1` over an out-of-scope dynamic home in a function (was "'+' operands
  not provably both-number or string-concatenable"), and Str2-c's `var g; function w() { g = g + "x"; }` (moved from
  "still refuses" to a node-agreement test). Nothing that was right changed (101 probes; ordinary pipeline
  byte-identical).
- **(a)** `sourceFunctionCallee` (provenance) is the one callee resolution for `callCarries` and `landsInCarrier`.
  `syntacticAnnotation` (`select-expression-structure.ts`) is the one statement of "only a syntactic annotation
  types a declaration natively"; `annotationUnder`, `sourceDynamicParameter`, the native result contract and
  provenance's `localCarries` read it, and `landsInCarrier`'s own `parent.type` check is gone.
- **(b)** `annotationUnder` takes `IrType`.
- **Slice P test.** Its two "refuses a JSDoc …" cases (written against the old behaviour) now run and agree with
  node, with wrong twins.
- **Object-literal wrong value fixed** (`prepare-ordinary-object-access.ts`): a literal's property read was typed
  from the checker, so `var pre = f(1); var n = 42; function f(a){ var o = { p: n }; return String(typeof o.p); }`
  said `"number"` for `undefined` (node: `"undefined"`). The read plan now skips a property whose stored value may be
  the dynamic one (provenance `carries`, passed in by `program-source-units.ts`); the read stays the dynamic member
  read. Test added to the W file.

**Known limits (named refusals / aborts today, not wrong values).**
- A JSDoc'd function EXPRESSION's parameter (`/** @param {number} x */ var fe = function (x) {…}; fe(v)`) is not
  covered by the parameter contract: "a dynamic value flows into number without a conversion (CallExpression)".
  Needs the closure parameter contract, a different mechanism.
- A nested function declaration's parameters: "nested func params must be Identifier-named with annotations", a
  from-ast gap independent of JSDoc.
- `/** @type {number} */ var t = 1; t = x;` in a function aborts ("assignment to t …"), exactly as without the tag:
  from-ast types a local from its initializer. Not a JSDoc issue.
- `String(o.p === undefined)` over a dynamic read aborts: that strict-equality producer's result is an unbranded
  i32 ("String() of i32 operand is deferred").

## Slice U result (2026-11-22, branch `claude/7354-u` from `claude/7354-c2` 8bbebca651; C2 7debc3daf0, Perf5 204d6f575e, Perf6 4521fc831f merged)

Abort bodies: a function whose body the path cannot lower gets the run-time abort as its body instead of refusing the
whole program. Switched on only by `src/test262/test262-prepared-entry.ts`.

### Built (plan §5 steps)

- Step 1: the per-unit body producer moved out of `prepareIrProgramSources` into `src/ir/program-source-units.ts`
  (`lowerSourceUnit`). `checkerScalar` moved beside `checkerAny` in `source-dynamic-contracts.ts`. program-source.ts
  1835 → 1746 lines.
- Step 2: `src/ir/abort-bodies.ts`, one module.
  - `ordinaryOwner`, the one owner rule: the innermost function expression or script-level function declaration
    that is neither async nor a generator.
  - `ownRefusal` / `owningRefusals` tag a named refusal with its owner, innermost first. Anything but an
    `IrUnsupportedError` passes through.
  - `abortBody(builder, closureSubtype?)` is the one builder.
  - `AbortBodies` is the policy and its record. Its `lower` is the retry: on an owned refusal it records the owner,
    truncates the allocation registry, and lowers the unit again. A refusal no function owns, or whose owner already
    has the abort body (a signature refusal), stays the program's.
  - `AllocSiteRegistry.truncate`.
- Steps 3–4: `lowerFunctionAstToIr` and `liftClosureBody` each ask `resolver.abortedBody(fn)` once their parameters
  exist, and return the abort body instead of the statements. The closure lift site tags its refusals
  (`owningRefusals`). from-ast is net 0 lines: the two copies of the closure's `finish` metadata became one
  `closureSubtype`, and two comments were merged.
- Step 5: `legalize(roots, functions, owners)`. A gap is the refusal of the function it was met in. The flow rule tags
  the innermost function around the expression and skips functions that have the abort body.
- Step 6: `requiredPreparedAbortBodies(result)`: rows of unit, Wasm name, line, column, code and detail, in source
  order. It is exported from the compiler bundle and the worker requires it.
  - The worker writes the rows into every row's metadata (`abort_bodies` in the JSONL).
  - `renderHostError(err, rows)` renders a trap whose top frame is a listed function as
    `aborted in unlowerable unit <name>: <detail> [in …]`.
- Step 7: `runPreparedIrPipelinePresentation(input, unlowerableBodies?)` → preparation input `unlowerableBodies` →
  `SourceUnitLowering.abortBodies`. The entry passes `new AbortBodies()`. Its `compile` has a test seam,
  `unlowerableBodies: "abort" | "refuse"`. It is kept on purpose: it mirrors the existing `elide` seam (a positional,
  test-only default), it is the only door to the policy-off position, and `compileMulti` has neither seam because no
  test needs one there.
- Abort-table names are Wasm function names. For an anonymous closure (`<module-init>__closure_10`) the name depends
  on the closures lowered before it, so the same harness closure can have a different name in different rows. Only
  the message text is affected; the trap is still joined to its row within one compile.
- (Review follow-up) The test262 compiler-pool worker (`scripts/compiler-pool.ts`, the one place its env is built)
  sets `JS2WASM_VALIDATE_PREPARED=0`. The worker measures the compiler as shipped. vitest.config.ts turns the
  Prepared self-checks on for its own processes, and the worker inherited that, which tripled a prelude compile
  against the 30 s row limit. The self-checks stay on for every vitest test; there is no escape hatch, because the
  runner honours no such switch.

### Differs from the plan

- The module is `src/ir/abort-bodies.ts`, not `src/ir/program/`. Its users (from-ast, the producer, the source
  legalization) sit in `src/ir/`.
- The table returns through the policy object (`AbortBodies.rows()`), not through `IrProgramSourcePreparation`. The
  source preparation is captured into the sealed `PreparedIrProgram`, and the AST-owned record has no place there.
- The abort body is the `unreachable` terminator alone (U-D6's alternative). `js.value.unsupported` is pure, so an
  unused result is dead code. The trap's top frame is the function itself, which the table names.
- There is no wrapper at `liftNestedFunction`. An unannotated nested declaration refuses in the enclosing function's
  context (plan §4: the enclosing function aborts), and no JS source reaches that lift.
- The abort check lives inside the two lift functions, after the parameters, so the abort body reuses their
  parameter construction. That is one line each, and the call site changes one call.

### Tests

| file | tests | exit |
|---|---|---|
| issue-7354-u-abort-bodies (new) | 40 | 0 |
| issue-7354-u-prelude (new; the real prelude, 3 compiles) | 3 | 0 |
| scripts/test262-prepared-trap-verdict.test.mjs (+1) | 14 | 0 |
| scripts/test262-compiler-path.test.mjs (capability list +1) | 23 | 0 |
| every other issue-7354-* file, each alone (42) | all | 0 |
| es5-assignment/compound, 7106, 7188, 7361, 7363, 7364 ×2, 7380 ×2, test262-prepared-entry/runtime | all | 0 |

Changed expectations, and why. Every one of these files goes through the test262 entry, where the policy is on.
- A refusal inside a function that the test only names is now probed without abort bodies. These use the shared
  `refusal()` and the local helpers of D1, Fa, F0, H, H2, O, P, S, Str, Str2c, T, Ty, X, 7363, 7364 and es5-assignment.
- Where the point is what the program does, the expectation is now the abort body: C2 this, C2 constructors, F2 ×2,
  F1b, M1 premise, Str2 multi-file, Ty multi-file.
- Stale rows that are red on the C2 base too were removed, each with a comment: H ×2 and T ×1 (lowered since F1b);
  7363 ×1 (C2 refuses the receiverless call first).

### Proof

- Sweep (§7; `.tmp/gen-sweep.mjs`): 3 refusal classes (from-ast, legalization gap, flow) × 5 forms × 10 uses ×
  sloppy/strict = 384 programs, run with the policy on.
  - Results: 84 node answers, 84 wrong twins thrown, 138 aborts where node enters the function, 78 refused.
  - The 78 refusals are all top-level shapes of the harness itself, such as `w()(1)` and `new (expr)`.
  - 0 wrong answers, 0 aborts where node does not enter the function, 0 invalid Wasm, 0 exceptions.
- Flow rule (TypeScript): inside a function it aborts; at top level it refuses with the same text; the rule skips an
  aborted closure.
- Regression, policy off vs the C2 base 7debc3daf0: 267 programs (half the sweep, plus 75 proving and probe
  programs). Results and bytes are identical. With the policy on, every program the base compiled is byte-identical.
- `check:prepared-bytes` (804 rows) vs 7debc3daf0: 756 identical, 48 differ.
  - 46 went from a refusal to compiling with an abort at the entry of the aborted function, which node's run enters.
  - 1 (585) went from a refusal to returning node's answer.
  - 1 (203) refuses later, by its physical-gap name.
  - All 48 were run (`.tmp/pbcheck.mts`).
- Ordinary pipeline: 20 test262 files × (default, standalone) produce identical bytes.
- Mutations, killed:
  - the flow rule's skip of aborted functions;
  - the innermost-first owner (killed by the new closure-in-a-function-expression probe).
- Mutations that survive:
  - the registry truncation: the leftover sites are inert in every probe;
  - The native-family / Promise-delay exclusion was not exercised.
- Removed as implied by another check: the module-init exclusion, because a module-init has no declaration.
- Removed in review as unreachable: the async/generator exclusion of the owner rule. Such a declaration refuses in
  signature planning, and such an expression refuses in its enclosing function. Without it, all 384 sweep programs
  give the same outcomes and tables. The slice that lowers generators adds the rule, with a program.

### Sample (411 rows, real runner, at the runner's DEFAULT settings: 512 MB worker, 30 s per row, after Perf6)

| | pass | fail | compile_error |
|---|---:|---:|---:|
| before U (C2) | 14 | 0 | 397 |
| U + Perf6 | **31** (14 negatives + **17 positives**) | 4 | 376 |

- Positive passes: asi S7.9_A6.1_T10, S7.9_A10_T7; assignment/white-space; compound-assignment/srshift-whitespace;
  identifiers/start-dollar-sign; harness/assert-notsamevalue-notsame; variable/S12.2_A4; try/S12.14_A11_T2;
  function-code/10.4.3-1-31gs, S10.2.1_A5.1_T1, 10.4.3-1-10-s; literals/numeric S7.8.3_A3.4_T1, A4.2_T5, A3.3_T7;
  literals/string S7.8.4_A4.2_T4; types/reference/8.7.2-8-s; white-space/between-space.
- Each was read. 15 carry the prelude's two abort bodies, compareArray (`b[i]`) and compareArray.format (`Array`).
  None names compareArray and none includes a harness file (K1 by reading; the node-entry script was not built).
- All 17 have a mutated twin: the last checked value changed, or for the two asi rows a computed flip. All 17 twins
  FAIL through the same runner.
- The 4 fails are `aborted in unlowerable unit …`: `arguments` ×3, and an assignment to an undeclared identifier.
- Top compile errors:

  | rows | first refusal |
  |---:|---|
  | 73 | `formatIdentityFreeValue … is written` |
  | 41 | isWritable invariant (below) |
  | 36 | `Object.defineProperty` |
  | 22 | module-init nested var |
  | 17 | `Object` |

- Before Perf6, at default settings, the 22 compiling rows died with OOM (SIGABRT, 512 MB). At measurement settings
  (3072 MB, 300 s — not CI's) they gave the same 17 passes. The runner compile then took 48–87 s; after Perf6 it is
  20–27 s and fits 512 MB.
- With the worker's self-checks off (review follow-up, at 131f7bd4c1, default settings), the 17 positive rows still
  pass: 17/17. Compile time per row is 5.9–8.1 s, median 6.9 s, against the 30 s limit.
- CI's IR job sets `TEST262_WORKER_MAX_OLD_SPACE_SIZE=1024` (`test262-sharded.yml`). The row limit is 30 s, hard-coded
  in tests/test262-shared.ts. A tsx prelude compile on the pre-Perf6 head OOMed at 1024 MB and passed at 1536 MB.

### Found, not fixed (own slice)

- `ir/from-ast: #5092 then arm proved number but lowered as dynamic in isWritable` (propertyHelper.js) is an
  `IrInvariantError`.
  - Through `compile()` it is an exception: `IrProgramDriverInvariantError` from `ir-program-driver.ts:25`.
    Repro: test262/harness/propertyHelper.js alone with the runner's options.
  - In the runner it becomes a compile_error row (41 rows).
  - Without the policy, an earlier unit (verifyProperty) refuses first.
  - No minimal program was found in 15 minutes.

### Not verified

- Node 25 (not installed).
- The K1 node-entry script: entry was checked by reading the 17 rows.
- The policy-gate and U0 mutations were not re-run.
- The full sweep with the policy off: half of it was run.
- The 3518/3526 pin suites.

## Slice X plan — an unread thrown value never matches (2026-11-22, branch `claude/7354-x` from `main` a12f6a4a13)

Not the earlier "T and X" slice (dynamic throw); this one is the runner's runtime-negative verdict.

### Confirmed (real runner, Prepared lane, 35 probe rows next to `language/statements/throw/`)

- The artifact exports `__module_init` only. Every thrown value reaches the worker as the label
  `TypeError (null/undefined access)`, and `originalHarnessExceptionMatches` substring-matches the expected type
  against it. Expected `TypeError`: `throw 1`, `throw new Test262Error("x")`, `o.p` on null → **pass**. Expected
  `Test262Error` with `throw new Test262Error("x")` → fail. `new TypeError/RangeError/…` → compile_error (unknown
  class). An abort body is a trap and fails (U0).
- ES5 runtime negatives in all of test262: 16 (12 Test262Error, 3 EvalError, 1 SyntaxError), no TypeError, so no
  ES5 row can be inflated by this label. Whole corpus: 40, of them 4 TypeError (all module-code).

### Every arm that turns an unread value into a pass

1. Worker `extractWasmExceptionMessage` returns the label for a `WebAssembly.Exception` whose payload is not read:
   (i) the instance exports no tag (Prepared: always), (ii) `getArg` throws, (iii) the payload is `null`. (iii) is
   the ordinary codegen's null-payload throw (array null guard #441, TDZ — the latter is a ReferenceError) and also
   a user `throw null`; the label guesses TypeError for all of them. All lanes.
2. `safeStringifyThrown`'s fallback labels (`uncaught Wasm-GC exception (non-stringifiable payload)`) are matched
   by substring too; they carry no type name today, so this is the same hole without a victim yet.
3. `tests/test262-shared.ts:1217` (fixture lane) is a second copy of the rule:
   `extractWasmExceptionMessage(…).includes(type)` with the runner's own reader, which has the same label.
4. Out of scope, reported: `!originalHarness` accepts any throw (no production job sends it; every
   `test262-shared.ts` job sets `originalHarness: true`); a READ value whose text contains the type
   (`throw new Test262Error("TypeError")` rendered natively) still passes by substring; trap frame names on the
   other lanes (#7447).

### (a) Runner soundness — one rule, one place

- The readers (worker, runner) answer `undefined` when they could not read the value; the label is applied by the
  caller for the error text only. `safeStringifyThrown` splits the same way (`stringifyThrown` → `undefined`).
- `scripts/test262-runtime-verdict.mjs` owns the rule: an unread value matches no expected type. The worker's
  two throw arms and the fixture lane (`test262-shared.ts`, which today has its own `.includes`) call it.
- Error text of an unread value says what was not read (`unknown thrown value: the module exports no exception
  tag` / `… payload is null`), except that the ordinary lane keeps its null-payload text unless the lead prefers
  the rename (it is the bucket label of many positive-test failures).
- Oracle: (iii) can flip ordinary rows that pass by the null label. The standalone baseline has 2 TypeError
  runtime negatives passing (`module-code/eval-rqstd-abrupt.js`, `top-level-await/module-import-rejection.js`);
  I run them (and the 2 failing ones) on the ordinary standalone and gc lanes before/after. A flip → ORACLE_VERSION
  bump with history; none → `oracle-version-exempt:` with that evidence.

### (b) Compiler — large, proposed as its own slice after (a)

- Exporting the tag is one line (`defineExport(…, "__exn_tag", exceptionTag)` after `publishPhysicalExports`),
  measured: then only i31 numbers (`throw 1` → `1`) and `null` are host-readable. `1.5`, strings, `undefined`, the
  realm's TypeError (`$Error_struct`, name field) and a C2 `Test262Error` (an ordinary object; no `name`, its
  constructor is the user function) are opaque GC refs, so the reader still learns no name.
- The reader needs an in-module export, planned as a physical resource before the freeze: for `$Error_struct` the
  `name` field, for an ordinary object `[[Get]] constructor` → the function's name, plus a native string char
  read (the `__exn_render_prepare/char` convention, which `tryNativeExnRender` already reads). With that, a
  `Test262Error` (ordinary object, constructor `Test262Error`) and a realm `TypeError` (`$Error_struct`) are told
  apart by kind, not by text. Every Prepared artifact changes bytes; the 4 compile-error rows above need the
  built-in error classes, which the path does not have.

Lead decision: (a) alone now, plus item 2 (match the read KIND, never the message); (b) is slice X2 below.

## Slice X result (2026-11-22, branch `claude/7354-x`; (a) = `fb4619b92f` + the oracle note)

### Built

- **One rule**, `originalHarnessExceptionMatches` in `scripts/test262-runtime-verdict.mjs`: a runtime negative
  passes only when the expected type is one of the KINDS the lane's reader read — the thrown value's `name` or its
  constructor's name. Message text never counts, and a value the reader could not read has no kind, so the label
  written for it cannot match by construction.
- **One reader** (review r1): `readThrownValue` in `scripts/lib/wasm-exn-render.mjs` returns `{ kinds, text }` for
  every test262 lane. The worker passes its row context (linked peers, abort table, observation); the runner's
  `extractWasmExceptionMessage`, the fixture lane and the local runner call it directly. The worker's, runner's and
  harness's own readers are deleted; `renderHarnessThrownText` stays as `Name: message` display text (npm-compat, dogfood, the local compile-crash detail); `exceptionPayload` stays exported for the octane worker.
  - No kind: no tag export (every Prepared artifact), a payload the tag does not carry, no instance, a null
    payload (the ordinary null-guard/TDZ throw or `throw null`), a primitive, a function (`throw TypeError`).
  - For a host-opaque WasmGC payload the kind is the module's own `String(payload)` (`__exn_render_*`) up to the
    first `": "` (whole text when none): message text of an opaque payload still counts on the ordinary lanes
    until X2 / #7453 gives them a kind export.
- The rule takes the reading (`runtimeNegativeThrowAccepted(err, thrown, …)`), so a lane reads once. Callers: the
  worker's instantiate and `__module_init` arms, the fixture lane (its `.includes` copy is gone), the local runner
  (its `originalNegativeMatches` copy is gone; its compile-failure arm now uses `negativeCompileErrorMatches`, the
  worker's compile-phase rule — the r0 branch still called the deleted function there and threw).
- A trap's text is the reader's (`renderHostError`, frame names) on every lane; the local runner no longer hands
  the rule its source-annotated detail.
- Unread text names what was not read: `unknown thrown value: the module exports no exception tag` / `… the
  module's exception tag does not carry it`. The null-payload text `TypeError (null/undefined access)` is unchanged.

### Real runner, before (`main` a12f6a4a13) → after; 40 probe rows + the 40 runtime negatives of test262 per lane

Probes are next to `language/statements/throw/` (deleted after the runs). Matrix: expected {TypeError,
Test262Error, ReferenceError, SyntaxError, RangeError} × thrown {matching `new X`, a different error, `throw 1`,
`new Test262Error`, nothing, an abort body (`arguments.length`), `null.p`}.

| lane | before pass | after pass | flips |
|---|---:|---:|---|
| Prepared (IR) | 6 | 0 | 6 probes → fail (below) |
| ordinary standalone | 45 | 42 | 3 probes → fail |
| ordinary gc (honest) | 45 | 42 | 3 probes → fail |

- Prepared, removed false passes (expected TypeError): `throw 1`, `throw new Test262Error("x")`, `null.p`,
  `throw "TypeError: x"`, `throw new Test262Error("TypeError")`, `throw {toString(){return "TypeError: x"}}`.
  All now fail as `unknown thrown value: the module exports no exception tag`. No Prepared row passes; the abort
  body fails as the abort, `new TypeError/RangeError/…/Error` is a compile_error (unknown class), nothing thrown
  fails `expected runtime … but succeeded`.
- Ordinary standalone and gc, removed false passes (expected TypeError, matched by message): `new Error("TypeError:
  x")` → `Error`, `new RangeError("not a TypeError")` → `RangeError`, `new Test262Error("TypeError")` →
  `Test262Error`. A real `new TypeError` and `null.p` still pass. Every other matrix cell keeps its verdict;
  `*-matching` passes for all five types.
- **Residual, on BOTH ordinary lanes** (not standalone only: the JS-environment lane runs the same native core and
  exports the same `__exn_render_*`): `throw "TypeError: x"` and an object whose `toString` returns
  `"TypeError: x"` still pass, because the module's rendering is the only reader. Needs the kind export.
- **The 40 runtime negatives of test262: 0 flips on all three lanes.** Standalone 33 pass before and after (incl.
  all 12 ES5 Test262Error rows); gc 31 → 31; Prepared 0 → 0 (7 compile and throw `new Test262Error`: the 7
  `language/line-terminators/comment-*` rows; they fail, unread, before and after).

### Positive tests and the sample

- Positive rows cannot flip by construction (only the runtime-negative verdict reads kinds). Status diff, ordinary
  standalone: the first 70 rows of `mw-01` 70 pass → 70 pass; the 5 baseline rows bucketed `TypeError
  (null/undefined access)` fail → fail. Their text: 1 unchanged (null payload), 4 now `unknown thrown value: the
  module's exception tag does not carry it` (a payload from another module's tag, e.g. the eval provider).
- 411-row ES5 sample, Prepared lane, default settings, base and head each run: 31 pass / 4 fail / 376
  compile_error on both; 0 rows changed.

### ES5 runtime negatives

16 in test262 (12 Test262Error, 3 EvalError, 1 SyntaxError; no TypeError, so no published ES5 number was inflated
by the label). On the Prepared lane 9 are compile errors (html-comment parsing, eval) and 7 throw
`new Test262Error()` and fail as unread; X2 lets those 7 pass.

### Gates and tests

- `node --test scripts/test262-prepared-trap-verdict.test.mjs`: 20/20 (6 new: unread × 5 types × 4 unread forms
  never pass; kind match passes; message, string, primitive never; a trap only by the non-Prepared frame rule).
- `scripts/lib/native-eval-boundary-observation.test.mjs`: the new worker-reader kind test passes; the other 11
  fail identically on `main` here (`frozen source digest must actually admit the controls`), so they say nothing
  about this change.
- Oracle (lead decision after review r1): ORACLE_VERSION 16 → 17 with a history entry; no exemption.

### Review r1 re-run (head `6319f2dc8c` vs `main` a36d229d89 after slice T; same 40 probes + 40 corpus rows)

| lane | probes+corpus pass before → after | corpus (40) pass | flips |
|---|---|---|---|
| Prepared (IR) | 6 → 0 | 0 → 0 | the same 6 probes |
| ordinary standalone (honest) | 45 → 42 | 33 → 33 | the same 3 message probes |
| ordinary gc (honest) | 45 → 42 | 33 → 33 | the same 3 message probes |
| ordinary gc (`TEST262_ORACLE_MODE=linked`, CI's host mode) | 44 → 41 | 33 → 33 | the same 3 message probes |

- No corpus row changes verdict on any lane, including the linked mode.
- Residual rows: `throw "TypeError: x"` passes on all three ordinary runs. The custom-`toString` object passes on
  standalone and gc honest, and fails on gc linked, both before and after.
- `runTest262File` (tsx) on `language/statements/break/S12.8_A1_T1.js` (a compile-failure row that threw before),
  `line-terminators/comment-single-lf.js` and `const/global-use-before-initialization-in-prior-statement.js`, gc and
  standalone: all 6 pass. `tests/issue-3613-render-parity.test.ts` 7/7, `tests/issue-3003.test.ts` 10/10,
  `scripts/test262-prepared-trap-verdict.test.mjs` 22/22 (+ a thrown constructor never matches).
- `scripts/lib/native-eval-boundary-observation.test.mjs`: its pinned source digest no longer admits this
  checkout's harness on `main` (11 tests fail there identically). With the current digest admitted for one local
  run (not committed), the 10 reader tests pass; `sendResult snapshots…` fails on `realmCanarySnapshot is not
  defined`, also on `main`.

### Left as they are (recorded)

- `!originalHarness` accepts any throw; no production job sends it.
- A trap on the non-Prepared lanes still matches by frame names in its text (#7447).
- The residual above: message text of an opaque payload still counts on the ordinary lanes until X2 (#7453).
- `scripts/wasm-exec-worker.mjs` (the local `tests/test262-vitest.test.ts` lane) accepts any throw on a runtime
  negative and has its own reader copy (`extractWasmExceptionInfo`). Routing it needs the expected type plumbed
  through `ExecPool.run` and its own before/after measurement; not done.
- Node 25 is not installed here.

## Slice X2 plan (not started) — the Prepared artifact names what it threw

- Export the exception tag as `__exn_tag` (one `defineExport` after `publishPhysicalExports` in
  `materializePhysicalProgram`, `src/ir/program-consumer.ts`), the ordinary lane's convention.
- Add an in-module kind reader, reserved as a physical resource before the freeze (and counted as a support
  function, so the "unowned function" receipt check holds):
  - `$Error_struct` (the realm's TypeError, `createErrorStructType`) → its `name` field;
  - an ordinary object → `[[Get]] constructor` → the function's name (a C2 `Test262Error` has no own `name`);
  - anything else → no kind;
  - the name string read out through the `__exn_render_prepare`/`__exn_render_char` convention, which the
    worker's `tryNativeExnRender` already reads — or, better, a dedicated kind export so the runner no longer
    splits rendered text.
- Every Prepared artifact's bytes change (`check:prepared-bytes`: every row differs by the export; run a sample at
  base and head to show the same outcomes). The 7 ES5 line-terminator rows should then pass.

## Slice O1 result (2026-11-22, branch `claude/7354-o1` from `claude/7354-u` 02f31edc4c)

`Object.defineProperty`, `Object.defineProperties`, `Object.create`, `Object.getOwnPropertyDescriptor` on the Prepared
path: the call form on the unshadowed global, served by the realm's descriptor pack.

### Built

- **bag** (own commit 25b71efc3d): the kernel's `bag` answers an ordinary object with itself, so every own-property
  role is total over a program's objects; the set adapter's `match ? bag : self` became `bag`.
- **Catalog**: `implementation: "native"` for the four ids (`NATIVE_OBJECT_STATICS`, the one list);
  `builtin-prototype-keys.ts` (the IR's catalog reader) answers `nativeObjectStatic(name)`.
- **Realm** (`js.object` family, served on demand): `descriptor-define(o, key, attributes)`,
  `descriptors-define(o, properties)`, `own-descriptor(o, key)`, and a row for the declared `create-null`. Bodies:
  `descriptor-record-bodies.ts` (ToPropertyDescriptor, one helper function; DefinePropertyOrThrow over the kernel's
  define roles; FromPropertyDescriptor) and `object-static-bodies.ts` (ObjectDefineProperties reads and converts
  every descriptor, in own-key order, into an argument vector before the first define). Helpers (ToPropertyDescriptor,
  ToBoolean = `buildToBooleanBody` on the realm's types) and the descriptor literals are reserved only for a program
  that calls such a contract (`native-source-objects.ts` `HELPERS`, `nativeSourceObjectLiterals`).
- **set**: a setter-less accessor answers false (strict: TypeError, sloppy: ignored); a setter call stays the trap
  (O2). **Strict PutValue** on an object answering false throws `Cannot assign to read only property 'k' of object`:
  one `putValue` arm parameterised by the kind, shared with F1b's function arm.
- **Source**: `src/ir/realm-static-call.ts` recognises `Object.m(...)` (unshadowed global, `m` native, closures are
  function objects); arguments are carriers in source order (`dynamicStoreOperand`), padded with `undefined` to the
  catalog's `length`, extras evaluated and dropped; one front-end helper call. `program/dynamic-object-statics.ts`
  expands it in the legalization: the target's kind (a primitive → TypeError, the realm's error → abort), then
  ToPropertyKey through the program's own `stringOf` (a key's `toString` runs through F2), Properties' ToObject
  (undefined/null → TypeError, number/Boolean → nothing, string → abort), then the realm contract; `Object.create`
  links an ordinary object (`create-with-prototype`) or null (`create-null`), a function or error prototype → abort.
  An abort arm calls the shared abort builder directly: `isSideEffecting` (`src/ir/analysis/effects.ts`) now keeps
  `js.value.unsupported` alive, so dead-code removal never drops an abort whose result is unused (an unused
  `Object.create(F);` ran on before). The intrinsic's effect facet stays pure, as its certification requires.
- "Is this the global `Object`" is one predicate, `pristineBuiltinGlobal` (`src/ir/builtin-global-binding.ts`): the
  checker's symbol is lib-declared only, no source binds the name at any level (the checker resolves a script's
  top-level `function Object(){}` reference to the lib symbol), and no source assigns it. The call arm and the flow
  exemption use it; each shadowing form refuses by name (tests).
- The flow rule (`source-dynamic-contracts.ts`) takes a native static's arguments and its literal descriptors'
  fields as carriers (the lib's `PropertyDescriptor` types do not apply); `programObjects` admits the object kind for
  a program whose objects come only from such a call.
- `prepare-object-create.ts` (the bounded whole-source `Object.create(null)` plan) is kept and still comes first: the
  #3518 fixtures (`issue-3518-object-create-null-source-admission`, the no-source realm of
  `issue-3518-native-object-realm-declarations`) compile typed TypeScript through it on this same lane. **Cleanup for
  the lead to file**: one route (the static arm also for a typed `const`), then delete the plan and its three from-ast
  sites (see "Found, not fixed").
- from-ast 17361 = base (the host is function-object-lowering's; `objectStaticPlanOf` inlined at its one caller);
  program-source.ts unchanged.

### Differs from the plan (agreed with the lead before building)

- No B-D1 `(this, a0…)` realm function and no value-form `algorithm` wrapper: ToPropertyKey needs the program's
  Number::toString and ToPrimitive (source closures), which only the source side has, and the specification puts the
  target's check before it. Slice V1 (built-ins as values) adds the wrapper and `this` with a program that reaches them.
- Contract names avoid the `js.object.define-` / `create-` prefixes the access/result requirements classify.
- Body-level tests are source programs (no forged kernel harness, #7380).

### Tests (each file alone, `VITEST_MAX_FORKS=1`, heap 2048)

| file | tests | exit |
|---|---:|---:|
| issue-7354-o1-define-property (new, programs 1–11) | 13 | 0 |
| issue-7354-o1-create-and-define-properties (new, 12–19, aborts, refusals) | 18 | 0 |
| issue-7354-m-refusals (G45 now `Object.freeze`) | 44 | 0 |
| issue-7354-s-script-var-define-target (calls run against node) | 12 | 0 |
| issue-7354-h-script-var-dynamic-home (two rows removed) | 59 | 0 |
| issue-7354-u-prelude (runner options moved to the helper) | 3 | 0 |
| issue-3518-ordinary-object-callable-contracts + native-realm-requirements | 80 | 0 |
| issue-3518-native-object-realm-declarations (four tests retired, count pin deleted) | 21 | 0 |
| r-provider-census 117; test262-prepared-entry + 7188 50; c2-this 18; o3 + f1b-writes 16; u-abort-bodies 40; native-builtin-functions 36 | | 0 |
| o4-member-read 16; x-dynamic-throw 59; f2-calls-through-values 10; c2-constructors 20; m-sweep-1/2/3/4 7/7/6/6 | | 0 |

**Retired (lead decision, own commit):** the realm-declarations file's four "executes actual source slots" tests
(displaced × decoded) failed identically at the base 02f31edc4c and on main: the fixture (`tests/helpers/native-object-realm.ts` `publicRealmSourceRuntime`) lowers `STATE_SOURCE`'s
bodies by hand with a resolver that knows only unit calls, and since F1b each closure literal on this lane is a
function object, so `makeCaptured` / `makeEmpty` now hold `string.const "captured"` and a `js.object.init-function`
call, which that resolver cannot lower (`string.const runtime is unavailable`). The compiler's behaviour is the right
one; the fixture predates function objects, and #7380 retires such hand-built harnesses. Per retired test, the same
facts through a real compile: closures returned from a factory and called through values with their own captures
(13 → 20, 100 → 107), a capture-free closure (3 → 10), distinct identities and a module without imports — the new
"retired #3518 fixture" tests in `issue-7354-o1-define-property.test.ts` (the source is STATE_SOURCE as a script; the
four were one test over displaced/decoded, transport details of the hand-built module); function objects of returned
closures — `issue-7354-f1b-function-objects`; closures as constructors and their prototypes —
`issue-7354-c2-constructors`. `publicRealmSourceRuntime` and its now-unused imports are deleted from
`tests/helpers/native-object-realm.ts`. The bare count pin `unavailable` = 42 (which this slice had moved to 38) is
deleted, not updated (#7380); the catalog's native rows are asserted by identity in
`issue-3518-native-realm-requirements` (the ids that are not `unavailable`, now including the four statics).

### Proof

- **Sweep (program 20)**: 13 existing kinds (absent; data with writable × enumerable × configurable; accessor with
  enumerable × configurable) × 216 descriptors (every subset of the six fields, each flag true/false, `value: 2`,
  fresh getter/setter) = 2,808 cases, expected values from node: **2,808 right, 0 refused, 0 abort, 0 wrong**. A batch
  with mutated expectations fails 12/12. The non-extensible column is not expressible on this path yet (no
  `Object.preventExtensions`, slice O3).
- **Regression**: the 804 proving programs (`check:prepared-bytes`) base vs head: 790 identical bytes; 14 differ —
  12 realm programs (the bag/set kernel bytes; each run at base and head: same outcome) and rows 47 / 48 (refusal →
  node's answer: a define that returns, a TypeError on a number). Policy off (`refuse`): 13 differ, the same realm rows
  and 47 / 48. Every O1 program refuses at the base (`Object.defineProperty is not an admitted Object static`).
- **Ordinary pipeline**: 20 test262 files (defineProperty, getOwnPropertyDescriptor, create, defineProperties and six
  language rows) × default + standalone: 40/40 identical.
- **Mutations** (each alone, probe run): killed — the mixed accessor/data TypeError, IsCallable of get/set, the
  descriptor's object test, ToBoolean of a flag, the enumerable filter of defineProperties, `create`'s undefined
  map, the served-kind test, the abort's pin, set's setter-less false, strict PutValue on an object, the flow-rule
  exemption, the static call admitting the object kind, the ordinary bag arm. The first three survived the first
  round (the pack throws the same TypeError at define time); the new rows of programs 5 and 12 kill them.
- **Compile time** (tsx, validator off, load 2–4): prelude + `assert(true);` base 7.6 / 8.3 / 8.6 s, head
  6.4–7.6 s; prelude + a defineProperty/GOPD test 6.8 s; a realm program with one object 0.8–1.2 s, with all four
  statics 1.1–1.4 s.

### Sample (411 rows, real runner, default settings)

| | pass | fail | compile_error |
|---|---:|---:|---:|
| U + W | 31 | 4 | 376 |
| O1 | **34** | 6 | 371 |
| O1c + receiver predicate | 34 | 6 | 371 |

- O1c run: every chunk's row count equals the base's (87 / 107 / 102 / 115); no row changed outcome. The 8 `intl402`
  rows of the 419-path list are dropped by path-filter discovery at base and head alike. A twin run had realized
  part of the local `test262/` link farm into real directories of symlinks, which discovery does not descend (107
  rows became 5); the farm is restored to plain symlinks.

- New passes: `built-ins/Object/create/15.2.3.5-4-152.js`, `language/expressions/object/11.1.5_5-4-1.js`,
  `language/types/reference/8.7.2-6-s.js`. Each has a mutated twin (last assertion's expected value changed) that
  FAILS through the same runner. No row that passed or failed at the base changed.
- New fails: `Object/create/15.2.3.5-4-161.js`, `-233.js`: the run-time abort at a getter (slice O2).
- The 36 `Object.defineProperty` rows now stop at: own-property test on a script var (`hasOwnProperty`, P1) 20,
  `Object` not in scope (another static) 8, `TypeError` 7, `Date` 4, `Array` 2, others 1 each.
- Top compile errors: `formatIdentityFreeValue … is written` 73, isWritable invariant 41, module-init nested var 22,
  own-property test 21, `TypeError` not in scope 16.

### Found, not fixed

- **Compile time grows superlinearly with the number of functions in one program** (tsx, strict Prepared entry,
  runner options, validator off; generator `.tmp/sweep.mts` on the branch's worktree, not committed). Program shape: a
  prelude of 5 function declarations (`t(f)` with a try/catch around `f()`, `fields(d)` reading six members and
  concatenating, three trivial `G`/`H`/`S`), then per case: one declaration `cI(o)` holding 0–1
  `Object.defineProperty`, one top-level `var oI = {}`, a call `cI(oI)`, a function expression passed to `t`
  (closure calling `Object.defineProperty(oI, 'p', {…})` with 1–6 descriptor fields, some reading `H` / `S` as values),
  a call `fields(Object.getOwnPropertyDescriptor(oI, 'p'))`, a string `===` and a `throw`. Per case: 1 declaration,
  1 closure, 4–5 calls, 2 object literals.
  - 12 cases: 17 declarations + 12 closures = 29 functions, ~60 calls: **4.2–6.0 s** per compile (234 runs).
  - 72 cases: 77 declarations + 72 closures = 149 functions, ~350 calls: **> 500 s** (killed at the 530 s limit; ×5
    the functions, ×100 the time).
- **Behaviour change (fixed here): an unused member read that aborts now stops the program.** The shared abort could
  be dropped as dead code when its result was unused (`function F(){} Object.create(F);` ran to its end). The root
  fix in `isSideEffecting` also reaches `o.toString;` on a receiver whose read is the abort: it now stops the program,
  where it silently went on before. That is the right direction (the read was never right). Changed outcomes: none
  found — the 804 prepared-bytes rows are byte-identical across the fix, and every suite listed above passes.
- **O1c, fixed: the statics on a function-local object.** A function-local `var o = {}` is a raw externref (#7128
  open-carrier local), and `concreteIntoDynamic` (behind `dynamicStoreOperand`) did not box one, so each static
  refused (`… operand of externref has no dynamic carrier`) and, under the abort-body policy, its function aborted.
  Where closures are function objects, `concreteIntoDynamic` now boxes a raw externref; the legalization proves its
  kind from its definition (`carrierKindOf`: the realm's `create-default` call) and refuses one it cannot. It is the
  one operand route for member-store values, construct and call arguments, returns and the statics.
  `lowerCarrierOperand` is not that route: from-ast-local, demotes instead of refusing by name, boxes no closure as a
  function value, and serves the #7338 ordinary lane, whose output must not change. Tests: the four statics on a
  function-local object, a parameter, a call's result (literal and local), in a constructor; each agrees with node
  and a wrong answer throws. 400 of the 2,808 sweep cases placed inside a function on a local object: 400 right (a
  mutated 24-case run: 24 wrong).
  - **Still aborting: a closure over such an object.** It reads the object from its capture, which has no
    defining `create-default` call, so the legalization refuses the box (`box of a non-primitive value`) and the
    closure's body is the abort. It needs the captured object to travel as a dynamic value (a dynamic home for a
    captured open-carrier local), not a wider `carrierKindOf`.
- **Fixed: `function Object(){} Object.is(1, 1)` answered `true`.** The #7106 static-predicates arm (and the other
  global-receiver arms of `lowerMethodCall`: `Function.prototype`, `Object.defineProperty`, `JSON.stringify`, `Math`)
  gate on `isAmbientReceiver`, whose checker answer a script's own top-level declaration fools. On Prepared it now
  also asks `pristineBuiltinGlobal` through the resolver; it refuses by name (test). Other lanes have no such
  resolver member and are unchanged; the 804 prepared-bytes rows are byte-identical. `isUnshadowedGlobalExpression`
  keeps its callers (return and default-parameter `undefined`, the predicates' `undefined` / `NaN` / `Infinity`
  operands): those globals are non-writable and non-configurable, so only a lexical or module binding shadows them,
  which it checks. `isNaN` / `String` declared at top level are refused, not fooled.
- **Cleanup to file: the #7338 statics table** (`objectStaticsRealmOf` in from-ast, `select-object-statics`) still
  asks `resolver.isAmbientBinding` ("some" quantifier). It should ask the same `pristineBuiltinGlobal`; it touches
  `select.ts` (at its budget) and the ordinary lane, so it is left to its own change.
- `Object.create(null)` as a program's only use of `Object` takes the bounded #3518 plan (`prepare-object-create.ts`),
  whose typed result a dynamic script var cannot hold: `var n = Object.create(null); n.v = 3;` refuses by name
  (`proven dynamic binding 'n' initializer has no supported carrier`). Turning the plan off on this lane broke the
  #3518 no-source fixture (a typed `const` then went through the static arm), so it stays; one route for both is
  cleanup for the lead to file.

### Not verified

- Node 25 (not installed); no legacy `try` was hand-built.
- The m-sweep, o/o2/o4, str*, ty, t, d1, vg, p, x, f2, c2-constructors suites and the full 3518/3526 pin suites.

## Slice T plan (2026-11-22, branch `claude/7354-t` from `claude/7354-w` `9e2e91c2d0`)

Top-level shapes the Prepared path refuses, measured on the 411-row sample (U+W tally 31/4/376). Each class was
reproduced with its rows (driver: shim + `assert.js` + `sta.js` + includes + body through the strict entry with the
runner's options) and minimised. "Next" is what the row meets with the fix applied locally (uncommitted probe).

| # | class (rows) | cause | next with the fix |
|---|---|---|---|
| 1 | `'+' … (string/number)` (14 of 19) | the Prepared resolver answers no `supportsBackendCapability`, so `additiveOperandsProvable` sees `numberToString: false` and refuses every string + number, also typed (`var z = 2; "a" + z`; in a function it is an abort) | 9 rows run to the end (`returned`); 5 meet `new Object/Number/Boolean/String` (O1) |
| 1' | `'+' … (string/unprovable)` (5) | the operand is `new RegExp(…)` | RegExp — dropped |
| 2 | `only direct calls supported` (12) | a callee that is no identifier or member (`(function(){…})()`, `function(){…}()`, `w()(1)`) is refused; F2's call through a value exists but only for bindings | 4 run (`do-while`/`while` A14_T2, 10.4.3-1-12gs/-43gs); 3 annexB function-code rows abort at run time (a function declaration in a `switch` inside the IIFE); 5 meet built-ins (`apply`, `bind`, `Object.defineProperty`, a JSDoc-typed call) |
| 3 | `direct call to "isNaN"/"parseInt" has no exact AST-site plan` (7) | the ambient-global-function admission needs a lane capability and a lib-only binding test; the Prepared resolver answers neither | `isNaN(null * undefined)` (1) and `isNaN(x)` over a dynamic home (1) can run; 4 meet `new Boolean/Number/String` or `Number.NaN`; `parseInt` meets `new String` |
| 4 | `unsupported body statement FunctionDeclaration` (6) | Annex B.3.3 function in a block / `case` / `if` clause at script level | 2–3 (`switch-case-global-update`, `…existing-block-fn-update`, `…skip-early-err`); the three `existing-var-update` rows then meet a `function f` beside `var f` (H's repeated-binding refusal) |
| — | `module-init … nested var` (22) | all 22 are `for (var p in o)` heads over objects from `Object.defineProperty/create`, `String.prototype.*` | for-in is lane O5 (#7377) and the objects are O1 — **dropped** |
| — | `assignment to undeclared identifier` (4) | sloppy implicit global / ReferenceError / non-writable `NaN = true` | needs the global object and a catchable ReferenceError — **dropped** |
| — | `compound assign RHS … (got string)` (2) | `x ^= "1"` | both rows then meet `new String/Boolean` — **dropped** |

### Cause 1 — string + number on the Prepared lane
JS: `"a" + n` is ToString(n) concatenated (§13.15.3). The formatter is already admitted on standalone (Str2-c), and
templates/`String(n)` already reach it (`retargetNumberToString`). Fix: the Prepared source resolver answers the lane
capability `number-to-string` on wasmgc standalone, exactly where the formatter's support batch exists
(`prepare-number-format.ts`); one answer in `prepareSourceBuiltinResolvers` (`program-source-units.ts`), no other
capability. Reuses: `additiveOperandsProvable`, the existing concat lowering, the formatter. Must NOT: answer other
capabilities (regexp, JSON, object statics) the Prepared presentation does not bind. Acceptance: string + number /
boolean / string in each position (top level, function, value, condition, `+=`, unused with a throwing operand), NaN,
±0, ±Infinity, 1e21, 0.1 — node's string, wrong twin throws; `+` over a dynamic home unchanged; gc target unchanged
(refuses as before). Quality: one line, no new predicate.

### Cause 2 — a call whose callee is not a Reference
JS: `(function(){…})()`, `f()()`, `(0, g)()`, `(c ? a : b)()` evaluate the callee to a value and call it with
`this` = undefined (§13.3.6.1: not a Reference → thisValue undefined); member callees keep their receiver, and
`(o.m)()` is still a Reference (parentheses do not drop it). Fix: on the Prepared lane (`createsFunctionObjects`) a
callee that, outer parentheses skipped, is neither an identifier nor a member access is F2's `lowerBindingCall`
(callee first, then arguments, then the dispatcher's IsCallable TypeError). The predicate goes beside
`lowerBindingCall` in `function-object-lowering.ts`; from-ast gets one call and stays at its size (something moves
out). Must NOT: route a parenthesized member access there (wrong `this`); change the ordinary pipeline (gated on the
lane). Acceptance: IIFE / named function expression / unparenthesized / call result / comma / conditional callee,
strict `typeof this`, argument padding and dropping, argument order, the not-callable TypeError caught by `try`,
the checker-typed result used in `+`, `*`, comparisons, conditions, `typeof`; `(o.m)()` keeps its receiver; wrong
twins. Quality: one predicate, no second call path.

### Cause 3 — `isNaN(v)` (the lead confirmed it is this slice's: O1 covers only the four `Object` statics)
JS: `isNaN(v)` is `ToNumber(v)` then NaN test (§19.2.3). Fix: `isNaN` joins the Prepared conversion plans
(`prepareConversionResolvers`, the `String`/`Number` direct-call proof with its rebinding refusals); the lowering is
`Number(v)`'s (`lowerPreparedNumberCall`: first argument, extras evaluated, any carrier through
`js.number.from-value`) then `f64.ne` with itself. `isNaN()` with no argument stays refused. Must NOT: answer the
generic `native-global-function-call` capability (that would admit `parseInt`/`escape` shapes this path cannot
bind). Acceptance: numbers incl. NaN/±0/±Infinity, booleans, undefined, null, strings ("", " 12 ", "x"), dynamic
homes, extra arguments with effects; a script `function isNaN` / `isNaN = …` keeps its refusal; wrong twins.

### Cause 4 — Annex B.3.3 block function at script level (DEFERRED by the lead, 2026-11-22; sized L, 6 rows, 2–3 would run)
JS (sloppy): the block binding is initialized at block entry; when the declaration is evaluated its value is copied
to a var binding `f` (created undefined at script start) unless replacing it with `var f` would be an early error
(`let f` at top level → no var binding); strict: block-scoped only. Fix sketch: a block-level declaration whose name
is not read or written inside its own block lowers to "store the closure into `f`'s dynamic script home" at the
declaration's position; the name joins the script var homes (`irOwnedScriptVarHome`). Any reference inside the
block, strict code, or a lexical top-level name of the same name refuses by name. Estimate L; not started unless
1–3 land with budget left. Lead decision: not in this slice.

### Order and gates
1 → 2 → 3 (approved); 4 deferred. Each cause one commit with its
`tests/issue-7354-t2-*.test.ts` file, pushed. Proof per the brief: node agreement + wrong twins, ≥150 probes base vs
head, ordinary bytes 20 files × 2 targets, `check:prepared-bytes`, the sample through the real runner with mutated
twins for every new pass, all gates.

## Slice T result (2026-11-22, branch `claude/7354-t` from `claude/7354-w` `9e2e91c2d0`)

Causes 1–3 built as planned; cause 4 deferred by the lead.

- **1, string + number** (`5e1182f267`). `prepareSourceBuiltinResolvers` (`program-source-units.ts`) answers the one
  lane capability `number-to-string` on wasmgc standalone; every other capability stays unanswered.
- **2, a callee that is no Reference** (`cd322edd40`, `07d3134763`). `callsNonReference` beside `lowerBindingCall`
  (`function-object-lowering.ts`): on the Prepared lane a callee that, outer parentheses and TS wrappers skipped
  (the shared `skipOuterExpressions`), is neither an identifier nor a property/element access is F2's call through a
  value with `this` undefined. No existing "is this a Reference" predicate was found (grep). `(o.m)()` and
  `(o["m"])()` stay refused by name. Sloppy `this` inside such a callee is the run-time abort (C2's), not undefined.
- **3, isNaN** (`73e66c0c69`). `isNaN` joins the conversion plans (`prepareConversionResolvers`, the `String` proof);
  from-ast lowers it as `Number(v)`'s conversion (`lowerPreparedNumberCall`, now with the ToNumber of no argument as
  a parameter: `isNaN()` is true) and `emitIsNaN`, now shared with the ordinary ambient arm. Two things the plan did
  not foresee: (a) the flow rule refused the dynamic argument (lib `isNaN(number: number)`), so `legalize` takes
  `converts` (an admitted call converts its own arguments; one call site passes the plan); (b) the Prepared lane
  binds no `js.number.from-value`, so a dynamic operand of `Number(v)` was a physical-plan refusal — on the Prepared
  lane (`createsFunctionObjects`) it is now the legalized carrier ToNumber (`dyn.to_number`). `Number(v)` of a
  dynamic value therefore runs too (tested). `isNaN` joins `PREPARED_PROVIDED_GLOBALS`: `typeof isNaN` refuses by
  name. `parseInt` is not done: it needs a Prepared-bound native scanner provider (a census admission like
  Str2-c's formatter), not the conversion mechanism.
- from-ast.ts ends at its base size (17357; comment reflows pay for the three calls); program-source.ts untouched.

| test file (each alone) | tests | exit |
|---|---|---|
| issue-7354-t2-string-number-add (new) | 7 | 0 (6 fail on base) |
| issue-7354-t2-non-reference-callee (new) | 8 | 0 |
| issue-7354-t2-isnan (new) | 9 | 0 |
| issue-7363-prepared-eval-refusal (changed: the named IIFE now runs; node agreement + wrong twin) | 91 | 0 |
| all 52 other issue-7354-* files, 7331, prepared-entry/-runtime, 7188 (batched, 1 fork) | all | 0 |

- **Probes**: 202 (3 causes × top / function / argument / condition / loop / statement positions; runner options),
  base → head: right 0 → 154, refused 152 → 42, abort 50 → 6. Moves: refused→right 108, abort→right 46,
  refused→abort 2. 0 wrong, 0 invalid Wasm, 0 exceptions, nothing right became anything else.
- **Ordinary pipeline**: 20 test262 files + 50 probes × default + standalone byte-identical. `check:prepared-bytes`:
  all 804 rows identical to the base.
- **Sample** (411 rows, real runner, default settings): 31/4/376 → **46 / 8 / 357**. New passes (15), each with a
  mutated twin (last `!==` flipped) that FAILS through the same runner (15/15): compound-assignment
  S11.13.2_A2.1_T1.6, A3.2_T9, A3.2_T10, A3.2_T11; do-while S12.6.1_A14_T2; while S12.6.2_A14_T2; for S12.6.3_A12.1_T2;
  line-terminators between-tokens-cr; function-code 10.4.3-1-12gs, 10.4.3-1-43gs; unsigned-right-shift
  S11.7.3_A5.1_T1; prefix-increment S11.4.4_A3_T4; multiplication S11.5.1_A3_T1.4; subtraction S11.6.2_A2.3_T1;
  white-space S7.2_A4.4_T2. New fails (4, run-time aborts): three annexB function-code rows (a function declaration
  in a `switch` inside the IIFE) and toLocaleLowerCase S15.5.4.17_A1_T5. Top errors: 73 `formatIdentityFreeValue`,
  44 `Array`, 37 `Object.defineProperty`, 22 nested var (for-in), 17 `Object`.
- Gates: typecheck, LOC and func budget (merge base and `LOC_GATE_BASE` = main `bbda75a4c4`), coercion sites,
  oracle ratchet, dead exports, import cycles, boundaries inventory — all exit 0.

**Found, not fixed (pre-existing, wrong value).** `typeof parseInt + typeof Math + typeof Object` is
`"undefinedundefinedundefined"` on the Prepared path (node: `functionobjectfunction`): `absentGlobal`
(`source-dynamic-contracts.ts`) takes every lib global outside `PREPARED_PROVIDED_GLOBALS` for an absent one.

**Not verified.** Node 25 (not installed; local Node 22). Mutation runs beyond the guards the tests kill by
construction (the capability answer, the member exclusions, `absent`, `converts`, the carrier ToNumber arm, the
`isNaN` provided-global entry each have a test that fails without them; the lane gate of `callsNonReference` and of
the carrier arm is covered only by the ordinary-bytes comparison).

### T follow-up: `typeof` of a standard global (lead request, 2026-11-22)

- **Fixed the wrong value above.** `absentGlobal` (`source-dynamic-contracts.ts`) now calls a name absent only when
  the checker resolves it to no symbol at all, neither the program's nor the loaded TypeScript lib's. The lib stands
  in for the list of standard globals but is not exactly that list (known limits below). `PREPARED_PROVIDED_GLOBALS`
  is gone; the new rule covers it.
  - `typeof` of `parseInt`, `Math`, `Object`, `JSON`, `globalThis`, every Error subclass, … refuses by name at top
    level and aborts inside a function.
  - `typeof undefined` / `NaN` / `Infinity`, an undeclared name, and a program `var` named like a global all give
    node's answer.
  - A script `function parseInt` still refuses, as it did before this change.
  - `globalThis` needed the symbol test: the checker resolves it to a symbol with no declarations.
- **Consequence in the prelude.** `formatIdentityFreeValue` (assert.js:27, `typeof JSON`) now gets the abort body.
  - A failing assertion therefore ends in that abort instead of a Test262Error. It is still a fail.
  - Before, the fold picked the `'"' + value + '"'` arm, which is not node's branch.
- **Pins updated.** Ty: the seven "absent global" rows now use an undeclared name, and every name in the ambient
  table refuses. U prelude: the abort table and the wrong-value outcome. M1 D35: the `typeof JSON` arm is dropped.
  C2, O2b, O4: the guard programs name `Symbol`/`Object` without a `typeof` at top level.
- **Tests.** `tests/issue-7354-t2-typeof-standard-globals.test.ts` (26). All issue-7354 files, 7363, 7331, 7343,
  7361, prepared entry/runtime and 7188 pass.
- **Sample.** All 46 passes (the 31 base passes plus slice T's 15) re-run through the runner: 46/46 still pass, so no
  false pass was found. Five of them contain `typeof`.
- Merged `claude/7354-w` `e6931fc15e`. Gates (also with `LOC_GATE_BASE` = main `bbda75a4c4`) exit 0.

### T review round (PR 7398)

- **Write to a named function expression's own name** (must-fix). `(function nm(){ nm = 1; })();` threw
  `assignment to non-slot binding "nm" — mutation pre-pass should have detected it` out of `compile()`. The defect
  predates T: `var f = function nm(){ nm = 1; }; f();` threw the same on the base. The name is an immutable binding
  (§9.1.1.1.5): sloppy code ignores the write, strict code throws a TypeError. Node's answer would need the strict
  TypeError on this lane, so the write is refused by name instead (`write to the function expression name "nm"`),
  which is the function's abort body under the test262 entry. The three non-slot write sites (assignment, compound
  assignment, increment) share one `refuseNonSlotWrite`; any other non-slot write keeps the invariant with its old
  text. Tests: `tests/issue-7354-t2-function-expression-name.test.ts`, covering both routes, sloppy and strict,
  `=`/`+=`/`++`, and a read of the name after the write. Ordinary pipeline: byte-identical on the 20 test262 files,
  25 probes and the three own-name programs, × default and standalone.
- **from-ast budget.** The seven comment reflows are reverted. T's growth is paid for by moving code:
  - `moduleInitContainsNestedVar` moves to `src/shared/var-declaration-lists.ts`, beside `isModuleInitVarList`.
  - `super(args)` becomes `lowerSuperConstructorCall`.
  - The Prepared element-access call and the non-Reference callee call are one `lowerPreparedValueCallee` in
    `function-object-lowering.ts`.
  - `from-ast.ts` ends at 17355 lines (base 17357). `lowerCall` is within its function budget. The #3000 IR class
    tests fail the same 8 host-lane rows on the base and on the head.
- **M1 D35** uses assert.js verbatim (checked against `test262/harness/assert.js`). `isNegativeZero`/`isPrimitive`
  keep node agreement; `formatIdentityFreeValue` is asserted to be the run-time abort.

**Found, not fixed: a runtime-negative test cannot pass on the Prepared path.** Control row (frontmatter `negative:
phase: runtime, type: Test262Error`, body `throw new Test262Error("x");`) through the runner: `fail`,
`TypeError (null/undefined access): <description>`.
- **Cause.** The program compiles and its module-init throws a `WebAssembly.Exception`. But a Prepared artifact
  exports neither `__exn_tag` nor `__tag` (checked on the head, on W `e6931fc15e` and on main `bbda75a4c4`, from
  `git archive` copies). So the worker's `extractWasmExceptionMessage` (`scripts/test262-worker.mjs`) cannot read the
  payload and falls back to its generic label "TypeError (null/undefined access)".
- **Verdict.** `originalHarnessExceptionMatches` (`scripts/test262-runtime-verdict.mjs`) compares the payload's
  `name` (unreadable) or the rendered text against `negative.type`. The text does not contain "Test262Error", so the
  row fails. This predates T.
- **Sample.** All 14 negative passes are `phase: parse`; no runtime negative passes today, so no sample row was
  affected.

**Known limits (pre-existing, not ES5, no sample row affected; not fixed here).** The checker's lib is the stand-in
list of standard globals, and it is not exactly that list:
- A standard global the loaded lib does not declare (ES2025 additions) still answers "undefined":
  `var out = typeof Iterator;` gives `"undefined"`; node gives `"function"`.
- A DOM name the lib does declare now refuses by name instead of answering "undefined" as node does:
  `var out = typeof window + typeof name;` → `identifier "window" is not in scope in <module-init>`. Likewise
  `print`, `console`.

## Slice H2 plan (2026-11-22, branch `claude/7354-h2` from `origin/main` 8485f48d6b)

Refusal: `function declaration 'F' read as a value is written` (`src/ir/function-declaration-values.ts:136`, the
`bindingHoldsItsDeclaration` proof). Measured on main 8485f48d6b, the 411-row ES5 sample through the real runner
(`TEST262_COMPILER_PATH=ir`, standalone, QuickJS eval engine; tally 46 / 8 / 357 as after T): **73 rows**
`formatIdentityFreeValue` + **1** with a parse error (S7.9_A6.3_T2, negative) + **6** `verifyProperty` (same proof).

### (a) Which clause fails (80 rows; classifier on the elided assembled source)

The harness itself (shim + assert.js + sta.js) is clean after F0's dead-binding elision: `thrown.constructor` is an
observed constructor and `this instanceof Test262Error` is inert. Every failure comes from the test or an include.

| failing clause | rows | test-side construct | examples |
|---|---:|---|---|
| unique (an `eval` identifier) + dynamicCode | 34 | `eval(…)` / `(0,eval)(…)` in the test | annexB/eval-code/direct/func-block-decl-eval-func-existing-fn-no-init.js L26 `eval(`; expressions/void/S11.4.2_A1.js L13 `eval("void\u00090")` |
| unique (`eval` as a property KEY in the kept `$262` shim: `eval: globalThis.eval`) + dynamicCode + escapes (`global: globalThis`) | 14 (+4 verifyProperty) | the test also calls `eval`/`Function`, which keeps `$262` alive | annexB/eval-code/indirect/global-switch-dflt-eval-global-block-scoping.js; built-ins/global/S10.2.3_A2.3_T4.js |
| unique (`eval` key / `with`) + dynamicCode + reflective + escapes | 6 | `with(myObj)` + `eval`, or `f.constructor` + `new Function` | statements/with/S12.10_A1.12_T2.js L44; built-ins/Function/S15.3.2.1_A3_T4.js L29 |
| unique (`with`, no eval) + reflective | 3 | `with (scope) {…}` | statements/with/S12.10_A3.3_T4.js L26; compound-assignment/S11.13.2_A5.3_T1.js L26 |
| dynamicCode only | 3 (+1 vp) | `Function("…")` | function-code/10.4.3-1-14gs.js L12; statements/function/13.2-11-s.js L11 |
| escapes only | 5 (+1 vp) | a non-inert `this` | function-code/S10.4.3_A1.js L12 `(function(){ return this; })()`; Object/create/15.2.3.5-4-256.js L12 `this.get = …` |
| reflective only | 8 | `x.constructor` (7), `Reflect.construct` via isConstructor.js (1) | Object/S15.2.1.1_A2_T13.js L14 `obj.constructor`; RegExp/prototype/toString/S15.10.6.4_A6.js |
| reflective + escapes | 1 | `err.constructor` + asyncHelpers' `call(globalThis, "$DONE")` | harness/asyncHelpers-throwsAsync-null.js |

`bindingIsUniqueAndNeverWritten` fails on 57 rows, always by its eval/with sub-clause (eval in the test 34, `eval`
property key in the shim 16, `with` 3, both 4); never by a second binding site or an identifier write. Its eval
sub-clause counts ANY identifier spelled `eval`, a property key included. `globalWrittenNames` (a member write of
the name on `this`/a global name) fails on 0 rows.

### (b) What each row meets next (refusal disabled locally, uncommitted; same runner)

| group | rows | next |
|---|---:|---|
| eval in test | 50 | 18 `eval statement has no eval provider`, 13 `globalThis` not in scope (the kept `$262`), 6 `direct call to "eval" has no exact AST-site plan`, 4 run-time abort in `eval` (fail), 3 `ReferenceError` not in scope, 3 nested var, 1 `Function`, 1 `SyntaxError`, 1 top-level `this` |
| reflective | 8 | 6 built-in classes (`String` ×3, `Number`, `Object` ×2), 1 `RegExp`, 1 closure return annotation |
| `Function` in test | 7 | 2 `globalThis`, 2 nested var, 3 `Function` refusals |
| verifyProperty | 6 | 4 `direct call to "Function"`, 2 `Array` |
| `this` | 5 | **1 pass** (function-code/S10.4.3_A1.js, strict `this` is `undefined`), 2 top-level `this`, 1 `.apply` on a closure, 1 `ambiguous or unsupported value type` |
| `with` | 3 | 1 abort (fail), 1 top-level `this`, 1 nested var |
| parse-error negative | 1 | `Expression expected.` (still compile_error: no owned static SyntaxError verdict) |

Expected gain of the slice alone: **+1 pass**, 5 compile errors become run-time-abort fails. Its value is that it is
the FIRST wall on 80 rows: behind it sit the eval provider (28), `globalThis` (15), the built-in classes (8),
`Function` (≥7) and top-level `this` (4). With this refusal in place, none of those slices can turn its rows.

### (c) Design: (ii) one mutable home; the routes refuse at their own site

Spec. A script-level function declaration is a binding of the global environment's OBJECT record (§9.1.1.4,
§16.1.7 GlobalDeclarationInstantiation step 16: `CreateGlobalFunctionBinding(fn, fo, false)`), i.e. an own data
property of the global object, `{ [[Writable]]: true, [[Enumerable]]: true, [[Configurable]]: false }`
(§9.1.1.4.18). `f = v`, `this.f = v` (script `this`), `globalThis.f = v`, `eval("f = v")`, a sloppy
`Function("f = v")()` and `Object.defineProperty(globalThis, "f", …)` all reach the SAME property. One storage, many
routes. The path models the storage as the home and lowers the routes it can see (identifier references) as home
operations. Every other route needs the global object as a value or dynamic code, and on this lane each of those
already refuses or aborts at its own site (measured on main with probe programs):

| route to the property | Prepared lane today |
|---|---|
| top-level `this` | refused: `'this' reference outside an instance method body` |
| sloppy function `this` (plain call, a callback) | refused (`a direct call of h installs no receiver`) or run-time abort (C2) |
| `globalThis` / `self` / `window` | refused: `identifier … is not in scope` (T follow-up); `global` is absent |
| direct / indirect `eval` | refused: `eval statement has no eval provider` / `no exact AST-site plan`; abort inside a function |
| `Function(…)`, `new Function(…)`, `x.constructor(…)` | refused: `direct call to "Function"`, `only direct constructor names`, `.constructor(...) not in slice 4`; a `.constructor` read aborts |
| `with (o) { f = v }` | refused: `with target/body outside the closed-object IR slice` |
| `Object.defineProperty(this/globalThis, …)`, `Reflect.set` | needs the global object as a value (above) |

So the read needs no proof. The existing direct call of a never-read declaration already relies on exactly this: it
has no whole-program check, and `this.f = 2; f()` is sound today only because `this` refuses. The read-site proof is
the one place that re-derives the invariant with a source scan, and the scan is both too strict (any `eval` key, any
`.constructor`, an unrelated strict `this`) and redundant with the site refusals.

Why not (i), narrowing per name: `eval` and an escaping global object can write any name, so 57 rows (eval/with)
stay refused, and the eval slice could never turn them. It keeps a whole-program scan beside the site refusals.

Built (H2):
1. **Writes.** `scriptVarWrites` (`module-binding-script-var.ts`, checker identity, `undefined` under `with`/direct
   `eval`) is generalised from `VariableDeclaration` to the function declaration too; it replaces
   `bindingHoldsItsDeclaration` in `functionDeclarationValues`. A declaration with any write (or `undefined`) gets
   a MUTABLE home (`identity.mutable: true`) of plain `irDynamic()` type, with no Function tag, because the binding
   may hold anything. Identifier writes of every form (`=`, compound, `++`, logical, destructuring, for-in/of head)
   take the existing module-binding write path. Forms that path does not lower keep their own refusal, at the write.
2. **Calls.** `program-source-direct-calls.ts` plans no direct call to a declaration whose home is mutable. from-ast
   then takes F2's call through the home (`lowerBindingCall`): callee first, arguments, IsCallable TypeError. `new F`
   of a written `F` refuses by name (`function declaration 'F' is constructed after a write`) unless the C2
   construct path reads the home. Phase 2 checks which.
3. **Static folds audit.** Every fact derived from the FunctionDeclaration symbol rather than the home must check
   "not written": `typeof f`, identity, IsCallable, `f.length`/`name`, `instanceof f` (its `prototype`), carrier kind.
   Each one found gets a program in the test file.
4. **Leave it better (separate commit, lead's call).** Fa's `staticFunctionValue` is `bindingHoldsItsDeclaration`'s
   only other user. The same argument applies to it: the binding never written by identifier (checker) means the
   closure call is sound. Folding it deletes `shared/binding-holds-declaration.ts` and F1b's `globalObjectWriteRoutes` /
   `globalWrittenNames` / `writesGlobalObject` in `intrinsic-prototype-writes.ts` (about −70 lines). Without the
   fold, a follow-up issue is filed and linked.

Still refused, and why each refusal is sound:
- A second declaration of the name (two `function f`, `var f` beside it [H's refusal], an Annex B block function):
  the last-wins and B.3.3 copy semantics are not modelled. Detected by the symbol's declaration count.
- `has a typed parameter` / `has a result the dynamic value does not carry` / `is in a script that runs no top-level
  code`: unchanged.
- Every route in the table above stays refused at its site. **Obligation on later slices:** a slice that makes the
  global object a value, or runs dynamic code (the eval provider, `globalThis`, sloppy `this` substitution, `with`
  over the global object), must read and write script bindings through their homes or refuse. The H2 test file's
  tripwire programs (below) fail with a wrong value the moment such a slice forgets.
- `delete f`: sloppy is `false` (non-configurable), strict is an early SyntaxError (§13.5.1.1). Probed in Phase 2;
  anything else refuses.

### (d) Placement, size, tests, quality

- Files: `src/ir/function-declaration-values.ts` (the proof call becomes the writes query, the home's mutability and
  type follow it; about +10/−6), `src/ir/module-binding-script-var.ts` (`scriptVarWrites` takes the declaration kind;
  about +4), `src/ir/program-source-direct-calls.ts` (skip a mutable home; about +6), the `new` site (about +4).
  Plus the step-4 fold if approved (about −70). from-ast.ts: no growth. Expected net src diff is +25 without the fold
  and −45 with it.
- Reuses: `scriptVarWrites`/`identifierWritesOf` (checker-identity writes), the module-binding read/write path,
  F2's `lowerBindingCall`. Removes: the read-site whole-program proof. With the fold it also removes the F1b
  global-write scan.
- Tests: `tests/issue-7354-h2-written-function-declarations.test.ts`, node agreement with a wrong twin
  (`agreesWithNode`) for:
  - each write form × position (top level, inside a function, inside the declaration itself, in a closure);
  - reads after the write: `typeof`, a call, `===` with an alias taken before the write, the alias still calling the
    old function;
  - order: the write in a function that runs before the first call;
  - a write to a non-callable value, then a call: the TypeError is caught by `try`;
  - strict and sloppy code.

  Tripwires: each route in the table above writes `f` and then reads `f`. Each must refuse or abort, never give a
  wrong value. Unchanged refusals: a second declaration, `var` beside it, a typed parameter.
- Runner: the 80 rows again. Every new pass (expected S10.4.3_A1) gets a mutated twin next to the original file
  (`!== undefined` → `=== undefined`). The twin is run through the same runner, must FAIL, and is then deleted.
- Gates: ≥150 probes base vs head (0 wrong, 0 invalid Wasm, 0 exceptions); ordinary pipeline 20 test262 files ×
  default/standalone byte-identical; `check:prepared-bytes` vs base (expected diffs only where a declaration is read
  as a value AND written); the f1b-*, fa-function-values, F2, C2, U prelude and t2-* files.
- Quality acceptance: no new whole-program scan or predicate. One checker-identity writes query serves script vars and
  function declarations. `bindingHoldsItsDeclaration` either is deleted (fold) or has one user and a linked cleanup
  issue. from-ast.ts does not grow. No defensive branch for a route that cannot reach the home.

## Slice H2 result (2026-11-22, branch `claude/7354-h2`; design (ii) with the Fa fold, approved; `main` c47b7a03fd with O1 merged)

### Built

- **One writes query** (`module-binding-script-var.ts`). The module doc states the invariant in one place: on this
  path every route to a script binding other than an identifier refuses or aborts at its own site.
  - `scriptVarWrites` and `preparedBindingRewritten` (named `scriptBindingRewritten` before review round 1) read one
    cache, `identifierWrites`, keyed by the declaration's name.
  - `preparedBindingRewritten` = any identifier write other than the declaration's own, by checker identity. It is
    Prepared-only: `with`/`eval` do not void it, because both refuse at their sites there.
- **Declaration values** (`function-declaration-values.ts`).
  - The read-site proof is gone.
  - A rewritten declaration's home is mutable and untagged.
  - A second `function f` refuses by name (`has a second declaration`). Only function declarations are counted, because
    a JS symbol also lists `f.x = 1` (sta.js's `Test262Error` hit this).
- **Calls.** The call planner already declines a reassigned declaration (`imported-functions.ts`, `reassigned`), so the
  plan's skip in `program-source-direct-calls.ts` was not needed. A probe with and without it showed this. What was
  needed:
  - `sourceFunctionCallee` (`source-dynamic-provenance.ts`) declines a rewritten callee. Without that,
    `function h(){ return f(); }` kept a number result while `f()` read the home. That was an exception out of
    `compile()` (`return[0] type externref not assignable`), found by a probe and fixed before commit.
- **Closure into a dynamic module home.** `f = function(){}` refused (`got closure()->dynamic`) for script vars too.
  - `storedCarrierValue` (`function-object-lowering.ts`) is the boxing `dynamicStoreOperand` already did; that function
    now calls it.
  - from-ast's `boxForDynamicModuleStorage` delegates to it, which shrinks from-ast by 1.
  - The closure arm is gated on the Prepared lane, so ordinary bytes do not change.
- **Fa fold.** `staticFunctionValue` asks `!scriptBindingRewritten`. `shared/binding-holds-declaration.ts` and F1b's
  `globalObjectWriteRoutes` / `globalWrittenNames` / `writesGlobalObject` are deleted, and so is the entry in
  `scripts/compiler-boundaries.json`.
- Diff vs main: src +103 / −121 over 9 files. program-source.ts grows by 1 line (the checker argument; dated grant in
  the frontmatter).

### Tripwires (condition 1)

Before any change: 12 routes × {called declaration, declaration read as a value, script var} × {top level, in a called
function} = 78 programs on main. **None ran to the end**: each refused or aborted, so no existing wrong value.
`tests/issue-7354-h2-script-binding-routes.test.ts` keeps 96 such programs, adding the Fa form (a var holding a
function expression). All 96 refuse or abort on the head.

### Fa fold (condition 2)

20 class programs plus 26 route programs, base and head:
- The classes the old proof declined (an `eval` key, `.constructor`, strict `this`, a same-name local or parameter,
  member writes of other names, `eval`/`with`/`Reflect`/`globalThis`/`Function` in uncalled functions, a second
  `var f`) are RIGHT on both. The old proof only chose the call path; the outcome did not change.
- `fa-rewritten` and `fa-rewritten-in-fn` go from refused/abort to RIGHT.
- Annex B and every route keep their refusal or abort.

### Tests (each file alone, one fork)

| file | tests | exit |
|---|---:|---:|
| issue-7354-h2-written-function-declarations (new) | 31 | 0 |
| issue-7354-h2-script-binding-routes (new) | 96 | 0 |
| fa-function-values (pins moved: 8 route rows now admit, two refusals now run) | 40 | 0 |
| f1b-declaration-values (5 "is written" rows → the H2 files) | 6 | 0 |
| f1-function-kind (`g.__proto__ = null` now refuses at the write) | 12 | 0 |
| c2-this (comment) | 18 | 0 |
| every other issue-7354-* file (49), 7363, test262-prepared-entry | all | 0 except o-objects |

- `issue-7354-o-objects` "refuses what the later steps build" fails **on main c47b7a03fd too** (O1 made
  `return { a: 1 }` compile). It is not H2's.
- Mutations (whole file): no Function tag on a rewritten home is killed (a write in a closure traps). An immutable
  home is killed (17 rows). Dropping `sourceFunctionCallee`'s decline is killed.

### Proof

- Probes: 207 programs (the plan probes, routes, Fa classes, call order, static folds), base c47b7a03fd vs head:
  - base: 30 right / 137 refused / 40 abort; head: 62 / 85 / 60;
  - moves: refused→right 31, refused→abort 21, abort→right 1;
  - 0 wrong, 0 invalid Wasm, 0 exceptions, nothing right became anything else.
- Ordinary pipeline: 20 test262 files + 69 probe programs × default/standalone are byte-identical.
- `check:prepared-bytes`: all 804 rows are identical to the base.
- Gates exit 0, against the merge base and against `LOC_GATE_BASE` = c47b7a03fd: typecheck, LOC, func budget,
  coercion sites, oracle ratchet, dead exports, import cycles, compiler-boundaries (`--mode inventory`), issue ids.

### Sample (411 rows, real runner, base = main c47b7a03fd with O1)

| | pass | fail | compile_error |
|---|---:|---:|---:|
| base | 49 | 11 | 351 |
| H2 | **50** | 16 | 345 |

- Exactly the 79 rows that met this refusal changed; no other row changed.
- New pass: `language/function-code/S10.4.3_A1.js`. Its twin (`!== undefined` → `===`, written next to the original,
  run through the same runner, deleted) FAILS.
- 5 rows went from compile error to fail, each a run-time abort: eval ×4, and `with` in testFunction.
- What the other 73 rows meet now: no eval provider (18), `globalThis` (15), `direct call to "Function"` (6), nested
  var (6), `direct call to "eval"` (6), top-level `this` (4), `ReferenceError` (3), built-in classes and the rest
  (15).

### Known, not done

- Write forms the module-binding path does not lower refuse at the write, each pinned in the test file:
  - `f += …`, `f++`;
  - logical assignment, destructuring;
  - a for-in head.
- `delete f` refuses (`delete has no IR lowering`); node gives `false`.
- Two write analyses of a function binding remain:
  - the call planner's `reassigned` set (`imported-functions.ts`, shared with the ordinary pipeline);
  - `identifierWrites`.

  Until review round 1 they disagreed on shorthand targets (`({ f } = o)`): only `reassigned` resolved the value
  symbol. Both resolve it now. Folding them is a follow-up, because it touches the ordinary pipeline's call planning.
- `new f()` after a write was checked with the runner's options in probes. The H2 test uses plain constructors,
  because without `skipSemanticDiagnostics` TypeScript calls `function f(){ this.a = 1 }` a class and refuses `f = C`.
- Node 25 is not installed.

### Review round 1 (PR 7408, NOT MET; fixed on the branch, `main` 88fd45a0c5 merged)

1. **Exception out of `compile()`** (`with ({ a: 1 }) { f = 5; }`). from-ast threw a bare `Error` when a `with` target
   lowered to no closed object; any top-level `with ({…})` reaches it on main too. It is now `refuseUnselected`:
   on the Prepared path it is the named refusal `with target not closed`, on the ordinary pipeline it stays an
   invariant.
   - `with` is named in the invariant doc. The checker resolves no symbol inside a `with` body, so the query cannot
     see a write there.
   - New routes rows: `with ({})` and `with ({ a: 1 })`, at top level and in a function, for a declaration and for a
     script var.
   - Other bare `Error`s on the `with`/`eval`/`this` routes: none reachable in from-ast. Those in integration.ts
     (`dyn.global_object`, `dyn.current_this`) are lane-capability invariants of the ordinary backend, and the 237
     review probes reached none.
2. **Shorthand targets.** `identifierWrites` resolves `({ f } = o)` and `({ f = 3 } = o)` through
   `getShorthandAssignmentValueSymbol`.
   - Pinned through Fa's contract: such a write declines the static closure. Both rows fail without the fix.
   - `scriptVarWrites` shares the cache, so the ordinary pipeline's certifiers see these writes too. Ordinary bytes
     are identical on 20 test262 files and 69 probes, six of them shorthand writes to script vars.
3. **Parameter initializer** (§10.2.11): named in the invariant doc as a route that must keep refusing; routes rows
   added. It refuses today (`rest/default/optional param not in Phase 1 IR scope`).
4. **One module, two answers, both needed.**
   - `scriptVarWrites` serves the ordinary pipeline's certifiers (string, vec, class-instance homes, via
     `makeIrModuleBindingResolver` in codegen/index.ts and integration.ts). There a host `eval` runs, so its
     `with`/`eval` decline is required.
   - `preparedBindingRewritten` is called only by Prepared code (function-declaration-values, Fa,
     source-dynamic-provenance), where the invariant holds.
   - The module doc says this; the name now says it.
5. **`dynamic-home-open-object.ts` `everyUseIsServed` is not folded.**
   - Its only user is `select.ts`, the ordinary pipeline's selector, where `eval`, `with` and the global object are
     lowered and live, so the site-refusal argument does not hold.
   - It also answers a different question: whether `Object.prototype` stays the realm's (`sourceMayPatchPrototype`,
     `sourceNamesReflectiveRoute`).
   - A cleanup would have to move its write half (`bindingIsUniqueAndNeverWritten` + `sourceWritesMemberNamed`) onto
     a checker-identity query that keeps the ordinary pipeline's dynamic-scope decline. That is a candidate for
     `scriptVarWrites` plus a global-object member-write scan.
6. **Nits.**
   - The `?? true` is gone (the query is keyed by an identifier name).
   - Renamed to `preparedBindingRewritten(checker, name)`; it serves nested function declarations too.
   - The second-declaration count is not shared with imported-functions' `functions.length === 1`. That one lives
     inside `targetForSymbol` beside overload-set admission (TypeScript overloads), which a JS function value has no
     use for, and extracting it is not cheap.

Proof (round 1):
- Review probes `.tmp/adv/a1`–`a9` plus the round-1 programs (237), previous head vs this head:
  - 13 exceptions → named refusals (every `with ({…})` program);
  - 0 other changes;
  - right 57 = 57, 0 wrong.
- Tests: h2 routes 120/120, fa 42/42, f1b 6/6.
- `check:prepared-bytes`: 804 rows identical. Ordinary bytes are identical, as in item 2.
- Gates exit 0, against the merge base and against `LOC_GATE_BASE` = main 88fd45a0c5: LOC, func budget, coercion,
  oracle, dead exports, import cycles, boundaries, typecheck. from-ast.ts shrinks by 2 more lines.

## Slice P1 plan (2026-11-22, branch `claude/7354-p1` from `claude/7354-o1` 4fc230872a)

`Object.prototype.hasOwnProperty`, `propertyIsEnumerable`, `isPrototypeOf` on the Prepared path.

### Reproduced (strict entry, runner options, real prelude)

| row | stops at (base) |
|---|---|
| `Object/defineProperty/15.2.3.6-2-12.js` | `own-property test on a script var planned by neither #7335's arm nor the row (<module-init>)` |
| `Object/create/15.2.3.5-4-19.js` | same |
| `Error/prototype/S15.11.3.1_A3_T1.js` | `identifier "Error" is not in scope` (needs G1; P1 does not move it) |

The refusal comes from from-ast's #7339 territory test (`isOwnPropertyTestTerritory`, the ordinary lane's fallback
row): on this lane the row is never planned, so every `x.hasOwnProperty(k)` on a script var refuses before F2's
method call is reached. Elsewhere (a parameter) the call already is Get + `js.closure.call:1`, and the Get is C2-D1's
`has ? get : abort`, so it aborts unless the object owns the key.

### Decision: (i), populate; the built-in's algorithm runs at the call site, behind an identity test

- **Population.** The realm's Object.prototype (the kernel's `objectPrototype`) holds the three methods as data
  properties `{writable, !enumerable, configurable}`, each a kernel built-in function entry: `typeof` "function", own
  `length` 1 and `name` (read only), [[Prototype]] %Function.prototype%, no `prototype`, not a constructor. Reads,
  writes, overrides and `Object.create(null)` chains are the realm's own [[Get]] / OrdinarySet, so a user own
  property, a user prototype's method or a write `o.hasOwnProperty = …` wins by construction, and
  `Object.create(null).hasOwnProperty` is `undefined` exactly. No proof of absence anywhere.
- **The call.** `o.m(args)` stays F2's Get + call. Where the call's callee is that Get with a populated constant key
  (the legalization sees it defined by `dyn.member_get`), the call expands to
  `f === %Object.prototype.m%` ? (the built-in's algorithm, written by the legalization) : (the dispatcher call). The
  test is the run-time identity of the value the Get answered, so an override is simply the else arm.
- **Why not (ii)** (recognised by receiver kind): it needs a proof that no object owns `m`, no user prototype has it,
  nothing was assigned to Object.prototype, and it is wrong for a receiver of unknown kind (plan B-D5).
- **Why the algorithm is not the kernel entry's `(this, vector)` body — how O1's decision carries over.** Step 1 of
  both predicates is ToPropertyKey(V), which for an object key calls its `toString` / `valueOf` (a source closure,
  F2's dispatcher) and for a number needs the program's Number::toString: only the source side has them (O1 made the
  same call for the statics). So the realm still serves contracts over converted operands, and the steps that need
  the program (ToPropertyKey via the legalization's `stringOf`, the kind tests) are written at the site. The value
  form (`var h = o.hasOwnProperty; h(k)`, `new h()`) reaches the dispatcher with a built-in callee: its fallback,
  today the catchable `Value is not callable` TypeError (wrong once a built-in is a value), becomes the run-time abort
  for a built-in function object (B-D3 / C1: such a kernel entry's algorithm is `unreachable`). V1/P2 replace that
  abort with a real `(this, vector)` algorithm plus a realm-to-program callback; nothing here has to be undone.
- **Not populated: `valueOf`, `toLocaleString`, `toString`, `constructor`, `__proto__`, the legacy methods.**
  `constructor` is %Object%, not a value yet (V1). `valueOf` / `toString` are read by OrdinaryToPrimitive (F2's D6),
  which models them as absent: populating `valueOf` would send every `"" + o` through the dispatcher's built-in arm,
  i.e. the abort — a regression. Deviations from plan §5 P1 (it listed `valueOf`) and §6 ("status 2 has no caller
  left"): status 2 (a miss at Object.prototype) keeps its meaning for these keys.

### What a read of an Object.prototype key becomes

| key | ordinary object | function value | number / boolean / string | error (caught TypeError) |
|---|---|---|---|---|
| the three | realm `get` (was `has ? get : abort`) | realm `get` (was abort) | `%Object.prototype.m%` (was abort): no wrapper prototype holds `m` and no program can change one (M1) | abort (unchanged) |
| `toString`, `valueOf`, `toLocaleString`, `constructor`, legacy methods | `has ? get : abort` (C2-D1, unchanged) | abort (unchanged) | abort (unchanged) | abort (unchanged) |
| `__proto__` | refusal / abort (unchanged) | same | same | same |

Nothing becomes `undefined` that was not: a populated key misses only on a chain that ends at `null`.

### The algorithm at the site (`this` = the call's receiver, `V` = the first argument or `undefined`)

- `hasOwnProperty` / `propertyIsEnumerable`: `P = ToPropertyKey(V)` first (`stringOf`; a key object's `toString` runs
  once, a throw is catchable), then by `this`'s kind: ordinary object or function → new realm row
  `js.object.has-own(o, P, selector)` (kernel `findOwn` over `bag`; selector 1 also tests the enumerable bit; it sees
  literal, written, defineProperty data / accessor / non-enumerable properties, a function's `length` / `name` /
  `prototype`, constructor-made properties); number / boolean → `false` (a fresh wrapper owns nothing); string →
  abort (its `length` and indices need the String exotic, A1); error → abort; `undefined` / `null` → ToObject's
  TypeError (unreachable: the Get before it threw).
- `isPrototypeOf`: V not an ordinary object → `false` (step 1, before ToObject(this)); else `js.object.inherits(V, this)`
  (C2's walk: an ordinary object's chain holds only ordinary objects, so a function, error or primitive `this` answers
  false by the walk; a function or error V's chain holds only realm prototypes no program can name → `false`).
- Result: the Boolean carrier.

### Placement, reuse, removals

- Catalog (`native-realm-catalog.ts`): the three rows `implementation: "native"`, one native list beside the statics'
  (`members()` asks one predicate); `builtin-prototype-keys.ts` reads it (`nativeObjectPrototypeMethod`, beside
  `nativeObjectStatic`).
- Realm: `beginRealm` adds kernel entries for the catalog's native Object.prototype methods when the realm description
  names them (`native-realm-requirements.ts`: a `js.object.get` whose key is that string constant, or the
  `prototype-method` contract) — on demand, so a program naming none (the prelude) keeps its bytes; the kernel's
  request check admits that behaviour with the catalog's name / length; the initializer defines each on
  Object.prototype; the entry's algorithm is `unreachable`. Rows (`native-source-objects.ts`):
  `js.object.prototype-method(selector) -> externref` (the entry's getter: the identity test and the primitive arm)
  and `js.object.has-own(o, key, selector) -> i32`; declarations and manifest lines.
- IR: `src/ir/program/dynamic-prototype-methods.ts` (new, sibling of `dynamic-object-statics.ts`, same shape: one
  expander, one row per method); the legalization's `call` case +2 lines; `dynamic-member-access.ts` arms per the
  table (C2-D1's has-or-abort and the function / primitive refusals lose the three keys: the duplicate removed). A
  program that reads one of the keys but creates no function value refuses by name (the function kind is not
  admitted there, so `typeof` would fold wrong).
- Dispatcher (`closure-method-body.ts`, and the apply body): fallback = abort for a closure-root value (every source
  closure has an arm, so what is left is a built-in), the TypeError otherwise. Only where the realm is populated, if
  the plumbing is small; else everywhere, with every differing prepared-bytes row explained and run.
- from-ast: no #7339 territory on the function-object lane (one predicate in `objectStaticsRealmOf`); net ≤ 0 lines,
  offset by moving code. program-source.ts untouched.
- Not reused: `buildObjectPrototypeMethodDefinition` (its ToPropertyKey / ToObject / Call0 bindings need the
  program); its HasOwnProperty step is the kernel's `findOwn`, which `has-own` calls.

### Proving programs (node's answer + a wrong twin, unless A = abort, R = refusal)

1. Own / inherited / absent / `defineProperty` data, accessor (`{get}`), non-enumerable — on a script var, a
   parameter, a `new C` instance (`this.a`), an `Object.create(p)` child; `propertyIsEnumerable` of each.
2. Keys `1`, `true`, `undefined`, none, `{toString(){ n++; return 'b'; }}` (n === 1), a throwing `toString` (caught).
3. Function receivers: `F.hasOwnProperty('prototype' | 'length' | 'name' | 'x')`, after `F.x = 1`;
   `F.propertyIsEnumerable('length')`.
4. `C.prototype.isPrototypeOf(new C)`, `({}).isPrototypeOf(c)`, `c.isPrototypeOf(c)`, `p.isPrototypeOf(1)`, two
   `Object.create` levels.
5. `Object.create(null)`: `typeof n.hasOwnProperty`; `n.hasOwnProperty('x')` → TypeError (caught).
6. Overrides: own method on a literal, a user prototype's, `o.hasOwnProperty = 5` then a call → TypeError (caught).
7. Values: `typeof`, `.length` 1, `.name`, `a.hasOwnProperty === b.hasOwnProperty`, `!== o.propertyIsEnumerable`,
   `.prototype` undefined, `x instanceof o.hasOwnProperty` → TypeError; A: `var h = o.hasOwnProperty; h('x')`, `new h()`.
8. Primitives: `(1).hasOwnProperty('x')`, `true.propertyIsEnumerable('x')`, `(1).isPrototypeOf({})`,
   `typeof (1).hasOwnProperty`; A: `'abc'.hasOwnProperty('length')`; A: a caught TypeError's `hasOwnProperty`.
9. Positions: loops observed across iterations, unused result with a side-effecting key, try/finally, sloppy and
   strict. R: a program that creates no function value.
10. Unchanged: `o.toString` / `o.valueOf` / `o.constructor` abort unless own; `o.__proto__` refuses.

Re-proofs (§6): the premise test gains the routes the new values open (`h.constructor`, `h.__proto__`, `h.call`,
`(1).hasOwnProperty.constructor`): each aborts or refuses, none yields a prototype. C2-D1 reads of every other
catalog key, the M1 / C2 tests and O1's define-property tests keep their answers.

### Quality criterion

The catalog is the only list of what is native; one expander module for the three methods, rows not copies; no second
ToPropertyKey (`stringOf`), no second own-property lookup (the kernel's `findOwn`), no second identity (the kernel
entry's singleton); from-ast and program-source end no larger than the base; every guard killed by a mutation or
listed.

## Slice P1 result (2026-11-22, branch `claude/7354-p1`; O1 incl. its main merge pulled in at ee1b478ce4)

### Built (as planned; deviations below)

- Catalog: `NATIVE_OBJECT_PROTOTYPE_METHODS` beside `NATIVE_OBJECT_STATICS`; `members()` asks one `isNativeMember`.
  `builtin-prototype-keys.ts` reads it (`nativeObjectPrototypeMethod`, `prototypeMethodSelector`) and its reachable-key
  sets no longer hold the three populated keys.
- Realm: kernel behaviour `object-prototype-method` (catalog name and length; the request check admits it); the
  initializer defines each on the realm's Object.prototype (`{writable, !enumerable, configurable}`); its algorithm is
  `unreachable`. `beginRealm` adds the entries only when `description.prototypeMethods` is non-empty: a `js.object.get`
  whose key is one of the names, or a `prototype-method` call (`NativeObjectAccessUse.constantKey`). Rows
  `js.object.prototype-method(selector)` (the entry's getter) and `js.object.has-own(o, key, selector)` (kernel `findOwn`).
- IR: `dynamic-prototype-methods.ts` (call expansion, identity test on the value the Get read, algorithms);
  `dynamic-member-access.ts` (primitive and error reads answer the realm's method; a read in a program without
  function values refuses by name); `selectorCall` / `prototypeMethod` builders beside `errorField` (which now uses
  `selectorCall`); flow rule: a method call on a dynamic receiver takes its arguments as carriers.
- Dispatcher: where the realm holds built-in methods, its last arm aborts for a closure-root callee (a built-in) and
  keeps the catchable "Value is not callable" TypeError for everything else (`buildClosureRootTest`, reused).
- from-ast: no #7339 territory on the function-object lane; −10 lines vs the O1 base (the descriptor-definition
  lowering moved to `open-object-carrier.ts` as `descriptorDefinitionValues`). program-source.ts unchanged.

### Deviations

- Error receiver: the read answers the realm's method (Error.prototype lacks the key, nothing can change it); the call
  then aborts (no own-property storage on the realm's error). Plan said "read aborts".
- The flow-rule exemption is general (any method call on a dynamic receiver), not keyed to the three names: that is
  what from-ast lowers for such a call (F2's Get + dispatcher with carrier arguments).
- `program-consumer.ts` +1 line (the dispatcher's flag), granted in the frontmatter (LOC + `materializePhysicalProgram`).
- No undefined/null `this` reaches the algorithm: a method call's Get throws first (tested: the argument is not
  evaluated); the value form goes to the dispatcher's abort. The chain's nullish arm is ToObject's TypeError text.

### Proof (local node 22; Node 25 not installed)

| test file (alone, VITEST_MAX_FORKS=1, heap 2048) | tests | exit |
|---|---:|---:|
| issue-7354-p1-own-property (new) | 18 | 0 |
| issue-7354-p1-method-values (new) | 14 | 0 |
| issue-7354-m-prototype-premise (+6 routes from a method value) | 18 | 0 |
| issue-3518-native-realm-requirements (native-id pin + the three methods) | 25 | 0 |
| issue-3518-native-builtin-functions / ordinary-object-callable-contracts | 36 / 55 | 0 |
| issue-7354-r-provider-census / m-refusals / o1-define-property / o1-create-and-define-properties | 117 / 44 / 30 / 18 | 0 |
| issue-7354-o4-member-read / f2-calls-through-values / c2-constructors | 16 / 10 / 20 | 0 |
| issue-3518-native-invocation-substrate | 41 of 45 | 1 — the same 4 fail on the base 4fc230872a |

- Sweep (`.tmp/p1-sweep.mjs`): 11 receiver kinds (literal, constructed, `Object.create(p)`, `Object.create(null)`,
  function expression, declaration, defined data/accessor/non-enumerable, number, Boolean, string, caught error) × the
  three methods, each program over 14 keys (or 8 `isPrototypeOf` arguments), every call wrapped so a TypeError is part
  of `out`: 33 programs / 396 cases: 26 programs right (wrong twins all throw), 7 abort (string and error receivers;
  `Object.create(function or error)` inside `isPrototypeOf`), 0 refused, 0 wrong, 0 invalid, 0 exceptions.
- Regression (216 probes: Object.prototype key reads × 6 receiver kinds × 2 positions, dispatcher calls, the flow
  rule, O1 statics, the P1 probes and sweep), base 4fc230872a vs head: OK→OK 45, ABORT→ABORT 70, REF→REF 23,
  ABORT→OK 54, REF→OK 22, REF→ABORT 2 (a getter-defined method, a string receiver); nothing right became anything else.
- `check:prepared-bytes`: 804/804 rows identical. Prelude + `assert(true);` sha256 5ffe9b7e… at base and head;
  compile 5.7–7.5 s both (load ~3). Prelude + a `hasOwnProperty` test: 6.4–7.6 s.
- Ordinary pipeline: 20 test262 files × default + standalone: 40/40 identical.
- Mutations (each alone, `.tmp/mutate.cjs`), all killed: dispatcher abort arm, identity test, populated-key filter,
  number/Boolean `false` arm, enumerable selector, flow exemption, the function-kind refusal (text), the ordinary walk,
  on-demand population, the primitive read arm.

### Sample (411 rows, real runner, default settings; row counts 87/107/102/115)

| | pass | fail | compile_error |
|---|---:|---:|---:|
| O1 | 34 | 6 | 371 |
| P1 | **46** | 13 | 352 |

- New passes (12): Object/create 15.2.3.5-4-164; defineProperty 15.2.3.6-2-12, -2-16, -2-32, -2-33, -3-216, -4-412,
  -4-423, -4-467; Object/prototype/hasOwnProperty 8.12.1-1_10, _12, _29. 17 mutated twins next to the originals (the
  last assertion flipped, plus the hasOwnProperty assertion where it was not the last) all FAIL in the same run; twins
  deleted, directory mtimes restored, `find test262 -newer marker` empty.
- New fails (7), all run-time aborts: getter/setter calls in the realm (O2: 15.2.3.5-4-186, -19, 15.2.3.6-4-568, -468,
  15.2.3.7-5-b-239) and `js.value.unsupported` (String lastIndexOf/replace rows). No row that passed or failed at O1
  changed.
- Top compile errors: `formatIdentityFreeValue … is written` 73, `Array` not in scope 46, module-init nested var 22,
  `+` operands 19, `TypeError` not in scope 17.

### Known limits / accepted debt

- **Detached calls abort.** `var h = o.hasOwnProperty; h('a')`, `(0, p.isPrototypeOf)(c)`, `new o.hasOwnProperty()` and
  `o.hasOwnProperty.call(...)` end at the run-time abort where JS throws a catchable TypeError or returns a value. Not
  a regression: the base aborted at the read. Closes with P2 (`call` / `apply`) and a callable built-in function
  object (a `(this, vector)` algorithm that can call back into the program).
- **The flow-rule change turns some compile refusals into run-time aborts**: a method call on a dynamic receiver
  takes its arguments as carriers, so e.g. `s.charAt(o.k)`, `s.indexOf(o.k)` compile and abort at the read of
  `charAt` / `indexOf` (String.prototype is not populated). No wrong value in 18 probes (review r1).
- A program that reads one of the methods but creates no function value refuses by name
  (`var o = {a: 1}; var out = typeof o.hasOwnProperty;`).
- A method call on a raw-externref receiver (`({}).isPrototypeOf(c)` or a `{…}` inside a closure) is from-ast's
  pre-existing "method call on externref not in slice 4" refusal / abort body.

### Review r1 (PR 7403): fixes

1. Blocker fixed: only the method-call shape runs the algorithm (`prototypeMethodOfCall` also requires the call's
   receiver to be the [[Get]]'s receiver); a detached call takes the dispatcher's abort. The nullish-receiver arm is
   gone: that receiver threw at its [[Get]], so the chain runs over the receiver's other kinds. Tests: the reviewer's
   two programs and the same two for `hasOwnProperty` / `propertyIsEnumerable` (p1-method-values).
2. One requirement builder in `beginRealm` for the bootstrap entries and the methods.
3. One id helper, `realmMethodId` (catalog); `nativeObjectStatic` and `nativeObjectPrototypeMethod` read one
   `nativeLength(parent, name)`.
4. That read is a Map built once (`NATIVE_LENGTHS`), not a catalog scan per member access.
5. The `materializePhysicalProgram` grant stays: `nativeSourceClosureCallableBindings` answers the source-closure
   owner's authenticated callable pack (compared by `requireNativeSourceClosureCallables`), and whether the realm holds
   built-in methods is the realm's fact; carrying it there would mix the two owners.
6. CI `quality` (s-script-var-define-target): the two pinned refusals of `o.hasOwnProperty('p')` on a script var now
   run where the program has a function value (node's answer and a wrong twin, plus a define-target var); without one
   the program refuses by the new name. f1b-function-objects pinned `a.hasOwnProperty` off a function as a refusal: it
   now reads Object.prototype's method (node agreement), and the refusal row moved to `a.valueOf`, a key the realm
   lacks. No other Prepared test pins one of the three keys (grep).

Verified after r1: p1-own-property 18, p1-method-values 20, m-prototype-premise 18, 3518-native-realm-requirements 25,
s-script-var-define-target 14, f1b-function-objects 9, 7339-own-property-rows 28 (each alone, exit 0); the 216
regression probes give the same transitions as before r1 (nothing right became anything else); prelude +
`assert(true);` sha256 e23f5dca… equals the O1 head it now sits on (8085f52549); gates exit 0 (LOC/func also against
main 42f2df53e2). Sample not re-measured: r1 changes only calls whose receiver is not the [[Get]]'s (detached calls),
and none of the 12 new passes has one (each was read); `check:prepared-bytes` not re-run.

## Slice G1 plan (2026-11-22, branch `claude/7354-g1` from `claude/7354-p1` eb98b057ec)

`Error`, the six NativeErrors and `Error.prototype.toString` as realm values on the Prepared path.

### What exists (read, plus probes on the base)

- Base probes (runner options, strict entry): `typeof TypeError` → `identifier "TypeError" is not in scope`;
  `new TypeError('m')` and `throw new TypeError('m')` → `unknown class "TypeError"`; `typeof undeclaredX` →
  "undefined" (node's answer); a read of `undeclaredX` → the not-in-scope refusal.
- Catalog: Object/Function rows only. Kernel entries: two bootstrap functions plus P1's methods, each a closure-root
  carrier with a bag (`createNull`, a null-proto `$Object`) and a separate `prototype` field; the realm's [[Get]] on a
  function already walks that field (`buildBuiltinFunctionLookup` / `ParentStep`), so a function whose [[Prototype]] is
  another entry is read correctly. Entry algorithms: undefined / ThrowTypeError / `unreachable`.
- Every realm TypeError (kernel, descriptor defines, the dispatcher's "Value is not callable", the legalization's
  `js.object.create-type-error`, promise resolution) is ONE function, `__new_TypeError` (`native-errors.ts`), which
  builds `$Error_struct` (tag −11, message, name, stack, brand). That struct type is `createErrorStructType`, shared
  with the legacy codegen (`registry/types.ts`), so it cannot change without moving ordinary-pipeline bytes.
- The `error` kind exists only where the program reads a catch binding (`readsCatchPayload`), answered by
  `js.object.is-error` (`ref.test $Error_struct`), `js.object.error-field` (name/message), and a row in every kind
  table (`TO_STRING_ARM` "error", `ADD_ROLE`, `TO_NUMBER_ARM` "nan", `MEMBER_ACCESS_ARM` "error", `ERROR_OWN_KEYS`,
  `ERROR_PROTOTYPE_KEYS`, aborts in the statics and P1's own-property arm, refused writes).
- Realm literals (`native-realm-literals.ts`) are taken from the WHOLE catalog: adding rows naively adds strings to
  every realm program. They must come from the families the realm holds.

### Design

1. **An error is an ordinary realm object** (`$Object`): [[Prototype]] `%XError.prototype%`, an own non-enumerable
   `message` only when one was given, and an `[[ErrorData]]` bit in `$Object.flags` (0x800 is free in both the realm's
   and the legacy encodings). Every realm operation (get, set, has, has-own, inherits, define, create-with-prototype)
   is already total over `$Object`; a bag on `$Error_struct` would be a second object layout every one of them must
   branch on, and would change the legacy struct. The bit is what `Object.prototype.toString` reads (`[object
   Error]`); prototypes do not carry it (ES2015+).
2. **When.** The realm holds the error family, and builds its own TypeErrors as such objects, iff the program can
   observe an error: it reads a pristine error global (a `js.object.intrinsic` use naming a family id) or binds a catch
   payload (an IR `try` with `payloadSlot >= 0`; a rethrow-only catch is included, harmlessly). Otherwise
   `__new_TypeError` keeps the struct: no code of such a program reads a thrown value, and the Prepared artifact
   exports no tag, so the payload is unobservable. Granularity: Error + TypeError + `Error.prototype.toString` for a
   catching program; each other NativeError (with Error) when named. Literals per held family.
3. **One getter** `js.object.intrinsic(selector) -> externref` replaces P1's `js.object.prototype-method`: the selector
   indexes one catalog list of realm function values (the three Object.prototype methods, the seven constructors,
   `Error.prototype.toString`). Same `js.object` family on purpose: a `js.realm.*` family needs its own manifest
   feature/provider lists for one row. The realm populates from the constant selectors it is called with.
4. **Kernel.** New entry behaviors `error-constructor` (constructible; own `prototype` {!w,!e,!c} → its prototype
   object; [[Prototype]] `%Function.prototype%` for Error, `%Error%` for a NativeError; algorithm `unreachable`, so the
   value form aborts as in P1) and the toString method entry. The initializer creates each held prototype
   (`%Error.prototype%` → Object.prototype; a NativeError's → `%Error.prototype%`) with `constructor`, `name`,
   `message` "" and (Error only) `toString`. One kernel function `createError(selector, message)` (create + bit +
   `message` defined only if not undefined) serves the contract `js.object.create-error` and, in the error-objects
   mode, is what `__new_TypeError` calls: one creation path for realm and program errors.
5. **Construction at the site** (`src/ir/program/dynamic-error-constructors.ts`, sibling of
   `dynamic-prototype-methods.ts`): `X(m)` / `new X(m)` lower as F2's call / C2's `dyn.construct` through the
   identifier's value; the legalization recognises a call or construct whose callee is defined by
   `js.object.intrinsic(<ctor>)` (the identifier read proved the pristine global) and expands §20.5.1.1: arguments
   already evaluated left to right (front end); `undefined` → `create-error(sel, undefined)`; else `stringOf` once (a
   message object's `toString` runs once, a throw is catchable), then `create-error(sel, s)`. Creating the object
   before ToString is unobservable. Any other callee (`var E = TypeError; new E()` through a script var) is the
   dispatcher's built-in abort.
6. **`Error.prototype.toString`** (§20.5.3.4) is one realm contract `js.object.error-to-string(o)`: name (undefined →
   "Error"), message (undefined → ""), the empty-string rules; a name/message that is neither a string nor undefined
   is the realm's abort (a program wrote a non-string; never a wrong text). Called where the IR proves the method is
   the intrinsic: (a) OrdinaryToPrimitive's `toString` step — `method === intrinsic(toString)` ? contract :
   dispatcher (so an override `Error.prototype.toString = …` and `TypeError.prototype.name = "X"` are seen); (b) the
   method call `e.toString()`, a fourth row of P1's call expansion. When P2 lets the dispatcher call built-ins, the
   same function becomes the entry's `(this, vector)` algorithm and both identity rows go.
7. **IR kinds.** The `error` kind is deleted from every table; a caught value is the object kind (admitted where the
   program builds objects or reads a catch binding); `carrierKindOf` answers object for `create-error`. ToString /
   ToNumber / `+` of an error take the object's ToPrimitive. `dyn.object_tag`'s object arm tests `is-error` (now the
   bit) where the family is held. P1's error abort arms, the statics' error abort, the refused error writes and
   `ERROR_OWN_KEYS` / `ERROR_PROTOTYPE_KEYS` / `js.object.error-field` go.
8. **Identifier read.** `identifier-read.ts` gains `realm-intrinsic` (pristine global, catalog marks the constructor
   native, function-object lane), lowered to the getter; `typeof TypeError` folds through the function kind. `new X`'s
   dynamic-callee gate and the flow rule (arguments as carriers) accept it. `source-plain-objects` counts such a read
   as creating a function value and objects.
9. **Premise change, `instanceof` / `isPrototypeOf`.** With `%Error%` a value, a NativeError constructor's chain holds
   an obtainable object, so "a function's chain holds no program value" (C2, P1) is false there. Where the family is
   held: a function-kind left operand / argument answers `false` unless the prototype / receiver is `%Error%`, which is
   the run-time abort (only `F.prototype = Error` or `Error.isPrototypeOf(TypeError)` reach it). The exact answer (the
   kernel's heterogeneous `ParentStep` inside `inherits`) is left to the slice that needs it.

### Stays refused / aborts (each sound)

- A second argument (`cause`, ES2022 options) refuses by name: InstallErrorCause would read a property of it.
- The value form (`E(m)`, `new E()` through a variable, `.call` / `.apply`): dispatcher abort, as P1.
- Shadowed or assigned names (`function TypeError(){}`, `TypeError = …`, `globalThis.TypeError = …`): not pristine,
  existing rules (refusal by name).
- V8-only keys: in a program holding the family, a constant-key read of `stack`, `captureStackTrace`,
  `stackTraceLimit`, `prepareStackTrace` refuses by name (specification: absent; V8: present).
- **Not in G1: ReferenceError at GetValue.** An "unresolved" identifier on this path is often a lib global the path
  does not implement (`Array`, `Math`), and the lib is not the exact list of globals (`Iterator` missing, DOM names
  present): a ReferenceError there would be a wrong answer. Sound only with a list of standard globals; own slice.
- Runtime negatives (`negative: phase: runtime`) stay unread on this lane (no exported tag; PR 7401's renderer).

### Placement, removals, size

- Catalog rows + one native list (`native-realm-catalog.ts`); kernel behaviors and prototype seeding in a new
  `error-intrinsic-bodies.ts` beside `builtin-function-bodies.ts`; contracts in `native-source-objects.ts` (+3, −2);
  requirements (`native-realm-requirements.ts`: families, payload binding); literals per held family.
- IR: `dynamic-error-constructors.ts` (new); `dynamic-prototype-methods.ts` generalised to the realm's methods (one
  more row); kinds / chains / member access lose the error kind (net negative); identifier-read +1 arm.
- from-ast: +3 lines (one `case`, the `new` gate), offset by moving code out; ends ≤ base.
- Estimate: src +600 / −250, tests ~700.

### Test plan (node agreement + wrong twin each; A = abort, R = refusal)

The brief's hazards, one test each: `e.constructor === TypeError` for realm-thrown (`o.x` on a null parameter) and
program-made errors; `instanceof Error` across the family, `instanceof RangeError` false for a TypeError;
`hasOwnProperty('message')` for none / `undefined` / `""`; a counting and a throwing message `toString`;
`TypeError.prototype.name = "X"` then `String(e)`; an `Error.prototype.toString` override used by `"" + e`; `typeof`,
`.length`, `.name`, `X.prototype.constructor`, `isPrototypeOf` between prototypes; `typeof undeclared`;
`f(a(), undeclared)` (stays the refusal: pinned as such); `throw new TypeError("m")` caught and inspected;
`Object.prototype.toString.call(e)`; `assert.throws(TypeError, …)` through the real harness, passing and failing
(wrong constructor). R: `cause`, shadowed / assigned names, `e.stack`. A: value form,
`F.prototype = Error; TypeError instanceof F`. Pins that move: M2 rows of m-refusals, x-dynamic-throw, o3, P1's error
receiver, C2's caught-error rows.

## Slice G1 result (2026-11-22, branch `claude/7354-g1`; P1 incl. its main merge pulled in at 71dbeb5d21)

### Built (the plan; deviations below)

- **Catalog** (`native-realm-catalog.ts`): rows for `%Error%`, the six NativeErrors, their prototypes and
  `%Error.prototype.toString%`, each `heldWith` its constructor; `NATIVE_ERROR_CONSTRUCTORS`; one ordered list
  `NATIVE_VALUE_INTRINSICS` (P1's three methods, the seven constructors, toString), whose index is the selector.
- **What a realm holds** (`native-realm-requirements.ts`): `description.intrinsics` replaces P1's `prototypeMethods`;
  the Error family is held where a `js.object.intrinsic` use names a member or any IR `try` binds its payload
  (`heldErrorConstructors`); `heldCatalogRows` is the one answer to "which catalog rows does this realm hold", read by
  the realm's literals (`native-realm-literals.ts`: the general rule, every family) and the public catalog issuer.
- **Kernel**: family members are entries of behavior `native` (algorithm `unreachable`; constructors constructible;
  a NativeError's [[Prototype]] field is `%Error%`'s singleton); the requirements carry their own properties and the
  family's prototype objects (`native-realm-families.ts` reads them from the catalog; both fields absent for a realm
  without a family, so such a realm's requirements are unchanged); `realm-family-bodies.ts` creates the prototypes in
  the initializer, seeds the catalog properties, and builds `createError(message | null, selector)` (OrdinaryCreate,
  the [[ErrorData]] bit 0x800, own `message` only when given).
- **One error representation per program**: `createError` is reserved before the invocation substrate where the
  family is held, and `__new_TypeError` (`native-errors.ts`) then delegates to it; elsewhere it keeps `$Error_struct`.
- **Contracts**: `js.object.intrinsic` (replaces `js.object.prototype-method`, which is gone), `js.object.create-error`
  (binds the kernel's), `js.object.error-to-string` (§20.5.3.4 over the kernel's [[Get]]; a cons of the parts),
  `js.object.is-error` (now the bit); `js.object.error-field` is gone.
- **IR**: the `error` kind and every row and arm of it are gone (`ERROR_FIELD`, `ERROR_OWN_KEYS`,
  `ERROR_PROTOTYPE_KEYS`, the "error" ToString/ToNumber/`+`/member-access rows, the statics' and P1's error aborts, the
  refused error writes); a caught value is the object kind. `identifier-read.ts` `realm-intrinsic`
  (`realmIntrinsicRead`) → a front-end helper the legalization writes as `js.object.intrinsic`;
  `dynamic-error-constructors.ts` (construction at the call / construct site, and `functionChainAnswer`, the premise
  guard); `ordinary-to-primitive.ts` recognises Error.prototype.toString by identity; P1's call expansion has a fourth
  row (`e.toString()`); `dyn.object_tag` tests the bit; V8's own keys refuse by name (`V8_ERROR_KEYS`).
- **Front end**: from-ast 17346 → 17343 (base P1 tip): the identifier `case` (+2) is paid for by moving
  `bindingHoldsDynamic`'s global test into `function-object-lowering.ts` (`readsDynamicGlobal`, which also answers the
  realm intrinsic, so `new X`, `instanceof X` and conditional arms need no line of their own). `TypeError(m)` goes
  through `lowerPreparedValueCallee`. The flow rule's exemption is `realmBuiltinOperand` (O1's, extended).

### Deviations from the plan

- **A program whose only function values are built-ins** (it names `TypeError` but creates no function expression):
  the function kind is admitted (`holdsErrors`), but no dispatcher exists. ToPrimitive's call of a non-identity method
  and `new` through a value are the run-time abort there (`builtinOnly`, `dynamicConstruct`'s `builtin` arm); any other
  call through a value refuses by name as before. The function test uses the realm's own closure root
  (`program-consumer.ts` reads it off the realm's inventory, which equals the source closures' where they exist), and
  is constant false where the program has no closure root at all (a catch binding without a realm).
- `js.object.intrinsic` stays in the `js.object` family (lead-approved).
- The instanceof / isPrototypeOf guard is the `%Error%` abort (lead decision), stated in `dynamic-error-constructors.ts`.

### Condition A — every producer of a thrown error, and its treatment where the family is held

| producer | where | treatment |
|---|---|---|
| `__new_TypeError` (substrate) | kernel failures, descriptor defines (DefinePropertyOrThrow), the dispatcher's "Value is not callable", the legalization's `js.object.create-type-error` (nullish member access, strict PutValue, ToPrimitive, `new`/`instanceof` TypeErrors) | converted: delegates to `createError` |
| program `new X(m)` / `X(m)` | source | `js.object.create-error` |
| IR-level runtime `__new_TypeError` / `__new_ReferenceError` (from-ast TDZ guard, `throw-type-error.ts`, function-object-lowering's legacy call path) | source lowering | a program that reads a catch binding refuses any throw of a non-carrier value (`refuseUnadmittedThrows`); probes: TDZ, destructuring null, `in` on a number end at a refusal / abort body, never at a caught struct |
| `vector-grow-store` null guard | argument vectors | throws a null payload, not an error (pre-existing; a null vector is an invariant failure) |
| promise resolution's TypeError (`native-promises.ts`) | self-resolution | unreachable on this lane: no promise is a dynamic value and `Promise` is not held (C2 known limit); a program that could reach it needs a promise value first |
| user `throw v` | source | the value itself |

Where the family is **not** held no code reads an error: the trigger is any bound catch payload or any named family
member, and a thrown value reaches a program only through a catch binding (promise reactions are not admitted).

### Condition B — realm messages

`e.message` of a realm TypeError was readable before G1 (the error kind's field) and reads the same text now. Texts
that differ from V8's: "Value is not callable" (V8: "x is not a function"), "Value is not a constructor", "Cannot
assign to read only property 'k' of object" (V8 adds the object). `Cannot read properties of null (reading 'x')`
matches. A program comparing such a text disagrees with node on the base and on the head alike (probe
`not-callable-msg`, both trees); test262 never compares a message text.

### Not in G1: ReferenceError at GetValue

An "unresolved" identifier on this path is often a standard global the path does not implement (`Array`, `Math`),
and the TypeScript lib, which stands in for the list of globals, is not that list (`Iterator` is missing, DOM names are
present): throwing a ReferenceError there would answer wrong. It needs a list of the standard globals; its own slice.

### Found by the suites and the sample, fixed here

- The three narrow fixes of the deviations above (no dispatcher: `builtinOnly` and `dynamicConstruct`'s built-in arm;
  the function test without a closure root; the kernel's optional family fields).

- **Strict `F.caller = 1` silently wrote an own property** (F1b's function write; JS throws: Function.prototype's
  `caller` / `arguments` setter is %ThrowTypeError%). Unobservable while `assert.throws(TypeError, …)` could not run;
  the sample's `13.2-19-b-3gs` turned it into a wrong-answer fail. Now a member write of either key on a value that may
  be a function refuses by name (`FUNCTION_PROTOTYPE_ACCESSOR_KEYS`, from the catalog, beside Object.prototype's).
  Base: the probe answered `none` where node throws; head: the named refusal (test in g1-refusals-and-aborts).

### Found, not fixed (pre-existing on the base, measured there)

- `const c = 1; c = 2;` throws out of `compile()` (`assignment to non-slot binding "c" — mutation pre-pass should have
  detected it`), base and head.
- A closure that writes a script `var` (`n++`, `s += 'a'` inside a function a value calls) ends at the run-time abort,
  base and head (the G1 tests count through an object property instead).
- `"" + new X()` (a `new` expression as a `+` operand) refuses (`'+' operands not provably … string/unprovable`): the
  carrier analysis has no `new` leaf (C2's constructs too); through a variable it runs.
- `tests/issue-7354-o-objects` "refuses what the later steps build" fails on the base too.

### Proof (local node 22; base = main 111b28ceaa, P1 included, `git archive` copy)

| test file (each alone, VITEST_MAX_FORKS=1, heap 2048) | tests | exit |
|---|---:|---:|
| issue-7354-g1-error-values (new) | 14 | 0 |
| issue-7354-g1-refusals-and-aborts (new) | 14 | 0 |
| issue-7354-g1-assert-throws (new, the real harness) | 5 | 0 |
| m-refusals (M2 constructor/toString/write → node agreement; `stack` → by name; G45 `new TypeError` runs) | 43 | 0 |
| c2-constructors (a built-in constructor runs), c2-this (a method on a caught error) | 19 / 18 | 0 |
| p1-method-values (a caught error's own `message`), o1-create-and-define-properties, o2-object-values (`namesErrors`) | 20 / 17 / 13 | 0 |
| t2-typeof-standard-globals, ty-typeof-comparisons (the Error names leave the refused list) | 20 / 61 | 0 |
| m-prototype-premise (+4 routes from the family, each aborts) | 22 | 0 |
| 3518 ordinary-object-callable-contracts (the new contracts), native-realm-requirements (count pin deleted, #7380), native-object-realm-declarations (held rows), native-builtin-functions | 61 / 25 / 21 / 36 | 0 |
| every other issue-7354 file (51), 3518 object-realm-algorithm-bodies, 7363, 7331, prepared entry / runtime, 7188 (run before the three narrow fixes below; o3, f1b writes / objects, f1 function-kind and the G1 files re-run after them) | all | 0 |
| 3518 native-invocation-substrate | 41 of 45 | 1 — the same 4 fail on the base |
| 7354 o-objects | 12 of 13 | 1 — the same 1 fails on the base |

- **Probes** (433 programs, each against node in a fresh realm, wrong twin for every OK; 160 generated G1 programs
  — 7 constructors × 8 messages × new/call, the constructors as values, the realm's TypeError in 8 contexts,
  Error.prototype.toString over 9 name/message pairs, rethrows, writes — P1's 216 regression probes, 57 hand ones),
  base → head: REFUSED→OK 186, OK→OK 123, ABORT→ABORT 68, REFUSED→REFUSED 44, REFUSED→ABORT 6, ABORT→OK 4,
  EXC→EXC 1, REFUSED→WRONG 1. Nothing right became anything else; 0 invalid Wasm; 0 twin failures. The one WRONG is
  `e.message` of the dispatcher's "Value is not callable" (Condition B: the same text on the base); the EXC is the
  pre-existing const assignment. REFUSED→ABORT: the three designed aborts, a closure writing a script var, and two
  functions whose refusal is their abort body (destructuring, `in`).
- **`check:prepared-bytes`** (804 rows) base vs head: **801 identical**. 3 differ, each a program that binds a catch
  payload (so the realm holds Error + TypeError + toString); run on both trees with the same outcome: row 445
  (`f(3)` = 6 both; 23,295 → 27,593 B), 532 (returns both; 23,684 → 26,099 B), 533 (returns both; 23,412 → 25,827 B).
  Every program naming no family member and binding no catch payload is byte-identical (the realm literals follow
  the held rows; the kernel requirements carry no family field).
- **Ordinary pipeline**: 20 test262 files (Error.prototype.toString, NativeErrors, Error, instanceof, try) × default
  and standalone: 40/40 identical.
- **Prelude** (strict entry, runner options, 3 compiles each, load ~2.5): prelude + `assert(true);` base 77,429 B
  (sha e23f5dca…, as P1 recorded) 5.2–7.7 s → head 81,397 B (+3,968 B, +5.1 %: the harness binds `thrown`) 5.0–6.4 s;
  prelude + one `assert.throws(TypeError, …)` row: base refused (`TypeError` not in scope) → head 81,986 B, 4.8–5.2 s.

### Sample (411 rows, the real runner, default settings; both trees run here)

| | pass | fail | compile_error |
|---|---:|---:|---:|
| base (main 111b28ceaa) | 61 | 19 | 331 |
| G1 | **71** | 27 | 313 |

- New passes (10): Object/create 15.2.3.5-1-1, -4-43; Object/defineProperty 15.2.3.6-1-3, -3-199, -4-17, -4-20,
  -4-379, -4-436, -4-493, -4-508 — every one stopped at `TypeError` / `SyntaxError` not in scope. 16 mutated twins next
  to the originals (`assert.throws(TypeError` → `RangeError` where present; the last `assert.sameValue`'s expected
  value flipped) all FAIL in the same run, the 10 originals pass; twins deleted, directory mtimes restored,
  `find test262 -newer marker` empty, no `*g1twin*` left.
- New fails (8), all run-time aborts in a function the path cannot lower (Function.prototype's `caller` read and,
  after the fix above, write; `JSON`; `arguments`; a compound member write; a nested statement) or a getter call (O2,
  11.13.1-2-s). No row that passed or failed on the base changed.
- Top compile errors now: `formatIdentityFreeValue … is written` 73, `Array` 46, module-init nested var 22, `String`
  14 + 13, RegExp 14, `Object` 8; no Error-family name is left among them.

### Not verified

- Node 25 (not installed); no adversarial review agent was run (the lead holds the PR).
- The full 3526/3518 pin suites beyond the files listed; the ordinary pipeline beyond the 20 files.

### Review r1 (PR 7411): fixes

1. **B1, one predicate.** The IR's "names an Error constructor" (`source-plain-objects.ts` `namesErrors`) and the
   realm's "holds the family" were two spellings of one question and disagreed: a parameter, local, label, function
   expression name or shorthand spelled `TypeError` made the IR admit the family while the realm held none, and
   `compile()` threw `missing literal "Error"`. Now `namesErrors` asks the same pristine test the read asks
   (`pristineBuiltinGlobal`), and the realm derives the family only from what the IR emitted
   (`heldErrorConstructors`: a family `js.object.intrinsic`, `create-error` / `error-to-string`, or a bound catch
   payload) — it no longer reads the IR's answer at all. Tests: `g1-spelled-names` pairs each shape (parameter, local
   var, label, function-expression name, shorthand, catch binding `Error`, object key, a catch in a function the path
   cannot lower) with every family consumer (`String()`, `+` both sides, `instanceof`, a caught value), node + twin.
2. **S1.** A script-level `var X;` without an initializer, X a global the realm serves (`REALM_GLOBAL_NAMES`: the
   catalog's plain-name aliases), reads the built-in in JS (the var binds the existing global property) but the IR's
   undefined slot here: a wrong value. It refuses by name (`scriptVarOfRealmGlobal`, checked once in the legalization's
   module-init group). With an initializer the var replaces the built-in where it runs, which the path lowers right, so
   it stays admitted. Known limit, pre-existing: a read of such an initialized var before its initializer runs.
3. **import-cycles.** The IR reads the catalog only through `builtin-prototype-keys.ts` (`errorConstructorId`,
   `errorConstructorSelector`, `realmIntrinsicSelector`, `objectPrototypeMethodId`, …); `native-realm-families.ts`
   takes the held rows instead of importing the IR. No `import-cycles-allow`.
4. Nits: the stale `prototypeMethodSelector` comment is gone with the function; `kernelGetInto`
   (`source-object-bodies.ts`) is the one [[Get]]-and-status-check, used by `buildSourceObjectGetDefinition` (same
   bytes) and by Error.prototype.toString's `part`.

Verified after r1 (main 9dfb1252a7 merged, H2 included):

- Reviewer probes `.tmp/rvg1/b*.json` (443), pre-r1 head 1ab908ba02 → head: OK→OK 177, REFUSED→REFUSED 150,
  ABORT→ABORT 69, WRONG→REFUSED 16 and EXC→REFUSED 3 (bare script vars, by name), EXC→OK 11 (every B1 program now
  node's answer), EXC→ABORT 2 (`finally-order`: the base aborts too), REFUSED→OK 1 / REFUSED→ABORT 1 (`sub-proto-create`
  / `sub-call`: H2 admits the written function declaration; `Error.call(this, m)` is the designed `.call` abort).
  Nothing right changed; no WRONG, INVALID or EXC left.
- The 433 G1 probes: the same transitions against base 111b28ceaa as before r1, except
  `r:read.fn.constructor` ABORT → a refusal by name (main's H2). The one WRONG is still Condition B's message text.
- Tests (each alone): the four g1 files (5/14/14/17), every moved pin and every 7354 c2/f1/f1b/fa/h2/m/o1/o2/p1/t2/ty
  file, 3518 realm-requirements / object-realm-declarations / callable-contracts / builtin-functions /
  compiler-boundaries: all exit 0.
- `check:prepared-bytes` vs main 9dfb1252a7: 801/804 identical; the same 3 catch-payload rows as before (445, 532,
  533), byte-identical to the pre-r1 head. Prelude + `assert(true);` and + `assert.throws`: same sha at pre-r1 and head.
  Ordinary pipeline, 20 files × 2 targets: identical to main.
- Sample not re-run: r1 changes only programs with an Error-spelled non-global name or a bare script var of a realm
  global; none of the 411 rows has either (grep), and the prelude compiles to the same bytes.

### Share the immutable string/value inventory across planners

Each collector call traverses both prepared views and records every instruction occurrence. Several planners hold these records at the same time. Reuse one inventory per producer-issued immutable program and selected projection through the existing settled-check mechanism. Custom descriptive inputs always take a fresh traversal. A host prototype change also requires a fresh traversal because an inherited getter or mutable value can change what the compiler observes. Mutable inputs must be traversed again and foreign projections must still fail. Keep enumeration order, allocation evidence, and the runtime emission interface intact.

A focused standalone integration comparison on 2026-11-25 exercised ES5 15.2.3.6-4-299-1.js with the original harness. With the nested-declaration candidate, the standard 512 MiB worker exhausted its heap on both attempts. With inventory reuse, the same worker limit produced a verified IR pass. The integration candidate also includes declaration and arguments support, so this result alone does not establish a main-branch test262 score change.

## Slice O2 plan (2026-11-22, branch `claude/7354-o2` from `claude/7354-p1` eb98b057ec)

Accessor properties on the Prepared path: the realm calls a source getter / setter.

### Reproduced (strict entry, runner options, real prelude, base eb98b057ec)

| row | stops at |
|---|---|
| `Object/create/15.2.3.5-4-161.js`, `-186.js` | `unreachable` in the ToPropertyDescriptor helper (`getOrAbort`: the descriptor object's own `value` / `writable` is an accessor) |
| `Object/create/15.2.3.5-4-19.js` | `unreachable` in `js.object.descriptors-define` (`getOrAbort` on `props.prop`, an accessor) |
| `Object/create/15.2.3.5-4-233.js`, `defineProperty/15.2.3.6-4-568.js` | `unreachable` in the `js.object.get` adapter (kernel status 3: a source getter) |
| `defineProperty/15.2.3.6-4-468.js`, `defineProperties/15.2.3.7-5-b-239.js` | `unreachable` in the `js.object.set` adapter (a setter) |

Probes (base): a defineProperty getter read, an inherited getter, a setter write, a descriptor whose field is a
getter all abort; `get: undefined` reads `undefined` and its descriptor is right. An object-literal accessor refuses
(`callable … object-getter … is not dispatchable`: its closure takes the checker's typed signature, `number` → f64,
because it sits in a "descriptor literal"); a dead literal is dropped. `o.x += 1`, `o.x++` refuse at top level
(`'+=' is capability-deferred`, `PostfixUnaryExpression`) and abort inside a function, accessor or not.

### What exists

- **The one "a getter is a source closure" point** is the kernel's `buildBuiltinFunctionEntryGet`
  (`builtin-function-property-bodies.ts`): null getter → `undefined`; a built-in function → `callVector` (the kernel's
  own [[Call]], receiver = the original object); a source closure → status 3 ("needs a mixed callable owner:
  `callVector` has no source arm yet"). The kernel `get` (`builtin-function-prototype-bodies.ts`) and `getOwn` share
  it, with the walk's original receiver. Every realm read goes through it: the `js.object.get` adapter (traps on
  status > 2), `getOrAbort` (traps on 3; ToPropertyDescriptor's six field reads, defineProperties' per-key read),
  OrdinaryToPrimitive's method reads.
- **set**: the `js.object.set` adapter (`source-object-bodies.ts`) finds the entry (own, else the kernel `lookup`);
  an accessor without a setter answers false (strict TypeError at the site, O1), one with a setter is `unreachable`.
- **ToPropertyDescriptor** reads each field by `has` (status 1) then the kernel `get` on the descriptor object, with
  the descriptor as receiver: inherited and accessor fields are already in the right order; only the getter call
  traps. defineProperties snapshots the keys, re-reads each key's `ownDescriptor`, converts every descriptor into a
  vector, then defines (no partial define on a throw). GOPD (`ownDescriptor`) and `has-own` never read a value.
- **define**: `js.object.descriptor-define` / `descriptors-define` define accessors through the descriptor pack's
  `defineAccessor` (ValidateAndApplyPropertyDescriptor, O1's 2,808-case sweep). The object literal lowers each
  `get x` / `set x` to `js.object.define-accessor(o, key, get|null, null|set, 310|566)` (from-ast
  `lowerOrdinaryObjectLiteral`; the pack merges the halves), but **the realm has no row for that contract**
  (pinned as a named gap in `issue-3518-ordinary-object-runtime-providers`).
- **F2's dispatcher**: `__call_fn_method_N(receiver, callee, …args)` (`native-invocation.ts`, body
  `closure-method-body.ts`): installs `__current_this`, pads / drops by arity, restores on return and throw, its last
  arm the "not callable" TypeError (P1: abort for a built-in). Reserved per arity the program's `js.closure.call:N`
  occurrences name (`native-invocation-requirements.ts` `methodArities`); a dynamic callee selects every source unit
  (`native-source-closure-callables.ts`) and requires each to be dispatchable (`dynamicCalleeGaps`).
- **Binding order**: program-consumer reserves the invocation pack (line ~1335) **before** `reserveNativeRealmKernel`
  (~1349) and fills both after the index freeze, so the kernel can name the dispatcher's handles; no cycle.
- `native-getter-invocation-requirements.ts` (C1, #3518): a getter proven by its static allocation (a
  `define-accessor` whose half is a `closure.new`, with a later `js.object.get`) adds method 0 and selects that unit.
  Its consumer `native-object-get.ts` is reached only from test fixtures; on this lane the C1 uses only add arity 0
  and unit selection, which the realm use below subsumes. Not reused, not removed (its #3518 fixtures pin it).

### Design

1. **The realm's call of a source accessor is F2's dispatcher, arity 0 for a getter and 1 for a setter.**
   The kernel gets one builder, `buildAccessorCall(callee, receiver, args)`: `match(callee) == sourceClosureOrdinal ?
   method:N(receiver, callee, …args) : callVector(callee, receiver, vector(args))`. The entry-get's status-3 arm
   becomes the arity-0 call (status 1); the set adapter's `unreachable` becomes the arity-1 call, result dropped,
   answering true. One path in both; the realm holds no entry reference across the call (entry-get returns the
   call's result; set returns true after it), so a getter that deletes, redefines or grows the object is safe.
   A stored half is null, a built-in or a source closure (ToPropertyDescriptor's IsCallable; to be confirmed for
   `get: undefined`, which reads `undefined` today, before relying on it), so the two arms are total.
2. **`getOrAbort` is removed**: with a source getter now status 1, the kernel `get` on a served object answers
   1 or 0/2 (absent), never 3 (`lookup` returns 3 only for a carrier that is neither an ordinary nor a function
   object, and both callers pass a served object). It becomes a plain [[Get]] (`getField`). The `js.object.get`
   adapter keeps its `> 2` test for that unknown-carrier state only (doc corrected).
3. **Requirement** (`native-invocation-requirements.ts`): a program that calls an accessor-defining contract
   (`js.object.define-accessor`, `descriptor-define`, `descriptors-define`; one list beside the declarations in
   `ordinary-object-callables.ts`) and has source closures sets `realmAccessors`: method arities 0 and 1, every
   source unit selected and required dispatchable (the same rule as a dynamic callee, one predicate
   `callsDynamicValues(requirements)` read by the gaps and by `native-source-closure-callables.ts`). It is not a
   `use` (uses are call-site ABI bindings). No source closure → no getter can exist → nothing reserved.
4. **Kernel dependency**: `reserveNativeRealmKernel` takes the invocation pack; when `realmAccessors`, the kernel
   dependencies carry `accessorCalls: { get: method:0, set: method:1 }` (authenticated with the others) and the
   kernel operands carry the two handles. Absent → the kernel and set bodies are today's bytes.
5. **Object literal**: (a) a realm row `js.object.define-accessor` binding the descriptor pack's `defineAccessor`, as
   `define-data` binds `defineData`; (b) on the native dynamic lane an accessor declaration (and a function
   expression or method inside a literal that has one) takes P's all-dynamic signature
   (`sourceDynamicClosureSignature` in `source-dynamic-contracts.ts`; its `ownedByDescriptorLiteral` exclusion stays
   only off this lane); from-ast's guard `ts.isFunctionExpression(expr) ?` widens in place (0 lines); (c)
   `emitFunctionObjectInit` gives an accessor its function object (`length` 0/1, `name` `get x` / `set x`, not a
   constructor); its "an accessor is never a value" premise is false since O1's GOPD.
6. Programs whose closures are not dispatchable (a typed TS signature) now refuse by name when they also call an
   accessor-defining static: the realm could reach them. Measured on the probe set before building.

### What stays refused / aborts (each sound: no wrong value)

- `o.x += v`, `o.x++` on any member: pre-existing refusal / abort (compound member assignment), not accessor-specific.
- A built-in function as a getter/setter: `callVector` runs the kernel's algorithm (Function.prototype → undefined,
  %ThrowTypeError% → TypeError, an Object.prototype method → its `unreachable`, P1).
- Accessors on the realm's error object and on primitives' wrappers: no own storage (unchanged aborts).
- `__defineGetter__` / `__lookupGetter__`: Object.prototype keys the realm lacks (unchanged C2-D1 abort/refusal).
- A closure that is not dispatchable in a program with an accessor-defining static: named refusal.
- Non-extensible targets: not expressible yet (O3).

### Placement, reuse, removals, size

- New code: `buildAccessorCall` beside `buildBuiltinFunctionEntryGet` (the realm's one [[Call]] dispatch by callee
  kind); the requirement flag in `native-invocation-requirements.ts`; the accessor-defining list in
  `ordinary-object-callables.ts`; the kernel dependency in `native-builtin-functions.ts` / `native-realm.ts`;
  program-consumer passes the pack on an existing line. G1's files are not touched except
  `native-source-objects.ts` (one row + the set row's operands).
- Removed: the entry-get status-3 arm (where the dispatcher exists), `getOrAbort` and its two call sites' trap, the
  set adapter's setter `unreachable`, the define-accessor named gap.
- Expected: ~+110 / −30 in src; from-ast 0; program-source 0; program-consumer 0. Tests: one new file
  `issue-7354-o2-accessors.test.ts`; the 3518 runtime-providers gap pin moves.

### Test plan

- Behaviour tests against node, each with a wrong twin, for every hazard in the brief: receiver of an inherited
  getter; one getter call per read (counter); `o.x = v` value; getter-only write strict TypeError / sloppy silent;
  throwing getter caught through `get`, defineProperty, create, defineProperties (no partial define); getter that
  deletes / redefines / grows the object read or defined; hasOwnProperty / propertyIsEnumerable / GOPD never call
  it; GOPD shape and identity; accessor returning a function called as a method; accessors on functions and on a
  constructor's prototype with `new`; prototype setter intercepting `child.x = v`; child data shadowing; every
  accessor↔data redefinition (configurable / non-configurable); `get: undefined`; non-callable `get` TypeError;
  descriptor fields as accessors / inherited (order counted); object-literal get/set merge, enumerable,
  configurable, `length` / `name` / no `prototype`. Compound forms pinned as their refusal / abort.
- O1's 2,808-case sweep regenerated with a counting-getter column; ≥150 probe programs base vs head; the seven rows
  plus the 411-row sample through the real runner with mutated twins; `check:prepared-bytes` with every difference
  explained; prelude + `assert(true);` hash unchanged; ordinary pipeline 20 files × 2 targets identical; mutations of
  each new arm.

## Slice O2 result (2026-11-23, branch `claude/7354-o2`; P1 and `main` merged at fc6a029b3f)

### Built (as planned; deviations below)

- **One call path.** `buildAccessorCall` (`builtin-function-property-bodies.ts`): a source closure goes to F2's dispatcher
  of that arity (`__call_fn_method_0(receiver, getter)`, `__call_fn_method_1(receiver, setter, v)`), a built-in to the
  kernel's own `method0` / `method1` (its `callVector`). The kernel's entry-get (`get`, `getOwn`) answers status 1 with
  the call's result; the set adapter (`source-object-bodies.ts`) drops it and answers true. Both return right after
  the call: no entry, table or chain position is used after program code ran.
- **Removed:** the entry-get's status-3 arm where a source accessor can exist, `getOrAbort` (now `getField`, a plain
  [[Get]] of a key just found present), the set adapter's setter `unreachable` where a source setter can exist, the
  `define-accessor` named gap (a realm row binding the descriptor pack's `defineAccessor`, as `define-data` does). The
  set row takes the kernel's operand record instead of six copied handles.
- **Requirement** (`native-invocation-requirements.ts`): `realmAccessors` is set when the program calls a contract that
  can store a function value as an accessor half (`definesAccessors`, one list in `ordinary-object-callables.ts`:
  `define-accessor`, `descriptor-define`, `descriptors-define`) and has source closures. It adds arities 0 and 1 and
  selects the **dispatchable** source closures as arms (`dispatchable`, the predicate `dynamicCalleeGaps` now shares).
  It adds **no gap**: a closure that is not dispatchable is not an arm, and if one ever reaches the realm's call, the
  dispatcher's last arm aborts for any closure (P1's `builtinRootTypeIdx`, now also set under `realmAccessors`). No new
  refusal is possible by construction (lead's answer 2). The kernel receives the two dispatchers only then
  (`nativeInvocationAccessorCalls`, a new optional kernel dependency); otherwise its bodies are the old bytes.
- **Object literal:** an accessor, and a function expression inside a literal that has one, take the all-dynamic
  signature on the lane of their enclosing function declaration (`sourceDynamicClosureSignature`); inside an exported
  function (the typed #3518 programs) they keep the checker's signature, as before. Such an accessor is a function
  object (`emitFunctionObjectInit`: `length`, name `get k` / `set k`, no `prototype`); a typed one keeps none.
  `programObjects` counts an accessor as a function value.
- from-ast 17346 = base (the resolver call lost its `isFunctionExpression` guard in place), program-source 1746 =
  base, program-consumer 1513 = base (the invocation pack rides on the existing `reserveNativeRealmKernel` call).

### Deviations from the plan

- Lead's answer 2 replaced plan step 3's "every source unit required dispatchable" (a named refusal) by "dispatchable
  units are the arms, the rest aborts": no program that compiles today can refuse.
- `get: undefined`: the stored half was already null (it read `undefined` and compared right on the base), so no
  normalization was added.
- The plan's "descriptor-literal closures always dynamic" broke the #3518 typed fixtures (TS programs on the same
  lane, whose literals live in exported functions): the enclosing-declaration rule above keeps them byte-identical.

### Re-entrancy and exceptions (lead's conditions A, B)

- A getter / setter is called from: kernel entry-get (returns its result), the set adapter (returns true),
  ToPropertyDescriptor's `getField` (each field is `has` then [[Get]] on the descriptor object, read afresh; only the
  record's own locals survive the call), defineProperties' per-key [[Get]] (the key list is the one snapshot the spec
  takes; each key's attributes are re-read by `ownDescriptor` after the previous getter ran; nothing is defined until
  every descriptor is converted). OrdinaryToPrimitive's method reads are `js.object.get` (IR side).
- Kernel state checked for a set-before / reset-after pattern: none in `get` / `lookup` / entry-get / set adapter /
  ToPropertyDescriptor / descriptors-define (locals only); the realm `initializer` runs before any lookup; the
  dispatcher's `__current_this`, `__argc`, `__extra_args` are saved and restored by its `try_table` boundary on return
  and on throw (F2). No legacy prototype cache or one-shot receiver global exists on this path (those are the legacy
  `object-get-bodies.ts`, not built here).
- Tested against node (each with its wrong twin): a getter that redefines its own property as an accessor and as data;
  grows the object read and an inherited read's receiver by 50 properties; a setter that grows its receiver, redefines
  the property it was found on, on the object and on a prototype; recursive reads (depth 4) and writes; a key getter
  that defines the SAME target during defineProperties (configurable: the later define wins; non-configurable:
  TypeError, the inner value stays); a key getter that hides a later key and adds one; a descriptor-field getter that
  grows the descriptor; a getter throwing on its 2nd call only; throws through a read, a write, ToPrimitive,
  defineProperty, create (no object leaks) and defineProperties (nothing defined); `this` restored after a caught
  getter throw. Not expressible on this path: `delete` inside a getter (`delete has no IR lowering`), changing a
  prototype (`Object.setPrototypeOf` / `__proto__` refused), so (i) and (iv) are covered by redefinition only.

### ToPropertyDescriptor order (condition C)

A descriptor whose six fields are logging getters reads `enumerable, configurable, value, writable, get, set`; a `get`
that is no function throws after `enumerable, configurable, get` were read and before `set`; a bad `set` after
`get, set`; `get` + `value` after `value, get` (all node's order).

### C1 (`native-getter-invocation-requirements.ts`): why it is not folded, what would delete it

It proves a getter by its static allocation (an object-literal `define-accessor` whose half is a `closure.new`, then a
`js.object.get`), and its use makes that closure an arm of method 0 **with the dispatcher's conversions** (an f64 or
Boolean result). The realm rule here admits only all-carrier closures. In the typed #3518 programs (accessors in an
exported function keep the checker's signature, e.g. `get value(): number`) the C1 arm is what lets the realm's call
of a typed getter answer (tests `issue-3518-ordinary-object-runtime-providers`, `-native-getter-resource-join`: those
programs are now accepted and run, `run() === 7`). Its other consumer, `native-object-get.ts`, is reached only from test
fixtures. It can be deleted once (a) a typed accessor gets an arm by the realm rule (the dispatcher's f64 / Boolean
conversions admitted there, with the undefined-preserving carrier C1's gap asks for f64 parameters) or typed programs
leave this lane, and (b) `native-object-get.ts` and its fixtures are retired (#7380).

### Proof

| test file (alone, VITEST_MAX_FORKS=1, heap 2048) | tests | exit |
|---|---:|---:|
| issue-7354-o2-accessors (new) | 43 | 0 |
| issue-7354-o1-define-property / o1-create-and-define-properties (3 O2 abort pins removed) | 30 / 15 | 0 |
| issue-3518-ordinary-object-runtime-providers (the gap pin now runs the getter: 7) | 271 | 0 |
| issue-3518-native-getter-invocation (arities [0, 1]; "no Get" has dispatchers, no use) | 37 | 0 |
| issue-3518-native-getter-resource-join (refusal → acceptance) | 13 + 2 skipped | 1 — the same 2 fail on the base (`string.const runtime is unavailable` in the hand-built fixture) |
| issue-3518-native-getter-results | 19 of 21 | 1 — the same 2 fail on the base (same fixture error) |
| issue-7354-o-objects | 12 of 13 | 1 — the same 1 fails on the base fc6a029b3f |
| issue-7354-fa-function-values (descriptor-literal pin moved to exported fn; script case positive) / p1-method-values (getter-defined method row removed, now an O2 test) | 44 / 19 | 0 |
| m-refusals 44, r-provider-census 117, 3518-native-realm-requirements 25, 3518 ordinary-descriptor-capture 7, ordinary-getter-source 8, ordinary-object-access-source-plan 27, transitive-getter-captures 23, promise-getter-capture 14, void-closure-results 16, native-object-realm-declarations 21, native-builtin-functions 36, semantic-provider-source-acceptance 86, native-add-default-hint 43, ordinary-object-callable-contracts 55 | | 0 |
| c2-constructors 20, c2-this 18, f1b-function-objects 9, f2 10, p1-own-property 18, m-prototype-premise 18, o4 16, o3 13, s-script-var-define-target 14, x-dynamic-throw 59, u-prelude 3, test262-prepared-entry 44, perf-string-authentication 27, o2b 15, f1b-declaration-values 11, f1b-function-object-writes 3, f1-function-kind 12 | | 0 |

- **Seven rows** (strict entry, real prelude): all return. **Sample** (411 rows, real runner, base = fc6a029b3f run
  the same day): base 61 pass / 19 fail / 331 CE, head **68** / 12 / 331; transitions fail→pass 7 (exactly the seven
  rows), everything else unchanged. Ten mutated twins of the seven (each flips one assertion) all FAIL through the same
  runner; deleted, directory mtimes restored, `find test262/test -name '*_o2twin*'` empty.
- **Probes base vs head** (310: P1's 216 regression programs, 74 O2 hazard probes, 20 base probes): OK→OK 132,
  ABORT→OK 42, REFUSED→OK 35, ABORT→ABORT 74, REFUSED→REFUSED 27; nothing that was right is anything else, 0 wrong,
  0 invalid, 0 exceptions. The 74 hazard probes with wrong twins: 73 OK, 1 abort (a closure capturing a written
  parameter, `closure inside mk captures non-local binding`, not accessor-specific).
- **Sweep** (`.tmp/sweep-gen.mjs`, 13 existing kinds × 216 descriptors): counting-getter column (every present field a
  getter that counts; the count is part of the answer) 2,808 / 2,808 right; plain column 2,808 / 2,808 right (O1's cases re-run on the head: `getField`). A 12-program
  batch with wrong expectations: 12 / 12 throw.
- **`check:prepared-bytes`** (804 rows) base vs head: 803 identical; row 47 (`Object.defineProperty(obj, "foo",
  {value: 1})`, no closure) differs by `getField` (the dropped status-3 test in the descriptor helper); run on base and
  head: both return with `obj.foo === 1`.
- **Plain programs** byte-identical: prelude + `assert(true);` sha256 e23f5dca… and prelude + an object-literal
  program 8b838a85… at base and head; the 803 rows above.
- **Ordinary pipeline**: 20 test262 files (the seven rows, six `11.1.5` object-literal accessor rows, O1/P1's
  defineProperty / create / getOwnPropertyDescriptor / hasOwnProperty rows) × default + standalone: 40 / 40 identical.
- **Mutations** (each alone, `.tmp/mutate.cjs`, probe run: 7 JS programs, a TS typed-getter program, the #3518
  exported-getter program), all killed: the dispatcher call's receiver (wrong `this`), the setter's `true` (strict
  TypeError), the realm's arms (`units: []`: abort in a program that calls no value), `define-accessor` in the
  accessor-defining list (literal reads abort), the accessor's dynamic signature (refusal), the accessor's
  function-object init and its `get ` prefix (wrong `name`), the closure-root abort under `realmAccessors` (the typed
  getter answers a catchable TypeError instead), the enclosing-declaration lane rule (the #3518 typed program refuses
  `js.number.box`), `programObjects`' accessor (an accessor-only program loses `this`), the kernel's source arm.
  Each killing program is in `issue-7354-o2-accessors` or the #3518 runtime-providers file.
- **`main` adc30d7fbc merged** after the measurements (no conflict; it touched from-ast, function-object-lowering,
  source-dynamic-contracts elsewhere). Re-checked on the merged state: typecheck, LOC / function budgets (also
  `LOC_GATE_BASE` = adc30d7fbc), coercion-sites, oracle-ratchet, dead-exports all exit 0; o2-accessors 43 / 43; the
  seven rows return; prelude + `assert(true);` still e23f5dca…. from-ast, program-source, program-consumer: net 0
  lines vs that main. No budget grant.

### Known limits

- `o.x += v`, `o.x++` on a member: refused at top level (`compound property write on dynamic not in IR scope`), the
  function's abort inside one (pinned in o2-accessors; slice L0).
- `delete` and prototype changes inside an accessor are not expressible on this path (see above).
- A non-dispatchable closure (typed) as an accessor half of a descriptor static aborts at its call.
- Requirement precision: `realmAccessors` reserves both dispatchers for any accessor-defining program with closures,
  even one that defines only a getter or never reads it (one unused function at most).

### Not verified

- Node 25 (not installed).
- The ordinary-pipeline suites beyond the 20-file byte comparison; the f1-function-expressions(-2/-3),
  h-script-var-dynamic-home and 3518-native-invocation-substrate suites.

## Slice W2 plan (2026-11-26, branch `claude/7354-w2` from `origin/main` 1a726b3e64)

`String`, `Number`, `Boolean` and `Object` as realm constructors on the Prepared path, by G1's mechanism.

Measured on the base (411-row sample): 59 rows stop first at one of these four names (`identifier … is not in
scope` 27, `unknown class` 31, `direct call to "Object"` 1).

### Design (lead decisions 2026-11-26: option A, reuse #3518's wrapper subtypes)

1. **Catalog.** G1's `errorRows` becomes one parameterised family builder (constructor row, prototype object, the
   prototype's methods, `heldWith` the constructor); the Error family and the three wrapper families are its rows.
   The wrapper prototypes' specification keys move from the hand lists in `builtin-prototype-keys.ts` into the catalog
   (`unavailable` rows), so "which keys does a held object lack" has one answer: its catalog properties whose value
   is an intrinsic the realm does not hold. `%Object%` becomes a value (native, not constructible through the
   dispatcher), its statics stay unheld. Number's data constants (`NaN`, `MAX_VALUE`, …) are seeded as data.
2. **What a realm holds** (`native-realm-requirements.ts`): `heldErrorConstructors` becomes a per-family rule over the
   same uses (an intrinsic read of a member, a family contract; Error also a bound catch payload).
3. **Kernel.** Constructors are G1 entries (behavior `native`, algorithm `unreachable`). A wrapper is #3518's
   `$StringObject` / `$NumberObject` / `$BooleanObject` (`primitive-wrapper-layouts.ts`, payload field 6), allocated
   by `buildPrimitiveWrapperAllocationDefinition`; the realm's `$Object` takes the existing `extensible` opt-in. The
   wrapper prototypes are themselves wrappers ("", +0, false). Contracts: `js.object.create-wrapper(primitive,
   selector)` (also defines a String's own `length`), `js.object.primitive-data(object)` (the payload as a carrier
   value, `undefined` for no wrapper: which wrapper it is comes only from the `ref.test` of the subtype).
   `js.object.intrinsic` also answers the family prototype objects.
4. **IR.** `realmIntrinsicRead` answers the four names (pristine, `pristineBuiltinGlobal`); `dynamic-error-constructors.ts`
   generalises to `dynamic-realm-constructors.ts`: a call / construct whose callee is the intrinsic expands at the
   site — `String(v)`/`Number(v)`/`Boolean(v)` are the existing ToString / ToNumber / ToBoolean builders,
   `new X(v)` is that conversion then `create-wrapper`, `Object(v)` / `new Object(v)` a kind chain (nullish → a new
   object, object or function → itself, primitive → its wrapper). OrdinaryToPrimitive and P1's method call recognise
   the wrappers' `valueOf` / `toString` by identity (G1's error-to-string row, generalised to a list) and answer
   `thisXValue` through `primitive-data`, a TypeError for a wrong receiver. `dyn.object_tag`'s object arm reads the
   wrapper payload's kind.
5. **Premise.** With a prototype obtainable, a primitive's member read goes through the realm's prototype object
   (`js.object.get(%K.prototype% or %Object.prototype%, key, primitive)`) and a primitive's write aborts where the key
   is found on it; the M1 premise test's routes move accordingly.

### Refuses / aborts (each sound)

- A read or write, by constant key, of a constructor static the realm does not hold (`String.fromCharCode`,
  `Object.keys`): refusal by name. Computed keys refuse as before.
- A String wrapper's index keys: run-time abort (the exotic lookup in `string-exotic-bodies.ts` is not wired).
- `Number.prototype.toString(radix)` with a radix, the unheld prototype methods (`charAt`, `toFixed`): by name.
- `==` with a wrapper: refused as all loose equality is today (L0a not on main).
- A built-in called through any other value (`var C = String; C(1)`): the dispatcher's built-in abort (G1).

### Placement and quality criterion

Catalog rows in `native-realm-catalog.ts`; kernel bodies beside G1's in `realm-family-bodies.ts`; contracts in
`native-source-objects.ts`; IR in `dynamic-realm-constructors.ts` (the renamed G1 module) and the existing chain /
member-access / to-primitive modules. from-ast net ≤ 0. Quality: no Error-only module stays where it is now one family
of several; no second wrapper layout; no hand list of wrapper-prototype keys left beside the catalog.

## Slice W2 result (2026-11-26, branch `claude/7354-w2` from `origin/main` 1a726b3e64)

### Built

- **Catalog** (`native-realm-catalog.ts`): G1's `errorRows` is one family builder (`familyRows` over a `Family`
  record); the Error family and the three wrapper families are rows of it. The wrapper families carry their statics,
  data constants (`Number.MAX_VALUE`, …) and every prototype method (Annex B included) as `unavailable` rows, but
  `valueOf` / `toString`; a wrapper prototype carries its primitive slot. `%Object%` is native (a value).
  `NATIVE_VALUE_INTRINSICS` gains `Object`, the wrapper constructors and methods, and the prototype objects a
  primitive's member read goes through (appended: G1/P1 selectors unchanged).
- **What a realm holds** (`native-realm-requirements.ts`): `heldErrorConstructors` → `heldFamilyMembers`, one rule per
  family over the IR's uses; `heldCatalogRows` holds a family's callable row only if it is a value the realm holds, so
  an unheld member (`String.prototype.charAt`) is no row, no literal and no seeded property.
- **Kernel**: the wrappers are #3518's subtypes (`createPrimitiveWrapperDeclaration`, payload field 6) and storage
  bodies, reserved over the realm's object layouts only where a wrapper family is held
  (`native-realm-wrappers.ts`; the layouts take the existing `extensible` opt-in then). `realm-wrapper-bodies.ts`:
  `create-wrapper` (a String's indices {!w,e,!c} and `length` {!w,!e,!c} are stored at creation, so every realm
  lookup, define, write and key walk answers the exotic object's answer), `primitive-data` (the slot, `undefined` for
  no wrapper), `wrapper-this` (thisXValue for a held wrapper method, TypeError for a wrong receiver, null for any other
  method), `wrapper-to-string`. The family seeding takes number values and skips unheld members; a wrapper prototype is
  allocated as a wrapper. `js.object.intrinsic` also answers the family objects and Object.prototype.
- **IR**: `dynamic-error-constructors.ts` → `dynamic-realm-constructors.ts` (Error, Object, String, Number, Boolean,
  call and construct at the site; `realmConstructorsRead`; `functionChainAnswer` answers `true` for
  %Object.prototype%). Which constructors a program holds is now the IR's answer (`realmConstructorsRead` over the
  front end's intrinsic reads), not a source walk: an intercepted `String(v)`, `Object.defineProperty(…)` or
  `Object.prototype.toString.call(v)` reads none, so the prelude holds no wrapper family.
  `dynamic-wrapper-methods.ts`: one `wrapper-this` call answers a wrapper method in OrdinaryToPrimitive and in P1's
  method call (G1's error-to-string row and it are entries of one `builtins` list). Member access: unheld statics
  (`unheldStaticKeys`) and unheld wrapper-prototype keys come from the catalog (the hand lists `STRING_PROTOTYPE` /
  `NUMBER_PROTOTYPE` are gone); where a program can obtain a prototype (`obtainsPrototypes`) a primitive's read goes
  through the realm's prototype object and a write of a key found there aborts; the intercepted
  `Object.prototype.toString.call` aborts if the program replaced Object.prototype.toString. `dyn.object_tag` reads a
  wrapper's kind through its slot. `new X` answers the carrier in the `+` analysis (`construct` leaf).
- from-ast: net 0 (the `construct` leaf +1; `Number(v)`'s lane arm moved to `function-object-lowering.ts`
  `preparedToNumber`).

### Cast / test sites checked for the extensible `$Object` (lead condition)

- `native-builtin-functions.ts` refused an extensible ordinary carrier ("plain storage lookup cannot stand in for an
  exotic carrier's own-property method"): relaxed only where the realm holds the wrappers, whose own properties are all
  stored. This is the one site touched.
- Every other kernel / source-object body casts to `$Object` (`ref.cast`, which accepts the subtype) or tests it as
  "is ordinary" (`ref.test`, true for a wrapper: a wrapper is an ordinary object with a slot, as intended). No
  `br_on_cast` on `$Object` exists on this path; no `struct.new $Object` reads a wrapper. Function entries are
  distinct closure types, unaffected.

### Refuses / aborts (each sound)

Unheld statics and prototype methods (`String.fromCharCode`, `Object.keys`, `"a".charAt`): refusal by name where
every kind refuses, else the abort; a constructor through a variable (`var C = String; new C()`): the dispatcher's
built-in abort; `Number.prototype.toString(radix)`: abort; `Object.prototype.constructor`: abort (not seeded);
`==` with a wrapper: refused as all loose equality; `var String;`: refused by name (G1's S1 rule now covers the four);
`'a'.valueOf()` on a statically typed string, `(1).toString()`: from-ast's typed refusals, unchanged; a sloppy method
on String.prototype called on a primitive: the existing C2-D3 abort.

### Proof (local node 22)

- Probes (`.tmp/w2a.json` 92 + `.tmp/w2c.json` 40, each against node with a wrong twin, chunks of 10 programs per
  process): head 59+33 OK, 0 WRONG, 0 twin failures, 0 invalid, 0 EXC; base → head on the 92: REFUSED→OK 56,
  REFUSED→REFUSED 27, REFUSED→ABORT 5 (the designed aborts above), OK→OK 2, ABORT→OK 1, EXC→REFUSED 1 (`var String;`,
  a verifier exception on the base).
- The probe driver throws invariant errors with message "r" (`verifier-failure`, `invalid-host-capability-catalog`,
  duplicate module binding) after ~20 compiles in one process, on the base too; each such program compiles and agrees
  when run alone. Not investigated.
- Tests (each alone, one fork): `issue-7354-w2-wrappers` (new) 24; g1-error-values 14, g1-refusals-and-aborts 14,
  g1-spelled-names 17, g1-assert-throws 5, c2-constructors 19, c2-this 18, p1-method-values 19, p1-own-property 18,
  o1-define-property 30, o1-create-and-define-properties 14, o2-accessors 43, o2-object-values 12, m-refusals 43,
  m-prototype-premise 18, t2-typeof-standard-globals 16, ty-typeof-comparisons 57, u-prelude 3; 3518
  native-realm-requirements 25, native-object-realm-declarations 21, ordinary-object-callable-contracts 61,
  native-builtin-functions 36, native-primitive-wrapper-layouts 71, -storage 178, primitive-wrapper-bodies 185,
  native-realm-wrapper-storage 24: all pass. Pins moved: premise routes (String/Number/Boolean/Object.prototype are
  values now; `Object.getPrototypeOf` is an abort row), `typeof` of the four, O1's computed static and M1's G45
  `Object.freeze` (a call through a value), the catalog's native list, `programObjects` (no constructor names).
- Ordinary pipeline: 12 test262 files (wrappers, Object, operators, Error) × gc + standalone: 24/24 byte-identical
  to the base.
- Prelude + `assert(true);`: 81,397 B → 81,408 B (+11 B: the intrinsic getter's Object.prototype arm in a program
  holding the Error family), 8.5 s → 8–10 s. Prelude + a `new String` program: 103,727 B, ~13 s (an earlier inline
  design took 35 s and was replaced by the realm call).

### Sample (the 59 rows of the 411 whose first error names String/Number/Boolean/Object; real runner, two runs)

Base: 59 compile errors. Head: **22 pass**, 18 fail, 19 compile errors. Fails: 16 run-time aborts, almost all an
unheld String.prototype method (`concat`, `trim`, `toLowerCase`, …) or `Object.preventExtensions` / `isFrozen`; one
closure body the path cannot lower. Next compile blockers: `delete` 4, `Array` 3, computed member keys 3, RegExp
literal 2, loose equality 2, `<` / `<=` on dynamic values 2, implicit dynamic flows 3. Sample passes not twin-checked.

### Not verified

Node 25; the full 3518/7354 suites beyond the files above; `check:prepared-bytes`; no adversarial review agent run.
