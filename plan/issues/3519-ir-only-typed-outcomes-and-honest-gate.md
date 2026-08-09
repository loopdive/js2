---
id: 3519
title: "IR-only R0: typed preparation outcomes and an honest readiness gate"
status: done
sprint: 74
created: 2026-07-21
updated: 2026-07-21
completed: 2026-07-21
priority: critical
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, compiler, ci
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
lane: ir-retirement-r0
model: gpt-5.6-sol
parent: 3518
depends_on: [3143, 3529]
related: [1376, 1923, 2855, 3090, 3153, 3341, 3529]
origin: "#3518 R0 — remove fallback telemetry blind spots before changing compilation ownership"
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/context/types.ts
  - src/compiler.ts
  - src/codegen/ir-overlay-finalize.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/module-bindings.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/passes/monomorphize.ts
  - src/ir/select.ts
  - src/ir/verify-alloc.ts
files:
  - src/ir/outcomes.ts
  - src/ir/index.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/module-bindings.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/passes/monomorphize.ts
  - src/ir/verify-alloc.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/index.ts
  - src/codegen/ir-overlay-finalize.ts
  - src/index.ts
  - src/compiler.ts
  - scripts/check-ir-only.ts
  - scripts/check-ir-fallbacks.ts
  - scripts/ir-only-baseline.json
  - package.json
  - .github/workflows/ci.yml
  - tests/issue-1850.test.ts
  - tests/ir/alloc-provenance.test.ts
  - tests/ir/phase3c.test.ts
  - tests/issue-1923.test.ts
  - tests/issue-3341-slice-b.test.ts
  - tests/issue-3519-ir-only-gate.test.ts
  - tests/issue-3519-ir-outcomes.test.ts
---

# #3519 — IR-only R0: typed outcomes and honest readiness gate

## Objective

Create one typed truth channel for every attempted IR unit and a
`pnpm run check:ir-only` command that cannot report readiness while a unit,
compiler error, or corpus is silently skipped.

This slice does **not** flip the default, skip more legacy bodies, or delete
legacy code. It introduces a policy evaluator over observed outcomes:

- `hybrid`: reports/baselines `Unsupported` units that actually retained
  legacy during migration; every `Invariant` fails.
- `ir-only`: treats any observed `Unsupported`, `Invariant`, or legacy-emitted
  unit as not ready.

The production routing remains unchanged until #3518 R2/R9. “IR-only” in R0 is
an opt-in verdict over telemetry, not a new public compile option or a
compatibility promise.

## Completion evidence (2026-07-21)

#3529 restored full-equivalence parity without weakening unknown-throw-to-
Invariant classification or changing the committed baseline:

| Signal                                      | Result |
| ------------------------------------------- | -----: |
| Passing tests                               |  1,608 |
| Failing tests                               |     35 |
| Committed known failures                    |     36 |
| Baseline-known cases that now pass          |      1 |
| New regressions                             |      0 |
| `scripts/equivalence-baseline.json` changes |      0 |

The final bounded `single-host` lane is non-vacuous and fully accounted:

| Signal                | Result |
| --------------------- | -----: |
| Corpus entries        |    5/5 |
| Terminal units        |     37 |
| Emitted IR bodies     |     31 |
| Typed `Unsupported`   |      6 |
| `Invariant` outcomes  |      0 |
| Legacy-emitted bodies |     37 |

The six typed Unsupported units are two async functions, one call-graph-
closure case, one body-shape case, and two static class members. Hybrid policy
is green with zero skipped entries, unaccounted units, Invariants, or
uninspected compile failures. Strict IR-only is intentionally red on those six
typed blockers and on all 37 legacy-emitted bodies; that is honest readiness
evidence for the later retirement slices, not an R0 failure.

## Implementation notes (2026-07-21)

Making unknown post-claim throws fatal exposed three pre-existing
selector/builder contract mismatches in the required cross-backend suite; the
typed-outcome work did not introduce new runtime behavior:

