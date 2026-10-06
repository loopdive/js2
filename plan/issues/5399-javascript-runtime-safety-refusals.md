---
id: 5399
title: "Refuse concrete unsupported JavaScript runtime operations found by the audit"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-10-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
parent: 5393
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
assignee: "ttraenkler/codex-js-runtime-safety"
---

## Measured defects

The immutable 168-program audit exposes unsupported operations independently of
TypeScript assertions: sparse-array presence, array prototype lookup, host array
coercion, alternate method receivers, derived constructors returning an object
before super, and host Promise.all array materialization. Standalone additionally
loses precision in String(BigInt), serializes private-only class instances as null,
and confuses an absent Map object key with a present undefined value.

Each source and exact before/after observation is in the general JavaScript audit
manifest and artifacts. Diagnostics must identify a concrete unsupported source
operation; absence of a diagnostic is not a claim that arbitrary JavaScript is safe.

## Acceptance criteria

- [x] Repair exact BigInt formatting without a Number round trip.
- [x] Refuse the measured unsupported operations with source locations.
- [x] Preserve supported neighboring operations and shadowed builtin names.
- [x] Rerun the complete four-lane audit and report residual errors honestly.
- [x] Run the full equivalence gate without expanding its baseline.

## Implementation and validation

String(BigInt) now uses the exact native integer formatter. Concrete unsupported
operations receive source-located diagnostics from the shared safety collector.
Thirty focused tests pass, including shadowed declarations, supported coercion
controls, filled-hole membership, and precise BigInt conversion. Unresolved
origins remain unclassified; this is not a general alias or coercion analysis.

Exact baseline/candidate rows and final validation are recorded in the
[general JavaScript audit](../audit/javascript-soundness-2026-09-08/README.md).

## Array-prototype landing dependency: resumed triage (2026-10-06)

PR5748 remains held at9b1106e6e73fe0669a91924271066fd2a982b4e4. The acceptance
checks above describe the historical refusal/audit checkpoint, not completion
of the subsequent array semantic repair. Parent read the complete
[existing semantic implementation plan](../agent-context/5399-array-prototype-semantic-repair-2026-09-15.md)
after Sol-6.1 Medium performed read-only triage. No new runtime execution is
claimed. The four original fixture hashes still match that plan; retain all
fixtures, harnesses, original failures and negative controls.

Current source still expects all four original array-prototype refusals. Earlier
four reported passes do not establish that the prototype was actually installed;
the conservative follow-up recorded four compile errors, and the adversarial
return-origin observation recorded7 expected versus NaN actual. Do not remove
the guard based on those earlier passing observation tests.

Dependency order remains A0 raw own-slot presence, A1 canonical live receiver
and own/Get/Has/prototype operations, A2 receiver-aware mutation, A3 legacy/IR
consumer routing, then parent-only A4 admission. A0 exists, but does not establish
runtime/start-time publication. Unpublished vector binding and managed instance
construction work is prerequisite scaffolding, not semantic readiness; preserve
those occupied paths. The current length-based facade and separate iterable
snapshot do not supply the required live identity or post-truncation Has behavior.

Before coding release, reconcile the binding/main and binding/recovery handoffs,
confirm live runtime.ts ownership, and compose the actual producer/startup base.
Then scope one Sol-6.1 Medium runtime writer to the existing plan's A1/A2 regions,
optional array-property-access module and new semantic tests. Keep the binding,
physical-owner and lifecycle paths outside that writer. Parent owns issue/spec,
shared boundary/publication composition, guard changes, validation and existing-PR
publication. No implementation is released solely by this triage update.

Acceptance still requires the four byte-identical originals, all seven original
adversarial source strings, installed-identity positive controls, exact effects,
and actual emitted IR evidence where claimed. Refusal preservation and helper
tests alone do not complete this task or justify legacy retirement.

### Producer/startup reconciliation findings

Parent inspected the retained binding-main and constructor handoffs. Binding
integration on e473 recorded33/33 binding controls; its owner population recorded
392/394, with the same two historical-layout failures reproduced on unchanged
e473. The38 supplemental owner type errors were also identical on both arms.
Keep those failures and the later historical-fixture repair separate; no final
repaired-owner passing result has been established. The dormant constructor's
27/27 results belong to349eab3, not the present main composition.

