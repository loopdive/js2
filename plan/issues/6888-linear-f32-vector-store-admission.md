---
id: 6888
title: "LinearEmitter f32 vector-store completion: semantic admission prerequisite"
status: blocked
created: 2026-10-07
updated: 2026-10-07
sprint: Backlog
priority: medium
horizon: s
feasibility: medium
task_type: feature
area: ir, codegen-linear
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [2954, 2956, 1852]
origin: "Session B read-only discovery and emitter-only planning release on e7760d1c2a"
---

# LinearEmitter f32 vector stores

## Decision and evidence boundary

The narrow candidate is completing `LinearEmitter.emitElemSet` for an existing
`f32` vector layout. It is an emitter capability gap, **not a demonstrated
source-program miscompile**. Do not dispatch this as an independently reachable
semantic IR fix on the current base: shared legality and the production Linear
resolver admit only `f64` vectors. Both are outside Session B's released scope.

Planning base: `e7760d1c2a`, worktree
`/private/tmp/js2-6888-linear-spec-20261007`, branch
`codex/6888-linear-spec-20261007`. Source and existing tests were inspected;
no tests, benchmarks, compiler probes, commits, or claim operations were run.
Repro outcomes below are source-derived expectations requiring later execution.
Planning ownership was supplied by the parent as
`6888:linear-plan-20261007`, owner
`ttraenkler/codex-linear-b-astra-plan-20261007`; this document creates no claim.

Session A owns shared integration, compiler entrypoints, active source-map
files, and coordination. Its reserved issue is 6889. This issue neither edits
nor replaces the parent's coordination record.

## Existing issue overlap check

On the planning base, no existing `6888-*.md` existed. Searches across
`plan/issues` for `emitElemSet` with `f32`, `f32` vector stores, and float32
stores found no matching narrow issue. Related records were read:

- #2954, "LinearEmitter core-op coverage (const/binary/locals/control-flow/call)
  + cross-backend corpus dynamic rows", is done and concerns core operations.
- #2956, "Linear backend consumes the IR front-end: wire the selector +
  LinearEmitter into generateLinearModule", is done; its admitted vector
  implementation is the existing fixed-f64 path.
- #1852, "Make dynamic-value representation explicitly per-backend (typed refs
  / i31ref on WasmGC; f64-value + i32-tag on linear)", concerns dynamic carriers.
- #25, "Issue 25: Fix f32.const opcode in binary emitter", is done and concerns
  scalar constant encoding, not vector stores.
- #5135, "IR: own exact ambient Math.fround calls", concerns
  f64-to-f32-to-f64 rounding and explicitly does
  not introduce public f32 source/IR signatures.

This is a local issue-content check, not a fresh assertion of canonical claim
availability. Parent retains claim/handoff authority. Excluded peer areas:
6865 linear-finalizer, linear-public-emission-telemetry,
linear-source-map-batch/numeric-module-binding, 6793, and 6815.

## Implementation Plan

### Root cause and exact existing contracts

The shared memory planner can describe more storage types than the currently
admitted Linear semantic IR surface. The emitter's read and write capabilities
also differ:

- `src/ir/analysis/contracts/linear-memory-layout.ts:8` defines `f32` and `i64`
  storage. `planLinearVectorLayout` in
  `src/ir/analysis/linear-memory-plan.ts:812` produces stride 4 for f32 and
  stride 8 for i64, with the existing header, length, capacity and data offsets.
  `planLinearRecordLayout:780` reserves eight-byte field slots, with storage
  alignment 4 for f32 and 8 for i64. Layout describability is not admission.
- `src/ir/backend/emitter.ts:125`, `BackendEmitter.emitElemSet`, already takes
  an element-typed scratch local. `ensureVecElementScratch` in
  `src/ir/lower-generic.ts:857` allocates it by exact element type; `vec.set`
  lowering at 2368 uses this contract.
- `src/ir/backend/linear-emitter.ts:87`, `linearLoadOp`, handles f32/f64 but
  defaults every other type to `i32.load`. An i64 handle therefore emits the
  wrong result type and an excessive alignment immediate (3 for i32.load).
  This latent API defect is not evidence of an admitted i64 vector program.
- `emitElemGet:266` already emits `f32.load` for a planned f32 vector.
  `emitElemSet:281` rejects every element type except f64/i32 before emitting
  any store, so an otherwise consistent f32 handle cannot round-trip a value.
- `linearStoreOp:101` and `emitLinearFieldGet:113` accept only i32/f64 fields.
  Object/ref-cell emitters use these helpers. They fail loudly, and current
  admission agrees with their limited surface.

### Reachability blocker: shared contracts before target implementation

The production blockers are concrete, and must not be bypassed in a test or
silently widened under this issue:

1. `src/ir/analysis/backend-legality.ts:393`, `backendTypeError`, permits only
   f64 elements for Linear `vec` types. `linearAggregateTypeError:440` permits
   only i32/f64 scalar fields; boxed/ref-cell types have a matching restriction.
   Ordinary scalar f32/i64 arithmetic admission does not admit their vectors.
2. `src/ir/backend/linear-integration.ts:2167`, `resolveVecForElement`, and
   `resolveVecValueTypeForElement:2170` bind only f64 vectors.
   `linearFieldType:1897` maps f64 and i32/pointer storage only;
   `resolveObject:2084` rejects other field storage, and `resolveRefCell:2136`
   rejects f32/i64 before creating a handle.
