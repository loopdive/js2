# Class-ownness preservation repair specification

Date: 2026-09-27. Specification only; no implementation.

## Design prerequisite discovered before implementation

Do not implement the proposed presence overlay below in isolation. Source review
found that repeated evaluation of a class expression reuses both a singleton
constructor global (`emitLazyClassObjectGet`) and declaration-keyed static
storage. Fresh allocation alone would still share values, and singleton identity
arms would lose older evaluated constructors. Correct receiver-owned definition,
deletion and redefinition state therefore first needs per-evaluation constructor/
prototype ownership and static storage. Eight additive candidate diagnostics
(four sources at O0/O2) now reproduce identity, static-value, descriptor and
reentrant-evaluation failures: zero of eight pass against native expectations.
The main arm for these eight diagnostics has not run. Exact fixtures and results
are preserved in `5753-landing-diagnostic-fixtures-20260927.json`.
The isolated class repair lane is revising the design; no implementation was applied. The requirements
below remain acceptance requirements, not an approved claim that the proposed
storage mechanism is sufficient.

Pair: main `935dab385ba7f21588ea371d052e7f143f894205` versus candidate
`b212925eaba4a038e3b422b21232c41000e2b451`, pinned Test262
`b363f29d3c43c626dc852744ad64a0b48a003693`. Parent reports original16 main
15 pass / 1 fail, candidate 7 pass / 9 fail, both complete16 with zero
exclusions. Eight candidate regressions are established. Three class-expression
fixtures are this specification's scope; Error and generators have other owners.

The unchanged class fixtures are under
`test/language/expressions/class/elements/`:

- `multiple-definitions-private-field-usage.js`
- `redeclaration.js`
- `field-definition-accessor-no-line-terminator.js`

The first implementation should be a **native class-ownness repair with complete
definition/delete/redefine handling**, not a dispatch change. Keep the reified
`hasOwnProperty` body, existing folding, class representations, and old mutation
implementations live. No retirement, fixture edits, gate weakening, or blanket
constructor-false answer.

Two pieces are required together: authenticated instance-field visibility, and
constructor static-own state. Shipping constructor exclusion alone would break
the required positive static `accessor` assertion.

## 1. Identity: reuse the mechanism, preserve existing gates

Existing implementations are not general-purpose constructor predicates:

- `standalone-class-construct.ts::classObjectIdentityArms` compares actual
  singleton identities, but is gated by dynamic-construction demand.
- `typeof-natives-finalize.ts`'s `__is_class_object` deliberately recognizes
  **base classes only**.
- `class-object-of.ts` is host-only and also recognizes instances; unsuitable
  here.

Factor the null-safe, `eqref`-guarded identity-arm emitter into a small shared
module, accepting explicit global identities and fresh match instructions.
Preserve both existing callers' admission policies unchanged. Ownness supplies
**all local constructor identities**, including derived classes, without
manufacturing a dynamic-`new` demand.

Do not change `IS_CLASS_INSTANCE_CARRIER` globally: existing bag/deletion
consumers depend on its broader structural admission.

## 2. Storage contract: presence is not a second values store

Proposed new owner: `src/codegen/class-own-state.ts`.

Use receiver-identity-keyed state, separately from user-visible property bags.
It records completed base definitions and their descriptor kind/default
attributes; it must not contain a duplicate mutable field value.

Three semantic states must remain distinguishable:

- **Live base definition:** value remains in existing static backing storage.
- **Descriptor override:** the existing carrier bag owns the actual descriptor/value.
- **Absent/deleted:** neither old physical slots nor backing globals establish presence.

Query precedence:

1. Authenticated deletion/absence state.
2. Actual own descriptor override.
3. Completed base-definition state.
4. Existing fallback for receivers outside this ownership.

Queries perform lookup only—no allocation, lazy declaration installation,
getter invocation, or inherited lookup.

Required internal operations, with final names chosen by the writer:

- Reserve/fill runtime helpers.
- Register an evaluated constructor identity.
- Look up completed base presence.
- Produce a **current base descriptor snapshot** when descriptor validation
  needs one.
- Commit successful definition, override, or deletion.

Descriptor snapshots must read the actual backing value. They are not placeholder
descriptors containing `undefined`, and must not invoke accessor bodies. Existing
static-method/accessor installation remains the value owner; record its
successful installation, not merely its syntax.

The current static sidecar cannot replace this owner: it omits fields and some
accessors.

## 3. Separate storage reservation from definition events

Modify `class-bodies.ts::collectClassDeclaration`:

