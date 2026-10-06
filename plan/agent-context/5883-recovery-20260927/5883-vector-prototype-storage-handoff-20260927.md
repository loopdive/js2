# PR5883 vector prototype storage slice — source-only handoff

Owned tree: `codex-5883-vector-prototype-storage-20260927`, branch
`codex/5883-vector-prototype-storage-20260927`, base
`bed38fc00a4dc3b3e7298a39c56c18d37cee9f03`.
Read the full architect plan from the acquisition-plan tree before edits.
This is the storage dependency of the existing PR5883/issue5197 work, not a
new acceptance target. Parent owns integration, compiler slots and publication.

## Implemented source contract (unexecuted)

Only production files changed: `src/codegen/vec-props.ts`,
`src/codegen/vec-proto-link.ts`, and shape documentation in
`src/codegen/context/types.ts`. The seven mutation files in the old tree remain
frozen. No parent/B files or other trees modified; no compiler/tests/commit/push.

`$VecPropEntry` retains next/key/bag fields 0–2 and appends mutable
protoPresent:i32 and protoValue:externref at 3–4. The single allocator is now
`__vec_entry_ensure`; the existing `__vec_bag_ensure` ABI is a wrapper returning
that entry's same bag. Every new entry initializes presence 0 and payload null.
Integrity/own-property users still operate on the original bag. Existing bag
lookup neither allocates nor replaces an entry. There is no second side cache.

Private APIs (arguments/results are externref unless noted):

- `VEC_PROTO_LOOKUP`: `__vec_proto_lookup(value) -> (i32 present, prototype)`.
  Read-only list walk; absent `(0,null)` differs from explicit `(1,null)`.
- `VEC_PROTO_STORE`: `__vec_proto_store(value,prototype) -> void`.
  Trusted commit through the shared allocator, raw payload unchanged, presence 1.
  Not a public validation boundary. No callable view/bag/vector normalization.
- `VEC_PROP_GET_R`: `__vec_prop_get_r(target,key,receiver) -> value`.
  Own presence wins even for undefined; bag Get uses original Receiver. Actual
  own miss calls the semantic prototype helper. Existing `__vec_prop_get(t,k)`
  calls this with Receiver=t. The terminal get-arm now retains explicit Receiver.
- `VEC_ACTUAL_PROTO`: `__vec_actual_proto(value) -> prototype`.
  Present returns exact payload (including null); absence calls default-only
  provider. No allocation on lookup/default reads in this implementation.
- `VEC_PROTO_STATUS`: `__vec_proto_status(value,prototype) -> i32`.
  Raw identity comparison first, then existing bag nonextensibility bit 0x01,
  then parent's trap-free cycle predicate. Does not store.
- `VEC_PROTO_TRY_SET`: `__vec_proto_try_set(value,prototype) -> i32`.
  Same predicate, commit only on success. The existing lenient writer arm drops
  this status and returns receiver even on refusal, preserving its ABI.
- `VEC_PROTO_GET_MISS`: `__vec_proto_get_miss(target,key,receiver) -> value`.
  Null actual prototype returns reserved undefined; otherwise one semantic Get.
- `VEC_PROTO_HAS_MISS`: `__vec_proto_has_miss(target,key) -> i32`.
  Null returns false; otherwise semantic Has, never getter-based presence.

`reserveVecPropHelpers` reserves storage and semantic signatures before callers
emit references. Stable funcMap/defined-function machinery is retained; each
instruction tree is fresh. Successful fills are latched once. Missing storage
layout/required Get dependencies throw a compiler integration error.

All vector-link bag.$proto readers/writers in owned files are migrated:
post-super class install calls raw store; generic Get returns actual prototype;
writer calls checked try-set; linked instanceof traverses semantic GetPrototypeOf
with invocation-local cursor, rather than Object-only fields. Primitive LHS is
guarded. Legacy Array-root class implicit edge remains separate and tests the
Object null-prototype flag. Alias materializer is preserved. New exported
`buildArrayProtoVecAliasTest(ctx,valueLocal)` lets the parent's default-only
provider recognize collected alias identities without normalizing stored links.

## Exact integration edges — blockers, not successful stubs

