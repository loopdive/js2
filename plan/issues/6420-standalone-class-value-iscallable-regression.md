---
id: 6420
title: "Standalone IsCallable conflates class values with `typeof \"function\"` after #5383's class-value tag repair"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: classes
goal: standalone-mode
requested_by: ttraenkler/codex-5350-super-rescue
related: [5350, 5383, 4221, 5242]
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/registry/imports.ts
  - src/codegen/expressions/new-super.ts
func-budget-allow:
  - src/codegen/typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/registry/imports.ts::addUnionImportsAsNativeFuncs
---

# #6420 — class values are not callable, even though `typeof classValue` is `"function"`

## Problem

#5383 correctly repaired dynamic class values so `typeof K === "function"`.
It did this in `src/codegen/typeof-natives-finalize.ts` by recognising the
lazily materialised class-object singleton by identity. A class constructor has
`[[Construct]]` but no `[[Call]]`, however. Calling it without `new` must throw
a `TypeError`; this is a different question from `typeof`.

The standalone object-literal `super` call path from #5350 currently guards the
resolved member using `__typeof_function`, then sends an accepted value into
`__apply_closure`. That makes a class value look callable and produces the
bridge's legacy nullish answer rather than a catchable `TypeError`.

The same conflation affects linked values. The wasm-to-wasm
`__js2wasm_link_callable_kind` terminal presently publishes bit 0 as
`__typeof_function(v)`, even though bit 0 is documented as `[[Call]]`. Simply
changing that bit would regress `typeof` on a provider-owned class, because the
consumer's current `typeof` arm masks only bit 0. The corrected protocol must
publish a real `[[Call]]` bit and have remote `typeof` accept either `[[Call]]`
or `[[Construct]]`.

The normative distinction is ECMAScript's `IsCallable` in
`EvaluateCall` versus the `typeof` operator: a class constructor is a function
for `typeof`, constructible via `new`, and not callable by `Call`.

## Baseline evidence

- `fork/codex/5350-super-property-rescue-20260912` identified this as the
  first-bad effect of #5383's class-value identity arm. Its pin is the object
  literal `super.v()` reduction where `v` is a class value.
- On the verified upstream baseline `405dfb5cacac05f98aaf20d41c794034c6d9f41f`,
  `src/codegen/typeof-natives-finalize.ts` places class-object identity arms in
  the shared `closureI32Arms` used by `__typeof_function`, `__typeof_object`,
  and materialised `__typeof`.
- `src/codegen/expressions/new-super.ts` registers and calls
  `__typeof_function` solely as an `EvaluateCall` guard for an object-literal
  super member. Its existing test already has the failing class control.
- `src/codegen/standalone-link-boundary.ts` labels `callableKind` bit 0 as
  `[[Call]]`, but currently computes it through `__typeof_function`; it is the
  required linked-class companion of the local bug.

## Consumer inventory and scope boundary

`rg -l '__typeof_function' src` finds consumers in three broad groups:

1. Actual `typeof` and function-object classification (`typeof-delete.ts`,
   `typeof-natives-finalize.ts`, materialised tag integration, `instanceof
   Object`/`Function`, Function-toString and object-tag paths). These must keep
   class identity and remain on `__typeof_function`.
2. Object-admission and representation predicates that use the function result
   as the function half of `typeof x === "object" || typeof x ===
   "function"`. These are not `IsCallable` checks and remain unchanged.
3. Semantic `IsCallable` checks in callback, iterator, call, Reflect, and
   promise helpers. Many have historical refusal/partial-classifier contracts.
   This issue will not globally substitute them without a class-value witness
   and focused controls. The bounded call sites are the direct dynamic-call
   guard and the #5350 `super` guard, plus the boundary ABI that they use.

The implementation must not special-case object-literal `super`: it consumes a
dedicated, host-free predicate with the same carrier definition direct dynamic
calls use. Existing ordinary call sites that intentionally rely on `typeof`
stay unchanged.

## Implementation plan

