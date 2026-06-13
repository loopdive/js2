---
id: 1989
title: "ToPrimitive valueOf dispatch keyed by struct type name, not object identity — last same-shape literal's valueOf wins for ALL coercions"
status: suspended
sprint: 62
created: 2026-06-10
updated: 2026-06-13
priority: high
feasibility: hard
reasoning_effort: max
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

## Suspended Work (2026-06-12, dev-c)

- **Worktree**: `/workspace/.claude/worktrees/issue-1989-valueof-dispatch`
  (branch `issue-1989-valueof-dispatch`, NO code changes committed — analysis only)

### Confirmed root cause (current main, line numbers re-verified)
The field-type decision is **`src/codegen/index.ts:9231-9235`** (not the
`literals.ts:9314` cited in the plan — that line doesn't exist; `literals.ts`
is ~2500 lines). When a callable `valueOf`/`toString` object property would be
`externref`, it is stored as **`{ kind: "eqref" }`** "so coercion can recover
the closure and call it via call_ref". `eqref` cannot carry the closure's
typeIdx, so the ToPrimitive eqref path
(`src/codegen/type-coercion.ts:1928+`) falls back to the name-keyed
`ctx.valueOfClosureTypes.get(typeName)` lookup, which collides across
same-shape literals.

### The correct per-instance path already exists and is sound
`src/codegen/type-coercion.ts:1871-1905` (the `ref`/`ref_null` valueOf branch)
does the RIGHT thing per instance: `local.set` the struct, `struct.get` the
valueOf field, `struct.get` field 0 (funcref), `call_ref` — **no name-keying**.
It only requires `valueOfField.type` to be `{ kind: "ref_null", typeIdx:
<closureTypeIdx> }` where `closureInfoByTypeIdx.get(closureTypeIdx)` resolves.

### The blocker (why this is reasoning_effort: high)
Chicken-and-egg ordering: the field TYPE is decided at **shape-build time**
(index.ts:9234), but the closure's concrete `typeIdx` is only produced at
**construction time** when `emitObjectMethodAsClosure(...)` compiles the method
(`literals.ts:1466`, returns `closureType`). To flip the field type to a typed
closure ref, the shape builder must resolve the closure typeIdx UP FRONT from
the property's call signature.

### Exact resume plan
1. In `src/codegen/index.ts` near line 9234, instead of `{ kind: "eqref" }`,
   resolve the closure typeIdx for the property's call signature (arity +
   return type) — investigate how `emitObjectMethodAsClosure` derives/registers
   the closure struct typeIdx and whether a per-signature **base closure type**
   is registered in `ctx.closureInfoByTypeIdx` early enough. If a base closure
   supertype per `(arity, retType)` exists (or can be pre-registered in the same
   pass that registers the method placeholder funcType, index.ts:9237-9244),
   store the field as `{ kind: "ref_null", typeIdx: baseClosureTypeIdx }`.
2. Confirm the construction path: `literals.ts:1466-1487` already emits the
   typed closure value; with a typed-ref field it stores it directly (the
   `field.type.kind === "ref"/"ref_null"` branch at 1476-1486 handles the
   typeIdx match; ensure the closure typeIdx the builder picked == the one
   `emitObjectMethodAsClosure` emits, else the 1476-1485 mismatch branch drops
   it to null — THIS is the alignment to get right).
3. The eqref path (type-coercion.ts:1928+) and the host export
   (index.ts:3616 `__valueOf`/`__toString`) then become fallbacks only.
4. Property-assignment form (`{ valueOf: () => 7 }`, literals.ts:1500-1517) also
   needs the typed-ref field — same flip.

### Repro (verified on main)
`String(a+1)+","+String(b+1)` with `a={valueOf(){return 7}}`,
`b={valueOf(){return 100}}`: **wasm THROWS "Cannot convert object to primitive
value"** (worse than the doc's "101,101"); node = `"8,101"`. Probe via
`compileToWasm`/`evaluateAsJs` from `tests/equivalence/helpers.js`.

### Why suspended not completed
Solving the up-front closure-typeIdx resolution (step 1) cleanly is the high-
effort core and warrants a dedicated focused pass or senior-dev — rushing it
risks the 1476-1485 typeIdx-mismatch silently nulling the field (regressing all
object-literal valueOf/toString). No partial code committed to avoid a
half-done state.

## CORRECTED root-cause analysis (2026-06-13, sdev) — the plan targets the WRONG layer

Deep WAT inspection (JS-host mode, `compile(src)` then run) shows the
architect's "Implementation Plan" and dev-c's resume plan both target the
**dispatch field type** (eqref vs typed closure ref) — but that is **not** the
bug. There are at least THREE stacked defects, none fixed by the planned change:

### Defect A — method bodies are deduplicated by struct shape (last literal wins)
`{valueOf(){return 7}}` and `{valueOf(){return 100}}` share the SAME anon struct
shape `$__anon_0`, so they compile to **ONE** shared method body
`$__anon_0_valueOf`, and the **last-compiled body overwrites** — the emitted WAT
has a single `(func $__anon_0_valueOf (result f64) f64.const 100)`. BOTH
per-literal trampolines (`__obj_meth_tramp___anon_0_valueOf_1` and `_2`) call
`call 5` = that ONE shared body. So even a *perfect* per-instance `call_ref`
reaches the same body returning 100. The dispatch field-type change the plan
proposes cannot fix this — it is a body-dedup problem.

The existing per-literal fork (#1557/#1602, `literalMethodFuncIdx`,
literals.ts:1390-1517) only forks when the methods have **different
SIGNATURES** (`sameArity && sameParamTypes` → skip). Same-shape literals with
identical signatures but **different bodies** (exactly #1989) are NOT forked.
Fixing this means forking a per-literal body whenever same-shape literals have
structurally different method bodies — which defeats the load-bearing struct/
type dedup and needs an expensive "bodies differ" detection. Large, risky.

### Defect B — `a + 1` never reaches the in-module valueOf dispatch
Even a SINGLE literal `{valueOf(){return 7}}; a + 1` throws
**"Cannot convert object to primitive value"**. The `test` body lowers to host
`call 0/1/2` (`__to_primitive`-family), NOT the per-instance `call_ref` path in
`type-coercion.ts:1871`. So the binary-`+` ToPrimitive lowering for an
`any`-typed object-with-valueOf does not route to the in-module dispatch the
plan assumes is already firing. (The plan's claim "the correct per-instance
path already fires" is false for this expression shape.)

### Defect C — the host `__to_primitive` cannot reach the WasmGC valueOf closure
Because B falls to the host helper, and the host has no access to the WasmGC
struct's valueOf closure (it is a GC ref, not an externref method), the host
throws — hence the repro is *worse* than the doc's "101,101": it throws.

### Verdict — re-suspended pending architect re-spec
This is a **multi-layer architectural problem** (object-literal method-body
dedup + binary-op ToPrimitive routing + host/Wasm closure bridging), not the
single-PR dispatch-field-type change scoped by the architect. A correct fix
needs an architect re-spec across literals.ts (per-body forking),
binary-ops.ts / type-coercion.ts (route `+` / `String()` ToPrimitive on
any-objects to the in-module per-instance `call_ref`), and possibly the host
bridge. No code committed (the planned change would not fix the repro and risks
regressing all object valueOf/toString via the 1580-1589 typeIdx-mismatch
null-out). Siblings: #2009 (field-name keying), #2022/#1990/#2059 (ToPrimitive
routing family). **status: suspended.**
