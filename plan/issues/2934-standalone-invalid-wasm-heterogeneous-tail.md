---
id: 2934
title: "Standalone: invalid-Wasm heterogeneous tail after #2878 (test/__closure_*/__cb_0 — distinct codegen bugs)"
status: ready
created: 2026-07-02
updated: 2026-07-02
priority: medium
feasibility: medium
task_type: bug
area: codegen
goal: standalone
related: [2860, 2868, 2878]
umbrella: 2860
---

# Standalone: invalid-Wasm heterogeneous tail after #2878

#2878 retired the `externref → eqref` coercion class (the
`__call_toString`/`__call_valueOf`/`__set_member_toString` invalid-Wasm bucket).
This tracks the **residual tail** measured on current `main` after that fix — a
set of **heterogeneous, unrelated** codegen defects (NOT a single mechanism, NOT
the eqref/funcIdx-shift class), so each needs its own triage.

## Measurement (2026-07-02, dev-2878)

`--target standalone` compile + `WebAssembly.compile` validate over a 3,500-file
`built-ins` stride sample, AFTER #2878: **26 invalid binaries** remaining.
Clustered by failing function + validator signature:

| failing fn | count | validator signature (representative) | example test |
| ---------- | ----- | ------------------------------------ | ------------ |
| `test` | ~15 | `call[0] expected type (ref null …)` | `String/prototype/concat/S15.5.4.6_A1_T8.js` |
| `test` | (in above) | `call[0] expected type externref` | `RegExp/prototype/test/S15.10.6.3_A8.js` |
| `test` | (in above) | `array.get: Array type N has packed…` / `array.set[2] expected type i32` | `TypedArray/prototype/set/array-arg-value-conversion-resizes-array-buffer.js`, `Uint8Array/prototype/toBase64/results.js` |
| `__closure_2/4/7/20` | ~8 | `call[1] expected type f64` / `call[0] expected type (…)` / `struct.get[0]` | `Array/prototype/map/15.4.4.19-4-7.js`, `Array/prototype/filter/create-species-poisoned.js`, `Proxy/revocable/tco-fn-realm.js` |
| `__closure_5` | 1 | `not enough arguments on the stack` (funcIdx-shift-shaped) | `AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js` |
| `__cb_0` | 1 | `array.set[2] expected type i32` | `TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-other-type-conversions-sab.js` |

(3,500-file sample → the full `built-ins` corpus + `language`/other roots scale
this ~3–4×.)

## Likely sub-clusters (triage-then-split)

1. **TypedArray resizable-buffer `array.get`/`array.set` type mismatch** — the
   `array.get: Array type N has packed…` / `array.set[2] expected i32` family
   (TypedArray `set` with a resizable `ArrayBuffer`, `Uint8Array.toBase64`). A
   packed-array element-type / i32-vs-i8 mismatch on a standalone-gated path.
2. **`call[0]/call[1] expected type …` in `test`/`__closure_*`** — a wrong-typed
   argument at a call site (String/concat, RegExp/test, Array map/filter species
   callbacks). Some are `species-poisoned` / `create-species-*` — likely a
   Symbol.species / callback-thunk typing issue, NOT funcIdx-shift.
3. **`__closure_5` `not enough arguments on the stack`** — the one funcIdx-shift-
   shaped failure (for-await async path); may share the #2918 late-import class.

## Approach

Per the #2868/#2878 playbook: pick one repro per cluster, disassemble with
`node_modules/.bin/wasm-dis`, read the exact validator complaint, cluster by
shared construct, fix the emitter. Split into sub-issues if the clusters are
independent (they likely are).

## Acceptance

- Each named cluster: standalone CE/invalid → valid module for its repros.
- 0 test262 regressions; full `merge_group` + standalone floor.
- Pure correctness (invalid binary → valid) — no host-mode path touched.
