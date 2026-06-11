# Architect: host-independence implementation plans

**Author**: arch-host-independence agent
**Date**: 2026-05-20
**Scope**: implementation specs for issues #1471, #1472, #1473, #1474
**Skipped**: #1470 (already landed via PR #408)

**Handoff intent**: these four plans are written here because concurrent
CI commits to `main` stripped my earlier in-place appendices on the
issue files. Tech lead to splice the relevant sections into
`plan/issues/sprints/52/1471-*.md`, `1472-*.md`, `1473-*.md`,
`1474-*.md` when convenient. The #1474 plan is also already in the
issue file at lines 169-364 (intact) — included here for completeness.

**Shared assumption (all 4 issues)**: #1470 introduced (or PR #408
introduces) a new `ctx.standalone: boolean` flag on `CodegenContext`,
plumbed from `CompileOptions.target === "standalone"`. The convention

```ts
const noJsHost = ctx.wasi || ctx.standalone;
```

is used at every gate point. Verify against PR #408's final shape and
adjust naming if it landed under a different name (e.g.,
`ctx.noJsHost`).

---

# #1471 — eliminate JS host boxing/unboxing

## Root cause
~35 call sites across `array-methods.ts`, `closures.ts`,
`expressions/calls.ts`, `expressions/calls-closures.ts`,
`expressions/new-super.ts`, `expressions/identifiers.ts`,
`property-access.ts`, `object-ops.ts`, `function-body.ts`,
`typeof-delete.ts`, `binary-ops.ts`, `type-coercion.ts` invoke
`ensureLateImport("__box_number"|"__unbox_number"|"__to_boolean"|
"__to_primitive"|"__typeof"|"__to_uint32"|"__box_boolean"|
"__unbox_boolean", …)` followed by `fctx.body.push({op:"call", funcIdx})`.
WasmGC + i31ref provide every primitive boxer/unboxer in pure Wasm;
the work is centralizing the dispatch.

