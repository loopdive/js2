# Promise species decline: partial object-runtime caller-order audit

Source-only result: the ordinary synchronous partial-initialization route cannot reach the missing-accessor species decline on the inspected standalone/native-string provider path. The early `objectRuntimeTypes` latch alone does NOT create a source-callable gap between data/accessor registration. This is a bounded caller-order proof, not a new executed test, universal compiler correctness proof, or waiver of the frozen coverage requirement.

Inspected authority `/private/tmp/js2-5883-main-6eac-20260927` reports HEAD `fda4b498696f395889e199756c6b8c27a629387c`. Hashes below pin actual working files, not merely HEAD. No assumption that new recovery main changes this source was needed. V2, its comparator, all fixtures, old five-row results and old 24-record observer remain untouched.

## Necessary condition for the guarded decline

`pushBuiltinCtorOwnPropSeed` in `builtin-ctor-own-props.ts:229` reads `__defineProperty_value` and returns immediately if absent, BEFORE its prototype/static/species probes. Species later reads `__defineProperty_accessor` at line 387 and returns `{commit:false}` when that or the symbol boxer is missing. `ensureSymbolCarrier` immediately preceding this registers `__box_symbol` on its normal return.

Thus the proposed partial-runtime witness specifically needs a Promise own-property seed to run while the native data helper is present and the native accessor helper is absent. A seed that returns before its probes does not qualify as a declined probe. A compiler exception also does not qualify as a callback returning `commit:false`.

## Actual ordering and callers

1. `ensureObjectRuntime` (`object-runtime.ts:1059`) returns on an existing `ctx.objectRuntimeTypes`. On first entry it publishes that latch at line 1466, before most helpers.
2. Its only production call to `buildObjectDescriptorHelpers` is at line 6533. A recursive `ensureObjectRuntime` after the latch does NOT recursively enter this builder.
3. `buildObjectDescriptorHelpers` (`object-runtime-descriptors.ts:200`) constructs the data helper first. Before registering it, it calls the union registrar, TypeError constructor registrar and exception-tag ensure at lines 311–314.
4. The data helper is registered at lines 751–775: local `registerNative` in `object-runtime.ts:1479` interns the function type, mints its handle, sets the function-map entry, then appends the body.
5. The builder immediately constructs the accessor helper and registers it at lines 1271–1298. No caller return, source-AST compile, seed-provider invocation, Promise glue registration or speculative callback invocation occurs in between. Detailed callees are closed below.
6. Wrapper-constructor carrier preparation runs later at `object-runtime.ts:7004`; pending prototype seeder flush runs later at line 7073. They therefore cannot observe the missing-accessor interval through this first invocation.

The three relevant phases are consequently:

- Before the data registration: even a real Promise seed reentry stops at the data-helper guard, with no species probe.
- Between data/accessor registrations: the only possible interleaving would be through a callee of accessor-body construction; none of those invokes the Promise/constructor/source compiler path on this basis.
- After accessor registration: reentrant seeds can reach species, but the accessor entry exists.

This directly closes the previously identified _normal partial-runtime caller-order_ uncertainty rather than inferring it from zero observed declines.

## Complete accessor-construction callee boundary

The actual interval was read in full, `object-runtime-descriptors.ts:826–1271`, including nested instruction-array expressions. Its JavaScript calls are:

