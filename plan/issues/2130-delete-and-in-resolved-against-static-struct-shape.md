---
id: 2130
title: "delete o.prop is a no-op and `in` answers against the static struct shape — post-delete / dynamic-key / object-rest all wrong"
status: done
sprint: 62
created: 2026-06-12
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/d1
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [1821, 492, 1112, 1991, 2179]
renumbered_from: "residual of #1821 (done) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2130 — `delete` / `in` ignore runtime object shape (static-struct resolution)

## Resolution (2026-06-16, Stage A — the titled `in`/hasOwnProperty defect)

**Done:** `in` and `Object.prototype.hasOwnProperty` now consult the runtime
presence model (delete tombstone + sidecar) via a single shared predicate
`_wasmStructHasOwn` (`src/runtime.ts`), instead of the static struct shape.
`__hasOwnProperty` and `__extern_has` (the `in` operator) both route through
it. The buggy module-global `__sget_<key>` existence probe in `__extern_has`
(which reported any field-name present in *any* struct type as present on
*every* receiver, and never consulted the tombstone — architect addendum A1)
was deleted. `_safeGet` is tombstone-gated and `_safeSet` clears the tombstone
on re-add (A3/A5). Tests: `tests/issue-2130-delete-in-presence.test.ts` (7
cases, all green). Verified `delete o.a; "a" in o` → false; object-rest
`"e" in rest` → false; `o.x = undefined; "x" in o` → true; delete-then-re-add
restores `in`.

**Deferred to #2179 (architect addenda A6/A7 — never in #2130's deliverable):**
the post-delete struct **read** path for statically-resolvable receivers
(`const o:any={a:1,b:2}; delete o.a; o.a === undefined`). The `any` read
compiles to an inline `ref.test`+`struct.get` fast-path that reads the live
f64 field (bypassing the runtime tombstone), and `=== undefined` is
constant-folded on the f64 field type. Fixing it requires routing such reads
through `__extern_get` for delete-using modules — which breaks standalone/WASI
(no `__extern_get` host import) and needs representation-steering. Tracked as a
separate `feasibility: hard` codegen concern in #2179.

## Problem

`in` is resolved at **compile time** against the source object's struct shape,
and `delete` on a literal object is a no-op on the underlying struct. So any
object whose runtime shape differs from its declared struct (post-delete
objects, object-rest objects) answers `in` wrong, and the deleted value is
still readable.

```ts
// delete is a no-op on the struct: value survives AND `in` stays true
const o: any = { a: 1, b: 2 };
delete o.a;
o.a                      // wasm: 1      node: undefined
"a" in o                 // wasm: true   node: false

// dynamic-key delete also a no-op
const k = "a";
delete o[k];
"a" in o                 // wasm: true   node: false

// object-rest: rest has no `e`, but `in` answers from the SOURCE struct shape
const { e, ...rest } = { e: 3, f: 4 };
"e" in rest              // wasm: true   node: false
// (rest CONTENTS are correct: rest.e === undefined, Object.keys(rest) === ["f"])
```

## Root cause

`in` lowering resolves the key against the receiver type's struct fields at
compile time and emits an `i32.const` (`src/codegen/binary-ops.ts:486-583`,
the `InKeyword` path). It never consults the runtime `__delete_prop` /
presence sidecar, so a property that was deleted at runtime — or never existed
on a rest object whose declared type still carries the field — is reported
present. The `delete` codegen for literal objects similarly doesn't clear the
struct field or mark the sidecar (#1821 fixed only the literal-key
`__delete_prop` sidecar for the *dynamic-key element-access* read path, not
the struct-field case, and not `in`).