At the inspected5f main composition, OptimizeResult contains replacement binary,
optimized, warning and timeout fields, but no producer reservation relocation
mapping. Both async compiler optimization paths check runtime rec-group drift
before accepting replacement bytes; neither thereby proves installer, projection,
completion or initialization role identity. Final managed receipt publication
must therefore include explicit post-optimization owner reconciliation. Names,
valid Wasm and unchanged runtime type fingerprints are insufficient substitutes.
No optimizer bypass, new source exclusion or fabricated managed receipt is
authorized. A Sol-6.1 Medium read-only follow-up is locating the corresponding
root-inclusive pre-compilation allocation-planning interface before coding release.

The follow-up inspected composition2e313209 (which includes5f main). Existing
prepareWholeIrProgram/PreparedIrProgram retains source, IR, startup and allocation
evidence, but AllocSite does not provide allocationRole/layoutBinding/semanticKind/
storageKind. The native-vector physical planner covers bounded storage layouts,
not semantic array ownership. Current carrier keys first arise inside physical
reservation. The unpublished planVectorGraphBindings deterministically consumes
provided rows; it does not discover or authenticate their semantic origin.

Required integration contract, before releasing production edits:

1. Prepare every provider and root once, retaining exact prepared-node ownership,
   symbolic dependency occurrences and startup policy before provider emission.
2. Join semantic allocation identity to representation-owned layout roles. Define
   alias/retirement and shared-role behavior explicitly; do not infer semantic
   kind from storage layout, exported names or TypeScript annotations.
3. Freeze one root-inclusive graph using the existing binding planner and pass
   that same plan/node association into retained-node emission. Resolve ordinary
   dependency namespaces later without changing allocation identity.
4. Authenticate physical reservations, final optimized bytes and startup roles
   before publishing the shared manifest/private receipt or constructing nodes.
5. Bind and complete every node before provider initialization; keep root init
   caller-owned. Cover compile-time signature validation and native/bundled paths,
   not only the ordinary runtime caller.

Current provider compilation happens before root preparation; root deferred-init
selection is not mandatory. Bootstrap init-guard exemptions and the root-inclusive
bind-all driver are absent; static bundling rejects deferred providers. These are
specific producer/startup integration gaps, not reasons to weaken the four original
tests. Parent must settle the actual producer interface against these existing
owners before assigning disjoint implementation slices. No new parallel schema,
decoder-only proof, source-population restriction or activation is authorized.

### Lifecycle prerequisite quality attribution (2026-10-06)

Read-only Sol6.1 Medium audit revalidated PR6195 at head
0f858c60e17bc0718f39e2653a4adb5666143d9e, reported base
2dfade54414ceaa6901f51bb964b794c893fdc31 and BEHIND. Actual quality job
108603166235 in run36313282107 fails check:host-import-policy:
ownedAdapterLines988 exceeds952. The gate's unchanged nine-file inventory
counts952 at predecessor/base and988 at head; only instance-lifecycle-adapter.ts
grows71 to107 lines. This is a demonstrated checkpoint regression, not an
unrelated CI failure. Do not increase the limit or move lines outside accounting
solely to pass it.

Parent inspected the committed adapter and full lifecycle handoff. Enrollment
authenticates a genuine instance and retains exports in a per-adapter WeakMap;
installation separately prepares, publishes and drains. Runtime buildImports
still publishes only legacy setters; the new enrollment methods have no
production callers. The dormant managed constructor also retains raw instance
identity but does not own activation/binding authority. Its27/27 old-base
controls do not prove composition with6195 or current main.

Keep the earlier five-point producer/startup integration contract as the coding
release boundary. Resolve raw-retention versus activation ownership there before
extracting another duplicate token registry. Any ownership repair must preserve
all25 lifecycle controls, both type-negative checks, genuine-instance and exact
local-token checks, inert enrollment, repeat installation, prepare-before-publish,
FIFO/reentrant drain, actual throw side effects and separate start exports.
Caller acceptance additionally covers construction/setter/provider-init/raw
decoder/wrapped-namespace order, root binding before caller-owned init, both
setter aliases, linked/unlinked registration, realm/shared-tag identity, raw
standalone exports, and fresh versus cached imports. This audit does not release
activation, claim a merge-ready PR or prove the four array semantics.

### Allocation-role distinction required before lifecycle replacement

