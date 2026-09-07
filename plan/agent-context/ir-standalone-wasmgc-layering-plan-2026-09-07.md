# Authoritative continuation: standalone WasmGC and physical folder separation

Issue #3518: **IR-only default and direct front-end retirement**; async work
also belongs to issue #3527, **IR-only R7: AST-free async suspension plans
and canonical Promise ABI**. This continuation supersedes implementation
priority in the recovery/post-CPB documents. Their generic contracts,
evidence and unfinished work remain preserved.

## User direction and present hold

The coordinator relayed this exact user instruction from side conversation
`01a07d73-82a4-79f1-8ba4-78db119d5fe1`:

> inform the parent session that we want this clean separation of concerns reflected in the foldrer structure and ask it to change the plan to reflect this.also it should prioritize the wasm gc implementation in standalone mode only for now and not work on linear memory or js host mode backends yet

This task could not directly read that ephemeral side conversation; provenance
is the coordinator's explicit relay. Implement standalone WasmGC only. Defer
new JS-host and linear backend implementation, host-first integration and new
acceptance work for those backends. Preserve existing host/linear behavior
and code; do not delete or change their defaults as a side effect. The
eventual full migration remains open.

P and C are paused per the coordinator, who retains publication and dispatch.
This is a documentation checkpoint, not permission for file moves or worker
resumption. No source edits or heavy tests were performed for this revision.
Reconcile ownership and approve the exact first move set before resuming.

## Read-only source and ownership census

Architecture was inspected in the combined validation tree at base
`6037ac8bcf07be4f71839cea33cf8c90ecc87f94`. Its composed P/B/C files are not
a landed commit or successful standalone test result. Targeted checkout reads:

- P: `/private/tmp/js2-3527-p-async-resources-20260907`, base `6037ac8bcf`.
  Dirty producer/source/ABI/validation/codec/schema files; new resource and
  callable-contract files; producer, canonical-call and codec fixtures.
  Preserve this generic ABI work. The coordinator reports P saved hashes for
  twelve files and a handoff. Do not relocate underneath its pending edits.
- C: `/Users/thomas/.codex/worktrees/e042/js2`, base `9feb7bf8fc`.
  Dirty consumer/physical planner, async planner/materializer and focused
  test. Preserve generic authority/reservation work and the host draft;
  do not finish new host support in this phase.
- B: `/private/tmp/js2-3527-b-forward-20260907`,
  `0b513df989e713eb2eb2b340824e3bd9694291c9`, clean in inspected src/tests/plan.
  Preserve engine/types/adapter/tests and the coordinator's PR hold.
- N: `/Users/thomas/.codex/worktrees/642d/js2`,
  `f735ed9720c0b1dd22d717655ebd441f53613899`, clean in those inspected paths.
  Queue PR 5727 is an existing checkpoint; live queue/merge status remains
  the coordinator's responsibility. Do not redispatch the completed work.
- D: `/Users/thomas/Code/js2/.codex-worktrees/codex-3518-forward-d-20260907`,
  `6753f6d3c3d6ad2590151beb11e58cdeb514846a`, clean in inspected paths.
  Retain its corpus and held checkpoint for rebasing and later evidence.
- Docs: `/private/tmp/js2-ir-recovery-docs-20260907`,
  `2a626eddfa793184f24f8ce139c7b3fbd7de9684` over `21d599eeaf`; the allocator
  clarification and this revision are subsequent documentation.

These scoped working-tree reads are not an exhaustive current claim ledger.
The saved claim snapshot remains historical. Before any move the coordinator
must reread the ledger and affected writers, record old/new paths, exact SHA
and dirty hashes, reconcile held source/runtime claims, and serialize import
rewrites. No claim is released here, no dirty work discarded, and no stale or
apparently prunable worktree removed.

Concrete boundary defects in the inspected source:

- `ir/identity.ts` imports ts-api and AST helpers while defining the brands
  used by nodes and identity-values. Type-only imports retain the coupling.
- `ir/program.ts` imports `LinearOptions` from the legacy linear index and
  module-init types from a source-building module. Prepared contracts need
  their own pure definitions, independent of those implementation modules.
