# PR5748: canonical array receiver and prototype-aware indexed operations

High specification, 2026-09-15. Implementation belongs to subsequent Low slices.
Issue 5399: “Refuse concrete unsupported JavaScript runtime operations found by the audit”.

## Decision and first dispatch

This is a semantic repair, not a narrower prototype guard. There is no honest
setter-only fix. A materialized array currently loses the prototype mutation;
raw vector reads, host descriptors, membership and the second host array view
also disagree about presence. The two TypedArray originals additionally require
receiver-aware Set/DefineOwnProperty. Sequence the dependencies below, retaining
the current refusal until the implemented producer/consumer closure is tested.

**Dispatch A0 now, independently of Volta:** implement a demand-gated raw
own-index-presence bridge in the existing vector export subsystem, with real
compiled-carrier tests. Own only a new
`src/codegen/vec-own-index-export.ts`, the narrow emitter/derived-ordinal hook in
`src/codegen/vec-access-exports.ts`, and a new
`tests/issue-5399-vec-own-index-export.test.ts`. No `runtime.ts`, guard, generator,
IR consumer, fixture, or core six-bridge-table edits. Parent checks the actual
shared-file claim before dispatch; these paths are proposed ownership, not a
claim that a worker has already been started.

Proposed ABI: `__vec_own_index(externref raw, i32 index) -> i32`, with `1` for a
present raw storage slot, `0` for OOB/hole, and `-1` for an unrecognized or
unsupported receiver. It is NOT HasProperty and does not invoke a getter, look
at prototypes, or fabricate host descriptor facts. Decode `$Hole` and the exact
`HOLE_F64_BITS` marker before boxing; `UNDEF_F64_BITS`, ordinary NaN and actual
undefined are present values. Use logical length, not capacity. Recognized
non-hole-capable storage can answer from its actual dense representation;
inability to inspect a carrier is `-1`, never “absent”.

Preserve the existing core bridge ordinals 0–5, materializers 6–8, writeback 9–10.
The six-entry definition table has an explicit `length === 6` ABI assertion:
**do not add a seventh core entry**. Reserve the next unoccupied derived ordinal
(11 at the inspected head) as a separate subfamily, using the existing stable
handle and Program ABI observation lifecycle, as writeback already does. Resolve
colliding user exports by allocator/descriptor ownership, not by label. A0 must
not claim live-runtime completion: start-time publication and consumption are A1.
Demand is the selected host array-property service/host-view need, not a blanket
extra export for every numeric function; verify absence when that need is absent.

A0 exit: real f64/externref/dense-i32 carriers, own undefined versus holes,
logical OOB within spare capacity, unrelated struct, and same-labelled user
export controls; exact existing ABI coordinates retained; no acceptance change.
If the emission demand cannot yet be connected without the A1 owner, retain a
tested allocator API and name that missing connection explicitly, not an unused
production helper represented as a finished integration.

## Evidence and scope

Inspected PR tree: `/private/tmp/js2-ir-takeover-20260914.uLEULx/pr5748`, clean at
`4b9a66d730b068893d716fbff645d94b6deeff13`. Parent documentation destination is
`/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree`, observed HEAD
`c7f7252fe173749b3323543e21af707f5b095008`. Parent's native-Promise staged and
unstaged work is unrelated and untouched. No commits, pushes, production or test
edits are part of this specification.

Read Wegener's retained `.tmp/adversarial-probes.log` and
`.tmp/adversarial-array-return-solo.log` in
`/Users/thomas/Code/js2/.codex-worktrees/5748-guard-repair-20260914`, plus both
committed guard-regression/adversarial suites. Those logs show the earlier
`9bde5d2` repair emitting NaN for five newly admitted origins; their successful
observation callbacks were not correctness passes. The held head restores the
array refusals. The reported guard-filtered four-original passes and the
numeric/any NaN/undefined pair are Wegener/user evidence, not new compiler
measurements in this spec. They do not prove an installed prototype.

This review performed read-only code inspection, hashed all four original
fixtures, and executed Node-only semantic controls. All seven preserved array
source strings printed `7` under Node (7/7). Additional Node controls confirmed
prototype/return identity, own-undefined versus hole distinction, and exactly
`has:0,has:1,has:2` with no Get after indexOf's fromIndex truncates length.
No compiler or Test262 run is claimed here. In particular, no broad conformance
gain, IR emission coverage, or fully working facade has been measured.

