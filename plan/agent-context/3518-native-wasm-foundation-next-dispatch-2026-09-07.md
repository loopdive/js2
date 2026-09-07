# Next bounded extraction: Wasm instruction model and native queue leaf

Issue #3518, **IR-only default and direct front-end retirement**; queue work
also supports #3527, **IR-only R7: AST-free async suspension plans and canonical
Promise ABI**. Standalone WasmGC remains the only implementation priority.
This is a proposed exact map for coordinator approval/claim reconciliation,
not a writer assignment. F0's nine files and the approved thirteen D0 metadata
overrides are unchanged; preserve original P/C/B/N work and claims.

## Source grounding and bounded outcome

Read locally in `/private/tmp/js2-3518-ir-foundation-checkpoint-20260907` at
`95186a4835a1fe7a024172a61be94781c7995670`; the coordinator's D0 commit advanced
that checkout to `57aa0d73025526812d06a3863d63552929618288` during review.
The six existing implementation/test paths below and the reachability auditor
have no diff between those commits and were clean in the inspected checkout.
Queue merge `396e690a85a9103d3f3d125b0f478c4cc99bf0c8` is an ancestor of the
inspected source. The independent cloud audit reports public main
`9b0358ec7d373034de6ff524eae286a50aaf2a4e`; that is separately attributed
evidence, not the local source SHA. Before dispatch, the coordinator records
the accepted D0/F0 integration base and rechecks these paths/claims there.

The connected result is a real native queue-body module importing only the
Wasm instruction model, plus a physical function-handle primitive imported
downward by function-space and emit. It changes no allocator or queue behavior.
The queue records remain unauthenticated numeric resource snapshots: this
slice establishes folder/dependency separation, not physical provider closure.

## N1 implementation owner: exactly ten files

Proposed owner: the existing native queue owner, resumed only by the coordinator
in a clean isolated checkout after source/runtime/emit claim reconciliation.

1. New `src/wasm/model/instructions.ts`: move exactly FuncHandle, GlobalHandle,
   TypeHandle, ValType, LocalDef, SourcePos, Instr, BlockType, CatchClause and
   TryTableCatch, plus their private InstrBase union, from ir/types.ts.
   This closed declaration set has no imports. Preserve all instruction arms,
   source positions, optional value-brand hints and numeric handle aliases.
2. `src/ir/types.ts`: explicitly type-import/re-export those canonical names;
   retain every other declaration and createEmptyModule implementation.
   In particular retain WasmModule, compiler metadata, FieldDef/type definitions,
   WasmFunction and import/export/global records. Do not duplicate the extracted
   declarations or add a new all-layer barrel.
3. New `src/wasm/physical/function-handles.ts`: move only STABLE_FUNC_BASE and
   inLiveShiftRange, unchanged. No imports, authority objects or allocation.
4. `src/emit/resolve-layout.ts`: explicitly import/re-export those two names.
   Keep absoluteFuncIndex, absoluteFuncIndexCached, ModuleLayout and resolveLayout
   here unchanged. The absolute-index helpers currently read WasmModule and
   strictDroppedHostImports diagnostics; moving them wholesale would carry
   compiler policy into the physical foundation.
5. `src/codegen/func-space.ts`: redirect only STABLE_FUNC_BASE to the new
   physical module. Keep mint/push, lookup, tracing and context behavior intact.
6. New `src/runtime/wasmgc/async/microtask-queue-bodies.ts`: move the existing
   queue leaf verbatim except its type import now targets wasm/model/instructions.
   Preserve PreparedNativeQueueHandle, PreparedNativeMicrotaskReservations and
   all five builders: buildGrowLocals, buildGrowBody, buildEnqueueBody,
   buildDrainLocals, buildDrainBody.
7. `src/codegen/prepared-native-async-runtime.ts`: explicit one-way compatibility
   re-exports of those two types and five function objects; no implementation.
8. `src/codegen/async-scheduler.ts`: redirect only the existing queue-builder
   import to the new native leaf. No registration/body/constant changes.
9. `tests/issue-3527-prepared-native-resource-closure.test.ts`: retain the four
   existing execution cases and original producer route; strengthen the fresh
   process case to load the new leaf and assert old/new compatibility exports
   in a separate process without weakening the clean-import barrier.
10. New `tests/issue-3518-native-wasm-foundation.test.ts`: model type compatibility,
    handle constant/predicate compatibility and new-path boundary controls.

This deliberately narrows the cloud's proposed full model/resolver move.
The instruction model retains existing JS value hints as inert data; no claim
is made that the entire compiler model is now target-independent or clean.
New semantic separation of those hints is outside this behavior-preserving slice.

## Gate/integration owner: exactly three additional files

The coordinator owns these, or explicitly resumes the existing D0/gate owner
after its current delivery. N1 does not edit them:

1. `scripts/compiler-boundaries.json`: classify the three new modules and old
   adapters, preserve all existing evidence/activation history and thirteen
   approved overrides. Record the real new entry modules and nonzero counts
   for model, physical primitives and native runtime; larger allocator/value
   boundaries remain outstanding debt. Do not claim full separation.
2. `scripts/audit-legacy-reachability.mjs`: enforce moved-function coverage
   before or atomically with relocation, using the rooted contract below.
3. New `tests/issue-3518-moved-runtime-reachability.test.ts`: relocation and
   missing-consumer controls for that same production checker.

No baseline forgiveness or package/CI rewrite is included. The existing
`check:dead-exports` command already invokes this auditor's `--check`; its
acceptance path must enforce the new coverage. If additional wiring/files
prove necessary, return their exact map to the coordinator before editing.

For moved functions, use actual production entry roots and report concrete
paths, never every function outside codegen as a root. The inspected public
`src/index.ts#compile` -> compiler/codegen route is an available production
entry; resolve its path to the scheduler and all five queue builders. Additional
public roots require explicit records. Neither the native leaf, scheduler
helpers nor compatibility re-exports may be admitted as roots merely to make
them live. Test imports do not count. Preserve separate full-production and
legacy-dispatch-cut results; a live legacy caller does not establish IR-only
survival or standalone backend completion.

Scan old and new paths and map all five original queue symbols by qualified
name to their new canonical names; also cover moved inLiveShiftRange. Keep
the existing old codegen gate coverage. Any older broad-root report retained
for unrelated debt is not evidence for these moves. Root/module/resolution
failure is unknown/failure, not an empty passing report. Require a nonempty
rooted report and all five queue symbols present; preserve B's ten held
unresolved symbols with zero settlement credited by this unrelated move.

Controls must show a renamed unreferenced function stays unreferenced, an old
compatibility export alone cannot establish liveness, a test-only caller does
not count, removing the real production reference fails, and a missing root
or unresolved edge cannot pass. A rooted reference is graph evidence;
production execution below independently demonstrates the route still works.

## Validation and unchanged semantics

Run checks only in the coordinator's serial slot. Required evidence:

- D0 inventory on the composed commit with independent base/activation
  provenance, positive type-only back-edge controls and actual new module
  counts. Default full-separation must still fail on outstanding debt.
- Fresh-process new-leaf import: deny resolved repo paths under codegen,
  frontend/checker/ts-api, compiler, legacy and old ir/types compatibility;
  include a deliberately injected forbidden import as a positive control.
  Runtime loading alone cannot see erased type edges; D0 checks those too.
- Old/new builder object identity, exact returned instructions/locals for
  explicit resource fixtures, old/new type compatibility, and unchanged
  STABLE_FUNC_BASE/predicate behavior at both regime boundaries.
- Existing queue execution cases, lazy registration and standalone production
  drain coverage from issue-1326c; affected standalone cases from
  issue-1916-symbolic-func-refs and issue-2918-promise-then-funcidx-shift;
  typecheck and the rooted dead-export controls. Preserve existing tests for
  other targets; no new host/linear acceptance campaign is introduced.
- Compare before/after registration names, types, globals, function order and
  emitted bytes for identical standalone fixtures using recorded integration
  and candidate revisions. Permanent tests use explicit expectations/fixtures,
  never an unavailable historical git object in shallow CI.

Preserve initial capacity 8192, lazy allocation, doubling, copying [head, tail),
head advancement before callback, throw/resume and reentrant growth semantics.
Preserve registration order and exact mint/push timing, late-function-import
handling, global/type indexing and scheduler idempotence behavior.

Late-global authentication, donor/stale/signature rejection, partial-failure
receipts, a real module allocator, queue materializer and Promise settlement
are later semantic slices, not new requirements to implement here. No numeric
resource record is advertised as module-authenticated, and no existing global
shift limitation is silently fixed or certified by this extraction.

Accept publication only with the model/native/primitive and gate changes
composed and validated. No worker was dispatched, source edited, hook run or
test executed by the architect for this specification.

## Coordinator dispatch update

On 2026-09-07, the coordinator accepted the bounded map above and replaced
separate app work sessions with native subagents. Maxwell (GPT-6 Astra Low,
01a07dc6-8ad5-7e72-a010-f877ea37c701) owns the ten N1 source/test files.
Boyle (GPT-6 Astra Low, 01a07dc6-8bfd-7991-be8d-a7b3e3105aa1) owns only the
reachability auditor and its new regression test. The coordinator owns the
boundary manifest, composition, serial validation and ready PR publication.

Both implementation worktrees start from D0 checkpoint
57aa0d73025526812d06a3863d63552929618288. Maxwell's ten-file draft is complete
but uncommitted and untested; it must not be published as accepted until the
composed gate and execution evidence pass. Neither worker may edit the dirty
root checkout or the preserved producer/consumer drafts.

