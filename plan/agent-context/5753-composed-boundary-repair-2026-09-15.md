# PR5753 composed boundary repair: executable specification

Date: 2026-09-15. Specification only. No implementation, staging, commit,
push, queue operation, fixture deletion, or baseline update is authorized by
this document. The only write in this review is this new document.

## Dispatch first: S0, the serializer's error dependency

The first bounded Astra Low slice is a mechanical relocation of
`ProgramAbiInvariantCode` and `ProgramAbiInvariantError`, followed by S1's
serializer relocation. Do S0 immediately in an isolated implementation
checkout supplied by the parent; it does not depend on component/provider
design or structural-test repair.

Exact S0 implementation ownership:

1. NEW `src/shared/contracts/program-abi-error.ts`: move the complete code
   union and the exact error class from `src/ir/program/abi.ts:148–224`.
   No imports, new codes, wrappers, subclasses, or changed messages.
2. `src/ir/program/abi.ts`: import and re-export those exact definitions;
   preserve every map operation and the old `ir/program-abi.ts` export route.
3. NEW `tests/issue-5753-program-abi-error-seam.test.ts`: all three import
   routes expose the same constructor; thrown error retains `name`, `code`,
   `message`, and `instanceof`; declaration/body relocation is exact; injected
   duplicate class or an upward dependency is rejected.
4. `tests/issue-3518-program-abi-seam-boundary.test.ts`: explicitly add the
   one error leaf to the finite foundation fixture and fresh-loader closure,
   update only those exact populations, and add a missing-leaf control.
   Its existing fixture copies a closed list and would otherwise fail before
   its mutations. Preserve all original members and mutation controls. Run
   unchanged `issue-3518-program-abi-seam.test.ts` too.

The parent gate owner adds only the new leaf's truthful foundation inventory
record/activation to `scripts/compiler-boundaries.json`. The implementation
writer does not own that shared file. Preserve all historical records and
floors. Source completion can be reviewed while unrelated gates remain red;
it is not permission to publish a red combined candidate.

Reason: actual main permits `ir-core -> ir-core/foundation/wasm-model`, not
`ir-core -> ir-program`. Importing the existing error class from
`ir/program/abi.ts` would make a supposedly pure core serializer invalid.
Preserving the same constructor also matters to existing catch sites.

## Provenance and boundaries of this review

- P: published PR parent `51590be38131c959990eb6f146ff0717c33551c5`.
- M: pinned main `8c9b65b389194c8c8fc3e857e4b7316b0ae524e1`.
- C: resolved staged tree `634a5e1e1b89a28fbbfa76a8e6c971742f825d11`.
- Volta owns `/private/tmp/js2-5753-published-composition-20260915`, including
  its staged P+M merge. C is a tree, not a merge commit. Its HEAD is P.
- Documentation worktree:
  `/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree`, observed HEAD
  `c7f7252fe173749b3323543e21af707f5b095008`.
- Read `.tmp/HANDOFF.md`, `.tmp/commands.md`, the scoped/runtime/generator
  evidence, layering and compiler-boundary reports in Volta's checkout, and
  the relevant source/test blobs at M and C. Local `upstream/main` resolved
  to M; no claim of remote freshness or current queue state is made.
- Reviewed current memory in both local checkouts; the supplied old
  `/Users/thomas/Documents/.../ts2wasm/.claude/memory` path is absent.
- Requested routing is native Astra High specification -> Astra Low
  implementation. Native subagent tools were unavailable in this session;
  this review was performed directly. No task or substitute agent harness
  was created. The following ownership groups are dispatch proposals, not
  assertions that a developer has been assigned.

Main's controlling contracts are the actual allowed-edge matrix and active
entries in `scripts/compiler-boundaries.json`, `ir/core/{types,type-key}.ts`,
`ir/program/{abi,abi-signatures}.ts`, `frontend/typescript.ts`, the existing
ProgramAbi registries, and their prepared-scope transaction implementation.
The prior ABI seam and preparation-ownership plans supply context; their
older file counts do not override current source.

## Dependency order and ownership

S0 -> S1 (serializer). F1 (frontend boundaries) can run independently.
S1 -> D1 (dynamic evidence). C1 (component candidate authentication) can run
after S0 in a separate checkout. U1 (undefined provider) follows C1 so its
provider/resource dependencies use the same transactional component route.
G1 (preservation tests/inventory) runs alongside source work and composes
last. S1's support-ref correction is an explicit substep with its own delta
proof, not disguised as relocation.

