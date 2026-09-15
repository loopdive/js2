# PR5753: narrow class native-own repair and paired callsite evidence

High specification, 2026-09-15. Production is unchanged by this document.
Only the public-slot **producer-only** prerequisite has parent implementation
approval. Constructor suppression, runtime static presence, and consumer
activation remain unreleased. This is not a general class reflection rewrite.

## Exact population and baseline

Failed composition: `cb07815129e65312bc8f02675644146318e1ce49`.
Actual first-parent control: `e9b43d3325352435aa7f84185ccb308c52ab909b`.
The measured predecessor `d6de81ced13f27930c83980e498a510e044435cd`
differs from e9 only in nine benchmark artifact files.
Pinned Test262: `b363f29d3c43c626dc852744ad64a0b48a003693`.

The original population has 48,735 identical unique paths, 137 host-free losses
and 31 gains, net -106. The 124 class-own assertion rows are a triage group, not
124 dynamically isolated instances of one mechanism.

Parent's original-CI-harness, fresh-bundle Node22 paired execution:

- Candidate session57639: exit1, 0/3, exact original CI errors.
- e9 control session94433: exit0, 3/3.
- Candidate log:
  `/private/tmp/js2-5753-queue-failure-20260915/.tmp/5753-candidate-class-original-harness.log`.
- Base log:
  `/private/tmp/js2-5753-floor-base-20260915/.tmp/5753-base-class-original-harness.log`.

This establishes an actual regression; do not dismiss the base passes as
vacuous. Local Node22 is not CI Node25.9.0 parity.

The three unchanged class-expression fixtures are:

1. `language/expressions/class/elements/multiple-definitions-private-field-usage.js`.
2. `language/expressions/class/elements/redeclaration.js`.
3. `language/expressions/class/elements/field-definition-accessor-no-line-terminator.js`.

Fixture3 declares instance `accessor` and `$`, and static `accessor` but no
static `$`. Its required positive `hasOwn(C, "accessor")` must survive. The word
`accessor` is a field name here, not evidence of a getter descriptor.

## Paired WAT receipt: actual failing callsite, not helper counts

Both successful diagnostic compilations use the first original fixture with
its original assembled harness. No `trackIrOutcomes` option was enabled.
The retained script records `allowJs`, `fileName: test.js`, source-map options,
`skipSemanticDiagnostics`, standalone target, automatic semantic providers,
and `emitWat`. The script itself is the options receipt.

- Source SHA256:
  `1fce5f238f0df904c433526eaccf7efae5e5afbc6c58b6ce44a3a2a588bc2609`.
- Assembled source SHA256:
  `27530f8ac790b2edac5fd7260a9157129483a2e9e71e7f5d45df43d51cb82987`.
- Both imports lists are empty. Candidate 461,778 bytes; base 459,328 bytes.
- Candidate session26598: terminal0. Base session96653: terminal0.
- Candidate WAT:
  `/private/tmp/js2-5753-queue-failure-20260915/.tmp/5753-class-route-wat-ci-options.log`.
- Base WAT:
  `/private/tmp/js2-5753-floor-base-20260915/.tmp/5753-class-route-wat-ci-options.log`.
- Script in each tree: `.tmp/5753-class-route.mts`.

These logs contain NUL characters: use `rg -a`. Zero imports permits defined
function ordinal lookup; the positive control resolves base ordinal219 and
candidate ordinal222 to `__hasOwnProperty`.

Both `__module_init` bodies contain eleven direct native hasOwn calls and both
chunk0 bodies contain four. Those counts concern initialization scaffolding;
they do **not** locate the original assertion.

The decisive site is the third `assert` call in `__module_init_chunk_1`:

- Base line151265: preceding constructor initialization is followed by
  `i32.const 0; i32.eqz; global.get 614; extern.convert_any; call 118`.
  The own query is folded false.
- Candidate line152436: preceding code materializes global544 from
  `ref.func 515`, passes receiver global31 and key global613, loads its callable
  field, checks/casts to type113 and executes `call_ref 113`, then negates and
  calls the same assertion with message global614.
- In BOTH logs global31 is `__class___anonClass_0`; global613 decodes to `foo`;
  global614 decodes to the exact original message
  `foo doesn't appear as an own property on the C constructor`.
- Candidate reified function515 starts at line137518, performs ToPropertyKey,
  then the nullish-this check, then calls native222. Native222 starts at
  line65634. Thus the actual failing assertion changed fold -> reified native
  own query. A direct `Function.prototype.call` wrapper invocation is not
  required by this evidence: the site calls the hasOwn closure directly.

This establishes ONE assertion's exposure, not all three fixtures or all124.
It does not isolate which changed compiler selector made the site choose that
route. `array-object-proto.ts` reification and `calls-closures.ts`'s broadened
`callablePropertyRefBridge` remain distinct source changes. No blanket bridge
revert or disabled real builtin is justified.