1. Reserve a host-free `__is_callable(externref) -> i32` native alongside the
   `__typeof_*` helpers in `registry/imports.ts`, and register it in the
   native-only late-import set. It deliberately does not enter the host import
   manifest: its initial refusal body is a defined native until the finalizer
   fills it.
2. In `typeof-natives-finalize.ts`, factor the finalized carrier arms so
   `__is_callable` accepts compiled closures, bound functions, async and
   generator closures, runtime-eval/provider carriers, callable builtin
   carriers, callable proxies, revokers, and linked `[[Call]]` values. It must
   deliberately omit class-object singleton identity. Keep the existing class
   identity arm exclusive to `__typeof_function` and materialised `__typeof`.
3. Correct the wasm-to-wasm callable-kind ABI: provider bit 0 calls
   `__is_callable`; bit 1 stays `__reflect_is_constructor`. For a peer value,
   `__typeof_function`/materialised `__typeof` classify `(kind & 3) !== 0` as
   a function so a linked class still reports `"function"`, while
   `__is_callable` accepts only `(kind & 1) !== 0`.
4. Route the common host-free dynamic-call guard and the object-literal
   `super` EvaluateCall guard through `__is_callable`, retaining existing
   operand order: resolve callee, evaluate all arguments, check callability,
   then invoke. A rejected class must throw before `__apply_closure` runs.
   Do not make a class-specific branch in the super lowering.
5. Add focused regressions for local and linked class values: direct and
   `super` calls throw `TypeError`, dynamic `typeof` stays `"function"`, and
   `new K` still executes the constructor. Retain/add positive controls for
   ordinary, bound, arrow, getter-returned, generator, async, builtin, and
   provider-linked callable values, plus a plain-object negative control.
6. Measure the affected maintained Test262 rows in standalone A/B against
   `405dfb5…`, record the row denominator and pass-to-fail difference, then run
   typecheck, lint, Prettier, ratchets, and applicable pre-push gates.

## Acceptance criteria

- Local and linked class values report `typeof === "function"`, remain
  constructible through `new`, and throw `TypeError` when directly or
  super-called.
- The call predicate is host-free and separate from `__typeof_function`; no
  object-literal-super-only class exception exists.
- Ordinary, bound, arrow, getter-returned, generator, async, builtin, and
  linked callables still invoke. Plain objects and missing members still throw.
- #5383 Temporal/provider behavior remains green, including linked `typeof` on
  a provider-owned class.
- The source/test scope remains limited to the shared predicate, its boundary
  ABI, direct/super guards, focused regressions, and this issue record.

## Verification record

Implementation developed from the verified baseline
`405dfb5cacac05f98aaf20d41c794034c6d9f41f`, first verified after the
`c645a7627e099173b0b3e0c5daa1d7b5a110a9d5` integration, then refreshed at
`7c8069cb0770e67014a8df4f42af48bbb7fb5736`, and finally verified after a
normal merge of strict upstream/main target
`cbeffc55aaf12cd26a52fcae811d2efa224c4dce` on
`codex/6420-class-value-iscallable-20260912`.

### Implemented surface

- Added a defined-native `__is_callable` and finalized it from the same
  carrier inventory as `__typeof_function`, with an explicit
  include-class/exclude-class mode. The class-object singleton identity arm is
  `typeof`-only.
- Routed host-free generic direct calls and the #5350 object-literal-super
  EvaluateCall guard through `__is_callable`, after callee and argument
  evaluation.
- Corrected linked-provider `callableKind`: bit 0 is `__is_callable`, bit 1 is
  `__reflect_is_constructor`; remote `typeof` accepts either bit while
  `__is_callable` accepts only bit 0.
- Routed a positive provider-owned callable to its provider apply terminal
  before the consumer's local closure dispatcher. This prevents a local
  dispatcher miss from shadowing a valid foreign callable with its legacy null
  sentinel; class values carry bit 1 only and are rejected earlier by the
  shared IsCallable guard.
