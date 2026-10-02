# 5753: coherent descriptor authority after blocked guard v1

Source-only implementation specification for Huygens, relayed by parent. No
compiler/test execution, production edits, or integration approval accompanies
this document. Base inspected: codex-5753-own-field-guard-20260927 at a10b.
Read the entire v1 blocked-write-authority handoff. Preserve v1 and all receipts.

## Decision and scope

Do not activate v1. A bag-negative read cannot distinguish a constructor's
default instance-layout slot from an actual successful write to that slot.
Nor can a new presence bit solve this without closing the same writer inventory.

Use one ordinary descriptor table for each positively authenticated local class
constructor/prototype value. Reuse the existing identity-keyed closure bag for
class-layout carriers; an original prototype already represented by Object uses
that Object's own table, NOT an additional bag. The table is the value/descriptor
authority, not a cache. Keep carrier identity/layout and genuine instance storage.

This is a larger but finite atomic change than the three-predicate guard. Static
fields, methods, accessors, and intrinsics cannot remain independent authorities
for activated receivers. Their existing producers must install into this table;
their typed consumers must consult it. Otherwise delete/redefine remains split.
Do not implement static fields as public accessor descriptors over old globals:
that changes gOPD's data-property shape. Do not maintain two writable copies.

Scope is the current local allocation-owned constructor/prototype globals, not a
total classifier. Match real non-null identities; unmatched values retain legacy
behavior. Never brand an instance merely because it becomes F.prototype. Preserve
the existing repeated-class-evaluation behavior as a separately recorded defect;
this slice does not fix allocation freshness or certify foreign/raw-funcref roles.
If a reachable local producer overwrites an allocation global with another value,
its lifetime must be closed before activation; current-global matching is not a
historical identity registry.

## Shared owner APIs (new small class-property-authority module)

Reserve fixed-signature runtime helpers before any source call can reference
them. Fill identity dispatch once, after local class globals are registered.

- `classPropertyOwned(receiver) -> i32`: exact positive identity only.
- `classPropertyTableLookup(receiver) -> externref`: existing Object table or
  existing closure bag, lookup-only. Null is a table absence, NOT Unknown.
- `classPropertyTableEnsure(receiver) -> externref`: mutation/producer only;
  requires an owned receiver and returns its one Object table.

Keep Owned separately from table/key absence. Callers branch on ownership first;
an owned miss may continue the proper prototype lookup but must never re-enter
instance-field lookup. No magic public role key, independently mutable role bag,
or new value cache. Use existing arena/index registries and relocation traversal.

Operations take original receiver separately from storage owner:
`Get(owner,key,receiver)`, `Set(owner,key,value,receiver)`; own descriptor,
HasOwn, PIE, DefineOwn, DeleteOwn, and own-key enumeration use the same table.
These are semantic API contracts, not claims that all current helper signatures
already support them. Preserve Object/Reflect return conventions and strict Set
failure handling at their existing adapters. A valid undefined/null value is not
a miss sentinel. Own predicates and descriptor inspection never invoke getters.

## Reuse and required adaptations

Existing anchors:

- carrier-bag-visibility.ts:476–621 supplies reserve/fill, lookup and own presence;
  closure-props.ts:669 onward supplies identity lookup without allocation.
- object-runtime.ts:10361–10402 already demonstrates bag Get with original
  receiver via \_\_reflect_get_receiver. Reuse its receiver discipline, not a call
  to generic Get on the bag with the bag as this.
- object-runtime.ts:3360/3594 contains **extern_set_decide and **extern_set_own.
  They are gated by inheritedSetRuntimeActive. Class-authority demand must reserve
  the required helpers explicitly before construction; do not set unrelated dirty
  flags or infer readiness from funcMap presence. Extract their ordinary descriptor
  core if needed, preserving old callers and gates for unactivated modules.
- carrier-bag-define.ts:351 substitutes the bag into existing descriptor appliers;
  keep the original receiver/result and its extensibility state separate. Its
  intrinsic seeding cannot reseed deleted/redefined class properties.
- carrier-bag-delete.ts:527 onward currently has class tombstone behavior.
  Authenticated property-table deletion must use ordinary descriptor deletion,
  NOT create an instance-field marker. Instance tombstones remain unchanged.

Table Object.proto must not become a second mutable public prototype authority.
On misses use the original receiver's actual prototype chain. Existing Set's
explicit/implicit chain code must be adapted where it cannot traverse the class
constructor/prototype chain with that receiver. Do not silently substitute
Object.prototype or the instance's prototype for the constructor's parent.
Reflect.set with a distinct receiver is a separate algorithmic case: inherited
descriptor lookup is on target, assignment/creation is on receiver.

## Implementation stages and ownership

Stages are reviewable coding partitions; activate only their coherent union.
Huygens owns coordination of this slice. Parent retains source integration/tests.

1. **Authority/provider core.** New class-property-authority.ts; targeted runtime
   helper extraction from object-runtime.ts; registration/finalization in both
   index.ts pipelines. Reserve before source emission, fill before final consumers
   are frozen. No placeholder false/undefined can stand in for missing authority
   on an activated receiver. No helper-body rebuilding or late import repair.
   Deliver exact helper ABI and owner-table readiness contract first.

