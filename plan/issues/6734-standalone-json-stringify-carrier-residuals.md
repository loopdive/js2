---
id: 6734
title: "standalone: JSON.stringify residuals after #1599 Phase 2 — top-level undefined, wrapper objects, $Object getters, dynamic space, empty/builtin structs, BigInt"
status: ready
sprint: Backlog
created: 2026-09-28
updated: 2026-09-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: json
goal: standalone
related: [1599, 3176, 4085]
---

# #6734 — standalone JSON.stringify residuals

## Problem

[#1599](https://js2wasm.loopdive.com/dashboard/issue.html?slug=1599-json-standalone)
Phase 2 made the native codec walk array carriers, closed user structs and
detect cycles. Scoped standalone test262 `built-ins/JSON` went 107 → 113 of
165. These gaps remain (each measured on that branch, `--target standalone`):

| Gap | Example | Got | Spec / Node |
| --- | --- | --- | --- |
| Top-level result `undefined` | `JSON.stringify(function(){})`, `JSON.stringify(1, function(){})` | `"null"` | `undefined` (`value-function.js`, `replacer-function-result-undefined.js`, `value-tojson-arguments.js`) |
| Wrapper objects not unwrapped (§25.5.2.2 step 4) | `JSON.stringify(new Number(8.5))`, `new String('str')`, `new Boolean(true)`; replacer array of `new Number`/`new String` | `"{}"` | `8.5` / `"str"` / `true` |
| `$Object` arm reads accessor slots raw | `{ p2: { get p3() { return x; } } }` | `"p3":null`, cycle through a getter not detected | getter called (`value-object-circular.js` indirect case) |
| Dynamic `space` argument | `JSON.stringify(v, null, sp)` | compile refusal (#1599) | `space-number-object.js`, `space-string-object.js` |
| Closed struct with no own fields | `class E {}; JSON.stringify(new E())` | `"null"` | `"{}"` — the `__object_assign_closed_struct_source` classifier only admits shapes with ≥1 field |
| `undefined` in an `any` struct field | `{ b: undefined }` via a closed struct | `"b":null` | key omitted |
| Builtin carriers | `JSON.stringify({ m: new Map() })` | `{}` (key dropped) | `{"m":{}}` |
| TypedArray | `JSON.stringify(new Float64Array([1,2]))` | `[1,2]` | `{"0":1,"1":2}` |
| BigInt | `JSON.stringify(0n)` | `"null"` | TypeError (`value-bigint*.js`) |
| Tuple | `const v: [number, string]` | compile refusal (#1599) | `[1,"x"]` |

Related, not JSON: `const v: any[] = []; v.push(v); v[0] === v` is `false`
standalone — the pushed self-reference is a different carrier, so
`JSON.stringify(v)` cannot see the cycle.

## Acceptance criteria

- Each row above answers the Node value in standalone, compared in-Wasm, with
  zero `env` imports; the named test262 files pass.
- No loss in scoped standalone `built-ins/JSON`.
