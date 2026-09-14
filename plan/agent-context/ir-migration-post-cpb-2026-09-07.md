# Post-CPB implementation sequence: settlement, public metadata, linear resources

The [standalone WasmGC folder plan](ir-standalone-wasmgc-layering-plan-2026-09-07.md)
supersedes this document's host-first/linear implementation sequence. Preserve
the native settlement and forward-reservation contracts below; defer new
host/linear implementation and use the new plan's ownership/move sequence.

This is a continuation of the frozen recovery plan for issue #3518,
**IR-only default and direct front-end retirement**, and issue #3527,
**IR-only R7: AST-free async suspension plans and canonical Promise ABI**.
It proposes the next bounded assignments; it does not transfer held claims,
change target defaults, or declare the migration complete.

Read-only source basis: `/private/tmp/js2-3527-cpb-validation-20260907`, base
`6037ac8bcf07be4f71839cea33cf8c90ecc87f94`, with the coordinator's P8/B5/C5
composition. The composition's test run is owned by the coordinator and is
not reported as passing here. Queue extraction commit independently resolved
as `f735ed9720c0b1dd22d717655ebd441f53613899` (PR 5727); mergeability and CI
status were reported by the coordinator, not independently rechecked here.
No implementation, heavy test run, claim mutation or publication was performed
for this specification. The parent retains publication ownership.

## Immediate N continuation: settlement and queued reaction delivery

CPB currently has a measured entry/call ABI blocker. Apply the
[canonical async entry prerequisite](3527-canonical-entry-abi-repair-2026-09-07.md)
before claiming CPB completion. The disjoint N work below can continue while
P repairs that prerequisite; A-public/linear integration waits for the shared
composition to stabilize.

The next connected cut extracts the bodies used by
`ensurePromiseSettleFunctions` for fulfill/reject and identity wrappers.
These bodies consume the queue already extracted in PR 5727. Resolve-value
and thenable assimilation remain registered by the existing owner and are
explicit external dependencies of the identity-fulfill wrapper.

This is a useful physical provider component, not a complete native async
provider. Native acceptance in C stays unsupported until all remaining
provider resources and their real bodies can be reserved and verified.

### Ownership and prerequisites

Resume N after its queue change is settled and the coordinator reconciles
the existing scheduler claim. Do not dispatch a second scheduler writer.
N owns these exact implementation surfaces for this continuation:

- New `src/codegen/prepared-native-promise-settlement.ts` for the pure bodies
  and their narrow resource types.
- `src/codegen/async-scheduler.ts`: import the leaf; construct its resource
  arguments at the existing settle/wrapper body call sites; move
  `buildPromiseSettleLocals`, `buildPromiseSettleBody`,
  `buildIdentityWrapperLocals`, and `buildIdentityWrapperBody`.
- New `tests/issue-3527-prepared-native-settlement.test.ts` for the production
  route, semantic parity, dependency and reservation controls.

Read the queue leaf, unhandled-rejection provider, runtime hooks and existing
native tests. Do not edit `unhandled-rejection.ts`, the queue leaf, B's engine,
P's producer/schema, C's planner/consumer, `ir-async-runtime-adapters.ts`, or
`native-promise-number-boundary.ts` in this cut. A concrete necessary change
outside that list goes back to the coordinator for ownership reconciliation.

### Narrow resource contract

Export detached settle-local/body and identity-local/body builders, with
role names specific to this leaf. Inputs are data and bound physical handles:

- Promise struct: state i32, value externref, callbacks externref, own-property
  bag externref, preserving all four existing mutable fields.
- Reaction struct: fulfill function/captures, reject function/captures, next;
  exact existing funcref/externref field order and mutability.
- Identity captures struct: callback externref and chained Promise reference.
- Queue enqueue callable `(funcref, externref, externref) -> void`, pointing
  to the actual registered queue function.
- Identity continuation callable `(ref Promise, externref) -> externref`.
  Fulfill selects the actual reserved resolve-value helper; reject selects
  the actual reserved reject helper. Both are explicit caller-owned handles.
- Tracking policy: `disabled` or the actual unhandled-node struct and list-head
  global. Its node is `{promise eqref, next externref, handled mutable i32}`.
- Hook policy: `disabled` or the actual dispatcher callable, its accepted
  signature and a canonical undefined value resource for the absent parent.
  The dispatcher receives f64 hook kind, Promise converted to externref,
  and parent externref. Preserve its existing result/stack contract.