- reassigned scalar parameters were accepted by selection but retained as SSA
  locals, so `countdown(n) { n--; }` reached the builder's non-slot invariant;
  the builder now seeds accepted mutable scalar/string parameters into slots;
- ambient typed-array constructors were listed as generic extern classes even
  though their implementation remains owned by the direct backend's native vec
  path; they now reject before claim;
- real Array/tuple receivers admitted every method name although the IR vec
  producer currently implements only `.push`; a checker-backed identity proof
  now rejects the unimplemented Array prototype surface before claim without
  stealing same-named local-class methods.

Focused outcome tests pin all three producer decisions. The post-merge
cross-backend differential suite is 29/29 after these changes.

The complete equivalence gate then exposed the wider pre-existing population
that R0's former silent demotion had hidden: 154 failures not in the committed
baseline, of which 152 surface the now-fatal IR diagnostic directly and two
assert only `CompileResult.success` without printing the underlying diagnostic.
That result became #3529's producer audit, not permission to weaken
unknown-throw-to-Invariant or expand the equivalence baseline. Intended
capability gaps needed an explicit `IrUnsupportedError` or honest pre-claim
decision, while selector/builder and pass-contract bugs needed fixes at their
producer seams.

### Producer-parity resolution

The selector/builder seed fixes, dynamic-box pass correction, explicit typed
producer exits, and integration preflights removed the entire 154-regression
population exposed by the honest boundary. Capability gaps now terminate as
stable `Unsupported` outcomes, while the genuine selector, builder, pass, and
integration contract violations were fixed rather than reclassified. The
single-host lane improved from its intermediate 30 emitted / 7 Unsupported
checkpoint to 31 emitted / 6 Unsupported with the baseline unchanged.

## Why the pre-R0 fallback gate was insufficient

`check:ir-fallbacks` is a useful narrow ratchet, but it cannot answer “can we
remove the direct front-end?” today:

1. It catches and **continues after `buildTypeMap` failure**.
2. It catches and **ignores most real `compileFiles` failures**.
3. It reads selector fallbacks and `irPostClaimErrors`, but the #3143 hard
   skipped-slot failures land in `CompileResult.errors`; that produced a
   documented false green.
4. Its disk walk does not execute the inline template programs in the actual
   equivalence suite.
5. `STRICT_IR_BUILD_ERRORS` classified compiler invariants by message
   substring, so wording changes could silently change policy.
6. `irCompiledFuncs` proves a slot was patched; it does not prove the unit was
   prepared before legacy emission or that every source unit was accounted for.

R0 makes those omissions impossible to hide. It complements
`check:ir-fallbacks`; it does not redefine a playground baseline as language
coverage.

## Typed terminal contract

Add `src/ir/outcomes.ts` and make the observed terminal ledger the only
policy-bearing classification. Preparation failures use the same closed
Unsupported/Invariant code unions internally; there is no second exported
generic outcome contract:

```ts
export type IrObservedOutcome =
  | (IrObservedOutcomeBase & { readonly kind: "emitted"; readonly stage: "patch" })
  | (IrObservedOutcomeBase & IrPreparationFailure);
```

Exact field names may follow repository conventions, but the discriminants and
policy meanings are acceptance requirements:

- `emitted` means the current unit completed the IR preparation/integration
  contract and patched its target slot. Until R2 it may still be patched into
  a legacy-created slot, so R0 telemetry reports
  `legacyBodyEmitted: boolean` separately.
- `Unsupported` is a source capability decision with a stable code and source
  location. It is warning/legacy-eligible only in hybrid mode and fatal in
  IR-only mode.
- `Invariant` is a compiler bug after an internal promise was made. It is fatal
  in **both** modes and may never demote to legacy.

`IrUnsupportedCode` may initially wrap the existing `IrFallbackReason` union
plus explicit deferred-feature codes. `IrInvariantCode` must be a closed union,
not a free-form message. It must include typed replacements for the three
currently strict name-repoint cases (`unknown-function-ref`,
`unknown-global-ref`, `unknown-type-ref`) and codes for verifier failure,
backend-legality failure, missing/unpatched slot, ABI/type-index mismatch, and
unexpected internal throw. Human-readable text remains diagnostic payload,
never policy input.