- `ir/program-consumer.ts` imports CodegenContext, codegen registries and
  physical async code while owning backend acceptance/emission. Relocation
  alone would retain the wrong allocator/context boundary.
- `ir/lower.ts` selects a WasmGC emitter; from-ast, program-source and parts
  of identity consume AST. The coordinator additionally confirmed frontend
  dependencies in program-callable-selection/bindings and startup-proof.
- `codegen/async-scheduler.ts` mixes pure bodies, registration, object/closure
  dependencies and services. Moving it whole would preserve the defect.
- Existing `src/runtime/` largely contains JS-host interop. It is not a
  source-free native runtime simply because it is called runtime.
- The public compiler/output modules still import legacy generators. An
  actual standalone entrypoint must not eagerly load that dependency tree.
- `check-ir-layering.mjs` is a line-based count ratchet, excludes linear edges
  from enforcement and can seed a missing baseline. It is debt information,
  not proof of the required clean directory graph.

## Destination folders

```text
src/
  shared/contracts/             pure identities, source locations, diagnostics
  wasm/
    model/                     Wasm data, value kinds and handle definitions
    physical/                  module-owned reservations and index-space APIs
    emit/                      final layout, binary and WAT encoding
  frontend/ts/
    checker/                   parsing/checker/oracle adapters
    inventory/                 source identities, imports and module init
    lowering/                  AST-to-IR and exact source evidence
    prepare-source-program.ts  complete source graph -> typed IR input
  ir/
    core/                      nodes, builder, semantic types and plan data
    analysis/                  effects, liveness, allocation and verification
    passes/                    transformations over typed IR only
    runtime/                   semantic demands and provider-plan selection
    program/                   prepared data, ABI, codec and pure validation
  backend/wasmgc/
    program/                   standalone acceptance/emission transaction
    lowering/                  IR operations -> WasmGC instructions
    resources/                 IR requirements -> complete physical bindings
    async/                     IR async-state adapter to shared frame engine
  runtime/
    contracts/                 provider/capability/value contracts
    wasmgc/
      values/                  native values, boxing, strings, object substrate
      promise/                 queue, settlement, adoption and reaction bodies
      async/                   detached frame engine and resource types
    platform/standalone/       explicit WASI/service binding and startup policy
  compiler/                    public options, pipeline and artifact metadata
  legacy/
    direct/wasmgc/             AST/context-driven direct generator
    direct/linear/             deferred existing linear backend
    ir-bridge/                 old selection/integration/context adapters
    host/                      deferred JS-host semantics and adapters
```

These are real destinations, not aliases pointing back into old directories.
Split mixed modules before moving components. Classify existing runtime files
individually; move JS-host adapters to their preserved legacy/host boundary,
not into generated native runtime support.

Wasm model is a data foundation. The present IR already uses Wasm scalar value
kinds; importing those pure definitions is allowed, without claiming that a
rename makes the entire IR representation target-independent. Extract pure
identity/source types from AST-bearing files. Split semantic async attachment
data from provider-selection implementation so core nodes do not import upward
into IR runtime or backend implementation.

## Enforced dependency direction

Rules include runtime and type-only imports, re-exports, side-effect imports,
dynamic imports, require/import-equals, path aliases and transitive closure.
Clean zones have zero forbidden edges; no per-file count allowance applies.

- Shared contracts and Wasm model import only data foundations, never frontend,
  compiler, backend, physical allocators or runtime implementations.
- IR core imports foundations and its own data contracts. Analysis imports
  core; passes import core/analysis. IR runtime/program can import pure IR
  layers and runtime contracts, never frontend, backend, allocator, compiler
  or legacy code.
- Frontend imports the TypeScript/checker dependencies and pure IR layers.
  It does not need CodegenContext, a module allocator, legacy selector or
  direct generator to produce complete typed IR.
- Native runtime materializers import contracts and Wasm model/physical APIs.
  They consume declared resources and do not inspect source IR bodies or
  register via legacy context. IR-to-resource adaptation belongs in backend.
- WasmGC backend imports pure IR, Wasm physical/model and native providers,
  never frontend/checker/compiler/legacy. Its token and allocator authority
  remain private to the emission transaction.
