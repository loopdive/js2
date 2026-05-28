---
id: 1629
title: "spec gap: Object.defineProperty — descriptor attribute fidelity (664 test262 fails, biggest single bucket)"
status: ready
created: 2026-05-08
updated: 2026-05-24
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: 56
renumbered_from: 1335
parent: 1328
---
# #1335 — Object.defineProperty: descriptor attribute fidelity

## Problem

`built-ins/Object/defineProperty` test262 bucket is the single largest fail bucket in the
audit: **467 / 1131 pass (41.3%) — 664 fails (600 assertion_fail, 32 other, 16 runtime_error,
7 type_error, 5 wasm_compile)**.

Spec §10.1.6 (OrdinaryDefineOwnProperty) and §20.1.2.4 (Object.defineProperty) require:

1. **Property attributes** (`writable`, `configurable`, `enumerable`) tracked **per property**.
2. **Accessor properties** (`get`/`set`) stored separately from data properties.
3. **Type-checking** the descriptor — non-object descriptors throw TypeError.
4. **Validating** descriptor invariants: a non-configurable property cannot become configurable,
   non-writable cannot become writable, the descriptor type cannot flip from data to accessor, etc.
5. **Coalescing** missing descriptor fields with defaults (writable/configurable/enumerable default
   to false; data-descriptor `value` defaults to undefined).

The current js2wasm implementation in `src/codegen/object-ops.ts` and `src/runtime.ts`:
- Sets the field value but **does not record the attribute flags** for typed structs.
- Only the externref/host path retains attributes (it forwards to host `Object.defineProperty`).
- For typed (struct-backed) objects, redefining a non-configurable property silently succeeds.

## Acceptance criteria

1. `built-ins/Object/defineProperty/15.2.3.6-3-*` (descriptor coalescing) tests pass.
2. `built-ins/Object/defineProperty/15.2.3.6-4-*` (configurable invariants) tests pass.
3. `built-ins/Object/defineProperty/15.2.3.6-5-*` (writable invariants) tests pass.
4. Pass-rate for `built-ins/Object/defineProperty` rises from 41.3% to ≥75%.
5. Object.defineProperties and Object.create(o, descriptors) inherit the fix.

## Files to modify

- `src/codegen/object-ops.ts` — descriptor compilation, attribute storage
- `src/codegen/property-access.ts` — attribute checks on get/set/delete
- `src/runtime.ts` — runtime helpers for typed-object descriptor table

## Implementation Plan

### Root cause

Typed (WasmGC struct) objects have no attribute storage — every property is implicitly
`{writable:true, configurable:true, enumerable:true}`. The descriptor passed to
`Object.defineProperty` is parsed for its `value` but the attribute bits are dropped on the floor.

### Approach

Add a parallel attribute-table struct to typed objects:

```
(type $AttrEntry (struct (field $key (ref string)) (field $flags i32)))
;; flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable, bit 3 = isAccessor
(type $AttrTable (array (mut (ref null $AttrEntry))))
;; Object struct gains an extra (mut (ref null $AttrTable)) — null means "all defaults".
```

When `Object.defineProperty` is called:
1. Parse the descriptor (a JS object) into `(value, flags)` pairs at compile time when possible,
   or at runtime via `__parse_descriptor` host import.
2. Lazily allocate `$AttrTable` on first non-default-attribute write.
3. On subsequent writes, look up by key and validate invariants.

### Edge cases

- Descriptor is null/undefined → TypeError at the call site.
- Descriptor has both `value` and `get` → TypeError (data + accessor mix).
- Descriptor argument is a Proxy → must trap on `[[Get]]` for each known key.
- Property already non-configurable → reject incompatible redefinition (return false in
  Reflect.defineProperty / throw in Object.defineProperty).

### Test262 sample

- `test262/test/built-ins/Object/defineProperty/15.2.3.6-1-1.js` (undefined → TypeError)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-3-1.js` (default attribute coalescing)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-4-82.js` (non-configurable invariants)

## Investigation (2026-05-27, dev-1607)

Authoritative baseline (`.test262-cache/test262-current.jsonl`, HEAD 1f9ada252):
**502 pass / 624 fail / 5 compile_error** in `built-ins/Object/defineProperty`.

Fail clusters by filename prefix:

| cluster        | fails | notes |
|----------------|-------|-------|
| `15.2.3.6-4-*` | 436   | step-4 [[DefineOwnProperty]] semantics |
| `15.2.3.6-3-*` | 173   | ToPropertyDescriptor / coalescing |
| `15.2.3.6-2-*` | 8     | property-key coercion |
| misc           | ~7    | symbol/typedarray/coerced-P/etc. |

