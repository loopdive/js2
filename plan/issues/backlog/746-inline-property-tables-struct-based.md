---
id: 746
title: "Inline property tables: struct-based property access for inferred shapes"
status: blocked
created: 2026-03-22
updated: 2026-04-28
priority: medium
feasibility: hard
goal: compiler-architecture
required_by: [905]
files:
  src/codegen/index.ts:
    new:
      - "defineHiddenClass(): create WasmGC struct type from inferred object shape"
      - "hiddenClassRegistry: map shape signatures to struct type indices"
  src/codegen/expressions.ts:
    breaking:
      - "property access on known shapes: emit struct.get instead of externref lookup"
      - "property assignment on known shapes: emit struct.set instead of externref store"
  src/shape-inference.ts:
    breaking:
      - "extend shape inference to track full property sets, not just array-like patterns"
---
# #746 — Inline property tables: struct-based property access for inferred shapes

## Status: open

## Problem

Property access on untyped objects (`obj.foo`) currently goes through `externref` when the object's shape isn't known from a TypeScript interface or class declaration. This requires JS host calls for every property read/write.

With whole-program analysis (#743), we can infer object shapes from construction sites (object literals, constructor functions) and compile property access as direct `struct.get`/`struct.set` — identical to typed class field access.

## Approach

### Phase 1: Shape collection
During the whole-program analysis pass, collect shapes from:
- Object literals: `{ x: 1, y: 2 }` → shape `{x: f64, y: f64}`
- Constructor patterns: `this.x = ...; this.y = ...` → shape from all assignments
- Property additions: `obj.z = ...` after construction → extended shape

### Phase 2: Hidden class generation
For each distinct shape, generate a WasmGC struct type:
```wasm
(type $shape_xy (struct
  (field $x (mut f64))
  (field $y (mut f64))
))
```

Map property names to field indices at compile time. Property access becomes:
```wasm
;; obj.x where obj has shape {x: f64, y: f64}
(struct.get $shape_xy $x (local.get $obj))  ;; O(1), no lookup
```

### Phase 3: Shape transitions
When an object gains a new property after construction:
- If the extended shape is known at compile time → use the extended struct type
- If dynamic → fall back to externref for that object

### What this enables
| Access pattern | Current | After |
|---------------|---------|-------|
| `obj.x` (typed class) | `struct.get` | `struct.get` (same) |
| `obj.x` (untyped, known shape) | JS host call | `struct.get` |
| `obj[dynamicKey]` | JS host call | JS host call (same) |
| `obj.x` (truly dynamic) | JS host call | JS host call (same) |

### Relation to V8's hidden classes
This is the compile-time equivalent of V8's hidden class / shape system. V8 discovers shapes at runtime; we discover them statically from whole-program analysis. The benefit: no deoptimization needed, shapes are fixed at compile time.

## Complexity: XL

## Implementation Plan

(Author: architect, 2026-05-21. Concrete plan that builds on the
existing `src/shape-inference.ts` — currently only tracks array-like
shapes — and extends to full object hidden classes.)

### Entry points

- **Shape collection**: extend `collectShapes` in
  `src/shape-inference.ts:33` to track object-literal shapes and
  constructor-built shapes, not just array-like patterns.
- **Type registry**: new helper `getOrRegisterHiddenClass(ctx,
  signature)` in `src/codegen/registry/types.ts` modelled on
  `getOrRegisterVecType` (L92).
- **Codegen**: branch in property-access lowering in
  `src/codegen/property-access.ts` — when receiver's static type
  resolves to a hidden class, emit `struct.get`/`struct.set` instead
  of the externref/sidecar path.
- **Construction**: branch in `src/codegen/expressions.ts`
  object-literal lowering — when literal's shape matches a registered
  hidden class, emit `struct.new` with the literal's values.

### Data structure changes

1. **`InferredShape`** (src/shape-inference.ts:16): widen to:
   ```ts
   export interface InferredShape {
     fields: Map<string, { type: "number" | "string" | "boolean" | "object" | "unknown" }>;
     hasNumericIndexing: boolean;
     // NEW
     constructionSites: ts.Node[];     // where shape was first observed
     extensions: Set<string>;          // properties added post-construction
     dynamicKeyed: boolean;            // bail out if true
     signature: string;                // canonical sorted field-list -> struct dedup key
   }
   ```

2. **Hidden-class registry** (new in `src/codegen/registry/types.ts`):
   ```ts
   ctx.hiddenClasses: Map<string /* signature */, {
     typeIdx: number;
     fieldOrder: string[];           // index into struct fields
     fieldTypes: ValType[];          // wasm types per field
   }>
   ```

3. **TypeMap propagation**: extend `ctx.varHiddenClass:
   Map<symbolId, signature>` to carry the inferred class through
   codegen; lookup is by TS symbol, not name, to handle shadowing.

### Numbered algorithm

1. **Shape collection (whole-program pass)** — depends on #743.
   1. Walk every variable declaration / assignment / constructor body.
   2. For each, record the set of property writes (`obj.x = ...`,
      object literal fields, `this.x = ...` inside ctor).
   3. Canonicalize: sort field names; produce signature
      `"x:f64|y:f64"` (type sigils: `f64 i32 str obj ref`).
   4. Mark `dynamicKeyed=true` if any `obj[expr]` write is seen where
      `expr` is not a known string literal.
   5. Group all variables/sites by signature.

2. **Hidden-class registration** — for each unique signature with at
   least 2 sites OR ≥1 hot site (per #743 hotness data):
   1. Call `getOrRegisterHiddenClass(ctx, signature)` → returns
      `typeIdx`.
   2. Emit type definition into the module's type section:
      `(type $hc_NNN (struct (field $x (mut f64)) (field $y (mut f64))))`.

3. **Construction lowering** — in `compileObjectLiteralExpression`
   (search `src/codegen/expressions.ts`):
   1. Look up the literal's TS node in
      `ctx.shapeMap → hiddenClassSignature`.
   2. If a hidden class exists with that signature: emit the field
      values in `fieldOrder`, then `struct.new $hc_NNN`.
   3. Otherwise: fall through to existing externref/sidecar literal
      path.

4. **Property access lowering** — in `src/codegen/property-access.ts`
   `compileMemberAccess` / `compileMemberAssignment`:
   1. Resolve the receiver's static type. If its TS symbol maps to a
      hidden class signature: look up `fieldOrder.indexOf(propName)`.
   2. If found: emit
      `struct.get $hc_NNN $field_i (local.get $obj)`. For assignment,
      use `struct.set`.
   3. If propName not in fieldOrder OR receiver maps to no hidden
      class: existing externref path.

5. **Shape transition / extensions** — if `extensions` is non-empty
   for a shape:
   1. Generate an extended hidden class with the union of fields.
   2. At the extension write site, allocate a new struct, copy
      fields from the old, write the new field, and replace the
      local. (Only viable when the variable is single-assignment;
      otherwise bail to externref for this site.)

6. **TypeChecker integration** — feed inferred hidden-class types
   into TS checker by treating object literals at compile sites as
   having a synthetic interface; this lets later checks short-circuit
   the externref path.

### Example wasm output — `let p = { x: 1, y: 2 }; p.x + p.y`

After:

```wat
(type $hc_xy (struct (field $x (mut f64)) (field $y (mut f64))))

;; let p = {x:1, y:2}
f64.const 1
f64.const 2
struct.new $hc_xy
local.set $p

;; p.x + p.y
local.get $p
struct.get $hc_xy $x
local.get $p
struct.get $hc_xy $y
f64.add
```

No host call. No sidecar.

### Edge cases

- **Two literals with different field orders but same set**:
  `{x:1,y:2}` vs `{y:2,x:1}` — canonical signature collapses these to
  one class.
- **Missing properties at construction**: `{x:1}` later `obj.y = 2`
  — generate extended class only if extension is statically
  observable; otherwise bail.
- **Type widening**: `{x:1}` then `obj.x = "hello"` — type widens to
  union; either drop to externref or register a tagged-union slot
  (depends on #1552).
- **`undefined` field default**: writing `undefined` to a number
  field needs a sentinel (sNaN 0x7FF00000DEADC0DE per project
  CLAUDE.md) or upgrade to a union slot.
- **`null` receiver**: `null.x` must throw TypeError — emit a
  `ref.is_null` guard before `struct.get`.
- **`delete obj.x`**: struct fields can't be deleted; if any site
  uses `delete`, the shape is dynamicKeyed → bail.
- **`for-in` enumeration**: must iterate `fieldOrder`; route through
  a generated `$hc_enumerate_NNN` helper that emits names in
  insertion order.
- **`Object.keys(obj)`**: same — generate a static keys array per
  hidden class.
- **Symbol-keyed properties**: never part of the hidden class; route
  symbol keys through the sidecar regardless.
- **`in` operator**: `'x' in p` → compile-time true/false.
- **Polymorphic call sites**: if `f(obj)` sees objects of multiple
  shapes, parameter type widens to externref unless all callers pass
  the same shape (per #743's call-graph specialization).

### Test262 paths to watch

- `test/language/expressions/object/*`
- `test/language/expressions/property-access/*`
- `test/built-ins/Object/keys/*`, `Object/values/*`, `Object/entries/*`
- `test/language/statements/for-in/*`

Acceptance: ≥30% reduction in `__sidecarGet` / `__sidecarSet` /
`__safeGet` / `__safeSet` call counts in the test262 emitted wasm.
No regression on test262 pass count.

### Dependencies

- **#743 (whole-program type flow analysis)** — required for the
  shape collection step. This issue is blocked on #743 (status:
  blocked is correct).
- **#1552 (tagged union)** — required to elegantly handle type
  widening within a field; without it, widening forces externref
  fallback for the whole struct.
- **#747 (escape analysis)** — orthogonal; enables stack allocation
  of hidden-class structs that don't escape.

### Risks

- Whole-program analysis cost: shape inference is O(program-size);
  acceptable for the compiler but must be incremental for the
  language-server story (out of scope for v1).
- Misinferred shapes can introduce subtle bugs; ship behind
  `ctx.useHiddenClasses` flag; default off until soak-test.
- ABI break: every emitted wasm changes property-access lowering;
  Test262 baseline must be refreshed atomically when this lands.