## Prerequisite
- `ctx.standalone` flag (#1470 / PR #408)

## New helper module: `src/codegen/wasm-helpers/box-unbox.ts`

Idempotent, cached on `ctx.boxHelpers: Map<string, number>` (mirrors
`ctx.nativeStrHelpers`).

### Types to register on first use

```
(type $BoxedNumber  (struct (field $value f64)))
(type $Symbol       (struct (field $desc (ref null $AnyString))
                            (field $id   i32)))
```

For `Boolean`, use i31ref `(ref.i31 (i32.const 1))` /
`(ref.i31 (i32.const 0))` — cheaper than allocation. Reserve i31
low bits for tag discrimination if conflict with SMI-number i31
encoding (see `$__box_num_wasm` below).

Add `ctx.boxedNumberStructTypeIdx`, `ctx.symbolStructTypeIdx`
fields (mirror existing `ctx.errorStructTypeIdx` in
`registry/error-types.ts`).

### Helper functions (all internal; never exported; never imported)

```
$__box_num_wasm    (f64) -> externref
$__unbox_num_wasm  (externref) -> f64
$__box_bool_wasm   (i32)  -> externref
$__to_bool_wasm    (externref) -> i32
$__typeof_wasm     (externref) -> ref $AnyString
$__to_uint32_wasm  (externref) -> i32
$__to_primitive_wasm (externref, i32 hint) -> externref
$__box_symbol_wasm (i32 id) -> ref $Symbol
```

ABI note: every helper returns **externref** (not anyref) so call
sites that previously consumed `__box_number(f64) -> externref` need
zero further coercion. The helper internally builds an anyref and
ends with `extern.convert_any`. One extra instruction per call; worth
the call-site simplicity.

### `$__box_num_wasm` body — SMI fast path

```wat
(func $__box_num_wasm (param $v f64) (result externref) (local $i i32)
  ;; integer & fits in 30 bits? → i31
  local.get $v
  local.get $v
  f64.trunc
  f64.eq
  (if (result externref)
    (then
      local.get $v
      i32.trunc_sat_f64_s
      local.tee $i
      i32.const 0x40000000
      i32.lt_s
      local.get $i
      i32.const -0x40000000
      i32.ge_s
      i32.and
      (if (result externref)
        (then local.get $i ref.i31 extern.convert_any)
        (else local.get $v struct.new $BoxedNumber extern.convert_any)))
    (else
      local.get $v
      struct.new $BoxedNumber
      extern.convert_any)))
```

i31 fast path matters: hot numeric loops on
`let x: any = i; y += x;` would otherwise allocate per iteration.
Per acceptance criteria (1.5× JS-host ceiling), this is required to
meet the bench target.

### `$__unbox_num_wasm` body — type-test chain

```wat
(func $__unbox_num_wasm (param $v externref) (result f64)
  block $done (result f64)
    ;; null/undefined → 0 (JS Number(null)==0, Number(undefined)==NaN;
    ;; differentiate via a sentinel global $__undefined_singleton if
    ;; the spec divergence matters; Phase 1 returns 0 for both)
    local.get $v ref.is_null
    if f64.const 0 br $done end

    ;; convert externref → anyref for ref.test dispatch
    local.get $v any.convert_extern
    local.tee $a            ;; $a: anyref local

    ;; i31 fast path
    ref.test (ref i31)
    if
      local.get $a ref.cast (ref i31) i31.get_s f64.convert_i32_s
      br $done
    end
    ;; $BoxedNumber
    local.get $a ref.test (ref $BoxedNumber)
    if
      local.get $a ref.cast (ref $BoxedNumber)
      struct.get $BoxedNumber $value
      br $done
    end
    ;; $AnyString — parse via existing native-strings $__str_to_number
    local.get $a ref.test (ref $AnyString)
    if
      local.get $a ref.cast (ref $AnyString)
      call $__str_to_number     ;; returns f64; NaN on parse failure
      br $done
    end
    ;; fallback: $__to_primitive_wasm(v, hint=number) then re-unbox.
    ;; Tail-call to bound stack growth on adversarial inputs.
    local.get $v
    i32.const 0   ;; hint = number
    call $__to_primitive_wasm
    return_call $__unbox_num_wasm
  end)
```

### `$__to_bool_wasm` (ECMA-262 §7.1.2)

```wat
(func $__to_bool_wasm (param $v externref) (result i32) (local $a anyref) (local $f f64)
  local.get $v ref.is_null if i32.const 0 return end
  local.get $v any.convert_extern local.tee $a

  ref.test (ref i31)
  if
    local.get $a ref.cast (ref i31) i31.get_s
    i32.const 0 i32.ne return
  end
  local.get $a ref.test (ref $BoxedNumber)
  if
    local.get $a ref.cast (ref $BoxedNumber)
    struct.get $BoxedNumber $value local.tee $f
    f64.const 0 f64.ne
    local.get $f local.get $f f64.eq
    i32.and return
  end
  local.get $a ref.test (ref $AnyString)
  if
    local.get $a ref.cast (ref $AnyString)
    call $__str_length
    i32.const 0 i32.ne return
  end
  i32.const 1)   ;; objects, functions, symbols → true
```

### `$__typeof_wasm`

Returns one of 7 singleton `ref $FlatString` globals
(`$__str_undefined`, `$__str_number`, `$__str_string`,
`$__str_boolean`, `$__str_function`, `$__str_symbol`,
`$__str_object`). Allocate them in `ensureBoxUnboxHelpers(ctx)` via
`stringConstantExternrefInstrs` at start.

```wat
(func $__typeof_wasm (param $v externref) (result (ref $AnyString)) (local $a anyref)
  local.get $v ref.is_null if global.get $__str_undefined return end
  local.get $v any.convert_extern local.tee $a
  ref.test (ref i31)            if global.get $__str_number   return end
  local.get $a ref.test (ref $BoxedNumber)  if global.get $__str_number   return end
  local.get $a ref.test (ref $AnyString)    if global.get $__str_string   return end
  local.get $a ref.test (ref $Symbol)       if global.get $__str_symbol   return end
  local.get $a ref.test (ref $Closure_base) if global.get $__str_function return end
  global.get $__str_object)
```

`$Closure_base` is the existing base struct that all compiled
closures extend (see `src/codegen/closures.ts`); confirm the exact
type name at implementation time. Phase 2 may need a `$functionTag`
field on `$Object` for user objects with a `[[Call]]` slot.

### `$__to_primitive_wasm` (ECMA-262 §7.1.1)

**Phase 1 stub**: for already-primitive refs (`null`, i31,
`$BoxedNumber`, `$AnyString`) return as-is. For `$Symbol` return as-is.
For other refs (objects, closures) hint=string → call `$__any_to_string`
(provided by #1470); hint=number/default → return the string then let
`$__unbox_num_wasm` parse it.

Phase 2 will plumb `@@toPrimitive`/`valueOf`/`toString` vtable lookup
through `call_ref`; depends on #1472's `$Object` vtable infrastructure.

### `$__box_symbol_wasm`

```wat
(func $__box_symbol_wasm (param $id i32) (result (ref $Symbol))
  ref.null (ref null $AnyString)    ;; desc null for well-known symbols
  local.get $id
  struct.new $Symbol)
```

For well-known symbols (`Symbol.iterator`, `Symbol.asyncIterator`,
…), emit a module-init function that fills module-level globals
`(global $__sym_iterator (mut (ref null $Symbol)))` with
`$__box_symbol_wasm(<intrinsic-id>)` at start. The existing
`BUILTIN_TYPE_TAGS` registry (`src/codegen/builtin-tags.ts`)
provides the integer IDs.

For user `Symbol("foo")` calls, expose a 2-arg overload that
accepts a description externref.

## Routing helpers (single per primitive)

In `src/codegen/wasm-helpers/box-unbox.ts`:

```ts
export function emitBoxNumber(ctx: CodegenContext, fctx: FunctionContext): ValType {
  if (ctx.wasi || ctx.standalone) {
    const idx = ensureBoxUnboxHelper(ctx, "__box_num_wasm",
      [{ kind: "f64" }], [{ kind: "externref" }],
      emitBoxNumBody);
    fctx.body.push({ op: "call", funcIdx: idx });
    return { kind: "externref" };
  }
  const idx = ensureLateImport(ctx, "__box_number",
    [{ kind: "f64" }], [{ kind: "externref" }]);
  fctx.body.push({ op: "call", funcIdx: idx });
  return { kind: "externref" };
}

export function emitUnboxNumber(ctx, fctx): void { /* mirror */ }
export function emitBoxBoolean(ctx, fctx): ValType { /* mirror */ }
export function emitToBoolean(ctx, fctx): void { /* mirror */ }
export function emitToUint32(ctx, fctx): void { /* mirror */ }
export function emitTypeofResult(ctx, fctx): ValType { /* mirror */ }
export function emitToPrimitive(ctx, fctx, hint: 0|1|2): void { /* mirror */ }
```

`ensureBoxUnboxHelper` registers the in-module function (NOT an
import) — funcIdx is `ctx.numImportFuncs + ctx.mod.functions.length`
at registration time, then `ctx.mod.functions.push({...})`. No
`shiftLateImportIndices` needed because no new import is added. This
mirrors `emitWasiErrorConstructor`'s pattern at
`src/codegen/registry/error-types.ts:116`.

## Per-call-site retargeting

Mechanical search-and-replace. Pattern:

```ts
// before
const boxIdx = ensureLateImport(ctx, "__box_number",
  [{ kind: "f64" }], [{ kind: "externref" }]);
fctx.body.push({ op: "call", funcIdx: boxIdx });

// after
emitBoxNumber(ctx, fctx);
```

Sites confirmed from grep of `src/codegen/`:

| File                                       | Lines (approx)                           |
| ------------------------------------------ | ---------------------------------------- |
| `src/codegen/array-methods.ts`             | 864, 968, 1072                           |
| `src/codegen/closures.ts`                  | 1963, 2060                               |
| `src/codegen/expressions/calls.ts`         | 738, 2621, 2626, 2669, 2676, 2683, 6342, 6649, 6653 |
| `src/codegen/expressions/calls-closures.ts`| 299, 312                                 |
| `src/codegen/expressions/new-super.ts`     | 1066, 1083                               |
| `src/codegen/function-body.ts`             | 802, 803                                 |
| `src/codegen/property-access.ts`           | 650, 656, 1090, 1098, 2093, 2200, 2208, 2320, 2390, 2501 |
| `src/codegen/object-ops.ts`                | 167, 168, 2289–2295, 2346–2354           |
| `src/codegen/binary-ops.ts`                | 241, 869, 892, 1404, 1627, 1683, 1715, 1736 |
| `src/codegen/type-coercion.ts`             | 136–148, 199–360, 1296–1410              |
| `src/codegen/typeof-delete.ts`             | 241, 782                                 |

Don't touch all sites in one PR — split by file. Order suggestion:
type-coercion.ts first (highest call-site density), then
property-access.ts, then object-ops.ts, then the rest.

## Test approach

- **Existing**: `tests/equivalence.test.ts` covers boxing surfaces.
  Must remain green in default mode AND under `--target standalone`.
  Add a `STANDALONE_EQUIV=1` test mode that recompiles every fixture
  with `target: "standalone"` and asserts identical output (or skips
  if the fixture needs a feature gated to JS-host mode).
- **New** `tests/standalone-boxing.test.ts`:
  - i31 hot loop bench (gate on 1.5× JS-host)
  - `typeof x === "string"`, `typeof x === "function"`,
    `typeof x === "symbol"`, `typeof x === "undefined"`
  - `Number("3.14")`, `Number(true)`, `Number(null)`,
    `Number(undefined)`
  - `Boolean(NaN)`, `Boolean("")`, `Boolean(0)`, `Boolean({})`
  - `let s = Symbol(); let t = Symbol(); s === t` → false
  - `Symbol.iterator === Symbol.iterator` → true
- **Import-section assertion** (shared helper from #1470 /
  PR #408): zero `env::__box_*`, `env::__unbox_*`, `env::__to_*`,
  `env::__typeof*`, `env::__box_symbol`.
- **Bench**: standalone variant for one numeric hot loop; fail PR if
  > 1.5× JS-host fast path.

## Dependency ordering within #1471

1. Land `$BoxedNumber` + `$__box_num_wasm` + `$__unbox_num_wasm`
   first (~80% of call sites by frequency).
2. `$__to_bool_wasm` + `$__typeof_wasm` next.
3. `$__box_symbol_wasm` + `$__to_primitive_wasm` last.

## Cross-issue ordering

- #1470 lands first (PR #408 in progress) — provides
  `ctx.standalone` + native-string `$__any_to_string`.
- #1471 lands second.
- #1473 depends on #1471 (TypeError `.message` field uses boxed
  externref; helpers from #1471 simplify the throw helpers).
- #1472 depends on #1471 (open-object property values are
  externref slots backed by box/unbox helpers).
- #1474 independent; can land any time after #1470.

---

# #1472 — eliminate JS host object/property ops

## Root cause
Open-object semantics (objects with dynamic shape, `any`-typed
property access, ES `Object.*` methods, `for-in`) currently delegate
to ~50 host imports across 13 families. The WasmGC compiler already
represents closed-shape structs natively (no host calls); the gap is
the open-shape runtime. This is the largest issue in the
host-independence goal — split into three phases.

## Prerequisite
- `ctx.standalone` flag (#1470 / PR #408)
- Boxing helpers (#1471) — `Object` property values are externref
  slots; backed by the box/unbox helpers

## Phase A — refuse-and-document for opt-out paths (this issue MVP)

Gate every code path that currently emits an `ensureLateImport` for
an `__extern_*` / `__object_*` / `__for_in_*` / `__defineProperty*` /
`__hasOwnProperty` / `__getOwn*` / `__delete_property` / `__new_plain_object`
/ `__extern_method_call` import. When `ctx.standalone`, emit a
compile-time error instead:

```ts
// New helper in src/codegen/object-ops.ts or a shared module
function emitObjectOpStandaloneError(
  ctx: CodegenContext, expr: ts.Node, opName: string
): null {
  reportError(ctx, expr,
    `${opName} on a dynamic-shape object is not yet supported in ` +
    `--target standalone (#1472 Phase B). Use a typed object ` +
    `literal or class instance for fast-path codegen.`);
  return null;
}
```

Apply at every `ensureLateImport(ctx, "__extern_get", …)` etc. call:

```ts
if (ctx.standalone) return emitObjectOpStandaloneError(ctx, expr, "__extern_get");
// ... existing import-registration path
```

**Closed-shape struct access (the existing `getFieldEntry`-based fast
path in `property-access.ts`) ALREADY works without host imports** —
verify with the import-section assertion helper from PR #408.

Phase A acceptance:
- [ ] `--target standalone` compiles a class-only / typed-only program
      (math, fib, string-basics) with zero `env::__extern_*` /
      `env::__object_*` imports
- [ ] Any open-object usage in `--target standalone` errors with a
      message pointing to #1472 Phase B

Phase A diff: ~150 LOC. Single PR.

## Phase B — Wasm-native open-object runtime (separate follow-up issue)

### New WasmGC types (in `src/codegen/wasm-helpers/object-runtime.ts`)

```
(type $PropEntry (struct
  (field $key      (ref $AnyString))
  (field $value    (mut externref))         ;; null = tombstone (combined w/ flags bit)
  (field $flags    (mut i32))))             ;; writable/enumerable/configurable/accessor/tombstone

(type $PropMap (array (mut (ref null $PropEntry))))

(type $Object (struct
  (field $proto      (ref null $Object))
  (field $props      (mut (ref $PropMap)))
  (field $count      (mut i32))             ;; live entries
  (field $tombstones (mut i32))             ;; for rehash threshold
  (field $flags      (mut i32))))           ;; extensible/frozen/sealed
```

Flags bit layout (i32):
```
bit 0: writable
bit 1: enumerable
bit 2: configurable
bit 3: accessor (1 = $value holds a getter/setter pair struct; 0 = data)
bit 4-6: reserved
bit 7: tombstone (1 = deleted; key still present for probing)
```

Object flags:
```
bit 0: extensible (1 = can add props)
bit 1: sealed
bit 2: frozen
```

### Helpers (all internal; registered idempotently in `ensureObjectRuntime`)

```
$__obj_new          ()                                  -> ref $Object
$__obj_get          (ref $Object, ref $AnyString)       -> externref
$__obj_set          (ref $Object, ref $AnyString, externref) -> void
$__obj_del          (ref $Object, ref $AnyString)       -> i32     ;; 1 = deleted
$__obj_has          (ref $Object, ref $AnyString)       -> i32
$__obj_keys         (ref $Object)                       -> ref $AnyVec  ;; enumerable, insertion order
$__obj_values       (ref $Object)                       -> ref $AnyVec
$__obj_entries      (ref $Object)                       -> ref $AnyVec  ;; entries are 2-tuples
$__obj_assign       (ref $Object, ref $Object)          -> ref $Object
$__obj_freeze       (ref $Object)                       -> ref $Object
$__obj_isFrozen     (ref $Object)                       -> i32
$__obj_grow         (ref $Object)                       -> void    ;; internal
$__obj_hash         (ref $AnyString)                    -> i32
$__obj_define_prop  (ref $Object, ref $AnyString, externref, i32 flags) -> void
$__obj_get_desc     (ref $Object, ref $AnyString)       -> ref null $PropEntry
$__proto_walk       (ref $Object, ref $AnyString)       -> externref
$__obj_isProtoOf    (ref $Object, ref $Object)          -> i32
```

### Hash function

FNV-1a over UTF-16 code units. ASCII fast path skips half the bytes:

```wat
(func $__obj_hash (param $s (ref $AnyString)) (result i32) (local $h i32) (local $i i32) (local $n i32)
  i32.const 0x811C9DC5 local.set $h        ;; FNV offset basis
  local.get $s call $__str_length local.set $n
  (loop $body
    local.get $i local.get $n i32.lt_s
    if
      local.get $h
      local.get $s local.get $i call $__str_code_unit_at
      i32.xor
      i32.const 0x01000193 i32.mul         ;; FNV prime
      local.set $h
      local.get $i i32.const 1 i32.add local.set $i
      br $body
    end)
  local.get $h)
```

`$__str_code_unit_at(s, i)` is the existing native-strings helper
that returns the i'th UTF-16 code unit (search `nativeStrHelpers`
keys for the canonical name).

### Get algorithm (linear probing)

```wat
(func $__obj_get (param $o (ref $Object)) (param $k (ref $AnyString))
                 (result externref)
                 (local $arr (ref $PropMap)) (local $cap i32) (local $i i32)
                 (local $e (ref null $PropEntry))
  local.get $o struct.get $Object $props local.set $arr
  local.get $arr array.len local.set $cap
  local.get $k call $__obj_hash
  local.get $cap i32.const 1 i32.sub i32.and       ;; assume cap is power of 2
  local.set $i
  (loop $probe
    local.get $arr local.get $i array.get $PropMap local.set $e
    local.get $e ref.is_null
    if
      ;; empty slot → key not present → walk proto chain
      local.get $o struct.get $Object $proto
      ref.is_null
      if ref.null extern return end
      local.get $o struct.get $Object $proto
      ref.as_non_null
      local.get $k
      return_call $__obj_get
    end
    local.get $e ref.as_non_null struct.get $PropEntry $key
    local.get $k
    call $__str_equals
    if
      ;; check tombstone bit (flags & 0x80)
      local.get $e ref.as_non_null struct.get $PropEntry $flags
      i32.const 0x80 i32.and
      if ref.null extern return end
      local.get $e ref.as_non_null struct.get $PropEntry $value
      return
    end
    local.get $i i32.const 1 i32.add
    local.get $cap i32.const 1 i32.sub i32.and
    local.set $i
    br $probe))
```

### Grow strategy

Initial capacity 8. Double when `count + tombstones > cap * 7 / 8`.
Rehash on grow (loses tombstones). On grow alone (no thresh trigger),
ECMAScript insertion order is preserved by tracking insertion in a
secondary `(array $InsOrderEntry)` (each `$PropEntry` gets an
`$insertSeq i32` field; `$__obj_keys` sorts by it). Phase B
acceptable simplification: ignore insertion order until #1472 Phase
B.1 (test262 has a few failure modes around this; tag them with a
follow-up).

### Per-import retargeting

Single helper per family in `src/codegen/wasm-helpers/object-runtime.ts`:

```ts
export function emitExternGet(ctx, fctx, expr): ValType | null {
  if (ctx.standalone) {
    ensureObjectRuntime(ctx);
    const idx = ctx.objectHelpers.get("__obj_get")!;
    fctx.body.push({ op: "call", funcIdx: idx });
    return { kind: "externref" };
  }
  // existing __extern_get import path
}
// ... mirror for emitExternSet, emitExternGetIdx, emitExternLen,
//     emitNewPlainObject, emitHasOwn, emitObjectKeys, emitForInKeys,
//     emitDeleteProperty, emitDefineProperty
```

Apply mechanically:

| Helper                        | Replaces import                              | Call sites                              |
| ----------------------------- | -------------------------------------------- | --------------------------------------- |
| `emitExternGet`               | `__extern_get`                               | `object-ops.ts:155, 1115, 1343, 2039`   |
| `emitExternSet`               | `__extern_set`                               | `object-ops.ts:161, 1371, 2067, 1993`   |
| `emitExternGetIdx`            | `__extern_get_idx`                           | `type-coercion.ts:357`                  |
| `emitExternLen`               | `__extern_length`                            | `object-ops.ts:2108`                    |
| `emitNewPlainObject`          | `__new_plain_object`                         | `literals.ts:139, 227, 458`             |
| `emitHasOwn`                  | `__hasOwnProperty`/`__propertyIsEnumerable`  | `object-ops.ts:2396, 2574`              |
| `emitObjectKeys/Values/Entries` | `__object_keys`/etc.                       | `object-ops.ts:2067, 1993`              |
| `emitForInKeys`               | `__for_in_keys`                              | `statements/loops.ts` (new path)        |
| `emitDeleteProperty`          | `__delete_property`                          | `typeof-delete.ts:782`                  |
| `emitDefineProperty*`         | `__defineProperty_*`                         | `object-ops.ts:1115, 1343`              |

### for-in loop in standalone mode

In `src/codegen/statements.ts` (or `statements/loops.ts` if extracted):

```ts
// Compile receiver → local $obj
if (noJsHost) {
  ensureObjectRuntime(ctx);
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.objectHelpers.get("__obj_keys")! });
  // stack: ref $AnyVec — iterate using existing vec-iterate codegen
} else {
  // existing __for_in_keys path
}
```

## Phase C — Proxy refusal + Reflect dispatch

```ts
// new-super.ts (RegExp / Proxy ctor dispatch site)
if (className === "Proxy" && ctx.standalone) {
  reportError(ctx, expr,
    "Proxy is not supported in --target standalone (#1472 Phase C). " +
    "Use a Wasm-native object with overridden methods instead.");
  return null;
}
```

Same for `Proxy.revocable` and `Reflect.construct` against proxy
targets. Pure `Reflect.get/set/has` aliases the `$__obj_*` helpers
(no refusal needed).

## Test approach

- **Phase A**: `tests/standalone-objects-refuse.test.ts` — assert
  the compile error fires for `let o: any = {x: 1}; o.y = 2;`;
  assert closed-shape struct programs compile clean.
- **Phase B**: `tests/standalone-objects.test.ts` — wasmtime smoke:
  literals, add/read/delete, `Object.keys/values/entries`, `for-in`,
  `Object.assign`, `Object.defineProperty`, prototype walks, class
  vtable dispatch.
- **Phase B Test262**: `built-ins/Object/{keys,values,entries,assign,
  defineProperty,freeze,isFrozen,create}` + `built-ins/Reflect/*`
  (no Proxy) in standalone mode; budget the regression against
  default-mode dashboard.
- **Phase C**: `tests/standalone-proxy-refuse.test.ts`.

## Dependency ordering within #1472

1. **Phase A** — smallest piece; gates dynamic ops with clear error.
2. **Phase B** — open-object runtime + retargeting. Land one helper
   family per PR (`__obj_get`/`set` first, then keys/values/entries,
   then defineProperty, then for-in). Each PR adds the Wasm helper +
   retargets one column of the table above.
3. **Phase C** — Proxy refusal; ~50 LOC.

## Cross-issue ordering

- #1470 (PR #408), #1471 land first.
- #1473 lands before #1472 Phase B so the open-object runtime can
  `throw` real TypeErrors on `Object.freeze` violation, etc.
- #1474 independent.

---

# #1473 — eliminate JS host error/exception ops

## Root cause
Two intertwined host dependencies:

1. Spec-mandated implicit throws (`__throw_type_error`,
   `__throw_reference_error`) call `new TypeError(msg)` /
   `new ReferenceError(msg)` in JS. Imports are unsatisfied in
   standalone → `wasmtime instantiate` fails.
2. Catch-binding for foreign exceptions uses `catch_all` +
   `__get_caught_exception` to read the JS-side `lastCaughtException`
   sidecar (`runtime.ts:4974-4988`). No sidecar in standalone →
   caught value is `null`.

Wasm Exceptions proposal + existing `$Error_struct` infra (#1104,
`registry/error-types.ts`) provide everything needed; policy moves
out of JS.

## Existing infrastructure to reuse

- **`$Error_struct`** (`registry/error-types.ts:28`):
  ```
  (type $Error_struct (struct
    (field $tag i32)
    (field $message (mut externref))
    (field $name externref)))
  ```
- **`emitWasiErrorConstructor(ctx, errorName, argCount)`**
  (`registry/error-types.ts:107`) — emits `__new_<Name>` Wasm
  functions for the 8 built-in Errors. Already wasi-safe.
- **`emitThrowTypeError(ctx, fctx, message)`** in
  `expressions/helpers.ts:93` — already does the right shape:
  `__new_TypeError(msg) + ensureExnTag + throw`. But several call
  sites still use the raw `__throw_type_error` host import — fix by
  routing them through this helper.
- **`ensureExnTag(ctx)`** in `registry/imports.ts` — registers the
  single `(tag $exc (param externref))`. **Keep** as-is in
  standalone; payload is `extern.convert_any`d `$Error_struct`.

## Prerequisite
- `ctx.standalone` (#1470 / PR #408)
- `stringConstantExternrefInstrs` already works under WASI/native-strings;
  no #1471 dependency for this issue's message-string construction.

## Changes

### (1) `__throw_type_error` sites — route through `emitThrowTypeError`

In `src/codegen/destructuring-params.ts:148`:

```ts
// before
const throwIdx = ensureLateImport(ctx, "__throw_type_error",
  [{ kind: "externref" }], []);
// ... message externref already on stack ...
fctx.body.push({ op: "call", funcIdx: throwIdx });

// after — restructure so the message is known at this point as a string:
emitThrowTypeError(ctx, fctx, /* missingArgMessage */);
```

Same surgery at `expressions/calls.ts:5600` and any other site:

```bash
rg 'ensureLateImport.*__throw_type_error' src/codegen/
```

Audit each site: if the message is dynamic (not a literal), the
existing `emitThrowTypeError` helper needs a new overload that
takes an already-pushed externref instead of constructing one from a
literal. Add a sibling helper:

```ts
/**
 * Throw a TypeError instance whose message is the externref already
 * on the stack. Caller must push the message externref before
 * calling this helper.
 */
