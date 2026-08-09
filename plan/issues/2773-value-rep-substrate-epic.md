---
id: 2773
title: "[EPIC][ARCH] Value-rep substrate: consistent native dispatch for reconstructed-struct field access + DCE/finalize-stable typeIdx"
status: ready
sprint: current
model: fable
fable_role: implement
created: 2026-06-28
updated: 2026-07-17
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: epic
area: codegen
language_feature: value-representation
goal: value-rep-substrate
related: [2681, 2686, 2760, 2674, 2664, 2660, 2075, 2151, 2357]
blocks: [2681, 2686, 2760, 2767, 2768, 2770]
---

# #2773 — Value-rep substrate EPIC

Umbrella for the value-representation substrate work. Three independent hard
issues converged on the **same wall** this session; this epic is the shared
substrate they all depend on. It was previously banked as "not this budget" —
that deferral is now **lifted** (stakeholder committed the sprint to it).

`#2681`, `#2686`, `#2760`, `#2767`, `#2768`, `#2770` all **depend on** this epic
and should be closed by its slices, not by independent point-fixes.

## The convergence (why this is one problem, not three)

| Issue                                                      | Surface symptom                                                                                                                                                                                                                                        | Underlying substrate defect                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #2681 / #2686 (acorn parse walls)                          | `parse("x")` / `parse("1+2*3;")` moved from THROW to **HANG** after sr-acorn's A1–A3 `new this()` reconstruct landed the `parseExprAtom` switch. The hang is a `scope.flags` `__extern_get` that reads `undefined`; `currentVarScope()` loops forever. | A reconstructed-struct field read reached via a typed/`any` receiver routes through the host proxy (`__extern_get`) instead of native `struct.get`, diverging from the `struct.set`-written slot. The `Scope`-typed read path bakes a `ref.test $__fnctor_Scope` whose **typeIdx misses despite the struct being built+registered**. |
| #2760 (plain-array OOB → undefined)                        | `a[OOB]` returns a type-default sentinel (sNaN / `false` / `null`), not `undefined`.                                                                                                                                                                   | The element-read result needs an **externref-or-undefined** representation that ripples to every f64 consumer — a value-rep-shape decision, not a helper-flag flip.                                                                                                                                                                  |
| #2767 / #2768 / #2770 (bare-var nominal receiver dispatch) | Non-`Date` receivers regress; boolean-method results lose their brand.                                                                                                                                                                                 | `externref → ref` receiver recovery is **unguarded** across ~10 dispatch sites; the boolean-method result brand is dropped across 4 dispatch-result sites.                                                                                                                                                                           |

All three are facets of one substrate question: **what is the in-flight
representation of a value as it crosses a dispatch/host/array boundary, and does
native struct identity + brand + typeIdx survive that crossing?**

## Root cause — pinned (keystone)

The `$__fnctor_<F>` struct type for a reconstructed constructor is registered
**on-demand at the `new F()` / `new this()` call-site compile time**
(`src/codegen/expressions/new-super.ts:1147-1155` —
`const structTypeIdx = ctx.mod.types.length; ctx.mod.types.push(...)`). The index
is therefore assigned at a **non-deterministic mid-compile point** that depends on
which function the compiler reached first. This produces **two** failure modes,
which are the same bug seen from two angles:

1. **Candidate-set freeze (`any`-receiver read path).** A lifted-method read site
   that compiles _before_ the `new F()` site enumerates its struct candidates via
   `findAlternateStructsForField` (property-access.ts:1370), which reads
   `ctx.structFields` + `ctx.structMap`. If `__fnctor_F` isn't registered yet, it
   is **excluded** from the candidate set → no `ref.test` arm → the read falls to
   `__extern_get`. The #2674 finalize-filled `__get_member_<name>` dispatcher
   already fixes _this_ facet for the `any` path (it re-enumerates at finalize).

2. **typeIdx instability (typed-receiver read path) — THE UNFIXED KEYSTONE.** A
   _concretely_ typed receiver (`Scope`-typed) reads via a direct
   `struct.get $__fnctor_Scope` / inline `ref.test $__fnctor_Scope`. The compiler
   numbers types across **two passes** — an early measuring/hoist pass
   (`inferLetConstInitializerWasmType`, sizes hoisted locals) and the final emit
   pass. A type registered **on-demand** lands at a **different index in each
   pass** (see `reference_subview_type_idx_stability`,
   `project_type_index_shift_and_deadelim`), so the hoisted-local/`ref.test`
   typeIdx disagrees with the emit-pass `struct.new` typeIdx → **`ref.test`
   misses even though the struct is built**, and `dead-elimination.ts`'s
   prune+renumber compounds the drift. This is the `scope.flags` miss
   sendev-acorn pinned.

Both facets collapse into a **single fix**: reserve every reconstructed-fnctor
struct type slot at the **deterministic up-front type-init phase** (the same
stable point as `reserveTypedArraySubviewTypes` / `reserveLinearU8AllocType` /
`$ObjVecArr`), so the index is identical across passes AND the candidate set is
complete at every read site. This is the **KEYSTONE SLICE (S1)** below.

## Design

### Invariant the substrate must enforce

> A value's native representation (struct identity, primitive brand, and the
> **typeIdx** used in its `ref.test`/`ref.cast`/`struct.get`/`struct.new`) is
> **stable from declaration through every dispatch, host-boundary, and
> array-element crossing**, and is **identical across the hoist pass, the emit
> pass, and after dead-elimination renumbering**.

Four sub-properties, each owned by a slice:

1. **typeIdx stability (S1, keystone).** All reconstructed-fnctor struct types are
   reserved at one deterministic up-front point so their index is pass-invariant
   and DCE-survivable. ⇒ `ref.test`/`struct.get` hit.
2. **Read/write/compound/delete-aware symmetry (S2).** _Every_ field read of a
   reconstructed struct reached via a typed or `any` receiver routes through the
   same native dispatch its write uses — including `+=`/`++` compound ops and the
   `tryEmitDeleteAware*` (`#2179`) paths. (sr-acorn's branch already implements
   most of this; S2 lands + validates it on top of a stable S1.)
   2b. **`new this()` escape-gate reconstruct (S2b).** Teach the escape gate to
   classify `new this()` inside a static/prototype method as an `F` reconstruct
   site so `Parser` gets a `$__fnctor_Parser` struct (sr-acorn A1–A2). Inert
   without S1+S2; load-bearing with them.
3. **Array-element identity (S3).** A native struct ref stored into a host-backed
   array (`arr.push(structRef)`) and read back must **not** be re-proxied to a
   host externref — it must round-trip the same struct identity (so a parser that
   `this.scopeStack.push(scope)` then re-reads `scope.flags` sees the native
   slot).