Keep one writer for each shared source: the parent serializes changes to
`ir/integration.ts` (S1, D1, U1), `program-abi-type-planning.ts` (S1, D1),
and context setup (C1, U1 if needed). G1 alone owns the five historical
structural tests and shared inventory. No writer touches Volta's stage.
Routine work inside these explicit slices needs no repeat design approval;
unexpected semantic drift is evidence to reconcile with the parent.

### S1: canonical support serializer, including its real dependencies

Exact source ownership:

- NEW `src/ir/core/support-key.ts`.
- NEW `src/wasm/model/abi-value-key.ts`.
- `src/codegen/program-abi-type-planning.ts`.
- `src/codegen/program-abi-signatures.ts`.
- `src/ir/integration.ts`, only its object-key import.
- NEW `tests/issue-5753-support-key-seam.test.ts`.

Move `canonicalClosureSupportIrType`, `canonicalClosureSupportSignature`,
and the four public functions `canonicalProgramAbiClosureSignatureKey`,
`canonicalProgramAbiClosureLayoutKey`, `canonicalProgramAbiRefCellKey`,
`canonicalProgramAbiObjectShapeKey` together. The backend planner imports
and re-exports the same function objects. Integration's object allocator
imports the core owner directly. Keep private recursive helpers private.

Move the exact `canonicalProgramAbiValType` implementation from
`program-abi-signatures.ts` to the model leaf; retain the old compatibility
export and internal calls. It serializes Wasm value vocabulary only. Do not
move physical struct/session planning into core. The core module imports
the canonical `core/types.ts`, `core/type-binding-keys.ts`,
`core/callable-bindings.ts`, `core/object-layout.ts`, the S0 error leaf and
the model value serializer. No old nodes, ABI facades, codegen, checker,
TypeScript shim, or program-layer import is permitted transitively.

Two explicit acceptance steps:

1. **Relocation parity.** Compare old C implementation against the moved
   implementation for every existing arm. Check exact strings and exact
   error class/code/message, not parsed-JSON similarity. Preserve JSON
   property order, `undefined` omission, i32 signed default, boolean/symbol
   and i64 bigint marks, union member order, dynamic null/default tag,
   DOM callback authority suffix, null return versus value return,
   vector nullability, declared allocation kind, physical field order,
   method-signature strings, class ID and fnctor owner/binding identities.
   Preserve anonymous layout/signature cycle rejection and accepted nominal
   recursive carriers. Reject bare module-relative refs and scalar-attached
   symbolic refs. Shared acyclic subobjects must serialize repeatedly.
2. **Explicit support-ref repair.** Both M and C's serializer lack a
   `case "support-ref"`. A valid main `IrSupportRefType` falls through and
   yields `undefined`; object properties disappear and array entries become
   JSON null. This is a real silent identity-loss defect, absent from the
   four-function proposal and not tested by the existing composed core test
   (that test exercises `irTypeKey`). Preserve a characterization of this
   original failure, then add exactly the arm
   `{ kind: "support-ref", typeRef: irTypeBindingKey(type.ref.binding), nullable: type.nullable }`.
   Require the canonical support binding kind and boolean nullability;
   malformed values fail `type-remap-mismatch`. An exhaustive default must
   refuse unknown kinds rather than fall through. Existing valid arms and
   existing refusal cases remain byte/error identical. The new arm's grammar
   is an explicitly new contract; do not claim it equals old output.

Construct support refs with the real main factories. Cover distinct bindings,
renamed compatibility labels, both nullabilities, top-level ref-cell payload,
object field, closure parameter/result, capture array, union and boxed nesting.
Different support identities/nullabilities must produce distinct keys;
renamed display names and remapped symbolic physical indices must not.
Use an independently pinned old implementation, not the new re-export as
both sides of the comparison. Keep known original failures as named rows.

Exit: integration's direct codegen count returns from 46 to at most 45,
old imports preserve function identity, the actual allocator consumes the
new owner, and the new type+value dependency closure satisfies existing
rules. Do not replace this grammar with `irTypeKey`, `irPhysicalTypeKey`, or
`preparedIrDataKey`; those are distinct contracts in current main.

### D1: dynamic closure carrier evidence before allocation