The earlier tracking-enabled `.tmp/5753-class-route-wat.log` failed with
`duplicate-direct-function-body-receipt` for anonymous-class methods. Preserve
that failed probe separately; it supplies no selector evidence. Both successful
WAT logs also retain the warning about `$DONOTEVALUATE` IR typeIdx189 versus
legacy51 fallback. Neither warning nor failed instrumentation waives the actual
original regression. No execution was repeated by High for this inspection.

## Concrete source owners and boundaries

All source locations below were read on the cb composition / cb-based tree.

- `expressions/extern.ts::emitLazyClassObjectGet` allocates the constructor
  using the instance class struct and stores its actual externref singleton in
  `classObjectGlobals`. Layout/type equality therefore does not prove instance
  semantics. Do not replace this representation: construction/tag users exist.
- `object-runtime.ts::fillClosedStructHasOwnArms` (~9254) currently infers own
  fields from `ref.test` plus physical slots/presence metadata. Its targets
  include own predicates and a distinct HasProperty mode. Keep their different
  tombstone/miss behavior; do not turn an `in` miss into final false.
- `object-runtime.ts` (~4450) -> `bagHasIfAbsent` ->
  `carrier-bag-visibility.ts` consults only actual identity-keyed own bags.
  It does not consult `staticProps`. Constructor exclusion alone is unsound.
- Existing class-name arms (~430) demonstrate actual `global.get`/`ref.eq`
  identity testing. Use actual `classObjectGlobals` and `protoGlobals`, not a
  name/type heuristic. An already materialized `$Object` prototype retains its
  own descriptor route; do not blanket-return false for prototypes.
- `struct-field-exports.ts::isInternalStructFieldName` (~865) uses prefix plus
  `structInsertionOrder`. That map serves object-literal ordering and multiple
  export/enumeration consumers. Do not populate it merely to unhide class `$`.
- `class-static-sidecar.ts` deliberately omits static fields and some
  receiver-reading accessors. `class-static-metadata.ts` provides syntactic
  metadata, not live field existence. Neither is a complete static-own owner.

## Released prerequisite: public-slot provenance only

Wegener owns `class-bodies.ts`, `class-layout-registration.ts`, a new
`class-field-provenance.ts`, one additive test, and parent-authorized handoff.
This document is High-owned until its completion handoff. No runtime consumer,
IR schema, context-wide flags, or `structInsertionOrder` changes.

Record source observations against the actual completed physical type and
actual FieldDef objects, scoped to the compiling context. Capture public
nonstatic field declarations and existing admitted public constructor
this-assignments; distinguish PrivateIdentifier and compiler-generated slots.
Observe skipped duplicate/parent-slot declarations too, not just first mint.
Inherited FieldDef references preserve their provenance, while each layout's
observations must not contaminate a sibling. Public/private/synthetic aliases
of the same physical slot are explicitly ambiguous, not first/last/public wins.
Same-name replacements, foreign contexts and removed fields cannot inherit
authority. No new runtime presence is inferred from this source fact.

Tests cover `$`, `__public`, private/mangled-looking public names, duplicate
observations in both orders, inheritance/skipped parent slots, synthetic slots,
foreign/replaced layouts and absent membership. Compare representative complete
compile output exactly with cb: binary/imports/exports/types/functions/globals/
bodies unchanged. Existing original failures remain. Speculative rollback
retains registered types; metadata must follow actual retained/current ownership,
not an invented rollback or persisted receipt.

## Proposed coherent native-own design: unreleased

The smallest sound semantic scope is **native own existence**, with a
presence-only producer for static definitions. Do not copy static values into a
parallel table, turn data properties into accessor descriptors for convenience,
or redirect all class operations to the incomplete static sidecar.

1. Classify constructor/prototype identities before interpreting an instance
   slot. For a constructor, query actual own metadata/bag plus live static
   definition presence. For an instance, use public slot provenance with the
   existing shape/presence/tombstone rules. For an ordinary prototype object,
   leave actual descriptor lookup intact. Exact identity misses must fall through,
   never claim a structurally similar receiver is that constructor.
2. Presence is runtime state keyed by the **actual evaluated receiver** and
   actual property key. It contains no user value. Field existence starts only
   when that definition completes successfully, including no-initializer fields
   and definitions whose value is undefined. A compile-time `staticProps.has`,
   nonzero global, declaration name, or latest singleton index is not that state.
3. Storage reservation and evaluation events must separate. Today
   `class-bodies.ts:2050` skips an already registered static key and records
   events only for initialized fields. Preserve one backing storage allocation,
   but retain every actual source definition event, including redeclarations and
   absent initializers. Use its PropertyDeclaration as an anchor; no fabricated
   source initializer is needed to make a timeline entry exist.
