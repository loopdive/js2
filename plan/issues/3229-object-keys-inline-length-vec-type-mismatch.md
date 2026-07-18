---
id: 3229
title: "Object.keys/values/entries(closedStruct).length INLINE returns 0 — static-enumeration vec type (vec-of-externref) mismatches the `.length` dispatch type (vec-of-string); mode-agnostic"
status: done
assignee: ttraenkler/dev-conform
sprint: current
created: 2026-07-13
updated: 2026-07-17
completed: 2026-07-17
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: objects, property enumeration, array length
related: [3222, 786]
# (#3102) The canonical-vec resolution + per-arm coercion comments grow the
# object-ops subsystem module (the correct home for Object.keys/values/entries)
# a few LOC; the net code is a simplification (removed manual per-field boxing).
loc-budget-allow:
  - src/codegen/object-ops.ts
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

## Resolution

The static keys/values fast-paths (`compileObjectKeysOrValues` in
`src/codegen/object-ops.ts`) built a vec-of-**externref** and returned its type
index, while an inline `.length` dispatches on the CANONICAL vec type
(`resolveWasmType(returnType)` → vec-of-string / vec-of-f64). `ref.test` against
the canonical type failed on the vec-of-externref → the `.length` else-arm read
`0`. (A `const k: string[] = …` binding worked only because the store coerced
the vec to the canonical layout.)

Fix — build the fast-path vec with the CANONICAL arr/element types, coercing
each element (mirrors what the `entries` arm already did):

- Hoisted the `entries` arm's `getResolvedSignature` / `getReturnTypeOfSignature`
  resolution to the top of `compileObjectKeysOrValues` and derived the canonical
  vec (`getVecInfo`) once; `entries` now reuses it (net-zero checker growth —
  oracle-ratchet clean).
- `keys`: return the canonical `string[]` vec; push each field-name string via
  `compileStringLiteral` and `coerceType` to the vec element (host element IS
  externref → byte-identical; standalone native-string element → fixed).
- `values`: return the canonical values vec; `coerceType` each field value to the
  element type — homogeneous `number[]` stores f64 unboxed (removed the manual
  `__box_number` branches), heterogeneous `(string|number)[]` boxes to externref
  exactly as before.
- Falls back to the legacy vec-of-externref when the return type is unresolvable.

## Test Results

`tests/issue-3229.test.ts` — 20/20 pass (10 host/gc + 10 standalone): inline
`.length` for keys/values/entries === field count; keys/values/entries content
correctness; inline index reads; `keys.length` driving a for-loop; heterogeneous
`(string|number)[]` boxing; intermediate-variable regression guard.

No regressions in `object-keys-values-entries`, `issue-786`,
`issue-786-object-keys-dynamic`, `issue-3222-standalone-closed-struct-enum`
(all pass). `npx tsc --noEmit` clean; prettier clean; oracle-ratchet clean
(checker usage +0). (The one failing case in `issue-2166-objvec-element-index`
— an `any`-receiver out-of-bounds read yielding NaN vs +0 — fails identically on
the clean tree; it is a pre-existing failure orthogonal to this change.)
