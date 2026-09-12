---
id: 5199
title: "ES2015 standalone generators — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-12
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
assignee: ttraenkler/codex-5199-generator-protocol-rescue-20260912
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/generators-native-consumer.ts
  - src/codegen/generators-native.ts
  - src/codegen/instance-props.ts
  - src/codegen/iter-hof-native.ts
  - src/codegen/iterator-native.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/proto-function-value.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/statements/variables.ts
func-budget-allow:
  - src/codegen/expressions/object-get-prototype-of.ts::tryCompileEs5GetPrototypeOfEarly
  - src/codegen/generators-native-consumer.ts::tryCompileNativeGeneratorResultProperty
  - src/codegen/generators-native-consumer.ts::tryCompileNativeGeneratorMethodCall
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::compileState
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/iter-hof-native.ts::fillIterHofSteppers
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/codegen/closures/funcref-as-closure.ts::emitFuncRefAsClosure
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/statements/variables.ts::compileVariableStatement
---

# #5199 — generators r2: cluster and fix the residual generator-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5141, part of PR #5179 — includes
the root-cause fix of the #5060 standalone generator-resume trap: V8 12.4 runs
a result-typed `try_table` as `unreachable`; the resume wrapper now trampolines
in a `block (result R)` under an empty-typed `buildTargetTaggedTry`) plus a
second pass (+25, PR #5213). Residual count on current main not re-measured;
the wave-8 planning pass was stopped.

Adjacent recorded defect: yield-star throw delegation has its own held draft
(PR #5063, pre-session) — check its state before clustering that area.

## Implementation Plan

Planning pass required before implementation (plan/implement split).

- Step 0 — regenerate the generators residual list
  (`language/statements/generators/**`, `language/expressions/generators/**`,
  `built-ins/GeneratorPrototype/**`) on current main via the standalone probe
  (see #5194 step 0 for probe shape and the `.test262-cache` caveat).
- Step 1 — cluster by error signature; write the cluster table into this
  file.
- Step 2 — implement per cluster; re-probe; spot-checks stay green.
- Step 3 — five ratchet gates + equivalence gate.

## Acceptance criteria

- Cluster table with measured counts in this file before implementation.
- Measurable net gain on the regenerated list; no spot-check or equivalence
  regressions.

## References

- #5141 (wave-1 plan), PRs #5179, #5213; #5060 (resume-trap root cause).

## 2026-09-12 generator protocol rescue checkpoint

### Provenance, ownership, and bounded scope

This implementation is a manual, generator-only port from the second commit of
the stale mixed draft PR #5736 (`b3a21dfcd1fc28c13a9f2ef168a8114deee347b0`),
reviewed relative to `357b05f68c8c76b8c4888690941edf9d247243ab`. It starts from
fresh main `d4108568d43f14c361ecc3a58c82633027eaae39` in the isolated branch
`codex/5199-generator-protocol-rescue-20260912`; before publication it must
merge, never rebase, current `upstream/main` `c645a7627e099173b0b3e0c5daa1d7b5a110a9d5`.

The port intentionally excludes the stale PR's super and TypedArray hunks. It
does not modify the TypedArray lane's `ta-dyn-mop.ts`, `native-proto.ts`, or
`proto-index-store.ts`. The only shared surfaces are ordinary prototype/object
plumbing, isolated to native-generator state branches. `context/types.ts` and
`statements/nested-declarations.ts` overlap #5683 at integration time; retain
both #5683's eager-capture semantics and this protocol wiring when resolving
the normal merge.

The bounded mechanism is ES2015 native-generator factory/prototype identity and
runtime protocol dispatch: each generator instance captures its factory's current
`prototype`, uses the common closure bag only as its ordinary-object view, and
observes own/inherited `next`/`return`/`throw` and iterator overrides through
ordinary Get with the source generator receiver. It is not a claim of complete
generator semantics or full ES2015 conformance.

### Local evidence before upstream integration

- Exact original-source `tests/issue-5199-native-generator-prototype.test.ts`:
  **11/11 pass** under one compiler worker. Every fixture asserted successful
  standalone compile, `imports=[]`, `WebAssembly.validate(binary)`, and result
  `1`. The temporary `any`-cast diagnostic used during triage is not a fixture
  rewrite and is not counted as a gain.
- `tests/issue-5199-generic-yield-star.test.ts`: **27/27 pass** under one
  compiler worker, with the same standalone/import/valid-Wasm assertions.
- The prototype fixes were: preserve a generator state's explicit/factory
  prototype instead of re-seeding its borrowed closure bag with
  `%Function.prototype%`; bypass the closed-plain-object `getPrototypeOf` fold
  after integrity operations for native generators; and make a non-native
  result from a mutable protocol method use ordinary property Get rather than
  treating it as a native `{ value, done }` struct and silently reading `0`.
- No current Test262 result is claimed from those fixture runs. The former
  `44/44` protocol/control result belongs to the stale source/provider and is
  historical only. The compiler bundle and QuickJS provider must be rebuilt
  after the upstream merge before any exact-corpus comparison.

### Current bridge repairs and why they are bounded

- A captured `var g = producer()` was planned against its hoisted `externref`
  slot before the initializer refined `g` to the native generator-state ref.
  A synchronous generator declaration that captures exactly such a binding now
  uses the existing capture cell; its initializer writes the cell rather than
  leaving the captured pre-init carrier at `undefined`. This is deliberately
  limited to synchronous generator declarations, whose function-value
  materialization initializes the factory/prototype view. Plain nested
  functions retain their by-value timing.
- A direct native generator factory returns its private state struct, while a
  first-class function value must match the checker-visible `Generator`
  closure ABI. Generator-state-only wrapper signatures now publish
  `externref`, with `extern.convert_any` at the trampoline return. This makes
  the registry's `ClosureInfo.returnType` agree with the dynamic call
  candidates without loosening any unrelated reference result signature.
- State instances use the ordinary identity-keyed expando bag but are not
  callable closure wrappers. The delete carrier recognizes only the exact
  registered native-state type set, restoring inherited `next` and
  `Symbol.iterator` after an own shadow is deleted; it does not widen the
  generic closure-carrier predicate.

The rebuilt local bundle is
`33dba5253a70deebe42a5f35ef04bfbb2244bbc2b8b6f484725416588188ac9a`.
Its QuickJS provider used artifact
`073742801ba76347` and canary-verified adapter `d9d66a61210e4856`. On this
pre-integration source, original bridge9 is **9/9** with successful compile,
`imports=[]`, valid Wasm, and result `1`; original prototype11 and generic27
plus the three isolated bridge tests are **41/41**. These remain source-level
evidence until the required integrated-head rerun.

The authoritative standalone ES2015 JSONL for subsequent measurements is
`/Users/thomas/Code/js2/.test262-cache/test262-standalone-current.jsonl`,
SHA-256 `45ff56e7570bba0a1bff6590d19d35de2525928adb7e3054789ba35aebb29360`:
11,704 rows (10,230 pass, 1,144 fail, 329 compile_error, 1 timeout). All
cohorts use one compiler worker and exact corpus paths.

### Required integrated validation

The historical `44/44` path list and legacy-control script were untracked
artifacts and cannot be recovered. Their result remains historical and is not
an acceptance claim. Do not reconstruct a lookalike list or report it as an
exact rerun.

The reproducible **2026-09-12 protocol36+B8** current-head protocol/control
matrix is
[`2026-09-12-es2015-generator-protocol-current-head-paths.txt`](../log/2026-09-12-es2015-generator-protocol-current-head-paths.txt):

- Lines 1–36 are the current exact corpus set of all
  `test/language/expressions/yield/star-rhs-iter-*.js`, plus
  `star-iterable.js`, `star-return-is-null.js`, and `star-throw-is-null.js`.
  They are the owned protocol rows and must be remeasured, not inferred from
  stale output.
- Lines 37–44 are the B controls selected from the authoritative JSONL, all
  currently `pass`: `star-array.js`, `star-string.js`, `rhs-iter.js`,
  `rhs-omitted.js`, `in-iteration-stmt.js`, `from-try.js`,
  `from-catch.js`, and `then-return.js`.

After the normal upstream merge and provider rebuild, rerun that exact
2026-09-12 protocol36+B8 matrix
matrix with the maintained isolated runner, the original prototype11, the 27
generic-yield-star pins, original bridge9, and the permanent named
legacy-producer test. Record zero losses across the B controls and keep
`imports=[]` plus valid Wasm for standalone fixture claims. The result of that
integrated run, not the local checkpoint above, decides whether the PR is
merge-ready or a useful draft.

### Separate numeric-payload and closed-identity residual

Numeric generators still need an independent payload ABI decision. Do not
convert caller-supplied sent/return values to the yielded `f64` merely because
the yield element is numeric. The follow-up implementation plan is:

1. Split `payloadValType` / public result value representation from the
   optimized yielded-element carrier in native generator state, resume,
   abrupt completion, and dispatch helpers.
2. Thread the raw externref payload through `next`, `return`, and completion
   construction, then retain a proven numeric fast path only at consumers that
   actually require numeric arithmetic.
3. Re-run the three original object-payload controls (suspended return,
   completed return, ignored next) with `imports=[]` and valid Wasm before
   counting a Test262 gain.

Closed-object identity has a no-generator control failure and is therefore not
attributable to this protocol bridge. It remains a separate object-carrier
substrate dependency: retain the no-generator control in the handoff, do not
relabel it as a generator regression or a passing payload result, and coordinate
with the owner before changing closed-object representation.

Full resumption details and exact local commands are in
[the 2026-09-12 rescue handoff](../log/2026-09-12-es2015-generator-protocol-rescue-handoff.md).