This is the **false-positive** mirror of **#1991** (`in` never consults the
prototype chain → false negatives for inherited members). A unified fix would
route `in` through a runtime presence check that combines: own struct fields,
the runtime presence/delete sidecar, and (per #1991) the prototype chain.

## Acceptance criteria

- `const o:any={a:1,b:2}; delete o.a; o.a` → `undefined`
- `… "a" in o` after `delete o.a` → `false`
- dynamic-key `delete o[k]` removes the property (`in` → `false`, read →
  `undefined`)
- `const {e,...rest}={e:3,f:4}; "e" in rest` → `false` while
  `Object.keys(rest)` stays `["f"]`
- No regression on `in` for present own properties or array index `in`
- Equivalence tests under `tests/`

## Notes

`feasibility: hard` — touches the `in` lowering, `delete` lowering, and the
runtime presence model; coordinate with #1991 so both directions land on one
presence predicate rather than two divergent paths. Verified on main
`c19a2e9c1` via `.tmp/triage.mts` / `.tmp/triage2.mts` (branch
`po-1971-triage`). JS-host mode, default options.

---

## Implementation Plan (joint with #1991 — shared presence predicate)

> **The canonical shared design lives in `#1991`'s `## Implementation Plan`.**
> Read it first. This issue is **Stage A + Stage B** of the staged landing
> order defined there; #1991 is Stage C. Stage A is the shared refactor that
> #1991 also depends on, so land A before C.

### Root cause (recap — full version in #1991)

Two faces of one defect. The `in` operator and `delete` operate against the
**static struct shape**, never the runtime presence/delete sidecar:

- `in` on an `any`/cast receiver routes to `__extern_has`
  (`src/runtime.ts`, ~line 6343), which — unlike `__hasOwnProperty`
  (~line 8781) — **never consults the delete tombstone**
  `_wasmStructDeletedKeys`. So `delete o.a; "a" in o` stays `true`.
- `delete o.a` on a struct **field** sets a NaN/ref-null sentinel
  (`typeof-delete.ts:32` `emitDeleteSentinel`) only on the **static
  struct-field arm** (`typeof-delete.ts:115-196`). For an `any`/cast
  receiver that arm is skipped and delete falls to the `__delete_property`
  runtime arm (`typeof-delete.ts:267-342`), which records the tombstone but
  **cannot clear the struct field** — so the subsequent read `o.a` reads the
  unchanged field via `__sget_a` and returns the stale value (`1`).

Ground truth (this PR's branch, `c19a2e9c1`, JS-host, `setExports` wired):

```
const o:any={a:1,b:2}; delete o.a;
  o.a        → 1      (want undefined)   ← field uncleared
  "a" in o   → true   (want false)       ← tombstone ignored
  "b" in o   → true   (correct)
const k="a"; delete o[k]; "a" in o → true (want false)   ← dyn-key no-op
const {e,...rest}={e:3,f:4}; "e" in rest → true (want false)
```

### Stage A — the `in` false-positive fix (shared; blocks #1991 Stage C)

Implement the shared predicate refactor from #1991's plan:

**File: `src/runtime.ts`**
- Extract `_wasmStructHasOwn(obj, key, exports)` from `__hasOwnProperty`'s
  WasmGC branch (~line 8791-8817) — tombstone-absent AND (sidecar OR
  descriptor OR struct-field). Re-point `__hasOwnProperty` at it (pure
  extraction, no behavior change).
- Rewrite the `__extern_has` arm (~line 6343-6386) so its WasmGC-struct
  branch is `_wasmStructHasOwn(...) || _wasmStructHasInherited(...)` (the
  inherited half is #1991 Stage C; for Stage A landing alone, call
  `_wasmStructHasOwn` and keep the existing inline `_OBJECT_PROTO_KEYS`
  check). The key Stage-A effect: the tombstone is now consulted, so
  `"a" in o` after `delete o.a` returns `false`, and object-rest `"e" in
  rest` returns `false` (the rest struct never had `e` written, and if the
  source struct's typeIdx leaks the field, the tombstone/own-check on the
  *rest* object — which has its own struct shape — answers correctly; verify
  the rest object is a distinct struct, see Stage B object-rest note).

This alone fixes acceptance criteria #2 and the object-rest criterion.

### Stage B — delete actually removes the property (read + dynamic-key)

**(B1) Clear the struct field on the runtime delete path.**

**File: `src/codegen/typeof-delete.ts`** — the `__delete_property` runtime
arm (`267-342`) records the tombstone but leaves the struct field holding
its old value, so reads return stale data. Two options:

- **Preferred:** when the receiver *can* be resolved to a struct type even
  through an `any`/cast (consult `ctx.widenedVarStructMap.get(ident.text)`
  the same way the static arm does at `typeof-delete.ts:118-119`), take the
  static field arm (sentinel `struct.set` + `__delete_property`) instead of
  the pure-runtime arm. The static arm at lines 115-196 already does exactly
  the right thing — extend its **guard** so it fires for widened-`any`
  identifiers, not only for receivers whose TS type resolves to a struct.
  This makes `delete (o as any).a` clear the field AND set the tombstone.
- **Fallback (covers truly opaque receivers):** make the read side
  tombstone-aware. The `__sget_<key>` getter path in property reads should
  return `undefined` when `_wasmStructDeletedKeys.get(obj)?.has(key)`. This
  is a runtime-only guard but adds a tombstone check to every dynamic struct
  read — heavier. Prefer the codegen-side field clear (B1 preferred) and use
  this only for receivers with no resolvable struct type.

**(B2) Dynamic-key delete `delete o[k]`.**

The element-access runtime arm (`typeof-delete.ts:304-324`) compiles the key
as externref and calls `__delete_property`, which DOES set the tombstone
keyed by `String(k)`. So after Stage A, `"a" in o` post `delete o[k]`
already returns `false` (tombstone consulted). The remaining gap is the
**read** `o.a` returning stale — same fix as B1 (the field isn't cleared
because a dynamic key can't be resolved to a static field index). For the
dynamic-key case the read-side tombstone guard (B1 fallback) is the only
option, since the field index isn't known at compile time. Scope: add the
tombstone guard to the dynamic element-read runtime helper
(`__extern_get` / `__sget` dispatch) so a tombstoned key reads `undefined`.

**(B3) `__for_in_keys` tombstone filter.**

**File: `src/runtime.ts`** — `__for_in_keys` (~line 8834) collects struct
field names (line ~8861) **without** filtering the tombstone. The per-visit
`__for_in_has` (#2066, line ~8924) currently masks this for for-in
enumeration, but `Object.keys` / `Object.entries` (which call
`__getOwnPropertyNames`-style helpers) may not. Filter
`_wasmStructDeletedKeys.get(current)` out of the collected `fieldNames` in
`__for_in_keys` and in `__getOwnPropertyNames` (~line 8814 region) so
`Object.keys(o)` after `delete o.a` omits `a`. **Cross-check the
`Object.keys(rest)` acceptance criterion stays `["f"]`** (it currently
passes — do not regress).

### Object-rest specifics

`const {e,...rest}={e:3,f:4}` — confirm the compiler lowers `rest` to a
**distinct struct** containing only `f` (not an alias of the source struct
with `e` still present). If `rest` shares the source struct shape, `"e" in
rest` resolves `e` as an own field and Stage A's own-check returns true
incorrectly. Check the object-rest lowering (grep `ObjectBindingPattern` /
rest-element in `src/codegen/declarations.ts` / `destructuring`); if `rest`
carries the source typeIdx, either (i) build a fresh struct type for the rest
object omitting the bound keys, or (ii) record the omitted keys as tombstones
on the rest object at construction. Prefer (i) — a correct shape is cheaper
than a tombstone the runtime must always consult. The acceptance note says
`rest` CONTENTS are already correct (`rest.e===undefined`,
`Object.keys(rest)===["f"]`), which suggests the rest object's *field set* is
right and only `in`'s static/own resolution is consulting the wrong shape —
verify which, as it decides between (i) and "Stage A already fixes it".

### Edge cases (#2130)

- **delete then re-add:** `delete o.a; o.a=5; "a" in o` → `true`, `o.a` → `5`.
  `_sidecarSet` already clears the tombstone (`runtime.ts:2250-2253`); confirm
  the re-add path (struct.set or sidecar) reaches it.
- **delete non-configurable** (`Object.defineProperty(o,"a",{configurable:
  false})` then `delete o.a`): `__delete_property` returns `0` and keeps the
  property — `"a" in o` must stay `true`. Stage A's own-check via descriptor
  map must still see it.
- **integer keys** (`delete o[0]`, `0 in o`): mirror #1837's integer-key
  helper; tombstone keys are stringified (`String(0)==="0"`) consistently on
  both delete and `in`. Coordinate with #2131 (integer-key enumeration).
- **Symbol keys:** `delete o[sym]; sym in o` — tombstone stores the raw
  symbol (`runtime.ts:8777`); `_wasmStructHasOwn` must compare symbol keys by
  identity, not `String(key)`.
- **null receiver:** `delete (null as any).x` → `__delete_property` returns
  vacuously true (`runtime.ts:8729`); `"x" in null` is a TypeError in real JS
  — but that's #2132's domain, do not change here.

### Test plan (#2130)

Add `tests/issue-2130-delete-in-presence.test.ts` (JS-host; mirror the
`setExports`-wired harness in `tests/fast-arrays.test.ts`):

- `const o:any={a:1,b:2}; delete o.a;` → `o.a===undefined`, `!("a" in o)`,
  `"b" in o`.
- dynamic key: `const k="a"; delete o[k];` → `!("a" in o)`,
  `o.a===undefined`.
- object-rest: `const {e,...rest}={e:3,f:4};` → `!("e" in rest)`,
  `"f" in rest`, `Object.keys(rest)` deep-equals `["f"]`.
- delete-then-re-add round-trips `in` and read.
- non-configurable delete keeps `in` true and returns `false` from `delete`.
- `Object.keys(o)` / `for (const k in o)` omit the deleted key.

test262: `language/expressions/delete/*`,
`language/statements/for-in/*`, `built-ins/Object/keys/*`,
`built-ins/Object/prototype/hasOwnProperty/*` — Stage A touches
`__hasOwnProperty`, must stay green.

## Addendum — verified corrections to the plan (2026-06-12, second architect pass)

Independent re-derivation against main `c19a2e9c1` with fresh probes
(equivalence harness, JS-host). The plan above is architecturally right; the
items below correct or pin down points where it is vague or where the probe
results contradict its assumptions. **Dev: treat these as authoritative where
they conflict with the text above.**

### A1. The `__sget_<key>` probe must be DELETED, not "kept folded in"

Stage A's closing line ("Keep the `__sget_<key>` getter probe folded into
`_wasmStructHasOwn`") is wrong and is the single most likely way this fix
fails review. The probe (`runtime.ts:6359-6373`) is the actual root cause of
the `in` false positives: `__sget_<key>` getters **never throw** —
`buildNestedIfElse` (`src/codegen/index.ts:4047`, default branch) falls
through to `ref.null.extern`/`i32.const 0` for receivers matching no struct
type. So "the getter returned without throwing" (the #1589A heuristic) is
true for *every* receiver whenever *any* struct type in the module has a
field of that name — a module-global check, not a per-receiver one. The
per-receiver shape oracle is `_getStructFieldNames(obj, exports)`
(`runtime.ts:2782`, backed by the `__struct_field_names` ref.test dispatch,
`index.ts:2086-2181`) — already what `__hasOwnProperty` uses at
`runtime.ts:8816`, and what `_wasmStructHasOwn` inherits via the extraction.
Delete the probe lines; do not port them.

### A2. Object-rest needs NO codegen work — close that open question

The "Object-rest specifics" section asks the dev to verify how `rest` is
lowered and sketches building a fresh struct type. Verified: `rest` is built
by the `__extern_rest_object` host import (`runtime.ts:6988-7030`), which
returns a **plain JS object** containing only the non-excluded keys. The
false positive comes entirely from A1: the plain-JS branch of `__extern_has`
misses (`"e" in rest` → false natively), then falls through to the
module-global `__sget_e` probe (the source struct `{e,f}` makes it exist) →
wrongly returns 1. The Stage A rewrite (own/inherited tiers for wasm structs;
native `key in obj` + sidecar for plain JS, with no `__sget_` fallthrough)
fixes rest with zero codegen changes. Drop options (i)/(ii); skip the
fresh-struct work.

### A3. delete-then-re-add is broken TODAY — promote from "confirm" to a fix item

Probe: `const o:any={a:1}; delete o.a; o.a = 5;` then `o.a` reads **1** (the
original value — the re-added `5` is lost). So the edge-case bullet
("confirm the re-add path reaches `_sidecarSet`") understates it: the write
path does NOT clear the tombstone and does not even surface the new value.
`_sidecarSet` clears tombstones (`runtime.ts:2245-2253`) but `_safeSet`
prefers the `__sset_<name>` struct setter (`emitStructFieldSetters`,
`index.ts:1898`), which writes the real struct field and bypasses
`_sidecarSet` entirely. Fix: clear `_wasmStructDeletedKeys` in **`_safeSet`
itself** (single choke point covering both the sidecar and `__sset_` arms),
and add `delete o.a; o.a=5; o.a===5 && ("a" in o)` to the tests — it guards
two distinct regressions.

### A4. `Object.keys` consistency: the real import is `__object_keys`, and it needs the sidecar union too

B3 points at `__for_in_keys`/`__getOwnPropertyNames`, but `Object.keys(o)`
on an `any` receiver routes to `__object_keys` (`runtime.ts:6684`; `values`
6702, `entries` 6725 — chosen in `compileObjectKeysOrValues`,
`src/codegen/object-ops.ts:3046-3063`). Probe confirms: after `delete o.a`,
`Object.keys(o)` is still `["a","b"]`. All three helpers enumerate
`_getStructFieldNames` + the `_SC_ENUMERABLE` filter only. Add (a) the
tombstone filter, and (b) the union of enumerable **sidecar** keys not in the
shape (mirror `__for_in_keys`'s sidecar block, `runtime.ts:8868-8882`) —
without (b), a deleted-then-re-added key (which now lives in the sidecar per
A3) vanishes from `Object.keys` forever. Shape order first, sidecar insertion
order after, matching `__for_in_keys`.

### A5. Read-path tombstone gate: both `__extern_get` AND `_safeGet`

B1/B2's read fix should be pinned to two exact spots: the wasm-struct
fallback region of `__extern_get` (`runtime.ts:6170-6179`, before the
`__sget_<key>` call) and the top of `_safeGet`'s `_isWasmStruct` branch
(`runtime.ts:3539`). Rule: **every path that treats `__sget_<key>` or struct
shape as own-property evidence must first consult
`_wasmStructDeletedKeys`.** With this in place, B1's "preferred"
widened-struct-arm extension becomes optional hardening, not a correctness
requirement — the generic arm + read gate already satisfy the acceptance
criteria (the sentinel `struct.set` only matters for statically-typed
`struct.get` reads, which remain number-typed NaN by design).

### A6. Two residual `in` gaps to document in the PR (not blockers)

- **Statically-typed receivers**: `const o={a:1}; delete (o as any).a;
  "a" in o` still folds to `i32.const 1` at compile time
  (`binary-ops.ts:654-702`). Acceptance criteria only cover `any` receivers,
  so this is out of Stage A/B scope. If wanted later: add a
  `sourceContainsDelete(sourceFile)` pre-scan (pattern:
  `sourceContainsClass`, `index.ts:208-220`; count only delete of
  property/element access) as `ctx.moduleUsesDelete`, and when true route
  struct-ref receivers through `__extern_has` instead of folding — preserves
  byte-identical output for delete-free modules.
- **Dynamic-key `in` on typed structs** (`k in typedStruct`,
  `binary-ops.ts:705-733`): an inline `__str_eq` loop over compile-time field
  names — a third divergent presence implementation that misses tombstones,
  sidecar props, and the proto tiers. Recommended: delete the path and route
  through `__extern_has` unconditionally (the shape is rare; one predicate,
  not three).

### A7. Standalone mode (Stage D — file as a follow-up issue, do not do here)

Static structs in standalone have no WeakMap sidecar; the native
`__extern_has` / `__delete_property`
(`src/codegen/object-runtime.ts:1468` / `:1199`) only understand the dynamic
`$Object` representation, which already has spec-correct tombstones
(`FLAG_TOMBSTONE`), proto-walk `in`, and #1837 insertion-order enumeration.
Do NOT build a wasm-side global (obj, key) tombstone registry — WasmGC has no
weak refs, so it would strongly retain every deleted-from object. The
dual-mode answer is **representation steering**: reuse the A6 pre-scan to
find object-literal struct types targeted by `delete`, and in standalone mode
lower those literals to `$Object`. Zero overhead for untouched objects, full
fidelity for delete-touched ones. PO: open the follow-up referencing this
section.

### A8. One-line predicate hygiene

In the `__extern_has` rewrite, the plain-JS sidecar check must be key-based
(`const sc = _wasmStructProps.get(obj); sc && key in sc`), not the current
value-based `_sidecarGet(obj, key) !== undefined` (`runtime.ts:6357`) —
HasProperty (§7.3.12) is value-independent, so `o.x = undefined; "x" in o`
must be true.

---

## Implementation status (2026-06-16, d1)

### Landed — Stage A: tombstone-aware presence predicate (the `in` half)

The headline defect — `in` / `hasOwnProperty` answering against the static
struct shape and ignoring runtime deletes — is fixed. `src/runtime.ts`:

- Extracted **`_wasmStructHasOwn(obj, key, exports)`** — the single own-property
  predicate (tombstone → sidecar (key-based, A8) → descriptor → class
  proto/static methods → struct-field shape). `__hasOwnProperty` now delegates
  to it (pure extraction).
- Rewrote **`__extern_has`** (the `in` operator): WasmGC-struct receivers route
  through `_wasmStructHasOwn` + the `_OBJECT_PROTO_KEYS` inherited tier, and the
  buggy **module-global `__sget_<key>` existence probe is deleted** (addendum
  A1 — it reported every receiver as having any field name present in any struct
  type and never consulted the tombstone). Plain-JS receivers use native
  HasProperty + a key-based sidecar check (A8).
- **`_safeGet`**: tombstone gate at the top of the WasmGC branch — a deleted key
  reads `undefined` via the generic (`__extern_get`) read path.
- **`_safeSet`**: clears the tombstone on (re-)assignment (A3) — single choke
  point covering the sidecar / `__sset_` / symbol arms.

Acceptance criteria met by Stage A:
- `delete o.a; "a" in o` → `false` ✓
- sibling `"b" in o` stays `true` ✓
- dynamic-key `delete o[k]; "a" in o` → `false` ✓
- object-rest `"e" in rest` → `false`, `"f" in rest` → `true` ✓
- `delete o.a; o.a = 5; "a" in o` → `true` ✓
- value-independent HasProperty: `o.x = undefined; "x" in o` → `true` ✓
- No regressions across in-operator / hasOwnProperty / delete-operator /
  #1821 / #1991 / #1364b suites.

Tests: `tests/issue-2130-delete-in-presence.test.ts` (7 cases, all green).

### Deferred — the read half (`delete o.a; o.a === undefined`)

For a **statically-resolvable struct receiver** (e.g. `const o:any={a:1,b:2}`),
`o.a` after delete still reads the stale field value. Root cause: that read
compiles to an inline `ref.test`+`struct.get` fast-path
(`emitExternrefToStructGet`, `src/codegen/property-access.ts`) that reads the
live f64 field and bypasses the runtime tombstone, and `o.a === undefined` is
constant-folded because the field's static type is `f64` (never `undefined`).

This is the architect's explicitly-deferred **A6/A7** work: the only sound fix
is to steer delete-touched object literals away from the inline struct.get
fast-path (route reads through tombstone-aware `__extern_get` in JS-host mode,
and use `$Object` representation steering in standalone mode — a wasm-side
`(obj,key)` tombstone registry is rejected by A7 because WasmGC has no weak
refs). Tracked as the read-path follow-up to this issue.