Exact source ownership:

- NEW `src/ir/program/closure-dynamic-carrier.ts`: immutable demand/evidence
  vocabulary using identity brands and canonical IR refs/types only.
- `src/codegen/program-abi-type-planning.ts`: the existing type registry owns
  evidence preparation/authentication using its session and context.
- `src/ir/prepared-closure-support.ts`: demand collection and evidence use.
- `src/ir/integration.ts`: `prepareClosureTransaction` wiring only.
- NEW `tests/issue-5753-closure-dynamic-evidence.test.ts`.

Demand key is the exact tuple `{ terminalUnitId, logicalTypeKey,
role: "closure-dynamic-payload" }`. `logicalTypeKey` comes from the S1
semantic serializer for the dynamic leaf, including tag refinement. Walk
all closure parameters/results, capture types, boxed payloads and object
fields used by the final prepared entries, with visited guards for nominal
recursive graphs. Do not demand by name or only by `box` instructions.

Evidence retains that tuple and a discriminated carrier:

```ts
type ClosureDynamicCarrier =
  | { readonly kind: "externref"; readonly carrierTypeRef: IrTypeRef }
  | { readonly kind: "reference"; readonly carrierTypeRef: IrTypeRef;
      readonly nullable: boolean };
```

The externref alternative deliberately keeps the existing slotless symbolic
carrier plan. It has no numeric type index and no fake nullable GC ref.
Frozen evidence objects are authenticated against their registry/session,
exact demand and existing type-cell/shape; copying fields is not proof.
Use a backend-private association to these existing identities, not a second
ABI registry. The type registry's operation-specific preparation method
executes the existing `resolveIrDynamicCarrierType` policy and
`prepareDynamicCarrier`; it must not merely wrap a callback supplied by IR.
Review the added backend dependency for cycles before landing it.

Actual policy is `!ctx.fast -> externref`, otherwise nullable `$AnyValue`
after `ensureAnyValueType`. It is not a simple host/standalone switch.
`prepareDynamicCarrier` already establishes one source-owned support ref,
slotless externref or a required type-cell plan, and rejects post-seal or
conflicting carriers. Preserve that authority and ordering. Its current
`ensurePlan` publication is existing behavior: evidence production must not
publish extra per-demand support plans or grant provisional component state
the status of committed state.

At `prepareClosureTransaction`, collect/prepare the finite demand population
before constructing/using `ClosureStructRegistry` and before any derived
callable type is allocated. Supply evidence to `lowerPreparedClosureSupportType`
through its concrete registry input; remove its direct any-helpers import.
The current callback shared by closure layout resolution can remain for its
existing purpose, but cannot be the dynamic-carrier evidence boundary.
When a registry lowers an identical logical payload shared by several
terminals, validate evidence for every consuming terminal and require the
same module carrier; do not choose the first terminal's proof.

Resolve reference indices at consumption through the current exact ABI
lookup (component overlay when provisional), preserving `ref` versus
`ref_null`. For externref, require the existing `slotPolicy: "none"` plan
and exact `JSON.stringify({kind:"externref"})` shape. Missing, forged,
wrong-terminal, wrong-key, foreign-session, stale-cell or changed-shape
evidence is a refusal. Recheck after a complete type-layout remap.

Controls: preserve `issue-1058-ir-dynamic-capture` shared mutable cells in
both modes and mismatched-initializer refusal; symbolic closure carrier
remap/unowned/scalar/unbound controls; capture preparation abort and withdrawn
closure fixtures. Add missing/foreign evidence controls, all `fast` policy
arms, and nested dynamic payloads. Compare undefined singleton, null, numbers,
objects and repeated writes by value/identity, not merely Wasm validation.
Failed preparation must leave the same retained allocator/session state as
C, with no extra pending reservations or published per-terminal carriers.

### C1: component data versus authenticated candidate ownership

Exact source ownership:

- NEW `src/shared/contracts/prepared-component-tokens.ts`: only the two
  existing kind-only token interfaces, with old backend type re-exports.
- NEW `src/ir/program/component-candidate-demand.ts`: the readonly request
  `{componentId, terminalUnitIds, callableBindingIds, supportBindingIds}`.
- NEW `src/codegen/program-abi-component-preparation.ts`: concrete candidate
  adapter for the existing ProgramAbiSession; move the actual candidate
  resolution/planning logic here from sealing, rather than forward `ctx`.