## Actual owners and why existing helpers are insufficient

All source coordinates below refer to the held PR tree, not moving parent lines.

- `src/codegen/expressions/call-builtin-static.ts:2230`: host
  Object.setPrototypeOf crosses externref coercion and calls
  `__host_set_struct_proto`; the helper-missing branch drops the prototype.
- `src/runtime.ts:16454`: that helper immediately returns for non-Wasm receivers.
  `__make_iterable` at 17500 creates/caches a real array per import closure;
  its vec arm registers mirror-to-vector identity but fills every index, turning
  holes into present undefined. Mutating that mirror is not mutating the vector's
  language-level prototype. The current helper also silently ignores invalid
  prototype/cycle cases; do not copy that behavior into the repaired array arm.
- `src/runtime.ts:8206`: `_wrapVecForHost` is an existing, separately cached,
  live `Proxy([])` view. Its numeric Get/Has/getOwnPropertyDescriptor still use
  length, ordinary-array define/delete mostly mutate only the target, and Set
  bypasses inherited descriptors. It is a reusable owner, not a completed proof.
- `src/runtime/vec-mirror-writeback.ts`: existing mirror registry has only the
  reverse association; element snapshots erase presence. Post-call writeback
  deliberately skips conflicting reentrant length mutations. It cannot establish
  the live semantics required by fromIndex's callback, or synchronize prototypes.
- `src/runtime.ts:6851`: `_readOwnDescriptor` exposes the raw vector's in-bounds
  value as an own descriptor even for a hole. `_wasmStructHasOwn` at 4581 does
  not itself establish all vector-index presence. A value check cannot repair
  either because `__vec_get` intentionally maps hole and undefined to undefined.
- `src/runtime.ts:5566`: `_safeGet` returns directly from raw vector storage or
  returns undefined on OOB, before the user prototype. `__extern_get_idx` at
  12985 retries numeric/string Gets when the value is undefined;
  `__extern_has_idx` at 13055 retries Has and catches abrupt completions. Do not
  reuse those bodies unchanged: repeated Proxy traps are observable.
- `src/codegen/property-access.ts:6408`: numeric-hint and ordinary-any reads
  take different raw/default paths. Bounds elimination proves range, not ownness.
  `src/codegen/binary-ops-in.ts:498` answers indexed membership from length.
  `typed-lane-overlay-route.ts:63` is standalone-only, not a ready host solution;
  its undefined-based retry is also unsuitable for exact Get semantics.
- `src/ir/array-element-lowering.ts:494,526`: narrowed-i32 and general safe reads
  synthesize OOB constants. `src/ir/from-ast.ts:6342` can emit unchecked vec.get
  from a bounds proof; it truncates the key before dispatch. Conversely its
  dynamic `in` arm at 13205 already names `__extern_has` symbolically. Repair the
  shared runtime answer, and extend typed-index selection, not a second IR MOP.

## Canonical receiver contract

Use the existing raw compiler vector as storage identity V and the existing
`_hostProxyCache`/`_hostProxyReverse` plus live export slot as the canonical
host-view ownership machinery. For an ordinary compiled array, expose ONE
stable live array facade A(V), based on `_wrapVecForHost`; make the ordinary-array
branch of `__make_iterable` return that same facade, not its independent dense
copy. Keep tuple, real TypedArray, arguments and regexp-specific branches under
their existing owners. Existing brand evidence distinguishes those semantics;
neither `__is_vec` nor a TypeScript `number[]` annotation proves a plain array.

This change is made from the **first host exposure**, not only when mutation is
seen later. Switching a previously exposed mirror to a new proxy at mutation
time breaks aliases, WeakMap keys, getter receiver identity and equality. Nor
may a parallel array registry choose a different facade from `_wrapForHost`.
Existing copy/serialization APIs remain copies; they are not receiver identities.
Legacy mirror writeback stays for the populations still using genuine copies;
do not register the new live facade as a snapshot mirror that will replay writes
it has already applied.

Canonicalization unwraps only compiler-issued bridges by exact private identity.
Do not unwrap a user Proxy to its target, even if Array.isArray(proxy) is true.
Use the supplying module's live helper exports, including the module-init window;
never probe another module's same-named getter and interpret its default as data.

