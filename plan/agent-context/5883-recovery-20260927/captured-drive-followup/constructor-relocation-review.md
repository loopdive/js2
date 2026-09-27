# Constructor relocation concern: scoped resolution and retention contract

2026-09-27, source-only. Inspected `/private/tmp/js2-5883-main-6eac-20260927`. No tests, compiler, source changes or git mutations. This narrows/supersedes the relocation concern and proposed retention-lease wording in `5883-constructor-identity-seed-prepare-emit-contract-20260927.md`.

## Decision for parent and Curie

The omission of `builtinObjectGlobals` from the host-string global-index fixup is a concrete **general global-relocation owner gap**, but it is **not an established reachable defect of the current captured standalone/native-string constructor path**. Native constructor strings do not insert imported globals. Do not make a host-global-map repair a prerequisite for Curie's attached-prologue extraction, and do not claim a runtime failure from this source audit.

Immediate same-frame prepare+append needs scoped preservation of existing `liveBodies` membership, not a new reference-counted lease system or ownership arena. No arbitrary retention lifetime is approved. A token that crosses unrelated registration, rollback, frame/local replacement, finalization or remapping needs separate proof; these findings do not supply it.

## Complete direct map-use inventory in current src

Repository-wide exact-identifier search finds initialization in `context/create-context.ts:403` and declaration in `context/types.ts:4195`. No explicit delete, clear, map replacement, snapshot restore or relocation update was found. The following are the direct writers (also reading the key to reuse it); all allocate absolute `numImportGlobals + mod.globals.length` and append a null-initialized defined global when missing:

- `builtin-static-globals.ts:187–196`: `ctor:<builtin>`; `:509–518`: bare namespace/constructor name.
- `array-object-proto.ts:3464–3473`: `%TypedArray%` constructor; `:3611–3620`: Function prototype; `:3672–3681`: Generator prototype; `:3725–3734`: Generator iterator prototype; `:3816–3825`: AsyncGeneratorFunction prototype; `:3921–3930`: globalThis; `:4174–4183`: per-kind iterator prototype; `:4318–4327`: Iterator prototype.
- `dataview-native.ts:4897–4906`: `ctor:Int8Array`, reserved by the dynamic identity predicate.
- `ta-static-from-of-spec.ts:63–72`: same `%TypedArray%` constructor key as array-object-proto.
- `array-species.ts:213–222`: bare `Array`, same key as namespace constructor read.
- `generator-function-intrinsic.ts:68–72`: lazyGlobal helper; current call at `:96` uses GeneratorFunction prototype.
- `registry/error-types.ts:231–240`: Error-family bare-name globals shared with namespace constructor reads.

Other direct readers:

- `builtin-ctor-callable.ts:64–65`: Array/Object identity arms; `:244`: iteration over Object/Array/ctor keys for callable carriers; `:380`: wrapper constructor conversion arms.
- `iterator-native.ts:1899`: native Array iterator prototype.
- `string-proto-tostring.ts:184`: Math/JSON identity-specific string behavior.
- `object-proto-tostring.ts:251`: Date key-presence gate, not an index read.
- `native-construct.ts:541`: Proxy carrier identity.
- `native-dynamic-instanceof.ts:715`: Object constructor identity.
- `construct-bound.ts:269`: Date constructor identity.
- `ta-dyn-mop.ts:489`: Int8Array constructor result arm.
- `expressions/calls.ts:4732` and `expressions/call-receiver-method.ts:4247`: Int8Array key-presence gates, not index consumers.

The inventory is direct map accesses, not a claim that every emitted instruction consumer is listed here. The returned numbers become ordinary global instructions whose later ownership is the existing body walker. Shared-key writers intentionally share identity; no new map should replace them.

## Global index mechanisms and actual reachability