Within c4 (431 sampled): **188 function-involving, 133 array-involving, 83 plain-object**.
The bulk target **Array / bound-Function exotic objects** (length/index semantics,
accessor-on-array), which are host-backed externrefs — a separate problem from the
issue's stated "typed-struct attribute table" plan.

### Root cause confirmed for the plain-object + dynamic-descriptor subset

`Object.defineProperty` is **compile-time inlined** in `src/codegen/object-ops.ts`
(`compileObjectDefineProperty`); no `__defineProperty_*` import is emitted for the
common cases. All descriptor analysis (value / get / set / writable / enumerable /
configurable extraction, the data+accessor-mix TypeError at line 736, struct-field
attribute storage) is guarded by `if (ts.isObjectLiteralExpression(descArg))`.

When the descriptor is passed as a **variable** (e.g. `var desc = {get, value};
Object.defineProperty(o, "foo", desc)` — the dominant c3 shape), NONE of that fires:
- `valueExpr`/`getNode`/`descWritable`/… are all `undefined`,
- the data+accessor-mix check sees `hasData=false, hasAccessor=false` → no throw,
- it falls to the `else` branch → `emitExternDefinePropertyNoValue`, which emits
  `__defineProperty_value(obj, prop, null, flags)` with statically-empty flags and
  **never passes the real descriptor's value/get/set to the runtime**. No validation,
  no storage. Reproduced: variable-descriptor `{get,value}` mix returns 0 (no throw);
  test262 expects TypeError.

Separately, even for the inline-literal plain-object path,
`Object.getOwnPropertyDescriptor(o,"foo").writable` returns the default `true` for a
brand-new (non-struct-field) property defined via `defineProperty({value:101})` — the
flags are stored in `ctx.definedPropertyFlags` / sidecar but `shapePropFlags` is only
updated when the prop is an existing struct field (`userIdx >= 0`), so descriptor
read-back misses them. (4-17 family.)

### Why there is no small fix

Routing the dynamic-descriptor case to the existing-but-dead runtime
`__defineProperty_desc(obj, prop, desc)` (runtime.ts:4045) does NOT work as-is: the
descriptor object is itself a WasmGC struct, and that helper's `getField` reads struct
descriptors via `_sidecarGet`, which returns `undefined` for real struct fields (`get`/
`value` live as `__sget_*` exports, not sidecar). So the runtime cannot read an opaque
struct descriptor's fields. A correct fix needs either (a) materializing the descriptor
struct into a JS object before the runtime call, or (b) teaching `getField` to read
struct fields through the exported getters. Both are non-trivial.

**Conclusion:** the 624 fails do not reduce to one localized patch. The biggest sub-clusters
(Array/Function exotic defineProperty) are a distinct workstream; the plain-object subset
needs the attribute-table + struct-descriptor-read design in the Implementation Plan above.
Recommend splitting into sub-issues:
- **#1629a** — dynamic (non-literal) descriptor: materialize struct descriptor → route to
  runtime `__defineProperty_desc` with working field reads (covers most of c3, ~150).
- **#1629b** — `getOwnPropertyDescriptor` attribute read-back for non-struct-field
  defined props on plain objects (4-17 family).
- **#1629c** — Array/Function exotic defineProperty semantics (the 321 array/function c4
  fails) — likely overlaps #1130.

No code change landed under this task; needs architect spec before implementation.

## Partial fix #1629b (2026-05-28)

Sub-cluster fixed: `Object.getOwnPropertyDescriptor` attribute readback
for plain-object struct fields that were redefined via
`Object.defineProperty`. Root cause: the GOPD fast path in
`src/codegen/expressions/calls.ts` reads `ctx.shapePropFlags`, but that
table is built via `buildShapePropFlagsTable` *after* body compilation
finishes — so per-variable updates recorded during codegen
(`definedPropertyFlags`, keyed `varName:propName`) are overwritten with
defaults. The defineProperty path's attempt to update `shapePropFlags`
inline (object-ops.ts:1133-1137) is a no-op when the table has not yet
been created.

Fix: GOPD fast path now consults `ctx.definedPropertyFlags` first when
arg0 is an identifier, falling back to the shape table. Tests:
`tests/issue-1629b.test.ts` (4 cases: writable/enumerable/configurable
overrides + default preservation, all green). Does not address
sub-clusters #1629a (dynamic descriptor) or #1629c (Array/Function
exotic) — those remain open.
