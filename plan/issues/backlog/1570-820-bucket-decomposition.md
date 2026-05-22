---
id: 1570
title: "#820 bucket decomposition — 2026-05-21"
parent: 820
status: analysis
created: 2026-05-21
baseline: "benchmarks/results/test262-current.jsonl (21.5.2026 00:24)"
---

# #820 Bucket Decomposition — 2026-05-21

Baseline: `test262-current.jsonl` from 21.5.2026 00:24. Filtering `scope_official=true, status=fail`.

## Current totals across the three umbrella sub-buckets

| `error_category` | Count | vs 2026-05-21 senior-dev re-analysis |
|------------------|-------|--------------------------------------|
| `null_deref`     | 569   | unchanged (same baseline) |
| `type_error`     | 506   | -2 |
| `illegal_cast`   | 241   | unchanged |
| **Total**        | **1,316** | umbrella shrunk from 6,993 → 1,316 (Temporal rescoped + sub-issues landed) |

## Cluster table (root-cause groupings)

| # | Cluster | Count | Sample error | Likely source location | Sub-issue |
|---|---------|-------|--------------|------------------------|-----------|
| A1 | RegExp `Symbol.replace/match/search/split/matchAll` null deref | 135 | `L#:# dereferencing a null pointer [in test()]` | `src/codegen/builtins/regexp.ts` — match-result consumption forgets to re-check null before reading `.index`/`.length` | **#820a** (closed per task #60) — residual ≈135 suggests baseline pre-merge; verify on next run |
| A2 | `class/dstr async-gen-meth-*` illegal cast | 104 | `L#:# illegal cast [in __closure_N() ← assert_throws ← test]` in `expressions/class/dstr/async-gen-meth-dflt-{ary,obj}-ptrn-*-init-unresolvable.js` | `src/codegen/literals.ts` binding-element exclusion → default-init closure compiles `ref.cast` against the wrong type when init is `unresolvable`; closely related to #1543 (closed) but a fresh sub-cluster | **NEW: #820d** — async-gen-meth default-init `unresolvable` cast |
| A3 | `language/expressions/object/method-definition` async-gen `yield*` null deref | 40 | `L#:# dereferencing a null pointer [in __anon_1_method() ← __obj_meth_tramp...]` | async-iterator protocol in object-method tramp; `src/codegen/expressions/yield.ts` + tramp closure builder | **#820c** (in-progress per task #61) |
| A4 | `class/dstr private-meth/private-gen/private-async-gen` null deref | 18 | `L#:# dereferencing a null pointer [in C___priv_method() ← test]` | Private-method dstr lowering re-uses the wrong receiver shape under destructured params | **NEW: #820e** — private-method dstr null deref |
| A5 | `dynamic-import/usage` null deref | 22 | `L#:# dereferencing a null pointer [in test()]` | Dynamic `import()` evaluator returns null promise on certain module-load paths | **NEW: #820f** — dynamic-import promise wiring |
| A6 | `Object.defineProperty called on non-object` (annexB eval-code + global) | 62 (from `type_error` bucket; 100 if combined w/ runtime_error) | `TypeError: Object.defineProperty called on non-object` | `src/codegen/index.ts` global-init path — primitives leak into `Object.defineProperty` receiver in `annexB/language/eval-code/{direct,indirect}` + `global-code` | overlaps with #929; recommend **scoping #929** explicitly to annex-B paths |
| A7 | `type_error: Cannot access property on null or undefined` (generic) | 381 | `TypeError: Cannot access property on null or undefined at #:#` | Spread across language/expressions, language/statements, built-ins/Function (44), Object (26), DisposableStack (25), AsyncDisposableStack (23), Generator/AsyncGenerator prototypes (36) | **Per-built-in sub-issues** — see breakdown below |
| A8 | `for-of/for-await-of dstr` illegal cast | 6 + 8 | inherits #1544 path | residual after #1544; minor | low priority residual |
| A9 | `language/expressions/assignment/dstr` mixed | ~15 (type_error) + 3 (illegal_cast) | various | residual after #1431 | low priority residual |
| A10 | `language/module-code/namespace/internals` type_error | 8 | `TypeError: Cannot access property on null or undefined` | module namespace `[[Get]]` proxy semantics | **NEW: #820g** — module namespace property access |

