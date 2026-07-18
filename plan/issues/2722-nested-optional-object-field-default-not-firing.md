---
id: 2722
title: "Nested OPTIONAL object-field binding default not firing — Path A INVALIDATED, needs substrate re-spec"
status: blocked
created: 2026-06-26
updated: 2026-06-26
priority: medium
feasibility: hard
model: fable
reasoning_effort: high
needs_arch_spec: true
task_type: fix
area: codegen, type-resolver
language_feature: destructuring, optional-properties
goal: test262-conformance
sprint: Backlog
parent: 1556
related: [1542, 1543, 1544, 1550, 1556]
owner_role: architect
---
# #2722 — Nested optional object-field destructuring default not firing

## Path A INVALIDATED — floor-unsafe (2026-06-26, sd-accessor)

> **The architect's "two small edits" Path A prototype is INVALID. It validated
> 4 synthetic repros but BREAKS the dstr floor in every configuration. Routed
> back to the architect for a genuine substrate re-spec (status: blocked,
> needs_arch_spec). PR #2145 was closed.**

Verified with a bounded **1,660-file object-pattern dstr sweep** (for-of /
for-await-of / variable / class / function / arrow dstr families) diffed against
the merged baseline, with a per-edit bisection:

| Config | Net | Regression cluster |
|---|---|---|
| **Both edits** (the committed PR #2145) | **-38** (44 regr / 6 impr) | `*obj-ptrn-prop-obj-value-null` + `*dflt-obj-ptrn-prop-obj-init` |
| **Change 1 only** (#1589A `resolvedIsEmpty` gating) | breaks the same cluster | forces EVERY optional-object field to `ref_null struct`; nested-pattern fields whose value isn't built as a matching struct then deref **`ref.null`** → *"Cannot destructure 'null' or 'undefined'"* (and the null-`TypeError` assertion mis-fires) |
| **Change 2 only** (`literals.ts` `T\|undefined`→`T` strip) | **-18** (24 regr / 6 impr) | `*dflt-obj-ptrn-prop-obj` → `assert.sameValue(x, undefined)` FAILS: building `{}` defaults as structs gives an absent field a **sentinel/0 instead of `undefined`** |

**No configuration is net ≥ 0.** The change fixes only **6** test262 tests while
breaking **18-44**. Bisection proves the two edits perturb the *shared* nested-
object-pattern representation in opposite-but-both-wrong directions — neither is
salvageable by narrowing. This matches #1556's original warning verbatim ("a
type-resolver representation change, not a focused dstr-codegen edit; **do not
ship a fragile partial**", ~150-200 LOC).

### What a correct fix actually requires (#1556 Path A, properly)

Represent optional object fields as **nullable struct refs** (`ref null structB`)
**AND thread that nullable type through `function-body.ts` param-type resolution**
so the destructure reader sees a struct ref (running the in-Wasm sentinel check),
not externref — **AND** ensure every value source (caller-built literal, nested
`= {}` default, outer `= {}` default) is *constructed* as the matching struct in
*all* nested-pattern shapes (not just the 2-member `T|undefined` contextual-type
case Change 2 covered). The `prop-obj`/`prop-obj-value-null`/`prop-obj-init`
clusters above are the regression gate the substrate version must clear. This is
the ~150-200 LOC substrate task #1556 scoped, not a 2-edit shortcut.

### Regression-gate files the substrate fix MUST keep green (sampled)
- `language/expressions/class/dstr/{meth,gen-meth,*-static}-dflt-obj-ptrn-prop-obj.js` (Change-2 cluster)
- `language/**/dstr/*dflt-obj-ptrn-prop-obj-init.js` (Change-1 cluster)
- `language/**/dstr/*obj-ptrn-prop-obj-value-null.js` (Change-1 cluster)

---


**Carved from #1556** (verify-first by dev-1556b, 2026-06-26). #1556's core scope
(the #1543/#1544 illegal-cast cluster + single-level defaults) is **done**. This
is the narrow architectural residual it left behind. Recommended owner:
**senior-developer / architect** — it is a type-resolver representation change,
not a focused dstr-codegen edit. **Do not ship a fragile partial.**

## Repro (verified failing on current `origin/main`)

```ts
function f({ a: { b = 3 } = {} }: { a?: { b?: number } } = {}): number { return b; }
```

| Call | Got | Want |
|------|-----|------|
| `f()`              | 0 | 3 |
| `f({ a: {} })`     | 0 | 3 |
| `f({ a: { c: 1 }})`| 1 | 3 |
| `f({ a: { b: 5 }})`| 5 | 5 ✅ (inner literal HAS the field) |

Contrast — these all PASS today, so the defect is precisely "nested + optional field":

```ts
// required nested field → struct-ref path → works
function g({ a: { b = 3 } }: { a: { b?: number } }): number { return b; }
g({ a: {} })    // => 3 ✅
// single-level optional default → works
function h({ b = 3 }: { b?: number } = {}): number { return b; }
h(); h({});     // => 3 ✅
// array-element nested object default → works
function m([{ b = 3 } = {}]: Array<{ b?: number }> = []): number { return b; }
m(); m([{}]);   // => 3 ✅
```

Harness used: `tests/equivalence/helpers.ts` `compileToWasm`. (`compile` is async
— `await` it.)

## Root cause (WAT + `src/runtime.ts` trace)

1. **`a?` is the union `{b?:number} | undefined`.** `resolveWasmType` of a union
   yields **externref**, so the param-struct field `a` is typed `externref` —
   NOT a `(ref null structB)`. A *required* `a` keeps a struct ref, which is why
   the required twin `g` works.
2. The inner `{}` / `{c:1}` value (whether caller-built or the nested `= {}`
   default) is built as a WasmGC struct that does **not** match the `{b}` struct
   type (`struct-7` in the trace), then boxed to externref (`extern.convert_any`).
3. The destructuring reads `b` via host `__extern_get` → `__sget_b`. The generated
   `$__sget_b`'s else branch (object fails `ref.test (ref 7)`) returns
   `f64.const 0`. So `__extern_get` hands back JS `0`, `__extern_is_undefined(0)`
   is false, and the `b = 3` default never fires (`f({a:{c:1}})` returns `1`
   because field 0 of the `{c}` struct is read instead).
   **An f64-returning struct getter cannot represent "field absent" across the
   host boundary** — the f64 undefined-sentinel (NaN bits) round-trips to JS
   `NaN`, not `undefined`, so even returning the sentinel wouldn't help.
4. The required-field path works because field `a` is a real struct ref →
   `ref.test (ref 7)` succeeds → the struct fast path runs the **in-Wasm**
   `i64.reinterpret_f64` undefined-sentinel check, firing the default with no
   host roundtrip.

Relevant code:
- `src/codegen/index.ts:11559+` — `ensureStructForType` field-type resolution;
  the union/optional → externref widening (and the existing #1468 / #1589A
  externref-widening guards for `undefined`-typed and empty-object fields).
- `src/codegen/destructuring-params.ts:958` — nested-pattern recursion in
  `destructureParamObject`; `:805` — the externref-arm `ref.test`/`__extern_get`
  fast path.
- `src/codegen/statements/destructuring.ts:453` — `emitNestedBindingDefault`
  (builds the nested `= {}` default as a boxed struct).
- `src/runtime.ts:7409` — host `__extern_get` (struct-getter fallback at :7444
  calls `__sget_<key>`, which returns the f64-0 garbage for a non-matching
  struct).

## Path options (architect chooses)

- **Path A (recommended)** — represent optional object fields as **nullable
  struct refs** (`ref null structB`) instead of externref in `ensureStructForType`,
  so the struct fast path with the in-Wasm sentinel check handles them. Requires
  recognising the optional/`T | undefined` member case, registering/using the
  inner struct as nullable, and threading the nullable type through
  `function-body.ts` param-type resolution so the destructure reader sees a
  struct ref, not externref. Issue #1556's estimate: ~150–200 lines. Regression
  gate: full `language/destructuring/*`, `for-of/dstr/`, `for-await-of/`,
  `class/dstr/`, `function/dstr/`, `arrow-function/dstr/` families — net pass ≥ 0
  on every dir.
- **Path B** — build `{}`/partial literals assigned to externref fields as plain
  objects (`__new_plain_object`) so `__extern_get` returns `undefined` for
  missing fields. Touches object-literal codegen (`literals.ts`) + call-site
  coercion — the flagged "150+ regression" surface from #1556.
- **Path C** — struct-getter representation that can signal absence (substrate).
  Broadest blast radius.

## Acceptance criteria

- All four `f(...)` repros above return the spec-correct value (3/3/3/5).
- The `g`/`h`/`m` controls (and the existing #1542/#1543/#1544 guard tests) stay
  green.
- Guard test added at `tests/issue-2722.test.ts` covering: `f()`, `f({})`,
  `f({a:{}})`, `f({a:{c:1}})`, `f({a:{b:5}})`, plus the required/single/array
  controls.
- No net test262 regression on the dstr families (regression gate above).

## Notes

- A focused partial (make `emitNestedBindingDefault`'s `{}` a plain object) would
  fix only the default-built cases (`f()`, `f({})`) and leave caller-built ones
  (`f({a:{}})`, `f({a:{c:1}})`) broken. **Do not ship it** — incomplete + fragile.
- Parent #1556 carries the full verify-first verdict.

## Implementation Plan (Path A) — architect, verified on `origin/main` @ 30bc55b

> **The root cause is narrower than the issue's hypothesis, and the fix is far
> smaller than the #1556 ~150–200 LOC estimate.** I re-traced it end to end on
> current main (probe + WAT) and **prototyped the complete fix — it is two small,
> coordinated edits (~10 lines total), no `function-body.ts` threading.** All four
> repros pass (3/3/3/5) and every control (`g`/`h`/`m`) stays green. Details below.

### Corrected root cause (supersedes §"Root cause" point 1)

`resolveWasmType` of the union `{ b? } | undefined` does **NOT** yield externref.
The union branch at **`src/codegen/index.ts:11398-11407`** already filters the
nullish member and returns `{ kind:"ref_null", typeIdx: <structB> }` (verified:
DBG trace prints `inner kind ref tidx 10`). The externref comes from a **later
override inside `ensureStructForType`**: the **#1589A empty-object widening guard
at `index.ts:11604-11614`**:

```ts
if ((wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
    callSigs.length === 0 &&
    propType.getProperties().length === 0) {           // ← FALSE-POSITIVE on T|undefined
  ... wasmType = { kind: "externref" };
}
```

`propType` here is the **union** `{ b? } | undefined`. `ts.Type.getProperties()`
on a union returns only the **common** properties; intersected with `undefined`'s
empty set that is **always `[]`**. So the guard mistakes *every* optional object
field for a "genuinely empty `{}`" and clobbers the correct `ref_null structB`
back to externref. That is the whole defect. (The required twin `g` has a
non-union `{ b? }` propType → `getProperties().length === 1` → guard never fires →
field stays a struct ref → works.)

Once the field is externref, the value flowing into it is built as a host object
and read back via `__extern_get`/`__sget_b`'s f64-`0` else-branch — exactly the
downstream symptom the issue describes. Fixing the representation at the guard
removes the entire host-getter path.

### Change 1 — resolver: stop #1589A clobbering a populated struct

**File: `src/codegen/index.ts`**, the #1589A guard at **`:11604-11614`**.
Gate the widening on the **resolved struct actually being empty** (0 fields),
instead of the union's common-property count. The resolved struct is already
registered by the time we reach here, so its field list is in `ctx.structFields`:

```ts
if ((wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
    callSigs.length === 0 &&
    propType.getProperties().length === 0) {
  const refTypeIdx = (wasmType as { typeIdx: number }).typeIdx;
  const refStructName = ctx.typeIdxToStructName.get(refTypeIdx);
  const resolvedFields = refStructName ? ctx.structFields.get(refStructName) : undefined;
  const resolvedIsEmpty = !resolvedFields || resolvedFields.length === 0;   // NEW
  if (refStructName !== "__Date" && resolvedIsEmpty) {                       // + resolvedIsEmpty
    wasmType = { kind: "externref" };
  }
}
```

- **Preserves #1589A's original intent**: a *genuinely* empty `{}` field resolves
  to an **empty** struct (0 fields) → `resolvedIsEmpty === true` → still widened
  to externref (verified: a sibling empty-object field in the same compile still
  reports `emptyResolved true` and stays externref). HasProperty / `indexOf.call`
  behavior is unchanged.
- **Fixes the optional-non-empty case**: `a?: { b? }` resolves to `structB`
  (1 field) → `resolvedIsEmpty === false` → keeps `ref_null structB`.
- After this, the **existing `ref → ref_null` field widening at `:11644-11649`**
  applies to the new struct field exactly as it already does for required fields,
  so `struct.new` can default it to `ref.null`. No new widening logic needed.

### Change 2 — construction: build optional-typed literals as structs

Change 1 alone is **necessary but not sufficient**. Field `a` is now
`ref_null structB`, but the *value* built for it is still wrong: the inner
`{}` / `{c:1}` literal (both caller-built **and** the nested `= {}` default) is
compiled against the **union** contextual type, which `resolveStructName` cannot
map → the literal is built as a host externref → coerced into the struct field via
`ref.test`→`ref.cast`-or-`ref.null` → the test fails → the field stores
**`ref.null`** → the nested destructure throws *"Cannot destructure 'null' or
'undefined'"* (verified WAT: `struct.new 4; extern.convert_any; … ref.test (ref 0);
(else ref.null 0)`). The required twin avoids this because its inner literal's
contextual type is the non-union `{ b? }`, which builds `struct.new structB` with
`b = sNaN-sentinel` directly.

**File: `src/codegen/literals.ts`**, `compileObjectLiteral`, at the contextual
struct-name resolution **`:1101-1110`**. Strip a 2-member `T | undefined` union to
`T` before `resolveStructName` (mirror the resolver union branch at
`index.ts:11398`):

```ts
let effectiveContextType = contextType;
if (contextType.isUnion()) {
  const nn = contextType.types.filter(
    (t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined) && !(t.flags & ts.TypeFlags.Void),
  );
  if (nn.length === 1 && contextType.types.length === 2) effectiveContextType = nn[0]!;
}
let typeName = resolveStructName(ctx, effectiveContextType);
if (!typeName) {
  ensureStructForType(ctx, effectiveContextType);
  typeName = resolveStructName(ctx, effectiveContextType);
}
if (typeName) {
  ensureComputedPropertyFields(ctx, fctx, expr, effectiveContextType);
  return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
}
```

This makes the inner `{}` / `{c:1}` build as a `structB` (absent fields →
sentinel, excess fields dropped) for **all three** value sources at once:
caller-built `f({a:{…}})`, the nested `= {}` binding default (compiled via
`emitNestedBindingDefault` → `compileExpression(initializer, ref_null structB)`),
and the outer `= {}` param default. **Scope is narrow**: it only "upgrades" to a
struct when the stripped `T` resolves to an already-registered struct name; any
`T` that maps to externref (host classes, `any`, empty `{}`) still falls through
to the unchanged externref/inferred-type path below. It is **purely additive to
the existing struct branch** — it does not touch the externref-field path Path B
would have rewritten.

### Why NO `function-body.ts` / destructure-reader threading is needed

The issue anticipated threading the nullable type through `function-body.ts`.
**It isn't required.** The field-type change flows automatically through
`ctx.structFields`, and the struct-read destructure path already handles a
nullable-struct field with a nested `= {}` default:
- `destructure-params.ts:957-982` reads the field with `struct.get`, then
  `emitNestedBindingDefault(…, fieldType=ref_null structB, initializer={})`
  (`statements/destructuring.ts:461-478`, the `ref`/`ref_null` arm) fires its
  `ref.is_null` check and substitutes the `{}`-built struct, then recurses via
  `destructureParamObject(…, convertedType=ref_null structB)`.
- The inner `b` read then runs the **in-Wasm** sentinel check
  (`emitDefaultValueCheck`, `statements/destructuring.ts:553+`, f64 sNaN arm) and
  fires `b = 3` with no host roundtrip — identical to the working required twin.

So the only edits are Change 1 + Change 2.

### Prototype result (validated, then reverted — left for the dev to (re)apply)

With both changes applied I ran the in-Wasm harness (`compileToWasm`; args built
inside TS and the function called internally, because a WasmGC **struct param
cannot be passed directly from JS** — `instance.exports.f({…})` throws
"type incompatibility", which is why the repro must construct args in-Wasm):

| case | before | after |
|------|--------|-------|
| `f()`            | 0 (THREW pre-C2) | **3** |
| `f({})`          | 0 | **3** |
| `f({ a: {} })`   | 0 | **3** |
| `f({ a: { c:1 }})` | 1 | **3** |
| `f({ a: { b:5 }})` | 5 | **5** |
| `g({ a:{} })` (req twin)      | 3 | **3** |
| `h()` (single-level)          | 3 | **3** |
| `m()` (array-elem nested)     | 3 | **3** |

### Edge cases (confirm in the guard test)

- **Deeper nesting** (`{ a:{ b:{ c=5 }={} }={} }: { a?:{ b?:{ c?:number } } }`):
  both changes apply at every level (each level's guard sees a populated struct;
  each nested `{}`'s contextual type is that level's `T|undefined` union). Add a
  3-level case.
- **Mixed optional + required** (`{ a?:{…}, d:{…} }`): `a` takes the new struct
  path, `d` the pre-existing one. Both are `ref_null structB` after `:11644`.
- **Optional field, NO default, NO nested pattern** (`function f({ a }: { a?:{b?} })`):
  `a` binds to `ref_null structB`; omitted → `ref.null` → `a` is `undefined`
  (correct). Plain bind, no `emitDefaultValueCheck` invoked.
- **Optional PRIMITIVE field** (`{ a?: number }`): union → f64 (no ref), guard's
  `ref`/`ref_null` precondition fails → untouched.
- **Genuinely-empty optional object** (`{ a?: {} }`): inner `{}` has 0 props →
  `resolveWasmType` returns externref (never a struct) → union returns externref →
  guard's `ref`/`ref_null` precondition fails → **stays externref** (correct; no
  fields to default). `resolvedIsEmpty` only matters for the already-registered
  empty-struct case and keeps it widened.

### Regression surface — why Path A here AVOIDS Path B's "150+ regressions"

Path B rewrote how `{}`/partials assigned to **externref** fields are built
(host plain object + call-site coercion) — a global change to the externref
object path touching every dstr/object-literal site. **This Path A does the
opposite and stays inside the struct path**:
- Change 1 only flips fields whose union member resolves to a **populated**
  struct; the empty-`{}` externref behavior (#1589A's reason to exist) is byte-
  preserved.
- Change 2 only "upgrades" a literal to a struct when `T` already maps to a
  registered struct; it never alters the externref/host-object branch.
- No `__sget_*` / `__extern_get` / runtime change; no `function-body.ts` change.

Both edits are gated on the specific `T | undefined`-with-a-real-struct shape, so
the blast radius is optional-object-typed slots only.

### Floor-safe slice plan (single PR)

This is small and cohesive — **one PR, two edits + a guard test**:
1. **Change 1** (`index.ts:11604` guard) — flips the field rep. On its own it
   makes `t0`/`t1` throw "Cannot destructure null" (expected intermediate);
   **do not commit alone**.
2. **Change 2** (`literals.ts:1101` union-strip) — completes the fix.
3. **Guard test** `tests/issue-2722.test.ts`: `f()`, `f({})`, `f({a:{}})`,
   `f({a:{c:1}})`, `f({a:{b:5}})` (build args in-Wasm and call internally, per the
   struct-param-marshaling note above), plus controls `g({a:{}})`, `h()`, `m()`,
   and a 3-level-deep nested-optional case. Assert via internal exports returning
   `number`.
4. **CI regression gate** (the #1556 list): net pass ≥ 0 on each of
   `language/destructuring/*`, `for-of/dstr/`, `for-await-of/`, `class/dstr/`,
   `function/dstr/`, `arrow-function/dstr/`. Watch specifically for object-literal
   representation flips in `expressions/object/` (Change 2 surface).
5. **Standalone floor**: validate on `merge_group` (object-literal construction
   differs under `ctx.standalone`'s `$Object` routing — Change 2 sits *after* the
   `:1013` standalone `$Object` diversion, so standalone non-empty literals still
   route to `$Object` first; the union-strip only affects the closed-struct
   fallthrough, but confirm no floor delta).

### Files / functions touched (final)

- `src/codegen/index.ts` — `ensureStructForType`, #1589A guard `:11604-11614`
  (add `resolvedIsEmpty`).
- `src/codegen/literals.ts` — `compileObjectLiteral` `:1101-1110` (union-strip
  before `resolveStructName`).
- `tests/issue-2722.test.ts` — new guard test.

No edits to `destructuring-params.ts`, `statements/destructuring.ts`,
`function-body.ts`, `runtime.ts`, or `property-access.ts`.