- `src/codegen/context/types.ts`, `src/codegen/context/create-context.ts`:
  wire one session-bound adapter with the other ProgramAbi registries.
- `src/codegen/program-abi-unit-callable-preparation.ts` and
  `src/codegen/program-abi-support-type-preparation.ts`: type imports only
  unless a specified missing validation is demonstrated by a control.
- `src/ir/prepared-component-sealing.ts`: emit exact dependency request and
  consume returned tokens; remove the two new backend descriptor imports.
- NEW `tests/issue-5753-component-candidate-boundary.test.ts`.

This adapter is a migration boundary attached to the existing context, not a
new compiler pipeline or a generic context service. Its methods do the
specific work now at sealing's allocator/contribution loop and component
candidate selection. It has no arbitrary `apply`, callback, guessed binding
ID, or independent plan/locator registry. Do not put it in an activated
`backend/wasmgc` module while it still imports legacy context and planners.
Its remaining migration debt is recorded honestly; no existing record is
downgraded. The bounded repair removes IR's new ownership of authentication.

Main's `ProgramAbiSession` constructor accepts inventory/module, not context.
Do not add `ctx` to that general authority just to hide the two imports.
The context-created adapter already has access to the same source/class/
module-init registries, `irUnitFuncMap`, type registry and session used by
the current sealing implementation. Resolve callable IDs using actual
inventory/derived-unit records and `irUnitCallableBindingId`; no ID parsing
or display-name lookup. Retained terminal/class/module-init reservations
keep their current planning behavior. Derived candidate contributions remain
non-publishing until the existing transaction seals.

IR dependency discovery may need candidates before it can form components.
Move the pre-component physical observation step to this adapter too. Return
only the existing structural ABI-entry view to `derivePreparedComponentDependencies`;
keep function/type-cell candidates private. Once it emits a component, bind
the request to that exact component population. Recompute the required
callable/support ID set from the accepted dependency report and reject a
missing, duplicated, foreign or excess ID. An empty optional population
means omit that token; a nonempty requested population may never silently
produce `undefined` or a fake empty descriptor.

Token authentication remains in the existing backend WeakMaps. Structural
kind-only token types are not a security boundary: a forged object with the
right kind must still fail WeakMap lookup. Keep `describePreparedUnitCallables`
and `describePreparedSupportTypes` as the actual mint/authentication sites.
Both mint fresh; scope preparation claims; a preparation failure after claim
consumes. Rebase reconstructs bindings; `assertCurrent` checks ownership,
shape and claim; seal/abort consumes. Never reset consumed tokens to fresh.

Return the original token objects to the existing
`stagePreparedComponentBatch({scopeId, terminalUnitIds, unitCallables,
supportTypes, ...})`. Preserve `program-abi-prepared-transaction.ts`'s
prepare/rebase/assert/consume, exclusive callable IDs, all descriptor kinds,
requested-key closure, duplicate scope checks and final consumption even on
abort failure. Preserve deferred publication and the per-component lookup;
do not borrow another component's or the live session's resolution view.

Negative controls: foreign session/context/module; same-size different
terminal population; duplicate terminal/binding; token copy/replay; missing
derived callable; changed callable signature; function removed from module;
function moved to another owner; type-cell replaced; type shape mutated;
unknown support candidate; partial descriptor preparation then failure;
intervening publication/rebase; shared support dependency across components;
seal failure, internal error, abort and withdrawal. Each starts from a real
valid descriptor and observes the intended failure after the mutation.
No public draft/locator/order/registry write survives an aborted candidate.

### U1: symbolic undefined demand, backend provider reservation

Exact source ownership:

- `src/ir/undefined-value-provider.ts`: retain the symbol and add pure
  demand vocabulary/validation; remove all five codegen imports and `ctx`.
- NEW `src/codegen/undefined-value-provider.ts`: actual provider allocator
  implementation moved from the old file, owned by the existing provider
  preparation path.
- `src/codegen/program-abi-provider-planning.ts`: demand resolution and
  authenticated observation/descriptor joining in the existing registry.
- `src/ir/integration.ts`: collect demand during its current instruction
  census and call the existing provider registry before body lowering.
- `src/ir/prepared-component-sealing.ts`: join the provider/resource demand
  through its current callableProviders/callableImports batch if not already
  supplied by the dependency sidecar; serialized after C1.