- Compiler orchestrates frontend -> pure preparation -> backend -> output.
  Encoding performs no semantic discovery. Platform services provide explicit
  capabilities; they are not JS-host Promise/object semantics in disguise.
- Legacy may depend on pure facilities through compatibility adapters. New
  clean zones may not depend on those adapters, even for types. Standalone
  public dispatch must not eagerly load legacy host/linear code; deferred
  dispatch stays outside that route's import closure.

Implement `scripts/check-compiler-boundaries.mjs`, a checked-in layer/move
manifest and `tests/issue-3518-compiler-boundaries.test.ts`. Parse syntax and
use actual repository module resolution, including barrels/aliases/symlinks.
Unresolved/nonliteral dynamic loading from a clean zone is failure/unknown,
never an empty edge set. Output required roots, scanned/resolved counts and
source revision/hash. Missing policy fails rather than seeding a new baseline.
Controls must detect direct, type-only, aliased, re-exported and dynamic back
edges. Fresh-process backend replay also detects runtime frontend/legacy loads.

Classify unmigrated modules explicitly as legacy debt. That does not authorize
clean-zone exceptions or completion while the mixed folders remain. The old
ratchet may continue reporting debt but cannot substitute for these boundaries.

### Preserve existing gate coverage during moves

The coordinator read B's CI run `34157974631`, job `101853643938`: its actual
dead-export failure is **10** new functions, including adapter
`emitPreparedIrAsyncFrame` and `sameType` plus eight engine functions. This
supersedes the older eight-function report. This task did not rerun that job.

Before or atomically with moving those files out of codegen, extend the
dead-export and applicable reachability/source-free gates to the destination
paths. Carry the old-to-new symbol/path mapping and unresolved findings into
the new report. The count must not drop because a glob stopped scanning them.
Production integration must be proved by real caller reachability/execution;
dummy consumers, test-only references, export removal to evade the check and
baseline forgiveness do not satisfy it. The same rule applies to moved body
receipt, oracle, fallback and corpus instrumentation. Renames cannot erase
known failure evidence. B's hold remains under the coordinator's control.

## Migration sequence and ownership

### 0. Preserve and reconcile

Coordinator snapshots P/C edits, B/N commits, D evidence and current claims,
then establishes one integration base. High reviews the exact first file and
import move map. One integration owner serializes rewrites/conflicts; workers
never relocate each other's active files. Preserve host/linear work untouched
except separately reconciled mechanical import/path compatibility changes.

### 1. Foundations and real source-to-IR separation

After explicit dispatch, P retains the generic canonical-call ABI repair and
owns its current program/ABI/codec surfaces plus the approved frontend source
producer and pure contract extraction. Split `prepareWholeIrProgram` into
frontend source preparation and pure typed-IR preparation before placing the
latter in `ir/program`. Its pure API cannot accept checker/AST inputs.

Move AST inventory/lowering to frontend, and their pure output contracts to
shared/IR. Remove type-only back edges in the same connected change. Preserve
unit IDs, body population, source locations and canonical async results. Prove
real source -> prepared IR -> codec -> fresh-process validation independent
of backend availability. Do not expand host resource production in this phase.

### 2. Real standalone backend and physical reservation boundary

C, after dispatch, owns splitting its planner/consumer into
backend/wasmgc/program and lowerer/emitter into backend/wasmgc/lowering.
It owns integration with the typed reservation view under wasm/physical.
Extract minimal pure module/type/import/global/tag/function registration APIs
from the current registries. They accept Wasm data and module-owned authority,
not CodegenContext or callbacks that allocate through it. Keep legacy adapters
outside the clean zone. Never rename CodegenContext into a facade that still
imports the old type or runtime registry.

B owns engine/types into runtime/wasmgc/async and its IR adapter into
backend/wasmgc/async after its checkpoint is reconciled. Engine types use pure
identities and Wasm data; only the backend adapter sees IR state operations.
C remains the transaction merge point. Extend gates before these moves.

Connect a real standalone scalar program through these roots with exact
acceptance/emission/body receipts, startup and output. Native resource gaps
remain located unsupported until step 3 closes them. Do not resume the host
materializer to manufacture early acceptance.

### 3. Native semantic and physical provider closure