export function emitThrowTypeErrorWithStackMessage(
  ctx: CodegenContext, fctx: FunctionContext
): void {
  const newTypeErrorIdx = ensureLateImport(ctx, "__new_TypeError",
    [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newTypeErrorIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: newTypeErrorIdx });
  }
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}
```

Standalone-safety: when `ctx.wasi || ctx.standalone`, call
`emitWasiErrorConstructor(ctx, "TypeError", 1)` before
`ensureLateImport("__new_TypeError", …)` — the latter then resolves
to an internal Wasm function rather than a host import. The existing
`emitThrowTypeError` (line 93–106) already handles this implicitly
because the funcIdx lookup goes through `ctx.funcMap`.

### (2) `__throw_reference_error` sites — new helper

Add to `src/codegen/expressions/helpers.ts`:

```ts
/**
 * Emit a throw of a ReferenceError instance for TDZ / unresolved
 * identifier reference. Mirrors emitThrowTypeError.
 *
 * In WASI / standalone mode the constructor is an in-module Wasm
 * function (registered by emitWasiErrorConstructor). In JS-host
 * mode it's the imported JS ReferenceError constructor.
 */
export function emitThrowReferenceError(
  ctx: CodegenContext, fctx: FunctionContext, message: string
): void {
  if (ctx.wasi || ctx.standalone) {
    emitWasiErrorConstructor(ctx, "ReferenceError", 1);
  }
  addStringConstantGlobal(ctx, message);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, message));
  const newRefErrIdx = ensureLateImport(ctx, "__new_ReferenceError",
    [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newRefErrIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: newRefErrIdx });
  }
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}
```

Replace all three sites in `src/codegen/expressions/identifiers.ts`
at lines 28, 310, 549:

```ts
// before
const throwRefErrIdx = ensureLateImport(ctx, "__throw_reference_error",
  [{ kind: "externref" }], []);
