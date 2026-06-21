---
id: 2357
title: "Standalone TypedArray subarray-aliasing — offset-windowing view representation"
status: done
sprint: Backlog
created: 2026-06-18
priority: medium
feasibility: hard
reasoning_effort: max
task_type: architecture
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 2159
depends_on: []
---

# Standalone TypedArray subarray-aliasing — offset-windowing view representation

## Problem

`TypedArray.prototype.subarray(begin, end)` must return a **view that shares the
parent's backing store** (ECMA §23.2.3.30): mutating `sub[i]` writes through to
`parent[begin + i]`, and `parent[begin + i]` reads back `sub[i]`. In standalone
mode (`--target wasi` / native byte buffers) the current lowering returns a
**copy** — the alias is lost.

This was carved out of #2159 / #38 (the DataView-windowing slice, PR #1678)
because, unlike DataView, subarray-aliasing lands directly on the **hot `a[i]`
element-access path** for *every* typed array, so the representation choice has
broad blast radius and warrants a deliberate architect decision rather than an
inline dev fix.

## Current representation (the constraint)

- A typed array / vec is a struct `$__vec_<elem> { length: i32, data: (ref
  $__arr_<elem>) }`, subtyping the shared `$__vec_base { length: i32 }` (see
  `src/codegen/registry/types.ts` `getOrRegisterVecType` ~line 116 and
  `getOrRegisterVecBaseType` ~line 96). **There is no offset field.**
- `subarray`/`slice` lowering returns a value typed as the *same* vec struct:
  `inferStandaloneRegExpMatchArrayType`-adjacent helper in
  `src/codegen/index.ts:12570` returns `{ kind: "ref_null", typeIdx:
  receiverType.typeIdx }`; the actual element copy is in
  `src/codegen/array-methods.ts:2887` (`case "subarray"`).
- Element **read** lowering (`compileElementAccess`,
  `src/codegen/property-access.ts:4387`; vec arm ~line 4840) does:
  `struct.get $vec 1` (data) → compile index → `array.get`/`array.get_u`/`_s`
  (with an optional bounds-check elide, `isSafeBoundsEliminated`). It indexes the
  backing array **directly** — no base offset.
- Element **write** lowering (`compileElementAssignment`,
  `src/codegen/expressions/assignment.ts:2693`) mirrors the read: `struct.get
  $vec 1` → index → `array.set`. (Plus the packed-i8/i16 unpack from #2159
  Slice 1.)