N owns queue and next settlement/reaction components under runtime/wasmgc/promise,
using its existing connected extraction and the post-CPB forward-token protocol.
The old scheduler adapter calls downward into the pure leaf. N publishes each
next transitive move/extraction list before touching tracking, resolve/adoption,
closure/object dispatch and native value support.

Close Promise/reaction/capture types, queue globals, fulfill/reject/resolve,
thenable jobs, exception/error construction, canonical undefined, boxing and
demanded unhandled-rejection/startup services. Finalizer-filled helpers need
actual body receipts; placeholders or a null substrate are not closure.
P declares the selected resources in the authoritative ABI/resource plan;
C verifies/reserves/materializes them before sealing; B emits only from those
bindings. Share the actual provider with legacy callers, not a duplicate
wrapper that retains an old dependency edge.

### 4. Standalone public metadata and dispatch

Coordinator assigns A-public the compiler pipeline/result/metadata scope and
later exact compiler.ts, compiler/output.ts and public wrapper dispatch sites.
Start metadata after pure source/standalone backend contracts stabilize; it
need not wait for unrelated native feature families. Preserve aliases/live
globals/source maps, native Promise metadata, initialization, diagnostics and
requested output policy. Remove eager legacy imports from the actual route.

Host/linear dispatch remains behind its preserved compatibility boundary;
their new backends stay deferred. A scalar-only/test-only wrapper is not
public cutover. Unsupported standalone programs return a located refusal
without an artifact; invariants never trigger a legacy retry.

### 5. Folder completion and standalone retirement evidence

After pure provider extraction, the integration owner moves remaining direct
generator code to legacy/direct/wasmgc and old selection/integration adapters
to legacy/ir-bridge. Quarantine is not proof standalone stopped calling it.
Preserved host/linear mechanical moves require their own ownership reconciliation
and do not reopen implementation. Final folder acceptance requires the actual
destination structure and explicit remaining debt, not clean-looking aliases.

D owns the boundary checker/tests and standalone evidence; coordinator owns
shared scripts/package/CI integration and approves its exact edits. D preserves
the full corpus manifest, labeling standalone WasmGC rows active and host/linear
rows explicitly deferred. No failing standalone source may be removed or
reclassified to reduce the active denominator.

## Standalone acceptance and completion

Each connected join runs focused behavior/boundary tests. Coordinator schedules
sustained runs afterward; no immediate heavy run is requested by this document.

- Actual public compile/compileFiles, exports/reexports, globals, startup,
  bytes/WAT and applicable object/link output must use the new route. Compare
  behavior with the same source on the prior baseline and independent JS
  oracle where applicable. Record revisions, policy, runtime and denominators.
- Native async cases cover callable/fulfillment ABI separation, imported await,
  no-await/void Promise results, multiple suspensions, rejection, recursive
  adoption, throwing then getters, exactly-once settlement, queue growth/FIFO,
  captures and undefined versus null. No JS-host Promise imports implement them.
- Execute demanded native strings/arrays/objects/closures/classes/exceptions
  and initialization. Compilation alone is not a pass; missing families stay
  in the original standalone population.
- Verify actual import objects and selected providers against standalone
  capability policy. Explicit WASI/environment services are allowed when
  requested; JS-host semantic helpers are not relabeled as I/O. Zero imports
  without successful execution is not standalone evidence.
- Codec-round-trip a real prepared program and reconstruct/emit it in a fresh
  process forbidding frontend/legacy loading, then execute it. Prove that the
  instrument catches a known forbidden load. The source compiler naturally
  loads frontend; backend replay does not. Require real body/provider counts
  and zero unknown census rows.
- Tamper controls reject donor bindings, wrong signatures, stale layouts,
  missing/placeholder bodies, foreign/reused tokens and changed manifests
  before artifact publication. Forward reservations must install real targets.
- Physical folder and transitive dependency gates must pass. A renamed file
  retaining a legacy/checker/AST edge fails. Known dead-export evidence and
  other gate populations survive moves; the old ratchet alone is insufficient.

This phase completes when the active standalone WasmGC corpus executes through
the separated architecture without legacy fallback, folder/dependency gates
pass, and public output contracts are preserved. Host/linear and the eventual
full migration remain explicitly deferred; do not close the overall issue
from this phase alone.
