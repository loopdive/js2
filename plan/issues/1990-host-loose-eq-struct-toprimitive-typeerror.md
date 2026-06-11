---
id: 1990
title: "loose == between any object carrying toString/valueOf and a string throws TypeError: host_loose_eq lacks _toPrimitiveSync routing"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
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