- NEW `tests/issue-5753-undefined-provider-demand.test.ts`.

Frontend already emits `irRuntimeFuncRef("__ir_undefined_value")` with no
arguments and externref result in `from-ast.ts:3767`. Keep that emission.
Demand carries that exact ref/ABI plus source ID and terminal consumer;
the existing component dependency pass attaches the component ID once known.
Do not invent a second source-census or provider-discovery pass. Integration's
current `usesUndefinedValue` census becomes the collection point.

Backend owns `ensureAnyValueType`, `canonicalUndefinedExternInstrs`, function
type/handle reservation, `pushDefinedFunc`, `funcMap`, and late-import shifts.
Its canonical provider registry is the existing slot through which integration
requests preparation, avoiding a replacement upward import. It authenticates
an existing reservation by allocator and exact `() -> externref` contract;
the current `funcMap.has(name)` early return alone is insufficient authority.
One program provider serves multiple exact consumers; record those consumers
without allocating one provider per component.

For standalone/nativeStrings, require the canonical undefined singleton
resource and its current global identity before building the body. For the
other arm, require the explicit existing host `__get_undefined` callable
import capability, with the same ABI. The provider's real import descriptor
must accompany its provider descriptor when required by the transaction.
No capability may be inferred solely from a spelling or invented for this
repair. Unknown capability, missing singleton, wrong ABI or wrong allocator
fails before publishing the component.

Use the existing runtime-provider reference/observation protocol so final
IR receives its authenticated prepared callable binding. Preserve the
existing pre-lowering allocation phase and shift handling. Do not eagerly
publish provisional provider state to make dependency discovery green.
Singleton allocation that is already retained module state is distinguished
from candidate publication; withdrawal must not destroy another accepted
component's shared provider or retain an unowned candidate contribution.

Controls: no-demand case; repeated demand in one/multiple components; zero
standalone imports; native undefined is distinct from null and stable under
repeated calls; existing host import used exactly; provider-name collision
with wrong signature; wrong source/terminal ownership; missing native
singleton; unavailable host capability; late import before/after reservation;
failed preparation/withdrawal/retry and a peer component still accepted.
Preserve `issue-2106-s1-undefined-singleton`, optional-parameter, eager-capture
TDZ, capture-abort and withdrawn-closure fixtures. Compare actual values,
callable/global identity, imports and allocator counts.

## F1: activated-boundary violations are concrete source edges

The composed report contains eight enforced forbidden-edge rows, over six
distinct source/target pairs. Two oracle edges each carry two reasons. Do
not count transitive fan-out as independent defects:

- `checker/higher-order-signature-fact.ts -> ts-api.ts` and `checker/oracle.ts`.
- `checker/signature-position.ts -> ts-api.ts` and `checker/oracle.ts`.
- `codegen/closures/generator-declaration.ts -> ts-api.ts`.
- `ir/tail-function-declarations.ts -> ts-api.ts`.

All four source modules are already assigned `frontend-ts` (state
`unmigrated`). Main's checker enforces clean-layer dependency rules on that
assignment. Relabeling them mixed, permitting debt edges, excluding type
imports or declaring `ts-api.ts` clean would conceal the defect.

F1's exact ownership is those four files, `src/checker/oracle.ts`, NEW
`src/frontend/type-fact-contracts.ts`, and NEW
`tests/issue-5753-frontend-boundary-preservation.test.ts`.

Change the four imports to the existing `frontend/typescript.ts` owner.
`ts-api.ts` already re-exports that exact static `ts` binding; runtime TS7
selection remains in the shim and these helpers do not use it. This is
replacement of a real import dependency, not copying TypeScript constants.
Extract the complete mutually recursive `TypeFact`, `SignatureFact`,
`ShapeFact` plus `SignaturePositionPath` data declarations from `oracle.ts`
to the new frontend leaf. Oracle imports/re-exports them. Keep its
`SignaturePositionFact` (which contains an AST annotation), caches, checker
queries, `OracleTypeKey`, and classification implementation where they are.
No type clone or duplicate fact vocabulary.

