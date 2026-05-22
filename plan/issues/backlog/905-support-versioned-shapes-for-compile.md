---
id: 905
title: "Support versioned shapes for compile-time-known prototype mutation"
status: ready
created: 2026-04-02
updated: 2026-04-28
priority: medium
feasibility: hard
reasoning_effort: max
goal: compiler-architecture
depends_on: [743, 746]
files:
  src/shape-inference.ts:
    modify:
      - "Track prototype/layout versions, not only single fixed shapes"
  src/codegen/expressions.ts:
    modify:
      - "Lower known prototype transitions to versioned struct/layout dispatch"
  src/codegen/index.ts:
    modify:
      - "Emit shape/prototype version metadata and select specialized access paths"
---
# #905 -- Support versioned shapes for compile-time-known prototype mutation

## Problem

Prototype mutation is usually treated as a reason to fall back to generic JS object behavior.

But in a closed-world compilation model, many prototype changes are known at compile time. In those cases, the compiler should not have to abandon specialization entirely.

## Goal

Support versioned shapes/layouts for prototype changes that are visible in the whole program.

## Approach

1. infer an initial object shape/layout
2. detect compile-time-known prototype/layout transitions
3. assign a new versioned shape for each transition
4. compile property reads/writes/method dispatch against the active version
5. fall back only when the mutation is truly dynamic or reflective beyond what the compiler can model

## Examples

Known-at-compile-time cases:

- constructor or setup code that swaps a prototype in a fixed way
- staged object initialization that extends a shape in known steps
- class/prototype patterns whose final shape graph is visible to the compiler

Truly dynamic cases should still use the generic path.

## Acceptance criteria

- compile-time-known prototype/layout mutations no longer force unconditional generic property handling
- versioned shape transitions are explicit in analysis/codegen
- direct specialized access remains possible before and after known transitions
- dynamic/reflective prototype mutation still falls back conservatively

## Implementation Plan (added 2026-05-21)

### Entry point
- `src/shape-inference.ts` — extend `ShapeMap` with version tracking
- `src/codegen/property-access.ts` — pick the active version at each access site
- `src/codegen/expressions/calls.ts` — method dispatch chooses version's vtable

### Data structures
1. `ShapeVersion` type:
   ```ts
   interface ShapeVersion {
     id: number;                    // unique within a shape lineage
     parent?: ShapeVersion;          // chain back to v0
     addedFields: Map<string, FieldDef>;
     removedFields: Set<string>;
     prototypeStructIdx: number;     // Wasm struct type for this version
     vtableFuncIdxs: Map<string, number>; // method name → funcIdx for this version
   }
   ```
2. `Shape` is now a list of versions: `versions: ShapeVersion[]`. v0 is the initial layout; transitions append new versions.
3. Each AST node that reads/writes a property gets annotated with `accessShapeVersionId` during analysis. Codegen reads this annotation to pick the right struct typeIdx and vtable.

### Algorithm
1. **Shape inference (whole-program pass)** — depends on #743:
   - Build the initial shape from object literal / class declaration sites (v0)
   - Walk the program; for each statement, detect prototype/layout mutations:
     - `obj.newField = v` where `obj`'s shape did not declare `newField` → start a new version with `newField` appended
     - `Object.setPrototypeOf(obj, other)` with `other` resolving to a known shape → new version pointing at `other`'s shape as parent
     - `delete obj.field` (where present at compile time) → new version with that field removed
     - `Object.defineProperty(obj, "field", desc)` where `desc` is a literal → new version with descriptor metadata
   - The new version's `id` is allocated; the AST nodes downstream of the mutation reference the new version
2. **Version selection per access**:
   - For `obj.field` at AST node N: walk N's data-flow predecessors; the unique shape version reaching N is N's `accessShapeVersionId`. If multiple versions reach (control-flow join), either:
     - Insert a `ref.test` chain to discriminate (slow), OR
     - Mark N as "unknown version" and emit the generic property-access path
3. **Codegen**:
   - For each version, emit a distinct Wasm struct typedef (`prototypeStructIdx`)
   - At each annotated property access, emit `struct.get $version_struct $field_idx` directly
   - The struct cast from a parent to a child version is `ref.cast $childStruct`; guarded by `ref.test` at runtime if the analysis is not certain
4. **Method dispatch**:
   - Each version's `vtableFuncIdxs` maps method names to specialised function indices
   - `obj.method()` where `obj`'s version is known → `call $vtableFuncIdx` directly (no indirection)
   - If `setPrototypeOf` swapped to a different class's prototype, the version's vtable reflects the new prototype's methods

### Wasm output (example: object with prototype swap)
```js
// Source:
function makeA() {
  const o = { x: 1 };
  o.__proto__ = { hello() { return this.x; } };
  return o.hello();
}
```
```wasm
;; v0 struct: $obj_v0 { x: f64 }
;; v1 struct: $obj_v1 { x: f64, __vtable: $vt_v1 }
;; v1 vtable: $vt_v1.hello = $hello_specialised

call $obj_new_v0 ;; allocate v0 with x=1
;; setPrototypeOf rewrite: ref.cast to v1 layout (or re-allocate if struct shape changed)
call $upgrade_v0_to_v1
;; o.hello() — known version v1, known vtable slot
local.tee $o
struct.get $obj_v1 $__vtable
struct.get $vt_v1 $hello
local.get $o
call_indirect ;; or call_ref
```

### Edge cases
- **Cyclic prototype graph**: detect cycles in `setPrototypeOf` chains; fall back to generic dispatch for the cycle's members.
- **Late binding via aliasing**: `const o = makeObj(); somethingThat(o);` where `somethingThat` is unanalysable → fall back at the alias boundary. Track aliasing via #743's type flow.
- **Conditional prototype mutation** (`if (cond) Object.setPrototypeOf(o, x);`) — control-flow join produces a union of versions; emit a `ref.test` discriminator chain at the next access, or fall back if the union is too large (>4 versions, say).
- **Constructor `this` escapes before mutation**: if `this` is passed to another function while shape is incomplete, the analysis must conservatively pick the earliest version reachable at the escape point.
- **`__proto__` write vs `Object.setPrototypeOf`**: treat both identically.
- **Inherited methods (prototype's prototype)**: walk the chain at compile time; the vtable inlines the lookup result.
- **Frozen prototypes**: a `Object.freeze(Proto.prototype)` lets the analysis prove no future mutation; can fold the vtable.

### Test plan
- Add `tests/issue-905.test.ts` with cases:
  - Simple prototype swap → direct vtable dispatch (verify no `call_indirect` to generic property fetch)
  - Conditional swap → discriminator emitted
  - Cyclic prototype → falls back, no infinite version generation
  - Frozen prototype → no version increment after freeze
- Performance bench: compare emitted Wasm size before/after on a representative class+prototype-mutation example (target <5% size increase, >2x dispatch perf in microbench)

### Dependencies
- **Hard**: #743 whole-program type flow analysis — needed to track shapes across function calls
- **Hard**: #746 inline property tables — versioned shapes piggyback on struct-based shapes
- **Soft**: #904 link-time specialization — versions can also specialise across module boundaries

### Files touched
- `src/shape-inference.ts` (extend ShapeMap to versions; primary)
- `src/codegen/property-access.ts` (version-aware emit)
- `src/codegen/expressions/calls.ts` (version-aware vtable dispatch)
- `src/codegen/index.ts` (emit per-version struct types)
- new `src/shape-versions.ts` (transition graph + version allocation, optional split)
- `tests/issue-905.test.ts` (new)