1. **Ordinary native global append:** constructor/prototype/method singleton reservations and `native-string-literals.ts:30–60` append to `mod.globals`. Existing absolute indices remain valid. String literal materialization is allocating, but allocation alone is not relocation.
2. **Host string imported globals:** `registry/imports.ts:221–278` inserts imports then calls `fixupModuleGlobalIndices`. With `ctx.nativeStrings`, lines 236–246 record sentinel/string-pool metadata and return before import insertion. Later literal materialization uses defined globals. Therefore the captured path's length/name/prototype/method/member-CSV strings do not cause this positive global delta.
3. **Explicit host strings with native strings enabled:** `addHostStringConstantGlobal` (`registry/imports.ts:365`) returns undefined for standalone, WASI or strict-no-host. It cannot introduce a host-global shift in the supported captured standalone path.
4. **Deferred string import batch:** `deferrableStringConstantGlobalGet` rejects nativeStrings/strict-no-host (`:300–303`); `resolveDeferredStringConstants` (`:347–354`) shares the same global fixup. No positive imported-global delta is produced by the native constructor seed through this route. A zero-delta walk is not evidence of map relocation.
5. **Raw physical import:** `registry/physical-imports.ts:15–44` appends imports and increments the appropriate counter; it is not itself a global remapper. Its strict gate can allow linked namespaces. Thus standalone must not be generalized to “no possible imports.” The constructor/own-seed work reviewed here contains no linked-global registration request. A future delayed fragment crossing an independently inserted linked global would need that producer's global-relocation contract; neither the constructor map nor `liveBodies` automatically supplies one.
6. **Later module transformations:** current dead-layout processing is after finalizers (`index.ts:11793`); global removal/renumbering is not the constructor's normal body-phase mechanism (also documented by `registry/error-types.ts:226`). Function/type remaps and whole-program ABI consumption are nevertheless outside the proposed immediate token lifetime. A prepared token must already be attached before these passes; cached frame/function/type numbers are not approved across them.

Exact owner gap: `fixupModuleGlobalIndices` updates physical global.get/set operands and enumerated cached maps (`registry/imports.ts:638–679`), but omits `builtinObjectGlobals`. A later map read after a positive imported-global delta can therefore yield an old index. The repair, if assigned for a reachable host/global-import case, belongs to that central map-shift list, not the constructor or a new private cache. Adding that map alone would not fix scalar `globalIdx` values captured across an allocating host seed; those must be re-read from the authoritative owner or already reside in shift-covered instructions. This audit does not authorize either repair as part of Curie's package.

## Function-index mechanisms are distinct

- Native boxing/object/iterator providers: `ensureLateImport` routes native-first union names, errors, object names and Symbol/iterator helpers to defined providers (`expressions/late-imports.ts:440–537`). Appending defined functions does not shift existing defined indices. In particular the own seed's numeric-box ensure is not a host function import on this path.
- Native-first `addStringImports` exits without host imports (`registry/imports.ts:767–775`); `addUnionImports` selects native definitions (`:986`). Their host batch shifters at `:846` and `:1166` are not the current native constructor's normal route.
- `ensureLateImport` can still reach physical imports for other allowed names. `flushLateImportShifts` (`late-imports.ts:704–710`) calls `shiftLateImportIndices` only for an actual positive function-import delta. Preserve both captured flush points and current live roots; do not assume no shift merely from standalone mode. This mechanism changes function operands/maps, not constructor global indices.
- Raw-import/native-string reconciliation (`late-imports.ts:599–699`) settles imports added outside the deferred batch. It walks `mod.functions` and definition maps, not arbitrary current/live detached fragments. It is called at initial collector/finalization boundaries (`index.ts:5620,5703,10809,10893`) and before opening a new deferred batch (`late-imports.ts:568`). Its comment says unified walker, but the actual implementation has its own module-body loop. Do not infer detached-buffer coverage from the comment or from `liveBodies` membership. No positive raw drift is established inside the reviewed intrinsic seed; delayed lifetime across raw imports/reconciliation is unproved.
- Final function/type dead-layout remaps are a further boundary, not a body-time import shift; tokens must not survive to them detached.