For prototype P, retain its language identity and expose the same existing
canonical host view A(P) when P is opaque compiled data. For a genuine host P,
including a user Proxy or TypedArray, A(P) is P itself. Install the prototype on
the live facade's backing array target and record the corresponding language
link in the existing prototype store. Neither independently succeeds: validate
first and commit the record only after the actual internal operation succeeds.
GetPrototypeOf must agree through raw aliases, facade aliases, and a host
Reflect.getPrototypeOf observation. Return the caller's receiver identity, not a
fresh wrapper. `Object.setPrototypeOf(a,p) === a` and
`Object.getPrototypeOf(a) === p` must both hold before testing inherited values.

The facade's getPrototypeOf/setPrototypeOf/extensibility traps must respect
target invariants, including null and failed mutation. Use the Object versus
Reflect entry-point distinction, rather than making the existing return-object
helper stand in for both. Reuse the existing Object/Reflect paths; do not add a
public custom builtin. Array-specific code may be extracted to one small runtime
module, but receives named descriptor/prototype/export capabilities, not a generic
context wrapper or an alternate object system.

## Shared Get / HasProperty / own descriptor contract

Normative reference: own descriptors terminate lookup even when their value is
undefined; an absent descriptor proceeds to the parent. Get carries the original
receiver to a getter; HasProperty does not read that getter. At an exotic parent,
invoke that object's internal operation, not an ordinary-descriptor emulation.
See [OrdinaryGet and OrdinaryHasProperty](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryget).

Implement a single ordinary-array own-descriptor reader and use it from both the
live facade and raw-vector property adapters. Proposed semantic interface:

```ts
// Internal contract, not a request for a new public API or emitted token.
ownArrayDescriptor(V, key): PropertyDescriptor | undefined
arrayGet(V, key, receiver): JSValue             // may throw
arrayHas(V, key): boolean                      // may throw
arrayHasOwn(V, key): boolean                    // own descriptor only
```

`undefined` in the first return position means no descriptor; `{value:undefined}`
is explicitly present. Tombstones/physical holes suppress stale backing slots,
not the prototype. Current own sidecar descriptors take precedence over backing
storage; deleting and re-adding must clear the tombstone atomically through the
existing mutation owner. The raw A0 bridge supplies only the remaining storage
presence fact. Length is its own array descriptor. A getter is not executed while
checking presence. Unknown/missing bridge evidence is an explicit unavailable
service or invariant failure, not a missing property or empty array.

On an own descriptor, Get returns its data value or invokes its getter exactly
once with the original receiver; setter-only yields undefined without falling
through. On absence, consult the installed parent with a receiver-preserving
Get. Has uses the parent's HasProperty, without a preparatory Get/gOPD scan of
that parent. For a host parent use captured Reflect.get(P,key,receiver) and
Reflect.has(P,key), preserving Proxy dispatch and exceptions. For an opaque
ordinary compiled parent use its existing authenticated descriptor/prototype
bridge, with the same receiver; an unsupported exotic parent is not silently
treated as an ordinary object. No generic `_safeGet(P,key)` substitution that
rebinds `this` to P, no depth limit that returns “missing”, and no catch-to-default
around getter/Proxy execution. Snapshotting/canonicalization must itself trigger
no user Get/Has traps.

At the language boundary, canonicalize the property key once. Numeric key 2 and
string "2" share the array-index path. String "02", "-0", fractions, negatives,
2^32-1 and symbols are ordinary keys, not truncated vector indices; numeric -0
becomes "0". Get and Has must not retry another spelling after a valid undefined
answer. Preserve key/receiver evaluation order, particularly key-before-receiver
for `in`, and do not duplicate coercion with observable hooks.

All indexed readers call this answer *before consumer coercion*. Thus inherited
7 yields 7 through both a numeric and an any consumer; a true absence produces
undefined in the value lane, and only an actual numeric conversion produces NaN.
Do not put NaN or a null marker into Get itself. TypedArray invalid-index behavior
remains its own exotic operation, including when the TypedArray is an array's
prototype; do not continue through its prototype after its terminal answer.

A compiler numeric hint or `number[]` annotation is not itself a JavaScript
ToNumber operation: an inherited property may hold a string/object. In a return,
assignment or console argument, preserve the actual value unless an independent
semantic proof justifies the specialized result. Add an inherited string and an
object-valued getter control so the 7/NaN repair cannot introduce coercion where
JavaScript performs none. For `+`, use the existing language addition semantics,
not an unconditional numeric unbox.

