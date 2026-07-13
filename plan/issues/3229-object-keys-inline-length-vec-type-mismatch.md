---
id: 3229
title: "Object.keys/values/entries(closedStruct).length INLINE returns 0 — static-enumeration vec type (vec-of-externref) mismatches the `.length` dispatch type (vec-of-string); mode-agnostic"
status: ready
sprint: Backlog
created: 2026-07-13
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: objects, property enumeration, array length
related: [3222, 786]
---

# #3229 — `Object.keys(o).length` INLINE returns 0 (vec-type mismatch)

## Problem (verified on current main, BOTH host and standalone)

When `Object.keys` / `Object.values` / `Object.entries` is called on a
statically-typed CLOSED-shape struct (a typed local / typed object), and the
result's `.length` is read **inline** on the call expression, it returns `0`
instead of the field count:

```ts
type P = { a: number; b: number; c: number };
export function f(): number {
  const o: P = { a: 1, b: 2, c: 3 };
  return Object.keys(o).length; // → 0   (should be 3)
}
```

Assigning to a variable first works:

```ts
const k = Object.keys(o);
return k.length; // → 3   (correct)
```

This is **mode-agnostic** — it reproduces in the default host/gc lanes as well
as standalone, so it is NOT a standalone-substrate gap. It was discovered while
implementing #3222 C1 (standalone closed-struct enumeration) and deliberately
left out of that slice to keep C1 host/gc byte-identical.

Note: the pure object-literal form `Object.keys({a:1,b:2,c:3}).length` returns
`3` — a bare literal compiles to an open `$Object`, so `Object.keys` takes the
runtime `__object_keys` path and returns `{kind: externref}` (a real array),
whose `.length` works. The bug is specific to the **compile-time struct
fast-path** (`compileObjectKeysOrValues` in `src/codegen/object-ops.ts`), which
resolves a static struct name and emits the field list directly.

## Root cause (WAT-confirmed)

The static `keys` fast-path builds and returns a vec of **externref** elements:

```
array.new_fixed <arrType> 3      ;; 3 field-name strings
i32.const 3                      ;; length
struct.new <vecTypeIdx>          ;; vecTypeIdx = getOrRegisterVecType(ctx, "externref")  → e.g. type 2
```

and returns `{ kind: "ref_null", typeIdx: <vec-of-externref> }`.

But the `.length` member access dispatches on the canonical `string[]` vec type
(vec-of-**string**, e.g. type 34 — what `resolveWasmType(string[])` produces):

```
local.tee <tmp>
ref.test (ref 34)                ;; the emitted vec is type 2, NOT a subtype of 34
(if (result f64)
  (then ... ref.cast (ref 34); struct.get 34 0 ...)   ;; length field
  (else f64.const 0))            ;; ← taken → returns 0
```

`ref.test (ref 34)` fails because the returned vec-of-externref (type 2) is not
the vec-of-string type (34), so the `else` arm yields `0`. The variable case
works because the `const k: string[]` binding **coerces** the vec-of-externref
to the canonical vec-of-string on store, so `k.length` reads the right layout.

## Fix direction

Make the static `keys`/`values`/`entries` fast-path return the **canonical vec
type** for the call's TS return type (resolve via `resolveWasmType` on the
signature's return type, as the `entries` arm already does for its tuple vec),
so an inline `.length` dispatch matches. Alternatively, coerce the built vec to
the canonical type before returning.

**Caution — this changes host/gc emitted bytes** (the returned type index
changes across ~244 `Object.keys` test files). It is a correctness fix, not a
standalone-gated feature, so validate it on the FULL CI matrix (not just the
standalone floor) and check for host regressions. That is exactly why it was
scoped OUT of #3222 C1 (which is NET≥0 by construction via host/gc
byte-identity).

## Repro / acceptance

- `Object.keys(typedLocal).length` inline === field count (host + standalone).
- Same for `Object.values(...).length` and `Object.entries(...).length`.
- No host/gc test262 regression (full-CI validation).
