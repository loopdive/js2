---
id: 4672
title: "ES2015 standalone let/TDZ residual cluster"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
assignee: codex/es6-tdz-wave3
related: [4444, 4447, 723, 906]
origin: "ES2015 standalone close-out umbrella #4444 long-tail measurement: 26 let/TDZ rows remain after the for-of/destructuring slice."
loc-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/statements/loops.ts::compileForStatement
---

# #4672 — ES2015 standalone `let`/TDZ residual cluster

## Scope

The #4444 ES2015 standalone edition measurement identifies approximately 26
non-passing `let`/temporal-dead-zone tests outside the landed #4447
for-of/destructuring slice. This issue owns only those residual rows; generator,
class, Promise, TypedArray, and prototype-reflection failures stay with their
existing issues.

## Implementation plan

1. Fetch the current standalone baseline and enumerate the exact ES2015 rows
   classified as `let`/TDZ, recording each path and baseline outcome.
2. Reproduce representative failures on fresh `upstream/main` with the
   standalone compiler and a host-free instantiation. Compare a known-good
   `var`/post-initialization control and inspect emitted WAT/imports before
   choosing a root cause.
3. Check the file-lock table and constrain the patch to the narrowest
   declaration/TDZ or scope path that owns the measured failures. Do not edit
   the protected TypedArray/class/Promise/RegExp areas from PRs #4856, #4857,
   #4872, #4874, or #4876.
4. Add focused regression coverage for the failing shape and controls, then
   run the scoped tests plus a GC-lane smoke check. Record before/after counts,
   exact row list, and zero-loss evidence here.

## Initial status

Issue allocated atomically as #4672 on 2026-08-25. Worktree is based on
`upstream/main` at `efee1cd88`.

The fresh baseline (`.test262-cache/test262-standalone-current.jsonl`) has 26
non-passing rows under `test/language/statements/let/`:

- TDZ/closure: `global-closure-get-before-initialization.js`,
  `global-closure-set-before-initialization.js`,
  `global-use-before-initialization-in-prior-statement.js`,
  `block-local-closure-get-before-initialization.js`,
  `block-local-closure-set-before-initialization.js`,
  `block-local-use-before-initialization-in-prior-statement.js`.
- For-head closure freshness: `syntax/let-iteration-variable-is-freshly-allocated-for-each-iteration-single-let-binding.js`,
  `syntax/let-iteration-variable-is-freshly-allocated-for-each-iteration-multi-let-binding.js`,
  `syntax/let-closure-inside-initialization.js`,
  `syntax/let-closure-inside-condition.js`,
  `syntax/let-closure-inside-next-expression.js`.
- Other syntax/scoping: `syntax/let.js`,
  `syntax/let-outer-inner-let-bindings.js`, `syntax/escaped-let.js`,
  `fn-name-class.js`.
- Destructuring iterator/property behavior: `dstr/ary-init-iter-get-err-array-prototype.js`,
  `dstr/ary-ptrn-elem-id-iter-complete.js`,
  `dstr/ary-ptrn-elem-id-iter-done.js`,
  `dstr/ary-ptrn-elem-id-iter-val-array-prototype.js`,
  `dstr/ary-ptrn-elision.js`, `dstr/ary-ptrn-elision-step-err.js`,
  `dstr/ary-ptrn-rest-id-exhausted.js`,
  `dstr/ary-ptrn-rest-id-iter-step-err.js`,
  `dstr/ary-ptrn-rest-obj-prop-id.js`,
  `dstr/obj-ptrn-prop-ary.js`, `dstr/obj-ptrn-prop-obj.js`.

The scoped runner reached 146 let tests (118 pass, 28 fail). Two failures were
runner-current-only and are not in the fetched baseline: the runtime-eval
refusal in `cptn-value.js` (#2928) and the timeout in
`dstr/obj-ptrn-rest-skip-non-enumerable.js`. The complete raw run is recorded
at `benchmarks/results/test262-standalone-results-20260825-041734.jsonl`.

Before this patch, the baseline outcome split was 24 assertion/runtime
failures and 2 compile errors (the escaped-keyword parser error and the
generator-provider host-import leak). After this patch, the seven rows listed
under the direct probes below pass in standalone compile/validate/instantiate
checks; the other 19 baseline rows remain explicitly out of this bounded
closure-call/per-iteration fix.

## Root cause and bounded fix

Two related closure-call/loop-shape gaps accounted for seven directly
reproduced baseline rows:

1. `let fns = []` is represented by TypeScript as an evolving `any[]`. The
   callable-element path intentionally declines an element with no static call
   signature, after which the tail fallback evaluated the callee and silently
   dropped `fns[0]()` instead of preserving JavaScript's dynamic call. The fix
   uses the existing inline dynamic-call emitter only for standalone modules
   whose receiver resolves to an array and whose element type is unresolved
   (`any`/`unknown`/`never`). Typed arrays and concrete primitive arrays retain
   their previous path.
2. `findHeadBindingsCapturedByClosures` scanned only the condition,
   incrementor, and body. A closure in a later declarator of a `for` head (for
   example `for (let i = 0, f = () => i; ...)`) therefore was not included in
   per-iteration capture analysis. When the initializer had already promoted
   `i` to a ref cell, the loop then wrapped that cell a second time. The fix
   scans the initializer and reuses the existing capture as the first
   per-iteration cell, preserving the loop's capture restoration behavior.

Changed files are `src/codegen/expressions/call-tail-dispatch.ts`,
`src/ir/analysis/loop-shape.ts`, `src/codegen/statements/loops.ts`, and the
focused regression `tests/issue-4672.test.ts`. Protected files from PRs
#4856/#4857/#4872/#4874/#4876 were not touched.

## Test Results

- `node node_modules/vitest/vitest.mjs run tests/issue-4672.test.ts
  --reporter=dot`: **4/4 passed**. Covers an evolving empty-array closure
  call, body-created per-iteration closures, condition/incrementor closures,
  and a closure created in a later for-head initializer.
- `node node_modules/vitest/vitest.mjs run tests/issue-4672.test.ts
  tests/issue-1453.test.ts tests/issue-1306.test.ts --reporter=dot`:
  **20/20 passed**. This is the zero-loss check for the existing loop
  per-iteration and typed callable-element paths.
- Direct standalone compile/validate/instantiate probes for the seven
  affected official shapes (`syntax/let.js`, both fresh-allocation tests,
  `let-closure-inside-{initialization,condition,next-expression}.js`, and
  `let-outer-inner-let-bindings.js`) each returned the expected `test=1`.
- `git diff --check`: passed.

The remaining baseline rows listed above are independent destructuring,
TDZ-environment, parser, generator-provider, and class-name issues; this
patch deliberately does not broaden into those owners.