- `addUnionImportsViaRegistry` → real delegate `addUnionImports` (`shared.ts:622`; registration `index.ts:12055`; `registry/imports.ts:969`). It returns at `hasUnionImports` because the same builder invoked it before data registration at line 311. The sole assignment to that latch found in source is the registrar setting it true; no reset appears between these calls. If an outer union registration is in progress, its latch is already true as well.
- `emitWasiErrorConstructor(ctx,"TypeError",1)` → `emitErrorStructConstructor` (`registry/error-types.ts:274`). It returns at `funcMap.has("__new_TypeError")`: the same exact constructor was prepared at line 312 before data registration. No intervening callee deletes this entry.
- `ensureExnTag` (`registry/physical-imports.ts:99`) returns its existing tag index, prepared by the data helper at line 314. No intervening callee resets it.
- Local `accHfBit` and `accEflBit`: instruction-array construction only.
- Local `accThrow`: `addStringConstantGlobal` → native-string registration (`registry/imports.ts:208/221`) adds string metadata/pool entries, with no host import or compile callback in nativeStrings mode. `stringConstantExternrefInstrs` (`native-strings.ts:65`) → `nativeStringLiteralInstrs` → `nativeStringLiteralMaterialization` (`native-string-literals.ts:30/42`) → pure literal planning and interned string globals. The error messages here are fixed short literals, not user AST or oversized strings. Even the separate oversized materializer builds literal chunks/helper instructions, not Promise/constructor providers.
- `defineCarrierBagSubstitutionArm` (`carrier-bag-define.ts:143`) → `defineCarrierBagEnsureInstrs` and `sharedBagCarrierTest`: read function-map entries and build instructions; emitted `call` instructions do NOT invoke those Wasm functions during compilation. Its `fnIntrinsicSeedInstrs` call (`fn-intrinsic-seed.ts:114`) either reads its cached helper or reserves an empty helper using type/handle allocation. It does NOT fill that helper or compile a source body. In this builder the same substitution was already constructed for the data helper at line 511.
- Local `vecOverlayArm` (`object-runtime-descriptors.ts:252`): reads the already reserved overlay and builds instruction arrays. It does not invoke `reserveVecOverlayHelpers` again.
- `ctx.funcMap.get` and the final `registerNative`: map reads/type interning/function handle allocation and append. `addFuncType` delegates to structural type interning; `mintDefinedFunc` and `pushDefinedFunc` delegate to physical handle allocation/append (`func-space.ts:203/211`, `wasm/physical/function-handles.ts:54/67/83`). The optional slot trace prints diagnostics only; it does not compile user code.

No source-dependent callback or seeder is hidden in the emitted `call`/`call_ref` instruction objects. Host-boundary branches likewise only construct instructions, and the experiment's standalone lane does not activate the JS boundary imports.

## Could reservation or rollback reopen the gap?

- Native late imports cannot pre-register just one of these as a host import: `expressions/late-imports.ts:482` routes names in `OBJECT_RUNTIME_HELPER_NAMES` through `ensureObjectRuntime` and RETURNS its map lookup, including undefined on incomplete reentry; it does not fall through to `addImport`. Both descriptor names belong to that set.
- Ordinary `withSpeculativeCompile` / `probeCompiledType` rollback (`context/speculative.ts`) truncates body/locals/errors and removes newly added function IMPORT names, not the native defined functions created by `registerNative`. On this native helper route no corresponding imported descriptor name was minted, so that rollback does not remove only the accessor. This is about the actual implementation, not a claim of complete rollback of every compiler cache.
- There are broader function-table rollback sites in `expressions/eval-inline.ts` (failed synthetic hoists around lines 1766, 2143, 2328 and 2515). They truncate defined functions and delete map keys above a saved cutoff; they do not restore `objectRuntimeTypes` there. Those are NOT invoked in the audited interval: the interval contains no synthetic hoist/source compilation. A surrounding checkpoint starts before or ends after the uninterrupted registration pair, not between them. This rules them out as an ordinary _mid-pair callback_, not as a proof that all failed-hoist recovery preserves every cache.
- Runtime JavaScript mutation of Promise/species does not mutate the compiler's function-map registration order. Forcing a map deletion or provider return in a harness would not test a source-reachable decline.

## Bounded theorem and explicit unknowns

For the pinned normal standalone/nativeStrings synchronous provider construction, with real compiler-created context and original delegates, no compiler exception interrupting the registration pair, and no separately induced internal-name/cache corruption: a Promise seed cannot execute a species callback with the data descriptor present and accessor absent _because object-runtime initialization is partially complete_. It is either too early and returns before probes, or late enough that accessor registration has completed. No valid source witness for the requested partial-initialization mechanism exists within that boundary.

