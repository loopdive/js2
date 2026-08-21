// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Backend context creation ownership.
 *
 * Constructs a fresh CodegenContext and the minimal registries used by both generators.
 */
import { ts } from "../../ts-api.js";
import type { WasmModule } from "../../ir/types.js";
import type { IrPlanningIdentityContext } from "../../ir/planning-identity.js";
import { createTypeOracle } from "../../checker/oracle-backend.js";
import { UsageInference } from "../../checker/usage-inference.js";
import { resolveCompileTargetProfile, type CompileTargetProfile } from "../../target-profile.js";
import { getOrRegisterVecType, registerNativeStringTypes } from "../registry/types.js";
import { nativeLiteralRegExpEngineConfig } from "../regexp-standalone.js";
import { createFallbackCounts } from "../fallback-telemetry.js";
import type { ProgramAbiSession } from "../program-abi-session.js";
import { createBodyRouteAudit } from "./body-route-audit.js";
import { ProgramAbiClassCallableRegistry } from "../program-abi-class-callable-planning.js";
import { ProgramAbiCallableRegistry } from "../program-abi-callable-planning.js";
import { ProgramAbiExportRegistry } from "../program-abi-export-planning.js";
import { ProgramAbiCallableProviderRegistry } from "../program-abi-provider-planning.js";
import { ProgramAbiGlobalRegistry } from "../program-abi-global-planning.js";
import { ProgramAbiModuleInitCallableRegistry } from "../program-abi-module-init-planning.js";
import { ProgramAbiSourceCallableRegistry } from "../program-abi-source-callable-planning.js";
import { ProgramAbiTypeRegistry } from "../program-abi-type-planning.js";
import type { CodegenContext, CodegenOptions } from "./types.js";

function selectNativeRegExpEngine(targetProfile: CompileTargetProfile) {
  return targetProfile.target === "standalone" ||
    (targetProfile.environment === "javascript" && targetProfile.semanticProviders === "native-first")
    ? nativeLiteralRegExpEngineConfig()
    : null;
}