The leaf constructs the fixed note-unhandled sequence from typed node/head
resources. It must not call `buildNoteUnhandledRejection` or import its
legacy module. Likewise it builds the fixed enabled-hook sequence from the
dispatcher and canonical value resource, without importing the scheduler or
`any-helpers.ts`. Do not inject arbitrary callbacks or instruction blobs that
can secretly perform registration or depend on a CodegenContext.

Canonical undefined is an explicit bound helper or bound singleton global
plus the declared conversion to externref. Missing enabled-hook resources
must not silently become null or a disabled hook. The compatibility adapter
must establish the same resources at the original construction point; any
new allocation or changed registration order requires investigation before
claiming byte parity. Disabled hooks remain byte-inert.

The caller owns the module, registration, optional-policy selection and
publication. Use a narrow read-only resolver that checks exact reserved
object, module ownership, expected kind/signature/layout and current index
space. The leaf neither accepts a serialized allocator index nor acquires a
CodegenContext, AsyncSchedulerState, mutable registry or source dependency.
Raw `{kind, index}` snapshots alone are not authenticated handles. Legacy
immediate emission can resolve through its own reservation view; it must
preserve the existing late-import relocation discipline. Do not impose a
whole-module early seal that prevents unrelated legacy registration.

### Forward callable reservations: concrete allocator protocol

The identity-fulfill continuation is intentionally referenced before its
resolve-value body is installed. Requiring an already published WasmFunction
at that call site would change the existing registration order. Use the
allocator's actual two-phase protocol instead; this clarification does not
expand N's three-file scope.

`func-space.ts` already provides `mintDefinedFunc`, `pushDefinedFunc`,
`definedFuncAt`, `definedFuncHandleOf` and `funcSignatureOf`. Minting returns
a stable `FuncHandle` backed by a reserved ordinal; its position remains NaN
until push. `definedFuncAt` deliberately returns undefined while pending.
Push records the function's eventual position, rejects an unminted/double
push, and preserves the stable handle across intervening functions/imports.
Only final layout turns that stable handle into a concrete Wasm index.

Keep that protocol and add a private adapter-owned receipt around it:

1. At the original resolve-value `mintDefinedFunc` statement, retain the exact
   returned handle. Create the eventual detached WasmFunction object with
   its existing name and already reserved settle signature. Creating this
   ordinary JS object must not append to module functions/types or fill its
   body early. Empty staging arrays are permitted only on this detached,
   explicitly pending object; they are not a completed body or a receipt.
2. The adapter creates an opaque frozen token. Its private per-invocation
   census associates that exact token with the module object, stable handle,
   exact detached function object, expected type object/signature and state
   `reserved`. The census creates the receipt directly from its own mint
   result; it must not accept an arbitrary caller-supplied numeric handle as
   proof of reservation. Do not recover the target by name from funcMap.
3. The pure identity builder receives the token through the typed callable
   resource interface. A read-only resolver verifies token identity and the
   active owner/module census, expected signature and pending/installed
   state. In the pending state it permits only a call reference to the
   captured stable handle, not a claim that a function is already present.
   An unexpected object at `definedFuncAt(ctx, handle)` while pending fails.
   The leaf places the stable handle in the call's `funcIdx` exactly as the
   old builder did. Do not convert it to a guessed absolute function index.
4. Preserve the original `funcMap.set("__promise_resolve_value", handle)`
   position and every fulfill/reject/wrapper push. Run the original thenable
   substrate registration at its original point. Nested registrations may
   consume arbitrary later ordinals; the captured stable handle remains valid.
5. At the original resolve-value body construction/push point, build the real
   locals/body, put those actual builder outputs on the same detached object,
   and call `pushDefinedFunc(ctx, handle, object)`. Only afterward transition
   its receipt to `installed`, verifying `definedFuncAt(ctx, handle) === object`
   and the current signature through the existing func-space accessors. A
   cloned replacement object or merely nonempty body is not the expected
   installation; the receipt records the actual completed builder outputs.
6. Before `ensurePromiseSettleFunctions` successfully returns, require every
   forward receipt this invocation owns to be installed. Recheck identity
   and signature, then close the reservation census. Failure/exception revokes
   its tokens and does not deliver a successful resource result. A recursive
   ensure that takes the existing early-return guard neither finalizes nor
   owns the outer invocation's pending receipt. Do not claim its reservation
   as complete from that recursive path.

The exact object can thus be authenticated before it has a module position;
final membership is a separate, mandatory lifecycle check. A removed/corrupt
ordinal cannot become successful installation because `pushDefinedFunc` and
the final identity lookup must both succeed. Normal final-layout resolution
also rejects a minted handle that was never pushed. Do not add inline
`handle - importCount` arithmetic or modify the shared allocator in this cut.

