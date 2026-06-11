---
id: 1916
title: "Symbolic function references in WasmGC codegen — retire the late-import index-shift machinery"
status: ready
sprint: 61
model: fable
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
---
# #1916 — Symbolic function references in WasmGC codegen

## Problem

The WasmGC backend bakes **absolute function indices** into instruction
streams as it compiles. Any import added after bodies exist shifts every
defined-function index, so compensation machinery must find and patch every
instruction array in flight:

- `shiftLateImportIndices` (`src/codegen/late-imports.ts:139-270`) walks 13+
  roots: `mod.functions`, `fctx.body`, `savedBodies`, `currentFunc`,
  `funcStack`, `parentBodiesStack`, `liveBodies`, `pendingInitBody`,
  `funcMap`, `nativeStrHelpers`, `pendingMethodTrampolines`, exports, elem
  segments, `declaredFuncRefs`.
- A **second** shift regime (`reconcileNativeStrFinalizeShift`,
  `late-imports.ts:355+`, #1677) exists because raw `addImport` deliberately
  doesn't shift (the #618 revert).
- Context fields exist *only* to make bodies reachable for the shifter
  (`liveBodies`, `context/types.ts:940-946`, citing #1384) — the context
  schema is shaped by repair-pass reachability.
- `generateModule`'s prologue (`index.ts:954-1103`) is a 150-line ordering
  ballet of which emission must precede which import registration.

At least 7 numbered regressions trace to this one design decision: #618,
#1109, #1384, #1525b, #1666, #1677, plus the #172-era class trampoline bug.
The IR layer already proved the alternative works: symbolic refs instead of
raw indices (`src/ir/nodes.ts:22-28`), which is exactly why IR integration
doesn't need `shiftLateImportIndices` (`ir/integration.ts:20-23`).

## Proposed approach

1. Introduce `FuncHandle` — one shared mutable `{ index: number }` (or
   name-keyed) object per function/import, interned in the codegen context.
2. Emit call/ref instructions as `{ op: "call", target: FuncHandle }`;
   resolve handles to concrete indices **once**, at binary-encoding time
   (`src/emit/binary.ts`), the same place type indices are already final.
3. `addImport`/`ensureLateImport` then renumber by mutating handles — no
   instruction walking, no body registry, no ordering constraints.
4. Delete `shiftLateImportIndices`, `reconcileNativeStrFinalizeShift`,
   `liveBodies`, `pendingLateImportShift`, and the prologue ordering
   comments as they become dead.
5. Migrate incrementally: accept `number | FuncHandle` in the `Instr` union
   during transition; ratchet raw-number call sites to zero (same pattern as
   the #1095 cast budget).

## Acceptance criteria

- No instruction-walking shift pass remains; `git grep shiftLateImportIndices` is empty.
- Equivalence suite + test262 sharded CI green (net ≥ 0, no bucket regressions).
- `liveBodies` / `parentBodiesStack` bookkeeping removed from `CodegenContext`.
- A regression test that adds a late import after N bodies are compiled and
  validates the binary.

## Source

Compiler quality review 2026-06
(`docs/architecture/compiler-quality-review-2026-06.md`), WasmGC codegen
section. Related: #1677 (unified two shift regimes; this removes the regime),
#1899 (funcIdx authority contract). Needs an architect spec before dev
dispatch (`/architect-spec`).

## Implementation Plan (architect spec, 2026-06-11)

### Survey corrections to the problem statement

The file is `src/codegen/expressions/late-imports.ts` (not
`src/codegen/late-imports.ts`), and there are **more renumbering regimes
than the two listed**:

1. `shiftLateImportIndices` (late-imports.ts:139) — 13-root walker.
2. `reconcileNativeStrFinalizeShift` (late-imports.ts:355) — finalize regime.
3. **Two inline shift loops in `src/codegen/index.ts:6541` and `:7938`**
   (same `funcIdx >= importsBefore → += delta` pattern, private walkers).
4. **`src/codegen/dead-elimination.ts:137` remaps funcIdx** when dropping
   unused functions — a renumbering in the *other* direction.

Exactly **three instruction ops carry a function index** (`src/ir/types.ts:
239,240,269`): `call`, `return_call`, `ref.func`. Non-instruction carriers:
`mod.exports[].desc.index`, `mod.elements[].funcIndices`,
`mod.declaredFuncRefs`, `mod.startFuncIdx`, `ctx.funcMap`,
`ctx.nativeStrHelpers`, `ctx.pendingMethodTrampolines[].{method,trampoline}FuncIdx`.
Readers of `instr.funcIdx` mid-compile (~40 sites): `expressions.ts:292+`
(`wasmFuncReturnsVoid`), `stack-balance.ts` (5 sites), `fixups.ts:936`,
`statements/control-flow.ts:221`, `expressions/calls.ts:1675+`,
`dead-elimination.ts`, `emit/object.ts:461`, plus the #1899 pre-emit
validator (`emit/binary.ts:94-180`).

### Core design — name-symbolic, not mutable-index

Use a **pure name ref** (`FuncRef = { kind: "funcref"; name: string }`),
NOT the mutable `{ index }` cell floated in the proposal. Rationale:
- It is exactly the proven IR design (`IrFuncRef`, `src/ir/nodes.ts:30`) —
  "lowering resolves it to a concrete index AFTER all imports are finalized".
- A mutable shared index cell still needs *someone* to renumber it on every
  add/remove — that's the same coupling, just O(handles) instead of
  O(instructions). A name needs **no maintenance at all**: `addImport`,
  late imports, and dead-elimination's compaction all become invisible.
- `ctx.funcMap` is already the authoritative unique name→index namespace
  (uniqueness enforced by Map identity; binary.ts:380-392 derives the name
  section from the same names).

Resolution points:
- **Mid-compile readers** (`wasmFuncReturnsVoid`, stack-balance signature
  lookups, …): a tiny accessor `resolveFuncRef(ctx, ref): number` =
  `typeof ref === "number" ? ref : ctx.funcMap.get(ref.name)`. funcMap is
  kept current by the *existing* machinery during migration, so readers are
  correct in both worlds.
- **Emit time**: a normalize pass `resolveFuncRefsInModule(mod)` placed at
  the top of `emitBinaryModule` / `emitWat` / `emit/object.ts`: build
  name→final-index from `mod.imports` (in order) then `mod.functions`
  (`numImports + i`), rewrite every object-valued `funcIdx` to the number,
  hard-error on unknown or duplicate names. Self-contained on `mod` — emit
  keeps zero codegen-context dependency. The #1899 validator runs after it
  unchanged.

### Why this is automatically shift-proof during migration

`shiftLateImportIndices` (late-imports.ts:155) and
`reconcileNativeStrFinalizeShift` (:403) both gate on
`typeof funcIdx === "number"` — object refs are **skipped by the existing
walkers without any change**. Migrated call sites simply stop being the
shifters' problem. The two index.ts inline loops (6541/7938) need the same
`typeof` guard added (2 lines each).

### Slices (each lands green through CI independently)

**S1 — plumbing + proof (this branch).**
- `FuncRef` type + `funcRef(ctx, name)` interner (one canonical object per
  name so `===` dedup in walkers still works), in
  `src/codegen/registry/imports.ts`.
- Widen the three Instr ops to `funcIdx: number | FuncRef`
  (`src/ir/types.ts`).
- `resolveFuncRefsInModule(mod)` normalize pass + wiring into
  `emit/binary.ts`, `emit/wat.ts`, `emit/object.ts`; `resolveFuncRef(ctx,
  ref)` accessor for mid-compile readers; `typeof` guards on the two
  index.ts inline shift loops; `dead-elimination.ts` usedFuncs/remap taught
  to treat refs as by-name (names survive compaction — refs need no remap,
  but usedFuncs must mark the named function as live).
- Migrate ONE producer as proof: `emitUndefined`
  (late-imports.ts:517-525) emits `funcRef(ctx, "__get_undefined")` and
  drops its `flushLateImportShifts` call.
- Regression test (acceptance criterion 4): compile a module that forces a
  late import after N bodies exist; validate via `WebAssembly.validate` +
  execute. Plus a unit test for the normalize pass (unknown name → error).

**S2 — late-import family.** `ensureLateImport` returns `FuncRef`
(keep a `-Idx` shim for stragglers); migrate its ~150 consumers
(`ensureGetUndefined`, `ensureExternIsUndefinedImport`, type-coercion
helpers, …). After this, `flushLateImportShifts` calls ratchet out;
`pendingLateImportShift` deleted.

**S3 — defined-function call sites.** The ~667 `ctx.funcMap.get(name)` →
`{op:"call", funcIdx}` producers move to `funcRef(ctx, name)`, family by
family (closures, calls, native-strings, accessor-driver, trampolines).
`pendingMethodTrampolines` stores names, `finalizeMethodTrampolines`
resolves at rebuild time — kills the #1525b side-channel shifting.

**S4 — non-instruction carriers.** Exports/elements/declaredFuncRefs/
startFuncIdx become `number | FuncRef`, resolved by the same normalize
pass; `nativeStrHelpers` becomes name→FuncRef (or is deleted into funcMap).

**S5 — demolition.** Delete `shiftLateImportIndices`,
`reconcileNativeStrFinalizeShift`, `flushLateImportShifts`,
`nativeStrHelperImportBase`, `liveBodies`, `parentBodiesStack`,
`pendingLateImportShift` (context/types.ts:827,939,946,950), the two
index.ts inline loops, and the generateModule prologue ordering comments.
Add a ratchet assert (debug builds): producing a raw-number `call` where a
FuncRef is available is an error.

### Risks / edge cases

- **Name uniqueness** is load-bearing: assert duplicates in the normalize
  pass (import vs defined-function name collision would silently
  mis-resolve today via funcMap too — the assert makes it loud).
- **Lambdas/trampolines** get generated names (`lambdaCounter`); refs work,
  but S3 must ensure every defined function lands in funcMap before emit
  (today some trampolines are index-only — give them synthetic names).
- **`structuredClone`/JSON of Instr arrays** would break interned-object
  dedup identity (not correctness — refs are value-comparable by name).
  No current cross-worker instr transfer exists; note for the compiler
  pool.
- **emit/object.ts:461** maps funcIdx→symIdx for relocation — must run
  after normalize (S1 wires it).
- **Per-slice CI**: equivalence + sharded test262 + the #1897 standalone
  gate. The historical failure mode (#618) was shifting too much; symbolic
  refs cannot over-shift — the residual risk is *unresolved* refs, which
  the normalize pass turns into a hard compile error instead of a
  mis-targeted call.
