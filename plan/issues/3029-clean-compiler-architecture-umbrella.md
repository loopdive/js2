---
id: 3029
title: "Clean compiler architecture umbrella: layered module map, five-part backend contract, reviewability ratchets"
status: ready
sprint: current
created: 2026-07-04
updated: 2026-07-04
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir, codegen, codegen-linear, compiler
language_feature: compiler-internals
goal: maintainability
related: [3030, 742, 1851, 1852, 1916, 1927, 1930, 1859, 1860, 2043, 2710, 2855, 2949, 2950, 2953, 2956]
origin: "2026-07-04 user directive: refactor into a clean architecture humans can review/extend, open to new backends (MLIR or others)"
---

# #3029 — Refactor into a reviewable, extensible, backend-open architecture

**Normative target picture:**
[`docs/architecture/target-architecture.md`](../../docs/architecture/target-architecture.md)
(written with this issue). This umbrella tracks the sequenced slices; each
slice PRs independently. Sibling: **#3030** (the serializable IR contract —
the interchange boundary this architecture is layered around).

## Problem

The compiler ships 73.9% test262 but has accumulated organically:

- `compileCallExpression` is ~9.1k lines with ~125 string-matched dispatch
  arms (#742); `src/codegen/index.ts` is 15.9k lines. Review cost and
  merge-conflict rate scale with these files, not with the change.
- The `BackendEmitter` trait exists (#1713/#1714) but 74 `pushRaw` sites in
  `src/ir/lower.ts` bypass it (#2953), its output sink is hardwired to the
  Wasm `Instr[]` shape, and there is **no declared contract at all** for the
  module-level half of a backend (function slots, imports, type
  registration) — that lives as WasmGC `ctx.mod` mutation. A new backend
  (MLIR, Cranelift, a different Wasm strategy) today has no interface to
  implement; it would have to be a fourth hand-rolled path.
- Layer boundaries exist in the docs but not in the import graph:
  `src/ir/integration.ts` imports 8 `src/codegen/` modules, so the
  "backend-neutral" middle-end is compile-time coupled to one backend.
- "Reviewable" has no enforcement: no file-size ceiling, no
  dependency-direction check, dispatch chains keep growing.

The June 2026 quality review (B− overall, C− codegen core) and the two-axes
doctrine already diagnose all of this; what has been missing is the **target
module architecture** and the ordered cut-lines to get there. That is this
issue.

## Target (summary — the doc is normative)

1. **Layer stack** L1 frontend → L2 ir-build → L3 backend-neutral IR (the
   serializable waist, #3030) → L4 legalization → L5 backends → L6 emit/link
   → L7 runtime. Imports point strictly downward, CI-checked.
2. **Five-part backend contract** — a new backend implements exactly:
   `TypeConverter` (#1851 L3), `BackendLegality` (#1851 L4),
   `BackendEmitter<Sink>` (sink generalized off `Instr[]`),
   `LayoutResolver` (extracted from `integration.ts`, #2956 item 1), and
   `ModuleAssembler` (new — name-based module assembly, no absolute-index
   baking; converges with #1916/#2710/#2043).
3. **Out-of-tree backends are first-class** via the serialized IR (#3030) —
   the recommended route for MLIR-class consumers.
4. **Reviewability rules with ratchets**: R-SIZE (file-size baseline,
   shrink-only), R-DEP (import-direction check), R-DISPATCH (table-driven
   registries), R-ESCAPE (pushraw-ok tags, #2953), R-OWN (subdir README
   contracts, #1859), R-LOUD (#1858).
5. **Neutral directory layout**: `src/frontend/`, `src/ir/`,
   `src/backend/{contract,gc,linear,bytecode}/`, `src/emit/`, `src/link/`,
   `src/runtime/` (resolves #1860).

## Slices

Tier ruling (user, 2026-07-04): **structural cut-lines = Fable-required**
(interface freezes, contract definitions, index-identity design);
**mechanical waves = Opus-executable** (file splits, moving code behind
frozen interfaces, call-site migration), each gated by byte-identity /
equivalence / full CI.

| Slice                                        | Tier      | Size               | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Depends on                                                    |
| -------------------------------------------- | --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **S1 — Backend contract v1**                 | **Fable** | M                  | Freeze the five interfaces as code: `src/ir/backend/contract.ts` (or split files) declaring `TypeConverter`, `BackendLegality` (promote `legality.ts`), `BackendEmitter<Sink>` with the sink made a type parameter (bytecode's `number[]` sink is the existing proof it must generalize; an MLIR builder is the future one), `LayoutResolver`, `ModuleAssembler` (declaration only — implementation is S4/S5). Includes the contract README (what each part owns, operand-order rules, memoization ownership) and a conformance test skeleton per interface. Byte-inert. | —                                                             |
| **S2 — pushRaw families behind the trait**   | Opus      | L                  | Finish #2953's remaining families (unions/boxing, closures, coercions/null, funcref, Promise-or-declared-deferred) + its count ratchet. Already sliced and in-progress there — this umbrella just sequences it.                                                                                                                                                                                                                                                                                                                                                          | S1 (trait surface)                                            |
| **S3 — LayoutResolver extraction**           | Opus      | M                  | Move `integration.ts`'s resolver construction behind the S1 interface: the context-facing surface (funcMap/typeIdx lookup, slot patching, import registration) becomes an interface the WasmGC context implements. Kills the `ir → codegen` import direction (then flip R-DEP to enforcing for `src/ir/`). Byte-identity gate. This is also #2956's prerequisite item 1 — coordinate; do it once, here.                                                                                                                                                                  | S1                                                            |
| **S4 — ModuleAssembler design**              | **Fable** | M                  | The one genuinely dangerous cut: who owns function slots, import/export/type registration, and index identity per backend. Must be designed against the live index-shift regime (`addUnionImports`, `late-imports.ts`, ≥7 historical regressions) and the in-flight symbolic-func-refs direction (#1916) + late-bound indices (#2710) + #2043 — the assembler is where those converge instead of three coexisting relocation regimes. Deliverable: ratified spec section here + the interface body in contract.ts.                                                       | S1; read #1916/#2710 state first                              |
| **S5 — Assembler implementations**           | Opus      | M–L                | WasmGC `ModuleAssembler` implementing S4 over the existing `ctx.mod` (adapter first, migration second); linear twin over `generateLinearModule`'s module state. Byte-identity + full CI per step.                                                                                                                                                                                                                                                                                                                                                                        | S4                                                            |
| **S6 — Directory re-layout + READMEs**       | Opus      | M                  | `git mv` waves per the migration map in the target doc (+ `src/backend/{gc,linear,bytecode}` naming, #1860) + per-subdir contract READMEs (#1859). Pure mechanics but high conflict surface: schedule in a quiet merge-queue window, one directory per PR, coordinate with the lead so no in-flight branch is stranded.                                                                                                                                                                                                                                                  | S1–S3 landed (so the moved code is already behind interfaces) |
| **S7 — CI reviewability ratchets**           | Opus      | S–M                | `scripts/check-file-sizes.mjs` (baseline JSON, shrink-only, like ir-fallback-baseline) + `scripts/check-layer-imports.mjs` (R-DEP; reads per-subdir README declared deps) wired into `quality`. Land EARLY — it locks the rules before the waves. R-DEP starts warn-only for known violations (the baseline lists them), enforcing per-directory as S3/S6 clear them.                                                                                                                                                                                                    | rules in the doc (done)                                       |
| **S8 — calls.ts decomposition continuation** | Opus      | L (many small PRs) | #742 under the new rules: keep extracting self-contained guard/dispatch blocks with the WAT-hash oracle, then the table-driven callee registry. Counts against the R-SIZE baseline (each PR shrinks it).                                                                                                                                                                                                                                                                                                                                                                 | S7 (ratchet banks the progress)                               |
| **S9 — MLIR feasibility memo**               | **Fable** | S                  | One-pager: map IR (block-arg SSA, symbolic refs, effects) onto an MLIR dialect; decide in-tree emitter vs out-of-tree consumer of #3030's serialized IR (expected answer: out-of-tree first). Explicitly a memo, not a commitment.                                                                                                                                                                                                                                                                                                                                       | #3030 T1–T3                                                   |

Sequencing: S1 → {S2, S3} → S4 → S5 → S6; S7 immediately (parallel); S8
continuous; S9 after #3030's serializer exists.

## Acceptance criteria (umbrella)

- [ ] `docs/architecture/target-architecture.md` merged and linked from
      `codegen-axes.md` (this PR).
- [ ] S1 contract merged; the three existing emitters (`WasmGcEmitter`,
      `LinearEmitter`, `BytecodeEmitter`) type-check against
      `BackendEmitter<Sink>` with their own sink types.
- [ ] `src/ir/` has zero imports from `src/codegen/` (S3), enforced by R-DEP.
- [ ] `ModuleAssembler` spec ratified (S4) and implemented for WasmGC +
      linear (S5) with no test262 regression.
- [ ] R-SIZE and R-DEP checks live in `quality` with committed baselines
      that only shrink (S7).
- [ ] Directory layout matches the migration map (S6); every `src/` subdir
      has a contract README.
- [ ] A design-only "how to add a backend" section exists (target doc) whose
      five interfaces are all real code — verified by the conformance test
      skeleton compiling against a stub backend.

## Risks

- **Index identity (S4/S5)** is the compiler's #1 historical regression
  class (≥7 numbered regressions from absolute-index baking). That is why
  S4 is Fable-tier and why S5 lands as adapter-first with byte-identity
  gates, never a rewrite.
- **Directory moves (S6)** conflict with every in-flight branch. One
  directory per PR, lead-scheduled, `git mv` only (history follows), no
  logic changes in move PRs.
- **Contract freeze too early**: S1 freezes _shape_, not completeness —
  methods may be added (additive) as #2953/#2956 discover needs; what S1
  forbids is new bypasses around the seam.
- **Duplication with in-flight issues**: #2953 (S2), #2956 (S3 overlap),
  #742 (S8) keep their own issue files and owners; this umbrella sequences
  them and must not double-dispatch. Check assignees before claiming.

## S4 — ModuleAssembler design (RATIFIED, Fable 2026-07-04)

The interface body lives in `src/ir/backend/contract.ts` (part 5) with the
invariants A1–A7 inline. This section records the design rationale and the
convergence map — the WHY, so the S5 implementer and the #2710 waves don't
re-litigate it.

### The design in one sentence

**A consumer of the assembler never sees a module index**: identity is a
stable handle minted at declaration; indices come into existence exactly
once, inside `finalize()` (= `resolveLayout`), and are consumed only by the
serializer.

### Why this shape (root cause of the regression class)

The bug class is definitionally "a concrete index baked into instruction X
went stale when the index space changed" (#2710). Every prior mitigation —
shifters, fixups, `?? funcIdx` repoints, cached-field chases — is REACTIVE:
it repairs concrete indices after churn, so every new emit site / cached
field is a fresh opportunity to forget the repair (the 2026-07 tag-5 PR's
stale cached `__gen_eager_mode` global index is the newest instance; #2078
`currentThisGlobalIdx` the canonical one). The assembler contract is the
STRUCTURAL fix: with no index in circulation before finalize, there is
nothing a late import can invalidate. This is the same dual lesson #1899
proved — identity must ride in the reference; the only sound resolution
point is after all churn.

### Key decisions

1. **Two-phase declare/define (mint/push), not define-returns-handle.**
   Producers routinely need the handle BEFORE the body exists (self-calls,
   mutual recursion, helper bodies that reference each other, bake-into-
   immediate-then-build). func-space.ts's `mintDefinedFunc`/`pushDefinedFunc`
   proved the protocol under nested emission; the contract generalizes it to
   globals. Declared-but-never-defined fails loudly at finalize (mirrors
   `absoluteFuncIndex`'s NaN-ordinal throw).
2. **Imports mint handles too, at any pre-finalize time.** This is the
   member that makes late imports FREE and retires the shift regime. The
   import/defined distinction becomes a finalize-time ordering concern
   (imports first, registration order), not a producer-visible index-space
   split — `isImportFuncIdx` arithmetic disappears with it.
3. **`finalize()` returns `ModuleLayout` and is the ONLY index authority
   (single-shot).** It corresponds to today's `indexSpaceFrozen = true`
   point in `generateModule`. Post-finalize mutation throws — the fail-loud
   twin of today's freeze flag.
4. **Type interning is the assembler's; layout-handle memoization is the
   LayoutResolver's.** Two different dedup concerns that today blur through
   `ctx`: "one canonical TypeDef entry per structural definition" (index
   identity — assembler) vs "one struct registration per IR shape"
   (lowering memoization — resolver). Splitting them keeps part 4
   backend-neutral.
5. **DCE marks dead, finalize skips.** Dead-elimination stops renumbering
   instructions (its remap is where the type-index remove-and-renumber
   factory lives, `project_type_index_shift_and_deadelim`); it only marks.
   The layout skips dead handles. One mechanism for funcs/globals/types.
6. **Definition payloads are generic.** `ModuleAssembler<FuncDefT,
GlobalDefT, TypeDefT>` defaults to the `src/ir/types.ts` Wasm records;
   an MLIR assembler's payloads are dialect ops and its finalize produces an
   `mlir::ModuleOp`-shaped layout. The handle protocol is representation-
   independent — that is what makes part 5 a _contract_ rather than a
   WasmGC refactor.

### Convergence map (today's mechanism → contract member)

| Today (live)                                                                                                 | Contract member                   | Migration vehicle             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------- |
| `mintDefinedFunc` / `pushDefinedFunc` (func-space.ts, #1916 S3 stable regime)                                | `declareFunc` / `defineFunc`      | already aligned               |
| `ctx.numImportFuncs + mod.functions.length` eager minting (legacy live regime)                               | `declareFunc` / `defineFunc`      | #1916 S3 / #2710 s4b          |
| `addUnionImports` / `addStringImports` / `ensureLateImport` + 4 shifters + `reconcileNativeStrFinalizeShift` | `importFunc` (shift-free by A3)   | #2710 slice 4b/4c             |
| `addStringConstantGlobal` + `fixupModuleGlobalIndices` + ~25 cached global-idx chases                        | `importGlobal` / `declareGlobal`  | #2710 slice 4a (globals wave) |
| `ctx.funcMap` / `moduleGlobals` / `ctx.typeNames`                                                            | `lookupFunc/Global/Type` (A6)     | S5 adapter                    |
| `addFuncType` / struct registration index minting                                                            | `internType`                      | #2710 slice 4d (types wave)   |
| `eliminateDeadImports` remove-and-renumber                                                                   | dead-marking + finalize skip (A7) | #2710 slice 4d                |
| `resolveLayout` (src/emit/resolve-layout.ts) at `indexSpaceFrozen`                                           | `finalize()`                      | already the seam              |
| `WasmExport` / `startFuncIdx` records                                                                        | `exportFunc/Global`, `setStart`   | S5 adapter                    |

Remaining positional-read surface at freeze time (#2710 slice 3 residue):
`index.ts` ×39 + `integration.ts` ×1, plus the globals/types waves — those
are exactly the reads the S5 adapter converts. **S5 is adapter-first over
the existing `ctx.mod` (byte-identity gated via
`scripts/prove-emit-identity.mjs`), never a rewrite** — the WasmGC
`ModuleAssembler` wraps the live registries; the linear twin wraps
`generateLinearModule`'s module state.

### Executable spec

`tests/backend-contract.test.ts` encodes A2/A3/A4/A5/A6 against the stub
assembler (`src/ir/backend/contract-conformance.ts`) — including the
headline property: a handle minted before a late import resolves correctly
after it, with zero fixup.

## Per-slice implementation specs (re-grounded 2026-07-12, fable-arch)

> Verified against `upstream/main @ 31b1970cfb`. Re-grep every anchor before
> editing. **State deltas since the slice table above was written:**
>
> - **S1 + S4 are LANDED** (contract.ts / README / conformance / A1–A7).
> - **R-SIZE already exists** — `check:loc-budget`
>   (`scripts/check-loc-budget.mjs`, #3102/#3131, THRESHOLD=1500,
>   change-scoped, wired into `quality` at `.github/workflows/ci.yml:152`).
>   S7 shrinks to the R-DEP half. Do NOT build a second size ratchet.
> - **#2956 L1 landed WITHOUT L0** — `src/ir/backend/linear-integration.ts`
>   is a live second consumer of the lowering pipeline. S3 now cuts the
>   adapter interface with TWO consumers in view (recorded in #2956's
>   "L0 deviation" note — the extraction is owned HERE, once).
> - **File sizes (R-SIZE offenders this umbrella shrinks):**
>   `src/codegen/expressions/calls.ts` **18,474** (moved from
>   `src/codegen/calls.ts` and grew), `src/runtime.ts` 16,257,
>   `src/codegen/index.ts` **15,625**, `src/codegen/object-runtime.ts`
>   10,453, `src/codegen/array-methods.ts` 9,565. S8 targets calls.ts;
>   S3c shrinks `src/ir/integration.ts` (2,758).
> - **pushRaw ground truth:** 103 `pushRaw(` call sites in
>   `src/ir/lower.ts`, **zero** `// pushraw-ok` tags yet — #2953's step 4
>   (the count ratchet) is not built. S2 spec below covers that residual.
> - **ir → codegen import inventory (the R-DEP baseline, exact):**
>   `src/ir/integration.ts` ×18 import statements;
>   `src/ir/nodes.ts:21`, `src/ir/builder.ts:40`, `src/ir/verify.ts:28`,
>   `src/ir/backend/handles.ts:24`, `src/ir/from-ast.ts:57` — all five are
>   `js-tag.js`; `src/ir/from-ast.ts:40-44` (FMOD_FN,
>   `evaluateConstantCondition`, `isIncreasingStep`/
>   `loopBodyMutatesIndexOrArray`);
>   `src/ir/backend/linear-integration.ts:48` (type-only `LinearContext`
>   from codegen-linear).

### Classification (who can execute what, now)

| Slice                    | Classification                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2 (pushRaw families)    | **executable now — but OWNED by #2953** (assignee opus-1a, in-progress). Do not double-dispatch; only the R-ESCAPE ratchet residual is unowned.       |
| S3a (js-tag mv)          | **fable-executable-now** — one `git mv` + shim, byte-inert                                                                                            |
| S3b (from-ast residue)   | **fable-executable-now** — after or with S3a                                                                                                          |
| S3c (integration split)  | **fable-executable-now** — interface already ratified in #2956 L0; two live consumers exist                                                           |
| S5 (assembler adapters)  | adapter PRs **fable-executable-now**; the positional-read migration waves are **blocked-on-#2710** sequencing (owned there — coordinate, don't clone) |
| S6 (directory re-layout) | waves 1–2 **fable-executable-now**; waves 3–5 **blocked-on-S3c** (gc wave also wants #2953 families landed); ALL waves lead-scheduled                 |
| S7 (R-DEP ratchet)       | **fable-executable-now**, no dependencies — land EARLY (R-SIZE half already banked)                                                                   |
| S8 (calls.ts decomp)     | **fable-executable-now**, continuous — owned by #742 (in-progress); method + oracle live there                                                        |
| S9 (MLIR memo)           | **OPUS-owned decision memo** — options laid out below, NOT picked here; hard-blocked on #3030 T3 (serializer not yet landed)                          |
| #3030 format/versioning  | **already frozen on main** (T1 D1/D2, 2026-07-04); residual open forks are an OPUS-owned memo in #3030                                                |

### Dispatch lines (lift straight into TaskList; gate = what proves it safe)

| Task                | One-line dispatch summary                                                                                                                                                                                                                                                    | Proving gate                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **S3a** [S]         | `git mv src/codegen/js-tag.ts src/ir/js-tag.ts` + one-line shim at old path + flip the 5 ir-side imports (nodes:21, builder:40, verify:28, from-ast:57, handles:24)                                                                                                          | import-path-only ⇒ byte-identical: tsc + equivalence + `prove-emit-identity.mjs` spot-check       |
| **S3b** [S]         | Re-home from-ast's 3 upward imports: FMOD_FN → `src/ir/names.ts`; `evaluateConstantCondition` + `isIncreasingStep`/`loopBodyMutatesIndexOrArray` → `src/compiler/ast-analysis.ts` (shims at old paths)                                                                       | tsc + equivalence; no emitted-code change                                                         |
| **S3c** [M–L]       | Split `compileIrPathFunctions` (integration.ts:138): neutral core keeps `IrBackendIntegration` param; WasmGC arm (makeResolver:1280 + Deferred\* + preregister\* + patch site) cut-pastes to new `src/codegen/ir-gc-adapter.ts`; caller index.ts:2205 constructs the adapter | **byte-identity**: `prove-emit-identity.mjs` + `byte-diff-corpus.mts` + equivalence + merge_group |
| **S5-gc** [M]       | New `src/codegen/module-assembler.ts`: `GcModuleAssembler` implementing contract part 5 over `mintDefinedFunc`/`pushDefinedFunc`/`ensureLateImport`/`resolveLayout`; bind in `tests/backend-contract.test.ts`; ZERO call-site migration                                      | additive-only ⇒ byte-inert: `prove-emit-identity.mjs` + conformance tests + tsc                   |
| **S5-linear** [S–M] | `LinearModuleAssembler` over `LinearContext` (context.ts:7), same conformance binding, no call-site change                                                                                                                                                                   | additive-only ⇒ byte-inert: same gates                                                            |
| **S6-w1** [S]       | `git mv src/ir/backend/bytecode-{emitter,vm}.ts → src/backend/bytecode/` + README + import-path rewrite                                                                                                                                                                      | tsc + equivalence; byte-identical (path-only)                                                     |
| **S6-w2** [S–M]     | `git mv` contract files (`contract,emitter,legality,handles,contract-conformance,README`) → `src/backend/contract/`; `wasmgc-emitter.ts` → `src/backend/gc/emitter.ts`                                                                                                       | tsc + equivalence; byte-identical (path-only); lead-scheduled window                              |
| **S7 R-DEP** [S–M]  | New `scripts/check-layer-imports.mjs` (change-scoped, baseline = the exact violation inventory above) + `check:layer-imports` in package.json + `quality` (ci.yml ~152)                                                                                                      | script unit test; no compiler change ⇒ byte-inert by construction                                 |
| **S2-resid** [S]    | New `scripts/check-pushraw.mjs`: fail on `pushRaw(` growth in lower.ts (base 103) unless `// pushraw-ok(#NNNN)` tagged; `--update-on-decrease` banks; wire into `quality`                                                                                                    | script unit test; no compiler change ⇒ byte-inert by construction                                 |

Ordering constraint the lead should encode: **S7 R-DEP + S2-resid first**
(lock the boundary before the moves), then S3a → S3b → S3c, then S5-gc /
S5-linear / S6-w1 / S6-w2 in any order (S6 waves 3–5 stay blocked on S3c).

### S2 — pushRaw families (defers to #2953; residual spec: the R-ESCAPE ratchet)

#2953 owns the family conversions (refcells done; unions/boxing, closures,
coercions/null, funcref, Promise remain). What is NOT yet built anywhere is
its step 4, the count ratchet. Spec (S-sized, one PR, no dependency on the
family order):

- **New `scripts/check-pushraw.mjs`** patterned on
  `scripts/check-loc-budget.mjs`'s change-scoped shape (reuse
  `scripts/lib/change-scope.mjs`): count `pushRaw(` call sites in
  `src/ir/lower.ts` (today: 103), fail when the count GROWS relative to the
  change base unless the added site carries a `// pushraw-ok(#NNNN)` tag on
  the same or preceding line; `--update-on-decrease` banks shrinkage into
  `scripts/pushraw-baseline.json` post-merge.
- Wire into `quality` (`.github/workflows/ci.yml`, next to
  `check:loc-budget` at line ~152) + a `check:pushraw` package.json script.
- Gate: the script's own unit test (fixture strings), tsc, no compiler
  change ⇒ byte-inert by construction.

### S3 — kill the `ir → codegen` import direction (three PRs)

Goal (umbrella acceptance criterion): `src/ir/` has zero imports from
`src/codegen/`, then R-DEP flips to enforcing for `src/ir/`.

**S3a — `js-tag.ts` is IR contract surface; move it (byte-inert).**
`JsTag` is the #2949/#3030-D3.4 partition enum — backend-neutral by
definition, living in the wrong directory. It accounts for 5 of the 9
violating files.

- `git mv src/codegen/js-tag.ts src/ir/js-tag.ts`.
- Recreate `src/codegen/js-tag.ts` as a one-line re-export shim
  (`export * from "../ir/js-tag.js";`) so the ~100 codegen importers are
  untouched (shim is a legal downward import: codegen → ir).
- Flip the five ir-side imports to the new home:
  `src/ir/nodes.ts:21` (type-only — this restores nodes.ts's "pure leaf"
  status), `src/ir/builder.ts:40`, `src/ir/verify.ts:28`,
  `src/ir/from-ast.ts:57`, `src/ir/backend/handles.ts:24`.
- Check first that `src/ir/js-tag.ts` has no upward imports of its own
  (grep its import block — if it imports codegen internals, extract only
  the enum + `jsTagUnboxKind` and leave the rest behind).
- Gate: tsc + `npm test -- tests/equivalence.test.ts` + merge_group. The
  change is import-path-only ⇒ byte-identical output; spot-confirm with
  `node scripts/prove-emit-identity.mjs` if touched beyond paths.

**S3b — from-ast's three analysis imports (small, mechanical).**

- `FMOD_FN` (`src/ir/from-ast.ts:40` ← `src/codegen/fmod.ts`): the name
  constant is IR-namespace-owned (A6). Move the `const FMOD_FN` declaration
  into `src/ir/js-tag.ts`'s sibling (new `src/ir/names.ts`, or export from
  from-ast) and have `src/codegen/fmod.ts` import it FROM ir (downward).
- `evaluateConstantCondition` (`from-ast.ts:41` ←
  `src/codegen/statements/control-flow.ts`) and `isIncreasingStep` /
  `loopBodyMutatesIndexOrArray` (`from-ast.ts:44` ←
  `src/codegen/statements/loops.ts`): pure ts.AST analysis helpers —
  frontend-shaped, no codegen state. Move them to a new
  `src/compiler/ast-analysis.ts` (the L1 home that already exists —
  `src/compiler/` holds define-substitution/early-errors), leave re-export
  shims at the old codegen paths so loops.ts/control-flow.ts callers are
  untouched. Verify the moved functions themselves import nothing from
  codegen (read their bodies first; if they touch codegen types, extract
  the AST-only core instead).
- Gate: tsc + equivalence; byte-inert (no emitted-code change).

**S3c — split `compileIrPathFunctions`: neutral core stays, WasmGC adapter
moves to codegen (the L0 design ratified in #2956 — do it once, here).**

Anchors: `src/ir/integration.ts:138` (`compileIrPathFunctions(ctx:
CodegenContext, …)`), sole production caller `src/codegen/index.ts:2205`,
import block `integration.ts:27-70` (the 18 codegen imports), resolver
factory `makeResolver` at `integration.ts:1280-1289` (+
`DeferredObjectResolver`/`DeferredClosureResolver`/… at 715-927),
`preregisterStringSupport` at 1593 (+ the iterator twin ~1745),
`makeDynamicLowering` at 2001.

1. **New file `src/codegen/ir-gc-adapter.ts`** (interim home; S6 wave 5
   moves it to `src/backend/gc/`): receives, verbatim, everything in
   integration.ts that touches `CodegenContext` or imports codegen —
   `makeResolver` + the Deferred\* resolver builders, `makeDynamicLowering`,
   `preregisterStringSupport` / `preregisterIteratorSupport`, the
   `ctx.mod.functions[localIdx]` patch site, helper materialization
   (ensureFmod / VEC_ELEM_SET / charCodeAt arms of `resolveFunc`). This is
   a cut-paste move, not a rewrite — same function bodies, same order.
2. **`src/ir/integration.ts` keeps the backend-neutral core**: selection
   consumption, calleeTypes fixpoint, per-function `lowerFunctionAstToIr` →
   `verifyIrFunction` → passes → `lowerIrFunction`, report/error handling.
   Its signature changes to
   `compileIrPathFunctions(integration: IrBackendIntegration, sourceFile, …)`
   where `IrBackendIntegration` is the **already-ratified** interface from
   #2956's L0 section (backend kind, `resolver`, `lookupFunc`,
   `numImportFuncs`, `patchFunction`, `ensureHelper`) — declare it in
   `src/ir/backend/contract.ts` next to the five parts, plus the two
   lifecycle hooks the WasmGC path needs:
   `prepare(readyForLower: readonly BuiltFnRef[]): void` (the
   preregister-string/iterator step) and
   `dynamicLowering(): IrDynamicLowering | null`.
3. **`src/codegen/index.ts:2205`** constructs the adapter and passes it in:
   `compileIrPathFunctions(makeGcIntegration(ctx, …), ast.sourceFile, …)`.
   codegen importing ir is downward-legal; the 18 upward imports disappear
   from `src/ir/`.
4. **`src/ir/backend/linear-integration.ts`** stays as-is this PR (its one
   type-only codegen-linear import is an R-DEP baseline entry retired by S6
   wave 3); a follow-up may re-shape it as a second `IrBackendIntegration`
   implementer — with two live consumers the interface is now cut against
   reality, which is exactly why S3c waited for #2956 L1.
5. Gate: **byte-identity** — `node scripts/prove-emit-identity.mjs` +
   the #2138 corpus hash harness (`scripts/byte-diff-corpus.mts`), then
   equivalence + full merge_group. After merge: add `src/ir/` to the
   R-DEP enforcing set (S7's baseline drops the 18+5+3 entries).

Sizing: S3a+S3b = S each; S3c = M–L (2.7k-line file split, but move-only).

### S5 — ModuleAssembler adapters (adapter-first; migration stays with #2710)

The interface is frozen (`src/ir/backend/contract.ts`, part 5, invariants
A1–A7). S5 lands **adapters over the live registries** — no call-site
migration in these PRs (that is #2710 slice 4's job; sequencing only).

**PR 1 — `GcModuleAssembler`** (new `src/codegen/module-assembler.ts`;
S6 wave 5 moves it):

- `declareFunc` → `mintDefinedFunc(ctx)` (`src/codegen/func-space.ts:114`);
  `defineFunc` → `pushDefinedFunc(ctx, handle, def)` (func-space.ts:126).
- `importFunc` → transitional wrapper over the live late-import path
  (`ensureLateImport`, `src/codegen/shared.ts`): performs today's
  registration (including the legacy shift, until #2710 4b/4c deletes it)
  and returns the minted handle. The contract's A3 "shift-free" promise is
  satisfied at the SEAM (callers see only handles); the shift remains an
  encapsulated implementation detail until #2710 retires it.
- `lookupFunc/Global/Type` → views over `ctx.funcMap` / `moduleGlobals` /
  `ctx.typeNames`; `internType` → the live `addFuncType`/struct
  registration; `exportFunc/Global`, `setStart` → the `WasmExport` /
  `startFuncIdx` records.
- `finalize()` → delegates to `resolveLayout(ctx.mod)`
  (`src/emit/resolve-layout.ts:183`) and sets/asserts
  `ctx.indexSpaceFrozen` (`src/codegen/context/types.ts:1839`); second call
  throws (A4).
- Bind it in `tests/backend-contract.test.ts` (the stub-assembler
  conformance cases run against the real adapter too — A2/A3/A4/A5/A6
  properties, incl. the headline "handle minted before a late import
  resolves correctly after it").

**PR 2 — `LinearModuleAssembler`** over `LinearContext`
(`src/codegen-linear/context.ts:7`): simpler — name-keyed
`funcMap`/`mod.functions` slots, no late-import shift regime, no type
hoisting. Same conformance binding.

- Gate (both PRs): additive code + conformance tests only, zero call-site
  change ⇒ byte-inert; prove with `scripts/prove-emit-identity.mjs` + tsc +
  equivalence. The subsequent migration of the ~40 positional-read sites
  (`index.ts` ×39 + `integration.ts` ×1, per the convergence map above) is
  **#2710 slice 4a–4d — check its assignee before touching**.

### S6 — directory re-layout (`git mv` waves, one per PR, lead-scheduled)

Ground truth: `src/codegen/` = **158 files**, `src/codegen-linear/` = 6,
`src/ir/backend/bytecode-*.ts` = 2 (+ `bytecode-vm`), frontend candidates =
`src/checker/` (5 files), `src/compiler/` (define-substitution,
early-errors/), `src/compiler.ts`, `src/ts-api.ts`, `src/shape-inference.ts`,
`src/import-resolver.ts`.

Wave order (each: `git mv` + one-shot import-path rewrite driven by tsc
errors + the #1859 README; **no re-export shims between waves** — shims
would defeat R-DEP; no logic change whatsoever):

1. `src/ir/backend/bytecode-{emitter,vm}.ts` → `src/backend/bytecode/`
   (2 files, ~no in-flight-branch conflict risk). Executable now.
2. `src/ir/backend/{contract,emitter,legality,handles,contract-conformance,README}`
   → `src/backend/contract/` (+ `wasmgc-emitter.ts` decision: it is
   GC-owned — send it ahead to `src/backend/gc/emitter.ts` in this wave and
   create the dir). Executable now.
3. `src/codegen-linear/` (6 files) + `src/ir/backend/linear-integration.ts`
   - `linear-emitter.ts` → `src/backend/linear/` (retires the
     linear-integration R-DEP baseline entry). After S3c.
4. checker/compiler/compiler.ts/ts-api.ts/shape-inference.ts/
   import-resolver.ts → `src/frontend/`. Independent; schedule when quiet.
5. `src/codegen/` (158 files) → `src/backend/gc/` — the monster. HARD
   requirements: after S3c (so `src/ir/` doesn't chase the move), quiet
   merge-queue window, lead broadcast so no in-flight branch strands,
   single PR, `git mv` only. Expect every open branch to need one
   `git merge origin/main` with rename detection (merge, never rebase).
6. `src/runtime*.ts` → `src/runtime/` — rides #1934, not this umbrella.

- **loc-budget interaction**: `scripts/loc-budget-baseline.json` keys are
  paths. The gate is change-scoped off git (renames grandfather at base),
  and the baseline is reseeded post-merge on main by the promote-baseline
  writer — so a pure-move PR passes without touching the baseline. Do NOT
  hand-edit the baseline in the move PR.
- Gate per wave: tsc + equivalence + merge_group; waves are import-path
  refactors ⇒ byte-identical (spot-check `prove-emit-identity.mjs`).

### S7 — CI ratchets: R-SIZE is DONE; build R-DEP (land early, no deps)

- **R-SIZE — banked.** `check:loc-budget` (#3102/#3131) already enforces
  the 1,500-line ceiling change-scoped in `quality`
  (`.github/workflows/ci.yml:152`), grandfathering + shrink-banking
  included. The umbrella's acceptance criterion is satisfied by pointing at
  it; build nothing.
- **R-DEP — new `scripts/check-layer-imports.mjs`** (pattern:
  `check-issue-ids.mjs` for the scan, `check-loc-budget.mjs` +
  `scripts/lib/change-scope.mjs` for change-scoping):
  1. Hardcode the layer map v1 (path-prefix → rank):
     `src/checker|src/compiler|src/ts-api|src/shape-inference|src/import-resolver` = L1,
     `src/ir` = L3 (contract surface `src/ir/backend` = L4),
     `src/codegen|src/codegen-linear` = L5, `src/emit|src/link` = L6,
     `src/runtime*` = L7. (Reading per-README declared deps — R-OWN — is
     v2, after #1859 populates them; do not block on it.)
  2. Scan `import`/`export … from` specifiers, resolve relative paths, flag
     any edge where importer-rank < importee-rank (an upward import).
  3. Baseline `scripts/layer-imports-baseline.json` seeded with today's
     known violations (exactly the inventory in the grounding block above);
     fail on NEW violations anywhere, `--update-on-decrease` banks
     removals; enforcing (empty-baseline) per directory as S3/S6 clear
     them — `src/ir/` flips first, right after S3c.
  4. Wire as `check:layer-imports` in package.json + the `quality` job next
     to `check:loc-budget`.
- Gate: script unit test with fixture files; no compiler change.

### S8 — calls.ts decomposition (defers to #742; grounding refresh only)

The target moved and grew: `src/codegen/calls.ts` is now
`src/codegen/expressions/calls.ts` at **18,474 lines** — the single largest
file in the tree (passed index.ts). #742 (in-progress) owns the method: per
PR, extract one self-contained guard/dispatch family into
`src/codegen/expressions/calls/<family>.ts`, prove byte-identity with its
25-program WAT-hash oracle, let the post-merge loc-budget reseed bank the
shrinkage. Table-driven callee registry (`Map<key, handler>`, handler
returns `undefined` = not-my-case) is the end-state per R-DISPATCH. No new
spec needed here — S8 exists in this umbrella only so the R-SIZE ledger
attributes the shrinkage.

### S9 — MLIR feasibility: DECISION MEMO (opus-owned — options only, no pick)

**Hard dependency:** #3030 T3 (serializer) has NOT landed — only T1 (the
contract doc/schema/version constant). Any out-of-tree consumer path is
blocked until `--emit-ir` exists. Do not start S9 before T3.

The fork to decide (NOT decided here):

**Option A — out-of-tree consumer of the serialized IR (#3030).**
A separate tool (own repo) reads the canonical-JSON IR and builds an MLIR
module via mlir-python / a small C++ translator; js2wasm ships zero MLIR
code.
_For:_ zero toolchain/CI weight in-repo (LLVM/MLIR is a ~GB build dep);
drift contained by the versioned contract (`IR_FORMAT_VERSION`, schema
gate T5); exactly the consumer #3030's D3 guarantees were written for;
failure is free (memo-grade experiment, no revert).
_Against:_ no pressure on the five-part contract (the in-tree seam gets no
second implementer, so contract rot risk stays); coverage limited to the
`carrier: "ir"` manifest subset; a second repo to own.

**Option B — in-tree fifth backend implementing the five-part contract.**
`src/backend/mlir/` implements TypeConverter (IrType → MLIR types),
BackendLegality (dialect-mappable kinds), `BackendEmitter<Sink>` with
Sink = an MLIR builder (or a textual `.mlir` string builder to avoid
binding deps), LayoutResolver, ModuleAssembler (finalize → `mlir::ModuleOp`
/ textual module).
_For:_ the contract gets its first true external-shaped implementer —
every hidden WasmGC assumption surfaces (the strongest possible S1/S4
validation); block-arg SSA maps 1:1 onto MLIR regions (no Φ translation —
the design bet made in compiler-design-lessons §2, verifiable here); stays
inside our test/CI discipline.
_Against:_ toolchain dependency (native MLIR libs or a bindings package) in
CI; a fifth lowering to keep green forever vs. a memo-grade experiment;
textual-MLIR emission avoids the dep but forfeits MLIR's verifier (half the
value).

**Option C — hybrid (sequenced A-then-B).** Out-of-tree translator first
(cheap, proves the mapping tables kind-by-kind); promote to an in-tree
backend only if a real consumer (optimization pipeline, alternate target)
materializes.
_For:_ defers the expensive commitment behind evidence; the translator's
kind→dialect mapping table is reusable as B's legality/emitter spec.
_Against:_ two artifacts if promotion happens.

**What the memo must deliver** (whichever option opus ratifies): the
IrInstr-kind → MLIR-dialect-op mapping table (which kinds hit `arith`/
`cf`/`func` directly, which need a custom `js2` dialect — dynamic ops,
box/unbox/tag.test, closures, vec ops); the effects-annotation → MLIR
side-effect-interface mapping (#2134); the type story (IrType.dynamic has
no MLIR analogue — custom type or lowered pair); and the go/no-go cost
line (toolchain, CI minutes, ownership).

The prior text above ("expected answer: out-of-tree first") is an
expectation, not a ratification — the memo decides.

## Progress log

### S1 + S4 landed (fable-arch-slices, 2026-07-04)

- **S1 — contract freeze**: `src/ir/backend/contract.ts` declares/re-exports
  all five parts (`TypeConverter<Slot>`, `BackendLegality` + `legalityFor`,
  `BackendEmitter<Sink>` re-export — the sink was already generic since
  #1584, so S1 banks it as contract surface — `LayoutResolver` as the
  canonical name of `IrLowerResolver`, `ModuleAssembler`, and the
  `BackendContract` bundle). Contract README at `src/ir/backend/README.md`
  (ownership table, operand-order rules, memoization ownership, R-ESCAPE,
  R-DEP declaration). Conformance skeleton
  `src/ir/backend/contract-conformance.ts`: tsc-enforced proof that the
  three emitters satisfy `BackendEmitter<Sink>` with their own sinks + a
  from-scratch stub backend implementing all five parts over a foreign
  `string[]` sink. Byte-inert: new files + type-only re-exports + one
  unused-by-callers factory; no call site changed.
- **S4 — ModuleAssembler design**: ratified above; interface body in
  contract.ts; invariants executable in tests/backend-contract.test.ts.
- Open slices: S2 (#2953, owned), S3, S5–S9 (Opus lanes per the tier
  ruling). Umbrella stays in-progress; claim released on merge so the next
  slice can dispatch.
