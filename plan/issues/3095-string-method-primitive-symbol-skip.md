---
id: 3095
title: "String.prototype.{match,search,replace,replaceAll,split} must not access Symbol.<method> on primitive search values"
status: done
completed: 2026-07-08
created: 2026-07-08
updated: 2026-07-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: string-symbol-dispatch
goal: spec-completeness
sprint: current
horizon: s
related: [1443, 1439]
---

# #3095 - String.prototype methods must not observably access Symbol.<method> on primitive search values

## Problem

Per ECMA-262, `String.prototype.{match,matchAll,search,replace,replaceAll,split}`
only look up the argument's well-known `Symbol.<method>` (`@@match`, `@@replace`,
etc.) when the search value **is an Object**. When it is a primitive
(number/string/boolean/bigint) they go straight to the "regexp is not an Object"
branch and must NOT observably access the property.

js2wasm delegates these methods to the JS host (`recvStr[method](arg)`). The host
(Node) still runs `GetMethod` on the primitive's wrapper prototype, so a
user-defined `Number.prototype[Symbol.match]` / `String.prototype[Symbol.replace]`
/ etc. accessor gets triggered — failing 23 test262 `cstm-*-on-*-primitive`
tests with `should not be called`.

Failing cluster (harvested from baseline):
`test/built-ins/String/prototype/{match,matchAll,search,replace,replaceAll,split}/cstm-*-on-{bigint,boolean,number,string}-primitive.js`

## Fix

In the `string_method` host shim (`src/runtime.ts`), when the first arg is a
primitive whose prototype chain actually defines the relevant well-known Symbol
(checked with `in`/HasProperty, which does **not** trigger getters), pre-build
the RegExp the spec's not-Object branch would create and hand _that_ to the host
method. The host then dispatches on the built-in `RegExp.prototype` Symbol
methods and never touches the primitive's prototype:

- `match` / `matchAll` / `search`: primitive is a **pattern** → `new RegExp(String(v)[, "g"])`
- `replace` / `replaceAll` / `split`: primitive is a **literal string** → `new RegExp(escape(String(v))[, "g"])`

The reroute only engages when the Symbol property actually exists on the
primitive's prototype, so the common no-override case is byte-identical to
before (zero behavior change on the hot path).

## Scope

Fixes match/search/replace/replaceAll/split (20 tests). `matchAll` on a string
receiver (3 tests) takes a **different codegen path** (dynamic `Cache_matchAll`
dispatch, not the `string_method` host shim), so this host-shim fix does not
reach it — left as a follow-up (no regression: still fails as before).

## Verification

- 20 real test262 `cstm-*` files pass via `runTest262File` (per-test isolation).
- No regression across regexp / string-split / Symbol-protocol (#1439/#1443/#2161)
  equivalence suites.