export function createCodegenContext(
  mod: WasmModule,
  checker: ts.TypeChecker,
  options?: CodegenOptions,
  programAbiSession?: ProgramAbiSession,
  irPlanningIdentityContext?: IrPlanningIdentityContext,
): CodegenContext {
  programAbiSession?.assertModule(mod);
  const targetProfile = resolveCompileTargetProfile(options);
  // #1524 — strict-mode default policy. WASI builds enforce the dual-mode
  // architectural principle (`CLAUDE.md` → "JS host optional"); pass
  // `strictNoHostImports: false` to opt out (the CLI's
  // `--allow-host-imports` does this). Strict mode also implies
  // `nativeStrings` so the wasm:js-string namespace is not requested.
  const strictNoHostImports = targetProfile.strictEnvImportGate;
  // #1470 — standalone target forces nativeStrings:true so the module has
  // no `wasm:js-string` and no env JS-host string helpers. Use logical OR
  // for the implication chain so `wasi: false` doesn't short-circuit
  // `standalone: true` (`?? ` returns the LHS on `false`).
  // #1588 PR-B: `utf8Storage` implies nativeStrings on the WasmGC backend —
  // host-string mode has no in-heap bytes to choose a width for.
  const nativeStrings =
    options?.nativeStrings ?? !!(options?.fast || targetProfile.nativeStringsRequiredByPolicy || options?.utf8Storage);
  // #2783 — the dynamic-linking set: external namespaces left as link-time
  // imports (satisfied by a preloaded provider) instead of inline-lowering.
  // Namespace authority is target-neutral: standalone and JS-hosted modules can
  // both link an explicit Wasm/embedder provider. The internal node:fs lowering
  // remains WASI-specific below so existing non-WASI code generation is byte
  // neutral when the namespace is merely declared as externally provided.
  const linkedNamespaces: ReadonlySet<string> = new Set(options?.link ?? []);
  const ctx: CodegenContext = {
    mod,
    targetProfile,
    programAbiSession,
    irPlanningIdentityContext,
    checker,
    sourceIsModule: false,
    // (#1930) THE type-query boundary. New codegen code MUST prefer
    // `ctx.oracle` over raw `ctx.checker` access — the oracle-ratchet CI gate
    // (`pnpm run check:oracle-ratchet`) fails on any growth of direct checker
    // usage under src/codegen/. Contract: registry-free, side-effect-free,
    // memoized (see src/checker/oracle.ts). The BACKEND is selectable (#4218).
    oracle: createTypeOracle(checker, options?.oracleBackend),
    // (#684) Usage-based any-local inference. Constructed from the local
    // `checker` parameter (a raw-checker capture that lives entirely in the
    // checker layer), so this instantiation adds no oracle-ratchet debt.
    usageInference: new UsageInference(checker),
    useUsageInfer: options?.useUsageInfer ?? process.env.JS2WASM_USAGE_INFER !== "0",
    funcMap: new Map(),
    ambientBuiltinFuncMap: new Map(),
    irUnitFuncMap: new Map(),
    structMap: new Map(),
    typeIdxToStructName: new Map(),
    structFields: new Map(),
    booleanPropertyNames: new Set(),
    noBrandShapeTypes: new Set(),
    fnctorReservedTypeIdx: new Map(), // #2773 S1 — up-front fnctor struct-type slots

    numImportFuncs: 0,
    jsStringImports: new Map(),
    currentFunc: null,
    funcStack: [],
    errors: [],
    // #2089 — silent-fallback telemetry counters.
    fallbackCounts: createFallbackCounts(),
    trackSilentFallbacks: options?.trackSilentFallbacks,
    // (#2119) default true: real module input is strict → unmapped
    // arguments. The test262 harness passes false for script tests.
    inferModuleStrictArguments: options?.inferModuleStrictArguments ?? true,
    // #1923 — IR post-claim demotions; always collected (cheap), mirroring
    // fallbackCounts. Surfaced on CompileResult.irPostClaimErrors for the gate.
    irPostClaimErrors: [],
    // #3519 — normal compiles pay no ledger allocation cost.
    irOutcomes: options?.trackIrOutcomes ? [] : undefined,
    irBodyRouteAuditSession: createBodyRouteAudit(options, irPlanningIdentityContext, targetProfile.target),
    lastKnownNode: null,
    externClasses: new Map(),
    pseudoExternClasses: new Map(),
    funcOptionalParams: new Map(),
    anonTypeMap: new Map(),
    anonTypeCounter: 0,
    stringLiteralMap: new Map(),
    stringLiteralValues: new Map(),
    stringLiteralCounter: 0,
    funcSourceText: new Map(),
    stringGlobalMap: new Map(),
    numImportGlobals: 0,
    hasStringImports: false,
    enumValues: new Map(),
    enumStringValues: new Map(),
    arrayTypeMap: new Map(),
    vecTypeMap: new Map(),
    exportSignatures: new Map(),
    externClassParent: new Map(),
    declaredGlobals: new Map(),
    callbackCounter: 0,
    capturedGlobals: new Map(),
    capturedGlobalsWidened: new Set(),
    classSet: new Set(),
    usesNewTarget: false, // (#2023) set by the pre-scan in generateModule
    newTargetGlobalIdx: undefined, // (#2023)
    classNewTargetIds: new Map(), // (#2023) className → stable 1-based i32 id
    usesDynamicProto: false, // (#802) set by the scanForDynamicProto pre-scan
    dynamicProtoClasses: new Set(), // (#802) hierarchy-ROOT class names receiving proto mutation (Slice B)
    dynamicProtoLiteralNodes: new WeakSet(), // (#802) object-literal proto receivers (Slice A)
    dynProtoSentinelGlobalIdx: undefined, // (#802) "explicit null proto" sentinel global
    usesArrayHoles: false, // (#2001 S1) set by the scanForArrayHoles pre-scan
    holeyArrayDeclarations: new Set(), // (#4222) exact bounded sized-Array bindings
    holeyArrayConstructorNodes: new Set(), // (#4222) exact sparse carrier constructors
    holeyArrayFilterCallNodes: new Set(), // (#4222) exact direct filter consumers
    protoIndexDirty: false, // (#2001 S2, widened #4160) scanForArrayHoles: Array/Object.prototype index write
    protoNamedDirty: false, // (#4176) scanForArrayHoles: named write onto a branded builtin's .prototype
    protoMemberDirty: false, // (#2175 V2-S3b-1) scanForArrayHoles: branded builtin .prototype reaches the dynamic reader as a VALUE
    vecAccessorDescriptorDirty: false, // (#4159) scanForArrayHoles: a non-data descriptor may exist somewhere
    inheritedSetDescriptorDirty: false, // (#4504) scanForArrayHoles: a descriptor may affect inherited [[Set]]
    inheritedSetDirtyKeys: new Set<string>(), // (#4602) scanForArrayHoles: statically-named keys such a descriptor could use
    vecIndexDeleteDirty: false, // (#4222) scanForArrayHoles: a `delete arr[i]` may tombstone an index
    vecOwnKeysDirty: false, // (#4230 L1) scanForArrayHoles: a descriptor define / own-name read is present
    dynamicCodeDirty: false, // (#4159/#4160) scanForArrayHoles: eval/Function present ⇒ both flags above forced
    usesVecValue: false, // (#2083) flipped by genuine getOrRegisterVecType usage
    // (#4035) "auto" = the JS host needs the bridge as its calling convention,
    // a JS-free host does not. Standalone/WASI callers that DO inspect the
    // module (the test262 harness) pass hostBridge: "always".
    emitHostBridge: targetProfile.hostValueInterop !== "off",
    suppressVecUsageFlag: false, // (#2083) true only during the two prereg calls below
    holeTypeIdx: -1, // (#2001 S1) $Hole struct type; lazily registered
    holeGlobalIdx: undefined, // (#2001 S1) $__hole singleton global
    importMetaTypeIdx: undefined, // (#2970) shared $ImportMeta struct type
    importMetaGlobals: new Map(), // (#2970) per-source-file import.meta object globals
    inModuleInitFlagReads: undefined, // (#2800) recorded __in_module_init flag reads
    inModuleInitGlobalIdx: undefined, // (#2800) __in_module_init flag global (set at finalize)
    usesDynRead: false, // (#2580 M0) set by a __dyn_has/__dyn_get call site (M1+); M0 adds none
    dynReadHelpersEmitted: false, // (#2580 M0) ensureDynReadHelpers idempotence latch
    usesDynMemberGet: false, // (#3053 U0) set by U1's IR member-read call site; U0 adds none
    dynMemberGetHelpersEmitted: false, // (#3053 U0) ensureDynMemberGet idempotence latch
    classThrowsOnEval: new Set(),
    topLevelFunctionNames: new Set(), // (#1983) for class-member funcMap key collision detection
    topLevelFunctionDeclarations: new Map(),
    classMethodSet: new Set(),
    deferredClassBodies: new Set(),
    classAccessorSet: new Set(),
    structAccessorClosure: new Map(), // (#1888 S5c) struct accessors compiled as host-free closures
    staticAccessorSet: new Set(),
    staticMethodSet: new Set(),
    staticProps: new Map(),
    protoOverrides: new Map(), // #1719 CPR — captured prototype-member overrides
    staticInitExprs: [],
    closureCounter: 0,
    closureMap: new Map(),
    closureInfoByTypeIdx: new Map(),
    hostDynamicClassMethodNames: new Set(),
    genericResolved: new Map(),
    funcRestParams: new Map(),
    funcUsesArguments: new Set(),
    extrasArgvGlobalIdx: -1,
    extrasArgvVecTypeIdx: -1,
    argcGlobalIdx: -1,
    currentThisGlobalIdx: -1,
    callerStrictGlobalIdx: -1,
    sourceFunctionStrictness: new Map(),
    sourceFunctionStrictnessByBody: new Map(),
    valueOfClosureTypes: new Map(),
    toPrimitiveSharedClaimed: new Set(),
    toPrimitiveForkedStructs: new Set(),
    exnTagIdx: -1,
    hasUnionImports: false,
    asyncFunctions: new Set(),
    generatorFunctions: new Set(),
    generatorYieldType: new Map(),
    nativeGeneratorResultTypeIdx: -1,
    nativeGenerators: new Map(),
    moduleGlobals: new Map(),
    globalLexicalBindings: new Set(),
    liveFuncBindingGlobals: new Set(),
    moduleInitStatements: [],
    nestedFuncCaptures: new Map(),
    funcMapOwnerDecl: new Map(),
    classParentMap: new Map(),
    classBuiltinParentMap: new Map(),
    classExternrefBackedSet: new Set(),
    classTagCounter: 0,
    classTagMap: new Map(),
    classExprNameMap: new Map(),
    anonClassExprNames: new Map(),
    functionNameMap: new Map(),
    sourceMap: options?.sourceMap ?? false,
    tupleTypeMap: new Map(),
    fast: options?.fast ?? false,
    nativeStrings,
    // (#745 S4.5 default-flip) union→$AnyValue rep — default ON in
    // native-string lanes now that the S3 (eq/truthiness/concat) and S4
    // (params/returns/any-boundary) consumer sweeps landed. Host (JS-host)
    // lane stays default-OFF until S5 (hard-gated on #2141). Explicit option
    // wins; set JS2WASM_UNION_ANYREP=0 to force the legacy externref union
    // regime for A/B control (mirrors JS2WASM_UNDEF_SINGLETON, #2106).
    unionAnyRep: options?.unionAnyRep ?? (nativeStrings && process.env.JS2WASM_UNION_ANYREP !== "0"),
    // #1719 S1 — ITER_OVERRIDDEN brand; set later by the
    // sourceOverridesArrayIterator pre-scan in index.ts. Default OFF.
    arrayIteratorMaybeOverridden: false,
    // #1588 PR-B: dual i8/i16 storage, default OFF.
    utf8Storage: !!options?.utf8Storage,
    testRuntime: options?.testRuntime ?? false,
    nativeStrDataTypeIdx: -1,
    anyStrTypeIdx: -1,
    nativeStrTypeIdx: -1,
    consStrTypeIdx: -1,
    hashedStrTypeIdx: -1,
    nativeStrLiteralGlobals: new Map(),
    usesStandaloneConsoleSink: false,
    stdoutAccGlobalIdx: -1,
    symbolTypeIdx: -1,
    utf8StrDataTypeIdx: -1,
    utf8StrTypeIdx: -1,
    nativeStrHelpersEmitted: false,
    nativeStrExternBridgeEmitted: false,
    testRuntimeStringHelpersEmitted: false,
    nativeStrHelpers: new Map(),
    nativeRegexHelpers: new Map(),
    nativeStrHelperImportBase: -1,
    // #1103a Wasm-native Map runtime
    mapTypeIdx: -1,
    mapEntryTypeIdx: -1,
    mapEntriesTypeIdx: -1,
    mapBucketsTypeIdx: -1,
    mapIterTypeIdx: -1,
    mapIterResultTypeIdx: -1,
    weakRefTypeIdx: -1,
    mapHelpers: new Map(),
    mapHelpersEmitted: false,
    objectLiteralAssignedPropertyNames: new Set(),
    objectLiteralAssignedPropertyTypes: new Map(),
    refCellTypeMap: new Map(),
    anyValueTypeIdx: -1,
    anyHelpers: new Map(),
    anyHelpersEmitted: false,
    moduleInitGuardApplied: false,
    indexSpaceFrozen: false, // #1984 — set true at the per-mode finalize boundary
    shapeMap: new Map(),
    templateCacheCounter: 0,
    templateVecTypeIdx: -1,
    holeyArrayTypeIdx: -1, // (#4222) dedicated sparse new Array(n) carrier, lazy
    vecBaseTypeIdx: -1, // (#2186) shared $__vec_base length supertype, lazy
    dvWindowTypeIdx: -1, // (#2159/#38) standalone DataView windowing wrapper, lazy
    subviewTypeIdx: -1, // (#2159/#2357/#47) standalone TypedArray subarray view, lazy
    subviewTypeMap: new Map(), // (#2357) per-elem-kind $__subview type idx
    taViewTypeMap: new Map(), // (#3054 B1) per-TA-name $__ta_view shared-backing view idx
    resizableAbTypeIdx: -1, // (#3054 C) $__resizable_ab subtype of $__vec_i32_byte, lazy
    taCtorTypeIdx: -1, // (#3054 D) $__ta_ctor {kind:i32} first-class TA constructor value, lazy
    taCtorSingletonGlobals: new Map(), // (#3054 D) per-kind boxed $__ta_ctor singleton module-globals
    taDynViewTypeIdx: -1, // (#3054 D) $__ta_dyn_view {length,buf,byteOffset,kind} runtime-kinded view, lazy
    boundFnTypeIdx: -1, // (#3140) $__bound_fn {target,thisArg,boundArgs} native bound-function carrier, lazy
    moduleUsesDynTaView: false, // (#3057) set by pre-scan when a dynamic `new ctorVar(buf)` exists
    errorStructTypeIdx: -1,
    widenedTypeProperties: new Map(),
    widenedVarStructMap: new Map(),
    widenedDefinePropertyKeys: new Set(),
    dynamicDescriptorWidenVars: new Set(),
    objectHashConsumerVars: new Set(),
    objectHashConsumerTypes: new Set(),
    dynamicObjectReturnFunctions: new Set(),
    growableObjectLiteralVars: new Set(),
    irWithOpenObjectTargetKeys: new Set(),
    ordinaryToPrimitiveObjectDeclarations: new Set(),
    ordinaryToPrimitiveObjectLiterals: new Set(),
    hostSpreadObjectGlobals: new Set(),
    externrefAccessorVars: new Set(),
    pendingMathMethods: new Set(),
    pendingMethodTrampolines: [],
    needsToUint32: false,
    classDeclarationMap: new Map(),
    wrapperNumberTypeIdx: -1,
    wrapperStringTypeIdx: -1,
    wrapperBooleanTypeIdx: -1,
    nativeBoxNumberTypeIdx: -1,
    nativeBoxBooleanTypeIdx: -1,
    nativeBigIntTypeIdx: -1,
    funcRefWrapperCache: new Map(),
    constructibleFuncRefWrapperCache: new Map(),
    constructibleClosureTypeIdxs: new Set(),
    nativeConstructProtoKey: new Map(),
    pendingInitBody: null,
    inlinableFunctions: new Map(),
    symbolCounterGlobalIdx: -1,
    symbolDescGlobalIdx: -1,
    symbolDescArrTypeIdx: -1,
    symbolRegKeysGlobalIdx: -1,
    symbolRegIdsGlobalIdx: -1,
    symbolRegCountGlobalIdx: -1,
    symbolRegIdsArrTypeIdx: -1,
    parentBodiesStack: [],
    liveBodies: new Set(),
    anonStructHash: new Map(),
    shapeIdByStructName: new Map(),
    shapeNameCsvById: [],
    structInsertionOrder: new Map(),
    funcTypeCache: new Map(),
    pendingLateImportShift: null,
    protoGlobals: new Map(),
    classMethodNames: new Map(),
    classMethodsCsvGlobal: new Map(),
    classObjectGlobals: new Map(),
    classStaticMethodNames: new Map(),
    classStaticMethodsCsvGlobal: new Map(),
    builtinObjectGlobals: new Map(),
    methodClosureGlobals: new Map(),
    nullThisTypeErrorReady: false, // (#2025)
    funcClosureGlobals: new Map(),
    wasi: targetProfile.target === "wasi",
    nodeGlobals: options?.nodeGlobals ?? false,
    // #2783 — namespaces left as link-time imports (WASI-gated above).
    linkedNamespaces,
    // #2625/#2783 — the linkable js2wasm:node-<mod> std-IO path only applies under
    // WASI; derived from `node:fs` membership in the (already WASI-gated) link set.
    linkNodeShims: targetProfile.target === "wasi" && linkedNamespaces.has("node:fs"),
    nodeFsReadSyncIdx: -1,
    nodeFsWriteSyncIdx: -1,
    standalone: targetProfile.target === "standalone",
    directEvalMode: options?.directEval ?? "legacy",
    // (#2141 S1) Honest generic any-boxing regime — default OFF (legacy tag-5
    // box-the-externref ABI, byte-identical modules). Flips in S4.
    honestAnyBoxing: options?.honestAnyBoxing ?? false,
    // (#2141 S2/S3, #2626, #2040 A1 default-flip) tag-5 boxed-VALUE eq
    // classifier — default ON. The #3032 lazy-generator waves (W3 TDZ
    // threading, #3302 capturing expressions, W4 method generators) removed
    // the eager-buffer vacuity that made the classifier's honest answers
    // unmask latent dstr failures (the 2026-06-22 −162 merge_group eject).
    // A/B-validated 2026-07-16: 0 flips across the eject canaries, the dstr
    // notSameValue family, the equality/search blast radius, and an
    // every-97th cross-tree control (see #2040). The emit site remains
    // standalone/wasi-gated (any-helpers.ts) — host lane byte-identical.
    // Set JS2WASM_TAG5_CLASSIFIER=0 to force the legacy always-false arm.
    tag5ValueEqClassifier: options?.tag5ValueEqClassifier ?? process.env.JS2WASM_TAG5_CLASSIFIER !== "0",
    // (#4173) Fast tag-pair dispatch in `__extern_strict_eq` + single-convert
    // `__is_truthy` ladder — default ON (A/B-validated on the standalone acorn
    // lane, see the issue's Results). Set JS2WASM_FAST_STRICT_EQ=0 to force
    // the legacy always-slow-path bodies for A/B control.
    fastStrictEq: options?.fastStrictEq ?? process.env.JS2WASM_FAST_STRICT_EQ !== "0",
    // (#2106 S1 default-flip) standalone $undefined tag-1 singleton regime —
    // default ON. The complete lockstep producer+consumer sweep landed behind
    // this flag in PR #2633; this flip makes the singleton the default
    // standalone/nativeStrings `undefined` representation so undefined is
    // observable to ===/??/?./typeof/ToString instead of aliasing null.
    // Host mode is unaffected (`undefinedSingletonActive` also gates on
    // standalone||nativeStrings). Set JS2WASM_UNDEF_SINGLETON=0 to force the
    // legacy (undefined ≡ null ≡ ref.null.extern) regime for A/B control.
    undefinedSingleton: options?.undefinedSingleton ?? process.env.JS2WASM_UNDEF_SINGLETON !== "0",
    // (#2796) Diff-test-harness fidelity — export __module_init + skip the wasm
    // start section so the host runs top-level code after setExports.
    deferTopLevelInit: options?.deferTopLevelInit ?? false,
    // #682/#4397 — native RegExp engine hook. Standalone and native-first JS
    // enable the reduced literal-substring backend; WASI retains its existing
    // narrowed refusals. Broader QuickJS libregexp ABI linking remains the
    // follow-up path for near-JS parity.
    standaloneRegExpEngine: selectNativeRegExpEngine(targetProfile),
    // (#1373b C-1) ON by default. The gate is narrow by construction: the IR
    // claims an async fn ONLY when the ONE async engine declines it
    // (`asyncEngineClaims` — sync-pass-through population), it is a top-level
    // declaration with an explicit `Promise<T>` annotation, and its body
    // passes the normal Phase-1 shape checks. Set JS2WASM_IR_ASYNC=0 to
    // disable (rollback lever).
    supportsAsyncIr: process.env.JS2WASM_IR_ASYNC !== "0",
    wasiFdWriteIdx: -1,
    wasiProcExitIdx: -1,
    wasiPathOpenIdx: -1,
    wasiFdCloseIdx: -1,
    wasiBumpPtrGlobalIdx: -1,
    wasiEnvironSizesGetIdx: -1,
    wasiEnvironGetIdx: -1,
    wasiEnvGetStrIdx: -1,
    wasiNodeFsFuncs: options?.wasiNodeFsFuncs ?? new Set(),
    ...(options?.dtsEntrypointSeeds ? { dtsEntrypointSeeds: options.dtsEntrypointSeeds } : {}),
    wasiRawImports: options?.wasiRawImports ?? new Set(),
    wasiMemAccessors: options?.wasiMemAccessors ?? new Set(),
    allowFs: options?.allowFs ?? false,
    // (#4238 slice 1) provider-build enablers — default off / undefined.
    externNativeTypes: options?.externNativeTypes ?? false,
    ...(options?.externImportModule ? { externImportModule: options.externImportModule } : {}),
    ...(options?.importMemory ? { importMemory: options.importMemory } : {}),
    strictNoHostImports,
    tdzGlobals: new Map(),
    tdzLetConstNames: new Set(),
    definedPropertyFlags: new Map(),
    nonWritableExternKeys: new Set(),
    sidecarDefinedPropertyKeys: new Set(),
    definePropertyReceiverKeys: new Set(),
    nonConfigurableAccessorKeys: new Set(),
    mappedArgsInfoByFunc: new Map(),
    nonExtensibleVars: new Set(),
    frozenVars: new Set(),
    sealedVars: new Set(),
    shapePropFlags: new Map(),
    funcConstructorMap: new Map(),
    fnctorPrototypeObject: new Map(),
    ensureStructPending: new Set(),
    nodeBuiltinGlobals: new Map(),
    jsxRuntime: options?.jsxRuntime,
  };
  ctx.programAbiModuleInitCallables = new ProgramAbiModuleInitCallableRegistry(
    ctx,
    programAbiSession,
    irPlanningIdentityContext,
  );
  ctx.programAbiSourceCallables = new ProgramAbiSourceCallableRegistry(
    ctx,
    programAbiSession,
    irPlanningIdentityContext,
  );
  if (programAbiSession) {
    ctx.programAbiCallableProviders = new ProgramAbiCallableProviderRegistry(programAbiSession, ctx);
    ctx.programAbiCallables = new ProgramAbiCallableRegistry(programAbiSession, ctx);
    ctx.programAbiGlobals = new ProgramAbiGlobalRegistry(programAbiSession, ctx);
    ctx.programAbiExports = new ProgramAbiExportRegistry(programAbiSession, ctx);
    if (irPlanningIdentityContext) {
      ctx.programAbiClassCallables = new ProgramAbiClassCallableRegistry(
        programAbiSession,
        ctx,
        irPlanningIdentityContext,
      );
      ctx.programAbiTypes = new ProgramAbiTypeRegistry(programAbiSession, ctx, irPlanningIdentityContext);
    }
  }

  // (#2083) Pre-register the `externref` + `f64` vec struct types up front for
  // type-index stability (every module reserves these slots regardless of
  // whether it uses arrays). These are NOT real array usage — suppress the
  // `usesVecValue` flag across them so arith-/string-only modules don't emit
  // the host-glue vec exports.
  ctx.suppressVecUsageFlag = true;
  getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  getOrRegisterVecType(ctx, "f64", { kind: "f64" });
  ctx.suppressVecUsageFlag = false;

  if (ctx.nativeStrings) registerNativeStringTypes(ctx);

  return ctx;
}