## Necessary write/host-method dependency, not a new Set refactor

The two TypedArray fixtures set an empty ordinary array's prototype to a real
TypedArray, assign an object to index 0, and demand an own array element, length
1, unchanged TypedArray content, and zero value coercions. Actual inherited Set
must receive the array as Receiver; the existing native TypedArray operation can
then drive the receiver's DefineOwnProperty. Do not substitute a write to P or
eager numeric unboxing. The relevant distinction is specified in
[TypedArray Set](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-integer-indexed-exotic-objects-set-p-v-receiver).

Complete the ordinary-array facade's existing define/delete/set/length traps
using `_vecDefineOwnProperty`, `__vec_set_elem`, `__vec_set_len`, sidecar flags,
and tombstones. A heterogeneous value incompatible with packed backing storage
must remain an exact own value in the existing overlay or undergo an already
supported representation transition; it cannot be silently coerced. All routed
readers consult that descriptor before backing data. Do not pretend a target-only
descriptor update changed the raw vector. Missing writeback support is explicit.
Inherited setters/non-writable descriptors and false-return/throw behavior need
controls before that Set population is admitted. Prototype mutation entry points
must preserve Object's throwing and return-value behavior; see
[Object.setPrototypeOf](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.setprototypeof).

For indexOf/lastIndexOf, the length initially read by the native method stays its
iteration bound, but after fromIndex calls back into Wasm and sets length to zero,
every subsequent Has sees the live truncated array. This excludes the old
snapshot/reconcile shortcut. Do not patch these algorithms to make the fixtures
pass: native methods over the repaired live facade already supply their sequence.

## Dependency-first integration and exclusive ownership

1. **A0 — raw presence, as dispatched above.** No runtime or guard writes.
2. **A1 — canonical live facade + runtime own/Get/Has + actual prototype mutation.**
   After Volta's runtime patch is integrated, one array worker owns the narrow
   regions in `runtime.ts` listed above, `runtime/wasm-struct-sidecar.ts` only for
   shared own-descriptor/own-key adaptation, and optionally new
   `runtime/array-property-access.ts` for the bounded algorithms. Integrate A0's
   export through `codegen/init-marshal-helpers.ts` and its runtime twin,
   append-only; preserve live cross-module export routing and ABI alias ownership.
   Remove only the ordinary-array duplicate `__make_iterable` path. No unrelated
   Promise, generator, serializer or primitive-dispatch changes.
3. **A2 — mutator closure needed by the four originals.** Same runtime owner
   completes the facade Set/Define/delete/length pieces. Narrow owners:
   `codegen/expressions/call-builtin-static.ts` for mutation/prototype result
   identity; `codegen/expressions/assignment.ts` and existing dynamic element
   assignment helper only if a direct typed write bypasses the repaired protocol;
   `codegen/vec-define-writeback.ts` only for a measured writeback deficiency.
   Review Reflect.setPrototypeOf and `__proto__` array paths for the same identity,
   without changing unrelated ordinary-object semantics opportunistically.
4. **A3 — legacy/IR consumer routing, after A1/A2 API is fixed.** Legacy owner:
   `codegen/property-access.ts`, `codegen/binary-ops-in.ts`, and the already-owned
   assignment branch as necessary. IR owner: `ir/array-element-lowering.ts`,
   `ir/from-ast.ts`, existing resolver/selection wiring in `ir/integration.ts` and
   its element-access selector. They reuse existing `__extern_get[_idx]` and
   `__extern_has[_idx]` runtime ABI, repaired for this population, not another
   lookup implementation. Numeric results are converted after Get via the normal
   value conversion operation. Do not globally change `emitSafeVecGet`'s OOB
   constant: it has destructuring-leaf override callers that are outside this
   repair. Route language property reads before the internal storage primitive.
5. **A4 — parent-only guard and acceptance integration.** Remove the relevant
   refusal only once the complete selected host service and tests below succeed.
   Keep standalone/linear and other unsupported operations refused where they
   lack this service. No Proxy/TypedArray/name/source-path/carrier exemption.
   Preserve all other array/sparse/enumeration safety diagnostics and original
   audit specimens. The safety collector is
   `src/compiler/javascript-semantic-safety.ts:192`, not lookup-semantic-safety.