4. Actual event owners are `class-expression-static-init.ts`, module declaration
   timeline emission in `declarations.ts`, and nested declaration emission in
   `statements/nested-declarations.ts`. Extend their existing entry contract in
   `context/types.ts`; do not create another class-evaluation pipeline. Expression
   aliases still evaluate each source initializer once and retain current backing
   global resolution after late shifts. A field's presence update follows its
   successful initializer/store, before the following source static block. It
   must not execute in untaken branches or after an abrupt initializer.
5. Standard constructor keys and static methods/accessors are not instance data
   slots. Preserve existing descriptor ownership and source installation order;
   own checks must not execute getters. Do not manufacture live method existence
   solely from a static field census, or confuse a field named `accessor` with a
   getter. No full descriptor serialization/enumeration implementation is needed.
6. Mutation closure is mandatory before exposing new presence: successful
   deletion removes the own fact; redefinition/re-add creates it only after
   success. An actual own-bag descriptor overrides a declaration-derived base
   fact; a deletion marker suppresses it. Queries use own lookup, not inherited
   `__extern_get`, so they cannot invoke a getter to discover presence.
   `instance-tombstones.ts` already writes receiver-bag identity markers for
   class carriers, and `carrier-bag-delete.ts` consults this path. Reuse their
   actual semantics where proved; do not assume these approximate instance
   predicates or marker-clearing behavior suffice for static fields.
7. Typed static writes currently bypass bags through `staticProps`:
   `expressions/assignment.ts` (~4576,4614,5622),
   `expressions/operator-assignment.ts` (~2631), and
   `expressions/unary-updates.ts` (~146,168). A presence-only design must account
   for successful creation after deletion through these admitted routes. Merely
   teaching declaration initialization would freeze stale absence after re-add.
   Do not silently add an entry when a nonwritable/nonextensible write failed.
8. Aliases and repeated evaluation must follow actual receiver identity. Existing
   constructor-singleton or static-value lifetime defects are not permission to
   attach a new true fact to the wrong object. Record paired behavior; stop the
   semantic release if this needs a representation redesign outside the bounded
   owner, rather than globally freezing or excluding these programs.

### Remaining implementation decision, not claimed solved

There is no demonstrated complete existing runtime static-presence service to
call. A proposed new presence-only owner must specify its actual reservation,
allocation, identity lookup, definition update, deletion and re-add operations,
and their placement before finalized helper consumers/DCE. A separate runtime
presence record is not a second values store, but it is still real new mutable
state requiring the mutation closure above. Do not approve an opaque generic
registry wrapper or ad hoc positive table without those links.

Before parent releases the next writer, pin the existing delete/defineProperty/
typed-readd paths with focused emitted-body evidence and choose either a genuine
reuse of their own state or an explicit presence-only record integrated with
them. This is a finite source/producer obligation, not a request for user
approval of every routine step. It is not yet a safe one-file suppression fix.

## Dependency-first write releases and controls

Release P is the approved producer-only four-file slice above.
Release E is focused test/evidence for runtime definition and mutation owners;
no new consumer truth yet. Release S, only after its write-set is reviewed,
combines definition/mutation presence with exact native constructor handling and
the provenance consumer. Internal commits may separate dependencies, but no
suppression-only checkpoint may be presented as the repaired semantic result.

Do not interpret the source-owner list as a blanket authorization to edit every
file. Each subsequent write-set must name exact required producer/mutator hunks;
keep initialization mechanics in their existing owners, and a genuinely shared
small emitter may factor duplicated mechanics only with equivalence controls.
No allowances, compressed code, comment removal, verifier demotion, new imports,
guard filtering, fixture edits, or broad snapshot refresh.

The acceptance matrix retains all original fixtures and adds native own checks
for instance/constructor/prototype, static-only and same-name static+instance
fields, own undefined, public `$`/`__` versus private/synthetic, inherited versus
own, source-order static blocks, initializer self-observation/throw, uninitialized
fields, duplicate definitions, deletion/redefinition/re-add, aliases and repeated
evaluation, and getters with a throw/counter proving own checks never call them.
Use both direct and stored/reified own predicates, O0/O2, zero host-import growth.
Preserve ToPropertyKey-before-nullish-this order at the reified hasOwn boundary.

gOPD/gOPN/Object.keys/propertyIsEnumerable and static reads/writes are paired
preservation probes, not a demand to fix every existing MOP limitation. Pin each
base/candidate/fixed result and failure phase; require no new regression and
retain old failures explicitly. Changes intentionally required for native own
truth must be named individually. No wholesale golden refresh. The 124-row
population and whole queue floor remain unwaived until actually measured.