### A7 sub-breakdown (the `Cannot access property` 381-strong residual)

| Sub-cluster | Count | Likely fix |
|-------------|-------|------------|
| `language/statements/*` (mostly try/with/for-in receiver coercion) | 57 | Spec — receiver coercion at `MemberExpression` |
| `language/expressions/*` | 56 | Spec — likely `OptionalExpression` / `CallExpression` short-circuit |
| `built-ins/Function/prototype/toString` etc. | 44 | Function intrinsic-method receiver validation (currently absent) |
| `built-ins/{Disposable,AsyncDisposable}Stack/prototype/disposed` | 48 | Receiver brand check on stub builtins |
| `built-ins/Object` | 26 | Object.* receiver coercion (toObject) |
| `built-ins/{Generator,AsyncGenerator}Prototype` | 36 | Generator brand check + iterator protocol error message |
| `built-ins/Array` | 19 | Array.prototype.* on null/undef receiver |
| `built-ins/String` | 19 | String.prototype.* on null/undef receiver |
| Other | ~75 | Long-tail per-built-in |

## Recommended sub-issues (priority order)

| Priority | Sub-issue | Title | Est. FAIL reduction | File(s) to fix |
|----------|-----------|-------|---------------------|----------------|
| 1 | **#820d** | `class/dstr async-gen-meth` default-init `unresolvable` illegal cast | ~104 | `src/codegen/literals.ts`, binding-element default-init closure typing |
| 2 | **#820h** | DisposableStack / AsyncDisposableStack brand check on `.disposed` and protocol methods | ~48 | `src/codegen/builtins/disposable-stack.ts` (or wherever) |
| 3 | **#820i** | Function.prototype.* (toString, bind, call, apply) receiver validation | ~44 | `src/codegen/builtins/function.ts` |
| 4 | **#820j** | Generator/AsyncGenerator prototype brand check + better TypeError messages | ~36 | `src/codegen/builtins/generator.ts` |
| 5 | **#820k** | Object.* TypeError on null/undefined receiver (ToObject step) | ~26 | `src/codegen/builtins/object.ts` (entry point) |
| 6 | **#820f** | Dynamic-import: null pointer on certain module-load paths | ~22 | Dynamic-import lowering (likely `src/codegen/expressions/dynamic-import.ts`) |
| 7 | **#820e** | `class/dstr` private-method/private-gen null deref under dstr params | ~18 | Private-method dstr lowering in `src/codegen/literals.ts` / class-element pipeline |
| 8 | **#929-scoped** | Scope existing #929 to annex-B eval-code `defineProperty` on primitive receivers | ~62 | `src/codegen/index.ts` annex-B eval shim |
| 9 | **#820g** | Module namespace object `[[Get]]` returns null on certain re-exports | ~8 | Module-resolver namespace builder |

**Total addressable across the new sub-issues: ~368 fails** (~28% of the 1,316
umbrella; remainder is long-tail per-built-in receiver validation that
benefits from a single "receiver brand check" helper landing in
`src/codegen/builtins/*`).

## Notes on stale-looking clusters

- A1 (RegExp Symbol.*) is supposed to be closed by **#820a** (task #60
  completed). The 135 residual probably means the merge to main is recent and
  the baseline was generated before promotion. Re-validate after the next
  `Test262 Sharded` push to main.
- A2 (class/dstr async-gen-meth) was nominally closed by #1543 (task #30) but
  the 104 still-failing tests share a tighter signature (`-init-unresolvable`)
  that the #1543 fix did not address. This is a genuine **new** sub-issue.
