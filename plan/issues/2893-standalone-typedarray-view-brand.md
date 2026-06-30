---
id: 2893
title: "Standalone: distinct %TypedArray% view brand (unblocks #2872 reflective getter/method bodies)"
status: ready
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2872, 2375, 2593, 2651, 2885, 2876]
umbrella: 2860
blocks: [2872]
---

# Standalone: distinct %TypedArray% view brand

## Why this exists (root cause, traced 2026-06-30)

The #2885 gOPD builtin-proto accessor synthesis + #2876 reflective `.call`
recovery are the standalone reflection **machinery** (both merged). They light up
the reflective surfaces (`gOPD(Proto, m).get`, `desc.get.call(R)`, plain reads)
**for free** for any brand whose getter/method `emitMemberBody` produces a real
body — proven for RegExp (#2876: 28→47 accessor passes).

For `%TypedArray%`/view (#2872), the glue (`makeTypedArrayGlue`,
`array-object-proto.ts:696`) advertises the four accessor getters
(`buffer`/`byteLength`/`byteOffset`/`length`) but its `emitMemberBody` is
`emitProtoMemberBodyRefusal` for **every** member — so the closure factory returns
null and both the gOPD synthesis and the reflective `.call` fall through (verified:
`gOPD(Uint8Array.prototype, "byteLength")` still → `undefined`). The clusters'
remaining bulk is the native member **bodies**, not glue.

**The blocker for those bodies is a representation gap, not a coding slice.** A
reflective getter receives `this` as an opaque `externref`, so its body must
brand-check "is this a `%TypedArray%` view?" at runtime (RequireInternalSlot
[[TypedArrayName]], §23.2.3.x step 2 — **throw TypeError otherwise**). But in the
standalone WasmGC representation a TypedArray view, a plain `number[]`, and (per
storage key) an ArrayBuffer **share the same `$Vec` struct type with no
distinguishing brand/tag**. The codebase states this directly:

> `index.ts` (~#1700): "The Wasm signature for `Uint8Array` and `number[]` is
> identical (`(ref null $Vec[f64])`)."

So an opaque `$Vec[f64]` could be a `Float64Array`, a `Float32Array`, **or** a
plain `number[]`. The `length`/`byteLength`/… getters cannot satisfy the
spec's throw-for-non-view requirement — they can't tell a view from an array.
`#2375` already cautions against re-emitting a body that touches the view's vec
state off the proto; this is the underlying reason.

Even `length` (the most _uniform_ getter — element count is `$Vec` field 0
regardless of element width) is gated on this: the field read is trivial, the
**brand check is the wall**.

## What's actually needed

A **distinct runtime brand for TypedArray views** so an opaque `externref` can be
classified as "a view of constructor X" (or "not a view") at runtime — without it,
none of the §23.2.3 accessor getters (nor the per-method `RequireInternalSlot`
checks) can be implemented reflectively. Options to weigh (coordinate with #2593's
packed-storage migration and #2375):

1. **Tag field on the view `$Vec`** — add a small brand/elem-kind tag field to the
   view struct (or a view-wrapper struct around the backing vec). Lets a runtime
   `__is_typed_array_view(externref) -> i32` + `__view_elem_kind` drive the brand
   check + per-constructor `BYTES_PER_ELEMENT`. Touches every TA construction +
   element read/write site → must pair with #2593.
2. **Distinct view struct subtype per element kind** — separate nominal types for
   `Int8Array`…`Float64Array` views (subtypes of the backing vec), so `ref.test`
   against the view-type set classifies it and disjoint from plain-array vec types.
   Cleaner brand check; larger type-graph + construction churn.

Either is a **representation change** spanning #2593/#2375, not a getter-body PR.

## Once landed (the payoff)

With a view brand, the §23.2.3 getter bodies become straightforward (brand-check →
read field / compute byteLength = count × BYTES_PER_ELEMENT → throw on non-view),
and the #2885 + #2876 machinery then flips the #2872 reflective-accessor subset
(`this-val-*`, `prop-desc` accessor reads, `desc.get.call(view)`) **for free** —
mirroring the RegExp result. The `verifyProperty`/`*.name` subset additionally
needs lever-2 (dynamic `.name`/`.length` on the opaque closure via
`nativeClosureMeta` by funcref identity) + mutable property-descriptor semantics;
track those separately.

## Acceptance

- A runtime classifier distinguishes a `%TypedArray%` view from a plain array /
  ArrayBuffer for an opaque `externref` (standalone).
- The four §23.2.3 accessor getter bodies implemented on it (start with `length`
  to validate the recovery shape, then `byteLength`/`byteOffset`/`buffer`).
- `gOPD(<View>.prototype, "byteLength")` host-free (`result.imports` empty);
  `get.call(view)` returns the value, `get.call(<non-view>)` throws TypeError.
- Verify-first standalone; full `merge_group` + standalone high-water; 0 regressions.

## Notes

Filed after #2876 landed the reflective `.call` lever. The "#2872 just needs
per-cluster glue" framing was optimistic — the glue is gated on this representation
work. #2872 stays `blocked_on: 2893`.
