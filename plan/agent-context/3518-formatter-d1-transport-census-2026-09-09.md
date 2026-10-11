# #3518 D1: real radix-source preparation and portable support transport

Read-only proposal for High to freeze; no source implementation, claim, test, typecheck, hook or publication is included. Preserve all old P/C/ABI drafts. This is the D1 prerequisite from the full native-async consumer spec, not a substitute for D2/Ryū or complete async acceptance.

Inspected actual working sources in `/private/tmp/js2-3518-native-string-value-consumer-20260909`, observed HEAD `9ccad45c62a29d3e314448f80da1e5a70e92e8a9`. Companion `3518-formatter-d1-transport-census-2026-09-09.json` pins four donor files/17 selected declarations plus 24 additional evidence files, exact offsets/hashes and source syntax counts. The working tree may contain parent composition; these hashes, not HEAD alone, identify the inspected material.

## Finding: two concrete missing contracts

1. The actual radix source is reusable unchanged, but its current `bufRef` is a **context-indexed raw i16 array reference**, not a JS vector or a logical string. No existing `IrType` arm expresses that exact symbolic reference without a module index. The current optional `typeRef` overlays an already-required `ValType`; it does not make the source build portable.
2. Production `PreparedIrProgram` has no executable compiler-support-body batch. Its `support` ABI intent is slotless, and the old `PreparedIrSupportIntentCandidate` is explicitly unvalidated. Neither transports an authenticated fully typed radix body. Putting a compiler builtin into the ordinary source-body vector without changing its ownership contract is invalid.

Recommendation: a small index-free symbolic support-reference type plus an explicit, data-only runtime-support batch, assembled at the frontend and validated/transported with the real prepared program. Reuse the existing IR body representation, identity factories, allocation registry, ABI vector and canonical codec. Do not introduce a separate emitter, a second allocator or a copy of P's schema-v2 draft.

## 1. Actual algorithm and complete bounded donor census

`src/stdlib/number-format.ts:51–110` is the unchanged `TOSTRING_RADIX_SOURCE`; `numToStringRadixDef` is at 116–131. Actual template content is **1,618 UTF8 bytes**, SHA256 `7b13099fbed0a87079f92e9bddbf75959065ed28daf66d5ad344e0b240037dc6`.

Static parse, not an IR/execution measurement:

- One function: `__sh_num_toString_radix(value:number, radix:number):string`.
- Six distinct call spellings, **16 source call occurrences**: `Math.floor` 4; `__num_fmt_trap` 1; `__nfd_new` 1; `__nfd_set` 7; `__nfd_get` 2; `__nfd_fin` 1. Math.floor is the existing from-ast intrinsic path, not a sixth micro-kernel to invent.
- Four string literal occurrences/values in order: `NaN`, `Infinity`, `-Infinity`, `0`.
- No source globals, closures, async states or nested functions in this template. That is a parsed template fact, not an inference that other formatter/resource populations are empty.
- Preserve nonfinite guards, radix floor, ±0 behavior, MAX_SAFE_INTEGER trap, LSB integer digits, reversal, fractional loop and its 100-digit bound. Existing non-V8-shortest fractional behavior is inherited debt, not something D1 may normalize away.