R0 uses an observational unit label containing file label, unit kind, display
name, and ordinal. It must not be used as compiler identity. R1 replaces it
with the source-qualified `IrUnitId` and `ProgramAbiMap`.

## Implementation plan

### 1. Make selection and preparation produce typed terminal evidence

**`src/ir/select.ts`**

- Preserve the selector's detailed reason codes, but surface every rejected
  function, class member, and module-init unit as `Unsupported`; do not require
  `trackFallbacks` to obtain correctness data.
- Keep verbose histograms opt-in. Correctness classification must be available
  independently of logging so IR-only policy cannot be disabled by telemetry
  settings.

**`src/codegen/index.ts`**

- Thread `trackIrOutcomes` through `planIrOverlay` /
  `consumeIrOverlayReport`. Do not add an IR-only production routing branch in
  R0.
- Convert override/type-resolution catches into typed outcomes. A known
  source-shape/type capability gap is `Unsupported`; a selector promise that
  violates a documented internal contract is `Invariant`.
- Delete `STRICT_IR_BUILD_ERRORS` and `isStrictIrBuildError`. Switch diagnostics
  on `IrInvariantCode`, never `message.includes(...)`.
- Keep `STRICT_IR_REASONS` only as a compatibility telemetry hook if another
  test still needs it; it must not define IR-only policy. Record its removal in
  the R9 checklist.
- Existing hybrid `Unsupported` routing remains a warning while its legacy
  body is available. Every typed `Invariant` and a missing emitted patch stay
  hard errors with stable diagnostic codes. The gate's IR-only policy rejects
  Unsupported outcomes without changing production routing in this slice.

**`src/ir/integration.ts`**

- Replace optional-kind/free-form `IrIntegrationError` policy with typed
  outcomes. Every build/verify/lower/backend-legality exit must have a code.
- Convert all expected not-yet-supported exits into `Unsupported`. Convert
  name resolution, verifier, ABI/slot, and impossible-state failures into
  `Invariant`.
- Catch an unclassified throw only at the unit boundary, emit
  `invariant/unexpected-internal-throw`, retain its cause for debugging, and
  fail both policies. Never turn it into an ordinary warning.

**`src/ir/from-ast.ts` / `src/ir/index.ts`**

- Export typed outcome/error helpers from the IR surface.
- Convert the currently exercised valid-source `void call in expression
position` build limitation to a typed
  `Unsupported("void-call-expression")`. Do not broadly label unknown builder
  throws unsupported; untyped throws are Invariants until deliberately
  classified with a regression test.

### 2. Expose complete, non-vacuous telemetry

**`src/codegen/context/types.ts` / `src/codegen/context/create-context.ts` /
`src/index.ts` / `src/compiler.ts`**

- Add compile-result telemetry for every attempted unit with: observational
  label, function/class/module-init kind, backend/target, outcome kind/code,
  preparation stage, `legacyBodyEmitted`, and `irBodyEmitted`.
- Add `CompileOptions.trackIrOutcomes?: boolean`, conditionally initialize the
  context ledger, and expose `CompileResult.irOutcomes`. Outcome collection may
  be opt-in for allocation cost, but correctness classification cannot depend
  on `JS2WASM_LOG_IR_FALLBACKS`.
- Preserve `irPostClaimErrors`, `irCompiledFuncs`, and `irFirstSkipped` during
  transition, but derive/cross-check them against the new outcomes. A mismatch
  is an Invariant and fails the gate.
- Preserve outcomes through `success:false` and `failResult(...)`; fatal
  skipped-slot/invariant evidence must not disappear when compilation fails.
- Unit-accounting invariant: inventoried units = emitted + Unsupported +
  Invariant. A claimed-but-missing, emitted-without-outcome, or duplicated unit
  is fatal.

### 3. Add `check:ir-only` without skip-on-error behavior

**`scripts/check-ir-only.ts` / `scripts/ir-only-baseline.json` / `package.json`
/ `.github/workflows/ci.yml`**

