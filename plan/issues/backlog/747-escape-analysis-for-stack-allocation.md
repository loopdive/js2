---
id: 747
title: "Escape analysis for stack allocation"
status: blocked
created: 2026-03-22
updated: 2026-04-28
priority: medium
feasibility: hard
goal: performance
files:
  src/codegen/index.ts:
    new:
      - "escapeAnalysis(): determine which allocations can be stack-allocated"
  src/codegen/expressions.ts:
    breaking:
      - "object/array literals: use stack allocation when escape analysis permits"
  src/codegen/statements.ts:
    breaking:
      - "function scoping: track allocation lifetimes for escape analysis"
---
# #747 — Escape analysis for stack allocation

## Status: open

## Problem

Every object literal, array literal, and closure capture currently allocates on the GC heap. For short-lived objects that don't escape their creating function, this creates unnecessary GC pressure. Wasm engines may not optimize this away.

## Approach

### What "escape" means
An allocation escapes if:
1. It's returned from the function
2. It's stored in a field of another object that escapes
3. It's passed as an argument to a function that stores it
4. It's captured by a closure that escapes

If none of these apply, the object's lifetime is bounded by the function scope.

### Analysis
After whole-program analysis (#743) and shape inference (#746):
1. For each `struct.new` / array allocation, track all uses
2. Classify as: **local-only** (never escapes), **returned** (escapes via return), **stored** (escapes via field/array store)
3. Local-only allocations can be replaced with locals (scalar replacement)

### Scalar replacement
For non-escaping objects with known shapes:
```javascript
function distance(x1, y1, x2, y2) {
  const p = { dx: x2 - x1, dy: y2 - y1 };  // doesn't escape
  return Math.sqrt(p.dx * p.dx + p.dy * p.dy);
}
```
Compile `p.dx` and `p.dy` as two `f64` locals instead of a heap-allocated struct:
```wasm
(local $p_dx f64)
(local $p_dy f64)
(local.set $p_dx (f64.sub (local.get $x2) (local.get $x1)))
(local.set $p_dy (f64.sub (local.get $y2) (local.get $y1)))
```

Zero allocation, zero GC. The struct never exists.

### Limits
- Only applies to objects with known, fixed shapes (depends on #746)
- Closures that capture mutable variables still need ref cells on the heap
- Arrays with dynamic length can't be scalar-replaced
- Recursive data structures can't be stack-allocated

### Relation to existing work
- #652 (compile-time ARC) is a more ambitious version of this — escape analysis is Phase 1 of #652
- Binaryen's `wasm-opt` may already do some of this, but whole-program knowledge enables more aggressive optimization

## Complexity: L

## Implementation Plan

(Author: architect, 2026-05-21. Blocked on #743 and #746;
specced now.)

### Entry point

New module `src/checker/escape-analysis.ts` exporting:

```ts
export interface EscapeInfo {
  classification: "local" | "returned" | "stored" | "captured";
  escapeReason?: string;
}
export function analyzeEscape(
  programTypes: ProgramTypeMap,
  shapeMap: ShapeMap,
): Map<ts.Node /* allocation site */, EscapeInfo>;
```

### Algorithm

1. **Allocation sites**: gather every object-literal, array-literal,
   class-instantiation, `new`-expression, closure-capture site.

2. **Use-def chain**: for each allocation, track the def chain via
   AST walk:
   - Stored to a local that's later returned? → returned.
   - Stored to a field of an escaping object? → stored.
   - Passed to a function whose parameter escapes? → propagate
     (interprocedural via #743's call graph).
   - Captured by a closure that escapes? → captured.
   - None of the above? → local.

3. **Apply optimization**:
   - **local + scalar-replaceable** (small struct, fields are
     primitives) → expand fields into wasm locals; rewrite
     `struct.get/set` to `local.get/set`.
   - **local but not scalar-replaceable** (large struct or
     ref-containing field) → keep struct.new but allow Binaryen
     wasm-opt's escape analysis to do its thing; we get nothing
     extra.
   - **escapes** → no change.

4. **Codegen integration**:
   - `src/codegen/expressions.ts` `compileObjectLiteralExpression`
     and array-literal: check `ctx.escapeInfo.get(node)` and emit
     scalar-replaced locals when local + replaceable.
   - `src/codegen/property-access.ts`: redirect field access of a
     replaced allocation to the corresponding local.

### Edge cases

- **Closures capturing the allocation**: if the closure doesn't
  escape, allocation also doesn't escape; transitively check.
- **`this` binding**: in methods, `this` is a parameter that
  escapes by definition.
- **Throw escapes**: throwing an object via `throw obj` escapes it.
- **Eval / dynamic property access**: gives up; treat as escapes.
- **for-of over local-only array**: still iterable via direct
  indexed access on the replaced locals (Phase 2 — for Phase 1,
  iteration disables scalar replacement).

### Test paths

Equivalence tests in `tests/issue-747-escape.test.ts`:
- `function() { let p = {x:1,y:2}; return p.x+p.y; }` — emits no
  struct.new; compares to externref-roundtrip baseline for
  observability.
- Returned object case stays heap-allocated.

### Dependencies

- **#743** — required for interprocedural escape propagation.
- **#746** — required to know struct field types for scalar
  replacement.
- **#652** — superset of this; #747 is Phase 1 of #652.

### Risks

- **Soundness**: any missed escape path silently stack-allocates
  an escaping object → use-after-free. Ship behind
  `ctx.escapeAnalysis` flag; default off until soak-tested.
- **Performance**: should be a clear win for hot allocation sites
  (e.g. Point-like classes in inner loops).
