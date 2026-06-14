---
id: 1991
title: "in operator never consults the prototype chain — inherited class methods and Object.prototype members invisible"
status: done
completed: 2026-06-12
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: operators
goal: core-semantics
related: [1971]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1991 — `"m" in instanceOfSubclass` and `"toString" in obj` return false

## Problem

```ts
class P { m() { return 1; } }
class C extends P { own = 1; }
const c: any = new C(); const o: any = { a: 1 };
String("m" in c) + "," + String("toString" in o)
// wasm: "false,false"   node: "true,true"
```

## Root cause

`src/codegen/binary-ops.ts:484-680` static path checks only struct field
names + TS-type props; for `any` receivers it routes to `__extern_has`
(`src/runtime.ts:5296-5327`) which checks own JS keys, the sidecar, and
`__sget_<key>` struct getters. Class methods aren't struct fields, and
HasProperty's `[[Prototype]]` walk (§13.10.1 → §7.3.12 → §10.1.7.1) is
never performed.

## Fix direction

Static path: include inherited methods/accessors from `classParentMap` and
known Object.prototype members. `__extern_has`: walk the compiled class
method registry (and built-in proto members) for struct receivers.

## Acceptance criteria

- Both repros true; own-property and array-index `in` unchanged
- `"missing" in c` stays false

## Dupe check

#110/#166 (`in` basics) done; #1971 item 5 covers `delete`+own-`in` only.
New.

## Partial fix landed (2026-06-11)

PR loopdive#1352 (merged) fixed the Object.prototype-members half
(`"toString" in obj` etc. via _OBJECT_PROTO_KEYS in __extern_has) and all
of #1992. REMAINING for this issue: inherited user-class methods
(`"m" in subclassInstance`) need the per-class method-name registry —
scoped in the sprint-62/63 proposal (analysis program 08-new-issues list).

---

## Implementation Plan (joint with #2130 — shared presence predicate)

> **This is the canonical design block for the joint presence-predicate
> work.** #2130 carries the same shared design plus its own deltas. Read
> both. Land in the staged order below; #1991 is **Stage C** and depends on
> Stage A landing first.

### Root cause (both issues are one defect)

Objects lowered to static WasmGC structs have **no runtime property-presence
notion**. The `in` operator has two lowering paths in
`src/codegen/binary-ops.ts` (the `InKeyword` arm, ~line 487-799):

