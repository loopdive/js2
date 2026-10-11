---
id: 6500
title: "compile-time kill: `<PackedTypedArray>.reverse()` leaks a packed storage type into a local and fails binary emit"
status: done
sprint: current
created: 2026-09-17
updated: 2026-09-17
completed: 2026-09-17
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
related: [1645, 5961]
# 2026-09-17 (#6500): +5 lines in the `array-methods.ts` god-file. The fix itself
# is two lines — a widened swap-slot type — and lives inside `compileArrayReverse`,
# which is the only function that can allocate that local; there is no subsystem
# module to move it to without relocating the whole method lowering. The other
# three lines are the comment explaining why the slot must track the LOAD op and
# not the storage type, which is exactly the invariant that was violated. An
# earlier draft cost +11 and was trimmed to this.
loc-budget-allow:
  - src/codegen/array-methods.ts
---

# `<PackedTypedArray>.reverse()` kills the module at compile time

One line reproduces it, on `main` @ `f5506015f9`:

```ts
export function probe(): number { const ta = new Uint8Array(8); ta.reverse(); return 1; }
```

```
Binary emit error: encodeValType: packed storage type "i8" is not valid in a
value position (only struct fields / array elements) — a packed type leaked
into a param/result/local/global
```

Nothing in the module runs — this is a **compile-time kill**, not a wrong
answer, so it takes out every other function in the same program.

## Measured surface

Two conditions, both required:

| condition | detail |
| --- | --- |
| a **statically-typed** receiver | `ta.reverse()` fails; `(ta as any).reverse()` compiles — the dynamic spelling routes to `ta-dyn-method-call.ts` instead |
| a **packed** element type | i8: `Uint8Array`, `Int8Array`, `Uint8ClampedArray` · i16: `Uint16Array`, `Int16Array` |

`Int32Array`, `Uint32Array`, `Float32Array`, `Float64Array` are unaffected.
Among the methods, **only `reverse`**: `sort`, `fill`, `copyWithin`, `slice`,
`subarray`, `indexOf` and `join` all compile on a packed receiver, so they
already widen correctly.

Detachment is irrelevant — the crash was first seen next to a detached-buffer
probe during #1645, which made it look related. It is not.

## Root cause

`compileArrayReverse` (`src/codegen/array-methods.ts`) allocated its swap slot
with the array's **storage** type:

```ts
const swapTmp = allocLocal(fctx, `__arr_rev_sw_…`, elemType);
```

A packed type is legal only as a struct field or array element, never in a
value position. The same function already knows this three lines later, where
it picks the load op:

```ts
const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
```

Both `array.get_u` and `array.get_s` push an **i32**. The slot simply has to
match what the load produces.

## Fix

Widen the swap slot to i32 for packed element types; everything else keeps its
own type, so the emitted bytes are unchanged wherever the module compiled
before.

## Verification

- **Reversal is correct, not just compiling.** `[1,…,9]` → `[9,…,1]` on all
  nine element types.
- **Conversions match the host exactly**, checked against Node:

  | receiver | `[-5,…,7]` reversed, `a[0]*1000+a[3]` | js2wasm | Node |
  | --- | --- | --- | --- |
  | `Int8Array` / `Int16Array` | sign-extended | 6995 | 6995 |
  | `Uint8Array` | wraps (−5 → 251) | 7251 | 7251 |
  | `Uint8ClampedArray` | clamps (−5 → 0) | 7000 | 7000 |

  This is the check that matters for a widened slot: `array.get_s` sign-extends
  and `array.get_u` zero-extends, and picking the wrong one would show up here
  rather than at compile time.
- **Byte-identical where it used to compile.** A probe using
  `Float64Array.reverse()` plus a plain `Array` `reverse`/`sort` hashes the same
  before and after, on **both** the gc and standalone lanes
  (`a5faf7fc396fa2ca` / `60777d8347221172`).
- **`result.imports` is `[]`** on every standalone probe.
- **The pin is not vacuous**: `tests/issue-6500-packed-typedarray-reverse.test.ts`
  is **7 failed / 5 passed** against the unfixed source and 12/12 with the fix.
  The five that pass either way are the unpacked controls and the byte-identity
  check — they exist to catch a fix that over-reaches, and would be meaningless
  if they flipped.

## Not fixed here

`reverse` on a **detached** buffer still does not throw the §23.2.4.4 TypeError.
That is the same validation family #5961 closed for nine sibling methods and is
tracked there; this issue is only about the module no longer failing to build.