4. **OOB / brand result representation (S4, S5).** The element-read result carries
   a true `undefined` singleton on OOB (#2760, S4); receiver recovery is guarded
   and boolean-method results keep their brand across all dispatch sites
   (#2767/#2768/#2770, S5).

### Why up-front reservation (S1) is the keystone, mechanically

`findAlternateStructsForField` (the candidate enumerator for BOTH read and write
dispatch) is a pure function of `ctx.structFields` + `ctx.structMap`. The
finalize-filled `__get_member`/`__set_member` dispatchers (#2674/#2664) already
re-enumerate at finalize, so they are _complete_ — but the **typed-receiver
inline path bakes an absolute typeIdx** that the two-pass numbering desyncs.
Reserving the slot up-front (placeholder→fill, exactly like class struct types in
`class-bodies.ts`) makes the index pass-invariant, which is the one thing the
finalize dispatcher cannot retroactively fix. Once S1 lands, sr-acorn's A1–A3
read/write symmetry (S2) becomes load-bearing instead of inert, and the `Scope`
typed-path `ref.test` hits.

## Slice plan (ordered, independently shippable, KEYSTONE FIRST)

Every slice is **broad-impact** → validate via **full `merge_group` +
standalone-floor**, never a scoped sweep (`project_broad_impact_validate_full_ci`,
`project_standalone_floor_only_on_merge_group`).

| #       | Slice                                                             | Scope                                                                                                                                                                                                              | Unblocks                                                 | Role                                                       |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| **S1**  | **Up-front fnctor struct-type reservation (KEYSTONE)**            | Reserve every approved `$__fnctor_<F>` struct slot (incl. `new this()` owners) in the deterministic type-init phase; placeholder→fill; populate `structMap`/`structFields`/`typeIdxToStructName` up-front.         | typeIdx stability for #2681/#2686; foundation for S2/S2b | **senior-dev**                                             |
| **S2**  | Read/write/compound/delete-aware dispatch symmetry                | Land + validate sr-acorn's A3 + beyond-A3 routing (compound `+=`/`++`, `tryEmitDeleteAware{Get,Set}` → `__get_member`/`__set_member` dispatchers) on top of S1.                                                    | #2681/#2686 read/write divergence                        | **senior-dev**                                             |
| **S2b** | `new this()` escape-gate reconstruct                              | sr-acorn A1–A2: classify `new this()` in static/prototype methods as `F` reconstruct; owner resolvers.                                                                                                             | #2681/#2686 (Parser gets a struct)                       | **senior-dev**                                             |
| **S3**  | Array-element struct identity (no re-proxy on `.push`/host calls) | Ensure native struct refs stored into host-backed arrays round-trip without `extern.convert_any`→host-proxy identity loss.                                                                                         | #2681 `scope.flags` via `scopeStack.push`                | **senior-dev**                                             |
| **S4**  | Plain-array OOB → `undefined` (externref-or-undefined result rep) | #2760 re-spec: discriminate plain-array vs typed-view at the vec site (`property-access.ts:6341`), return the `undefined` singleton; ripple the result-rep change to f64 consumers without the shared-helper flip. | #2760                                                    | **senior-dev**                                             |
| **S5**  | Guarded receiver recovery + brand-preserving boolean results      | #2767/#2768/#2770: guard `externref→ref` recovery across ~10 dispatch sites (`emitThisReceiverGuardConvert`); preserve the boolean brand across the 4 dispatch-result sites.                                       | #2767/#2768/#2770                                        | **dev** (S5a guard audit) + **senior-dev** (S5b brand-rep) |

**Ordering rationale.** S1 must land first — it is the typeIdx-stability
foundation that makes S2/S2b correct (without it the `ref.test` arms S2 emits miss
at scale). S2 + S2b are a tight pair (the acorn parse fix) and should land in
quick succession after S1, re-validating against the full acorn dogfood. S3 is
independent of S1 mechanically but only _observable_ once S1+S2 stop the parser
from hanging earlier, so sequence it after S2. S4 (#2760) and S5 (#2767/8/70) are
mechanically independent of the fnctor work and may proceed in **parallel** with
S1–S3 by separate devs (different files), but each is still broad-impact.

## Build-on, do NOT redo

- **sr-acorn WIP**: branch `origin/issue-2681-acorn-new-this` (commit `ebc464375`),
  worktree `/workspace/.claude/worktrees/agent-ae75b7409d6e143f8/`. Has A1–A3 +
  symmetric read/write + compound + delete-aware routing, all typecheck-clean,
  minimal repros pass. S2/S2b **rebase this branch onto a merged S1**, they do not
  re-author it.
- **Findings + probes** in that worktree: the #2681 issue file's `## Implementation
attempt + findings`; `.tmp/acorn-run.mjs` (single-compile worker watchdog +
  host-call signature), `.tmp/dbg-keys.mjs` (extern_get key histogram),
  `.tmp/identity*.mjs` (struct-identity repros). **Read these before touching S1–S3.**
- The #2674 `__get_member_<name>` (member-get-dispatch.ts) and #2664
  `__set_member_<name>` (member-set-dispatch.ts) finalize-filled dispatchers are
  **already correct** — S1 makes their typed-path siblings stable; do not rewrite
  them.

---

# KEYSTONE SLICE (S1) — full spec

**Title:** Reserve all reconstructed-fnctor struct types up-front (pass-invariant,
DCE-stable typeIdx). **Role: senior-dev. Broad-impact: full `merge_group` +
standalone-floor.**

## Root cause (one sentence)

`$__fnctor_<F>` struct types are registered on-demand at the `new F()` call site
(`new-super.ts:1148`, `ctx.mod.types.length`), so their typeIdx differs between
the hoist pass and the emit pass and may be absent from a read site's candidate
set — making `ref.test $__fnctor_F` / `struct.get $__fnctor_F` miss despite the
struct being built.

## The fix — placeholder→fill at the up-front type-init phase

Mirror the class-struct placeholder→fill pattern (`class-bodies.ts`
`collectClassDeclaration`) and the subview/`$ObjVecArr` up-front reservations
(`index.ts`). Reserve **all** approved fnctor struct slots before any function
compiles, in two sub-passes so cross-fnctor field refs resolve.

### Change 1 — new reservation pass

**File: `src/codegen/fnctor-escape-gate.ts`** (new exported helper; it already
owns the whole-program fnctor analysis and `approvedNames`)

Add `export function deriveFnctorFields(ctx, funcDecl): FieldDef[]` by
**extracting** the field-derivation logic currently inline in
`new-super.ts:1064-1146` (`recordThisField` / `collectAssignmentChain` /
`collectThisAssignments` + the `ref → ref_null` widening loop). This becomes the
**single source of truth** for a fnctor's field shape, called by both the
reservation pass and (as a fallback) `new-super.ts`.

**File: `src/codegen/index.ts`** — new `reserveFnctorStructTypes(ctx, sourceFile)`
called in the up-front type-init block, **immediately after**
`reserveTypedArraySubviewTypes(ctx)` (≈ line 1138) and the `$ObjVecArr`
reservation, and **after** `ctx.fnctorEscapeGate = analyzeFnctorEscapeGate(...)`
(line 1081). Runs **unconditionally** (empty `approvedNames` ⇒ no-op ⇒
byte-identical output for fnctor-free modules).

```
function reserveFnctorStructTypes(ctx):
  gate = ctx.fnctorEscapeGate
  if !gate or gate.approvedNames.size === 0: return
  // Stable, deterministic order — sort the approved names so the reserved
  // index is identical across the hoist pass and the emit pass.
  names = [...gate.approvedNames]                       // incl. new this() owners (S2b)
        + [...gate.newThisOwnerNames]                   // (S2b adds this set)
  names = unique(names).sort()
  // SUB-PASS 1: reserve every index + name FIRST, so cross-fnctor field type
  // resolution in sub-pass 2 (a Parser field typed `Scope` → (ref null
  // $__fnctor_Scope)) resolves against an already-registered structMap entry.
  for F in names:
    decl = resolveFnctorDecl(ctx, F)                    // symbol.valueDeclaration
    if !decl or !decl.body: continue
    structName = `__fnctor_${F}`
    if ctx.structMap.has(structName): continue          // idempotent
    idx = ctx.mod.types.length
    ctx.mod.types.push({ kind:"struct", name:structName, fields: [] })  // placeholder
    ctx.structMap.set(structName, idx)
    ctx.typeIdxToStructName.set(idx, structName)
    ctx.fnctorReservedTypeIdx.set(F, idx)               // new ctx map (context/types.ts)
  // SUB-PASS 2: fill fields now that ALL names+indices exist.
  for F in names:
    idx = ctx.fnctorReservedTypeIdx.get(F); if idx === undefined: continue
    decl = resolveFnctorDecl(ctx, F)
    fields = deriveFnctorFields(ctx, decl)              // shared helper
    ctx.mod.types[idx].fields = fields                  // FILL IN PLACE (index unchanged)
    ctx.structFields.set(`__fnctor_${F}`, fields)       // candidate-set completeness
```

### Change 2 — `new-super.ts` consumes the reserved slot

**File: `src/codegen/expressions/new-super.ts`**, `compileNewFunctionDeclaration`
(line ~1147). Replace the on-demand registration:

```
// BEFORE:
const structName = `__fnctor_${funcName}`;
const structTypeIdx = ctx.mod.types.length;
ctx.mod.types.push({ kind:"struct", name:structName, fields });
ctx.structMap.set(structName, structTypeIdx);
ctx.typeIdxToStructName.set(structTypeIdx, structName);
ctx.structFields.set(structName, fields);

// AFTER:
const structName = `__fnctor_${funcName}`;
let structTypeIdx = ctx.fnctorReservedTypeIdx.get(funcName);
if (structTypeIdx !== undefined) {
  // Reserved up-front (S1): the slot, structMap, structFields, and
  // typeIdxToStructName are already populated with the SAME field shape
  // (deriveFnctorFields). Trust the reserved index — do NOT push a new type
  // (that would shift every downstream typeIdx and re-introduce the desync).
  // Use the reserved `fields` for the struct.new field-init loop below.
  fields.length = 0;
  fields.push(...ctx.structFields.get(structName)!);
} else {
  // Not reserved (defensive fallback — e.g. a fnctor reached via a path the
  // escape gate didn't approve): keep the legacy on-demand registration.
  structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind:"struct", name:structName, fields });
  ctx.structMap.set(structName, structTypeIdx);
  ctx.typeIdxToStructName.set(structTypeIdx, structName);
  ctx.structFields.set(structName, fields);
}
```

The `struct.new` field-init loop (lines 1168-1241) is **unchanged** — it iterates
`fields`, which now references the reserved shape. Verify the `fields` array used
by the init loop is **identical object/order** to the reserved one (the
`fields.length=0; push(...)` re-sync above guarantees same order; do NOT re-derive
independently here — divergent field order ⇒ `struct.new` arity mismatch).

### Change 3 — context plumbing

**File: `src/codegen/context/types.ts`** — add to `CodegenContext`:
`fnctorReservedTypeIdx: Map<string, number>`, initialized to `new Map()` in
`createCodegenContext`.

**File: `src/codegen/fnctor-escape-gate.ts`** — add `newThisOwnerNames:
ReadonlySet<string>` to the gate result (the `new this()` owners; S2b populates
it, S1 reads it — ship S1 reading an empty set if S2b lands second, but prefer
landing the gate-shape field in S1 so S2b is purely additive).

## Edge cases

- **Cross-fnctor ref fields.** A Parser field typed `Scope` resolves to
  `(ref null $__fnctor_Scope)` only if `Scope` is in `structMap` when Parser's
  fields are derived → **sub-pass 1 reserves ALL names before sub-pass 2 derives
  ANY fields**. Do not collapse the two sub-passes.
- **`ref → ref_null` widening** (new-super.ts:1136-1144) must run **inside**
  `deriveFnctorFields` so the reserved field set matches what `struct.new`'s
  `ref.null` default-init expects. (struct.new can't default a non-null ref.)
- **DCE survival.** A reserved-but-never-constructed placeholder (escape-gate
  approved but the `new` site is pruned) is **unreferenced** → `dead-elimination.ts`
  prunes+renumbers it cleanly (instructions are remapped in the same pass). A
  reserved-AND-filled struct is referenced by `struct.new`/`ref.test`/`struct.get`
  → survives. Both are safe — but confirm via a WAT-diff that a fnctor-free module
  is **byte-identical** (the pass is a no-op when `approvedNames` is empty).
- **Idempotency across passes.** `reserveFnctorStructTypes` runs once per
  `generateModule` invocation; `generateModule` runs fresh per pass. The sorted
  `approvedNames` order + the fixed call-site position guarantee the **same index
  in the hoist pass and the emit pass** — the entire point of the slice. The
  `ctx.structMap.has(structName)` guard makes it idempotent within a pass.
- **Empty-body fnctor / S3a reconstruct interaction.** The `compileFnctorNewAsObject`
  S3a path (new-super.ts:1051, standalone empty-body `$Object` reconstruction)
  fires BEFORE struct lowering and returns early — it never reaches the struct
  registration, so a reserved-but-unused slot for an S3a fnctor is the
  prune-cleanly case above. No conflict.
- **A non-approved sibling `new F()` compiling first** (the cache-order note at
  new-super.ts:1044) populates `funcConstructorMap[F]`; with S1 the struct type is
  already reserved, so the cache holds the **reserved** index — consistent for both
  approved and non-approved sites. Verify `funcConstructorMap` caching reads the
  reserved index.

## Test plan

1. **Byte-identical no-op proof.** Compile a fnctor-free module (any existing
   equivalence test) before/after; WAT-diff must be empty. The pass is gated on
   `approvedNames.size > 0`.
2. **typeIdx-stability unit repro** (`.tmp/`): a fnctor whose field is read in a
   lifted method compiled _before_ the `new` site, AND a sibling fnctor referenced
   as a ref field — assert the read's `ref.test $__fnctor_F` matches the
   `struct.new $__fnctor_F` typeIdx (dump WAT, grep the type indices agree).
3. **sr-acorn minimal repros** (`.tmp/identity*.mjs` from the WIP branch): all must
   still pass (`new Parser(); p.getType()` → 7; `p.bump();p.bump()` → 45; nested →
   207).
4. **Acorn dogfood (the real gate, with S2/S2b stacked):** S1 alone will NOT close
   the acorn hang (it needs S2's read/write symmetry on the now-stable indices) —
   so S1's acceptance is the **stability invariant + no regression**, and the acorn
   `parse("x")`/`parse("1+2*3;")` AST result is **S2+S2b's** acceptance. Verify S1
   does not _worsen_ acorn (still hangs/throws is acceptable for S1-alone;
   verify with `.tmp/acorn-run.mjs`).
5. **Full `merge_group` + standalone-floor.** Broad-impact (changes struct-type
   ordering for every module with a reconstructed fnctor). NEVER a scoped sweep.
   Watch the standalone floor object-identity signature
   (`reference_standalone_floor_object_identity_and_real_vs_drift`).

## Acceptance criteria (S1)

- All approved `$__fnctor_<F>` struct types are reserved at the up-front type-init
  phase; their typeIdx is **identical across the hoist pass and the emit pass**
  (verified by WAT type-index diff on the unit repro).
- `findAlternateStructsForField` returns the complete candidate set at **every**
  read site regardless of compile order (`__fnctor_Scope` is present before its
  `new`-site compiles).
- Fnctor-free modules are **byte-identical**.
- No net test262 regression in `merge_group`; standalone floor holds.
- sr-acorn minimal struct-identity repros pass; the acorn parse hang is **not made
  worse** (its closure is S2/S2b).

## Classification summary

- **S1 (keystone), S2, S2b, S3, S4 → senior-dev** (Opus): typeIdx/representation
  surgery, broad blast radius, two-pass numbering hazards.
- **S5a (receiver-recovery guard audit) → dev**: mechanical guard insertion across
  the ~10 `emitThisReceiverGuardConvert` sites with a clear pattern.
- **S5b (boolean-result brand rep) → senior-dev**: result-representation change.

## S1 — Implementation notes (sendev-substrate, 2026-06-28)

**Landed exactly per the architect spec; the deviations below are mechanical, not
design changes.**

- **Reservation set = `approvedNames ∪ newThisOwnerNames`, SORTED.** `newThisOwnerNames`
  is empty in S1 (S2b populates it), so today the set is exactly the
  reconstruct-approved fnctor names. Verified empirically: for the keystone Parser
  shape the gate reports `reconstruct=2 keep-typed=0` so `Parser` and `Node` are
  both approved and both get reserved `$__fnctor_<Name>` slots. A `keep-static`
  fnctor (`new F()` with no dynamic/typed use) is NOT approved → its slot is not
  reserved → output stays byte-identical to main (proven below).
- **WHY only approved names, not every fnctor that builds a struct:** field shapes
  are INDEPENDENT of reservation order — `resolveWasmType` resolves a fnctor
  instance type to `externref` (host, the #1712 guard) and never keys `structMap`
  on the bare ctor name (`__fnctor_<Name>` ≠ `<Name>`), so a sibling fnctor field
  is `externref`/`f64`, never a cross-`(ref $__fnctor_Sibling)`. Up-front
  reservation therefore changes ONLY the type INDEX (the keystone), not the field
  set. Reserving the approved set is sufficient to stabilize the typeIdx of every
  fnctor whose typed/dynamic read desyncs; the two-sub-pass ordering is kept anyway
  (reserve-all-then-fill) so it stays correct if `resolveWasmType` ever gains
  fnctor-ref resolution.
- **`deriveFnctorFields` is the single source of truth** (extracted verbatim from
  the old inline `new-super.ts` logic, incl. the chained-assignment + if/loop
  recursion and the `ref → ref_null` widening). Both the reservation pass and the
  on-demand fallback call it ⇒ identical field set/order ⇒ no `struct.new`
  arity mismatch against the reserved type.
- **`new-super.ts` consumes the reserved slot** (FILL-in-place, never push) when
  `ctx.fnctorReservedTypeIdx.has(funcName)`; the legacy on-demand `mod.types.push`
  remains as a defensive fallback for a fnctor the gate didn't approve.
- **Name→decl resolution:** added `ctorDeclByName` to the gate result (first-seen
  decl per fnctor name, deterministic by source order) so the reservation pass
  resolves a name to the SAME declaration the on-demand path uses.

**Validation (all green locally):**

- **Byte-identical no-op proof (TRUE cross-compile vs main):** 7 fnctor-free
  modules + a keep-static fnctor, each ×{host, standalone, wasi}, emit
  **byte-for-byte identical WAT** on this branch vs `/workspace/src` (main). The
  reservation pass is provably inert when no fnctor is approved.
- **typeIdx stability / candidate-set completeness:** the keystone shape (a fnctor
  field read in a lifted method defined BEFORE the `new` site, plus a sibling
  fnctor) reserves `$__fnctor_Parser` + `$__fnctor_Node` up-front; binary
  instantiates and runs correctly (no `ref.test` miss / cast trap).
- **sr-acorn minimal struct-identity repros:** `identity2.mjs` → 7 / 45,
  `identity3.mjs` → 207 (the spec's stated targets). The `this:any` variant
  (`identity.mjs`) returns NaN on **both this branch AND main** — a PRE-EXISTING
  orthogonal dispatch gap, not made worse by S1 (closure is S2/S2b).
- **Fnctor/new-expression test suite:** 67/68 green. The single failure
  (`constructor-arity.test.ts`) is PRE-EXISTING and byte-identical to main — the
  test hand-rolls `{ env: {} }` but the class module has always required a
  `string_constants` import; unrelated to S1.
- Full `merge_group` + standalone-floor is the broad-impact gate (CI).

**S1 status: complete. S2/S2b rebase `origin/issue-2681-acorn-new-this` on top.**

## S2 + S2b — Implementation notes (sendev-substrate, 2026-06-28) — LANDED as substrate

Branch `issue-2681-s2-acorn` (merge of sr-acorn `ebc464375` onto merged S1).

- **Merge:** `fnctor-escape-gate.ts` auto-merged (sr-acorn's `new this()` resolvers
  - reconstruct classification alongside S1's `deriveFnctorFields`/`ctorDeclByName`/
    `newThisOwnerNames`); only `new-super.ts`'s import line conflicted. The 4 S2 files
    S1 didn't touch (`closures`/`assignment`/`unary-updates`/`property-access`) came
    in clean.
- **S2b** fills the empty S1 `newThisOwnerNames` placeholder from each
  reconstruct-classified `new this()` owner ⇒ `reserveFnctorStructTypes` reserves a
  pass-invariant `$__fnctor_Parser` (absent on main).
- **S2** = sr-acorn's read/write/compound/delete-aware dispatch symmetry, now
  load-bearing on stable typeIdx.
- **Validated:** typecheck exit 0; identity 7/45/207; acorn WAT now has
  `$__fnctor_Parser` + `__get_member_*`; `parse("1")`/`parse("1;")` attach the
  `Literal` (closes the **#2687** `expression:null` gap for literals).
- **Did NOT close #2681/#2686** — `parse("x")` still hangs. S1 already stabilized
  `$__fnctor_Scope`'s typeIdx, so the residual cause is **S3** (host/array-boundary
  identity loss), now spec'd as a standalone slice **#2784**.

**S2/S2b status: complete (substrate). Next: S3 = #2784 (closes #2681/#2686).**

> **S3 moved to its own dispatchable issue: #2784** —
> `plan/issues/2784-s3-array-host-boundary-struct-identity.md` (full pinned
> root-cause + fix direction). It supersedes the one-line S3 row in the slice
> table above.

---

# SLICE S4 — full spec — plain-array OOB → `undefined` (consumer-scoped externref-or-undefined result rep) — #2760

**Role: senior-dev. Broad-impact: full `merge_group` + standalone-floor.** Builds
directly on dev-rescue's #2760 re-spec (the #2760 issue file's `## ⚠️ Re-spec
required` section) — do NOT redo that investigation. Closes #2760, unblocks #2766.

## Root cause (re-confirmed by dev-rescue, do not re-verify)

`const a: number[] = [1,4,5]; a[4]` lowers `number[]`/`string[]`/`any[]` to a
**vec struct** and reaches the vec-struct element read at
`property-access.ts:6341` (the `emitBoundsCheckedArrayGet(fctx, arrTypeIdx,
arrDef.element, ctx, false, taSignedness)` call). That helper returns a
**type-default sentinel** on OOB (sNaN for f64, `false` for boolean,
`ref.null.extern`→`null` for externref), never the JS `undefined` singleton. The
`property-access.ts:6390` raw-array path the _original_ plan targeted is rarely
reached → patching it fixes ~nothing. The shared-helper flip (parked S2/#2198)
is the wrong fix: it perturbs typed-array/`$__subview`/array-method callers and
regressed `built-ins/Array/prototype/map/15.4.4.19-8-b-2.js`.

## Design — consumer-scoped OOB policy (bounds the f64-consumer ripple)

The hard constraint dev-rescue flagged: making the element-read result
**externref-or-undefined** "ripples to every f64 consumer of `a[i]`." The design
**eliminates that ripple** by making the result-rep change **consumer-aware** and
**scoped to the plain-array vec call site only** — the shared
`emitBoundsCheckedArrayGet` default stays `false` (byte-identical for every other
caller). Three policy arms at the read site, chosen by what is statically known:

1. **Bounds-eliminated read (`isSafeBoundsEliminated(fctx, expr)` is true).** A
   loop guard already proves `index < length`, so OOB is impossible →
   **unchanged**: raw `array.get` returning the element ValType (f64/i32/externref).
   Zero cost, zero blast radius. This is the hot path (`for(i<len) a[i]`).
2. **Numeric consumer (the read's `expectedType` is `f64`/`i32`).** `a[OOB]` in a
   numeric context (`a[k] + 1`, `const n: number = a[k]`, a store into an f64
   slot) is observably `undefined` coerced to number = **`NaN`** in JS
   (`undefined + 1` is `NaN`). The existing type-default **sNaN** sentinel already
   yields `NaN` here → **keep the f64 sentinel path** for numeric consumers (no
   box/unbox, no ripple). This arm is why the change does NOT ripple to f64
   consumers: they never see an externref.
3. **Reference / `any` / comparison consumer (expectedType is externref/`any`, or
   absent).** This is the _only_ arm where the true `undefined` singleton is
   observable (`a[OOB] === undefined`, `String(a[OOB])`, spreading, passing to a
   parameter). Here the read returns **externref-or-undefined**: in-bounds **boxes**
   the element (`__box_number` for f64, `__box_boolean` for boolean, pass-through
   for externref), OOB returns the `__get_undefined` singleton
   (`ensureGetUndefined`). Result ValType = `{kind:"externref"}`. The existing
   `coerceType(externref → …)` bridges to whatever the consumer ultimately needs.

The blast radius is therefore the read site + the EXISTING `coerceType` paths —
**not** every f64 consumer. Numeric consumers are observably identical to JS via
the NaN sentinel they already use; only reference consumers pay the box, and only
on the rare non-bounds-eliminated dynamic read.

## Changes

**File: `src/codegen/property-access.ts`**

1. **Thread the consumer's expected type into the read.**
   `compileElementAccessBody` (signature at line 5949) currently takes
   `objType: ValType` but NOT the consumer's expected type. Add a parameter
   `expectedType?: ValType` and pass it from the call sites (5653/5874/5882/5903/
   5913 — the callers already have the target type in scope; 5882 already passes
   an explicit `{kind:"externref"}`). For sites with no expected type, pass
   `undefined` (→ arm 3, the safe `undefined`-preserving default).

2. **Discriminate plain-array vs typed-array view at the vec site (≈6341).**
   The vec read serves BOTH plain `T[]` and TypedArray views. Add an
   `isPlainArrayElementRead` predicate: **true** when the receiver's static TS
   type is a plain `Array<T>`/`T[]`/tuple (NOT a TypedArray view name
   `Int8Array`…`Float64Array`/`DataView`, and NOT a `$__subview`). Reuse the
   receiver-type classification already computed near here (the existing
   `typedArrayViewSignedness(ctx, expr.expression)` returns a defined `"s"|"u"`
   only for i8/i16 typed-array views; for the general check, test the receiver TS
   type symbol name against the TypedArray view set, mirroring how
   `compileTypedArray*` paths detect views). Only the **plain-array** branch gets
   the new OOB policy; the TypedArray-view and `$__subview` branches keep their
   current semantics **byte-identical** (a typed-array OOB is also `undefined`,
   but it rides a different value-rep and is verified independently — explicitly
   OUT of S4 scope to avoid the parked-S2 blast radius).

3. **Apply the 3-arm policy** in the plain-array branch, replacing the single
   `emitBoundsCheckedArrayGet(..., false, ...)` call at 6342:
   - arm 1 (`isSafeBoundsEliminated`): unchanged raw `array.get` (+ existing
     `emitHoleToUndefined` for externref holes).
   - arm 2 (`expectedType` is f64/i32): keep
     `emitBoundsCheckedArrayGet(..., useUndefinedSentinel=false, ...)` (current
     sentinel → NaN in numeric context). Return the element ValType.
   - arm 3 (else): emit a bounds-checked read that **boxes in-bounds / returns
     `__get_undefined` on OOB**. Prefer reusing
     `emitBoundsCheckedArrayGet(..., useUndefinedSentinel=true, ...)` — but note
     that helper's `useUndefinedSentinel` only fires for `externref`/`ref_extern`
     element types (array-methods.ts:411). For an **f64/i32/boolean** element the
     helper does NOT currently emit the undefined branch, so arm 3 must wrap the
     read: build the same `idx < array.len` guard as the helper, in-bounds box the
     element to externref (`__box_number`/`__box_boolean`), OOB call
     `__get_undefined`. Factor this as a small local `emitPlainArrayUndefOrBoxed`
     in property-access.ts (do NOT widen the shared helper — that's the parked-S2
     trap). Return `{kind:"externref"}`.

**Do NOT touch:** `emitBoundsCheckedArrayGet`'s default (stays `false`); the
`$__subview` call site (property-access.ts:6034); any `array-methods.ts` internal
caller. They must be byte-identical (verify by WAT-diff).

## Result-rep / f64-consumer correctness (the ripple, handled)

- A consumer that requested **f64** gets arm 2 (NaN sentinel) — **no externref ever
  reaches an f64 consumer**, so there is no ripple, no unbox inserted, no perf
  change on numeric code.
- A consumer that requested **externref/any** gets arm 3; the value is already
  externref, consumed directly.
- A consumer with **no expected type** (statement-position read, or a context that
  later coerces) gets arm 3 (externref-or-undefined) and the standard
  `coerceType(externref → target)` bridges it — including the existing
  `null/undefined in f64 context → NaN` rule (type-coercion.ts) if it is later
  forced to f64. This is the conservative, JS-correct default.

## Edge cases

- **Negative index** (`a[-1]`): the `i32.lt_u` guard already treats negatives as
  huge-unsigned → OOB branch → `undefined` (arms 2/3). No extra handling.
- **Hole-in-bounds** (`[1,,3][1]`): keep the existing `$Hole → undefined`
  mapping (`emitHoleToUndefined`); S4 is about _absent_ (OOB), F2 (holes) is
  separate and unchanged.
- **`number[]` OOB previously sNaN**: under arm 2 still NaN (numeric consumer) —
  acceptance for `a[OOB] === undefined` requires arm 3, which fires for the `any`/
  comparison consumer. Confirm `a[OOB] === undefined` reaches arm 3 (the `===`
  operand is compiled with no f64 expectation → externref).
- **`map`-on-array-like** (`built-ins/Array/prototype/map/15.4.4.19-8-b-2.js`):
  goes through `array-methods.ts` internal callers, untouched → stays green.
- **Boolean element `boolean[]`**: arm 3 boxes via `__box_boolean` (not
  `__box_number`) — reuse the #2770 brand logic so `a[OOB-or-bool]` is a JS boolean,
  not `1`.

## Test plan

1. `const a: number[] = [1,4,5]; a[4] === undefined` → `true`; `a[-1] === undefined`
   → `true`; `a[1]` → `4` (in-bounds unchanged); `a[1] + 1` → `5` (arm 2, f64).
2. `string[]` / `boolean[]` / `any[]` OOB → `undefined`; in-bounds unchanged.
3. `built-ins/Array/prototype/map/15.4.4.19-8-b-2.js` green; typed-array reads
   (`Int8Array`/`Float64Array`) byte-identical (WAT-diff a plain `for(i)a[i]` loop
   and a typed-array read — expect no new instructions on the hot/typed paths).
4. `.ts`/`.js` parity: the safe OOB read identical for typed and untyped source.
5. Full `merge_group` + standalone-floor, net ≥ 0, no new bucket.

## Acceptance criteria (S4)

- `a[OOB]` on a plain `T[]` reads JS `undefined` for all element types (observable
  via `=== undefined`).
- `emitBoundsCheckedArrayGet` shared default UNCHANGED; typed-array / `$__subview` /
  array-method callers byte-identical.
- Hot numeric `a[i]` (bounds-eliminated and numeric-consumer) shows **zero** extra
  instructions.
- map-on-array-like green; no net test262 regression in `merge_group`.

---

# SLICE S5 — full spec — guarded receiver recovery (S5a) + boolean-result brand preservation (S5b) — #2767/#2768/#2770

**Two independently-shippable sub-slices.** S5b (brand) is mechanically isolated
from S5a (recovery guard) and can land first/in-parallel. Builds on dev-rescue's
#2770 root-cause and #2768's per-type table — do NOT redo that investigation.
**Context:** #2767 already MERGED (Date-only, via a `SAFE_BARE_VAR_RECOVERY_NOMINALS`
safelist after the broad substitution regressed 6 non-Date receivers in
`merge_group`). S5a = expand that safelist by hardening each type; S5b = the
type-agnostic boolean-brand fix (#2770, supersedes #2768's boolean cases).

## S5b — boolean-result brand preservation (#2770) — senior-dev, broad-impact

### Root cause (measured, #2770)

A boolean-returning builtin method on a **bare-var / dynamic** receiver returns a
JS **number** (`1`/`0`) not a **boolean** (`true`/`false`):
`var s; s = new Set(); s.add(3); s.has(3)` → `1`. Two coupled defects:

1. **Extern-method boolean returns lose the `boolean: true` brand.** An extern
   class method whose lib.d.ts return type is `boolean` is registered with
   `results: [resolveWasmType(ctx, retType)]` = `{kind:"i32"}` — the boolean brand
   is dropped (`declarations.ts:1655`; `registerBuiltinExternClasses` fallback in
   `index.ts:~11878`). An unbranded i32 coerces to f64/number at the `any`/return
   boundary instead of boxing as a JS boolean.
2. **The brand is dropped at MULTIPLE dispatch-RESULT sites, not one.** dev-rescue
   verified the bare-var `s.has(3)` does NOT return via `extern.ts`'s
   `methodInfo.results[0]` (extern.ts:~150). It dispatches through one of the
   `${className}_${methodName}` funcMap paths whose result ValType is
   `getWasmFuncReturnType(ctx, finalIdx) ?? resolveWasmType(ctx, retType)` — a bare
   i32 with the brand dropped — at **every** such site:
   `calls.ts:8738, 9398, 9479, 9595, 9627, 9736, 12932, 13590, 13613, 13695,
13732, 14051` (the `?? resolveWasmType(ctx, retType)` extern-method-result
   family; the #2770 note cited 4606/9220/9279/14077 as the routing sites — the
   actual ValType sites are these `getWasmFuncReturnType` returns), plus
   `extern.ts:~150` (`return methodInfo.results[0]`).
   (Set is Map-backed, so a dynamic receiver routes to `Map_has` (i32, defect 1)
   while a typed `Set` receiver routes to `Set_has` (externref) — why only the
   bare-var case is wrong; S5b fixes the i32-return side so routing no longer
   matters for booleans.)

### Fix — a shared `brandExternMethodResult` helper applied at EVERY result site

**New helper** (put in `shared.ts` so both `calls.ts` and `extern.ts` import it
without a cycle):

```ts
// Brand an extern-method result ValType as a boolean when the method's declared
// TS return type is boolean, so the any/return coercion boxes it via
// __box_boolean (true/false) instead of __box_number (1/0). Over-boxing guards:
// brand ONLY a bare i32 whose declared return type is exactly boolean; never
// touch f64/externref/already-branded results.
export function brandExternMethodResult(
  ctx: CodegenContext,
  tsReturnType: ts.Type | undefined,
  valType: ValType,
): ValType {
  if (!tsReturnType) return valType;
  if (valType.kind !== "i32" || (valType as { boolean?: boolean }).boolean) return valType;
  if (!isBooleanType(ctx, tsReturnType)) return valType; // strict: flags === boolean only
  return { kind: "i32", boolean: true };
}
```

**Apply at every extern-method-result return site.** Wrap the existing expression:

```ts
return brandExternMethodResult(
  ctx,
  retType,
  getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType),
);
```

at each of: `calls.ts:8738, 9398, 9479 (callReturnType=), 9595, 9627 (callReturnType=),
9736, 12932, 13590, 13613 (callReturnType=), 13695, 13732, 14051`, and
`extern.ts:~150` (`return brandExternMethodResult(ctx, <method TS return type>,
methodInfo.results[0]!)`). For `extern.ts`, derive the TS return type from the
method signature already resolved there (or thread `methodInfo`'s declared boolean
flag — prefer branding `methodInfo.results[0]` at REGISTRATION too: defect 1, see
below).

**Also brand at registration (defect 1)** so the `extern.ts` `methodInfo.results[0]`
path is correct at source: `declarations.ts:1655` and the `externMethod` fallback
in `index.ts:~11878` — when the declared return type is boolean, register
`results: [{kind:"i32", boolean:true}]`. This is the single-site fix that makes
the registration honest; the per-call-site `brandExternMethodResult` wraps the
`getWasmFuncReturnType` paths that bypass `methodInfo.results`.

### Edge cases (S5b)

- **Over-boxing guard**: brand ONLY when the declared return type is exactly
  `boolean`. Number-returning methods (`map.get`, `indexOf`, the `size` accessor)
  stay numbers; `isBooleanType` must reject `number`/`boolean | undefined` unions
  unless they reduce to boolean. Verify `map.get` / `map.size` / `indexOf` stay
  numbers.
- **No double-box**: skip when `valType` is already externref (typed `Set_has`
  path) or already `boolean:true`.
- **ES2025 boolean Set methods**: `isSubsetOf`/`isSupersetOf`/`isDisjointFrom`
  return boolean → covered by the same brand.
- **`getWasmFuncReturnType` already returns a branded i32**: if a wasm func's
  declared return is already `{i32,boolean:true}`, the `??` short-circuits and the
  brand survives — the wrap is idempotent.

### Acceptance (S5b)

- `var s; s = new Set([1]); s.has(1)` → `true`; same for `map.has`, `set.delete`,
  `map.delete`, `re.test`, and the ES2025 boolean Set methods.
- Typed-receiver booleans unchanged; numeric methods stay numbers; no double-box.
- `language/literals/regexp/y-assertion-start.js` (`re.test`) flips green.
- Full `merge_group` green (extern method-call result path is hot/broad).

## S5a — guarded externref→ref receiver recovery + safelist expansion (#2768) — senior-dev

### What #2767 left (do not re-author)

#2767 added `resolveAssignedNominalType` (recover the nominal type a bare-`var`/
`let` identifier holds when the TS checker reports evolving-`any`) and substitutes
it at the call dispatch hub (`calls.ts:~8746`), gated by a
`SAFE_BARE_VAR_RECOVERY_NOMINALS` safelist = **Date only** (the broad substitution
regressed 6 non-Date receivers in `merge_group`). S5a **expands the safelist one
type at a time**, each behind a hardened recovery path + full `merge_group`.

### The 6 regressors and their per-site fix (from #2228's merge_group delta)

| type                                | test262 evidence                                                                                      | failure                                                 | per-site fix                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Promise**                         | `built-ins/Promise/prototype/finally/{rejected,resolved}-observable-then-calls-PromiseResolve.js`     | `illegal_cast` in the recovered closure (`__closure_0`) | guard the externref→ref recovery with `ref.test` BEFORE `ref.cast` on the Promise/thenable path (the cast currently trusts the substituted type)                                       |
| **RegExp**                          | `language/literals/regexp/y-assertion-start.js` (`re.test`)                                           | returns truthy `1` not `true`                           | **subsumed by S5b** (boolean brand). Land S5b first; RegExp recovery then only needs the `ref.test` guard.                                                                             |
| **SharedArrayBuffer / ArrayBuffer** | `built-ins/SharedArrayBuffer/prototype/grow/this-is-not-resizable-arraybuffer-object.js`              | `.grow()` skips the spec TypeError                      | brand-check the recovered buffer receiver (`ref.test` the resizable-buffer brand; throw the spec TypeError on miss) before dispatch                                                    |
| **super-spread**                    | `language/expressions/super/call-spread-obj-spread-order.js`                                          | `wasm_compile` (invalid Wasm)                           | the recovered super/closure receiver emits invalid Wasm — the super-call lowering must tolerate the substituted type (do not substitute into the super path, or emit a valid coercion) |
| **DisposableStack**                 | `built-ins/DisposableStack/prototype/dispose/throws-error-as-is-if-only-one-error-during-disposal.js` | `assertion_fail`                                        | recovered dispatch path partial — harden the DisposableStack method dispatch before safelisting                                                                                        |

### The guard pattern (the common mechanism)

The shared defect across the cast/`illegal_cast`/`wasm_compile` regressors:
`resolveAssignedNominalType` substitutes a nominal type, and the downstream
value-recovery does an **unguarded** `externref → ref $T` (`coerceType` emits
`any.convert_extern` + `ref.cast` — type-coercion.ts:~1466) that **traps** when the
runtime value is NOT a `$T` (a `method.call({})`, a thenable that isn't the native
Promise, etc.). The fix is the **`ref.test` before `ref.cast`** discipline the
codebase already uses at `emitThisReceiverGuardConvert` (property-access.ts:5443,
used at 4018/5868/array-object-proto:514) and the `.call`/`.apply` brand-guard at
`calls.ts:4606` (which emits a `ref.test` guard + catchable TypeError on mismatch).

**S5a per-type loop (one PR per type, or a small batch):**

1. Route the recovered receiver's externref→ref recovery through a **guarded**
   convert (`ref.test $T` → on true `ref.cast` + dispatch; on false → the type's
   spec behavior: TypeError for brand-check methods, or fall through to dynamic
   dispatch) — reuse/extend `emitThisReceiverGuardConvert` so the guard is shared,
   not re-implemented per type.
2. Add the type to `SAFE_BARE_VAR_RECOVERY_NOMINALS`.
3. Validate the cited test262 file(s) + a full `merge_group` (net ≥ 0, no new
   bucket) BEFORE moving to the next type.

### Also (folded from original #2768): property read/write recovery

Property **reads** (`d.field`) / **writes** (`d.x=…`) on a bare-var receiver
compute their OWN `receiverType` in `property-access.ts`
(`compilePropertyAccess`, the `objType = getTypeAtLocation(...)` site), separate
from the call hub. Struct-field reads/writes already work (runtime recovery); the
divergent cases are builtin property reads keyed on the static nominal symbol
(`Map.size`, `Set.size`, `ArrayBuffer.byteLength`). When a type is hardened +
safelisted, ALSO route `resolveAssignedNominalType` through the property
read/write `objType` resolution, gated on the **same** safelist. Hoist the shared
helper to `shared.ts` (calls.ts imports from property-access.ts → cannot live in
either without a cycle).

### Acceptance (S5a)

- For each type added to `SAFE_BARE_VAR_RECOVERY_NOMINALS`: its externref→ref
  recovery is `ref.test`-guarded, the cited test262 file(s) pass, full
  `merge_group` net ≥ 0, no new bucket.
- `resolveAssignedNominalType`'s var/let-only + all-assignments-agree + safelist
  guards remain intact; never substitute a non-safelisted type.
- Never remove a type from the safelist without a regression.

## Classification (S4/S5)

- **S4 → senior-dev** (result-rep union + consumer-aware threading, broad-impact).
- **S5b → senior-dev** (multi-site result-brand + registration change, hot path).
- **S5a → senior-dev** (per-type recovery guards + safelist; each addition is a
  small PR but each touches the brand-guard mechanism and needs a `merge_group`
  validation — senior-dev judgment per type). The mechanical guard insertion at a
  single already-understood site could be a dev task, but the per-type spec
  behavior (TypeError vs fall-through, super-path validity) is senior-dev.

## Landed slices (reconcile 2026-07-02)

Epic stays **in-progress**. Per-slice merge state:

- **S1** (keystone, up-front fnctor struct-type reservation) — LANDED, PR #2234.
- **S2 + S2b** (dispatch symmetry + `new this()` reconstruct) — LANDED, PR #2247
  (also fixed the dispatcher funcIdx over-shift).
- **S3** (array-element struct identity / native-vec-aware dispatch) — LANDED
  under #2784, PR #2260 (#2784 is `done`).
- **S4** (#2760 plain-array OOB → `undefined`) — resolved: folded by the IR
  ElementAccess prove-then-specialize work (#2766, PR #2233); #2760 is `done`.
- **S5b** (#2770 boolean result branding) — LANDED, PR #2249; #2770 is `done`.
- **S5a** (#2767/#2768 guarded receiver recovery): #2767 LANDED, PR #2228
  (`done`). **Remaining:** #2768 per-type safelist expansion/hardening is still
  `ready` — the open tail of this epic.

---

# SLICE S6 — HOF element-rep: dynamic-index native-vec read — #2773 (fable-2773, 2026-07-09)

**Role: senior-dev. Broad-impact (touches every dynamic-index externref element
read in host/gc mode). Byte-identity proven on unrelated code.**

## Repro (empirical, current main 95af8b0)

The "callbackfn called with correct parameters" test262 family passes a **named
function declaration** as the HOF callback:

```js
function callbackfn(val, idx, obj) {
  if (obj[idx] !== val) bPar = false;
}
[0, 1, true, null, new Object(), "five"].map(callbackfn); // srcArr[999999] = -6.6
```

TS does **not** contextually type the params of a _named function passed by
reference_ (only inline arrow/function-expression params get contextual types),
so `val`/`idx`/`obj` are implicit **`any`**. The heterogeneous array lowers to a
native WasmGC **externref-element vec**, and the callback's 3rd `array` arg
reaches the body coerced to `externref` (`extern.convert_any` on the vec ref).
Inside, `obj[idx]` with a **dynamic `any` index** used to route to the host
`__extern_get`, which **cannot read the opaque WasmGC vec** → returned
`undefined`. So `obj[idx] !== val` was wrongly `true` and the whole family failed.

Pinned distinction (why the inline-arrow probe passed but the named-fn test
failed): `srcArr.map((v,i,a)=>a[i]===v)` — the arrow's `i` **is** contextually
typed `number`, so `isNumericIndexExpression` is true and the #2784
static-numeric native-vec read already fired. The `#2784` arm only covers a
**statically-numeric** index; the dynamic-`any` index (the named-fn `idx`) fell
through to `__extern_get`.

## Root cause (one sentence)

`obj[idx]` on an `any`/externref receiver that is a native WasmGC vec, where the
index is a **dynamic `any`-typed** expression, routed to the host `__extern_get`
(opaque to the vec ⇒ `undefined`) because the #2784 native-vec read only fires
for a statically-numeric index.

## Fix — dynamic-index native-vec read (the `__dyn_member_get` carrier shape)

`src/codegen/property-access.ts`, `compileElementAccessBody`, externref-receiver
branch. New arm gated on `!ctx.standalone && ctx.vecTypeMap.size > 0 &&
isAnyTypedIndexExpression(ctx, index)` (new predicate: index static type is
`Any`/`Unknown`, excluding string/symbol/union — those are genuine property
keys). It emits, at runtime:

```
recv → recvLocal;  key(externref) → keyLocal          // key compiled FIRST (#3007 flush order)
idxF64 = __unbox_number(keyLocal)                      // Number(key); NaN for a string key
idxI32 = i32.trunc_sat_f64_s(idxF64)
cond   = idxI32>=0 && idxI32 < __vec_len(recv) && f64(idxI32)==idxF64
if cond: __vec_get(recv, idxI32)                       // native per-kind element → boxed carrier
else:    __extern_get(recv, keyLocal)                  // non-vec host obj / OOB / string key
```

`__vec_len` returns **0 for a non-vec**, so it doubles as the vec-vs-host-object
discriminator **and** the in-bounds guard; the integer round-trip check
(`f64(idxI32)==idxF64`) rejects NaN/fractional/string keys so a genuine string
key never mis-indexes. `__vec_get` is the existing per-element-kind reader that
already boxes each kind to a carrier externref and maps `$Hole → undefined`. This
is exactly the corrected-memory `__dyn_member_get(recv,key)→carrier` primitive,
expressed inline over the existing native-vec helpers.

**Plumbing:** added `"len"` to `reserveVecMethodHelper` and made the finalize
`__vec_len` emit **fill-or-build** (like `__vec_get`), so the guard call can be
baked at property-access compile time before the finalize pass fills the body.

## Behavior-preserving for non-vec (the blast-radius bound)

For a non-vec externref receiver (a genuine host object / array-like) the guard
is always false → the `else` arm calls the **same** `__extern_get(recv, key)` the
old fallback used ⇒ **identical observable result** (host property read / OOB
`undefined`). The arm only _adds_ the correct native-vec answer. Byte-identity
proven on the playground corpus: `prove-emit-identity` reports **IDENTICAL — all
39 (file,target) emits** (the arm is gated on `vecTypeMap.size>0 &&
any-typed-index`, so vec-free / numeric-index code is untouched).

## Measured delta (via `runTest262File` on current main)

- **+18 test262 files** flip FAIL→PASS across the HOF fail-set (632 files):
  the `-c-ii-1/11/12/13` "callbackfn called with correct parameters" variants of
  `every`/`filter`/`forEach`/`map`/`reduce`/`reduceRight`/`some`.
- Regression sample: 65 previously-passing HOF files re-checked (no regression);
  full byte-identity on the unrelated corpus. `merge_group` full test262 is the
  real gate.
- Test: `tests/issue-2773-hof-dynamic-index.test.ts` (8 host-mode cases).

## Boundary — NOT closed by S6 (documented for follow-ups)

These are DISTINCT gaps surfaced while validating; each is a separate slice, not
part of the dynamic-index READ rep:

1. **Boxed-carrier `=== primitive-number`** (`obj[0] === 0` where `obj[0]` is a
   boxed-any carrier and `0` is an f64 literal). The `===` operator does not
   unbox the carrier against a primitive number operand → false. (`direct-any-
param-read` probe; pre-existing, unchanged.) Separate coercion slice.
2. **HOF hole visit-skip** (#2001 S2): `forEach`/`map`/… still VISIT holes
   (`[1,,3].forEach` count 3 not 2; `map` result NaN at the hole not a
   result-hole). The dynamic-index READ maps `$Hole → undefined` correctly, but
   the _visit semantics_ are #2001 S2/S3.
3. **Index-grow past length writes element-default, not `$Hole`** (#2001 S3):
   `a[3]=x` on a len-1 externref vec fills `[len,3)` with the default → HOFs then
   visit those as present. `oob-grow-forEach` / `A-sparse-tail-het` probes.
4. **Dynamic-index WRITE + read-back on a growing `any[]`** (`kIndex[idx]=1`
   inside a callback, then `kIndex[idx-1]`): the `-c-ii-5` / `-c-iii-1-6`
   variants. The WRITE side has no dynamic-index native-vec routing (this slice
   is READ-only). Symmetric follow-up to S6.
5. **Array-like `.call(obj)` receiver-shape** (`-c-ii-20/21/22/23`,
   `Array.prototype.map.call({0:11,length:2}, cb)` + `thisArg`): a plain-object
   array-like receiver, separate from the native-vec read.
6. **`arguments[3][idx]`** (`reduceRight -c-ii-12`): arguments-object + nested
   dynamic index — a distinct path.
7. **Standalone lane**: S6 is host/gc only (standalone has its own
   `__extern_get_idx` `$ObjVec` path); a standalone dynamic-index native-vec read
   is a parallel follow-up.

**S6 status: landed (this PR). The epic tail remains #2768 (S5a) + the boundary
items above.**

---

# SLICE S7 — externref plain-array OOB → `undefined` + length-bounded vec reads + grow-write gap-fill — #2773 (fable-2773t, 2026-07-09)

**Role: senior-dev. Broad-impact (touches every unproven plain-array element
read in every lane). Emit drift confined to 4/39 corpus (file,target) emits —
exactly the two files with dynamic array ops.**

## Verify-first correction to the S6 boundary doc

S6's boundary item 4 pinned the `-c-ii-5` family on the **dynamic-index
WRITE**. Empirically (probes on main 300fc5a) that was wrong: the write+grow on
the captured vec-struct receiver (`kIndex[idx] = 1`, typed `never[]` receiver)
**already works natively** — the family hung entirely on the **READ** side.
Decomposition (all probed):

1. `typeof kIndex[0]` on the empty tracking array read `ref.null.extern` →
   `typeof` = "object" ≠ "undefined" → every callback bailed on iteration 1.
   Cause: the F1 OOB→undefined floor (#2760/#2785/#2792) covered
   f64/boolean/symbol elements but **deferred externref** (`f1BoxType === null`
   → `emitBoundsCheckedArrayGet(..., false)` → OOB null).
2. After fixing (1), iteration 2 still failed: `kIndex[0]=1` on the empty vec
   **grows capacity to 4** (length 1), and the bounded read tested
   `idx < array.len(data)` — the **CAPACITY**, not the vec's logical `length`
   field — so `kIndex[1]` read the null gap slot "in bounds" instead of OOB.
   Same latent bug: `a.pop()` leaves the stale slot readable.
3. The reduceRight variant writes DOWNWARD (`kIndex[3]=1` first): the grow
   fills `[0,3)` with `array.new_default` nulls that become in-bounds once
   `length=4` — reads of the gap gave null, not `undefined`.

## The fix (three coordinated, call-site-scoped changes)

- **`src/codegen/property-access.ts`** (two `compileElementAccessBody`
  plain-array read sites): opt into the existing #1396 `useUndefinedSentinel`
  arm for externref/ref_extern elements, gated on the same `oobUndefined`
  policy (plain array, non-numeric consumer, not the regex-match vec). The
  shared helper DEFAULT stays false — subview/TA/array-method callers are
  byte-identical (#2198 S2 discipline). Numeric consumers keep the NaN
  sentinel (no externref ripple — the F1 consumer-scoping).
- **`src/codegen/array-methods.ts` `emitBoundsCheckedArrayGet`** +
  **`emitPlainArrayUndefinedOobGet`**: new optional `lengthBoundInstrs` param —
  the vec-struct call site tees the vec ref and passes
  `[local.get vecRef, struct.get length]` so the bound is the LOGICAL length,
  not capacity. Instrs are **cloned per push** (never alias one Instr object
  into the body twice — DCE double-remap hazard,
  `reference_shared_instr_object_dce_double_remap`). TA arm skipped
  (fixed-length views: capacity === length, bytes identical).
- **`src/codegen/expressions/assignment.ts`** (vec-struct element assign): on
  an index-grow write past the current length, `array.fill` the gap
  `[length, idx)` with JS `undefined` BEFORE the element write + length bump.
  Externref elements only (an f64/i32 slot cannot hold undefined — its gap
  stays the numeric default, #2001 S3 boundary). `emitUndefined` is emitted
  imperatively so the `__get_undefined` late import registers/shifts through
  the normal path.
- **Standalone neutral by construction**: `ensureGetUndefined` returns
  undefined under nativeStrings → the helpers fall back to `ref.null.extern`,
  which IS the standalone undefined convention.

## Measured delta

- **All 8 baseline-failing family files flip locally** (runTest262File):
  `every/some/map/forEach/reduce/reduceRight -c-ii-5`, `filter -c-ii-5`,
  `filter -c-iii-1-6`.
- New suite `tests/issue-2773-oob-length-bound.test.ts` (11 cases: tracking
  patterns both directions, grow-gap, pop stale-slot, `string[]` OOB,
  numeric-consumer NaN preservation, heterogeneous grow identity, standalone).
- Related suites green: array-oob-bounds-check, at-oob, 2001-S1 holes, 2760,
  2773-S6, 2785, 2792, 2798 (140 tests). The 2 failures in
  `tests/issue-2766.test.ts` are **pre-existing on main** (verified: identical
  failures on the main tree — `a[i] === undefined` constant-folds to false;
  flagged to the lead, NOT from this slice).
- `prove-emit-identity`: 35/39 (file,target) byte-identical vs main; the 4
  drifts are `calendar.ts::{gc,standalone}` + `algorithms.ts::{standalone,wasi}`
  — the corpus files with dynamic array reads/writes (intended surface).

## Boundary — NOT closed by S7

- **Static `typeof` fold on typed-element arrays**: `typeof a[i]` on a
  homogeneous `string[]` folds to "string" at compile time WITHOUT reading —
  wrong for an OOB/popped index. Orthogonal pre-existing defect (the fold, not
  the read rep).
- **f64/i32 vec grow-gap**: gap slots keep the numeric default (0) — in-length
  reads after a sparse grow on `number[]` give 0 not undefined ($Hole rep is
  #2001 S3).
- **Dynamic-index WRITE on an externref RECEIVER** (`obj[idx] = v` inside a HOF
  callback writing through the 3rd param): still drops silently via
  `__extern_set` on the opaque vec (probe `objparam-write-readback`). Zero
  test262 surface today (the `-c-ii-8` array-like variants pass — module-level
  array-likes are genuine host objects). The symmetric `__vec_set` helper
  (mirror `__vec_push`'s fill-or-build + reserve) is the next mechanical slice
  if playground/user-code ROI appears.
- **HOF hole visit-skip** (#2001 S2), **array-like `.call(obj)` receiver-shape**
  (`-c-ii-20+`), **`arguments[3][idx]`** — unchanged from the S6 boundary list.
  (S8 below closes the `.call(obj)` receiver-shape item.)

---

# SLICE S8 — array-like `.call(obj, cb, thisArg)` fidelity — #2773 (fable-2773t, 2026-07-09)

**Role: senior-dev. Scoped to `compileArrayLikePrototypeCall`
(array-methods.ts); prove-emit-identity: ALL 39 corpus emits byte-identical vs
main.**

## Root causes (probed)

1. **thisArg never installed.** The generic array-like loop calls the callback
   closure via `call_ref` but never installs the spec `thisArg` into the
   `__current_this` global — the #2152 install/restore existed only on the
   direct-array HOF path. `Array.prototype.map.call({0:11,length:2}, cb,
thisArg)` ran `cb` with the wrong `this` (probe: `this.threshold === 10` →
   false on every element). Direct `.map(cb, thisArg)` and `.call` WITHOUT
   thisArg both worked — the gap was exactly the 3-arg `.call` form.
2. **Boolean callback results boxed as numbers.** A boolean-returning callback
   (`return prev === null`) has its i32 result boxed via `__box_number` (1/0)
   into the reduce accumulator / map result array. Inline consumers mask it
   (`r === true` folds i32-side, true) but any `any`-typed consumer — the
   test262 harness's `isSameValue(a, b)` — sees Number 1 vs Boolean true →
   `assert.sameValue(result, true)` fails.

## Fix

- **thisArg**: compile `args[2]` (spec arg-eval order; methods with a thisArg
  slot only — reduce/reduceRight's `args[2]` is initialValue; arrow callbacks
  ignored) into an externref local; wrap each arm's callback invocation via a
  `withThisInstalled` factory. The factory is invoked at ARM-BUILD time and
  reads `ctx.currentThisGlobalIdx` FRESH: `__current_this` is a module global
  whose index shifts when an arm later adds a string-constant IMPORT global
  (`addStringConstantGlobal` → `fixupModuleGlobalIndices` patches committed
  bodies but NOT detached templates) — baking the idx early would desync.
- **boolean brand**: detect boolean-ness from the callback's TS call-signature
  return type (closure metadata erases the brand for named-fn refs);
  pre-register `__box_boolean` in the #16 up-front import block (so no funcIdx
  baked into a detached ladder template shifts later); the map/reduce/
  reduceRight i32 ladders box via `__box_boolean` when boolean. Host lane;
  standalone unchanged unless its native helper is registered (mirrors #2785's
  host-first shipping).

## Measured delta

- **A/B batched sweep, 1,605 files (7 HOF dirs), branch vs same-harness main
  control: +19 wins, 0 regressions** — the 13 targeted `-c-ii-20..23` files
  plus collateral wins (`-c-ii-16/17/18/24/25/31/32/34/35`, reduce `2-5`/`3-24`).
- `tests/issue-2773-arraylike-call-thisarg.test.ts` (9 cases: thisArg binding
  across 5 methods, arrow-ignores-thisArg, no-thisArg unchanged, boolean brand
  on reduce/reduceRight/map results, install/restore nesting).
- prove-emit-identity 39/39 byte-identical; ir-fallbacks OK; LOC baseline +100.

**S8 status: landed (this PR). Epic tail: #2768 (S5a) + `arguments[3][idx]` +
#2001 S2 hole visit-skip + f64-gap/`typeof`-fold boundaries from S7.**