- Reserve each backing storage key once.
- Retain **every source field-definition event**, including repeated names and
  absent initializers.
- Anchor events with the actual `PropertyDeclaration`, not just its initializer.
- Exclude private fields from public-own state.
- Deduplicate visible/synthetic compiler aliases by declaration identity; do not
  deduplicate separate source redeclarations.

Extend the existing entry contracts in `context/types.ts`, then update these
existing emitters:

- `class-expression-static-init.ts`: `emitClassExpressionStaticInitialization`
  and `emitClassExpressionStaticsBeforeValue`.
- `declarations.ts`: `moduleStaticInitNode`, `emitModuleStaticInitialization`,
  and their existing graph timeline.
- `statements/nested-declarations.ts`: `staticInitOwner`,
  `emitNestedDeclarationStaticInitializers`.

For each event: evaluate once → validate definition → commit storage and
presence → proceed to the next event. Abrupt completion/refusal must leave prior
state intact. An initializer-free field defines canonical `undefined`; it is
not “no event.”

Preserve late-global-index repair and source-order scheduling. Capture the actual
constructor receiver across initializer evaluation rather than assuming a
subsequently read singleton global still identifies it.

## 4. Consumers and mutation closure

### Native own queries

In `object-runtime.ts::fillClosedStructHasOwnArms`:

- Authenticate constructor identity **before interpreting instance slots**.
- Constructor misses bypass instance-field arms, but retain intrinsic-name/
  prototype and real own-descriptor handling.
- For instances, consume `readClassFieldProvenance` from
  `class-field-provenance.ts`. Admit proven public `$`/`__public`; do not grant
  private, synthetic, ambiguous, or unknown records new visibility.
- Preserve presence bits and tombstone precedence.
- Authenticate class tags where structurally identical layouts can otherwise
  match another class's field names.

Do not globally relax `isInternalStructFieldName` or modify `structInsertionOrder`.

The shared builder also serves enumerability and `in`: preserve descriptor flags
and inherited fallthrough. An own miss is not an `in` result.

### Definition/redefinition

Integrate at these existing seams:

- `carrier-bag-define.ts`: `defineCarrierBagSubstitutionArm`,
  `definePropertiesCarrierBagArm`, and authenticated retained-marker handling.
- `object-runtime-descriptors.ts::buildObjectDescriptorHelpers`: data/accessor
  validators and descriptor readback.

A live base definition must supply the validator's current descriptor; a deleted
base must count as absent. Commit the override only after successful validation.
Preserve existing retained-marker implementations and refusal behavior.

### Deletion and writes

- `carrier-bag-delete.ts`: `buildNonObjectDeleteArms`, `fillCarrierBagDelete`,
  `buildClassRetainedDelete`. Successful deletion suppresses the base fact;
  rejected deletion changes nothing.
- Direct static stores in `expressions/assignment.ts`,
  `expressions/operator-assignment.ts`, and `expressions/unary-updates.ts` must
  respect override/deleted state. Re-add presence only after a successful write.
- Corresponding static reads in `property-access.ts` and dynamic runtime reads
  must not expose stale globals after an override/deletion. Keep existing global
  access as the genuine live-base fast path.

This is why a presence-only positive table is insufficient.

## 5. Reservation, proof, and stop conditions

Reserve dependencies from `ensureObjectRuntime`; fill after class discovery in
**both** `generateModule` and `generateMultiModule`. Final own-field filling must
not mint late dependencies or retain stale indices.

Minimum acceptance:

- All three unchanged original class-expression fixtures.
- Constructor/prototype/instance and alias distinctions; derived and same-layout
  unrelated classes.
- Public-prefix/private collisions.
- Static initializer-free/undefined fields, repeated definitions, static-block
  ordering, abrupt initializers and untaken branches.
- Delete/re-add, data↔accessor redefinition, nonconfigurable refusal,
  nonextensible existing-versus-new properties; getters must not run during
  own queries.
- Direct, stored and borrowed own-query spellings, with generated-route evidence.
- Unchanged original176 pair after focused acceptance.

**Stop and escalate** if repeated class evaluation cannot preserve receiver/
storage ownership, or descriptor snapshots require a broader static-value
redesign. Do not substitute a compile-time census or suppress the failing route.

This is an actionable scope, but not a three-file patch. The descriptor and
direct-static-access seams are necessary to avoid purchasing three passes with
new stale-value or resurrection bugs. No implementation, tests, or compiler
execution are claimed by this specification.