The command runs real production compilation and emits a stable JSON summary
plus a human table. It has two modes:

- `--policy=hybrid`: instrumentation/invariant gate. Unsupported units are
  reported and may use legacy, but every corpus entry must compile or produce a
  recorded hard failure; no outcome may be missing.
- `--policy=ir-only` (the default for `check:ir-only`): readiness gate. Any
  Unsupported/Invariant result, legacy body emission, hard compile diagnostic,
  or unaccounted unit exits non-zero.

Commit `scripts/ir-only-baseline.json` for the hybrid ratchet and wire that
bounded invocation into `quality`. The IR-only verdict never accepts the
baseline as readiness: it stays non-zero until the unsupported and
legacy-emitted populations are actually zero.

Unlike `check:ir-fallbacks`, this script must not contain a `catch { continue }`
for TypeMap or compilation. Specifically:

- TypeMap build failure becomes a typed Invariant and fails both policies.
- A thrown compile, `result.success === false`, or any
  `result.errors.some(e => e.severity === "error")` is recorded and fails.
- `result.errors` is always scanned, even when `irPostClaimErrors` is empty.
- Expected IR-only non-readiness is represented by typed Unsupported rows, not
  by skipping the source file or accepting a baseline.

R0 lands one deliberately bounded, named `single-host` lane over the five
audited import-free example entries. It must invoke the real default
single-source compiler path and include function, class-member, non-empty
module-init, and async units; it must not rebuild selector logic in the script.
Focused anti-vacuity fixtures cover TypeMap/compile failure and fatal
`result.errors` even when the five entries do not naturally trigger them.

The report schema must support additive named lanes and reject a missing lane.
Before R9, #3518 expands it to the actual `tests/equivalence/` Vitest suite
(inline templates, not a directory regex), cross-backend WasmGC/linear,
multi-source M0, fast, standalone, WASI, `strictNoHostImports`, and merge-group
Test262 artifacts. R0 must not label its five-entry result “whole compiler
ready”; the lane name and denominators appear in every output.

The IR-only command is intentionally expected to report current blockers until
R3–R8 land; do not add the strict readiness invocation to required `quality`
yet. Add the hybrid instrumentation mode to CI once its runtime is bounded.
R9 promotes the strict command to a required gate.

### Audited seed lane (must be remeasured on the implementation base)

Start with a named `single-host` lane over the five audited import-free example
entries. The pre-#3517 audit found **5 entries / 37 terminal source units / 29
emitted / 8 Unsupported / 0 Invariants**:

