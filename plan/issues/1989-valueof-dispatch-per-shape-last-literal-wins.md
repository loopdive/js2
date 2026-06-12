---
id: 1989
title: "ToPrimitive valueOf dispatch keyed by struct type name, not object identity — last same-shape literal's valueOf wins for ALL coercions"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1937, 2009, 1971]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1989 — static valueOf resolution collides across same-shape object literals

## Problem

```ts
const a: any = { valueOf() { return 7; } };
const b: any = { valueOf() { return 100; } };
String(a + 1) + "," + String(b + 1)
// wasm: "101,101"   node: "8,101"
```

Cross-function variant: three separate exported functions with objects
carrying `valueOf`→2, `valueOf`→7/100, and `toString`→"T" ALL coerce via
the last-compiled literal's method — even the `{toString}` object.

## Root cause

`src/codegen/type-coercion.ts:1762-1768` and `:1903-1930` — the ref→f64
static valueOf dispatch is keyed by struct **type name**
(`fields.findIndex("valueOf")`, `ctx.funcMap.get(\`${name}_valueOf\`)`,
`ctx.valueOfClosureTypes.get(name)` registered at
`src/codegen/literals.ts:1360-1364`). Distinct literals sharing a Wasm
struct shape share the name, so every coercion resolves to the
last-compiled literal's method instead of the funcref actually stored in
the object.

## Fix direction

Dispatch through the funcref field stored in the struct instance
(`call_ref` on the object's own valueOf slot) rather than a name-keyed
static lookup. Same disease family as #2009 (field-name export keyed by
canonicalized typeIdx).

## Acceptance criteria

- Both repros match Node; per-object valueOf/toString respected
- Mixed valueOf/toString objects pick their own method per hint

## Dupe check

#1937 is the static-analysis-ignores-dataflow sibling for Math.min/max;
#1971 doesn't mention valueOf. Older valueOf issues (#1090/#1253/#1319)
done. New.
## Implementation Plan

### Chosen mechanism: per-instance funcref/slot dispatch (option c)

Dispatch ToPrimitive through the closure ref stored in the object's OWN field
via `call_ref`, never through a name-keyed static lookup. This kills the bug
independently of #2009 and needs NO new struct fields.

**Key finding:** the fix is already HALF-implemented. The `ref`/`ref_null`
valueOf-field path at `src/codegen/type-coercion.ts:1853-1920` ALREADY does the
right thing — it saves the struct to a local, does `struct.get` on the valueOf
field, and `call_ref`s the closure from the instance. The bug lives ONLY in the
`eqref` path (line 1928-2074), which falls back to
`ctx.valueOfClosureTypes.get(name)` (name-keyed, registered at
`literals.ts:1486-1489`). Distinct literals sharing a struct shape share that
name, so the eqref dispatch tries the LAST-registered literal's closure type
first and that wins for every instance.

### Why eqref instead of ref in the first place
`literals.ts:9314-9315` stores valueOf/toString as `eqref` (not a typed closure
ref) specifically so coercion can "recover the closure and call it by trying
each known closure type." That recovery is the name-keyed loop that breaks.
The fix: store the valueOf/toString field as a TYPED closure ref so it routes
through the already-correct per-instance `call_ref` path.

### Why option (b)/eqref-type-test CANNOT work
The eqref dispatch `ref.test`s the stored closure against each tracked closure
type (line 2019). But the closures are themselves same-shape (zero-param
`() => f64`), so `() => 7` and `() => 100` are `ref.test`-INDISTINGUISHABLE —
exactly the same disease as the outer structs. Any type-test-based recovery is
unsound here. Per-instance `call_ref` on the stored funcref is the only correct
dispatch, which mandates option (c).

### Changes

**File: src/codegen/literals.ts**
- Field-type decision (line 9314-9315): when a valueOf/toString property is a
  closure with a resolvable single closure typeIdx, store it as
  `{ kind: "ref_null", typeIdx: closureTypeIdx }` instead of `eqref`. Construction
  already produces the closure value via `compileExpression` (line 1479); a
  typed ref field makes ToPrimitive take the per-instance `call_ref` path at
  type-coercion.ts:1853.
- Keep the `valueOfClosureTypes` registration (line 1486) ONLY for the residual
  eqref fallback (genuinely polymorphic fields that union multiple closure
  shapes across a deduped struct); it is no longer the primary dispatch source.

