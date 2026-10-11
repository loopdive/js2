---
id: 6659
title: "uuid standalone lanes retained 3 host imports (__crypto_get_random_values, __crypto_random_uuid, __unwrap_for_wasm)"
status: done
sprint: current
created: 2026-09-23
updated: 2026-09-23
completed: 2026-09-23
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [1503, 1664, 4383, 4398, 4569]
loc-budget-allow:
  # 2026-09-23: +2 lines in compileTypedArraySet for the host-free receiver
  # path (no __unwrap_for_wasm facade on standalone/WASI).
  - src/codegen/array-methods.ts
---

# #6659 — uuid standalone lanes retained 3 host imports

## Problem

The npm-compat `standaloneDynamic` (and `standalone`) perf lanes for `uuid`
failed with `host-import-error: standalone binary retained 3 host import(s)`.
The lane admits zero imports. The three, and the functions that emitted them
(`--target standalone`, `wasm-dis` of the lane binary):

| import | emitted in | codegen arm |
| --- | --- | --- |
| `env.__crypto_get_random_values` | `rng` (`crypto.getRandomValues(rnds8)`) | `calls.ts` #1503 Web Crypto arm |
| `env.__crypto_random_uuid` | `v4` (`crypto.randomUUID()`) | `calls.ts` #1503 Web Crypto arm |
| `env.__unwrap_for_wasm` | `v35` (`bytes.set(...)`, `bytes` reassigned so its carrier is externref) | `array-methods.ts` `compileTypedArraySet` |

The perf driver only calls `validate` + `version`; the imports came from
functions the module merely contains.

## Implementation Plan

1. **`TypedArray.prototype.set` on an externref receiver**: the
   `__unwrap_for_wasm` call exists to strip the JS-host facade. Host-free
   targets have no facade (same rule as `closure-exports.ts`), so under
   `ctx.standalone || ctx.wasi` the receiver is `any.convert_extern` +
   `ref.cast_null $vec` directly; the nullable cast routes a null receiver to
   the existing TypeError guard. The JS-host path is unchanged.
2. **Web Crypto under `--target standalone`** (new module
   `src/codegen/expressions/standalone-crypto.ts`): a pure standalone module has
   no secure randomness provider — it can import none, and #4569 forbids a
   pseudorandom substitute. So `crypto.getRandomValues(...)` /
   `crypto.randomUUID()` lower to the `ReferenceError` an engine without the
   `crypto` global throws, before any argument is evaluated and before any byte
   is returned. Gated on `targetProfile.environment === "none"`; JS host and
   WASI are unchanged.

## Resolution

- `uuid` standaloneDynamic: `host-import-error` (3 imports) → `measured`
  (ratio 0.209, checksum correct). `uuid` standalone (static):
  `host-import-error` → `measured` (ratio 0.217).
- JS-host `uuid` binary byte-identical before/after (sha256 match); uuid
  upstream suite 75/75.
- `tests/issue-6659-standalone-uuid-host-imports.test.ts`: parent 0/2, fix 2/2.
- test262 standalone `built-ins/TypedArray/prototype/set`: 61/110 → 61/110,
  identical per-test verdicts.

Residual: real entropy for standalone needs a declared randomness capability
(#4398/#4569); WASI still lowers Web Crypto to env imports (out of scope).
