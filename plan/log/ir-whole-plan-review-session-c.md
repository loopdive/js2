# IR migration whole-plan review — Session C's proposed revisions to #6920 / #6865

Author: Session C (Claude Fable 5.1), 2026-10-08. Base reviewed: main
`8452732f0b`. Plan inputs: issue 6920 (published in [PR 6596](https://github.com/loopdive/js2/pull/6596) at `5d1d872`)
and #6865 as of commit `5d1d872241` (2026-10-08, "link B memory plan to its
immutable published commit" — **not reachable from any ref in this clone**, so
the two plan files are not on main; citations below are to the published
copies the review was given), plus the main-tree sources cited by path:line.

**Status of this document.** These are *proposals* from Session C to the
owners of #6920 (Session A, root) and #6865 (Session B). Nothing here edits
their files; each item is for them to accept, amend or reject. Labels:
**[confirmed]** verified against source / PR API with a citation ·
**[proposed]** Session C's recommendation · **[unresolved]** needs an owner
decision.

---

## 1. Confirmed facts the plans rest on

### 1a. The #6920 "current source defects" are real

- **[confirmed]** `resolveVecType` (`src/ir/lower-generic.ts:950-972`) and
  `lowerIrTypeToValType` (`:3991-4027`) prefer an explicit GC `type.layout`
  and fall back to `resolver.resolveVecForElement`, whose return type is the
  GC-shaped `IrVecLowering` (`src/ir/backend/handles.ts:183-190`:
  `vecStructTypeIdx / lengthFieldIdx / dataFieldIdx / arrayTypeIdx`). Nuance
  the plan under-states: `IrVecLowering.valueType?` already exists and
  `lowerIrTypeToValType` honours it (`:4026`), so the *outer ABI* can already
  be `i32`; the gap is internal construction and scratch, not signatures.
- **[confirmed]** `ensureVecDataScratch(arrayTypeIdx)`
  (`lower-generic.ts:848-856`) unconditionally allocates a `ref_null typeIdx`
  local; `vec.new_fixed` calls it with `vec.arrayTypeIdx` (`:2367`). The
  Linear overlay (`src/ir/backend/linear-integration.ts`, not
  `codegen-linear/` as earlier drafts said) smuggles through by returning a
  **fake GC handle** (`:1915-1937`: `vecStructTypeIdx: 0, arrayTypeIdx: 0,
  valueType: i32`) and **rewriting emitted locals afterwards**
  (`linear-emitter.ts:160-166, 349` → `linear-integration.ts:1607-1616`). The
  plan's "do not copy the overlay post-processing" is justified.
- **[confirmed]** `planPhysicalSetup` refuses Linear with allocations
  (`src/ir/program-physical-plan.ts:1456-1458`); `physicalBodyResolver` binds
  only GC vectors (`src/ir/program-consumer.ts:1137-1138`);
  `fillPreparedPrimaryUnit` constructs a bare `new LinearEmitter()`
  (`src/ir/program-native-invocation.ts:237`), so even `vec.len` throws on
  Linear (`linear-emitter.ts:273-276` needs `resolveRuntimeOperation`).
- **[confirmed]** Every Linear vector read needs `__arr_resolve`
  (`linear-emitter.ts:251-278` → `resolve-forwarding`), defined by
  `ensureArrayResolveRuntime` (`src/codegen-linear/runtime.ts:797-799`) via
  `addRuntime/addArrayRuntime/addLinearIrVecRuntime` (`:129, :847, :1375`),
  which mutate a raw `WasmModule` — not ledger-reservable, as the plan says.
- **[confirmed]** Geometry authority today is
  `src/ir/analysis/linear-memory-plan.ts` (`LINEAR_ARRAY_FORWARDING :82`,
  `prepareLinearAllocationFacts :393`, `verifyLinearPreparedAllocationFacts
  :599`, `planLinearMemoryFromFrozenFacts :687`, `planLinearVectorLayout
  :812`). `src/shared/contracts/linear-memory-layout.ts`, `src/backend/`,
  `src/compiler/native-linear-pipeline.ts` **do not exist on main**; the
  plan's "source route" names unpublished A1 modules.
- **[confirmed]** `{target: "standalone"|"wasi", backend: "linear"}` does not
  exist: `src/target-profile.ts:83` hard-codes
  `backend = target === "linear" ? "linear" : "wasmgc"`.

### 1b. Facts the plans do not state that change the risk picture

- **[confirmed, measured]** On main the #6920 fixture **already returns 1.25
  on `target: "linear"`** through legacy Linear codegen + the IR overlay
  (`__arr_new`, `__arr_resolve`, `__linear_ir_vec_init_f64`); with
  `JS2WASM_LINEAR_IR=0` it also returns 1.25 via direct codegen. The overlay is
  **default-on** (`linear-integration.ts:412`, `linearIrEnabled()` — enabled
  unless `=0`). The handoff's "env cannot authorize it" describes the *native
  prepared* route, not what users get today.
- **[confirmed]** `runPreparedIrPipelinePresentation` (`src/compiler.ts:1185`)
  is exported but **never called by `compile()`**; its callers are 8 test
  files (`tests/issue-3525-prepared-*`, `issue-6837-*`, `issue-6864-*`). The
  A-C / B-M path targets a pipeline with no public entry; the user-visible
  value of the #6920 critical path is architectural until A-P lands.
- **[confirmed]** Two middle-end drivers coexist with one pass sequence:
  `runHygienePasses` (`src/ir/program-middleend.ts:17`, used by
  `src/ir/integration.ts:321`) and `runHygienePassesIr`
  (`src/ir/program-middleend-ir.ts:37`, used by `program-prepare-ir.ts`).
  GVN is off by default in both (`gvnMode: "off"` unless `JS2WASM_IR_GVN`,
  `program-middleend.ts:33`); ownership/escape are env-gated off
  (`:34-35`), yet `prepareLinearAllocationFacts` re-runs
  ownership/escape/encoding itself (`linear-memory-plan.ts:397-402`). A-F
  step 3 ("facts after final middle-end analysis") must reconcile this.
- **[confirmed]** The passes are target-neutral: `src/ir/passes/*.ts` import
  only `../nodes|builder|analysis|callable-bindings|string-runtime|type-key|
  ../../shared/contracts|../../env`; no `backend/`, `codegen*`, Wasm types.
  **And the Linear lane does not run them at all**:
  `src/ir/backend/linear-integration.ts` imports nothing from `passes/` or
  `program-middleend*`, and `compiler.ts:1093-1101` routes Linear to
  `generateLinearModule`. So pass bugs are GC+standalone bugs today, and
  become Linear bugs the day A-P routes Linear through the prepared pipeline.
- **[confirmed, new since the first draft]** The passes have real correctness
  defects under default flags — see **#6921**
  (`plan/issues/6921-ir-middle-end-pass-correctness.md`): the inliner
  splices callee `slot.*` ops unremapped (silent wrong answer `6007` vs
  `105007`, and a hard CE when the caller has no slots), and
  `dyn.to_number` / loose `dyn.eq` are classified pure so DCE drops
  `valueOf` calls and throws; GVN (`JS2WASM_IR_GVN=1`) merges repeated
  ToNumber. Raw evidence: `plan/log/6921-ir-pass-correctness/`. This
  replaces the first draft's weaker "pass test coverage is thin" (still true:
  `constantFold` is referenced by 3 test files, `simplifyCFG` 2, `gvnCore` 3).