Preserve the higher-order classifier's depth 6 and budget 64, overload/
generic/receiver/optional/rest/default/cycle refusals, instantiated-symbol
query, signature path limit 12 and exact annotation identity test. Keep the
existing classifier callback's narrow fact purpose; add no context callback.
Preserve generator FunctionExpression/MethodDeclaration recognition and
asterisk check, exact AST node identity in tail reordering, declaration-only
suffix after return, erased interfaces/types and executable-statement order.
Run existing higher-order-signature-facts, signature-position,
ir-tail-declarations, generator protocol/prototype/worklist and both
same-name factory fixtures. Fresh static closure must include type edges and
reject oracle/shim imports; verify old/new `ts` identity in a fresh process.

Separately, `core/object-layout.ts` is an unclassified new module in an
active root. Inspection shows one type import to core/types and the actual
pure field-order implementation. G1 may add its new truthful clean record
and explicit active entry, with malformed length/duplicate/missing-name
controls. This is new-module coverage, not relabeling existing debt. No gate
green is claimed until the record and source controls compose.

## G1: all 27 structural failures, with narrow preservation repairs

All five structural test files are byte-identical between M and C. Read-only
Git-blob comparison and selected original source-receipt/graph calculations
were performed in memory. The full Vitest suite was not executed on M in
this review. The classifications below describe demonstrated input/receipt
conflicts, not an invented main test-run result.

### 15 core-type-boundary failures

Fourteen stop in `positive(f)` before their intended mutation. The fixture
copies eight historical clean modules and expects 9 total modules/12 edges.
M's `core/types.ts` already imports `binding-key-primitives.ts`, absent from
that fixture. C additionally imports `core/object-layout.ts`, also absent.
The affected rows are positive closure (1), four import forms (4), deletion
of each original canonical entry (5), unknown/missing/invalid source (3), and
transitive barrel (1). These are main-preexisting fixture-population defects
with a new C closure obligation, not fourteen proven mutation escapes.

The fifteenth expects active `ir-core.minModules === 12`; both M and C have
21. The original five activation-history entries and forbidden-edge policy
remain meaningful. Their historical min=5 record stays exact.

Repair the finite fixture population with explicit independently reviewed
dependency additions. Keep the original eight inputs, all five deletion
mutations and all failure forms; add deletion controls for newly required
leaves. Establish the positive control before every mutation. Recalculate
the exact fixture module/edge list, pin that list, and require no unknown or
unresolved edge. Do not let the candidate dynamically choose its own allowed
closure. Test original historical activation and current explicit activation
separately; no blanket `>=`, history deletion, or wildcard allowance.

The original seam's type+value traversal, evaluated in memory over M/C blobs
with those two explicit leaves admitted, measures M: 9 clean modules/14
edges; C: 10 clean modules/16 edges. Adding the retained old-nodes debt stub
gives expected fixture totals 10 and 11 respectively. The production checker
must confirm those fixture totals; the in-memory traversal is not a fixture
gate run. C's two additional edges are types -> object-layout (runtime) and
object-layout -> types (type-only), so the visited guard must retain that
legitimate type cycle without admitting an upward dependency.

### 5 core-type-seam failures

All have a main-preexisting first failure:

- Export population omits main's existing `irSupportRef` (1).
- Static closure and two intended injection refusals encounter main's
  omitted binding-key leaf first (3).
- Fresh-process loader's allowed set omits that runtime leaf (1).

C adds object-layout to the required closure. Add `irSupportRef` to exact
runtime export coverage and old/new function identity checks; retain one
class symbol, one private recursion guard and the negative export controls.
Reconcile exact type/value edges and fresh-loader visited modules, not just
counts. Retain every injection, including nonliteral import, absent export
and invalid syntax. Prove each reaches its intended failure after a valid
positive. Broadly expecting any exception would turn these back into vacuous
passes. Inspect later assertions after repairing the first failure: the log
does not establish that currently masked assertions already pass.

The exact runtime imports from types.ts are tag-refinement and
binding-key-primitives at M, plus object-layout at C. Thus the intended
fresh-loader set is types plus those two/three leaves, respectively; no
foundation runtime load is needed for binding-key-primitives' erased type
import. Require a successful fresh-process execution to confirm that set.

### 5 symbolic-support-ref failures

One original factory receipt and four mutation controls fail on the original
positive. Both M and C have exactly the same relevant production inputs:

- `ir/abi-bindings.ts` SHA256
  `66ed6871b28bad9610053cb56ac30a3bbd99abb6a28e55b87f83a1e0c43cc65b`.
