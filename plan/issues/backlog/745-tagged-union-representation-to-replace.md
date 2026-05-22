---
id: 745
title: "Tagged union representation to replace externref boxing"
status: ready
created: 2026-03-22
updated: 2026-04-28
priority: high
feasibility: hard
reasoning_effort: max
goal: performance
files:
  src/codegen/index.ts:
    new:
      - "defineTaggedUnionType(): create WasmGC struct for tagged unions"
      - "tagged union helper functions: tag checks, value extraction"
  src/codegen/type-coercion.ts:
    breaking:
      - "replace externref boxing with tagged union struct for known union types"
  src/codegen/expressions.ts:
    breaking:
      - "binary/unary ops on tagged unions: branch on tag, dispatch to typed path"
---
# #745 — Tagged union representation to replace externref boxing

## Status: open

## Problem

Currently, any value whose type can't be resolved to a single Wasm primitive becomes `externref`. Operations on `externref` require JS host calls (`__box_number`, `__unbox_number`, `__any_add`, etc.) — each costing a cross-boundary call.

For values that are a *known* union of Wasm-representable types (e.g., `number | string`, `number | null`), we can use a WasmGC struct with a type tag instead — keeping everything in pure Wasm with no host calls.

## Approach

### Tagged union struct layout
```wasm
(type $tagged_union (struct
  (field $tag (mut i32))         ;; 0=f64, 1=i32, 2=string, 3=null, 4=ref, ...
  (field $f64_val (mut f64))     ;; populated when tag=0
  (field $i32_val (mut i32))     ;; populated when tag=1
  (field $ref_val (mut anyref))  ;; populated when tag=2,4 (strings, objects)
))
```

### Operations on tagged unions
Instead of calling `__any_add(externref, externref) → externref`:
```wasm
;; a + b where both are tagged unions
(block $done (result f64)
  ;; Fast path: both are f64
  (br_if $done
    (f64.add
      (struct.get $tagged_union $f64_val (local.get $a))
      (struct.get $tagged_union $f64_val (local.get $b)))
    (i32.and
      (i32.eqz (struct.get $tagged_union $tag (local.get $a)))
      (i32.eqz (struct.get $tagged_union $tag (local.get $b)))))
  ;; Slow path: coerce and add
  ...
)
```

### When to use
- After whole-program analysis (#743): if a variable's type resolves to a union of 2-3 concrete types, use a tagged union instead of externref
- For function parameters that receive different types at different call sites but monomorphization (#744) isn't worthwhile (large functions)
- For collection elements: `Array<number | string>` → `vec (ref $tagged_union)` with fast numeric path

### Performance model
| Operation | externref (current) | Tagged union |
|-----------|-------------------|--------------|
| Arithmetic | 2 JS host calls | 1 branch + native op |
| Comparison | 1 JS host call | 1 branch + native op |
| Type check | 1 JS host call | 1 i32 compare |
| Boxing | 1 allocation + JS call | 1 struct.new (Wasm GC) |

### Interaction with other issues
- #743 (whole-program analysis) determines which variables are known unions vs truly dynamic
- #744 (monomorphization) is preferred for small functions; tagged unions for large functions and collections
- Replaces need for `__any_add`, `__any_sub` etc. host helpers for known-union cases

## Complexity: XL

## Implementation Plan

(Author: architect, 2026-05-21. **Important**: #1552 is a newer
issue that supersedes parts of this with a single uniform `$Value`
struct. Recommend closing #745 in favour of #1552 unless there's a
reason for the per-union-type custom struct described here.)

### Coordination

This issue and #1552 describe overlapping designs:

- **#745 (this issue)**: Per-distinct-union-type custom struct
  with only the fields needed for that union (e.g.
  `number | string` gets `{tag, f64, ref}`).
- **#1552**: A single universal `$Value` struct covering ALL
  union types in the program.

#1552 is simpler (one type for everything) and easier to optimize
(predictable layout, JIT-friendly). #745 is space-efficient (no
unused fields) but generates many struct types and complicates
codegen branching.

**Architect recommendation**: Adopt #1552's universal design.
Close #745 as superseded once #1552's Implementation Plan is
approved.

### If #745 is kept

Follow the algorithm in #1552's Implementation Plan but generate
one struct type per distinct union signature observed (signature
= sorted set of member types). Helper functions become parametric
over the struct type. Add a `ctx.unionTypes:
Map<signature, typeIdx>` to dedup.

### Dependencies

- **#1552** — supersedes; coordinate.
- **#743** — required to identify union types.
- **#744** — monomorphization; complementary.

### Risk

Two competing designs in the backlog. Decide before any code
ships.