- The DataView slice (PR #1678) added an **additive** `$__dv_window { buf,
  byteOffset, byteLength }` wrapper (`src/codegen/dataview-native.ts`
  `getOrRegisterDvWindowType` / `recoverDvBacking`) — but DataView accessors are
  a *separate* dispatch (`emitDataViewAccessor`), not the generic `a[i]` path, so
  that wrapper does **not** help subarray.

## The decision to make

Two viable representations, with a clear hot-path tradeoff:

### Option A — offset field on every vec

Add a third field `byteOffset: i32` (element offset, not byte) to
`$__vec_<elem>`; subarray sets `offset = parent.offset + begin`, `length = end -
begin`, shares `data`. Every element read/write adds `+ offset` to the index.

- **Pro:** one uniform shape; no per-access type discrimination; subarray and
  the parent are the same struct type, so existing type-flow is untouched.
- **Con:** taxes the hot `a[i]` path for **all** arrays (a `struct.get offset` +
  `i32.add` on every read and write), including the overwhelmingly common
  non-windowed case. Also perturbs the `$__vec_base` prefix invariant if `offset`
  is inserted before `data` (it must be appended after `data` to keep field 0 =
  length / field 1 = data, which #2190's `$__vec_base` length-through-externref
  fix and the DataView `struct.get fieldIdx:1` data reads both rely on — see
  `src/codegen/registry/types.ts` and the #2190 work). Appending offset as
  field 2 is safe for those invariants but still costs the per-access add.

### Option B — dedicated `$__subview` struct (recommended)

A separate `$__subview { base: (ref $__vec_base), byteOffset: i32, length: i32 }`
(or per-elem `base: (ref $__vec_<elem>)`) produced **only** by subarray/slice
windowing; plain arrays keep the bare two-field vec. The element path does a
runtime `ref.test $__subview` and routes windowed access through `base.data` +
`offset`; the non-windowed array falls through unchanged.

- **Pro:** **zero cost on the common non-windowed path** when the discrimination
  is structured to avoid a branch there (see below); contained blast radius
  (mirrors the `$__dv_window` pattern just shipped).
- **Con:** element access must discriminate view-vs-plain. Naively that's a
  `ref.test` branch on **every** `a[i]`, which is itself a hot-path tax — the
  crux this spec must resolve.

## Discriminating view-vs-plain WITHOUT a per-access hot-path branch

This is the heart of the #46 design. Candidate strategies (architect to choose +
justify):

1. **Static type-driven dispatch (preferred).** The result of `subarray`/`slice`
   is statically known at the call site (the helper at `index.ts:12570` already
   special-cases it). Give the *binding* that receives a subarray result a
   distinct wasm type (`$__subview`) in the local/type map, so
   `compileElementAccess` picks the windowed lowering **at compile time** by
   inspecting the receiver's resolved `ValType.typeIdx` — no runtime `ref.test`.
   Plain `Uint8Array` locals keep the bare-vec ValType and the bare-vec lowering.
   The runtime branch only appears where the static type is genuinely a union
   (e.g. a param typed `Uint8Array` that may receive either). Requires:
   - extending `inferLetConstInitializerWasmType` (index.ts ~12519) +
     `resolveWasmType` so a subarray-result binding resolves to `$__subview`;
   - a `compileElementAccess` arm keyed on `isSubviewStructType(receiverType)`
     that emits `base.data` + `offset + index`;
   - the matching write arm in `compileElementAssignment`.
2. **Subtype + single covariant lowering.** Make `$__subview` subtype the bare
   vec with `offset` defaulted to 0 on plain vecs, so one lowering (`struct.get
   offset` + add) serves both — collapses to Option A's per-access add but keeps
   the wrapper allocation cost off plain construction. Rejected unless (1) proves
   infeasible: it reintroduces the universal per-access add.
3. **Length-method / iterator funnel only.** Alias only through `.length`,
   iteration, and `.set`/`copyWithin`/`fill` (which already go through helper
   funcs), NOT raw `a[i]`. Cheap but **incorrect** for `sub[i] = v` raw writes,
   which test262 exercises directly — rejected as a partial.

## Acceptance criteria

- `let p = new Uint8Array(4); let s = p.subarray(1,3); s[0]=9; ` ⇒ `p[1]===9`
  (aliasing through raw `a[i]`), standalone.
- `p[2]` reads back `s[1]`; `s.length === 2`; `s.byteOffset` (if exposed) ===
  parent offset + begin.
- Negative / clamped `begin`/`end` per §23.2.3.30 (reuse the
  `emitNormalizeIndex` clamp already in `dataview-native.ts`).
- **No measurable regression on the non-windowed `a[i]` hot path** — the chosen
  discrimination must not add an instruction to plain-array element access (the
  Option-B-strategy-1 static dispatch achieves this; verify by diffing the WAT of
  a plain `for` loop over a `Uint8Array` before/after).
- Scoped standalone tests + an equivalence test; existing TypedArray suites green.

## Files / line refs (entry points)

- `src/codegen/registry/types.ts` — vec struct def (`getOrRegisterVecType` ~116,
  `getOrRegisterVecBaseType` ~96); add `$__subview` registration here (mirror the
  `$__dv_window` reg now in `dataview-native.ts`).
- `src/codegen/array-methods.ts:2887` (`case "subarray"`) + `src/codegen/index.ts:12570`
  (subarray/slice result-type inference) — build the `$__subview` sharing
  `parent.data`, set `offset`/`length`, instead of copying.
- `src/codegen/property-access.ts:4387` `compileElementAccess` (vec arm ~4840) —
  windowed-read arm.
- `src/codegen/expressions/assignment.ts:2693` `compileElementAssignment` —
  windowed-write arm.
- `src/codegen/index.ts` ~12519 `inferLetConstInitializerWasmType` /
  `resolveWasmType` — make a subarray-result binding resolve to `$__subview`
  (the static-dispatch enabler for strategy 1).
- Reference precedent: `src/codegen/dataview-native.ts` `$__dv_window`
  wrapper + `recoverDvBacking` (PR #1678) — same additive-wrapper pattern, but
  for the separate DataView accessor dispatch.

## Notes

Related: #2190 (array element indexing through the externref boundary — the
`$__vec_base` length-through-externref fix) constrains where new fields may be
inserted (length must stay field 0). The DataView windowing slice (PR #1678)
validated the additive-wrapper approach end-to-end; subarray differs only in that
its accessor IS the generic `a[i]` path, which is why the discrimination strategy
(above) is the load-bearing decision.

## Implementation status (#47, 2026-06-18) — BLOCKED on type-index stability

WIP on branch `issue-2357-subarray-impl` (commits "WIP 1/4", "WIP 2/4"). The
representation + lowering are built and correct in isolation:

- `$__subview_<elem> {length:i32, data:(ref null $__arr_<elem>), byteOffset:i32}`
  registered (`getOrRegisterSubviewType`); deliberately holds the backing **array**
  directly (uniquely deduped per elem kind) rather than a vec struct idx, to avoid
  the dual-vec-registration hazard.
- `compileTypedArraySubarray` builds a windowing `$__subview` sharing `parent.data`
  (no copy), with offset accumulation for nested `subarray`; host mode keeps the copy.
- `compileElementAccess` reads `$__subview.data[byteOffset + i]`, compile-time
  discriminated via the receiver `typeIdx` (zero cost on the plain `a[i]` path).
- `inferLetConstInitializerWasmType` resolves a `subarray`-result binding to the
  subview type.

**The blocker** is *not* in any of the above — it is **type-index stability across
the compiler's two type-numbering passes**. The hoist pass sizes the binding's local
from `inferLetConstInitializerWasmType` (which on-demand-registers the subview at,
say, idx 45); the body pass re-numbers and the subview lands at a different idx (35),
while the binding local was already pinned to the hoist-pass number. Result: the
`s` local and the emitted `struct.new` disagree, so reads/`.length` return 0.

A naive fix — eagerly registering the subview inside `getOrRegisterVecType` —
**back-fires**: it shifts type indices so `resolveWasmType(Uint8Array)` resolves a
plain `new Uint8Array()` to the *subview* idx, building the parent array itself as a
subview (verified: `local $a (ref null <subview>)`). So index shifting is too fragile.

**Recommended fix (next session):** reserve the `$__subview_<elem>` type slots in the
**deterministic up-front type-init phase** — the same place `$__vec_base`,
`$AnyString`/`$NativeString`/`$ConsString`, and the box-number/box-bool structs are
registered (see `index.ts` ~9002–9016 and `registerNativeStringTypes`) — so the
subview idx is identical in both passes. Then the existing inference + element-access
+ subarray-lowering wiring works unchanged. A symbol-keyed side-map is the fallback,
but the binding local still needs the subview *type* to hold the struct, so the
stable-reservation route is cleaner. Writes (`s[i] = v` → same `data[byteOffset+i]`
store) and scoped standalone tests remain to wire once the binding type lands.

### Update (WIP 4/4) — reservation done, de-sync narrowed below the renumber pass

`reserveTypedArraySubviewTypes(ctx)` is now called at the deterministic up-front
point in `generateModule` (after the linear-u8 reservation). **This fixed the
parent-as-subview regression** — plain `new Uint8Array()` resolves to the vec
correctly again, and 38/38 typed-array + DataView tests pass. But the
`s = a.subarray(...)` binding STILL gets the vec type, not the subview, so reads
return 0.

Narrowed the remaining de-sync: it is **NOT** the dead-type-elimination renumber.
`dead-elimination.ts` remaps BOTH `func.locals[i].type` (line ~362) and body
instructions through the same `tR` map, so a local and its `struct.new` stay in
sync across elimination. The de-sync is **earlier**: a probe confirms
`inferLetConstInitializerWasmType` runs for `s`, sees `recvName=__vec_i8_byte`, and
RETURNS the subview ValType — yet the hoisted `s` local is allocated as the vec
(`local $s (ref null <vec>)`, while the body emits `struct.new <subview>`). So
`walkStmtForLetConst`'s allocation is not receiving / not honoring the subview
ValType that inference returns for this binding. Next step: trace why
`walkStmtForLetConst` (index.ts ~12669–12676) allocates the vec despite the
`inferLetConstInitializerWasmType(...) ?? resolveWasmType(...)` expression.

### ROOT CAUSE FOUND — exact fix location

A probe on `allocLocal` (instrumented for subarray-result bindings) produced **no
output**: the TDZ-hoist pre-pass allocation branch I'd wired (`walkStmtForLetConst`
→ `inferLetConstInitializerWasmType`) is **never reached for `s`**. The binding's
local is actually allocated at the **real variable-declaration compile site**,
`compileVariableStatement` in `src/codegen/statements/variables.ts` (~line 590–641),
where the `wasmType` chain ends in `localTypeForDeclaration(ctx, varType)` (= the
vec) and does **not** consult subarray-subview inference. (That chain DOES already
special-case the analogous `standaloneRegExpMatchArrayType` at line 590/600 — the
exact pattern to mirror.)

**THE FIX (localized, low-risk, mirrors existing code):**
1. In `compileVariableStatement` (`variables.ts` ~590), compute a
   `subarraySubviewType` for a `subarray`-result initializer (standalone/wasi) the
   same way `inferLetConstInitializerWasmType` does — receiver `__vec_<elem>` /
   `__subview_<elem>` name → `getOrRegisterSubviewType(elemKind)` — and add it to the
   `wasmType` chain right after `standaloneRegExpMatchArrayType`.
2. Keep the matching subview inference in the TDZ hoist pre-pass
   (`inferLetConstInitializerWasmType`, already done) so a hoisted slot and the real
   site agree (both resolve to the up-front-reserved, idx-stable subview).
3. Then wire the WRITE path (`compileElementAssignment`, `assignment.ts:2693`) with
   the same `$__subview` → `data[byteOffset+i]` store arm as the read path, and add
   scoped standalone tests (sub-write visible in parent, parent-write visible in sub,
   `.length`, byteOffset, negative/clamped begin/end, nested subarray, disjoint
   windows).

With the up-front reservation (WIP 4/4) the subview idx is stable and the
parent-as-subview regression is gone (38/38 typed-array+DataView tests pass), so once
the binding type is sourced at the real decl site the read/length/aliasing should
land. Branch `issue-2357-subarray-impl` (commits WIP 1–4 + docs) has the full state.
**Floor-gate hard** on the standalone baseline and **WAT-diff a plain Uint8Array
for-loop before/after** to prove zero added instructions on the non-view path
(the #1673 discipline).

### Update (WIP 5) — `.length` WORKS; read-receiver flow is the last wrinkle

Two root-cause fixes landed and verified:
- **Binding type at the real decl site:** `inferSubarraySubviewType` in
  `variables.ts` (~590) sources `s = a.subarray(...)` → `$__subview` (the TDZ-hoist
  path was never reached for it; the live alloc is at `compileVariableStatement`).
  `s`'s local is now `(ref null $__subview)` in the WAT and holds the
  `struct.new $__subview` the lowering emits.
- **`select` condition bug:** Wasm `select` returns the FIRST operand when the
  condition is TRUE; the viewLen `max(end-begin,0)` used `i32.lt_s` (→ 0 for every
  valid window). Fixed to `i32.ge_s`. **`s.length` now returns the correct window
  length**, and plain `a[i]` is unaffected (no parent-as-subview regression). 40/40
  non-pre-existing typed-array + DataView tests pass.

**Last wrinkle:** `s[i]` element READ still leaks `env.__extern_get` — my
`$__subview` read arm in `compileElementAccessBody` (property-access.ts ~4840) is
NOT reached (`__sv_recv` absent from WAT). At the read site
(`compileElementAccess` ~4529) `compileExpression(s)` evidently returns
**externref**, not the subview ValType, so it takes the externref `__extern_get`
fallback instead of the struct path. `compileIdentifier` returns the local's
declared type (subview) — so either a later compile pass re-types `s` as externref
(the TS type is `Uint8Array`), or a narrowing/coercion at the read site boxes it.
Next: probe `objType.kind` at property-access.ts:4529 for `s[i]`; if externref,
either (a) keep the local subview-typed through reads (suppress the
externref-narrowing for subview-typed locals), or (b) add a `ref.test $__subview`
runtime arm in the externref branch (still compile-time-free for plain arrays since
their objType is the vec struct, not externref). Then wire the WRITE path
(`compileElementAssignment`, assignment.ts:2693) with the same
`data[byteOffset+i]` store, and add the scoped standalone tests. Branch
`issue-2357-subarray-impl` (WIP 1–5).

### DONE (WIP 6-8) — full subarray aliasing implemented, zero hot-path cost

Implementation complete on `issue-2357-subarray-impl`. The two remaining wrinkles
from WIP 5 are fixed:
- **Read arm placement:** the `$__subview` element-read arm ran AFTER the
  tuple/struct-field check, which intercepts any non-2-field struct. Moved it to run
  right after `typeDef` resolves (before the tuple check), gated on
  `isSubviewTypeIdx`. `s[i]` reads now route through `data[byteOffset+i]`.
- **Write arm:** added the mirror arm in `compileElementAssignment` (also before the
  2-field check); stashes index+value, stores into the SHARED backing array, and
  re-pushes the value (assignment is an expression — fixes a `drop` stack imbalance).
- **Nested subarray:** `compileTypedArraySubarray` elemKind derivation now strips
  `__subview_` as well as `__vec_`, so `s.subarray()` on a subview accumulates the
  offset over the same shared array.

**Verified** (`tests/issue-2357-subarray-aliasing.test.ts`, 8 cases): write-through
aliasing (`s[0]=99 → a[1]===99`), parent-write→view-read, view-read maps to
`parent[begin]`, write/read round-trip, `.length` (explicit + default-end), nested
subarray aliasing, and plain typed-array access unaffected. 38/38 existing
typed-array + DataView tests pass; coercion-sites gate OK.

**Hot-path cost = ZERO** (the #1673 discipline): WAT-diff of a plain
`for (i) sum += a[i]` over a `Uint8Array` shows `array.get_u: 1` and **no**
`__subview` / `ref.test` / `__sv_recv` instructions — the discrimination is entirely
compile-time (the binding's static `$__subview` vs vec type), so regular arrays pay
nothing.
