---
id: 1990
title: "loose == between any object carrying toString/valueOf and a string throws TypeError: host_loose_eq lacks _toPrimitiveSync routing"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: host-interop
language_feature: equality
goal: core-semantics
related: [1989]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1990 — `o == "T"` throws instead of invoking the object's toString

## Problem

```ts
const o2: any = { toString() { return "T"; } };
String(o2 == "T")
// wasm: throws TypeError: Cannot convert object to primitive value (escapes to caller)
// node: "true"
```

Plain `{}` operands survive — only literals carrying valueOf/toString
methods crash, because the WasmGC struct's funcref field isn't a JS-callable
method from the host's perspective.

## Root cause

`src/runtime.ts:9044` — `host_loose_eq` applies JS `==` directly to the
operands; host-side ToPrimitive on the opaque struct throws. `__extern_has`
(runtime.ts:5300) already solves this with
`_toPrimitiveSync(..., callbackState)`; `host_loose_eq` lacks the
equivalent routing.

## Fix direction

In `host_loose_eq`, detect wasm struct operands and run `_toPrimitiveSync`
before applying `==`.

## Acceptance criteria

- Repro returns true without throwing
- `{} == "[object Object]"` keeps working

## Dupe check

#1134 introduced host_loose_eq (done); #1090/#1253/#1319/#983 done. No
open issue. New.

## Resolution (2026-06-12)

Fixed in `host_loose_eq` (`src/runtime.ts`, the `case "host_loose_eq"` intent
handler — line ~10346, not the :9044 cited above which drifted). Per
§7.2.15 IsLooselyEqual steps 8-9, `object == primitive` coerces the object via
ToPrimitive. When a WasmGC-struct operand is compared against a **primitive**,
the handler now runs it through `_toPrimitiveSync(v, "default", callbackState)`
— the same callbackState-aware walker `__extern_has` uses — before applying
`==`. A no-method struct still resolves to `"[object Object]"`, so
`{} == "[object Object]"` is preserved, and `object == object` stays reference
identity (no coercion when both sides are objects).

## Test Results

`tests/issue-1990.test.ts` — 5/5 pass (`assertEquivalent`, wasm vs Node):
object `toString` == string, object `valueOf` == number (match + non-match),
`{}` == `"[object Object]"`, and `object == object` reference identity (`a==b`
false, `a==a` true). Pre-existing coercion/equality suites green:
`tests/equivalence/{object-to-primitive,tostring-valueof,loose-equality,
equality-mixed-types,comparison-coercion}.test.ts` 40/40. `biome lint`,
`tsc --noEmit`, `prettier --check` clean.

### Known follow-up (out of scope, not fixed here)
The **symmetric** `"T" == o` (string LITERAL on the LHS) is lowered through a
different codegen path than `host_loose_eq` and still mis-compares (returns
`false`). #1990 is scoped to the `object == primitive` host_loose_eq path; the
string-literal-LHS path is a separate codegen routing gap worth a follow-up
issue.