- Added `tests/issue-6420-class-value-iscallable.test.ts` covering local and
  linked class values, plain-object rejection, and ordinary/bound/arrow/
  getter/generator/async/builtin/linked callable controls.

### Focused project regression evidence

- Baseline, exact #5350 pin command:
  `pnpm exec vitest run tests/issue-5350-super-property-r1.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose -t 'throws TypeError when an object literal'`
  at `405dfb5…`: **1 passed, 1 failed, 31 skipped**. The class-member row
  expected `2` and received `0`.
- Fixed tree, same command: **2 passed, 31 skipped** in 32.87s.
- `tests/issue-6420-class-value-iscallable.test.ts`: **3 passed** in 45.64s.
  It proves local `typeof`/direct-call/super-call/new/plain-object behavior,
  all listed callable controls, and a separately compiled provider class plus
  callable control.
- Full `tests/issue-5350-super-property-r1.test.ts`: **33 passed** in 78.82s.
- `tests/issue-5383-standalone-temporal-provider.test.ts -t 'S2f R12|S2g R14'`:
  **6 passed, 74 skipped** in 54.53s.
- The same file with `-t 'S2f R11|S2f R13'`: **4 passed, 76 skipped** in
  57.15s. These retain provider class `typeof`, local/linked construction,
  class-instance discrimination, and ordinary function construction.
- `pnpm typecheck`: passed.

### Post-integration evidence (`c645a762…` + #6420 working tree)

- `tests/issue-6420-class-value-iscallable.test.ts`: **3 passed** in
  83.50s.
- Full `tests/issue-5350-super-property-r1.test.ts`: **33 passed** in
  140.31s, including the class-super TypeError control and every callable
  carrier control.
- `tests/issue-5383-standalone-temporal-provider.test.ts -t 'S2f R11|S2f
  R12|S2f R13|S2g R14'`: **10 passed, 70 skipped** in 96.61s. This covers
  class-instance discrimination, local/provider class `typeof`, and local/
  provider construction.
- `pnpm typecheck`, `pnpm run lint`, and `pnpm run format:check`: passed.
  Biome retained its existing capped diagnostic summary but exited 0.
- `pnpm run check:oracle-ratchet`, `pnpm run check:coercion-sites`,
  `pnpm run check:codegen-fallbacks`, and `pnpm run check:stack-balance`:
  passed with no oracle/coercion/fallback/stack-fixup growth.
- `pnpm run check:loc-budget` and `pnpm run check:func-budget`: passed using
  only the frontmatter allowances above. They cover the four changed legacy
  carrier/dispatch functions and no baseline file was modified.
- Pre-push numeric-local control
  `tests/issue-3765-numeric-locals.test.ts`: **18 passed** in 104.82s.

### Intermediate strict-head refresh (`7c8069cb…`, merge commit `f63579cf…`)

- `tests/issue-6420-class-value-iscallable.test.ts`: **3 passed** in 87.48s.
- Full `tests/issue-5350-super-property-r1.test.ts`: **33 passed** in
  111.21s.
- `tests/issue-5383-standalone-temporal-provider.test.ts -t 'S2f R11|S2f
  R12|S2f R13|S2g R14'`: **10 passed, 70 skipped** in 101.05s.
- `pnpm typecheck`, `pnpm run lint`, and `pnpm run format:check`: passed.
  Biome again retained its capped existing-diagnostic summary but exited 0.
- `pnpm run check:oracle-ratchet`, `pnpm run check:coercion-sites`,
  `pnpm run check:loc-budget`, `pnpm run check:func-budget`,
  `pnpm run check:codegen-fallbacks`, and `pnpm run check:stack-balance`:
  passed with no unallowed ratchet growth.
- Pre-push numeric-local control
  `tests/issue-3765-numeric-locals.test.ts`: **18 passed** in 94.44s.

### Final strict-head refresh (`cbeffc55…`, merge commit `15c6dd65…`)