Excluded/unproven, not silently accepted:

1. A caught compiler-internal exception after data registration but before accessor registration could leave the early latch set. No source expression is evaluated inside that interval; demonstrating such an exception needs a separate real compiler invariant/resource-failure path, not JS throwing from user code. No such valid source witness is identified here.
2. Arbitrary earlier failed-hoist recovery, evaluator rollback, internal helper-name collisions, custom compiler delegates, or cache corruption is not proved safe by this local audit. Failed eval hoists are concrete source locations to audit if that broader question is assigned. They are not evidence that this missing-accessor guard is source-reachable, and are absent from the fixed Promise fixtures.
3. Other targets, nativeStrings-off behavior and other constructor families are outside this proof.
4. Throws and early no-op seed returns are not declined speculative outcomes. No coverage counter or fixture is changed to count them.

Combined with the prior prototype/static Promise branch audit, this explains why genuine Promise declines remain absent on the measured completed-provider path without inventing a positive control. The original 5/5 correspondence / 0/5 coverage stays frozen; a source proof is not a fabricated executed decline. Legacy retirement remains forbidden pending the required implementation/equivalence decision.

## Witness-review correction retained

V2's comparator recomputes recorded ancestry and transaction conditions only. Its reachability booleans come from the observer and are NOT independently derived physical-identity proof from receipts. This audit does not expand that claim or modify the frozen v2 artifacts.

## File hashes read for this audit

- `object-runtime.ts`: `a5726dbf7b121cb8e1b935ca47b3d38003cdc2ef0989b1f3665793f8c5236378`
- `object-runtime-descriptors.ts`: `77088a39726f66eab25e178d921dead031e5bf09700e9b1c342860e71c78a463`
- `carrier-bag-define.ts`: `d760141beb8aa18f51e316c53e3820f023121308ff86dbc644edc67f0a6499cb`
- `fn-intrinsic-seed.ts`: `0a94e4508b70df3d859d2f030a2685a87ede3a2dd986df259ecaf06e086c9ec3`
- `registry/imports.ts`: `39d00e9bc74ce6bbc94e70f06d7421017ef2b5acb6cdc94d50f1c518baefb4e1`
- `registry/error-types.ts`: `34b3945111463db39a9592fc7fdca2d35f0b533ea9ac5bfcbcf625f391ddd120`
- `registry/physical-imports.ts`: `3da243e8608c131421706ddf39c459649be7e86847f18e84900fb1d5d87a4dba`
- `native-string-literals.ts`: `8e330f3d2f7a46df6c984b2cbf8c9911c744d28d48c96739379be57342308f61`
- `context/speculative.ts`: `ba2c77f8c3c86d6790f4c4c733c2b7a65981a5a26a054e21e6f6cae4e2efaa02`
- `expressions/eval-inline.ts`: `4a55f94a3b7b5afb9899f4e141abb55a5bdfabed9e6028c88bedea341a34ec16`
- `expressions/late-imports.ts`: `20a882b235deb9bfe3dd83943405972110c939a1f2f951ce6918c27934402636`
- `func-space.ts`: `0a203e2616db871c7eccf832a9510ae5e89b30d67f281b0f259ee9b0953e781c`
- `registry/types.ts`: `54a64e571a8ef1b42ca72e6837f8306cbe9cbe009a795d984404cb7cdd54f886`
- `wasm/physical/function-handles.ts`: `c6a82f897b8fa6c755b68129926e2deb9b6e885a25ecd2e253a444d0bcb5193f`
- `runtime/wasmgc/values/string-literal-bodies.ts`: `c5cd6dad450a3eaffa4d07c5864ec89bd09b2170d544c0373faa2773a42fcafa`

Only source reads/searches/hashes and this new own-tree audit document were performed. No execution, compiler lease, source fixture changes, production edits, commits, pushes, or parent edits.