For A3 the safe baseline is full dynamic property dispatch for selected ordinary
array reads/Has whose own-data status is not proved. A bounds check alone never
licenses a raw read; even a proven in-bounds slot may be a hole, descriptor or
deleted/redefined slot. Preserve raw fast paths only with existing positive,
current own-data/no-intervening-effect evidence. Do not invent alias analysis or
use “no literal setPrototypeOf nearby” as proof. If the claimed IR population
cannot carry a dynamic result, extend its bounded result/conversion plan or
decline pre-claim explicitly; post-claim fallback is not IR equivalence evidence.
Expose symbolic service availability through the existing resolver/selection
contract, not `ctx` flags leaking into core IR. Both numeric and value-lane IR
controls must actually emit before the migration slice is called complete.

**Volta separation:** its runtime iterator/completion region around 17033 and its
helper registry remain exclusively Volta-owned. Despite different line ranges,
`runtime.ts` is one shared file: do not run two writers against it or apply a
stale whole-file version. A0 and read-only spec work can proceed now; serialize
A1/A2 after Volta's final diff, then give the array worker the composed base.
The start-export registry in A1 is not assumed disjoint from Volta's registration
work; parent composes those hunks and reruns both lanes' tests. Parent alone edits
the shared guard-regression expectations. Routine execution after this handoff
needs no repeated user approval, but ownership is not broadened to other lanes.

Parent also owns precise compiler-boundary registration for any new compiler
module. Register its actual allocator/import dependencies; do not relabel an
activated-boundary violation as debt or weaken the boundary/equivalence gates.
The optional extraction is not permission for a second pipeline.

## Immutable specimens and exact equivalence controls

Preserve these original files byte-for-byte, with their original Test262 harness,
constructor loops, strict reruns and assertions:

- `built-ins/Array/prototype/indexOf/calls-only-has-on-prototype-after-length-zeroed.js`
  SHA256 `e570b835839f9190bc1e933035848176b757f66795b2f5b177af52b7ff3a404b`.
- `built-ins/Array/prototype/lastIndexOf/calls-only-has-on-prototype-after-length-zeroed.js`
  SHA256 `dc38ac16a4cf88eb5b4ed382532f7557a843d47421e3b683b3dd1fc25f3e2c8a`.
- `built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-prototype-chain-set.js`
  SHA256 `e15dd8fd65ed8f6252513970a71115f8b3bd39db80afe187fc065e5f8e89ecff`.
- `built-ins/TypedArrayConstructors/internals/Set/BigInt/key-is-valid-index-prototype-chain-set.js`
  SHA256 `eef01ea89aebbe41a4746a605495d3a2bc88bf0fbf2d84be5c8fbbeabdad9162`.

Paths above are relative to `test262/test/`. Do not edit proxyTrapsHelper or
testTypedArray helpers to compensate. Four unmodified original files times
optimization 0/2 times legacy/IR-enabled configuration gives 16 top-level run
cells; report strict/subvariant counts separately, not as sixteen proven IR
bodies. Current held-head expected status remains compile_error. Candidate target
is pass through the ordinary guard, with independent identity-positive evidence.

Keep all seven exact strings in `tests/issue-5393-guard-adversarial.test.ts`:
literal, alias, return, field, rebound, chain, conditional. All must print exactly
`7` after repair. They are 28 cells at optimize 0/2 × legacy/IR-enabled, separate
from added numeric/any functions. Preserve sources rather than replacing them
with easy direct literals; the two negative guard controls are not expendable.
Expectation changes are narrow, evidence-backed parent integration, not a test
rewrite or wholesale golden refresh. The enumeration specimens remain untouched.

Add a focused `tests/issue-5399-array-prototype-semantics.test.ts` matrix:

1. **Installed identity, aliases, repeat crossing.** Set p, assert setter result
   equals a, getPrototypeOf(a) equals p, getter receiver equals a; cross a and p
   through an actual host call before and after mutation. A forwarding import
   observer may record the actual operands and native Reflect.getPrototypeOf of
   the canonical facade. It must invoke production unchanged, never install p
   itself. Distinct but structurally equal prototypes must remain distinct.
2. **Numeric and any missing-slot result.** Parameterized read functions with a
   runtime index, plus constant OOB: `[1]` and installed `{2:7}` return 7 as a JS
   value and through numeric use. Include arithmetic, return/local/console uses;
   do not pass because JSON normalized NaN/null/undefined to the same spelling.
