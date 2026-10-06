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
