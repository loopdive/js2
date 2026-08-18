---
id: 4383
title: "UUID original suite exposes vector, crypto, exception, and callback ABI gaps"
status: in-progress
sprint: current
created: 2026-08-12
updated: 2026-08-13
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: arrays, closures, exceptions, crypto
goal: npm-library-support
assignee: ttraenkler/codex
related: [3995]
files:
  - tests/dogfood/uuid-upstream-suite.mjs
  - tests/dogfood/report/uuid-upstream-suite.json
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
  - src/runtime.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/array-methods.ts
  - src/codegen/index.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/closures.ts
  - src/codegen/closure-exports.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/object-runtime.ts
  - src/codegen/binary-ops.ts
  - src/codegen/registry/imports.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/context/types.ts
  - src/codegen/literals.ts
  - src/codegen/statements/variables.ts
  - src/codegen/declarations/object-shape-widening.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
  - src/runtime.ts::<anonymous>#89
  - src/codegen/vec-access-exports.ts::_emitVecAccessExportsInner
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/statements/nested-declarations.ts::emitSetExtrasArgv
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/index.ts::generateModule
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
coercion-sites-allow:
  - src/codegen/closure-exports.ts
---

# UUID original suite exposes vector, crypto, exception, and callback ABI gaps

## Problem

The pinned `uuid@14.0.1` adapter runs ten original upstream files and all 75
registered callbacks pass in Node. Only **3/75** pass after compiling the same
callbacks and the published implementation to Wasm. This is runtime evidence,
not an extrapolation from compiler diagnostics.

Nine generated test modules validate. `v7.test.ts` instead emits an invalid
callback trampoline:

```text
__call_fn_2: call_ref[1] expected i64, found externref
```

That single ABI defect blocks all 14 v7 callbacks before execution.

## Measured failure buckets

The runner records the thrown assertion/error text for every callback. The
remaining 58 executing failures cluster as follows:

- byte-vector parsing/stringification and output-buffer writes return unequal
  arrays or `undefined` strings (`parse`, `stringify`, v4, and v6);
- v1's option/state path traps with `RuntimeError: illegal cast` in all ten
  selected callbacks;
- v3/v5 digest helpers produce empty output, namespace/property reads become
  null, and expected exceptions are not preserved;
- the Node RNG path reports length 0 instead of 16, while v4's native-random
  probes report `crypto is not defined`;
- `validate` and `version` table cases observe null/undefined results rather
  than the published helper results.

The exact names and messages live in the generated
`tests/dogfood/report/uuid-upstream-suite.json`; the headline alone is not the
acceptance oracle.

## Acceptance criteria

- [x] `v7.test.ts` emits valid Wasm and its 14 callbacks execute.
- [x] The v1 illegal-cast cluster is reduced to a minimal compiler regression
      and fixed without UUID-specific source rewriting.
- [ ] Byte-vector parse/stringify/buffer-offset behavior matches Node.
- [ ] Node-platform `crypto`/RNG capability is either provided honestly or
      reported as unavailable without silently returning wrong bytes.
- [ ] Expected RangeError/validation paths preserve throw behavior.
- [ ] The unchanged original suite reaches 75/75 Node and 75/75 Wasm, with zero
      harness-incompatible tests.

## 2026-08-12 implementation checkpoint

The unchanged pinned suite reaches **10/75 Wasm** with **75/75 Node**, up from
**3/75 Wasm** on current `main`. All ten generated modules compile and validate;
`main` validates only nine because `v7.test.ts` has a callback ABI mismatch.

The seven newly passing callbacks are three v1 cases formerly blocked by an
illegal cast, one v4 option-path case, and three v7 cases formerly blocked by
the invalid module. Focused reductions pass 16/16 and cover typed-array identity,
optional and shadowed callables, missing option fields, and collision-safe
struct reads. This is a real compatibility increment, but it does not fix the
broad vector, crypto, digest, exception, and dynamic-state failures: **65/75**
upstream callbacks still fail and remain follow-up work for the final 75/75
acceptance target.

## 2026-08-16 re-measure (main `a9b20d4c`, curated-suite triage)

Still **10/75 Wasm, 75/75 Node**, all ten modules validate — unchanged from
the 2026-08-12 checkpoint; the 65 remaining failures bucket as:

| bucket | count | note |
| --- | --- | --- |
| `[object WebAssembly.Exception]` (uncaught wasm exception) | 24 | v35 digest paths + v1/v6/v7 option/state paths |
| `RuntimeError: illegal cast` | 21 | v1/v6/v7 dynamic-state clusters |
| assertion: `Invalid UUID` / stringify invalid | 7 | byte-vector parse/stringify round-trips |
| `crypto.getRandomValues: argument is not a typed-array (Uint8Array required)` | 6 | compiled Uint8Array loses host typed-array identity (see `tests/issue-4383-uuid-typed-array-identity.test.ts`) |
| `crypto is not defined` | 3 | v4 native-random probes |
| validate/version null-result table cases | 4 | helpers return null/undefined |

Per-file: `v35` 0/21 · `v7` 0/14 · `v1` 0/10 · `v6` 0/8 · `v4` 6/10 ·
`parse` 1/5 · `stringify` 3/4 · `rng` 0/1 · `validate` 0/1 · `version` 0/1.
The open acceptance boxes above are all still open; no drift, no progress
since the checkpoint.

## Reproduction

```bash
node --import tsx tests/dogfood/uuid-upstream-suite.mjs --json
```

## 2026-08-13 merge-group regression handoff

The first merge-group attempt exposed 74 host-lane and 99 standalone
candidate regressions. The host set now reproduces at **74/74 passing** after
generic fixes for function-value observation, internal-call arguments,
nullish property reads, symbol-key widening, optional `super` calls, async
hoisting, and null-prototype native host objects.

Standalone reruns recovered 86 of the 99 rows after the current-main merge. Two additional generic routing
fixes keep primitive `valueOf()` and constructor-assigned methods on the native
standalone paths. The 13 locally unresolved rows are not changes introduced by
this branch: the exact pre-PR source also fails them in the current checkout.
They cover three tests requiring the unavailable local QuickJS artifact, one
absent Test262 harness file, and nine pre-existing module-binding cases. The
exact 74 host regressions now pass 74/74, the 86 locally executable standalone
rows pass, and the authoritative merge-group baseline remains the final oracle
before removing the hold label.
