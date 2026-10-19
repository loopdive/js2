# Native values and the live JavaScript boundary

Status: architectural contract for the one-native-core migration. This is the
required end state, **not a claim that every cell is implemented**. The measured
typed-object ABI gaps and next implementation steps are recorded in
[S7: delete the host-semantic implementation](../../plan/issues/6979-s7-delete-host-semantic-implementation.md).

## Ownership, not execution mode

Compiled language semantics run in the native core in every environment.
JavaScript adds boundary adapters, explicit platform capabilities, and named
opt-in accelerators. A value's owner determines its representation:

| Value | Native semantic representation | JavaScript boundary |
|---|---|---|
| Native-owned object/array | Native object/struct/vector | Stable live facade; passing it back recovers the same native identity |
| JS-owned object/array | Admitted foreign reference, retaining its JS identity | The original object, not a copied native graph |
| Native-owned callable | Native closure and native calling contract | Stable callable facade dispatching to that closure |
| JS-owned callable | Admitted foreign callable reference | The original callable, with its receiver, actual arguments, result, and thrown value preserved |
| Primitive | Native primitive/carrier | Explicit value adaptation; null and undefined remain distinct |

A TypeScript annotation describes source semantics; it does **not** prove that
an incoming JavaScript object has a particular WasmGC struct layout. An opaque
WasmGC reference or a same-spelled export is likewise not authority to decode,
cast, or construct a compiler-owned value. Adapters must use the module's
authenticated instance/ABI contracts.

## No implicit graph copies

Crossing the boundary must not enumerate a genuine JS-owned object, read all
its fields, rebuild its prototype, or recursively materialize its children.
Keep identity, aliases, cycles, inherited properties, accessors, symbols and
subsequent mutations live. The adapter must not invoke getters before the
compiled program asks for those properties.

Allocating an argument-list container, a rest array, or an Object.keys result
is part of that operation's semantics. It does not authorize copying the
objects inside that container or replacing an incoming array formal with a
detached vector. An explicitly requested snapshot/serialization operation is
different from an interop conversion. Legacy explicit copy APIs may remain
compatibility facilities; they are not the new boundary model.

## Native operations over foreign references

The native core decides language behavior. When its receiver is positively
identified as JS-owned, the boundary supplies that object's primitive
operations: Get, Set, OwnPropertyKeys, descriptors, prototypes, Call and
Construct as required. Those operations must retain the original receiver and
exact thrown value. They must not become a fallback implementation of native
objects, arrays, coercion, or other compiled language semantics.

For example, a typed read of `input.n` on a JS object performs its live Get at
the point of use; a typed assignment updates that same object and respects its
setter or non-writable descriptor. A native-owned record can keep its native
field fast path when native representation is proven. Both implement the same
source operation; JavaScript environment selection is not a semantic switch.

## Typed entry ABI obligations

The declared source signature, physical callable signature, and object
operations in the body must agree. Merely labeling a slot `live-view` does not
make a native-struct-only entry accept JavaScript objects.

1. Plan a foreign-capable entry through the prepared IR/Program-ABI contract,
   with actual callable/parameter/result identities and physical carriers.
2. Keep genuine foreign objects as references. Lower the existing logical
   object operations through native-or-foreign reference operations; retain
   direct native field access only where its native-origin proof holds.
3. Propagate that carrier contract through reachable calls, aliases, returns,
   rest elements and containers. Do not repair one entry by copying its fields
   or by quietly sending foreign values to a native-only callee.
4. Publish the entry and its adapter metadata atomically under the existing
   ABI ownership checks. A function name, source type, or copied export record
   is not a physical representation proof.
5. Preserve genuine IR ownership and report unsupported routes honestly. Do
   not expand frozen direct-AST emitters or change selectors to claim that the
   missing boundary semantics have been implemented.

A nominal native wrapper with default-valued fields is not a shortcut: raw
field reads would observe the defaults, and nominal brand tests could report
properties of the wrapper instead of the original JS object. Any proposed
native view representation must account for **all** its field operations,
identity/erasure paths, generic operations and reachable consumers before it is
exposed. A passing isolated field helper is insufficient.