3. The common instruction/binary encoder has `f32.load` and `f32.store`
   (`src/emit/binary.ts:1814`, 1819; `src/emit/wat.ts:535`, 536), but lacks
   `i64.load`. An i64 extension is consequently not this f32 leaf change.

Session A/parent must either deliver an admitted semantic path with its exact
contract and ownership, or explicitly choose an emitter-only prerequisite
with that limited acceptance. Until then, this issue stays blocked. No shared
admission change or synthetic resolver is accepted as proof of production
reachability. Do not widen frontend/preparation, use raw-Wasm escape hatches,
or implement an i64 workaround to manufacture a claim.

### Finite disjoint implementation slices, after prerequisite resolution

S1 — target implementation, one existing source file:

- Own only `src/ir/backend/linear-emitter.ts`, specifically `emitElemSet:281`.
- Extend its explicit supported-type/store-op choice to f32 -> `f32.store`.
  Keep i32 -> `i32.store`, f64 -> `f64.store`, and other types rejected.
- Retain planned element stride and the existing element-typed scratch index;
  use alignment immediate 2 for the canonical four-byte f32 element.
- Keep address formation and stack order common to all supported types;
  do not clone the method or add backend orchestration. A small private opcode
  selector in this file is sufficient if it improves clarity.
- Do not change field/ref-cell helpers, `linearLoadOp`, allocation, vector
  growth, null/ref conversion, source maps, or runtime/provider registration.

The target sequence for a canonical f32 handle is:

```wasm
;; Input stack: dataBase:i32, index:i32, value:f32
local.set $elementScratch   ;; existing f32 scratch supplied by generic lowerer
i32.const 4                ;; layout.elementStride
i32.mul
i32.add
local.get $elementScratch
f32.store offset=0 align=4  ;; text alignment 4 bytes; Instr.align = 2
```

S2 — validation, one new test file:

- Own only `tests/issue-6888-linear-f32-vector-store.test.ts`.
- Reuse `planLinearVectorLayout`, `defaultOperationsForLayout`, existing IR
  builders, identity helpers and binary emission. Keep local fixture setup
  in the new file; do not edit shared test helpers or existing suites.
- S1 and S2 have disjoint write sets. S2's successful candidate execution
  depends on S1 and, for the semantic acceptance below, the A-owned admission
  prerequisite. There are no further implementation slices in this issue.

Generic IR and existing layout/scratch contracts precede the target-specific
store selection. Existing grouping under `src/ir/backend` is sufficient;
no umbrella module, registry, duplicate allocator or new optimization pass
is warranted. Inlining and DCE remain in their dedicated shared pass modules.

### Repro and meaningful baseline/candidate proof

Emitter boundary repro on e776: construct the f32 handle using the canonical
planner, then call `emitElemSet(handle, f32ScratchIndex, sink)`. The current
guard predicts `LinearEmitter: unsupported vec.set element type 'f32'`.
Calling `emitElemGet` with the same handle predicts f32.load. Record this as
API-level evidence only; an executing hand-built module is still not an
admitted semantic IR regression.

For acceptance after admission, use the actual delivered source/prepared-IR
route and assert the exact tested owner was compiled through Linear IR, with
no fallback. Require a vector write followed by a read from the same index,
with runtime input values and indexes to prevent constant folding. Validate,
instantiate, execute, and read back memory as well as the returned value.
Do not invent a TypeScript Float32Array frontend path absent from that release.

Required cases:

- Indexes 0, 1 and the last in-bounds slot; guard bytes before/after the
  allocation and neighboring elements remain unchanged.
- Exactly representable fractions, a rounding-boundary input, +0/-0 (check
  Object.is), smallest f32 subnormal, both infinities and NaN. Do not require
  an arbitrary NaN payload after a JavaScript numeric boundary.
- Nonzero function parameter count and existing locals exercise the supplied
  scratch index; repeated stores do not alias different element-type scratch.
- Existing i32/f64 stores still execute correctly; unsupported kinds still
  reject. Out-of-bounds/growth semantics are outside this store primitive.

Use two explicitly identified baselines: e776 records the present admission
refusal; the delivered A-prerequisite parent becomes the meaningful emitter
baseline. Run the same new regression on that parent (must reach the f32 store
and fail), then on S1+S2 (must execute correctly). Report exact commits, lane,
fixture names, counts and failure text. A failure only at the old legality
gate does not establish the emitter fix. The focused existing control suite
is `tests/ir-vec-two-backend.test.ts`; run additional checks only as required
by the delivered change. No test success or performance gain is claimed here.

## Completion criteria

- [ ] Parent resolves the reachability/ownership prerequisite explicitly.
- [ ] Source/test changes stay within S1/S2; no shared metadata or wiring edits.
- [ ] Baseline fails at the intended emitter boundary after lawful admission.
- [ ] Candidate executes the admitted semantic IR path and memory checks.
- [ ] Existing i32/f64 controls pass; evidence states exact tested revisions.

Until these are met, do not label this a shipped Linear scalar-memory fix or
claim support for i64 vectors, scalar object fields, or new source types.