- **[confirmed]** A dual-backend oracle already exists:
  `tests/cross-backend-diff.test.ts` (#1854) compiles every
  `tests/cross-backend/corpus.ts` program on GC and Linear and diffs returns;
  13 entries are `expectLinearUnsupported` (ratchet-down).

### 1c. Ownership / claim facts

- **[confirmed]** The ledger carries ~130 `in-progress` records dated
  2026-10-06..08: #6865 alone has ~45 slices across 16+ Codex A owners; B
  holds the 6888/6891/6892/6893/6896/6899/6905/6911/6914/6915/6916/6917
  families (3–7 sub-slices each).
- **[confirmed]** The four donor acknowledgements #6920 blocks on are stale
  or scope-less: `2956:l2-vec` claimed 2026-07-16 (no write id); `4540`
  claimed 2026-08-19 on `claude/linear-memory-quickjs-backend-gkhszu`;
  `3518:allocation-ownership-runtime` and
  `3518:physical-module-completion-kernel` claimed 2026-09-08 and **not
  described anywhere in any issue-3518 file under plan/issues** (grep: zero hits).
- **[confirmed]** All nine A/B PRs (6572, 6575, 6577, 6583, 6590, 6593, 6595,
  6596, 6597) are `hold`. Six B PRs all modify `src/codegen-linear/runtime.ts`
  plus `scripts/compiler-boundaries.json`, so they conflict with each other
  regardless of A. Only PR 5748 (hold, old) touches `src/ir/passes/`
  (`inline-small.ts`), and not the slot path.

---

## 2. Assessment

### Q1 — Is A-F → A-G → A-C → B-M → A-P correctly ordered?

- **[confirmed]** The dependency direction is right (facts/geometry before the
  consumer; consumer contract before B's pack; public caller last).
- **[proposed]** The granularity is wrong. A-G (geometry) has **no dependency
  on A-F**: they touch disjoint functions of one file
  (`linear-memory-plan.ts:67-107, 780-923` vs `:134-686`), and A-G is the only
  slice with an immediate measurable payoff — it removes the
  codegen-linear→ir value edges failing `quality` on PRs 6572/6577/6583. Land
  it **first and alone**, not behind donor acknowledgements whose owners are
  effectively absent (§1c).
- **[proposed]** A-C is one slice over five shared files
  (`program-physical-plan.ts`, `program-consumer.ts`,
  `program-native-invocation.ts`, `lower-generic.ts`,
  `ir/backend/{handles,lower-contracts}.ts`). Split: **A-C1** = generic seam
  only (`resolveVectorRepresentation`; scratch derived from the handle;
  `ensureVecDataScratch` takes a representation, not an `arrayTypeIdx`) with
  GC byte-identity tests; **A-C2** = consumer dispatch. A-C1 is testable on GC
  today with no B dependency.

### Q2 — Generic IR vs target lowering: leaks and duplicate authorities

- **[confirmed]** The plan keeps generic IR clean (no offsets or helper names
  in IR; `LinearVecLowering` lives in `ir/backend/handles.ts:453`).
- **[confirmed] leak today:** the overlay's fake GC handle plus post-hoc local
  rewrite (§1a) is the concrete leak the plan targets.
- **[confirmed] duplicate authorities the plan does not name:** (a) two
  hygiene drivers; (b) ownership/escape run both in the middle-end (gated) and
  inside `prepareLinearAllocationFacts`; (c) #6920 proposes
  `src/backend/linear/program/memory.ts` **and** #6865 proposes
  `src/backend/linear/{prepared-memory,physical-resources,body-resolver}.ts`
  with different function names (`planPreparedLinearMemory…` vs
  `prepareLinearPhysicalMemory…`). **[unresolved]** — two facades if both B
  writers proceed.
- **[proposed]** Pick the #6920 five-function contract
  (plan/reserve/fill/complete/bindings), delete the #6865 names from the
  handoff; one `memory.ts` + `contracts.ts`.

### Q3 — Process risk

- **[confirmed]** Planning overhead dominates: #6920 is ~710 lines and
  authorizes zero edits; 10 acknowledgement groups; frozen cohorts of 48+24+13
  rows "before first run". Meanwhile the product behaviour (1.25 on Linear)
  works on main via a route the plan treats as legacy, and the route the plan
  builds has no public caller.
- **[confirmed]** B's six PRs serially conflict on `runtime.ts` and are all
  blocked on A-G; A-G is blocked on acknowledgements from claims silent for
  1–3 months.
- **[proposed]** Treat claims older than 30 days with no PR and no issue-file
  scope as expired by root decision; replace "named acknowledgement" with
  "root reviews the diff".

---

## 3. Proposed plan changes (for A root / B to accept or reject)

1. **[proposed → A]** Land **A-G alone first** as one small PR
   (`src/shared/contracts/linear-memory-layout.ts` + re-exports in
   `ir/analysis/contracts/linear-memory-layout.ts` + adapter in
   `linear-memory-plan.ts`), gated by the existing identity/preservation
   suites (`tests/issue-3518-lowering-analysis-preservation.test.ts`,
   `tests/helpers/ir-lowering-analysis-relocation.*`) and
   `check-compiler-boundaries` / `check-import-cycles`. Drop the "historical
   successor proof" from the gate; keep it as a follow-up.
2. **[proposed → B]** Rebase PRs 6572 → 6577 → 6583 → 6590 as a **stack**
   (shared `runtime.ts`), each retargeting one import to the shared geometry.
3. **[proposed → A]** Split A-C into A-C1 (generic seam, GC-identical) and
   A-C2 (consumer dispatch). A-C1 can start now.
4. **[proposed → A]** A-F: decide the single owner of ownership/escape
   analysis (middle-end vs `prepareLinearAllocationFacts`) *before*
   relocating facts, or A-F moves a duplicate.
5. **[proposed → A/B]** Downgrade the 48/24/13-row frozen cohorts to "rows in
   `tests/cross-backend/corpus.ts` + one prepared-consumer test"; the
   cross-backend harness already is the GC-vs-Linear oracle the plan wants.
6. **[proposed → A]** Record in #6920 that today's public value is delivered
   by the overlay, and state A-P's deliverable as "prepared route reaches
   `compile()` for `{standalone|wasi}+linear`" — the first user-visible
   increment.
7. **[proposed → A, new]** Add #6921 as a **predecessor of A-P**, not of A-F/
   A-G. The moment Linear runs the prepared pipeline it inherits every pass
   bug; fixing the passes while they are GC/standalone-only is cheaper, and
   the fix is file-disjoint from every A/B slice.

---

## 4. Unresolved decisions (owner named)

- **[unresolved — root]** Are claims `2956:l2-vec`, `4540`,
  `3518:allocation-ownership-runtime`,
  `3518:physical-module-completion-kernel` live? If not, release them so
  A-G/A-F stop waiting.
- **[unresolved — root + B]** One memory contract: #6920's five functions vs
  #6865's `prepareLinearPhysicalMemory` family. Pick before B writes a line.
- **[unresolved — A]** Which middle-end driver survives (`runHygienePasses`
  vs `runHygienePassesIr`), and whether GVN / ownership / escape become
  default-on in preparation. A-F depends on it; so does #6921's D2b (GVN
  cannot be turned on until `dyn.to_number` is call-like).
- **[unresolved — root]** Must the prepared route reach `compile()` for the
  first handoff, or is a test-only `runPreparedIrPipelinePresentation`
  acceptance enough? #6920 says "real exported public compile", but A1's
  caller is unpublished.
- **[unresolved — A]** `IrLowerResolver.resolveVectorRepresentation`: does it
  replace `resolveVec` / `resolveVecForElement` (two call sites each,
  `lower-generic.ts:968, 971` and `:4024`) or sit beside them?
- **[unresolved — A, for #6921]** Acknowledge that Session C may edit
  `src/ir/passes/inline-small.ts` and `src/ir/analysis/effects.ts` (shared
  IR files; no 2026-10 claim or open-PR diff touches the affected functions).

---

## 5. Proposed A/B/C ownership map

Subject to A's acknowledgement for the shared-IR rows; C never edits a file
an A or B slice has claimed without that acknowledgement.

| Lane | Owns | Does not touch |
| --- | --- | --- |
| **A (root, #6920)** | Prepared-program pipeline and its consumer: `src/ir/program-*.ts`, `src/ir/lower-generic.ts` / `lower.ts`, `src/ir/backend/{handles,lower-contracts}.ts`, `src/ir/analysis/linear-memory-plan.ts` geometry/facts (A-F, A-G), `src/target-profile.ts` + `compile()` routing (A-P), `src/ir/from-ast.ts` / `select.ts` arms it has claimed | `src/codegen-linear/runtime.ts` (B); pass-internal logic in `src/ir/passes/*` (C), except to accept C's PRs |
| **B (#6865)** | Linear physical memory pack: `src/codegen-linear/runtime.ts`, the one agreed `src/backend/linear/…/memory.ts` + `contracts.ts`, Linear emitter runtime operations (`src/ir/backend/linear-emitter.ts` resolve/forwarding bodies), the B PR stack | Generic lowering seam (A-C1), geometry authority (A-G), passes/effects (C) |
| **C (Session C, #6921 and successors)** | **Target-neutral middle-end correctness**: `src/ir/passes/*` (inline-small, dead-code, gvn-core, constant-fold, simplify-cfg), `src/ir/analysis/effects.ts` purity/side-effect tables, driver unification (`runHygienePasses` → `runHygienePassesIr`) once A decides §4; **cross-backend corpus tests** (`tests/cross-backend/corpus.ts`, `tests/cross-backend-diff.test.ts`, `expectLinearUnsupported` ratchet) and pass-level regression suites | Any backend file (`src/codegen*`, `src/ir/backend/*`), lowering, from-ast/select arms, physical plan/consumer, `runtime.ts` |

Working rules for C: (1) every C change must be byte-identical on GC for
programs that do not exercise the fixed shape (identity suites + WAT diff
named in the PR); (2) Linear is covered by `cross-backend-diff` only, since
Linear does not run the passes until A-P; (3) C files an issue with
preserved base-arm logs before editing, as #6921 does; (4) C's first slice is
#6921; candidates after it, in order: `dyn.member_get` in `isSideEffecting`,
driver unification (after §4), GVN default-on measured against
`cross-backend-diff`, `i32.mul` fold exactness, ratchet
`expectLinearUnsupported` 13 → ≤ 8 (the earlier draft's C1 "vector
representation seam" is A-C1 and stays with A unless A releases it).

---

## 6. Smallest tested-increment sequence to main

1. **A-G geometry PR** (shared contract + adapter, ~3 files; existing
   preservation + boundary gates). Unblocks B's `quality` failures.
2. **B stack 6572 → 6577 → 6583 → 6590** rebased on (1), serial merge.
3. **C: #6921** (inliner slot remap; `dyn.to_number` / loose `dyn.eq`
   call-like) — independent, lands any time; must precede A-P.
4. **A-C1** generic vector seam, GC byte-identical, overlay rewrite deleted.
5. **A-F** facts relocation (after the §4 middle-end owner decision), with
   the 18-row A2 suite as its gate.
6. **A-C2 + B-M** consumer dispatch + `memory.ts` pack; acceptance = #6920
   fixture through `runPreparedIrPipelinePresentation` on Linear, source-free
   replay, cross-backend diff.
7. **A-P** `{standalone|wasi}+linear` in `target-profile.ts:83` + `compile()`
   calling the prepared route — the first user-visible increment.

Each step is one PR with existing gates; none needs a frozen 48-row cohort
before its first run.

## Corrections to the earlier draft

- Overlay files live in `src/ir/backend/`, not `src/codegen-linear/`.
- `runPreparedIrPipelinePresentation` has 8 test callers, not 9.
- "Pass coverage is thin" is superseded by the measured defects in #6921.
- The earlier C2 proposal ("turn GVN default-on") is blocked by #6921 D2b
  and is re-ordered after it.