3. **Own undefined and holes.** `[undefined]` with proto `{0:7}` reads undefined,
   Has/hasOwn both true; `[,]` reads 7, Has true, hasOwn false. Repeat with deletion,
   length-grow gap, length-shrink stale capacity, f64 holes, and genuine NaN. With
   no inherited property, a hole and OOB read undefined and Has/hasOwn are false.
   Re-add own undefined to a deleted slot and verify it shadows the prototype.
4. **Getter receiver and abrupt completion.** Inherited getter observes the
   original a, runs once per Get and zero times for Has/hasOwn. Setter-only own
   accessor stops Get with undefined. Throw a unique object from a getter and
   assert identity and no later side effects; no catch/retry/default value.
5. **Proxy protocol.** Inherited Proxy has returns false: Has invokes only has
   once; Get invokes get once, not has/gOPD first. Own undefined suppresses both.
   Test throwing/revoked Proxy, and a get returning undefined (no second get).
   Own-descriptor reflection must not traverse that prototype.
6. **Original-algorithm positive controls.** Separate instrumented companions to
   the unchanged originals: indexOf after truncation records has 0,1,2; lastIndexOf
   records has 2,1,0; no inherited Get when Has is false. Assert the proxy is
   installed first. A deliberately throwing has trap must be observed, making a
   dropped prototype fail even though the original allowProxyTraps test was quiet.
7. **Actual TypedArray prototype.** Before the original Set operation, independently
   assert installed identity and an inherited valid index value; after assignment,
   assert own descriptor.value is the same object, receiver.length=1, target
   unchanged, zero valueOf calls, and the original proxy defineProperty count.
   Add an invalid TypedArray index control proving its exotic operation does not
   fall through to a poisoned TypedArray.prototype index.
8. **Key/evaluation and mutation integrity.** Numeric/string canonical indices,
   non-index strings, symbols, key coercion once, key-before-RHS order for `in`;
   null prototype and replacement twice; Object/Reflect return/throw distinctions,
   failed cycle/non-extensible mutation preserves the prior link. A numeric
   context still observes a throwing inherited getter before any conversion.

Use the production compile result's importObject and correct instance/start
binding, not under-assembled buildImports. For original files use
`runTest262File` with verified options; do not claim optimize/IR cells if that
runner configuration did not actually select them. For focused functions use
`experimentalIR:false/true`, `trackIrOutcomes:true`, and assert each intended
function has an `emitted` outcome with no `irPostClaimErrors` (existing example:
`tests/issue-5164-comma-and-in.test.ts`). A whole-file IR-enabled pass can consist
entirely of legacy fallback; record that separately and do not count it as IR
coverage. Both compilers must equal Node, not merely each other.

Negative attribution controls: restoring the old non-Wasm setter no-op must fail
identity; restoring length-only presence must fail a hole; restoring OOB constant
must fail inherited 7; restoring undefined-based retry must fail trap count;
restoring copied-mirror dispatch must fail the reentrant length trace. These are
future test controls, never a production guard filter or permanent bypass.

## Completion and preservation bar

Report baseline `4b9a66d730b068893d716fbff645d94b6deeff13` versus the exact composed
candidate SHA/tree, JS-host WasmGC, harness, optimize setting and actual IR outcome
for each row. Preserve raw status, error text, value/identity and ordered effects.
Keep the original audit manifest and its hashes; an admitted inherited-array
specimen changes from refusal to its correct value, not to a rewritten specimen.
Retain refusals outside the implemented host array-property service.

Run the original guard suites and focused bridge/array suites, vector mirror
writeback controls, hole/descriptor tests, bounds-elimination and dynamic-in IR
controls, then complete existing equivalence/quality checks without changing their
baselines. Include zero-array and dense-array/no-host-service controls for no new
imports, start helpers or behavioral changes. Run module-init and post-init cases,
same-name export collisions and foreign-module vectors for A0/A1. Following runtime
serialization, rerun Volta's generator/completion controls on the composed tree.

No full “array semantics repaired” claim until canonical identity, raw presence,
shared Get/Has, necessary Set/Define and both consumers are live. A0 is a bounded
dependency delivery; A1 alone is not four restored originals; guard-filtered green
is not acceptance. If a runtime getter/Proxy/exotic bridge or IR value carrier is
still unavailable, name the exact missing owner and keep the affected source
population refused—never turn unavailable evidence into undefined, false or a
new exemption.
