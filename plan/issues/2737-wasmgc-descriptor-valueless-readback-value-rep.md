---
id: 2737
title: "WasmGC-struct property descriptor read-back: a value-less data descriptor reads `value` as null (not undefined) and booleans as 0/1 (value-representation substrate)"
status: ready
sprint: Backlog
created: 2026-06-27
priority: medium
feasibility: hard
model: fable
reasoning_effort: high
task_type: bug
area: codegen/runtime
es_edition: 5
language_feature: property-descriptors, value-representation
goal: es5
related: [2680, 2106, 2712, 2668, 1629]
parent: 2671
---
# #2737 — WasmGC-struct descriptor read-back drops `undefined`/boolean value representation

**Carved from #2680** (dev2, 2026-06-27) as the orthogonal value-representation
substrate gap surfaced while implementing the ToPropertyDescriptor proto-walk.
This is **NOT a clean dev fix** — it is the `undefined`/boolean VALUE
representation substrate, coupled to #2106 (undefined-observability,
`UNDEF_F64` sentinel) and #2712 (real `bool` ValType).

## Problem A — value-less data descriptor reads `value` back as `null`, not `undefined`

`Object.defineProperty(obj, key, { configurable: false })` on a **WasmGC-struct**
`obj` stores the data property with `value` defaulting to `undefined`
(`_sidecarSet(obj, key, undefined)` in `__defineProperty_desc`), but
`Object.getOwnPropertyDescriptor(obj, key).value` reads back as **`null`**, not
`undefined`.

**Verified (dev2, control-isolated):** the divergence reproduces with a *plain
own* descriptor — **no prototype / no #2680 path involved** — so it is a generic
sidecar `undefined → null` read-back representation gap, not specific to #2680:

```
// CONTROL (no proto, no fnctor link):
const obj: any = {};                                   // wasmGC struct
Object.defineProperty(obj, "p", { configurable: false } as any);
const d = Object.getOwnPropertyDescriptor(obj, "p");
// d.value === undefined  → FALSE  (d.value is null)   ← bug
// d.configurable === false → TRUE (boolean read-back of false is fine via === )
```

Impact: any test262 `built-ins/Object/defineProperty/...` case whose
`verifyProperty(obj, prop, { value: undefined, ... })` checks `value === undefined`
on a value-less descriptor fails on the value assertion even when every other
attribute is correct. This caps how many of the #2680 cited
`15.2.3.6-3-*` proto-inherited tests flip green end-to-end (the inherited
`configurable`/`enumerable`/`writable` reads — the #2680 core fix — ARE correct;
this is the residual on the value-less ones).

## Problem B — boolean attribute marshalling reads back as `0`/`1` in some `any` contexts

A descriptor's boolean attribute (`configurable`/`enumerable`/`writable`),
read back from a WasmGC-struct `obj` through an `any`-typed access, can surface as
the integer `0`/`1` rather than `false`/`true` in some marshalling paths
(observed via `String(d.configurable) === "0"` for `false`). Strict
`=== false`/`=== true` comparisons *inside* compiled code happened to hold in the
#2680 probes, but the representation is not uniformly a JS boolean across the
externref boundary. This is the same family as #2712 (introduce a real `bool`
ValType; retire the optional i32 boolean brand).

## Problem C (related, separate) — plural `Object.defineProperties` dynamic descriptor-MAP representation

A descriptor **map** with a dynamic (externref) per-property value — e.g.
`Object.defineProperties(obj, { k: child })` where `child` is a runtime object —
does **not** compile to a WasmGC struct, so it routes through a native
`Object.defineProperties` fallback rather than the wasm-struct descriptor reader.
Consequently the #2680 proto-walk (which is present and symmetric in the plural
reader) never fires for that map shape, and a wasm-struct-valued descriptor entry
is read by native `Object.defineProperties` (which cannot see its
sidecar/typed-field attributes). This is a **descriptor-map representation** gap,
distinct from Problems A/B (which are value-representation). Tracked here so it is
not lost; the #2680 plural-path test is `it.skip`'d pointing at this.

## Why substrate (not a clean dev fix)

- Problem A is the `undefined` observability substrate (#2106): the runtime
  cannot currently round-trip a stored `undefined` data value distinctly from
  `null` across the WasmGC-struct sidecar / descriptor read-back. The fix belongs
  with the `UNDEF_F64`/undefined-singleton work, not a local descriptor patch.
- Problem B is the boolean-ValType substrate (#2712).
- Problem C is a descriptor-map lowering decision (when does an object literal
  with dynamic values become a wasm struct vs a host object), coupled to the
  open-object runtime.

## Acceptance criteria

- A value-less data descriptor on a WasmGC-struct object reads `value` back as
  `undefined` (not `null`); booleans read back as JS booleans.
- The value-less proto-inherited `15.2.3.6-3-*` cases (the residual after #2680)
  pass end-to-end.
- (Problem C, optionally separable) the plural `Object.defineProperties`
  dynamic descriptor-map path reaches the wasm-struct reader so the #2680
  proto-walk applies; re-enable the `it.skip` in `tests/issue-2680.test.ts`.
- Validate on the full `merge_group` floor (descriptor surface, auto-park-prone).

## Notes
- Carved from #2680 (PR #2168). The #2680 reader fix is correct and lands
  independently; this issue is the value-representation residual it exposed.
