---
id: 6965
title: "IR migration: clean module ownership and measurable bloat reduction"
status: ready
sprint: Backlog
created: 2026-10-11
updated: 2026-10-11
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler, frontend, ir, backend, runtime
language_feature: compiler-internals
goal: maintainability
parent: 3029
related: [3399, 3518, 3525, 6808]
requested_by: ttraenkler
origin: "2026-10-11 user review: use the new IR path for a clean structure; reduce bloat and LOC, split large files, and share helpers and implementations"
---

# #6965 — IR migration: clean module ownership and measurable bloat reduction

## User direction and scope

Use the new IR path to build a clean, modular, maintainable and understandable
compiler. Identify and reduce bloat, reduce total implementation LOC, split
large files into focused units, and share helpers and implementations where
their semantics match.

This issue records the architecture review and coordinates bounded follow-up
slices within existing work. It is not a competing migration umbrella and does
not claim implementation, cutover, or runtime-equivalence results.

Existing plans retain their responsibilities:

- [#3029 — Clean compiler architecture umbrella: layered module map, five-part backend contract, reviewability ratchets](3029-clean-compiler-architecture-umbrella.md):
  architecture and backend interfaces.
- [#3399 — Architecture modularization + bloat-reduction roadmap: 2026-07-18 re-grounding + god-function enforcement axis](3399-arch-modularization-bloat-roadmap-regrounding.md):
  decomposition and size enforcement.
- [#3518 — IR-only default and direct front-end retirement](3518-ir-only-default-and-direct-frontend-retirement.md):
  implementation, parity and final retirement.
- [#3525 — IR-only R5: whole-program single- and multi-source Prepared ownership](3525-ir-r5-whole-program-multi-source-ownership.md):
  whole-program ownership and driver integration.
- [#6808 — arch: cut the 74 ir → codegen value-import edges (cut list for #6797 item 2) — shared constants to src/shared/, helpers to src/backend/wasmgc/, legacy-pipeline calls behind IrBackend](6808-ir-to-codegen-edges-cut-list.md):
  dependency-cut inventory. Its 74-edge count is dated evidence, not a new census.

Before dispatch, reconcile each slice with current main, active claims, and
Session A/B/C ownership. The existing A/B coordination channel is
[PR 6583](https://github.com/loopdive/js2/pull/6583); shared contract planning
also exists in [PR 6596](https://github.com/loopdive/js2/pull/6596).
This issue grants no shared-file ownership or queue authority.

## Review evidence and limits

Reviewed on 2026-10-11 in the local checkout at HEAD `b19e6d6b1d`.
That checkout had pre-existing changes, including
`src/ir/backend/lower-contracts.ts`; it was not a clean canonical-main
measurement. Revalidate all anchors and counts against the implementation base.

The census counted physical lines, including comments and blank lines, in all
`src/**/*.ts` files: **926,608 lines across 1,851 files**.

| File | Physical lines | Main restructuring concern |
| --- | ---: | --- |
| `src/runtime.ts` | 20,194 | Mixed host adaptation and runtime responsibilities |
| `src/ir/from-ast.ts` | 16,045 | Large source-to-IR builder with physical representation callbacks |
| `src/codegen/index.ts` | 15,301 | Legacy orchestration and shared mutable state |
| `src/ir/select.ts` | 11,270 | Large admission/shape decision surface |
| `src/ir/integration.ts` | 10,333 | IR overlay coupled to legacy codegen |
| `src/codegen/context/types.ts` | 4,977 | Source, program, backend and function state mixed together |
| `src/ir/program-consumer.ts` | 1,489 | Acceptance, resource preparation and physical emission combined |

Concrete observations:

1. `src/compiler.ts:1142` still dispatches through legacy/linear generators.
   `src/compiler/ir-program-driver.ts:12` implements a prepare → accept → emit
   transaction, but the review found no call to it under `src/`.
2. `src/ir/program-prepare-ir.ts:49` and
   `src/ir/program/prepared-contracts.ts:68` provide useful typed-data seams.
   Keep these explicit inputs and owned state rather than passing legacy context.
3. `src/ir/program-preparation.ts` combines frontend preparation,
   environment controls, legacy accounting and observation.
4. `src/ir/program-consumer.ts:292` accepts programs and prepares concrete
   resources; physical construction starts at `materializePhysicalProgram`.
   Its private acceptance and one-use emission authority are deliberate.
5. `src/ir/from-ast.ts:448` exposes `ValType` and representation queries
   through its resolver. Those callbacks should not become the clean
   frontend's permanent contract.
6. `src/ir/backend/linear-emitter.ts:356` documents copies of core Wasm
   methods implemented in `wasmgc-emitter.ts:207`. Arithmetic, locals,
   structured control and direct-call methods offer a bounded sharing candidate.
   However, `emitConst` and `emitGlobalSet` differ: WasmGC handles null
   constants and preserves `initializesBinding` metadata.
7. `src/wasm/physical/module-reservations.ts` already owns resource
   reservation/filling/sealing. Reuse it instead of creating another allocator.
8. Current boundary, IR-layering, import-cycle, file/function-size and
   flat-directory checks already exist. Older roadmap statements that these
   checks are absent need updating.

No compiler tests were run for this review. Counts and source inspection do
not establish runtime parity, safe deletion, performance improvement, or
complete IR coverage.

## Required architecture

- `compiler/`: orchestration, resolved options, diagnostics and public artifacts.
- `frontend/`: parser/checker adaptation, source analysis and typed preparation.
- `ir/core`, `ir/analysis`, `ir/passes`, `ir/program`: semantic data,
  analyses, transformations and whole-program preparation.
- `backend/wasmgc/` and other approved backend owners: target representation,
  legalization, lowering and materialization.
- `wasm/model`, `wasm/physical`, `emit/`: physical records, resource
  identity/layout and serialization.
- `runtime/`: generated runtime implementations and explicit capability
  contracts; host adapters remain separate from semantic compiler decisions.

Use small responsibility-specific contracts and one-way compatibility adapters.
Do not replace `CodegenContext` with an equally broad interface under a new
name, hide the same dependency behind callbacks, or create a generic utils
directory that becomes a new shared dependency hub.

## Implementation plan

### S1 — Establish a fresh, attributable reduction baseline

Record the implementation base SHA, source population, physical and nonblank
source LOC, largest affected functions/files, duplicated implementations and
relevant dependency edges. Include all new helpers, wrappers and adapters in
before/after measurements. Report production code, tests and documentation
separately; file moves alone are not LOC reduction.

### S2 — Remove a bounded duplicate implementation

First verified candidate: share stateless core Wasm emission between the
existing emitters through a small core implementation. Preserve public emitter
interfaces and representation-specific methods. Exclude differing null and
global-initialization behavior unless separately specified and tested.

Further candidates to revalidate before dispatch:

- The repeated native-projection policy guards in `program-preparation.ts`:
  a local named validator may reduce repetition while preserving validation
  order, exact errors and failure classification.
- The fixed-point hygiene loops in `program-middleend.ts` and
  `program-middleend-ir.ts`: share the algorithm only if legacy environment
  reads/accounting and the typed route's explicit modes/counters stay intact.

Do not blindly consolidate `internLinearFuncType` with physical
`internFunctionType`: their type-equivalence policies differ, including
semantic brands. Similar syntax does not establish identical behavior.

Accept a sharing abstraction only when it removes a duplicate and improves
clarity after counting the replacement implementation and wrappers.

### S3 — Separate typed preparation from compiler orchestration

Keep source capture in frontend ownership, configuration/observation in
compiler ownership and semantic preparation/passes in IR ownership. Resolve
controls explicitly at the boundary. Preserve observation ordering,
diagnostics, counters and authenticated attachment identity.

Exercise the clean program driver against the operational baseline. A passing
subset does not authorize a public default change.

### S4 — Split program consumption by responsibility

Keep acceptance-token authentication and one-use emission authority in the
coordinator. Extract concrete backend preparation, resource reconciliation
and physical materialization into their owning modules with narrow inputs.
Reuse existing backend interfaces and physical reservations.

Do not scatter lifecycle checks or replace one state bag with several aliases
to the same unrestricted object.

### S5 — Prepare one language family once and consume its plan

Select a bounded language family with its current owner. Consolidate admission
and source analysis into an explicit typed preparation result, consumed by IR
construction, so selection and construction cannot drift independently.

Split source lowering by responsibility and language family. Keep physical
representation choices below semantic IR. Adapt legacy callers to a shared
implementation only where comparison-baseline independence and existing
behavior are preserved.

### S6 — Remove dependencies and reconcile the existing roadmap

Use the existing dependency cut list; move helpers to their actual owner only
after checking their full dependency closure. Reduce forbidden edges, not just
rename them. Refresh the old architecture/bloat roadmaps with measured
checkpoints and current gate names.

Sequence shared emission → program-consumer decomposition → one prepared
frontend family, subject to current claims and prerequisites. Further slices
must be independently reviewable and must name the old implementation or
dependency they remove.

## Validation and acceptance criteria

- [ ] S1–S6 are implemented and validated, or any deferred slice is explicitly
      approved and linked to a separately tracked issue. Filing this plan
      alone does not complete the task.
- [ ] Slices are reconciled with current main and active IR-session claims.
- [ ] At least one bounded slice removes an actual duplicated implementation
      and achieves measured net nonblank production-source LOC reduction,
      including all new helpers/wrappers.
- [ ] Decomposition reduces the largest affected function/file and gives each
      new module a clear responsibility, narrow inputs and explicit owner.
- [ ] Structural moves, net deletion and temporary migration scaffolding are
      reported separately; diagnostics and validation are not removed to meet
      a size target.
- [ ] Clean dependency closures remain closed; relevant compiler-boundary,
      IR-layering, import-cycle, flat-directory and file/function gates pass
      without exemptions or weakened baselines.
- [ ] Shared-state changes enumerate readers, writers, initialization,
      snapshot/restore, invalidation and ordering responsibilities.
- [ ] Existing emitter/backend-contract, prepared-program replay, driver and
      changed-feature tests cover the affected slice. Mechanical emission
      changes preserve emitted bytes and metadata.
- [ ] Behavioral comparisons name both commits, target/backend, harness,
      population and pass/fail counts. Execution checks supplement compilation
      and route evidence; empty populations are not success.
- [ ] The existing compiler remains operational until the full migration's
      tested behavior-equality and retirement requirements are met.

The reviewed cutover corpus contains five single-source standalone compile
cases; `scripts/run-standalone-ir-cutover-corpus.mjs:131` records compilation
and routing evidence without executing results. Expand execution coverage for
migrated features and relevant public routes rather than treating that corpus
alone as cutover proof.

## Sequencing and coordination

Follow the latest user-approved migration scope and existing ownership.
The reviewed #3518 record prioritizes standalone WasmGC and retaining the old
compiler until complete parity. Later authorized native Linear work is already
active in Session B: this issue does not cancel it or transfer its scope.
Existing JS-host compatibility is preserved; this review does not authorize
new JS-host IR implementation.

Session A retains shared integration and protected delivery according to the
current coordination record. Session B and other IR sessions should apply
these reduction/ownership criteria within their approved disjoint work and
raise concrete overlap before editing shared files.

Filing this issue and notifying the sessions are documentation/coordination
actions. All implementation and acceptance checkboxes remain open.
