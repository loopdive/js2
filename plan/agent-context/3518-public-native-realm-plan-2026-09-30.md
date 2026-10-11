# Public native realm and Number integration

Independent Astra planning, 2026-09-30. The parent issue is
[3518 — IR-only default and direct front-end retirement](../issues/3518-ir-only-default-and-direct-frontend-retirement.md).
The user requires development and complete tested parity before retiring the
legacy compiler. This plan preserves the original public 712 fixture and all
failures. Passing prerequisites do not finish the responsibility.

## Current evidence and missing bindings

The preserved Number integration at `8245fc8e` measures 5/9 original tests: the
source oracle and four legacy lanes pass; all four native original/decoded ×
UTF-16/UTF-8 cases refuse. Seven physical gaps represent three unique functions
plus four call-site references. The missing functions are:

| Binding | Signature | Required semantic owner |
| --- | --- | --- |
| `js.object.create-default` | `() → externref` | allocation using actual realm Object.prototype |
| `js.object.define-accessor` | `(target,key,getter,setter,f64 mask) → void` | descriptors, callable validation and canonical exception authority |
| `js.number.from-value` | `(externref) → f64` | complete Get, ToPrimitive, invocation and conversion graph |

The storage createDefault leaf has an unresolved implicit-prototype marker;
binding it directly would conceal missing behavior. Existing object Get
returns status/value and does not provide Number's complete scalar Get ABI.
The builtin kernel's realmReady remains zero. Its bounded property walker
requires an effectively final ordinary layout; removing that guard would
reintroduce false absence for String virtual properties.

## Dependency-first implementation

1. Issue authentic prepared-program/projection realm requirements and a
   compiler-owned catalog of constructors, members, descriptors, accessors,
   aliases, parents and body roles. Rederive during currentness and replay.
   Completed canonical population must prove default-prototype absence;
   preserve getter-return and mutation evidence. Selected Number callable
   coverage cannot grant general realm-wide callable classification.
2. Break the actual reservation cycle. Issue strings and a shared invocation
   substrate (argument-vector declarations and canonical error owner) before
   source closures. Issue builtin requests next and reserve one combined
   closure pack. Source invocation retains its local mutable state but uses
   the same vector tokens. One owner fills them. Programs with no source
   closures need authentic realm requests rather than invented source demands.
   Supplemental realm literals require an authenticated retained planner input,
   not ad-hoc appends. Shared vector/TypeError ownership and optional source
   invocation injection are the current slice; builtin/realm requests, consumer
   reordering and supplemental literal planning remain subsequent joins.
3. Give public carriers actual heterogeneous prototypes. Append an immutable
   private state reference after ordinary storage fields, wrapper payloads
   and source captures; retain all existing offsets and metadata separation.
   Native builtins retain their actual prototype field. Keep old layout modes
   intact. Wrapper/String factories must allocate their issued variants, not
   old shapes with unexplained extra fields.
4. Build one mixed property/invocation owner. At every prototype node, dispatch
   String exotic own properties first, then authentic builtin/source/ordinary
   families and follow that carrier's actual prototype. Preserve receiver and
   present-with-undefined. Unknown or incomplete carriers cannot prove absence.
   Validate full prospective prototype chains before mutation, including cycles
   and Object.prototype immutability. Invoke authentic builtins before source
   dispatch, reject unowned metadata, then dispatch source and genuine bound
   families. Preserve missing/excess arguments, exact null/undefined this and
   normal/abrupt restoration.
5. Populate the actual realm once from authenticated algorithm owners. Reuse
   real Object.prototype/Function.prototype singleton identities. Populate
   constructor links, required descriptors, aliases, accessor halves and
   transitive providers before granting public readiness. Object algorithms
   need genuine ToObject/ToPropertyKey/Get/descriptor/prototype/callable owners.
   Function requirements include call/apply/bind/toString/@@hasInstance and
   restricted properties. Function's CreateDynamicFunction is substantive
   remaining work, not a refusal stub or mere frontend inventory. Required
   statics and transitive operations cannot disappear from the catalog to
   manufacture whole-realm completion. Other epic families stay explicit.
6. Bind Number through the completed graph: scalar mixed Get/callability/call,
   primitive classifier, native StringToNumber, BigInt, well-known symbols,
   literal providers and canonical TypeError/tag. Emit a genuine adapter for
   method0(receiver,method) versus builtin call0(callee,receiver). Getter and
   method exceptions propagate unchanged. Bind each public ABI row once and
   reconcile all references with actual physical reservations.

## Canonical physical lifecycle

Derive the complete semantic/catalog census; reserve shared prerequisites;
issue builtin requests and the combined closure pack; reserve every algorithm,
source slot, mixed dispatcher, initializer and public adapter; freeze once;
bind genuine source slots/cyclic tokens; fill noncyclic leaves, canonical
algorithms and dispatchers, source bodies and bootstrap; authenticate the
whole completed graph before successful emission. Reservation authority cannot
substitute for canonical body completion. Compare canonical vector bodies and
locals, not just token completion or a private filled flag.

Root owns claim registration, issue and boundary inventory, integration and
publication. Implementers get isolated worktrees and explicit disjoint path
ownership. Preserve all 56 original pending Number files and original fixture
bytes. The armed builtin PR gets no implementation edits or further pushes.

## Required evidence

The unchanged original nine tests must pass: both encodings, original/decoded
views, two fresh instances and repeated 712 calls. Fresh decoded child replay
must block frontend/TypeScript resolution and emit zero host imports. Measure
actual mixed source/native/String inheritance, descriptors, receivers, prototype
identity/cycles, initialization reentry and abrupt restoration. Refuse forged,
copied, foreign, stale and incomplete dependencies, same-shaped metadata
collisions and externally filled wrong canonical bodies. Retain original
failures and denominators. Complete public parity is followed by all remaining
program/backend/conformance obligations; only then may old code retire.

Only verified exact-content main merges count as delivered work. Scoped gates
certify preservation, not whole compiler closure or retirement.
