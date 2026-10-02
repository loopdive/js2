# V1 BLOCKED: successful physical constructor writes have no bag-presence receipt

This supersedes any preservation implication in the v1 source-review handoff.
V1 is NOT approved for activation/integration. No production code was changed
during this investigation, and no compiler/native/tests/typecheck ran.

Preserved source-v1.patch SHA256:
856b50c4accd5c41721043d5ca08c2fb44b6c76160a95d8e53d59dc77f6041eb
Preserved inventory-only-v1.patch SHA256:
f756b31acec9c177ae72c4b8b2be7db7521a68977da254a31f4bd952db16c44a
Preserved helper SHA256:
3c1e317ace252c03282dfc493aaf2b67d82ca09f3faa74b1eea370f23d5ca1d6

All anchors are in the owned a10b-based worktree. Writer code is unchanged from
exact a10bf6c3d1f129604c43c834a492db54a6ec93a2. These are SOURCE findings;
emitted route/results for the countercontrols have not been measured yet.

## Confirmed writer/read mismatch

1. expressions/assignment.ts:4627–4674 handles a direct class property write.
   A declared static accessor/global takes its own authority; an undeclared
   static key falls through to compilePropertyAssignmentExternSet. Thus the
   test source `class C { foo=1; } C.foo=2` is not proof of a bag write.
2. closed-struct-extern-set.ts:156 fillClosedStructExternSetArms prepends the
   dynamic write ladder. At182–209 it collects exposed MUTABLE physical fields
   (not constructor vs instance roles). buildStore at302–321 casts the matched
   receiver, struct.sets the field, optionally sets an existing presence bit,
   clears a tombstone, then publishes success and returns. Receiver arms at
   451–471 discriminate by physical type/shape, not constructor identity.
3. untombstoneInstrs at110–147 either invokes the existing resurrection helper
   or LOOKS UP a bag and clears a marker if one exists. It does not ensure a bag
   on a bagless receiver. Success at274 records the operation result, not a
   persistent own-property-presence fact for that receiver/key.
4. Consequently, v1's new guard can encounter a real successful physical
   constructor write, known singleton identity, no declared static overlap,
   and no bag entry. It suppresses the arm that previously reported that own
   property. Empty bag does not prove absence of a physical write. This is a
   concrete source-level preservation counterexample, not an observed paired
   runtime delta yet.
5. object-runtime.ts:10201 fillClosedStructExternGetArms still includes physical
   fields. Bag descriptor precedence at10361–10402 runs only on a bag hit;
   otherwise the physical read/box route remains. Ownness can therefore diverge
   from a retained physical value under v1. Do not infer absence from a default
   slot value: writes of0/undefined/null are real properties too.

## Delete/redefine are separate authorities

- instance-tombstones.ts:296–318 deletion ENSURES a bag and records a marker
  keyed by the original receiver; the read-only deleted predicate starts320.
  The global class-carrier screen is structural, so constructors are not
  excluded by role. Existing own-field tombstone prelude must remain intact.
- carrier-bag-define.ts:309 defineCarrierBagEnsureInstrs and350 onward
  defineCarrierBagSubstitutionArm can install actual descriptor entries into
  the shared bag. This is a different route from ordinary physical assignment.
- object-runtime.ts:10361 bag GET precedence honors real descriptors with
  original-receiver accessor binding. No bag hit means no such override.
- object-runtime.ts:4571–4620 PIE's base non-Object branch returns false, whereas
  its physical-field prologue returns true. Merely redirecting writes to a bag
  without fixing the descriptor-aware PIE route is not a coherent correction.
  Conversely keeping the old physical arm on a bag hit is NOT proof that a
  non-enumerable redefinition now reports correct PIE.

The tests named 'constructor bag add/delete/redefine' are syntactic scenarios,
NOT authenticated bag-route assertions. Keep their exact sources and expectations
for pairing; do not rename the mistake into a claim that the path was measured.

## Is there an existing sound exclusion?

