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

## Implementation Plan

### Root cause
Open-object semantics (objects with dynamic shape, `any`-typed
property access, ES `Object.*` methods, `for-in`) currently delegate
to a sprawling JS host sidecar (~13 import families, ~50 individual
imports). The WasmGC compiler already represents closed-shape
structs natively (no host calls); the gap is the **open-shape
runtime**. This issue is the largest of the five — closing it
takes a multi-phase rollout because each piece touches the
`object-ops.ts` mega-module (~2680 LOC).

### Prerequisite (depends on #1470, #1471)
- `ctx.standalone` flag (from #1470)
- `$__box_num_wasm` / `$__unbox_num_wasm` / `$__to_bool_wasm` /
  `$__typeof_wasm` (from #1471) — property values are anyref slots,
  reading/writing them needs the boxing helpers

### Phased rollout — three phases

This issue is too large for a single dev-day; split into three
independent PRs that land in order.

#### Phase A (this issue's MVP): refuse-and-document for opt-out paths

When `ctx.standalone` is set, **every code path that currently emits
an `ensureLateImport` for an `__extern_*` / `__object_*` /
`__for_in_*` / `__defineProperty*` / `__hasOwnProperty` /
`__getOwn*` / `__delete_property` import** falls through to a
compile-time error:

```ts
function emitObjectOpStandaloneError(
  ctx: CodegenContext, expr: ts.Node, opName: string
): void {
  reportError(ctx, expr,
    `${opName} on a dynamic-shape object is not yet supported in ` +
    `--target standalone (#1472 Phase B). Use a typed object ` +
    `literal or class instance for fast-path codegen.`);
}
```

This is enough to ship `--target standalone` for the math/string
workloads that are the early-adopter use case. Closed-shape struct
access (the existing `getFieldEntry`-based fast path in
`property-access.ts`) ALREADY works without any host imports —
verify with the `assert-no-js-host-imports.ts` helper from #1470.

The Phase-A diff is small (~150 LOC) and gates every
`ensureLateImport("__extern_get"|"__extern_set"|"__extern_get_idx"|…
)` call with:

```ts
if (ctx.standalone) {
  emitObjectOpStandaloneError(ctx, expr, "__extern_get");
  return null;
}
```

Acceptance for Phase A:
- [ ] `--target standalone` compiles a class-only / typed-only
      program (math fixtures, fib, string-basics) with **zero**
      `env::__extern_*`/`env::__object_*` imports.
- [ ] Any open-object usage in `--target standalone` fails with a
      clear error message pointing to #1472 Phase B.

#### Phase B (follow-up issue): Wasm-native open-object runtime

New WasmGC types (registered in `src/codegen/wasm-helpers/object-runtime.ts`):

```
(type $PropEntry (struct
  (field $key      (ref $AnyString))   ;; immutable
  (field $value    (mut anyref))       ;; mutable; null = tombstone
  (field $flags    (mut i32))))        ;; writable/enumerable/configurable/accessor

(type $PropMap (array (mut (ref null $PropEntry))))

(type $Object (struct
  (field $proto      (ref null $Object))     ;; prototype chain
  (field $props      (mut (ref $PropMap)))   ;; resized on grow
  (field $count      (mut i32))              ;; live entries (exc. tombstones)
  (field $tombstones (mut i32))              ;; for rehash threshold
  (field $flags      (mut i32))))            ;; extensible/frozen/sealed bits
```

Hash function: FNV-1a over the string's UTF-16 code units (8
instructions per code unit; trade off length for collision rate;
ASCII fast path skips half).

**Helpers** (all internal, idempotent registration via
`ensureObjectRuntime(ctx)`):

```
$__obj_new      ()                                  -> ref $Object
$__obj_get      (ref $Object, ref $AnyString)       -> anyref
$__obj_set      (ref $Object, ref $AnyString, anyref) -> void
$__obj_del      (ref $Object, ref $AnyString)       -> i32 (1 = deleted)
$__obj_has      (ref $Object, ref $AnyString)       -> i32
$__obj_keys     (ref $Object)                       -> ref $AnyVec
$__obj_values   (ref $Object)                       -> ref $AnyVec
$__obj_entries  (ref $Object)                       -> ref $AnyVec   ;; entries are 2-tuples
$__obj_assign   (ref $Object, ref $Object)          -> ref $Object
$__obj_freeze   (ref $Object)                       -> ref $Object   ;; sets flags
$__obj_isFrozen (ref $Object)                       -> i32
$__obj_grow     (ref $Object)                       -> void          ;; internal
$__obj_hash     (ref $AnyString)                    -> i32
$__obj_define_prop (ref $Object, ref $AnyString, anyref, i32 flags) -> void
$__obj_get_desc (ref $Object, ref $AnyString)       -> ref null $PropEntry
$__proto_walk   (ref $Object, ref $AnyString)       -> anyref        ;; getPrototypeOf chain
```

Get/set algorithm (linear probing, robin hood deletion):

```wat
(func $__obj_get (param $o (ref $Object)) (param $k (ref $AnyString))
                 (result anyref)
  ;; props = o.$props; capacity = array.len(props)
  local.get $o struct.get $Object $props local.set $arr
  local.get $arr array.len local.set $cap
  ;; idx = hash(k) & (cap - 1)
  local.get $k call $__obj_hash
  local.get $cap i32.const 1 i32.sub i32.and
  local.set $i
  (loop $probe
    local.get $arr local.get $i array.get $PropMap local.set $e
    ;; empty slot → key not present → walk proto
    local.get $e ref.is_null
    if
      local.get $o struct.get $Object $proto local.set $p
      local.get $p ref.is_null
      if ref.null any return end
      local.get $p local.get $k
      return_call $__obj_get
    end
    ;; key match?
    local.get $e struct.get $PropEntry $key
    local.get $k
    call $__str_equals
    if
      ;; check tombstone (value == null AND flags has TOMBSTONE bit)
      local.get $e struct.get $PropEntry $flags
      i32.const 0x80 i32.and
      if ref.null any return end
      local.get $e struct.get $PropEntry $value
      return
    end
    ;; advance i
    local.get $i i32.const 1 i32.add
    local.get $cap i32.const 1 i32.sub i32.and
    local.set $i
    br $probe))
```

Grow strategy: double the array when `count + tombstones > cap *
0.7`. Rehash on grow; this is the same shape as V8's hidden-class
fallback dictionary mode.

**Per-import retargeting** in `src/codegen/object-ops.ts` and
adjacent files (replace every `ensureLateImport("__extern_get", …)`
with):

```ts
if (ctx.standalone) {
  ensureObjectRuntime(ctx);
  const fnIdx = ctx.objectHelpers.get("__obj_get")!;
  fctx.body.push({ op: "call", funcIdx: fnIdx });
} else {
  const fnIdx = ensureLateImport(ctx, "__extern_get", …);
  fctx.body.push({ op: "call", funcIdx: fnIdx });
}
```

Pull this branching into a single `emitExternGet(ctx, fctx)` helper
in `src/codegen/wasm-helpers/object-runtime.ts` (mirrors the
`emitBoxNumber` pattern from #1471). Apply mechanically to every
call site:

| Helper                         | Replaces import                              | Call sites (file:line)                  |
| ------------------------------ | -------------------------------------------- | --------------------------------------- |
| `emitExternGet`                | `__extern_get`                               | `object-ops.ts:155, 1115, 1343, 2039`   |
| `emitExternSet`                | `__extern_set`                               | `object-ops.ts:161, 1371, 1947, 1993`   |
| `emitExternGetIdx`             | `__extern_get_idx`                           | `type-coercion.ts:357`                  |
| `emitExternLen`                | `__extern_length`                            | `object-ops.ts:2108`                    |
| `emitNewPlainObject`           | `__new_plain_object`                         | `literals.ts:139, 227, 458`             |
| `emitHasOwn`                   | `__hasOwnProperty`/`__propertyIsEnumerable`  | `object-ops.ts:2396, 2574`              |
| `emitObjectKeys/Values/Entries`| `__object_keys` etc.                         | `object-ops.ts:1947, 1993` (already partial) |
| `emitForInKeys`                | `__for_in_keys`                              | `statements/for-in.ts` (new)            |
| `emitDeleteProperty`           | `__delete_property`                          | `typeof-delete.ts:782`                  |
| `emitDefineProperty*`          | `__defineProperty_*`                         | `object-ops.ts:1115, 1343`              |

For-in loop emission (`src/codegen/statements/loops.ts` or
`statements.ts`):

```ts
// Compile receiver → local $obj. If ctx.standalone:
ensureObjectRuntime(ctx);
fctx.body.push({ op: "local.get", index: objLocal });
fctx.body.push({ op: "call",
                 funcIdx: ctx.objectHelpers.get("__obj_keys")! });
// stack: ref $AnyVec — iterate using existing vec-iterate codegen
```

**Closed-shape struct path is unchanged**: when the codegen has
already resolved a struct field via `getFieldEntry`, it emits
`struct.get` / `struct.set` directly. The open-object runtime is
only consulted when the static type is `any` / index access / open
literal.

#### Phase C (follow-up): Proxy refusal + Reflect.* dispatch

When `ctx.standalone` is set:

- `new Proxy(target, handler)` → compile-time error (per
  acceptance criteria): "Proxy not supported in standalone mode
  (#1472 Phase C)". Emitted from
  `src/codegen/expressions/new-super.ts` and
  `src/codegen/builtin-tags.ts:180` allowed-ctor list.
- `Proxy.revocable(...)` → same error.
- `Reflect.*` methods that don't have a `Object.*` equivalent
  (`Reflect.construct` with proxy target, `Reflect.apply` against
  externrefs) → error. Pure-Wasm `Reflect.get` / `Reflect.set` /
  `Reflect.has` are aliases of the `$__obj_*` helpers.

### Test approach

- **Phase A**: `tests/standalone-objects-refuse.test.ts` — assert
  the compile error fires for `let o: any = {x: 1}; o.y = 2;`
  with the message above; assert closed-shape struct programs
  compile clean with zero `env::__extern_*` imports.
- **Phase B**: `tests/standalone-objects.test.ts` — wasmtime
  smoke test for: object literals, property add/read/delete,
  `Object.keys/values/entries`, `for (k in o)`, `Object.assign`,
  `Object.defineProperty` with data descriptors, prototype-chain
  walks, class instances with method dispatch (vtable).
- **Phase B Test262**: re-run `built-ins/Object/{keys,values,
  entries,assign,defineProperty,freeze,isFrozen,create}` and
  `built-ins/Reflect/*` subset (excluding Proxy) in standalone
  mode; track regression budget against the same suite in default
  mode.
- **Phase C**: `tests/standalone-proxy-refuse.test.ts` — assert
  `new Proxy(...)` emits the expected compile error.

### Dependency ordering within #1472

1. **Phase A first** — gives `--target standalone` a clean
   `"this isn't supported yet"` signpost. Allows downstream issues
   to assert that standalone mode produces stable output for
   non-object workloads.
2. **Phase B second** — biggest piece, ~2 weeks of dev time. New
   open-object runtime + 13 helper functions + retargeting every
   call site. Best handled as its own multi-PR effort with one
   helper landing per PR.
3. **Phase C last** — small (~50 LOC); refusal patterns.

### Cross-issue ordering

- #1470, #1471 land first (CLI flag + boxing infra).
- #1473 (errors) is independent of #1472 Phase B but should land
  before Phase B so the open-object runtime can `throw` real
  TypeErrors on `Object.freeze`-violation, etc.
- #1474 is independent.
