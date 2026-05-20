---
id: 1472
sprint: 52
title: "host-independence: eliminate JS host object/property ops for standalone Wasm"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: objects, property access, prototype chain
goal: host-independence
related: []
---

# #1472 — Eliminate JS host object/property ops for standalone Wasm

## Problem

Object property access on `any`-typed values (or dynamically-typed
struct fields) routes through a sprawling family of JS host imports.
The JS side maintains four WeakMap sidecars
(`_wasmStructProps`, `_wasmStructDeletedKeys`, `_wasmPropDescs`,
`_wasmStructAccessors`) and a Proxy cache (`_hostProxyCache`,
`_hostProxyReverse`) that compensate for WasmGC structs being opaque
to JS. None of this exists when there's no JS runtime.

Imports with **no standalone fallback**:

1. **`__extern_get`** / **`__extern_set`** (`runtime.ts` 2259, 2271,
   registered at `codegen/index.ts:3558`). Property get/set on
   externref. Implemented via `_safeGet` / `_safeSet` which walks
   the sidecars and invokes Wasm-exported `__sget_*` getters when
   available — but the policy lives in JS.
2. **`__extern_get_idx`** / **`__extern_has_idx`** / **`__extern_length`**
   (`runtime.ts` 2337, 2366, 2272). Indexed access on array-likes
   (JS arrays and WasmGC vecs).
3. **`__extern_slice`** / **`__extern_rest_object`** (`runtime.ts`
   2856, 2880) — destructuring rest patterns (`{a, ...rest}`).
4. **`__delete_property`** (`runtime.ts` 3626) — `delete obj.x`
   uses sidecar tombstone set; no Wasm-side analog.
5. **`__hasOwnProperty`**, **`__propertyIsEnumerable`**,
   **`__isPrototypeOf`**, **`__object_hasOwn`** (`runtime.ts`
   3680, 3713, 3305, 3482) — `Object` prototype methods + ES2022
   `Object.hasOwn`. Spec semantics require sidecar consultation.
6. **`__getOwnPropertyDescriptor`** /
   **`__getOwnPropertyNames`** / **`__getOwnPropertySymbols`** /
   **`__getPrototypeOf`** (`runtime.ts` 3131, 3218, 3272, 3278) —
   Reflection API; reads the `_wasmPropDescs` sidecar.
7. **`__defineProperty_desc`** / **`__defineProperty_value`** /
   **`__defineProperty_accessor`** / **`__defineProperties`**
   (`runtime.ts` 2915, 2938, 2974, 3023) — `Object.defineProperty`
   variants; mutate the descriptor sidecar.
8. **`__object_create`**, **`__new_plain_object`**,
   **`__object_freeze`**, **`__object_seal`**,
   **`__object_preventExtensions`**, **`__object_isFrozen`**,
   **`__object_isSealed`**, **`__object_isExtensible`** (`runtime.ts`
   2510–2638) — Object.* lifecycle methods.