// ... push message ...
fctx.body.push({ op: "call", funcIdx: throwRefErrIdx });

// after
emitThrowReferenceError(ctx, fctx, `Cannot access '${name}' before initialization`);
```

### (3) `__get_caught_exception` removal in standalone

Current dual-branch emission at `src/codegen/statements/exceptions.ts:515-594`
emits a `try` with both `catches: [{ tagIdx, body: typedCatchBody }]`
AND `catchAll: catchAllBody` (the catch_all body calls
`__get_caught_exception` and binds the result to the catch local).

In standalone mode, there's no JS host to throw foreign exceptions
and Wasm traps aren't catchable. Drop the catch_all branch:

```ts
const noJsHost = ctx.wasi || ctx.standalone;
if (noJsHost) {
  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches: [{ tagIdx, body: typedCatchBody }],
    // catchAll OMITTED — no JS-foreign exceptions possible
  });
} else {
  // existing dual-branch emission
  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches,
    catchAll: catchAllBody,
  });
}
```

Subtlety: the catch local's binding lives in `typedCatchBody`,
which the typed `catch $exc` populates by pushing the externref
payload onto the stack at entry. Verify that the existing
typed-catch path at line 515 already does `local.set $exnLocalIdx`
at the head of `typedCatchBody`. If not, splice it in.

Also audit `src/codegen/expressions.ts:269` (the other
`ensureLateImport("__get_caught_exception", …)` site) — likely an
adapter for async/generator try blocks. Same gating pattern.

### (4) `$exc` tag payload — verify wasi-safety

Tag signature `(tag $exc (param externref))` — unchanged. In
standalone, the externref is the result of `extern.convert_any` on
a `$Error_struct` (already correct via `registry/error-types.ts:130`).

Reading fields:
- `e.message` → `property-access.ts:914` already emits direct
  `ref.cast $Error_struct + struct.get message` when
  `ctx.errorStructTypeIdx >= 0`. **No change**.
- `e instanceof TypeError` → `$tag` field comparison; Phase 3 of
  #1104 already covers this. Verify the path doesn't fall back to
  `__instanceof` host import in standalone (`typeof-delete.ts` or
  wherever instanceof is lowered).

### (5) `RangeError` for stack overflow — known divergence

Document at `plan/method/standalone-divergences.md` (create if not
existing): wasmtime traps with `call stack exhausted` rather than
throwing a catchable `RangeError`. Matches all other
wasm32-targeting languages.

### (6) `assert.throws` (test262 harness) — out of scope

Test262 harness is JS code; never compiled. Document that
`tests/standalone-*.test.ts` runners must NOT use `assert.throws` —
instead assert on the wasmtime exit code (non-zero = uncaught throw).

## Wasm IR patterns

`try {…} catch (e) {…}` in standalone:
```wat
(try
  (do … tryBody …)
  (catch $exc
    ;; externref payload on stack
    local.set $exnLocalIdx
    … catchBody using local.get $exnLocalIdx …))