Keep type/global object checks and optional-policy checks as specified above.
The completed prepared consumer will additionally require its whole-resource
census at its own seal; this legacy extraction does not replace later module
finalization or prove that unrelated deferred helpers were filled.

Focused forward-reference controls: insert intervening function registrations
and late imports before the original resolve-value push, and verify the
identity wrapper still calls that exact helper with unchanged final behavior.
Reject a token from another invocation/module, a matching numeric handle with
no owned token, wrong signature, wrong pushed object, duplicate push and an
omitted push. The omitted-push case must fail the local completion check;
never satisfy it with a dummy body, early installation or changed push order.

### Preserve exact behavior and registration timing

Keep the existing sequence: queue, optional tracking, Promise/reaction/caps
types, settle signature; reserve fulfill, reject, identity fulfill, identity
reject and resolve-value slots; register the resolve-value name before its
executor/thenable users; fill the same slots in the same order. Do not move
thenable registration earlier or replace a forward reference with fulfillment.

Settlement emits the resolve hook before the one-shot guard, including a
duplicate settlement attempt. It returns the attempted value on that guard,
leaves the original state/value intact, otherwise stores state/value and
detaches the reaction list before enqueueing callbacks. Fulfill chooses
reaction fields 0/1; reject chooses 2/3; next remains field 4. Rejection notes
an unhandled promise only when tracking is enabled and its detached callback
list is null. Delivery remains queued, with the original list traversal order.

Identity wrappers decode the chained Promise, emit before/after hooks around
their selected continuation, and return that continuation's value. Fulfill
uses resolve-value so returned Promises/thenables are adopted. Reject passes
its reason directly to reject; rejection reasons are not assimilated.

### Acceptance evidence for this cut

Run focused tests against the actual legacy producer route, with the queue
dependency present. Record compared source revisions, target, fixture count
and result count; pure constructor tests alone are insufficient.

1. Compare old/new emitted instructions or module bytes for no-hook and
   enabled-hook fixtures, covering both tracking policies. Keep slot names,
   ordering, imports and exports unchanged; explain any difference.
2. Execute fulfillment, rejection and repeated settle attempts. The first
   result must persist, and duplicate attempts must preserve resolve-hook
   ordering where enabled.
3. Attach multiple reactions before settlement and another during callback
   execution; assert queued FIFO delivery, exact captures/argument forwarding,
   and no duplicate reaction delivery after the list was detached.
4. Exercise identity fulfillment of a pending/settled native Promise and a
   user thenable, plus identity rejection with a thenable-valued reason. This
   tests the actual existing resolve-value dependency, not a stub substitute.
5. With tracking enabled, contrast unhandled rejection, an already attached
   reaction, and same-turn late handling. Use the existing runtime's real
   drain/report boundary; do not change reporter policy in this PR.
6. Reject wrong-kind, donor-module, absent and stale reservations before body
   publication. For enabled hooks reject absent undefined/dispatcher resources.
   Verify the fresh-process import closure of the pure leaf, with a known
   forbidden back-edge control; its legacy caller is not a source-free root.

The deliverable is production use of all four extracted builders plus the
focused evidence. No native admission or full provider-closure claim follows
from this checkpoint.

## What remains before complete native admission

The source census shows why resolve-value is the subsequent architectural
boundary: `ensurePromiseThenableSubstrate` registers TypeError construction,
a pooled self-resolution message, exception tag, closed `then` dispatch,
object-vector builders, executor resolve/reject closures and apply-closure.
It also reserves `has_callable_then` and `peel_value` bodies for later filling.
Those placeholders can currently classify everything as non-thenable or pass
values through. Their existence is not executable closure evidence.

After settlement, assign a bounded type/tracking descriptor and materializer
cut, then a resolve/adoption cut over the actual object/value/closure providers.
The latter must account for self-resolution TypeError, a throwing `then`
getter, single retrieval/captured then method, exactly-once executor behavior,
job scheduling, recursive adoption, native boxing and canonical undefined.
Require final-body receipts for every delayed helper. A default placeholder
or null substrate cannot satisfy a required provider in the new consumer.

Keep timer/fd-reactor and exit-report integration as explicit startup/service
requirements when demanded. Keep JS callback/value interop separate from the
native Promise semantic implementation. N publishes the exact next transitive
file set before claiming these larger providers; this note does not authorize
simultaneous edits throughout the scheduler or object runtime.

P then serializes the complete selected native resource requirements and ABI
declarations; C validates and reserves them, calls the pure materializers,
binds and seals before B emits any frame, installs actual outputs, and
reconciles all required bodies. C cannot call `ensureAsyncDriveRuntime` or
legacy registration helpers. Native WasmGC completion does not imply linear
async completion or authorize a native-first default change.

