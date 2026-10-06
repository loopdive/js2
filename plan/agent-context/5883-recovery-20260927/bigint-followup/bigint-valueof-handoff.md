# BigInt valueOf provider — separate source-only patch

## Current bounded admission (supersedes hold below)

Separate `5883-bigint-valueof-dynamic-admission.patch` adds a calls.ts branch
for resolved BigInt/valueOf only. It reuses existing
emitFnctorSubclassDynamicMethodCall on the ORIGINAL .call/.apply expression,
so it compiles the actual method expression once, packs original arguments,
and dispatches that value's call/apply through __extern_method_call. It does
NOT ensure/cast a statically selected native method closure and never calls
pushReflectiveCallReceiver (which synthesizes instance singletons). Spread
calls decline; other families unchanged. No new static BigInt brand admission.
The existing generic dispatcher re-resolves handles after argument compilation.
Read-only git apply --check against parent passes; not applied by this lane.

Integrate provider patch PLUS this separate dynamic-admission patch; neither
contains the earlier Symbol hunks or parent scanner extraction. The helper and
31 tests remain frozen. No test/native/typecheck/compiler executions.

Remaining provenance boundary: this fixes how the evaluated method is invoked,
not the compiler's property-read lowering itself. If direct prototype reads
still ignore companion overrides or shadowed names upstream, generic dispatch
cannot recover the lost callee. Namespace shadows whose type is not BigInt
stay on existing fallback. Retain those controls; no override-success claim.
Likewise this reuses existing method lookup/argument sequencing; it is not a
new proof of arbitrary getters on Function.prototype.call/apply. Do not broaden
the resolved-interface gate based on spelling or best-effort dirty flags.

Parent's corrected measured39: method9/12, safety5/7, originalToObject14/20.
Prototype override and namespace shadow both fail baseline and candidate (-2).
Both remain binding. Parent push80831 owns slot; this lane starts no run.

## Safety revision: hold direct-call admission

Following parent's provenance warning, REMOVED the new BigInt calls.ts import
and static admission before integration. Current integration patch contains
ONLY new provider plus array-object-proto makeGlue routing. Own calls.ts is
back to the already-handed-off Symbol-only patch. Earlier three-file plan and
calls.ts hash below are historical, not the current integration instruction.

No sound existing pristine-callee guard found: protoNamedWrittenMembers is
explicitly best-effort and incomplete, and dirty flags are reserve gates, not
proof that an actual method value equals its intrinsic singleton. Therefore
none is used to justify the unconditional cast. BigInt direct calls continue
to DECLINE the newly proposed static path (existing fallback unchanged).
This is an intentionally incomplete direct-call repair; do not report direct
cases fixed from the provider alone. Original31 strict tests remain unchanged.

Next bounded routing proposal: evaluate the ACTUAL callee once and dispatch
via existing generic callable bridge (__apply_closure), or runtime-check that
callee against the expected intrinsic carrier before a fast call_ref and use
the actual callee on the fallback. Instance-member reads must never synthesize
the singleton merely from a MethodSignature. Extracted/reassigned variables
must retain their runtime value. This requires an explicit receiver-preserving
dynamic-call emission path, not reuse of reflective-call-receiver's normalizer.
No reflective helper or parent scanner edits made; parent can review provider
independently while direct routing remains held.

Exact production changes: NEW `src/codegen/bigint-proto-valueof.ts`, import and
single makeGlue dispatch arm in `src/codegen/array-object-proto.ts`, import and
BigInt/valueOf-only admission in `src/codegen/expressions/calls.ts`.
Integration patch: `5883-bigint-valueof-provider.patch`. It excludes the earlier
Symbol changes; apply after that Symbol patch, never overwrite whole calls.ts.
Parent scanner extraction and parent iterator changes are untouched.

Provider follows Symbol's two arms: native primitive carrier returned unchanged;
object wrapper slot must exist, carry FLAG_INTERNAL, and contain a BigInt
carrier. Otherwise throws in-module TypeError. Base-carrier ref.test accepts
$BigIntWide subtype. No __to_bigint, i64 field read, or narrowing conversion.
Union/object/throw dependencies register before function/type handle capture.
Slot key already registered by object runtime; no new host import.
Standalone gate matches Symbol provider. Missing carrier is a compiler error,
not an identity fallback. Glue/body registration occurs before call emission.

## Additive checks, all unrun

`tests/issue-5883-bigint-valueof.test.ts`: 31 cases, strict native/Wasm expected1.
16 combinations primitive/narrow wrapper/wide primitive/wide wrapper with
direct/extracted and call/apply. One runtime-ToObject wide-wrapper check; ten
incompatible receiver cases each exercise direct call and extracted apply,
including forged public slot and BigInt.prototype. Three override/provenance
controls (prototype replacement with retained original, shadowed constructor
name, reassigned method). One method-free wide formatting positive control.

Full-width observations use String(value), not Object.is or i64 arithmetic;
formatting control distinguishes failure of that observable. Static Object(wide)
may still narrow BEFORE this provider (calls-guards.ts i64 ABI); those four
expectations remain strict and must not be weakened. Runtime wrapper control
uses actual values factory and a strict prototype getter to capture its wrapper.
Override/provenance tests intentionally retain potential shared dispatch gaps;
they are not claimed passing based on source review. No existing fixture edits.

## Frozen hashes

- bigint-proto-valueof.ts: 415f8a5eabf0c3ff2f3aa7099584dd537b06469b3459f44ce271907dea9c224e
- array-object-proto.ts (own full file): db2ea5bb8415063720630bcbc97d4edb94c5c2fd3de244a516edf8e301af1978
- calls.ts (own full file, includes earlier Symbol): a09503c41e2abe8da5c5fed03edd5bde2a4627f9155c7b9b4c8c73b860f90b6e
- new fixture: 7bf28516c37e4cba3d60aa26406c35dfda708122e2ace9f31070f643bb5cdc44

Only formatting and source/diff checks performed; no compiler, native control,
Wasm, typecheck, tests, commits or pushes. Execution denominator 0/31.
Initial compact-context patch applicability check failed on calls.ts context;
expanded context to preserve adjacent Symbol hunks before rechecking. No parent
file was changed by either read-only check.
