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

## Architect refresh (2026-06-13) — corrected line numbers + the TIMING blocker

The plan above is **conceptually correct** (route eqref valueOf/toString fields
onto the already-working per-instance `call_ref` path by storing a typed closure
ref), but its line numbers drifted and it understates the one real design
obstacle. Re-verified against current main:

### Corrected change sites (the plan's `literals.ts:9314` etc. are stale)

- **The field-TYPE decision is `src/codegen/index.ts:9242-9246`**, NOT in
  literals.ts. This is the exact code that creates the bug:
  ```ts
  // index.ts:9242  (inside the anon-struct field builder)
  // For valueOf/toString callable properties, store as eqref instead of externref
  // so coercion can recover the closure and call it via call_ref
  if (wasmType.kind === "externref" && callSigs.length > 0 &&
      (prop.name === "valueOf" || prop.name === "toString")) {
    wasmType = { kind: "eqref" };   // ← the eqref that forces the name-keyed fallback
  }
  ```
  The comment literally says "recover the closure and call it via call_ref" —
  but `eqref` has no typeIdx, so coercion can't `call_ref` it directly and falls
  back to the name-keyed `ctx.valueOfClosureTypes.get(name)` loop (the bug).
- **The already-correct per-instance typed-ref path is
  `src/codegen/type-coercion.ts:1871-1937`** (valueOf, number hint) — when
  `valueOfField.type.kind === "ref" | "ref_null"` it saves the struct, does
  `struct.get` the closure field, and `call_ref`s the instance's own closure.
  The eqref name-keyed fallback is `type-coercion.ts:1946-2074`
  (`ctx.valueOfClosureTypes.get(name)` at `:1950`). The toString twin lives at
  `:2169` / `:2390`.
- **The closure-type tracking registration is `src/codegen/literals.ts:1605-1620`**
  (`ctx.valueOfClosureTypes.set(typeName, …)` at `:1617`), populated at struct
  *construction* time.
- **The host-export twin is `src/codegen/index.ts:3340-3341`**
  (`ctx.valueOfClosureTypes.get(structName)`), reached by `String(obj)` / `+obj`
  from the JS boundary — same collision, same fix once the field is typed.

### The TIMING blocker the plan under-specifies (READ BEFORE IMPLEMENTING)

The field type at `index.ts:9242` is decided during the **anon-struct
type-registration pre-pass** (`ensureStructForType`), driven by
`resolveWasmType(propType)` over the TS type. At that moment the **closure
struct typeIdx does not exist yet** — closures are created lazily during
expression compilation (`closures.ts`, populating `ctx.closureInfoByTypeIdx`),
which runs LATER than struct-type registration. So you cannot simply write
`wasmType = { kind: "ref_null", typeIdx: <closureTypeIdx> }` at `:9245` — there
is no typeIdx to put there.

This is why the original author chose `eqref` (a typeIdx-free supertype) and
deferred recovery to coercion time. The fix must bridge that gap. Two viable
designs — recommend **(B)** as lowest-risk:

- **(A) Eagerly create the closure struct type during the pre-pass** from the
  TS call signature (synthesize the closure typeIdx for `() => T` before the
  body is compiled), then store `{ kind: "ref_null", typeIdx }` at `:9245`.
  Correct but invasive: requires closure-type creation to be callable from the
  type pre-pass and to MATCH the typeIdx the construction path later produces
  (`literals.ts:1607` `compileExpression(prop.initializer, field.type)`), or the
  field-store coercion fails its `ref.test`. High risk of typeIdx divergence.

