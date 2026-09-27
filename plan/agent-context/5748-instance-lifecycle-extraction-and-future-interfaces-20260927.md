# Instance lifecycle extraction and three future interface contracts

Final validation update: 46 distinct cases passed (25 adapter + 21 neighbors),
canonical source and supplemental test TS7 passed, and focused formatting passed.
The first TS7 failure and narrow literal-type correction are preserved in
`5748-instance-lifecycle-validation-20260927.md`, which supersedes the historical
unrun status/hashes below. No commit or push. Published PR5748 tree untouched.

Final adapter SHA256: `a7e6d4b4a661e44781a5414c72204bef0de3d823ef6296b926a20ca97efa0d05`.
Final test SHA256: `cba4d915373fbad818d82de305435892e9e57dfa57b72fa5529c371d624f417d`.

## Exact subject and owned scope

- Tree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-instance-lifecycle-20260927`.
- Branch: `codex/5748-instance-lifecycle-20260927`.
- Base: `50f57285922a5084007ba6feadc76838dffda84e`, verified against upstream
  `refs/heads/main` by ls-remote before normal worktree creation.
- Worktree creation session 81063, terminal ff3c2a, exit 0. No hook overrides.
- Read Mendel's full DomainV1 integration partition and both Hume portable
  storage/provider-record contracts before this implementation.

Files:

1. `src/runtime/instance-lifecycle-adapter.ts`
2. `tests/issue-5748-instance-lifecycle-enrollment.test.ts` (new)
3. This handoff.

No runtime.ts edit was necessary: the adapter already receives the actual trusted
branded-instance reader through its existing options. Runtime still publishes only
the original public setters. No linked-provider, index, init-guard, manifest,
physical resource, DomainV1, host-import, gate or baseline edits.

## Implemented API and preserved semantics

The existing install operation now composes private `prepareAndPublish` followed
by private `drainDeferred`. Preparation still executes at installation, returns
the actual view, then assigns currentExports. The queue still uses
`while (deferred.length > 0) deferred.shift()!()` without a draining lock,
queue snapshot, deduplication, catch, finally drain, or rollback.

Both public setters retain their existing routes: setExports installs with false
authority; setInstance calls the existing branded reader, preserves its old
TypeError diagnostic on rejection, then installs with true authority. Repeated
calls still prepare and drain each time. _hostBridgeExportView authority, timer
and DOM side effects remain at this original point, not during enrollment.

- Prepare throws: no outer assignment or outer drain. Existing view and queue
  remain, except for any real reentrant effects performed by prepare itself.
- Drain throws: the throwing operation was already shifted; installed view and
  remaining queue survive. The original thrown value propagates.
- Reentrant install may drain the shared tail before the outer operation resumes;
  its view remains unless the outer prepare later returns and performs its own
  assignment. No artificial install-once or nonreentrant policy is introduced.

New INTERNAL adapter methods:

```ts
enrollInstance(instance: WebAssembly.Instance): InstanceLifecycleEnrollment;
installEnrolledInstance(enrollment: InstanceLifecycleEnrollment): void;
```

Enrollment reads genuine-instance exports through the existing supplied trusted
reader, mints a frozen opaque token, and stores raw exports in this adapter's
private WeakMap. It does NOT call prepareExports, assign currentExports, alter
startExports, drain operations, invoke exports, or publish runtime authority.
Installation checks exact token membership before using the original installation
operation. A symbol-shaped copy, inherited/proxied token or another adapter's
genuine token is insufficient. The symbol field is nominal typing, not the runtime
authority check. Handles may be installed repeatedly, deliberately matching the
existing install semantics; no consumed/revoked graph capability is claimed.

Trust boundary: the factory's branded reader is trusted injected infrastructure.
A caller supplying a lying reader is outside this adapter guarantee. The existing
runtime supplies its captured intrinsic reader. This handle proves only brand
plus adapter ownership, NOT artifact authenticity, module identity, DomainV1
readiness, graph membership or successful user initialization.

## Historical pre-validation controls and source hashes

25 source-authored cases: nine controls for each of the two public setters (18),
plus seven enrollment cases (including three parameterized forged-instance forms).
They cover prepared-view publication, FIFO order, prepare failure, shifted drain
failure, repeated install, queue append, nested drain/install, nested prepare
success/failure, inert enrollment, exact raw identity and rejected foreign/copied/
inherited/proxied handles. Compile-only @ts-expect-error checks protect opaque
handle typing. Tests instantiate only tiny real Wasm modules when eventually run;
no compiler-generated fixture or fake instance is used as the positive control.

- Adapter SHA256: `0b28a3ab11f4128a4db7b55fa37a419a2bea8395e5e661ba38a48d3482bf67ef`.
- Test SHA256: `33a3fd5514b1d85d709d1528eff31a2d0e7e73970fa477c6a91860f5d2050953`.

No executed denominator or acceptance claim. A broad read-only git diff listing
hit the known LFS clean-filter sandbox permission failure; no lock/config change
or cleanup attempted. Narrow text-path diffs and hashes were readable.

## Future interface 1: externally orchestrated root construction

PROPOSAL ONLY; names need parent/linker agreement before wiring:

```ts
prepareRootConstruction(verifiedRoot, graphPlan, hostInputs): RootConstructionRequest;
instantiatePreparedRoot(request): ConstructedRoot;
completeRootBindings(root, readyProviderBindings): BoundRoot;
```

These belong to the existing managed linker, not the adapter above. Request/root
objects must be privately owned there and record the exact verified binary/hash,
exact compiled WebAssembly.Module object, graph node, import-adapter identity and
resulting actual Instance. The construction function itself invokes the captured
trusted constructor/instantiate primitive with that Module; it cannot accept an
arbitrary caller-supplied Instance or user callback's claimed receipt. Complete
checks the exact constructor-issued record and all required slots before binding.
The current brand-only enrollment can be a component, not its provenance proof.

For cached result.importObject, cache host-input/template preparation separately
from per-instantiation graph state. The raw getter currently initializes providers
before the root exists; a new-version path must instead let the managed request
construct dependencies and root, bind all, then release deferred work/init in the
specified order. Reusing a cached object cannot select a latest root or merge two
instances' domains. Mutable adapter state is per node/instance even when immutable
host dependencies/import functions are shared.

Hard boundary: JavaScript has no general API to recover a genuine Instance's
originating Module. A legacy caller doing arbitrary
WebAssembly.instantiate(binary, cachedImports) and later handing over only its
Instance cannot supply this proof. That caller must use the managed construction
entry (or a trusted embedder construction owner with the same exact association).
Do not invent `adopt(instance, claimedModule)` or treat equal binary/exports names
as evidence. Old APIs remain old behavior while dormant; full activated graphs
require migration of every relevant caller, not source eligibility exclusions.

Concrete callers: index.ts withImportObject/instantiateLinkedProject;
linked-provider-runtime.ts instantiateLinkedProviders/wireProviderInstance/
wireCompiledInstance; scripts/test262-import-object.mjs and worker's caller-owned
root-init path; runtime.ts compileAndInstantiate and raw instantiate helpers as
their managed usage requires. Preserve worker exception classification and the
runDeferredInit opt-in: bound root does not mean caller-owned init already ran.
Fresh origin, shared-import and duplicate/reentrant construction negatives apply.

## Future interface 2: bootstrap physical role versus user-init guard

PROPOSAL ONLY, jointly owned by Mendel's physical owner and the init-guard owner:

```ts
// Issued through the existing reservation transaction, not caller metadata.
reserveBootstrapBindingCallable(transaction, plannedRole): BootstrapCallable;
classifyEntryPhase(exactFunctionAllocation): "binding-only" | "user-entry";
```

The role is attached to the exact reserved function allocation and authenticated
by the existing PhysicalModuleReservations/Program ABI owner. classifyEntryPhase
must reject a forged/foreign claimed role; default existing source entries retain
their original guard policy. applyModuleInitGuard consults that trusted allocation
role before prepending user init. It must not skip names/prefixes, arbitrary exports,
whole helper classes, or a caller-provided function-set with no owner proof.

Seal must prove binding-only bodies are filled, correct-signature, non-user-calling
and free of user-init edges, and that only planned private slots are written.
Preserve normal relocation and all actual instruction roots. User functions with
identical names still receive their guards. No binding export can accidentally
trigger user init through a wrapped helper, an export-view preparation callback,
or transitively invoked guarded function. This is a physical phase authority
contract, not a spelling exception. The current patch does not implement it.

## Future interface 3: native/static bundled bind-before-init

PROPOSAL ONLY, jointly owned by native driver/bundler and physical linker owners:

```ts
prepareLinkedStartup(graphPlan, bootstrapRoles, initializerRoles): LinkedStartupPlan;
emitLinkedStartupDriver(sealedPlan): PreparedStartupBody;
```

The plan includes all providers AND root, finite forward/transitive/reverse binding
edges and explicit initialization ownership/order. Emit the native typed binding
calls first, then provider user initialization in existing dependency order, then
root initialization only at its existing owner-selected checkpoint. Calls are
actual declared/retained IR edges in the existing module owner; no opaque list,
host callback trampoline or post-DCE index patch. DCE/serialization must retain
binding functions, domain globals, ref.func services, driver and initializer roots
through their real ownership/relocation paths. Post-link verification authenticates
all role mappings and signatures and no surviving user-start-before-bind edge.

package-bundler.ts currently refuses providers with initExport. Keep that refusal
until the driver and matching native invocation path exist and are measured;
removing the check is not implementing initialization. Do not add JS imports to
bridge-off output. Standalone/WASI _start and callable-entry guards must not cause
double init, and external root-deferred ownership must remain explicit rather
than swallowed by the bundle. Existing incompatible graphs remain a named
activation blocker, not an acceptance-population reduction. Native driver and
bundler owner assignment is still needed; this adapter patch cannot close it.

## Before activation

Agree these three interfaces with parent/Hume/Mendel. Validate this adapter slice
only after explicit slot grant, including full source and targeted-test TS7.
Later controls must include both old public setters, graph/order/error negatives,
same-binary distinct instances, transplanted exports, cached-import reuse, reverse
callbacks before first host observation, root-deferred ownership, guard-role
forgeries, DCE retention and zero-new-host-import evidence. No active DomainV1,
semantic-service claim, four-array-blocker acceptance or old-compiler retirement.
