// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Backend context creation ownership.
 *
 * This module constructs a fresh CodegenContext and performs the minimal
 * upfront registry bootstrap that generateModule/generateMultiModule rely on.
 */
import { ts } from "../../ts-api.js";
import type { WasmModule } from "../../ir/types.js";
import { getOrRegisterVecType, registerNativeStringTypes } from "../registry/types.js";
import { nativeLiteralRegExpEngineConfig } from "../regexp-standalone.js";
import { createFallbackCounts } from "../fallback-telemetry.js";
import type { CodegenContext, CodegenOptions } from "./types.js";

export function createCodegenContext(
  mod: WasmModule,
  checker: ts.TypeChecker,
  options?: CodegenOptions,
): CodegenContext {
  // #1524 — strict-mode default policy. WASI builds enforce the dual-mode
  // architectural principle by default (`CLAUDE.md` → "JS host optional");
  // pass `strictNoHostImports: false` to opt out (the CLI's
  // `--allow-host-imports` does this). Strict mode also implies
  // `nativeStrings` so the wasm:js-string namespace is not requested.
  const strictNoHostImports = options?.strictNoHostImports ?? options?.wasi ?? false;
  // #1470 — standalone target forces nativeStrings:true so the module has
  // no `wasm:js-string` and no env JS-host string helpers. Use logical OR
  // for the implication chain so `wasi: false` doesn't short-circuit
  // `standalone: true` (`?? ` returns the LHS on `false`).
  // #1588 PR-B: `utf8Storage` implies nativeStrings on the WasmGC backend —
  // host-string mode has no in-heap bytes to choose a width for.
  const nativeStrings =
    options?.nativeStrings ??
    !!(options?.fast || options?.wasi || options?.standalone || strictNoHostImports || options?.utf8Storage);
  const ctx: CodegenContext = {
    mod,
    checker,
    funcMap: new Map(),
    structMap: new Map(),
    typeIdxToStructName: new Map(),
    structFields: new Map(),
    numImportFuncs: 0,
    jsStringImports: new Map(),
    currentFunc: null,
    funcStack: [],
    errors: [],
    // #2089 — silent-fallback telemetry counters.
    fallbackCounts: createFallbackCounts(),
    trackSilentFallbacks: options?.trackSilentFallbacks,
    // #1923 — IR post-claim demotions; always collected (cheap), mirroring
    // fallbackCounts. Surfaced on CompileResult.irPostClaimErrors for the gate.
    irPostClaimErrors: [],
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
    classThrowsOnEval: new Set(),
    topLevelFunctionNames: new Set(), // (#1983) for class-member funcMap key collision detection
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
    genericResolved: new Map(),
    funcRestParams: new Map(),
    funcUsesArguments: new Set(),
    extrasArgvGlobalIdx: -1,
    extrasArgvVecTypeIdx: -1,
    argcGlobalIdx: -1,
    currentThisGlobalIdx: -1,
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
    moduleInitStatements: [],
    nestedFuncCaptures: new Map(),
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
    mapHelpers: new Map(),
    mapHelpersEmitted: false,
    refCellTypeMap: new Map(),
    anyValueTypeIdx: -1,
    anyHelpers: new Map(),
    anyHelpersEmitted: false,
    moduleInitGuardApplied: false,
    indexSpaceFrozen: false, // #1984 — set true at the per-mode finalize boundary
    shapeMap: new Map(),
    templateCacheCounter: 0,
    templateVecTypeIdx: -1,
    errorStructTypeIdx: -1,
    widenedTypeProperties: new Map(),
    widenedVarStructMap: new Map(),
    widenedDefinePropertyKeys: new Set(),
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
    wasi: options?.wasi ?? false,
    standalone: options?.standalone ?? false,
    // #682 — native standalone RegExp engine hook. Standalone mode enables the
    // reduced literal-substring backend; broader QuickJS libregexp ABI linking
    // remains the follow-up path for near-JS parity.
    standaloneRegExpEngine: options?.standalone ? nativeLiteralRegExpEngineConfig() : null,
    // (#1373b Slice 1) Scaffolding only — hardcoded false. Future slices
    // expose a CLI/option flag once the CPS lowering is parity-tested.
    supportsAsyncIr: false,
    wasiFdWriteIdx: -1,
    wasiProcExitIdx: -1,
    wasiPathOpenIdx: -1,
    wasiFdCloseIdx: -1,
    wasiBumpPtrGlobalIdx: -1,
    wasiEnvironSizesGetIdx: -1,
    wasiEnvironGetIdx: -1,
    wasiEnvGetStrIdx: -1,
    wasiNodeFsFuncs: options?.wasiNodeFsFuncs ?? new Set(),
    allowFs: options?.allowFs ?? false,
    strictNoHostImports,
    tdzGlobals: new Map(),
    tdzLetConstNames: new Set(),
    definedPropertyFlags: new Map(),
    sidecarDefinedPropertyKeys: new Set(),
    nonExtensibleVars: new Set(),
    frozenVars: new Set(),
    sealedVars: new Set(),
    shapePropFlags: new Map(),
    funcConstructorMap: new Map(),
    ensureStructPending: new Set(),
    nodeBuiltinGlobals: new Map(),
    jsxRuntime: options?.jsxRuntime,
  };

  getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  getOrRegisterVecType(ctx, "f64", { kind: "f64" });

  if (ctx.nativeStrings) {
    registerNativeStringTypes(ctx);
  }

  return ctx;
}