No useful complete per-key physical-write absence authority was found in the
inspected compiler context. In particular inheritedSetAffectsKey/
inheritedSetAnyDirty (inherited-set-gate.ts:37–47, context/types.ts:1905–1933)
track suspicious DESCRIPTORS, not ordinary writes. array-holes.ts:144–160 feeds
that descriptor analysis. A plain `C.foo=2` need not dirty foo; using a clean
descriptor flag to activate v1 would be unsound.

numericPropertyNames/stringPropertyNames/booleanPropertyNames classify VALUE
types of definitions/writes, not whether a receiver was ever written. A known
field mutable bit establishes write capability, not absence of writes. The
operation-result global holds only the latest Set outcome and cannot answer a
later receiver/key query. Existing tombstones establish deletion, not initial
materialization. None may be repurposed as ownness evidence.

An extremely conservative source exclusion could retain the old arm whenever
the receiver layout/key admits ANY physical writer. That protects this route,
but is not complete without typed/member-set/define/direct-allocation coverage.
For ordinary mutable class foo it would reject the proposed repair itself;
do not present that no-op as resolving124 class losses. No such exclusion was
implemented. A new whole-program no-write proof would need direct, aliased,
computed, compound/update/destructuring, Reflect/Object.assign, callbacks,
dynamic code and linked-provider writes; unknown must retain. That is new
analysis scope, not an existing sound flag.

## Smallest coherent repair direction for architect review

Prefer one actual property authority for ad-hoc properties of the recognized
constructor/prototype receiver, rather than mirroring a physical value:

1. For the same narrow authenticated singleton/key domain, divert writes BEFORE
   physical struct.set to the existing descriptor-aware Set/bag own-store path.
   Preserve callee/receiver/key/RHS evaluation, conversion order, rejection,
   result channel and accessor receiver. Missing write authority must decline
   the repair, not report successful storage.
2. Every competing writer that can receive those values must share that policy:
   closed-struct-extern-set.ts, member-set-dispatch/typed twins, and direct
   assignment paths need an explicit route audit. A singleton exclusion only in
   dynamic Set leaves typed aliases able to create untracked physical properties.
3. Queries/reads must use that SAME store and descriptor flags. Bag hit is
   authoritative; misses for recognized non-instance receivers must not invent
   properties from physical instance slots. Preserve declared static/intrinsic
   overlap routes. PIE needs a real bag-descriptor read; hasOwn's boolean bag
   predicate is insufficient. gOPD/keys/delete/redefine must agree.
4. Keep actual instances' physical storage untouched, including instances used
   as ordinary function.prototype. No public key used as role marker. No copied
   value cache. Existing constructor/prototype singleton identity remains a
   bounded positive match, not a total class-role classifier.

This expands writer/read ownership beyond the approved own-predicate-only hunk
and therefore requires explicit architect/parent review. It may be larger than
the original repair; the source evidence does not support a smaller useful
presence-only fix with the current authorities. Tracking a new write-presence
bit would also require ALL successful writers/delete/define transitions; it is
not a free alternative and is not proposed as an already-complete solution.

## Next measurement proposal — NOT a slot grant

First pair the EXACT already-authored add/delete/redefine constructor scenarios
against exact a10b and preserved v1. Keep scenario names for artifact identity,
but label their storage route unproven until emitted WAT confirms it.

Scoped selector within issue-5753-class-own-field-runtime.test.ts:
`standalone: constructor bag (add|delete|redefine)` selects9 compiled cases
(3 operations ×3 predicates) per arm. Native selector for the same scenarios
selects9 independent strict-native cases. Parent chooses/grants the sequence;
no execution starts implicitly. Copy only the additive test source to an isolated
baseline; do not edit the immutable pair or revise native expected booleans.

Capture first compile/link/init/probe failures and actual emitted store/return,
bag lookup and predicate routes. Follow-up readback/gOPD/value/rejected-write
controls would be additive and require a separately approved bounded batch;
the existing ownness-only tests do not supply those measurements.

Original176/129 losses/13 gains/full errors remain the acceptance gate. No
repair, preservation pass, or activation claim from source analysis alone.