2. **Actual producers, not query-time reconstruction.** expressions/extern.ts,
   class-proto-object.ts, class-static-sidecar.ts, class-expression-static-init.ts,
   class-bodies.ts and class-member key installation paths. Keep current carrier
   allocation identity; associate its table before any seed can reenter/escape.
   Seed constructor name/length/prototype and prototype constructor once at their
   actual initialization points, then methods/accessor halves and static fields
   in existing source evaluation order. Evaluate computed keys and RHS once.
   Do not replay them on a read or force a lazy sidecar while inspecting ownness.
   Static sidecar producers must target the same table, not copy a finished bag.
   Existing static globals may remain temporary construction operands only after
   ALL active value readers/writers have moved; no post-publication authority.
   Preserve class-binding TDZ and publication-before-reentry semantics explicitly.

3. **Competing writer/reader closure.** Mandatory owner file inventory:
   closed-struct-extern-set.ts; member-set-dispatch.ts; member-set-f64.ts;
   member-set-inline-ic.ts; fnctor-typed-reads.ts; expressions/assignment.ts;
   expressions/operator-assignment.ts; expressions/unary-updates.ts;
   expressions/static-callable-field.ts; property-access.ts;
   property-access-dispatch.ts; class-proto-lookup.ts;
   standalone-linked-static-inheritance.ts; object-runtime.ts and its descriptor
   and enumeration builders; carrier-bag-define/delete/visibility.ts;
   instance-tombstones.ts; object integrity and Reflect adapters.
   This is a bounded owner inventory, not permission to rewrite all these files.
   For each direct physical/static operation record: guarded, delegated, or proven
   unreachable for an owned value, with the exact source reason. Guard before
   physical field coercion so a general JS value is not truncated to the instance
   slot's type before storing. Retain evaluated receiver/key/RHS locals; do not
   compile operands twice. Compound/update retain Get/ToNumeric/Set order and
   prefix/postfix result; method calls preserve original this. Audit generated
   getters/setters and specialized callsites as well as generic helpers.

4. **Atomic operation cutover.** For owned values, route all own queries and
   mutations to the table, including missing keys. Remove physical-slot fallback
   in Get, ownness, gOPD, keys and delete; Has/Get misses continue actual inheritance.
   PIE reads FLAG_ENUMERABLE from the found live descriptor. Define merges partial
   descriptors and honors nonconfigurable/writable/accessor rules. Set rejects
   nonwritable data or getter-only accessors, calls setters with original receiver,
   and allocates a bag only for permitted own creation. Extensibility belongs to
   the receiver; table allocation does not make a nonextensible receiver extensible.
   Delete returns true for absent keys, false for nonconfigurable keys, and never
   resurrects a deleted intrinsic via lazy seeding. Key enumeration exposes only
   actual descriptors in JS order, not storage slots, globals, or hidden metadata.
   Remove v1's exception “bag hit means use physical arm”: it is incompatible
   with descriptor flags and non-enumerable redefinition.

## Explicit source blockers to resolve during implementation

The current static sidecar omits fields and excludes some receiver-using accessors;
it cannot simply be declared the full table. Receiver-aware accessor trampolines
must accept the actual constructor, not cast its table to the class layout.
Direct static globals and constant metadata folds cannot survive deletion or
redefinition on owned values. Runtime-computed members must join the same table,
not cause the repair to opt out. The existing conditional Set providers and their
class-chain traversal require actual reservation/receiver closure. These are
required coding work, not opportunities to replace unknown with success/absence.

Do not fix these by changing every class to an Object carrier: construction,
instanceof, tags and foreign ABI rely on existing representation. Do not silently
expand this into repeated-evaluation freshness or full role-authority migration.
If an owner edge cannot fit this table contract, report its concrete callsite and
representation conflict; preserve the failing source rather than add a fallback.

## Acceptance / receipts (parent owns execution)

Keep all176 original sources and complete row results against immutable a10b and
the original main baseline. Preserve all129 original losses,13 gains and shared
failures in the ledger; count recovered and remaining rows individually. No source
exclusions, expected-value changes, swallowed failures, or retirement claim.

Keep the exact69 native +69 compiled v1 countercontrols, including their original
names; annotate that “bag add” was a source scenario, not a proven storage route.
Add bounded controls for dynamic and typed aliases, all competing writer forms,
zero/null/undefined/wide/object values, actual reads and gOPD flags, PIE/keys order,
getter/setter this+call counts, throwing accessors, data/accessor conversion,
partial redefine, delete/recreate, strict/sloppy refusal, Reflect.set's distinct
receiver, preventExtensions/seal/freeze, inherited shadowing, computed duplicate
members and static blocks. Include constructor/prototype alias identity and a real
instance assigned to ordinary F.prototype. Retained repeated evaluations remain
separate unchanged-failure controls; do not attribute all129 losses to freshness.

Route-positive evidence must show no class physical-slot write/read for owned
keys after activation, real descriptor updates, and no bag allocation on queries
or rejected Set. Exercise both compiler pipelines and preserve nonowned instance,
fnctor, builtin, host and linked routes. Pure helper tests are not that evidence.
Run original cohorts unchanged before declaring the bounded repair acceptable.