- **(B) Keep the field as `eqref`, but make the eqref coercion path do
  PER-INSTANCE dispatch instead of name-keyed recovery.** The eqref slot holds
  the actual closure struct value of THIS instance. At coercion time we have the
  struct on the stack; `struct.get` the eqref valueOf field, then recover its
  concrete closure type **from the value, not from the name**. The current code
  already `ref.test`s the stored closure against each tracked type
  (`type-coercion.ts:2019`) — the bug is it tries the LAST-registered type
  first/only. The fix: the eqref value carries its own concrete type;
  `call_ref` requires a typed funcref, so we still need a typeIdx — but we can
  get it per-instance by `ref.test`-ing against the FULL tracked list and
  dispatching to whichever matches, calling that instance's funcref via
  `call_ref`. **CAVEAT (from the plan's own §"Why option (b) CANNOT work"):**
  same-shape zero-arg closures (`()=>7` vs `()=>100`) are `ref.test`-
  indistinguishable, so type-test recovery is unsound when two literals share a
  closure shape — which is exactly the repro. So pure (B) is also insufficient.

- **(B′) — RECOMMENDED: per-instance funcref dispatch, no type recovery at all.**
  The closure struct's field 0 is the **funcref** (the actual function pointer),
  which DIFFERS between `()=>7` and `()=>100` even though the struct TYPE is
  identical. So:
  1. Keep the field `eqref` (no pre-pass typeIdx needed — sidesteps the timing
     blocker entirely).
  2. At coercion (`type-coercion.ts` eqref path), `struct.get` field 0 (the
     funcref) from the eqref-stored closure of THIS instance. We need ONE
     closure struct typeIdx to do the `struct.get` and to type the `call_ref` —
     but all same-shape closures share that typeIdx, so a single
     `ref.cast <sharedClosureTypeIdx>` is sound (they ARE that type). The
     `call_ref` then targets the per-instance funcref read from field 0 →
     correct per-object dispatch.
  3. The only thing that was wrong is selecting the closure by NAME-keyed
     `valueOfClosureTypes.get(name)[last]` and calling THAT literal's funcref.
     Replace "pick a tracked type and call its funcref" with "cast the
     instance's eqref to the shared closure type, read ITS field-0 funcref,
     `call_ref` it." For the single-shape case (the repro) there is exactly one
     tracked closure typeIdx, so the cast target is unambiguous; the funcref is
     read per-instance. This needs NO pre-pass change, NO new struct field, and
     fixes both repros.
  - **Genuinely-polymorphic valueOf fields** (two DIFFERENT closure shapes,
    e.g. arities, unioned into one deduped struct): `valueOfClosureTypes` has >1
    entry; `ref.test` to pick the matching shape FIRST (shapes differ → test is
    sound), THEN read that instance's field-0 funcref and `call_ref`. The
    unsound case the plan worried about (same shape, different body) is handled
    because we never distinguish by body — we read the funcref from the value.

Implement **(B′)** in the eqref valueOf path (`type-coercion.ts:1946-2074`), the
toString twins (`:2169`, `:2390`), and the host-export eqref branch
(`index.ts:3340`). This is the minimal correct change and avoids the
type-pre-pass timing trap that sinks options (A) and the original plan's "store
a typed ref at :9245".

### Revised PR split
- **PR-1:** rewrite the eqref valueOf/toString coercion recovery to read the
  per-instance field-0 funcref (B′), for both the in-module coercion
  (`type-coercion.ts`) and the host export (`index.ts:3340`). Fixes both repros.
  No literals.ts / index.ts:9242 field-type change → no #2009 conflict, no
  timing blocker.
- **PR-2 (optional cleanup):** once PR-1 proves the name-keyed
  `valueOfClosureTypes` map is only consulted to enumerate candidate SHAPES (not
  to pick the funcref), simplify or remove the last-wins selection.

### Sibling collision to file (do NOT fix here)
`[Symbol.toPrimitive]` dispatch (`type-coercion.ts:1758` area) is ALSO name-keyed
(`${name}_@@toPrimitive`) and has the identical last-literal-wins bug. Out of
scope (the repros don't use it); file a follow-up — the same B′ funcref-per-
instance fix applies.

### Quick verification the spec is current
- `index.ts:9242` eqref decision: confirmed present.
- `type-coercion.ts:1871` typed-ref `call_ref` path: confirmed correct/working.
- `type-coercion.ts:1950` `valueOfClosureTypes.get(name)`: confirmed the
  name-keyed fallback.
- `index.ts:3340` host-export eqref branch: confirmed the host-boundary twin.

## CRITICAL CORRECTION (2026-06-13, after reading the actual repro path)

**The repro uses METHOD SHORTHAND (`{ valueOf() { return 7 } }`), not a
property-assigned closure (`{ valueOf: () => 7 }`). These take DIFFERENT codegen
paths, and the repro's path is NOT the eqref-closure dispatch the plans above
describe.** This changes the fix. The eqref-closure analysis above applies only
to `valueOf:` arrow/function-EXPRESSION properties; the repro's method-shorthand
form is the harder, distinct case.

### What actually happens for `{ valueOf() { return 7 } }`

Method-shorthand `valueOf` compiles to a **standalone Wasm function**
`${typeName}_valueOf` (`src/codegen/literals.ts:1921-2016`), registered in
`ctx.funcMap` keyed by the struct's `typeName` (`literals.ts:2007`,
`ctx.funcMap.set(fullName, methodFuncIdx)` where `fullName = ${typeName}_valueOf`).
Its first param is `this: (ref $structType)` (`:2023`). It is **NOT stored in the
struct as a per-instance field** — there is no funcref slot to read.

At coercion time, the eqref branch's tracked-closure list is EMPTY for
method-shorthand (no closure struct was stored), so dispatch falls to
`type-coercion.ts:2054`: `ctx.funcMap.get(\`${name}_valueOf\`)` → a single
**name-keyed standalone function**. Because `a` and `b` are the same Wasm struct
shape, they share `name`, so `${name}_valueOf` resolves to ONE function for both
instances. And since the two literals' methods were registered under the same
`fullName`, the second registration's typeIdx/body wins (`literals.ts:2001-2004`
update path) — so BOTH `a.valueOf()` and `b.valueOf()` call the LAST literal's
body. Result: `7`'s object and `100`'s object both coerce via `()=>100` ⇒
`"101,101"`. That is the bug, exactly.