- `ir/core/type-references.ts` SHA256
  `fc86cce3079cf606e0ab0e24814cc7b9b009bbd8450d638938d29cb59ac4bef4`.

Executing the original inverse-reconstruction calculation against both blobs
gives `bea8dbc0b7ed4b5bbb6f5735d3e59223e15dd557dd93fcd9fdd1bfc48c9b8945`;
the historical expected whole-file hash is
`9324caf316c596019beab1007c7e602263ae2955328a0f336b1ab38246bb09fc`.
This is demonstrated main-preexisting receipt drift, not a PR factory change.

The exact original donor is `721cd33a828c89cfc04c851b011f910b76a4d2c5`;
its abi-bindings blob hashes to the historical expected value. The support
factory relocation landed in `efe352fee8afc3feb6a28c34d00fc658dc1fb205`.
The subsequent facade delta through M is precisely the relocation of
`irTypeBindingKey` into `core/type-binding-keys.ts`, recorded at
`27abcf7beaf400fde81da157a1c1357f808a78e1`: two import/export lines added
and the exact key function removed. No other facade delta appears in that
comparison.

Keep the original donor/hash and original two-factory inverse. Compose it
with an additional narrow inverse for the independently checked key-function
relocation: verify its canonical body/prefix, remove exactly its two facade
import/export lines and restore the exact old function at its original
anchor. The resulting whole file must still match the original donor hash.
Also compare present facade/canonical modules against pinned M for unexpected
changes. Every inverse span must occur exactly once. Keep all four original
body/extra/route/export mutation controls and positive-first ordering; add
a key-function and unrelated-facade mutation. Do not replace the expected
hash with C's hash and call that an equivalence proof.

### 1 lowering-cycle failure

The unchanged test expects 21 module identities. Reusing its valueClosure
algorithm against Git blobs, with the same forbidden paths and literal-edge
resolution, yields M: 23 modules/27 edges; C: 25 modules/29 edges. Both
populations are nonempty and include lower-generic. M already adds
`core/binding-key-primitives.ts` and `core/string-callables.ts` to the old
expectation. C adds exactly `core/object-layout.ts` and
`ir/object-construction-order.ts`, removes no module, and adds exactly:

- `ir/core/types.ts -> ir/core/object-layout.ts`.
- `ir/lower-generic.ts -> ir/object-construction-order.ts`.

Thus the first assertion is main-preexisting; C's two new edges are a real
review obligation. Pin M's graph and the exact reviewed C delta separately.
Retain forbidden facade/emitter paths and every unknown, unresolved, external
and injected reverse-edge control. This projection covers runtime imports;
the production compiler-boundary checker still covers type-only edges.

### 1 lowering-relocation-coverage failure

This is an actual changed-body receipt at C. M matches both historical body
receipts exactly:

- `emitInstrTree`: M hash
  `75c0cceb6224dda24e892bcc5433532f10985c863b09fd4ae4245037811a2424`, span 2297;
  C hash `0f85a9a3a8623c48e018a1715b8a31ab1801cce44ee049e6ac7014a7e0013009`, span 2292.
- `lowerIrFunctionBody`: M hash
  `ed92c0a576009ab30571152c9b01dfc6caf19a2e2ca3dfb436edef32b4436739`, span 3380;
  C hash `2fdb881ee0f0f21fdd77ebcdd264425c64a745ca5a5ab0f6921cd89e73e19cb8`, span 3375.

The nested `emitInstrTree` change is also inside the outer body; it is not
two independent runtime failures. Diff review finds four bounded operations:
object operand load ordering and refcell.new/get/set logical type lowering.
The separate `lowerIrTypeToValType` boxed-inner recursion changes too and
must have its own preservation/semantic controls even though it is outside
the two reported body receipts.

Retain historical initial-relocation proof against donor
`120cd638cf2a971934eaaccf47aaf65f06491f3d` and relocation commit
`c257b46620fb4996bf5233763b80298c1fd03dc6`. Direct calculation on the donor's
`lower.ts` matches both original body hashes above.
For C preservation, invert only the exact reviewed object-new and three
refcell hunks in memory, assert each expected occurrence count, then demand
the original body hashes/spans. Compare the separate boxed-inner change in
the same bounded fashion. Changing anything else in either body must fail.
Add one mutation inside an approved hunk and one outside to prove the inverse
cannot erase arbitrary changes. Positive semantic controls verify physical
field order, original effect evaluation order, nested logical payloads,
boxed symbolic support refs, and retained scalar/physical mutable-slot
refusals on WasmGC and bytecode where already supported.