```

`throw new TypeError("msg")`:
```wat
;; stringConstantExternrefInstrs → externref on stack
call $__new_TypeError      ;; returns externref ($Error_struct)
throw $exc
```

TDZ: `let x; x;` before init:
```wat
local.get $x_tdz_flag i32.eqz
if
  ;; "Cannot access 'x' before initialization" externref
  call $__new_ReferenceError
  throw $exc
end
```

## Test approach

- **Existing**: throw/catch + TDZ + `instanceof TypeError` tests in
  `tests/equivalence.test.ts` — must remain green default AND
  standalone.
- **New** `tests/standalone-throw.test.ts`:
  - `try { throw new TypeError("x") } catch (e) { return e.message }`
    → `"x"`
  - `try { throw new RangeError("r") } catch (e) {
       return e instanceof TypeError ? "wrong" : "ok" }` → `"ok"`
  - `try { let z = x; let x = 1; } catch (e) {
       return e instanceof ReferenceError }` → `true`
  - Nested try/catch with rethrow — verifies typed-catch preserves
    externref payload
- **Import-section assertion**: zero `env::__throw_type_error`,
  `env::__throw_reference_error`, `env::__get_caught_exception`,
  `env::TypeError_new`, `env::ReferenceError_new`. `__new_TypeError`
  / `__new_ReferenceError` should appear in `ctx.mod.functions`, NOT
  in the import section.
- **Test262**: `language/statements/try/**` and
  `language/expressions/throw/**` — re-run in standalone; budget
  regression vs default-mode dashboard.

## Dependency ordering within #1473

1. `emitThrowReferenceError` helper + identifier-site retargeting
   (~80 LOC).
2. `emitThrowTypeError` retargeting at remaining call sites
   (`destructuring-params.ts:148`, `expressions/calls.ts:5600`) —
   ~30 LOC.
3. Catch-block standalone simplification (`exceptions.ts:515-594`,
   `expressions.ts:269`) — ~50 LOC; subtle, test extensively.

## Cross-issue ordering

- #1470 (PR #408) lands first.
- #1471 lands before #1473 (string-message externref construction
  via native-strings bridge benefits from #1471's boxing infra
  consistency).
- #1473 independent of #1472 — can land in parallel.

---

# #1474 — eliminate JS host RegExp (Phase 1: refuse-and-document)

> Note: the full plan also lives in
> `plan/issues/1474-no-js-host-regex-standalone.md` lines
> 169-364 (intact). This is a condensed copy for handoff
> completeness. Issue status currently `in-progress`.

## Root cause
No Wasm-native regex engine. `RegExp_new` host import + JS
delegations for `String.prototype.{replace, replaceAll, split, match,
matchAll}` with regex arg. Standalone fails at instantiate.

Phase 1 is refuse-and-document only. Phase 2 (NFA engine) deferred.

## Prerequisite
- `ctx.standalone` flag (#1470 / PR #408). No other dependencies.

## Changes

**(1) `src/codegen/typeof-delete.ts:287-311` (`compileRegExpLiteral`)** —
gate at function top:
```ts
if (ctx.standalone) {
  reportError(ctx, expr,
    "RegExp literals are not supported in --target standalone " +
    "(#1474). Recompile without --target standalone, or replace " +
    "the regex with String.prototype.{indexOf, startsWith, slice}.");
  return null;
}
```

**(2) `src/codegen/builtin-tags.ts:180` (allowed-ctor list)** — drop
`"RegExp"` when `ctx.standalone`. Also gate the dispatch in
`src/codegen/expressions/new-super.ts` at the `new RegExp(…)` branch:
```ts
if (className === "RegExp" && ctx.standalone) {
  reportError(ctx, expr,
    "new RegExp(...) is not supported in --target standalone (#1474). " +
    "Recompile without --target standalone.");
  return null;
}
```

**(3) `src/codegen/string-ops.ts:1680, 1690, 1718, 1746`** — at each
`firstArgIsRegExp` branch, insert before the host-fallback:
```ts
if (firstArgIsRegExp && ctx.standalone) {
  reportError(ctx, expr,
    `String.prototype.${method}(RegExp, …) is not supported in ` +
    `--target standalone (#1474). Pass a string pattern instead, ` +
    `or recompile without --target standalone.`);
  return null;
}
```

**(4) `src/codegen/index.ts` ~line 3451 (`regexpArgMethods`)** — gate
import registration on `!ctx.standalone`.

**(5) `src/codegen/declarations.ts:200, 288`** — audit; same gate
where regex-related imports are registered.

## Error message style

```
<Feature> is not supported in --target standalone (#1474).
<Workaround>, or recompile without --target standalone.
```

Source position comes free from `reportError(ctx, expr, msg)`.

## Test approach

`tests/standalone-regex-refuse.test.ts`:
```ts
it("rejects regex literal in standalone mode", () => {
  const result = compile(
    `export function f(s: string) { return /\\d+/.test(s); }`,
    { target: "standalone" });
  expect(result.success).toBe(false);
  expect(result.errors[0].message).toMatch(/#1474/);
});

it("rejects new RegExp in standalone mode", () => {…});
it("rejects s.replace(regex, ...) in standalone mode", () => {…});
it("rejects s.match(regex) in standalone mode", () => {…});
it("rejects s.split(regex) in standalone mode", () => {…});
```

Default-mode regression: all existing regex tests in
`tests/equivalence.test.ts` must remain green.

Import-section assertion (shared helper from PR #408): for a
standalone program with NO regex, zero `env::RegExp_new`,
`env::regexp_*` imports.

## Dependency ordering

Within #1474: single PR, ~80 LOC across 5 files.

Cross-issue: only requires #1470 (`ctx.standalone`). Can land in
parallel with #1471, #1472, #1473. **Land last** so the other three
don't inadvertently add new regex paths bypassing the refusal gate.

Phase 2 (NFA engine) — separate follow-up issue:
- New `src/codegen/regex-compile.ts` — Thompson's construction
- New `src/codegen/wasm-helpers/regex-runtime.ts` — NFA executor
  + match-array struct types
- Subset: char classes, anchors, `*`/`+`/`?`/`{n,m}`, capturing
  groups, non-greedy, flags `g`/`i`/`m`/`s`
- Excludes: backreferences, lookbehind, `\p{…}`, sticky-with-state
- Bench: 5× JS-host on `/\w+/g.exec(longText)`

---

# Summary table — landing order

| Order | Issue   | Estimated LOC | Blockers                          |
|-------|---------|---------------|-----------------------------------|
| 1     | #1470   | (PR #408)     | — (in CI)                         |
| 2     | #1471   | ~600          | #1470                             |
| 3a    | #1473   | ~160          | #1470, #1471                      |
| 3b    | #1472 A | ~150          | #1470 (parallel to #1473)         |
| 3c    | #1474 P1| ~80           | #1470 (parallel to all)           |
| 4     | #1472 B | ~2000         | #1471, #1473 (large, multi-PR)    |
| 5     | #1472 C | ~50           | #1472 B                           |
| 6     | #1474 P2| ~1500         | separate follow-up issue          |

Steps 3a/3b/3c can land in parallel. Step 4 is the long pole.

## Verification helper (build once, use four times)

Create `tests/helpers/assert-no-js-host-imports.ts`:

```ts
import { parseWasmImports } from "../utils/wasm-parse";

export function assertNoJsHostImports(
  bin: Uint8Array,
  banPatterns: RegExp[],
  allowList: string[] = []
): void {
  const imports = parseWasmImports(bin);
  const violations = imports.filter(({ module, name }) => {
    const qual = `${module}::${name}`;
    if (allowList.includes(qual)) return false;
    return banPatterns.some((p) => p.test(qual));
  });
  if (violations.length > 0) {
    throw new Error(
      `Standalone build leaked JS-host imports:\n` +
      violations.map((v) => `  ${v.module}::${v.name}`).join("\n"));
  }
}
```

Each issue's tests reuse this with its own ban-regex list.