9. **`__object_keys`** / **`__object_values`** /
   **`__object_entries`** / **`__object_assign`** /
   **`__object_fromEntries`** / **`__object_getOwnPropertyDescriptors`**
   /**`__object_groupBy`** / **`__object_is`** (`runtime.ts`
   2649–3513) — Object iteration / equality.
10. **`__for_in_keys`** / **`__for_in_len`** / **`__for_in_get`**
    (`runtime.ts` 3746, 3820, 3825) — for-in enumeration.
11. **`__extern_method_call`** / **`__proto_method_call`** /
    **`__get_builtin`** (`runtime.ts` 3328, 3432, 3480) — generic
    dispatch for `obj.m(...)` and built-in lookup via `globalThis[n]`.
12. **`__register_prototype`** / **`__register_class_object`**
    (`runtime.ts` 2512, 2520) — populates the method-name sidecars
    used by the host Proxy to report the spec-correct property
    descriptor flags on user-class prototypes.
13. **`__proxy_revocable`** (`runtime.ts` 3516) — `Proxy.revocable`
    can't be implemented without JS `Proxy`.

Why this blocks standalone: `let o = {x:1}; o.y = 2; console.log(o.y);`
goes through `__new_plain_object` → `__extern_set` → `__extern_get`.
Wasmtime: "unknown import env::__new_plain_object". The most pervasive
host-import dependency in the compiler.

## Standalone alternative

The WasmGC design already represents objects as structs; the
remaining work is moving the sidecar policy into Wasm:

- **Closed structs (known shape, type-annotated)**: today's fast
  path already compiles these to `struct.get`/`struct.set` with
  zero host calls. No work needed beyond ensuring `--standalone`
  never falls back to `__extern_get`.

- **Open objects (`any`, plain object literals)**: replace the JS
  sidecar with a Wasm-native open-hash-map struct:
  `struct $Object { proto: ref null $Object, props: ref $PropMap }`
  where `$PropMap` is an `array (mut $PropEntry)` with linear
  probing. Property get/set/delete become pure-Wasm helpers
  (`$__obj_get`, `$__obj_set`, `$__obj_del`).

- **Descriptor flags**: extend `$PropEntry` with a `flags: i32`
  field (writable/enumerable/configurable/accessor) so
  `Object.defineProperty` and the descriptor reflection family work
  without a sidecar.

- **For-in enumeration**: `$__obj_keys` walks `$PropMap` filtering
  enumerable + non-tombstoned. Order: insertion (matches JS).

- **Prototype chain**: walk `proto` field; `__isPrototypeOf` /
  `instanceof` become Wasm loops with `ref.eq`.

- **`__get_builtin` / `__extern_method_call`**: the standalone runtime
  ships built-ins as static Wasm globals (`$ArrayCtor`,
  `$ObjectCtor`, …); method dispatch goes through the vtable on the
  prototype struct field.

- **`Proxy`**: out of scope for standalone (spec requires arbitrary
  handler dispatch); mark as deferred — modules using `Proxy` opt
  out of `--standalone` with a clear compile-time error.

## Acceptance criteria

- [ ] `--standalone` build emits zero `env::__extern_*`,
      `env::__object_*`, `env::__for_in_*`, `env::__defineProperty*`,
      `env::__hasOwnProperty`, `env::__getOwn*`, `env::__delete_property`,
      `env::__new_plain_object`, `env::__object_create`,
      `env::__register_prototype`, `env::__register_class_object`
      imports.
- [ ] `wasmtime run` succeeds for: object literals, property
      add/read/delete, `Object.keys/values/entries`, `for (k in o)`,
      `Object.assign`, `Object.defineProperty` with data
      descriptors, prototype-chain walks (`instanceof`,
      `isPrototypeOf`), class instances with method dispatch.
- [ ] `Proxy`-using code emits a compile error in `--standalone`:
      "Proxy not supported in standalone mode" (no silent fall-back
      to a half-working runtime).
- [ ] Equivalence tests under `--standalone` for all currently
      passing object-shape examples (~1500 tests in
      `tests/equivalence.test.ts`).
- [ ] Test262 `built-ins/Object/**` and `built-ins/Reflect/**`
      subset (excluding Proxy) does not regress vs main in default
      mode.

## Files to modify

- `src/codegen/object-ops.ts` (entire file, ~2400 LOC) — main site:
  replace `ensureLateImport("__extern_get", …)` etc. with calls to
  new Wasm helpers when `ctx.standalone`.
- `src/codegen/index.ts` line 3558 — gate `addImport(__extern_get
  /__extern_length)` on `!ctx.standalone`.
- `src/codegen/property-access.ts` (if exists; otherwise
  `expressions.ts` MemberExpression path) — emit `$__obj_get` /
  `$__obj_set` for open-object access.
- New: `src/codegen/wasm-helpers/object-runtime.ts` — emits the
  `$Object`, `$PropMap`, `$PropEntry` type definitions and the
  `$__obj_get` / `$__obj_set` / `$__obj_del` / `$__obj_keys` /
  `$__obj_has` / `$__proto_walk` helpers on first use.
- `src/codegen/statements.ts` (for-in) — switch standalone path to
  `$__obj_keys`-driven loop.
- `src/runtime.ts` lines 2259–3680 — keep for default mode; the
  standalone modules simply do not import these names.