These distinctions permit immediate extraction without declaring arbitrary function-index snapshots safe. Existing immediate instruction construction/flush order stays unchanged. If a new API retains numeric resource fields across additional provider work, that is a new obligation even when the old attached path passes.

## Existing traversal dedup evidence

`shiftLateImportIndices` has both a Set of arrays and WeakSet of function-index instruction objects (`late-imports.ts:170–181`). It visits module functions, supplied/current functions and saved bodies, function stack, parent bodies, `liveBodies`, and pending init (`:225–265`), recursively including then/else/body/catches/catchAll. Multiple roots reaching the same nested array or call object receive one function shift per invocation.

`fixupModuleGlobalIndices` has WeakSets of arrays and instruction objects (`registry/imports.ts:522–568`) and includes `liveBodies` (`:622`). It also patches deferred string markers and visits global initializers. This protects physical operands, not omitted cached maps.

The host batch string/union shifters deduplicate arrays, not individual objects copied into different arrays (`registry/imports.ts:846–870,1166–1190`). Raw native-string reconciliation also deduplicates arrays and visits module bodies only (`late-imports.ts:639–664`). Therefore the blanket claim “all walkers deduplicate every alias” is false. Prefer one actual subtree/array owner and no duplicate leaf arrays; never use the stronger normal-flush property to license sharing through every other pass.

## Minimal immediate retention contract — no new lease

Use the existing `ctx.liveBodies: Set<Instr[]>` with lexically scoped ownership of each **membership insertion**, plus existing `fctx.savedBodies`/body restore rules. This is physical reachability, not semantic selected-source ownership.

1. For each outer/init root the constructor scope needs, record whether it was already a member. Add it only when absent. Nested scopes see it present and borrow it; they must not delete it on exit.
2. Build the same init prefix and seed on the same current init array; preserve current body swapping and nested speculative checkpoints. Restore `fctx.body` in finally. On failure remove only memberships this scope inserted; propagate the original failure and let the actual speculative owner perform rollback.
3. Keep the prepared actual fragment rooted through the immediate append. Attach it to the same function's already-tracked body before removing inserted membership. Perform the attach and cleanup consecutively with no allocating callback/ensure/flush between them. If a full-root array is spread into the destination, do not allow a shift while both top-level leaf arrays alias; nested init remains the same array.
4. The same outer lexical owner holds the ownership booleans until append or failure. No async return, registry-held token, module cache, refcount system, or independently escaping retention lease is needed. A private one-use token may enforce transfer, but it is not a second arena and does not extend lifetime beyond this lexical operation.
5. Preserve pre-existing membership exactly. The current unconditional `delete(savedBody)`/`delete(initBody)` pattern (`builtin-static-globals.ts:234–241`) can remove a registration borrowed from an outer scope. That is the concrete minimal local retention-owner correction, independent of whether a shift happened in a particular run. Record/check prior membership, not a new mutable authority.
6. Do not treat retention as rollback proof. If append is erased by the enclosing speculative operation, the fragment is gone with that body region. An unattached token must not survive rollback or local reuse. Durable orphan adoption remains the existing staging arena's future responsibility.

This contract addresses safe immediate prepare+append. A token returned for arbitrary later use is deliberately not approved; normal-flush dedup cannot make raw reconciliation or local/epoch replacement safe.

## Coordination / validation handoff

Curie's already-approved attached-effectful-prologue step remains independent: keep constructor emission at its current point, both flushes, and legacy behavior. Do not add map shifts, root registries or delayed constructor tokens to that assignment. Parent may assign the scoped membership correction and immediate constructor extraction separately.

Parent-only future checks: nested pre-existing live membership survives success/throw; one shift per shared init under normal flush; deliberate copied-leaf alias exposes host-walker limitations; host positive-global delta exposes map omission separately from native zero-delta controls; no deferred token crosses raw reconciliation; cold/warm constructor identities and local/string order match. These are proposed controls, not executed evidence. Canonical provider closure, pending activation, full IR equivalence and retirement gates remain open.