Read-only inspection of the current integrated8b9e89a5f9 source found a concrete
reason not to interpret AllocSite.kind=array as JavaScript Array ownership.
IrBuilder.emitVecNewFixed records kind=array for both from-ast array construction
and source-closure-invocation's internal argument pack. The latter passes its
vector directly into an external closure invocation. A physical vector or the
array allocation tag alone therefore cannot issue semantic receiver authority.

The eventual producer contract must carry an explicit semantic role established
at creation, keep internal argument packs distinct, and preserve the role through
allocation aliases, retirement, snapshots and IR cloning/import. Unknown role
must remain unproven; neither TypeScript annotations nor layout names fill it in.
This is a prerequisite for5748/6195, not permission to activate either path or
add a second managed-construction registry.

Release a bounded read-only Sol6.1 Medium audit of those exact creation and
propagation paths on integrated8b9e89a5f9. Enumerate every emitVecNewFixed caller,
registry registration/alias/retirement and snapshot restore, plus cloning/import
that changes allocation identity. Identify the smallest existing owner interface
that can carry an explicit role without duplicating provenance; give exact
positive/negative controls, especially array literal versus closure argument pack.
No source edits, test execution, branch/config changes or new public issues.
Parent uses these findings to author the implementation contract before any
production coding release. The frozen5883 validation continues independently.

Audit completed against8b9e89a5f9009d7a17a8c6410fa2ea2b1d0b3960 with working
src/ir bytes matching that commit. Four from-ast callers create literal vectors;
source-closure-invocation's fifth caller creates an internal apply argument pack.
The dense-fill literal branch instead calls a provider; those five calls are
not the complete semantic-array population. Backend emitters are not additional
allocation-registration sites.

Use the existing AllocSite/AllocSiteRegistry owner for any creation-established
role, not arbitrary namespaced metadata: alias currently replaces the source
record and merges metadata with target keys winning. That would silently erase
a role conflict. Only string-concat batching currently invokes alias for fusion;
its valid behavior and metadata precedence must remain covered. Retiring an
alias affects that slot; retiring its canonical target invalidates incoming
aliases. A new role must not turn an unknown/internal allocation into a semantic
array merely by aliasing it to another site.

Concrete propagation seams to include in the implementation contract:

- builder's source-location allocId wrapper must forward any new role argument;
- the snapshot live-site whitelist must validate it, while joint data/registry
  capture and restore preserve shared identities, slot order and next ID;
- forkAllocInInstr, enriched inline allocation cloning and specialization
  cloning must retain role while minting distinct IDs and preserving source-map
  origin rewriting;
- program allocation verification currently remints live sites and creates
  unknown dummy sites before replaying aliases. A new alias guard cannot be
  added in isolation: legitimate role-bearing snapshots would then fail this
  reconstruction. Resolve that reconstruction with the existing joint restore
  interface while retaining independent recomputation of metadata; do not seed
  recomputation with caller-claimed analysis facts and thereby verify itself;
- no generic cross-registry importer was found. Provider/root registries need
  an explicit prepared-node association; numeric site IDs alone are not global
  graph identities.

Required controls are same-layout literal versus argument pack, all four literal
branches plus the separate dense-fill coverage gap, source capture on/off,
zero/nonzero argument packs, same-role and conflicting alias chains, unknown
role, alias-versus-target retirement, malformed snapshots and detached round-trip,
ordinary/enriched inline and nested specialization clones. Role data alone is
not Module-to-Instance provenance, layout binding, initialization authority or
semantic readiness. Production release remains pending the complete producer/
verification contract; no check is waived and no existing fixture is changed.

### Queue-first dispatch update (2026-10-06, 14:39 CEST)

Parent owns implementation contracts and issue updates; bounded implementation
goes to native gpt-6.1-sol agents at medium effort. Do not delegate acceptance,
weaken the legacy-retirement bar, or open speculative migration checkpoints.

Fresh PR5883 state at published64849f95d2a0482820bafdd90bb0852184baeab1
has completed successful CI but mergeStateStatus=DIRTY. Local8b9e89a5f9
already integrates d0a13 and is running the exact full successor comparison;
it must remain unchanged until that run terminates. Green published-head checks
do not certify the later local checkpoint or resolve its main relationship.