**File: src/codegen/type-coercion.ts**
- The `ref`/`ref_null` valueOf path (line 1853-1920) already handles the typed-
  ref field correctly — once the field stores a typed closure ref (above), this
  path fires per instance. No change needed there beyond confirming the closure
  info lookup (`closureInfoByTypeIdx.get(closureTypeIdx)`) resolves.
- The `eqref` path (line 1928-2074) becomes the fallback only. No behavioural
  change required for PR-1; it stays for true-polymorphic fields. Object-return
  TypeError handling (§7.1.1.1, lines 1904-1915 / 2004-2016) is preserved by the
  typed-ref path's existing `emitToPrimitiveHostCall` fallback.

**File: src/codegen/index.ts**
- Host-export `__valueOf`/`__toString` dispatch (line 3616-3641): this twin also
  reads `ctx.valueOfClosureTypes.get(structName)` and has the SAME collision for
  host-boundary coercion (`String(obj)`, `+obj` from JS). Once the field is a
  typed closure ref, the `mode: "closure"` branch at line 3622-3628 (which
  already `call_ref`s the instance field at line 3708) handles it; the eqref
  tracked-types branch at 3631-3641 is no longer the primary path for the
  single-closure case.

### Migration steps (ordered for incremental PRs)
1. **PR-1:** flip valueOf/toString field storage to typed `ref_null
   <closureTypeIdx>` for the single-closure case (literals.ts:9314). This alone
   routes both in-module coercion (type-coercion.ts:1853) and the host export
   (index.ts:3622) onto the per-instance `call_ref` path. Fixes both repros.
2. **PR-2 (cleanup):** once PR-1 lands and tests confirm the eqref path is only
   hit for true polymorphism, add an assertion/log when the eqref name-keyed
   fallback fires, to quantify residual usage before removing it.

### Edge cases
- **Mixed valueOf/toString objects** (the cross-function variant: one obj with
  valueOf→2, one with valueOf→100, one with toString→"T"): each stores its own
  typed closure ref; `call_ref` on the instance field picks the right method per
  object. The `{toString}`-only object has no valueOf field, so ToPrimitive
  falls to the toString path (tryToStringFallback, line 1830) reading ITS own
  toString closure.
- **[Symbol.toPrimitive]** (line 1758): unchanged — already takes precedence;
  but it is ALSO name-keyed (`${name}_@@toPrimitive`). Out of scope for this
  issue (the repros don't use it) but flag as a sibling collision for a
  follow-up — same fix applies (store the @@toPrimitive closure as a typed field
  ref). Document, do not fix here.
- **valueOf returning an object** (must continue to toString then TypeError,
  §7.1.1.1): the existing host-fallback at line 1904-1915 (`ref`/`ref_null`
  return path) is preserved — the typed-ref path already routes object returns
  through `emitToPrimitiveHostCall`.
- **Hint variants** (number/string/default): the typed-ref path passes through
  the same hint plumbing (`toPrimitiveHint`) as today.
- **Spread results / class instances:** class methods are nominal
  (`ClassName_valueOf` standalone funcs, line 1790) — unaffected, already
  per-class-correct. Object-literal spread that copies a valueOf field copies
  the closure ref value, so the copy dispatches to the same method (correct).
- **Host-boundary marshaling:** the index.ts:3616 host export fix ensures
  `String(obj)` / `+obj` from JS also resolves per-instance.

### Test plan
- `tests/issue-1989.test.ts` (new): both repros must match Node —
  `String(a+1)+","+String(b+1)` ⇒ `"8,101"`; the three-function cross variant
  (valueOf→2, valueOf→7/100, toString→"T") each coercing via its own method.
- Add a mixed-hint case: `` `${a}` `` (string hint) vs `a+1` (number hint) on an
  object with both valueOf and toString returning different values.
- Equivalence suite green; confirm the typed `ref`/`ref_null` valueOf path
  (pre-existing) still passes its #1253/#1525b TypeError cases.

### Revised feasibility / reasoning_effort
DOWNGRADE: `feasibility: medium` (was hard), `reasoning_effort: high`
(unchanged). The correct per-instance machinery already exists at
type-coercion.ts:1853 and index.ts:3622; the change is to ROUTE eqref valueOf/
toString fields onto it by storing them as typed closure refs, rather than
building new dispatch. PR-1 is small and high-leverage. Developer-claimable
(not senior-only), but coordinate with #2009 since both touch object-literal
struct construction in literals.ts (different concerns — field NAMES vs field
TYPE for valueOf — low conflict risk, but sequence #2009 PR-1 and #1989 PR-1 to
avoid overlapping edits at literals.ts:9314/9348).