The host-export twin is `index.ts:3310-3320` ("Check for standalone method:
StructName_toString/_valueOf") — same name-keyed collapse for `String(obj)`/`+obj`.

### Why this is genuinely harder than the closure-field case

For `valueOf:`-arrow properties the method IS a per-instance value (a closure
struct stored in the field), so per-instance dispatch is "read field 0 funcref"
(the B′ fix). For method-SHORTHAND there is **no per-instance value at all** —
the method is a single shared standalone function selected by struct-type name.
Two same-shape literals with different method BODIES are two different functions
that got collapsed under one `${typeName}_valueOf` name. To dispatch
per-instance you must make the method per-instance, i.e. store a funcref to the
correct standalone function IN the struct so each literal carries its own.

### Recommended fix (method-shorthand): store the method funcref in the struct

1. **Field-type:** when an object literal has a method-shorthand `valueOf`/
   `toString` (`literals.ts:1921` method-decl branch), add a struct field
   `valueOf`/`toString` of type `funcref` (or a typed `ref <funcTypeIdx>` to the
   method's function type) — NOT eqref, NOT a standalone-only function. The
   field stores `ref.func ${typeName}_valueOf_<literalN>` where each literal gets
   a DISTINCT standalone function (do NOT collapse same-shape literals' method
   bodies under one `fullName` — disambiguate the function name per literal so
   `()=>7` and `()=>100` are separate funcs, then store each instance's own
   funcref in its struct).
2. **Construction (`literals.ts`):** after compiling each literal's method to its
   own standalone function, `ref.func` that function and store it into the new
   funcref field of THAT instance's struct.new.
3. **Coercion (`type-coercion.ts`):** for a struct whose `valueOf`/`toString`
   field is the funcref type, `struct.get` the field from the instance and
   `call_ref` it with `this = the instance` — fully per-object. This replaces the
   `${name}_valueOf` name-keyed lookup at `:2054` for the funcref-field case.
4. **Host export (`index.ts:3310`):** read the same per-instance funcref field
   instead of the name-keyed `${structName}_valueOf`.

The blocker is the same DEDUP that causes the bug: same-shape literals currently
share `${typeName}_valueOf`, and the struct dedup (`index.ts:9264` hashKey)
unifies their struct types. The `methodSigParts` hash (`index.ts:9248-9257`)
keys on arity + RETURN TYPE, not body — so `()=>7` and `()=>100` (both
`#0->number`) dedup to the same struct AND the same method name. **The fix must
break that collapse for valueOf/toString**: either (a) give each literal a
distinct method function and store its funcref per-instance (so the struct TYPE
can still dedup but the VALUE differs per instance — preferred, this is the
whole point of per-instance dispatch), or (b) stop deduping structs that carry
valueOf/toString method-shorthand (cruder, type-count blowup).

Prefer (a): structs still dedup (same shape), but the funcref FIELD value is
per-instance, so `a` stores `ref.func valueOf_for_7` and `b` stores
`ref.func valueOf_for_100`. This is the same architecture as the closure-field
B′ fix, unified: **make valueOf/toString a per-instance funcref field for BOTH
the arrow-property and method-shorthand forms**, and have coercion always
`struct.get`+`call_ref` the field. One mechanism covers both repro variants and
the cross-function variant.

### Revised feasibility
This is **harder than the original `feasibility: medium` downgrade implies** for
the method-shorthand case — it requires a struct-field addition + construction
change + breaking the method-name collapse, touching `literals.ts` (method
compile + struct.new), `index.ts` (field-type + host export + dedup interaction),
and `type-coercion.ts` (both valueOf/toString hint paths). Keep
`reasoning_effort: high`. Recommend **senior-dev**, and sequence carefully with
#2009 (both touch `literals.ts` struct construction and `index.ts:9242-9264`
anon-struct building). The arrow-property B′ sub-fix is the smaller half and
could ship first as a confidence-builder, but the repro needs the
method-shorthand half.

### Test must cover BOTH property forms
- `{ valueOf() { return 7 } }` (method shorthand — the actual repro)
- `{ valueOf: () => 7 }` (arrow property — the eqref-closure path)
- `{ valueOf: function() { return 7 } }` (function-expression property)
All three of `a`/`b` same-shape must coerce per-instance to `"8,101"`.
