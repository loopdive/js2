# Vector prototype providers: concrete representation dependency

Source-only inspection on bed38fc00a plus frozen storage v1. No new production
edits, compiler, tests or native executions. Storage v1 patch SHA-256 remains
`3abbb1b5dff4abee7421a1231fbb0964418c78bbabd42fb64711913d81729bd1`;
all three source hashes were rechecked unchanged against the storage handoff.

## Why a cycle provider alone cannot satisfy this assignment

1. `object-runtime.ts:1197` reserves `$Object.proto` as mutable
   `(ref null $Object)`, not a raw externref. That authority cannot store a vec,
   closed ordinary instance or proxy carrier. This file belongs to Russell.
2. `object-runtime-prototype.ts:483` canonicalizes prototype proposals through
   `__proxy_get_target_if_absent` and `__proto_from_function`. The former unwraps
   proxies based on absence of a **get** trap, not their GetPrototypeOf behavior:
   it can replace the exact identity that must be retained as the prototype.
3. `proto-function-value.ts:545–563` handles closure, native-generator and
   NativeProto views, then returns unmatched values unchanged. There is no
   vector-to-Object representation here. A vector returned unchanged reaches
   the Object setter/status ref.test, misses, and becomes encoded null
   (`object-runtime-prototype.ts:784–802` and `:921–937`).
4. `returnIfSameEncodedPrototype` around `:505` compares that encoded null with
   the current Object field before cycle validation. With an ordinary implicit
   Object.prototype and a non-null vector proposal, both fields are null and
   NULL_PROTO is unset: the source emits an early successful/no-op answer.
   Inserting a better cycle loop at existing step 4 does not reach this case.
5. Even after correcting SameValue to compare raw identities and rejecting
   actual cycles, a valid `Object.setPrototypeOf(o,a)` has no lossless destination
   in the current Object field. Mapping a to its own-property bag would not fix
   semantic indexed reads, accessors, or exact identity; a second mutable cache
   without migrating readers would create competing authorities.

These are source findings, not newly measured runtime results. Six additive
strict-native/compiled controls are authored in
`tests/issue-5883-vector-prototype-mixed-authority.test.ts`: valid Object->vector
identity/inheritance, both mixed-cycle directions, Reflect false, vector/proxy
no-trap, and Object/proxy exact identity/no-trap. They are unrun, with full source,
hash and failure-boundary logging; the parent's original eight are untouched.

## Required representation decision / ownership edge

Parent/Russell must first select and own a lossless ordinary Object prototype
authority, with all relevant readers/writers migrated coherently. Options are
an Object layout evolution to raw prototype identity, or an explicitly designed
single authoritative raw-link extension to the existing Object owner. Merely
adding vector views to the callable map is not proven sound: bag views do not
represent vector indexed/accessor/proxy semantics. This report does not authorize
any option, append another cache, or change Russell's files.

Once that authority is fixed, the provider module can consume it read-only and
share one trap-free ordinary step/cycle loop between Object and vector setters.
The step must distinguish recognized ordinary carriers from proxies/nonordinary
ones and unresolved ordinary representations. Unknown must not mean null or
nonordinary. Callable proto-view reverse identity, closed-instance explicit-null
normalization, intrinsic singleton parents and native generator views all need
explicit authority dispatch. No observable generic GetPrototypeOf in that loop.

## Provider ordering contract to implement after authority agreement

Both standalone and module pipelines need the same order:

1. Reserve storage plus provider/step/cycle signatures during ordinary runtime
   construction, before mutually recursive helper bodies bake calls. Reserve
   real Array/Object singleton and source-array classifier dependencies here.
2. Finish class/alias/native carrier registration, then fill existing storage,
   callable/closed/raw Object authorities and intrinsic singleton providers.
3. Fill `__vec_default_proto` with actual `__extern_is_array` classification,
   alias identity -> Object parent, and each supported other carrier's existing
   default-only authority. Do not clone a partly finalized generic GetPrototypeOf
   body or call that full helper recursively to obtain vector defaults.
4. Fill ordinary step/cycle and vector semantic helpers once; resolve stable
   function handles by name. Wire raw SameValue, extensibility and shared cycle
   in Object status/writer; vector status must precede permissive non-Object exit.
5. Finish receiver/index/overlay dispatch before B's final receiver snapshot and
   before optimizer/DCE. Parent retains both index.ts hooks and frontend readers.

No dedicated provider module has been added with partial-success/null stubs.
Production remains at preserved storage v1, intentionally awaiting integration.
Next needed direction is the Object authority design/ownership agreement, not a
compiler slot or weakened expectations.