Dispatch a read-only Sol6.1 Medium conflict assessment: obtain current server
main and PR head identities, compare main changes since d0a13 with the local
checkpoint's changed paths, and distinguish conflicts already resolved locally
from additional incoming changes. Report exact files and a minimal resolution
proposal, especially any inventory successor changes. Do not fetch, merge,
modify worktrees, start tests, change configuration, push, or release holds.
Parent reviews the result after the frozen comparison, then writes the precise
repair contract before releasing implementation. This is landing-sequence work,
not authorization to implement the lifecycle/semantic-role prerequisites above.

### Terminal evidence packaging contract for PR5883

Release a second bounded Sol6.1 Medium task, isolated from the frozen D tree:
prepare a lossless evidence packer in C's own .tmp directory. This packages the
current full comparison after termination; it does not run tests or decide
acceptance. Parent retains review of every native/raw result and source delta.

The packer must require explicit absolute run/manifest/runner paths and expected
manifest/runner SHA256 values. Require all eight named stages (canonical,
compiler-readers, text-readers, runtime, incoming23, repair-controls,
successor-proof, imported-main) and their terminal records for this full-success
packaging mode; reject partial/running runs rather than invent terminal status.
Authenticate the manifest and runner, bind each invocation/terminal to the exact
head, manifest and runner, and retain every regular file recursively under the
run, including complete before/after input maps and unmodified raw/native bytes.
Reject symlinks, unexpected stages and unsafe relative paths. Retain the explicit
manifest, runner and original boundary control-report authority as separate
streams; do not substitute the already-failed newline-altered v1 boundary file.

Use per-stream relative path, byte count, SHA256 and gzip+base64 payload; preserve
the original absolute source path as provenance. Decode and verify every stream
against its source before publication; fail if the input inventory or source
bytes change during packaging. Output is exclusive-create in C's .tmp only,
never overwrite and never write into D. Report accepted=false and require parent
raw-channel review even when all terminal records pass. Retain failures honestly;
this mode must not package a subset as a full successful run. Standalone smoke
checks may use small artificial fixtures in the agent's own .tmp: exact no-final-
newline bytes, missing terminal, wrong authority hash, symlink and output reuse
must be covered. No compiler tests, production source edits, Git mutations,
commits, pushes or changes to the running process. Parent reviews the packer and
authorizes its real invocation only after session65800 is terminal.

Parent reviewed the complete packer implementation at C
.tmp/5883-pack-full-successor-evidence-20261006.mjs, SHA256
6cc1cfbb390841cb35a53252832ac895c806a1edac0f58a1a08d59efda032557.
All nine artificial smoke controls passed, including missing/failed terminal,
wrong terminal head, missing explicit parent confirmation and unexpected stage.
Parent independently decoded and hash-verified all51 artificial archive streams.
This approves the packaging tool only, not the actual run or semantic acceptance.
The live run remains unmodified and unpackaged until its process is terminal.
The implementation and artificial evidence stay in C's isolated .tmp for later
publication with the actual terminal records; no new checkpoint PR is authorized.

### Incoming-main composition contract after frozen PR5883 validation

Read-only conflict assessment observed server main
4bffef14505f26558556a707931c711105a968af,26 commits after d0a13, and
published64849 still DIRTY. This is a hunk comparison, not an executed merge.
Twelve changed paths overlap local8b9. Ten require deliberate composition:
the C1 authority root, JSON manifest and current-source test, plus the seven
policy acquisition callers listed in the prior PR5883 repair. Context types
have disjoint additions to retain. The inventory requires five added rows:
source-map-position.ts (clean ir-program), callable-property-omittable-param.ts,
host-boolean-callback.ts, typeof-import-binding.ts and ta-iter-detach.ts (the
latter four unmigrated/mixed-needs-split/backend-wasmgc). Observed main inventory
blob126b9da52886d6c153271005953d87816189f19f is a source identity, not yet
the candidate union's byte authority.

Implementation sequence, parent-controlled after the running epoch terminates:

1. Preserve and review the full8b9 result, even if it fails. Do not label it a
   result for newer main. Pin the actual incoming commit before integration;
   if it differs from4bff, enumerate additional changes before releasing edits.
2. Merge into the integration branch with normal Git history, preserving both
   source trees' intended changes. Capture the exact inventory union and its
   five additions with full bytes, positions, hashes and semantic comparison.
   Add an exact successor projection to the existing591084-byte D profile;
   keep all old receipts and inverse/replay controls unchanged.