The test currently uses `resolveChangeBase` and `skipIf(beforeGeneric exists)`.
The broad logged run did not pin LOC_GATE_BASE; C's HEAD is P and its merge
state matters. Merely rerunning with M can skip this initial-relocation row.
That skip is not repair. Keep the historical donor proof and add the present
M-to-C comparison so both regimes have live, non-skipped coverage. Preserve
all five lowering target paths, missing-file tests in every mode, original
pushRaw sites/tags, replacement/duplicate-site controls, all budget allowances
and baseline equality checks.

**Disposition:** source evidence supports 26 main-preexisting first assertion
conflicts and 1 C-specific body-receipt change. None of those labels licenses
dropping tests or refreshing all goldens. C additionally needs the new graph
closure, truthful object-layout inventory and four interface source repairs.

G1 owns only `scripts/compiler-boundaries.json` and the five exact files
`tests/issue-3518-{core-type-boundary,core-type-seam,symbolic-support-ref,lowering-cycle,lowering-relocation-coverage}.test.ts`.
The brace notation names five files, not directory ownership. Any new
preservation helper belongs in these tests unless the parent assigns a
specific separate file. Production source remains owned by its slice.

## Equivalence controls and final handoff requirements

Use three explicit comparisons: M versus C to attribute composition changes;
C versus each repair tree to prove the bounded repair; and the original
relocation donor versus its historical postimage for relocation provenance.
Record lane, harness version, environment, exact trees and fixture/test IDs.
An uncommitted tree's HEAD alone is not provenance.

Preserve all fixture sources and original failures from both parents,
including the already repaired seven generator identity failures and the
first mixed-delegation TypeScript fixture error. Keep their original logs
and the corrective results. A failure is fixed only when its same named
control exercises the repaired path; missing/skipped/filtered is not fixed.

Mandatory existing runtime populations are exactly those in
`.tmp/commands.md`: initial ten-file runtime group (90/90 recorded), broad
23-file group (281/315 before the final generator repair), and final four-file
generator group (30/30 recorded). The broad 34 failures comprise the seven
subsequently repaired generator rows and the 27 structural rows above.
The final four generator files overlap the broad group; do not add their
denominators as new coverage. The combined core 4/4 and mixed-delegation
1/1 evidence also overlap. These are inherited logs, not fresh runs here.

In particular retain eager capture before nullable lazy-cell/raw-local
fallback, argument proof versus result truthiness, exact plain-this source
handles, typed-array and native-generator prototype exclusions, declaration-
owned same-name factory identity, array-to-protocol delegation transition,
return(done=false) object identity/finally cleanup, original harness status/
callback counts and unhandled-rejection diagnostics. No fixture rewrite may
remove one of these controls to simplify a boundary repair.

For each slice use its focused controls first. At composition rerun the full
preserved commands plus new seam tests, with
`VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048`, reporting executed,
passed, failed and skipped rows by stable test ID. Compare actual values,
imports, allocator identities, ABI keys and refusal evidence. For relocation
only, require exact output; for S1 support-ref and the existing C lowerer
behavior deltas, enumerate the narrowly intended differences explicitly.
No full TypeScript upstream suite or test262 sweep has been run or is claimed
by this review; retain the original failing corpus files for later queue
validation through the existing harness.

Final gates use explicit M as comparison base and name the repaired tree:
compiler-boundaries inventory and activated roots, IR layering/dialect/kind
neutrality, pushRaw, LOC/function budgets, oracle ratchet, typecheck, lint and
format. Keep inventory classifications/history, every activated root and
floor (including six physical entries), issue allowances and baselines.
No `--update`, broad hash replacement, added suppression, fabricated token,
new parallel compiler route, or promotion of provisional state is part of
these slices. Full architectural completion must remain false while the
recorded migration debt remains.

The first actionable deliverable is S0's tiny error-contract relocation;
S1 then removes the serializer layering edge with actual parity evidence.
F1 can remove the six frontend dependency pairs concurrently. The parent
can dispatch the remaining typed slices in the dependency order above
without re-requesting routine permission. This specification does not
perform those implementations or claim that PR5753 is ready to enqueue.
