// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Call expression compilation: direct calls, optional calls, closure calls,
 * property method calls, IIFEs, and conditional callees.
 */
import { ts, forEachChild } from "../../ts-api.js";
import { profilePhase } from "../../compile-profile.js";
import {
  isBigIntType,
  isBooleanType,
  isBooleanWrapperType,
  isExternalDeclaredClass,
  isGeneratorType,
  isNumberType,
  isNumberWrapperType,
  isPromiseType,
  isStringType,
  isStringWrapperType,
  isSymbolType,
  isVoidType,
} from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { compileArrayMethodCall, compileArrayPrototypeCall, resolveArrayInfo } from "../array-methods.js";
import { emitGlobalThisGopdFold } from "../dyn-read.js"; // (#2984)
import { tryEmitNullishReceiverCall } from "../nullish-receiver-coercible.js"; // (#4484 B) §7.3.2 on a syntactic null/undefined receiver
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js"; // (#1916 S3b) stable-regime minting
import { withRuntimeModuleCallableBindings } from "../runtime-module-callable-metadata.js";
import { initializeFunctionPoisonPillContext } from "../function-poison-pill.js";
import { expectedArgumentCountOfParams } from "../function-expected-argument-count.js";
import { reshapeFunctionCtorReflectiveCall } from "../function-ctor-reflective-call.js"; // (#4483) Function.call/apply → Function(…)
import { tryEmitApplyArgArrayTypeError } from "../apply-arglist-typeerror.js"; // (#4483) §20.2.3.1 step 4 primitive argArray
import { tryEmitClassConstructorCallWithoutNew } from "../class-call-without-new.js"; // (#4483) §10.2.1 step 2
import { buildClosureResultBoxing } from "../closures/result-boxing.js"; // (#4082) the single closure-result→externref decision
import { emitCollectionIteratorVec, ensureMapGroupBy } from "../map-runtime.js"; // (#42) native Set/Map → vec, shared with spread / Array.from; (#3149) native Map.groupBy
import { isCollectionReflectiveCallShape, tryCompileCollectionReflectiveCall } from "../collections-brand.js"; // (#2604/#3171) {Map,Set,WeakMap,WeakSet}.prototype.METHOD.call brand-check
import { classMemberFuncKey, fnctorAncestorOfClass } from "../class-member-keys.js"; // (#1983 / #3123)
import {
  ensureIterStepScratchGlobal,
  ensureNativeArrayFromMapped,
  ensureNativeIteratorRuntime,
} from "../iterator-native.js"; // (#2169c) native Array.from drain / (#3146) Iterator-statics intrinsics / (#3206) native Array.from(src, mapFn)
import { reserveClosedMethodDispatch, reserveClosedMethodDispatchVararg } from "../closed-method-dispatch.js";
import { emitNativeDateParse } from "../date-parse-native.js"; // (#2164) pure-Wasm Date.parse / new Date(str)
import { observeHostDynamicMethodCallArity } from "../dynamic-method-call-arity.js";
import { NATIVE_HOF_METHODS } from "../hof-native.js";
import { ensureTaMapFilterHelper } from "../ta-hof-map-filter.js";
import { LAZY_ITER_METHODS } from "../iter-lazy-native.js"; // (#2903 R3b) flatMap closure-path exemption
import {
  ensureObjVecBuilders,
  ensureObjectGroupBy,
  ensureObjectRuntime,
  reserveApplyClosure,
  reserveBindDynHelper,
} from "../object-runtime.js";
import { ensureStringRawHelper } from "../string-raw.js"; // (#3147)
import { tryEmitStandaloneThenThenableMissArm } from "../then-thenable-miss.js"; // (#4394)
import {
  emitMicrotaskEnqueue,
  emitStandalonePromiseFinally,
  emitStandalonePromiseReject,
  emitStandalonePromiseResolve,
  emitStandalonePromiseThen,
  emitStdinAvailable,
  emitStdinEof,
  emitStdinReadByte,
  emitStdinSetReader,
  emitStdinStop,
  emitTimerAdd,
  emitTimerCallbackWrapper,
  emitTimerCancel,
  ensurePromiseSettleFunctions,
  ensureTimerHeap,
  getDrainFuncIdxForWasiStart,
  getOrRegisterPromiseType,
  getRunLoopNowFuncIdx,
  isStandalonePromiseActive,
  isStandaloneThenChainNativeActive,
  isStdinReactorActive,
  type StandalonePromiseThenCallback,
} from "../async-scheduler.js";
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileArrowAsClosure,
  compileArrowFunction,
  computeClosureWrapperSig,
  getClosureFuncSelfTypeIdx,
  getFuncRefWrapperRootTypeIdx,
  getFuncSignature,
  getOrCreateFuncRefWrapperTypes,
} from "../closures.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import {
  tryBorrowedPrototypeBrandThisThrow,
  tryBorrowedPrototypeNullishThisThrow,
} from "../builtin-prototype-brand.js"; // (#4076, #5143)
import { tryCompilePromiseCallWithoutNew } from "../promise-newtarget.js"; // (#5143)
import {
  appendDynamicCandidateArgcSetup,
  appendExternResultArgcReset,
  buildArgcExtrasSetupFromLocals,
  buildArgcResetNoLazyExtras,
} from "./argc-extras.js";
import { emitMaterializedArgumentsVector, prepareCompiledApplyBridge, tryBindApply } from "./apply-arguments-vector.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
import { snapshotSpeculative, rollbackSpeculative } from "../context/speculative.js";
import { emitVirtualMethodDispatchByTag } from "./virtual-dispatch.js";
import { ensureCurrentThisGlobal } from "../statements/nested-declarations.js";
import { buildStandardTryTable } from "../../ir/try-table.js";
import { installableReceiverInstrs } from "../helpers/undefined-receiver.js"; // (#4555) runtime-eval receiver seam
import {
  consumeNativeIteratorResultBuffer,
  enterNativeIteratorResultCallback,
  markNativeIteratorResultBuffer,
  nativeIteratorResultThenReceiver,
} from "../promise-native-iterator-result.js";
export { tryEmitAsyncGenNextDispatch } from "../promise-native-iterator-result.js";

// (#1299) Lives in its own subsystem module since 2026-08-23; re-exported here
// because call sites import it from `calls.ts`.
export { emitVirtualMethodDispatchByTag };

/**
 * Install the unbound-call receiver marker around a dynamically dispatched
 * callable invocation.
 *
 * A closure body that reads `this` uses `__current_this` when it has no lexical
 * receiver.  Member-call dispatchers deliberately install their receiver in
 * that global, but a bare call has no Reference base (§13.3.6.2), so its
 * thisArgument is `undefined` and the global must be empty while the callee
 * runs.  Leaving an enclosing member receiver in place made
 * `assert.throws(TypeError, function () { this.missing(); })` observe the
 * outer `assert` function as `this` and skip the expected TypeError.
 *
 * The body is parked in a local before restoring the previous receiver.  The
 * target-tagged scaffold restores it on both normal and tagged-exception exits
 * so a caught throw cannot leak the unbound marker into the surrounding call.
 */
export function emitBareCallReceiverReset(
  ctx: CodegenContext,
  fctx: FunctionContext,
  body: Instr[],
  resultType: ValType | null,
): Instr[] {
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  const previousThisLocal = allocLocal(fctx, `__bare_prev_this_${fctx.locals.length}`, { kind: "externref" });
  const resultLocal =
    resultType === null ? undefined : allocLocal(fctx, `__bare_result_${fctx.locals.length}`, resultType);
  const restoreOnException = (fctx.tryCatchDepth ?? 0) > 0;
  const exceptionLocal =
    restoreOnException && (ctx.standalone || ctx.wasi)
      ? allocLocal(fctx, `__bare_exception_${fctx.locals.length}`, { kind: "externref" })
      : undefined;

  const restore: Instr[] = [
    { op: "local.get", index: previousThisLocal },
    { op: "global.set", index: currentThisGlobalIdx },
  ];
  const parkedBody = [...body];
  if (resultLocal !== undefined) parkedBody.push({ op: "local.set", index: resultLocal });

  const protectedCall: Instr | undefined = !restoreOnException
    ? undefined
    : exceptionLocal !== undefined
      ? buildStandardTryTable({ kind: "empty" }, parkedBody, [
          {
            kind: "catch",
            tagIdx: ensureExnTag(ctx),
            payloadType: { kind: "externref" },
            body: [
              { op: "local.set", index: exceptionLocal },
              ...restore,
              { op: "local.get", index: exceptionLocal },
              { op: "throw", tagIdx: ensureExnTag(ctx) },
            ],
          },
        ])
      : {
          op: "try",
          blockType: { kind: "empty" },
          body: parkedBody,
          catches: [],
          catchAll: [...restore, { op: "rethrow", depth: 0 }],
        };

  return [
    { op: "global.get", index: currentThisGlobalIdx },
    { op: "local.set", index: previousThisLocal },
    { op: "ref.null.extern" },
    { op: "global.set", index: currentThisGlobalIdx },
    ...(protectedCall === undefined ? parkedBody : [protectedCall]),
    ...restore,
    ...(resultLocal === undefined ? [] : ([{ op: "local.get", index: resultLocal }] satisfies Instr[])),
  ];
}

function emitDynamicCallDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  dispatch: Instr[],
): Instr[] {
  // A property/element reference carries an explicit receiver and must retain
  // any receiver installed by its caller. Every other dynamic callee is a
  // value call: its Reference base is absent, so clear `__current_this` while
  // the selected closure runs (§13.3.6.2). Parenthesized/type-asserted forms
  // are still bare calls after their transparent wrappers are removed.
  let bareCallee: ts.Expression = expr.expression;
  while (
    ts.isParenthesizedExpression(bareCallee) ||
    ts.isAsExpression(bareCallee) ||
    ts.isSatisfiesExpression(bareCallee) ||
    ts.isNonNullExpression(bareCallee) ||
    ts.isTypeAssertionExpression(bareCallee)
  ) {
    bareCallee = bareCallee.expression;
  }
  const isBareCall = !ts.isPropertyAccessExpression(bareCallee) && !ts.isElementAccessExpression(bareCallee);
  return isBareCall ? emitBareCallReceiverReset(ctx, fctx, dispatch, { kind: "externref" }) : dispatch;
}
import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  ensureExnTag,
  ensureI32Condition,
  getArrTypeIdxFromVec,
  getOrRegisterBoundFnType,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
  nativeStringType,
  reserveVecMethodHelper,
  resolveWasmType,
  STRING_METHODS,
  TYPED_ARRAY_NAMES,
  typedArrayVecStorage,
} from "../index.js";
import { buildVecFromExternMaterializer, getVecInfo, vecFromExternFuncIdx } from "../type-coercion.js";
import {
  compileArrayConstructorCall,
  compileObjectLiteralAsExternref,
  compileSymbolCall,
  objectLiteralTakesStandaloneAnyObjectPath,
  resolveComputedKeyExpression,
  resolvePropertyNameText,
} from "../literals.js";
import { compileInternalCallArgument } from "./internal-call-argument.js";
import {
  jsonGapFromStaticSpace,
  staticSpaceValue,
  tryEmitJsonParseLiteral,
  tryEmitJsonStringifyStatic,
} from "../json-standalone.js";
import { emitJsonParsePrimitive, emitJsonQuoteString } from "../json-runtime.js";
import {
  emitJsonParseText,
  emitJsonParseTextReviver,
  emitJsonStringifyValue,
  emitJsonRawJson,
  emitJsonIsRawJson,
} from "../json-codec-native.js";
import {
  compileObjectDefineProperties,
  compileObjectDefineProperty,
  compileObjectKeysOrValues,
  compilePropertyIntrospection,
  emitDefinePropertyDescRuntime,
  emitNonObjectArgGuard,
} from "../object-ops.js";
import {
  BUILTIN_CTOR_NAMES,
  chainRootIsGrowable,
  emitArrayIsArrayExternrefPredicate,
  emitNullCheckThrow,
  isIrWithOpenObjectTargetReceiver,
  receiverIsCaughtErrorStringRead,
  receiverIsNativeStringValType,
  receiverMayBeNativeStringAtRuntime,
  tryEnsureNativeProtoBrand,
  typeErrorThrowInstrs,
} from "../property-access.js";
import { emitToNumber, emitToString } from "../coercion-engine.js";
import type { InnerResult } from "../shared.js";
import {
  brandExternMethodResult,
  coerceType,
  compileExpression,
  resolveEnclosingClassName,
  resolveThisStructName,
  valTypesMatch,
  VOID_RESULT,
} from "../shared.js";
import { compileSuperCall } from "../class-bodies.js"; // (#5153 F) nested `super(...)`
// (#2193 PR-B) reflective `m.call(thisArg, …)` on a `$NativeProto` member-closure value.
import {
  ensureArrayBufferNativeProtoGlue,
  ensureArrayNativeProtoGlue,
  ensureDataViewNativeProtoGlue,
  ensureDateNativeProtoGlue,
  ensureErrorNativeProtoGlue,
  ensureNativeErrorNativeProtoGlue,
  ensureNumberNativeProtoGlue,
  ensureBooleanNativeProtoGlue,
  ensureObjectNativeProtoGlue,
  ensureStringNativeProtoGlue,
  ensureGeneratorPrototypeNativeProtoGlue,
  emitTypedArrayIntrinsicCtorObject,
  emitArrayIteratorPrototypeSingleton,
  emitGeneratorFunctionPrototypeSingleton,
  emitGeneratorPrototypeSingleton,
  emitFunctionPrototypeObjectSingleton,
  isWiredTypedArrayViewName,
} from "../array-object-proto.js";
// (#4119) The §20.1.3.6 classifiers — the #2501 COMPILE-TIME tag fold and the
// runtime reflective one — now live together in their own subsystem module
// rather than in this driver.
import { ensureObjectProtoToStringRuntimeHelper, resolveObjectToStringTag } from "../object-proto-tostring.js";
import {
  OBJECT_PROTO_TOSTRING_CLASSIFY_FN,
  emitClassifierSelect,
  ensureObjectProtoToStringClassifierFn,
} from "../object-proto-tostring-native.js";
import { emitObjectProtoToStringWithSymbolTag } from "../object-proto-symbol-tag.js";
import {
  emitBrandCheckTypeError,
  ensureStandaloneNativeMethodClosure,
  getNativeProtoBuiltinGlue,
} from "../native-proto.js";
import { ensureRuntimeEvalAotCallableCarrierTypes } from "../runtime-eval-callable.js";
import { RUNTIME_EVAL_AOT_CALLABLE_BRAND_A, RUNTIME_EVAL_AOT_CALLABLE_BRAND_B } from "../runtime-eval-boundary.js";
import { wrapperProtoSyntacticMember } from "../wrapper-proto-dynamic-demand.js"; // (#4619)
import { resolveDefaultExpressionImportGlobal } from "../default-expression-import-global.js";
import { BUILTIN_STATIC_METHOD_ARITY } from "../builtin-fn-meta.js";
import { pushReflectiveCallReceiver } from "../reflective-call-receiver.js"; // (#3638)
import {
  isSymbolSpeciesKeyExpression,
  resolveBuiltinReceiverName,
  tryEmitStandaloneBuiltinSpeciesGopd,
  tryEmitStandaloneBuiltinStaticGopd,
  tryEmitStandaloneStructGopdKeyDispatch,
} from "../builtin-static-gopd.js"; // (#2984 Phase 3 + bucket-1 alias receivers + arg-2 name coercion + @@species)
import { compileStatement, hoistFunctionDeclarations } from "../statements.js";
import {
  emitDefaultParamInit,
  emitSetExtrasArgv,
  ensureArgcGlobal,
  maybeSetArgcForKnownCall,
} from "../statements/nested-declarations.js";
import {
  compileGuardedNativeStringMethodCall,
  compileNativeStringMethodCall,
  compileStringLiteral,
  emitBoolToString,
  emitBorrowedStringReceiverToString,
  isStaticUndefinedArg,
  tryThrowOnBigIntOrSymbolArg,
} from "../string-ops.js";
import { tryCompileNodeFsCall, tryCompileNodeProcessCall } from "../node-fs-api.js";
import { tryCompileDenoStdioCall } from "../deno-api.js";
import { tryCompileRawWasiCall } from "../raw-wasi-api.js";
import { tryEmitPromiseSubclassReceiver } from "./promise-subclass.js";
import { tryEmitStandalonePromiseStaticCallTypeError } from "./promise-static-call-typeerror.js";
import {
  emitStandalonePromiseCombinator,
  emitStandalonePromiseCombinatorRuntime,
  ensureCombinatorFunctions,
  ensureCombinatorToVec,
  isNativeCombinatorMethod,
  resolveExternrefVecArg,
  type NativeCombinator,
} from "../promise-combinators.js";
import { emitWasiErrorConstructor } from "../registry/error-types.js"; // (#2922) native TypeError for not-iterable reject
import { isSupportedBuiltinStaticProperty, resolveBuiltinNamespaceValueName } from "../builtin-static-globals.js";
import {
  defaultValueInstrs,
  emitGuardedFuncRefCast,
  emitGuardedRefCast,
  pushDefaultValue,
  pushParamSentinel,
} from "../type-coercion.js";
import {
  compileConsoleCall,
  compileDateMethodCall,
  compileMathCall,
  ensureDateDaysFromCivilHelper,
} from "./builtins.js";
import { tryCompileTemporalMethodCall, tryCompileTemporalStaticCall } from "../temporal-native.js";
import {
  compileCallableElementAccessCall,
  compileCallablePropertyCall,
  compileClosureCall,
  compileGetterCallable,
  compileObjectPrototypeFallback,
  runtimeSignatureParameters,
  tryExternClassMethodOnAny,
} from "./calls-closures.js";
import { compileOptionalCallExpression } from "./calls-optional.js";
import {
  emitStandaloneDirectEvalRuntime,
  emitStandaloneIndirectEvalRuntime,
  emitStandaloneGlobalScriptEvalRuntime,
  ensureRuntimeEvalCallableCarrier,
  isGlobalFunctionIdentifier,
  isFunctionCtorImmediateCall,
  tryStaticNewFunction,
  tryStandaloneDynamicFunctionCtorValue,
  tryStaticEvalInline,
  tryStaticFunctionCtorCall,
} from "./eval-inline.js";
import { tryHostDynamicFunctionCtorValue } from "./dynamic-function-ctor-value.js"; // (#4650)
import { tryEvalAsCommentPeephole } from "./eval-comment-peephole.js"; // (#1240) exhaustive comment eval loop
import { dynamicEvalRefusalMessages } from "./runtime-eval-provider.js";
import {
  ensureRuntimeEvalInterpretedCallbackType,
  ensureRuntimeEvalValueType,
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A,
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B,
  RUNTIME_EVAL_INTERP_CALLBACK_KIND_GENERIC,
  RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_EVAL,
  RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION,
  RUNTIME_EVAL_VALUE_KIND_BIGINT,
  RUNTIME_EVAL_VALUE_KIND_BOOLEAN,
  RUNTIME_EVAL_VALUE_KIND_NULL,
  RUNTIME_EVAL_VALUE_KIND_NUMBER,
  RUNTIME_EVAL_VALUE_KIND_REFERENCE,
  RUNTIME_EVAL_VALUE_KIND_STRING,
  RUNTIME_EVAL_VALUE_KIND_UNDEFINED,
} from "../runtime-eval-boundary.js";
import { compileExternMethodCall, compileSpreadCallArgs, emitLazyProtoGet } from "./extern.js";
import {
  compileStandaloneRegExpConstructor,
  emitStandaloneRegExpToStringFromExpr,
  isGlobalRegExpIdentifier,
  tryCompileStandaloneRegExpCompile,
  tryCompileStandaloneRegExpExec,
  tryCompileStandaloneRegExpSymbolCall,
  tryCompileStandaloneRegExpTest,
  tryCompileStandaloneRegExpToString,
  usesNativeRegExpProvider,
} from "../regexp-standalone.js";
import {
  buildThrowJsErrorInstrs,
  emitThrowRangeError,
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  maybeStampCompiledFunctionArgName,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import {
  tryJsxRuntimeCall,
  tryNamespaceNonCallable,
  tryNonCallableValueCall,
  tryObjectCoercionCall,
  tryRegExpConstructorCall,
} from "./calls-guards.js";
import { reshapeSloppyPrimitiveThisArg } from "./sloppy-this-toobject.js"; // (#4246)
import { planInlinedReceiver, releaseInlinedReceiver } from "./inlined-call-receiver.js"; // (#4246)
import { seedBoundFunctionMetaOnStack } from "../bound-fn-meta.js"; // (#4562/#4563) §20.2.3.2 steps 5-11
import { buildHostCallFallbackArm, ensureHostCallFallbackImports, planHostCallFallback } from "./host-call-fallback.js";
import { analyzeTdzAccessByPos, emitLocalTdzCheck, emitStaticTdzThrow } from "./identifiers.js";
import {
  emitUndefined,
  ensureGetUndefined,
  ensureLateImport,
  flushLateImportShifts,
  shiftLateImportIndices,
} from "./late-imports.js";
import { ensureAnyHelpers, undefinedExternInstrs } from "../any-helpers.js";
import { emitSymbolToString, ensureSymbolRegistry } from "../symbol-native.js";
import { resolveStructName } from "./misc.js";
import {
  tryCompileDateCallWithoutNew,
  tryCompileErrorCtorCallWithoutNew,
  tryCompileCollectionCtorCallWithoutNew,
} from "./new-builtin-globals.js";
import { compileSuperElementMethodCall, compileSuperMethodCall } from "./new-super.js";
import { compileIdentifierCall } from "./call-identifier.js";
import { compileBuiltinStaticCall, tryCompileFromCharCodeFamilyReflective } from "./call-builtin-static.js";
import { compileNamespaceStaticCall } from "./call-namespace-static.js";
import { compileReceiverMethodCall } from "./call-receiver-method.js";
import { compileTailDispatch } from "./call-tail-dispatch.js";
import { tryEmitIsPrototypeOfCallArm } from "./is-prototype-of-call-arm.js";
import { tryEmitRealmGlobalMemberCall } from "./realm-global-member-call.js"; // (#4491)
import {
  emitNativeGeneratorToVec,
  nativeGeneratorInfoForForOfSubject,
  tryCompileNativeGeneratorMethodCall,
} from "../generators-native.js";
import {
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  ensureStrToCharVecHelper,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
} from "../native-strings.js";
import { ensureTextEncodingHelpers } from "../text-encoding-native.js";
import { emitVariadicStringConcat, hostStringRepr, nativeStringRepr } from "../builtin-scaffold.js";
import { URI_DECODE_MASK, URI_ENCODE_MASK } from "../uri-encoding-native.js";
import {
  buildInt8ArrayCarrierMatch,
  emitArrayBufferResize,
  emitArrayBufferSlice,
  emitDataViewAccessor,
  ensureDvAccessorHelper,
  ensureTaDynCopyWithinHelper,
  ensureTaDynFillHelper,
  ensureTaDynReverseHelper,
  getOrRegisterDvWindowType,
  isDataViewAccessor,
} from "../dataview-native.js";
import {
  getLinearU8Buffer,
  getLinearU8ParamIndicesForCall,
  sourceParamCountFromExpanded,
  wasmParamIndexForSourceParam,
} from "../linear-uint8-signatures.js";
import { resolveNamedThisCallTarget, tryReshapeApplyToNamedThisCall } from "../named-this-call.js";
import {
  emitClosureReceiverInstall,
  finishClosureReceiverCall,
  planClosureReceiverInstall,
} from "../closure-receiver-install.js";
import { directEvalRunsAtScriptGlobal } from "../direct-eval-environment.js";
import { variableMayProduceHostCallable } from "../analysis/host-callable-initializer.js";
import { bindingMayReceiveHostCallable } from "../analysis/mixed-assignment-carrier.js";

// Registry extracted to its own leaf module (#1793; LOC ratchet #3102) —
// re-exported here so existing importers keep resolving via calls.js.
import { BUILTIN_CLASS_NAMES } from "./builtin-class-names.js";
import { maybeEmitLayoutHint } from "../fnctor-layout-emit.js"; // (#3927) per-type layouts
import { matchClosureInfoBySignature, tsSignatureHasRest } from "./closure-sig-match.js"; // (#4394) exact-first closure pick
export { BUILTIN_CLASS_NAMES };

/**
 * (#2631) Path-based node:fs functions that require a filesystem (path_open /
 * preopens). Distinct from the fd-based synchronous primitives readSync /
 * writeSync (no path). Under --target wasi these are rejected — standalone WASI
 * has no filesystem. `writeFileSync` is intentionally excluded: it has a
 * dedicated WASI lowering above (`__wasi_write_file_sync`).
 */
export const PATH_BASED_FS_FNS = new Set([
  "readFileSync",
  "readFile",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "openSync",
  "open",
  "unlinkSync",
  "unlink",
  "mkdirSync",
  "mkdir",
  "readdirSync",
  "readdir",
  "statSync",
  "stat",
  "existsSync",
]);

/**
 * (#3031) Per-source-file syntactic gate for the standalone Proxy [[Call]] arm:
 * does this file contain `new Proxy(...)` or a `Proxy.revocable(...)` call?
 * Cached per SourceFile (WeakMap). This complements the "`__proxy_create`
 * already registered" check in `tryEmitInlineDynamicCall`: a dynamic call site
 * can compile BEFORE the same file's `new Proxy` site (the #2754
 * registration-order class), while a proxy compiled in an earlier file is
 * caught by the funcMap check. A proxy has no TS-type brand
 * (`project_proxy_no_ts_type_brand`), so the gate is syntactic by design.
 */
const sourceCreatesProxyCache = new WeakMap<ts.SourceFile, boolean>();

/**
 * (#3140) True when the source contains any `<expr>.bind(...)` call — a
 * `$__bound_fn` carrier may then exist at runtime, so the dynamic-call
 * dispatch must carry the unwrap arm even when the bind SITE compiles after
 * this call site (compile-order independence; mirrors `sourceCreatesProxy`).
 */
const sourceHasBindCallCache = new WeakMap<ts.SourceFile, boolean>();
function sourceHasBindCall(sf: ts.SourceFile): boolean {
  const cached = sourceHasBindCallCache.get(sf);
  if (cached !== undefined) return cached;
  let found = false;
  if (sf.text.includes(".bind(")) {
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "bind"
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  sourceHasBindCallCache.set(sf, found);
  return found;
}

/**
 * Select the Wasm-owned Function.prototype.bind provider.
 *
 * Native-first JavaScript targets use the same `$__bound_fn` carrier as
 * standalone/WASI. Only a bound target that is itself an admitted caller-owned
 * JavaScript function crosses the explicit callback boundary when invoked.
 */
export function usesNativeFunctionBindProvider(ctx: CodegenContext): boolean {
  return noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first";
}

function sourceCreatesProxy(sf: ts.SourceFile): boolean {
  const cached = sourceCreatesProxyCache.get(sf);
  if (cached !== undefined) return cached;
  let found = false;
  // Cheap text pre-filter before the AST walk.
  if (sf.text.includes("Proxy")) {
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy") {
        found = true;
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "revocable" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Proxy"
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  sourceCreatesProxyCache.set(sf, found);
  return found;
}

/**
 * Statically evaluate `ToBoolean(expr)` for descriptor flag literals.
 * Per §6.2.6 ToPropertyDescriptor each attribute flag is ToBoolean-coerced —
 * `configurable: 123` / `'x'` / `{}` / `[]` are all truthy. Used by the
 * Object.create/defineProperties static-expansion fast path so the emitted
 * descriptor flags reflect the spec rather than degrading every non-`true`
 * literal to `false`. Returns `undefined` when the value isn't statically
 * resolvable (caller should fall back to the runtime path).
 */
/**
 * (#2076) Compile an `Object.assign(target, ...sources)` argument, pushing an
 * externref onto the stack. Under `--target standalone`, the native
 * `__object_assign` reads each operand by `ref.test $Object` and iterates its
 * `$PropEntry` table; a *closed-struct* literal fails that test, so its
 * properties are silently dropped and `Object.keys` on the result sees nothing
 * (the bug). The struct path is what `compileObjectLiteral` picks for a literal
 * argument whose TS contextual type — here `Object.assign`'s generic signature
 * resolves it to a CONCRETE object type, not `any` — so the open-`$Object`
 * diversion (literals.ts) never fires.
 *
 * Fix: when the argument is a *plain data-property / spread* object literal
 * (no accessors, methods, or computed/symbol keys — the same shapes the
 * `$Object` builder accepts at literals.ts:870-874), build it directly as a
 * native `$Object` via `compileObjectLiteralAsExternref` so `__object_assign`
 * recognises it. This includes `{}` when used as the target: the native helper
 * must be able to insert the copied fields into it. Any other argument
 * (identifiers, calls, accessor-bearing literals) keeps the ordinary
 * `compileExpression` path. Host-assisted mode keeps the JS import unchanged;
 * all native-first environments share the Wasm helper.
 */
export function compileObjectAssignArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  if (
    (ctx.targetProfile.semanticProviders === "native-first" || ctx.standalone) &&
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.every(
      (p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p),
    ) &&
    arg.properties.every((p) => ts.isSpreadAssignment(p) || resolvePropertyNameText(ctx, p) !== undefined)
  ) {
    const objResult = compileObjectLiteralAsExternref(ctx, fctx, arg);
    if (objResult) {
      if (objResult.kind !== "externref") coerceType(ctx, fctx, objResult, { kind: "externref" });
      return;
    }
    // fall through to the ordinary path if the $Object builder declined.
  }
  const t = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
}

/**
 * #2580 M3 Stage A — compile a `[[Prototype]]` argument (the proto operand of
 * `Object.create(proto)` / `Object.setPrototypeOf(obj, proto)`) so that an
 * INLINE OBJECT LITERAL proto is built as a native `$Object`, pushing an
 * externref onto the stack.
 *
 * Root cause (standalone): the native `__object_create` / `__object_setPrototypeOf`
 * helpers write the link field `$Object.$proto` only when the proto value
 * `ref.test $Object` succeeds (a non-`$Object` externref coerces to null, by
 * design — see object-runtime.ts `__object_create`/`__object_setPrototypeOf`).
 * `compileObjectLiteral` lowers an inline literal whose TS contextual type is a
 * CONCRETE object type (not `any`) to a CLOSED-shape struct (`struct.new <typeIdx>`),
 * which fails `ref.test $Object`. So `Object.create({foo:7}).foo` and
 * `Object.setPrototypeOf(o,{foo:7}); o.foo` silently lose the proto link (the
 * chain walk reads a null `$proto` → property absent → 0). A proto passed via a
 * `const p:any = {foo:7}` *named variable* already works because the `any`
 * annotation diverts that literal to the open-`$Object` builder (literals.ts).
 *
 * Fix mirrors the merged #2076 `compileObjectAssignArg` precedent: when the proto
 * is a plain data-property / spread object literal (the same shapes the `$Object`
 * builder accepts), build it directly as a native `$Object` via
 * `compileObjectLiteralAsExternref` so `ref.test $Object` succeeds and the link
 * is recorded. Any other proto expression (identifiers, calls, `null`,
 * `Foo.prototype`, accessor-bearing literals) keeps the ordinary
 * `compileExpression` path unchanged. Standalone-only — host/GC mode owns the
 * `__object_create` JS import and a separate (still-broken, tracked) proto-link
 * mechanism, untouched here.
 */
export function compileProtoArg(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  if (
    ctx.standalone &&
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.length > 0 &&
    arg.properties.every(
      (p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p),
    ) &&
    arg.properties.every((p) => ts.isSpreadAssignment(p) || resolvePropertyNameText(ctx, p) !== undefined)
  ) {
    const objResult = compileObjectLiteralAsExternref(ctx, fctx, arg);
    if (objResult) {
      if (objResult.kind !== "externref") coerceType(ctx, fctx, objResult, { kind: "externref" });
      return;
    }
    // fall through to the ordinary path if the $Object builder declined.
  }
  const t = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (!t) {
    // Expression produced no value — push null so the stack stays balanced for
    // the consuming __object_create / __object_setPrototypeOf call.
    fctx.body.push({ op: "ref.null.extern" });
  } else if (t.kind !== "externref") {
    coerceType(ctx, fctx, t, { kind: "externref" });
  }
}

/**
 * #2160 — `String(arr)` / `Number(arr)` array→primitive coercion in standalone.
 *
 * In native-strings (standalone / WASI) mode there is no JS host
 * `__extern_toString` to run ToPrimitive on a WasmGC array struct, so the
 * generic `coerceType` ref→string/number path null-derefs (`String([1,2,3])`)
 * or yields NaN (`Number([5])`). Arrays already have a native ToString — the
 * `Array.prototype.toString` lowering (§23.1.3.36 → `join(",")`) via
 * `compileArrayJoinNative`. This routes the array argument through that path by
 * synthesizing `arg.toString()` and dispatching to the array-method compiler
 * (mirroring `compileArrayPrototypeCall`'s synthesis at array-methods.ts:1856).
 *
 * Returns the emitted native-string ValType on success, or `undefined` when the
 * argument is not a resolvable array (caller then keeps its existing behavior).
 * Does NOT touch the shared coercion engine (#1917) — purely additive.
 */
export function tryEmitArrayToStringNative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
  argTsType: ts.Type,
): ValType | null | undefined {
  // Only meaningful where the native array-join path applies (standalone /
  // WASI native strings). In JS-host mode the existing __extern_toString path
  // already handles arrays, so leave that untouched.
  if (!(ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0)) return undefined;
  if (!resolveArrayInfo(ctx, argTsType)) return undefined;

  // Skip boolean-element arrays: the join-native lowering packs them as i8 and
  // the synthetic-dispatch element-type resolution diverges from the direct
  // `arr.toString()` receiver path, tripping an "invalid array type" validation
  // error. Booleans are a rare String()/Number() argument; leaving them to the
  // existing fall-through avoids touching the shared array-element machinery
  // (the #2160 slice targets numeric/string arrays). `arr.toString()` on a
  // boolean array still works via the direct property-access path.
  const elemIdxType = argTsType.getNumberIndexType();
  if (elemIdxType && isBooleanType(elemIdxType)) return undefined;

  // Synthesize `argExpr.toString()` and route through the array-method
  // compiler. compileArrayJoinNative reads only `propAccess.expression`
  // (the real, type-resolvable array node) and `callExpr.arguments`
  // (empty → default "," separator), so the synthetic wrappers are safe.
  const syntheticPropAccess = ts.factory.createPropertyAccessExpression(argExpr, "toString");
  (syntheticPropAccess as unknown as { parent: ts.Node }).parent = argExpr.parent;
  const syntheticCall = ts.factory.createCallExpression(syntheticPropAccess, undefined, []);
  (syntheticCall as unknown as { parent: ts.Node }).parent = argExpr.parent;

  const result = compileArrayMethodCall(ctx, fctx, syntheticPropAccess, syntheticCall, argTsType, "toString");
  // `undefined` means the dispatcher declined (not an array shape it handles) —
  // surface that so the caller falls back. VOID_RESULT can't occur for toString.
  if (result === undefined || result === VOID_RESULT) return undefined;
  return result;
}

export function staticToBoolean(expr: ts.Expression): boolean | undefined {
  while (
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.ParenthesizedExpression
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  switch (expr.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return true;
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return false;
    case ts.SyntaxKind.NumericLiteral:
      return Number((expr as ts.NumericLiteral).text) !== 0;
    case ts.SyntaxKind.BigIntLiteral: {
      const t = (expr as ts.BigIntLiteral).text;
      return BigInt(t.slice(0, -1)) !== 0n;
    }
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return (expr as ts.StringLiteralLike).text.length > 0;
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.ClassExpression:
      return true;
    case ts.SyntaxKind.Identifier: {
      const text = (expr as ts.Identifier).text;
      if (text === "undefined") return false;
      if (text === "NaN") return false;
      if (text === "Infinity") return true;
      return undefined;
    }
    case ts.SyntaxKind.VoidExpression:
      return false;
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const u = expr as ts.PrefixUnaryExpression;
      if (u.operator === ts.SyntaxKind.ExclamationToken) {
        const inner = staticToBoolean(u.operand);
        return inner === undefined ? undefined : !inner;
      }
      if (u.operator === ts.SyntaxKind.MinusToken || u.operator === ts.SyntaxKind.PlusToken) {
        if (u.operand.kind === ts.SyntaxKind.NumericLiteral) {
          return Number((u.operand as ts.NumericLiteral).text) !== 0;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Coerce an already-pushed Number.prototype method argument (toFixed /
 * toPrecision / toExponential digits) to f64. These runtime helpers take an
 * f64 argument, but the source argument may be i32 (boolean) or externref/ref
 * (e.g. a Symbol). Per §21.1.3.x the argument runs through ToInteger, which
 * begins with ToNumber — and ToNumber(Symbol) throws TypeError (§7.1.4).
 * Routing externref/ref through coerceType funnels Symbols into the throwing
 * ToNumber path (#1564) and keeps the value stack f64-typed for the
 * subsequent local.tee/local.set into an f64 local.
 */
export function coerceNumberMethodArgToF64(ctx: CodegenContext, fctx: FunctionContext, argType: ValType | null): void {
  if (!argType) return;
  if (argType.kind === "f64") return;
  if (argType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }
  coerceType(ctx, fctx, argType, { kind: "f64" });
}

/**
 * (#2160 number-wrapper) Returns true when `receiverType` is a Number-prototype
 * method receiver that the numeric arms below should handle — i.e. a primitive
 * number, OR (standalone only) a `new Number(x)` WRAPPER object.
 *
 * `isNumberType` matches only the primitive (`TypeFlags.Number`), NOT the wrapper
 * (`TypeFlags.Object` whose symbol is `Number`), so `new Number(3.14).toFixed(2)`
 * never entered the numeric lowering and fell through to a generic/host path that
 * trapped in standalone ("null pointer" / wrong value). Mirror of the #1878
 * String-wrapper fix. Gated on `ctx.standalone` for the wrapper case — the native
 * `__to_primitive` recovery (see `emitNumberMethodReceiverF64`) is standalone-only;
 * WASI/host keep the existing object machinery.
 */
export function isNumberMethodReceiver(ctx: CodegenContext, receiverType: ts.Type): boolean {
  return isNumberType(receiverType) || (ctx.standalone && isNumberWrapperType(receiverType));
}

/**
 * (#3175) Detect a syntactic `Number.prototype` receiver.
 *
 * Per §21.1.3 the Number prototype object is an ordinary object whose internal
 * [[NumberData]] slot is +0, so `Number.prototype.toString(radix)` /
 * `.valueOf()` / `.toFixed(d)` / `.toPrecision(p)` / `.toExponential(d)` all
 * behave as if invoked on the primitive +0 (e.g. `Number.prototype.toString(3)`
 * is `"0"`). This is the dominant standalone gap in the S15.7.4.2 corpus
 * (35 `A1`/`A2` tests open with exactly this assertion).
 *
 * Standalone types `Number.prototype` as the `Number` wrapper interface, so the
 * boxed-wrapper `__to_primitive`/`__unbox_number` recovery runs — but the
 * prototype object carries no [[PrimitiveValue]] slot, so the unbox yields NaN
 * (rendered `"NaN"`). Recover the +0 directly at the receiver site instead.
 *
 * Guarded against a shadowing user binding: a LOCAL `const Number = {...}` /
 * param is caught by `fctx.localMap`/`boxedCaptures` (mirrors the sibling
 * `tryCompileStandaloneBuiltinProtoMemberMeta` shadow check). A module-level
 * shadow does not reach here at all — every caller is gated on the receiver
 * TYPE being the `Number` wrapper (`isNumberMethodReceiver` /
 * `recvSymName === "Number"`), which a non-Number shadow would not satisfy.
 * Uses no direct TS-checker read (oracle-ratchet, #1930).
 */
export function isNumberDotPrototype(fctx: FunctionContext, expr: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (expr.name.text !== "prototype") return false;
  const base = expr.expression;
  if (!ts.isIdentifier(base) || base.text !== "Number") return false;
  const shadowed = fctx.localMap.has("Number") || (fctx.boxedCaptures?.has("Number") ?? false);
  return !shadowed;
}

/**
 * (#2767) Nominal types whose bare-`var` receiver recovery is VERIFIED safe —
 * the substituted `receiverType` routes into a dispatch path whose
 * externref→ref value-recovery is properly guarded and whose method/property
 * lowering is correct for the recovered struct.
 *
 * This safelist is load-bearing, not a perf refinement: the #2228 `merge_group`
 * test262 gate proved that substituting WITHOUT it regresses non-Date receivers
 * (Promise.finally → illegal cast in the recovered closure; RegExp `re.test` /
 * SharedArrayBuffer `.grow` → wrong native dispatch; super call-spread → invalid
 * Wasm). Those gates route the recovered struct through an UNGUARDED `ref.cast`
 * or a partial native path. Date's recovery is guarded + correct (the measured
 * wins: toISOString ×2, annexB setYear ×3). Expand this set ONE type at a time,
 * each gated behind a full `merge_group` validation (tracked on #2768).
 */
const SAFE_BARE_VAR_RECOVERY_NOMINALS: ReadonlySet<string> = new Set(["Date"]);

/**
 * (#2767) Recover the nominal `ts.Type` a bare-`var`/`let` identifier holds when
 * the TS checker reports `any` (no annotation, no initializer — the
 * "evolving-any" case the checker does NOT narrow across statements, so
 * `var d; d = new Date(0); d.toISOString()` types the receiver `any`/externref
 * and the nominal-symbol dispatch gate bails to the generic dynamic path).
 *
 * Conservative-closed on THREE rules so it never substitutes a type the runtime
 * value may not be:
 *   1. every declaration of the symbol is a plain `var`/`let` VariableDeclaration
 *      — excludes PARAMETERS / catch / binding-element bindings whose value
 *      arrives from outside the scanned assignments (a param reassigned
 *      `p = new X()` in the body must NOT be assumed to always hold an `X`;
 *      that drove the Promise.finally illegal-cast regression);
 *   2. the initializer (if any) AND every `<ident> = <rhs>` assignment to the
 *      symbol resolve to the SAME nominal symbol — any divergence, any
 *      non-nominal RHS, or zero assignments ⇒ undefined;
 *   3. that nominal symbol is on the verified `SAFE_BARE_VAR_RECOVERY_NOMINALS`
 *      safelist (the #2228 merge_group gate showed an unrestricted substitution
 *      misdispatches non-Date receivers).
 * Mirrors the symbol-scan in `symbolBindsAsyncFunction` (expressions.ts:262).
 */
/**
 * (#3433) All `<ident> = <rhs>` assignments in `sf`, grouped by the left
 * identifier's symbol; computed once per compile per source file. See
 * `resolveAssignedNominalType`.
 */
function identAssignRhsInFile(
  ctx: CodegenContext,
  sf: ts.SourceFile,
): ReadonlyMap<ts.Symbol, readonly ts.Expression[]> {
  const cache = (ctx.identAssignRhsCache ??= new Map());
  const cached = cache.get(sf);
  if (cached) return cached;
  const map = new Map<ts.Symbol, ts.Expression[]>();
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      const assigned = ctx.checker.getSymbolAtLocation(n.left);
      if (assigned) {
        const list = map.get(assigned);
        if (list) list.push(n.right);
        else map.set(assigned, [n.right]);
      }
    }
    forEachChild(n, visit);
  };
  for (const sourceFile of ctx.callableSourceFiles ?? [sf]) visit(sourceFile);
  cache.set(sf, map);
  return map;
}

export function resolveAssignedNominalType(ctx: CodegenContext, ident: ts.Identifier): ts.Type | undefined {
  const sym = ctx.checker.getSymbolAtLocation(ident);
  if (!sym) return undefined;
  const decls = sym.declarations ?? [];
  // Rule 1: only plain var/let bindings (no params / catch / destructuring
  // elements — their value can arrive un-scanned from outside the assignments).
  if (decls.length === 0 || !decls.every((d) => ts.isVariableDeclaration(d))) return undefined;
  const rhsTypes: ts.Type[] = [];
  for (const d of decls) {
    if (ts.isVariableDeclaration(d) && d.initializer) {
      rhsTypes.push(ctx.checker.getTypeAtLocation(d.initializer));
    }
  }
  // (#3433) Memoized per source file: one walk collects `<ident> = <rhs>`
  // assignments grouped by the left identifier's symbol; per-query work is a
  // map lookup plus RHS type resolution for THIS symbol's assignments only
  // (the same `getTypeAtLocation` calls the pre-memo per-query scan made).
  // The pre-memo full-file rescan ran for every bare-`var`/`let` receiver —
  // common in the oracle-v8 test262 harness assemblies — making compiles
  // superlinear in file size.
  const sf = ident.getSourceFile();
  for (const rhs of identAssignRhsInFile(ctx, sf).get(sym) ?? []) {
    rhsTypes.push(ctx.checker.getTypeAtLocation(rhs));
  }
  if (rhsTypes.length === 0) return undefined;
  let name: string | undefined;
  for (const t of rhsTypes) {
    const nm = t.getSymbol()?.name;
    if (!nm) return undefined; // a non-nominal RHS (any / number / …) → bail
    if (name === undefined) name = nm;
    else if (name !== nm) return undefined; // divergent nominal types → union → bail
  }
  // Rule 3: only substitute for a nominal whose recovery is verified safe.
  if (!name || !SAFE_BARE_VAR_RECOVERY_NOMINALS.has(name)) return undefined;
  return rhsTypes[0];
}

/**
 * (#2160 number-wrapper) Emit the receiver of a Number.prototype method as an
 * f64 on the stack.
 *
 * - Primitive number receiver: `compileExpression(propAccess.expression)` then
 *   i32→f64 widen (the prior inline behaviour of every numeric arm).
 * - Standalone Number WRAPPER receiver (`new Number(x)`): the wrapper lowers to a
 *   `$Object` carrying the primitive in the reserved FLAG_INTERNAL
 *   [[PrimitiveValue]] slot (#1910 S2). Recover it via the existing §7.1.1.1
 *   `__to_primitive(hint "number")` engine helper (reads that slot first) →
 *   `__unbox_number` → f64. Reuses the SAME helper the wrapper `.valueOf()` slice
 *   (cs-2160) uses; no new coercion matrix.
 */
export function emitNumberMethodReceiverF64(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  receiverType: ts.Type,
): void {
  // (#3175) `Number.prototype.<m>(...)` — the prototype object's [[NumberData]]
  // is +0 (§21.1.3). Recover the +0 directly; the wrapper `__to_primitive`
  // recovery below finds no [[PrimitiveValue]] slot and would yield NaN.
  if (isNumberDotPrototype(fctx, propAccess.expression)) {
    fctx.body.push({ op: "f64.const", value: 0 });
    return;
  }
  if (ctx.standalone && isNumberWrapperType(receiverType)) {
    ensureObjectRuntime(ctx);
    const toPrimIdx = ctx.funcMap.get("__to_primitive");
    if (toPrimIdx !== undefined) {
      // wrapper externref → __to_primitive(hint "number") → boxed-number externref
      compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
      addStringConstantGlobal(ctx, "number");
      fctx.body.push(...stringConstantExternrefInstrs(ctx, "number"));
      fctx.body.push({ op: "call", funcIdx: toPrimIdx });
      const unboxNumIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
      if (unboxNumIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: unboxNumIdx });
      }
      return;
    }
    // __to_primitive unavailable — fall through to the primitive path (best effort).
  }
  const exprType = compileExpression(ctx, fctx, propAccess.expression);
  if (exprType && exprType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (exprType && exprType.kind !== "f64") {
    // (#3081) A `number`-typed receiver can compile to a BOXED-number externref
    // rather than an f64 — e.g. a namespace-constant read `Number.NaN.toFixed(0)`
    // / `Number.POSITIVE_INFINITY.toExponential()` lowers `Number.NaN` through
    // `__get_builtin` to a boxed externref. The `number_to{Fixed,Precision,
    // Exponential}` runtime helpers expect an f64 receiver, so feeding the raw
    // externref emits invalid Wasm ("call[0] expected type f64, found externref").
    // Route through the #1917 coercion ENGINE (`coerceType` → f64), which unboxes
    // a boxed-number externref exactly as the sibling argument path
    // (`coerceNumberMethodArgToF64`) already does — no hand-rolled coercion
    // vocabulary here (#2108 coercion-sites gate). An externref/ref receiver was
    // ALWAYS invalid Wasm here, so this cannot regress any previously-instantiable
    // module.
    coerceType(ctx, fctx, exprType, { kind: "f64" });
  }
}

/**
 * (#1735) Normalise an f64 local holding a Number.prototype.{toExponential,
 * toPrecision} digits/precision argument so that NaN becomes 0, matching
 * ToIntegerOrInfinity (§7.1.5 / §21.1.3.{3,5} step 5: NaN → +0).
 *
 * The `number_toExponential` / `number_toPrecision` runtime helpers overload
 * NaN as their "no argument supplied" sentinel (the codegen no-arg branch
 * pushes `f64.const NaN`). Without this normalisation an *explicit* NaN
 * argument (`(1).toExponential(NaN)`, `(1).toExponential(0/0)`) carries the
 * same bits as the sentinel and is wrongly handled as no-arg. Rewriting the
 * local in place — `local = (d == d) ? d : 0` via `f64.eq` self-compare (false
 * only for NaN) feeding `select` — keeps the subsequent range-check and call
 * reading a spec-correct value with no host-side change.
 */
export function normalizeNaNToZero(fctx: FunctionContext, f64Local: number): void {
  fctx.body.push({ op: "local.get", index: f64Local }); // val-if-true: d
  fctx.body.push({ op: "f64.const", value: 0 }); // val-if-false: 0
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "local.get", index: f64Local });
  fctx.body.push({ op: "f64.eq" }); // condition: d == d (0 only when NaN)
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: f64Local });
}

/**
 * Look up closure info for a variable by checking if its local type
 * is a ref to a known closure struct. Handles cases like:
 *   var f = function() { ... }; f();
 *   const f = makeAdder(5); f.call(null, 10);
 */
export function resolveClosureInfoFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): ClosureInfo | undefined {
  const localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) return undefined;
  const localType =
    localIdx < fctx.params.length ? fctx.params[localIdx]?.type : fctx.locals[localIdx - fctx.params.length]?.type;
  if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
    return ctx.closureInfoByTypeIdx.get(localType.typeIdx);
  }
  return undefined;
}

/**
 * (#2193 PR-B) Reflective `m.call(thisArg, …args)` / `m.apply(thisArg, [args])`
 * where `m` is a **value-materialized `$NativeProto` member closure** (e.g.
 * `const m = Array.prototype.slice; m.call(a, 1, 3)`).
 *
 * The closure value is type-erased to `externref` when stored in a variable
 * (its local wasm type is `externref`, not the concrete `(ref $wrap)`), so
 * `resolveClosureInfoFromLocal` can't recover it and the generic `.call`/`.apply`
 * path drops `thisArg`. We instead recover the closure from the receiver's
 * **TypeScript symbol**: a builtin prototype method's symbol declares as a
 * `MethodSignature` on the `Array` / `Object` lib interface. From that we
 * re-resolve the brand + member, ensure the native method closure, and emit a
 * direct `call_ref` with `thisArg → param 1` (the receiver) and the remaining
 * args → params 2.. — exactly the closure's `(self, this, …args)` ABI.
 *
 * Returns the result `ValType` when it handled the call, or `undefined` to fall
 * through to the legacy paths (non-proto receiver, dynamic `.apply` args, etc.).
 */
function tryEmitNativeProtoReflectiveCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  receiver: ts.Expression,
  isCall: boolean,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (expr.arguments.length === 0) return undefined; // need at least a thisArg

  // Resolve the member name + declaring builtin from the receiver's symbol.
  let sym: ts.Symbol | undefined;
  try {
    sym = ctx.checker.getTypeAtLocation(receiver).getSymbol();
  } catch {
    return undefined;
  }
  let member = sym?.getName();
  const decl = sym?.declarations?.[0];
  let ifaceName: string | undefined;
  if (member && decl && ts.isMethodSignature(decl) && decl.parent && ts.isInterfaceDeclaration(decl.parent)) {
    ifaceName = decl.parent.name.text;
  } else {
    // (#3173) LIB-MISSING members (`DataView.prototype.getFloat16` — ES2025
    // members absent from the bundled lib have NO method-signature symbol):
    // resolve from the receiver variable's declaration-initializer SYNTAX —
    // `var m = <Builtin>.prototype.<member>; m.call(x, …)`. The glue's member
    // CSV is string-keyed, so the closure resolution below is lib-independent.
    member = undefined;
    if (ts.isIdentifier(receiver)) {
      const varSym = ctx.checker.getSymbolAtLocation(receiver);
      const varDecl = varSym?.valueDeclaration;
      if (varDecl && ts.isVariableDeclaration(varDecl) && varDecl.initializer) {
        const init = varDecl.initializer;
        if (
          ts.isPropertyAccessExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          init.expression.name.text === "prototype" &&
          ts.isIdentifier(init.expression.expression)
        ) {
          member = init.name.text;
          ifaceName = init.expression.expression.text;
        }
      }
    }
    if (!member || !ifaceName) return undefined;
  }
  if (!member || !ifaceName) return undefined;

  // (#4619 family D) For the two wrapper members the brand genuinely owns, the
  // SYNTACTIC spelling beats the symbol — `lib.es5.d.ts` declares no `toString`
  // on `interface Boolean`, so the symbol says Object. See the module.
  {
    const syntactic = wrapperProtoSyntacticMember(ctx, unwrapTransparent(receiver), member);
    if (syntactic !== undefined) ({ member, ifaceName } = syntactic);
  }

  // TypeScript declares `Error.prototype.toString` through the broad Object
  // method signature, so the member symbol above can report `Object` even
  // though the value read is an Error-family prototype. Recover the concrete
  // owner from this exact intrinsic syntax before selecting the native-proto
  // glue. This is intentionally limited to the Error family; other
  // `<Builtin>.prototype.toString.call` forms retain their existing resolver.
  {
    const syntax = unwrapTransparent(receiver);
    if (
      ts.isPropertyAccessExpression(syntax) &&
      syntax.name.text === "toString" &&
      ts.isPropertyAccessExpression(syntax.expression) &&
      syntax.expression.name.text === "prototype" &&
      ts.isIdentifier(syntax.expression.expression)
    ) {
      const owner = resolveBuiltinNamespaceValueName(ctx, syntax.expression.expression);
      if (
        owner === "Error" ||
        owner === "TypeError" ||
        owner === "RangeError" ||
        owner === "SyntaxError" ||
        owner === "URIError" ||
        owner === "EvalError" ||
        owner === "ReferenceError"
      ) {
        ifaceName = owner;
        // A direct object-literal argument normally receives a closed
        // WasmGC struct. Error.prototype.toString performs dynamic [[Get]], so
        // promote this exact receiver (and a one-hop variable initializer) to
        // the open object carrier before pushReflectiveCallReceiver compiles
        // it. Other prototype calls keep their existing representation.
        const receiverArg = expr.arguments[0];
        const receiverArgUnwrapped = receiverArg === undefined ? undefined : unwrapTransparent(receiverArg);
        if (receiverArgUnwrapped && ts.isObjectLiteralExpression(receiverArgUnwrapped)) {
          ctx.dynamicProtoLiteralNodes.add(receiverArgUnwrapped);
        } else if (receiverArgUnwrapped && ts.isIdentifier(receiverArgUnwrapped)) {
          const declaration = ctx.oracle.valueDeclarationOf(receiverArgUnwrapped);
          if (
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            ts.isObjectLiteralExpression(declaration.initializer)
          ) {
            ctx.dynamicProtoLiteralNodes.add(declaration.initializer);
          }
        }
      }
    }
  }

  // (#4119) `Object.prototype.toString.call(v)` written in its DIRECT syntactic
  // form stays owned by the #2501 compile-time fold further down, NOT by the
  // reflective closure. The fold keys on the receiver ARGUMENT's static type, so
  // it tags Date / RegExp / Error / `arguments` precisely — strictly more than
  // the runtime classifier (object-proto-tostring.ts) can prove from a bare
  // externref, whose carriers for those four are nominal structs it deliberately
  // refuses. Before #4119 wired a body, this interception silently declined
  // (a refusal body made `ensureStandaloneNativeMethodClosure` yield nothing) and
  // the fold won by accident; giving `toString` a real body made the
  // interception succeed and took 27 passing rows — every one of them the direct
  // form — down to the classifier's refusal, plus one MIS-TAG
  // (`toString.call-arguments.js` read `[object Array]`, the vec arm claiming an
  // `arguments` exotic). Declining here restores the fold's precedence.
  //
  // The VALUE-ERASED forms are untouched and still take the reflective path,
  // because that is the whole point of #4119: `var m = Object.prototype.toString;
  // m.call(x)` arrives with an Identifier receiver, and the ES5 genericity idiom
  // `arr.getClass = Object.prototype.toString; arr.getClass()` never reaches a
  // `.call` at all. Neither gives the fold a receiver to read.
  if (ifaceName === "Object" && member === "toString" && ts.isPropertyAccessExpression(unwrapTransparent(receiver))) {
    // The lower direct-call path now owns BOTH statically-known tags and the
    // runtime any/externref classifier. Never divert this syntactic form through
    // the generic reflective Function#call adapter, which erases native view RTT.
    return undefined;
  }

  let brand = nativeProtoBrandForInterface(ctx, ifaceName);
  // (#4582) `valueOf` ONLY — the other Number/Boolean members still refuse, and
  // routing those here would turn today's answers into TypeErrors. Without this
  // arm both fell to the legacy `.call` tail that drops `thisArg` and returns 0:
  // `Boolean.prototype.valueOf.call(Object(true))` answered `false`, the Number
  // twin `undefined` — silent wrong values, measured on base.
  // (#4619 family D) …and `toString`, now that it has a native body too
  // (wrapper-proto-to-string.ts). Same measured symptom as #4582's `valueOf`:
  // `Boolean.prototype.toString.call(true)` and the Number twin both answered
  // `undefined` on base, because the legacy `.call` tail drops `thisArg`. Both
  // members are still enumerated one by one rather than opening the whole
  // family — a member whose body still refuses would turn today's (wrong but
  // non-throwing) answer into a TypeError.
  const wrapperWiredMember = member === "valueOf" || member === "toString";
  if (brand === undefined && wrapperWiredMember && ifaceName === "Number") brand = ensureNumberNativeProtoGlue(ctx);
  else if (brand === undefined && wrapperWiredMember && ifaceName === "Boolean")
    brand = ensureBooleanNativeProtoGlue(ctx);
  if (brand === undefined) return undefined;

  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return undefined;
  // Only a `method`-kind member has the `(self, this, …args)` shape we thread.
  if (glue.memberKind(member) !== "method") return undefined;

  return emitReflectiveNativeProtoClosureCall(ctx, fctx, expr, receiver, brand, member, "method", isCall);
}

/**
 * (#2876) Shared tail for a reflective `<closure>.call/apply(thisArg, …args)` on a
 * value-erased native-proto member closure. Ensures the `(brand, member, kind)`
 * closure to obtain the wrapper struct type + lifted func type, reshapes the args
 * to the closure's `(self, this, …args)` ABI, recovers the wrapper from the
 * runtime `receiver` value (`any.convert_extern` + `ref.cast`), and `call_ref`s
 * the funcref stored in its field 0 — so the ACTUAL stored member runs, with
 * `thisArg → param 1`. Works for both `method` and `getter` kinds (a getter's
 * user-arg list is just `[thisArg]`, threaded into the closure's lone `this`
 * param). Returns the result ValType, or `undefined` to fall through.
 */
export function emitReflectiveNativeProtoClosureCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  /**
   * (#2875) Argument SOURCE, not necessarily the syntactic call — only
   * `.arguments` is read. `transferred-native-proto-call.ts` supplies a
   * synthesized `[thisArg, …userArgs]` list whose elements are all real nodes.
   */
  expr: { readonly arguments: readonly ts.Expression[] },
  receiver: ts.Expression,
  brand: number,
  member: string,
  kind: "method" | "getter",
  isCall: boolean,
  /**
   * (#3236 Slice 1b) When set, resolve the closure through the factory's
   * `refusalBodyFallback` — the identity-stable throwing stand-in a member with
   * no wired native body reifies to. Needed for the %GeneratorPrototype% members
   * (`next`/`return`/`throw`), whose only body IS the catchable-TypeError refusal
   * and whose stored `$Object` data-property value is exactly that fallback
   * singleton. Off by default so the existing native-bodied callers (Array/Object
   * proto slice/etc.) are byte-identical.
   */
  useRefusalBodyFallback = false,
): ValType | undefined {
  const closure = ensureStandaloneNativeMethodClosure(
    ctx,
    brand,
    member,
    kind,
    useRefusalBodyFallback ? { refusalBodyFallback: true } : undefined,
  );
  if (!closure) return undefined; // member body refuses / not native yet → fall through
  const closureInfo = ctx.closureInfoByTypeIdx.get(closure.type.typeIdx);
  if (!closureInfo) return undefined;

  // (#2193 PR-B) Active by default. The earlier `expected (ref null N) found
  // (ref null N-1)` blocker was NOT a type-renumber bug (the prior diagnosis) —
  // it was the `call_ref` operand: the trailing operand must be the FUNCREF
  // from the wrapper's field 0, not the wrapper struct (see the call-emit tail
  // below, which now mirrors the canonical closure-call sequence). With that
  // corrected the recovery validates and `m.call(a,1,3) === a.slice(1,3)`.
  // `JS2WASM_DISABLE_PRB_REFLECTIVE_CALL` is an escape hatch (falls back to the
  // legacy drop-thisArg path → returns 0, valid Wasm, no worse than pre-PR-B).
  if (process.env.JS2WASM_DISABLE_PRB_REFLECTIVE_CALL) return undefined;

  // Reshape args to the closure's positional ABI: [thisArg, ...userArgs].
  let userArgs: readonly ts.Expression[] | undefined;
  if (isCall) {
    userArgs = expr.arguments; // [thisArg, a, b] → (this, a, b)
  } else if (expr.arguments.length === 1) {
    userArgs = [expr.arguments[0]!]; // .apply(thisArg) → (this)
  } else {
    const argsExpr = expr.arguments[1]!;
    if (ts.isArrayLiteralExpression(argsExpr)) {
      const flattened = flattenStaticArrayElements(argsExpr);
      if (flattened !== undefined) userArgs = [expr.arguments[0]!, ...flattened];
    }
  }
  if (userArgs === undefined) return undefined; // dynamic apply args → fall through

  // Recover the closure value the variable HOLDS — compile the receiver `m`
  // (an externref carrying a `$wrap` struct), then `any.convert_extern` +
  // `ref.cast` to the lifted function's actual self carrier. Shared wrapper
  // funcs use the canonical root; private/named funcs retain concrete self.
  // Using the freshly-emitted closure
  // (`ref.func`+`struct.new`) instead tripped a wrapper-struct type-idx
  // consistency check at finalize (the probe vs final wrapper in
  // `ensureStandaloneNativeMethodClosure` register distinct struct types). The
  // receiver's runtime value is exactly the value-read closure. Do not cast a
  // shared closure to the module-local per-signature allocation wrapper: the
  // same signature may occupy a different child position in another module.
  const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, closureInfo.funcTypeIdx) ?? closureInfo.structTypeIdx;
  const structRefT: ValType = { kind: "ref", typeIdx: selfTypeIdx };
  const closureLocal = allocLocal(fctx, `__protocall_${fctx.locals.length}`, structRefT);
  // (#3638) …but this `ref.cast` is UNCONDITIONAL, so it is sound only when the
  // receiver's RUNTIME VALUE is provably that wrapper — which the symbol-based
  // gate above does NOT establish. Receiver normalisation (and why an INSTANCE
  // member read used to trap here) lives in reflective-call-receiver.ts.
  pushReflectiveCallReceiver(ctx, fctx, receiver, closure);
  fctx.body.push({ op: "ref.cast", typeIdx: selfTypeIdx });
  fctx.body.push({ op: "local.set", index: closureLocal });

  // call_ref ABI mirrors the canonical closure-call sequence
  // (calls-closures.ts compileClosureCall): the lifted func type is
  //   (ref $selfCarrier, ...userParams) -> result
  // so the wasm stack must be [self_struct, ...userParams, funcref], where the
  // trailing operand is the FUNCREF extracted from the wrapper's field 0 — NOT
  // the wrapper struct itself. The earlier draft pushed the struct as the
  // call_ref operand, which validates as `expected (ref $funcType) found
  // (ref $wrapStruct)` (the off-by-one #2193 gap A actually surfaced here, not
  // in the type-renumber pass).

  // self param 0: the wrapper struct.
  fctx.body.push({ op: "local.get", index: closureLocal });

  const paramTypes = closureInfo.paramTypes; // excludes the self param
  // Receiver-aware native-prototype variadic methods keep the receiver in the
  // first user slot and carry the *actual* call-site arguments in one typed
  // externref vector.  Treat that vector as an ABI boundary here rather than
  // feeding the first user argument to the vector parameter positionally.  A
  // positional marshal would attempt to cast (for example) `-1` to
  // `$vec_externref`, which either traps or silently takes the refusal path;
  // it also cannot represent a five-argument `push`/`unshift` call because
  // their JavaScript `.length` is only one.
  const nativeProtoVariadic = kind === "method" && closureInfo.nativeProtoVariadic === true;
  let nativeProtoVariadicVec: { vecTypeIdx: number; arrTypeIdx: number } | undefined;
  if (nativeProtoVariadic) {
    const vecParam = paramTypes[1];
    if (!vecParam || (vecParam.kind !== "ref" && vecParam.kind !== "ref_null")) return undefined;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecParam.typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (arrDef?.kind !== "array" || arrDef.element.kind !== "externref") return undefined;
    nativeProtoVariadicVec = { vecTypeIdx: vecParam.typeIdx, arrTypeIdx };
  }
  // ArrayBufferCopyAndDetach must distinguish an omitted/undefined newLength
  // from explicit null. This native-proto call surface normally pads optional
  // externrefs with null, so use the canonical standalone undefined singleton
  // for ArrayBuffer members; their shared helper applies the corresponding
  // runtime predicate. Other builtin families retain their existing ABI.
  const arrayBufferUndefinedPad =
    getNativeProtoBuiltinGlue(ctx, brand)?.name === "ArrayBuffer" ? undefinedExternInstrs(ctx) : undefined;
  for (let i = 0; i < paramTypes.length; i++) {
    const pType = paramTypes[i]!;
    if (nativeProtoVariadic && i === 1) {
      // `userArgs[0]` is the receiver/thisValue.  Every remaining expression
      // is a real JavaScript argument and must be packed without padding.
      // `$vec_externref` carries its length before the backing array.
      const variadicArgs = userArgs.slice(1);
      fctx.body.push({ op: "i32.const", value: variadicArgs.length });
      for (const arg of variadicArgs) {
        const aType = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (aType === null) fctx.body.push({ op: "ref.null.extern" });
        else if (aType.kind !== "externref") coerceType(ctx, fctx, aType, { kind: "externref" });
      }
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: nativeProtoVariadicVec!.arrTypeIdx,
        length: variadicArgs.length,
      });
      fctx.body.push({ op: "struct.new", typeIdx: nativeProtoVariadicVec!.vecTypeIdx });
      continue;
    }
    if (i < userArgs.length) {
      const aType = compileExpression(ctx, fctx, userArgs[i]!, pType);
      if (aType !== null && !valTypesMatch(aType, pType)) {
        coerceType(ctx, fctx, aType, pType);
      }
    } else if (pType.kind === "externref") {
      fctx.body.push(...(arrayBufferUndefinedPad ?? [{ op: "ref.null.extern" }]));
    } else {
      pushDefaultValue(fctx, pType, ctx);
    }
  }

  // Trailing operand: funcref from the wrapper struct's field 0, guard-cast to
  // the lifted func type, null-checked (→ TypeError, never a trap) — exactly
  // the canonical closure-call tail (calls-closures.ts ~lines 138-150).
  fctx.body.push({ op: "local.get", index: closureLocal });
  fctx.body.push({ op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 });
  emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
  emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
  fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
  return closureInfo.returnType ?? { kind: "externref" };
}

/**
 * (#3236 Slice 1b) True when `objExpr` syntactically resolves to the native
 * `%GeneratorPrototype%` singleton — the object whose own `next`/`return`/`throw`
 * are the brand-checked closure values Slice 1 installed. Recognises the two
 * shapes the test262 GeneratorPrototype `this-val-*` tests use, tracing at most
 * ONE variable-initializer indirection (`var GP = <expr>; GP.next.call(x)`):
 *
 *   - `<genFn>.prototype`                    (§27.5.1 — genFn.prototype IS %GP%)
 *   - `Object.getPrototypeOf(<genFn>).prototype`
 *          (getPrototypeOf(genFn) = %Generator%, whose own `.prototype` = %GP%)
 *
 * `<genFn>` must be a `function*` declaration known to `ctx.generatorFunctions`
 * (sync only — async generators keep the host-import path). Conservative: any
 * shape it can't prove returns false, so the caller falls through to the
 * unchanged legacy `.call` lowering (no regression).
 */
function isGeneratorPrototypeReceiver(ctx: CodegenContext, objExpr: ts.Expression): boolean {
  let cur = unwrapTransparent(objExpr);
  // One level of `var GP = <init>` indirection.
  if (ts.isIdentifier(cur)) {
    const sym = ctx.checker.getSymbolAtLocation(cur);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      cur = unwrapTransparent(decl.initializer);
    }
  }
  if (!ts.isPropertyAccessExpression(cur) || cur.name.text !== "prototype") return false;
  const base = unwrapTransparent(cur.expression);
  // Shape A: `<genFn>.prototype`.
  if (ts.isIdentifier(base) && ctx.generatorFunctions.has(base.text)) return true;
  // Shape B: `Object.getPrototypeOf(<genFn>).prototype`.
  if (ts.isCallExpression(base)) {
    const callee = unwrapTransparent(base.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "getPrototypeOf" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      base.arguments.length >= 1
    ) {
      const arg = unwrapTransparent(base.arguments[0]!);
      if (ts.isIdentifier(arg) && ctx.generatorFunctions.has(arg.text)) return true;
    }
  }
  return false;
}

/**
 * (#3236 Slice 1b) Reflective `<GP>.next.call/apply(thisArg, …)` where the
 * `.call`/`.apply` receiver `<GP>.next` is a DYNAMICALLY-READ %GeneratorPrototype%
 * member closure. Unlike `tryEmitNativeProtoReflectiveCall` (which recovers the
 * closure from the receiver's TS symbol), here the receiver object `<GP>` is
 * `any`-typed (`Object.getPrototypeOf(g).prototype`), so `<GP>.next` has no
 * method-signature symbol — the closure value is an own `$Object` data property.
 * We instead resolve the `(brand, member)` from the receiver's syntactic
 * GeneratorPrototype provenance, then reuse the shared reflective closure-call
 * emitter, which compiles `<GP>.next` to the stored closure externref, casts it
 * to the wrapper struct, and `call_ref`s it with `thisArg → this` param. The
 * closure's Slice-1 catchable-TypeError refusal body then fires on the bad
 * `this` (GeneratorValidate §27.5.1.2). Standalone-gated; returns the result
 * ValType when handled, or `undefined` to fall through unchanged.
 */
function tryEmitGeneratorProtoReflectiveCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  innerExpr: ts.Expression,
  isCall: boolean,
): ValType | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  const recv = unwrapTransparent(innerExpr);
  if (!ts.isPropertyAccessExpression(recv)) return undefined;
  const member = recv.name.text;
  if (member !== "next" && member !== "return" && member !== "throw") return undefined;
  if (!isGeneratorPrototypeReceiver(ctx, recv.expression)) return undefined;
  const brand = ensureGeneratorPrototypeNativeProtoGlue(ctx);
  if (brand === undefined) return undefined;
  // `useRefusalBodyFallback: true` — the GeneratorPrototype members carry only
  // the catchable-TypeError refusal body (no wired native body), and their
  // stored `$Object` data-property value IS that identity-stable fallback
  // singleton, so the reflective cast must target the same struct type.
  return emitReflectiveNativeProtoClosureCall(ctx, fctx, expr, recv, brand, member, "method", isCall, true);
}

/** Unwrap parenthesized / `as` / non-null wrappers to the underlying expression. */
function unwrapTransparent(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/** True if `e` is `Object.getOwnPropertyDescriptor(…)`. */
function isObjectGopdCall(e: ts.Expression): e is ts.CallExpression {
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Object" &&
    callee.name.text === "getOwnPropertyDescriptor"
  );
}

/** Follow an identifier to its (single) variable-declaration initializer, if any. */
function traceVarInitializer(ctx: CodegenContext, ident: ts.Identifier): ts.Expression | undefined {
  let sym: ts.Symbol | undefined;
  try {
    sym = ctx.checker.getSymbolAtLocation(ident);
  } catch {
    return undefined;
  }
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return decl.initializer;
  return undefined;
}

/**
 * (#2876) Resolve a `.call`/`.apply` receiver to the builtin-proto accessor
 * descriptor it came from: `{ accessorName, gopdCall }` for the shapes
 *   - `gOPD(...).get`                 (inline accessor access)
 *   - `<ident=gOPD(...).get>`         (var holding the accessor closure)
 *   - `<ident=gOPD(...)>.get`         (var holding the descriptor)
 * or `undefined` when it doesn't trace to one.
 */
function resolveDescriptorAccessorSource(
  ctx: CodegenContext,
  recv: ts.Expression,
): { accessorName: string; gopdCall: ts.CallExpression } | undefined {
  const r = unwrapTransparent(recv);

  // `<obj>.get` / `<obj>.set`
  if (ts.isPropertyAccessExpression(r) && (r.name.text === "get" || r.name.text === "set")) {
    const obj = unwrapTransparent(r.expression);
    if (isObjectGopdCall(obj)) return { accessorName: r.name.text, gopdCall: obj };
    if (ts.isIdentifier(obj)) {
      const init = traceVarInitializer(ctx, obj);
      if (init && isObjectGopdCall(unwrapTransparent(init))) {
        return { accessorName: r.name.text, gopdCall: unwrapTransparent(init) as ts.CallExpression };
      }
    }
    return undefined;
  }

  // `<ident>` whose initializer is `gOPD(...).get`
  if (ts.isIdentifier(r)) {
    const init = traceVarInitializer(ctx, r);
    if (!init) return undefined;
    const i = unwrapTransparent(init);
    if (ts.isPropertyAccessExpression(i) && (i.name.text === "get" || i.name.text === "set")) {
      const obj = unwrapTransparent(i.expression);
      if (isObjectGopdCall(obj)) return { accessorName: i.name.text, gopdCall: obj };
    }
  }
  return undefined;
}

/**
 * (#2901) Resolve a module/function-scope variable's initializer expression, or
 * `undefined` if `ident` is not a single-initializer variable. Used by the static
 * data-flow trace that recognises the `testTypedArray.js` harness's
 * `var TypedArray = Object.getPrototypeOf(Int8Array)` / `var P = TypedArray.prototype`
 * intermediate bindings.
 */
function resolveVarInitializer(ctx: CodegenContext, ident: ts.Identifier): ts.Expression | undefined {
  const sym = ctx.checker.getSymbolAtLocation(ident);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  return decl.initializer;
}

/** (#2901) True iff `call` is `Object.getPrototypeOf(<arg>)`; returns the unwrapped arg or undefined. */
function getProtoOfCallArg(expr: ts.Expression): ts.Expression | undefined {
  const e = unwrapTransparent(expr);
  if (!ts.isCallExpression(e) || e.arguments.length < 1) return undefined;
  const callee = e.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    callee.name.text !== "getPrototypeOf"
  ) {
    return undefined;
  }
  return unwrapTransparent(e.arguments[0]!);
}

/**
 * (#2903 R4) Scalar-returning `%TypedArray%.prototype` callback HOFs whose
 * STANDALONE dispatch on a DIRECT (`$__vec_i8_byte`-style) carrier is routed to
 * the native `__call_m_<name>_<arity>` / `__hof_<name>` substrate (see the
 * interception in {@link compileCallExpression}'s array-method arm). Excludes
 * `map`/`filter` (typed-RESULT construction — deferred to R4b) and the mutators.
 */
export const STANDALONE_TA_SCALAR_HOFS: ReadonlySet<string> = new Set([
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "forEach",
  "some",
  "every",
  "reduce",
  "reduceRight",
]);

/**
 * (#2903 R4b) The PACKED-INTEGER typed-array views whose `map`/`filter` are
 * routed to the native `__ta_map_*`/`__ta_filter_*` typed-RESULT helper (STORE
 * via width-truncation). `Uint8ClampedArray` (#2903 R4c) is handled alongside
 * these but routes to the `clamp` helper variant (round-half-to-even store) — it
 * is NOT in this set because it shares the `i8_byte` carrier and would collide.
 * The float views (`Float32Array`/`Float64Array`) use the `f64` carrier and
 * already `map`/`filter` correctly through the existing array-HOF path
 * (byte-identical, left untouched).
 */
export const STANDALONE_TA_MAPFILTER_PACKED_VIEWS: ReadonlySet<string> = new Set([
  "Int8Array",
  "Uint8Array",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
]);

/**
 * (#2901) True iff `expr` (statically, following single-init var bindings) denotes
 * the abstract `%TypedArray%` intrinsic constructor, in either shape the test262
 * TypedArray corpus reaches it:
 *   - `Object.getPrototypeOf(Int8Array)`                      (full `testTypedArray.js`)
 *   - `Object.getPrototypeOf(Int8Array.prototype).constructor` (the test262-runner
 *     injected shim for the abstract intrinsic — test262-runner.ts ~1823)
 */
function isTypedArrayIntrinsicCtorExpr(ctx: CodegenContext, expr: ts.Expression): boolean {
  const e = unwrapTransparent(expr);
  // Object.getPrototypeOf(<wired view ctor>)
  const gpoArg = getProtoOfCallArg(e);
  if (gpoArg && ts.isIdentifier(gpoArg) && isWiredTypedArrayViewName(gpoArg.text)) return true;
  // Object.getPrototypeOf(<wired view ctor>.prototype).constructor
  if (ts.isPropertyAccessExpression(e) && e.name.text === "constructor") {
    const innerArg = getProtoOfCallArg(e.expression);
    if (
      innerArg &&
      ts.isPropertyAccessExpression(innerArg) &&
      innerArg.name.text === "prototype" &&
      ts.isIdentifier(innerArg.expression) &&
      isWiredTypedArrayViewName(innerArg.expression.text)
    ) {
      return true;
    }
  }
  // a var whose initializer denotes the intrinsic ctor
  if (ts.isIdentifier(e)) {
    const init = resolveVarInitializer(ctx, e);
    if (init && isTypedArrayIntrinsicCtorExpr(ctx, init)) return true;
  }
  return false;
}

/**
 * (#2901) True iff `arg0` statically traces to `%TypedArray%.prototype`: it is (or
 * a var whose initializer is) a `<X>.prototype` access where `X` denotes the
 * `%TypedArray%` intrinsic constructor (see `isTypedArrayIntrinsicCtorExpr`). This
 * lets the #2885 gOPD synthesis + #2876 reflective `.call` fire on the harness's
 * *dynamic* (variable-routed) proto receiver — `gOPD(TypedArrayPrototype, m)` where
 * `TypedArrayPrototype = TypedArray.prototype` — not just the syntactic
 * `<Ctor>.prototype` form. Pure static analysis — no runtime dispatch, no rep
 * change; returns false (unchanged behaviour) for any other receiver.
 */
export function tracesToTypedArrayIntrinsicProto(ctx: CodegenContext, arg0: ts.Expression): boolean {
  let pa: ts.Expression = unwrapTransparent(arg0);
  if (ts.isIdentifier(pa)) {
    const init = resolveVarInitializer(ctx, pa);
    if (!init) return false;
    pa = unwrapTransparent(init);
  }
  if (!ts.isPropertyAccessExpression(pa) || pa.name.text !== "prototype") return false;
  return isTypedArrayIntrinsicCtorExpr(ctx, pa.expression);
}

/**
 * (#2876) Parse `Object.getOwnPropertyDescriptor(<Builtin>.prototype, "<member>")`
 * → `{ builtinName, member }`, gated like the gOPD-synthesis site: arg0 is an
 * unshadowed `BUILTIN_CTOR_NAMES` `.prototype` access, arg1 a string literal.
 * (#2901) Also accepts a `%TypedArray%`-intrinsic proto receiver that statically
 * traces through the harness's intermediate vars (see `tracesToTypedArrayIntrinsicProto`).
 */
function parseBuiltinProtoGopdCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
): { builtinName: string; member: string } | undefined {
  if (call.arguments.length < 2) return undefined;
  const arg0 = unwrapTransparent(call.arguments[0]!);
  const arg1 = call.arguments[1]!;
  if (!ts.isStringLiteral(arg1)) return undefined;
  // (#2901) Dynamic %TypedArray%.prototype receiver, traced through the harness's
  // intermediate vars (`var TypedArray = getProtoOf(Int8Array); TypedArray.prototype`).
  if (tracesToTypedArrayIntrinsicProto(ctx, arg0)) {
    return { builtinName: "%TypedArray%", member: arg1.text };
  }
  if (
    !ts.isPropertyAccessExpression(arg0) ||
    arg0.name.text !== "prototype" ||
    !ts.isIdentifier(arg0.expression) ||
    !BUILTIN_CTOR_NAMES.has(arg0.expression.text)
  ) {
    return undefined;
  }
  const builtinName = arg0.expression.text;
  if (fctx.localMap.has(builtinName) || (fctx.boxedCaptures?.has(builtinName) ?? false)) return undefined;
  return { builtinName, member: arg1.text };
}

/**
 * (#2876) Reflective `.call/.apply` on a getter pulled from a builtin-proto
 * accessor descriptor — `var get = Object.getOwnPropertyDescriptor(RegExp.prototype,
 * "global").get; get.call(R)` (and the inline `gOPD(...).get.call(R)` form).
 *
 * The descriptor `get` is the brand-keyed getter closure synthesized by #2885;
 * stored in a variable it erases to `externref`, so `tryEmitNativeProtoReflectiveCall`
 * (which keys off the receiver's TS *symbol*, a MethodSignature on a lib
 * interface) can't recover it. Here we recover (brand, member) by STATICALLY
 * tracing the receiver's data-flow back to its `gOPD(<Builtin>.prototype,
 * "<member>").get` initializer, then reuse the shared call_ref emitter (which
 * call_ref's the funcref stored in the runtime wrapper, so the right member runs
 * with thisArg → its `this` param). The getter body's #2885 proto-identity arm +
 * brand recovery then yield the spec result: undefined for `R === proto`, the
 * field value for a real instance, a catchable TypeError for a non-brand `this`.
 *
 * Standalone-only; returns `undefined` (no behaviour change) when the receiver
 * doesn't trace to a builtin-proto accessor descriptor.
 */
function tryEmitNativeProtoDescriptorAccessorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  recv: ts.Expression,
  isCall: boolean,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (expr.arguments.length === 0) return undefined; // need at least a thisArg

  const resolved = resolveDescriptorAccessorSource(ctx, recv);
  if (!resolved || resolved.accessorName !== "get") return undefined; // setter synthesis not wired

  const info = parseBuiltinProtoGopdCall(ctx, fctx, resolved.gopdCall);
  if (!info) return undefined;

  const brand = tryEnsureNativeProtoBrand(ctx, info.builtinName);
  if (brand === undefined) return undefined;
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue || !glue.memberCsv.split(",").includes(info.member)) return undefined;
  if (glue.memberKind(info.member) !== "getter") return undefined;

  return emitReflectiveNativeProtoClosureCall(ctx, fctx, expr, recv, brand, info.member, "getter", isCall);
}

/**
 * (#1324 primitives slice) Try to emit `JSON.stringify(arg)` for a
 * statically-typed primitive value without the `JSON_stringify` JS host call.
 *
 * Supported shapes (all leave an externref string on the stack):
 *   - `null`       → string `"null"`
 *   - `undefined`  → undefined (ref.null.extern) — per spec §25.5.4.2,
 *                    `JSON.stringify(undefined)` returns `undefined`,
 *                    not the string "null"
 *   - `boolean`    → string `"true"` or `"false"`
 *   - `number`     → result of `number_toString(value)` when available, except
 *                    `NaN`/`±Infinity` serialize to the string `"null"`
 *                    per §25.5.4.2 step 9
 *
 * Deferred to #1353 (full architect spec):
 *   - `string`  — needs runtime JSON-escape helper
 *   - `bigint`  — needs runtime check + TypeError throw
 *   - object / array — needs WasmGC shape walking
 *
 * Returns the emitted type and pushes a string/undefined value onto the wasm
 * stack when emission succeeded; returns `undefined` (no stack effect) otherwise so
 * the caller can fall through to the `JSON_stringify` host import.
 */
export function tryEmitJsonStringifyPrimitive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): ValType | null | undefined {
  let argType: ts.Type;
  try {
    argType = ctx.checker.getTypeAtLocation(arg);
  } catch {
    return undefined;
  }
  const flags = argType.flags;

  // (#2166) TypeScript models the `boolean` primitive as the union
  // `true | false`, so a `boolean`-typed value (e.g. `const b: boolean = x`)
  // carries the `Union` flag and was wrongly skipped by the ambiguous-mask
  // early-return below — so `JSON.stringify(b)` refused in standalone instead
  // of serializing to "true"/"false". A `BooleanLike` type (the boolean union
  // or a boolean literal) is unambiguously serializable, so recognize it before
  // the mask. Guard on `intrinsicName === "boolean"` for the union so we don't
  // misfire on a mixed union that merely contains a boolean member.
  const isBooleanType =
    (flags & ts.TypeFlags.BooleanLiteral) !== 0 ||
    ((flags & ts.TypeFlags.Boolean) !== 0 &&
      (argType as ts.Type & { intrinsicName?: string }).intrinsicName === "boolean");

  // Skip ambiguous shapes (any/unknown/union/object/intersection) — let
  // the caller fall through to the host import which handles them. The
  // `boolean` union is the documented exception (see above).
  const ambiguousMask =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Union |
    ts.TypeFlags.Intersection |
    ts.TypeFlags.Object |
    ts.TypeFlags.NonPrimitive |
    ts.TypeFlags.TypeParameter;
  if (!isBooleanType && flags & ambiguousMask) return undefined;

  // null literal
  if (flags & ts.TypeFlags.Null) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" });
    return compileStringLiteral(ctx, fctx, "null", arg);
  }

  // undefined / void — `JSON.stringify(undefined)` returns the JS
  // `undefined` value (not the string "undefined" or "null"). Emit via
  // the existing `emitUndefined` helper so JS sees the right value
  // (host-mode pulls it from `__get_undefined`; standalone mode falls
  // back to `ref.null.extern` which JS sees as `null` — acceptable per
  // the existing helper's documented contract).
  if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" });
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // boolean / true / false
  if (flags & ts.TypeFlags.BooleanLike) {
    const argResult = compileExpression(ctx, fctx, arg, { kind: "i32" });
    if (argResult === null) {
      // Failed to compile the arg as i32 — abandon (no stack effect from this fn).
      return undefined;
    }
    const savedBody = fctx.body;
    fctx.body = [];
    const trueType = compileStringLiteral(ctx, fctx, "true", arg);
    const trueBody = fctx.body;
    fctx.body = [];
    const falseType = compileStringLiteral(ctx, fctx, "false", arg);
    const falseBody = fctx.body;
    fctx.body = savedBody;
    const resultType = trueType ?? falseType ?? ({ kind: "externref" } as ValType);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: trueBody,
      else: falseBody,
    });
    return resultType;
  }

  // number / numeric literal
  if (flags & ts.TypeFlags.NumberLike) {
    const numToStrIdx = ctx.funcMap.get("number_toString");
    if (numToStrIdx === undefined) return undefined;
    const savedBody = fctx.body;
    fctx.body = [];
    const nullType = compileStringLiteral(ctx, fctx, "null", arg);
    const nullBody = fctx.body;
    fctx.body = savedBody;
    // (#3912) BOTH arms must agree on the string representation. The `else` arm
    // is `compileStringLiteral("null")`, which yields a NATIVE `$AnyString` ref
    // exactly when `ctx.nativeStrings`; the `then` arm is `number_toString`,
    // whose externref wraps a native string exactly when the formatter is native
    // — which, since #3912's gate change, is also `ctx.nativeStrings`. The old
    // `ctx.standalone || ctx.wasi` predicate therefore disagreed with the
    // literal under `fast` (nativeStrings without either target): the arms had
    // different types and `JSON.stringify(<number>)` emitted an INVALID MODULE
    // — a validation failure, not merely a trap — across the whole gc-native
    // lane. `ctx.nativeStrings` is the one question both arms actually ask.
    const nativeStringArms = ctx.nativeStrings && ctx.anyStrTypeIdx >= 0;
    const resultType = (nativeStringArms ? nullType : ({ kind: "externref" } as ValType)) ?? {
      kind: "externref",
    };

    const argResult = compileExpression(ctx, fctx, arg, { kind: "f64" });
    if (argResult === null) return undefined;

    // Stack: [f64 value]. Save to a local so we can both test for
    // finiteness AND pass to number_toString in the finite branch.
    const valLocal = allocTempLocal(fctx, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: valLocal });

    // isFinite check: x - x === 0. NaN-NaN and ±Infinity-±Infinity both
    // produce NaN, which fails the equality. Finite values produce 0.
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "f64.sub" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.eq" });

    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [
        { op: "local.get", index: valLocal },
        { op: "call", funcIdx: numToStrIdx },
        ...(nativeStringArms
          ? ([{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx }] satisfies Instr[])
          : []),
      ],
      else: nullBody,
    });
    releaseTempLocal(fctx, valLocal);
    return resultType;
  }

  // string / String — standalone/WASI have no JSON_stringify host import.
  // Emit the pure-Wasm `__json_quote_string` runtime helper (#1599 Phase 2):
  // it scans the runtime string's UTF-16 code units and produces a
  // JSON-quoted $NativeString per §25.5.4.3 QuoteJSONString. In JS-host mode
  // we fall through to the JSON_stringify import (it observes replacer/space
  // and toJSON, which the helper does not).
  if ((ctx.standalone || ctx.wasi) && flags & ts.TypeFlags.StringLike) {
    const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argResult === null) return undefined;
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const quoteIdx = emitJsonQuoteString(ctx);
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_quote_string") ?? quoteIdx });
    // __json_quote_string returns a native string ref (matches compileStringLiteral
    // in nativeStrings mode), so downstream string ops (===, return) see the same
    // type they expect rather than an over-wrapped externref.
    return nativeStringType(ctx);
  }

  // bigint / unhandled — fall through to the host import. Full
  // pure-Wasm support tracked under #1353.
  return undefined;
}

/**
 * (#1599 Phase 2) Try to emit `JSON.parse(s)` for a runtime string-typed
 * argument in standalone / WASI mode, where there is no `env::JSON_parse`
 * host import. Handles the JSON *primitive* slice — number / `true` / `false`
 * / `null` — via the pure-Wasm `__json_parse_primitive` helper, which boxes
 * the parsed value into the host-free `$AnyValue` tagged union.
 *
 * Returns the emitted `ref $AnyValue` type (so the downstream AnyValue→
 * primitive coercion path unboxes it to number / boolean as the consumer
 * requires) and pushes the value; returns `undefined` (no stack effect) when
 * the argument is not a runtime string — objects, arrays, and string *values*
 * still fall through to the #1599 refusal (they need the full Phase 2 codec).
 *
 * Spec: ECMA-262 §25.5.2 `JSON.parse` / `ParseJSON`, ECMA-404.
 */
export function tryEmitJsonParsePrimitive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
  arg: ts.Expression,
): ValType | undefined {
  if (!(ctx.standalone || ctx.wasi)) return undefined;
  // A property/element read on the result — `JSON.parse(s).x` / `JSON.parse(s)[i]`
  // — means the parsed value is consumed as an object/array, which the primitive
  // slice does not produce. Leave those to the #1599 refusal (full Phase 2 codec).
  const parent = call.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.expression === call) ||
    (ts.isElementAccessExpression(parent) && parent.expression === call)
  ) {
    return undefined;
  }
  let argType: ts.Type;
  try {
    argType = ctx.checker.getTypeAtLocation(arg);
  } catch {
    return undefined;
  }
  // Only a string-typed argument routes here. `JSON.parse(<string literal>)`
  // is folded earlier by tryEmitJsonParseLiteral; this handles the runtime
  // string-value case.
  if ((argType.flags & ts.TypeFlags.StringLike) === 0) return undefined;

  const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argResult === null) return undefined;
  if (argResult.kind !== "externref") {
    coerceType(ctx, fctx, argResult, { kind: "externref" });
  }
  const parseIdx = emitJsonParsePrimitive(ctx);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__json_parse_primitive") ?? parseIdx });
  return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
}

/**
 * Check if a node (function body) uses the `arguments` binding.
 * Skips nested function/function-expression scopes (they have their own `arguments`),
 * but traverses arrow functions (which inherit the enclosing `arguments`).
 */
/**
 * (#1465) Emit an iterable argument for a host-bound Promise combinator
 * (Promise.all / race / allSettled / any).
 *
 * The runtime helper delegates to native `Promise.METHOD.call(C, iter)` which
 * drives the spec's `GetIterator(iter)` algorithm — strings, arguments,
 * generators, custom Symbol.iterator objects, Set/Map/TypedArrays all "just
 * work" when the host engine sees them as real iterables.
 *
 * The pain point is array literals: by default `[p1, p2]` compiles to a
 * wasm vec or tuple struct, which is opaque to the host engine. Native
 * GetIterator on an opaque externref throws "object is not iterable".
 *
 * Fix: when the iterable argument is a syntactic ArrayLiteralExpression,
 * compile each element to externref and push it into a JS array via
 * `__js_array_new` / `__js_array_push`. For any other shape (variables,
 * function returns, spread, …) fall back to plain externref coercion and
 * trust the runtime helper's `_toIterable` to dispatch (it handles strings,
 * known JS iterables, and wasm vec via __vec_len/__vec_get).
 */
export function emitIterableArg(ctx: CodegenContext, fctx: FunctionContext, argExpr: ts.Expression): void {
  // Strip parens/as so `(p as any[])` and similar wrappers still match.
  let inner: ts.Expression = argExpr;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isArrayLiteralExpression(inner)) {
    const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
    flushLateImportShifts(ctx, fctx);
    if (arrNewIdx !== undefined && arrPushIdx !== undefined) {
      // Build a JS array eagerly, push each element coerced to externref.
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      const jsArrLocal = allocLocal(fctx, `__promise_iter_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: jsArrLocal });
      for (const el of inner.elements) {
        // Spread inside the array literal: fall back to a generic coercion of
        // the entire literal to externref. Native engine will iterate the
        // spread source on our behalf.
        if (ts.isSpreadElement(el)) {
          fctx.body.push({ op: "drop" });
          compileExpression(ctx, fctx, argExpr, { kind: "externref" });
          return;
        }
        fctx.body.push({ op: "local.get", index: jsArrLocal });
        // OmittedExpression (sparse array hole) — push undefined sentinel.
        if (ts.isOmittedExpression(el)) {
          emitUndefined(ctx, fctx);
        } else {
          const elType = compileExpression(ctx, fctx, el, { kind: "externref" });
          if (elType && elType.kind !== "externref") {
            // compileExpression with target externref should coerce already;
            // belt-and-braces fallback.
            fctx.body.push({ op: "extern.convert_any" });
          }
        }
        fctx.body.push({ op: "call", funcIdx: arrPushIdx });
      }
      fctx.body.push({ op: "local.get", index: jsArrLocal });
      return;
    }
  }
  // Default: coerce to externref and let the runtime helper dispatch.
  compileExpression(ctx, fctx, argExpr, { kind: "externref" });
}

/**
 * (#1632a) Static-resolve the name of a function-like expression for the
 * `__bind_function` nameHint argument. Returns "" when no static name is
 * available (anonymous function, complex expression). The host falls back to
 * the wrapped callable's own `.name` when the hint is empty.
 *
 * Per spec §15.2.5 / NamedEvaluation: a named function expression
 * `function namedFn(){}` keeps its inner name even when bound to a different
 * identifier (`const fn = function namedFn(){}`); the inner name wins.
 */
function resolveStaticFunctionName(ctx: CodegenContext, expr: ts.Expression): string {
  let cursor: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cursor) ||
    ts.isAsExpression(cursor) ||
    ts.isTypeAssertionExpression(cursor) ||
    ts.isSatisfiesExpression(cursor) ||
    ts.isNonNullExpression(cursor)
  ) {
    cursor = (cursor as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(cursor)) {
    // Look through `const fn = function namedFn(){}` to prefer the inner name
    // (named function expression) over the binding identifier.
    const sym = ctx.checker.getSymbolAtLocation(cursor);
    const decl = sym?.valueDeclaration;
    if (decl && (ts.isVariableDeclaration(decl) || ts.isBindingElement(decl)) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.name) return init.name.text;
    }
    return cursor.text;
  }
  if (ts.isPropertyAccessExpression(cursor)) return cursor.name.text;
  // Named function expression: `(function namedFn(){}).bind(...)`
  if (ts.isFunctionExpression(cursor) && cursor.name) return cursor.name.text;
  return "";
}

/**
 * (#1632a) Static-resolve the declared parameter count of a function-like
 * expression for the `__bind_function` lengthHint. Returns -1 when no static
 * arity is available; the host falls back to the wrapped callable's `.length`.
 *
 * Spec §20.2.4.2: `Function.prototype.length` is the count of formal parameters
 * before the first default-valued, rest, or destructured parameter.
 */
function resolveStaticFunctionLength(ctx: CodegenContext, expr: ts.Expression): number {
  let cursor: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cursor) ||
    ts.isAsExpression(cursor) ||
    ts.isTypeAssertionExpression(cursor) ||
    ts.isSatisfiesExpression(cursor) ||
    ts.isNonNullExpression(cursor)
  ) {
    cursor = (cursor as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  // Inline function expression / arrow — read parameters directly.
  if (ts.isFunctionExpression(cursor) || ts.isArrowFunction(cursor)) {
    return countSpecLength(cursor.parameters);
  }
  // Try the TS checker's call signatures.
  const tsType = ctx.checker.getTypeAtLocation(cursor);
  const sigs = tsType?.getCallSignatures?.() ?? [];
  if (sigs.length > 0) {
    const sig = sigs[0]!;
    const decl = sig.getDeclaration?.();
    if (decl && decl.parameters) {
      return countSpecLength(decl.parameters);
    }
    // Fallback: signature parameter count (less precise — counts optional/rest).
    const minArity = (sig as unknown as { minArgumentCount?: number }).minArgumentCount;
    if (typeof minArity === "number") return minArity;
    return sig.parameters.length;
  }
  return -1;
}

function countSpecLength(params: ts.NodeArray<ts.ParameterDeclaration>): number {
  let count = 0;
  for (const p of params) {
    // Skip the TypeScript `this` pseudo-parameter — it's not part of
    // Function.prototype.length per spec.
    if (ts.isIdentifier(p.name) && p.name.text === "this") continue;
    // Stop at first default, rest, or optional — per spec.
    if (p.questionToken !== undefined) break;
    if (p.dotDotDotToken !== undefined) break;
    if (p.initializer !== undefined) break;
    count++;
  }
  return count;
}

/**
 * (#3767) Conservative syntax-only proof that the receiver supplied to
 * `Function.prototype.bind.call(receiver, ...)` cannot have [[Call]].
 *
 * Keep identifiers and other runtime values dynamic: standalone's native
 * closure carriers are callable even though their TypeScript surface can be
 * `any`/object-like. The literals below, however, are unconditionally
 * non-callable ECMAScript values. Transparent TypeScript wrappers do not
 * change that fact.
 */
function isStaticallyNonCallableBindTarget(ctx: CodegenContext, fctx: FunctionContext, value: ts.Expression): boolean {
  let target = value;
  while (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isTypeAssertionExpression(target) ||
    ts.isSatisfiesExpression(target) ||
    ts.isNonNullExpression(target)
  ) {
    target = target.expression;
  }
  const literalNonCallable =
    target.kind === ts.SyntaxKind.NullKeyword ||
    target.kind === ts.SyntaxKind.TrueKeyword ||
    target.kind === ts.SyntaxKind.FalseKeyword ||
    target.kind === ts.SyntaxKind.RegularExpressionLiteral ||
    ts.isNumericLiteral(target) ||
    ts.isBigIntLiteral(target) ||
    ts.isStringLiteralLike(target) ||
    ts.isObjectLiteralExpression(target) ||
    ts.isArrayLiteralExpression(target) ||
    (ts.isIdentifier(target) && target.text === "undefined" && !fctx.localMap.has("undefined"));
  if (literalNonCallable) return true;

  // Test262's ES5 RegExp case first binds `/x/` to `var re` and then passes
  // `re`. The oracle's nominal builtin classification preserves that exact
  // proof without following arbitrary mutable initializers or treating a
  // generic object/`any` value as non-callable.
  return ts.isIdentifier(target) && ctx.oracle.builtinReceiverOf(target) === "RegExp";
}
/**
 * Compile `Function.prototype.bind.call(target, thisArg, ...args)`.
 * Callable targets reshape to the ordinary `.bind` path. Under standalone,
 * statically non-callable targets take the #3767 eager TypeError guard before
 * the general hostless `.call` fallback can silently return.
 */
function tryCompileIndirectFunctionBindCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  if (propAccess.name.text === "apply") return tryBindApply(ctx, fctx, expr, propAccess);
  if (
    propAccess.name.text !== "call" ||
    !ts.isPropertyAccessExpression(propAccess.expression) ||
    propAccess.expression.name.text !== "bind" ||
    !ts.isPropertyAccessExpression(propAccess.expression.expression) ||
    propAccess.expression.expression.name.text !== "prototype" ||
    !ts.isIdentifier(propAccess.expression.expression.expression) ||
    propAccess.expression.expression.expression.text !== "Function" ||
    expr.arguments.length < 1
  ) {
    return undefined;
  }

  const fnExpr = expr.arguments[0]!;
  // ES5 §15.3.4.5 step 2 / current §20.2.3.2 step 2: IsCallable(Target)
  // false must throw TypeError. Outer-call arguments are evaluated first.
  if (usesNativeFunctionBindProvider(ctx) && isStaticallyNonCallableBindTarget(ctx, fctx, fnExpr)) {
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    emitThrowTypeError(ctx, fctx, "Function.prototype.bind called on non-callable");
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Preserve #1337's conservative callable-only reshape. Dynamic targets
  // continue through the general `.call` path.
  const fnTsType = ctx.checker.getTypeAtLocation(fnExpr);
  if ((fnTsType?.getCallSignatures?.()?.length ?? 0) === 0) return undefined;
  const reshapedArgs = expr.arguments.slice(1);
  const reshapedProp = ts.factory.createPropertyAccessExpression(fnExpr as ts.LeftHandSideExpression, "bind");
  ts.setTextRange(reshapedProp, propAccess);
  const reshapedCall = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
  ts.setTextRange(reshapedCall, expr);
  (reshapedCall as any).parent = expr.parent;
  return compileCallExpression(ctx, fctx, reshapedCall as ts.CallExpression);
}

/**
 * (#1632a) Compile `target.bind(thisArg, ...partialArgs)` to a
 * `__bind_function(target, thisArg, argsArray, nameHint, lengthHint)` host
 * import call. The host delegates to `Function.prototype.bind.apply(wrapped,
 * [thisArg, ...partial])` and returns a real JS bound-function exotic.
 *
 * Native-first/standalone targets mint the Wasm-owned `$__bound_fn` carrier;
 * compatibility targets retain the real JS bound-function exotic. Returns
 * `undefined` to signal "no codegen happened, caller should fall through".
 */
/**
 * (#3140) Mint a native `$__bound_fn` value from PRE-EVALUATED externref
 * locals: `{target, thisArg, boundArgs}` where `boundArgs` is a fresh `$ObjVec`
 * of the partial-application args. Leaves the boxed externref on the stack.
 * The carrier is unwrapped by the `__apply_closure` front-guard (boundArgs
 * prepended, recursion on target — bound-of-bound composes) and classified
 * callable by `closure-classifier.ts` (`typeof bound === "function"`).
 * Native semantic-provider lane only (the $ObjVec builders are native).
 */
function emitBoundFnValueFromLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  thisArgLocal: number | undefined,
  partialArgLocals: readonly number[],
): void {
  const { newIdx: objVecNewIdx, pushIdx: objVecPushIdx } = ensureObjVecBuilders(ctx);
  // Reserve the closure bridge so `fillApplyClosure` (which carries the
  // $__bound_fn unwrap front-guard) is guaranteed to run for this module even
  // when the bind result is never visibly called from compiled code paths that
  // would otherwise reserve it.
  reserveApplyClosure(ctx);
  const bfIdx = getOrRegisterBoundFnType(ctx);
  fctx.body.push({ op: "local.get", index: targetLocal });
  if (thisArgLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: thisArgLocal });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const argsVecLocal = allocLocal(fctx, `__bindfn_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: objVecNewIdx });
  fctx.body.push({ op: "local.set", index: argsVecLocal });
  for (const aLocal of partialArgLocals) {
    fctx.body.push({ op: "local.get", index: argsVecLocal });
    fctx.body.push({ op: "local.get", index: aLocal });
    fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
  }
  fctx.body.push({ op: "local.get", index: argsVecLocal });
  fctx.body.push({ op: "ref.null.extern" }); // (#4241) $bag — no expandos at birth
  fctx.body.push({ op: "struct.new", typeIdx: bfIdx });
  fctx.body.push({ op: "extern.convert_any" });
  seedBoundFunctionMetaOnStack(ctx, fctx, targetLocal, partialArgLocals.length); // (#4562/#4563) §20.2.3.2 steps 5-11
}

export function compileFunctionBind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  const externRef: ValType = { kind: "externref" };
  const i32Ty: ValType = { kind: "i32" };

  // (#3140/#4397) Native semantic provider: mint the native
  // `$__bound_fn` carrier {target, thisArg, boundArgs}. Replaces the #1632a
  // identity-bind degrade (which DROPPED the partial args, so the test262
  // TypedArray harness `argFactory.bind(undefined, constructor)` lost the bound
  // ctor and every makeCtorArg-style test failed at the harness level).
  // Evaluation order per §20.2.3.2: target (receiver), then thisArg, then
  // partials — each exactly once, into externref locals.
  if (usesNativeFunctionBindProvider(ctx)) {
    const recvType = compileExpression(ctx, fctx, propAccess.expression, externRef);
    if (recvType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (recvType.kind !== "externref") {
      coerceType(ctx, fctx, recvType, externRef);
    }
    const targetLocal = allocLocal(fctx, `__bindfn_tgt_${fctx.locals.length}`, externRef);
    fctx.body.push({ op: "local.set", index: targetLocal });
    const argLocals: number[] = [];
    for (const arg of expr.arguments) {
      const src = ts.isSpreadElement(arg) ? arg.expression : arg;
      const t = compileExpression(ctx, fctx, src, externRef);
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        coerceType(ctx, fctx, t, externRef);
      }
      const aLocal = allocLocal(fctx, `__bindfn_arg_${fctx.locals.length}`, externRef);
      fctx.body.push({ op: "local.set", index: aLocal });
      argLocals.push(aLocal);
    }
    emitBoundFnValueFromLocals(ctx, fctx, targetLocal, argLocals[0], argLocals.slice(1));
    return externRef;
  }

  // Static hints from the receiver expression (host falls back when -1 / "").
  const targetName = resolveStaticFunctionName(ctx, propAccess.expression);
  const targetLength = resolveStaticFunctionLength(ctx, propAccess.expression);

  // 1. Push target externref.
  const recvType = compileExpression(ctx, fctx, propAccess.expression, externRef);
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  // 2. Push thisArg externref (or ref.null.extern when omitted).
  const args = expr.arguments;
  if (args.length >= 1) {
    const t = compileExpression(ctx, fctx, args[0]!, externRef);
    if (t === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (t.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // 3. Build argsArray as a JS Array of partial args (args[1..]).
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  flushLateImportShifts(ctx, fctx);
  const arrNewResolvedIdx = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
  const arrPushResolvedIdx = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  if (arrNewResolvedIdx === undefined || arrPushResolvedIdx === undefined) {
    // Late-import setup failed (very unusual). Bail to identity-bind for safety.
    fctx.body.push({ op: "drop" }); // drop thisArg
    return externRef;
  }
  fctx.body.push({ op: "call", funcIdx: arrNewResolvedIdx });
  const argsArrayLocal = allocLocal(fctx, `__bind_args_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: argsArrayLocal });
  for (let i = 1; i < args.length; i++) {
    fctx.body.push({ op: "local.get", index: argsArrayLocal });
    const argExpr = args[i]!;
    if (ts.isSpreadElement(argExpr)) {
      // Spread in bind partials is rare — coerce the spread argument to
      // externref and let the host accept it as a single value. Real spread
      // handling would need iterable expansion at compile time.
      const t = compileExpression(ctx, fctx, argExpr.expression, externRef);
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
    } else {
      const t = compileExpression(ctx, fctx, argExpr, externRef);
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
    }
    fctx.body.push({ op: "call", funcIdx: arrPushResolvedIdx });
  }
  fctx.body.push({ op: "local.get", index: argsArrayLocal });

  // 4. Push nameHint (string externref or ref.null.extern).
  if (targetName) {
    fctx.body.push(...stringConstantExternrefInstrs(ctx, targetName));
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // 5. Push lengthHint i32 (-1 = unknown).
  fctx.body.push({ op: "i32.const", value: targetLength });

  // 6. Call __bind_function. Result is externref.
  const bindIdx = ensureLateImport(
    ctx,
    "__bind_function",
    [externRef, externRef, externRef, externRef, i32Ty],
    [externRef],
  );
  flushLateImportShifts(ctx, fctx);
  const bindResolvedIdx = ctx.funcMap.get("__bind_function") ?? bindIdx;
  if (bindResolvedIdx === undefined) {
    // Should not happen in host mode — drop the staged args and degrade.
    fctx.body.push({ op: "drop" }); // length hint
    fctx.body.push({ op: "drop" }); // name hint
    fctx.body.push({ op: "drop" }); // args array
    fctx.body.push({ op: "drop" }); // thisArg
    // Leave receiver on the stack as identity-bind fallback.
    return externRef;
  }
  fctx.body.push({ op: "call", funcIdx: bindResolvedIdx });
  return externRef;
}

/**
 * (#1712 / #1941) Static gate for the host-callable dispatch fallback.
 *
 * The callable-param dispatch below emits an extra `__call_function` arm so a
 * callee that arrives as a non-closure externref (a host builtin held in a JS
 * variable — acorn's `var hasOwn = Object.hasOwn || function(…){…}`) dispatches
 * through the host instead of trapping on `struct.get` of a null cast. That arm
 * is only ever *taken* when the runtime value is NOT a wasm closure struct, but
 * it was emitted for EVERY callable-param dispatch, which unconditionally pulls
 * `__js_array_new` / `__js_array_push` / `__call_function` host imports into the
 * module — even for pure local-closure programs (`applyTwice((x)=>x+1, 10)`,
 * `const add5 = makeAdder(5)`) that need no JS host at all. That regressed the
 * #1941 optimize-differential gate (LinkError: `__js_array_new` not provided)
 * and violated the dual-mode "JS host optional" principle for these programs.
 *
 * Gate the fallback to callees whose runtime value can plausibly be a foreign
 * (non-wasm-closure) callable: a variable whose initializer references a host
 * builtin member directly (`var f = Object.hasOwn`) or as the left operand of a
 * `||` / `??` short-circuit (`Object.hasOwn || function(){}`). Function
 * parameters and locals/globals initialized from wasm expressions (closures,
 * local function results) are always wrapped into the closure struct by the
 * call-site coercion, so the fallback can never fire for them — and we must not
 * burden them with host imports.
 */
export function calleeMayBeHostCallable(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  // A default-export expression cell can carry either a compiled closure or a
  // host function selected at runtime (`Function.prototype.bind || fallback`).
  // The exact import-cell lookup keeps this decision independent of unrelated
  // same-named graph entries; the ordinary closure arm still handles compiled
  // values and this only admits the non-closure host fallback.
  if (resolveDefaultExpressionImportGlobal(ctx, expr) !== undefined) {
    return !ctx.standalone && !ctx.wasi;
  }
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  const unparen = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? node.expression : node);
  // (#4616) A callable PARAM of a CLASS METHOD routinely receives a host
  // function at runtime: an any-receiver dynamic method call marshals its
  // arrow argument through the host bridge, and test harnesses hand methods
  // host spies (jest.fn()). Replaceable.forEach's `cb(...)` nulled the
  // wrapper cast and trapped call_ref un-catchably. Method params get the
  // #1712 host arm; plain function params keep the #1941 gate so pure
  // local-closure programs stay host-import-free.
  if (decl && ts.isParameter(decl) && decl.parent !== undefined && ts.isMethodDeclaration(decl.parent)) {
    return !ctx.standalone && !ctx.wasi;
  }

  // A callable extracted from a host builtin through object destructuring is
  // still a real JS function, not a Wasm closure. For example Axios starts
  // with `const { getPrototypeOf } = Object` and later calls
  // `getPrototypeOf(Uint8Array)` during module initialization. The binding's
  // checker type is callable, so the ordinary closure dispatch guard-casts the
  // externref to a closure struct; that cast yields null and the following
  // struct.get traps. Keep the raw externref fallback for this exact,
  // statically-proven host source. User-object destructuring is deliberately
  // excluded so pure compiled callback graphs retain the #1941 no-host-import
  // property.
  if (decl && ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
    const variableDecl = decl.parent.parent;
    if (ts.isVariableDeclaration(variableDecl) && variableDecl.initializer) {
      const source = unparen(variableDecl.initializer);
      if (ts.isIdentifier(source) && (BUILTIN_CLASS_NAMES.has(source.text) || ctx.declaredGlobals.has(source.text))) {
        return !ctx.standalone && !ctx.wasi;
      }
    }
  }
  if (variableMayProduceHostCallable(ctx, expr)) return true;
  if (decl && ts.isVariableDeclaration(decl) && bindingMayReceiveHostCallable(ctx, decl)) return true;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;

  // (#3432 follow-up) A declaration that SKIPPED the closure match-and-recast
  // (callable-typed var whose slot stayed externref, see
  // `skippedClosureRecastDecls` in context/types.ts) holds a raw externref
  // that can be a foreign callable — a bridge-wrapped wasm closure read back
  // off a property/array element (`var format = compareArray.format;`), a
  // bound function, or a host builtin. The #1941 "always normalized to
  // struct-or-null" assumption does not hold for these, so the #1712
  // `__call_function` fallback arm MUST be emitted or the closure-struct
  // dispatch traps `struct.get` on the nulled cast. Precise (per-decl, only
  // when the skip actually happened at compile time), so the #1941 dual-mode
  // guarantee for pure local-closure programs is preserved.
  if (ctx.skippedClosureRecastDecls?.has(decl)) return true;

  return false;
}

/**
 * (#2028) Is `expr` an identifier resolving to a parameter of a **Promise
 * executor** — the `(resolve, reject) => {…}` arrow/function-expression passed
 * directly to `new Promise(...)`?
 *
 * Those params are bound by the host (native `new Promise` calls the executor
 * with real JS `resolve`/`reject` functions), so they arrive as plain externref
 * JS callables, NOT wasm closure structs. Calling them through the closure-struct
 * `ref.test`/`ref.cast`/`struct.get`/`call_ref` dispatch path nulls the cast and
 * traps on the null deref — they must take the `__call_function` arm instead.
 *
 * This is intentionally narrow. An ordinary callable parameter (`cb` in
 * `function apply(cb, v) { return cb(v); }`) is ALSO lowered with an `externref`
 * wasm type — the closure struct is recovered dynamically at the call site via
 * `ref.test (ref $closure)`. So "externref-typed callable param" alone is NOT a
 * safe discriminator: gating on it would re-emit the `__call_function` arm for
 * pure local-closure programs and regress the #1941 dual-mode guarantee. The
 * precise signal is that the param's *declaring function is a Promise executor*
 * (an arrow/function-expression that is the direct argument of `new Promise`),
 * whose param values are genuinely host-supplied.
 */
export function calleeIsPromiseExecutorParam(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isParameter(decl)) return false;
  // The parameter's declaring function must be the executor of `new Promise(...)`:
  // an arrow / function expression that is a direct argument of a `new Promise`.
  const fn = decl.parent;
  if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return false;
  const argParent = fn.parent;
  if (!argParent || !ts.isNewExpression(argParent)) return false;
  const ctor = argParent.expression;
  if (!ts.isIdentifier(ctor) || ctor.text !== "Promise") return false;
  // Confirm the executor is actually in the argument list (not, e.g., a type arg).
  const fnNode: ts.Node = fn;
  return (argParent.arguments ?? []).some((a) => a === fnNode);
}

/**
 * (#1528 / #56 follow-up — class-ctor arm) Is `expr` an identifier resolving to a
 * parameter of a function that is used as a Promise-combinator CAPABILITY
 * CONSTRUCTOR — i.e. the `executor` of a `function Constructor(executor){…}` that
 * flows to `Promise.{all,allSettled,race,any}.call(Constructor, …)`?
 *
 * V8's `NewPromiseCapability(Constructor)` does `Construct(Constructor, «executor»)`
 * (run via #1632b-2's closure-construct bridge). Inside the compiled body the call
 * `executor(resolve, reject)` is a call of a function-typed PARAMETER whose value
 * is a HOST function V8 supplied — NOT a wasm closure struct. The default
 * closure-struct `ref.cast`/`call_ref` dispatch then `illegal cast`s; such a param
 * must take the `__call_function` host-callable arm instead. This mirrors the
 * Promise-executor-param case (#2028) but for the capability-constructor entry.
 *
 * Gate is SYNTACTIC and narrow (NOT whole-program escape analysis), to preserve
 * the #1941 dual-mode guarantee: the param's declaring function must be a
 * `function` declaration / named function-expression whose identifier appears as
 * the FIRST argument of a `Promise.<combinator>.call(...)` somewhere in the
 * source file. Only such functions are entered as capability constructors with
 * host-supplied params; ordinary callable params never match.
 */
export function calleeIsCapabilityCtorParam(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isIdentifier(expr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isParameter(decl)) return false;
  // The declaring function: a FunctionDeclaration, or a function/arrow expression
  // bound to a variable (so it has a stable referenceable name).
  const fn = decl.parent;
  let fnName: string | undefined;
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    fnName = fn.name.text;
  } else if (
    (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) &&
    fn.parent &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    fnName = fn.parent.name.text;
  }
  if (fnName === undefined) return false;
  // Scan the source file for `Promise.<combinator>.call(<fnName>, …)`.
  // (#2671) `Promise.resolve` / `Promise.reject` are ALSO capability-ctor
  // sites: V8's `Promise.resolve.call(C)` → PromiseResolve(C) →
  // NewPromiseCapability(C) → `Construct(C, «GetCapabilitiesExecutor»)`. The
  // user fn's `executor` param therefore receives a host executor and must
  // wrap its closure args host-callable through `__call_function`, exactly
  // like the four aggregators (executor-function-* test262 family).
  const COMBINATORS = new Set(["all", "allSettled", "race", "any", "resolve", "reject"]);
  const sf = decl.getSourceFile();
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // `Promise.<combinator>.call(<id>, …)` — `(Promise.X).call`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "call" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "Promise" &&
      COMBINATORS.has(node.expression.expression.name.text)
    ) {
      // Unwrap `as`/paren/non-null on the capability arg so
      // `Promise.X.call(Constructor as any, …)` matches the bare-identifier form.
      let firstArg = node.arguments[0];
      while (
        firstArg &&
        (ts.isAsExpression(firstArg) || ts.isParenthesizedExpression(firstArg) || ts.isNonNullExpression(firstArg))
      ) {
        firstArg = firstArg.expression;
      }
      if (firstArg && ts.isIdentifier(firstArg) && firstArg.text === fnName) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * (#1337) Emit a call to a host bound-function externref via the
 * `__call_function(fn, thisArg, argsArray)` host helper. The bound function
 * already carries [[BoundThis]] and [[BoundArguments]], so `thisArg` is passed
 * as `undefined` (ref.null.extern) and only the call-site arguments are packed.
 *
 * Returns `{ kind: "externref" }` on success, or `null` to let the caller fall
 * through to the normal dispatch (e.g. if late-import wiring fails).
 */
export function emitBoundFunctionCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  calleeAlreadyOnStack = false,
): InnerResult | null {
  const externRef: ValType = { kind: "externref" };

  // 1. Compile callee → externref, stash in a local.
  if (!calleeAlreadyOnStack) {
    const calleeType = compileExpression(ctx, fctx, expr.expression, externRef);
    if (calleeType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (calleeType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
  }
  const calleeLocal = allocLocal(fctx, `__bfn_callee_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  // 2. Build the arguments array (JS Array externref).
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  flushLateImportShifts(ctx, fctx);
  const arrNewResolvedIdx = ctx.funcMap.get("__js_array_new") ?? arrNewIdx;
  const arrPushResolvedIdx = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  if (arrNewResolvedIdx === undefined || arrPushResolvedIdx === undefined) return null;

  fctx.body.push({ op: "call", funcIdx: arrNewResolvedIdx });
  const argsArrayLocal = allocLocal(fctx, `__bfn_args_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: argsArrayLocal });
  for (const argExpr of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsArrayLocal });
    const inner = ts.isSpreadElement(argExpr) ? argExpr.expression : argExpr;
    const t = compileExpression(ctx, fctx, inner, externRef);
    if (t === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (t.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    fctx.body.push({ op: "call", funcIdx: arrPushResolvedIdx });
  }

  // 3. Call __call_function(callee, undefined, argsArray).
  const callIdx = ensureLateImport(ctx, "__call_function", [externRef, externRef, externRef], [externRef]);
  flushLateImportShifts(ctx, fctx);
  const callResolvedIdx = ctx.funcMap.get("__call_function") ?? callIdx;
  if (callResolvedIdx === undefined) return null;

  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "ref.null.extern" }); // thisArg — bound fn carries [[BoundThis]]
  fctx.body.push({ op: "local.get", index: argsArrayLocal });
  fctx.body.push({ op: "call", funcIdx: callResolvedIdx });
  return externRef;
}

/**
 * Emit a host call for a dynamically stored callable whose call site contains
 * a spread argument.  A spread parameter is represented inside Wasm as a
 * `__vec_*` struct; passing that struct through the ordinary callable wrapper
 * turns it into one JavaScript argument (for example, `"a,b,c"`) instead of
 * expanding its elements.  Build the host argument array here so both Wasm
 * closures and ordinary host functions observe the same positional arguments.
 *
 * This path is deliberately limited to the JS-host lane.  Standalone/WASI
 * calls retain their native ObjVec/call_ref lowering, where the vector is a
 * first-class Wasm value and can be expanded without a host boundary.
 */
export function emitDynamicSpreadCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  expectedType?: ValType,
): InnerResult | null {
  if (ctx.standalone || ctx.wasi || !expr.arguments.some((arg) => ts.isSpreadElement(arg))) return null;

  const externRef: ValType = { kind: "externref" };
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externRef]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [externRef, externRef], []);
  const callIdx = ensureLateImport(ctx, "__call_function", [externRef, externRef, externRef], [externRef]);
  // The fallback for a non-Wasm iterable uses the same host indexing helpers as
  // the arguments/array materializer. Register them up front so a source
  // expression that itself triggers a late import cannot invalidate the array
  // builder indices below.
  const iterIdx = ensureLateImport(ctx, "__array_from_iter", [externRef], [externRef]);
  const lenIdx = ensureLateImport(ctx, "__extern_length", [externRef], [{ kind: "f64" }]);
  const getIdx = ensureLateImport(ctx, "__extern_get_idx", [externRef, { kind: "f64" }], [externRef]);
  flushLateImportShifts(ctx, fctx);
  if (arrNewIdx === undefined || arrPushIdx === undefined || callIdx === undefined) return null;

  // Compile the callee exactly once and retain the raw externref.  The host
  // call adapter wraps a Wasm closure struct into a real JS function when
  // needed, while leaving ordinary host functions untouched.
  const calleeType = compileExpression(ctx, fctx, expr.expression, externRef);
  if (calleeType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (calleeType.kind !== "externref") {
    coerceType(ctx, fctx, calleeType, externRef);
  }
  const calleeLocal = allocLocal(fctx, `__spread_callee_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: calleeLocal });

  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_new") ?? arrNewIdx });
  const argsLocal = allocLocal(fctx, `__spread_args_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.set", index: argsLocal });

  const pushIndex = (): number => ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
  const boxNumberIndex = (): number | undefined => ctx.funcMap.get("__box_number");

  const appendElementAsExtern = (elementType: ValType, body: Instr[]): void => {
    if (elementType.kind === "f64") {
      const boxIdx = boxNumberIndex();
      if (boxIdx !== undefined) body.push({ op: "call", funcIdx: boxIdx });
      else body.push({ op: "drop" }, { op: "ref.null.extern" });
    } else if (elementType.kind === "i32" || elementType.kind === "i8" || elementType.kind === "i16") {
      const boxIdx = boxNumberIndex();
      if (boxIdx !== undefined) {
        body.push({ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx });
      } else {
        body.push({ op: "drop" }, { op: "ref.null.extern" });
      }
    } else if (elementType.kind === "ref" || elementType.kind === "ref_null" || elementType.kind === "eqref") {
      body.push({ op: "extern.convert_any" });
    }
  };

  for (const arg of expr.arguments) {
    if (!ts.isSpreadElement(arg)) {
      fctx.body.push({ op: "local.get", index: argsLocal });
      const valueType = compileExpression(ctx, fctx, arg, externRef);
      if (valueType === null) fctx.body.push({ op: "ref.null.extern" });
      else if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, externRef);
      fctx.body.push({ op: "call", funcIdx: pushIndex() });
      continue;
    }

    // Preserve the natural representation of a Wasm vector.  Coercing it to
    // externref first would create a mirror object and lose the vector's
    // element boundaries at precisely the call boundary we are repairing.
    const spreadType = compileExpression(ctx, fctx, arg.expression);
    if (spreadType && (spreadType.kind === "ref" || spreadType.kind === "ref_null")) {
      const vecInfo = getVecInfo(ctx, spreadType.typeIdx);
      if (vecInfo) {
        const vecLocal = allocLocal(fctx, `__spread_vec_${fctx.locals.length}`, spreadType);
        fctx.body.push({ op: "local.set", index: vecLocal });
        const idxLocal = allocLocal(fctx, `__spread_idx_${fctx.locals.length}`, { kind: "i32" });
        const lenLocal = allocLocal(fctx, `__spread_len_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.get", index: vecLocal });
        if (spreadType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
        fctx.body.push({ op: "struct.get", typeIdx: spreadType.typeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "local.set", index: lenLocal });
        fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: idxLocal });
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: idxLocal },
                { op: "local.get", index: lenLocal },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: argsLocal },
                { op: "local.get", index: vecLocal },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: spreadType.typeIdx, fieldIdx: 1 },
                { op: "local.get", index: idxLocal },
                {
                  op: vecInfo.elemType.kind === "i8" || vecInfo.elemType.kind === "i16" ? "array.get_s" : "array.get",
                  typeIdx: vecInfo.arrTypeIdx,
                },
                ...(() => {
                  const elementBody: Instr[] = [];
                  appendElementAsExtern(vecInfo.elemType, elementBody);
                  return elementBody;
                })(),
                { op: "call", funcIdx: pushIndex() },
                { op: "local.get", index: idxLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: idxLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        });
        continue;
      }
    }

    // Fallback for a host iterable or an opaque object.  The host helpers
    // materialize it into an Array and expose length/index operations; unlike
    // the old path, every element is pushed separately.
    if (spreadType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (spreadType.kind !== "externref") {
      coerceType(ctx, fctx, spreadType, externRef);
    }
    if (iterIdx === undefined || lenIdx === undefined || getIdx === undefined) {
      fctx.body.push({ op: "local.get", index: argsLocal }, { op: "call", funcIdx: pushIndex() });
      continue;
    }
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__array_from_iter") ?? iterIdx });
    const iterableLocal = allocLocal(fctx, `__spread_iter_${fctx.locals.length}`, externRef);
    fctx.body.push({ op: "local.set", index: iterableLocal });
    const idxLocal = allocLocal(fctx, `__spread_host_idx_${fctx.locals.length}`, { kind: "i32" });
    const lenLocal = allocLocal(fctx, `__spread_host_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push(
      { op: "local.get", index: iterableLocal },
      { op: "call", funcIdx: ctx.funcMap.get("__extern_length") ?? lenIdx },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.set", index: lenLocal },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: idxLocal },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: idxLocal },
              { op: "local.get", index: lenLocal },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: argsLocal },
              { op: "local.get", index: iterableLocal },
              { op: "local.get", index: idxLocal },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: ctx.funcMap.get("__extern_get_idx") ?? getIdx },
              { op: "call", funcIdx: pushIndex() },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    );
  }

  fctx.body.push(
    { op: "local.get", index: calleeLocal },
    { op: "ref.null.extern" },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__call_function") ?? callIdx },
  );
  if (expectedType && expectedType.kind !== "externref") {
    coerceType(ctx, fctx, externRef, expectedType);
    return expectedType;
  }
  return externRef;
}

/**
 * (#1116b) Resolve a Promise-combinator `thisArg`/receiver that names a
 * Wasm-compiled `class X extends Promise`.
 *
 * Such a class is externref-backed (#1366a/b): its instances are real host
 * Promises (built via `__new_Promise`), but the class *identifier itself* has
 * no class-object singleton global, so `compileExpression(MyPromise)` yields
 * `null`/opaque — and `Promise.all.call(MyPromise, iter)` then throws
 * `[object Object] is not a constructor` in V8. The fix: resolve the
 * identifier to a real JS-callable Promise subclass synthesized (and cached)
 * by the `__promise_subclass_ctor` host import, keyed on the class name.
 *
 * Returns true if it emitted a JS-constructor externref for `argExpr`; false
 * if the caller should fall back to plain `compileExpression`.
 */
export function resolvePromiseSubclassThisArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
): boolean {
  // (#2623 Slice B) Unified with the value-read path: both the combinator
  // `thisArg` receiver here and a bare-identifier read-as-value in
  // `identifiers.ts` now go through the same cached `__promise_subclass_ctor`
  // singleton, so the constructor the user observes IS the one used to build
  // the subclassed promise (one object, not two). Detection (parent-chain
  // walk, standalone gate) + emission live in `promise-subclass.ts`.
  return tryEmitPromiseSubclassReceiver(ctx, fctx, argExpr);
}

/**
 * (#1397) Conservative scope-level reassignment scan: returns true if the
 * source file contains any assignment expression of the form `X.<method> = ...`
 * (any LHS expression, member name === `methodName`).
 *
 * Used to gate static-dispatch fast-paths for wrapper-type method calls
 * (`new String(...).toString()`, `new Number(...).valueOf()`, etc.) so that
 * sources that explicitly reassign these methods fall through to the
 * dynamic-dispatch path (`__extern_method_call`) and pick up the override
 * at runtime — preserving spec semantics where transferred prototype methods
 * throw TypeError on the wrong receiver type.
 *
 * Conservative scan rationale: scope-narrowing (only the enclosing function)
 * would miss patterns like `obj.toString = OtherType.prototype.toString`
 * defined at module scope and used inside a function. False positives
 * (sources that reassign in some unrelated branch) only cost the static
 * fast-path on wrapper objects — not a measurable perf hit because wrappers
 * are uncommon at runtime in real code.
 *
 * Cached per `(sourceFile, methodName)` so repeated calls are O(1).
 */
const _reassignmentCache = new WeakMap<ts.SourceFile, Map<string, boolean>>();
export function sourceHasMethodReassignment(ctx: CodegenContext, anchor: ts.Node, methodName: string): boolean {
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  let perFile = _reassignmentCache.get(sf);
  if (perFile === undefined) {
    perFile = new Map<string, boolean>();
    _reassignmentCache.set(sf, perFile);
  }
  const cached = perFile.get(methodName);
  if (cached !== undefined) return cached;

  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.name) &&
      node.left.name.text === methodName
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(sf);
  perFile.set(methodName, found);
  // Reference ctx so the parameter isn't unused — the cache is keyed on the
  // SourceFile (not ctx) but we keep ctx in the signature for future
  // refinements that need scope-narrowing or per-symbol resolution.
  void ctx;
  return found;
}

/**
 * (#1397) Emit a dynamic-dispatch method call on a wrapper-object receiver:
 *
 *   __extern_method_call(receiver, methodName, [])
 *
 * Used by the wrapper-reassignment branch at the top of compileMethodCall
 * to bypass the static fast-paths when source has reassigned the method.
 * Returns the result type (externref) on success, null if the necessary
 * runtime imports cannot be registered (caller falls through to the
 * static path as a best-effort fallback).
 */
export function emitWrapperDynamicMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
  methodName: string,
  callExpr?: ts.CallExpression,
): ValType | null {
  // (#4373) The host wrapper can only preserve arguments that have a matching
  // `__call_fn_method_N` dispatcher. Record the real dynamic call-site width
  // before module finalization; otherwise modules whose declared closures are
  // all narrower retain the historical five-argument cap and truncate extras.
  if (callExpr) observeHostDynamicMethodCallArity(ctx, callExpr.arguments);

  // (#1888 Slice 2) Standalone routes __extern_method_call native, which reads
  // its args over a $ObjVec — build the (empty) args list with the native
  // $ObjVec builder, not the host __js_array_new. JS-host keeps the host import.
  const arrNewIdx = ctx.standalone
    ? ensureObjVecBuilders(ctx).newIdx
    : ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  // (#1712) Args support: when a call expression with arguments is supplied,
  // pack them into the args array via __js_array_push. JS-host only — the
  // standalone $ObjVec path stays empty-args until it grows a native push.
  const wantArgs = callExpr !== undefined && callExpr.arguments.length > 0 && !ctx.standalone && !ctx.wasi;
  const arrPushIdx = wantArgs
    ? ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], [])
    : undefined;
  const methodCallIdx = ensureLateImport(
    ctx,
    "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (arrNewIdx === undefined || methodCallIdx === undefined) return null;
  if (wantArgs && arrPushIdx === undefined) return null;

  // Compile receiver as externref.
  const recvType = compileExpression(ctx, fctx, recvExpr, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Push method name as a string constant.
  addStringConstantGlobal(ctx, methodName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));

  // Args array: __js_array_new() → externref (+ per-arg __js_array_push).
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_new") ?? arrNewIdx });
  if (wantArgs) {
    const argsArrLocal = allocLocal(fctx, `__dynm_args_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: argsArrLocal });
    for (const argExpr of callExpr!.arguments) {
      fctx.body.push({ op: "local.get", index: argsArrLocal });
      const t = compileExpression(ctx, fctx, argExpr, { kind: "externref" });
      if (t === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (t.kind !== "externref") {
        coerceType(ctx, fctx, t, { kind: "externref" });
      }
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__js_array_push") ?? arrPushIdx! });
    }
    fctx.body.push({ op: "local.get", index: argsArrLocal });
  }

  // Re-lookup methodCallIdx in case args compilation triggered shifts.
  const finalMcIdx = ctx.funcMap.get("__extern_method_call") ?? methodCallIdx;
  fctx.body.push({ op: "call", funcIdx: finalMcIdx });
  return { kind: "externref" };
}

/**
 * Emit `global.set __argc` with the actual call-site argument count.
 * This communicates how many args were really passed so the callee can
 * build a correctly-sized `arguments` object (per ES spec, arguments.length
 * equals the number of args passed, not the number of formal params).
 * Only emitted when the callee is known to use `arguments`.
 */
export function emitSetArgc(
  ctx: CodegenContext,
  fctx: FunctionContext,
  actualArgCount: number,
  paramCount: number,
): void {
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  // Set __argc = min(actualArgCount, paramCount) — the count of formal param
  // slots actually filled. Overflow args are in __extras_argv and tracked by
  // extrasLen, so totalLen = argc + extrasLen gives the correct arguments.length.
  const argc = Math.min(actualArgCount, paramCount);
  fctx.body.push({ op: "i32.const", value: argc });
  fctx.body.push({ op: "global.set", index: argcGlobalIdx });
}

/**
 * Reset the __argc and __extras_argv globals to their sentinel values
 * (-1 / null). Used after closure / indirect call paths where we set the
 * globals unconditionally but can't be sure the callee consumed them
 * (its prologue only consumes when the body reads `arguments`). Without
 * cleanup, a subsequent function that does read `arguments` would
 * inherit a stale extras_argv and produce a wrong arguments.length.
 * (#1511)
 */
export function emitResetArgcExtras(ctx: CodegenContext, fctx: FunctionContext): void {
  // A zero-overflow indirect call sets only __argc. Do not lazily create
  // __extras_argv during cleanup: registering that imported global after the
  // setup arm has already been captured can shift the arm's baked __argc
  // global.set while it is temporarily detached (#3367). If the extras global
  // already exists, the shared no-lazy helper still clears it as required.
  fctx.body.push(...buildArgcResetNoLazyExtras(ctx));
}

/**
 * For indirect (closure / call_ref) call paths where the callee is not
 * statically known, set `__argc` and (if there are overflow args) build
 * `__extras_argv` from the call-site args beyond `paramCount`. The
 * lifted callee's prologue reads these to compute `arguments.length`
 * correctly even when more args were passed than the lifted function's
 * formal signature accepts.
 *
 * Must be called AFTER the formal args have been compiled / pushed onto
 * the stack (or saved to locals), but BEFORE the call_ref. Pair with
 * `emitResetArgcExtras` after the call to prevent stale-extras leaking
 * into a subsequent callee that DOES read `arguments`. (#1511)
 */
export function emitClosureCallArgcExtras(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  paramCount: number,
): void {
  if (args.length > paramCount) {
    emitSetExtrasArgv(ctx, fctx, args as unknown as ts.Expression[], paramCount);
  }
  emitSetArgc(ctx, fctx, args.length, paramCount);
}

/**
 * Flatten call-site arguments, expanding spread elements on array literals
 * into individual expressions. Returns the flat list of expressions.
 * For spread on non-literal arrays, returns null (cannot flatten at compile time).
 */
export function flattenCallArgs(args: readonly ts.Expression[]): ts.Expression[] | null {
  const result: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (ts.isArrayLiteralExpression(arg.expression)) {
        for (const el of arg.expression.elements) {
          result.push(el);
        }
      } else {
        return null;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * (#2707c) Does a named function expression's body reference its OWN name? Used
 * to decide whether a `(function f(){ … })()` IIFE is *recursive* and therefore
 * cannot be inlined (the inlined body would have no callable to bind `f` to).
 *
 * Conservative — returns true on ANY identifier occurrence of the own name
 * inside the body, without resolving shadowing. That is safe because the only
 * consequence is compiling the IIFE as a closure instead of inlining it, which
 * is always semantically correct; a false positive merely forgoes the inline
 * optimization. We do NOT descend into nested function/class scopes that
 * re-declare the name as their own (those are separate bindings), to keep the
 * conservative over-approximation from being needlessly broad.
 */
export function functionExprBodyReferencesOwnName(fn: ts.FunctionExpression): boolean {
  if (!fn.name) return false;
  const ownName = fn.name.text;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // A nested function/method that declares a parameter or its own name equal
    // to ownName shadows it — but to stay conservative+simple we still descend;
    // a self-call to a shadowing inner binding only ever causes a (correct)
    // closure compile. Identifier match = treat as self-reference.
    if (ts.isIdentifier(node) && node.text === ownName) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

function isRuntimeNamespaceReceiver(ctx: CodegenContext, identifier: ts.Identifier): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (declaration !== undefined && (ts.isNamespaceImport(declaration) || ts.isModuleDeclaration(declaration))) {
    return true;
  }

  // A named import of an `export namespace` binds an ImportSpecifier at the
  // use site. Follow that one checker alias to the provider's runtime
  // ModuleDeclaration; the namespace object itself is not materialized by the
  // Wasm backend, so member functions must use the same static call path as an
  // `import * as ns` receiver.
  let symbol = ctx.checker.getSymbolAtLocation(identifier);
  if (symbol === undefined) return false;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = ctx.checker.getAliasedSymbol(symbol);
    } catch {
      return false;
    }
  }
  return [symbol.valueDeclaration, ...(symbol.declarations ?? [])].some(
    (candidate) => candidate !== undefined && ts.isModuleDeclaration(candidate),
  );
}

/**
 * (#4614/#1058) Statically resolve a runtime namespace member call to the
 * equivalent named call. This covers both `import * as ns` and TypeScript's
 * `export namespace Debug` consumed locally or through a named import. Returns
 * undefined for ambient/external namespaces and non-function members so the
 * caller can fall through to the legacy lanes.
 */
function tryRuntimeNamespaceMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ts.isPropertyAccessExpression(expr.expression)) return undefined;
  const access = expr.expression;
  if (!ts.isIdentifier(access.expression) || ts.isPrivateIdentifier(access.name)) return undefined;
  if (!isRuntimeNamespaceReceiver(ctx, access.expression)) return undefined;
  // The export symbol of `export function f` carries the FunctionDeclaration
  // directly; deeper re-export chains resolve to the intermediate specifier
  // and decline here (fail-closed to the legacy lane).
  const memberDecl = ctx.oracle.valueDeclarationOf(access.name);
  if (
    memberDecl === undefined ||
    !ts.isFunctionDeclaration(memberDecl) ||
    memberDecl.name === undefined ||
    memberDecl.body === undefined
  ) {
    return undefined;
  }
  const targetName = memberDecl.name;
  // A bare name is graph-global legacy state and may belong to an unrelated
  // declaration. Require the exact Program ABI source unit and allocator
  // handle, then project that handle only for the duration of the established
  // identifier-call lowering. Missing or inconsistent identity fails closed.
  const registry = ctx.programAbiSourceCallables;
  const identity = registry?.identityContext;
  const unitId = identity?.unitIdByDeclaration.get(memberDecl);
  if (!registry || !identity || unitId === undefined || identity.declarationByUnitId.get(unitId) !== memberDecl) {
    return undefined;
  }
  const targetHandle = registry.handleForUnit(unitId);
  const targetFunc = registry.functionForUnit(unitId);
  if (targetHandle === undefined || targetFunc === undefined || definedFuncAt(ctx, targetHandle) !== targetFunc) {
    return undefined;
  }
  const synthetic = ts.factory.createCallExpression(targetName, expr.typeArguments, expr.arguments);
  ts.setTextRange(synthetic, expr);
  // A factory node has no parent chain, so `getSourceFile()` on it (position
  // maps, diagnostics) crashes — anchor it where the original call sits.
  (synthetic as { parent?: ts.Node }).parent = expr.parent;
  // The factory reuses the original argument nodes. Callback classification
  // consults an arrow/function expression's parent call to decide whether it
  // crosses a host/dynamic method boundary; leaving `Parser.f(callback)` as
  // that parent would build a host callback for this exact static direct call.
  // Temporarily make the reused arguments lexical children of the synthetic
  // identifier call, then restore the source AST exactly after lowering.
  const argumentParents = expr.arguments.map((argument) => argument.parent);
  for (const argument of expr.arguments) {
    (argument as { parent?: ts.Node }).parent = synthetic;
  }
  try {
    return withRuntimeModuleCallableBindings(ctx, [{ declaration: memberDecl, handle: targetHandle }], () =>
      compileCallExpression(ctx, fctx, synthetic as ts.CallExpression),
    );
  } finally {
    for (let i = 0; i < expr.arguments.length; i++) {
      (expr.arguments[i] as { parent?: ts.Node }).parent = argumentParents[i];
    }
  }
}

function compileOptionalDirectCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult {
  const callee = expr.expression as ts.Identifier;
  const calleeType = compileExpression(ctx, fctx, callee);
  if (!calleeType) return null;

  if (calleeType.kind !== "ref" && calleeType.kind !== "ref_null" && calleeType.kind !== "externref") {
    fctx.body.push({ op: "drop" });
    const syntheticCall = ts.factory.createCallExpression(callee, expr.typeArguments, expr.arguments);
    ts.setTextRange(syntheticCall, expr);
    return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
  }

  const tmp = allocLocal(fctx, `__optdcall_${fctx.locals.length}`, calleeType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });

  let resultType: ValType = { kind: "externref" };
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      const resolved = resolveWasmType(ctx, retType);
      resultType = resolved.kind === "ref" ? { kind: "ref_null", typeIdx: resolved.typeIdx } : resolved;
    }
  }

  const savedBody = pushBody(fctx);
  const funcName = callee.text;
  const closureInfo = ctx.closureMap.get(funcName);
  const funcIdx = ctx.funcMap.get(funcName);
  let resolved = false;

  if (closureInfo && (calleeType.kind === "ref" || calleeType.kind === "ref_null")) {
    fctx.body.push({ op: "local.get", index: tmp });
    if (calleeType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
    const closureTmp = allocLocal(fctx, `__optdcall_cls_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: calleeType.typeIdx,
    });
    fctx.body.push({ op: "local.tee", index: closureTmp });
    fctx.body.push({ op: "local.get", index: closureTmp });
    for (const arg of expr.arguments) compileExpression(ctx, fctx, arg);
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
    resolved = true;
  } else if (funcIdx !== undefined) {
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    for (let i = 0; i < expr.arguments.length; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
    }
    if (paramTypes) {
      const optInfo = ctx.funcOptionalParams.get(funcName);
      for (let i = expr.arguments.length; i < paramTypes.length; i++) {
        const opt = optInfo?.find((o) => o.index === i);
        if (opt) {
          pushParamSentinel(fctx, paramTypes[i]!, ctx, opt);
        } else {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      }
      maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, paramTypes.length);
    }
    fctx.body.push({ op: "call", funcIdx });
    resolved = true;
  }

  if (!resolved) fctx.body.push(...defaultValueInstrs(resultType));

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
}

/**
 * Classify an eval call expression as `direct`, `indirect`, or `none`.
 *
 * Per ECMA-262 §19.2.1, a *direct* eval is a call whose callee is the
 * lexical Identifier `eval` (after stripping parentheses).  Anything that
 * forces a reference resolution detour — `(0, eval)(...)` or any other
 * non-Identifier callee that resolves to the eval function — is *indirect*.
 *
 * The compiler-side flag is forwarded to `__extern_eval` so the host shim
 * can preserve the spec-mandated scope distinction (#1164).  Direct eval
 * runs in the caller's lexical scope; indirect eval runs in global scope.
 *
 * Uses the TypeScript checker to verify that any `eval` identifier resolves
 * to the *global* eval, not a locally-shadowed variable or parameter named
 * `eval` (e.g. `function foo(eval) { return eval(42); }`).
 */
function classifyEvalCallExpression(expr: ts.CallExpression, checker: ts.TypeChecker): "direct" | "indirect" | "none" {
  if (expr.questionDotToken) return "none";
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee) && callee.text === "eval") {
    if (isGlobalEvalIdentifier(callee, checker)) return "direct";
    return "none";
  }
  // Indirect form: (0, eval)(src) — a comma expression whose right side is `eval`.
  if (
    ts.isBinaryExpression(callee) &&
    callee.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    ts.isIdentifier(callee.right) &&
    callee.right.text === "eval"
  ) {
    if (isGlobalEvalIdentifier(callee.right, checker)) return "indirect";
    return "none";
  }
  return "none";
}

/**
 * #1229 peephole — detect `eval("/" + X + "/")` and rewrite to `new RegExp(X)`.
 *
 * Test262's BMP-codepoint regex tests are 65k-iteration loops that build a
 * regex literal via eval per iteration:
 *
 * ```js
 * for (var cu = 0; cu <= 0xffff; ++cu) {
 *   var pattern = eval("/" + xx + "/");
 * }
 * ```
 *
 * Each `eval()` call on js2wasm pays the full TS-parse + js2wasm-codegen +
 * Wasm-instantiate pipeline (~50ms). 65,536 × 50ms = an hour of wall-clock,
 * so the test always hits the 30s pool ceiling. By detecting the literal-
 * fence shape `"/" + X + "/"` we can route directly to the RegExp
 * constructor path — same observable semantics for any code that
 * inspects `.source` / `.flags` / matching behavior, but ~one
 * host-call's worth of work instead of two.
 *
 * Returns:
 *   - `InnerResult` (with stack push of the constructed RegExp externref) on match
 *   - `undefined` if the AST shape doesn't match — caller falls through
 */
function tryEvalAsRegExpPeephole(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (expr.arguments.length !== 1) return undefined;

  // Strip parens around the argument.
  let arg = expr.arguments[0]!;
  while (ts.isParenthesizedExpression(arg)) arg = arg.expression;

  // Outer shape: BinaryExpression(`+`, BinaryExpression(`+`, "/", X), "/")
  // (left-associative `+`).
  if (!ts.isBinaryExpression(arg)) return undefined;
  if (arg.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  if (!ts.isStringLiteral(arg.right)) return undefined;
  if (arg.right.text !== "/") return undefined;

  let inner: ts.Expression = arg.left;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!ts.isBinaryExpression(inner)) return undefined;
  if (inner.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
  if (!ts.isStringLiteral(inner.left)) return undefined;
  if (inner.left.text !== "/") return undefined;

  const xExpr = inner.right;

  // The standalone lane has a Wasm-native RegExp carrier now. Route the exact
  // literal-fence shape through the native constructor instead of the
  // runtime-eval provider, whose foreign RegExp object cannot be reflected
  // through the standalone carrier (`pattern.source` became undefined in the
  // ES5 BMP escape tests). This preserves the peephole's one-evaluation
  // property while keeping the module host-free.
  if (ctx.standalone) {
    return compileStandaloneRegExpConstructor(ctx, fctx, [xExpr], expr) ?? undefined;
  }

  // Register `RegExp_new(pattern, flags) -> externref` on demand. The 7 target
  // tests (regexp/S7.8.5_*, comments/S7.4_A6, AnnexB/RegExp/RegExp-*-escape-BMP)
  // build their regex via eval *only* — they never write `new RegExp(...)` or a
  // `/.../` literal in source, so the pre-pass scan in `index.ts` does NOT
  // register `RegExp_new` and `ctx.externClasses` does NOT contain a `"RegExp"`
  // entry at this point. We mirror the on-demand registration pattern from
  // `compileRegExpLiteral` (`src/codegen/typeof-delete.ts:172-180`) so the
  // peephole works even when the source has no other RegExp use.
  //
  // Both the import AND a minimal externClasses entry are needed: the host
  // import resolver (`src/compiler/import-manifest.ts:46-51`) only routes
  // `RegExp_new` to the extern_class constructor when "RegExp" is in
  // `mod.externClasses`. Without that entry, the resolver falls through to
  // the "builtin" branch, which has no handler for `RegExp_new` and resolves
  // to a no-op that returns undefined — making the produced "regex" undefined
  // at runtime even though codegen looked correct.
  if (!ctx.externClasses.has("RegExp")) {
    ctx.externClasses.set("RegExp", {
      importPrefix: "RegExp",
      namespacePath: [],
      className: "RegExp",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }],
      methods: new Map(),
      properties: new Map(),
    });
  }
  let funcIdx = ctx.funcMap.get("RegExp_new");
  if (funcIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const regexpNewType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "RegExp_new", { kind: "func", typeIdx: regexpNewType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    funcIdx = ctx.funcMap.get("RegExp_new");
  }
  if (funcIdx === undefined) return undefined;

  // Argument 0: pattern source (X compiled to externref).
  compileExpression(ctx, fctx, xExpr, { kind: "externref" });
  // Argument 1: flags — empty string. The eval-of-regex shape is
  // `eval("/" + X + "/")` with no flag tail, so flags is always "".
  const emptyFlagsResult = compileStringLiteral(ctx, fctx, "", expr);
  if (!emptyFlagsResult) return undefined;
  const finalIdx = ctx.funcMap.get("RegExp_new") ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalIdx });
  return { kind: "externref" };
}

/** Returns true if the given `eval` identifier resolves to the global eval function (not a local shadow). */
function isGlobalEvalIdentifier(ident: ts.Identifier, checker: ts.TypeChecker): boolean {
  const sym = checker.getSymbolAtLocation(ident);
  if (!sym) return true; // unresolved → assume global eval
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  // Global eval is declared only in .d.ts files. A local shadow has at least one
  // declaration in a non-declaration (.ts) source file.
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * (#3145) True when `ident` refers to a GLOBAL builtin binding (declared only in
 * ambient .d.ts lib files) that is NOT shadowed by a local or captured variable
 * in the current function. Gates builtin-namespace call lowerings (e.g.
 * `Atomics.<m>(...)`) so a user `const Atomics = { … }` never hijacks the
 * fast path. Mirrors `isGlobalEvalIdentifier` with the extra local/capture
 * guard the namespace case needs.
 */
export function isGlobalBuiltinIdentifier(ctx: CodegenContext, fctx: FunctionContext, ident: ts.Identifier): boolean {
  if (fctx.localMap.has(ident.text)) return false;
  if (fctx.boxedCaptures?.has(ident.text)) return false;
  return isGlobalEvalIdentifier(ident, ctx.checker);
}

/**
 * (#2754) Eagerly register the funcref-wrapper closure types for every no-capture
 * `function` DECLARATION that is referenced as a VALUE (passed as an argument,
 * assigned, returned — anything other than a direct call/`new` callee) somewhere
 * in the source file.
 *
 * Why: the inline dynamic-dispatch path (`tryEmitInlineDynamicCall`) builds its
 * `ref.test`/`call_ref` arms from `ctx.closureInfoByTypeIdx` — the wrappers
 * registered SO FAR. A top-level function's wrapper is otherwise registered only
 * LAZILY, at the value site that references it (`emitFuncRefAsClosure`). When that
 * site lives in a later-compiled function (e.g. `main` calling
 * `runNmHost(denoRead, …)`) but the param is invoked from an earlier-compiled
 * body (`read(tmp)` inside `readFillExact`), the dispatch sees ZERO candidates and
 * silently lowers the call to `ref.null.extern` — the function value is never
 * invoked. Pre-registering the wrapper TYPE here (the trampoline is still emitted
 * lazily at the value site; `getOrCreateFuncRefWrapperTypes` is signature-cached,
 * so both sites share one type) makes the candidate visible regardless of compile
 * order.
 *
 * Idempotent (guarded by a per-module flag) and scoped to no-capture function
 * declarations actually used as values, so it is a no-op for programs without
 * function-valued declarations.
 */
export function ensureFuncValueWrappersRegistered(ctx: CodegenContext, sf: ts.SourceFile): void {
  const registrationState = ctx as unknown as {
    __funcValueWrapperSourcesRegistered?: Set<string>;
    __funcValueWrapperDiscoverySources?: Set<string>;
    __funcValueWrapperNamedDeclarations?: Set<ts.FunctionDeclaration>;
    __funcValueWrapperFunctionExpressions?: Set<ts.FunctionExpression | ts.ArrowFunction>;
  };
  const registeredSources =
    registrationState.__funcValueWrapperSourcesRegistered ??
    (registrationState.__funcValueWrapperSourcesRegistered = new Set<string>());
  if (registeredSources.has(sf.fileName)) return;
  registeredSources.add(sf.fileName);

  // Cross-source discovery is graph-global and purely syntactic. Cache its
  // result instead of walking the complete TypeScript compiler graph once per
  // source file. Registration below intentionally still runs per source: a
  // declaration can acquire its exact funcMap/capture ABI after an earlier
  // source's conservative registration, and getOrCreate is idempotent.
  const discoverySources =
    registrationState.__funcValueWrapperDiscoverySources ??
    (registrationState.__funcValueWrapperDiscoverySources = new Set<string>());
  const usedAsValue =
    registrationState.__funcValueWrapperNamedDeclarations ??
    (registrationState.__funcValueWrapperNamedDeclarations = new Set<ts.FunctionDeclaration>());
  const usedAsValueFunctions =
    registrationState.__funcValueWrapperFunctionExpressions ??
    (registrationState.__funcValueWrapperFunctionExpressions = new Set<ts.FunctionExpression | ts.ArrowFunction>());
  const observeMinimumArgumentCount = (
    wrapper: NonNullable<ReturnType<typeof getOrCreateFuncRefWrapperTypes>>,
    minimumArgumentCount: number,
  ): void => {
    const current = wrapper.closureInfo.minimumArgumentCount ?? wrapper.closureInfo.paramTypes.length;
    wrapper.closureInfo.minimumArgumentCount = Math.min(current, minimumArgumentCount);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isCallee = p && ts.isCallExpression(p) && p.expression === node;
      const isNewCallee = p && ts.isNewExpression(p) && p.expression === node;
      const isOwnName =
        p &&
        (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) &&
        (p as ts.FunctionLikeDeclaration).name === node;
      if (!isCallee && !isNewCallee && !isOwnName) {
        const sym = ctx.checker.getSymbolAtLocation(node);
        const decl = sym?.valueDeclaration;
        if (decl && ts.isFunctionDeclaration(decl) && decl.name) {
          usedAsValue.add(decl);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  const visitFns = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const p = node.parent;
      const isCallArg = p && ts.isCallExpression(p) && p.arguments.some((a) => a === node);
      const isVarInit = p && ts.isVariableDeclaration(p) && p.initializer === node;
      // A reassigned mutable callable is another dynamic-dispatch value
      // producer. Its call site may compile before the assignment RHS's
      // wrapper is materialized, so pre-register the same conservative
      // all-reference wrapper shape used for callback values.
      const isAssignmentValue =
        p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === node;
      // A generator function-expression's value is a Generator object, not a
      // plain closure the inline dispatcher marshals; skip (its wrapper type
      // is externref-returning and harmless, but leave it to the value site).
      const isGen = ts.isFunctionExpression(node) && node.asteriskToken !== undefined;
      if ((isCallArg || isVarInit || isAssignmentValue) && !isGen) usedAsValueFunctions.add(node);
    }
    ts.forEachChild(node, visitFns);
  };
  // The generic dispatcher can be compiled in an EARLIER source file than the
  // named callback values passed to it. TypeScript's scanner is the production
  // witness: scanner.ts emits `speculationHelper<T>(callback: () => T)` before
  // parser.ts passes nested `nextToken*`/`parse*` declarations through it.
  // Arrow pre-registration below already scans the complete callable program;
  // named declarations need the same order-independent visibility.
  for (const sourceFile of ctx.callableSourceFiles ?? [sf]) {
    if (discoverySources.has(sourceFile.fileName)) continue;
    discoverySources.add(sourceFile.fileName);
    visit(sourceFile);
    visitFns(sourceFile);
  }

  for (const declaration of usedAsValue) {
    const name = declaration.name!.text;
    const ownsMappedFunction =
      ctx.funcMapOwnerDecl.get(name) === declaration || ctx.topLevelFunctionDeclarations.get(name) === declaration;
    const captures = ownsMappedFunction ? ctx.nestedFuncCaptures.get(name) : undefined;
    const funcIdx = ownsMappedFunction ? ctx.funcMap.get(name) : undefined;

    // Preserve the value site's exact lowered ABI whenever this declaration
    // already owns a no-capture funcMap entry. In particular, rest/arguments
    // and generator lowering can add parameters that are not visible in the
    // source-level signature.
    if ((captures?.length ?? 0) === 0 && funcIdx !== undefined) {
      const sig = getFuncSignature(ctx, funcIdx);
      if (sig) {
        const wrapper = getOrCreateFuncRefWrapperTypes(ctx, sig.params, sig.results);
        if (wrapper && expectedArgumentCountOfParams(declaration.parameters) < sig.params.length) {
          observeMinimumArgumentCount(wrapper, expectedArgumentCountOfParams(declaration.parameters));
        }
        continue;
      }
    }

    // Captured or not-yet-registered nested declarations have no safe funcMap
    // signature to consult. Their lifted funcref still shares the root wrapper
    // signature computed from the declaration, but only pre-register the same
    // conservative all-externref shape used for function expressions below.
    // Numeric/mixed speculative candidates can make an over-arity dispatch arm
    // invalid even when that arm never matches at runtime.
    const { params, returnType } = computeClosureWrapperSig(ctx, declaration);
    const allExternref = params.every((p) => p.kind === "externref");
    const externrefOrVoidReturn = returnType === null || returnType.kind === "externref";
    const hasOmittableTrailingParams = expectedArgumentCountOfParams(declaration.parameters) < params.length;
    // A callback whose entire parameter ABI is externref can safely be
    // registered before its value site: omitted trailing parameters are
    // materialized as JavaScript `undefined` by the dynamic dispatcher below.
    // Register it early
    // so generic helpers such as TypeScript's `speculationHelper<T>(() => T)`
    // and `parseListElement<T>(() => T)` can discover later-compiled boolean
    // predicates and GC-reference parsers. The dynamic-call bridge preserves
    // the boolean brand or losslessly exports the GC ref when the generic
    // result carrier is externref.
    // Scalar erased returns remain zero-argument-only: widening that older
    // exception would admit speculative numeric signatures whose argument
    // bridges are not proven here.
    const safeErasedReturn =
      returnType !== null &&
      (params.length === 0
        ? returnType.kind === "ref" ||
          returnType.kind === "ref_null" ||
          (returnType.kind === "i32" && returnType.boolean === true) ||
          (returnType.kind === "f64" && returnType.undefSentinel !== true)
        : hasOmittableTrailingParams && (returnType.kind === "ref" || returnType.kind === "ref_null"));
    if (!allExternref || (!externrefOrVoidReturn && !safeErasedReturn)) continue;
    const wrapper = getOrCreateFuncRefWrapperTypes(ctx, params, returnType ? [returnType] : []);
    if (wrapper && hasOmittableTrailingParams) {
      observeMinimumArgumentCount(wrapper, expectedArgumentCountOfParams(declaration.parameters));
    }
  }

  // (#2939) Nested-scope function-expression / arrow callbacks. A callback like
  // `testWith*Constructors(function (TA) { … })` defined INSIDE another function
  // (e.g. the test262 runner's `export function test()` wrapper) registers its
  // funcref-wrapper type only LAZILY when its value site compiles — which is
  // inside a body compiled AFTER the higher-order function whose `fn(...)`
  // dispatch needs the candidate. So the dispatch (`tryEmitInlineDynamicCall`)
  // saw ZERO candidates and silently dropped the call — the ~814 vacuous
  // `testWith*Constructors` harness passes (round-4 leak analysis). Pre-register
  // the SAME wrapper type (computeClosureWrapperSig ≡ the value-site logic;
  // getOrCreateFuncRefWrapperTypes is signature-cached, so the value site reuses
  // it — a capturing callback's custom subtype still shares this funcTypeIdx,
  // which is what the dispatch discriminates on) for every func-expr / arrow used
  // as a call argument or a variable initializer.
  //
  // (#3074) Applied on BOTH lanes. It was originally standalone-gated for
  // byte-inertness on the gc/host lane, but that left the DEFAULT lane's
  // harness-wrapper cluster (`testWith*TypedArrayConstructors(function(TA){…})`)
  // stuck vacuous — measured at 1,535 default records vs 448 standalone, i.e.
  // the LARGER cluster (#3074). Empirically the harness callback compiles to a
  // real closure struct on the gc lane too (`ref.func …; struct.new $__fn_wrap_*;
  // extern.convert_any` — verified via WAT), so the runtime value flowing into
  // the higher-order body IS a wrapper struct that `tryEmitInlineDynamicCall`
  // dispatches correctly; the ONLY reason the gc lane dropped the call was the
  // compile-order candidate gap this pre-registration closes (identical to the
  // declaration loop above, which already runs un-gated on both lanes).
  //
  // Safety on the gc lane (the two reasons for the old gate, both addressed):
  //  1. Byte change on the default lane — intended: #3074 wants the gc lane
  //     fixed, and the affected tests are ALL currently VACUOUS FAILS
  //     (`return -262`), so dispatch can only move them fail→pass or stay fail
  //     (never a pass→fail regression). The caller's only alternative to a
  //     successful inline dispatch is the graceful `ref.null.extern` drop, so
  //     enabling dispatch is a strict improvement.
  //  2. A callback that instead takes the `__make_callback` host path (passed
  //     to a host builtin, e.g. `arr.map(cb)`) never materializes a wrapper
  //     STRUCT — only the wrapper TYPE is pre-registered here (the trampoline /
  //     struct.new stays lazy at the value site). So an extra dispatch arm for
  //     that signature never `ref.test`-matches the JS-function externref at
  //     runtime → falls through to the default → same drop as before. No
  //     behavior change for `__make_callback` callbacks, only the harness /
  //     compiled-HOF callbacks gain dispatch. `getOrCreateFuncRefWrapperTypes`
  //     is signature-cached, so the value site reuses the same funcTypeIdx —
  //     no index inconsistency (the declaration loop already relies on this).
  {
    const usedAsValueFn = (node: ts.FunctionExpression | ts.ArrowFunction): void => {
      const { params, returnType } = computeClosureWrapperSig(ctx, node);
      // (#2939) Restrict pre-registration to the ALL-EXTERNREF callback shape
      // (externref params + externref/void return). This is exactly the harness
      // callback shape (`function(TA, makeCtorArg)` — `any` params) — the whole
      // ~1421-test target population. A candidate with a NUMERIC (f64/i32) param
      // in an OVER-ARITY position mints a malformed dispatch arm in the
      // higher-order body (`call[0] expected externref, found f64…`) — the
      // over-arity numeric-pad + box path in `tryEmitInlineDynamicCall` is not
      // sound for a speculatively-registered candidate that never matches a real
      // runtime value. Numeric-mixed nested callbacks stay lazily-registered
      // (unchanged from base — they were never candidates), so this both fixes
      // the invalid-Wasm CE and keeps the fix's blast radius to the harness
      // class. (Inner numeric-param callbacks like `findLastIndex(fn)` dispatch
      // via the array-method path, never this inline dispatcher.)
      const allExternref = params.every((p) => p.kind === "externref");
      const externrefOrVoidReturn = returnType === null || returnType.kind === "externref";
      const hasOmittableTrailingParams = expectedArgumentCountOfParams(node.parameters) < params.length;
      const safeErasedReturn =
        returnType !== null &&
        (params.length === 0
          ? returnType.kind === "ref" ||
            returnType.kind === "ref_null" ||
            (returnType.kind === "i32" && returnType.boolean === true) ||
            (returnType.kind === "f64" && returnType.undefSentinel !== true)
          : hasOmittableTrailingParams && (returnType.kind === "ref" || returnType.kind === "ref_null"));
      if (!allExternref || (!externrefOrVoidReturn && !safeErasedReturn)) return;
      const wrapper = getOrCreateFuncRefWrapperTypes(ctx, params, returnType ? [returnType] : []);
      if (wrapper && hasOmittableTrailingParams) {
        observeMinimumArgumentCount(wrapper, expectedArgumentCountOfParams(node.parameters));
      }
    };
    for (const node of usedAsValueFunctions) usedAsValueFn(node);
  }
}

/**
 * #1063 Part B: inline dynamic-dispatch for an identifier callee whose static
 * type is `any` (externref) but which may hold a wrapped closure struct at
 * runtime (e.g. `function outer(op: any) { return function (x) { return op(x); } }`).
 *
 * Emits a `ref.test`/`ref.cast`/`struct.get`/`call_ref` chain against every
 * closure struct type in the module whose arity can satisfy the call's arg
 * count. Mirrors `emitClosureCallExport` (__call_fn_0) but specialized to
 * arity N with inline arg marshalling.
 *
 * (#820 / #1543) Two correctness fixes vs. the original exact-arity form:
 *
 *  1. **Discriminate by funcref signature, not struct type.** All
 *     `__fn_wrap_*` closure structs subtype a single *root* wrapper struct
 *     (`getOrCreateFuncRefWrapperTypes` chains every later signature under
 *     the first one created). So `ref.test (ref <some-wrapper-struct>)`
 *     matches wrapper values of *every* arity, not just the candidate's.
 *     A 0-arg call to an extracted 1-formal async-generator method then
 *     matched the arity-0 root arm, did `struct.get 0` + `ref.cast (ref
 *     <arity-0 funcType>)` on an arity-1 funcref, and trapped with `illegal
 *     cast` — the entire `async-gen-meth-dflt-*` test262 cluster. We instead
 *     test the *funcref* (`ref.test (ref funcTypeIdx)`), which encodes the
 *     exact param count + result, so each arm fires only for its own
 *     signature regardless of struct subtyping.
 *
 *  2. **Adapt arity by padding missing trailing args with `undefined`.**
 *     A candidate whose formal-param count is *greater than* the call arity
 *     is now eligible (ES calls a function with fewer args than formals,
 *     filling the rest with `undefined`). Without this a 0-arg call to a
 *     1-formal method found no candidate and silently returned `undefined`
 *     instead of invoking the method (which must apply its default param and
 *     run the destructure / initializer the spec mandates).
 *
 * Returns `{ kind: "externref" }` on success, or `null` to let the caller
 * fall back to the existing `ref.null.extern` behavior.
 */
/**
 * (#3166) Resolve the receiver of an element-access expression to a
 * user-defined class name (present in `ctx.classSet`, incl. class expressions
 * aliased via `classExprNameMap`), or `undefined`. Uses the type oracle
 * (#1930) rather than a raw checker query.
 */
function elemAccessReceiverClassName(ctx: CodegenContext, elemAccess: ts.ElementAccessExpression): string | undefined {
  let name = ctx.oracle.declaredNameOf(elemAccess.expression);
  if (name && !ctx.classSet.has(name)) name = ctx.classExprNameMap.get(name) ?? name;
  return name && ctx.classSet.has(name) ? name : undefined;
}

/**
 * (#3166) True when the element-access receiver resolves to a user-class
 * instance. Gates the field-closure dynamic-call route so primitive / array /
 * host receivers keep their existing lowering.
 */
export function elemAccessReceiverIsUserClass(ctx: CodegenContext, elemAccess: ts.ElementAccessExpression): boolean {
  return elemAccessReceiverClassName(ctx, elemAccess) !== undefined;
}

/**
 * (#4252) True when the element-access receiver is an ORDINARY OBJECT — an
 * object literal or an object-typed binding — as opposed to an array, a
 * primitive, a builtin, a function or a user class.
 *
 * Gates the plain-object arm of the runtime-key call dispatch in
 * `call-tail-dispatch.ts`. `TypeFact.kind === "object"` is exactly the
 * discrimination wanted: `array`/`tuple` receivers already have a working
 * element-call lowering, `string`/`number`/`boolean` receivers must keep their
 * primitive method paths, `builtin`/`function`/`class` are handled by their own
 * arms (`class` by `elemAccessReceiverIsUserClass` immediately above), and the
 * deliberately-excluded `any`/`unknown`/`unresolvable` are NOT admitted — an
 * unresolvable receiver could be anything, so widening the dispatch there would
 * perturb receivers that compile correctly today.
 *
 * Oracle-based (#1930/#3273): a `TypeFact` tri-state, no `ts.Type` escapes.
 */
export function elemAccessReceiverIsPlainObject(ctx: CodegenContext, elemAccess: ts.ElementAccessExpression): boolean {
  return ctx.oracle.typeFactOf(elemAccess.expression).kind === "object";
}

/**
 * (#3166) True when the receiver class of an element access declares a struct
 * field named `fieldName`. A computed-name class field (`[1+1] = …`) lands here
 * under its ToPropertyKey-canonicalised name ("2"); distinguishes a
 * field-holding-closure from a prototype method for the static-key call route.
 */
export function classInstanceHasField(
  ctx: CodegenContext,
  elemAccess: ts.ElementAccessExpression,
  fieldName: string,
): boolean {
  const name = elemAccessReceiverClassName(ctx, elemAccess);
  if (!name) return false;
  const fields = ctx.structFields.get(name);
  return !!fields && fields.some((f) => f.name === fieldName);
}

function buildDynamicApplyFallback(
  fctx: FunctionContext,
  fallback: { applyIdx: number; vecNewIdx: number; vecPushIdx: number },
  argLocals: readonly number[],
  anyLocal: number,
  undefinedIdx: number | undefined,
  undefinedSingletonPad: readonly Instr[] | undefined,
): Instr[] {
  const argsLocal = allocLocal(fctx, `__dyn_apply_args_${fctx.locals.length}`, { kind: "externref" });
  const body: Instr[] = [
    { op: "call", funcIdx: fallback.vecNewIdx },
    { op: "local.set", index: argsLocal },
  ];
  for (const argLocal of argLocals) {
    body.push({ op: "local.get", index: argsLocal });
    body.push({ op: "local.get", index: argLocal });
    body.push({ op: "call", funcIdx: fallback.vecPushIdx });
  }
  body.push({ op: "local.get", index: anyLocal });
  body.push({ op: "extern.convert_any" });
  pushDynamicUndefinedExternref(body, undefinedIdx, undefinedSingletonPad);
  body.push({ op: "local.get", index: argsLocal });
  body.push({ op: "call", funcIdx: fallback.applyIdx });
  return body;
}

function pushDynamicUndefinedExternref(
  body: Instr[],
  undefinedIdx: number | undefined,
  singleton: readonly Instr[] | undefined,
): void {
  if (undefinedIdx !== undefined) {
    body.push({ op: "call", funcIdx: undefinedIdx });
  } else if (singleton !== undefined) {
    for (const ins of singleton) body.push({ ...ins });
  } else {
    body.push({ op: "ref.null.extern" });
  }
}

function reserveDynamicApplyFallback(ctx: CodegenContext): {
  applyIdx: number;
  vecNewIdx: number;
  vecPushIdx: number;
} {
  const vecBuilders = ensureObjVecBuilders(ctx);
  return {
    applyIdx: reserveApplyClosure(ctx),
    vecNewIdx: vecBuilders.newIdx,
    vecPushIdx: vecBuilders.pushIdx,
  };
}

export function tryEmitInlineDynamicCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  isKnownVariable: boolean,
  allowHostBoundaryFallback = true,
): InnerResult | null {
  if (!isKnownVariable) return null;

  // (#2754) A call on an `any`-typed value (e.g. a callable PARAMETER whose
  // type annotation was stripped by a `bun build` / esbuild transpile) reaches
  // this dynamic-dispatch path. The dispatch is built from the funcref-wrapper
  // closure types registered SO FAR (`ctx.closureInfoByTypeIdx`). But a top-level
  // `function foo(){…}` only gets its wrapper registered LAZILY at the value site
  // that references it as a value (`runNmHost(denoRead, …)`), which is often a
  // LATER-compiled function (e.g. `main`). So when an earlier-compiled body calls
  // the param (`read(tmp)`), there are ZERO candidates and the call silently
  // lowers to `ref.null.extern` — the value is never invoked (the #2754 zero-
  // output Native-Messaging miscompile; the typed `.ts` path is unaffected because
  // a typed funcref param emits a direct `call_ref`). Eagerly register the
  // funcref wrappers for every no-capture function declaration referenced as a
  // value so the dispatch sees them regardless of compile order. Idempotent +
  // gated on a flag, so it runs once per module; a no-op for programs with no
  // function-valued declarations (byte-neutral on the typed corpus).
  ensureFuncValueWrappersRegistered(ctx, expr.getSourceFile());

  const arity = expr.arguments.length;
  const hostCallPlan = planHostCallFallback(arity, ctx.targetProfile.semanticProviders === "native-first");

  // Pre-filter candidates: formal-param count must be able to satisfy the
  // call arity (>= arity — missing trailing args are padded with `undefined`,
  // see #820/#1543), and all param/return types supported by inline
  // marshalling (f64 / i32 / externref / ref / ref_null).
  type Cand = { structTypeIdx: number; info: ClosureInfo };
  const supported = (t: ValType | null): boolean => {
    if (t === null) return true;
    return t.kind === "f64" || t.kind === "i32" || t.kind === "externref" || t.kind === "ref" || t.kind === "ref_null";
  };

  const allCandidates: Cand[] = [];
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    // (#2923) JS §7.3.14: a call whose arg count differs from the callee's
    // declared param count still INVOKES the callee — extra args are ignored,
    // missing params are `undefined`. The per-candidate dispatch arm below
    // already honours this: it marshals exactly `info.paramTypes.length`
    // formals (pulling `argLocals[i]` for `i < arity`, padding `undefined` for
    // `i >= arity`), so an UNDER-arity candidate (fewer params than args)
    // simply drops the extra args, and an OVER-arity candidate pads. Every
    // call-site arg is still evaluated into a temp local above, so a truncated
    // extra arg keeps its side effects. The old `paramTypes.length < arity`
    // hard filter therefore SILENTLY DROPPED an entire class of higher-order
    // calls (the test262 `testWith*TypedArrayConstructors(fn)` harness calls
    // `fn(ctor, makeCtorArg)` — 2 args — but the callback declares `(TA)` — 1
    // param — so the whole test body was dead; 468+ BigInt tests). Removing it
    // adopts the JS arity semantics the direct-closure path (`compileClosureCall`
    // L122-129) already implements.
    //
    // (#1837) Over-arity padding was gated to NON-VOID results: the June-21
    // arm emitter produced a stack-invalid `call_ref` ("not enough arguments
    // on the stack") for padded void candidates — 52 merge_group regressions
    // in Promise/{all,race,any,allSettled} + TypedArray internals. The arm
    // construction has since been reworked (#3031 dynamic-apply, #2611 flush,
    // #2923) and now marshals exactly `paramTypes.length` formals with typed
    // pads plus a `ref.null.extern` block result for void returns — stack-
    // valid for void candidates too.
    //
    // (#3128) Narrowly re-admit over-arity VOID candidates whose padded
    // formals are all externref (`undefined` pad is exact). This is the
    // Promise settle-closure shape: a 0-arg `resolve()` inside a
    // `new Promise(function(resolve){ resolve(); })` executor must dispatch
    // the canonical `(externref) -> ()` settle wrapper with an undefined pad
    // (§7.3.14 missing args are `undefined`) — the gate made the call a
    // silent no-op, so the promise never settled (resolve-settled-*-self).
    // Void candidates needing a non-externref pad stay excluded
    // (conservative: their pad values are NaN/0/typed-null guesses).
    // (#4616) A rest-param closure's trailing formal is the packed rest VEC,
    // not a positional param: its effective fixed-formal count excludes it.
    // Mirror the generic `__call_fn_N` dispatcher (closure-exports.ts): only
    // admit a rest candidate when the call supplies at least every fixed
    // formal (fewer → conservative skip, same as `hostArity > arity` there).
    const infoIsRest = info.hasRestParam === true && info.paramTypes.length > 0;
    const infoFixedCount = infoIsRest ? info.paramTypes.length - 1 : info.paramTypes.length;
    if (infoIsRest && arity < infoFixedCount) continue;
    if (!infoIsRest && info.paramTypes.length > arity && info.returnType === null) {
      let padsAllExternref = true;
      for (let i = arity; i < info.paramTypes.length; i++) {
        if (info.paramTypes[i]!.kind !== "externref") {
          padsAllExternref = false;
          break;
        }
      }
      if (!padsAllExternref) continue;
    }
    if (!supported(info.returnType)) continue;
    let ok = true;
    for (const p of info.paramTypes) {
      if (!supported(p)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    allCandidates.push({ structTypeIdx: typeIdx, info });
  }

  // (#3031) Standalone Proxy [[Call]] arm gate — §0.1 ladder step 1: a Proxy
  // must intercept everything, including a dynamic call of the proxy value
  // itself (`p(...)`). Armed when the module can contain a live `$Proxy`:
  // `__proxy_create` already registered (an earlier-compiled / cross-file
  // `new Proxy`) OR this source file syntactically creates one (a call site can
  // compile BEFORE the same file's `new Proxy` site, so funcMap presence alone
  // misses the registration-order case — the #2754 class). Proxy-free programs
  // never grow the arm (byte-identical, the #2175 S0 discipline). Host lane is
  // untouched: a host proxy is a host externref whose [[Call]] belongs to the
  // K1 inbound-marshalling keystone, not this dispatch.
  const wantProxyArm =
    (ctx.standalone === true || ctx.targetProfile.semanticProviders === "native-first") &&
    (ctx.funcMap.has("__proxy_create") || sourceCreatesProxy(expr.getSourceFile()));
  // (#3140) A `$__bound_fn` (native Function.prototype.bind carrier) may reach a
  // bare dynamic call (`bound(...)`) — add an unwrap arm when a bind site minted
  // the carrier in this module.
  const wantBoundArm =
    usesNativeFunctionBindProvider(ctx) && (ctx.boundFnTypeIdx >= 0 || sourceHasBindCall(expr.getSourceFile()));
  // (#3177 slice 3) §23.2.5.1 step 1: CALLING a TypedArray-constructor VALUE
  // without `new` (undefined NewTarget) must throw TypeError — `TA(1)` inside
  // `assert.throws(TypeError, …)` is the undefined-newtarget-throws corpus
  // shape. Armed only when a `$__ta_ctor` value can exist in the module
  // (byte-inert otherwise). Standalone/WASI lane; the host lane's callee is a
  // real host constructor whose [[Call]] already throws.
  const wantTaCtorArm =
    (ctx.standalone === true || ctx.wasi === true) &&
    (ctx.taCtorTypeIdx >= 0 || ctx.builtinObjectGlobals.has("ctor:Int8Array"));
  const wantApplyFallback = ctx.standalone === true || ctx.wasi === true;
  if (allCandidates.length === 0 && !wantProxyArm && !wantBoundArm && !wantTaCtorArm && !wantApplyFallback) return null;

  // Dedupe by funcTypeIdx — concrete subtypes share funcTypeIdx with their
  // base wrapper; one dispatch arm per unique funcref type is enough.
  // (#4616) EXCEPT rest-param candidates: a rest closure's funcref signature
  // is identical to a genuine one-vec-param closure's (`function spy(...args)`
  // vs `function g(xs: any[])`), so rest candidates keep their own arms —
  // guarded by their CONCRETE struct type, not just the funcref signature —
  // and are emitted after the positional arms below so they are tested FIRST
  // (each later arm wraps the previous dispatch chain).
  const seenFuncType = new Set<number>();
  const seenRestStruct = new Set<number>();
  const candidates: Cand[] = [];
  const restCandidates: Cand[] = [];
  for (const c of allCandidates) {
    if (c.info.hasRestParam === true && c.info.paramTypes.length > 0) {
      if (seenRestStruct.has(c.structTypeIdx)) continue;
      seenRestStruct.add(c.structTypeIdx);
      restCandidates.push(c);
      continue;
    }
    if (seenFuncType.has(c.info.funcTypeIdx)) continue;
    seenFuncType.add(c.info.funcTypeIdx);
    candidates.push(c);
  }
  // Emit exact-arity arms first (most-specific), then padded over-arity arms,
  // so a value that satisfies an exact wrapper takes that arm before a
  // wider, undefined-padded one.
  candidates.sort((a, b) => a.info.paramTypes.length - arity - (b.info.paramTypes.length - arity));
  // (#4616) Rest arms last in emission order = OUTERMOST at runtime, so a
  // rest-struct value takes the rest arm before the same-signature positional
  // arm can mis-cast its first arg to the vec type.
  candidates.push(...restCandidates);

  // Dynamic callers save every argument as externref, while a selected
  // closure may expose a concrete vec formal. Reserve the generic cross-rep
  // materializers before capturing any helper indices below: a caller-owned
  // array/vec is a valid JavaScript argument even when its allocation type is
  // not the callee's exact inferred vec type.
  for (const candidate of candidates) {
    for (const paramType of candidate.info.paramTypes) {
      if (paramType.kind === "ref" || paramType.kind === "ref_null") {
        buildVecFromExternMaterializer(ctx, paramType.typeIdx);
      }
    }
  }

  // Ensure box/unbox helpers exist (standalone: registered as native defined
  // functions, no import; host: late imports). Their indices are captured AFTER
  // the flush below — capturing them here, BEFORE a real import insertion (the
  // `__get_undefined` pad import), left the captured locals stale-low by the
  // insertion count while `flushLateImportShifts` repaired only `funcMap` and
  // already-emitted bodies. Every dispatch arm then baked `call <box-1>` — the
  // adjacent string-to-number native instead of the box helper — and the
  // module failed validation ("call[0] expected externref, found call_ref
  // of type f64"; the #3031 dynamic-apply invalid-module class).
  const UNBOX_NUMBER = "__unbox_number";
  addUnionImports(ctx);
  if (ensureLateImport(ctx, UNBOX_NUMBER, [{ kind: "externref" }], [{ kind: "f64" }]) === undefined) {
    return null;
  }
  // (#3335) Host-lane default arm dependencies (see the dispatch default
  // below): ensure the imports HERE, before the box/unbox indices are
  // captured, so the capture happens after every import insertion this
  // function performs (the stale-capture hazard the note above describes).
  const needsProvidedUndefinedCheck = candidates.some((candidate) => {
    const fixedCount =
      candidate.info.hasRestParam === true && candidate.info.paramTypes.length > 0
        ? candidate.info.paramTypes.length - 1
        : candidate.info.paramTypes.length;
    return candidate.info.paramTypes
      .slice(0, Math.min(arity, fixedCount))
      .some((paramType) => paramType.kind === "f64" || paramType.kind === "ref_null");
  });
  // Explicit `undefined` is just as observable as an omitted argument. A
  // dynamic caller stores every provided value as externref, so scalar/default
  // and nullable-reference formals must classify that value before unboxing or
  // casting it. This is required even when the host-call fallback is disabled:
  // the exact Wasm-closure arm still needs to deliver the f64 undefined
  // sentinel / typed-null default marker. Native-first targets route this name
  // to the in-Wasm object runtime, so the check does not create a host import.
  if (needsProvidedUndefinedCheck || (!ctx.standalone && !ctx.wasi && allowHostBoundaryFallback)) {
    ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  }
  if (!ctx.standalone && !ctx.wasi && allowHostBoundaryFallback) {
    ensureHostCallFallbackImports(ctx, hostCallPlan);
  }
  const needsHostFacadeUnwrap =
    ctx.targetProfile.environment === "javascript" &&
    candidates.some((candidate) =>
      candidate.info.paramTypes.some(
        (param) => param.kind === "externref" || param.kind === "ref" || param.kind === "ref_null",
      ),
    );
  if (needsHostFacadeUnwrap) {
    ensureLateImport(ctx, "__unwrap_for_wasm", [{ kind: "externref" }], [{ kind: "externref" }]);
  }

  // (#820/#1543) `undefined` externref source for padding missing trailing
  // args (call arity < a candidate's formal count), and (#3031) for the Proxy
  // arm's `thisArgument` (a bare `p(...)` call has `this = undefined`). Host
  // mode pulls it from `__get_undefined`; standalone / native-strings MUST NOT
  // add that env import (it made the module un-instantiable host-free — the
  // #3031 leak): `ensureGetUndefined` gates the import exactly like
  // `emitUndefined`, and the standalone representation is the (#2106 S1)
  // $undefined singleton when active, else `ref.null.extern` (a wasm method's
  // `__extern_is_undefined` default-param guard treats host `undefined` and a
  // null externref alike).
  const maxFormals = candidates.reduce((m, c) => Math.max(m, c.info.paramTypes.length), 0);
  const needsUndefinedPad = maxFormals > arity;
  const needsUndefined =
    needsUndefinedPad ||
    wantProxyArm ||
    wantApplyFallback ||
    (!ctx.standalone && !ctx.wasi && allowHostBoundaryFallback);
  const undefinedIdx = needsUndefined ? ensureGetUndefined(ctx) : undefined;
  const undefinedSingletonPad = needsUndefined && undefinedIdx === undefined ? undefinedExternInstrs(ctx) : undefined;
  // (#2611) Flush the deferred late-import shift NOW — every other late-import
  // call site in this file flushes after the add, but this one historically did
  // not, leaving `ctx.pendingLateImportShift` dangling. `ensureLateImport`
  // inserts the import at index `numImportFuncs` and defers the shift; until it
  // is flushed, the funcMap entries + bodies of functions registered BEFORE the
  // import stay stale-low while functions registered AFTER (e.g. `__module_init`,
  // whose funcIdx is recomputed from the post-import `numImportFuncs`) are already
  // correct. A flush left this late is then HALF-applied: shifting it at finalize
  // re-bumps the already-correct post-import indices (`startFuncIdx` → invalid
  // start function), while NOT flushing at all leaves the pre-import native
  // runtime helpers (`__extern_length`/`__extern_get_idx`/…) stale, so a
  // finalize reserve-then-fill resolves `funcMap.get(name) - numImportFuncs` to
  // the WRONG `mod.functions[]` slot and corrupts that body ("local index out of
  // range … #2043 class"). Flushing immediately — before any further function is
  // registered — repairs only the genuinely-stale pre-import indices and keeps
  // the index space self-consistent through the rest of compilation. Idempotent
  // no-op when nothing is pending. This site (`tryEmitInlineDynamicCall` ->
  // `__get_undefined` for the arity-pad path) is the one async-generator /
  // destructuring-param trigger that reaches here, but the flush is correct for
  // every path. (Mirrors `emitUndefined`, which already flushes after the same
  // `ensureGetUndefined` add.)
  flushLateImportShifts(ctx, fctx);
  // Capture the helper indices AFTER the flush: the flush re-bases `funcMap`
  // for defined functions, so these are the settled, final indices (see the
  // stale-capture note above).
  let boxNumberIdx = ctx.funcMap.get("__box_number");
  let unboxNumberIdx = ctx.funcMap.get(UNBOX_NUMBER);
  let isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  let unwrapForWasmIdx = ctx.funcMap.get("__unwrap_for_wasm");
  if (
    boxNumberIdx === undefined ||
    unboxNumberIdx === undefined ||
    (needsHostFacadeUnwrap && unwrapForWasmIdx === undefined)
  )
    return null;

  // (#3031) Materialize the Proxy [[Call]] pieces while the gate is live. The
  // object/proxy runtime registers DEFINED functions only (no import → no index
  // shift), so this is safe after the flush + captures above.
  let proxyArm: { proxyTypeIdx: number; dispatchIdx: number; vecNewIdx: number; vecPushIdx: number } | undefined;
  if (wantProxyArm) {
    const vecBuilders = ensureObjVecBuilders(ctx);
    const dispatchIdx = ctx.funcMap.get("__proxy_apply_dispatch");
    const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
    if (dispatchIdx !== undefined && proxyTypeIdx !== undefined) {
      proxyArm = { proxyTypeIdx, dispatchIdx, vecNewIdx: vecBuilders.newIdx, vecPushIdx: vecBuilders.pushIdx };
    }
  }
  // (#3140) Bound-function [[Call]] arm pieces — same DEFINED-only invariant as
  // the proxy pieces above (reserveApplyClosure mints a defined placeholder).
  let boundArm: { bfTypeIdx: number; applyIdx: number; vecNewIdx: number; vecPushIdx: number } | undefined;
  if (wantBoundArm) {
    const vecBuilders = ensureObjVecBuilders(ctx);
    const applyIdx = reserveApplyClosure(ctx);
    boundArm = {
      // Register on demand — the bind SITE may compile after this call site
      // (the pre-scan `sourceHasBindCall` covers that order).
      bfTypeIdx: getOrRegisterBoundFnType(ctx),
      applyIdx,
      vecNewIdx: vecBuilders.newIdx,
      vecPushIdx: vecBuilders.pushIdx,
    };
  }
  let applyFallback = wantApplyFallback ? reserveDynamicApplyFallback(ctx) : undefined;
  // (#2933) Variadic builtin value-closure arm pieces. Set at Math.max/Math.min
  // value-read time (all of its types + the closure func are then already
  // registered — DEFINED funcs only, no import, no index shift). One lifted
  // func type `(self, (ref null $vec_externref)) -> externref` serves BOTH
  // methods and EVERY call-site arity (the arm packs the saved arg locals into
  // a fresh vec). Modules without such a value read are byte-identical.
  const variadicArm = ctx.standalone || ctx.wasi ? ctx.variadicBuiltinClosure : undefined;
  if (variadicArm !== undefined) {
    // The variadic closure registers in `closureInfoByTypeIdx` like any other
    // wrapper signature, so the generic candidate scan can pick it up — but its
    // single `(ref null $vec_externref)` formal must NOT be marshalled like a
    // positional param (the generic arm would `ref.cast` the first ARG to the
    // vec type → illegal cast, and its funcref test would shadow the dedicated
    // variadic arm below). It is served exclusively by the dedicated arm.
    for (let ci = candidates.length - 1; ci >= 0; ci--) {
      if (candidates[ci]!.info.funcTypeIdx === variadicArm.funcTypeIdx) candidates.splice(ci, 1);
    }
  }

  if (
    candidates.length === 0 &&
    proxyArm === undefined &&
    boundArm === undefined &&
    applyFallback === undefined &&
    variadicArm === undefined &&
    !wantTaCtorArm
  )
    return null;

  // Compile callee (externref) → anyref → temp local.
  const calleeType = compileExpression(ctx, fctx, expr.expression);
  if (calleeType === null) return null;
  // If already a ref type, skip the extern→any convert; otherwise expect externref.
  if (calleeType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (calleeType.kind !== "ref" && calleeType.kind !== "ref_null") {
    // Unexpected stack type — bail, the existing fallback will run.
    fctx.body.push({ op: "drop" });
    return null;
  }
  const anyLocal = allocLocal(fctx, `__dyn_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // Compile each argument to externref and stash in a temp local so each
  // dispatch arm can marshal it independently without re-evaluating.
  const argLocals: number[] = [];
  for (let i = 0; i < arity; i++) {
    // A dynamic native call is still an internal JavaScript-value boundary.
    // In particular, Deno invokes the captured `Object.assign` primordial
    // through this path. Materialize plain object literals as open `$Object`
    // carriers so the selected callable can enumerate and mutate them rather
    // than receiving an opaque boxed closed struct.
    compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
    const argLocal = allocLocal(fctx, `__dyn_arg${i}_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: argLocal });
    argLocals.push(argLocal);
  }

  // Compiling the callee/arguments above can itself add late imports —
  // `new Function("…")()` as the CALLEE routes through
  // `emitStandaloneDynamicFunctionRuntime` → `ensureLateImport(
  // "__runtime_new_function")` + flush — which shifts every defined-function
  // index AFTER the captures above. The flush repairs `funcMap` and bodies
  // already attached to a tracked FunctionContext, but the captured LOCALS
  // stay stale-low, so every dispatch arm baked `call <box-1>` — the adjacent
  // `__str_to_number` native instead of `__box_number` — and the module failed
  // validation ("call[0] expected type externref, found call_ref of type
  // f64"; test262 harness/wellKnownIntrinsicObjects.js standalone). This is
  // the same stale-capture class the ensure-before-capture block above fixed
  // for this function's OWN import insertions; the callee/argument compile was
  // the remaining insertion point. Flush (idempotent) and re-capture, and
  // re-materialize the arm pieces whose funcIdxs were captured pre-callee
  // (all reserve*/ensure* here are funcMap-backed and idempotent).
  flushLateImportShifts(ctx, fctx);
  boxNumberIdx = ctx.funcMap.get("__box_number");
  unboxNumberIdx = ctx.funcMap.get(UNBOX_NUMBER);
  isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  unwrapForWasmIdx = ctx.funcMap.get("__unwrap_for_wasm");
  if (
    boxNumberIdx === undefined ||
    unboxNumberIdx === undefined ||
    (needsHostFacadeUnwrap && unwrapForWasmIdx === undefined)
  ) {
    // The helpers existed at the first capture; funcMap entries are shifted,
    // never removed, so this cannot happen — bail defensively if it ever does
    // (callee/args are all consumed into locals, the stack is empty here).
    return null;
  }
  if (proxyArm !== undefined) {
    const dispatchIdx = ctx.funcMap.get("__proxy_apply_dispatch");
    const vecBuilders = ensureObjVecBuilders(ctx);
    if (dispatchIdx !== undefined) {
      proxyArm = { ...proxyArm, dispatchIdx, vecNewIdx: vecBuilders.newIdx, vecPushIdx: vecBuilders.pushIdx };
    }
  }
  if (boundArm !== undefined) {
    const vecBuilders = ensureObjVecBuilders(ctx);
    boundArm = {
      ...boundArm,
      applyIdx: reserveApplyClosure(ctx),
      vecNewIdx: vecBuilders.newIdx,
      vecPushIdx: vecBuilders.pushIdx,
    };
  }
  if (applyFallback !== undefined) applyFallback = reserveDynamicApplyFallback(ctx);

  // Build dispatch chain (innermost = default, outermost = first).
  // Default: ref.null.extern (matches existing fallback semantics).
  let dispatch: Instr[] = [{ op: "ref.null.extern" }];

  // Finalize-time default; exact inline arms remain preferred.
  if (applyFallback !== undefined) {
    dispatch = buildDynamicApplyFallback(fctx, applyFallback, argLocals, anyLocal, undefinedIdx, undefinedSingletonPad);
  }

  // (#3335) HOST-lane default arm: dispatch through `__call_function` instead
  // of silently producing `undefined`. A dynamic callee that is NOT a wasm
  // closure struct is routinely a HOST function value — the canonical shape is
  // the test262 TypedArray harness: `argFactory.bind(undefined, ctor)` returns
  // a host bound function, which then flows through an any-typed closure param
  // (`makeCtorArg`) and gets CALLED here. The bare `ref.null.extern` default
  // dropped that call on the floor: `new TA(makeCtorArg([...]))` constructed
  // from `null` → a LENGTH-0 host TypedArray → `.set()` threw the host
  // RangeError "offset is out of bounds", which the #3189 ratchet and the
  // poison classifier bin as an UNCATCHABLE oob trap (the 45→51 baseline flap,
  // six BigInt `TypedArray.prototype.set` files). `__call_function` invokes a
  // real host callable with the saved args (marshalled per #1712) and throws
  // the spec TypeError for non-callables (§7.3.14 Call → IsCallable false),
  // so the failure mode is deterministic and catchable. Standalone/WASI have
  // no host: they keep the legacy null default (their callable shapes are the
  // dedicated proxy/bound/ta-ctor arms above).
  if (!ctx.standalone && !ctx.wasi && allowHostBoundaryFallback) {
    // Imports were ensured (and flushed) before box/unbox indices were captured.
    // (#4313) A bare call's `thisArg` is `undefined`, not a null externref, so it
    // is materialized here and handed to the helper rather than hardcoded there.
    const bareCallThisArg: Instr[] = [];
    pushDynamicUndefinedExternref(bareCallThisArg, undefinedIdx, undefinedSingletonPad);
    dispatch = buildHostCallFallbackArm(ctx, fctx, hostCallPlan, anyLocal, argLocals, bareCallThisArg) ?? dispatch;
  }

  // (#2933) Variadic builtin value-closure arm — INNERMOST (just above the
  // null default), so any exact-arity candidate stays preferred. The saved arg
  // locals are already externref, exactly what the closure's vec carries: pack
  // ALL of them (true call-site count, no padding) into a fresh
  // `$vec_externref` and `call_ref` the closure. Result is already externref.
  if (variadicArm !== undefined) {
    const vFuncTypeDef = ctx.mod.types[variadicArm.funcTypeIdx];
    const vSelfParam = vFuncTypeDef?.kind === "func" ? vFuncTypeDef.params[0] : undefined;
    const vSelfTypeIdx =
      vSelfParam && (vSelfParam.kind === "ref" || vSelfParam.kind === "ref_null")
        ? (vSelfParam as { typeIdx: number }).typeIdx
        : variadicArm.structTypeIdx;
    const vArrLocal = allocLocal(fctx, `__dyn_varargs_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: variadicArm.arrTypeIdx,
    });
    const armBody: Instr[] = [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: vSelfTypeIdx },
    ];
    for (const argLocal of argLocals) {
      armBody.push({ op: "local.get", index: argLocal });
    }
    armBody.push({ op: "array.new_fixed", typeIdx: variadicArm.arrTypeIdx, length: argLocals.length });
    armBody.push({ op: "local.set", index: vArrLocal });
    armBody.push({ op: "i32.const", value: argLocals.length });
    armBody.push({ op: "local.get", index: vArrLocal });
    armBody.push({ op: "struct.new", typeIdx: variadicArm.vecTypeIdx });
    armBody.push({ op: "local.get", index: anyLocal });
    armBody.push({ op: "ref.cast", typeIdx: vSelfTypeIdx });
    armBody.push({ op: "struct.get", typeIdx: vSelfTypeIdx, fieldIdx: 0 });
    armBody.push({ op: "ref.cast", typeIdx: variadicArm.funcTypeIdx });
    armBody.push({ op: "call_ref", typeIdx: variadicArm.funcTypeIdx });
    // Same funcref-signature discrimination as the candidate arms below: the
    // struct guard alone matches every wrapper arity, so test field 0 against
    // the variadic func type.
    const vRootStructIdx =
      (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx ?? vSelfTypeIdx;
    dispatch = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: vRootStructIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: vRootStructIdx },
          { op: "struct.get", typeIdx: vRootStructIdx, fieldIdx: 0 },
          { op: "ref.test", typeIdx: variadicArm.funcTypeIdx },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: armBody,
        else: dispatch,
      },
    ];
  }

  for (const cand of candidates) {
    const funcTypeDef = ctx.mod.types[cand.info.funcTypeIdx];
    const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
    const selfTypeIdx =
      selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
        ? (selfParam as { typeIdx: number }).typeIdx
        : cand.structTypeIdx;

    // (#4616) Rest-param candidate: the trailing formal is the packed rest
    // vec. Marshal only the fixed formals positionally, then pack every
    // remaining call arg into a fresh vec — mirroring the generic
    // `__call_fn_N` rest arm (closure-exports.ts). Falls back to positional
    // marshalling when the vec/array shape can't be resolved or an element
    // kind isn't marshalable here.
    let restVec: { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | undefined;
    let fixedCount = cand.info.paramTypes.length;
    if (cand.info.hasRestParam === true && cand.info.paramTypes.length > 0) {
      const restFixed = cand.info.paramTypes.length - 1;
      const restParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[restFixed + 1] : undefined;
      if (restParam && (restParam.kind === "ref" || restParam.kind === "ref_null")) {
        const vecTypeIdx = (restParam as { typeIdx: number }).typeIdx;
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
        const arrDef = ctx.mod.types[arrTypeIdx];
        if (
          arrDef?.kind === "array" &&
          (arrDef.element.kind === "externref" || arrDef.element.kind === "f64" || arrDef.element.kind === "i32")
        ) {
          restVec = { vecTypeIdx, arrTypeIdx, elemType: arrDef.element };
          fixedCount = restFixed;
        }
      }
    }

    const callBody: Instr[] = [];

    appendDynamicCandidateArgcSetup(ctx, fctx, callBody, fixedCount, argLocals, arity);
    // Self arg: anyref → the concrete struct type this funcref expects.
    callBody.push({ op: "local.get", index: anyLocal });
    callBody.push({ op: "ref.cast", typeIdx: selfTypeIdx });

    // Push each FORMAL of the candidate, marshalling per its declared param
    // type. Call-site args (i < arity) come from the saved arg locals;
    // missing trailing formals (i >= arity) are padded with `undefined`
    // (#820/#1543) so the lifted method applies its default / runs the
    // spec-mandated destructure of the default value.
    for (let i = 0; i < fixedCount; i++) {
      const pType = cand.info.paramTypes[i]!;
      if (i >= arity) {
        // Missing arg → `undefined`. For ref/ref_null formals there is no
        // valid concrete struct to cast `undefined` to; pass the typed null.
        if (pType.kind === "f64") {
          callBody.push({ op: "i64.const", value: 0x7ff00000deadc0den });
          callBody.push({ op: "f64.reinterpret_i64" });
        } else if (pType.kind === "i32") {
          callBody.push({ op: "i32.const", value: 0 });
        } else if (pType.kind === "externref") {
          pushDynamicUndefinedExternref(callBody, undefinedIdx, undefinedSingletonPad);
        } else if (pType.kind === "ref" || pType.kind === "ref_null") {
          callBody.push({ op: "ref.null", typeIdx: (pType as { typeIdx: number }).typeIdx });
        }
        continue;
      }
      callBody.push({ op: "local.get", index: argLocals[i]! });
      if (pType.kind === "f64") {
        if (isUndefinedIdx === undefined) {
          callBody.push({ op: "call", funcIdx: unboxNumberIdx });
        } else {
          callBody.push({ op: "call", funcIdx: isUndefinedIdx });
          callBody.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }],
            else: [
              { op: "local.get", index: argLocals[i]! },
              { op: "call", funcIdx: unboxNumberIdx },
            ],
          });
        }
      } else if (pType.kind === "i32") {
        callBody.push({ op: "call", funcIdx: unboxNumberIdx });
        callBody.push({ op: "i32.trunc_sat_f64_s" });
      } else if (pType.kind === "externref") {
        // The saved value is already an externref, but it may be a host mirror
        // for a compiled vec. Reconcile same-length host/compiled mutations
        // before handing the value to an extern consumer (for example
        // node:crypto hashing a Uint8Array assembled in Wasm).
        if (unwrapForWasmIdx !== undefined) callBody.push({ op: "call", funcIdx: unwrapForWasmIdx });
      } else if (pType.kind === "ref") {
        // A compiled GC value may be represented by a host facade in this
        // dynamic lane. Recover the underlying value before preserving the
        // existing vec materialization and concrete cast behavior.
        if (unwrapForWasmIdx !== undefined) callBody.push({ op: "call", funcIdx: unwrapForWasmIdx });
        const vecMaterializerIdx = vecFromExternFuncIdx(ctx, pType.typeIdx);
        if (vecMaterializerIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: vecMaterializerIdx });
          callBody.push({ op: "ref.as_non_null" });
        } else {
          callBody.push({ op: "any.convert_extern" });
          callBody.push({ op: "ref.cast", typeIdx: pType.typeIdx });
        }
      } else if (pType.kind === "ref_null") {
        // A concrete nullable-ref formal with a default commonly receives the
        // host `undefined` singleton through this any-typed dispatch lane. It
        // must arrive as typed null so the callee's default-parameter prologue
        // can observe the missing argument. Casting the host singleton directly
        // to the concrete GC type traps with `illegal cast` before the function
        // runs (Redux's `currentReducer(currentState, action)` with an omitted
        // initial state). Real null also remains nullable via ref.cast_null.
        if (isUndefinedIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: isUndefinedIdx });
          callBody.push({
            op: "if",
            blockType: { kind: "val", type: pType },
            then: [{ op: "ref.null", typeIdx: pType.typeIdx }],
            else: (() => {
              const vecMaterializerIdx = vecFromExternFuncIdx(ctx, pType.typeIdx);
              return vecMaterializerIdx === undefined
                ? [
                    { op: "local.get", index: argLocals[i]! } as Instr,
                    ...(unwrapForWasmIdx === undefined ? [] : ([{ op: "call", funcIdx: unwrapForWasmIdx }] as Instr[])),
                    { op: "any.convert_extern" } as Instr,
                    { op: "ref.cast_null", typeIdx: pType.typeIdx } as Instr,
                  ]
                : [
                    { op: "local.get", index: argLocals[i]! } as Instr,
                    ...(unwrapForWasmIdx === undefined ? [] : ([{ op: "call", funcIdx: unwrapForWasmIdx }] as Instr[])),
                    { op: "call", funcIdx: vecMaterializerIdx } as Instr,
                  ];
            })(),
          });
        } else {
          const vecMaterializerIdx = vecFromExternFuncIdx(ctx, pType.typeIdx);
          if (unwrapForWasmIdx !== undefined) callBody.push({ op: "call", funcIdx: unwrapForWasmIdx });
          if (vecMaterializerIdx !== undefined) {
            callBody.push({ op: "call", funcIdx: vecMaterializerIdx });
          } else {
            callBody.push({ op: "any.convert_extern" });
            callBody.push({ op: "ref.cast_null", typeIdx: pType.typeIdx });
          }
        }
      }
    }

    // (#4616) Rest formal: pack every remaining call arg into a fresh vec
    // (length first, then the fixed-size array — the vec struct field order).
    if (restVec !== undefined) {
      const restCount = Math.max(0, arity - fixedCount);
      callBody.push({ op: "i32.const", value: restCount });
      for (let i = fixedCount; i < arity; i++) {
        callBody.push({ op: "local.get", index: argLocals[i]! });
        if (restVec.elemType.kind === "f64") {
          callBody.push({ op: "call", funcIdx: unboxNumberIdx });
        } else if (restVec.elemType.kind === "i32") {
          callBody.push({ op: "call", funcIdx: unboxNumberIdx });
          callBody.push({ op: "i32.trunc_sat_f64_s" });
        }
        // externref element: raw saved arg local.
      }
      callBody.push({ op: "array.new_fixed", typeIdx: restVec.arrTypeIdx, length: restCount });
      callBody.push({ op: "struct.new", typeIdx: restVec.vecTypeIdx });
    }

    // Extract funcref from field 0 and call_ref.
    callBody.push({ op: "local.get", index: anyLocal });
    callBody.push({ op: "ref.cast", typeIdx: selfTypeIdx });
    callBody.push({ op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 });
    callBody.push({ op: "ref.cast", typeIdx: cand.info.funcTypeIdx });
    callBody.push({ op: "call_ref", typeIdx: cand.info.funcTypeIdx });

    // Coerce return value to externref — the ONE shared decision (#4082
    // `buildClosureResultBoxing`), not a fourth private copy. The private copy
    // this replaces tested `ret.kind === "i32"` and unconditionally emitted
    // `f64.convert_i32_s` + `__box_number`, which is brand-blind: an `i32`
    // slot backs `number`, `boolean` (1/0) and symbol handles alike (#2785),
    // so a boolean-returning closure reached through this inline ladder handed
    // back the NUMBER 0/1. That is what made test262's `isConfigurable()`
    callBody.push(...buildClosureResultBoxing(ctx, cand.info.returnType, boxNumberIdx));
    appendExternResultArgcReset(ctx, fctx, callBody);

    // (#820/#1543) Discriminate by the *funcref* signature, not the struct
    // type. Every `__fn_wrap_*` struct subtypes the single root wrapper, so
    // `ref.test (ref <wrapper-struct>)` matches wrapper values of every arity
    // — an arity-0 arm would then fire for an extracted arity-1 method and
    // `ref.cast` its arity-1 funcref to the arity-0 funcType, trapping with
    // `illegal cast`. The funcref's type encodes the exact param count +
    // result, so `ref.test (ref funcTypeIdx)` on field 0 fires this arm only
    // for its own signature. A struct guard is still needed before the
    // `struct.get` (you can't read a field off a non-struct); the *root*
    // wrapper struct is a safe supertype to cast any wrapper to for that read.
    const rootStructIdx =
      (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx ?? selfTypeIdx;
    // (#4616) A rest arm additionally guards on the candidate's CONCRETE
    // struct type — its funcref signature alone is indistinguishable from a
    // genuine vec-param closure's, and the positional arm for that signature
    // stays in the chain below for those.
    const structGuardIdx = restVec !== undefined ? cand.structTypeIdx : rootStructIdx;
    const testCond: Instr[] = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: structGuardIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: rootStructIdx },
          { op: "struct.get", typeIdx: rootStructIdx, fieldIdx: 0 },
          { op: "ref.test", typeIdx: cand.info.funcTypeIdx },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];

    dispatch = [
      ...testCond,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: dispatch,
      },
    ];
  }

  // (#3031) Standalone Proxy [[Call]] — the OUTERMOST arm (§0.1 ladder step 1,
  // ahead of every closure-shape candidate): `p(...)` where `p` is a live
  // `$Proxy` packs the saved args into the native `$ObjVec` carrier and routes
  // to `__proxy_apply_dispatch(p, undefined, argsVec)` — the §10.5.12 apply
  // trap when installed, a transparent forward to the target otherwise. The
  // `thisArgument` of a bare call is `undefined`.
  if (proxyArm !== undefined) {
    const vecLocal = allocLocal(fctx, `__dyn_pargs_${fctx.locals.length}`, { kind: "externref" });
    const armBody: Instr[] = [
      { op: "call", funcIdx: proxyArm.vecNewIdx },
      { op: "local.set", index: vecLocal },
    ];
    for (const argLocal of argLocals) {
      armBody.push({ op: "local.get", index: vecLocal });
      armBody.push({ op: "local.get", index: argLocal });
      armBody.push({ op: "call", funcIdx: proxyArm.vecPushIdx });
    }
    armBody.push({ op: "local.get", index: anyLocal });
    armBody.push({ op: "extern.convert_any" });
    pushDynamicUndefinedExternref(armBody, undefinedIdx, undefinedSingletonPad); // thisArgument = undefined
    armBody.push({ op: "local.get", index: vecLocal });
    armBody.push({ op: "call", funcIdx: proxyArm.dispatchIdx });
    dispatch = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: proxyArm.proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: armBody,
        else: dispatch,
      },
    ];
  }

  // (#3140) Bound-function [[Call]] arm: `bound(...)` where `bound` is a
  // `$__bound_fn` minted by a standalone `.bind(...)` site. Pack the args into
  // a `$ObjVec` and route through `__apply_closure`, whose fill-time front
  // guard unwraps the carrier (prepends [[BoundArguments]], applies
  // [[BoundThis]], recurses on the target — bound-of-bound composes).
  if (boundArm !== undefined) {
    const vecLocal = allocLocal(fctx, `__dyn_bargs_${fctx.locals.length}`, { kind: "externref" });
    const armBody: Instr[] = [
      { op: "call", funcIdx: boundArm.vecNewIdx },
      { op: "local.set", index: vecLocal },
    ];
    for (const argLocal of argLocals) {
      armBody.push({ op: "local.get", index: vecLocal });
      armBody.push({ op: "local.get", index: argLocal });
      armBody.push({ op: "call", funcIdx: boundArm.vecPushIdx });
    }
    armBody.push({ op: "local.get", index: anyLocal });
    armBody.push({ op: "extern.convert_any" });
    armBody.push({ op: "ref.null.extern" }); // recv — [[BoundThis]] wins in the guard
    armBody.push({ op: "local.get", index: vecLocal });
    armBody.push({ op: "call", funcIdx: boundArm.applyIdx });
    dispatch = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: boundArm.bfTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: armBody,
        else: dispatch,
      },
    ];
  }

  // (#3177 slice 3) `$__ta_ctor` [[Call]] arm — outermost: a TypedArray
  // constructor value invoked WITHOUT `new` throws TypeError (§23.2.5.1
  // step 1, undefined NewTarget). Built here (immediately before the dispatch
  // is attached) so the baked `__new_TypeError` funcIdx cannot go stale: on
  // this lane the constructor is an in-module DEFINED function (append-only,
  // no import shift) and `buildThrowJsErrorInstrs` self-flushes against fctx.
  if (wantTaCtorArm) {
    const throwInstrs = buildThrowJsErrorInstrs(ctx, "TypeError", "Constructor cannot be invoked without 'new'", {
      flush: fctx,
    });
    // (#5188) The carrier match nests its `onMatch` under an `empty`-typed
    // `if`, while the `$__ta_ctor` arm below uses the SAME sequence as the
    // `then` of a `val externref` `if`. Handing ONE `Instr[]` object to both
    // makes that array reachable from two incompatible branch contexts, and
    // the stack-balance repair pass then fails the whole compile closed rather
    // than mutate a shared body ("reaches an instruction array from
    // incompatible control-flow ... contexts", #1058). That refusal hit EVERY
    // test262 file including `testTypedArray.js` — 534 of the 540 on the
    // #5188 target list were compile errors for this one aliased array — so
    // give each consumer its own copy.
    const int8CarrierThrow = buildInt8ArrayCarrierMatch(
      ctx,
      anyLocal,
      throwInstrs.map((instr) => ({ ...instr })),
    );
    if (ctx.taCtorTypeIdx >= 0) {
      dispatch = [
        { op: "local.get", index: anyLocal },
        { op: "ref.test", typeIdx: ctx.taCtorTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: throwInstrs, // terminal throw — stack-polymorphic, validates as externref
          else: [...int8CarrierThrow, ...dispatch],
        },
      ];
    } else {
      dispatch = [...int8CarrierThrow, ...dispatch];
    }
  }

  fctx.body.push(...emitDynamicCallDispatch(ctx, fctx, expr, dispatch));
  return { kind: "externref" };
}

/**
 * Statically flatten an array literal's elements into a positional argument
 * list, expanding spreads of nested array literals (`[...[a, b]]` → `a, b`).
 * Returns undefined when the literal contains an element we cannot expand at
 * compile time (a spread of a non-literal, or an elided hole). Used by the
 * `fn.apply(thisArg, [...])` rewrite (#1596).
 */
function flattenStaticArrayElements(arr: ts.ArrayLiteralExpression): ts.Expression[] | undefined {
  const out: ts.Expression[] = [];
  for (const el of arr.elements) {
    if (ts.isOmittedExpression(el)) return undefined;
    if (ts.isSpreadElement(el)) {
      let inner: ts.Expression = el.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (!ts.isArrayLiteralExpression(inner)) return undefined;
      const nested = flattenStaticArrayElements(inner);
      if (nested === undefined) return undefined;
      out.push(...nested);
    } else {
      out.push(el);
    }
  }
  return out;
}

/**
 * Return the materialized arguments-object identifier behind transparent
 * syntax such as `arguments as any`.  The local-map check distinguishes the
 * real per-call arguments vec from an unrelated top-level binding with the
 * same spelling.
 */
function materializedArgumentsVector(fctx: FunctionContext, expression: ts.Expression): ts.Identifier | undefined {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === "arguments" && fctx.localMap.has("arguments")
    ? current
    : undefined;
}

/**
 * True for a syntactic value produced by the standalone runtime-eval
 * Function constructor.  Such a value is a caller-owned callable carrier, so
 * its `.call`/`.apply` members cannot be recovered by the ordinary property
 * ladder (the provider's target intentionally does not mirror Function's
 * prototype).  The reflective call site can nevertheless route it through
 * the canonical `__apply_closure` bridge, preserving the explicit receiver.
 */
function standaloneDynamicFunctionCtorArgs(
  ctx: CodegenContext,
  expression: ts.Expression,
): readonly ts.Expression[] | undefined {
  if (!ctx.standalone) return undefined;
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isTypeAssertionExpression(value)
  ) {
    value = value.expression;
  }
  if (ts.isNewExpression(value)) {
    let target: ts.Expression = value.expression;
    while (
      ts.isParenthesizedExpression(target) ||
      ts.isAsExpression(target) ||
      ts.isSatisfiesExpression(target) ||
      ts.isNonNullExpression(target) ||
      ts.isTypeAssertionExpression(target)
    ) {
      target = target.expression;
    }
    if (ts.isIdentifier(target) && target.text === "Function" && isGlobalFunctionIdentifier(target, ctx.checker)) {
      return value.arguments ?? [];
    }
  }
  if (ts.isCallExpression(value) && !value.questionDotToken) {
    let target: ts.Expression = value.expression;
    while (
      ts.isParenthesizedExpression(target) ||
      ts.isAsExpression(target) ||
      ts.isSatisfiesExpression(target) ||
      ts.isNonNullExpression(target) ||
      ts.isTypeAssertionExpression(target)
    ) {
      target = target.expression;
    }
    if (ts.isIdentifier(target) && target.text === "Function" && isGlobalFunctionIdentifier(target, ctx.checker)) {
      return value.arguments;
    }
  }
  return undefined;
}

function isNullishPromiseThenCallbackArg(expr: ts.Expression | undefined): boolean {
  if (expr === undefined) return true;
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = (
      cur as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.SatisfiesExpression
        | ts.NonNullExpression
        | ts.TypeAssertion
    ).expression;
  }
  return (
    cur.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(cur) && cur.text === "undefined") ||
    (ts.isVoidExpression(cur) && cur.expression.kind === ts.SyntaxKind.NumericLiteral)
  );
}

export function compilePromiseThenReceiverBuffer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  liveBuffers: Instr[][],
): Instr[] {
  const instrs: Instr[] = [];
  liveBuffers.push(instrs);
  ctx.liveBodies.add(instrs);
  // (#2918) Push the real body onto `savedBodies` — NOT just a local — so a
  // late-import funcIdx shift fired while compiling this buffer (e.g. an object-
  // runtime helper import pulled in by an earlier `{}` statement, or `__box_*`
  // for a numeric arg) still walks the outer body and bumps the `call`/`ref.func`
  // indices already emitted there. A bare `savedBody` local left the outer body
  // unreachable to the shifter, so a `call __new_plain_object` baked at N stayed
  // N after everything moved to N+delta → it pointed at a wrong-arity helper
  // ("not enough arguments on the stack for call", the −601 standalone regression).
  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);
  fctx.body = instrs;
  try {
    const type = compileExpression(ctx, fctx, expr, { kind: "externref" });
    if (type && type.kind !== "externref") {
      coerceType(ctx, fctx, type, { kind: "externref" });
    }
  } finally {
    fctx.savedBodies.pop();
    fctx.body = savedBody;
  }
  markNativeIteratorResultBuffer(liveBuffers, nativeIteratorResultThenReceiver(ctx, expr));
  return instrs;
}

export function compileStandalonePromiseThenCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression | undefined,
  liveBuffers: Instr[][],
  // (#4394) `.then`/`.catch` sites opt in to DYNAMIC handlers (a runtime-held
  // function value with no compile-time ClosureInfo — captured promise
  // resolvers, reassigned `$DONE`): the compiled externref rides the caps and
  // the shared `__then_dyn_*` wrapper applies it at settle time. Left off for
  // `.finally` opts in as well; its dedicated dynamic wrapper invokes the
  // handler with zero arguments and preserves the original settlement.
  opts?: { allowDynamic?: boolean },
): StandalonePromiseThenCallback | null {
  const nativeIteratorResult = consumeNativeIteratorResultBuffer(liveBuffers);
  if (arg === undefined || isNullishPromiseThenCallbackArg(arg)) return null;

  const instrs: Instr[] = [];
  liveBuffers.push(instrs);
  ctx.liveBodies.add(instrs);
  // (#2918) Keep the outer body reachable to the late-import shifter — a late
  // import registered while compiling this buffer (e.g. an object-runtime
  // helper, or `__box_*` for a numeric arg) must still be able to walk the
  // outer body and bump the `call`/`ref.func` indices already emitted there.
  const savedBody = fctx.body;
  fctx.savedBodies.push(savedBody);
  fctx.body = instrs;
  // (#3137) Widen TUPLE-typed callback params to externref for this compile
  // window — the native then-wrapper ABI delivers externref, and the
  // contextually-inferred tuple struct (combinator over a tuple input) can
  // never match the runtime results vec (see computeClosureWrapperSig).
  const savedWidenTuple = ctx.widenTupleCallbackParams;
  const restoreNativeIteratorResult = enterNativeIteratorResultCallback(ctx, nativeIteratorResult);
  ctx.widenTupleCallbackParams = true;
  try {
    const type =
      ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
        ? compileArrowAsClosure(ctx, fctx, arg)
        : compileExpression(ctx, fctx, arg);
    let closureInfo: ClosureInfo | undefined;
    if (type && (type.kind === "ref" || type.kind === "ref_null")) {
      closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
    }
    if (!closureInfo && ts.isIdentifier(arg)) {
      closureInfo = ctx.closureMap.get(arg.text);
    }
    if (!closureInfo) {
      // (#4394) Dynamic handler: keep the compiled externref value — the shared
      // `__then_dyn_*` settle-time wrapper invokes it via `__apply_closure`.
      // Dropping it here (the pre-#4394 behaviour) silently treated the handler
      // as absent, leaving e.g. asyncHelpers' `resSettlementP` pending forever.
      if (opts?.allowDynamic === true && (ctx.standalone === true || ctx.wasi === true) && type !== null) {
        if (type.kind !== "externref") {
          coerceType(ctx, fctx, type, { kind: "externref" });
        }
        return { instrs, dynamic: true };
      }
      instrs.length = 0;
      return null;
    }
    if (type && type.kind !== "externref") {
      coerceType(ctx, fctx, type, { kind: "externref" });
    }
    return { instrs, closureInfo };
  } finally {
    ctx.widenTupleCallbackParams = savedWidenTuple;
    restoreNativeIteratorResult();
    fctx.savedBodies.pop();
    fctx.body = savedBody;
  }
}

/**
 * (#2980 class 1) The pre-widen host `.then`/`.catch` path (`Promise_then` /
 * `Promise_then2` / `Promise_catch` late imports) — unchanged behaviour,
 * extracted into its own function so {@link emitStandaloneThenWithNativeFallback}
 * can bake it into the runtime `else` arm against the ALREADY-EVALUATED
 * receiver local, instead of a second (possibly side-effecting) compile of
 * the receiver expression.
 */
function emitHostPromiseThenFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvLocal: number,
  method: "then" | "catch",
  onFulfilledArg: ts.Expression | undefined,
  onRejectedArg: ts.Expression | undefined,
): void {
  const useThen2 = method === "then" && onRejectedArg !== undefined;
  const importName = useThen2 ? "Promise_then2" : `Promise_${method}`;
  const paramTypes: ValType[] = useThen2
    ? [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }]
    : [{ kind: "externref" }, { kind: "externref" }];
  let funcIdx = ctx.funcMap.get(importName) ?? ensureLateImport(ctx, importName, paramTypes, [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  funcIdx = ctx.funcMap.get(importName) ?? funcIdx;

  if (funcIdx === undefined) {
    // Keep the stack balanced even if the import couldn't be registered.
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }

  fctx.body.push({ op: "local.get", index: recvLocal });

  const firstArg = method === "catch" ? onRejectedArg : onFulfilledArg;
  if (firstArg) {
    const cbType = compileExpression(ctx, fctx, firstArg, { kind: "externref" });
    if (cbType && cbType.kind !== "externref") coerceType(ctx, fctx, cbType, { kind: "externref" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  if (useThen2) {
    const cb2Type = compileExpression(ctx, fctx, onRejectedArg!, { kind: "externref" });
    if (cb2Type && cb2Type.kind !== "externref") coerceType(ctx, fctx, cb2Type, { kind: "externref" });
  }

  const finalIdx = ctx.funcMap.get(importName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalIdx });
}

/**
 * (#2980 class 1) `.then`/`.catch` runtime dispatch on standalone/WASI native
 * chaining. `isStandaloneThenChainNativeActive` only decides whether native
 * `$Promise` chaining is enabled AT ALL for this compile — it cannot know the
 * runtime SHAPE of the receiver, which for several real constructs is NOT a
 * native `$Promise` struct even when native chaining is on: the deferred
 * combinators (`Promise.allSettled` / `Promise.any` — `promise-combinators.ts`
 * only lowers `all`/`race` natively), constructor-executor promises, and
 * `Promise.prototype.then.call` / capability-object shapes all route through
 * host machinery. `emitStandalonePromiseThen`'s unconditional `ref.cast` to
 * `$Promise` TRAPS on any of these — the dominant #2980 decision-measure
 * residual (class 1, −18/60 in the original 262-file corpus measure;
 * re-measured 2026-07-05 against current main at 16/60 regressed in the
 * promise-then-all bucket alone, every one an "illegal cast in test()").
 *
 * Fix: evaluate the receiver ONCE into a local, `ref.test` it against the
 * native `$Promise` struct at RUNTIME, and route to the fast native chain
 * only on a genuine hit. A miss falls back to
 * {@link emitHostPromiseThenFallback} — exactly the pre-widen standalone
 * behaviour for that shape (fails to instantiate cleanly if the host import
 * is unsatisfied, no invalid Wasm — see {@link isStandaloneThenChainNativeActive}).
 *
 * Both arms are pre-compiled Instr buffers spliced into a runtime `if`/`else`
 * (`blockType: {kind:"val", type:{kind:"externref"}}` — both arms leave
 * exactly one externref). The native arm is built FIRST and then held
 * off `fctx.body`/`fctx.savedBodies` while the host arm is built (which can
 * register a NEW late host import and shift already-baked defined-function
 * indices) — so it MUST be registered in `ctx.liveBodies` for that window,
 * exactly the `liveBuffers` pattern this file already uses for the
 * `onFulfilled`/`onRejected` closure buffers (#2918).
 *
 * CALLER CONTRACT: only call this for the NON-wasi case (`ctx.wasi !==
 * true`). WASI's `.then`/`.catch` MUST NEVER gain a `Promise_then` import —
 * that contract is enforced by `tests/issue-1326.test.ts` (asserts the WAT
 * never contains "Promise_then" and instantiates with an EMPTY imports
 * object). The call sites in `compileCallExpression` branch on `ctx.wasi`
 * BEFORE reaching here and keep the original unconditional-cast lowering
 * for wasi untouched.
 */

/**
 * (#3389 slice 2a) `.return(v)` / `.throw(e)` on a DRIVEN async-generator
 * receiver — the sibling of {@link tryEmitAsyncGenNextDispatch}. Routes to the
 * per-gen `__async_gen_return_<stem>` / `__async_gen_throw_<stem>` driver (which
 * settles/rejects a fresh result promise and completes the frame). `method` is
 * `"return"` or `"throw"`; `argExpr` is the single optional arg (undefined → the
 * `ref.null.extern` sentinel). Runtime-dispatched by `ref.test`ing each
 * registered producer's frame struct, exactly like `.next()`.
 *
 * Miss arm: the legacy host `__gen_return`/`__gen_throw` is kept ONLY when a
 * legacy buffer async gen was emitted (`asyncGenLegacyBufferEmitted`); else a
 * plain null result, so an all-driven module stays host-free. Returns null
 * (fall through) off the standalone/wasi lane or when no driven producers exist.
 */
export function tryEmitAsyncGenReturnThrowDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  method: "return" | "throw",
  argExpr: ts.Expression | undefined,
): ValType | null {
  const producers = ctx.asyncGenProducers;
  if (ctx.standalone !== true && ctx.wasi !== true) return null;
  if (producers === undefined || producers.size === 0) return null;
  // (#3389 slice 2a — correct-or-legacy) `.return(v)` AWAITS its value under a
  // return completion (§27.6.3.8): a thenable/Promise return value must be
  // adopted before the IteratorResult settles. The driver fulfils with the raw
  // value, so bail a STATICALLY Promise/PromiseLike-typed `.return` arg to the
  // legacy path rather than deliver the un-awaited thenable (wrong value).
  // `.throw(e)` does NOT await its reason (§27.6.3.9 throws it directly), so no
  // restriction there.
  if (method === "return" && argExpr !== undefined) {
    const builtin = ctx.oracle.builtinReceiverOf(argExpr);
    const declared = ctx.oracle.declaredNameOf(argExpr);
    const parts = ctx.oracle.unionPartsOf(argExpr);
    if (
      builtin === "Promise" ||
      declared === "PromiseLike" ||
      (parts !== undefined && parts.some((p) => p.kind === "builtin" && p.name === "Promise"))
    ) {
      return null;
    }
  }
  // Evaluate the receiver ONCE into an externref local.
  const recvLocal = allocLocal(fctx, `__agen_rt_recv_${fctx.locals.length}`, { kind: "externref" });
  const rt = compileExpression(ctx, fctx, receiverExpr, { kind: "externref" });
  if (rt !== null && rt !== undefined && (rt as ValType).kind !== "externref") {
    coerceType(ctx, fctx, rt as ValType, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: recvLocal });
  // Evaluate the arg ONCE into an externref local (undefined → null sentinel).
  const argLocal = allocLocal(fctx, `__agen_rt_arg_${fctx.locals.length}`, { kind: "externref" });
  if (argExpr !== undefined) {
    const at = compileExpression(ctx, fctx, argExpr, { kind: "externref" });
    if (at !== null && at !== undefined && (at as ValType).kind !== "externref") {
      coerceType(ctx, fctx, at as ValType, { kind: "externref" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.set", index: argLocal });
  // funcMap lookups AFTER the receiver/arg compiles (which may shift indices).
  const hostName = method === "return" ? "__gen_return" : "__gen_throw";
  const wantHostFallback = ctx.asyncGenLegacyBufferEmitted === true;
  const hostIdx = wantHostFallback ? ctx.funcMap.get(hostName) : undefined;
  let chain: Instr[] =
    hostIdx !== undefined
      ? [
          { op: "local.get", index: recvLocal },
          { op: "local.get", index: argLocal },
          { op: "call", funcIdx: hostIdx },
        ]
      : [{ op: "ref.null.extern" }];
  for (const p of [...producers.values()].reverse()) {
    const helperName = method === "return" ? p.returnHelperName : p.throwHelperName;
    if (helperName === undefined) continue;
    const helperIdx = ctx.funcMap.get(helperName);
    if (helperIdx === undefined) continue;
    chain = [
      { op: "local.get", index: recvLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: p.stateTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: recvLocal },
          { op: "local.get", index: argLocal },
          { op: "call", funcIdx: helperIdx },
        ],
        else: chain,
      },
    ];
  }
  fctx.body.push(...chain);
  return { kind: "externref" };
}

/**
 * (#2903) Host-import names that PRODUCE promises the standalone module did
 * not mint natively. Checked (alongside the pre-body syntactic scan flag
 * `ctx.moduleHasHostPromiseSource`) before replacing the `.then`/`.catch`
 * bridge's host fallback arm with a native TypeError: if any of these is
 * registered, a runtime receiver can genuinely be a HOST promise and the host
 * arm must stay (exactly the pre-#2903 lowering — the module was irreducibly
 * host-import-leaky anyway, so keeping the arm sacrifices zero host-free
 * passes). All the *statically-detectable* producers register UPFRONT in the
 * `collectPromiseImports` finalize (declarations.ts) — before any function
 * body compiles — so this check is compile-order-safe for them; the
 * lazily-registered producers (dynamic `import()`, subclass-of-Promise
 * statics) are covered by the pre-body syntactic scan instead. `.finally(…)`
 * is NO LONGER a producer on the active native lane (it lowers to the native
 * §27.2.5.3 machinery, #2903 finally sub-front); `Promise_finally` stays
 * listed below as the funcMap backstop for the residual host-routed shapes
 * (producer modules' legacy route, carrier-fallback modules).
 *
 * Deliberately NOT listed (upfront-registered even when the lowering is
 * native, so funcMap presence is a false-positive that would forfeit the
 * de-leak): `Promise_resolve`/`Promise_reject` (unconditionally native under
 * `isStandalonePromiseActive`, expressions.ts) and `Promise_new` (native for
 * inline executors via `emitStandalonePromiseFromExecutor`; the genuine host
 * fallthrough in new-super.ts sets `ctx.moduleHasHostPromiseSource` at
 * emission instead).
 */
const HOST_PROMISE_PRODUCER_IMPORTS = [
  "Promise_all",
  "Promise_race",
  "Promise_allSettled",
  "Promise_any",
  "Promise_finally",
  "__dynamic_import",
  "__array_from_async",
] as const;

/**
 * (#2903) True when the `.then`/`.catch` receiver bridge's miss arm can be
 * NATIVE (a catchable TypeError) instead of the host `Promise_then*` fallback.
 * Standalone-only (wasi keeps its `nullMiss` contract; gc/host never emits the
 * bridge). Requires that the module provably cannot mint a host promise: no
 * syntactic producer (pre-body scan, `moduleHasHostPromiseSource`) and no
 * producer host import registered. Under that proof every runtime receiver
 * that fails the `ref.test $Promise` is a non-promise (§27.2.5.4 step 2 —
 * TypeError), and dropping the host arm removes the
 * `Promise_then*`/`__make_callback` imports that kept ~626 otherwise-passing
 * standalone modules host-import-leaky (measured 2026-07-10, see
 * plan/issues/2903: 662 then-chain-only leaky passes, 626 with the host arm
 * never CALLED at runtime).
 */
export function standaloneThenMissArmCanBeNative(ctx: CodegenContext): boolean {
  if (ctx.standalone !== true || ctx.wasi === true) return false;
  if (ctx.moduleHasHostPromiseSource === true) return false;
  for (const name of HOST_PROMISE_PRODUCER_IMPORTS) {
    if (ctx.funcMap.has(name)) return false;
  }
  return true;
}

export function emitStandaloneThenWithNativeFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  method: "then" | "catch",
  onFulfilledArg: ts.Expression | undefined,
  onRejectedArg: ts.Expression | undefined,
  // (#2865) `nullMiss` replaces the HOST miss arm with a plain null result —
  // for `--target wasi` any-receiver dispatch, where the zero-import contract
  // forbids registering `Promise_then*`/`__make_callback` and a host arm could
  // never succeed anyway (no stubs). Native receivers are unaffected.
  opts?: { nullMiss?: boolean },
): void {
  const liveBuffers: Instr[][] = [];
  try {
    const recvLocal = allocLocal(fctx, `__then_recv_${fctx.locals.length}`, { kind: "externref" });
    const recvType = compileExpression(ctx, fctx, receiverExpr, { kind: "externref" });
    if (recvType && recvType.kind !== "externref") {
      coerceType(ctx, fctx, recvType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: recvLocal });

    compilePromiseThenReceiverBuffer(ctx, fctx, receiverExpr, liveBuffers);
    const onFulfilled =
      method === "then"
        ? compileStandalonePromiseThenCallback(ctx, fctx, onFulfilledArg, liveBuffers, { allowDynamic: true })
        : null;
    const onRejected = compileStandalonePromiseThenCallback(ctx, fctx, onRejectedArg, liveBuffers, {
      allowDynamic: true,
    });
    const promiseInstrs: Instr[] = [{ op: "local.get", index: recvLocal }];

    const outerBody = fctx.body;

    const nativeArm: Instr[] = [];
    ctx.liveBodies.add(nativeArm);
    liveBuffers.push(nativeArm);
    fctx.savedBodies.push(outerBody);
    fctx.body = nativeArm;
    try {
      emitStandalonePromiseThen(ctx, fctx, promiseInstrs, onFulfilled, onRejected);
    } finally {
      fctx.savedBodies.pop();
      fctx.body = outerBody;
    }

    const hostArm: Instr[] = [];
    let missArmEmitted = false;
    if (opts?.nullMiss === true) {
      // (#4394) Standalone (non-wasi) `.then` miss arm: a user thenable's own
      // `then` must be invoked and a genuine non-thenable must throw the
      // catchable §27.2.5.4 TypeError — the bare null result swallowed both
      // (asyncHelpers `asyncTest`/`throwsAsync` stalls). All-native pieces, no
      // host import; wasi keeps its zero-import null contract.
      if (ctx.standalone === true && ctx.wasi !== true && method === "then") {
        const missArgs: (ts.Expression | undefined)[] = [onFulfilledArg, onRejectedArg];
        while (missArgs.length > 0 && missArgs[missArgs.length - 1] === undefined) missArgs.pop();
        ctx.liveBodies.add(hostArm);
        liveBuffers.push(hostArm);
        fctx.savedBodies.push(outerBody);
        fctx.body = hostArm;
        try {
          missArmEmitted = tryEmitStandaloneThenThenableMissArm(
            ctx,
            fctx,
            recvLocal,
            missArgs,
            standaloneThenMissArmCanBeNative(ctx),
          );
        } finally {
          fctx.savedBodies.pop();
          fctx.body = outerBody;
        }
      }
      if (!missArmEmitted) hostArm.push({ op: "ref.null.extern" });
    } else {
      ctx.liveBodies.add(hostArm);
      liveBuffers.push(hostArm);
      fctx.savedBodies.push(outerBody);
      fctx.body = hostArm;
      try {
        if (standaloneThenMissArmCanBeNative(ctx)) {
          // (#2903) The module provably cannot mint a HOST promise (no
          // syntactic producer, no producer import), so a receiver failing
          // the `ref.test $Promise` is a non-promise: throw the §27.2.5.4
          // step-2 TypeError NATIVELY instead of baking the dead host
          // `Promise_then*` arm. This is what makes the whole module
          // host-free — the host arm's `ensureLateImport` was the sole
          // source of the `Promise_then*`/`__make_callback` leak in ~626
          // otherwise-passing standalone modules. `throw` is terminal
          // (stack-polymorphic), so the externref-typed arm validates.
          emitThrowTypeError(ctx, fctx, `Promise.prototype.${method} called on a non-Promise receiver`);
        } else {
          emitHostPromiseThenFallback(ctx, fctx, recvLocal, method, onFulfilledArg, onRejectedArg);
        }
      } finally {
        fctx.savedBodies.pop();
        fctx.body = outerBody;
      }
    }

    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: nativeArm,
      else: hostArm,
    });
  } finally {
    for (const b of liveBuffers) ctx.liveBodies.delete(b);
  }
}

/**
 * (#2903) The pre-native host `.finally` path (`Promise_finally` late import) —
 * kept as the receiver bridge's miss arm ONLY when the module can genuinely
 * mint a host promise (`standaloneThenMissArmCanBeNative` false). Mirrors
 * {@link emitHostPromiseThenFallback}: emits against the ALREADY-EVALUATED
 * receiver local (no second receiver compile).
 */
function emitHostPromiseFinallyFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvLocal: number,
  onFinallyArg: ts.Expression | undefined,
): void {
  const paramTypes: ValType[] = [{ kind: "externref" }, { kind: "externref" }];
  let funcIdx =
    ctx.funcMap.get("Promise_finally") ?? ensureLateImport(ctx, "Promise_finally", paramTypes, [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  funcIdx = ctx.funcMap.get("Promise_finally") ?? funcIdx;

  if (funcIdx === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }

  fctx.body.push({ op: "local.get", index: recvLocal });
  if (onFinallyArg) {
    const cbType = compileExpression(ctx, fctx, onFinallyArg, { kind: "externref" });
    if (cbType && cbType.kind !== "externref") coerceType(ctx, fctx, cbType, { kind: "externref" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const finalIdx = ctx.funcMap.get("Promise_finally") ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalIdx });
}

/**
 * (#2903) `.finally` runtime dispatch on standalone/WASI native `$Promise`
 * receivers — the finally twin of {@link emitStandaloneThenWithNativeFallback}.
 * A `ref.test $Promise` HIT lowers §27.2.5.3 natively
 * (`emitStandalonePromiseFinally`); the MISS arm is a native catchable
 * TypeError when the module provably cannot mint a host promise, the exact
 * pre-#2903 `Promise_finally` host call when it can, and a plain null under
 * wasi (`nullMiss` — zero-import contract).
 */
export function emitStandaloneFinallyWithNativeFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  onFinallyArg: ts.Expression | undefined,
  opts?: { nullMiss?: boolean },
): void {
  const liveBuffers: Instr[][] = [];
  try {
    const recvLocal = allocLocal(fctx, `__finally_recv_${fctx.locals.length}`, { kind: "externref" });
    const recvType = compileExpression(ctx, fctx, receiverExpr, { kind: "externref" });
    if (recvType && recvType.kind !== "externref") {
      coerceType(ctx, fctx, recvType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: recvLocal });

    const onFinally = compileStandalonePromiseThenCallback(ctx, fctx, onFinallyArg, liveBuffers, {
      allowDynamic: true,
    });

    const outerBody = fctx.body;
    const nativeArm: Instr[] = [];
    ctx.liveBodies.add(nativeArm);
    liveBuffers.push(nativeArm);
    fctx.savedBodies.push(outerBody);
    fctx.body = nativeArm;
    try {
      emitStandalonePromiseFinally(ctx, fctx, [{ op: "local.get", index: recvLocal }], onFinally);
    } finally {
      fctx.savedBodies.pop();
      fctx.body = outerBody;
    }

    const hostArm: Instr[] = [];
    if (opts?.nullMiss === true) {
      hostArm.push({ op: "ref.null.extern" });
    } else {
      ctx.liveBodies.add(hostArm);
      liveBuffers.push(hostArm);
      fctx.savedBodies.push(outerBody);
      fctx.body = hostArm;
      try {
        if (standaloneThenMissArmCanBeNative(ctx)) {
          emitThrowTypeError(ctx, fctx, "Promise.prototype.finally called on a non-Promise receiver");
        } else {
          emitHostPromiseFinallyFallback(ctx, fctx, recvLocal, onFinallyArg);
        }
      } finally {
        fctx.savedBodies.pop();
        fctx.body = outerBody;
      }
    }

    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: nativeArm,
      else: hostArm,
    });
  } finally {
    for (const b of liveBuffers) ctx.liveBodies.delete(b);
  }
}

/**
 * #2034: compile a `Number.is*` predicate argument as an f64, honouring the
 * spec rule that these predicates do NOT coerce (ES §21.1.2.x): a non-Number
 * argument must yield `false` without ToNumber. (The *global* `isNaN`/`isFinite`
 * DO coerce — they are handled elsewhere and unaffected.)
 *
 * Emits one of two shapes and returns i32 (0/1):
 *   - static number arg → `predicate(arg)` (unchanged fast path).
 *   - any-typed arg → `__typeof_number(box) ? predicate(__unbox_number(box)) : 0`.
 *     The typeof guard runs first, so a string/object/null box short-circuits to
 *     0 (false) and never reaches the numeric test.
 *
 * `emitPredicate` receives the local holding the f64 value and pushes the
 * boolean (i32) test for that value.
 */
export function compileNumberIsPredicate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  emitPredicate: (valLocal: number) => Instr[],
): ValType {
  const argTsType = ctx.checker.getTypeAtLocation(arg);
  const argWasm = resolveWasmType(ctx, argTsType);

  // #2034 follow-up: a `symbol`-typed argument is statically NOT a Number, so
  // every `Number.is*` predicate is `false` (ES §21.1.2.x). A Symbol's Wasm
  // representation is a single-slot reference that BOTH the i32/f64 "static
  // number" fast path AND the runtime `__typeof_number` guard mis-handle (the
  // guard reports it as a number), so neither generic arm yields the spec
  // answer. Fold it at compile time: evaluate the argument for its side effects
  // (the Symbol expression may be an observable call) and push `false`.
  // (test262 Number/{isInteger,isFinite,isSafeInteger}/arg-is-not-number.js.)
  if ((argTsType.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Several non-Number primitive types reuse a numeric Wasm representation that
  // would otherwise hijack the "static number" fast path and coerce, violating
  // the no-coercion rule (ES §21.1.2.x):
  //   - `boolean` is i32 (`true`→1.0 / `false`→0.0), and
  //   - `undefined` / `void` / `null` lower to an f64 `NaN` (CLAUDE.md: "null/
  //     undefined in f64 context → f64.const NaN"). For `isInteger`/`isFinite`/
  //     `isSafeInteger` the NaN happens to yield the correct `false`, but
  //     `Number.isNaN(undefined)` would wrongly return `true`.
  // Exclude them so they take the runtime `__typeof_number` guard, which reports
  // a non-number and yields `false`.
  // (test262 Number/{isInteger,isFinite,isNaN,isSafeInteger}/arg-is-not-number.js.)
  const nonNumberMask = ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;
  const isNonNumberPrimitive = (argTsType.flags & nonNumberMask) !== 0;
  const isStaticNumber =
    !isNonNumberPrimitive && (isNumberType(argTsType) || argWasm.kind === "f64" || argWasm.kind === "i32");

  if (isStaticNumber) {
    // Fast path: the argument is statically a number — apply the test directly.
    compileExpression(ctx, fctx, arg, { kind: "f64" });
    const valTmp = allocLocal(fctx, `__numpred_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: valTmp });
    for (const instr of emitPredicate(valTmp)) fctx.body.push(instr);
    return { kind: "i32" };
  }

  // Any-typed argument: inspect the box's runtime type. Non-numbers are `false`
  // (no coercion); numbers unbox to f64 and run the test.
  addUnionImports(ctx);
  const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
  const unboxIdx = ctx.funcMap.get("__unbox_number")!;

  compileExpression(ctx, fctx, arg, { kind: "externref" });
  const boxTmp = allocLocal(fctx, `__numpred_box_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: boxTmp });

  const valTmp = allocLocal(fctx, `__numpred_${fctx.locals.length}`, { kind: "f64" });

  fctx.body.push({ op: "local.get", index: boxTmp });
  fctx.body.push({ op: "call", funcIdx: typeofNumIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: boxTmp },
      { op: "call", funcIdx: unboxIdx },
      { op: "local.set", index: valTmp },
      ...emitPredicate(valTmp),
    ],
    else: [{ op: "i32.const", value: 0 }],
  });
  return { kind: "i32" };
}

/**
 * (#2069) Detect whether a named callee was declared with an explicit
 * TypeScript `this` parameter (`function f(this: T, …)`). Such a function
 * materializes a leading `externref` `this` slot in its Wasm signature, so a
 * `.call`/`.apply` lowering must thread the user's thisArg into that slot
 * rather than dropping it. Returns the function's first ParameterDeclaration
 * when it is the `this` pseudo-parameter, else undefined.
 */
function getExplicitThisParam(ctx: CodegenContext, callee: ts.Expression): ts.ParameterDeclaration | undefined {
  const sym = ctx.checker.getSymbolAtLocation(callee);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (
    decl &&
    (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) &&
    decl.parameters.length > 0
  ) {
    const p0 = decl.parameters[0]!;
    if (ts.isIdentifier(p0.name) && p0.name.text === "this") return p0;
  }
  return undefined;
}

/**
 * #2088 — `String.fromCharCode` / `String.fromCodePoint`, all four lanes
 * (native helper × host import) served by one definition.
 *
 * Each argument becomes a one-char(-or-code-point) string via `helperIdx`;
 * the variadic concatenation that joins them is the shared
 * {@link emitVariadicStringConcat} primitive, so the single-argument-drop bug
 * that #2122 / #1955 fixed independently in every arm can no longer reappear
 * in just one lane.
 *
 * `native` selects the representation: native helpers concat with
 * `__str_concat` over `(ref $NativeString)` parts (zero host imports); the
 * host import path concats with the `wasm:js-string` `concat` builtin over
 * externref parts. `argToCode` is the per-argument numeric coercion the helper
 * expects (`i32.trunc_sat_f64_s` for the i32-typed native helpers,
 * `f64.convert_i32_s` for the f64-typed host imports).
 */
export function compileFromCharCodeFamily(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  opts: { native: boolean; helperIdx: number; isFromCodePoint?: boolean },
): ValType | null {
  const { native, helperIdx, isFromCodePoint } = opts;
  const repr = native ? nativeStringRepr(ctx) : hostStringRepr(ctx);
  if (repr === undefined) return null;

  // Build one string `part` per argument by compiling its code into a buffer
  // and applying the per-rep numeric coercion + the 1-char-string helper. The
  // buffers are registered with `ctx.liveBodies` so a late import added while
  // compiling a *later* argument still shifts indices baked into earlier ones.
  const parts: Instr[][] = [];
  for (let i = 0; i < expr.arguments.length; i++) {
    const buf: Instr[] = [];
    ctx.liveBodies.add(buf);
    const savedBody = fctx.body;
    fctx.body = buf;
    try {
      // (#5152) §22.1.2.2 step 2a / §22.1.2.1 step 2a apply ToNumber to every
      // argument, and §7.1.4 ToNumber(Symbol) throws a TypeError. Without this
      // a statically Symbol-typed arg silently coerced its internal id.
      if (noJsHost(ctx) && tryThrowOnBigIntOrSymbolArg(ctx, fctx, expr.arguments[i]!)) {
        parts.push(buf);
        continue;
      }
      const argType = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "f64" });
      // #2601 — §22.1.2.2 step 2b/2c: each fromCodePoint code point, after
      // ToNumber, must be an INTEGRAL Number in [0, 0x10FFFF] else RangeError.
      // (fromCharCode does ToUint16 with NO such check — fromCodePoint-only.)
      // Scoped to standalone/WASI (`noJsHost`): the throw uses the in-module
      // `__new_RangeError` constructor with no host bridge. The JS-host lane
      // keeps its existing host-delegated behaviour (the slice is standalone).
      const emitRangeGuard = isFromCodePoint === true && noJsHost(ctx);
      if (emitRangeGuard) {
        // Normalise to f64, then test `trunc(cp) != cp` (catches fractional AND
        // NaN) OR `cp < 0` OR `cp > 0x10FFFF` (±∞ caught by the range test).
        if (argType && argType.kind === "i32") buf.push({ op: "f64.convert_i32_s" });
        const cpTmp = allocLocal(fctx, `__fcp_cp_${fctx.locals.length}`, { kind: "f64" });
        buf.push({ op: "local.tee", index: cpTmp });
        // integral: trunc(cp) != cp  → also true for NaN
        buf.push({ op: "local.get", index: cpTmp });
        buf.push({ op: "f64.trunc" });
        buf.push({ op: "f64.ne" });
        // range: cp < 0
        buf.push({ op: "local.get", index: cpTmp });
        buf.push({ op: "f64.const", value: 0 });
        buf.push({ op: "f64.lt" });
        // range: cp > 0x10FFFF
        buf.push({ op: "local.get", index: cpTmp });
        buf.push({ op: "f64.const", value: 0x10ffff });
        buf.push({ op: "f64.gt" });
        buf.push({ op: "i32.or" });
        buf.push({ op: "i32.or" });
        const throwBuf: Instr[] = [];
        const savedForThrow = fctx.body;
        fctx.body = throwBuf;
        emitThrowRangeError(ctx, fctx, "RangeError: Invalid code point");
        fctx.body = savedForThrow;
        buf.push({ op: "if", blockType: { kind: "empty" }, then: throwBuf });
        // Re-push the validated code point for the helper.
        buf.push({ op: "local.get", index: cpTmp });
      }
      if (native) {
        if (emitRangeGuard) {
          // Already f64 in the temp above — trunc to the i32 the native helper wants.
          buf.push({ op: "i32.trunc_sat_f64_s" });
        } else if (argType && argType.kind !== "i32") {
          // (#2875 slice 5) §7.1.8 ToUint16 computed in the f64 domain BEFORE
          // the i32 conversion: t = trunc(x); m = t − floor(t/2^16)·2^16 ∈
          // [0, 65535]. Division by 2^16 is a pure exponent shift, so every
          // step is exact for all finite f64s; NaN and ±Inf propagate to a NaN
          // m (Inf−Inf), which i32.trunc_sat then maps to the spec's +0.
          // A bare `i32.trunc_sat_f64_s` SATURATES first — +Inf → 0x7FFFFFFF,
          // which the helper's low-16 mask turns into 0xFFFF instead of 0
          // (S9.7_A1 #5), and any |x| ≥ 2^31 loses its true modulo the same
          // way. (The i32-typed arg arm needs none of this: the helper's mask
          // IS ToUint16 for i32-representable integers.)
          const u16Tmp = allocLocal(fctx, `__fcc_u16_${fctx.locals.length}`, { kind: "f64" });
          buf.push({ op: "f64.trunc" });
          buf.push({ op: "local.tee", index: u16Tmp });
          buf.push({ op: "local.get", index: u16Tmp });
          buf.push({ op: "f64.const", value: 65536 });
          buf.push({ op: "f64.div" });
          buf.push({ op: "f64.floor" });
          buf.push({ op: "f64.const", value: 65536 });
          buf.push({ op: "f64.mul" });
          buf.push({ op: "f64.sub" });
          buf.push({ op: "i32.trunc_sat_f64_s" });
        }
      } else {
        if (argType && argType.kind === "i32") buf.push({ op: "f64.convert_i32_s" });
      }
      buf.push({ op: "call", funcIdx: helperIdx });
    } finally {
      fctx.body = savedBody;
    }
    parts.push(buf);
  }

  fctx.body.push(...emitVariadicStringConcat(repr, parts));
  // The part instructions now live (spliced) inside `fctx.body`, which every
  // future `flushLateImportShifts` already walks. Drop the standalone buffer
  // registrations so the same instruction objects are not shifted twice (the
  // shift dedup keys on array identity, not instruction identity).
  for (const buf of parts) ctx.liveBodies.delete(buf);
  return repr.resultType;
}

/**
 * (#2166 PR-D3) Build the array-form `JSON.stringify` replacer allowlist as a
 * plain `$Object` whose own keys are the (String/Number-coerced) elements of an
 * array-literal replacer, and leave it on the stack as an externref. The codec
 * tests membership with `__extern_has`, so the stored value is immaterial — we
 * store the key string itself. Per §25.5.2 SerializeJSONArray-replacer rules
 * only String and Number elements contribute a key; duplicates collapse (a
 * second `__extern_set` of the same key is a no-op for membership). Other
 * element kinds (booleans, objects, dynamic expressions) are ignored, matching
 * the spec's "only String/Number" filter for the common static-array case.
 */
export function emitJsonReplacerAllowList(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrayLit: ts.ArrayLiteralExpression,
): void {
  const newObjIdx = ctx.funcMap.get("__new_plain_object")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const allowLocal = allocLocal(fctx, `__json_allow_${fctx.locals.length}`, { kind: "externref" });
  // allow = __new_plain_object()
  fctx.body.push({ op: "call", funcIdx: newObjIdx });
  fctx.body.push({ op: "local.set", index: allowLocal });
  const seen = new Set<string>();
  for (const el of arrayLit.elements) {
    let key: string | undefined;
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
      key = el.text;
    } else if (ts.isNumericLiteral(el)) {
      // Number element → its String() form (e.g. 0 → "0").
      key = String(Number(el.text));
    } else if (
      ts.isPrefixUnaryExpression(el) &&
      el.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(el.operand)
    ) {
      key = String(-Number(el.operand.text));
    }
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    // __extern_set(allow, key, key) — value is immaterial (membership only).
    fctx.body.push({ op: "local.get", index: allowLocal });
    for (const instr of nativeStringLiteralInstrs(ctx, key)) fctx.body.push(instr);
    fctx.body.push({ op: "extern.convert_any" });
    for (const instr of nativeStringLiteralInstrs(ctx, key)) fctx.body.push(instr);
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "call", funcIdx: externSetIdx });
  }
  // leave the allowlist object on the stack as externref
  fctx.body.push({ op: "local.get", index: allowLocal });
}

/**
 * #2632 Phase 1 — lower `setTimeout` / `setInterval` / `clearTimeout` /
 * `clearInterval` / `queueMicrotask` onto the WASI timer-heap + run-loop
 * reactor. Returns `undefined` when this is not a WASI timer call (so the
 * generic dispatcher continues), or an `InnerResult` when handled.
 *
 * Only bare-identifier callees fire (a member call like `obj.setTimeout(...)`
 * is a user method, never the global). The timer heap was registered in the
 * deferred-helper phase (`ensureTimerHeap`), so `__timer_add` / `__timer_cancel`
 * func indices are already final.
 */
function tryWasiTimerCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.wasi) return undefined;
  if (!ts.isIdentifier(expr.expression)) return undefined;
  const name = expr.expression.text;

  // #2632 Phase 2 — `__wasiStdinReadByte()` reads the next byte the fd0 reactor
  // buffered into the internal stdin buffer (or -1 if empty), as a JS number.
  // This is the internal-buffer primitive Phase 3's `process.stdin.read()`
  // builds on. The timer heap + run loop were registered in the deferred phase.
  if (name === "__wasiStdinReadByte") {
    emitStdinReadByte(ctx, fctx);
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }

  // #2632 Phase 3 — internal-buffer query primitives the library `process.stdin`
  // Readable builds on: how many bytes are buffered+unread, and whether fd0 has
  // hit EOF with the buffer fully drained.
  if (name === "__wasiStdinAvailable") {
    emitStdinAvailable(ctx, fctx);
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }
  if (name === "__wasiStdinEof") {
    emitStdinEof(ctx, fctx);
    // boolean result (i32 0/1)
    return { kind: "i32" };
  }
  // #2735 — `__wasiStdinStop()` drops the fd0 subscription so the reactor can
  // terminate WITHOUT stdin EOF (in-band shutdown / `process.stdin.destroy()`).
  // The library `Readable.destroy()` lowers to this.
  if (name === "__wasiStdinStop") {
    emitStdinStop(ctx, fctx);
    return VOID_RESULT;
  }
  // #2632 Phase 3 — `__wasiStdinSetReader(cb)` registers the Readable's pump as
  // the reactor-tick hook (run loop call_ref's it each tick after the drain).
  // The callback closure is compiled into a `$__mt_func_type` wrapper + captures
  // exactly like a timer callback, then stored into the hook globals.
  if (name === "__wasiStdinSetReader") {
    ensureTimerHeap(ctx);
    const cbArg = expr.arguments[0];
    if (cbArg === undefined) return VOID_RESULT;
    let capInstrs: Instr[];
    let closureInfo: ClosureInfo | undefined;
    {
      const saved = pushBody(fctx);
      try {
        const type =
          ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
            ? compileArrowAsClosure(ctx, fctx, cbArg)
            : compileExpression(ctx, fctx, cbArg);
        if (type && (type.kind === "ref" || type.kind === "ref_null")) {
          closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
        }
        if (!closureInfo && ts.isIdentifier(cbArg)) {
          closureInfo = ctx.closureMap.get(cbArg.text);
        }
        if (closureInfo && type && type.kind !== "externref") {
          coerceType(ctx, fctx, type, { kind: "externref" });
        }
      } finally {
        capInstrs = fctx.body;
        popBody(fctx, saved);
      }
    }
    if (!closureInfo) return undefined;
    const wrapperFuncIdx = emitTimerCallbackWrapper(ctx, closureInfo);
    emitStdinSetReader(ctx, fctx, [{ op: "ref.func", funcIdx: wrapperFuncIdx }], capInstrs);
    return VOID_RESULT;
  }

  if (
    name !== "setTimeout" &&
    name !== "setInterval" &&
    name !== "clearTimeout" &&
    name !== "clearInterval" &&
    name !== "queueMicrotask"
  ) {
    return undefined;
  }
  // Guard against a user-defined local/function shadowing the global name. The
  // global timer functions are declared ONLY in lib .d.ts files; a user shadow
  // has at least one declaration in a real (.ts) source file. (`setTimeout` &c
  // are also registered as inlinable lib stubs in ctx.funcMap, so a funcMap
  // membership check would false-positive — use the symbol's declarations.)
  {
    const sym = ctx.checker.getSymbolAtLocation(expr.expression);
    const decls = sym?.declarations;
    if (decls && decls.length > 0 && !decls.every((d) => d.getSourceFile().isDeclarationFile)) {
      return undefined; // user-defined shadow → not the global timer
    }
  }

  // Ensure the timer heap exists. It is normally registered eagerly in the
  // deferred-helper phase; this call is idempotent and a safety net.
  ensureTimerHeap(ctx);

  // ── clearTimeout(id) / clearInterval(id) ──────────────────────────────
  if (name === "clearTimeout" || name === "clearInterval") {
    if (expr.arguments.length < 1) return VOID_RESULT;
    // id is a JS number (f64). Convert to the i32 slot id.
    const saved = pushBody(fctx);
    compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
    const idInstrs = fctx.body;
    popBody(fctx, saved);
    idInstrs.push({ op: "i32.trunc_sat_f64_s" });
    emitTimerCancel(ctx, fctx, idInstrs);
    return VOID_RESULT;
  }

  // ── setTimeout / setInterval / queueMicrotask: compile the callback ──
  const cbArg = expr.arguments[0];
  if (cbArg === undefined) return VOID_RESULT;

  // Compile the callback into its own buffer, yielding a closure struct pushed
  // as externref + its ClosureInfo (mirrors compileStandalonePromiseThenCallback).
  let capInstrs: Instr[];
  let closureInfo: ClosureInfo | undefined;
  {
    const saved = pushBody(fctx);
    try {
      const type =
        ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
          ? compileArrowAsClosure(ctx, fctx, cbArg)
          : compileExpression(ctx, fctx, cbArg);
      if (type && (type.kind === "ref" || type.kind === "ref_null")) {
        closureInfo = ctx.closureInfoByTypeIdx.get(type.typeIdx);
      }
      if (!closureInfo && ts.isIdentifier(cbArg)) {
        closureInfo = ctx.closureMap.get(cbArg.text);
      }
      if (closureInfo && type && type.kind !== "externref") {
        coerceType(ctx, fctx, type, { kind: "externref" });
      }
    } finally {
      capInstrs = fctx.body;
      popBody(fctx, saved);
    }
  }
  if (!closureInfo) {
    // Not a recognised closure (e.g. a string-bodied setTimeout, unsupported).
    // Bail to the generic path, which will reject/handle it.
    return undefined;
  }

  const wrapperFuncIdx = emitTimerCallbackWrapper(ctx, closureInfo);

  // ── queueMicrotask(cb) — enqueue directly onto the microtask queue ────
  if (name === "queueMicrotask") {
    emitMicrotaskEnqueue(
      ctx,
      fctx,
      [{ op: "ref.func", funcIdx: wrapperFuncIdx }],
      capInstrs, // captures externref = the closure struct
      [{ op: "ref.null.extern" }], // value = undefined
    );
    return VOID_RESULT;
  }

  // ── setTimeout(cb, ms) / setInterval(cb, ms) ──────────────────────────
  // delayNs = max(0, ms) * 1e6 ; deadlineNs = now + delayNs.
  const nowIdx = getRunLoopNowFuncIdx(ctx);
  const delayNsLocal = allocLocal(fctx, `__timer_delay_${fctx.locals.length}`, { kind: "i64" });

  // Compute delayNs into a local: trunc(ms) clamped to >= 0, times 1e6.
  if (expr.arguments.length >= 2) {
    compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "f64" });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 });
  }
  // Clamp negative / NaN ms to 0 (Node treats ms<=0 or NaN as 0).
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.max" });
  fctx.body.push({ op: "i64.trunc_sat_f64_s" });
  fctx.body.push({ op: "i64.const", value: 1000000n });
  fctx.body.push({ op: "i64.mul" });
  fctx.body.push({ op: "local.set", index: delayNsLocal });

  const deadlineInstrs: Instr[] = [
    { op: "call", funcIdx: nowIdx },
    { op: "local.get", index: delayNsLocal },
    { op: "i64.add" },
  ];
  // interval period: setInterval re-arms with delayNs; setTimeout = 0 (one-shot).
  const intervalInstrs: Instr[] =
    name === "setInterval" ? [{ op: "local.get", index: delayNsLocal }] : [{ op: "i64.const", value: 0n }];

  emitTimerAdd(
    ctx,
    fctx,
    deadlineInstrs,
    [{ op: "ref.func", funcIdx: wrapperFuncIdx }],
    capInstrs, // captures externref = the closure struct
    intervalInstrs,
  );
  // __timer_add returns the i32 id; setTimeout/setInterval return a JS number.
  fctx.body.push({ op: "f64.convert_i32_s" });
  return { kind: "f64" };
}

/**
 * (#3146) Iterator-statics prelude intrinsics — the four `__j2w_iter_*`
 * bare-identifier calls the injected standalone `Iterator.zip / zipKeyed /
 * concat / from` prelude (src/iterator-statics-prelude.ts) rides on. Each
 * lowers onto the NATIVE iterator runtime (iterator-native.ts), so the
 * prelude inherits the full GetIterator ladder (vec / vec-family / USER
 * closed-struct / OBJ plain-object / host-gen / async-gen carriers),
 * receiver-correct `.next()` stepping, and `.return()`-forwarding
 * IteratorClose without any new host import:
 *   - `__j2w_iter_rec(o)`    → `__iterator(o)`             (externref rec)
 *   - `__j2w_iter_step(rec)` → `__iterator_next(rec)`; the step VALUE is
 *     parked in the scratch global, the i32 done flag is returned as f64 0/1
 *   - `__j2w_iter_value()`   → reads the parked step value
 *   - `__j2w_iter_close(rec)`→ `__iterator_return(rec)`    (IteratorClose)
 *
 * Returns `undefined` when this is not an intrinsic call (generic dispatch
 * continues). Gated to the host-free targets — the prelude is only ever
 * injected under `--target standalone|wasi`, and in JS-host mode the
 * runtime.ts polyfills own these helpers (#1464).
 */
function tryIteratorStaticsIntrinsicCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  if (!ts.isIdentifier(expr.expression)) return undefined;
  const name = expr.expression.text;
  if (
    name !== "__j2w_iter_rec" &&
    name !== "__j2w_iter_step" &&
    name !== "__j2w_iter_value" &&
    name !== "__j2w_iter_close"
  ) {
    return undefined;
  }

  ensureNativeIteratorRuntime(ctx);

  if (name === "__j2w_iter_value") {
    const scratchIdx = ensureIterStepScratchGlobal(ctx);
    fctx.body.push({ op: "global.get", index: scratchIdx });
    return { kind: "externref" };
  }

  const arg = expr.arguments[0];
  if (arg === undefined) return undefined; // malformed — let generic dispatch report
  const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argType && argType.kind !== "externref") {
    coerceType(ctx, fctx, argType, { kind: "externref" });
  }
  flushLateImportShifts(ctx, fctx);

  if (name === "__j2w_iter_rec") {
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__iterator")! });
    return { kind: "externref" };
  }
  if (name === "__j2w_iter_step") {
    const scratchIdx = ensureIterStepScratchGlobal(ctx);
    // (i32 done, externref value) — park the value, surface done as f64 0/1.
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__iterator_next")! });
    fctx.body.push({ op: "global.set", index: scratchIdx });
    fctx.body.push({ op: "f64.convert_i32_s" });
    return { kind: "f64" };
  }
  // __j2w_iter_close
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__iterator_return")! });
  return VOID_RESULT;
}

/**
 * #3509 — A standalone dynamic import in an ordinary lifted closure can be lowered
 * to a call-site trap instead of rejecting the whole module. This is the
 * deferred case: creating the function does not need a loader, and execution
 * remains honest because reaching import() throws before a Promise or module
 * namespace can be manufactured.
 *
 * Async functions stay on #3494's explicit unsupported path. Their throw must
 * become a rejected Promise rather than escape synchronously, which requires
 * the async/module-evaluation substrate that this bounded fix deliberately
 * does not approximate.
 */
function canDeferStandaloneDynamicImport(fctx: FunctionContext): boolean {
  return fctx.deferredDynamicImportTrap === true;
}

/** Private, opt-in proxy brand probe used by the Deno app bridge. Ordinary
 * source never sees this name; the JavaScript fallback returns false, while a
 * standalone build can test the concrete `$Proxy` RTT without invoking any
 * user-visible proxy trap. */
function tryRuntimeIsProxyIntrinsic(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (
    (!ctx.standalone && !ctx.wasi) ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "__runtime_is_proxy" ||
    expr.arguments.length !== 1
  ) {
    return undefined;
  }

  const externref: ValType = { kind: "externref" };
  const value = allocLocal(fctx, `__runtime_is_proxy_value_${fctx.locals.length}`, externref);
  const type = compileExpression(ctx, fctx, expr.arguments[0]!, externref);
  if (type && type.kind !== "externref") coerceType(ctx, fctx, type, externref);
  fctx.body.push({ op: "local.set", index: value });
  emitRuntimeEvalBoundaryCarrierPeel(ctx, fctx, value, externref);
  const runtime = ensureObjectRuntime(ctx);
  fctx.body.push(
    { op: "local.get", index: value },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: runtime.proxyTypeIdx },
  );
  return { kind: "i32" };
}

/**
 * #2928 — interpreter-owned external-call intrinsic. The source helper keeps
 * ordinary Node execution on Function#apply; the self-compiled provider lowers
 * it directly to the native closure bridge so a foreign callable carrier does
 * not need to expose `.apply` through the provider's object-property runtime.
 */
function tryRuntimeEvalApplyCallableIntrinsic(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (
    (!ctx.standalone && !ctx.wasi) ||
    ctx.runtimeEvalCallableBoundaryEnabled !== true ||
    !ts.isIdentifier(expr.expression) ||
    expr.expression.text !== "__runtime_eval_apply_callable" ||
    expr.arguments.length !== 3
  ) {
    return undefined;
  }

  const externref: ValType = { kind: "externref" };
  for (let i = 0; i < expr.arguments.length; i += 1) {
    const arg = expr.arguments[i]!;
    const type = compileExpression(ctx, fctx, arg, externref);
    if (type && type.kind !== "externref") coerceType(ctx, fctx, type, externref);
    if (i === 1) {
      // The provider's undefined singleton is private to that module. If it
      // crosses the seam as an opaque externref, the caller's carrier cannot
      // recognize it as an absent receiver and a sloppy callee observes that
      // foreign object instead of applying §10.4.3. Normalize at the seam
      // while the value is still in the provider's own representation; null
      // is the caller's established unbound spelling, and the callee's own
      // strictness still selects undefined versus the realm global.
      const receiverLocal = allocLocal(fctx, `__runtime_eval_receiver_${fctx.locals.length}`, externref);
      fctx.body.push({ op: "local.set", index: receiverLocal }, ...installableReceiverInstrs(ctx, receiverLocal));
    }
  }
  ensureObjectRuntime(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  fctx.body.push({ op: "call", funcIdx: applyIdx });
  return externref;
}

/** Peel the generic `$AnyValue` extern/any carrier layers that can be added by
 * erased object slots and closure dispatch. A callback marker is intentionally
 * structural, so the boundary intrinsics must inspect the first real payload
 * instead of relying on host/WeakMap identity. */
function emitRuntimeEvalBoundaryCarrierPeel(
  ctx: CodegenContext,
  fctx: FunctionContext,
  candidateLocal: number,
  externref: ValType,
): void {
  if (ctx.anyValueTypeIdx < 0) return;
  const anyTypeIdx = ctx.anyValueTypeIdx;
  const anyLocal = allocLocal(fctx, `__runtime_eval_boundary_any_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: anyTypeIdx,
  });
  for (let depth = 0; depth < 8; depth += 1) {
    fctx.body.push(
      { op: "local.get", index: candidateLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: anyTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [
          { op: "local.get", index: candidateLocal },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: anyTypeIdx },
          { op: "local.tee", index: anyLocal },
          { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: 6 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "val", type: externref },
            then: [
              { op: "local.get", index: anyLocal },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 3 },
              { op: "extern.convert_any" },
            ],
            else: [
              { op: "local.get", index: anyLocal },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 },
              { op: "i32.const", value: 5 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: externref },
                then: [
                  { op: "local.get", index: anyLocal },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 4 },
                ],
                else: [{ op: "local.get", index: candidateLocal }],
              },
            ],
          },
        ],
        else: [{ op: "local.get", index: candidateLocal }],
      },
      { op: "local.set", index: candidateLocal },
    );
  }
}

/** Marshal one provider result into a canonical, non-recursive carrier. The
 * provider's `$AnyValue` and primitive box structs are private to that module;
 * scalar payloads must cross explicitly so the caller can rebuild its own
 * number/boolean/BigInt boxes. */
function emitRuntimeEvalResultBoundaryWrap(ctx: CodegenContext, fctx: FunctionContext, externref: ValType): ValType {
  ensureAnyHelpers(ctx);
  const valueTypeIdx = ensureRuntimeEvalValueType(ctx);
  const anyTypeIdx = ctx.anyValueTypeIdx;
  const valueLocal = allocLocal(fctx, `__runtime_eval_result_value_${fctx.locals.length}`, externref);
  const anyLocal = allocLocal(fctx, `__runtime_eval_result_any_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: anyTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: valueLocal });

  const makeValue = (
    kind: number,
    i32Value: Instr[] = [{ op: "i32.const", value: 0 }],
    f64Value: Instr[] = [{ op: "f64.const", value: 0 }],
    i64Value: Instr[] = [{ op: "i64.const", value: 0n }],
    refValue: Instr[] = [{ op: "ref.null.extern" }],
  ): Instr[] => [
    { op: "i32.const", value: kind },
    ...i32Value,
    ...f64Value,
    ...i64Value,
    ...refValue,
    { op: "struct.new", typeIdx: valueTypeIdx },
    { op: "extern.convert_any" },
  ];
  const anyField = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: anyLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx },
  ];
  const anyTagCase = (tag: number, then: Instr[], otherwise: Instr[]): Instr[] => [
    ...anyField(0),
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then,
      else: otherwise,
    },
  ];
  const anyReference: Instr[] = [
    ...anyField(3),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: anyField(4),
      else: [...anyField(3), { op: "extern.convert_any" }],
    },
  ];
  const anyValue: Instr[] = anyTagCase(
    0,
    makeValue(RUNTIME_EVAL_VALUE_KIND_NULL),
    anyTagCase(
      1,
      makeValue(RUNTIME_EVAL_VALUE_KIND_UNDEFINED),
      anyTagCase(
        2,
        makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, [...anyField(1), { op: "f64.convert_i32_s" }]),
        anyTagCase(
          3,
          makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, anyField(2)),
          anyTagCase(
            4,
            makeValue(RUNTIME_EVAL_VALUE_KIND_BOOLEAN, anyField(1)),
            anyTagCase(
              5,
              makeValue(RUNTIME_EVAL_VALUE_KIND_STRING, undefined, undefined, undefined, anyField(4)),
              anyTagCase(
                6,
                makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, anyReference),
                makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, [
                  { op: "local.get", index: valueLocal },
                ]),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  const helperTest = (name: string, then: Instr[], otherwise: Instr[]): Instr[] => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return otherwise;
    return [
      { op: "local.get", index: valueLocal },
      { op: "call", funcIdx: idx },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then,
        else: otherwise,
      },
    ];
  };
  const helperPayload = (name: string, result: ValType): Instr[] => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) {
      if (result.kind === "i32") return [{ op: "i32.const", value: 0 }];
      if (result.kind === "f64") return [{ op: "f64.const", value: 0 }];
      return [{ op: "i64.const", value: 0n }];
    }
    return [
      { op: "local.get", index: valueLocal },
      { op: "call", funcIdx: idx },
    ];
  };
  const fallbackReference = makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, [
    { op: "local.get", index: valueLocal },
  ]);
  const classifiedValue = helperTest("__typeof_undefined", makeValue(RUNTIME_EVAL_VALUE_KIND_UNDEFINED), [
    { op: "local.get", index: valueLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: makeValue(RUNTIME_EVAL_VALUE_KIND_NULL),
      else: helperTest(
        "__typeof_number",
        makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, helperPayload("__unbox_number", { kind: "f64" })),
        helperTest(
          "__typeof_boolean",
          makeValue(RUNTIME_EVAL_VALUE_KIND_BOOLEAN, helperPayload("__unbox_boolean", { kind: "i32" })),
          helperTest(
            "__typeof_string",
            makeValue(RUNTIME_EVAL_VALUE_KIND_STRING, undefined, undefined, undefined, [
              { op: "local.get", index: valueLocal },
            ]),
            helperTest(
              "__typeof_bigint",
              makeValue(
                RUNTIME_EVAL_VALUE_KIND_BIGINT,
                undefined,
                undefined,
                helperPayload("__to_bigint", { kind: "i64" }),
              ),
              fallbackReference,
            ),
          ),
        ),
      ),
    },
  ]);

  fctx.body.push(
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyTypeIdx },
        { op: "local.set", index: anyLocal },
        ...anyValue,
      ],
      else: classifiedValue,
    },
  );
  return externref;
}

/** Marshal an i32 boolean without first materializing the provider module's
 * private boolean box. Mirrored object fields live past the call boundary, so
 * their primitive payload must enter the canonical value carrier directly. */
function emitRuntimeEvalBooleanBoundaryWrap(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const externref: ValType = { kind: "externref" };
  const booleanLocal = allocLocal(fctx, `__runtime_eval_boolean_${fctx.locals.length}`, {
    kind: "i32",
    boolean: true,
  });
  fctx.body.push(
    { op: "local.set", index: booleanLocal },
    { op: "i32.const", value: RUNTIME_EVAL_VALUE_KIND_BOOLEAN },
    { op: "local.get", index: booleanLocal },
    { op: "f64.const", value: 0 },
    { op: "i64.const", value: 0n },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: ensureRuntimeEvalValueType(ctx) },
    { op: "extern.convert_any" },
  );
  return externref;
}

/** Provider-local inverse of the canonical result carrier. This is used by
 * canaries that exercise an exported envelope from inside the provider; user
 * modules decode the same shape in emitRuntimeEvalResultUnwrap. */
function emitRuntimeEvalResultBoundaryUnwrap(ctx: CodegenContext, fctx: FunctionContext, externref: ValType): ValType {
  ensureAnyHelpers(ctx);
  const typeIdx = ensureRuntimeEvalValueType(ctx);
  const valueLocal = allocLocal(fctx, `__runtime_eval_result_wrapped_${fctx.locals.length}`, externref);
  const carrierLocal = allocLocal(fctx, `__runtime_eval_result_carrier_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx,
  });
  fctx.body.push({ op: "local.set", index: valueLocal });

  const field = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: carrierLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx, fieldIdx },
  ];
  const kindCase = (kind: number, then: Instr[], otherwise: Instr[]): Instr[] => [
    ...field(0),
    { op: "i32.const", value: kind },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then,
      else: otherwise,
    },
  ];
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  const boxBigIntIdx = ctx.funcMap.get("__box_bigint");
  const decoded = kindCase(
    RUNTIME_EVAL_VALUE_KIND_REFERENCE,
    field(4),
    kindCase(
      RUNTIME_EVAL_VALUE_KIND_UNDEFINED,
      undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }],
      kindCase(
        RUNTIME_EVAL_VALUE_KIND_NULL,
        [{ op: "ref.null.extern" }],
        kindCase(
          RUNTIME_EVAL_VALUE_KIND_NUMBER,
          boxNumberIdx === undefined
            ? [{ op: "ref.null.extern" }]
            : [...field(2), { op: "call", funcIdx: boxNumberIdx }],
          kindCase(
            RUNTIME_EVAL_VALUE_KIND_BOOLEAN,
            boxBooleanIdx === undefined
              ? [{ op: "ref.null.extern" }]
              : [...field(1), { op: "call", funcIdx: boxBooleanIdx }],
            kindCase(
              RUNTIME_EVAL_VALUE_KIND_STRING,
              field(4),
              kindCase(
                RUNTIME_EVAL_VALUE_KIND_BIGINT,
                boxBigIntIdx === undefined
                  ? [{ op: "ref.null.extern" }]
                  : [...field(3), { op: "call", funcIdx: boxBigIntIdx }],
                field(4),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  fctx.body.push(
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx },
        { op: "local.set", index: carrierLocal },
        ...decoded,
      ],
      else: [{ op: "local.get", index: valueLocal }],
    },
  );
  return externref;
}

/** Provider-side half of the callback exception bridge. */
function tryRuntimeEvalInterpretedBoundaryIntrinsic(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  const calleeName = ts.isIdentifier(expr.expression) ? expr.expression.text : "";
  const wrapsGeneric = calleeName === "__runtime_eval_wrap_interpreted_callback";
  const wrapsIntrinsic = calleeName === "__runtime_eval_wrap_intrinsic_callback";
  const wrapsFunction = calleeName === "__runtime_eval_wrap_intrinsic_function_callback";
  const wraps = wrapsGeneric || wrapsIntrinsic || wrapsFunction;
  const unwraps = calleeName === "__runtime_eval_unwrap_interpreted_callback";
  const testsIntrinsic = calleeName === "__runtime_eval_is_intrinsic_callback";
  const wrapsResult = calleeName === "__runtime_eval_wrap_result";
  const wrapsBooleanResult = calleeName === "__runtime_eval_wrap_boolean_result";
  const unwrapsResult = calleeName === "__runtime_eval_unwrap_result";
  const testsAotCallable = calleeName === "__runtime_eval_is_aot_callable";
  if (
    (!ctx.standalone && !ctx.wasi) ||
    ctx.runtimeEvalCallableBoundaryEnabled !== true ||
    (!wraps &&
      !unwraps &&
      !testsIntrinsic &&
      !wrapsResult &&
      !wrapsBooleanResult &&
      !unwrapsResult &&
      !testsAotCallable) ||
    (wraps ? expr.arguments.length !== (wrapsFunction ? 3 : 4) : expr.arguments.length !== 1)
  ) {
    return undefined;
  }

  const externref: ValType = { kind: "externref" };
  if (wrapsBooleanResult) {
    const booleanType: ValType = { kind: "i32", boolean: true };
    const valueType = compileExpression(ctx, fctx, expr.arguments[0]!, booleanType);
    if (valueType && valueType.kind !== "i32") coerceType(ctx, fctx, valueType, booleanType);
    return emitRuntimeEvalBooleanBoundaryWrap(ctx, fctx);
  }
  const valueType = compileExpression(ctx, fctx, expr.arguments[0]!, externref);
  if (valueType && valueType.kind !== "externref") coerceType(ctx, fctx, valueType, externref);
  if (wrapsResult) return emitRuntimeEvalResultBoundaryWrap(ctx, fctx, externref);
  if (unwrapsResult) return emitRuntimeEvalResultBoundaryUnwrap(ctx, fctx, externref);
  if (testsAotCallable) {
    const carrier = ctx.runtimeEvalAotCallableCarrier ?? ensureRuntimeEvalAotCallableCarrierTypes(ctx);
    const valueLocal = allocLocal(fctx, `__runtime_eval_aot_predicate_${fctx.locals.length}`, externref);
    fctx.body.push({ op: "local.set", index: valueLocal });
    const brandMatch: Instr[] = [
      { op: "local.get", index: valueLocal },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: carrier.structTypeIdx },
      { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 3 },
      { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_A },
      { op: "i32.eq" },
      { op: "local.get", index: valueLocal },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: carrier.structTypeIdx },
      { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_B },
      { op: "i32.eq" },
      { op: "i32.and" },
    ];
    fctx.body.push(
      { op: "local.get", index: valueLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: carrier.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: brandMatch,
        else: [{ op: "i32.const", value: 0 }],
      },
    );
    return { kind: "i32" };
  }
  const typeIdx = ensureRuntimeEvalInterpretedCallbackType(ctx);
  const valueLocal = allocLocal(fctx, `__runtime_eval_boundary_value_${fctx.locals.length}`, externref);
  const candidateLocal = allocLocal(fctx, `__runtime_eval_boundary_candidate_${fctx.locals.length}`, externref);
  const markerLocal = allocLocal(fctx, `__runtime_eval_boundary_marker_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx,
  });
  fctx.body.push(
    { op: "local.set", index: valueLocal },
    { op: "local.get", index: valueLocal },
    { op: "local.set", index: candidateLocal },
  );
  let nameLocal = -1;
  let lengthLocal = -1;
  let constructorLocal = -1;
  if (wraps) {
    nameLocal = allocLocal(fctx, `__runtime_eval_boundary_name_${fctx.locals.length}`, externref);
    const nameType = compileExpression(ctx, fctx, expr.arguments[1]!, externref);
    if (nameType && nameType.kind !== "externref") coerceType(ctx, fctx, nameType, externref);
    fctx.body.push({ op: "local.set", index: nameLocal });
    lengthLocal = allocLocal(fctx, `__runtime_eval_boundary_length_${fctx.locals.length}`, { kind: "f64" });
    const lengthType = compileExpression(ctx, fctx, expr.arguments[2]!, { kind: "f64" });
    if (lengthType && lengthType.kind !== "f64") coerceType(ctx, fctx, lengthType, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: lengthLocal });
    if (!wrapsFunction) {
      constructorLocal = allocLocal(fctx, `__runtime_eval_boundary_constructor_${fctx.locals.length}`, externref);
      const constructorType = compileExpression(ctx, fctx, expr.arguments[3]!, externref);
      if (constructorType && constructorType.kind !== "externref") {
        coerceType(ctx, fctx, constructorType, externref);
      }
      fctx.body.push({ op: "local.set", index: constructorLocal });
      emitRuntimeEvalBoundaryCarrierPeel(ctx, fctx, constructorLocal, externref);
    }
  }
  emitRuntimeEvalBoundaryCarrierPeel(ctx, fctx, candidateLocal, externref);

  const setMarker = (): Instr[] => [
    { op: "local.get", index: candidateLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
    { op: "local.set", index: markerLocal },
  ];
  const markerBrandsMatch = (): Instr[] => [
    { op: "local.get", index: markerLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx, fieldIdx: 1 },
    { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A },
    { op: "i32.eq" },
    { op: "local.get", index: markerLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx, fieldIdx: 2 },
    { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B },
    { op: "i32.eq" },
    { op: "i32.and" },
  ];

  if (testsIntrinsic) {
    const i32: ValType = { kind: "i32" };
    fctx.body.push(
      { op: "local.get", index: candidateLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [
          ...setMarker(),
          ...markerBrandsMatch(),
          { op: "local.get", index: markerLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx, fieldIdx: 3 },
          { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_EVAL },
          { op: "i32.eq" },
          { op: "i32.and" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    );
    return i32;
  }

  if (unwraps) {
    fctx.body.push(
      { op: "local.get", index: candidateLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [
          ...setMarker(),
          ...markerBrandsMatch(),
          {
            op: "if",
            blockType: { kind: "val", type: externref },
            then: [
              { op: "local.get", index: markerLocal },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx, fieldIdx: 3 },
              { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_EVAL },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: externref },
                then: [{ op: "local.get", index: candidateLocal }],
                else: [
                  { op: "local.get", index: markerLocal },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx, fieldIdx: 0 },
                ],
              },
            ],
            else: [{ op: "local.get", index: valueLocal }],
          },
        ],
        // A non-marker reference may still have crossed an erased `any` slot
        // in a `$AnyValue` tag-6 carrier. Return the peeled candidate so the
        // interpreter can recognize a freshly-created raw closure before it
        // wraps that callback for a native HOF.
        else: [{ op: "local.get", index: candidateLocal }],
      },
    );
    return externref;
  }

  const markerKind = wrapsIntrinsic
    ? RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_EVAL
    : wrapsFunction
      ? RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION
      : RUNTIME_EVAL_INTERP_CALLBACK_KIND_GENERIC;
  const makeMarker = (): Instr[] => [
    { op: "local.get", index: candidateLocal },
    { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A },
    { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B },
    { op: "i32.const", value: markerKind },
    { op: "local.get", index: nameLocal },
    { op: "local.get", index: lengthLocal },
    ...((wrapsFunction
      ? [{ op: "ref.null.extern" }]
      : [{ op: "local.get", index: constructorLocal }]) satisfies Instr[]),
    { op: "struct.new", typeIdx },
    { op: "extern.convert_any" },
  ];
  fctx.body.push(
    { op: "local.get", index: candidateLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        ...setMarker(),
        ...markerBrandsMatch(),
        {
          op: "if",
          blockType: { kind: "val", type: externref },
          then: [{ op: "local.get", index: candidateLocal }],
          else: makeMarker(),
        },
      ],
      else: makeMarker(),
    },
  );
  return externref;
}

function compileCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  expectedType?: ValType,
): InnerResult {
  // (#3927 per-type layouts) Publish the allocation-label hint when this call
  // is a recorded label site (a transparent-factory call) of a split fnctor
  // family. Emitted BEFORE the callee/arguments compile: a labelled allocation
  // nested inside them consumes and resets the hint, so the outer allocation
  // degrades to the union layout — fat, never narrow. Net stack effect zero,
  // so this is safe on every lowering path below. No-op unless
  // `JS2WASM_FNCTOR_LAYOUT_EMIT` populated the site map.
  maybeEmitLayoutHint(ctx, fctx, expr);

  // Optional chaining on calls: obj?.method() and obj.method?.().
  //
  // In the TS AST the `?.` of `o?.m(args)` sits on the inner
  // PropertyAccessExpression, NOT on the CallExpression — only `o.m?.(args)`
  // sets `expr.questionDotToken`. Gating on the call token alone (#2049) missed
  // the common `o?.m(args)` form, so it fell into the regular method-call path
  // which evaluates arguments unconditionally and derefs the receiver (trapping
  // on a null class instance). Gate on the optional chain itself so both forms
  // route to the short-circuiting path.
  if (ts.isOptionalChain(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    return compileOptionalCallExpression(ctx, fctx, expr);
  }

  // (#4484 B) §7.3.2 RequireObjectCoercible — `undefined.toString()` /
  // `null["toString"]()`. Runs BEFORE every builtin-method interception below:
  // those dispatch on the METHOD name and never ask whether the receiver can
  // carry a method, so all four nullish call forms returned without throwing.
  // Syntactic receivers only (see the module header).
  {
    const r = tryEmitNullishReceiverCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  {
    const r = tryRuntimeIsProxyIntrinsic(ctx, fctx, expr);
    if (r !== undefined) return r;
  }
  {
    const r = tryRuntimeEvalApplyCallableIntrinsic(ctx, fctx, expr);
    if (r !== undefined) return r;
  }
  {
    const r = tryRuntimeEvalInterpretedBoundaryIntrinsic(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#1732/#2180) Calling a built-in non-constructor namespace (Math, JSON,
  // Reflect, Atomics, Proxy) as a function must throw TypeError ("no [[Call]]").
  // Extracted to calls-guards.ts (#742).
  {
    const r = tryNamespaceNonCallable(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#4221) §13.3.6.2 steps 4-5 — a callee whose static type PROVES it is a
  // primitive (and so carries no [[Call]]) throws TypeError instead of falling
  // to the last-resort arm's silent `undefined`. Extracted to calls-guards.ts.
  {
    const r = tryNonCallableValueCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#4483) §10.2.1 [[Call]] step 2 — a `class` constructor invoked without
  // `new` throws TypeError. Sits beside the #4221 primitive guard because it
  // answers the same question for the one callable-looking value the checker
  // types as constructable. Declines for ambient (`.d.ts`) classes, which is
  // how the callable builtins (`Number(1)`, `Error(m)`) are modelled.
  {
    const r = tryEmitClassConstructorCallWithoutNew(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // `Error(msg)` / `TypeError(msg)` / … without `new` — spec-identical to the
  // `new` form (§20.5.1.1). Without this arm the call produced a silent
  // `ref.null.extern`, so the following `.message` read null-trapped.
  {
    const r = tryCompileErrorCtorCallWithoutNew(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#4640 D7) `Date(...)` without `new` — §21.4.2.1 returns ToDateString(now),
  // a String, ignoring every argument. Not spec-identical to the `new` form (so
  // it cannot delegate like the Error arm above); without it the call produced a
  // silent `ref.null.extern` under a checker type of `string`, and the next
  // `Date.parse(...)` illegal-cast TRAPPED.
  {
    const r = tryCompileDateCallWithoutNew(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#4732/#5151) `Map(...)`/`Set(...)`/`WeakMap(...)`/`WeakSet(...)` have no
  // [[Call]] — §24.1.1.1 step 1 and siblings require `new`.
  {
    const r = tryCompileCollectionCtorCallWithoutNew(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#5143) `Promise(...)` / `Promise.call(...)` — §27.2.3.1 step 1 requires
  // `new`. Standalone-carrier gated inside the helper.
  {
    const r = tryCompilePromiseCallWithoutNew(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#1540) JSX runtime call intercept — `_jsx` / `_jsxs` / `_jsxDEV`. Routed to
  // the matching `__jsx_runtime_*` host import. Extracted to calls-guards.ts (#742).
  {
    const r = tryJsxRuntimeCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#4614) `ns.f(args)` where `ns` is a NamespaceImport of a COMPILED sibling
  // module. The namespace binding has no runtime value (it compiled to
  // `ref.null extern`), so the generic method lane became
  // `__extern_method_call(null, "f", …)` — every call through `import * as`
  // threw (cookie's vitest harness: 65/63740). Namespace member access is
  // statically resolvable per ESM semantics: resolve the alias to the target
  // FunctionDeclaration and re-enter as the equivalent named call, which
  // carries the full identifier-call lowering (arguments protocol, rest,
  // dispatch). Ambient/external declarations (no body) and non-function
  // exports decline to the legacy lane.
  {
    const r = tryRuntimeNamespaceMemberCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // #2632 Phase 1 — WASI event-loop timers / microtasks. setTimeout/setInterval/
  // clearTimeout/clearInterval/queueMicrotask lower onto the timer heap + run-loop
  // reactor (async-scheduler.ts). Only fires under --target wasi; everything else
  // falls through to the JS-host import path unchanged.
  {
    const r = tryWasiTimerCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#2924) Constant `Function("<params>", …, "<body>")` compile-away — both
  // the plain-call value form and the immediate-call form
  // (`new Function(...)(args)` / `Function(...)(args)`). Non-constant args or
  // a local `Function` shadow fall through to the existing paths.
  {
    const r = tryStaticFunctionCtorCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // (#4650) JS-host VALUE form `Function(<args>)` called as a plain function —
  // §20.2.1.1 makes it identical to `new Function(...)`, but only the
  // NewExpression path routed a declined compile-away to the host shim.
  {
    const r = tryHostDynamicFunctionCtorValue(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // #2928 — dynamic standalone Function(...) value form, plus the immediate
  // `new Function(...)(args)` / `Function(...)(args)` form. Seed the canonical
  // runtime callable before the dynamic-dispatch candidate scan.
  const immediateFunctionCtor = isFunctionCtorImmediateCall(expr, ctx.checker);
  {
    const r = tryStandaloneDynamicFunctionCtorValue(ctx, fctx, expr);
    if (r !== undefined) return r;
    if (ctx.standalone && immediateFunctionCtor && ensureRuntimeEvalCallableCarrier(ctx, fctx)) {
      const dyn = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
      if (dyn !== null) return dyn;
    }
  }

  // (#2960) DYNAMIC immediate-call `new Function(<non-const>)(args)` /
  // `Function(<non-const>)(args)` in JS-host mode. The constant compile-away
  // above declined (non-constant args), so the callee compiles to the
  // meta-circular shim's real host-callable value. A wasm-side `f(args)` on a
  // plain host-function externref returns undefined (the general any-callee
  // host-function limitation), so route the call through the `__call_function`
  // host helper (the same packer bound functions use).
  if (!noJsHost(ctx) && !ctx.nativeStrings && immediateFunctionCtor) {
    const r = emitBoundFunctionCall(ctx, fctx, expr);
    if (r !== null) return r;
  }

  // (#2921) `__drain_microtasks()` — explicit microtask-queue drain intrinsic
  // (banked from the closed #2367/#2867 PR-B; the funcIdx-shift half already
  // landed via #2918). Lets a standalone/WASI embedder — and, once the carrier
  // is activated for `--target standalone` (blocked on #2864's native $Frame),
  // the test262 harness verdict-read — flush pending native `$Promise` reactions
  // before observing module state. Native `.then` reactions are QUEUED, not run
  // synchronously, so assertions inside them set state only once the queue drains.
  //
  // Fully INERT until something *calls* it: it emits the native drain ONLY when
  // the microtask queue is already registered (some `.then`/Promise lowered
  // earlier on a carrier target, `getDrainFuncIdxForWasiStart` non-null).
  // Otherwise — every JS-host compile (the host owns its own microtask queue),
  // and any carrier module with no Promise — it is a silent VOID no-op that emits
  // NOTHING, so the identifier can be introduced into a wrapper unconditionally
  // without leaking an import, forcing queue infra into Promise-free modules, or
  // disturbing JS-host / gc / linear codegen (byte-identical off the carrier path).
  if (
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "__drain_microtasks" &&
    expr.arguments.length === 0
  ) {
    const drainIdx = getDrainFuncIdxForWasiStart(ctx);
    if (drainIdx !== null) {
      fctx.body.push({ op: "call", funcIdx: drainIdx });
    }
    return VOID_RESULT;
  }

  // (#3146) Iterator-statics prelude intrinsics (`__j2w_iter_*`) — lower onto
  // the native iterator runtime under the host-free targets. Byte-neutral for
  // every program the prelude was not injected into.
  {
    const r = tryIteratorStaticsIntrinsicCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // Node-shaped process APIs are lowered in their own module so the generic
  // call-expression compiler does not accumulate host API special cases.
  const nodeProcessCall = tryCompileNodeProcessCall(ctx, fctx, expr);
  if (nodeProcessCall !== undefined) return nodeProcessCall;

  // #2657 — raw `wasi_snapshot_preview1` fd_read/fd_write → direct WASI import
  // call (the most honest pure-WASI-P1 path; no node:fs surface). Sits before the
  // node:fs path; byte-neutral unless the source imports the raw WASI module.
  const rawWasiCall = tryCompileRawWasiCall(ctx, fctx, expr);
  if (rawWasiCall !== undefined) return rawWasiCall;

  // #2631 — node:fs fd-based readSync/writeSync → `node:fs` shim calls.
  const nodeFsCall = tryCompileNodeFsCall(ctx, fctx, expr);
  if (nodeFsCall !== undefined) return nodeFsCall;

  // #2684 — Deno synchronous stdio (`Deno.stdin.readSync` /
  // `Deno.{stdout,stderr}.writeSync`) → direct WASI fd_read/fd_write. Ambient
  // global, recognized by member-call shape; byte-neutral unless `Deno.` is used.
  const denoStdioCall = tryCompileDenoStdioCall(ctx, fctx, expr);
  if (denoStdioCall !== undefined) return denoStdioCall;

  // RegExp(pattern, flags) called without `new`. Extracted to calls-guards.ts (#742).
  {
    const r = tryRegExpConstructorCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // `Object(x)` called without `new` — §20.1.1.1 / §7.1.18 ToObject.
  // Extracted to calls-guards.ts (#742).
  {
    const r = tryObjectCoercionCall(ctx, fctx, expr);
    if (r !== undefined) return r;
  }

  // Optional chaining on direct call: fn?.()
  if (expr.questionDotToken && ts.isIdentifier(expr.expression)) {
    return compileOptionalDirectCall(ctx, fctx, expr);
  }

  const globalScriptEvalCallee = unwrapTransparent(expr.expression);
  if (
    ctx.standalone &&
    ts.isIdentifier(globalScriptEvalCallee) &&
    globalScriptEvalCallee.text === "__js2wasm_global_script_eval"
  ) {
    const runtimeScriptEval = emitStandaloneGlobalScriptEvalRuntime(ctx, fctx, expr.arguments);
    if (runtimeScriptEval !== undefined) return runtimeScriptEval;
  }
  // Test262's `$262.evalScript` is a host-facing global-Script entry, not an
  // ordinary open-object method. Lower the direct canonical spelling before
  // native `$Object` method dispatch would try to recover a closure from the
  // harness object. Aliased reads still execute the shim's intrinsic helper.
  if (
    ctx.standalone &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "evalScript" &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "$262"
  ) {
    const runtimeScriptEval = emitStandaloneGlobalScriptEvalRuntime(ctx, fctx, expr.arguments);
    if (runtimeScriptEval !== undefined) return runtimeScriptEval;
  }
  // eval(...) — first try static inlining (#1163): if the source argument is
  // a compile-time-constant string, parse it and splice the AST inline at the
  // call site.  This is the zero-runtime-cost path.  If the argument is not
  // a constant (or parsing fails), fall through to __extern_eval (#1006/#1164).
  // Direct eval may use the caller-scope splice. Indirect eval keeps the
  // established literal-only compile-away surface; dynamic sources route
  // through the realm-global runtime path.
  // In standalone/WASI mode the host import is unavailable and will trap at
  // instantiation time — callers that need eval must use a JS host.
  //
  // #1164: signature is `(externref src, i32 isDirect) -> externref`.  The
  // isDirect flag (1 = direct call, 0 = indirect) lets the host shim
  // preserve ECMA-262 §19.2.1 scope semantics — direct eval has access to
  // the caller's lexical scope, indirect eval runs in global scope.
  {
    const evalKind = classifyEvalCallExpression(expr, ctx.checker);
    if (evalKind !== "none") {
      // Hot-loop eval shapes compile away before the general runtime boundary.
      const commentOnly = tryEvalAsCommentPeephole(ctx, fctx, expr);
      if (commentOnly !== undefined) return commentOnly;
      const rewritten = tryEvalAsRegExpPeephole(ctx, fctx, expr);
      if (rewritten !== undefined) return rewritten;
      const inlined = tryStaticEvalInline(ctx, fctx, expr, evalKind === "direct");
      if (inlined !== undefined) return inlined;
      // #2928/#2929 — direct eval adds live caller cells to indirect eval's global environment.
      const runtimeEval =
        evalKind === "direct"
          ? directEvalRunsAtScriptGlobal(expr, ctx)
            ? emitStandaloneIndirectEvalRuntime(ctx, fctx, expr.arguments)
            : ctx.directEvalMode === "reified-host"
              ? emitStandaloneDirectEvalRuntime(ctx, fctx, expr)
              : ctx.standalone && ensureRuntimeEvalCallableCarrier(ctx, fctx)
                ? emitStandaloneDirectEvalRuntime(ctx, fctx, expr)
                : undefined
          : emitStandaloneIndirectEvalRuntime(ctx, fctx, expr.arguments);
      if (runtimeEval !== undefined) return runtimeEval;
      // (#2960) WASI (until its linker grows the provider), or a standalone
      // route that could not materialize its runtime ABI: refuse the
      // unsatisfiable host import with a catchable call-site throw.
      if (noJsHost(ctx)) {
        // (#4195) Wording lives with the provider gate that decides it.
        const refusal = dynamicEvalRefusalMessages(ctx);
        reportError(ctx, expr, refusal.warning, "warning");
        // Evaluate the argument expressions for their side effects first.
        for (const a of expr.arguments) {
          const t = compileExpression(ctx, fctx, a);
          if (t !== null) fctx.body.push({ op: "drop" });
        }
        emitThrowTypeError(ctx, fctx, refusal.thrown);
        // The throw is stack-polymorphic; return the nominal eval result type.
        return { kind: "externref" };
      }
      let evalIdx = ctx.funcMap.get("__extern_eval");
      if (evalIdx === undefined) {
        const importsBefore = ctx.numImportFuncs;
        const evalType = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "__extern_eval", { kind: "func", typeIdx: evalType });
        shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
        evalIdx = ctx.funcMap.get("__extern_eval");
      }
      if (evalIdx === undefined) {
        fctx.body.push({ op: "unreachable" });
        return null;
      }
      if (expr.arguments.length === 0) {
        // eval() with no args returns undefined per spec.  Avoid the host
        // round-trip entirely.
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      const srcArg = expr.arguments[0]!;
      const srcType = compileExpression(ctx, fctx, srcArg);
      if (srcType && srcType.kind !== "externref") {
        coerceType(ctx, fctx, srcType, { kind: "externref" });
      }
      // Push isDirect flag.
      fctx.body.push({ op: "i32.const", value: evalKind === "direct" ? 1 : 0 });
      for (let ai = 1; ai < expr.arguments.length; ai++) {
        const extraType = compileExpression(ctx, fctx, expr.arguments[ai]!);
        if (extraType) fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "call", funcIdx: evalIdx });
      return { kind: "externref" };
    }
  }

  // import.defer(...) / import.source(...) — Stage 3 proposals not implemented.
  // Without this guard, falling through to type-resolution lower in the call
  // pipeline triggers `Debug Failure: Trying to get the type of import.defer
  // in import.defer(...)` from the TypeScript checker (it doesn't know how to
  // type these meta-properties). Emit a clean compile error instead — for
  // negative parse/early SyntaxError tests this counts as the expected error
  // (compilation rejecting the source). #1315.
  if (
    ts.isMetaProperty(expr.expression) &&
    expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    (expr.expression.name.text === "defer" || expr.expression.name.text === "source")
  ) {
    reportError(
      ctx,
      expr,
      `SyntaxError: import.${expr.expression.name.text}(...) is not supported (Stage 3 proposal — import-defer / source-phase-imports)`,
    );
    return null;
  }

  // Dynamic import() — delegate to __dynamic_import host import.
  // Takes a specifier (externref string) and returns an externref (Promise).
  // #3494 — standalone has no host loader, while compileMulti does not yet
  // represent deferred module records or module namespace objects. Never emit
  // env.__dynamic_import or manufacture an always-fulfilled placeholder.
  //
  // #3509 — an ordinary function body is deferred: compiling/creating it does
  // not require a loader. Preserve that property with a host-free, catchable
  // runtime throw if execution reaches import(). Eager/top-level and async
  // cases retain #3494's fatal diagnostic until their Promise/module semantics
  // can be implemented honestly.
  if (expr.expression.kind === ts.SyntaxKind.ImportKeyword) {
    if (ctx.standalone) {
      if (canDeferStandaloneDynamicImport(fctx)) {
        reportError(
          ctx,
          expr,
          "Warning: standalone dynamic import has no module loader and will throw if this function is invoked (#3509; module evaluation #3494)",
          "warning",
        );
        // Preserve argument side effects and nesting order before the loader
        // failure. A nested import emits its own terminal throw here; Wasm's
        // stack-polymorphic unreachable tail keeps the enclosing expression
        // valid without inventing a result.
        for (const argument of expr.arguments) {
          const argumentType = compileExpression(ctx, fctx, argument);
          if (argumentType !== null) fctx.body.push({ op: "drop" });
        }
        emitThrowTypeError(ctx, fctx, "Standalone dynamic import requires a module loader (#3494)");
        return { kind: "externref" };
      }
      reportError(
        ctx,
        expr,
        "Standalone dynamic import is unsupported until compileMulti provides internal module records and namespace objects",
      );
      return null;
    }
    // Ensure __dynamic_import is registered
    let dynIdx = ctx.funcMap.get("__dynamic_import");
    if (dynIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const dynType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__dynamic_import", { kind: "func", typeIdx: dynType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      dynIdx = ctx.funcMap.get("__dynamic_import");
    }
    if (dynIdx === undefined) {
      fctx.body.push({ op: "unreachable" });
      return null;
    }
    // Compile the specifier argument
    const specArg = expr.arguments[0];
    if (specArg) {
      const specResult = compileExpression(ctx, fctx, specArg);
      // Coerce to externref if needed
      if (specResult && specResult.kind !== "externref") {
        coerceType(ctx, fctx, specResult, { kind: "externref" });
      }
    } else {
      // No argument — pass undefined (null externref)
      fctx.body.push({ op: "ref.null.extern" });
    }

    // Evaluate remaining arguments (e.g. import attributes/options) for side effects.
    // Per spec, the second argument (optionsExpression) is evaluated before the
    // host import is performed. If it throws, the throw propagates synchronously.
    // We evaluate and drop the result since __dynamic_import only takes the specifier.
    for (let ai = 1; ai < expr.arguments.length; ai++) {
      const extraArg = expr.arguments[ai];
      const extraResult = compileExpression(ctx, fctx, extraArg);
      // Drop the value from the stack if the expression produced one
      if (extraResult) {
        fctx.body.push({ op: "drop" });
      }
    }

    fctx.body.push({ op: "call", funcIdx: dynIdx });
    return { kind: "externref" };
  }

  // Unwrap parenthesized callee: (fn)(...), ((obj.method))(...) etc.
  // This handles patterns like (0, fn)() which are already handled below,
  // but also (fn)(), ((fn))(), (obj.method)() etc. which would otherwise fail.
  if (ts.isParenthesizedExpression(expr.expression)) {
    let unwrapped: ts.Expression = expr.expression;
    // Strip parentheses AND type-only callee wrappers (`as T`, `satisfies T`,
    // `<T>x`). A type cast is a compile-time no-op, so `(eval as any)()` must
    // behave exactly like `eval()`. Critically, `AsExpression` /
    // `SatisfiesExpression` / `TypeAssertion` are NOT `LeftHandSideExpression`s,
    // so if we left them wrapped and fell through to the generic synthetic-call
    // path below, `ts.factory.createCallExpression` would re-wrap the callee in
    // a `ParenthesizedExpression` and the re-entry would rebuild an identical
    // synthetic call → unbounded recursion (#3005). Stripping them here lets the
    // inner expression reach its normal callee handling (e.g. eval special-casing).
    while (
      ts.isParenthesizedExpression(unwrapped) ||
      ts.isAsExpression(unwrapped) ||
      ts.isSatisfiesExpression(unwrapped) ||
      ts.isTypeAssertionExpression(unwrapped)
    ) {
      unwrapped = unwrapped.expression;
    }
    // Only unwrap if it's NOT a function expression or arrow (those are IIFEs, handled later)
    // and NOT a binary/comma expression (handled separately below)
    if (
      !ts.isFunctionExpression(unwrapped) &&
      !ts.isArrowFunction(unwrapped) &&
      !(ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken)
    ) {
      // Handle conditional callee inline: (cond ? fn1 : fn2)(args)
      // Cannot create a synthetic call because ts.factory wraps non-LeftHandSide
      // expressions in ParenthesizedExpression, causing infinite recursion.
      if (ts.isConditionalExpression(unwrapped)) {
        return compileConditionalCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle assignment/binary expressions as callee: (x = fn)(), (a || fn)()
      // These are non-LeftHandSideExpressions, so ts.factory.createCallExpression
      // would re-wrap them in ParenthesizedExpression, causing infinite recursion.
      // Instead, compile the expression for its side effects and value, then use
      // the generic closure-matching path to call the result.
      if (ts.isBinaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      // Handle prefix/postfix unary as callee (rare but possible)
      if (ts.isPrefixUnaryExpression(unwrapped) || ts.isPostfixUnaryExpression(unwrapped)) {
        return compileExpressionCallee(ctx, fctx, expr, unwrapped);
      }

      const syntheticCall = ts.factory.createCallExpression(
        unwrapped as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Unwrap `expr!(...)` non-null assertions on the callee (#1298). The TS type
  // of NonNullExpression is the original type minus null/undefined, so the
  // underlying PropertyAccessExpression / Identifier / etc. dispatch sees a
  // callable type. Mirrors the ParenthesizedExpression unwrap above.
  if (ts.isNonNullExpression(expr.expression)) {
    let inner: ts.Expression = expr.expression.expression;
    // Strip nested non-null assertions: `obj.fn!!(...)`
    while (ts.isNonNullExpression(inner)) {
      inner = inner.expression;
    }
    // Only build a synthetic CallExpression for LeftHandSide-shaped inner
    // expressions; non-LHS (e.g. binary, conditional) would be re-wrapped in
    // ParenthesizedExpression by ts.factory and infinite-recurse. For those,
    // fall through to compileExpressionCallee.
    if (
      !ts.isFunctionExpression(inner) &&
      !ts.isArrowFunction(inner) &&
      !ts.isBinaryExpression(inner) &&
      !ts.isConditionalExpression(inner) &&
      !ts.isPrefixUnaryExpression(inner) &&
      !ts.isPostfixUnaryExpression(inner)
    ) {
      const syntheticCall = ts.factory.createCallExpression(
        inner as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Handle super.method() calls — resolve to ParentClass_method with this as first arg
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return compileSuperMethodCall(ctx, fctx, expr);
  }

  // (#5153 F) A NESTED `super(...)` — one that is not a top-level statement of
  // the constructor body, e.g. inside a `try`. `class-bodies.ts` intercepts
  // only the statement form (its loop matches `ExpressionStatement` →
  // `CallExpression` → `SuperKeyword`), so this shape reached the generic
  // callee dispatch and emitted NOTHING: the parent constructor never ran and
  // an abrupt completion inside it could not be caught
  // (`call-construct-error.js`). Route it to the same lowering.
  //
  // Own-field initializers are deliberately NOT re-run here — the statement
  // site owns that sequencing, and this arm only replaces a no-op.
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword && fctx.isConstructor === true) {
    const enclosingClass = resolveEnclosingClassName(fctx);
    const thisLocal = fctx.localMap.get("this");
    if (enclosingClass !== undefined && thisLocal !== undefined) {
      compileSuperCall(ctx, fctx, enclosingClass, thisLocal, expr, []);
      return VOID_RESULT;
    }
  }

  // (#1467) AggregateError(errors, message, options?) — called WITHOUT `new`.
  // Per ES §20.5.7.1, AggregateError called as a function must construct
  // normally (same effective semantics as `new`). Mirror the codegen in
  // new-super.ts so the without-new and with-new failures resolve together.
  // Must run BEFORE the property-access dispatch since the expression is a
  // bare identifier, and BEFORE the BUILTIN_CLASS_NAMES generic path which
  // would otherwise emit a host-method call without spec coercion.
  // Unwrap parenthesized expressions and as/satisfies casts so
  // `(AggregateError as any)([], 'msg')` also reaches this dispatch.
  let _aggCallee: ts.Expression = expr.expression;
  while (
    ts.isParenthesizedExpression(_aggCallee) ||
    ts.isAsExpression(_aggCallee) ||
    ts.isTypeAssertionExpression(_aggCallee) ||
    ts.isSatisfiesExpression(_aggCallee) ||
    ts.isNonNullExpression(_aggCallee)
  ) {
    _aggCallee = (_aggCallee as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(_aggCallee) && _aggCallee.text === "AggregateError") {
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      const errorsType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      if (errorsType && errorsType.kind !== "externref") {
        coerceType(ctx, fctx, errorsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    if (args.length >= 2) {
      const msgType = compileExpression(ctx, fctx, args[1]!, { kind: "externref" });
      if (msgType && msgType.kind !== "externref") {
        coerceType(ctx, fctx, msgType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    if (args.length >= 3) {
      const optsType = compileExpression(ctx, fctx, args[2]!, { kind: "externref" });
      if (optsType && optsType.kind !== "externref") {
        coerceType(ctx, fctx, optsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_AggregateError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // (#1634) SuppressedError(error, suppressed, message, options?) — called
  // WITHOUT `new`. Per ES §20.5.10.1, called as a function it constructs
  // normally. Mirror the new-super.ts codegen so without-new and with-new
  // resolve together. Unwrap parenthesized/cast wrappers like the AggregateError
  // dispatch above.
  let _suppCallee: ts.Expression = expr.expression;
  while (
    ts.isParenthesizedExpression(_suppCallee) ||
    ts.isAsExpression(_suppCallee) ||
    ts.isTypeAssertionExpression(_suppCallee) ||
    ts.isSatisfiesExpression(_suppCallee) ||
    ts.isNonNullExpression(_suppCallee)
  ) {
    _suppCallee = (_suppCallee as ts.AsExpression | ts.ParenthesizedExpression).expression;
  }
  if (ts.isIdentifier(_suppCallee) && _suppCallee.text === "SuppressedError") {
    const args = expr.arguments ?? [];
    for (let i = 0; i < 4; i++) {
      if (args.length > i) {
        const t = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
        if (t && t.kind !== "externref") {
          coerceType(ctx, fctx, t, { kind: "externref" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_SuppressedError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // (#4491) `this.f(…)` / `this["f"](…)` where `f` is a `var`-declared script
  // global. Must run BEFORE the receiver-type method dispatch below: that arm
  // resolves the member against the checker's `typeof globalThis` struct, which
  // has no field for a `var` global, and its resolved-method-is-null guard turns
  // the miss into `TypeError: called value is not a function`. The member READ
  // has answered from the module global since #4500 Slice A; this is the CALL
  // twin. Narrowly gated (see the module), so every other call is unchanged.
  {
    const realmGlobalCall = tryEmitRealmGlobalMemberCall(ctx, fctx, expr);
    if (realmGlobalCall !== undefined) return realmGlobalCall;
  }

  // Handle property access calls: console.log, Math.xxx, extern methods
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const propAccess = expr.expression;

    // (#671 W1) A callable field on the planner-selected open `with` target
    // is runtime state just like a data field. Use the canonical open-object
    // method provider instead of resolving the literal's stale static method;
    // this retains both post-with replacement, repeated-read identity, and
    // the full argument list in both lanes.
    if (
      !ts.isPrivateIdentifier(propAccess.name) &&
      (isIrWithOpenObjectTargetReceiver(ctx, propAccess.expression) ||
        (ctx.standalone &&
          ts.isIdentifier(propAccess.expression) &&
          ctx.sloppyImplicitGlobals?.has(propAccess.expression.text) === true &&
          chainRootIsGrowable(ctx, propAccess.expression)))
    ) {
      const openTargetCall = emitFnctorSubclassDynamicMethodCall(ctx, fctx, expr, propAccess, propAccess.name.text);
      if (openTargetCall !== undefined) return openTargetCall;
    }

    // (#2838 L6) Dynamic-`this` method-call dispatch. When the receiver is `this`
    // and the runtime `this` is DYNAMIC (the fctx `this` local is not a concrete
    // struct ref — e.g. inside a runtime-installed accessor getter whose body runs
    // with `__current_this` set, NOT a real typed method) BUT TypeScript has
    // contextually typed `this` as a concrete struct/object (acorn's getter `this`
    // is typed as the descriptor literal `__anon_N`), the static method-dispatch
    // arms below resolve the receiver against that WRONG nominal type. None match
    // the real method, so the call silently degrades to a member-get-then-drop
    // (returns null) and the method never runs — the acorn `this.currentVarScope()`
    // wall (L6). Route such calls through `__extern_method_call`, which binds the
    // receiver via `__current_this` and walks the runtime prototype chain
    // (`_fnctorProtoLookup`) — exactly what the any/externref-receiver fallback
    // already does for a correctly-`any`-typed receiver. The predicate is precise:
    // `resolveThisStructName` (the fctx local's actual ref type) is undefined
    // (dynamic), yet `resolveStructName` of the TS type IS a struct (the lie) — so
    // a genuine typed class/fnctor method (truth AGREES → struct name defined) is
    // never intercepted, and a truly-`any`/module-level `this` (no struct either
    // way) is left to the existing fallback. JS-host only (the dynamic MOP path);
    // the reflective `.call`/`.apply`/`.bind` forms keep their dedicated handlers.
    {
      const mName = propAccess.name.text;
      // Fire ONLY for the descriptor-literal mistype (the acorn getter case): the
      // fctx `this` is dynamic (not a concrete struct ref) AND TS typed it as an
      // `__anon` descriptor object. A genuine typed method (concrete `this`) or a
      // static-method `this` (TS = a real `typeof C` struct, needed for static /
      // private dispatch) is NEVER intercepted — mirrors the L5 read-side rule.
      const tsThisName =
        propAccess.expression.kind === ts.SyntaxKind.ThisKeyword
          ? resolveStructName(ctx, ctx.checker.getTypeAtLocation(propAccess.expression))
          : undefined;
      if (
        !noJsHost(ctx) &&
        propAccess.expression.kind === ts.SyntaxKind.ThisKeyword &&
        // Private members (`this.#m()`) are brand-checked WasmGC elements the host
        // MOP can never see — never route them dynamically (would break static/
        // instance private-method dispatch). The acorn getter chain is all public.
        !ts.isPrivateIdentifier(propAccess.name) &&
        mName !== "call" &&
        mName !== "apply" &&
        mName !== "bind" &&
        resolveThisStructName(ctx, fctx) === undefined &&
        tsThisName !== undefined &&
        // ONLY the descriptor-literal anon struct (`__anon_<n>`, the acorn getter's
        // `this`), NEVER an anonymous CLASS struct (`__anonClass_<n>`) whose
        // static/instance method dispatch must stay static (the #2325 regression).
        tsThisName.startsWith("__anon_")
      ) {
        const dynThisResult = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, mName, expr);
        if (dynThisResult !== null) return dynThisResult;
      }
    }

    const standaloneRegExpExec = tryCompileStandaloneRegExpExec(ctx, fctx, expr, propAccess);
    if (standaloneRegExpExec !== undefined) return standaloneRegExpExec;

    const standaloneRegExpTest = tryCompileStandaloneRegExpTest(ctx, fctx, expr, propAccess);
    if (standaloneRegExpTest !== undefined) return standaloneRegExpTest;

    const standaloneRegExpToString = tryCompileStandaloneRegExpToString(ctx, fctx, expr, propAccess);
    if (standaloneRegExpToString !== undefined) return standaloneRegExpToString;

    // (#5142) `re.compile(pattern, flags)` — Annex B §B.2.4.1 in-place
    // re-initialization. Without an arm here the call fell through to a generic
    // path that silently no-op'd.
    const standaloneRegExpCompile = tryCompileStandaloneRegExpCompile(ctx, fctx, expr, propAccess);
    if (standaloneRegExpCompile !== undefined) return standaloneRegExpCompile;

    // Handle Array.prototype.METHOD.call(obj, ...args) — inline as array method on shape-inferred obj
    {
      const callResult = compileArrayPrototypeCall(ctx, fctx, expr, propAccess);
      if (callResult !== undefined) return callResult;
    }

    const indirectBind = tryCompileIndirectFunctionBindCall(ctx, fctx, expr, propAccess);
    if (indirectBind !== undefined) return indirectBind;

    // Handle fn.bind(thisArg, ...partialArgs).
    //
    // Native-first/standalone: mint a Wasm-owned `$__bound_fn` carrying target,
    // bound receiver and partial arguments. A definitely compiled target stays
    // entirely in Wasm; a dynamic caller-owned JS target is serviced only by
    // the admitted boundary path. Compatibility keeps `__bind_function` and
    // the engine-owned bound-function exotic, including `.name`, `.length`,
    // [[Call]] and [[Construct]].
    //
    // Narrowing: only fires when the receiver's TS type has call signatures. This
    // preserves the legacy "throws on non-function receiver" behavior that a
    // handful of test262 assertions implicitly rely on
    // (e.g. `assert.throws(TypeError, () => nonFn.bind())` and `JSON.bind()`).
    //
    // Exclusion: fn.bind(...)(...) (immediate bind+call) is already handled later
    // with proper argument threading — don't intercept it here.
    if (propAccess.name.text === "bind" && !(ts.isCallExpression(expr.parent) && expr.parent.expression === expr)) {
      const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const recvHasCallSig = (recvTsType?.getCallSignatures?.()?.length ?? 0) > 0;
      if (recvHasCallSig) {
        const bindResult = compileFunctionBind(ctx, fctx, expr, propAccess);
        if (bindResult !== undefined) return bindResult;
      }
    }

    // Handle fn.call(thisArg, ...args) and fn.apply(thisArg, argsArray)
    // For standalone functions (no `this`), drop thisArg and call directly.
    // For class methods, use thisArg as the receiver.
    if (propAccess.name.text === "call" || propAccess.name.text === "apply") {
      const isCall = propAccess.name.text === "call";
      const innerExpr = propAccess.expression;

      // (#4076) `<Ctor>.prototype.<m>.call/apply(<invalid this>, …)` is a
      // compile-time-decidable TypeError. MUST stay first — arms below claim the
      // shape and answer without running step 1. Rationale: builtin-prototype-brand.ts.
      const compileOneArg = (a: ts.Expression) => compileExpression(ctx, fctx, a);
      const invalidThis = tryBorrowedPrototypeNullishThisThrow(ctx, fctx, expr, innerExpr, compileOneArg, expectedType);
      if (invalidThis !== undefined) return invalidThis;

      // (#5143) …and the other statically-decidable bad receiver: a builtin
      // PROTOTYPE object handed to a brand-checked method
      // (`Promise.prototype.then.call(Promise.prototype, …)`).
      const brandThis = tryBorrowedPrototypeBrandThisThrow(ctx, fctx, expr, innerExpr, compileOneArg, expectedType);
      if (brandThis !== undefined) return brandThis;

      // (#4483) `Function.call(thisArg, …body)` / `Function.apply(thisArg, [body])`
      // are reflective spellings of the Function CONSTRUCTOR, whose [[Call]]
      // discards `this` (§15.3.1). Reshape to `Function(…body)` so the ordinary
      // constructor route runs; otherwise `Function.call` is a dynamic builtin
      // member read that standalone refuses at compile time via `__get_builtin`.
      {
        const ctorReshape = reshapeFunctionCtorReflectiveCall(ctx.oracle, expr, propAccess);
        if (ctorReshape !== undefined) return compileCallExpression(ctx, fctx, ctorReshape, expectedType);
      }

      // (#4483) §20.2.3.1 step 4 → CreateListFromArrayLike step 2: an argArray
      // that is provably a non-null primitive is a TypeError, before the callee
      // runs. Declines for null/undefined (step 3: empty list) and for anything
      // the oracle cannot prove primitive.
      {
        const badArgArray = tryEmitApplyArgArrayTypeError(ctx, fctx, expr, propAccess);
        if (badArgArray !== undefined) return badArgArray;
      }

      // (#4656) A dynamic standalone Function value is represented by a
      // caller-owned runtime-eval carrier.  Its provider target deliberately
      // does not mirror Function.prototype, so the ordinary `innerExpr.apply`
      // property lookup misses even though the carrier is callable.  Route the
      // reflective operation through the same arity bridge used by dynamic
      // calls, retaining the explicit thisArg and the real argument vector.
      // Keep this syntactic and standalone-only: constant Function forms are
      // harmless here (the bridge still invokes their compiled closure), while
      // arbitrary callable values continue through the established lowerings.
      // (#4246) §10.2.1.2 step 5.b — a SLOPPY callee binds `ToObject(thisArg)`
      // for a primitive receiver. Rewrite the receiver to `new <Wrapper>(…)`
      // once, here, above the several receiver-install lowerings below, so the
      // strict/sloppy decision lives in one place. Declines (returns undefined)
      // for a strict callee, a callee that ignores `this`, and any receiver the
      // oracle cannot prove primitive. See sloppy-this-toobject.ts.
      {
        const boxedThisCall = reshapeSloppyPrimitiveThisArg(ctx, expr, innerExpr);
        if (boxedThisCall !== undefined) return compileCallExpression(ctx, fctx, boxedThisCall, expectedType);
      }

      const dynamicFunctionCtorArgs = standaloneDynamicFunctionCtorArgs(ctx, innerExpr);
      if (dynamicFunctionCtorArgs !== undefined) {
        const applyArgsExpr = !isCall && expr.arguments.length >= 2 ? expr.arguments[1]! : undefined;
        const applyVector = applyArgsExpr === undefined ? undefined : materializedArgumentsVector(fctx, applyArgsExpr);
        const applyElements =
          applyArgsExpr !== undefined && ts.isArrayLiteralExpression(applyArgsExpr)
            ? flattenStaticArrayElements(applyArgsExpr)
            : undefined;
        // A non-materialized, non-literal array-like still needs the generic
        // runtime property path; do not claim it and silently turn it into an
        // empty argument list.
        if (!isCall && applyArgsExpr !== undefined && applyVector === undefined && applyElements === undefined) {
          // fall through to the established reflective-call machinery
        } else {
          const vecBuilders = ensureObjVecBuilders(ctx);
          reserveApplyClosure(ctx);

          // Constant constructor arguments can use the existing AOT synthesis,
          // but this reflective site explicitly supplies the receiver.  Allow
          // `this` in that synthesis so `new Function("this.x = 1").call(o)`
          // stays in the caller module where the object-property runtime can see
          // `o`; non-constant bodies retain the provider carrier path below.
          const staticCalleeType = tryStaticNewFunction(ctx, fctx, dynamicFunctionCtorArgs, true);
          const calleeType = staticCalleeType ?? compileExpression(ctx, fctx, innerExpr, { kind: "externref" });
          if (calleeType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (calleeType.kind !== "externref") {
            coerceType(ctx, fctx, calleeType, { kind: "externref" });
          }

          if (expr.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            if (thisType === null) fctx.body.push({ op: "ref.null.extern" });
            else if (thisType.kind !== "externref") coerceType(ctx, fctx, thisType, { kind: "externref" });
          } else {
            emitUndefined(ctx, fctx);
          }

          const argsLocal = allocLocal(fctx, `__runtime_eval_reflective_args_${fctx.locals.length}`, {
            kind: "externref",
          });
          const newIdx = ctx.funcMap.get("__new_objvec") ?? vecBuilders.newIdx;
          fctx.body.push({ op: "call", funcIdx: newIdx }, { op: "local.set", index: argsLocal });

          if (isCall) {
            for (const arg of expr.arguments.slice(1)) {
              fctx.body.push({ op: "local.get", index: argsLocal });
              const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
              if (argType === null) fctx.body.push({ op: "ref.null.extern" });
              else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
              fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? vecBuilders.pushIdx });
            }
          } else if (expr.arguments.length >= 2) {
            const vector = applyVector;
            if (vector !== undefined) {
              // Replace the local's freshly allocated empty vector with the
              // already-materialized arguments object.  The callee and receiver
              // remain on the value stack for the final apply call.
              emitMaterializedArgumentsVector(ctx, fctx, vector);
              fctx.body.push({ op: "local.set", index: argsLocal });
            } else if (applyElements !== undefined) {
              for (const arg of applyElements) {
                fctx.body.push({ op: "local.get", index: argsLocal });
                const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
                if (argType === null) fctx.body.push({ op: "ref.null.extern" });
                else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
                fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? vecBuilders.pushIdx });
              }
            }
          }

          const applyIdx = ctx.funcMap.get("__apply_closure");
          if (applyIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: argsLocal }, { op: "call", funcIdx: applyIdx });
            return { kind: "externref" };
          }
          // Reservation should make this unreachable; keep a balanced fallback
          // if a future target declines the bridge after operands are emitted.
          fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "drop" }, { op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }

      // (#3390) `Promise.<static>.call(recv, …)` with a STATICALLY
      // non-constructor receiver throws a TypeError synchronously (§27.2.4.1
      // step 2 IsConstructor, BEFORE touching the iterable). On the standalone
      // lane the host fallback (`Promise_all` etc.) leaks; emit the native
      // throw instead. Constructor / Promise / dynamic receivers fall through
      // (correct-or-legacy — slice 2/3). `.apply` is not intercepted (rare;
      // the corpus uses `.call`).
      if (isCall) {
        const promiseStaticErr = tryEmitStandalonePromiseStaticCallTypeError(ctx, fctx, expr, propAccess);
        if (promiseStaticErr !== undefined) return promiseStaticErr;
      }

      // (#2604/#3171) Reflective `X.prototype.METHOD.call(recv, …)` /
      // `inst.METHOD.call(recv, …)` for the four keyed collections — brand-check
      // the receiver ([[MapData]]/[[SetData]]/[[WeakMapData]]/[[WeakSetData]],
      // struct + COLLECTION_KIND tag) and dispatch to the native collection
      // runtimes. Runs BEFORE the generic #2193 member-closure recovery (which
      // has no native-collection knowledge), and only matches a collection
      // method closure under nativeStrings, so it ADDS a collection-specific
      // pre-check without rewriting the generic path. addUnionImports up-front
      // (mirrors extern.ts's direct-path setup) so the arg-boxing `__box_number`
      // the dispatch emits is registered without a mid-body shift.
      if (isCollectionReflectiveCallShape(ctx, expr)) {
        addUnionImports(ctx);
        const collReflResult = tryCompileCollectionReflectiveCall(ctx, fctx, expr);
        if (collReflResult !== undefined) return collReflResult;
      }

      // (#2193 PR-B) Reflective `m.call/apply(thisArg, …)` on a value-erased
      // `$NativeProto` member closure (e.g. `const m = Array.prototype.slice`).
      // Recover the closure from the receiver's TS symbol and call_ref it with
      // thisArg threaded into param 1. Unwrap `as`/parenthesized casts so both
      // `m.call(…)` and `(m as any).call(…)` resolve the underlying symbol.
      {
        let recv: ts.Expression = innerExpr;
        while (ts.isParenthesizedExpression(recv) || ts.isAsExpression(recv) || ts.isNonNullExpression(recv)) {
          recv = recv.expression;
        }
        const reflResult = tryEmitNativeProtoReflectiveCall(ctx, fctx, expr, recv, isCall);
        if (reflResult !== undefined) return reflResult;

        // (#2876) Reflective `.call`/`.apply` on a getter pulled from a
        // builtin-proto accessor descriptor (`gOPD(RegExp.prototype, "global").get`),
        // recovered by data-flow trace rather than a TS symbol.
        const descAccResult = tryEmitNativeProtoDescriptorAccessorCall(ctx, fctx, expr, recv, isCall);
        if (descAccResult !== undefined) return descAccResult;

        // (#3236 Slice 1b) Reflective `.call`/`.apply` on a dynamically-read
        // %GeneratorPrototype% member closure (`GeneratorPrototype.next.call(x)`).
        // The receiver object is `any`-typed so the symbol-based paths above miss;
        // resolve the (brand, member) from the receiver's GeneratorPrototype
        // provenance and invoke the stored closure with `thisArg → this`, so its
        // Slice-1 brand-check fires on the bad `this`. Standalone-gated.
        const genProtoResult = tryEmitGeneratorProtoReflectiveCall(ctx, fctx, expr, recv, isCall);
        if (genProtoResult !== undefined) return genProtoResult;
      }

      // (#3541) Reflective `String.fromCharCode/fromCodePoint` .call/.apply on
      // the native-string lanes: the generic closure-wrapper apply machinery
      // cannot spread a native $vec argv into the builtin's variadic lowering
      // (null string → __str_concat null-deref — the sole gate on the 311
      // built-ins/RegExp/property-escapes rows). Precise-match arm; falls
      // through (undefined) for the host lane and any non-vec/unsafe shape.
      {
        const fccResult = tryCompileFromCharCodeFamilyReflective(ctx, fctx, expr, innerExpr, isCall);
        if (fccResult !== undefined) return fccResult;
      }

      // Sub-fix 3 (#1596): Function.prototype.{apply,call}.call(fn, ...) reshape.
      // Rewrite `Function.prototype.apply.call(fn, thisArg, argsArr)` to
      // `fn.apply(thisArg, argsArr)` (and analogous for .call.call) so the
      // existing Case 0 / Case 1 handlers fire. Only the outer `.call` form is
      // matched — `Function.prototype.apply.apply(fn, [thisArg, argsArr])` is
      // rare and would need a packed-args reshape.
      if (
        isCall &&
        ts.isPropertyAccessExpression(innerExpr) &&
        (innerExpr.name.text === "apply" || innerExpr.name.text === "call") &&
        ts.isPropertyAccessExpression(innerExpr.expression) &&
        innerExpr.expression.name.text === "prototype" &&
        ts.isIdentifier(innerExpr.expression.expression) &&
        innerExpr.expression.expression.text === "Function" &&
        expr.arguments.length >= 1
      ) {
        const innerMethod = innerExpr.name.text; // "apply" or "call"
        const fnExpr = expr.arguments[0]!;
        const reshapedArgs = expr.arguments.slice(1);
        const reshapedProp = ts.factory.createPropertyAccessExpression(
          fnExpr as ts.LeftHandSideExpression,
          innerMethod,
        );
        ts.setTextRange(reshapedProp, propAccess);
        const reshapedCall = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
        ts.setTextRange(reshapedCall, expr);
        (reshapedCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, reshapedCall as ts.CallExpression);
      }

      // (#2069) `.call`/`.apply` on a callee declared with an explicit
      // TypeScript `this` parameter (`function f(this: T, …)`). Such a function
      // has a leading `externref` `this` slot in its Wasm signature, so the
      // legacy "evaluate thisArg, drop it" lowering passed `undefined` for
      // `this` AND shifted every user argument into the wrong slot. Rewrite to a
      // direct call that supplies the thisArg as the first positional argument —
      // it lands in param 0 (the `this` slot, boxed to externref by the regular
      // arg coercion) and the remaining args fill the declared params in order.
      // Only fires when the thisArg can be threaded soundly: a named callee with
      // a static this-param, and (for `.apply`) a statically-flattenable args
      // array. Anything else falls through to the legacy paths below.
      if (getExplicitThisParam(ctx, innerExpr) !== undefined && expr.arguments.length > 0) {
        const thisArg = expr.arguments[0]!;
        let directArgs: ts.Expression[] | undefined;
        if (isCall) {
          directArgs = [thisArg, ...expr.arguments.slice(1)];
        } else if (expr.arguments.length === 1) {
          // .apply(thisArg) — no args array
          directArgs = [thisArg];
        } else {
          const argsExpr = expr.arguments[1]!;
          if (ts.isArrayLiteralExpression(argsExpr)) {
            const flattened = flattenStaticArrayElements(argsExpr);
            if (flattened !== undefined) directArgs = [thisArg, ...flattened];
          }
        }
        if (directArgs !== undefined) {
          const directCall = ts.factory.createCallExpression(
            innerExpr as ts.LeftHandSideExpression,
            undefined,
            directArgs,
          );
          ts.setTextRange(directCall, expr);
          (directCall as { parent?: ts.Node }).parent = expr.parent;
          return compileCallExpression(ctx, fctx, directCall as ts.CallExpression);
        }
      }

      // Dynamic `.apply(thisArg, arguments)` forwarding.  The materialized
      // arguments object is a runtime-length WasmGC vec, so treating it as one
      // positional value (the old generic fallthrough) loses every forwarded
      // argument.  Route the vec through the shared closure-application bridge:
      // it reads the real length, installs `thisArg`, widens under-application,
      // and preserves the exact argc/extras protocol used by the callee's own
      // `arguments` object.  This is the common UMD forwarding shape used by
      // Moment's `hooks -> hookCallback.apply(null, arguments)` entry point.
      //
      // Keep the arm deliberately exact: only a materialized arguments vec and
      // a compiler-known identifier can enter.  Arbitrary array-likes and host
      // functions retain their existing paths.
      if (!isCall && expr.arguments.length === 2 && ts.isIdentifier(innerExpr)) {
        const argumentsVector = materializedArgumentsVector(fctx, expr.arguments[1]!);
        const calleeName = innerExpr.text;
        const knownCompiledCallee =
          fctx.localMap.has(calleeName) ||
          ctx.moduleGlobals.has(calleeName) ||
          ctx.closureMap.has(calleeName) ||
          ctx.funcMap.has(calleeName);
        if (argumentsVector !== undefined && knownCompiledCallee) {
          prepareCompiledApplyBridge(ctx, fctx);
          reserveApplyClosure(ctx);

          const calleeType = compileExpression(ctx, fctx, innerExpr, { kind: "externref" });
          if (calleeType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (calleeType.kind !== "externref") {
            coerceType(ctx, fctx, calleeType, { kind: "externref" });
          }

          const receiverType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
          if (receiverType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (receiverType.kind !== "externref") {
            coerceType(ctx, fctx, receiverType, { kind: "externref" });
          }

          emitMaterializedArgumentsVector(ctx, fctx, argumentsVector);

          const applyIdx = ctx.funcMap.get("__apply_closure");
          if (applyIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: applyIdx });
            return { kind: "externref" };
          }
          // Reservation is expected to succeed; keep a balanced fallback if a
          // future runtime configuration declines it after operands were built.
          fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "drop" }, { op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }

      // Case 0: (function(){}).call/apply(...) and (() => {}).call/apply(...).
      // A compiled function is a WasmGC funcref/struct, not a JS Function, so a
      // host-side `.apply`/`.call` lookup fails ("apply is not a function").
      // Rewrite statically to a direct invocation of the function expression,
      // dropping thisArg (standalone functions ignore `this`). This reuses the
      // IIFE-inlining path, which also binds `arguments` correctly (#1596).
      {
        let fnExpr: ts.Expression = innerExpr;
        while (ts.isParenthesizedExpression(fnExpr)) fnExpr = fnExpr.expression;
        const isFnLiteral =
          (ts.isFunctionExpression(fnExpr) && fnExpr.asteriskToken === undefined) || ts.isArrowFunction(fnExpr);
        if (isFnLiteral) {
          let directArgs: readonly ts.Expression[] | undefined;
          if (isCall) {
            // fn.call(thisArg, a, b, ...) → fn(a, b, ...)
            directArgs = expr.arguments.slice(1);
          } else if (expr.arguments.length < 2) {
            // fn.apply(thisArg) / fn.apply() → fn()
            directArgs = [];
          } else {
            // fn.apply(thisArg, [a, b, ...]) → fn(a, b, ...). Statically flatten
            // the args-array literal into positional call arguments so the
            // IIFE-inlining path sees a fixed argument count (it binds
            // `arguments` from the literal arg list and does not expand spreads
            // itself). A spread of a nested array literal (`[...[3,4,5]]`, the
            // common test262 shape) is flattened recursively. Anything we
            // cannot statically flatten (dynamic spread source, elided holes)
            // is left to the generic path.
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const flattened = flattenStaticArrayElements(argsExpr);
              if (flattened !== undefined) directArgs = flattened;
            }
          }
          if (directArgs !== undefined) {
            // (#4246) A function-expression callee that READS `this` gets the
            // receiver bound as a real `this` local for the duration of the
            // inline, instead of the legacy evaluate-and-drop below. Without
            // it `(function(){ this.x = 1 }).call(obj)` wrote to the ambient
            // receiver — the global object in sloppy top-level code — so the
            // read looked right and every write was lost. See
            // inlined-call-receiver.ts for the two gates that keep the nullish
            // and arrow cases on the existing path.
            const inlinedReceiver = planInlinedReceiver(ctx, fctx, fnExpr, expr.arguments[0]);
            // Evaluate the receiver-position thisArg for side effects (spec:
            // arguments are evaluated even though standalone functions ignore
            // `this`). For .call/.apply the thisArg is expr.arguments[0].
            if (expr.arguments.length > 0) {
              const thisType = compileExpression(
                ctx,
                fctx,
                expr.arguments[0]!,
                inlinedReceiver ? { kind: "externref" } : undefined,
              );
              if (inlinedReceiver) {
                if (thisType === null) fctx.body.push({ op: "ref.null.extern" });
                else if (thisType.kind !== "externref") coerceType(ctx, fctx, thisType, { kind: "externref" });
                fctx.body.push({ op: "local.set", index: inlinedReceiver.localIdx });
              } else if (thisType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
            const directCall = ts.factory.createCallExpression(
              fnExpr as ts.LeftHandSideExpression,
              undefined,
              directArgs,
            );
            ts.setTextRange(directCall, expr);
            (directCall as any).parent = expr.parent;
            const inlinedResult = compileCallExpression(ctx, fctx, directCall as ts.CallExpression);
            if (inlinedReceiver) releaseInlinedReceiver(fctx, inlinedReceiver);
            return inlinedResult;
          }
        }
      }

      // Case 1: identifier.call(thisArg, args...) — standalone function
      if (ts.isIdentifier(innerExpr)) {
        const funcName = innerExpr.text;
        const innerFact = ctx.oracle.typeFactOf(innerExpr);
        const innerCanBeHostCallable =
          ctx.oracle.signatureOf(innerExpr) !== undefined ||
          innerFact.kind === "function" ||
          innerFact.kind === "any" ||
          innerFact.kind === "unknown";
        const valueDeclaration = ctx.oracle.valueDeclarationOf(innerExpr);
        const aliasedImportTarget =
          valueDeclaration && (ts.isImportClause(valueDeclaration) || ts.isImportSpecifier(valueDeclaration))
            ? ctx.importBindingTargets?.get(valueDeclaration)
            : undefined;
        // The graph-wide name registries may also contain an unrelated
        // same-named function from another module. A real variable/binding
        // element backed by a module cell owns this identifier read, so it must
        // not be reinterpreted as that colliding function for `.call/.apply`.
        const moduleValueOwnsName =
          (ctx.moduleGlobals.has(funcName) &&
            valueDeclaration !== undefined &&
            !ts.isFunctionDeclaration(valueDeclaration) &&
            !ts.isFunctionExpression(valueDeclaration) &&
            !ts.isArrowFunction(valueDeclaration)) ||
          (aliasedImportTarget !== undefined &&
            !ts.isFunctionDeclaration(aliasedImportTarget) &&
            !ts.isFunctionExpression(aliasedImportTarget) &&
            !ts.isArrowFunction(aliasedImportTarget));
        let closureInfo = moduleValueOwnsName ? undefined : ctx.closureMap.get(funcName);
        const funcIdx = moduleValueOwnsName ? undefined : ctx.funcMap.get(funcName);

        if (!closureInfo && funcIdx === undefined) {
          closureInfo = resolveClosureInfoFromLocal(ctx, fctx, funcName);
        }

        // (#3983) `.apply(thisArg, …)` dropped the receiver; reshape it onto
        // the receiver-correct `.call` path (see named-this-call.ts).
        if (!isCall && !closureInfo && funcIdx !== undefined) {
          const asCall = tryReshapeApplyToNamedThisCall(ctx, fctx, expr, innerExpr, funcIdx);
          if (asCall !== undefined) return compileCallExpression(ctx, fctx, asCall);
        }

        // (#3796) A stable named FunctionDeclaration whose own body reads
        // `this` needs the `.call` receiver installed in `__current_this`.
        // Resolve/reserve this before emitting operands so helper publication
        // cannot happen while values are conceptually live on the Wasm stack.
        // Closures, imports, explicit-this declarations, nullable receivers,
        // and unstable symbols keep their existing lowerings; `.apply` reaches
        // this via the reshape directly above.
        const namedThisCall =
          isCall && !closureInfo && funcIdx !== undefined && expr.arguments.length > 0
            ? resolveNamedThisCallTarget(ctx, fctx, innerExpr, funcIdx, expr.arguments[0]!, expr.arguments.slice(1))
            : undefined;

        // (#2193 PR-B) `m.call(thisArg, …args)` where `m` is a `$NativeProto`
        // member closure (e.g. `Array.prototype.slice`). Its FIRST user param is
        // the receiver (`this`), NOT an ordinary arg — so unlike a plain
        // standalone function (handled below, which DROPS thisArg), the thisArg
        // must be threaded into param 1. Rewrite `m.call(t, a, b)` to the direct
        // closure call `m(t, a, b)` so `compileClosureCall` lands t→this, a→arg1,
        // b→arg2. `.apply(t, [a,b])` with a statically-flattenable array literal
        // reshapes the same way. Anything dynamic falls through to the legacy
        // drop-thisArg path (no worse than before).
        if (
          closureInfo &&
          ctx.nativeProtoReceiverClosureStructTypes?.has(closureInfo.structTypeIdx) &&
          expr.arguments.length > 0
        ) {
          let directArgs: readonly ts.Expression[] | undefined;
          if (isCall) {
            directArgs = expr.arguments; // [thisArg, ...args] → (this, ...args)
          } else if (expr.arguments.length === 1) {
            directArgs = [expr.arguments[0]!]; // .apply(thisArg) → (this)
          } else {
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const flattened = flattenStaticArrayElements(argsExpr);
              if (flattened !== undefined) directArgs = [expr.arguments[0]!, ...flattened];
            }
          }
          if (directArgs !== undefined) {
            const syntheticCall = ts.factory.createCallExpression(
              innerExpr,
              undefined,
              directArgs as unknown as readonly ts.Expression[],
            );
            (syntheticCall as { parent?: ts.Node }).parent = expr.parent;
            return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
          }
        }

        // (#4192) A CLOSURE callee (`var fe = function () { … this … }`) never
        // reached the named-`this` trampoline above — that arm is gated on
        // `!closureInfo` — so its receiver was evaluated and DROPPED. Install
        // it in `__current_this`, which the lifted body already reads. Load-
        // bearing invariant: every `closureInfo` sub-path below returns through
        // a `finishClosureReceiverCall`, so the restore is always reachable.
        // See closure-receiver-install.ts.
        const closureReceiver =
          closureInfo !== undefined && expr.arguments.length > 0
            ? planClosureReceiverInstall(ctx, fctx, innerExpr)
            : undefined;

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate thisArg first. The receiver-correct named trampoline owns
          // it as leading externref param; every other existing path keeps the
          // legacy evaluate-and-drop behavior.
          if (expr.arguments.length > 0) {
            const thisType = compileExpression(
              ctx,
              fctx,
              expr.arguments[0]!,
              namedThisCall || closureReceiver ? { kind: "externref" } : undefined,
            );
            if (thisType && closureReceiver) {
              emitClosureReceiverInstall(ctx, fctx, closureReceiver);
            } else if (thisType && !namedThisCall) {
              fctx.body.push({ op: "drop" });
            }
          }

          if (isCall) {
            // .call(thisArg, arg1, arg2, ...) — remaining args are positional
            const remainingArgs = expr.arguments.slice(1);

            if (closureInfo) {
              // Create a synthetic call expression with remaining args
              const syntheticCall = ts.factory.createCallExpression(
                innerExpr,
                undefined,
                remainingArgs as unknown as readonly ts.Expression[],
              );
              // Copy source file info for error reporting
              (syntheticCall as any).parent = expr.parent;
              return finishClosureReceiverCall(
                fctx,
                closureReceiver,
                compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo),
              );
            }

            // Check for rest parameters on the callee
            const callRestInfo = ctx.funcRestParams.get(funcName);

            if (callRestInfo) {
              // Calling a rest-param function via .call(): pack trailing args into a GC array
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              // Compile non-rest arguments
              for (let i = 0; i < callRestInfo.restIndex; i++) {
                if (i < remainingArgs.length) {
                  compileExpression(ctx, fctx, remainingArgs[i]!, paramTypes?.[i]);
                } else {
                  pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
                }
              }
              // Pack remaining arguments into a vec struct (array + length)
              const restArgCount = Math.max(0, remainingArgs.length - callRestInfo.restIndex);
              fctx.body.push({ op: "i32.const", value: restArgCount });
              for (let i = callRestInfo.restIndex; i < remainingArgs.length; i++) {
                compileExpression(ctx, fctx, remainingArgs[i]!, callRestInfo.elemType);
              }
              fctx.body.push({
                op: "array.new_fixed",
                typeIdx: callRestInfo.arrayTypeIdx,
                length: restArgCount,
              });
              fctx.body.push({
                op: "struct.new",
                typeIdx: callRestInfo.vecTypeIdx,
              });
            } else {
              // Regular function call
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              const paramCount = paramTypes?.length ?? remainingArgs.length;
              const formalArgCount = Math.min(remainingArgs.length, paramCount);
              for (let i = 0; i < formalArgCount; i++) {
                compileExpression(ctx, fctx, remainingArgs[i]!, paramTypes?.[i]);
              }
              // `.call` over-application must not leave extra operands under
              // the exact Wasm call. Preserve side effects, and when the target
              // reads `arguments`, marshal the overflow through the same
              // extras-argv ABI as a direct identifier call.
              if (remainingArgs.length > paramCount) {
                if (ctx.funcUsesArguments.has(funcName)) {
                  emitSetExtrasArgv(ctx, fctx, remainingArgs as ts.Expression[], paramCount);
                } else {
                  for (let i = paramCount; i < remainingArgs.length; i++) {
                    const extraType = compileExpression(ctx, fctx, remainingArgs[i]!);
                    if (extraType !== null) fctx.body.push({ op: "drop" });
                  }
                }
              }

              // Supply defaults for missing optional params
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                const numProvided = remainingArgs.length;
                for (const opt of optInfo) {
                  if (opt.index >= numProvided) {
                    pushParamSentinel(fctx, opt.type, ctx, opt);
                  }
                }
              }

              // Pad any remaining missing arguments with defaults
              if (paramTypes) {
                const providedCount = Math.min(remainingArgs.length, paramTypes.length);
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.filter((o) => o.index >= remainingArgs.length).length
                  : 0;
                const totalPushed = providedCount + optFilledCount;
                for (let i = totalPushed; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }

            maybeSetArgcForKnownCall(
              ctx,
              fctx,
              funcName,
              remainingArgs.length,
              getFuncParamTypes(ctx, funcIdx!)?.length ?? remainingArgs.length,
            );
            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            fctx.body.push({ op: "call", funcIdx: namedThisCall?.trampolineFuncIdx ?? finalFuncIdx });

            // Use actual Wasm return type — TS checker reports `any` for .call()/.apply()
            // which resolves to externref, but the actual function may return f64/i32/ref.
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
          }
          // .apply(thisArg, argsArray) — spread array literal elements as positional args
          if (!isCall && expr.arguments.length >= 2) {
            const argsExpr = expr.arguments[1]!;
            if (ts.isArrayLiteralExpression(argsExpr)) {
              const elements = argsExpr.elements;
              if (closureInfo) {
                const syntheticCall = ts.factory.createCallExpression(
                  innerExpr,
                  undefined,
                  elements as unknown as readonly ts.Expression[],
                );
                (syntheticCall as any).parent = expr.parent;
                return finishClosureReceiverCall(
                  fctx,
                  closureReceiver,
                  compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo),
                );
              }
              const applyRestInfo = ctx.funcRestParams.get(funcName);
              if (applyRestInfo) {
                // Rest-param function via .apply(): pack trailing elements into vec
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < applyRestInfo.restIndex; i++) {
                  if (i < elements.length) {
                    compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                  } else {
                    pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
                  }
                }
                const restArgCount = Math.max(0, elements.length - applyRestInfo.restIndex);
                fctx.body.push({ op: "i32.const", value: restArgCount });
                for (let i = applyRestInfo.restIndex; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, applyRestInfo.elemType);
                }
                fctx.body.push({
                  op: "array.new_fixed",
                  typeIdx: applyRestInfo.arrayTypeIdx,
                  length: restArgCount,
                });
                fctx.body.push({
                  op: "struct.new",
                  typeIdx: applyRestInfo.vecTypeIdx,
                });
              } else {
                const paramTypes = getFuncParamTypes(ctx, funcIdx!);
                for (let i = 0; i < elements.length; i++) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i]);
                }
                const optInfo = ctx.funcOptionalParams.get(funcName);
                if (optInfo) {
                  for (const opt of optInfo) {
                    if (opt.index >= elements.length) pushParamSentinel(fctx, opt.type, ctx, opt);
                  }
                }
                // Pad any remaining missing arguments with defaults
                if (paramTypes) {
                  const providedCount = Math.min(elements.length, paramTypes.length);
                  const optFilledCount = ctx.funcOptionalParams.get(funcName)
                    ? ctx.funcOptionalParams.get(funcName)!.filter((o) => o.index >= elements.length).length
                    : 0;
                  const totalPushed = providedCount + optFilledCount;
                  for (let i = totalPushed; i < paramTypes.length; i++) {
                    pushDefaultValue(fctx, paramTypes[i]!, ctx);
                  }
                }
              }
              const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
              maybeSetArgcForKnownCall(
                ctx,
                fctx,
                funcName,
                elements.length,
                getFuncParamTypes(ctx, finalFuncIdx)?.length ?? elements.length,
              );
              fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
              // Use actual Wasm return type for .apply()
              if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
              return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
            }
          }
          // .apply() with no args array — call with no args
          if (!isCall) {
            if (closureInfo) {
              const syntheticCall = ts.factory.createCallExpression(innerExpr, undefined, []);
              (syntheticCall as any).parent = expr.parent;
              return finishClosureReceiverCall(
                fctx,
                closureReceiver,
                compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo),
              );
            }
            const applyNoArgsRestInfo = ctx.funcRestParams.get(funcName);
            if (applyNoArgsRestInfo) {
              // Rest-param function with no args: push empty vec
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              for (let i = 0; i < applyNoArgsRestInfo.restIndex; i++) {
                pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
              }
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({
                op: "array.new_fixed",
                typeIdx: applyNoArgsRestInfo.arrayTypeIdx,
                length: 0,
              });
              fctx.body.push({
                op: "struct.new",
                typeIdx: applyNoArgsRestInfo.vecTypeIdx,
              });
            } else {
              const optInfo = ctx.funcOptionalParams.get(funcName);
              if (optInfo) {
                for (const opt of optInfo) pushParamSentinel(fctx, opt.type, ctx, opt);
              }
              // Pad any remaining missing arguments with defaults
              const paramTypes = getFuncParamTypes(ctx, funcIdx!);
              if (paramTypes) {
                const optFilledCount = ctx.funcOptionalParams.get(funcName)
                  ? ctx.funcOptionalParams.get(funcName)!.length
                  : 0;
                for (let i = optFilledCount; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }
            const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
            maybeSetArgcForKnownCall(ctx, fctx, funcName, 0, getFuncParamTypes(ctx, finalFuncIdx)?.length ?? 0);
            fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
            // Use actual Wasm return type for .apply() with no args
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalFuncIdx) ?? VOID_RESULT;
          }
        }

        // A declared identifier can hold a genuine host callable without a
        // Wasm function/closure identity (for example
        // `const { toString } = Object.prototype; toString.call(value)`). The
        // legacy identifier `.call` tail only handled compiler-owned
        // callables; for a host function it evaluated the receiver and then
        // returned the graceful undefined fallback. Preserve the real
        // Function.prototype.call/apply semantics through the existing dynamic
        // host method boundary. Undeclared identifiers remain on the ordinary
        // ReferenceError path, and standalone/WASI retain their native lanes.
        if (
          !ctx.standalone &&
          !ctx.wasi &&
          !noJsHost(ctx) &&
          closureInfo === undefined &&
          funcIdx === undefined &&
          innerCanBeHostCallable &&
          (ctx.oracle.valueDeclarationOf(innerExpr) !== undefined ||
            fctx.localMap.has(funcName) ||
            (fctx.boxedCaptures?.has(funcName) ?? false) ||
            ctx.moduleGlobals.has(funcName))
        ) {
          const hostReflectiveCall = emitFnctorSubclassDynamicMethodCall(
            ctx,
            fctx,
            expr,
            propAccess,
            propAccess.name.text,
          );
          if (hostReflectiveCall !== undefined) return hostReflectiveCall;
        }
      }

      // Case 2: obj.method.call/apply — method call with different receiver
      if (ts.isPropertyAccessExpression(innerExpr)) {
        const methodName = innerExpr.name.text;
        const objExpr = innerExpr.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        // Case 2a: Type.prototype.method.call(receiver, ...args)
        // Use __proto_method_call host import to correctly dispatch through
        // the Type's prototype, even when receiver doesn't inherit from Type.
        // e.g. Array.prototype.every.call(fnObj, cb) where fnObj is a Function.
        if (
          ts.isPropertyAccessExpression(objExpr) &&
          objExpr.name.text === "prototype" &&
          ts.isIdentifier(objExpr.expression) &&
          isCall &&
          expr.arguments.length >= 1
        ) {
          const typeName = objExpr.expression.text;

          // (#2501) Object.prototype.toString.call(v) → native `[object X]` tag
          // (§20.1.3.6 builtin-tag subset). The builtin tag is statically known
          // from the receiver's TS type in nearly every test262 case, so emit the
          // string constant directly — this fixes host mode (Array/Function/Date
          // were mis-tagged `[object Object]` because the Wasm vec/closure receiver
          // is opaque to the host's `Object.prototype.toString`) AND standalone
          // (the whole `.call(...)` form was a hard compile error there). Routes
          // BOTH modes through the same compile-away classifier — no host import.
          // Symbol.toStringTag (§20.1.3.6 step 15) is deferred to phase-2 (it needs
          // dynamic @@toStringTag property lookup → the dynamic-property epic).
          if (typeName === "Object" && methodName === "toString") {
            const proof = { unprovenDefault: false };
            const tag = resolveObjectToStringTag(ctx, expr.arguments[0], proof);
            if (tag !== undefined) {
              // (#4491 wave-7) The fold's standalone terminal is a FALLBACK, not
              // a classification — under `allowJs` every `any` receiver lands
              // there and bakes `"[object Object]"`, so a dynamic receiver was
              // answered by a constant that had never looked at it. Ask the
              // #4119 runtime classifier first and keep this constant as ITS
              // fallback (object-proto-tostring-native.ts explains why the
              // composition has to be this way round and not the reverse).
              const receiverExpr = expr.arguments[0];
              // (#5148 cluster 3a) §20.1.3.6 steps 14-15 — a `@@toStringTag`
              // STRING on the receiver overrides builtinTag. Owned by
              // object-proto-symbol-tag.ts; `null` there means "reported a
              // compile error, operands already emitted", `undefined` means
              // "declined, keep the existing arms below".
              const symbolTagged = emitObjectProtoToStringWithSymbolTag(ctx, fctx, receiverExpr, tag, proof);
              if (symbolTagged !== undefined) return symbolTagged;
              if (ctx.standalone && proof.unprovenDefault && receiverExpr !== undefined) {
                // Flush against the CALLER's fctx before minting: the classifier
                // adds late imports, and only this body needs its own funcIdx
                // operands shifted (the minted helper starts from an empty body).
                flushLateImportShifts(ctx, fctx);
                const classifyIdx = ensureObjectProtoToStringClassifierFn(ctx);
                if (classifyIdx !== undefined) {
                  const recvResult = compileExpression(ctx, fctx, receiverExpr, { kind: "externref" });
                  // `null` means the receiver reported a compile error, and by
                  // then partial operand instructions are already in the body —
                  // so PROPAGATE rather than falling through to the constant
                  // path, which would push a string on top of them and leave the
                  // block unbalanced.
                  if (recvResult === null) return null;
                  if (recvResult.kind !== "externref") {
                    coerceType(ctx, fctx, recvResult, { kind: "externref" });
                  }
                  flushLateImportShifts(ctx, fctx);
                  return emitClassifierSelect(
                    ctx,
                    fctx,
                    ctx.funcMap.get(OBJECT_PROTO_TOSTRING_CLASSIFY_FN) ?? classifyIdx,
                    tag,
                  );
                }
              }
              const tagStr = `[object ${tag}]`;
              addStringConstantGlobal(ctx, tagStr);
              // Dual-mode string-constant push (externref in both host and
              // nativeStrings/standalone — the host `global.get` path only works
              // in non-nativeStrings mode, so use the shared helper).
              for (const instr of stringConstantExternrefInstrs(ctx, tagStr)) fctx.body.push(instr);
              return { kind: "externref" };
            }
            // An `any`-typed receiver has no static tag to fold. Route it through
            // the same WasmGC runtime classifier as the reflective member body,
            // but call the classifier directly: the generic Function#call
            // adapter boxes the native ArrayBuffer/DataView/TA carrier and loses
            // the RTT needed to distinguish it from an ordinary Array/Object.
            if (ctx.standalone || ctx.wasi) {
              const helperReady = ensureObjectProtoToStringRuntimeHelper(ctx);
              if (helperReady !== undefined) {
                fctx.body.push({ op: "ref.null.extern" }); // unused closure-self slot
                const valueType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
                if (valueType && valueType.kind !== "externref") {
                  coerceType(ctx, fctx, valueType, { kind: "externref" });
                }
                const helperIdx = ensureObjectProtoToStringRuntimeHelper(ctx);
                if (helperIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: helperIdx });
                  return { kind: "externref" };
                }
              }
            }
          }

          const isBuiltinRegExpPrototype = typeName === "RegExp" && isGlobalRegExpIdentifier(ctx, objExpr.expression);
          if (usesNativeRegExpProvider(ctx) && isBuiltinRegExpPrototype) {
            if (methodName === "test" || methodName === "exec") {
              const receiverArg = expr.arguments[0]!;
              const syntheticProp = ts.factory.createPropertyAccessExpression(receiverArg, methodName);
              ts.setTextRange(syntheticProp, innerExpr);
              const syntheticCall = ts.factory.createCallExpression(
                syntheticProp,
                undefined,
                Array.from(expr.arguments).slice(1),
              );
              ts.setTextRange(syntheticCall, expr);
              (syntheticCall as any).parent = expr.parent;
              const standaloneRegExpMethod =
                methodName === "exec"
                  ? tryCompileStandaloneRegExpExec(ctx, fctx, syntheticCall, syntheticProp)
                  : tryCompileStandaloneRegExpTest(ctx, fctx, syntheticCall, syntheticProp);
              if (standaloneRegExpMethod !== undefined) return standaloneRegExpMethod;
            }
            reportError(
              ctx,
              expr,
              `Codegen error: standalone RegExp literal-substring backend does not support ` +
                `RegExp.prototype.${methodName}.call(...) (#682/#1474). Use RegExp.prototype.test/exec ` +
                `with a plain static pattern and no flags, or recompile without --target standalone.`,
            );
            return null;
          }
          // (#1888 Slice 3) Standalone borrowed-method dispatch
          // `Type.prototype.<m>.call(recv, …args)` (ES §7.3.14 Call). The host
          // `__proto_method_call` is refused under --target standalone (no JS
          // runtime). Per the "compile away" principle, typeName + methodName
          // are compile-time constants here, so we dispatch STATICALLY by
          // synthesising `recv.<m>(…args)` and routing it through the native
          // member-call path — no new runtime helper, no funcIdx shift.
          //   - String: route to compileNativeStringMethodCall, which coerces
          //     the borrowed receiver to a native string ($NativeString brand)
          //     and emits the __str_* fast path. The covered method set is the
          //     ones whose native helper round-trips correctly (see below).
          //   - Object.hasOwnProperty/propertyIsEnumerable: synthesise the bare
          //     call, which already has a clean native standalone path
          //     (compilePropertyIntrospection → __hasOwnProperty /
          //     __propertyIsEnumerable) while preserving closed class-struct
          //     field/method semantics.
          //   - Object.isPrototypeOf: route directly to the native open-object
          //     prototype-chain helper. Array/Number/Boolean/Function have no
          //     clean native borrowed path yet → refuse-loud below (Array brand
          //     arm rides on #2177). Never a silent-wrong answer.
          if (ctx.standalone && expr.arguments.length >= 1 && !isBuiltinRegExpPrototype) {
            // Native String methods whose __str_* helper + return marshaling
            // round-trip correctly standalone (verified end-to-end). Methods
            // outside this set refuse-loud rather than risk a wrong result.
            const STANDALONE_STR_PROTO_METHODS = new Set<string>([
              "charAt",
              "charCodeAt",
              "codePointAt",
              "indexOf",
              "lastIndexOf",
              "includes",
              "startsWith",
              "endsWith",
              "toUpperCase",
              "toLowerCase",
              "trim",
              "trimStart",
              "trimEnd",
              "trimLeft",
              "trimRight",
              "concat",
              "repeat",
              "padStart",
              "padEnd",
              "substring",
              "slice",
              "at",
            ]);
            const synthesizeBorrowedCall = (): { prop: ts.PropertyAccessExpression; call: ts.CallExpression } => {
              const receiverArg = expr.arguments[0]!;
              const restArgs = Array.from(expr.arguments).slice(1);
              const sProp = ts.factory.createPropertyAccessExpression(receiverArg, methodName);
              ts.setTextRange(sProp, innerExpr);
              (sProp as unknown as { parent: ts.Node }).parent = expr;
              const sCall = ts.factory.createCallExpression(sProp, undefined, restArgs);
              ts.setTextRange(sCall, expr);
              (sCall as unknown as { parent: ts.Node }).parent = expr.parent;
              return { prop: sProp, call: sCall };
            };

            if (typeName === "String" && STANDALONE_STR_PROTO_METHODS.has(methodName)) {
              const { prop, call } = synthesizeBorrowedCall();
              // (#3254) The borrowed `this` is the FIRST arg. §22.1.3 requires
              // `RequireObjectCoercible(this)` then `ToString(this)` on it — a
              // null/undefined receiver must throw TypeError, and a
              // boolean/number/object receiver must ToString (the default
              // `emitReceiver` only handled a string/object-struct receiver, so
              // `.call(false)` yielded "[object Object]" and `.call(undefined)`
              // silently coerced). Feed a ROC+ToString receiver override so the
              // fix covers every method in STANDALONE_STR_PROTO_METHODS.
              const borrowedReceiver = expr.arguments[0]!;
              const strResult = compileNativeStringMethodCall(ctx, fctx, call, prop, methodName, () =>
                emitBorrowedStringReceiverToString(ctx, fctx, borrowedReceiver, methodName),
              );
              if (strResult !== null) return strResult;
              // Native string path declined (unexpected shape) — fall through
              // to the refuse-loud below rather than the host import.
            } else if (
              typeName === "Object" &&
              (methodName === "hasOwnProperty" || methodName === "propertyIsEnumerable")
            ) {
              // Object.prototype.{hasOwnProperty,propertyIsEnumerable}.call(o, k)
              // → o.<method>(k), which routes through compilePropertyIntrospection.
              const { prop, call } = synthesizeBorrowedCall();
              const introspectionResult = compilePropertyIntrospection(ctx, fctx, prop, call);
              if (introspectionResult !== null) return introspectionResult;
            } else if (typeName === "Object" && methodName === "isPrototypeOf") {
              const protoIdx = ensureLateImport(
                ctx,
                "__isPrototypeOf",
                [{ kind: "externref" }, { kind: "externref" }],
                [{ kind: "i32" }],
              );
              flushLateImportShifts(ctx, fctx);
              if (protoIdx !== undefined) {
                const receiverType = compileExpression(ctx, fctx, expr.arguments[0]!);
                if (receiverType && receiverType.kind !== "externref") {
                  coerceType(ctx, fctx, receiverType, { kind: "externref" });
                }
                if (expr.arguments[1]) {
                  const candidateType = compileExpression(ctx, fctx, expr.arguments[1]!);
                  if (candidateType && candidateType.kind !== "externref") {
                    coerceType(ctx, fctx, candidateType, { kind: "externref" });
                  }
                } else {
                  fctx.body.push({ op: "ref.null.extern" });
                }
                fctx.body.push({ op: "call", funcIdx: protoIdx });
                return { kind: "i32" };
              }
            }

            // Unsupported (typeName, methodName) under standalone: refuse-loud,
            // never leak the host import or return a silent-wrong value.
            const cite =
              typeName === "Array"
                ? "the Array brand arm rides on #2177 ($Vec element retrieval)"
                : typeName === "Object"
                  ? "only Object.prototype hasOwnProperty/propertyIsEnumerable/isPrototypeOf borrowed calls are wired (valueOf is a follow-on)"
                  : "this prototype's borrowed-method brand arm is not yet native";
            reportError(
              ctx,
              expr,
              `Codegen error: ${typeName}.prototype.${methodName}.call(...) is not yet ` +
                `supported in --target standalone (#1888 Slice 3/4) — ${cite}. ` +
                `Recompile without --target standalone, or call the method directly on a typed receiver.`,
            );
            return null;
          }
          if (
            (typeName === "String" ||
              typeName === "Number" ||
              typeName === "Array" ||
              typeName === "Boolean" ||
              typeName === "Object" ||
              typeName === "Function" ||
              isBuiltinRegExpPrototype) &&
            expr.arguments.length >= 1
          ) {
            const protoCallIdx = ensureLateImport(
              ctx,
              "__proto_method_call",
              [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }],
            );
            const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
            const arrPushIdx = ensureLateImport(
              ctx,
              "__js_array_push",
              [{ kind: "externref" }, { kind: "externref" }],
              [],
            );
            flushLateImportShifts(ctx, fctx);

            if (protoCallIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
              // Push typeName string
              addStringConstantGlobal(ctx, typeName);
              fctx.body.push(...stringConstantExternrefInstrs(ctx, typeName));

              // Push methodName string
              addStringConstantGlobal(ctx, methodName);
              fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));

              // Compile receiver (first argument to .call).
              // (#1442) When the receiver's static TS type is `boolean`, the
              // i32 → externref auto-coercion uses `__box_number` and arrives
              // host-side as `Number(0)` / `Number(1)`. That makes
              // `String.prototype.trim.call(true)` return `"1"` instead of
              // `"true"`. Box booleans through `__box_boolean` so the host
              // gets a real `Boolean` wrapper, then String() / ToString
              // produces the spec-correct `"true"` / `"false"`.
              const receiverArg = expr.arguments[0]!;
              const receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
              if (isBooleanType(receiverTsType)) {
                const recvWasm = compileExpression(ctx, fctx, receiverArg);
                if (recvWasm && recvWasm.kind === "i32") {
                  addUnionImports(ctx);
                  flushLateImportShifts(ctx, fctx);
                  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
                  if (boxBoolIdx !== undefined) {
                    fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
                  } else {
                    fctx.body.push({ op: "extern.convert_any" });
                  }
                } else if (recvWasm && recvWasm.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                } else if (recvWasm === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
              } else {
                const recvType = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
                if (recvType && recvType.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                }
                if (recvType === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
              }

              // Build args array from remaining arguments
              const remainingArgs = Array.from(expr.arguments).slice(1);
              const argsLocal = allocLocal(fctx, `__pmc_args_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push({ op: "call", funcIdx: arrNewIdx });
              fctx.body.push({ op: "local.set", index: argsLocal });
              for (const arg of remainingArgs) {
                fctx.body.push({ op: "local.get", index: argsLocal });
                const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
                if (argType && argType.kind !== "externref") {
                  fctx.body.push({ op: "extern.convert_any" });
                }
                if (argType === null) {
                  fctx.body.push({ op: "ref.null.extern" });
                }
                fctx.body.push({ op: "call", funcIdx: arrPushIdx });
              }
              fctx.body.push({ op: "local.get", index: argsLocal });

              // Call __proto_method_call(typeName, methodName, receiver, args)
              fctx.body.push({ op: "call", funcIdx: protoCallIdx });
              return { kind: "externref" };
            }
          }
        }

        // Resolve class name from the object's type
        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }

        // Also try struct name
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (className && (ctx.classSet.has(className) || ctx.funcMap.has(`${className}_${methodName}`))) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && expr.arguments.length > 0) {
            // First argument is the thisArg (receiver).
            // For class methods called via .call()/.apply() the receiver might
            // not actually be an instance of the class (e.g. `method.call({})`).
            // Without a brand check, the downstream ref.cast traps with
            // uncatchable "illegal cast". Instead, emit a ref.test guard and
            // throw a catchable TypeError on mismatch — matches the ES
            // private-field brand-check semantics (#826, class/elements
            // illegal_cast bucket).
            const selfParamTypes = getFuncParamTypes(ctx, funcIdx);
            const selfParamType = selfParamTypes?.[0];
            const thisArgType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (
              thisArgType &&
              selfParamType &&
              (selfParamType.kind === "ref" || selfParamType.kind === "ref_null") &&
              (thisArgType.kind === "externref" ||
                thisArgType.kind === "anyref" ||
                thisArgType.kind === "eqref" ||
                ((thisArgType.kind === "ref" || thisArgType.kind === "ref_null") &&
                  (thisArgType as { typeIdx: number }).typeIdx !== (selfParamType as { typeIdx: number }).typeIdx))
            ) {
              const selfTypeIdx = (selfParamType as { typeIdx: number }).typeIdx;
              if (thisArgType.kind === "externref") {
                fctx.body.push({ op: "any.convert_extern" });
              }
              const thisTmpType: ValType = { kind: "anyref" };
              const thisTmp = allocTempLocal(fctx, thisTmpType);
              fctx.body.push({ op: "local.tee", index: thisTmp });
              fctx.body.push({ op: "ref.test", typeIdx: selfTypeIdx });
              fctx.body.push({ op: "i32.eqz" });
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: typeErrorThrowInstrs(ctx, expr),
              });
              fctx.body.push({ op: "local.get", index: thisTmp });
              fctx.body.push({ op: "ref.cast", typeIdx: selfTypeIdx });
              releaseTempLocal(fctx, thisTmp);
            }

            if (isCall) {
              // .call(thisArg, arg1, arg2, ...) — remaining args are positional
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              // User-visible param count excludes self (param 0);
              // .call() args start at index 1 (index 0 is thisArg)
              const callParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length - 1;
              for (let i = 1; i < expr.arguments.length; i++) {
                if (i - 1 < callParamCount) {
                  compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
                } else {
                  // Extra argument beyond method's parameter count — evaluate for
                  // side effects (JS semantics) and discard the result
                  const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                  if (extraType !== null) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
              // Pad missing arguments with defaults (skip self at index 0)
              if (paramTypes) {
                for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            } else if (expr.arguments.length >= 2 && ts.isArrayLiteralExpression(expr.arguments[1]!)) {
              // .apply(thisArg, [arg1, arg2, ...]) — spread array literal
              const elements = (expr.arguments[1] as ts.ArrayLiteralExpression).elements;
              const paramTypes = getFuncParamTypes(ctx, funcIdx);
              // User-visible param count excludes self (param 0)
              const applyParamCount = paramTypes ? paramTypes.length - 1 : elements.length;
              for (let i = 0; i < elements.length; i++) {
                if (i < applyParamCount) {
                  compileExpression(ctx, fctx, elements[i]!, paramTypes?.[i + 1]); // param 0 = self
                } else {
                  // Extra argument beyond method's parameter count — evaluate for
                  // side effects (JS semantics) and discard the result
                  const extraType = compileExpression(ctx, fctx, elements[i]!);
                  if (extraType !== null) {
                    fctx.body.push({ op: "drop" });
                  }
                }
              }
              // Pad missing arguments with defaults (skip self at index 0)
              if (paramTypes) {
                for (let i = elements.length + 1; i < paramTypes.length; i++) {
                  pushDefaultValue(fctx, paramTypes[i]!, ctx);
                }
              }
            }

            // Re-lookup funcIdx: argument compilation may trigger addUnionImports
            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            // Use actual Wasm return type for .call()/.apply() on class methods
            if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
            return getWasmFuncReturnType(ctx, finalCallIdx) ?? VOID_RESULT;
          }
        }
      }
    }

    if (
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "console" &&
      (propAccess.name.text === "log" ||
        propAccess.name.text === "warn" ||
        propAccess.name.text === "error" ||
        propAccess.name.text === "info" ||
        propAccess.name.text === "debug")
    ) {
      return compileConsoleCall(ctx, fctx, expr, propAccess.name.text);
    }

    // (#1490) Non-WASI Node.js host mode: process.exit(code) and process.cwd().
    // process.exit routes to the __process_exit host import (calls real process.exit
    // when running under Node). process.cwd() returns a string via __get_process_cwd.
    if (!ctx.wasi && ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "process") {
      const isShadowed = fctx.localMap.has("process") || (fctx.boxedCaptures?.has("process") ?? false);
      if (!isShadowed) {
        const procMethod = propAccess.name.text;
        if (procMethod === "exit") {
          const idx = ensureLateImport(ctx, "__process_exit", [{ kind: "f64" }], []);
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            if (expr.arguments.length >= 1) {
              compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
            } else {
              fctx.body.push({ op: "f64.const", value: 0 });
            }
            fctx.body.push({ op: "call", funcIdx: idx });
          }
          return VOID_RESULT;
        }
        if (procMethod === "cwd") {
          const idx = ensureLateImport(ctx, "__get_process_cwd", [], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: idx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          return { kind: "externref" };
        }
      }
    }

    // (#1503) Web Crypto host imports: crypto.randomUUID() / crypto.getRandomValues(buf).
    // Available wherever the host exposes a `crypto` global (browsers + Node 19+).
    // In WASI mode there is no JS host, so the imports are still added but resolve
    // to a throw at runtime (no silent fallback to Math.random — that would be a
    // security trap, see issue #1503). Shadow-aware.
    if (ts.isIdentifier(propAccess.expression) && propAccess.expression.text === "crypto") {
      const isShadowed = fctx.localMap.has("crypto") || (fctx.boxedCaptures?.has("crypto") ?? false);
      if (!isShadowed) {
        const cryptoMethod = propAccess.name.text;
        if (cryptoMethod === "randomUUID") {
          const idx = ensureLateImport(ctx, "__crypto_random_uuid", [], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: idx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          return { kind: "externref" };
        }
        if (cryptoMethod === "getRandomValues") {
          // Compile the typed-array argument. Uint8Array compiles to a vec
          // struct typed `ref_null $vec_f64`. We need to pass the RAW
          // extern-wrapped vec to the host (so the host can call back
          // `__vec_set_byte(vec, i, byte)` and mutate the same struct).
          // The generic coerceType path would wrap the vec with
          // `__make_iterable` (so JS sees a real iterable) — but that
          // wrapping strips the vec identity, leaving the host unable to
          // ref.test against the vec type. Emit `extern.convert_any`
          // directly to bypass `__make_iterable`.
          const idx = ensureLateImport(
            ctx,
            "__crypto_get_random_values",
            [{ kind: "externref" }],
            [{ kind: "externref" }],
          );
          let preservedVecLocal: number | undefined;
          let preservedVecType: ValType | null = null;
          if (expr.arguments.length >= 1) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!);
            if (argType?.kind === "ref" || argType?.kind === "ref_null") {
              // Web Crypto returns the exact view it was given. Keep the typed
              // Wasm vec live across the host mutation instead of accepting
              // the import's necessarily-externref result: the latter loses
              // the vec's static carrier at a linked-module return boundary
              // (`uuid`'s rng() then observed length 0).
              preservedVecType = argType;
              preservedVecLocal = allocLocal(fctx, `__crypto_vec_${fctx.locals.length}`, argType);
              fctx.body.push({ op: "local.tee", index: preservedVecLocal });
              fctx.body.push({ op: "extern.convert_any" });
            } else if (argType && argType.kind !== "externref") {
              // Fall back to the standard coerce for non-ref result types.
              coerceType(ctx, fctx, argType, { kind: "externref" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          flushLateImportShifts(ctx, fctx);
          if (idx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: idx });
            if (preservedVecLocal !== undefined && preservedVecType !== null) {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "local.get", index: preservedVecLocal });
            }
          } else {
            // Fallback: pop the arg and push null so the stack stays balanced.
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "ref.null.extern" });
          }
          return preservedVecType ?? { kind: "externref" };
        }
      }
    }

    // WASI mode: process.exit(code) -> proc_exit(code)
    if (
      ctx.wasi &&
      ts.isIdentifier(propAccess.expression) &&
      propAccess.expression.text === "process" &&
      propAccess.name.text === "exit" &&
      ctx.wasiProcExitIdx >= 0
    ) {
      // #2735 — when the fd0 stdin reactor is active, drop its subscription
      // before `proc_exit` so the intent (terminate now) is explicit and the
      // run loop cannot out-live the exit. `proc_exit` already tears the whole
      // instance down, so this is belt-and-suspenders; it is gated on the
      // reactor being active so a `process.exit`-only program (no stdin) is
      // NOT forced to wire the reactor.
      if (isStdinReactorActive(ctx)) {
        emitStdinStop(ctx, fctx);
      }
      if (expr.arguments.length >= 1) {
        // #1801: `proc_exit` takes an i32 exit code. Compiling the argument
        // with expected type `{ kind: "i32" }` already delivers an i32 on the
        // stack (a numeric literal lowers directly to `i32.const N`, and
        // f64-valued expressions are truncated by coerceType). The previous
        // code *also* pushed `i32.trunc_sat_f64_s`, which expects an f64
        // operand — so the i32 already on the stack made the module fail
        // `WebAssembly.validate()` ("i32.trunc_sat_f64_s expected type f64,
        // found ... i32"). The expected-type compile and the truncation are
        // mutually exclusive; keep the former, drop the latter.
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" });
      } else {
        fctx.body.push({ op: "i32.const", value: 0 });
      }
      fctx.body.push({ op: "call", funcIdx: ctx.wasiProcExitIdx });
      return VOID_RESULT;
    }

    // (#742 slice 2) Built-in static-method dispatch — Math / BigInt / Number /
    // Array / String / Object namespace statics. Extracted verbatim to
    // compileBuiltinStaticCall; an `undefined` result means the callee is not a
    // builtin-static case, so dispatch continues below (Symbol / Reflect / …).
    {
      const __bsResult = compileBuiltinStaticCall(ctx, fctx, expr, propAccess);
      if (__bsResult !== undefined) return __bsResult;
    }

    // (#742 slice 3) Remaining namespace static-method dispatch — Symbol /
    // Reflect / Promise / JSON / Date statics. Extracted verbatim to
    // compileNamespaceStaticCall; an `undefined` result means the callee is not
    // one of these, so dispatch continues below (receiver-type method dispatch).
    {
      const __nsResult = compileNamespaceStaticCall(ctx, fctx, expr, propAccess);
      if (__nsResult !== undefined) return __nsResult;
    }

    // (#742 slice 4) Receiver-type method dispatch — class methods, Number /
    // BigInt / Boolean wrapper methods, generators, typed arrays, valueOf /
    // toString, keyed on the receiver's TS type. Extracted verbatim to
    // compileReceiverMethodCall; an `undefined` result means it was not handled
    // here, so the arm falls through to the post-arm dispatch (identifier / IIFE).
    {
      const __rmResult = compileReceiverMethodCall(ctx, fctx, expr, propAccess, expectedType);
      if (__rmResult !== undefined) return __rmResult;
    }
  }

  // (#742) Identifier-callee dispatch — node:fs global functions, inline
  // global builtins (parseInt/isNaN/parseFloat/isFinite/Array/…), and direct
  // named-function calls resolved via funcMap. Extracted verbatim to
  // compileIdentifierCall; an `undefined` result means the callee is not one
  // of these identifier cases, so dispatch continues below (IIFE / super / …).
  {
    const __idResult = compileIdentifierCall(ctx, fctx, expr, expectedType);
    if (__idResult !== undefined) return __idResult;
  }

  // (#4623) `<ordinary receiver>.isPrototypeOf(v)` — §20.1.3.4. Every arm above
  // has declined, so what remains is the tail dispatch, whose two possible
  // answers for this shape were both WRONG and lane-divergent: standalone took
  // the ref.test-guarded generic closure dispatch on a member read that
  // resolves to nothing (→ `false`), and the JS host took the graceful
  // `ref.null.extern` fallback (→ `undefined`). Both lanes model the
  // `[[Prototype]]` edge the predicate asks about, so route to the chain walk.
  // See is-prototype-of-call-arm.ts for the measurements and the guards.
  {
    const __ipoResult = tryEmitIsPrototypeOfCallArm(ctx, fctx, expr);
    if (__ipoResult !== undefined) return __ipoResult;
  }

  // (#742 slice 5) Tail dispatch — IIFE, super, element-access, call-of-call,
  // conditional callee, and the graceful fallback. Extracted verbatim to
  // compileTailDispatch, which always returns (its final fallback is
  // unconditional), so this is the sole tail return of compileCallExpression.
  return compileTailDispatch(ctx, fctx, expr, expectedType);
}

/**
 * (#3123) Generic dynamic method dispatch for a method MISS on a
 * fnctor-subclass receiver (`class C extends F`, F a top-level plain
 * function). The member may live on F's runtime-assigned `.prototype`
 * (host-side), so compile the receiver as externref (extern.convert_any for
 * the struct instance), marshal the args into a host JS array (native $ObjVec
 * under standalone), and call `__extern_method_call(recv, "<name>", args)` —
 * mirroring the any-receiver generic ladder (#799 WI3) so both entry points
 * behave identically. Helper indices are re-read from funcMap at each use so
 * late-import shifts during arg compilation cannot bake stale call targets.
 */
export function emitFnctorSubclassDynamicMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
  // (#3201) Marshal the receiver as the RAW wasm ref (`extern.convert_any`)
  // instead of compiling with an externref expected-type hint. The hint routes
  // a vec receiver through coerceType's `__make_iterable` arm, which COPIES
  // the vec into a fresh JS array — a new identity every crossing, so the
  // `_wasmStructProps` expando sidecar (where `arr.getClass = …` writes land,
  // keyed by the RAW struct) can never be found again at the call. The raw
  // struct keeps identity stable; `__extern_method_call` live-mirrors it via
  // `_wrapForHost` on the host side. Default false — the #3123
  // fnctor-subclass call sites keep their existing bytes.
  rawStructReceiver = false,
): InnerResult | undefined {
  if (!ctx.standalone && !ctx.wasi) ctx.hostDynamicClassMethodNames.add(methodName);
  let arrNewIdx: number | undefined;
  let arrPushIdx: number | undefined;
  const arrNewName = ctx.standalone ? "__objvec_new" : "__js_array_new";
  const arrPushName = ctx.standalone ? "__objvec_push" : "__js_array_push";
  if (ctx.standalone) {
    const b = ensureObjVecBuilders(ctx);
    arrNewIdx = b.newIdx;
    arrPushIdx = b.pushIdx;
  } else {
    arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
    arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  }
  const methodCallIdx = ensureLateImport(
    ctx,
    "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  // The fallback's method-name string constant, materialized BEFORE any body
  // instructions so the global index is settled.
  addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);
  if (methodCallIdx === undefined || arrNewIdx === undefined || arrPushIdx === undefined) return undefined;

  const recvType = rawStructReceiver
    ? compileExpression(ctx, fctx, propAccess.expression)
    : compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (recvType.kind === "ref" || recvType.kind === "ref_null" || recvType.kind === "anyref") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (recvType.kind !== "externref") {
    // Raw mode can surface a scalar (defensive — the #3201 arm gates on
    // ref-typed receivers); box via the shared coercion path.
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  const recvLocal = allocLocal(fctx, `__fsd_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(arrNewName) ?? arrNewIdx });
  const argsLocal = allocLocal(fctx, `__fsd_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argType && argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // (#3429) See maybeStampCompiledFunctionArgName — no-ops outside JS-host.
    maybeStampCompiledFunctionArgName(ctx, fctx, arg);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(arrPushName) ?? arrPushIdx });
  }
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_method_call") ?? methodCallIdx });
  return { kind: "externref" };
}

/**
 * Compile a call with a ConditionalExpression callee: (cond ? fn1 : fn2)(args)
 *
 * We compile the condition, then emit an if/else where each branch makes
 * the call with the respective callee.
 *
 * Cannot create synthetic CallExpression via ts.factory because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler above.
 */
export function compileConditionalCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  condExpr: ts.ConditionalExpression,
): InnerResult {
  // Compile condition
  const condType = compileExpression(ctx, fctx, condExpr.condition);
  if (!condType) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    ensureI32Condition(fctx, condType, ctx);
  }

  // Determine the expected return type of the call from the original expression
  const callSig = ctx.checker.getResolvedSignature(expr);
  let callRetType: ValType | null = null;
  if (callSig) {
    const retTsType = ctx.checker.getReturnTypeOfSignature(callSig);
    if (!isVoidType(retTsType)) {
      callRetType = resolveWasmType(ctx, retTsType);
    }
  }

  // Helper: compile a call branch by constructing the call inline
  // Uses the branch expression (whenTrue or whenFalse) as the callee.
  function compileBranchCall(branchExpr: ts.Expression): InnerResult {
    // If the branch is an identifier referencing a known function, call it directly
    if (ts.isIdentifier(branchExpr)) {
      const funcName = branchExpr.text;
      let closureInfo = ctx.closureMap.get(funcName);
      if (!closureInfo) {
        closureInfo = resolveClosureInfoFromLocal(ctx, fctx, funcName);
      }
      if (closureInfo) {
        // Use the original expr's arguments but with this identifier as callee
        // Create a minimal synthetic object that mimics a CallExpression
        // for compileClosureCall
        const syntheticCall = Object.create(expr);
        syntheticCall.expression = branchExpr;
        return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
      }
      const funcIdx = ctx.funcMap.get(funcName);
      if (funcIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const ccParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
        for (let i = 0; i < expr.arguments.length; i++) {
          if (i < ccParamCount) {
            compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          } else {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing arguments with defaults
        if (paramTypes) {
          for (let i = expr.arguments.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx;
        maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, ccParamCount);
        fctx.body.push({ op: "call", funcIdx: finalFuncIdx });
        // The checker's result for the *conditional call* is only the desired
        // join representation. It does not describe what this direct branch
        // physically leaves on the Wasm stack. For example, lodash's
        // `arrayEach` returns the canonical vec ref while `baseForOwn` returns
        // externref, even though the conditional call is typed as `any`.
        // Report the emitted function's real result here so the join below can
        // insert the required ref -> externref conversion.
        if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
        const actualRetType = getWasmFuncReturnType(ctx, finalFuncIdx);
        if (actualRetType) return actualRetType;
        if (callRetType) return callRetType;
        // Try to determine return type from the branch function's signature
        const branchType = ctx.checker.getTypeAtLocation(branchExpr);
        const branchSigs = branchType.getCallSignatures?.();
        if (branchSigs && branchSigs.length > 0) {
          const retType = ctx.checker.getReturnTypeOfSignature(branchSigs[0]!);
          if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
          return brandExternMethodResult(
            ctx,
            retType,
            getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType),
          );
        }
        return callRetType ?? getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
      }
    }

    // If the branch is itself a conditional, recurse
    if (ts.isConditionalExpression(branchExpr)) {
      return compileConditionalCallee(ctx, fctx, expr, branchExpr);
    }

    // If the branch is wrapped in parens, unwrap
    if (ts.isParenthesizedExpression(branchExpr)) {
      let inner: ts.Expression = branchExpr;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      return compileBranchCall(inner);
    }

    // If the branch is a property access, try method call
    if (ts.isPropertyAccessExpression(branchExpr)) {
      // Create a synthetic call with the property access as callee
      // PropertyAccessExpression IS a LeftHandSideExpression so no infinite recursion
      const syntheticCall = ts.factory.createCallExpression(branchExpr, expr.typeArguments, expr.arguments);
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }

    // Fallback: compile expression value and try to use as closure call
    const calleeType = compileExpression(ctx, fctx, branchExpr);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    if (callRetType) {
      pushDefaultValue(fctx, callRetType, ctx);
      return callRetType;
    }
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }

  // Compile then-branch call
  const savedBody = fctx.body;
  fctx.body = [];
  const thenType = compileBranchCall(condExpr.whenTrue);
  let thenInstrs = fctx.body;

  // Compile else-branch call
  fctx.body = [];
  const elseType = compileBranchCall(condExpr.whenFalse);
  let elseInstrs = fctx.body;

  fctx.body = savedBody;

  // Determine result type
  if (thenType === VOID_RESULT && elseType === VOID_RESULT) {
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: elseInstrs,
    });
    return VOID_RESULT;
  }

  // Coerce branches to a common type
  const thenVal: ValType = thenType && thenType !== VOID_RESULT ? thenType : (callRetType ?? { kind: "f64" });
  const elseVal: ValType = elseType && elseType !== VOID_RESULT ? elseType : (callRetType ?? { kind: "f64" });
  let resultType: ValType = callRetType ?? thenVal;

  // If types don't match, coerce both to the result type
  if (!valTypesMatch(thenVal, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, thenVal, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }
  if (!valTypesMatch(elseVal, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, elseVal, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  // Handle void branches that need to produce a value
  if (thenType === VOID_RESULT || thenType === null) {
    thenInstrs = [...thenInstrs, ...defaultValueInstrs(resultType)];
  }
  if (elseType === VOID_RESULT || elseType === null) {
    elseInstrs = [...elseInstrs, ...defaultValueInstrs(resultType)];
  }

  // Widen ref to ref_null when a branch uses defaultValueInstrs (which produces ref.null)
  if (
    resultType.kind === "ref" &&
    (thenType === VOID_RESULT || thenType === null || elseType === VOID_RESULT || elseType === null)
  ) {
    resultType = { kind: "ref_null", typeIdx: (resultType as any).typeIdx };
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  return resultType;
}

/**
 * Compile a call where the callee is an arbitrary expression that is not a
 * LeftHandSideExpression (e.g. assignment: `(x = fn)()`, logical: `(a || fn)()`).
 *
 * We cannot use ts.factory.createCallExpression for these because it wraps
 * non-LeftHandSideExpression callees in ParenthesizedExpression, causing
 * infinite recursion with the paren-unwrapping handler.
 *
 * Strategy: compile the callee expression to get its value on the stack,
 * then try to use the result as a closure call (closure-matching by type),
 * or as a direct function call if the expression resolves to a known function.
 */
function compileExpressionCallee(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  calleeExpr: ts.Expression,
): InnerResult {
  // For assignment expressions, we can look at the RHS to identify the function
  // being called, while still compiling the full assignment for side effects.
  if (
    ts.isBinaryExpression(calleeExpr) &&
    calleeExpr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    calleeExpr.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    calleeExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    // For simple assignment (x = fn)(), compile the assignment for side effects
    // then call the RHS function directly if it's identifiable.
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs)) {
      const funcIdx = ctx.funcMap.get(rhs.text);
      const closureInfo = ctx.closureMap.get(rhs.text);
      if (funcIdx !== undefined || closureInfo) {
        // Compile the full assignment for side effects (stores value in LHS)
        const assignResult = compileExpression(ctx, fctx, calleeExpr);
        if (assignResult) {
          fctx.body.push({ op: "drop" });
        }
        // Now make a direct call using the RHS identifier as callee
        const syntheticCall = ts.factory.createCallExpression(rhs, expr.typeArguments, expr.arguments);
        ts.setTextRange(syntheticCall, expr);
        (syntheticCall as any).parent = expr.parent;
        return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
      }
    }
  }

  // Generic path: compile the callee expression and try closure-matching
  const calleeTsType = ctx.checker.getTypeAtLocation(calleeExpr);
  const callSigs = calleeTsType.getCallSignatures?.();

  if (callSigs && callSigs.length > 0) {
    const sig = callSigs[0]!;

    // Look for a matching closure type. (#4491) `runtimeSignatureParameters`
    // drops the synthetic `(...args: any[])` the checker gives a JS function
    // that reads `arguments` — it has no formal slot in the compiled callee, and
    // counting it here nulls the coerced argument and mis-reports `__argc`
    // (`__FUNC()(__JEDI)` in S13.2_A2_T1).
    const runtimeSigParams = runtimeSignatureParameters(sig);
    const sigParamCount = runtimeSigParams.length;
    const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
    const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
    const sigParamWasmTypes: ValType[] = [];
    for (let i = 0; i < sigParamCount; i++) {
      const paramType = ctx.checker.getTypeOfSymbol(runtimeSigParams[i]!);
      sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
    }

    // (#4394) Exact-first (typeIdx-aware) matching — the old kind-only linear
    // scan picked whichever same-arity closure registered first, and a wrong
    // ref-result typeIdx makes the guarded funcref cast below null → call_ref
    // trap (standalone deepEqual-* family). Mechanism in closure-sig-match.ts.
    const sigMatched = matchClosureInfoBySignature(ctx, sigParamWasmTypes, sigRetWasm, {
      sigHasRest: tsSignatureHasRest(sig),
    });
    const matchedClosureInfo: ClosureInfo | undefined = sigMatched?.info;
    const matchedStructTypeIdx: number | undefined = sigMatched?.structTypeIdx;

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile the callee expression to get the closure on the stack
      const innerResultType = compileExpression(ctx, fctx, calleeExpr);
      const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, matchedClosureInfo.funcTypeIdx) ?? matchedStructTypeIdx;
      const closureRefType: ValType = { kind: "ref_null", typeIdx: selfTypeIdx };

      // Normalize an erased shared closure to the canonical root. Private/named
      // closure funcs still resolve to their concrete self type.
      const closureLocal = allocLocal(fctx, `__expr_call_${fctx.locals.length}`, closureRefType);
      if (innerResultType?.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, selfTypeIdx);
      } else if (
        innerResultType &&
        (innerResultType.kind === "ref" || innerResultType.kind === "ref_null") &&
        innerResultType.typeIdx !== selfTypeIdx
      ) {
        emitGuardedRefCast(fctx, selfTypeIdx);
      }
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, closureRefType);

      // Push call arguments (only up to declared param count)
      const ecParamCnt = matchedClosureInfo.paramTypes.length;
      // biome-ignore lint/complexity/noUselessLoneBlockStatements: groups arg-emit + extras-pack as one logical unit
      {
        for (let i = 0; i < Math.min(expr.arguments.length, ecParamCnt); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
      }

      // Pad missing arguments
      for (let i = expr.arguments.length; i < ecParamCnt; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
      }

      // (#1511) Indirect call — propagate overflow args via __extras_argv so
      // a callee reading `arguments` gets the correct length.
      emitClosureCallArgcExtras(ctx, fctx, expr.arguments, ecParamCnt);

      // Push the funcref from closure struct and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, closureRefType);
      fctx.body.push({
        op: "struct.get",
        typeIdx: selfTypeIdx,
        fieldIdx: 0,
      });
      // Guard funcref cast to avoid illegal cast (#778)
      emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      // (#1511) Cleanup
      if (matchedClosureInfo.returnType === null) {
        emitResetArgcExtras(ctx, fctx);
      } else {
        const _retLocal = allocLocal(fctx, `__ec_ret_${fctx.locals.length}`, matchedClosureInfo.returnType);
        fctx.body.push({ op: "local.set", index: _retLocal });
        emitResetArgcExtras(ctx, fctx);
        fctx.body.push({ op: "local.get", index: _retLocal });
      }

      return matchedClosureInfo.returnType ?? VOID_RESULT;
    }
  }

  // Last resort: compile the callee for side effects and try to resolve
  // the call via the RHS of an assignment or the last operand
  if (ts.isBinaryExpression(calleeExpr)) {
    const assignResult = compileExpression(ctx, fctx, calleeExpr);
    if (assignResult) {
      fctx.body.push({ op: "drop" });
    }
    // Try calling the RHS (for assignment) or right operand (for logical)
    const rhs = calleeExpr.right;
    if (ts.isIdentifier(rhs) || ts.isPropertyAccessExpression(rhs)) {
      const syntheticCall = ts.factory.createCallExpression(
        rhs as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Graceful fallback for non-LHSE callee: compile callee and args for side effects,
  // return externref null. Avoids hard compile errors for uncommon callee shapes.
  {
    const calleeType = compileExpression(ctx, fctx, calleeExpr);
    if (calleeType) {
      fctx.body.push({ op: "drop" });
    }
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType) {
        fctx.body.push({ op: "drop" });
      }
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
}

/**
 * Compile an IIFE (Immediately Invoked Function Expression):
 *   (function(params) { body })(args)
 *
 * Strategy: compile the function expression as a named module-level function
 * with a unique synthetic name, then emit a direct call to it.
 * Captures from the enclosing scope are passed as extra leading parameters.
 *
 * Returns undefined if the expression is not an IIFE pattern.
 */
function compileIIFE(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult | undefined {
  // Unwrap parenthesized expression to find the function expression
  let callee: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(callee)) {
    callee = callee.expression;
  }
  if (!ts.isFunctionExpression(callee) && !ts.isArrowFunction(callee)) {
    return undefined; // not an IIFE
  }
  // Generator function expressions (function*) cannot be inlined as IIFEs
  // because their body uses `yield` which requires a generator FunctionContext (#657).
  if (ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined) {
    return undefined;
  }
  const funcExpr = callee as ts.FunctionExpression | ts.ArrowFunction;

  // Determine parameter types from the function's declared parameters
  const paramTypes: ValType[] = [];
  for (const p of funcExpr.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    paramTypes.push(resolveWasmType(ctx, paramType));
  }

  // Determine return type
  const sig = ctx.checker.getSignatureFromDeclaration(funcExpr);
  let returnType: ValType | null = null;
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      returnType = resolveWasmType(ctx, retType);
    }
  }

  // Analyze captured variables from the enclosing scope. A module initializer
  // has an empty local map, so no identifier in this IIFE can become a capture.
  // Avoid walking the entire IIFE AST in that common case.
  // This matters for bundled npm packages whose entry point is one giant IIFE
  // (TypeScript's published `lib/typescript.js` is ~1M AST nodes).
  const body = funcExpr.body;
  const referencedNames = new Set<string>();
  const writtenInIIFE = new Set<string>();
  const hasCaptureCandidate = fctx.localMap.size > 0;
  if (hasCaptureCandidate) {
    if (ts.isBlock(body)) {
      for (const stmt of body.statements) {
        collectReferencedIdentifiers(stmt, referencedNames);
      }
    } else {
      collectReferencedIdentifiers(body, referencedNames);
    }

    // Detect which captured variables are written inside the IIFE body
    if (ts.isBlock(body)) {
      for (const stmt of body.statements) {
        collectWrittenIdentifiers(stmt, writtenInIIFE);
      }
    } else {
      collectWrittenIdentifiers(body, writtenInIIFE);
    }
  }

  const ownParamNames = new Set(
    funcExpr.parameters.filter((p) => ts.isIdentifier(p.name)).map((p) => (p.name as ts.Identifier).text),
  );

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
  }[] = [];
  for (const name of referencedNames) {
    if (ownParamNames.has(name)) continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    const isMutable = writtenInIIFE.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable });
  }

  // Generate a unique name for the IIFE
  const iifeName = `__iife_${ctx.closureCounter++}`;
  const results: ValType[] = returnType ? [returnType] : [];

  // Build parameter types: for mutable captures use ref cells, others pass by value
  // Use ref_null for ref types to allow null default initialization (var hoisting)
  const captureParamTypes = captures.map((c) => {
    if (c.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
      return { kind: "ref_null" as const, typeIdx: refCellTypeIdx };
    }
    // Widen ref to ref_null so hoisted vars initialized to null can be passed
    if (c.type.kind === "ref") {
      return {
        kind: "ref_null" as const,
        typeIdx: (c.type as { typeIdx: number }).typeIdx,
      };
    }
    return c.type;
  });
  const allParamTypes = [...captureParamTypes, ...paramTypes];
  const funcTypeIdx = addFuncType(ctx, allParamTypes, results, `${iifeName}_type`);

  const liftedFctx: FunctionContext = {
    name: iifeName,
    params: [
      ...captures.map((c, i) => ({
        name: c.name,
        type: captureParamTypes[i]!,
      })),
      ...funcExpr.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: paramTypes[i] ?? ({ kind: "f64" } as ValType),
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // This fallback emits a real Wasm function instead of using the inline-IIFE
  // fast path, so register its source strictness like every other source body.
  initializeFunctionPoisonPillContext(ctx, liftedFctx, funcExpr);

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // For mutable captures, register them as boxed so read/write uses struct.get/set.
  // Also register non-mutable captures that are already boxed in the outer scope.
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, {
        refCellTypeIdx,
        valType: cap.type,
      });
    } else {
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, {
          refCellTypeIdx: outerBoxed.refCellTypeIdx,
          valType: outerBoxed.valType,
        });
      }
    }
  }

  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;

  // A lifted IIFE is a real function activation. Its parameter defaults must
  // run in the synthesized callee before the body, just like defaults on a
  // source FunctionDeclaration. The old path only padded missing numeric
  // arguments with NaN and entered the body directly, so `function (x = 1)`
  // observed NaN whenever the call omitted `x`.
  emitDefaultParamInit(ctx, liftedFctx, funcExpr, paramTypes, captures.length);

  if (ts.isBlock(body)) {
    // A published package may be one enormous bundler IIFE. Attribute its
    // pre-body analyses separately so a bounded worker distinguishes a scope
    // hoist from statement emission. Small ordinary IIFEs keep the original
    // straight-line calls and allocate no profiling closures.
    if (body.statements.length >= 1_000) {
      profilePhase("large-iife-hoist-vars", () => hoistVarDeclarations(ctx, liftedFctx, body.statements));
      profilePhase("large-iife-hoist-let-const", () => hoistLetConstWithTdz(ctx, liftedFctx, body.statements));
      profilePhase("large-iife-hoist-functions", () => hoistFunctionDeclarations(ctx, liftedFctx, body.statements));
      profilePhase("large-iife-compile-statements", () => {
        for (const stmt of body.statements) compileStatement(ctx, liftedFctx, stmt);
      });
    } else {
      // Hoist var declarations and let/const with TDZ flags (#790)
      hoistVarDeclarations(ctx, liftedFctx, body.statements);
      hoistLetConstWithTdz(ctx, liftedFctx, body.statements);
      hoistFunctionDeclarations(ctx, liftedFctx, body.statements);
      for (const stmt of body.statements) compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    // Concise arrow body — expression is the return value
    const exprType = compileExpression(ctx, liftedFctx, body, returnType ?? undefined);
    if (exprType === null && returnType) {
      // Push default return value
      if (returnType.kind === "f64") liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32") liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref") liftedFctx.body.push({ op: "ref.null.extern" });
    }
    if (returnType) {
      // The concise expression itself is the function result. Terminate the
      // lifted IIFE here so the generic fallthrough-default guard below does
      // not append a second value above it. In particular, `() => dispatch()`
      // returns the Promise produced by dispatch; appending ref.null.extern
      // launched that Promise but made the callback return null, so an outer
      // await resumed early while the real continuation ran unhandled.
      liftedFctx.body.push({ op: "return" });
    } else if (exprType !== null) {
      // A contextually-void concise callback still evaluates its expression
      // for side effects, but its value is not part of the Wasm ABI.
      liftedFctx.body.push({ op: "drop" });
    }
  }

  // Append default return if needed
  if (returnType) {
    const lastInstr = liftedFctx.body[liftedFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (returnType.kind === "f64") liftedFctx.body.push({ op: "f64.const", value: 0 });
      else if (returnType.kind === "i32") liftedFctx.body.push({ op: "i32.const", value: 0 });
      else if (returnType.kind === "externref") liftedFctx.body.push({ op: "ref.null.extern" });
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // Register the lifted function
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: iifeName,
    typeIdx: funcTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(iifeName, funcIdx);

  // Emit the call: push captures (with ref cells for mutable ones), then arguments, then call
  for (const cap of captures) {
    if (cap.mutable) {
      // Wrap the current value in a ref cell for mutable capture
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
      // Check if the outer local is already boxed
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass directly
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        // Create a ref cell, store value, keep ref on stack
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Also box the outer local so subsequent reads/writes go through the ref cell
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        // Re-register the original name to point to the boxed local
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }

  // Compile call arguments, matching to declared params; extras are evaluated and dropped
  // Flatten spread elements on array literals into individual expressions
  const flatIIFEArgs = flattenCallArgs(expr.arguments) ?? (expr.arguments as unknown as ts.Expression[]);
  const paramCount = paramTypes.length;
  for (let i = 0; i < flatIIFEArgs.length; i++) {
    const arg = flatIIFEArgs[i]!;
    // Skip any remaining spread elements that couldn't be flattened
    if (ts.isSpreadElement(arg)) continue;
    if (i < paramCount) {
      compileExpression(ctx, fctx, arg, paramTypes[i]);
    } else {
      // Extra argument — evaluate for side effects, drop result
      const extraType = compileExpression(ctx, fctx, arg);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }

  // Supply defaults for missing params (use NaN sentinel for f64, #787)
  for (let i = flatIIFEArgs.length; i < paramCount; i++) {
    const pt = paramTypes[i] ?? { kind: "f64" as const };
    if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: NaN });
    else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
    else if (pt.kind === "ref" || pt.kind === "ref_null") fctx.body.push({ op: "ref.null", typeIdx: pt.typeIdx });
  }

  // Numeric defaults use the exact call-site argc rather than treating an
  // arbitrary NaN payload as the missing-argument sentinel. The synthesized
  // callee consumes this value once and resets the shared carrier to -1.
  if (funcExpr.parameters.some((param) => param.initializer)) {
    const argcGlobalIdx = ensureArgcGlobal(ctx);
    fctx.body.push({ op: "i32.const", value: Math.min(flatIIFEArgs.length, paramCount) });
    fctx.body.push({ op: "global.set", index: argcGlobalIdx });
  }

  // Re-lookup in case addUnionImports shifted indices
  const finalFuncIdx = ctx.funcMap.get(iifeName) ?? funcIdx;
  fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

  if (returnType) return returnType;
  return VOID_RESULT;
}

// ── New expressions ──────────────────────────────────────────────────

/** Resolve the enclosing class name from a FunctionContext.
 *  Uses enclosingClassName if set (e.g. closures), otherwise parses ClassName from "ClassName_methodName". */

// ── #2922 arms 2+3 — dynamic Promise.all/race argument ──────────────────────

/**
 * (#2922) Decide whether a probed (and rolled-back) combinator argument may
 * take the dynamic `__combinator_to_vec` path. Everything EXCEPT the shapes
 * that must keep the host fallthrough byte-unchanged:
 *   - `__vec_*` structs that are not externref-backed (`number[]` — the Gap-4
 *     output-representation escalation documented in promise-combinators.ts);
 *     externref-backed vecs were already committed by arm 1.
 *   - strings when native strings are OFF (#2867 string-combinator slice:
 *     with them ON the drain has a code-point string arm, so strings take
 *     the dynamic path; with the arm absent they'd WRONGLY reject).
 *   - native-generator subjects: they iterate via the dedicated compile-time
 *     resume path (`emitNativeGeneratorToVec`), not the runtime dispatchers —
 *     the drain would wrongly reject them. Follow-up.
 *   - funcref/v128/i64-shaped values: conservative fallthrough.
 */
export function isDynamicCombinatorArgEligible(
  ctx: CodegenContext,
  argType: ValType | null,
  arg0: ts.Expression,
): boolean {
  if (argType === null) return false;
  if (ctx.nativeStrings !== true && isStringType(ctx.checker.getTypeAtLocation(arg0))) return false;
  switch (argType.kind) {
    case "f64":
    case "i32":
    case "externref":
    case "anyref":
    case "eqref":
      return true;
    case "ref":
    case "ref_null": {
      const typeIdx = (argType as { typeIdx?: number }).typeIdx;
      if (typeof typeIdx !== "number" || typeIdx < 0) return false;
      const structName = ctx.typeIdxToStructName.get(typeIdx);
      if (structName !== undefined && structName.startsWith("__vec_")) return false;
      if (typeIdx === ctx.anyStrTypeIdx || typeIdx === ctx.nativeStrTypeIdx || typeIdx === ctx.consStrTypeIdx) {
        return ctx.nativeStrings === true;
      }
      if (nativeGeneratorInfoForForOfSubject(ctx, argType) !== undefined) return false;
      return true;
    }
    default:
      return false;
  }
}

/**
 * (#2922 arms 2+3) Emit the dynamic combinator argument path:
 *
 *   arg      = <compile arg0 as externref>
 *   drained  = __combinator_to_vec(arg)       ;; $Vec | null (= not iterable)
 *   notIter  = drained == null                ;; (empty vec substituted)
 *   <arm-1 runtime loop over drained, rejecting the result promise with a
 *    native TypeError when notIter — see emitStandalonePromiseCombinatorRuntime>
 *
 * ALL ensure* registrations run BEFORE any instruction is built so no late
 * import can land between an instr's funcIdx bake and its landing in
 * `fctx.body` (where `shiftLateImportIndices` walks it, nested arms included).
 * `ensureNativeIteratorRuntime` is required so `emitIteratorMethodExport`
 * actually emits the `__call_*` dispatchers at finalize (it early-returns
 * unless `__iterator` is registered) — without it `fillCombinatorToVec`
 * could never fill the user-iterable arm.
 */
export function emitDynamicCombinatorArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: NativeCombinator,
  arg0: ts.Expression,
): ValType {
  ensureNativeIteratorRuntime(ctx);
  const ids = ensureCombinatorFunctions(ctx);
  ensureCombinatorToVec(ctx);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const msg = `Promise.${methodName} argument is not iterable`;
  addStringConstantGlobal(ctx, msg);

  // arg → externref (committed compile; the natural-type probe was rolled back).
  compileExpression(ctx, fctx, arg0, { kind: "externref" });
  const argLocal = allocLocal(fctx, `__comb_dynarg_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argLocal });

  // drained = __combinator_to_vec(arg)
  const drainedLocal = allocLocal(fctx, `__comb_drained_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.get", index: argLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__combinator_to_vec")! });
  fctx.body.push({ op: "local.set", index: drainedLocal });

  // notIter = drained == null; vec = notIter ? <fresh empty $Vec> : cast(drained)
  const notIterLocal = allocLocal(fctx, `__comb_notiter_${fctx.locals.length}`, { kind: "i32" });
  const vecLocal = allocLocal(fctx, `__comb_argvec_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ids.vecTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: drainedLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: notIterLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: ids.arrTypeIdx },
      { op: "struct.new", typeIdx: ids.vecTypeIdx },
      { op: "local.set", index: vecLocal },
    ],
    else: [
      { op: "local.get", index: drainedLocal },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: ids.vecTypeIdx },
      { op: "local.set", index: vecLocal },
    ],
  });

  // Reject-reason instrs (externref TypeError instance). funcMap is read AFTER
  // every ensure above (and after the arg compile), so the baked funcIdx is
  // current; once embedded in fctx.body (inside the emitter's `if` arm) any
  // later shift walks it like every other nested instruction.
  const rejectReason: Instr[] = [
    ...stringConstantExternrefInstrs(ctx, msg),
    { op: "call", funcIdx: ctx.funcMap.get("__new_TypeError")! },
  ];

  return emitStandalonePromiseCombinatorRuntime(ctx, fctx, methodName, vecLocal, ids.vecTypeIdx, ids.arrTypeIdx, {
    notIterLocal,
    rejectReason,
  });
}

/**
 * (#2875) Lib INTERFACE name (`String`, `Array`, …) → the registered
 * `$NativeProto` brand whose member closures model that prototype, ensuring the
 * glue on the way. `undefined` for an interface with no wired glue.
 *
 * Shared with `transferred-native-proto-call.ts` so the two spellings of the
 * same operation — `String.prototype.m.call(x)` and `x.m = String.prototype.m;
 * x.m()` — resolve the same brand by construction rather than by coincidence.
 */
export function nativeProtoBrandForInterface(ctx: CodegenContext, ifaceName: string): number | undefined {
  if (ifaceName === "Array" || ifaceName === "ReadonlyArray") return ensureArrayNativeProtoGlue(ctx);
  if (ifaceName === "Object") return ensureObjectNativeProtoGlue(ctx);
  // ES2015 Error.prototype.toString is a reflective native-proto member just
  // like the other standalone Error-family prototype methods. Keep this
  // resolver arm narrow: the shared body in array-object-proto.ts owns the
  // actual ordered Get/ToString semantics and NativeError inheritance.
  if (ifaceName === "Error") return ensureErrorNativeProtoGlue(ctx);
  if (
    ifaceName === "TypeError" ||
    ifaceName === "RangeError" ||
    ifaceName === "SyntaxError" ||
    ifaceName === "URIError" ||
    ifaceName === "EvalError" ||
    ifaceName === "ReferenceError"
  ) {
    return ensureNativeErrorNativeProtoGlue(ctx, ifaceName);
  }
  if (ifaceName === "String") return ensureStringNativeProtoGlue(ctx); // (#2875)
  if (ifaceName === "DataView") return ensureDataViewNativeProtoGlue(ctx); // (#3173)
  if (ifaceName === "ArrayBuffer") return ensureArrayBufferNativeProtoGlue(ctx); // (#1595)
  if (ifaceName === "Date") return ensureDateNativeProtoGlue(ctx); // (#3219)
  return undefined;
}

export { compileCallExpression, compileIIFE, compileOptionalCallExpression };