3. Give one Sol6.1 Medium writer ownership of the successor helper/receipt and
   the seven acquisition adapters plus their preservation controls. Incoming
   main expects a separate589117-byte historical profile, so blindly nesting
   adapters is invalid. Define explicit views of the same authenticated physical
   source; preserve each original view and every physical-source corruption
   negative, reject unknown input, and retain malformed-before-I/O behavior and
   read traces. Do not authorize arbitrary current inventory by recomputing a
   self-consistent receipt from it at test runtime.
4. Only once those source bytes are final, give the C1 owner the exact resulting
   instrument hashes and inverse recipes. Preserve immutable historical source,
   all assertion identities and fixtures, D's demonstrated120000/150000 probe
   budgets, and the incoming main recipe edits. No independent concurrent edits
   to the shared C1 authority files.
5. Collect the full incoming test identity population as identity evidence only;
   retain all existing68 files/4515 unique identities and account explicitly
   for additions. Test exact bridge controls, C1 and affected callers, then the
   required full composition with all original failed attempts retained. Parent
   audits native/raw channels before pushing the existing PR and protected-queue
   admission. No budget increase, skipped fixtures or legacy retirement.

This contract releases further read-only profiling now; production/test edits
await a pinned composition and isolated write ownership after session65800.
The existing dirty issue6440 worktree is not available for this implementation.
PR5911's actual historical queue job103729834926 reports host-free35585 against
floor35692 (mark35742,tolerance50), rather than an infrastructure failure. Its
published938342 remains held/DIRTY; its local branch has an unpublished6c648fec
merge and dirty README/baseline files. Preserve those owner changes and require
row-level attribution/current-main verification before touching its hold.

### Parent decision: independent allocation verification reconstruction

Inspection of src/ir/program/allocations.ts and the existing registry restore
interface resolves one prerequisite without inventing another allocation owner.
The verifier must first validate and retain the caller's complete metadata rows
as the expected evidence (including namespace ownership, duplicate rejection,
live owner checks and absent-versus-explicit-undefined semantics). Reconstruct
the registry jointly with the IR/runtime-support data through
AllocSiteRegistry.restorePreparationData, using the same provenance entries but
an empty metadata population for the recomputation side. Run the existing
encoding/ownership/escape analyses on that restored data, then compare their
results with the retained claims using the existing exact namespace rules.

Do not restore caller-supplied analysis values into the recomputation registry.
Do not mint dummy object sites and replay aliases as a replacement for restoring
the recorded slot graph: doing so loses creation-owned fields and can conflict
with a future role-aware alias check. Joint restore must retain site/type/IR
sharing, slot order, aliases, retired slots and subsequent fresh-ID behavior.
This decision does not make untrusted role strings semantic proof: the producer
contract still must establish creation roles and validate their propagation.

Required additions to the eventual writer's controls: valid live/alias/retired
graphs and shared type identity survive reconstruction; forged encoding,
ownership or escape claims fail even if internally self-consistent; absent and
explicit undefined remain distinct; metadata on non-live slots, duplicate rows
or namespaces, unsupported namespaces and cyclic/broken aliases remain rejected.
All existing allocation/typed-input tests remain unchanged. This is a settled
implementation decision within the pending producer contract, not a release to
modify the frozen PR5883 source or activate managed receivers.

### Pinned incoming acquisition profiles and baseline preservation

Read-only profiling is pinned to4bffef14505f26558556a707931c711105a968af,
not a moving main. Physical main inventory is590770 bytes, SHA256
b606727c951331096a458b46ef344e8042018089b04e0e1fa587d7045fad3d13.
The incoming fixed acquisition chain is:

- ir-position-finally-main-successor:589117 to588799;
- ir-position-class-fields-main-successor:588799 to588471;
- ir-source-map-position-inventory-successor:588471 to588351.

The first input's SHA256 is
58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857.
Parent read the complete first helper: it pins receipt.current on input and
does not admit deliveredMain as an alternative source profile. The agent is
checking complete call sites for an outer normalization before concluding
whether main itself encounters this mismatch. No test execution on4bff is
claimed by this source inspection.

If that outer normalization is absent, retain the original main failure as
arm A. Specify the smallest exact acquisition-only main repair as arm B before
execution, preserving its full source/fixture/assertion population and expected
outputs. The composed PR candidate is arm C; require exact identities/results
against arm B and retain A unchanged. Do not disguise main's failure by applying
candidate-only source projections to both arms or replacing historical receipts.
The projection difference between repaired main and candidate must be explicit
and limited to their authenticated physical inventory profiles.