1. Parent must reserve/fill `__vec_default_proto(value)->prototype`, exported
   name `VEC_DEFAULT_PROTO`, before semantic fill. It must be non-recursive,
   classify actual source arrays (not all vec_base carriers), preserve other
   carrier defaults, lazy singleton identity and Array.prototype alias parent.
   Use the alias test only after all materialization sites are collected.
2. Parent must reserve/fill `__ordinary_proto_cycle_ok(target,proposed)->i32`,
   exported name `ORDINARY_PROTO_CYCLE_OK`. It walks exact ordinary authorities,
   stops at nonordinary/proxy links WITHOUT traps, and rejects reaching target.
   Both ordinary Object and vector setters must use it, including mixed cycles.
3. Parent must add matching `VEC_PROTO_STATUS` dispatch to public status helper
   before its non-Object exit. Storage's lenient writer alone cannot implement
   Object throw/Reflect false/accessor policy. Frontend must preserve raw proto
   identity and evaluate each operand once, including explicit null.
4. `__reflect_get_receiver(target,key,receiver)` and `__extern_has(target,key)`
   must provide B/parent's complete semantic dispatch for Object, callable,
   closed, vector and proxy prototypes. This slice calls those existing names;
   their current names do NOT prove their receiver/index/brand-tail coverage.
   Parent/B still own indexed `_r` wrappers, native companion tails and receiver
   forwarding into own/inherited accessors and proxy traps.
5. Both compiler entry pipelines must call storage fill and generic semantic
   fill even without linked classes, before B's final receiver dispatch snapshot
   and before DCE. **This tree deliberately fails at missing parent providers**
   when semantic fill is reached. Do not treat the source slice as independently
   runnable production activation or replace missing providers with success/null.
6. `__extern_set_decide` still needs parent-owned actual-chain selection for
   inherited writes. Index holes/OOB Get/Has, inherited enumeration and static
   getPrototypeOf/direct-method folds remain the architect plan's dependencies.
7. Semantic GetPrototypeOf used by linked instanceof must retain target-neutral
   callable/closed/proxy behavior; existing Symbol.hasInstance callers remain
   outside this slice. Raw identity comparisons use nullable eqref on supported
   standalone GC carriers; admission of other external representations requires
   explicit identity support, not coercion into a different carrier.

## Additive tests and verification status

`tests/issue-5883-vector-prototype-storage-contract.test.ts` has four structural
emitter checks (single allocation/init, lookup/store payload, Receiver wrapper,
missing-provider refusal) and six independently reported strict-native versus
compiled acceptance cases (null/restore, callable identity, vector identity,
bag/integrity, own undefined/Receiver, mixed-cycle refusal). Structural dependency
stubs are never executed and do not claim semantic-provider implementation.
Acceptance cases are not skipped when integration is missing. Full source/hash,
native/compiled result, errors/imports and failure boundary are logged.

No tests, compiler or typecheck have run. Only pinned formatting and source/diff
inspection are authorized. The original eight parent controls and all existing
class/mutation/Promise fixtures remain unchanged. Full semantics and runnable
integration are unproven; no passing count or repair/completion claim is made.

## Source receipt

Full three-file production diff against the base is preserved as
`plan/agent-context/5883-vector-prototype-storage-source-v1.patch`, SHA-256
`3abbb1b5dff4abee7421a1231fbb0964418c78bbabd42fb64711913d81729bd1`.
Source SHA-256 values:

- vec-props.ts: `5e7e2a7f767b6e8ae8bd50ef5e0514261dd17e742db798bc1b8f97dcc15b096d`
- vec-proto-link.ts: `33cff8f3c8d18c4707fe0f0d8d73da43941e062fb480ce4407fc738593148e1e`
- context/types.ts: `26f17954c4fbe8442dfaa10e930d69f3f5c9c9e8dc4d730cec5cd09321067e56`
- additive test: `7ce703517cd5f1cb464d796e11903f8f7f9ef11192d635430f4bc2640a489368`

No compiler handle exists for this slice; no compiler slot was taken. Formatting
and scoped diff whitespace check completed; those are not semantic validation.