## Public metadata: proceed after CPB stabilizes, parallel to N and linear work

CPB's real producer/codec/consumer/engine tests must first establish the shared
contract. Then resume A-public with disjoint ownership of
`src/compiler/ir-program-driver.ts`, `src/compiler/ir-program-result.ts`, new
`src/compiler/ir-program-public-metadata.ts`, and focused result tests.
P continues owning any required program/schema evolution; A proposes the
minimal data-only metadata fields to P instead of editing those files itself.

The existing driver returns internal program/emission evidence, not a public
CompileResult. The next connected deliverable must call the metadata adapter
from that actual driver/result path for supported producer-created programs.
Preserve canonical exported aliases, function/Promise signatures, live globals,
source locations/maps, callback and linked-provider metadata, initialization
order, diagnostics, and original output/backend/allocator options. Join final
objects/indices through binding identities; never infer metadata from names or
empty module properties. Codec persistence must retain the public contract.

Test a re-export alias, two same-named source owners, a mutable live global,
an async export through the real host wrapper, initialization order, and a
user export named `__module_init`. Execute bytes; parse WAT and verify it
describes the same module; validate object-link metadata through its real
consumer. Keep ordinary synchronous result and failure-location controls.

This internal integration can land while N/linear coverage is incomplete.
Actual public dispatch remains a separate exclusive A-public change in
`src/compiler.ts`, `src/compiler/output.ts`, and applicable `src/index.ts`
wrappers. Do not flip the general route merely because the host async fixture
passes. Gate public cutover on the original population across required APIs
and profiles, including unsupported families tracked by D. At cutover there
is one preparation and selected emission, no invariant-catching legacy retry,
and no partial artifact returned for a refused program.

## Linear closure: first connected memory/allocator/data component

Start a separate linear writer after CPB stabilizes its shared contracts;
it can run in parallel with A-public and N. Own new
`src/codegen-linear/prepared-program-resources.ts` and
`tests/issue-3518-prepared-linear-resources.test.ts`. C alone owns the shared
planner/consumer dispatch integration. P owns serialized descriptor changes.
Do not assign broad `codegen-linear/index.ts` edits to this first slice.

Read `analysis/linear-memory-plan.ts`, `codegen-linear/runtime.ts`,
`linked-arena.ts`, `heap-allocator.ts`, `string-literals.ts`, and `c-abi.ts`.
Reuse their actual layout and allocator policy contracts. The snapshot already
names layouts, allocation sites, relocatable data segments and static globals;
the instruction emitter does not allocate or initialize that whole population.

First close one explicitly accepted policy: owned i32 memory, existing bump
allocator, declared static data/global storage and declared allocation
operations. The plan must name memory limits, alignment/overflow rules,
null-reserved region, data placement, heap floor after data, allocator/global
bindings and startup actions. Materialize the complete set before body
emission and prove each allocation operation resolves to the selected provider.
Resource declarations and runtime body receipts must be exact; no blanket
zero-allocation success or AST scan may substitute for the frozen plan.

Connect the leaf to C's actual accepted linear route for fixtures with real
allocation and nonempty initialized data. If a legacy runtime helper mutates
the module or discovers additional dependencies, split reservation from body
construction or adapt it under this complete plan; do not import the legacy
AST-based linear index as a convenient constructor.

Test alignment and data/heap non-overlap, growth with live data preservation,
the configured growth failure behavior, initialized bytes read by emitted
code, repeat instantiation, and wrong-policy/donor-layout/missing-runtime
negative controls. Contrast a no-allocation scalar fixture as a control, not
as the acceptance denominator. Add linked-memory and malloc-v1 policies in
separate explicit continuations; unsupported variants retain located refusals.
Linked memory must use its owner's allocator and relocatable data, never the
owned-memory fixed heap/data addresses or independent memory growth. Do not
silently normalize a requested policy to bump, or memory64 to memory32.

After this connected closure, add demanded string/vector/closure/class layout
families with their conversions and startup dependencies. Linear continuation
frames and Promise runtime remain a distinct later representation slice;
WasmGC frame descriptors cannot stand in for them.

## Join and retirement gates

CPB establishes the shared host path. N settlement, A-public internal metadata,
and the linear resource leaf then proceed with disjoint ownership. C serializes
their shared acceptance/emission integration; P serializes schema additions.
D reruns the original population across its required profiles and public APIs
after each meaningful join, preserving row identity and explicit failures.
Only actual full coverage authorizes the public default replacement and later
legacy deletion. Claims, passing test totals, and merged infrastructure PRs
are not substitutes for that evidence.