Incoming C1 manifest SHA256 is
7866e5631d0c18a1226dec77fce73733a0140253f3ee959fca45289ae6c93d00.
Only currentInstruments and instrumentEdits differ from d0a13: recipes1,7,8,9
(boundary, runtime-program, well-known-symbol, number-prerequisite). Historical
before-pins/text/offsets and span counts remain unchanged. Preserve those
historical fields exactly when composing; final current pins cannot come from
either branch before its acquisition source bytes are settled.

### Isolation refinement for parallel conflict implementation

Parent inspected captureEpochPins/listDomain/currentHead and the full frozen
runner: authority is D's own HEAD, index/source bytes and explicit file pins,
not another worktree's branch or additions to the shared Git object store.
Accordingly the earlier wait-for-terminal restriction is narrowed: D remains
completely frozen, but composition may proceed in a newly isolated checkout
starting at exact8b9, with incoming4bff pinned and fetched without changing D's
HEAD/index or shared configuration. This supersedes only the blanket prohibition
on isolated edits before terminal; validation, push and acceptance restrictions
remain. Do not run competing compiler tests, install dependencies, change shared
configuration, or modify any existing occupied checkout. Parent owns the merge
and exact inventory union; the Sol6.1 writer receives an explicit disjoint write
set only after that candidate state is inspected. New incoming commits are not
silently folded into this pinned composition.

Follow-up source inspection found no preceding590770-to589117 normalization in
the pinned boundary/runtime-program acquisition calls or the finally/class-fields/
source-map-position physical successor tests. Ordinary unchanged reads therefore
encounter the mismatch before downstream positives; retain this as a source-level
finding until arm A is actually executed. Do not label inferred failures as
measured test outcomes.

### Phase one coding release: exact inventory views

Parent created managed isolated checkout
/Users/thomas/.codex/worktrees/5883-main4bff-composition/js2, branch
codex/5883-main4bff-composition-20261006, at8b9 and fetched exact4bff without
updating tracking refs/FETCH_HEAD. A normal no-commit merge produced the ten
expected unmerged authority/caller paths. Context types and inventory merged
automatically. Parent independently measured the inventory union:592524 bytes,
SHA25662dac966e6f945ba268a3ad76ee6b1e5215629234ab63e6f8ace744d8ecbfe22,
1849 rows, precisely the five additions above, zero removed/modified D rows,
and all non-files fields unchanged. This is a candidate, not acceptance.

Release Laplace (Sol6.1 Medium) only these new files in that checkout:
tests/helpers/ir-5883-main-4bff-inventory-views.ts, its same-basename JSON receipt,
and tests/issue-5883-main-4bff-inventory-views.test.ts. No existing file edits yet.
Implement explicit raw and semantic projections using the established fixed
receipt/authenticated inverse-and-replay pattern:

- exact candidate union592524 to prior D591084, removing only the five additions;
- exact candidate union592524 to incoming589117;
- exact physical main590770 to incoming589117 for narrowly repaired baseline B.

Recover incoming589117 from existing blob e775a64483ace95ca46b0d65221cff9cf84c4500
and verify its previously pinned SHA; preserve it byte-for-byte. The last two
projections must have independent explicit source profiles and raw edit recipes,
not runtime-generated acceptance from the caller's input. Map known source
profiles to named views, reject every other source, authenticate a fresh fixed
receipt on every call, validate input shape before authority I/O, and verify full
source/target profiles plus reciprocal raw/semantic transforms. Record every
removed row and any non-row change; stop and report unexpected semantic changes
instead of treating them as formatting. Original D/main receipts stay untouched.

Controls cover each valid projection; wrong/mutated physical profiles; reordered,
duplicated, changed or omitted additions; changed retained rows/non-files fields;
raw formatting corruption; malformed input before I/O; corrupt/stale receipts;
and fresh reads after a successful call. Keep test assertions independently
literal rather than deriving expected receipt values from the helper. Do not
execute compiler/Vitest tests while session65800 runs. Lightweight source/hash/
inverse verification and syntax checks are allowed. Parent reviews this phase
before assigning the existing callers, physical-source negatives and C1 recipes.
No staging, commits, merge completion, dependency installs or pushes by the agent.
