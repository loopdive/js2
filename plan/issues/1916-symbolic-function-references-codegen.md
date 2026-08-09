---
id: 1916
title: "Symbolic function references in WasmGC codegen — retire the late-import index-shift machinery"
status: ready
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
- Context fields exist _only_ to make bodies reachable for the shifter
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
  - (h - STABLE_BASE) : h`.
- **Each of the 4 shifters + dead-elim's fR remap get a one-line guard:
  skip any `funcIdx >= STABLE_BASE`** (a stable handle never shifts).
  Transitional; deleted with the shifters.
- Import handles stay in the live regime initially — they are already
  _prefix-stable_ (an import's index never changes once minted; imports
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
    - late-shift suites green, and a new acceptance test: stable
      producer + forced late-import churn compiles/validates/runs on all
      3 targets.
- S3b..N: flip remaining producers batchwise (~203 canonical
  `numImportFuncs + mod.functions.length` sites + 10 variants across 49
  files → `mintDefinedFunc`/`pushDefinedFunc`). Byte-identity after
  every batch. Import handles stay live-regime (prefix-stable) until
  S3-final.
  - **S3b batch 1 — LANDED (PR 4)**: `number-ryu.ts` (3 helpers:
    `__ryu_mul_shift`/`__num_ryu_digits`/`__num_ryu_to_buf`) +
    `parse-number-native.ts` (3: `parseFloat`/`__str_to_number`/
    `parseInt`) — completes the number cluster (number-format flipped in
    S3a calls into Ryū). Also carries the S3a audit-completeness fixes
    (compiler/output.ts, emit/c-header.ts, codegen-linear/c-abi.ts,
    promise-combinators.ts — four funcIdx interpreters outside the S2
    sweep scope, normalized) that missed #2499's queue window. Proof:
    1215-record corpus byte-IDENTICAL; issue-1537 (33) + parseint-edge +
    #1916 suites green.
  - **S3b batches 2+3 — LANDED (PR 5)**: batch 2 = `symbol-native.ts`
    (`__box_symbol`/`__symbol_for_native`/`__symbol_keyfor_native`),
    `uri-encoding-native.ts` (`__uri_encode`/`__uri_decode` — the
    "claim the slot last" ordering dance is moot), `date-parse-native.ts`
    (`__date_parse`). Batch 3 = `case-convert-native.ts` (the #40/#2191
    name-based public repoint flows stable handles unchanged — a
    name→handle map re-point is value-opaque) + `json-codec-native.ts`
    (9 helpers; the JSON parse trio's `valueFuncIdx + 1/+ 2` sibling
    derivation — implicit consecutive-push assumption — replaced by
    three explicit mints). Both corpus byte-IDENTICAL; family suites
    green. (The 3 `issue-1599` refusal failures are pre-existing on
    clean main — stale expectations after a recent JSON change; flagged
    to the lead, not this migration's doing.)
  - **S3b medium batch A — LANDED (dev-1916b)**: `closures.ts` (8:
    lifted-closure + `__cb_` continuations + method trampolines),
    `any-helpers.ts` (8: `__any_from_extern`/`__any_to_extern` etc.,
    separated mint/push — body built between reserve and push),
    `class-bodies.ts` (6: ctor / `__onhost` / `_init` / method / getter /
    setter). Corpus byte-IDENTICAL over playground + probe corpus ×
    {gc,standalone,wasi}. **Surfaced two general infra fixes** (the
    batch-8-style "drift reveals a latent assumption" — both are
    order/shift bugs that bite ANY producer once its handle goes stable,
    so they are load-bearing for every later batch AND S3-final):
    1. **`collectDeclaredFuncRefs` sorted the declarative element segment
       by RAW handle value** (`class-bodies.ts` `[...refs].sort((a,b)=>a-b)`).
       A stable handle (`>= STABLE_FUNC_BASE`) is numerically huge, so it
       was banished to the end → the emitted elem segment permuted vs the
       all-live baseline (same bytes, reordered — caught only via
       `async.ts::wasi`, two lifted closures). Fixed to sort by
       `absoluteFuncIndex(mod, h)` (resolved index) → identical for live
       handles, correct for stable. This is the elem-segment analogue of
       the #1899 "identity must ride in the value" lesson.
    2. **`closures.ts` manual `ntShift` bump used a bare
       `methodFuncIdx >= importsBeforeNT`** (the "closure-creation import
       machinery can't reach this captured callee, bump it ourselves"
       path). A stable callee handle satisfies the bare `>=` and got
       `+= ntShift` corrupted (only when `ntShift>0`, i.e. native-strings
       under wasi/standalone). Fixed to `inLiveShiftRange(...)` per the
       resolve-layout shifter contract (every shifter comparison must use
       it). Byte-neutral for live handles.
  - **S3b medium batch B — LANDED (dev-1916b)**: `expressions/builtins.ts`
    (6), `literals.ts` (4: object-literal fresh-fn / getter / setter /
    method), `statements/nested-declarations.ts` (3: the reserve-then-fill
    placeholder pattern — mint/push effectively adjacent, body filled by
    mutating the pushed object reference). Corpus byte-IDENTICAL (stacked
    on batch A so it inherits the declaredFuncRefs sort fix — literals'
    object-method funcrefs are ref.func'd).
  - **`declarations.ts` (5 sites) — LANDED (fable-2710, 2026-07-04), and the
    deferral diagnosis is CORRECTED**. The observed `async.ts::gc` −6-byte
    drift was NOT a consumer reading a stable handle positionally — it was
    the flip **fixing a latent invalid-Wasm bug on main** (baseline
    `async.ts::gc` fails `WebAssembly.validate` since PR #2483/#1042; the
    "different call target" was a STALE live-regime immediate that missed
    its late-import shift inside a shifter-unreachable detached array, then
    got renumbered onto an unrelated function by dead-import elimination;
    stackBalance behaved correctly on the wrong input). `stackBalance` needs
    no audit fix — it has been dual-regime since S3a. Full trace + bisect +
    proof in #2710's progress log ("S3b deferred-producer flip landed").
  - **S3b medium batch C — LANDED (dev-1916b)**: `accessor-driver.ts` (5:
    reserve-then-fill placeholder accessors, uniform `funcIdx`/`placeholder`)
    - `iterator-native.ts` (3: `__array_from_iter_n` + inline iterator
      helpers). Corpus byte-IDENTICAL (stacked on A+B → inherits both infra
      fixes). Non-async producers flipped cleanly with no new drift.
  - **async-frame.ts (3) + promise-combinators.ts (5) — LANDED
    (fable-2710, 2026-07-04)** together with `declarations.ts` (the
    "consumer audit" gate was a misdiagnosis, see above). async-frame also
    gained the transitional `buildStateArm` detached-segment
    `ctx.liveBodies` tracking: completed-but-unassembled state-segment
    arrays were unreachable by ALL FOUR shifters while later segments
    compiled (the second half of the invalid-Wasm mechanism); the tracking
    covers calls to the ~39 still-live-regime `index.ts` mints and is
    deleted with the shifters at S3-final. promise-combinators' `base + k`
    four-sibling derivation became four explicit mints (the batch-3 JSON
    trio pattern).
  - **S3b medium batch D — LANDED (dev-1916b)**: the 15 single-/double-mint
    producer files — `array-to-primitive`, `builtin-static-globals` (2),
    `class-to-primitive`, `closed-method-dispatch` (2), `fmod`,
    `generators-native`, `json-runtime` (2), `math-helpers`, `native-proto`,
    `expressions/calls`, `expressions/new-super` (2), `expressions/proto-override`,
    `registry/error-types`, `timsort`, `type-coercion` (19 sites total).
    Corpus byte-IDENTICAL (stacked on A+B+C). NOTE: `generators-native`
    (generator state machine, `__gen_*` reserve-then-fill) flipped clean —
    its helper is not on the `stackBalance` drift path the async
    `__sset_*` helpers hit, so generators are safe to flip while
    async-frame/promise-combinators wait for the consumer-audit fix.
  - **Remaining after the deferred-producer flip (2026-07-04): ONLY
    `index.ts` (39 non-uniform sites, shifter-adjacent — its own careful
    PR) + `ir/integration.ts` (1)**, then S3-final. Out of scope for the
    WasmGC front-end flip: `codegen-linear/*` (converts with the linear
    backend's own registry), `emit/binary.ts` (the resolver surface, not a
    producer). Execution notes for the index.ts wave (bank for the
    executor): (a) the two inline shifters (`addStringImports` /
    `addUnionImports`) live in this file — flipping the natives they mint
    while their own shift blocks still run is safe ONLY because every
    shifter comparison uses `inLiveShiftRange` (stable range skipped), but
    verify each flipped mint is not also read back positionally inside the
    same function; (b) `addUnionImportsAsNativeFuncs` and the native-string
    helper finalize interact with `reconcileNativeStrFinalizeShift` +
    `nativeStrHelperImportBase` — flip those clusters LAST, immediately
    before deleting the reconcile machinery (S3-final 4c), or the re-base
    bookkeeping double-counts; (c) prove with the byte-identity harness
    per batch AND classify any drift before deferring (validate both
    binaries first — see the #2710 method lesson: a drift can be the flip
    FIXING a latent stale-shift bug, as it was for async.ts::gc).
  - **S3b batch 4 — native-regex (dev-1916o, handoff from dev-1916f).**
    `native-regex.ts`: all 10 helper producers (`__regex_class_match` +
    the exec/match/replace/split/test family) flipped from the inline
    `numImportFuncs + mod.functions.length` mint to `mintDefinedFunc` /
    `pushDefinedFunc`. All 10 are the simple mint→push shape — no
    `funcIdx + k` sibling derivation, and (verified by push-order) no
    intervening push between any mint and its push, so the resolved
    index equals the live-regime index by construction. Proof: corpus
    byte-IDENTICAL incl. `regex.ts::standalone` (65908 B, native-regex
    helpers emitted); #1916/#1677/#1809/#2191/#2193 + regex functional
    suites (682/1539/2588) green. (The 1 `issue-1539` "refuses dynamic
    `new RegExp(var)`" failure is pre-existing on clean origin/main —
    stale refusal expectation after a recent RegExp change; verified via
    file-revert control, not this flip's doing.)
  - Batch discipline (for the next executor): flip whole FILES (a
    producer family), never partial files; `nextFuncIdx`-style local
    helpers redefine in place; multi-mint sibling derivations
    (`base + k`) become explicit per-function mints; verify
    `grep -c mod.functions.push <file>` is 0 after; corpus check per
    batch; run the family's test suites.
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