- `tests/issue-6420-class-value-iscallable.test.ts`: **3 passed** in 47.85s.
- Full `tests/issue-5350-super-property-r1.test.ts`: **33 passed** in 66.87s.
- `tests/issue-5383-standalone-temporal-provider.test.ts -t 'S2f R11|S2f
  R12|S2f R13|S2g R14'`: **10 passed, 70 skipped** in 56.30s.
- `pnpm typecheck`, `pnpm run lint`, and `pnpm run format:check`: passed.
  Biome retained its capped existing-diagnostic summary but exited 0.
- `pnpm run check:oracle-ratchet`, `pnpm run check:coercion-sites`,
  `pnpm run check:loc-budget`, `pnpm run check:func-budget`,
  `pnpm run check:codegen-fallbacks`, and `pnpm run check:stack-balance`:
  passed with no unallowed ratchet growth.
- Pre-push numeric-local control
  `tests/issue-3765-numeric-locals.test.ts`: **18 passed** in 74.96s.

### Maintained Test262 A/B

Used `scripts/harness-flip-probe.ts` in the standalone lane, which assembles
the upstream Test262 harness and asserts both a must-pass and must-fail control
before recording each arm. The before arm injected only the verified base
versions of the seven changed source modules at read time; the after arm used
the working tree. Neither arm used a committed CI baseline.

Exact rows:

1. `test/built-ins/Function/internals/Call/class-ctor.js` — `pass` → `pass`.
2. `test/staging/sm/class/classConstructorNoCall.js` — `skip` → `skip`
   (default scope excludes staging proposals).
3. `test/staging/sm/class/defaultConstructorNotCallable.js` — `skip` → `skip`
   (same scope rule).
4. `test/language/statements/class/arguments/default-constructor.js` —
   `fail` → `fail` (existing `args.length` failure, unrelated to this change).

The final `cbeffc55…` strict-head rerun has the identical verified partition:
**0 fail→pass, 0 pass→fail, 0 other changes, 4 unchanged, net 0**. The
normative direct class Call row remains a pass; the dynamic class-value
regression is represented by the focused host-free regression above because
these maintained rows do not exercise that alias/boundary shape.

### Handoff gates

- `node scripts/check-committed-issue-integrity.mjs HEAD`: passed on the final
  strict-head checkpoint (4,437 issue files scanned, all with frontmatter).
- `pnpm run check:issues` and `pnpm run check:issue-ids`: passed after the
  final strict-head handoff record was finalized.
- Do not widen the untouched historical `__typeof_function` consumers without
  a witnessed class-value path. Their legacy contracts remain outside #6420.

## Handoff

This issue is deliberately separate from #5350. The #5350 tests exposed the
fault, but the cause is #5383's correct `typeof` repair being reused as a
different abstract operation. Start from the verified upstream baseline above;
do not weaken the #5383 class `typeof` identity arm to make calls throw.

Residual scope note: Test262's maintained direct-class Call row was preserved;
the fuller dynamic/local/link boundary behavior is guarded by the new focused
regression and #5350/#5383 controls. No object-literal-super-only exception was
introduced. There is no remaining implementation blocker; the only residual is
the intentionally bounded non-migration of unrelated historical
`__typeof_function` consumers.

## Publication checkpoint

- Review PR: <https://github.com/loopdive/js2/pull/5849> (non-draft, targeting
  `loopdive/js2:main` from the authorized `ttraenkler/js2` fork).
- The implementation head `4fd5a582bbe7de375f2d0781cfd3cd06aa7fcda1`
  completed the repository PR workflows successfully. The strict-head refresh
  through `cbeffc55aaf12cd26a52fcae811d2efa224c4dce` and documentation checkpoint
  `23d0e676bbdc4d4eca1b37430dd092756365ca8b` retained all local gates above,
  but GitHub did not schedule the required `pull_request` workflows for that
  exact updated head.
- This publication-only issue update is the documented recovery checkpoint for
  that dropped `synchronize` delivery. The PR shepherd must certify the new
  exact head only after required CI has been scheduled and passed; it must not
  infer readiness from the earlier green head or merge the PR.
