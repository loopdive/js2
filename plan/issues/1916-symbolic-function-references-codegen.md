---
id: 1916
title: "Symbolic function references in WasmGC codegen — retire the late-import index-shift machinery"
status: in-progress
assignee: ttraenkler/dev-1916f
pipeline_unblocked: 1927
sprint: current
model: fable
created: 2026-06-10
updated: 2026-07-02
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [2710, 1899, 1985]
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

## Amendment (2026-06-11, analysis program)

Symbolic references as specced fix index-shift fragility but keep
NAME-keyed identity: `IrFuncRef { name }` is still a string (report 05
§3), so the collision class survives the migration — `${Class}_${method}`
colliding with a user `function A_m()` (#1983), `${name}_valueOf`
last-literal-wins dispatch (#1989, now specced onto typed refs), and the
`__sget_<name>` family. Requirement added: handles must be
**collision-free FuncIds derived from the declaration site /
ts.Symbol**, with names demoted to debug metadata. The instance-side twin
($shape, #2009) covers struct identity; this issue owns function/registry
identity. Full analysis: plan/log/analysis-2026-06/05-structure-review.md
§3.

## Reconciliation with #2710 + staged plan (dev-1916f, 2026-07-02)

Unblocked: #2167 resolved — Fable re-enabled 2026-07-02 (coordinator
direction); `blocked_by` cleared.

**Foundation decision: #1916 builds ON #2710's landed FuncHandle
foundation — it does NOT introduce a second identity mechanism.** While
this issue was Fable-parked, #2710 ("late-bind module indices") landed
slices 0+1 of the same migration: the `scripts/prove-emit-identity.mjs`
byte-identity oracle and the `FuncHandle`/`GlobalHandle`/`TypeHandle`
vocabulary pinned onto the discriminated `Instr` arms
(`src/ir/types.ts`). #1916's original sketch (shared mutable `{index}`
cells mutated by shifters) is **rejected** in favour of #2710's stable
counter-minted handles + one `resolveLayout()` at serialization, for two
reasons grounded in prior findings:

1. **Mutable cells keep the class reachable** — every shifter must still
   know about every cell holder (the same "did you remember to chase this
   side-channel" discipline that produced the 7 regressions). Stable
   handles + late resolve delete the shifters instead of teaching them.
2. **#1899's implementation notes prove idx-keyed repair is unsound** —
   a numeric funcIdx is ambiguous across shifts (a freed slot gets reused
   by a different function), so identity must ride IN the instruction as
   a layout-independent value. That is exactly the #2710 handle.

The #1916 amendment's collision-free requirement is satisfied for the
handle itself (monotonic counter, never reused, never renumbered — no
name derivation). The registry-key collision class (name-keyed
`funcMap.get(name)` returning the wrong entry — #1983/#1989) is
orthogonal to index binding and stays tracked in those issues.

**Slice mapping (each ships green + byte-identical via
`prove-emit-identity`; #2710 slice numbers in parens):**

- **S1 (=2710 slice 2) — resolver seam, identity.** THIS SLICE.
  `src/emit/resolve-layout.ts` (`ModuleLayout` + identity `resolveLayout`)
  armed per-emit in `emitBinaryWithSourceMap` next to `valCtx`; every
  func/global reference serialization in `src/emit/binary.ts` now
  dereferences through it: `call`, `return_call`, `ref.func`,
  `global.{get,set}`, func/global export descriptors, element-segment
  function lists, `declaredFuncRefs`, start section. Proof: 1215
  (file,target) records — playground examples + 392-file test262 sample
  × {gc, standalone, wasi}, 992 real binaries — **byte-identical**.
  Late-shift class holds: issue-329/1677/1809/1839/1899/2191/2193/2918
  suites green (51 tests) + new `tests/issue-1916-symbolic-func-refs.test.ts`.
- **S2 (=2710 slice 3) — convert positional reads.** DONE (PR 2, this
  slice) for the FUNCTION space. Implementation notes (the WHY, for S3):
  - **New chokepoint module `src/codegen/func-space.ts`**: `definedFuncAt`
    (handle→defined-record, the ONLY place `idx - numImportFuncs` lives),
    `isImportFuncIdx`, `funcSignatureOf` (import-scan + defined unified),
    `replaceDefinedFuncAt` (the write-side twin — the IR integration
    patches a lowered body in-place by handle). S3 rewrites THESE four to
    registry lookups and every caller is already correct.
  - **~40 call sites across 24 files converted**; 4 duplicated
    signature-scan helper clones collapsed onto `funcSignatureOf`
    (`getFuncParamTypes`/`wasmFuncReturnsVoid`/`getWasmFuncReturnType` in
    expressions/helpers.ts, `getFuncSignature` in closures.ts,
    `getFuncResultType` in expressions/new-super.ts). Zero
    `mod.functions[idx - numImportFuncs]` / `- numImportFuncs` arithmetic
    remains in `src/codegen` + `src/ir` outside func-space.ts.
  - **Semantics-preservation rule discovered**: several sites (e.g. the
    toPrimitive retKind reads in type-coercion.ts) deliberately treat an
    IMPORT handle as "unknown → default" — converting those to
    `funcSignatureOf` (which resolves import signatures) would CHANGE
    behavior. They use `definedFuncAt`, preserving exact semantics;
    byte-identity is the proof. Flag for S3+: whether the import-default
    behavior is itself a latent bug is a separate question.
  - **Position-space reads are NOT this surface** (and were left alone):
    `funcByName`-map reads in class-bodies.ts / declarations.ts index
    `mod.functions` by POSITION (never mixing `numImportFuncs`) —
    positions don't shift when imports are added, so they are already
    stable and stay valid post-flip. Plain whole-array iteration
    (shifters/DCE/emit) is layout work, also out of scope.
  - **Known latent positional-import reads preserved for byte-identity**
    (flagged in-code for S3 review): `ir-tail-call.ts` `calleeTypeIdx` and
    `statements/control-flow.ts` index `mod.imports[calleeIdx]` by
    func-space index — only correct while func imports precede non-func
    imports; a mismatch degrades to undefined via the kind guard.
  - **Out of scope**: `src/codegen-linear/c-abi.ts` (1 site) — the linear
    backend uses bare mod/numImportFuncs locals, not `CodegenContext`;
    convert when the linear backend gets its own registry (or S3 unifies).
  - Proof: byte-identical over the same 1215-record corpus; the four
    late-shift issue suites (329/1899/1916/2941, 32 tests) green. The
    `ir-*-equivalence` harness failures observed locally reproduce
    identically on clean origin/main (pre-existing, container-env).
- **S3 (=2710 slice 4b/4c, func space — the heart of #1916).** Mint
  stable func handles at registration; `resolveLayout` computes the real
  permutation (imports in declaration order, then live defined funcs in
  array order post-DCE — reproduces today's layout byte-for-byte); DELETE
  the four func-index shifters (`shiftLateImportIndices`,
  `reconcileNativeStrFinalizeShift`, the `addStringImports` /
  `addUnionImports` inline shifters) + the `liveBodies`/
  `parentBodiesStack` reachability bookkeeping; dead-elim stops
  renumbering func refs (drops dead defs; layout skips dead handles).
  Full CI + merge_group (broad-impact — never a scoped sweep).
- **S4 (=2710 slice 4a/4d) — globals (`fixupModuleGlobalIndices` + ~25
  cached fields, the #2078 site), then types (DCE renumber through
  `resolveLayout`).** May land under #2710 directly.

## S3 design — the two-regime incremental flip (dev-1916f, 2026-07-02)

**The naive S3 is atomic and unshippable**: you cannot mint stable
handles gradually while shifters still walk bodies (they would corrupt
stable handles), and you cannot delete the shifters before every mint
site is converted (~209 canonical `numImportFuncs +
mod.functions.length` sites + 10 variants + `addImport`). One mega-PR
over that surface violates the slice discipline.

**Resolution — numerically disjoint handle regimes coexist.** Mint
stable defined-func handles in a range that cannot collide with live
indices: `STABLE_BASE + definitionOrdinal` with `STABLE_BASE = 1 << 21`
(a module with ≥2M functions is rejected at emit; today's biggest
modules have <10k). Definition ordinal = position in `mod.functions`,
which IS stable: the array only appends (dead-elim removes func IMPORTS
and types, never defined functions), and imports prepend only in the
INDEX SPACE, not in the array. So `STABLE_BASE + position` is a stable,
collision-free id requiring no registry map. The two regimes are then
distinguishable by magnitude, like a tagged union:

- `definedFuncAt`: `h >= STABLE_BASE ? mod.functions[h - STABLE_BASE] :
  mod.functions[h - numImportFuncs]` — S2 made this THE read chokepoint,
  so dual-mode lands in one function (+ its 3 siblings).
- `binary.ts` `fIdx` (the S1 seam): `h >= STABLE_BASE ? finalNumImports
  + (h - STABLE_BASE) : h`.
- **Each of the 4 shifters + dead-elim's fR remap get a one-line guard:
  skip any `funcIdx >= STABLE_BASE`** (a stable handle never shifts).
  Transitional; deleted with the shifters.
- Import handles stay in the live regime initially — they are already
  *prefix-stable* (an import's index never changes once minted; imports
  only append among themselves). The only breaker is dead-elim REMOVING
  a func import; that is resolveLayout's import-ordinal remap table in
  the endgame slice.

**Why this is sound where #1899's B2 was not**: B2 tried to recover
identity FROM an ambiguous number after the fact. Here the number IS
the identity by construction (disjoint ranges, stable ordinal); there
is never a moment where one value means two functions.

**S3 slices (each byte-identity-provable):**
- S3a — LANDED (PR 3): the full two-regime infrastructure + the FIRST
  flipped producer, proven byte-identical. As-built notes:
  - `src/emit/resolve-layout.ts`: `STABLE_FUNC_BASE` (1<<21),
    `isStableFuncHandle`, `absoluteFuncIndex[Cached]` (the one
    normalization primitive; throws on minted-never-pushed), and
    `inLiveShiftRange` (the shift predicate); `resolveLayout.func` now
    resolves stable handles via `mod.funcOrdinalToPosition`.
  - `WasmModule.funcOrdinalToPosition: number[]` — ordinal→position,
    on the MODULE so mod-only passes can resolve. NaN = minted, not yet
    pushed (loud failure if it reaches emit).
  - Mint/push protocol in `func-space.ts`: `mintDefinedFunc` (reserves
    an ordinal — decoupled from position, so nested emission between
    mint and push is safe) + `pushDefinedFunc` (records position;
    throws on double-push). Read chokepoints are dual-regime via
    `definedPositionOf`.
  - ALL FOUR shifters + `reconcileNativeStrFinalizeShift` +
    `shiftAsyncSideChannelFuncIdxs` guard every comparison with
    `inLiveShiftRange` (instruction immediates AND every side-table:
    funcMap, nativeStr/Regex/map helpers, trampolines, nativeGenerators,
    async side-channels, exports, elems, declaredFuncRefs, start).
  - Dual-regime consumers: `stack-balance.ts` (stable ALIASES registered
    in `buildFuncSigs` + `getFullParamTypes`/2 inline reads normalized),
    `fixups.ts` (4 reads normalized), `object.ts` (symbol aliases).
    `dead-elimination.ts` needs NO change (proven: all defined funcs are
    unconditionally live; the `fR` remap keys can never match a stable
    value). `wat.ts` prints the raw handle value (debug-only; uniquely
    identifies; normalize in S3-final).
  - First flipped producer: `number-format-native.ts` (6 helpers incl.
    the `__num_fmt_finalize` sibling-call fan-in). Proof: corpus
    byte-IDENTICAL (1215 records — the flip resolves to exactly the
    bytes the shifter regime produced), issue-1537 (33) + issue-49 (7)
    + late-shift suites green, and a new acceptance test: stable
    producer + forced late-import churn compiles/validates/runs on all
    3 targets.
- S3b..N: flip remaining producers batchwise (~203 canonical
  `numImportFuncs + mod.functions.length` sites + 10 variants across 49
  files → `mintDefinedFunc`/`pushDefinedFunc`). Byte-identity after
  every batch. Import handles stay live-regime (prefix-stable) until
  S3-final.
- S3-final: zero live-regime defined-func mints remain → delete
  `shiftLateImportIndices`, `reconcileNativeStrFinalizeShift`, both
  inline shifters, `flushLateImportShifts`, the `liveBodies`/
  `parentBodiesStack` bookkeeping, and dead-elim's funcIdx body remap;
  resolveLayout computes the real permutation incl. the dead-import
  ordinal remap; normalize `wat.ts`. Full CI + merge_group.

**Consumers between freeze and emit that interpret funcIdx** (must be
dual-mode by S3a): `stackBalance` (reads callee signatures — takes
`mod` only, so the import-count context must be derivable from `mod`;
audit), `repairStructTypeMismatches`/`fixupExternConvertAny` (bake NEW
calls post-dead-elim from side-tables — with stable handles those bakes
become correct by construction, retiring the #1899 fix's reason to
exist), `eliminateDeadImports` liveness walk, `wat.ts`, `object.ts`,
`validateFuncRefs` (validate RESOLVED values). `addImport` already
enforces the freeze point (#1984 throw) — the flip inherits it.

Coordination note: #2710 is claim-held by `ttraenkler/sd-indexshift`
(2026-06-26, no active agent, no open PR). S1–S3 are being advanced
under #1916 by `ttraenkler/dev-1916f` with a cross-note in #2710's log;
the two issues share one mechanism and MUST NOT diverge.