- `select/async-function`: 4
- `select/module-init:body-shape-rejected`: 1 (expected to disappear when
  #3517 is in the base)
- `prepare/static-class-member`: 2
- `build/void-call-expression`: 1

This is seed evidence, not a value to copy blindly. Re-run after #3517, commit
the exact nonzero baseline, record entry/unit denominators, and add later named
lanes rather than claiming five examples represent the compiler. The gate must
reject an empty corpus, zero terminal units, zero emitted units, duplicate
observational keys, missing terminal outcomes, invariant growth, unsupported
growth, and an emitted-floor regression. Unsupported decreases and emitted
increases are bankable progress.

### 4. Policy tests

**`tests/issue-3519-ir-outcomes.test.ts`** must include:

1. A fully supported free function produces one terminal `emitted` outcome,
   with no fatal diagnostics and complete accounting; both policy evaluators
   consume that same observation.
2. A selector-rejected source shape succeeds via legacy in production hybrid
   with one typed `Unsupported`; the hybrid evaluator records it while the
   IR-only evaluator rejects the same stable code.
3. A post-claim ordinary capability gap is typed `Unsupported`, not inferred
   from its message.
4. Each unknown function/global/type ref invariant is fatal in both policies;
   changing the human message does not affect classification.
5. A verifier/backend-legality failure and a missing skipped slot are fatal
   Invariants in both policies.
6. `irPostClaimErrors: []` plus a fatal skipped-slot entry in `result.errors`
   fails the gate (the #3153/#3143 false-green regression).
7. TypeMap throw, compile throw, `success:false`, and fatal `result.errors`
   fixtures are each counted and fail; none can reach a skip/continue arm.
8. Module-init and class-member attempts appear in accounting even though they
   remain compile-twice until R3/R4.
9. Gate anti-vacuity rejects empty input, missing telemetry, zero emitted
   units, duplicate keys, missing terminal units, unsupported growth, and a
   emitted-floor regression; it accepts only bankable progress.

## Acceptance criteria

- [x] `emitted` / `Unsupported` / `Invariant` are the only policy-bearing IR
      preparation outcomes; every outcome has a stable code and stage.
- [x] `STRICT_IR_BUILD_ERRORS` substring matching is deleted and its existing
      three strict cases are covered by typed invariant codes.
- [x] Invariants fail both policy evaluators; Unsupported remains observable
      hybrid fallback and makes the IR-only evaluator non-ready. Production
      routing is otherwise unchanged in R0.
- [x] Compile-result unit accounting covers functions, class members, and
      module init and distinguishes “IR patched” from “legacy never emitted.”
- [x] `pnpm run check:ir-only -- --policy=hybrid` completes with zero skipped
      corpus entries, zero unaccounted units, zero Invariants, and zero
      uninspected compile failures.
- [x] `pnpm run check:ir-only -- --policy=ir-only --json` exits non-zero on the
      current known blockers and names each typed blocker; it may not report a
      false green merely because fallback/post-claim baselines are zero.
- [x] The focused policy tests above pass, including `result.errors`, TypeMap,
      compile-failure, class, and module-init coverage.
- [x] Existing `pnpm run check:ir-fallbacks`, typecheck, format/lint, issue
      integrity, equivalence, and cross-backend gates remain green under the
      unchanged production default.

## Implementation Summary

- **What was done:** added the closed emitted/Unsupported/Invariant outcome
  contract, preserved terminal evidence through compiler failures, reconciled
  it with transitional telemetry, and added the bounded hybrid/strict
  `check:ir-only` policy gate with anti-vacuity checks.
- **What worked:** stable typed codes now drive policy independently of
  diagnostic wording, and complete per-unit accounting exposes class members,
  module init, legacy emission, and hard `result.errors` without skip paths.
- **What did not work:** making unknown post-claim throws fatal initially
  exposed 154 previously demoted equivalence failures. Expanding the baseline
  or weakening classification was rejected; #3529 repaired the true
  invariants and made capability exits explicit instead.
- **Files changed:** the IR outcome/selection/preparation seams, compiler and
  codegen telemetry plumbing, `check:ir-only` script/baseline/CI wiring, and
  the focused outcome/gate tests listed in this issue's frontmatter.
- **Tests:** equivalence finished at 1,608 passing / 35 failing against 36
  committed known failures (one known case now passes, zero new regressions,
  baseline unchanged); hybrid finished at 5/5 entries, 37 terminal units,
  31 emitted IR bodies, 6 Unsupported, 0 Invariants, and 37 legacy bodies.

## Required validation commands

```bash
pnpm exec vitest run tests/issue-3519-ir-outcomes.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-only -- --policy=ir-only --json  # expected non-zero until later retirement slices; inspect blocker set
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
node scripts/equivalence-gate.mjs
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

## Bounded landing sequence

1. `feat(ir): add typed terminal outcomes` — outcome types/errors, context and
   compile-result plumbing, reconciliation, fatal-result preservation, and
   compatibility/policy tests. No routing change.
2. `ci(ir): add honest IR-only readiness ratchet` — `single-host` lane,
   committed baseline, package/CI wiring, and anti-vacuity evaluator tests.

Both commits belong to one R0 issue/PR unless review requires a stacked split;
the gate commit must not land without the typed result channel it consumes.

The implementation/PR report must include both policy outputs, total corpus
entries, total inventoried units, outcome counts by unit kind/target, and the
intentional IR-only blocker list. “Gate is zero” without those denominators is
not acceptance evidence.
