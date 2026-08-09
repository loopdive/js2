---
id: 2026
title: "classes are not first-class values: new K() on a parameter throws 'No dependency provided for extern class', .constructor identity broken"
status: in-progress
assignee: ttraenkler/cs-2158
sprint: 63
created: 2026-06-10
updated: 2026-07-20
completed: 2026-06-18
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: core-semantics
related: [1395, 1116, 1721, 1992]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
coercion-sites-allow:
  - src/codegen/expressions/new-super.ts
---

# #2026 — no runtime constructor-object identity

## Problem

```ts
const C = class {
  v = 3;
  m(): number {
    return this.v * 2;
  }
};
function make(K: any): any {
  return new K();
}
make(C).m();
// wasm: THROW: No dependency provided for extern class "K"   node: 6
```

Also: `new A().constructor === A` → 0 (node: true); `A instanceof
Function` → false (filed separately as #1992). Direct `new C()` on a class
expression works.

## Root cause

`src/codegen/expressions/new-super.ts:1534` (`compileNewExpression`) — a
constructee that isn't a statically known class falls through to the
extern-class import intent, which `src/runtime.ts:4584` rejects; class
identifiers have no runtime constructor-object representation.

## Fix direction

Give each class a runtime constructor descriptor (struct with class-id +
ctor funcref); `new <dynamic>` dispatches through it when the static path
misses. Same descriptor backs `.constructor` identity and
`new.target === C` (#2023) — consider one architect spec for the family.

## Acceptance criteria

- Repro returns 6; `.constructor === A` true
- Statically-resolved `new` unchanged (no perf regression)

## Dupe check

#1395 (static descriptor, done), #1116b (JS-side ctor bridge, done), #1721
(subclass Function/Object, done). Class-through-variable `new` not filed.
New.

---

## Implementation Plan

> Architect spec, 2026-06-17. Based on `upstream/main` @ `79e16bb37`.
> Anti-dup: no `## Implementation Plan` existed before this; PR #1647 is the
> doc-only routing/validation PR (no spec). No open PR speccs this.

### Root cause (precise)

`compileNewExpression` (`src/codegen/expressions/new-super.ts`, the giant
dispatcher starting ~line 1612) resolves the constructee **statically**: it
needs `className` to land in `ctx.classSet` (line ~3201), `ctx.funcConstructorMap`
(function-style ctor, line ~2899), or `ctx.externClasses` (line ~3317). For

```ts
function make(K: any): any {
  return new K();
}
```

`K` is a value-bound parameter. The type checker gives `new K` the type `any`,
so `symbol?.name` is undefined and `ctx.classSet.has(K)` is false. Because
`expr.expression` IS an identifier (`K`), the resolution at line ~2801 sets
`className = "K"` only if `"K" ∈ classSet` — it isn't — so `className` stays
`undefined`/`"K"`, the function-ctor and local-class arms miss, and execution
reaches the **extern-class arm** (line ~3317) keyed on the literal name `"K"`.
No `K_new` import exists, so either a compile-time `Missing import for
constructor: K_new` fires, or (when an extern intent was registered) the
runtime resolver at `src/runtime.ts:6230` throws `No dependency provided for
extern class "K"`. Either way: the **value bound to the parameter is never
consulted** — there is no runtime constructor representation to `call_ref`.

The class VALUE that flows into `K` already exists and is correct: a class
identifier as a value resolves to the `__class_<Name>` singleton
(`emitLazyClassObjectGet`, `src/codegen/expressions/extern.ts:258`), an
`extern.convert_any`'d `$ClassName` struct whose `__tag` field carries the
class-id (`ctx.classTagMap`). So the descriptor is **present at the call site
as an externref**; what is missing is a uniform **construct ABI** that, given
that externref, dispatches to the right `<Class>_new` and returns a boxed
instance.

### Design: uniform boxed-instance construct ABI via a per-class ctor trampoline

Add a **uniform constructor entry** for every WasmGC-struct-backed class, of a
single shared signature, reachable by `call_ref` off a funcref keyed by the
class-tag carried on the class-object descriptor. The static `new ClassName()`
path is **left exactly as is** (no perf change, no boxing): only the _dynamic_
`new <value>()` fallback changes.

**Uniform ctor signature** (one func type, registered once):

```wat
(type $UniformCtor (func (param $argv (ref null $ObjVecArr)) (result externref)))
```

- `$argv` = the boxed-externref argument vector (reuse the existing
  `$ObjVecArr` = `(array (mut externref))` from object-runtime.ts, the same
  type Object.keys/values enumeration already uses — do NOT mint a new array
  type, it invites the #2009 canonicalization hazard).
- result = the constructed instance **boxed to externref** (`extern.convert_any`
  on the `(ref $ClassName)` the real ctor returns; externref-backed subclasses
  already return externref so they pass through).

**Per-class trampoline** `__ctor_uniform_<Name>`: a generated function of type
`$UniformCtor` that

1. reads each `<Class>_new` param `i` from `$argv[i]` (null-extern when
   `i >= argv.len`, matching the existing missing-arg padding), coercing the
   boxed externref to the param's ValType via the **existing** unbox helpers
   (`coerceType` externref→f64 uses `__unbox_number`/ToNumber; externref→ref
   uses `any.convert_extern` + `ref.cast`; see type-coercion.ts). For
   `any`-typed params keep externref.
2. `call`s `<Class>_new` (re-resolve idx via `classMemberFuncKey`).
3. boxes the result to externref and returns.

This trampoline is the SAME shape as `emitFuncRefAsClosure`'s trampoline
(`src/codegen/closures.ts:3285`) — model the arg-unpacking loop on that code.

**Descriptor wiring.** The class-object descriptor singleton (the
`__class_<Name>` global, built in `emitLazyClassObjectGet`) gains the ability to
answer "give me your uniform ctor funcref". Two implementation options — pick
**(A)** for the first PR (smaller blast radius), leave (B) as a noted
follow-up:

- **(A) class-tag → funcref table (recommended).** Build one module-level
  `(table $ctorTable funcref)` (or an `(array funcref)` global) indexed by
  class-tag (`ctx.classTagMap` values are dense small ints). At class
  registration, `elem`/`array.set` slot `tag → ref.func $__ctor_uniform_<Name>`.
  The dynamic path reads the tag off the descriptor externref
  (`any.convert_extern` → `ref.cast` the class-object struct → `struct.get`
  the `__tag` field), then `table.get $ctorTable` / `call_ref $UniformCtor`.
  No host import; works standalone.
- **(B) descriptor carries the funcref directly.** Add a `__ctor` funcref field
  to the `$ClassName` class-object struct and `struct.new` it with
  `ref.func $__ctor_uniform_<Name>`. Cleaner but mutates the class struct
  shape used for instances too — higher regression surface
  (`patchStructNewForDynamicField` territory). Defer.

### Changes (sliced into dev-sized PRs)

**PR-1 — uniform ctor trampolines + tag→funcref table (the core).**

_File: `src/codegen/expressions/new-super.ts`_

- New `emitUniformCtorTrampoline(ctx, className): number` — generates
  `__ctor_uniform_<Name>` (type `$UniformCtor`), returns its funcIdx. Call it
  once per WasmGC-struct class, right after the class ctor is registered (near
  `class-bodies.ts:667` where `<Class>_new` is set up — or lazily on first
  dynamic-new use, keyed in a `ctx.uniformCtorFuncIdx: Map<string,number>` to
  avoid emitting for classes never used dynamically).
- New `ensureCtorTable(ctx)` — registers the `$UniformCtor` func type + the
  `(table funcref)` (or `(array funcref)` global) once; idempotent. Populate
  slot `classTag → trampoline funcIdx` when a trampoline is emitted.

_File: `src/codegen/expressions/new-super.ts`, `compileNewExpression`_

- **New fallback arm**, inserted as the LAST resolution attempt — AFTER the
  extern-class arm (line ~3317) and the builtin-ctor arms, immediately BEFORE
  the terminal `reportError(... "Unsupported new expression ...")` at line
  ~3822. Guard: `ts.isIdentifier(expr.expression)` (or `PropertyAccess`/`this`
  per §below) AND the static resolution produced no class/func/extern match AND
  the value's static type is a class-or-`any` (see Edge cases). Emit:
  1. compile `expr.expression` → externref (the class descriptor value).
  2. build `$argv`: `array.new_fixed $ObjVecArr` over the compiled+boxed args
     (each arg `compileExpression(... {externref})`; spread → fall through to
     refusal in PR-1, handle in PR-3).
  3. read the class-tag off the descriptor, `table.get`/`call_ref $UniformCtor`.
  4. result type `{ kind: "externref" }`.
- Keep the existing static `classSet` arm (line ~3201) UNCHANGED — static
  `new C()` keeps emitting the direct typed `call` + `(ref $struct)` result,
  zero boxing, zero perf regression. This is the hard acceptance criterion.

**PR-2 — `.constructor` identity through the descriptor (`new A().constructor === A`).**

- `src/codegen/property-access.ts:3457` already routes `.constructor` on a
  statically-typed instance to the `__class_<Name>` singleton via
  `emitLazyClassObjectGet` — that path already makes `new A().constructor === A`
  hold for the STATIC receiver. Verify the repro's failing case
  (`new A().constructor === A → 0`) is the case where the instance type is
  inferred (e.g. through `make(C)` returning `any`); for an `any`/externref
  receiver `.constructor` can't statically know `typeName`. PR-2 scope: when the
  receiver is externref and carries a boxed class instance, read the instance's
  class-tag (instances already carry `__tag`? confirm — if not, this is the slot
  to add) and map tag→`__class_<Name>` singleton. If instances do NOT carry a
  tag, scope PR-2 to ONLY the statically-typed receiver (already works) and file
  the externref-receiver `.constructor` as a follow-up; do not block PR-1.

**PR-3 — spread / arity / derived-class args in the dynamic path.**

- `new K(...args)` and arg-count mismatches: extend the `$argv` builder to
  flatten spread (reuse `flattenCallArgs`); the trampoline already null-pads
  missing params. Subclass-through-value (`new K()` where `K` is a derived
  class value) works automatically because `<Class>_new` already drives the
  super-chain — just confirm with a test.

### Wasm IR pattern (dynamic-new fallback, option A)

```wat
;; new K(a, b)  where K is a value-bound class descriptor (externref)
;; 1. evaluate descriptor
local.get $K                       ;; externref class-object
;; 2. read class-tag from descriptor  (any.convert_extern + ref.cast class-object struct + struct.get __tag)
any.convert_extern
ref.cast $ClassObjBase             ;; the class-object struct carrying __tag
struct.get $ClassObjBase $__tag    ;; -> i32 classTag
;; 3. build argv = [box(a), box(b)]
<compile a -> externref>
<compile b -> externref>
array.new_fixed $ObjVecArr 2       ;; -> (ref $ObjVecArr)
;; 4. dispatch: ctorTable[classTag](argv) -> externref
local.set $argv
local.get $tag
table.get $ctorTable               ;; -> (ref $UniformCtor)  (or array.get on a funcref array)
local.get $argv
call_ref $UniformCtor              ;; -> externref instance
```

```wat
;; __ctor_uniform_K  (type $UniformCtor): param $argv (ref null $ObjVecArr) -> externref
;; for each K_new param i:  read argv[i] (null-extern when i>=len), coerce to param ValType
local.get $argv  i32.const 0  ... <bounds + array.get + coerce>   ;; arg0
local.get $argv  i32.const 1  ... <coerce>                        ;; arg1
call $K_new                        ;; -> (ref $K)
extern.convert_any                 ;; box instance
;; (externref-backed subclass: K_new already returns externref — skip the box)
```

### Edge cases

- **Static path untouched**: `new C()` on a directly-typed class must still hit
  the `classSet` arm and return `(ref $struct)`, NOT externref. Gate the new
  fallback so it only fires when static resolution genuinely missed — assert via
  a test that `new C()` codegen is unchanged before/after.
- **Non-class value** (`new K()` where `K` holds a number/string/plain object):
  the descriptor has no valid class-tag. The trampoline table lookup must
  trap-clean into a TypeError, not an illegal `call_ref`. Reserve tag 0 / a
  null table slot → emit `throw TypeError("K is not a constructor")`. Use the
  existing `emitThrowTypeError` path. (test262
  `language/expressions/new/non-ctor*` patterns.)
- **`null`/`undefined` descriptor**: `new K()` with `K == null` → TypeError, not
  null-deref. Guard with `ref.is_null` before the tag read.
- **new.target (#2023)**: the dynamic path should set new.target to the resolved
  class id inside the trampoline (mirror `emitSetNewTargetBeforeCall`), so
  `new.target === K` inside the body holds. Defer to a follow-up if it
  complicates PR-1; note it.
- **externref-backed subclasses** (`extends Error/Map/...`, `classBuiltinParentMap`):
  these have no `$ClassName` struct and no class-object singleton, so they are
  NOT registered in the ctor table — a dynamic `new K()` on such a value keeps
  the current behaviour (out of scope; document).
- **`new this(...)` in a static method (#1679)** already has a path
  (line ~2831); leave it — the new fallback must run only after it misses.

### Files to touch (summary)

- `src/codegen/expressions/new-super.ts` — trampoline emit, ctor-table ensure,
  dynamic-new fallback arm.
- `src/codegen/class-bodies.ts` (~line 664) — emit/slot the uniform trampoline
  when the class-object global is registered (or lazily; see PR-1).
- `src/codegen/expressions/extern.ts` (`emitLazyClassObjectGet`, ~line 258) —
  ensure the class-object struct exposes the `__tag` for the dynamic tag read
  (it already carries `__tag`; confirm field index).
- `src/codegen/property-access.ts` (~line 3457) — PR-2 only.

### Implementation log (sdev-async2, 2026-06-17)

Re-validated repro on `upstream/main` @ `fe0e21ba1`: `THROW: No dependency
provided for extern class "K"` — confirmed. Traced the live path precisely:

- `new K()` (K an `any` param) reaches `compileNewExpression`'s **`!className`
  unknown-ctor branch** (`new-super.ts:2954`), NOT the terminal `reportError`
  at 3812. `ctorName = "K"`. It falls past the `resolvesToNonConstructableValue`
  guard (2992, doesn't fire for K) and the ArrayBuffer/DataView/Array builtin
  arms, then emits the `__new_K` unknown-ctor import (~3168) → runtime
  `runtime.ts:6230` throws "No dependency provided for extern class K".
- Insertion point for the dynamic fallback: **inside the `!className` branch,
  immediately before the `__new_${ctorName}` import emission (~3168)**, gated on
  `ts.isIdentifier(s1Callee)` + value-type is class-or-`any`. Try the ctor-table
  dispatch first; on a null/invalid tag, **fall through to the existing
  `__new_` import** so `Test262Error`-style genuine host builtins keep working.
- Tag read: class root structs get `__tag` at **field 0** (`class-bodies.ts:598`),
  child classes inherit it. Class-object descriptor reuses the **same
  `$ClassName` struct** as instances (`extern.ts:317`), so the value in `K` is an
  `extern.convert_any`'d `$ClassName` struct carrying `__tag`. To read it
  generically I register one shared open base `$ClassTagBase =
(sub (struct (field $__tag i32) (field $__shape_brand i32)))` and set it as the
  superTypeIdx of every class-ROOT struct (`class-bodies.ts:632`); the existing
  `__shape_brand` sentinel (626) already dodges the #2009 `$AnyString`
  canonical-merge. Then `any.convert_extern` + `ref.test $ClassTagBase` +
  `struct.get 0` yields the tag with no host import (standalone-safe).
- `$ObjVecArr` = `(array (mut externref))` (`object-runtime.ts:273`) is the argv
  array type — reuse it, do not mint a new one.
- `<Class>_new` is keyed `classMemberFuncKey(ctx, "${className}_new")`
  (`class-bodies.ts:736`); the uniform trampoline re-resolves it per class.

### Slice plan (PR-1 → PR-3)

- **PR-1 (core) — DONE (host mode).** Implemented as a tag-dispatch chain in
  `emitDynamicNewFallback` (`new-super.ts`), NOT the `$ClassTagBase` supertype
  - `(table funcref)` from the original sketch. Rationale discovered during
    implementation: `ref.test $Class` cannot distinguish structurally-identical
    classes (WasmGC iso-recursive canonicalization merges two `{x:number}`
    classes; a `ref.test` matches both — verified, it mis-constructed B for A).
    So discrimination MUST be by the `__tag` value, not the struct type. The
    shipped design avoids any struct-hierarchy change (lower regression surface
    than a shared base supertype): read `__tag` (field 0) via a
    `ref.test`/`ref.cast` against any shape-compatible candidate struct (valid
    under canonicalization), then a flat `tag == classTag` if/else chain selects
    `<Class>_new`, threading boxed args coerced to each ctor param's ValType. No
    host import → pure-Wasm. No-match base falls through to the legacy `__new_`
    host import (host mode) so genuine builtins (Test262Error) keep working;
    gated off in `noJsHost` mode. Static `new C()` path UNCHANGED (the
    `classSet` arm is never touched). Repro → 6. Tests: `tests/issue-2026-dynamic-new.test.ts`
    (6 cases incl. shape-collision dispatch, arg threading, static regression
    guard, builtin fallthrough). tsc + biome clean; stack-balance gate OK.
    **Standalone (`--target wasi`) deferred:** `new K()` already failed on main
    in standalone (the unused `__new_K` import trips the WASI allowlist at
    module-build, independent of dispatch). Fixing it needs suppressing that
    import registration in `collectUnknownConstructorImports` for value-bound
    class identifiers — split out to avoid PR-1 regression risk (PR-1b).
- **PR-1b — DONE (standalone/WASI parity).** Two no-JS-host gaps, not one:
  1. **`__new_<name>` host-import registration** (`collectUnknownConstructorImports`
     finalize, `declarations.ts:1436`). For `new K()` on a value-bound class
     identifier it registered `env.__new_K`, which the strict-import allowlist
     gate (`addImport`, #1524) rejected _at registration time_ — a single
     `new K()` failed the whole standalone compile (`Host import "env.__new_K"
… not on the dual-mode allowlist`). Fix: in no-JS-host mode (`ctx.wasi ||
ctx.standalone`), after the WASI-error-name native path, **skip the host
     import entirely** — it is never satisfiable with no host, and the pure-Wasm
     `emitDynamicNewFallback` (PR-1) is the resolution path (it reads the
     class-object `__tag` and tag-dispatches to `<Class>_new`; its no-match base
     already yields a null externref in no-JS-host mode). Host (JS) mode
     unchanged.
  2. **`__register_class_object` registered under `--target wasi`** — the
     deeper, latent blocker. The skip guard (`index.ts:1121`) excluded only
     `ctx.standalone`, so **`wasi` still registered** the JS-host Proxy own-key
     notification import. `emitLazyClassObjectGet` (`extern.ts:269`) then took
     its CSV-notify branch and `global.get`'d the static-methods-CSV **string**
     global, which under nativeStrings is **not a real module global** — baking
     a `-1` global index that crashed binary emit (`global index out of range —
-1`) the _instant a class flowed as a value_ (`use(A)`, `const v:any=A`,
     hence `new K()`). Reproduced on **unmodified upstream/main** under
     `--target wasi`, and did NOT under `--target standalone` (which already
     skipped the import) — so it pre-dates #2026 and is a general
     class-as-value bug, surfaced here because the dynamic-new ABI requires the
     class descriptor to flow as an externref. Fix: extend the skip to **both**
     no-JS-host targets — `!(ctx.standalone || ctx.wasi)`. The import is a
     JS-host Proxy notification with zero effect on actual class / method /
     static-field behavior (verified: instance methods, static methods, static
     fields all correct in wasi+standalone after removal).

  Result: `new K()` through an `any` param returns the correct instance in
  `--target wasi`/`standalone` with **zero `env` host imports**; arg threading
  and shape-collision tag dispatch correct; static `new C()` untouched. Tests:
  `tests/issue-2026-standalone-dynamic-new.test.ts` (6 cases, all assert no
  `env` imports + instantiate with `{}`). PR-1 host test
  (`issue-2026-dynamic-new.test.ts`, 7) still green. Files: `declarations.ts`,
  `index.ts`. Branch `issue-2026-standalone-ctor-abi`.

- **PR-2 — DONE (host + standalone), cs-2158, 2026-06-18.** `.constructor === A`
  for the externref/`any`-typed receiver. New `tryEmitConstructorViaTag`
  (`property-access.ts`), called from `compilePropertyAccess` when
  `propName === "constructor"` AND the receiver type is `any`/`unknown` (a
  concretely-typed class instance keeps the zero-overhead static arm in
  `compileInstanceMember`, unchanged). It reuses PR-1's exact `__tag` mechanism:
  evaluate the receiver to anyref, read the instance's class `__tag` (struct
  field 0, via a `ref.test`/`struct.get 0` per distinct candidate struct shape —
  canonicalization-safe), then a flat `tag == classTag` if/else chain selects the
  matching `__class_<Name>` singleton (`emitLazyClassObjectGet`), making both
  sides of `=== A` reference-identical. Discrimination is by `__tag`, never struct
  type (same-shape classes canonical-merge — #2009). No host import →
  standalone-safe (verified: zero `env` imports). No-match (non-class externref /
  null) yields a null externref — prior generic-read behaviour, nothing
  regresses. Repro `id(new A()).constructor === A` → true (was false); static
  `new A().constructor === A` untouched (true); shape-colliding `A`/`B`
  discriminate correctly; subclass `b.constructor === B` true; non-class `42`
  `.constructor` → no match, no crash. tsc + prettier clean. Tests:
  `tests/issue-2026-constructor-identity-any.test.ts` (8 cases, host + standalone
  incl. shape-collision, subclass, wrong-class, non-class, static regression
  guard). Existing #2026 PR-1/PR-1b tests (13) still green. File:
  `src/codegen/property-access.ts`.

  **This satisfies the remaining acceptance criterion** (`.constructor === A`
  true). With PR-1 (repro → 6), PR-1b (standalone parity), and PR-2, all
  acceptance criteria are met. PR-3 (below) is residual hardening only.

- **PR-3 (residual, OPTIONAL):** spread/arity/derived-class args in the dynamic
  path (reuse `flattenCallArgs`); new.target threading. **Verified already
  working on current main** (smoke-tested 2026-06-18): `new K(5)` arg threading →
  correct; `new (42 as any)()` and `new (null as any)()` already throw a
  catchable TypeError (no null-deref). So PR-3's edge cases are largely covered;
  only `new K(...spread)` flattening remains as a genuine gap — file as a small
  follow-up if a test262 case needs it.

### Test files to verify

- New `tests/issue-2026.test.ts`:
  - `function make(K:any){return new K()}; const C=class{v=3;m(){return this.v*2}}; make(C).m()` → 6
  - `new A().constructor === A` → true (PR-2)
  - `new K(1,2)` arg threading (PR-3)
  - non-constructor value `new (42 as any)()` → throws TypeError
  - `new (null as any)()` → throws TypeError (no null-deref)
  - regression guard: `new C()` direct still returns a typed instance (no
    externref widening) and its method calls keep working.
- Host + standalone (`--target wasi` / nativeStrings) for each — the ABI is
  pure-Wasm (no host import) so both modes must pass.
- Confirm no test262 `built-ins/`/`language/` regressions in the
  classes/new buckets (CI).

## Reopened 2026-07-20 (harvest cross-reference)

Marked `status: done` but the test262 harvest shows **1464 live failures still citing #2026** in the error field. Premature close — reopened as `ready`. See the sprint-73 harvest note.

## PR-3 runtime-spread residual — preliminary FYI standalone evidence (2026-07-20)

Slice claim: `ttraenkler/fix-2026-dynamic-new-spread` (the historical issue
assignee above is intentionally preserved).

The preliminary standalone result set contains **2,754 rows** that fan out from
eager compilation of `temporalHelpers.js`, specifically its generic helper
shape:

```js
new construct(...constructArgs);
```

This is an include fan-out, not 2,754 distinct direct uses. The compiler eagerly
compiles the shared helper even for tests that never call it, so one unsupported
dynamic spread contaminates unrelated include consumers.

Fresh-main revalidation at `6a2bb824aec9d4` reproduced the same #2026
compile-error signature in both requested probes:

- direct canary:
  `built-ins/Temporal/Duration/prototype/negated/subclassing-ignored.js`
- include-only canary:
  `built-ins/Array/fromAsync/asyncitems-arraylike-promise.js`

### Root cause and implementation rationale

The existing runtime-argv path accepted only statically typed Wasm vec refs.
An untyped JavaScript helper parameter such as `constructArgs` compiles as an
`externref`, even when its runtime value is the compiler's boxed vec, so the
path rejected it as non-array-like.

The fix normalizes an externref spread carrier through the established
externref-to-canonical-vec coercion, then threads the materialized values through
the existing class-tag dispatch. Standalone/WASI uses native
`__extern_length`/`__extern_get_idx` readers and introduces no `env` imports.

Two correctness details are part of the same runtime-argv boundary:

- Every positional argument and spread source is evaluated once and retained in
  source order before copying. The previous two-pass shape evaluated all spread
  sources before positional arguments, observably reordering side effects.
- Runtime-argv reader dependencies are registered before callee/argument body
  emission. Registering a host helper while visiting a later spread shifts
  defined-function indices and can retarget an earlier positional call.

The no-tag path now preserves IsConstructor behavior: host mode routes the
materialized argv through the existing `Reflect.construct` bridge, while
standalone/WASI throws a real catchable TypeError. Static `new C()` and the
array-literal spread path are unchanged.

### Validation

- Focused Vitest: **29/29 passed** across
  `issue-2026-dynamic-new-varspread`, `issue-2026-dynamic-new-spread`,
  `issue-2026-dynamic-new`, and `issue-2026-standalone-dynamic-new`.
- New controls cover host + standalone, zero `env` imports, generic `any`
  array carriers, mixed positional/spread source order and single evaluation,
  ctor arity/surplus arguments, and catchable non-constructor TypeError.
- Both FYI probes now compile past #2026. Their only remaining compile error is
  the unrelated explicit-receiver `Reflect.get` blocker #2046
  (`L1060:24` direct; `L1194:24` include-only).
- FYI probes were non-authoritative smokes because the local runtime is
  Node 24 / Unicode 16 rather than the pinned Node 25 / Unicode 17 contract;
  the before/after diagnostic signature is still useful implementation
  evidence, but must not be compared with CI pass-rate baselines.
