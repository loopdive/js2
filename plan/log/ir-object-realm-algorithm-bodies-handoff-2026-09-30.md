# Native Object realm algorithm bodies

Issue 3518: IR-only default and direct front-end retirement.
Claim `3518:object-realm-algorithm-bodies-20260930`, owner
`ttraenkler/codex-object-realm-algorithm-bodies-20260930`.
Isolated worktree `/private/tmp/js2-ir-object-realm-bodies-20260930`, branch
`codex/3518-object-realm-algorithm-bodies-20260930`.
Implementation base: verified main `a2546f6fc5c3fb1bff7ca95c1db365afb4c264de`.

## Implementation

Three native-runtime modules build the full instruction algorithms for:

- Object(value, NewTarget), including alternate-NewTarget allocation before value handling.
- hasOwnProperty, propertyIsEnumerable, isPrototypeOf, toLocaleString and valueOf.
- __defineGetter__, __defineSetter__, __lookupGetter__, __lookupSetter__.
- Separate get/set __proto__ accessors, including internal false-status TypeError.

The existing ten-method Object.prototype catalog's toString recipe remains in
the preserved Number integration worktree; this increment implements the other
nine, both __proto__ halves and the constructor. Every body returns a language
externref, including canonical Boolean/undefined results. Key coercion order,
GetV's original primitive receiver, partial accessor descriptors, own-data
shadowing, null prototype termination and abrupt identity are explicit.
There are no caught exceptions or silent unresolved-prototype fallbacks.

Semantic dependencies are mandatory binding contracts. Tests import complete
JavaScript controls for these dependencies and execute real emitted Wasm;
they do not authenticate native Object/Function realm providers. No public
IR grant, realm completion, migration parity or legacy retirement is claimed.
Object.prototype's owner must preserve its immutable [[SetPrototypeOf]] behavior,
despite its other ordinary object methods and extensible own-property population.

Only three actual native-runtime leaves/entries are added to compiler inventory.
All 1,718 prior file rows and ordering, signed activation records and allowed
edges are preserved. Native-runtime minimum grows by exactly three, to 89.
The existing boundary test adds those explicit unsigned additions; historical
signed composition and population receipts remain intact.

## Validation and evidence

The final strict current-source cohort passed 563/563: 214 algorithm assertions
across normal/displaced indices and all 349 boundary assertions, zero skips or
suite errors. Source TS7 passed. Seven preservation gates passed; all 6,984 input hashes
remained unchanged through final validation and controls. Normal hook and
publication receipts must be recorded alongside this tracked checkpoint.

The first run retained 200/202 with two failures in the alternate-NewTarget
assertion. Direct execution returned a distinct object with Sub.prototype and
zero reads on the hostile value proxy. Vitest's negative identity matcher
inspected that proxy; the corrected assertion checks Object.is against false.
No algorithm change or failure deletion was used to repair that instrument.

A valid-Wasm mutation deliberately boxes this before coercing the key. All four
selected coercion-order controls fail; 210 other algorithm cases are deliberately
unselected. Exact original bytes are restored afterward. Fresh-process census
executes all 12 bodies, with 12 matched rows, 18 modules/14 source modules and
zero TypeScript/frontend modules. Actual forbidden frontend/TypeScript probes
each exit 2 with one blocked resolution and zero emitted modules. This is
algorithm emission with imported controls, not public prepared-program replay.

Independent review added 12 assertions for nullish isPrototypeOf/object arguments,
lookup key conversion/abrupt ordering and exact active-constructor identity.
Current complete receipts are in `.tmp/object-realm-bodies/reviewed/`.

Receipts remain under `.tmp/object-realm-bodies/`, including the original failure,
full reports, mutation receipts, census module records and preservation evidence.
Independent clean test262 checkout is pinned at
`b363f29d3c43c626dc852744ad64a0b48a003693`, 56,970 tracked files. Its shared object
source worktree must be preserved. No hook bypass, gate weakening or force-push.

## Integrated main and normal hooks

Implementation commit `f81a8e54c33ed6153d3ccbae4145ca6e1ce8fbca` is signed;
normal hooks passed all 563 changed-root assertions without bypasses. The next
signed merge integrates freshly fetched main
`8245fc8ea121909a81d98cce003340c7c55e1296`. Its sole conflict is the boundary
test additions: preserve both the three Object bodies and the delivered
runtime-contract JavaScript value-tag leaf. Source String-key implementations,
all corresponding regression tests and original signed inventory receipts remain.

String-key PR6352 is delivered as `82b63dab16f0a9a0edee211eba9a92db346e927c`:
exact head ancestry and seven scoped blobs are verified on main, with all 102
actual conformance shards, final regression gate, CI, CLA and differential
merge-group workflows passing. Its slice claim completion was verified upstream.
ABI PR6353 is merged as `9fb5ecccffc2e37c37db5972b336f0037cb837fe`; complete
protected/content evidence belongs in the publication receipt before delivery
is declared. The broader ABI/Number claim remains active.

## Required continuation

Reuse `native-closures.ts` authenticated root/signature/metadata tokens. Do not
create an unrelated builtin closure root: native invocation currently admits
descendants of the source-closure root only. Add an authentic builtin invocation
entry that supplies hidden this before ordinary arguments; public .length excludes
this and is separate from padded physical arity.

Materialize function singletons, actual name/length property behavior, their
Function.prototype link and closure-to-own-property-bag routing. `$bag` is own
property storage, not [[Prototype]]. WasmGC can canonicalize otherwise identical
metadata types, so family ref.test requires exact bfnid matching. Canonical header
indices are func=0, arity=1, bag=2, deleted metadata bits=3, metadata id=4.
`nativeClosureMeta` has no live readers; legacy builtinFnMetaByTypeIdx and its
runtime readers currently own reflection. Do not infer completed property
semantics from reserved metadata types or descriptor-only seeder receipts.

Then close Object/Function realm construction and all required semantic operations,
bind these bodies through physical owner/ABI/consumer joins, and execute the
unchanged public Number fixture returning 712 in original/decoded views and both
string encodings without host imports or frontend replay dependencies. Preserve
all 56 Number pending paths and original nine acceptance cases/22 primitive proof
assertions in `/private/tmp/js2-ir-public-number-712-20260928`.

Only exact-head ancestry, actual merged content and protected merge-group checks
prove delivery. Keep this slice claim active until delivery is verified. The full
IR migration goal remains incomplete; legacy stays operational until everything
in the IR path is tested and equal. No scheduled polling watcher is installed.
