---
id: 1472
title: "host-independence: eliminate JS host object/property ops for standalone Wasm"
status: done
pr: 1047
created: 2026-05-20
updated: 2026-06-03
completed: 2026-06-04
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: objects, property access, prototype chain
goal: host-independence
sprint: 58
related: []
claimed_by: codex-developer
claimed_at: 2026-06-02T22:34:59.447Z
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

## Evidence: real standalone test262 run 2026-06-01

Artifacts:
`benchmarks/results/test262-standalone-report-20260601-213702.json` and
`benchmarks/results/test262-standalone-results-20260601-213702.jsonl`.

Standalone result: 4,368 / 43,106 passing (10.1%) versus the canonical JS-host
baseline of 30,480 / 43,106 (70.7%). The dynamic-shape object/property cluster
accounts for 22,986 priority-classified failures. Top helper signatures in that
cluster are `__extern_get` (11,841), `__extern_is_undefined` (7,476),
`__get_builtin` (6,410), `__extern_length` (5,460), `__extern_set` (5,459),
`__new_plain_object` (4,632), `__extern_get_idx` (4,618), and
`__extern_method_call` (4,322).

## Evidence: refreshed standalone test262 artifact 2026-06-02

Source: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`; js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The full artifact has 48,110 rows. Excluding passes/skips leaves 40,208 bad
rows; the root-cause classifier assigns **26,880** of them primarily to #1472.
That is still the dominant standalone root cause, and it is now mostly a
successful refusal diagnostic rather than an unknown import crash.

Representative diagnostic:

```text
Codegen error: '__new_plain_object' (dynamic-shape object/property operation)
is not yet supported in --target standalone (#1472 Phase B).
```

Raw, non-exclusive helper mentions in the latest current JSONL:

| Helper | Rows mentioning helper |
| --- | ---: |
| `__extern_get` | 15,597 |
| `__extern_is_undefined` | 7,970 |
| `__extern_method_call` | 7,465 |
| `__get_builtin` | 6,565 |
| `__extern_length` | 5,808 |
| `__extern_set` | 5,414 |
| `__new_plain_object` | 5,008 |
| `__defineProperty_accessor` | 2,713 |
| `__defineProperty_value` | 1,486 |
| `__hasOwnProperty` | 1,416 |
| `__proto_method_call` | 659 |

This keeps Phase B as the main pass-rate lever: the standalone lane now tells
users exactly where dynamic object semantics are missing, but the corpus cannot
recover until the open-object runtime replaces these host-side sidecars.

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
- [x] `--target standalone` compiles a class-only / typed-only
      program (math fixtures, fib, string-basics) with **zero**
      `env::__extern_*`/`env::__object_*` imports.
- [x] Any open-object usage in `--target standalone` fails with a
      clear error message pointing to #1472 Phase B.

### Phase A — DONE (PR pending)

Implemented as a single central choke point rather than per-call-site
gates (the plan's per-site retargeting is Phase B work):

- `src/codegen/expressions/late-imports.ts` — `ensureLateImport` now
  calls `refuseStandaloneObjectImport(ctx, name)`. Under `ctx.standalone`,
  any object/property host-import family name (`__extern_*`, `__object_*`,
  `__for_in_*`, `__defineProperty*`, `__getOwn*`, `__new_plain_object`,
  `__delete_property`, `__hasOwnProperty`, `__propertyIsEnumerable`,
  `__isPrototypeOf`, `__register_prototype`, `__register_class_object`,
  `__proxy_*`, `__get_builtin`, `__proto_method_call`) queues a
  `Codegen error:`-prefixed diagnostic (deduplicated per name) pointing
  at Phase B. The prefix routes through compiler.ts's hard-fail path
  (`success: false`, empty module) so no half-working module with a
  leaked host import is emitted.
- `src/codegen/index.ts` — the eager `__register_prototype` /
  `__register_class_object` registration (only needed by the JS-host
  Proxy wrapper) is now gated `&& !ctx.standalone`. `emitLazyProtoGet` /
  `emitLazyClassObjectGet` already gate their `call` on the import being
  in funcMap, so class prototype/class-object globals still work
  natively (struct.new + global.set) with no host notification.
- `src/codegen/context/types.ts` — added `standaloneRefusedImports?:
  Set<string>` for per-name error dedup.
- Test: `tests/issue-1472-standalone-object-imports.test.ts` (4 tests,
  passing): typed object literal + class instance compile with zero host
  object imports; open `any` object refuses with the Phase B error;
  default `gc` target still uses the JS-host object machinery.

Closed-shape struct access (the `getFieldEntry` fast path) never reaches
the gate — it emits struct.get/struct.set and never calls
`ensureLateImport` for these names, so it works standalone unchanged.

2026-06-01 follow-up slice:

- Routed the statements destructuring `ensureExternIsUndefined` helper through
  `ensureLateImport` instead of raw `addImport`, so `--target standalone`
  applies the same #1472 Phase A refusal to `__extern_is_undefined` instead of
  leaking `env::__extern_is_undefined`.
- Added a regression for array destructuring defaults in
  `tests/issue-1472-standalone-object-imports.test.ts`; the suite now has 5
  tests.
- Spec reference checked: ECMA-262 §14.3.3 Keyed/Iterator binding
  initialization defaults trigger when the bound value is `undefined`.
- Validation: `pnpm exec prettier --write
  src/codegen/statements/destructuring.ts
  tests/issue-1472-standalone-object-imports.test.ts` (unchanged);
  `pnpm exec vitest run tests/issue-1472-standalone-object-imports.test.ts`
  (1 file passed, 5 tests passed). Full test262 was not run.

2026-06-03 Codex follow-up slice:

- Added the explicit Phase C standalone Proxy refusal for `new Proxy(...)` in
  `src/codegen/expressions/new-super.ts` and `Proxy.revocable(...)` in
  `src/codegen/expressions/calls.ts`. Both now report
  `Codegen error: Proxy not supported in standalone mode (#1472 Phase C).`
  before compiling arguments or registering `__proxy_*` imports.
- Moved the focused regression suite to `tests/issue-1472.test.ts` per the
  sprint lane instruction, expanded the banned-host-import assertion to cover
  `__get_builtin`, `__proto_method_call`, and `__proxy_*`, and added coverage
  for standalone `new Proxy`, standalone `Proxy.revocable`, and default-GC
  `new Proxy`.
- Validation: `pnpm exec prettier --write
  src/codegen/expressions/calls.ts src/codegen/expressions/new-super.ts
  tests/issue-1472.test.ts` (unchanged); `pnpm exec vitest run
  tests/issue-1472.test.ts` (1 file passed, 8 tests passed);
  `pnpm exec biome lint src/codegen/expressions/calls.ts
  src/codegen/expressions/new-super.ts tests/issue-1472.test.ts
  --diagnostic-level=error --no-errors-on-unmatched` (exit 0). Full local
  test262 was not run.

**Phase B** (Wasm-native open-object runtime) and Reflect-specific Phase C
dispatch remain as follow-up work — see plan below.

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
| `emitExternSet`                | `__extern_set`                               | `object-ops.ts:161, 1371, 2067, 1993`   |
| `emitExternGetIdx`             | `__extern_get_idx`                           | `type-coercion.ts:357`                  |
| `emitExternLen`                | `__extern_length`                            | `object-ops.ts:2108`                    |
| `emitNewPlainObject`           | `__new_plain_object`                         | `literals.ts:139, 227, 458`             |
| `emitHasOwn`                   | `__hasOwnProperty`/`__propertyIsEnumerable`  | `object-ops.ts:2396, 2574`              |
| `emitObjectKeys/Values/Entries`| `__object_keys` etc.                         | `object-ops.ts:2067, 1993` (already partial) |
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

#### Phase C (partial): Proxy refusal + Reflect.* dispatch

When `ctx.standalone` is set:

- `new Proxy(target, handler)` → compile-time error (per
  acceptance criteria): "Proxy not supported in standalone mode
  (#1472 Phase C)". Emitted from
  `src/codegen/expressions/new-super.ts`. **Implemented 2026-06-03.**
- `Proxy.revocable(...)` → same error. **Implemented 2026-06-03** from
  `src/codegen/expressions/calls.ts`.
- `Reflect.*` methods → routed/refused per the **Phase C — Reflect.\***
  section below. **Implemented 2026-06-03.**

## Phase C — Reflect.* standalone routing — IMPLEMENTED 2026-06-03 (senior-dev)

Folded into PR #1081 (branch `issue-1472-blocker-a-half2`).

### Root cause
Every `Reflect.*` method in `src/codegen/expressions/calls.ts` (the Reflect
dispatch block ~L4787) routes through `ensureLateImport(ctx, "__reflect_X", …)`,
adding an `env::__reflect_X` host import. The `__reflect_*` family is **not** in
`STANDALONE_REFUSED_IMPORT` (`late-imports.ts`), so under `--target standalone`
these imports silently **leaked** into the binary and failed at instantiation
with an opaque "unknown import env::__reflect_X" linker error — the bug class
#1472 exists to eliminate.

### What landed
A single `if (ctx.standalone)` branch at the top of the Reflect dispatch block,
before any per-method handler registers a host import:

- `Reflect.ownKeys(target)` → native **`__object_keys`** (already in
  `OBJECT_RUNTIME_HELPER_NAMES`, so `ensureLateImport` auto-routes it through
  `ensureObjectRuntime` to the in-module func). Returns the string own keys of
  the `$Object` hash-map in insertion order. The native runtime tracks only
  string keys; Symbol/non-enumerable keys are out of scope (a consistent
  approximation across the whole standalone object runtime). Validated
  end-to-end: instantiates under empty imports, correct key count.
- **All other** `Reflect.*` (`get`/`set`/`has`/`deleteProperty`/
  `defineProperty`/`getOwnPropertyDescriptor`/`getPrototypeOf`/`setPrototypeOf`/
  `isExtensible`/`preventExtensions`/`apply`/`construct`) → emit
  `Codegen error: Reflect.X not supported in standalone mode (#1472 Phase C).`
  (hard-fail via the `Codegen error:` prefix), pushing the correct fallback
  value shape (i32 for boolean-returning methods, externref otherwise) so
  codegen doesn't crash before the error surfaces.

Default/gc + wasi-with-host is **unchanged** — host `__reflect_*` dispatch is
only bypassed under `ctx.standalone`.

### Two deliberate divergences from the original plan sketch (root-cause)
1. **`Reflect.has` refuses rather than routing to `__extern_has_idx`.** The plan
   suggested `__extern_has_idx`, but that is an *indexed* (array-like
   `HasProperty(O, ToString(idx))`) check over a `$ObjVec` by integer index — not
   a keyed `HasProperty` over the `$Object` hash-map. No native keyed
   `__extern_has` is registered, so routing there would be *semantically wrong*.
   Correct-or-refuse: it refuses. A real keyed native `has` (thin wrapper over
   `__obj_find`) is a follow-up slice.
2. **`Reflect.apply` / `Reflect.construct` refuse under standalone** (the sketch
   said "keep existing host path"). The existing path adds `env::__reflect_apply`
   / `env::__reflect_construct` with no native analog — keeping it would leak
   host imports and break the #1472 acceptance criterion. They refuse in
   standalone; default/gc keeps the host path.

### Follow-up slices
- Native keyed `__extern_has` (`Reflect.has` / `key in obj`) over `$Object`.
- Native `Reflect.get`/`set`/`deleteProperty` as thin aliases of the existing
  `__extern_get`/`__extern_set`/`__delete_property` natives (receiver/key
  coercion + boolean-return semantics differ from the bare property ops).
- Descriptor / prototype-mutation Reflect methods depend on the descriptor
  sidecar model (gated on the broader Phase B descriptor work).

### Validation
- `tests/issue-1472.test.ts`: added `/^env::__reflect_/` to `BANNED_IMPORTS` and
  3 tests — `Reflect.ownKeys` routes native (returns 2, zero host imports,
  instantiates); all 10 unsupported methods refuse with the Phase C message and
  no leaked `__reflect_*`; gc-mode guard confirms `Reflect.has` still binds
  `env::__reflect_has`. Full file: 26 tests green.
- `npx tsc --noEmit` clean; `biome lint` no errors on `calls.ts`.
- `tests/equivalence/ts-wasm-equivalence.test.ts`: the 11 "tagged template
  literals — *" compile failures are pre-existing on `origin/main` (reproduced
  identically on the clean merge commit 830cd2e10 with these edits stashed) —
  NOT a regression from this change, which only touches the `ctx.standalone`
  Reflect path.

### Test approach

- **Phase A / C refusal coverage**: `tests/issue-1472.test.ts` — assert
  the compile error fires for `let o: any = {x: 1}; o.y = 2;`
  with the message above; assert `new Proxy(...)` /
  `Proxy.revocable(...)` emit the standalone Proxy error; assert closed-shape
  struct programs compile clean with zero object/proxy host imports.
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
- **Phase C follow-up**: extend `tests/issue-1472.test.ts` for
  Reflect-specific standalone dispatch/refusal once the Wasm-native object
  runtime exists.

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

## Phase B Slice 1 — IMPLEMENTED 2026-06-03 (senior-dev)

The Wasm-native open-object runtime core (object creation + own/proto property
get/set) now lowers `--target standalone` open objects to a pure-WasmGC
open-hash-map. No more refuse-and-document for the `__new_plain_object` /
`__extern_get` / `__extern_set` triad — the top-3 standalone failure helpers
(15,597 + 5,008 + 5,414 raw mentions).

### What landed
- `src/codegen/object-runtime.ts` (NEW, ~570 LOC of emitter): registers the
  `$Object` / `$PropMap` / `$PropEntry` WasmGC types and the helper functions
  `__obj_hash`, `__obj_find`, `__obj_insert`, `__obj_grow` (internal) plus the
  three externref-signatured public helpers `__new_plain_object`,
  `__extern_get`, `__extern_set`. Open addressing with linear probing, FNV-1a
  hash over the flattened string's UTF-16 code units, 0.7 load-factor grow +
  rehash, tombstone bit reserved for the delete slice.
- `src/codegen/expressions/late-imports.ts`: `ensureLateImport` routes the three
  public names through `ensureObjectRuntime(ctx)` under `ctx.standalone`,
  mirroring the #1471 `UNION_NATIVE_HELPER_NAMES` boxing-helper pattern. Sits
  BEFORE the Phase A `refuseStandaloneObjectImport` gate so those names compile
  instead of refusing. WASI is intentionally NOT routed yet.
- `src/codegen/context/types.ts`: `objectRuntimeTypes?: ObjectRuntimeTypes`
  caches the type indices for later slices.

### Why this design (root-cause, not symptom)
The decisive insight is that the entire existing JS-host object machinery treats
objects as **externref** and looks helpers up by NAME via `ensureLateImport`
then emits a plain `call funcIdx`. By giving the native helpers the **exact same
name + externref-based signature** as the host imports and wrapping the
`$Object` struct to externref via `extern.convert_any` (a no-op at the engine
level, the same trick `__box_number` uses), EVERY existing call site in
`object-ops.ts` / `property-access.ts` / `literals.ts` resolves to the native
function with **zero per-call-site retargeting**. This avoids the fragile
per-site `if (ctx.standalone) … else …` edits the original plan sketched, and
it sidesteps the late-import index-shift machinery entirely: the helpers are
emitted as DEFINED functions (no imports added), so their funcIdx sits above
every existing function and no shift is required (same invariant as
`addUnionImportsAsNativeFuncs`).

Keys arrive as externref holding a `$NativeString` (standalone auto-enables
nativeStrings). The runtime reuses the existing `__str_flatten` (cons→flat) and
`__str_equals` native string helpers for keying, so it inherits correct
UTF-16 comparison and never needs a JS host.

### Validation
- `tests/issue-1472.test.ts` (9 tests, all green): the Phase A "open object
  refuses" assertion is replaced by two Phase B end-to-end tests that
  `WebAssembly.instantiate(r.binary, {})` (empty imports) and execute under
  Node's WasmGC engine: new/set/get returns 42; property update + 15-key
  grow/rehash returns 24. Closed-shape struct + class-instance + Proxy-refusal +
  default-GC regression guards still pass. `assertNoHostObjectImports` confirms
  zero leaked `env::__extern_*` / `__new_plain_object` imports.
- `npx tsc --noEmit` clean; `biome lint` clean on the three changed files.
- `tests/wasi.test.ts` (24 tests) green — WASI path untouched (not routed).

### Follow-up slices (still refuse under standalone)
- `__extern_get_idx` / `__extern_length` (indexed/array-like access)
- `__delete_property` (tombstone is already reserved in `$PropEntry.flags`)
- `__hasOwnProperty` / `__object_keys|values|entries` / `__object_assign`
- `__for_in_*` (for-in enumeration over `$PropMap`, insertion order)
- `__defineProperty_*` + descriptor reflection (flags field is in place)
- `__get_builtin` / `__extern_method_call` (vtable dispatch)
- Prototype chain is already walked by `__extern_get`; `__getPrototypeOf` /
  `instanceof` / `isPrototypeOf` helpers are a thin follow-up over the `$proto`
  field.

## Phase B Slice 2 — IMPLEMENTED 2026-06-03 (senior-dev, stacked on Slice 1)

`delete o.k` now lowers to a native `__delete_property` over the `$Object`
hash-map instead of refusing. Tombstones the matching `$PropEntry`
(`flags |= TOMBSTONE`), decrements `count`, increments `tombstones`, and
returns 1 — including a no-op success when the key is absent (matches the host
import and ECMA-262 §13.5.1.2 OrdinaryDelete, which returns true for a missing
own property). The TOMBSTONE bit was already reserved in Slice 1, and
`__obj_find` already skips tombstoned slots, so a deleted key reads as missing
and its slot is reused on the next `__obj_insert` with the same key.

- `src/codegen/object-runtime.ts`: `__delete_property` helper + added to
  `OBJECT_RUNTIME_HELPER_NAMES`. No value-nulling needed — the tombstone flag is
  the single source of truth (`__obj_find`/`__extern_get` never read a
  tombstoned entry), which sidesteps emitting an `anyref` null.
- `tests/issue-1472.test.ts`: a run-test (`delete a; re-add a; delete missing`
  → 46) validates tombstone + slot-reuse + no-op-on-missing end-to-end under
  Node's WasmGC engine, with zero `env::__delete_property` import.

**Deferred from this slice — `__hasOwnProperty` / `__object_hasOwn` /
`__propertyIsEnumerable`:** these were prototyped but pulled out. Root cause:
`o.hasOwnProperty("x")` on an `any`-typed open object does **not** route to the
`__hasOwnProperty` host import even today — `compilePropertyIntrospection` only
fires when the receiver's static wasm type is `externref`, and the open-object
`any` receiver takes a different method-dispatch path that returns a falsy
result (the program compiles clean but the call never reaches the helper). So a
native `__hasOwnProperty` func alone is dead code. This is a **call-site
method-dispatch gap**, not a runtime gap, and belongs with the
`__extern_method_call` / `__get_builtin` dispatch slice (Slice "6"), which will
route `obj.m(...)` through the prototype vtable. Tracked there.

## Phase B — NEXT BLOCKERS + freeze/seal code preserved (senior-dev handoff 2026-06-03)

Slices 1 (#1059) + 2 (#1067) merged: the $Object open-hash-map runtime core
(new/get/set + proto walk) and __delete_property/tombstone. These are the
dominant 26,880-row standalone lever. The remaining Object.* surface is gated on
**two foundational blockers** (per-method slices keep dead-ending on these):

### Blocker A — open-`any` receiver does not present as externref at Object.* call sites

`Object.freeze(o)` / `Object.isFrozen(o)` / `o.hasOwnProperty(k)` only route to a
helper when the *static wasm type* of the receiver is `externref`
(`calls.ts` Object.freeze handler ~L3599; `compilePropertyIntrospection` in
`object-ops.ts` ~L3021). For `const o: any = {}`:
- The object LITERAL `{}` in `any` context DOES compile to externref
  (`literals.ts:578` → `__new_plain_object`). So creation is externref.
- But a later REFERENCE `o` in **call-argument position** (`Object.freeze(o)`)
  goes through `compileExpression(o)`, which returns the variable's declared
  wasm type — NOT necessarily externref. Member access `o.x` works (property
  path handles it) but `Object.freeze(o)` falls through to the
  return-arg NO-OP at `calls.ts` ~L3620 (helper never invoked; verified
  `__object_freeze` ends up unreferenced).

FIX (contained, ~6 lines per handler, no new types): in each of the
`Object.freeze/seal/preventExtensions` and `isFrozen/isSealed/isExtensible` and
`isExtensible` handlers, under `ctx.standalone`, when the compiled `argType` is a
`ref`/`ref_null`/`anyref` (the open-object representation) rather than externref,
call `coerceType(ctx, fctx, argType, { kind: "externref" })` (supports
ref→externref via `extern.convert_any`, type-coercion.ts:130) BEFORE the
`argType.kind === "externref"` branch, and treat it as externref thereafter.
ALSO gate the compile-time static fast-paths (`ctx.frozenVars`/`sealedVars`/
`nonExtensibleVars`) on `!ctx.standalone` — they are execution-order-blind and
poison runtime-accurate isFrozen/isExtensible (verified: isFrozen returned 1
BEFORE freeze ran). Same coercion unblocks hasOwnProperty/propertyIsEnumerable
in compilePropertyIntrospection. Keep the JS-host path untouched (gate on
ctx.standalone).

### Blocker B — native $Vec build/iterate helper

keys/values/entries, __object_assign (sources-array), __extern_get_idx/has_idx/
length all need a native element-typed $Vec build+iterate. No single
`anyVecTypeIdx` exists (vec types are per-element). Build on the machinery in
literals.ts/type-coercion.ts. This is its own slice.

### freeze/seal helper code (WRITTEN + tsc-clean, reverted pending Blocker A)

Drops into object-runtime.ts once Blocker A lands. Uses $Object.$flags
(field idx 4). Object-level flag bits (distinct from $PropEntry.$flags):
`OBJ_FLAG_NON_EXTENSIBLE=0x01, OBJ_FLAG_SEALED=0x02, OBJ_FLAG_FROZEN=0x04`
(freeze⊃seal⊃preventExtensions: freeze sets all 3, seal sets {nonext,sealed}).
- `__object_preventExtensions/seal/freeze(externref)->externref`: `emitSetFlags`
  helper — any.convert_extern; if ref.test $Object → cast + `flags |= bits`;
  return the ORIGINAL externref (identity preserved). Non-$Object returned
  unchanged.
- `__object_isFrozen/isSealed(externref)->i32`: 1 iff bit set; non-$Object → 1
  (primitive vacuously frozen/sealed §19.1.2.15/16).
- `__object_isExtensible(externref)->i32`: 1 iff NON_EXTENSIBLE clear;
  non-$Object → 0.
- WRITE GATES (in object-runtime.ts): in `__obj_insert` empty-slot branch, if
  `o.flags & NON_EXTENSIBLE` return (refuse NEW key, sloppy no-op). In
  `__extern_set` after casting `o`, if `o.flags & FROZEN` return (refuse ALL
  writes). Strict-mode throw deferred to error-machinery slice (#1473).
- All 6 added to OBJECT_RUNTIME_HELPER_NAMES so ensureLateImport routes them.
- Tests written (instantiate-and-run under Node WasmGC): isFrozen flips on
  freeze; freeze refuses update; preventExtensions refuses new key/allows
  update; seal isSealed+update; isExtensible flips; freeze returns same object.

## Phase B Blocker B — native $ObjVec build/iterate foundation (sd-1472, 2026-06-03)

Branch `issue-1472-blocker-b` off origin/main. Lands the standalone
enumeration *foundation*: a growable externref vector + the three helpers the
enumeration/indexed-access consumers read.

### What landed
- New WasmGC types in `object-runtime.ts` (registered by `ensureObjectRuntime`,
  standalone-only — JS-host path never sees them):
  - `$ObjVecArr` = `(array (mut externref))`
  - `$ObjVec` = `(struct (field $len (mut i32)) (field $data (mut (ref $ObjVecArr))))`
  - Added `objVecTypeIdx` / `objVecArrTypeIdx` to `ObjectRuntimeTypes`.
- Internal helpers (defined funcs, no imports):
  - `__objvec_new() -> externref` — empty vec (cap = INITIAL_CAP), wrapped via
    `extern.convert_any`.
  - `__objvec_push(externref vec, externref elem)` — append with doubling
    growth (copies into a fresh `$ObjVecArr` when full). No-op on non-$ObjVec.
- Standalone runtime helpers (routed via `OBJECT_RUNTIME_HELPER_NAMES`):
  - `__object_keys(externref) -> externref` — walks the `$Object` PropMap,
    pushes each LIVE (non-tombstone) **and enumerable** entry key (wrapped) into
    a fresh `$ObjVec`. Non-`$Object` receiver → empty vec.
  - `__extern_length(externref) -> f64` — wrapped `$ObjVec` → f64(len); any
    other value → 0 (matches host import's null/non-array fallback).
  - `__extern_get_idx(externref, f64) -> externref` — wrapped `$ObjVec` →
    `data[i32(idx)]` for `0 <= i < len`, else null; non-`$ObjVec` → null.

### Proven
- `Object.keys(o)` over an `any` **function parameter** (TS can't narrow it to a
  closed struct shape) lowers to the native `__object_keys`; an all-`any`
  indexed read `(ks as any)[i]` lowers to native `__extern_get_idx`. All five
  helpers (`__object_keys`, `__objvec_new`, `__objvec_push`,
  `__extern_get_idx`, `__extern_length`) emit as **defined** functions, the
  module **validates**, instantiates with `{}`, and leaks **zero** object/array
  host imports. Test: `tests/issue-1472.test.ts` "Phase B Blocker B".

### Scoping note (why this is a foundation, not the whole enumeration feature)
Two consumer-side gaps remain — these are the stacked "enumeration consumer"
slice, NOT this foundation:
1. A locally-built `{}` is narrowed by TS to a **closed struct**, so
   `Object.keys` over it routes to the struct fast path in
   `compileObjectKeysOrValues` (builds a `__vec_externref`), never reaching the
   open-`$Object` runtime. Reaching the open runtime for non-param receivers is
   the **Blocker A** receiver-dispatch problem (routed to architect).
2. Typed consumers don't yet reach the extern helpers:
   - `ks.length` (direct member on `any`) routes through `__extern_get("length")`,
     not `__extern_length`.
   - `const ks: string[] = Object.keys(o); for (const k of ks)` triggers
     `buildVecFromExternref`, which pulls in host-only `env::__array_from_iter`
     and emits **invalid** Wasm in standalone.
   The consumer slice must (a) bypass/standalone-implement `__array_from_iter`
   when the source is already an `$ObjVec`, and (b) route `.length` / indexed
   member-access on `any` to `__extern_length` / `__extern_get_idx`.
`__object_values` / `__object_entries` / `__object_assign` / `__for_in_keys`
stack trivially on the `$ObjVec` + `__objvec_*` primitives added here.

## Phase B Blocker B Slice 2 — enumeration consumer (sd-1472, 2026-06-03)

Branch `issue-1472-blocker-b-slice2` off origin/main (post-#1075). Wires the
typed enumeration *consumer* chain to the native `$ObjVec` foundation so
`Object.keys(o)` results are usable host-free in standalone.

### What landed
- `src/codegen/type-coercion.ts` `buildVecFromExternref`: under `ctx.standalone`,
  SKIP the host-only `env::__array_from_iter` materialization (the source is
  already an indexable externref — the `$ObjVec` from Object.keys/values/entries)
  and read elements via the native `__extern_get_idx(obj, f64(idx))` instead of
  `__extern_get(obj, boxed-index)` (the native `__extern_get` casts its key to
  `$AnyString` and would trap on a boxed number). JS-host path unchanged.
- `src/codegen/property-access.ts` `.length` block: under `ctx.standalone`, when
  the receiver type is `any`/`unknown` and no vec fast-path matched, route
  `.length` to the native `__extern_length` (the `$ObjVec` length reader) instead
  of falling through to `__extern_get("length")`. JS-host path unchanged.
- `tests/issue-1472.test.ts`: (a) `const ks: string[] = Object.keys(o); for…of`
  validates + leaks zero `__array_from_iter`/object/array host imports; (b)
  `(ks.length)` on an `any` routes to native `__extern_length`, validates, emits
  it as a defined fn.

### Validation
- `tests/issue-1472.test.ts` — 15 pass. No gc-mode regression: issue-1471,
  issue-1664, and the externref-array-destructuring / array-rest-destructuring /
  for-of-array-destructuring / arguments-object equivalence suites all green.

## Phase B Slice 3 — values / entries / assign / has_idx (sd-1472, 2026-06-03)

Branch `issue-1472-slice3` off origin/main (post-#1075/#1078). Completes the
remaining open-object enumeration / indexed-access / assign surface on top of
the `$ObjVec` foundation, all as DEFINED Wasm functions (no host imports, no
index shift — same invariant as Slices 1/2).

### What landed (`src/codegen/object-runtime.ts`)
- `__object_values(externref) -> externref`: walks the `$Object` `$PropMap`,
  pushes each LIVE + enumerable entry's *value* (anyref → externref) into a fresh
  `$ObjVec`. Mirror of `__object_keys` over the value field.
- `__object_entries(externref) -> externref`: each entry is itself a 2-element
  `$ObjVec` (`[key, value]`), wrapped to externref and pushed into the outer
  `$ObjVec`. The native `__extern_get_idx` already indexes a `$ObjVec`, so a
  consumer reading `entry[0]`/`entry[1]` round-trips without a host array.
- `__extern_has_idx(externref, f64) -> i32`: array-like `HasProperty(O,
  ToString(idx))` — present iff `0 <= i32(idx) < len` over a `$ObjVec` (mirror of
  `__extern_get_idx`, returns i32). Drives array-method callback loops
  (`Array.prototype.filter.call(arrayLike, …)`) so they skip holes host-free.
- `__object_assign(externref target, externref sources) -> externref`: §20.1.2.1.
  `sources` is a `$ObjVec` of source externrefs; for each source that is a
  `$Object`, copy every LIVE + enumerable own prop into `target` via the native
  `__extern_set` (lenient no-op on a non-`$Object` target / nullish source).
  Returns `target` (identity preserved).
- New export `ensureObjVecBuilders(ctx)` returns the `__objvec_new` /
  `__objvec_push` funcIdxs.

### Call-site retargeting (the one non-trivial design call)
`Object.assign(target, ...sources)` and the object-spread fallback build the
variadic `...sources` list with `__js_array_new` / `__js_array_push`. Those two
names are **not** safe to globally alias onto the `$ObjVec` builders: they are
also used pervasively for real JS-array construction (spread call args, tagged
templates, `new`-with-spread, `Reflect.apply` arg arrays, array-method results),
whose consumers expect a genuine JS array — aliasing would silently corrupt
those paths. So instead of a global alias, the **3 assign/spread call sites**
(`calls.ts` Object.assign handler, `literals.ts`
`compileObjectLiteralAsExternref` + `compileObjectLiteralWithAccessors`) branch
on `ctx.standalone` to build the sources list with `ensureObjVecBuilders` (native
`$ObjVec`) vs the JS-host imports. `__object_assign` itself iterates a `$ObjVec`
(`ref.test $ObjVec`), so the only call-site delta is *which funcIdx* the existing
builder loop calls. JS-host path is byte-for-byte unchanged (the `else` branch).

### Latent bug fixed: enumerable-bit AND in `__object_keys` (Blocker B)
While end-to-end testing enumeration I found `__object_keys` (merged in #1075,
never runtime-asserted — its test only checked compile+validate) computed
`(not-tombstone:0/1) i32.and (flags & ENUMERABLE:0/0x02)`. `1 & 0x02 == 0`, so
`Object.keys` ALWAYS returned an empty `$ObjVec`. Fixed by normalising the
enumerable bit to 0/1 (`i32.eqz; i32.eqz`) before the `&&`; applied the same
normalisation in the new values/entries/assign helpers. Now `Object.keys/values/
entries` return the correct elements (verified by for-of sum/count + `.length`).

### Validation
- `tests/issue-1472.test.ts` — 21 pass (6 new Slice-3 tests, all
  instantiate-and-run under Node's WasmGC engine with empty imports):
  values count + values-element round-trip via typed for-of (sum=30), entries
  count, Object.assign merge (later-source-wins → 18), object-spread `{...src}`,
  `__extern_has_idx` resolves native (no host import). Tests use *computed* keys
  (`o[k]=v`) to defeat static struct-shape inference and force the genuine open
  `$Object` runtime path (a literal `o.a=1` lets the compiler shape `o` into a
  closed struct that bypasses the runtime entirely).
- `npx tsc --noEmit` clean; `biome lint` clean (error level) on the 4 changed
  files. gc-mode `Object.assign merges properties` (#965) still green; the one
  pre-existing #965 `Symbol.for` failure reproduces identically on clean
  origin/main (unrelated). No gc-mode path touched — every change is
  `ctx.standalone`-gated or inside `ensureObjectRuntime` (standalone-only).

### Known consumer gaps (out of scope — Blocker A receiver-dispatch)
Reading a single element back via chained `any` indexing (`Object.values(o)[0]`
or `entries[0][1]`) does not route the *second* index through the native
helpers (the externref result loses its static type), and `Array.prototype.
filter.call(arrayLike, …)` emits a module with independent standalone gaps. The
helpers build correct structures (verified via the typed for-of consumer); the
element-readback routing belongs with the Blocker A receiver-dispatch slice.

## Phase C Slice — keyed presence: `in` / hasOwn (sd-1472c, 2026-06-05)

Branch `issue-1472c-has` off origin/main. Native keyed presence checks over the
`$Object` hash-map, closing the follow-up the Phase C Reflect note explicitly
deferred ("a real keyed native `has` — thin wrapper over `__obj_find`").

### What landed (`src/codegen/object-runtime.ts`)
- `__extern_has(externref obj, externref key) -> i32` — ES §7.3.12 HasProperty:
  own props AND the prototype chain. A proto-walk loop mirroring `__extern_get`
  (calls `__obj_find` at each `$Object` level, walks `$proto`), but returns a
  boolean (so a present-but-undefined property still reports 1). Drives the `in`
  operator (`binary-ops.ts` routes `key in obj` to `__extern_has` for an
  object-shaped externref receiver). Non-`$Object`/null → 0.
- `__hasOwnProperty` / `__object_hasOwn (externref, externref) -> i32` — ES
  §20.1.3.2 / §20.1.2.13: OWN-property presence only (no proto walk), via
  `__obj_find` over the own props table (find already skips tombstones). Both
  names share one body.
- All three added to `OBJECT_RUNTIME_HELPER_NAMES` so `ensureLateImport` routes
  them through `ensureObjectRuntime` under `ctx.standalone` BEFORE the Phase A
  `__extern_*`/`__hasOwnProperty`/`__object_hasOwn` refuse gate. No imports
  added ⇒ no index shift.

### Proven (`tests/issue-1472.test.ts`, instantiate-and-run, empty imports)
- `key in obj` over an open `any` (computed-key writes defeat closed-struct
  inference): present→1, absent→0; zero `env::__extern_has` / object imports.
- `Object.hasOwn(o, k)`: own→1, absent→0; zero `env::__object_hasOwn` imports.

### Scoping note (out of scope — method-dispatch gap)
`o.hasOwnProperty(k)` (the bare *method-call* form) does NOT reach
`__hasOwnProperty` — it routes through `__proto_method_call` (the open-`any`
method-dispatch path), which is still refused under standalone. The native
`__hasOwnProperty` func is in place for when that dispatch lands (the
`__extern_method_call`/`__proto_method_call` slice). `Object.hasOwn(o, k)` is the
host-free own-check today. `Object.prototype.hasOwnProperty.call(o, k)` likewise
needs the method-dispatch slice. The big win in this slice is the `in` operator
(`__extern_has`).

## Phase C Slice — prototype-chain ops (sd-1472c, 2026-06-05)

Branch `issue-1472c-proto` off origin/main. Native getPrototypeOf / Object.create
/ isPrototypeOf over the existing `$Object.$proto` field (field 0). The runtime
already *walks* the chain (`__extern_get`/`__extern_has`); these expose it.

### What landed (`src/codegen/object-runtime.ts`)
- `__getPrototypeOf(externref) -> externref` (ES §20.1.2.12): `$Object` →
  `extern.convert_any($proto)` (may be null); non-`$Object` → null.
- `__object_create(externref proto) -> externref` (ES §20.1.2.2): fresh empty
  `$Object` (new `$PropMap(INITIAL_CAP)`, count/tombstones/flags = 0) with
  `$proto` = (proto is `$Object` ? cast : null). `Object.create(null)` passes a
  null externref ⇒ `$proto` stays null. (The descriptors 2nd arg is materialised
  separately by the existing call site.)
- `__isPrototypeOf(externref obj, externref candidate) -> i32` (ES §20.1.3.3):
  walk `candidate.$proto` and `ref.eq` each level against obj; 1 if found, else 0.
- All three added to `OBJECT_RUNTIME_HELPER_NAMES` (routed under `ctx.standalone`
  before the Phase A `__getPrototypeOf`/`__isPrototypeOf` refuse gate). No imports
  added ⇒ no index shift.

### Proven (`tests/issue-1472.test.ts`, instantiate-and-run, empty imports)
- `Object.create(proto)` + `Object.getPrototypeOf(o) === proto` + inherited read
  through the chain → 8; zero `env::__getPrototypeOf`/`__object_create` imports.
- `Object.getPrototypeOf({})` → null (bare open object has null `$proto` in
  standalone — no built-in Object.prototype graph) → 5.

### Deliberately NOT in this slice
- **`Object.setPrototypeOf(o, p)`** is *stubbed* at its call site (`calls.ts`
  ~L3857) in ALL modes — it drops the proto arg and returns obj, so a native
  `__object_setPrototypeOf` would be dead code. Wiring the `$proto` write needs a
  dual-mode change to that stubbed call site (a separate follow-up).
- **`obj.isPrototypeOf(x)`** (the bare method-call form) routes through
  `__proto_method_call` (open-`any` method dispatch), still refused — the native
  `__isPrototypeOf` func is in place for when that dispatch lands.
- Primitive receivers (`getPrototypeOf(5)` → Number.prototype) return null —
  acceptable, since standalone ships no built-in prototype graph (the broader
  `__get_builtin` architectural item).

## Phase C Slice — `__extern_is_undefined` native (sd-1472c, 2026-06-05)

Branch `issue-1472c-is-undefined` off origin/main. Routes the single largest
remaining standalone-refusal helper (`__extern_is_undefined`, ~6.6k tests in the
live standalone run) to a native Wasm function instead of the Phase A refusal.

### Root cause / design
`__extern_is_undefined` is the undefinedness predicate behind every
default-parameter / destructuring-default fire (`function-body.ts`,
`closures.ts`, `class-bodies.ts`, `statements/destructuring.ts`) and the
`x === undefined` / `x == null` comparisons over an externref value
(`binary-ops.ts`). The JS-host import is `(v) => (v === undefined ? 1 : 0)` —
it distinguishes JS `undefined` (a *defined* externref minted by
`__get_undefined`) from `null`. Standalone has **no** `__get_undefined`:
`emitUndefined` (late-imports.ts) falls back to `ref.null.extern`, so the
runtime represents BOTH `undefined` and `null` as the null externref. The
standalone `__typeof_undefined` helper (`addUnionImportsAsNativeFuncs` in
index.ts) already encodes exactly this conflation as a bare `ref.is_null`.

So the correct native `__extern_is_undefined` under standalone is the **same**
`ref.is_null` — internally consistent with `__typeof_undefined`, and exactly
the predicate the callers want: a missing/omitted argument arrives as the null
externref (the same value `undefined` lowers to), so `ref.is_null` applies the
binding default in precisely the "value is undefined" cases (§14.3.3
Keyed/Iterator BindingInitialization defaults fire when the bound value is
`undefined`).

### What landed
- `src/codegen/object-runtime.ts`: registers `__extern_is_undefined(externref)
  -> i32` as a DEFINED function (`local.get 0; ref.is_null`) and adds it to
  `OBJECT_RUNTIME_HELPER_NAMES` so `ensureLateImport` auto-routes it through
  `ensureObjectRuntime` under `ctx.standalone` (the routing check sits *before*
  the Phase A `__extern_*` refuse gate). No imports added ⇒ no index shift.
- `tests/issue-1472.test.ts`: replaced the now-stale "destructuring defaults
  *refuse* `__extern_is_undefined`" Phase A test with two Phase C
  instantiate-and-run tests — a destructuring default `[x = 7, y = 9]` over
  `[5]` (→ 14) and a default-valued object parameter `f()` (→ 42). Both leak
  **zero** `env::__extern_is_undefined` / object host imports and run under
  Node's WasmGC engine with empty imports.

### Scoping note (deliberately NOT in this slice)
`x === undefined` where `x` is an **optional `number`** param does NOT route
through this helper in EITHER mode (gc or standalone) — the param lowers to f64
with a NaN sentinel, so the comparison resolves on the f64 side (verified: gc
mode never binds `__extern_is_undefined` for that shape, and returns the same
result). That f64/NaN optional-number representation is a separate pre-existing
limitation, independent of this slice.

### Pre-existing failure NOT touched by this slice
The "Phase B Slice 3: Object.assign … (no host array imports)" test in
`tests/issue-1472.test.ts` **already fails on clean origin/main HEAD**
(confirmed by stashing all edits): the `Object.assign(t, ...sources)`
computed-key path still builds the variadic sources list with the JS-host
`__js_array_new`/`__js_array_push` under standalone instead of the native
`$ObjVec` builders. This is a regression that predates this branch and belongs
to a separate Object.assign call-site-retargeting follow-up — left untouched
here to keep this slice's regression surface clean.