## Callable and receiver invariants

- Forward the actual argument count and every argument. Dispatcher padding
  must not create supplied arguments or read out-of-range array-like slots.
- Keep null and undefined receivers distinct for strict calls; apply the
  source language's receiver rules rather than a blanket normalization.
- Preserve ownership and stable facade identity on return, nested calls,
  reentrancy, callbacks, and module-init calls.
- Preserve Call versus Construct, callable metadata, and exact exceptions.

These are requirements, not certifications of the current implementation.

## Verification and known gaps

Acceptance requires source-to-Wasm execution against native and JS-owned
controls, actual IR body/ABI evidence, and identity/mutation assertions. Check
Proxy trap order and absence of eager traversal, inherited getters/setters,
read-only properties, thrown tokens, same-object aliases, cross-shape aliases,
returned/nested references, array formals and rest elements. A native-only
control must still run without JavaScript semantic imports.

The S7-q investigation at `519578344261746f63ad25d8d6914dcee980b033`
shows that simple typed object reads/writes receive IR bodies after direct-body
emission, with prepared ownership withdrawn as `param-signature-unstable`, and
reject JS objects at their native-GC-parameter ABI. They are not IR-only. A dynamic `any` control
does update the live JS object. Typed object rest elements also hit a native
cast. These are open migration defects; using a copied graph would conceal,
not close, them. Native callable-tail repairs, by themselves, do not certify
typed-object or typed-array interop.

The S7-r backend prerequisite adds an explicit reference carrier and declared
field providers, independent of environment selection. Its property operations
must be projected to real IR calls **before optimization**: foreign Get can
invoke getters, mutate state and throw, so a late replacement of a native
field load would lose effects already removed or reordered by optimization.
The lowerer rejects unprojected reference field operations. Native construction
still allocates one native object, with reference erasure rather than a copied
wrapper. The same carrier flows through signatures, SSA spill locals, calls and
returns in the backend fixture. This does not certify mutable physical slots,
vectors/rest, closure captures, complete component planning or public admission.
The normal public compiler does not yet select this contract; its typed-object
negative controls remain open. A backend fixture's manually bound primitive
providers are not a replacement for authenticated production resource planning.

Source property writes must retain their lexical failed-write policy before
the AST is discarded: strict writes throw on refusal; sloppy writes retain the
RHS without throwing on refusal (a setter's own exception still propagates).
Reference projection requires the corresponding declared setter; unknown
policy cannot default to strict or silently reuse another provider. This fact
is independent of environment and physical carrier choice.

Checker-derived record shapes in prepared source signatures are logical
contracts only. Aliases and nested records do not establish native allocation,
own properties or a public foreign-reference ABI. Physical acceptance must
still refuse a component whose carriers/providers are not materialized.
Project raw source IR before optimization, not an already optimized prepared
packet or decoded copy. Complete reachable callee contracts and authenticated
entry publication remain prerequisites for using this boundary in compile().

Internal whole-program preparation can request the live logical projection
before hygiene. Its complete current type population and exact per-field
Get/strict-Set/sloppy-Set declarations live in the existing Program ABI, not
an alternate binding table. Direct-call arguments/results are checked before
optimization. The frozen logical plan survives codec replay and is rechecked
against its current program and canonical declarations. Getter/setter effects
therefore enter normal optimization as calls, not native field loads.

This declaration plan is not a native resource receipt or public entry token.
Physical acceptance still refuses unmaterialized record carriers/providers.
The native allocation owner must establish actual ordinary-object semantics;
an old fixed-field GC struct is not automatically an object with canonical
descriptor/prototype behavior. Canonical resources, complete storage/indirect
callable ownership and authenticated boundary publication remain open.

This contract supersedes the former deep-marshaling proposal in this file.
That proposal's recursive incoming Array-to-vector policy is not an approved
implementation of the live boundary. Its historical text remains available
in Git; the current contract is the one above.
