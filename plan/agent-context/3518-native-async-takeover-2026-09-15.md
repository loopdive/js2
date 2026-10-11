# Native async takeover: current-main implementation sequence

Grounding: upstream main `8c9b65b389194c8c8fc3e857e4b7316b0ae524e1`.
Specification reviewed by Astra High (Hypatia); coordinator retains integration.
This supplements, not replaces, the September 8 materialization plan and all
original fixtures, failures, preservation receipts and epic acceptance criteria.

## Verified state

Native output PR5937 is merged. The unchanged full-family refusal control passed
on this main: one selected test, 23 unselected. It retains seven inventory units,
five terminal units and sixteen prepared functions. This proves refusal before
emission, not execution. The full prepared owner/call obligation remains 16/33.

Resolution/thenable bodies and the Promise resource pack already exist. Do not
extract or reserve them again. The existing pack pins 25 resources and 26
reservation operations, but its tests do not establish successful executable fill.
Delay/combinator resources have declarations/reservations but no fill. The current
prepared frame planner admits WasmGC host, not standalone native frames.

## Next connected dependency

Complete the actual property-access and invocation dependencies consumed by
`fillNativePromiseResources`: open-object type/get, accessorGet, applyClosure,
thenDispatch, bagHas, externGet and typeofFunction. These form a recursive group;
reserve the complete group before filling. Reuse the existing ledger, ABI,
closure/argument-vector, value, string, error and resolution owners.

First correct the inventory contract: one unique ordered carrier population,
with separate ordered method/accessor/field/callable facts referring to it.
The current exclusive carrier role cannot represent an accessor with a fallback
field on the same type. Preserve method -> accessor -> field -> open-object
precedence and runtime-null accessor fallback. Independently reconcile prepared
allocations/types/callables, resource construction recipes, ledger reservations,
and emitted allocations. Missing evidence is unavailable, never an empty set.
The final classifier population is not yet measured.

## Sequenced ownership proposal

1. Carrier accounting: `src/ir/program/native-promise-inventory.ts`, existing
   Promise requirements/resources and focused inventory/resource tests. Freeze
   exact input provenance and overlap rules before Low implementation.
2. Property access: canonical object/accessor/property-key bodies and native
   object-access resource owner. Begin with bounded key/hash/equality/find and
   conversion dependencies, then getter/finalizer composition.
3. Invocation: canonical closure-invocation/property bodies and native invocation
   resources using real arity, receiver, argument-vector and bag protocols.
4. Native frames: native requirements, prepared adapter, frame entry and resources;
   preserve selected runtime-state bodies, all fields/spills and asynchronous await.
5. Delay/combinator fill and timer publication using existing canonical bodies,
   tagged/foreign catches, actual binding/marker tables, element and manifest.

These are proposed scopes, not permission to fill dependencies with placeholders.
Parent owns shared legacy donor adaptation, program physical plan/consumer,
native-async aggregate, supplemental ABI, boundary policy and end-to-end tests.
No overlapping writes with PR5753 composition or PR5748 safety repairs.

## Required semantics and proof

Keep complete self-resolution, pending/settled adoption, own then properties,
poisoned/captured getters, original receiver, argument counts, undefined padding,
accessor/field precedence, queue FIFO/growth beyond 8192, and hook configuration.
General externGet must retain ToPropertyKey/ToPrimitive/ToString semantics; do not
narrow it to literal then while claiming the general contract. Conditional
prototype/proxy/typed-view/error arms need actual owners or affirmative absence.

The aggregate authenticates before allocation, seals one symbolic ABI, reserves
shared types once, reconciles inventories, freezes once, binds indices, fills all
dependencies, publishes actual timer/output/value boundaries and seals emission.
Keep single-use acceptance tokens and all existing refusal paths until supported.

Execute the original playground source (SHA256
`6bc4fc96cc65881c9919a39b840afaf1001dfd3d0e05ef0cc141441a051f7915`),
original/decoded and GVN off/on, retaining 7/5/16 and 16/33 accounting. Four native
async owner state counts remain 2/5/2/3. Use the existing full-family runtime helper
and behavior suite: 70 and 3e9 delays, duplicate callbacks, sequential suspension,
eager parallel starts/reverse completion, empty timing, both registration failures,
exact four output lines/final newline and once-only canonical undefined fulfillment.
Only the explicit timer capability may supply host behavior. Fresh-process decoded
replay must detect forbidden frontend/codegen imports. Negative controls must reject
missing/stale/copied/foreign owners, layouts, carriers, providers, fills and publication.

Resource tests or legacy execution do not replace this whole-consumer proof.
Public IR-only cutover, both-backend shared preparation, ABI30, strict closure,
optimization preservation and deletion of direct handlers remain separate required
epic obligations. Nothing here declares the migration finished.
