---
id: 1103
title: "Wasm-native Map, Set, WeakMap, WeakSet using WasmGC structs and arrays"
status: ready
created: 2026-04-12
updated: 2026-04-12
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
language_feature: collections
goal: iterator-protocol
es_edition: ES2015
---
# #1103 — Wasm-native Map, Set, WeakMap, WeakSet

## Problem

Map, Set, WeakMap, and WeakSet are currently constructed via the JS host's `builtinCtors` table in runtime.ts (L872-897). All method calls on these types are dispatched through externref host imports. In standalone mode, there is no JS host to provide these constructors.

## Approach

Implement Map and Set as WasmGC struct-based data structures:

### Map
- **Storage**: WasmGC array of key-value pair structs
- **Hashing**: compile a hash function for each key type (number → identity, string → FNV/djb2, object → identity/address)
- **Collision resolution**: linear probing or chaining via WasmGC arrays
- **Iteration order**: maintain insertion-order linked list per ES2015 spec

### Set
- **Storage**: Map with value = key (or a simplified single-array variant)

### WeakMap / WeakSet
- Depend on WasmGC weak reference support (#1101)
- Without engine-level weak refs, can implement as strong Map/Set (conformant behavior but no GC benefit)

### Key operations to implement in Wasm
- `get`, `set`, `has`, `delete`, `clear`, `size`
- `forEach`, `keys`, `values`, `entries`, `[Symbol.iterator]`
- Constructor with optional iterable argument

## Acceptance criteria

- [ ] `new Map()` compiles in standalone mode
- [ ] `map.set(k, v)` / `map.get(k)` / `map.has(k)` / `map.delete(k)` work correctly
- [ ] Map iteration preserves insertion order per spec
- [ ] `new Set()` compiles in standalone mode with add/has/delete/size
- [ ] test262 Map/Set tests pass (target: ≥60% of basic operation tests)

## Complexity

L — each collection type is a full data structure implementation

## Related

- #1071 for-of non-array iterables (Map/Set iteration depends on this)
- #1101 WeakRef (WeakMap/WeakSet depend on weak references)
- #859 Map.forEach callback captures (existing bug)

## Implementation Plan

### Root cause

There is no Wasm-native data structure for Map/Set. Every Map/Set operation
flows through `ctx.externClasses` (`src/codegen/index.ts:6401-6474`) and is
dispatched as a host method call (`Map.prototype.get`, etc.) on an externref
provided by `builtinCtors` in `src/runtime.ts:1856-1907`. Under `--target wasi`
or a future `--standalone` mode, the JS host is unavailable and these imports
cannot be satisfied, so `new Map()` either fails to instantiate or traps the
first time a method is invoked.

This is a **large feature (~1,500-2,000 LOC across 4 PRs)** — it MUST be split
into sub-issues. Recommended split:

- **#1103a Map** — hash table + insertion-order list, 7 methods, iterators (~700 LOC)
- **#1103b Set** — wraps Map with single-column entries, 9 methods incl. set-theoretic ops (~400 LOC)
- **#1103c WeakMap** — strong-Map fallback semantics (no GC benefit) until #1101 lands (~250 LOC)
- **#1103d WeakSet** — wraps WeakMap, 3 methods (~150 LOC)

Each sub-issue must be a single mergeable PR. #1103a is the foundation; b/c/d
depend on it.

### Design overview (V8/SpiderMonkey-style ordered hash table)

Two structures cooperate:

1. **Entries vector** — insertion-ordered array of `(key, value, next-in-bucket, hash)` records.
   This is what iterators walk. Deletion tombstones a slot (sets a "deleted"
   bit on `hash`) but does not remove it, preserving iterator stability per
   spec (24.1.1.7 `Map.prototype.forEach` + 24.1.5 iterator algorithms).
2. **Bucket array (hash table)** — `i32` array indexed by `hash & (cap-1)`,
   storing the index of the first entry in the chain. Each entry's `next`
   field continues the chain.

Iteration order = entries-vector order. Lookup = O(1) via bucket array.
Rehash triggers when load factor > 0.75 OR `liveCount < entries.length / 2`
(compacts tombstones).

```
$MapEntry struct:
  field $key      (mut anyref)    ;; tombstoned key replaced with ref.null
  field $value    (mut anyref)    ;; ditto
  field $next     (mut i32)       ;; index of next entry in same bucket, -1 = end
  field $hash     (mut i32)       ;; top bit = deleted flag; low 31 bits = key hash

$MapEntries (array (mut (ref null $MapEntry)))   ;; growable: copy-on-grow

$Map struct:
  field $buckets    (mut (ref $BucketArray))   ;; (array (mut i32)), power-of-2 length
  field $entries    (mut (ref $MapEntries))
  field $entryCount (mut i32)                  ;; total slots used (incl. tombstones)
  field $liveCount  (mut i32)                  ;; size as exposed by .size

$BucketArray (array (mut i32))
```

### Key hashing & equality (SameValueZero per spec 7.2.10)

Hash and equality must dispatch on key type without `instanceof` (no host).
The compiler emits a single polymorphic hash helper that handles all anyref
flavours:

| Key type           | Hash                                              | Equality                          |
|--------------------|---------------------------------------------------|-----------------------------------|
| `f64`              | bitcast to i64, fold halves, then mix             | `f64.eq`, with `NaN===NaN` per SameValueZero |
| `i32` (small int)  | identity (Wang mix optional)                      | `i32.eq`                          |
| `ref $AnyString`   | walk code units, FNV-1a 32-bit                    | `__str_equals` (existing)         |
| `bool`             | 0 or 1                                            | `i32.eq`                          |
| `null` / `undefined` | reserved sentinels (-1, -2)                     | `ref.eq` on sentinel globals      |
| object (ref any)   | identity hash from a hidden struct field          | `ref.eq`                          |

The "identity hash on objects" needs a one-shot lazy hash. Use a global
counter `$__obj_hash_seed` (i32) bumped on first `Object.identityHash(o)`
call, stored in a per-struct hidden field `$__obj_hash` added to every
user struct type at codegen time (zero = unhashed, sentinel `0x80000000`
for the rare zero-hash collision).

### Wasm function signatures (all in a new `src/codegen/map-runtime.ts`)

```wat
;; Construction
(func $__map_new          (result (ref $Map)))
(func $__map_new_from_arr (param (ref $JsArr)) (result (ref $Map)))  ;; new Map(iterable)

;; Hashing — emitted ONCE per compile, dispatches on rtt
(func $__hash_anyref      (param anyref) (result i32))
(func $__same_value_zero  (param anyref) (param anyref) (result i32))

;; Bucket math
(func $__bucket_for_hash  (param i32 i32) (result i32))  ;; (hash, capMask)
(func $__map_lookup_idx   (param (ref $Map)) (param anyref) (result i32))  ;; -1 if absent

;; Methods (signatures mirror the ESnative externClass entries at index.ts:6413)
(func $__map_get          (param (ref $Map)) (param anyref) (result anyref))
(func $__map_set          (param (ref $Map)) (param anyref) (param anyref) (result (ref $Map)))
(func $__map_has          (param (ref $Map)) (param anyref) (result i32))
(func $__map_delete       (param (ref $Map)) (param anyref) (result i32))
(func $__map_clear        (param (ref $Map)))
(func $__map_size         (param (ref $Map)) (result i32))
(func $__map_get_or_insert          (param (ref $Map)) (param anyref) (param anyref) (result anyref))
(func $__map_get_or_insert_computed (param (ref $Map)) (param anyref) (param funcref) (result anyref))

;; Rehash / compact (internal)
(func $__map_grow_rehash  (param (ref $Map)) (param i32))   ;; (map, newCap)

;; Iterator
(func $__map_iter_new     (param (ref $Map)) (param i32) (result (ref $MapIter)))  ;; kind: 0=key,1=val,2=entry
(func $__map_iter_next    (param (ref $MapIter)) (result (ref $IterResult)))
```

### Changes

**File: `src/codegen/map-runtime.ts` (NEW, ~700 LOC for #1103a)**
- Register struct types `$Map`, `$MapEntry`, `$MapEntries`, `$BucketArray`, `$MapIter`,
  `$IterResult` in `ensureMapRuntimeTypes(ctx)`. Store type indices on `ctx`
  (`ctx.mapTypeIdx`, `ctx.mapEntryTypeIdx`, etc.) — mirror the pattern in
  `ensureNativeStringHelpers` at `src/codegen/native-strings.ts:85-180`.
- Emit hash/eq/lookup/method/iterator functions lazily via
  `ensureMapHelpers(ctx)`. Cache funcIdx in `ctx.mapHelpers: Map<string, number>`
  (mirror `ctx.nativeStrHelpers`).
- **MUST register imports before functions** (per the addUnionImports hazard
  in CLAUDE.md). Call `ensureMapHelpers` from `compileStringLiterals`-equivalent
  early in `compile()`.

**File: `src/codegen/context/types.ts` (~line 487)**
- Add fields to `CodegenContext`:
  ```ts
  mapTypeIdx: number;             // -1 until ensureMapRuntimeTypes runs
  mapEntryTypeIdx: number;
  mapEntriesTypeIdx: number;
  mapBucketsTypeIdx: number;
  mapIterTypeIdx: number;
  iterResultTypeIdx: number;
  mapHelpers: Map<string, number>;
  mapHelpersEmitted: boolean;
  objHashFieldIdx: number;        // index of hidden $__obj_hash field on user structs
  ```

**File: `src/codegen/index.ts` (line ~6411)**
- Inside `if (!ctx.externClasses.has("Map"))`, gate on `ctx.nativeStrings` (or
  add `ctx.standalone` flag, same as nativeStrings auto-enables for wasi):
  - When `ctx.nativeStrings` is true → DO NOT register the externClass entry.
    Instead, route `new Map(...)` and method dispatch through map-runtime.
  - When false → keep the existing externClass path (host bridge) unchanged.
- Mirror the gating at line ~6429 for Set, ~6451 for WeakMap, ~6468 for WeakSet.

**File: `src/codegen/expressions/calls.ts` (~line 124, near `"Map"` in `extern` set)**
- Add a pre-check in the `new <className>(...)` lowering: if className is
  `"Map"` / `"Set"` / `"WeakMap"` / `"WeakSet"` AND `ctx.nativeStrings` is on,
  call `ensureMapHelpers(ctx)` and emit `call $__map_new_from_arr` (or
  `__map_new` with no-arg form) instead of `__new_Map(extern)`. Single-arg
  iterable: compile expression, coerce to a vec-style anyref array, pass to
  `__map_new_from_arr`. Mirrors how `__new_Promise` is currently routed.

**File: `src/codegen/property-access.ts` (~line 1138 and 1477)**
- In the Map/Set method dispatch path, branch on `ctx.nativeStrings`:
  - native path → look up `ctx.mapHelpers.get(__map_${method})!` and emit a
    direct `call funcIdx`
  - host path → unchanged (existing externClass method-import dispatch)

**File: `src/codegen/builtin-tags.ts` (~line 193)**
- Map already listed; add a brand tag so `typeof m === "object"` and
  `Object.prototype.toString.call(m) === "[object Map]"` work without host.
  Reuse the BUILTIN_TAG scheme already in place (see how Promise's tag is
  emitted as a hidden field). Tag values: `MAP=12`, `SET=13`, `WEAKMAP=14`,
  `WEAKSET=15` (pick next free).

**File: `src/codegen/literals.ts` (Object struct registration site)**
- Add the hidden `$__obj_hash (mut i32)` field to every user struct that may
  be used as a Map key. Cheapest place: append it as the LAST field in the
  struct schema right before `struct.new` emission. Updates `ctx.objHashFieldIdx`
  to the field index in any given struct (it's the last index — keep a
  per-type map).
- Initialize to `0` in `struct.new`/`struct.new_default`. Lazy population:
  `__hash_anyref` reads the field, if zero, mints a fresh hash from
  `$__obj_hash_seed` (global i32, bumped by 0x9E3779B9 — golden ratio mix)
  and writes it back.

### Iterator protocol (#1071 dependency)

The for-of lowering at `src/codegen/statements.ts` / `statements/loops.ts`
must learn to recognise `ref $Map`/`ref $Set` as iterables and route to
`__map_iter_new` + `__map_iter_next`. The IterResult struct must match what
for-of consumes (`{ done: i32, value: anyref }`) — re-use the array iterator's
struct if it exists in `array-methods.ts`, otherwise define
`$IterResult { value (mut anyref); done (mut i32) }` and share it.

`map.entries()`, `map.keys()`, `map.values()`, and `map[Symbol.iterator]` all
return a `$MapIter`. `iterKind` int discriminates: 0=keys, 1=values, 2=entries.

`forEach(cb)` is a direct loop over `entries`, calling `cb(value, key, map)`
via `call_ref`. Closure captures fix from #859 applies here unchanged.

### Sub-issue split & dependencies

```
#1103a Map (foundation)
   ├─ #1103b Set     (depends on 1103a — Set wraps a Map with key === value)
   ├─ #1103c WeakMap (depends on 1103a — strong-Map fallback until #1101 lands)
   └─ #1103d WeakSet (depends on 1103c)
```

**#1103a Map**: types + hash + 7 methods + iterators. Target: ~700 LOC, single PR.

**#1103b Set**:
- Reuses `$Map` (value field = key, ignored) OR a slimmer `$Set` struct without
  the value field. Recommendation: slimmer `$Set` — code duplication is small
  and saves one anyref slot per entry × N entries.
- Methods: `add, has, delete, clear, size, forEach, values, keys, entries,
  [Symbol.iterator], union, intersection, difference, symmetricDifference,
  isSubsetOf, isSupersetOf, isDisjointFrom` (per index.ts:6381-6408).
- Set-theoretic operations (intersection etc.) iterate one set and probe the
  other — straight-line code in `__set_intersection(a, b)`.

**#1103c WeakMap**:
- Without engine-level WeakRef (#1101), implement as a strong Map. Document
  this in the issue: standalone-mode WeakMap leaks memory but is
  *behaviourally* spec-conformant for non-GC-observable programs.
- Only obj keys allowed — throw TypeError on non-object key (mirror runtime.ts
  `_canBeWeakKey` at line 287).
- Methods: `get, set, has, delete, getOrInsert, getOrInsertComputed`.
- No iteration, no .size — these don't exist on the spec interface.

**#1103d WeakSet**: trivial wrapper over #1103c (`add` = `set(k, true)`).

### Wasm IR pattern — Map.set hot path

```wat
;; map.set(key, value)
local.get $map
local.get $key
call $__hash_anyref                  ;; -> i32 hash
local.tee $hash
local.get $map
struct.get $Map $buckets
array.len                            ;; capacity
i32.const 1
i32.sub
i32.and                              ;; bucket = hash & (cap-1)
local.set $bucket

;; chase chain looking for existing key
local.get $map
struct.get $Map $buckets
local.get $bucket
array.get $BucketArray               ;; entryIdx
local.set $cur
(loop $chain
  local.get $cur
  i32.const 0
  i32.lt_s
  br_if $miss
  ;; ... call $__same_value_zero on stored key
  ;; if equal: overwrite value, return map
  ;; else: cur = entry.next; br $chain
)
$miss:
;; allocate new entry, append to entries vector, link bucket head
;; bump liveCount; if liveCount > buckets.len * 3 / 4 → call $__map_grow_rehash
```

### Edge cases

- **NaN key**: SameValueZero treats NaN===NaN (24.1.1.7 step 1). `f64.eq` on
  NaN returns 0, so the hash helper must short-circuit: if `is_nan(f64)`
  produce a canonical NaN hash (e.g. 0x7FC00000) and use `f64.ne` followed by
  `i32.eqz` (or a bitcast equality) for equality.
- **+0 / -0**: SameValueZero treats them equal; bitcast equality would say
  no. Normalize: if `f64 == 0`, hash as `+0`.
- **String key already-flat vs cons**: `__hash_anyref` must call
  `__str_flatten` before hashing (same fix used by `__str_equals`).
- **Rehash during forEach**: spec requires iteration over insertion-order
  entries; deletions during iteration must skip tombstones; insertions during
  iteration MUST be visited (see test262 `Map/prototype/forEach/iterates-added-entries`).
  The `entries` vector grows monotonically (compact only outside iteration);
  the iterator just advances its index and skips tombstones — that's why
  tombstones-in-entries matters more than packing.
- **`new Map(iterable)`** where iterable is a generator: requires #1071. For
  the initial #1103a, accept only `JsArr`/`vec` of `[k, v]` pairs and throw
  TypeError otherwise. Full iterable support lands when #1071 closes.
- **Map.set chaining**: returns `this` per spec — currently the externClass
  signature returns externref. The native helper must return `(ref $Map)` of
  the same map; codegen at the call site must use the result for chained
  `.set(a,1).set(b,2)`.

### Regression gate

- All existing equiv tests that use Map/Set (`tests/equivalence.test.ts` —
  grep for `new Map\|new Set\|new WeakMap`) must still pass.
- New tests in `.tmp/standalone-map-*.ts` exercising each method with
  `--target wasi` so the JS host is unavailable. Verify under wasmtime via
  `pnpm run build:wasi-tests`.
- Test262 buckets to monitor:
  - `built-ins/Map/**`
  - `built-ins/Set/**`
  - `built-ins/WeakMap/**`
  - `built-ins/WeakSet/**`
  Target after #1103a–d: lift Map/Set conformance buckets out of "100% CE" into
  the high-pass region. No regression in JS-host mode (the native path is
  gated on `nativeStrings`).

### Estimate

- #1103a Map: ~700 LOC (map-runtime.ts ~550 + context/index/property-access wiring ~150)
- #1103b Set: ~400 LOC
- #1103c WeakMap: ~250 LOC
- #1103d WeakSet: ~150 LOC
- **Total: ~1,500 LOC across 4 PRs.** Single-PR is rejected — split required.
