---
id: 4691
title: "ES2015 standalone class-method array destructuring preserves explicit null"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-26
completed: 2026-08-25
priority: high
feasibility: medium
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [4450, 4447, 4690]
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# #4691 — ES2015 standalone class-method array destructuring preserves explicit null

## Scope and authoritative rows

The authoritative artifact is `/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`, timestamped `25.8.2026, 04:31:12` onward and recorded at oracle version 13. It contains **24** non-pass `class/dstr/*init-skipped.js` rows. This issue takes the bounded **4-row plain-method subset** (no generator, async-generator, private-generator, computed-key, derived-constructor, or for-of lowering):

- `test/language/expressions/class/dstr/meth-ary-ptrn-elem-id-init-skipped.js`
- `test/language/expressions/class/dstr/meth-static-ary-ptrn-elem-id-init-skipped.js`
- `test/language/statements/class/dstr/meth-ary-ptrn-elem-id-init-skipped.js`
- `test/language/statements/class/dstr/meth-static-ary-ptrn-elem-id-init-skipped.js`

All four artifact rows are `status: fail`, `error_category: assertion_fail`, with signature `assertion_fail:Test262Error: Expected SameValue(«undefined», «null») to be true`. The remaining 20 rows are generator/async-generator/private-generator variants and are explicitly out of scope for this slice.

## Current-main reproduction

On branch base `02db64c27d9b82a0d76ee4576c344b95b714d801` (latest cached `upstream/main`), the authoritative `runTest262File(file, "class-dstr-init-skipped", 120000, "standalone")` pins reproduce all four rows as `fail`. Each fails at the first assertion `assert.sameValue(w, null)`, reporting `Expected SameValue(«undefined», «null») to be true`:

| file subset | result |
| --- | --- |
| 4/4 exact files | `fail` |
| first assertion | `w` is `undefined`, expected explicit `null` |
| initializer side effects | not reached in the failing assertion; the test passes `[null, 0, false, '']` |

The artifact and current-main run agree on the semantic signature; this is not a host-import or generator failure.

## Root-cause hypothesis (confirmed)

The class method reaches the shared array binding-parameter path in `src/codegen/destructuring-params.ts` through `src/codegen/class-bodies.ts` with an `externref` parameter. Class bodies are emitted before their call sites, so the call-site literal `[null, 0, false, '']` is lowered as a heterogeneous tuple type that is not present when the method's tuple fast-path candidates are built. The unknown tuple then falls through the generic iterable materialization path; its first read yields the undefined carrier instead of the present `null`. Plain functions do not reproduce this because their body is emitted after the call-site tuple is known. The fix forces only the known class-method `externref` array-literal argument sites through the lossless vec carrier, leaving `emitBoundsCheckedArrayGetUndef`'s out-of-bounds/holes-as-undefined behavior unchanged.

## Plan

1. Confirm the class-only tuple-registration ordering and a passing plain-function control.
2. Force only class-method array literals targeting `externref` through the lossless vec carrier.
3. Add focused regression coverage for the four exact class-expression/declaration and instance/static variants.
4. Re-run the four exact `runTest262File(..., "standalone")` pins plus baseline-pass controls and the normal pre-push checks.

## Risks and non-goals

- Do not touch generator/async-generator/private-generator class methods; those 20 residual rows remain separate work.
- Do not touch computed class keys or derived-constructor return handling (open class work), and do not touch `#4908`/for-of destructuring code.
- Do not rewrite the broad destructuring ABI or iterator materialization layer. If the class-call-site carrier fix does not preserve explicit null, stop and report the slice blocked rather than expanding it.
- The fix must not turn out-of-bounds or actual holes into null; those must remain `undefined` so element defaults still fire per [ECMAScript IteratorBindingInitialization](https://tc39.es/ecma262/2026/multipage/ecmascript-language-statements-and-declarations.html#sec-runtime-semantics-iteratorbindinginitialization).

## Acceptance

- All four pinned rows pass in standalone mode.
- A positive control with an explicit non-null element and a negative control with an absent/undefined element retain their existing behavior.
- No new standalone host imports, no generator/for-of source changes, and no unrelated class residual regressions in the focused controls.
- Source change remains ≤150 LOC and the PR carries this issue file with measured results.

## Test Results

All commands used the pinned PATH `PATH=/private/tmp/codex-pnpm10/node_modules/.bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH`.

- Validation was repeated after fast-forwarding `upstream/main` from `02db64c27` to `5a4a0f07c`.
- `pnpm exec vitest run tests/issue-4691.test.ts --reporter=verbose`: **6/6 passed** (one exact-pin test covering four rows, four class instance/static probes, and the absent-element default control).
- Exact `runTest262File(file, "issue-4691-exact", 120000, "standalone")` pins: **4/4 passed**.
  - `expressions/class/dstr/meth-ary-ptrn-elem-id-init-skipped.js` → pass (SHA `6c9a8d7d74b6`)
  - `expressions/class/dstr/meth-static-ary-ptrn-elem-id-init-skipped.js` → pass (SHA `8407679f512e`)
  - `statements/class/dstr/meth-ary-ptrn-elem-id-init-skipped.js` → pass (SHA `f1438ca086b8`)
  - `statements/class/dstr/meth-static-ary-ptrn-elem-id-init-skipped.js` → pass (SHA `995a8298557c`)
- Baseline-pass controls through the same standalone runner: **4/4 passed**:
  - `expressions/function/dstr/ary-ptrn-elem-id-init-skipped.js`
  - `statements/function/dstr/ary-ptrn-elem-id-init-skipped.js`
  - `expressions/class/dstr/meth-dflt-ary-ptrn-elem-id-init-skipped.js`
  - `expressions/class/dstr/meth-static-dflt-ary-ptrn-elem-id-init-skipped.js`

## Intended files

- `src/codegen/expressions/internal-call-argument.ts` (opt-in lossless array-literal carrier)
- `src/codegen/expressions/call-receiver-method.ts` (instance class-method call site)
- `src/codegen/expressions/call-namespace-static.ts` (static class-method call site)
- `tests/issue-4691.test.ts`

## Integration follow-up

The combined conformance branch retained a wider version of the carrier
override: it routed unrelated namespace-static arguments through internal-call
adaptation and changed the default identifier probe to compile with an expected
type. The queue merge group exposed three host `Object.defineProperty`
regressions from that widening.

The integration repair keeps the pre-existing host/default lowering verbatim
and enters the override only for standalone/WASI array literals passed to class
method array binding patterns. `tests/issue-4691.test.ts` passes 7/7, and the
assembled host harness passes all three descriptor rows that failed before the
repair (3/3).