1. **Static struct path** (staticKey known + receiver resolves to a named
   struct via `resolveWasmType`): emits a compile-time `i32.const` from the
   struct's *declared field set* — `binary-ops.ts:654-702`. This ignores
   runtime deletes (#2130 own-field false-positive) and inherited members
   (#1991 false-negative).
2. **Runtime path** (`externref`/`anyref` receiver — which is what an `any`,
   `unknown`, or cast receiver becomes): routes to the `__extern_has` host
   import — `binary-ops.ts:663-688` and `745-772`. `__extern_has`
   (`src/runtime.ts`, the `name === "__extern_has"` arm ~line 6343-6386) is a
   **thinner, divergent** presence predicate than `__hasOwnProperty`
   (~line 8781-8818): it never consults the delete **tombstone**
   (`_wasmStructDeletedKeys`), never consults `_getStructFieldNames` as a
   value-independent own check, and never walks the prototype chain for
   inherited user-class methods.

So today (verified on `c19a2e9c1`, JS-host mode, via probes in this PR's
branch):

| Case | wasm | node | path |
|------|------|------|------|
| `const o:any={a:1,b:2}; "b" in o` | `true` | `true` | runtime ok |
| `delete o.a; "a" in o` | **`true`** | `false` | tombstone ignored (#2130) |
| `delete o.a; o.a` | **`1`** | `undefined` | struct field uncleared (#2130) |
| `delete o[k]; "a" in o` | **`true`** | `false` | dynamic-key (#2130) |
| `const {e,...rest}=…; "e" in rest` | **`true`** | `false` | rest source shape (#2130) |
| `"m" in subclassInstance` | **`false`** | `true` | no proto walk (#1991) |
| `"toString" in c` | `true` | `true` | `_OBJECT_PROTO_KEYS` ok (#1352) |
| `"zzz" in c` | `false` | `false` | ok |

The two issues are the **false-positive** (#2130) and **false-negative**
(#1991) faces of the same missing runtime presence predicate. Fix them with
**one** predicate, not two divergent host imports.

### The unified predicate

`__hasOwnProperty` (`runtime.ts` ~8781-8818) is already the most complete
**own**-presence predicate: it checks, in order, tombstone →
sidecar (`_wasmStructProps`) → descriptor map (`_wasmPropDescs`) →
prototype/static method registries (`_prototypeMethodNames` /
`_staticMethodNames`, only when `obj` *is* a registered proto/class object) →
struct field names (`_getStructFieldNames`). `in` differs from
`hasOwnProperty` only by **also walking `[[Prototype]]`**.

**Design: one own-presence helper, one inherited-presence helper, both
consumed by every presence site.**

#### 1. `_wasmStructHasOwn(obj, key, exports): boolean` — new helper in `runtime.ts`

Factor the body of `__hasOwnProperty`'s WasmGC-struct branch (everything
after the `_isWasmStruct(obj)` guard, lines ~8791-8817) into a named
function. It returns true iff `key` is an **own** property of the struct
`obj` right now: tombstone-absent AND (sidecar-has OR descriptor-has OR
struct-field-has). Re-point `__hasOwnProperty` at it (no behavior change —
pure extraction, keeps the existing #1334 tombstone + #929 descriptor
semantics). This becomes the single source of own-presence truth.

#### 2. `_wasmStructHasInherited(obj, key, exports): boolean` — new helper

For the prototype-chain half that `in` needs but `hasOwnProperty` does not:

- `_OBJECT_PROTO_KEYS.has(key)` → true (already done inline in `__extern_has`;
  move it here so all `in` callers share it).
- **Inherited user-class methods (#1991 core):** the struct instance has no
  JS `[[Prototype]]` edge to its class's registered prototype object, so the
  runtime cannot reach `_prototypeMethodNames` from the instance. **Codegen
  must register an instance→method-name-set mapping** (see Stage C codegen
  work below). The helper consults that new registry:
  `_wasmInstanceProtoMethods.get(obj)?.includes(key)`.

#### 3. Rewrite `__extern_has` (the `in` runtime) as: own ∨ inherited

```
__extern_has(obj, key):
  if obj == null: return 0          // matches current; in on non-object → caller-guarded
  key = ToPrimitive(key) if wasm-struct key   // keep existing #1716 coercion
  if !_isWasmStruct(obj):
    try { if key in obj: return 1 } catch {}    // host object — native in walks its proto
    if _sidecarGet(obj,key) !== undefined: return 1
    return 0
  // WasmGC struct: own first (incl. tombstone), then inherited
  if _wasmStructHasOwn(obj, key, exports): return 1
  if _wasmStructHasInherited(obj, key, exports): return 1
  return 0
```

This single change fixes #2130's `in` false-positives (tombstone now
consulted via `_wasmStructHasOwn`) **and** #1991's inherited-method
false-negatives (via `_wasmStructHasInherited`) for the runtime path. Keep
the `__sget_<key>` getter probe folded into `_wasmStructHasOwn` (it already
lives there as the struct-field check).

### Staged landing order

The stages are independently testable and independently mergeable. **Land A
before B and C** (A is the shared refactor + tombstone fix that both depend
on). B and C are parallel after A.

- **Stage A (#2130 core, blocks B & C):** extract `_wasmStructHasOwn`;
  re-point `__hasOwnProperty`; rewrite `__extern_has` to call it (own half +
  tombstone). Fixes `delete o.a → "a" in o === false` and object-rest. This
  is the minimal change that closes the #2130 `in` false-positive.
- **Stage B (#2130 remainder):** dynamic-key delete actually removing the
  property, and the struct-field-clear-on-delete read fix. See #2130 deltas.
- **Stage C (#1991, this issue):** add `_wasmInstanceProtoMethods` registry +
  codegen registration; add `_wasmStructHasInherited`; route `__extern_has`
  through it. Fixes `"m" in subclassInstance`.

### #1991-specific work (Stage C)

**File: `src/codegen/class-bodies.ts`** — `ctx.classMethodNames` (set at
line ~905) already holds each class's **own** prototype method names, and
`ctx.classParentMap` (line ~408) gives the parent chain. Compute the
**transitive** inherited method-name set per class (own ∪ all ancestors'),
deduped, and emit a registration call so the runtime can map a constructed
instance to that set.

Two registration options — **prefer (a)**:

- **(a) Per-instance registration at construction.** In the class
  constructor codegen (where the instance struct is allocated — see
  `compileNewExpression` / the ctor body emit in `class-bodies.ts`), after
  the instance is created, emit a call to a new host import
  `__register_instance_methods(externref instance, externref csv)` where
  `csv` is the comma-joined transitive method-name string (a string constant
  global, same mechanism as `__struct_field_names` uses —
  `addStringConstantGlobal` / `stringGlobalMap`). Runtime stores
  `_wasmInstanceProtoMethods.set(instance, names)`. Zero overhead for classes
  whose instances never hit an `in`-miss is **not** achievable per-instance,
  but the cost is one host call + one WeakMap set per `new` of a class that
  has methods — acceptable and bounded. Guard with `nativeStrings` skip
  (standalone has no host; see Stage C standalone note).
- **(b) Per-struct-type lookup.** Emit a `__instance_proto_methods(externref)
  -> externref` export mirroring `emitStructFieldNamesExport`
  (`index.ts:2086`): a `ref.test typeIdx` chain returning the class's
  transitive method CSV. Runtime's `_wasmStructHasInherited` calls it
  (via `getExports()`), no per-`new` cost. **This is lower-overhead and
  preferred IF the instance struct typeIdx ↔ class-name mapping is available
  at export-emit time** (it is — `ctx.structMap` keyed by class name). Use
  (b) if the `ref.test` chain is clean; fall back to (a) only if instance
  structs can't be distinguished by typeIdx from the class.

> **Architect recommendation: implement (b).** It mirrors an existing,
> proven export (`__struct_field_names`), has zero per-`new` cost, and the
> typeIdx→methods map is trivially built from `ctx.structMap` +
> `ctx.classMethodNames` + `ctx.classParentMap`. (a) is the fallback only if
> a class's instances share a typeIdx with something else.

**File: `src/runtime.ts`** — add `_wasmStructHasInherited`; if using (b), add
a `_getInstanceProtoMethods(obj, exports)` reading the new export (mirror
`_getStructFieldNames`, `runtime.ts:2782`). Fold `_OBJECT_PROTO_KEYS` into
the inherited check.

**Also (optional, low-risk) static-path improvement:** in
`binary-ops.ts:654-702`, when the receiver resolves to a known class struct
(`ctx.classSet.has(typeName)`) and `staticKey` is known, also consult the
transitive `ctx.classMethodNames` + ancestors so a *statically-typed* (non-
`any`) `"m" in instance` folds to `i32.const 1` at compile time without a
runtime call. Not required for correctness (the runtime path covers `any`
receivers) but removes a host call on the common typed path. Verify
`_OBJECT_PROTO_KEYS` membership is also accepted here.

### Edge cases (#1991)

- `"m" in subclassInstance` where `m` is declared on the grandparent → must
  be true (transitive walk, not just immediate parent).
- Inherited **accessor** (`get x()`): `resolveClassMemberName` already
  collects get/set accessors into `classMethodNames`
  (`class-bodies.ts:895-902`), so they're included — confirm.
- A method **deleted** via `delete instance.m` → `_isDeletedClassProp` /
  tombstone must win over the inherited-method registry (own tombstone is
  checked first in the predicate order, so `delete` of an *inherited* method
  on the instance shadows it as a tombstone — matches spec, the own delete
  records absence; but note deleting an inherited method via the instance is
  a no-op in real JS since it's not own — keep `in` true unless the tombstone
  semantics already cover it; do NOT regress `__for_in_has`).
- `"constructor" in instance` → true (it's on the proto chain). Add
  `"constructor"` handling if not in `_OBJECT_PROTO_KEYS`.
- Static-side: `"m" in C` (the class object, not an instance) routes through
  `_staticMethodNames` already — do not break it.

### Test plan (#1991)

Add `tests/issue-1991-in-prototype-chain.test.ts`:

- `class P{m(){return 1}} class C extends P{own=1} const c:any=new C();`
  → `"m" in c === true`, `"own" in c === true`, `"toString" in c === true`,
  `"zzz" in c === false`.
- Three-level inheritance: method on grandparent visible via `in` on a
  grandchild instance.
- Inherited accessor `get g(){…}` → `"g" in instance === true`.
- `"m" in C` (class object) unchanged.
- Statically-typed receiver (`const c: C = new C(); "m" in c`) → true
  (exercises the optional static-path improvement if implemented).
- No regression: array-index `in`, own-data-property `in`, `#priv in obj`
  brand check (`binary-ops.ts:503-521`).

test262: `language/expressions/in/*`,
`built-ins/Object/prototype/hasOwnProperty/*` (must stay green — the Stage A
extraction touches `__hasOwnProperty`).

## Addendum — verified corrections to the plan (2026-06-12, second architect pass)

See also the addendum in #2130's file (A1-A8); the items below are
#1991-specific. **Dev: treat these as authoritative where they conflict with
the text above.**

### B1. Option (b)'s plain `ref.test` chain has a wrong-answer mode — dispatch on the `__tag` value instead

The recommended `__instance_proto_methods(externref) -> externref` export is
right, but a chain of `ref.test <classStructTypeIdx>` cannot distinguish
classes whose structs have **identical field layouts**: WasmGC types are
canonicalized **iso-recursively** (this is exactly #2009's collision), so
`class A { m() {} }` and `class B { n() {} }` — both lowering to
`(i32 __tag)` plus the same field kinds — share one heap type, and the chain
returns the *first* class's method CSV for instances of both. Result:
`"n" in new A()` → true. Field-name dispatch (`__struct_field_names`) lives
with this today, but for the method registry there is a collision-free
discriminator already in every class instance: the `__tag` field (field 0),
whose **values** are globally unique per class (`ctx.classTagMap`) — it is
per-instance data, immune to type canonicalization. Emit the export the way
`compileInstanceOf`'s externref arm already reads tags
(`src/codegen/typeof-delete.ts:531-585`):

```wasm
;; __instance_proto_methods(externref) -> externref
local.get 0
any.convert_extern
local.tee $any
ref.test $RootStruct_1          ;; per root-class hierarchy; gates the cast
if
  local.get $any
  ref.cast $RootStruct_1
  struct.get $RootStruct_1 0    ;; __tag
  ;; if-chain (or br_table) over ALL class tag values → global.get <csv>
end
;; ... next root hierarchy ...
ref.null.extern                 ;; not a class instance
```

Per-class transitive CSV = own `ctx.classMethodNames` ∪ ancestors via
`ctx.classParentMap` (child names shadow parent — dedupe keeps one entry;
membership is what matters here). Register CSVs with
`addStringConstantGlobal`; skip emission in `ctx.nativeStrings` mode for the
same reason as `emitStructFieldNamesExport` (`index.ts:2097`). Note the
`ref.test $RootStruct` gate is only a safe-cast guard — two unrelated root
hierarchies may canonicalize together and both pass the same test, which is
fine because the tag if-chain spans all classes and disambiguates.

### B2. Tombstone ordering for `delete instance.m` — simpler than the edge-case text suggests

The "method deleted via `delete instance.m`" bullet hedges. The clean rule,
already implied by the predicate shape: **the tombstone gates the OWN tier
only** — when tombstoned, skip own checks but still evaluate
`_wasmStructHasInherited`. That yields spec behavior with no special cases:
`delete c.m` (m inherited, not own) per §13.5.1 removes nothing, and
`"m" in c` stays true because the inherited tier answers after the
tombstone-suppressed own tier. Do NOT make the tombstone short-circuit the
whole predicate to false.

### B3. Confirmations (probed/read on `c19a2e9c1`, no action needed)

- Inherited accessors are covered: `class-bodies.ts:890-903` collects
  get/set accessor names into `ctx.classMethodNames` alongside methods.
- `"toString" in c` already true via `_OBJECT_PROTO_KEYS` (PR #1352);
  `"m" in c` / `"missing" in c` probe `false`/`false` today — only the
  registry tier is missing.
- Statically-typed receivers (`const c: C = …; "m" in c`) already fold to
  `true`: the TS type of `C` carries `m`, and `binary-ops.ts:588-614`
  (`getProperty` + apparent-type check) answers before any struct-field
  test. The optional static-path improvement in the plan is therefore
  already-implemented behavior — verify with a test, but expect no code
  change.

## Sprint-62 scheduling note (2026-06-12)

PR #1352 fixed the Object.prototype half only — the earlier `done` flip in
this planning branch was premature and is reverted here. The remaining
inherited-user-class-method half is Stage C of the joint presence-predicate
plan above (#2130 = Stages A+B). Spec is complete (PR #1394) → scheduled
sprint 62, dev lane (no Fable needed).