`src/codegen/number-format-selfhost.ts:54–148 ensureNumFmtBufKernels` supplies five exact contracts (B = nullable reference to the selected native string pack's mutable u16 data array; S = logical string):

- `__nfd_new`: `(f64) → B`; saturating signed i32 truncation then zero-initialized `array.new_default`.
- `__nfd_get`: `(B,f64) → f64`; truncation, unsigned packed-array read, unsigned widening.
- `__nfd_set`: `(B,f64,f64) → void`; index/value truncation and array store.
- `__nfd_fin`: `(B,f64) → S`; copy the selected prefix into a new tight native string buffer, output offset zero. Physical result is the existing AnyString ref.
- `__num_fmt_trap`: `() → void`; actual `unreachable`, not a no-op or synthetic exception.

Declaration order in `numToStringRadixDef.calleeTypes` is new/get/set/fin/trap. **Physical legacy emission order is new/get/set/trap/fin**, followed by the self-hosted body and the legacy thunk. Preserve both orders separately. `emitSelfHostedToStringRadix:157–171` constructs `irVal({kind:'ref_null',typeIdx:ctx.nativeStrDataTypeIdx})`; the thunk is exactly argument0, argument1, call body, extern.convert_any, retaining `(f64,f64)→externref`.

`number-format-native.ts:494–550 emitNativeNumberFormat` requires radix for ordinary toString and fixed-family paths. `emitToString:587–704` also needs the full other formatting machinery; the environment-selected integer-before-scratch flag is read at 619. D2 must consume an explicit resolved boolean at the wrapper boundary. Building radix alone is not full formatting capability.

## 2. Smallest real frontend extraction

`src/codegen/stdlib-selfhost.ts:363–447 buildSelfHostedIr` already performs the needed sequence: parse exact template; select exact function/arity; `lowerFunctionAstToIr` with explicit positional/result/callee contracts and direct-call plans; reject lifted bodies; verify; up to ten `constantFold → deadCode → simplifyCFG` iterations; verify again. Keep that order and failure behavior.

Extract only this build kernel into a new frontend-owned module, proposed `src/frontend/builtins/build-ir.ts`. Keep the existing `buildSelfHostedIr` export as the compatibility wrapper, with its exact memo checks, fingerprints, identity-free templates and reconstruction behavior. The radix path has no memoKey today; do not turn on global memoization merely because the new representation is portable. `selfHostedCalleeRef`, native-string dialect selection and context-bound legacy signature construction can remain wrapper-owned adapters.

The new kernel should receive **explicit declared callable references/signatures**, not a callback or a name-prefix fallback. The legacy wrapper derives its existing references; D1 supplies exact owner-qualified compiler-support references for the five known kernels. This avoids moving physical-vector-prefix/charCodeAt codegen imports into the frontend kernel. Preserve the existing genuine Math.floor handling; do not add an always-true ambient resolver.

Move the data-only definition interface out of the mixed codegen module, proposed `src/frontend/builtins/contracts.ts`, importing only canonical IR types. `src/stdlib/number-format.ts` then type-imports it and imports `irVal`/`IrType` from their canonical core owner. Preserve the source literal and `numToStringRadixDef` algorithm/signature-map body. A pure type import from codegen is still the wrong folder direction; deleting that type annotation is not a repair.

Add proposed `src/frontend/builtins/prepare-number-format.ts`: derive the selected canonical native formatter demand, choose the exact template, bind its support identities and types, build with the source preparation's actual compiler allocation registry, and produce the support batch for joint capture. Source parsing happens here, **before** `prepareTypedIrProgram`; never inside resource reserve/fill, codec replay or backend acceptance. Missing post-pass dependency coverage must be refused, not lazily parsed by the backend. Parent must freeze which real canonical demand triggers preparation; helper presence/name alone does not grant provider permission.

Preserve current diagnostics/once-only preparation behavior. Do not implement a hidden retry that runs the full typed transaction twice to discover a missing formatter. The producer must supply the declared formatter closure before the transaction crosses the source-free boundary.

## 3. Portable scratch-reference prerequisite

Current exact constraints:

- `core/types.ts:274–284`: `kind:'val'` requires `val:ValType`; `typeRef` is optional attachment.
- `core/types.ts:454` compares val types by their concrete ValType and signedness; the attached ref is not the equality authority.
- `type-key.ts:12` includes physical reference indices in the val key. `program-abi-contracts.ts:29` adds complete data but does not remove that index.
- `lower.ts:4319–4325` replaces a supplied val ref's index via `resolveType(typeRef)` only at physical lowering.
- `physical-ref-support.ts` attaches a ref to a pre-existing physical ref and cannot manufacture index-free source IR.
- `prepared-component-dependencies.ts:334–353` requires typeRef for final raw references; supplying any integer plus a ref could pass some checks while still leaking/faking the build representation.

Proposed narrow canonical addition for High's type-contract freeze: an **index-free support reference** carrying exact `IrTypeRef` structural identity and explicit nullability, e.g. `kind:'support-ref', ref:IrTypeRef, nullable:boolean`. The spelling is proposed, not an existing API. For D1 permit only the declared number-format scratch role; no JS object/array syntax, generic numeric conversion, arbitrary reference casts or union promotion. Equality/keying must use the full structural binding plus nullability, not a display name. `asVal` must not return a made-up storage type. WasmGC lowering resolves the exact type token and only then constructs the real nullable/nonnullable ValType.

The support declaration describes **mutable packed u16 array storage shared with the selected native string-data role**. The actual scratch contract remains nullable exactly as the donor, even though `__nfd_new` constructs a nonnull array. Do not narrow the callable signature based on that observation. Do not reinterpret B as `string`, `vec<i32>`, an empty object, `externref`, or an invented negative/zero type index.

Bind/alias to the canonical existing string-data requirement before allocation. If the same array token is reused, it must be the same canonical required entry or an explicit compatible alias—not two independent required roots interned into one token. Buffer role, array kind, packed width, mutability, nullability and complete kernel signatures must all be checked against the actual declaration/owned pack before allocation. The later physical finalizer's own local-array types are D2 recipe details, not indices in the transported frontend body.

This is a genuine prerequisite beyond the listed formatter files. Exact known type-consumer sites to dispatch/review with it are `src/ir/core/types.ts`, `src/ir/type-key.ts`, `src/ir/from-ast.ts` (typed locals/call arguments/nullability), `src/ir/lower.ts`, `src/ir/prepared-component-dependencies.ts`, `src/ir/physical-ref-support.ts`, `src/ir/prepared-callable-boundary.ts`, `src/ir/prepared-closure-support.ts`, and `src/ir/passes/monomorphize.ts` (its separate type key). Treat the new kind as a leaf where appropriate and an explicit unsupported type in non-admitted backends; no new host/linear implementation. Verification/analysis/pass controls must prove it survives the real build pipeline. This read-only pass did not run a whole-project typecheck, so it is **not a claim that this is a proven exhaustive compile-fix writeset**; High should freeze the logical-reference substep separately, then use diagnostics to request any concrete extra ownership, never an open-ended scope grant.

## 4. Production transport and identity, without a fake source owner

`program/prepared-contracts.ts:78` contains inventory, semantic IR, ABI, derived units, startup, allocations and runtime projections, but no runtime-support bodies. `program/input-contracts.ts:35` likewise has no such field. `program/input.ts:87` validates exact input keys, so attaching an arbitrary property is not a supported transport API.

Keep a separate optional **typed runtime-support batch** in the input/prepared contracts (proposed `runtimeSupport`, omitted on old/no-demand programs). Its body remains an ordinary fully typed `IrFunction`, not unknown data/Instr arrays/a callback/TS source to compile later. The batch must retain:

- Versioned role and exact original-demand owners, source/definition provenance and source hash.
- One compiler-support function identity/ref, exact `(f64,f64)→string` contract, complete typed body and verifier inputs.
- Five exact owner-qualified support callable declarations/refs/signatures; no sixth invented Math.floor callable.
- Exact symbolic scratch type and its selected string-data identity relationship.
- Complete body call-occurrence and literal/allocation association records, with retained ordering and currentness.
- Shared allocation snapshot membership, all known encoding/provenance metadata, and independent expected resource/support populations. Derived runtime resources remain separate from semantic allocation IDs.

Use `irSupportFuncRef`/`irSupportTypeRef` and the existing canonical identity factories, anchored in the actual program's entry source. Support callable intents need exactly one valid source owner, as the recent string ABI join established. Runtime toString remains its existing owner-free canonical runtime declaration; do not add sourceId to that runtime intent.

Do **not** reuse `createSelfHostedIrUnitId`'s global synthetic `@compiler/stdlib-selfhost` identity blindly: `program-population.ts:26–96` requires ordinary/derived bodies to join real source/terminal ancestry. Adding a synthetic builtin source or pretending the formatter is a user terminal changes the 5/22→16/33 denominator. Keep support-body provenance explicitly disjoint and validate its branded ID against its support owner/role; do not relax ordinary population checks. One support body, five kernel declarations and later physical kernels/thunk are distinct counts.

`PreparedIrSupportIntentCandidate` and `PreparedIrAllocationCandidate` in `program.ts:179–209` say `unvalidated-candidate`; their `unknown` bodies are not an alternative transport. `PreparedIrAbiContract.kind:'support'` and `ProgramAbiIntent.kind:'support'` are slotless. Executable kernels/body/type need actual typed callable/type entries in the one ABI vector, with required slots/aliases as appropriate. Preserve existing entries, order, alias identity, source owners and final-binding rules.

Avoid broadening the global runtime catalog with `__nfd_*` names: `runtime/callable-declarations.ts` currently recognizes ReferenceError/native-async/vector declarations, and `program-runtime-abi.ts` rejects unknown runtime calls. The five internal kernels can use canonical **support** bindings and the support batch's closed signatures. Existing runtime provider declarations and permissions remain independent. A forged support binding or undeclared call must still be rejected by complete validation.

## 5. Allocation and literal obligations

`builder.ts:355` mints a string allocation site for each literal if an `AllocSiteRegistry` is supplied. `builder.ts:210–222` also mints one for a string-returning call, so `__nfd_fin` is a semantic string allocation site. The current generic `buildSelfHostedIr` does not pass a registry to from-ast. The new frontend build path must pass the actual shared preparation registry; omission would make a superficially correct support body invisible to string-resource demand collection.

Expected source-origin accounting before pass effects: four literal string sites plus the fin call's string result site, and all 16 source call occurrences. Recount actual post-pass IR rather than declare these static counts to be runtime evidence. Preserve every aliased/retired/live entry and metadata namespace; `program-allocations.ts` reconstructs and verifies these semantics. Scope its traversal over support bodies as well as existing source/async buffers without changing the latter's denominator.

`AllocKind` in `core/nodes.ts:150` explicitly excludes black-box builtin internal allocations. Therefore do not fake `__nfd_new` as an object/JS-array allocation merely to populate the semantic registry. Its scratch array and fin's internal output buffer remain actual D2 resource/body allocation obligations, independently declared and validated. No new semantic AllocKind is necessary merely to enumerate those internal Wasm sites.

The four literal values are all ASCII, but new preparation should retain genuine producer encoding evidence and real allocation owners, not bypass them based on the known spellings. Existing legacy emission at `stdlib-selfhost.ts:690` uses inline UTF16 native strings without UTF8-storage metadata. D1 must preserve this recipe or explicitly record/prove any representation change; do not assume the default public literal planner is byte-identical. Include an empty UTF16 buffer requirement where D2's actual string/resource recipe requires it; it is not an extra literal occurrence in this source.

## 6. Precise proposed P release request (current paths, separate worktree)

Request additive prepared runtime-support integration permission for these **eleven existing paths**, with all paused P originals untouched:

1. `src/ir/program/input-contracts.ts` — optional, typed support batch in source-free input; no erased generic payload.
2. `src/ir/program/prepared-contracts.ts` — retain the finalized support batch in the prepared program; no new candidate execution route.
3. `src/ir/program/input.ts` — allowed-field/schema validation, joint detached capture/restoration and support/currentness checks.
4. `src/ir/program-preparation.ts` — real frontend support producer after source lowering but before joint capture and the once-only typed transaction; keep all current source/policy failure ordering and diagnostics.
5. `src/ir/program-prepare-ir.ts` — carry/validate/own/freeze the batch and allocation facts; no AST imports, callbacks or compile retry.
6. `src/ir/program-abi-contracts.ts` — merge exact support callable/type contracts in the existing order/ABI authority, preserving canonical runtime ordering.
7. `src/ir/program-validation.ts` — validate full support-body signature/callee/literal/allocation/provenance closure in addition to unchanged source/runtime checks.
8. `src/ir/program-allocations.ts` — include the additional explicit support bodies in allocation validation/analysis; do not weaken namespace/provenance checks.
9. `src/ir/program-codec.ts` — shape-check, carry through the explicit reconstructed result, and revalidate support data after decode; never rebuild it from TS source here.
10. `src/ir/prepared-component-dependencies.ts` — record implicit scratch/string type and support callable dependencies instead of treating the support batch as opaque complete data.
11. `src/ir/program-source.ts` — capture-only additive argument/field for the support batch, included in the existing `allocations.capturePreparationData` call and explicit result projection; no source algorithm/option expansion.

New pure contract/validator modules under `src/ir/program/` (proposed `formatter-support.ts` and `runtime-support.ts`) should contain the bounded schema/validation, not swell transaction/codec methods. Exact module names and index-free type spelling require High's freeze; this request does not authorize writes yet.

The narrow capture change is necessary for lossless sharing: `captureTypedIrProgramInput` currently jointly captures only inventory/IR/derived/startup/callables/globals plus the allocation snapshot. Build support against the same live registry first, then capture the support body/types and allocation metadata in that same operation (an optional second support argument is sufficient). Do not append independently cloned support data to an already captured source snapshot and assume graph identity was preserved. No `src/ir/program-input.ts` forwarding change is needed while its existing type/function reexports remain identical. This capture permission must be explicitly released; past source-option forwarding permission does not grant it.

No change is presently necessary to the canonical `src/ir/program/abi.ts` class implementation, source `program-population.ts` rules, startup contracts, async attachments/codecs, or global runtime callable catalog solely to transport this separate batch. Generic copying in `program/data.ts`/`analysis/alloc-registry.ts` already handles plain typed records; preserve their lossless semantics. Codec encoding is generic, but explicit program reconstruction is not: simply relying on JSON retaining the new property would silently drop it during reauthentication.

Core symbolic-reference changes listed in section 3 need **separate owner coordination**; they are not silently included in this P permission request. Likewise D2 owns `number-format-selfhost.ts` physical kernel/thunk adapters and its new physical formatter/Ryū/resource files; parent owns physical-plan/consumer/aggregate support-body materialization and exact selected string-pack joins. Keep these lanes disjoint.

## 7. Required narrow acceptance before D1 is usable

- Source/declaration preservation: exact template hash and full `numToStringRadixDef` source/signature-map body; explicit allowed import/type/target-binding changes; positive-first altered source/callee/signature/literal controls. Keep all existing self-host/math/string adapters and memo failures unchanged.
- Actual frontend builder: one typed support body, exact closed kernel signatures, no lifted body, no physical type/function/global indices anywhere in its semantic type graph; pre/post-pass verify, exact allocation/literal joins. Negative absent/foreign scratch role, wrong packed width/mutability/nullability, changed fin result, missing trap and altered target identity.
- Real transport: canonical encode→decode→encode exact bytes; original and decoded support body/type/callee/literal/allocation evidence equal; complete validation after decoder reconstruction. Remove/duplicate/change one support body, ABI entry, owner, allocation, callee or literal and reject even when both local lists are corrupted consistently.
- Fresh-process consumer of decoded data: forbid `ts-api`, TypeScript, frontend/from-ast, stdlib source and legacy codegen loads; positive nonempty support body/call/literal/resource population first. Replaying an omitted/unvalidated support field is not a passing source-free probe.
- Later D2 execution: run the real prepared radix body and full formatter, exact binary/WAT/resources/order/string outputs, original/decoded and repeated instances, against the genuine legacy builder using the actual data array. Preserve nonfinite, −0, 3e9, fractional, radix and unsafe-integer trap outcomes separately from historical V8 divergence. Existing `tests/issue-3305.test.ts` contains 21 values across standalone/WASI and documents inherited fraction debt; its public compiler path is regression evidence, not D1 prepared execution proof. Do not reuse its permissive dummy import construction as standalone acceptance.
- No-demand control: existing prepared serialization, public compilation and source-only counts stay unchanged. No host/linear feature admission, no blanket support signature fallback, no ABI30/planningSealed/full-family/retirement claim.

All results here are static. No frontend preparation, codec run, formatter compilation or tests were executed. High must first freeze the index-free reference contract and the explicit P release; backend parsing, a fabricated index or an unvalidated support-intent list would hide the two actual blockers rather than implement D1.
