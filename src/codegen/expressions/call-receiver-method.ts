// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Receiver-type method-call dispatch extracted from the tail of the ~13k-line
// compileCallExpression's property-access arm (#742, Wave B mega-function
// decomposition, slice 4). The single exported entry `compileReceiverMethodCall`
// is the `receiverType`-keyed half of the arm: it resolves the receiver's
// TypeScript type and dispatches user-class instance methods, Number / BigInt /
// Boolean wrapper methods, generator methods, typed-array methods, and the
// generic valueOf / toString / toLocaleString fallbacks. It returns `undefined`
// when nothing matched, so the caller in calls.ts continues its post-arm
// dispatch. Moved verbatim: the emitted Wasm is byte-identical.
import { ts } from "../../ts-api.js";
import {
  isBigIntType,
  isBooleanType,
  isBooleanWrapperType,
  isExternalDeclaredClass,
  isGeneratorType,
  isNumberType,
  isNumberWrapperType,
  isStringType,
  isStringWrapperType,
  isSymbolType,
} from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { compileArrayMethodCall, resolveArrayInfo } from "../array-methods.js";
import { isWiredTypedArrayViewName } from "../array-object-proto.js";
import {
  emitStandalonePromiseFinally,
  emitStandalonePromiseThen,
  isStandaloneThenChainNativeActive,
} from "../async-scheduler.js";
import { isSupportedBuiltinStaticProperty, resolveBuiltinNamespaceValueName } from "../builtin-static-globals.js";
import { classMemberFuncKey, fnctorAncestorOfClass } from "../class-member-keys.js";
import { reserveClosedMethodDispatch, reserveClosedMethodDispatchVararg } from "../closed-method-dispatch.js";
import { compileArrowAsClosure, computeClosureWrapperSig } from "../closures.js";
import { tryEmitDirectTwinCall } from "../typed-this.js"; // (#3683 S3) direct-call devirtualization
import { undefinedExternInstrs } from "../any-helpers.js"; // (#3683 S3b) arity-padding sentinel
import { pushBody } from "../context/bodies.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolveReceiverStruct } from "../fnctor-escape-gate.js";
import { tryEmitFixedHostMethodCall } from "../fixed-host-method-call.js";
import { hostFnctorCallableFallbackImportName, reserveHostFnctorMethodDriver } from "../host-fnctor-method-driver.js";
import { tryCompileHostStringPredicate } from "../host-string-prefix-suffix.js";
import { observeHostDynamicMethodCallArity } from "../dynamic-method-call-arity.js";
import { effectiveLocalCarrier } from "../analysis/mixed-assignment-carrier.js";
import { staticIntegerRange } from "../../ir/analysis/static-numeric-range.js";
import {
  emitArrayBufferResize,
  emitArrayBufferSlice,
  emitArrayBufferTransfer,
  emitDataViewAccessor,
  ensureDvAccessorHelper,
  ensureTaDynCopyWithinHelper,
  ensureTaDynFillHelper,
  ensureTaDynReverseHelper,
  ensureTaFromArrayLikeHelper,
  isDataViewAccessor,
  usesNativeDataViewProvider,
} from "../dataview-native.js";
import { ensureNativeArrayFromIterN, ensureNativeArrayFromMapped } from "../iterator-native.js";
import { tryCompileNativeGeneratorMethodCall } from "../generators-native.js";
import { NATIVE_HOF_METHODS } from "../hof-native.js";
import {
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  ensureExnTag,
  getOrRegisterVecType,
  nativeStringType,
  reserveVecMethodHelper,
  resolveWasmType,
  STRING_METHODS,
  typedArrayVecStorage,
} from "../index.js";
import { LAZY_ITER_METHODS } from "../iter-lazy-native.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { usesNativeNumberFormat } from "../number-format-native.js";
import { ensureStandaloneRegExpCarrierTestHelper } from "../regexp-standalone.js";
import { compilePropertyIntrospection } from "../object-ops.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveBindDynHelper } from "../object-runtime.js";
import {
  emitNullCheckThrow,
  receiverIsCaughtErrorStringRead,
  receiverIsNativeStringValType,
  receiverMayBeNativeStringAtRuntime,
  typeErrorThrowInstrs,
} from "../property-access.js";
import type { InnerResult } from "../shared.js";
import {
  brandExternMethodResult,
  coerceType,
  compileExpression,
  skipTransparentExpressions,
  valTypesMatch,
  VOID_RESULT,
} from "../shared.js";
import { tryBuiltinPrototypeMethodBrandThrow } from "../builtin-prototype-brand.js";
import {
  emitSetExtrasArgv,
  ensureArgcGlobal,
  ensureCurrentThisGlobal,
  maybeSetArgcForKnownCall,
} from "../statements/nested-declarations.js";
import {
  compileGuardedNativeStringMethodCall,
  compileNativeStringMethodCall,
  compileStringLiteral,
  emitBoolToString,
  isStaticUndefinedArg,
} from "../string-ops.js";
import { tryCompileIndexOfHoistedUndefinedSearch } from "../string-indexof-undefined.js";
import { tryEmitStaticI32Expression } from "../i32-static-range-expr.js";
import { emitSymbolToString } from "../symbol-native.js";
import { ensureTaMapFilterHelper } from "../ta-hof-map-filter.js";
import { ensureUint8ToBase64, ensureUint8ToHex } from "../uint8-codec.js";
import { tryCompileTemporalMethodCall } from "../temporal-native.js";
import { ensureTextEncodingHelpers } from "../text-encoding-native.js";
import { defaultValueInstrs, emitGuardedRefCast, pushDefaultValue } from "../type-coercion.js";
import { compileDateMethodCall } from "./builtins.js";
import {
  compileCallablePropertyCall,
  compileGetterCallable,
  compileObjectPrototypeFallback,
  tryExternClassMethodOnAny,
} from "./calls-closures.js";
import { sourceDefinesFunctionMember } from "../source-function-members.js";
import { compileExternMethodCall } from "./extern.js";
import { tryEmitValueOfFallback } from "./valueof-fallback.js";
import { sourceOverridesMethodOnReceiver } from "./member-override-scan.js";
import { compileInternalCallArgument } from "./internal-call-argument.js";
import {
  directObjectMethodFuncIdx,
  emitKnownRestMethodArguments,
  knownMethodRestInfo,
} from "./object-method-rest-abi.js";
import {
  buildThrowJsErrorInstrs,
  canonicalClassExpressionName,
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  maybeStampCompiledFunctionArgName,
  noJsHost,
  resolveReceiverMethodClassName,
  usesNativeJsErrors,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { resolveStructName } from "./misc.js";
import {
  BUILTIN_CLASS_NAMES,
  coerceNumberMethodArgToF64,
  compileCallExpression,
  STANDALONE_TA_MAPFILTER_PACKED_VIEWS,
  STANDALONE_TA_SCALAR_HOFS,
  compileFunctionBind,
  usesNativeFunctionBindProvider,
  compilePromiseThenReceiverBuffer,
  compileStandalonePromiseThenCallback,
  emitFnctorSubclassDynamicMethodCall,
  emitNumberMethodReceiverF64,
  emitStandaloneFinallyWithNativeFallback,
  emitStandaloneThenWithNativeFallback,
  emitVirtualMethodDispatchByTag,
  emitWrapperDynamicMethodCall,
  flattenCallArgs,
  isNumberDotPrototype,
  isNumberMethodReceiver,
  normalizeNaNToZero,
  resolveAssignedNominalType,
  sourceHasMethodReassignment,
  standaloneThenMissArmCanBeNative,
  tryEmitAsyncGenNextDispatch,
  tryEmitAsyncGenReturnThrowDispatch,
} from "./calls.js";

/**
 * (#742 slice 4) Receiver-type method-call dispatch — extracted verbatim from
 * the tail of compileCallExpression's property-access arm. This is the
 * `receiverType`-keyed half: it resolves the receiver's TypeScript type and
 * dispatches user-class instance methods, Number / BigInt / Boolean wrapper
 * methods, generator methods, typed-array methods, and the generic
 * valueOf / toString / toLocaleString fallbacks.
 *
 * `propAccess` is the already-narrowed `expr.expression`; `expectedType` is
 * threaded through from the caller. The block computes `receiverType` /
 * `receiverClassName` itself (they are arm-local, unused after the arm), so it
 * is self-contained. Returns an InnerResult when it handled the call, or
 * `undefined` when nothing matched — the caller then continues its post-arm
 * dispatch (identifier / IIFE / super / element-access / conditional). Moved
 * unchanged so the emitted Wasm is byte-identical.
 */
/**
 * (#3177 slice 5) `%TypedArray%.of` / `%TypedArray%.from` STATIC methods on a
 * `$__ta_ctor` receiver VALUE (the testWithTypedArrayConstructors harness
 * shape: `TA.of(v0,…)` / `TA.from(src[, mapfn[, thisArg]])`). Emits a runtime
 * `ref.test $__ta_ctor` two-arm: a TA-constructor receiver builds a fresh
 * same-kind dyn-view (`__ta_from_arraylike` over an indexable carrier — the
 * packed `of` args as a `$ObjVec`, or the `from` source normalized via
 * `__array_from_iter_n` / `__array_from_mapped`); ANY other runtime value
 * (Array.of/from, user objects) falls through to the ordinary dispatcher,
 * byte-identical to today. Caller gates noJsHost + a live TA ctor type, so
 * host/gc and TA-free modules never reach here. Returns `{ kind: "externref" }`
 * when handled, or `null` when the shared builder is unavailable (caller keeps
 * its existing routing).
 */
function tryEmitTaStaticOfFrom(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  dispatchArgs: readonly ts.Expression[],
  methodName: string,
  dispatchIdx: number,
): InnerResult | null {
  const taFromIdx = ensureTaFromArrayLikeHelper(ctx);
  if (taFromIdx === undefined) return null;

  // Receiver (the ctor value) → local.
  const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvT && recvT.kind !== "externref") coerceType(ctx, fctx, recvT, { kind: "externref" });
  else if (recvT === null) fctx.body.push({ op: "ref.null.extern" });
  const recvLocal = allocLocal(fctx, `__tastat_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Args → locals (evaluated once, spec order — the else arm reuses them).
  const argLocals: number[] = [];
  for (const arg of dispatchArgs) {
    const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
    else if (at === null) fctx.body.push({ op: "ref.null.extern" });
    const aLocal = allocLocal(fctx, `__tastat_arg_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: aLocal });
    argLocals.push(aLocal);
  }

  // THEN arm: build an indexable carrier, then __ta_from_arraylike(recv, carrier).
  const thenArm: Instr[] = [];
  {
    const savedT = fctx.body;
    fctx.body = thenArm;
    const carrierLocal = allocLocal(fctx, `__tastat_carrier_${fctx.locals.length}`, { kind: "externref" });
    if (methodName === "of") {
      // Pack the of-args into a native `$ObjVec` (read by __extern_*).
      const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
      fctx.body.push({ op: "call", funcIdx: newIdx });
      fctx.body.push({ op: "local.set", index: carrierLocal });
      for (const aLocal of argLocals) {
        fctx.body.push({ op: "local.get", index: carrierLocal });
        fctx.body.push({ op: "local.get", index: aLocal });
        fctx.body.push({ op: "call", funcIdx: pushIdx });
      }
    } else {
      // from(src[, mapfn[, thisArg]]): normalize src (+ optional mapfn) to a
      // carrier the array-like reader consumes. A present, non-nullish mapfn
      // routes through __array_from_mapped (composes __array_from_iter_n +
      // __hof_map); no/undefined mapfn drains via __array_from_iter_n directly.
      const iterNIdx = ensureNativeArrayFromIterN(ctx);
      const src = argLocals[0];
      if (src === undefined) {
        const { newIdx } = ensureObjVecBuilders(ctx);
        fctx.body.push({ op: "call", funcIdx: newIdx });
        fctx.body.push({ op: "local.set", index: carrierLocal });
      } else if (dispatchArgs.length >= 2) {
        const mappedIdx = ensureNativeArrayFromMapped(ctx);
        const nullishIdx = ctx.funcMap.get("__nullish_to_null");
        const mapfn = argLocals[1]!;
        const thisArg = argLocals[2];
        const iterArm: Instr[] = [
          { op: "local.get", index: src },
          { op: "f64.const", value: -1 },
          { op: "call", funcIdx: iterNIdx },
          { op: "local.set", index: carrierLocal },
        ];
        if (mappedIdx !== undefined) {
          const mapArm: Instr[] = [
            { op: "local.get", index: src },
            { op: "local.get", index: mapfn },
            thisArg !== undefined ? { op: "local.get", index: thisArg } : { op: "ref.null.extern" },
            { op: "call", funcIdx: mappedIdx },
            { op: "local.set", index: carrierLocal },
          ];
          fctx.body.push({ op: "local.get", index: mapfn });
          if (nullishIdx !== undefined) fctx.body.push({ op: "call", funcIdx: nullishIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: iterArm, else: mapArm });
        } else {
          for (const ins of iterArm) fctx.body.push(ins);
        }
      } else {
        fctx.body.push({ op: "local.get", index: src });
        fctx.body.push({ op: "f64.const", value: -1 });
        fctx.body.push({ op: "call", funcIdx: iterNIdx });
        fctx.body.push({ op: "local.set", index: carrierLocal });
      }
    }
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "local.get", index: carrierLocal });
    fctx.body.push({ op: "call", funcIdx: taFromIdx });
    fctx.body = savedT;
  }

  // ELSE arm: the ordinary dynamic dispatcher (recv + args), i.e. what this
  // call site does today for these method names.
  const elseArm: Instr[] = [{ op: "local.get", index: recvLocal }];
  for (const aLocal of argLocals) elseArm.push({ op: "local.get", index: aLocal });
  elseArm.push({ op: "call", funcIdx: dispatchIdx });
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: ctx.taCtorTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: thenArm,
    else: elseArm,
  });
  return { kind: "externref" };
}

/**
 * Acorn installs some prototype getters before the methods they invoke:
 *
 *   Object.defineProperty(Parser.prototype, "inFunction", {
 *     get() { return this.currentVarScope().flags !== 0; }
 *   });
 *   Parser.prototype.currentVarScope = function () { ... };
 *
 * The getter compiles before a direct method target exists. Standalone defers
 * that call to the closed-method dispatcher. JS-host mode performs a live raw
 * callable lookup and invokes the compiled closure through a private in-Wasm
 * driver, avoiding a recursive host callback frame (#3668).
 */
function tryCompileLateFnctorPrototypeMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult | undefined {
  const pinnedReceiver = resolveReceiverStruct(ctx, fctx, propAccess.expression);
  const isThisReceiver = propAccess.expression.kind === ts.SyntaxKind.ThisKeyword;
  const pinnedFnctor = pinnedReceiver?.startsWith("__fnctor_") === true;
  if (ctx.standalone) {
    if (!isThisReceiver && !pinnedFnctor) return undefined;
  } else {
    // (#3668) JS-host parser recursion used to bounce every `this.m(...)`
    // between Wasm and `__extern_method_call`, consuming one native JS frame
    // per recursive-descent edge. Only take the in-module dispatcher when the
    // escape analysis proves the receiver's concrete fnctor struct. Dynamic /
    // unpinned receivers retain the host MOP path.
    if (ctx.wasi || !pinnedFnctor) return undefined;
  }

  // (#3683 S3) Inside a typed twin, `this.<m>(...)` on a write-once prototype
  // method of the SAME fnctor lowers to a direct call. MUST run before the
  // `__call_m_*` reservation below — a decline falls straight through to it and
  // is byte-for-byte the pre-S3 lowering. See typed-this.ts for the soundness
  // argument and the reserve-then-fill rationale.
  const devirtualized = tryEmitDirectTwinCall(ctx, fctx, expr, propAccess, {
    computeSig: (fn) => computeClosureWrapperSig(ctx, fn),
    reserveLegacyDispatch: (name, arity) => reserveClosedMethodDispatch(ctx, name, arity),
    ensureCurrentThisGlobal: () => ensureCurrentThisGlobal(ctx),
    ensureArgcGlobal: () => ensureArgcGlobal(ctx),
    undefinedExtern: () => undefinedExternInstrs(ctx),
  });
  if (devirtualized !== undefined) return devirtualized;

  const dispatchArgs = expr.arguments.some((arg) => ts.isSpreadElement(arg))
    ? flattenCallArgs(expr.arguments)
    : [...expr.arguments];
  if (dispatchArgs === null) return undefined;
  // The canonical closure-method surface is intentionally capped at arity 8.
  // Preserve the generic host path above that cap instead of reserving an
  // unfillable private driver.
  if (!ctx.standalone && !ctx.wasi && dispatchArgs.length > 8) return undefined;

  const methodName = propAccess.name.text;
  const dispatchIdx = ctx.standalone
    ? reserveClosedMethodDispatch(ctx, methodName, dispatchArgs.length)
    : reserveHostFnctorMethodDriver(ctx, dispatchArgs.length);
  const rawGetIdx =
    ctx.standalone || ctx.wasi
      ? undefined
      : ensureLateImport(
          ctx,
          "__extern_get_raw_callable",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
  if (!ctx.standalone && !ctx.wasi) {
    ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
    ensureLateImport(
      ctx,
      hostFnctorCallableFallbackImportName(dispatchArgs.length),
      Array.from({ length: dispatchArgs.length + 2 }, () => ({ kind: "externref" }) as ValType),
      [{ kind: "externref" }],
    );
  }
  if (!ctx.standalone && !ctx.wasi) addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);
  const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  } else if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  if (!ctx.standalone && !ctx.wasi) {
    // Keep one receiver copy for `this`, then resolve the current method value
    // without wrapping the Wasm closure as a JavaScript Function. The lookup
    // import returns before the closure is invoked, so recursive descent does
    // not retain a host frame.
    const recvLocal = allocLocal(fctx, `__host_fnctor_recv_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: recvLocal });
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
    if (rawGetIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: rawGetIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  }
  for (const arg of dispatchArgs) {
    const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argType && argType.kind !== "externref") {
      coerceType(ctx, fctx, argType, { kind: "externref" });
    } else if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
  }
  fctx.body.push({ op: "call", funcIdx: dispatchIdx });
  return { kind: "externref" };
}

/**
 * (#4482) True when the native String-family arm below must DECLINE because the
 * member being called is provably not on the receiver's own prototype, so it can
 * only have come from somewhere the arm cannot see:
 *
 *  * an OWN slot the program wrote on a primitive-WRAPPER receiver
 *    (`new String("[a-b]").exec = RegExp.prototype.exec` — the §15.10.6.2
 *    "is not generic" idiom, `…/exec/S15.10.6.2_A2_T{4,6}`); or
 *  * an INHERITED slot the program installed on a builtin prototype, reached
 *    through a PRIMITIVE receiver (`Object.prototype.exec =
 *    RegExp.prototype.exec; ".".exec(m)` — `…/exec/S15.10.6.2_A2_T8`).
 *
 * Either way the per-wrapper native dispatch keys on the receiver's OWN method
 * table and cannot answer a foreign name; it silently produced `undefined`
 * where the transferred intrinsic must run its brand check and throw a real
 * `TypeError`. Declining routes the call past this arm to the stored-member /
 * proto-inherited closure dispatch (`stored-member-closure-call.ts`), which
 * reads the slot — own first, then the receiver's implicit chain via
 * `__extern_method_call` — and applies it with the ORIGINAL receiver as `this`.
 *
 * ABSENT-NOT-WRONG, twice over:
 *  * the TS interfaces (`String`/`Number`/`Boolean`, and `string` itself)
 *    declare exactly their prototype members, so a `getProperty` HIT keeps the
 *    existing native arm — only a provable MISS declines;
 *  * a PRIMITIVE receiver carries no own slot, so its miss is only interesting
 *    when the module actually wrote a named property onto a builtin prototype.
 *    That is `ctx.protoNamedDirty`, the #4176 pre-scan flag — a module without
 *    such a write compiles byte-identically on the primitive path.
 */
function declinesToOwnOrInheritedSlot(ctx: CodegenContext, receiverType: ts.Type, method: string): boolean {
  if (!ctx.standalone) return false;
  const isWrapper =
    isStringWrapperType(receiverType) || isNumberWrapperType(receiverType) || isBooleanWrapperType(receiverType);
  if (!isWrapper && !(isStringType(receiverType) && ctx.protoNamedDirty)) return false;
  // `toString`/`valueOf` are handled by the dedicated wrapper arms (which
  // already consult `sourceHasMethodReassignment`); leaving them here would
  // re-route a working path.
  if (method === "toString" || method === "valueOf") return false;
  return receiverType.getProperty(method) === undefined;
}

function tryCompileDerivedHostSubstringCharCodeAt(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: string,
): ValType | null {
  if (ctx.nativeStrings || method !== "charCodeAt" || !ts.isIdentifier(propAccess.expression)) return null;
  const declaration = ctx.oracle.valueDeclarationOf(propAccess.expression);
  const substring = declaration ? fctx.derivedSubstringReads?.get(declaration) : undefined;
  const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
  if (substring?.kind !== "host" || charCodeAtIdx === undefined) return null;

  const arg = expr.arguments[0];
  const isLengthMinusOne =
    arg !== undefined &&
    ts.isBinaryExpression(arg) &&
    arg.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    ts.isPropertyAccessExpression(arg.left) &&
    arg.left.name.text === "length" &&
    ts.isIdentifier(arg.left.expression) &&
    ctx.oracle.valueDeclarationOf(arg.left.expression) === declaration &&
    ts.isNumericLiteral(arg.right) &&
    Number(arg.right.text) === 1;
  const indexLocal = allocLocal(fctx, `__host_substring_char_idx_${fctx.locals.length}`, { kind: "i32" });
  if (isLengthMinusOne) {
    fctx.body.push({ op: "local.get", index: substring.lenLocal });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
  } else if (arg && tryEmitStaticI32Expression(ctx, fctx, arg)) {
    // already emitted as i32
  } else if (arg) {
    const argType = compileExpression(ctx, fctx, arg, { kind: "i32" });
    if (argType && argType.kind !== "i32") coerceType(ctx, fctx, argType, { kind: "i32" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: indexLocal });

  const range = arg ? staticIntegerRange(ctx, arg) : { min: 0, max: 0 };
  const provenInBounds =
    (range !== undefined && range.min >= 0 && range.max < substring.minLen) ||
    (isLengthMinusOne && substring.minLen > 0);
  const read: Instr[] = [
    { op: "local.get", index: substring.receiverLocal },
    { op: "local.get", index: substring.offLocal },
    { op: "local.get", index: indexLocal },
    { op: "i32.add" },
    { op: "call", funcIdx: charCodeAtIdx },
    { op: "f64.convert_i32_u" },
  ];
  if (provenInBounds) {
    fctx.body.push(...read);
  } else {
    fctx.body.push({ op: "local.get", index: indexLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({ op: "local.get", index: indexLocal });
    fctx.body.push({ op: "local.get", index: substring.lenLocal });
    fctx.body.push({ op: "i32.ge_s" });
    fctx.body.push({ op: "i32.or" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: NaN }],
      else: read,
    });
  }
  return { kind: "f64" };
}

export function compileReceiverMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  expectedType?: ValType,
): InnerResult | undefined {
  // (#3610) `<Builtin>.prototype.<brandedMethod>(...)` — e.g.
  // `Date.prototype.getTime()`. The prototype object carries no [[DateValue]],
  // so `thisTimeValue` throws TypeError (§21.4.4). Without this gate the
  // receiver compiles to a null `$Date` ref (TS types `Date.prototype` as
  // `Date`, so `compileDateMethodCall` engages) and the following `struct.get`
  // traps UNCATCHABLY on a null reference. Runs first so no downstream arm can
  // claim the call.
  {
    const __r = tryBuiltinPrototypeMethodBrandThrow(
      ctx,
      fctx,
      expr,
      propAccess,
      (arg) => compileExpression(ctx, fctx, arg),
      expectedType,
    );
    if (__r !== undefined) return __r;
  }

  // Check if receiver is an externref object
  let receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  if (
    process.env.DEBUG_MARKED_CODEGEN === "1" &&
    fctx.name.includes("closure") &&
    (propAccess.name.text === "lex" ||
      propAccess.name.text === "lexInline" ||
      propAccess.name.text === "parse" ||
      propAccess.name.text === "parseInline")
  ) {
    console.error(
      "[marked-receiver-enter]",
      fctx.name,
      propAccess.name.text,
      "receiverText",
      propAccess.expression.getText?.(),
      "type",
      receiverType.getSymbol?.()?.name,
      "construct",
      receiverType.getConstructSignatures?.().length,
      "external",
      isExternalDeclaredClass(receiverType, ctx.checker),
      "classMap",
      ts.isIdentifier(propAccess.expression) ? ctx.classExprNameMap.get(propAccess.expression.text) : undefined,
    );
  }
  // (#2767) When the static type resolves NO nominal symbol and the receiver
  // is a bare identifier (the evolving-`any` `var d; d = new Date(0)` case),
  // recover the effective nominal type from the binding's assignments so the
  // nominal-symbol dispatch gates below (Date, DataView, ArrayBuffer, RegExp,
  // wrappers, …) engage instead of falling to the failing generic path.
  if (!receiverType.getSymbol()?.name && ts.isIdentifier(propAccess.expression)) {
    const recovered = resolveAssignedNominalType(ctx, propAccess.expression);
    if (recovered) receiverType = recovered;
  }

  // TextEncoder/TextDecoder under no-JS-host targets. These are standard
  // Web/Node APIs, but WASI/standalone cannot rely on env.TextEncoder_* host
  // imports. Lower the narrow UTF-8 surface natively.
  if ((noJsHost(ctx) || ctx.strictNoHostImports) && ctx.nativeStrings) {
    const recvSym =
      receiverType.getSymbol()?.name ??
      (ts.isNewExpression(propAccess.expression) && ts.isIdentifier(propAccess.expression.expression)
        ? propAccess.expression.expression.text
        : undefined);
    const method = propAccess.name.text;
    if (recvSym === "TextEncoder" && method === "encode") {
      const { encodeIdx, vecTypeIdx } = ensureTextEncodingHelpers(ctx);
      const recvResult = compileExpression(ctx, fctx, propAccess.expression);
      if (recvResult !== null) fctx.body.push({ op: "drop" });
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, nativeStringType(ctx));
      } else {
        compileStringLiteral(ctx, fctx, "");
      }
      for (let i = 1; i < expr.arguments.length; i++) {
        const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (extra !== null) fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "call", funcIdx: encodeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (recvSym === "TextDecoder" && method === "decode") {
      const { decodeU8Idx, vecTypeIdx } = ensureTextEncodingHelpers(ctx);
      const recvResult = compileExpression(ctx, fctx, propAccess.expression);
      if (recvResult !== null) fctx.body.push({ op: "drop" });
      if (expr.arguments.length === 0) {
        compileStringLiteral(ctx, fctx, "");
        return nativeStringType(ctx);
      }
      const expected: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
      const argType = compileExpression(ctx, fctx, expr.arguments[0]!, expected);
      if (argType && !valTypesMatch(argType, expected)) {
        coerceType(ctx, fctx, argType, expected);
      }
      for (let i = 1; i < expr.arguments.length; i++) {
        const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
        if (extra !== null) fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "call", funcIdx: decodeU8Idx });
      return nativeStringType(ctx);
    }

    // (#3150) Standalone-native `Uint8Array.prototype.toHex()` / `.toBase64()` —
    // encode the packed-`i8` Uint8Array vec (the same backing `new Uint8Array` /
    // `Uint8Array.of` / `fromHex` produce) to a native hex / standard-base64
    // string. No-argument DEFAULT-options form only: a `.toBase64({...})` call
    // with an options object carries `arguments.length > 0` and falls through to
    // the existing dynamic-shape refusal, so no wrong default (base64url /
    // omitPadding) is silently applied. Standalone-pure (0 host imports).
    if (recvSym === "Uint8Array" && (method === "toHex" || method === "toBase64") && expr.arguments.length === 0) {
      const vecTypeIdx = getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" });
      const expected: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
      const recvT = compileExpression(ctx, fctx, propAccess.expression, expected);
      if (recvT && !valTypesMatch(recvT, expected)) coerceType(ctx, fctx, recvT, expected);
      else if (recvT === null) fctx.body.push({ op: "ref.null", typeIdx: vecTypeIdx });
      const encIdx = method === "toHex" ? ensureUint8ToHex(ctx) : ensureUint8ToBase64(ctx);
      if (encIdx >= 0) {
        fctx.body.push({ op: "call", funcIdx: encIdx });
        return nativeStringType(ctx);
      }
    }
  }

  // Handle Date instance method calls BEFORE extern class dispatch,
  // because Date is declared in lib.d.ts (so isExternalDeclaredClass returns true)
  // but we implement it natively as a WasmGC struct.
  {
    const temporalResult = tryCompileTemporalMethodCall(ctx, fctx, propAccess, expr);
    if (temporalResult !== undefined) return temporalResult;
  }

  {
    const dateResult = compileDateMethodCall(ctx, fctx, propAccess, expr, receiverType);
    if (dateResult !== undefined) return dateResult;
  }

  // Property introspection: hasOwnProperty / propertyIsEnumerable
  // Must be checked BEFORE extern class dispatch so that calls like
  // regexp.hasOwnProperty("x") use the generic handler instead of
  // looking for a non-existent RegExp_hasOwnProperty import.
  if (propAccess.name.text === "hasOwnProperty" || propAccess.name.text === "propertyIsEnumerable") {
    return compilePropertyIntrospection(ctx, fctx, propAccess, expr);
  }

  // #1654/#4397 — the native DataView provider is independent of the embedder.
  // It must run before extern-class dispatch so native-first JS builds do not
  // move DataView state or byte access into the host runtime.
  if (usesNativeDataViewProvider(ctx) && isDataViewAccessor(propAccess.name.text)) {
    const recvSym = receiverType.getSymbol()?.name;
    if (recvSym === "DataView") {
      const dvResult = emitDataViewAccessor(
        ctx,
        fctx,
        propAccess.name.text,
        propAccess.expression,
        expr.arguments,
        (e, hint) => compileExpression(ctx, fctx, e, hint),
      );
      if (dvResult) {
        if (dvResult.kind === "get") return dvResult.result;
        // (#3173) Setter used as an EXPRESSION (`assert.sameValue(
        // dv.setUint8(0, 1), undefined)` — set-values-return-undefined.js):
        // §24.3.4.* setters return undefined. VOID_RESULT in a value
        // position desyncs the caller's argument stack; hand back the
        // canonical `undefined` singleton instead (null ≠ undefined under
        // strict equality). Statement position keeps the zero-cost
        // VOID_RESULT.
        if (!ts.isExpressionStatement(expr.parent)) {
          // Standalone lowers `undefined` to the null externref (undefined ≡
          // null-extern; `x === undefined` is `ref.is_null` — see
          // `__extern_is_undefined`, object-runtime.ts), so this IS the
          // canonical undefined here.
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        return VOID_RESULT;
      }
    }
  }

  // #1698 / #1717 — native ArrayBuffer.prototype.slice. The ArrayBuffer
  // backing store is the same `i32_byte` vec struct in BOTH JS-host and
  // standalone modes, so the byte-by-byte copy is mode-agnostic. In JS-host
  // mode `slice` was previously dropped by the extern-class dispatch
  // (`slice is not a function`, #1717); in standalone there is no runtime
  // (#1698). Route both through the same native emitter — emit a byte copy
  // into a fresh i32_byte vec. (SharedArrayBuffer is filtered out: it has no
  // i32_byte struct, so the cast would trap.)
  if (propAccess.name.text === "slice") {
    const recvSym = receiverType.getSymbol()?.name;
    if (recvSym === "ArrayBuffer") {
      const sliceResult = emitArrayBufferSlice(ctx, fctx, propAccess.expression, expr.arguments, (e, hint) =>
        compileExpression(ctx, fctx, e, hint),
      );
      if (sliceResult) return sliceResult;
    }
  }

  // (#3054 C) Native `rab.resize(newByteLength)` in no-JS-host mode. Only a
  // `$__resizable_ab` receiver actually resizes (checked at runtime inside the
  // emitter — a fixed buffer throws TypeError); reallocs the backing array,
  // swaps `data` + `length` in place so shared views observe the new length.
  if (propAccess.name.text === "resize" && noJsHost(ctx)) {
    const recvSym = receiverType.getSymbol()?.name;
    if (recvSym === "ArrayBuffer") {
      emitArrayBufferResize(ctx, fctx, propAccess.expression, expr.arguments, (e, hint) =>
        compileExpression(ctx, fctx, e, hint),
      );
      return VOID_RESULT;
    }
  }

  // (#1595) Direct-call adapter to the canonical native
  // ArrayBufferCopyAndDetach helper. The operation itself is shared with the
  // reflective ArrayBuffer.prototype member closures; this surface only
  // compiles the receiver/argument expressions into that common ABI.
  if (noJsHost(ctx) && (propAccess.name.text === "transfer" || propAccess.name.text === "transferToFixedLength")) {
    const recvSym = receiverType.getSymbol()?.name;
    if (recvSym === "ArrayBuffer") {
      const transferResult = emitArrayBufferTransfer(
        ctx,
        fctx,
        propAccess.name.text,
        propAccess.expression,
        expr.arguments,
        (e, hint) => compileExpression(ctx, fctx, e, hint),
      );
      if (transferResult) return transferResult;
    }
  }

  if (isExternalDeclaredClass(receiverType, ctx.checker)) {
    const externResult = compileExternMethodCall(ctx, fctx, propAccess, expr);
    // undefined means method not found in extern class hierarchy — fall through to generic handlers
    if (externResult !== undefined) return externResult;
  }

  // (#2865) `.next()` on a DRIVEN async-generator object (typed receiver).
  // `next(v)` sent-value delivery is still 3d-iii; `.return()`/`.throw()` are
  // now handled (#3389 slice 2a).
  {
    const recvSymName = receiverType.getSymbol()?.name;
    const isAsyncGenRecv =
      recvSymName === "AsyncGenerator" || recvSymName === "AsyncIterableIterator" || recvSymName === "AsyncIterator";
    if (isAsyncGenRecv && propAccess.name.text === "next" && expr.arguments.length === 0) {
      const dispatched = tryEmitAsyncGenNextDispatch(ctx, fctx, propAccess.expression);
      if (dispatched !== null) return dispatched;
    }
    // (#3389 slice 2a) `.return(v)` / `.throw(e)` on a driven async-gen — the
    // consumer-completion protocol (§27.6.3.8/.9). One optional arg.
    if (
      isAsyncGenRecv &&
      (propAccess.name.text === "return" || propAccess.name.text === "throw") &&
      expr.arguments.length <= 1
    ) {
      const dispatched = tryEmitAsyncGenReturnThrowDispatch(
        ctx,
        fctx,
        propAccess.expression,
        propAccess.name.text,
        expr.arguments[0],
      );
      if (dispatched !== null) return dispatched;
    }
  }

  // Generator method calls: gen.next(), gen.return(value), gen.throw(error)
  if (isGeneratorType(receiverType)) {
    const methodName = propAccess.name.text;
    const nativeResult = tryCompileNativeGeneratorMethodCall(
      ctx,
      fctx,
      propAccess.expression,
      methodName,
      expr.arguments,
    );
    if (nativeResult !== undefined) return nativeResult;
    if (methodName === "next") {
      compileExpression(ctx, fctx, propAccess.expression);
      const funcIdx = ctx.funcMap.get("__gen_next");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" }; // Returns IteratorResult as externref
      }
    } else if (methodName === "return") {
      compileExpression(ctx, fctx, propAccess.expression);
      // Push the argument (value to return), default to ref.null if none
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, {
          kind: "externref",
        });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      const funcIdx = ctx.funcMap.get("__gen_return");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" }; // Returns IteratorResult as externref
      }
    } else if (methodName === "throw") {
      compileExpression(ctx, fctx, propAccess.expression);
      // Push the argument (error to throw), default to ref.null if none
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, {
          kind: "externref",
        });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      const funcIdx = ctx.funcMap.get("__gen_throw");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" }; // Returns IteratorResult as externref
      }
    }
  }

  // Handle Promise instance methods: .then(cb1, cb2?), .catch(cb), .finally(cb)
  // Promise values are externref; delegate to host imports registered as LATE
  // imports (during codegen, not collection) to avoid type index corruption (#961).
  // GUARD: Only match when receiver TS type is Promise (prevents routing
  // compiled async function returns through host Promise path — v1 regression)
  {
    const method = propAccess.name.text;
    const nativeFirstPromise = ctx.targetProfile.semanticProviders === "native-first";
    // (#2903) `.finally` takes the NATIVE §27.2.5.3 lowering only when the
    // module provably cannot mint a HOST promise (or under wasi, whose
    // zero-import contract has no host route at all). Producer modules keep
    // the EXACT legacy host `Promise_finally` lowering — including the
    // async-call fulfilled-wrap in expressions.ts — because their receivers
    // can be host promises the native machinery cannot chain (measured:
    // subclass-`finally` tests pass through the host route only WITH the
    // wrap). Zero-arg `.finally()` is admitted ONLY when the native lowering
    // will consume it; every other lane keeps the historical ≥1-argument
    // gate so its generic paths (and bytes) are untouched.
    const nativeFinallyActive =
      method === "finally" &&
      isStandaloneThenChainNativeActive(ctx) &&
      (ctx.wasi === true || nativeFirstPromise || standaloneThenMissArmCanBeNative(ctx));
    // (#2867 S2b) Zero-argument `.then()` — §27.2.5.4 with both handlers absent,
    // i.e. the identity pass-through. It was excluded by the historical
    // `arguments.length >= 1` gate below and fell through to the GENERIC
    // member-call path, which emits a `__call_m_then_0` reflective trampoline
    // over a native `$Promise`. That trampoline resolves `.then` to the wrong
    // callable, so the microtask drive later ran a per-site `__then_fulfill_N`
    // wrapper against caps whose `callback` field was not its closure and the
    // wrapper's `ref.cast` to its own closure struct trapped —
    // `illegal cast [__then_fulfill_N <- __drain_microtasks]`. Reproduced down
    // to `Promise.resolve(x).then().then(fn)`, and confirmed by the function
    // table: the failing module carries exactly one extra function,
    // `__call_m_then_0`, versus the identical `.then(undefined, undefined)`
    // spelling, which already worked.
    //
    // Admitted ONLY when the native lowering will actually consume it — the
    // same shape and the same justification as the zero-arg `.finally()`
    // admission (#2903) immediately above; every other lane keeps the
    // historical >=1-argument gate, so their generic paths and bytes are
    // untouched. `emitStandalonePromiseThen(…, null, null)` is the existing
    // absent-handler identity chain (it is what `.finally` degrades to at
    // async-scheduler.ts:4553), so this reuses machinery rather than adding any.
    const nativeThenZeroArgActive =
      method === "then" &&
      expr.arguments.length === 0 &&
      isStandaloneThenChainNativeActive(ctx) &&
      (ctx.wasi === true || nativeFirstPromise || standaloneThenMissArmCanBeNative(ctx));
    if (
      (method === "then" || method === "catch" || method === "finally") &&
      (expr.arguments.length >= 1 || nativeFinallyActive || nativeThenZeroArgActive)
    ) {
      const receiverTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
      const recvSym = receiverTsType.getSymbol()?.name;
      const apparentSym = ctx.checker.getApparentType(receiverTsType).getSymbol()?.name;
      const isPromiseReceiver = recvSym === "Promise" || apparentSym === "Promise";

      // (#2865) ANY-typed receiver under ACTIVE native chaining: the value
      // may be a native `$Promise` minted by the driven async-gen machinery
      // (`var f; f = async function*(){…}; f().next().then(cb, $DONE)` — the
      // dominant test262 driving shape holds everything as `any`). Route
      // through the runtime `ref.test` receiver bridge: a native `$Promise`
      // chains natively; a miss keeps the host path under standalone
      // (behavior-preserving — the generic any-path used the same host
      // imports) and yields null under wasi (zero-import contract; a host
      // arm could never succeed there). Only fires when the module has
      // native machinery (`isStandaloneThenChainNativeActive` — wasi, or
      // standalone with the scheduler registered), so every other module is
      // byte-identical.
      if (
        !isPromiseReceiver &&
        (method === "then" || method === "catch" || (method === "finally" && nativeFinallyActive)) &&
        (receiverTsType.flags & ts.TypeFlags.Any) !== 0 &&
        isStandaloneThenChainNativeActive(ctx)
      ) {
        // (#2903) `.finally` on an any-typed receiver takes the same runtime
        // `ref.test $Promise` bridge as `.then`/`.catch` — a native receiver
        // chains through the native §27.2.5.3 lowering; a miss is the native
        // TypeError (null under wasi). Producer modules never reach this arm
        // (`nativeFinallyActive` false) and keep their pre-native generic
        // path.
        if (method === "finally") {
          (ctx.standaloneNativeFinallyNodes ??= new Set()).add(expr);
          emitStandaloneFinallyWithNativeFallback(ctx, fctx, propAccess.expression, expr.arguments[0], {
            nullMiss: ctx.wasi === true || nativeFirstPromise,
          });
          return { kind: "externref" };
        }
        emitStandaloneThenWithNativeFallback(
          ctx,
          fctx,
          propAccess.expression,
          method,
          method === "then" ? expr.arguments[0] : undefined,
          method === "then" ? expr.arguments[1] : expr.arguments[0],
          { nullMiss: ctx.wasi === true || nativeFirstPromise },
        );
        return { kind: "externref" };
      }

      if (isPromiseReceiver) {
        // (#2980 class 1) `.then` on native chaining. WASI's ZERO-host-
        // import contract for `.then`/`.catch` is load-bearing (#1326/
        // #2895 — `tests/issue-1326.test.ts` asserts the WAT never
        // contains "Promise_then" for `--target wasi`, and instantiates
        // with an EMPTY imports object). So the `ref.test` + host-fallback
        // hardening below is scoped to the NON-wasi case (`ctx.standalone`
        // under the carrier-widen measurement) — the only configuration
        // the #2980 decision measure actually exercises, and one where a
        // host `Promise_then`/`Promise_then2`/`Promise_catch` import is
        // ALREADY the pre-widen fallback for every standalone `.then`
        // receiver (see `isStandaloneThenChainNativeActive`), so making it
        // conditional here introduces no NEW import dependency. WASI keeps
        // the exact original unconditional-cast lowering: no test262
        // corpus item currently reaches a non-native receiver under wasi
        // (the deferred-combinator paths that would produce one already
        // fail to instantiate for their own unrelated missing import), so
        // this preserves WASI's behaviour byte-for-byte.
        if (isStandaloneThenChainNativeActive(ctx) && method === "then") {
          if (ctx.wasi === true || nativeFirstPromise) {
            const liveBuffers: Instr[][] = [];
            try {
              const promiseInstrs = compilePromiseThenReceiverBuffer(ctx, fctx, propAccess.expression, liveBuffers);
              // (#4394) allowDynamic: runtime-held handlers ride the caps and the
              // shared `__then_dyn_*` wrapper applies them at settle time.
              const onFulfilled = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[0], liveBuffers, {
                allowDynamic: true,
              });
              const onRejected = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[1], liveBuffers, {
                allowDynamic: true,
              });
              emitStandalonePromiseThen(ctx, fctx, promiseInstrs, onFulfilled, onRejected);
            } finally {
              for (const b of liveBuffers) ctx.liveBodies.delete(b);
            }
          } else {
            emitStandaloneThenWithNativeFallback(
              ctx,
              fctx,
              propAccess.expression,
              "then",
              expr.arguments[0],
              expr.arguments[1],
            );
          }
          return { kind: "externref" };
        }

        // (#2165) Standalone `.catch(onRejected)` ≡ `.then(undefined, onRejected)`
        // per §27.2.5.1. Reuse the native `$Promise` then-machinery so native
        // provider lanes don't leak the `Promise_catch` / `__make_callback`
        // host imports. The chained promise still propagates a fulfilled receiver
        // unchanged (onFulfilled = null) and routes a rejection through the
        // user's onRejected continuation. (#2980 class 1: same wasi/standalone
        // split as `.then` above.)
        if (isStandaloneThenChainNativeActive(ctx) && method === "catch") {
          if (ctx.wasi === true || nativeFirstPromise) {
            const liveBuffers: Instr[][] = [];
            try {
              const promiseInstrs = compilePromiseThenReceiverBuffer(ctx, fctx, propAccess.expression, liveBuffers);
              // (#4394) allowDynamic — see the `.then` twin above.
              const onRejected = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[0], liveBuffers, {
                allowDynamic: true,
              });
              emitStandalonePromiseThen(ctx, fctx, promiseInstrs, null, onRejected);
            } finally {
              for (const b of liveBuffers) ctx.liveBodies.delete(b);
            }
          } else {
            emitStandaloneThenWithNativeFallback(
              ctx,
              fctx,
              propAccess.expression,
              "catch",
              undefined,
              expr.arguments[0],
            );
          }
          return { kind: "externref" };
        }

        // (#2903) Native `.finally(onFinally)` — §27.2.5.3 over the native
        // then machinery. Replaces the host `Promise_finally` route (which
        // under the native carrier received a `$Promise` GC struct the host
        // cannot chain: callback silently dropped, reason identity lost —
        // measured broken on main 2026-07-11). WASI takes the direct
        // unconditional-cast lowering (zero-import contract, same shape as
        // `.then`/`.catch` above); standalone takes the receiver bridge.
        // Producer modules (`nativeFinallyActive` false) fall through to the
        // exact legacy host route below.
        if (nativeFinallyActive) {
          (ctx.standaloneNativeFinallyNodes ??= new Set()).add(expr);
          if (ctx.wasi === true || nativeFirstPromise) {
            const liveBuffers: Instr[][] = [];
            try {
              const promiseInstrs = compilePromiseThenReceiverBuffer(ctx, fctx, propAccess.expression, liveBuffers);
              const onFinally = compileStandalonePromiseThenCallback(ctx, fctx, expr.arguments[0], liveBuffers);
              emitStandalonePromiseFinally(ctx, fctx, promiseInstrs, onFinally);
            } finally {
              for (const b of liveBuffers) ctx.liveBodies.delete(b);
            }
          } else {
            emitStandaloneFinallyWithNativeFallback(ctx, fctx, propAccess.expression, expr.arguments[0]);
          }
          return { kind: "externref" };
        }

        // Determine import name: use Promise_then2 for .then(cb1, cb2)
        const useThen2 = method === "then" && expr.arguments.length >= 2;
        const importName = useThen2 ? "Promise_then2" : `Promise_${method}`;

        // Register as late import (NOT during collection — #960 fix)
        const paramTypes: ValType[] = useThen2
          ? [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }]
          : [{ kind: "externref" }, { kind: "externref" }];
        let funcIdx =
          ctx.funcMap.get(importName) ?? ensureLateImport(ctx, importName, paramTypes, [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        funcIdx = ctx.funcMap.get(importName) ?? funcIdx;

        if (funcIdx !== undefined) {
          // Compile the Promise value (receiver)
          compileExpression(ctx, fctx, propAccess.expression, {
            kind: "externref",
          });
          // Compile the first callback argument, coercing to externref
          const cbType = compileExpression(ctx, fctx, expr.arguments[0]!, {
            kind: "externref",
          });
          if (cbType && cbType.kind !== "externref") {
            coerceType(ctx, fctx, cbType, { kind: "externref" });
          }
          // For .then(cb1, cb2): compile second callback
          if (useThen2) {
            const cb2Type = compileExpression(ctx, fctx, expr.arguments[1]!, {
              kind: "externref",
            });
            if (cb2Type && cb2Type.kind !== "externref") {
              coerceType(ctx, fctx, cb2Type, { kind: "externref" });
            }
          }
          // Re-lookup funcIdx after compiling args (late imports may shift)
          const finalIdx = ctx.funcMap.get(importName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalIdx });
          return { kind: "externref" };
        }
      }
    }
  }

  // (#1397) Wrapper-object dynamic dispatch on reassigned methods.
  //
  // For wrapper-object receivers (`new String/Number/Boolean(...)`) where
  // `.toString` or `.valueOf` has been reassigned somewhere in the source,
  // skip every static fast-path and route through `__extern_method_call`
  // so the runtime property lookup picks up the override. Required for
  // spec compliance with transferred prototype methods (S15.7.4.2_A4_*,
  // S15.7.4.4_A2_*, S15.6.4.2_A2_*, S15.6.4.3_A2_*):
  //
  //   var s1 = new String();
  //   s1.toString = Number.prototype.toString;
  //   s1.toString();   // spec: TypeError; we used to return s1 itself.
  //
  // Primitives keep the static fast-path — primitives can't have own
  // properties, so `"abc".toString = …` is a no-op and the short-circuit
  // is correct. Wrappers without any matching reassignment in the source
  // also keep the static fast-path (no perf regression for the common
  // case). The reassignment scan is conservative — any
  // `<expr>.<method> = …` anywhere in the source disables the static
  // path for wrappers; that's a narrower hit than Option B (always
  // dynamic) and matches the architect's Option D feasibility study.
  {
    const wrapperMethodName = propAccess.name.text;
    const isWrapperReceiver =
      isStringWrapperType(receiverType) || isNumberWrapperType(receiverType) || isBooleanWrapperType(receiverType);
    if (
      isWrapperReceiver &&
      (wrapperMethodName === "valueOf" || wrapperMethodName === "toString") &&
      expr.arguments.length === 0 &&
      sourceHasMethodReassignment(ctx, propAccess.expression, wrapperMethodName)
    ) {
      const dynResult = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, wrapperMethodName);
      if (dynResult) return dynResult;
    }
  }

  // Handle wrapper type method calls: new Number(x).valueOf(), etc.
  // Since wrapper constructors now return primitives, valueOf() is a no-op identity.
  {
    const wrapperMethodName = propAccess.name.text;
    const recvSymName = receiverType.getSymbol()?.name;
    // Covered cases (the rest stay on their existing paths to avoid regressions):
    //   - String wrapper .valueOf()/.toString() → the internal slot IS a native
    //     string, so __to_primitive returns it directly (no post-processing).
    //   - Number wrapper .valueOf() → internal slot is a boxed number; unbox to f64.
    // Excluded:
    //   - Number wrapper .toString() — the slot is a boxed number, not a string;
    //     it needs the radix-aware numeric ToString lowering, so it falls through.
    //   - Boolean wrappers — the internal slot is a `$__box_boolean_struct`, whose
    //     extraction differs from the boxed-number unbox used here.
    const isWrapperValueAccessor =
      expr.arguments.length === 0 &&
      ((recvSymName === "String" && (wrapperMethodName === "valueOf" || wrapperMethodName === "toString")) ||
        (recvSymName === "Number" && wrapperMethodName === "valueOf") ||
        // #1910 R3 — Boolean wrapper .valueOf() in standalone: the internal
        // slot holds a boxed boolean (`__box_boolean_struct`), recovered by
        // `__to_primitive`; unbox it to the i32 primitive below (§20.3.3.3
        // Boolean.prototype.valueOf returns the [[BooleanData]] slot).
        (recvSymName === "Boolean" && wrapperMethodName === "valueOf"));

    // #2160 — standalone recovery of the wrapper's internal [[PrimitiveValue]]
    // slot. In --target standalone there is no JS host, so `new String(x)` /
    // `new Number(x)` build a native `$Object` carrying the primitive under the
    // reserved FLAG_INTERNAL slot (#1910 S2). The legacy host paths below leak
    // `__unbox_string` (no native impl) and recompile the wrapper as a primitive
    // ValType (which traps / yields the wrong value for a `$Object` receiver).
    // Route through the native `__to_primitive` helper, which reads that slot
    // first (§7.1.1.1), then apply the method's result type. `Number.prototype.
    // toString` with a radix is NOT this path (arguments.length === 0 above), so
    // it falls through to the radix-aware toString lowering. Gated on
    // `ctx.standalone` specifically — WASI keeps the host-import object
    // machinery (the native object-runtime is standalone-only), so it stays on
    // the legacy paths below.
    // (#3175) `Number.prototype.valueOf()` — [[NumberData]] is +0 (§21.1.3).
    // The prototype object has no [[PrimitiveValue]] slot, so the wrapper
    // `__to_primitive`/`__unbox_number` recovery below would yield NaN.
    if (
      recvSymName === "Number" &&
      wrapperMethodName === "valueOf" &&
      expr.arguments.length === 0 &&
      isNumberDotPrototype(fctx, propAccess.expression)
    ) {
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }

    if (ctx.standalone && isWrapperValueAccessor) {
      ensureObjectRuntime(ctx);
      const toPrimIdx = ctx.funcMap.get("__to_primitive");
      if (toPrimIdx !== undefined) {
        // hint: "string" for toString / String wrapper, "number" for Number
        // valueOf — matches OrdinaryToPrimitive's hint ordering.
        const hint = wrapperMethodName === "toString" || recvSymName === "String" ? "string" : "number";
        compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        addStringConstantGlobal(ctx, hint);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, hint));
        fctx.body.push({ op: "call", funcIdx: toPrimIdx });
        // __to_primitive returns the boxed primitive as externref. String
        // wrappers (and any toString) yield the native string ref directly.
        // Number valueOf yields a boxed number — unbox to the f64 primitive.
        if (wrapperMethodName === "valueOf" && recvSymName === "Number") {
          const unboxNumIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
          flushLateImportShifts(ctx, fctx);
          if (unboxNumIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxNumIdx });
          return { kind: "f64" };
        }
        // #1910 R3 — Boolean wrapper valueOf → boxed boolean in the slot; unbox
        // to the i32 primitive (true→1, false→0).
        if (wrapperMethodName === "valueOf" && recvSymName === "Boolean") {
          const unboxBoolIdx = ensureLateImport(ctx, "__unbox_boolean", [{ kind: "externref" }], [{ kind: "i32" }]);
          flushLateImportShifts(ctx, fctx);
          if (unboxBoolIdx !== undefined) fctx.body.push({ op: "call", funcIdx: unboxBoolIdx });
          return { kind: "i32" };
        }
        // String wrapper valueOf/toString, or Number wrapper toString → string ref.
        return { kind: "externref" };
      }
    }

    if (recvSymName === "Number" && wrapperMethodName === "valueOf") {
      compileExpression(ctx, fctx, propAccess.expression, { kind: "f64" });
      return { kind: "f64" };
    }
    if (recvSymName === "String" && wrapperMethodName === "valueOf") {
      // new String("x") now returns a real String wrapper object (externref).
      // valueOf() must extract the primitive string via __unbox_string (#929).
      compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
      const unboxIdx = ensureLateImport(ctx, "__unbox_string", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (unboxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
      }
      return { kind: "externref" };
    }
    if (recvSymName === "Boolean" && wrapperMethodName === "valueOf") {
      compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
      return { kind: "i32" };
    }
  }

  // Check if receiver is a local class instance.
  let receiverClassName = resolveReceiverMethodClassName(ctx, fctx, propAccess, receiverType);
  // Fallback for union types, interfaces, abstract classes:
  // When the direct symbol name is not a known class, try to resolve via
  // union members, apparent type, or base types.
  if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
    const methodName = ts.isPrivateIdentifier(propAccess.name)
      ? "__priv_" + propAccess.name.text.slice(1)
      : propAccess.name.text;
    // Try union type members: for `A | B`, check each member for a known class
    if (receiverType.isUnion()) {
      for (const memberType of (receiverType as ts.UnionType).types) {
        const memberName = canonicalClassExpressionName(ctx, memberType.getSymbol()?.name);
        if (memberName && ctx.classSet.has(memberName)) {
          const fullName = `${memberName}_${methodName}`;
          if (ctx.funcMap.has(fullName)) {
            receiverClassName = memberName;
            break;
          }
          // Walk inheritance chain
          let ancestor = ctx.classParentMap.get(memberName);
          while (ancestor) {
            if (ctx.funcMap.has(`${ancestor}_${methodName}`)) {
              receiverClassName = memberName;
              break;
            }
            ancestor = ctx.classParentMap.get(ancestor);
          }
          if (receiverClassName && ctx.classSet.has(receiverClassName)) break;
        }
      }
    }
    // Try apparent type (handles interfaces, abstract classes)
    if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
      const apparentType = ctx.checker.getApparentType(receiverType);
      if (apparentType !== receiverType) {
        const apparentName = canonicalClassExpressionName(ctx, apparentType.getSymbol()?.name);
        if (apparentName && ctx.classSet.has(apparentName) && ctx.funcMap.has(`${apparentName}_${methodName}`)) {
          receiverClassName = apparentName;
        }
      }
    }
    // Try base types: if the receiver type has base types (e.g. abstract class → concrete class)
    if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
      const baseTypes = receiverType.getBaseTypes?.();
      if (baseTypes) {
        for (const baseType of baseTypes) {
          const baseName = canonicalClassExpressionName(ctx, baseType.getSymbol()?.name);
          if (baseName && ctx.classSet.has(baseName) && ctx.funcMap.has(`${baseName}_${methodName}`)) {
            receiverClassName = baseName;
            break;
          }
        }
      }
    }
    // Try struct name from the receiver's wasm type
    if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
      const structName = canonicalClassExpressionName(ctx, resolveStructName(ctx, receiverType));
      if (structName && ctx.classSet.has(structName) && ctx.funcMap.has(`${structName}_${methodName}`)) {
        receiverClassName = structName;
      }
    }
    // Final fallback: scan all known classes for one that has the method.
    // This handles interface types and abstract classes where we can't determine
    // the implementing class from the type alone. We pick the first class that
    // has the method and whose struct fields are a superset of the receiver type's properties.
    if (!receiverClassName || !ctx.classSet.has(receiverClassName)) {
      const recvProps = receiverType.getProperties?.() ?? [];
      const recvPropNames = new Set(recvProps.map((p) => p.name));
      // An `any`/`unknown` receiver (or another property-less structural type)
      // provides no evidence for a nominal class. Picking the first class that
      // happens to define the same method name is order-dependent and can run a
      // private-field body against an unrelated object. Leave those receivers
      // dynamic so their runtime identity selects the method.
      const canInferClass =
        recvProps.length > 0 && (receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0;
      const canonicalClasses = canInferClass
        ? new Set([...ctx.classSet].map((name) => canonicalClassExpressionName(ctx, name) ?? name))
        : [];
      for (const className of canonicalClasses) {
        if (!ctx.funcMap.has(`${className}_${methodName}`)) continue;
        // (#3123) Never INFER a fnctor-subclass (`class C extends F`, F a
        // top-level plain function) for an any/unknown-typed receiver: the
        // runtime value may be a HOST object (e.g. an Iterator-helper
        // wrapper minted by F.prototype's live methods), and the static
        // tag-dispatch would run the class method with a null self instead
        // of forwarding to the host object. The any-receiver ladder below
        // (__gen_next/__gen_return/__extern_method_call) dispatches on the
        // runtime value for BOTH host objects and struct instances (the
        // struct arm resolves via _safeGet → __member_kind_* exports).
        if (fnctorAncestorOfClass(ctx, className) !== undefined) continue;
        // Quick heuristic: check that the class has at least the same property names
        // as the interface (structural compatibility check)
        const classFields = ctx.structFields.get(className);
        if (classFields && recvPropNames.size > 0) {
          const classFieldNames = new Set(classFields.map((f) => f.name));
          let compatible = true;
          for (const prop of recvPropNames) {
            // Methods won't be in struct fields, so skip function-typed properties
            const propSymbol = recvProps.find((p) => p.name === prop);
            const propType = propSymbol ? ctx.checker.getTypeOfSymbol(propSymbol) : undefined;
            const isMethod = propType && (propType.getCallSignatures?.()?.length ?? 0) > 0;
            if (!isMethod && !classFieldNames.has(prop)) {
              compatible = false;
              break;
            }
          }
          if (!compatible) continue;
        }
        receiverClassName = className;
        break;
      }
    }
  }
  if (receiverClassName && ctx.classSet.has(receiverClassName)) {
    const methodName = ts.isPrivateIdentifier(propAccess.name)
      ? "__priv_" + propAccess.name.text.slice(1)
      : propAccess.name.text;
    // (#3123) A WIDENED fnctor-subclass binding (`let iterator = new C();
    // iterator = iterator.drop(0)`) may hold a HOST object at runtime — the
    // static tag-dispatch below would guarded-cast it to null and run the
    // class method/getter with a null self. Dispatch member calls on such
    // bindings dynamically: the runtime value (struct instance or host
    // wrapper) decides, via __extern_method_call + the host-side
    // member-kind resolution.
    {
      let recvInner: ts.Expression = propAccess.expression;
      while (
        ts.isParenthesizedExpression(recvInner) ||
        ts.isAsExpression(recvInner) ||
        ts.isNonNullExpression(recvInner)
      ) {
        recvInner = recvInner.expression;
      }
      if (
        ts.isIdentifier(recvInner) &&
        fctx.fnctorWidenedLocals?.has(recvInner.text) &&
        fnctorAncestorOfClass(ctx, receiverClassName) !== undefined
      ) {
        const dynResult = emitFnctorSubclassDynamicMethodCall(ctx, fctx, expr, propAccess, methodName);
        if (dynResult !== undefined) return dynResult;
      }
    }
    let fullName = `${receiverClassName}_${methodName}`;
    // A class may legally expose the same spelling on its constructor and
    // prototype (`static parse()` alongside `parse()`).  The legacy lookup
    // used the shared `${Class}_${method}` key and then decided whether the
    // call was static from the *existence* of a static member.  That makes an
    // instance call such as `new Parser().parse(tokens)` select the static
    // method, which recursively re-enters the static wrapper (`Parser.parse`)
    // instead of invoking the prototype method.  Conversely, a static-only
    // method could be called with an instance receiver and receive a bogus
    // hidden `this` argument.  Use the receiver's constructor signature to
    // choose the namespace first, then resolve the collision-safe key for that
    // namespace.  `typeof C` has construct signatures; `new C()` instances do
    // not.  This keeps inherited/virtual dispatch on the instance side while
    // preserving ordinary static calls through a class value.
    // Bundled JavaScript compiled with `allowJs` can give a class-valued
    // module binding the *instance* class type (the declaration has no
    // `typeof` annotation), even though the property access is on the
    // constructor object.  The declaration pass still records that binding
    // in classExprNameMap, which is a stronger identity signal than the
    // checker-side construct-signature result here.  Without this fallback a
    // detached conditional such as `flag ? Lexer.lex : Lexer.lexInline`
    // enters the instance dispatcher, drops the static method's return, and
    // materializes null for the caller.
    const staticReceiverExpr = skipTransparentExpressions(propAccess.expression);
    const mappedStaticReceiver = ts.isIdentifier(staticReceiverExpr)
      ? ctx.classExprNameMap.get(staticReceiverExpr.text)
      : undefined;
    const receiverIsClassObject =
      (receiverType.getConstructSignatures?.().length ?? 0) > 0 || mappedStaticReceiver === receiverClassName;
    const receiverMemberKind = receiverIsClassObject ? "static" : "instance";
    const hasReceiverMember = receiverIsClassObject
      ? ctx.staticMethodSet.has(fullName)
      : ctx.classMethodSet.has(fullName);
    let funcIdx = hasReceiverMember
      ? ctx.funcMap.get(classMemberFuncKey(ctx, fullName, receiverMemberKind))
      : undefined; // (#1983)
    if (process.env.DEBUG_MARKED_CODEGEN === "1" && (methodName === "lexInline" || methodName === "lex")) {
      console.error(
        "[marked-call-receiver]",
        fctx.name,
        receiverClassName,
        methodName,
        "construct",
        receiverIsClassObject,
        "mappedStaticReceiver",
        mappedStaticReceiver,
        "receiverClassName",
        receiverClassName,
        "fullName",
        fullName,
        "hasStatic",
        ctx.staticMethodSet.has(fullName),
        "hasInstance",
        ctx.classMethodSet.has(fullName),
        "key",
        classMemberFuncKey(ctx, fullName, receiverMemberKind),
        "funcIdx",
        funcIdx,
        "base",
        ctx.funcMap.get(fullName),
        "staticKey",
        ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static")),
        "instanceKey",
        ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "instance")),
      );
    }
    // Walk inheritance chain to find the method in a parent class
    if (funcIdx === undefined && !ts.isPrivateIdentifier(propAccess.name)) {
      let ancestor = ctx.classParentMap.get(receiverClassName);
      while (ancestor && funcIdx === undefined) {
        fullName = `${ancestor}_${methodName}`;
        const ancestorHasMember = receiverIsClassObject
          ? ctx.staticMethodSet.has(fullName)
          : ctx.classMethodSet.has(fullName);
        funcIdx = ancestorHasMember
          ? ctx.funcMap.get(classMemberFuncKey(ctx, fullName, receiverMemberKind))
          : undefined; // (#1983)
        ancestor = ctx.classParentMap.get(ancestor);
      }
    }
    // Walk child classes (handles abstract class → concrete subclass).
    // (#1299) Collect ALL subclass implementations so we can emit a
    // runtime tag-based dispatch (virtual dispatch) when more than one
    // exists. Without this, a base-typed receiver would unconditionally
    // call the first subclass's method regardless of runtime type.
    let virtualCandidates: { className: string; funcIdx: number; classTag: number }[] | undefined;
    if (funcIdx === undefined && !ts.isPrivateIdentifier(propAccess.name)) {
      const candidates: { className: string; funcIdx: number; classTag: number }[] = [];
      const baseClass = fullName.split("_")[0];
      for (const [childClass, parentClass] of ctx.classParentMap) {
        if (parentClass === receiverClassName || parentClass === baseClass) {
          const childFullName = `${childClass}_${methodName}`;
          const childHasMember = receiverIsClassObject
            ? ctx.staticMethodSet.has(childFullName)
            : ctx.classMethodSet.has(childFullName);
          const childFuncIdx = childHasMember
            ? ctx.funcMap.get(classMemberFuncKey(ctx, childFullName, receiverMemberKind))
            : undefined; // (#1983)
          const childTag = ctx.classTagMap.get(childClass);
          if (childFuncIdx !== undefined && childTag !== undefined) {
            candidates.push({ className: childClass, funcIdx: childFuncIdx, classTag: childTag });
          }
        }
      }
      if (candidates.length === 1) {
        fullName = `${candidates[0]!.className}_${methodName}`;
        funcIdx = candidates[0]!.funcIdx;
      } else if (candidates.length > 1) {
        virtualCandidates = candidates;
        fullName = `${candidates[0]!.className}_${methodName}`;
        funcIdx = candidates[0]!.funcIdx;
      }
    } else if (funcIdx !== undefined && !ts.isPrivateIdentifier(propAccess.name)) {
      // Private names are lexically bound and cannot be overridden. Dispatch
      // exactly to their declaring body; treating a same-spelled private name
      // on a subclass as an override violates both the brand and self ABI.
      // Method exists on receiver class — also check for subclass overrides.
      const candidates: { className: string; funcIdx: number; classTag: number }[] = [];
      const recvTag = ctx.classTagMap.get(receiverClassName);
      if (recvTag !== undefined) {
        candidates.push({ className: receiverClassName, funcIdx, classTag: recvTag });
      }
      for (const [childClass, parentClass] of ctx.classParentMap) {
        // Walk full ancestry to capture transitive subclasses.
        let cur: string | undefined = parentClass;
        while (cur) {
          if (cur === receiverClassName) break;
          cur = ctx.classParentMap.get(cur);
        }
        if (cur === receiverClassName && childClass !== receiverClassName) {
          const childFullName = `${childClass}_${methodName}`;
          const childHasMember = receiverIsClassObject
            ? ctx.staticMethodSet.has(childFullName)
            : ctx.classMethodSet.has(childFullName);
          const childFuncIdx = childHasMember
            ? ctx.funcMap.get(classMemberFuncKey(ctx, childFullName, receiverMemberKind))
            : undefined; // (#1983)
          const childTag = ctx.classTagMap.get(childClass);
          if (
            childFuncIdx !== undefined &&
            childTag !== undefined &&
            !candidates.some((c) => c.className === childClass)
          ) {
            candidates.push({ className: childClass, funcIdx: childFuncIdx, classTag: childTag });
          }
        }
      }
      if (candidates.length > 1) {
        virtualCandidates = candidates;
      }
    }
    // Early intercept: emit virtual dispatch (tag-comparison cascade,
    // same pattern as `instanceof`) if multiple candidates exist.
    if (virtualCandidates && virtualCandidates.length > 1) {
      const vresult = emitVirtualMethodDispatchByTag(ctx, fctx, expr, propAccess, virtualCandidates, receiverClassName);
      if (vresult !== undefined) return vresult;
    }
    // If no method found, check if the property is a callable struct field
    // (e.g. this.callback() where callback is a function-typed property)
    if (funcIdx === undefined) {
      const callablePropResult = compileCallablePropertyCall(ctx, fctx, expr, propAccess, receiverClassName);
      if (callablePropResult !== undefined) return callablePropResult;
    }
    // If still no method, check if this is a getter that returns a callable.
    // Pattern: c.method(args) where `method` is a getter returning a function ref.
    // We call the getter first, then invoke the returned callable.
    if (funcIdx === undefined) {
      const getterName = `${receiverClassName}_get_${methodName}`;
      const getterIdx = ctx.funcMap.get(classMemberFuncKey(ctx, getterName)); // (#1983)
      if (getterIdx !== undefined) {
        const getterCallResult = compileGetterCallable(ctx, fctx, expr, propAccess, receiverClassName, getterIdx);
        if (getterCallResult !== undefined) return getterCallResult;
      }
    }
    // Object.prototype fallback for known class instances (#799 WI1):
    // When no method found on the class or its ancestors, check if the method
    // is an Object.prototype method and delegate to the host via externref.
    if (funcIdx === undefined) {
      const objProtoResult = compileObjectPrototypeFallback(ctx, fctx, expr, propAccess, receiverClassName, methodName);
      if (objProtoResult !== undefined) return objProtoResult;
    }
    // (#3123) Method MISS on a fnctor-subclass (`class C extends F`, F a
    // top-level plain function): the method may live on F's LIVE
    // `.prototype` — assigned at RUNTIME (module init; the test262 harness
    // `Iterator` shim installs the ES2025 Iterator-helper prototype there),
    // which no static dispatch can see. Route through the generic
    // `__extern_method_call` host ladder (the ctor registered the instance
    // in `_fnctorInstanceCtor`, so the host resolves the member through the
    // live prototype chain) instead of falling to the graceful-null tail.
    if (funcIdx === undefined && fnctorAncestorOfClass(ctx, receiverClassName) !== undefined) {
      const dynResult = emitFnctorSubclassDynamicMethodCall(ctx, fctx, expr, propAccess, methodName);
      if (dynResult !== undefined) return dynResult;
    }
    if ((funcIdx = directObjectMethodFuncIdx(ctx, expr, funcIdx)) !== undefined) {
      const isStaticMethod = receiverIsClassObject;
      // Static methods: evaluate receiver for side effects, drop, call directly
      if (isStaticMethod) {
        const recvType = compileExpression(ctx, fctx, propAccess.expression);
        if (recvType !== null) {
          fctx.body.push({ op: "drop" });
        }
        // Re-resolve funcIdx after receiver compilation — emitUndefined (for `this` in static
        // context) triggers addUnionImports which shifts all function indices (#998)
        const resolvedStaticIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static")) ?? funcIdx; // (#1983)
        const paramTypes = getFuncParamTypes(ctx, resolvedStaticIdx);
        const paramCount = paramTypes ? paramTypes.length : expr.arguments.length;
        const calleeReadsArgsStatic = ctx.funcUsesArguments.has(fullName);
        const restInfoStatic = knownMethodRestInfo(ctx, expr, fullName, paramTypes, 0);
        const handledRestStatic =
          restInfoStatic !== undefined && emitKnownRestMethodArguments(ctx, fctx, expr, paramTypes, restInfoStatic, 0);
        if (!handledRestStatic) {
          for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
            compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
          }
        }
        if (!handledRestStatic && expr.arguments.length > paramCount) {
          if (calleeReadsArgsStatic) {
            emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], paramCount);
          } else {
            for (let i = paramCount; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
        }
        if (paramTypes && !handledRestStatic) {
          for (let i = expr.arguments.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        // Set __argc before the call so the callee knows the actual arg count
        maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, paramCount);
        const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static")) ?? resolvedStaticIdx; // (#1983)
        fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
        const sig = ctx.checker.getResolvedSignature(expr);
        if (
          process.env.DEBUG_MARKED_CODEGEN === "1" &&
          (methodName === "lex" || methodName === "lexInline" || methodName === "parse" || methodName === "parseInline")
        ) {
          console.error(
            "[marked-static-return]",
            methodName,
            fullName,
            "idx",
            finalMethodIdx,
            "sig",
            !!sig,
            "wasmVoid",
            wasmFuncReturnsVoid(ctx, finalMethodIdx),
            "wasmRet",
            getWasmFuncReturnType(ctx, finalMethodIdx),
            "expected",
            expectedType,
            "parent",
            expr.parent?.kind,
          );
        }
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
          return brandExternMethodResult(
            ctx,
            retType,
            getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType),
          );
        }
        // Synthetic calls used by conditional-callee lowering are not always
        // attached to a source node, so TypeScript can decline to resolve a
        // signature even though the selected class method has already been
        // emitted. Preserve that method's real Wasm result instead of
        // reporting void (which makes the caller drop the value and replace it
        // with null).
        if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
        return getWasmFuncReturnType(ctx, finalMethodIdx) ?? expectedType ?? { kind: "externref" };
      }
      // Push self (the receiver) as first argument, with type hint from method's first param
      const methodParamTypes0 = getFuncParamTypes(ctx, funcIdx);
      // (#2132) A method call on a statically-nullable receiver (`C | null`,
      // incl. when laundered through `as any`) must throw a CATCHABLE
      // TypeError on null, not a bare `ref.as_non_null` trap (Wasm null-deref
      // traps bypass the module's exception tags and abort uncatchably).
      // Detect nullability from the static type here, because the param-0 type
      // hint passed to compileExpression below can coerce the value to a
      // non-null `ref` and hide it from the `recvType.kind === "ref_null"`
      // guard further down.
      const NULL_OR_UNDEF = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
      const typeIsMaybeNull = (t: ts.Type): boolean =>
        (t.flags & NULL_OR_UNDEF) !== 0 ||
        (t.isUnion?.() === true && t.types.some((u) => (u.flags & NULL_OR_UNDEF) !== 0));
      // Peel `as`/`!`/parens so `(c as any)` / `c!` reveal the underlying
      // declared nullability — `as any` launders Null out of the static type,
      // so checking only the cast expression's own type would miss it (#2132).
      let receiverInner: ts.Expression = propAccess.expression;
      while (
        ts.isAsExpression(receiverInner) ||
        ts.isNonNullExpression(receiverInner) ||
        ts.isParenthesizedExpression(receiverInner) ||
        ts.isTypeAssertionExpression(receiverInner)
      ) {
        receiverInner = (
          receiverInner as ts.AsExpression | ts.NonNullExpression | ts.ParenthesizedExpression | ts.TypeAssertion
        ).expression;
      }
      const receiverMaybeNull =
        typeIsMaybeNull(ctx.checker.getTypeAtLocation(propAccess.expression)) ||
        typeIsMaybeNull(ctx.checker.getTypeAtLocation(receiverInner));
      // (#2132) When the receiver may be null, pass a NULLABLE param-0 hint (or
      // none) so compileExpression keeps the value nullable on the stack — a
      // non-null `ref` hint makes coerceType emit `ref.as_non_null`, which
      // would trap on null BEFORE the guard below can throw a catchable
      // TypeError. The `ref_null` guard further down re-asserts non-null only
      // on the non-null branch.
      const recvHint0: ValType | undefined =
        receiverMaybeNull && methodParamTypes0?.[0]?.kind === "ref"
          ? { kind: "ref_null", typeIdx: (methodParamTypes0[0] as { typeIdx: number }).typeIdx }
          : methodParamTypes0?.[0];
      let recvType = compileExpression(ctx, fctx, propAccess.expression, recvHint0);
      // Track whether receiver went through emitGuardedRefCast — if so, null
      // means "wrong struct type" (not genuinely null), so we should NOT throw
      // TypeError on null after cast.
      let receiverWasCast = false;
      // (#2132) If the receiver is statically nullable but compiled to a
      // non-null `ref` (e.g. via `as any`), force `ref_null` so the null-guard
      // below fires and throws a catchable TypeError instead of trapping.
      if (
        receiverMaybeNull &&
        recvType &&
        recvType.kind === "ref" &&
        (recvType as { typeIdx?: number }).typeIdx !== undefined
      ) {
        recvType = { kind: "ref_null", typeIdx: (recvType as { typeIdx: number }).typeIdx };
      }
      // If receiver is externref but the method expects a struct ref, coerce —
      // and ONLY then. (#2620 gc/host arm) A callee taking `externref` self is a
      // host import: casting to the class struct there always fails (the
      // instance is a real host Map/Set from `__new_Map`), yields null, and the
      // null-guard below silently DROPS the call. Full analysis + the measured
      // rows are on plan/issues/2620-*.md ("the gc/host lane was NOT fine").
      if (recvType && recvType.kind === "externref" && getFuncParamTypes(ctx, funcIdx)?.[0]?.kind !== "externref") {
        const structTypeIdx = ctx.structMap.get(receiverClassName);
        if (structTypeIdx !== undefined) {
          // Check for null BEFORE the guarded cast — only genuine null should throw TypeError
          emitNullCheckThrow(ctx, fctx, { kind: "externref" });
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, structTypeIdx);
          recvType = { kind: "ref_null", typeIdx: structTypeIdx };
          receiverWasCast = true;
        }
      }
      // Null-guard: if receiver is ref_null, check for null before calling method
      if (recvType && recvType.kind === "ref_null") {
        // Determine return type early so we can build null-guard
        const sig = ctx.checker.getResolvedSignature(expr);
        let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (!isEffectivelyVoidReturn(ctx, retType, fullName))
            callReturnType = brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
            );
        }
        const tmp = allocLocal(fctx, `__ng_recv_${fctx.locals.length}`, recvType);
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "ref.is_null" });

        // Build the else branch (non-null path) with the full call
        const savedBody = pushBody(fctx);
        fctx.body.push({ op: "local.get", index: tmp });
        fctx.body.push({ op: "ref.as_non_null" });
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        // Coerce receiver (self param) if ref type doesn't match function's first param
        if (paramTypes?.[0]) {
          const recvRefType: ValType = { kind: "ref", typeIdx: (recvType as any).typeIdx };
          if (!valTypesMatch(recvRefType, paramTypes[0])) {
            coerceType(ctx, fctx, recvRefType, paramTypes[0]);
          }
        }
        // User-visible param count excludes self (param 0)
        const ngParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
        const calleeReadsArgsNg = ctx.funcUsesArguments.has(fullName);
        const restInfoNg = knownMethodRestInfo(ctx, expr, fullName, paramTypes, 1);
        const handledRestNg =
          restInfoNg !== undefined && emitKnownRestMethodArguments(ctx, fctx, expr, paramTypes, restInfoNg, 1);
        if (!handledRestNg) {
          for (let i = 0; i < Math.min(expr.arguments.length, ngParamCount); i++) {
            compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
          }
        }
        if (!handledRestNg && expr.arguments.length > ngParamCount) {
          if (calleeReadsArgsNg) {
            emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], ngParamCount);
          } else {
            for (let i = ngParamCount; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
        }
        if (paramTypes && !handledRestNg) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        // Set __argc before the call so the callee knows the actual arg count
        maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, ngParamCount);
        const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
        fctx.body.push({ op: "call", funcIdx: finalMethodIdx });
        const elseInstrs = fctx.body;
        fctx.body = savedBody;

        if (callReturnType === VOID_RESULT) {
          // Void method: if null after cast, skip (wrong type); if genuinely null, throw TypeError
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: receiverWasCast ? [] : typeErrorThrowInstrs(ctx),
            else: elseInstrs,
          });
          return VOID_RESULT;
        } else {
          const resultType: ValType =
            callReturnType.kind === "ref"
              ? { kind: "ref_null", typeIdx: (callReturnType as any).typeIdx }
              : callReturnType;
          // throw is divergent, so the then branch is valid without producing a value
          fctx.body.push({
            op: "if",
            blockType: { kind: "val" as const, type: resultType },
            then: receiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
            else: elseInstrs,
          });
          return resultType;
        }
      }
      // Non-nullable receiver: emit call directly.
      // User-visible param count excludes self (param 0). Clamp to ≥ 0 —
      // when funcMap indirectly points at a stale index (e.g. a zero-arg
      // constructor entry that wasn't shifted after a late import), the
      // raw `length - 1` would go negative and the `for` loop would read
      // `expr.arguments[-1]` → undefined → "unexpected undefined AST node".
      // Seen in tests that mix static + instance private methods under
      // the #1162 yield* async-generator cluster.
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      const methodParamCount = paramTypes ? Math.max(0, paramTypes.length - 1) : expr.arguments.length;
      const calleeReadsArgsNn = ctx.funcUsesArguments.has(fullName);
      const restInfoNn = knownMethodRestInfo(ctx, expr, fullName, paramTypes, 1);
      const handledRestNn =
        restInfoNn !== undefined && emitKnownRestMethodArguments(ctx, fctx, expr, paramTypes, restInfoNn, 1);
      if (!handledRestNn) {
        for (let i = 0; i < Math.min(expr.arguments.length, methodParamCount); i++) {
          compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
        }
      }
      if (!handledRestNn && expr.arguments.length > methodParamCount) {
        if (calleeReadsArgsNn) {
          emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], methodParamCount);
        } else {
          for (let i = methodParamCount; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
      }
      // Pad missing arguments with defaults (skip self param at index 0)
      if (paramTypes && !handledRestNn) {
        for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      }
      // Set __argc before the call so the callee knows the actual arg count
      maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, methodParamCount);
      // Re-lookup funcIdx: argument compilation may trigger addUnionImports
      const finalMethodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? funcIdx; // (#1983)
      fctx.body.push({ op: "call", funcIdx: finalMethodIdx });

      // Determine return type
      const sig = ctx.checker.getResolvedSignature(expr);
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
        if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
        return brandExternMethodResult(
          ctx,
          retType,
          getWasmFuncReturnType(ctx, finalMethodIdx) ?? resolveWasmType(ctx, retType),
        );
      }
      if (wasmFuncReturnsVoid(ctx, finalMethodIdx)) return VOID_RESULT;
      return getWasmFuncReturnType(ctx, finalMethodIdx) ?? expectedType ?? { kind: "externref" };
    }
  }

  // Check if receiver is a struct type (e.g. object literal with methods)
  {
    const structTypeName = resolveStructName(ctx, receiverType);
    if (structTypeName) {
      const methodName = propAccess.name.text;
      const fullName = `${structTypeName}_${methodName}`;
      let funcIdx = ctx.funcMap.get(fullName);
      // If no method found, check callable property on struct
      if (funcIdx === undefined) {
        const callablePropResult = compileCallablePropertyCall(ctx, fctx, expr, propAccess, structTypeName);
        if (callablePropResult !== undefined) return callablePropResult;
      }
      if ((funcIdx = directObjectMethodFuncIdx(ctx, expr, funcIdx)) !== undefined) {
        // Push self (the receiver) as first argument, with type hint from method's first param
        const structMethodPTypes = getFuncParamTypes(ctx, funcIdx);
        const recvType = compileExpression(ctx, fctx, propAccess.expression, structMethodPTypes?.[0]);
        // Check if receiver went through emitGuardedRefCast — null may mean
        // "wrong struct type" rather than genuinely null (#789)
        const smReceiverWasCast = (fctx as any).__lastGuardedCastBackup !== undefined;
        // Module globals produce ref_null but method params expect ref — null-guard
        if (recvType && recvType.kind === "ref_null") {
          const sig = ctx.checker.getResolvedSignature(expr);
          let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (!isEffectivelyVoidReturn(ctx, retType, fullName))
              callReturnType = brandExternMethodResult(
                ctx,
                retType,
                getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
              );
          }
          const tmp = allocLocal(fctx, `__ng_srecv_${fctx.locals.length}`, recvType);
          fctx.body.push({ op: "local.tee", index: tmp });
          fctx.body.push({ op: "ref.is_null" });

          const savedBody = pushBody(fctx);
          fctx.body.push({ op: "local.get", index: tmp });
          fctx.body.push({ op: "ref.as_non_null" });
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          // Coerce receiver (self param) if ref type doesn't match function's first param
          if (paramTypes?.[0]) {
            const recvRefType: ValType = { kind: "ref", typeIdx: (recvType as any).typeIdx };
            if (!valTypesMatch(recvRefType, paramTypes[0])) {
              coerceType(ctx, fctx, recvRefType, paramTypes[0]);
            }
          }
          const smMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          const calleeReadsArgsSm = ctx.funcUsesArguments.has(fullName);
          const restInfoSm = knownMethodRestInfo(ctx, expr, fullName, paramTypes, 1);
          const handledRestSm =
            restInfoSm !== undefined && emitKnownRestMethodArguments(ctx, fctx, expr, paramTypes, restInfoSm, 1);
          if (!handledRestSm) {
            for (let i = 0; i < Math.min(expr.arguments.length, smMethodParamCount); i++) {
              compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
            }
          }
          if (!handledRestSm && expr.arguments.length > smMethodParamCount) {
            if (calleeReadsArgsSm) {
              emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], smMethodParamCount);
            } else {
              for (let i = smMethodParamCount; i < expr.arguments.length; i++) {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
          }
          if (paramTypes && !handledRestSm) {
            for (let i = Math.min(expr.arguments.length, smMethodParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          // Set __argc before the call so the callee knows the actual arg count
          maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, smMethodParamCount);
          const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
          fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });
          const elseInstrs = fctx.body;
          fctx.body = savedBody;

          if (callReturnType === VOID_RESULT) {
            // Void method: if null after cast, skip (wrong type); if genuinely null, throw TypeError (#789)
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: smReceiverWasCast ? [] : typeErrorThrowInstrs(ctx),
              else: elseInstrs,
            });
            return VOID_RESULT;
          } else {
            const resultType: ValType =
              callReturnType.kind === "ref"
                ? {
                    kind: "ref_null",
                    typeIdx: (callReturnType as any).typeIdx,
                  }
                : callReturnType;
            // throw is divergent, valid without producing a value (#789)
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: resultType },
              then: smReceiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
              else: elseInstrs,
            });
            return resultType;
          }
        }
        // Non-nullable receiver
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const nnMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
        const calleeReadsArgsNns = ctx.funcUsesArguments.has(fullName);
        const restInfoNns = knownMethodRestInfo(ctx, expr, fullName, paramTypes, 1);
        const handledRestNns =
          restInfoNns !== undefined && emitKnownRestMethodArguments(ctx, fctx, expr, paramTypes, restInfoNns, 1);
        if (!handledRestNns) {
          for (let i = 0; i < Math.min(expr.arguments.length, nnMethodParamCount); i++) {
            compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
          }
        }
        if (!handledRestNns && expr.arguments.length > nnMethodParamCount) {
          if (calleeReadsArgsNns) {
            emitSetExtrasArgv(ctx, fctx, expr.arguments as unknown as ts.Expression[], nnMethodParamCount);
          } else {
            for (let i = nnMethodParamCount; i < expr.arguments.length; i++) {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
        }
        // Pad missing arguments with defaults (skip self param at index 0)
        if (paramTypes && !handledRestNns) {
          for (let i = Math.min(expr.arguments.length, nnMethodParamCount) + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        // Set __argc before the call so the callee knows the actual arg count
        maybeSetArgcForKnownCall(ctx, fctx, fullName, expr.arguments.length, nnMethodParamCount);
        // Re-lookup funcIdx: argument compilation may trigger addUnionImports
        const finalStructMethodIdx = ctx.funcMap.get(fullName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalStructMethodIdx });

        const sig = ctx.checker.getResolvedSignature(expr);
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
          if (wasmFuncReturnsVoid(ctx, finalStructMethodIdx)) return VOID_RESULT;
          return brandExternMethodResult(
            ctx,
            retType,
            getWasmFuncReturnType(ctx, finalStructMethodIdx) ?? resolveWasmType(ctx, retType),
          );
        }
        if (wasmFuncReturnsVoid(ctx, finalStructMethodIdx)) return VOID_RESULT;
        return getWasmFuncReturnType(ctx, finalStructMethodIdx) ?? expectedType ?? { kind: "externref" };
      }
    }
  }

  // (#2903 R4b) Standalone DIRECT-carrier packed-integer typed-array
  // `map`/`filter` → the native `__ta_map_*`/`__ta_filter_*` typed-RESULT
  // helper, BEFORE the array-methods.ts path (whose standalone packed-carrier
  // arm is the same `__make_callback` no-op stub the R4 scalar HOFs hit). The
  // helper allocates a fresh same-kind packed `$__vec_<kind>` carrier and
  // drives the callback host-free via `__apply_closure`. Returns the vec ref
  // directly so the statically-typed result binding (`const b: Uint8Array =
  // a.map(...)`) matches and reads element-correctly. `Uint8ClampedArray`
  // (#2903 R4c) routes here too but through the `clamp` helper variant
  // (round-half-to-even store). Float views + `any`-held receivers are still
  // excluded (see the view set / the R4b/R4c notes).
  if (
    ctx.standalone &&
    (propAccess.name.text === "map" || propAccess.name.text === "filter") &&
    expr.arguments.length >= 1 &&
    !expr.arguments.some((a) => ts.isSpreadElement(a))
  ) {
    const viewName = receiverType.getSymbol?.()?.getName?.();
    // (#2903 R4c) `Uint8ClampedArray` shares the `i8_byte` carrier but stores
    // via ToUint8Clamp (round-half-to-even), not the width-truncation the other
    // integer views use → a DISTINCT clamp helper (`clamp` flag below).
    const isClamped = viewName === "Uint8ClampedArray";
    if (viewName !== undefined && (STANDALONE_TA_MAPFILTER_PACKED_VIEWS.has(viewName) || isClamped)) {
      const methodName = propAccess.name.text as "map" | "filter";
      const storage = typedArrayVecStorage(ctx, viewName);
      const vecTypeIdx = getOrRegisterVecType(ctx, storage.key, storage.type);
      const helperIdx = ensureTaMapFilterHelper(ctx, methodName, vecTypeIdx, isClamped);
      if (helperIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        // Receiver → externref.
        const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        if (recvT && recvT.kind !== "externref") coerceType(ctx, fctx, recvT, { kind: "externref" });
        else if (recvT === null) fctx.body.push({ op: "ref.null.extern" });
        // Callback (arg0) → WasmGC closure struct (not __make_callback).
        const cbArg = expr.arguments[0]!;
        if (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)) {
          const at = compileArrowAsClosure(ctx, fctx, cbArg);
          if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
          else if (at === null) fctx.body.push({ op: "ref.null.extern" });
        } else {
          const at = compileExpression(ctx, fctx, cbArg, { kind: "externref" });
          if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
          else if (at === null) fctx.body.push({ op: "ref.null.extern" });
        }
        // thisArg (arg1) → externref, or undefined-sentinel null.
        if (expr.arguments.length >= 2) {
          const tt = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
          if (tt && tt.kind !== "externref") coerceType(ctx, fctx, tt, { kind: "externref" });
          else if (tt === null) fctx.body.push({ op: "ref.null.extern" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "call", funcIdx: helperIdx });
        return { kind: "ref", typeIdx: vecTypeIdx };
      }
    }
  }

  // (#2903 R4) Standalone DIRECT-carrier typed-array SCALAR callback HOFs
  // (find/findIndex/…/forEach/some/every/reduce) → the native
  // `__call_m_<name>_<arity>` / `__hof_<name>` substrate, BEFORE the
  // array-methods.ts path. On main the standalone typed-array externref arm in
  // `compileArrayMethodCall` is a `__make_callback` no-op STUB (banked at
  // array-methods.ts ~"BANKED … the callback methods … → env.__make_callback"
  // as "a separate follow-up") — it leaks `env.__make_callback` (breaking
  // host-free instantiation) and never runs the predicate. The closed-method
  // dispatcher's `$__vec_base` HOF arm drives the callback via `__apply_closure`
  // on a WasmGC closure struct (host-free), reading elements through the
  // byte-carrier-aware `__extern_get_idx` (this PR). Only DIRECT carriers reach
  // here; the dynamic-view (`$__ta_dyn_view`) shape keeps its own #3058/#3162
  // path in array-methods.ts (disjoint receiver). map/filter (typed-RESULT)
  // deferred to R4b. Standalone-gated → gc/wasi byte-identical.
  if (ctx.standalone && STANDALONE_TA_SCALAR_HOFS.has(propAccess.name.text)) {
    // A concrete typed-array receiver carries its view name directly on the
    // type symbol (the known-element-kind shape this interception targets).
    const taName = receiverType.getSymbol?.()?.getName?.();
    const hasSpread = expr.arguments.some((a) => ts.isSpreadElement(a));
    const dispatchArgs = hasSpread ? flattenCallArgs(expr.arguments) : [...expr.arguments];
    if (
      taName !== undefined &&
      isWiredTypedArrayViewName(taName) &&
      dispatchArgs !== null &&
      dispatchArgs.length >= 1
    ) {
      const methodName = propAccess.name.text;
      const arity = dispatchArgs.length;
      const dispatchIdx = reserveClosedMethodDispatch(ctx, methodName, arity);
      flushLateImportShifts(ctx, fctx);
      // Receiver → externref.
      const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
      if (recvT && recvT.kind !== "externref") coerceType(ctx, fctx, recvT, { kind: "externref" });
      else if (recvT === null) fctx.body.push({ op: "ref.null.extern" });
      // Args → externref; an INLINE arrow/function callback compiles as a raw
      // WasmGC closure struct (crossing as externref) — NOT the host
      // `__make_callback` bridge — so the dispatcher's HOF arm can drive it via
      // `__apply_closure` (same rep an identifier-held callback crosses with).
      for (const arg of dispatchArgs) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          const at = compileArrowAsClosure(ctx, fctx, arg);
          if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
          else if (at === null) fctx.body.push({ op: "ref.null.extern" });
        } else {
          const at = compileInternalCallArgument(ctx, fctx, arg, { kind: "externref" });
          if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
          else if (at === null) fctx.body.push({ op: "ref.null.extern" });
        }
      }
      fctx.body.push({ op: "call", funcIdx: dispatchIdx });
      return { kind: "externref" };
    }
  }

  // Array method calls
  // A native-first `any`/`unknown` receiver can be a caller-owned JS array.
  // Do not specialize it as a Wasm vec from the method spelling alone: the
  // generic object-runtime call preserves the admitted raw JS receiver and
  // reaches the boundary-object adapter only on its non-native fallback.
  if (
    !(
      ctx.targetProfile.semanticProviders === "native-first" &&
      (receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    )
  ) {
    const arrMethodResult = compileArrayMethodCall(ctx, fctx, propAccess, expr, receiverType, undefined, expectedType);
    if (arrMethodResult !== undefined) return arrMethodResult;
  }

  // Primitive method calls: number.toString(), number.toFixed()
  if (isNumberMethodReceiver(ctx, receiverType) && propAccess.name.text === "toString") {
    // RangeError: if radix argument is provided, must be integer 2-36
    // Also captures the validated, floored radix in `radixLocalIdx` so it can
    // be passed to the 2-arg `number_toString_radix` host import below (#1321).
    let radixLocalIdx: number | undefined;
    // (#3175) §21.1.3.6 step 2: an `undefined` radix means base 10 — the
    // ToIntegerOrInfinity/range-check (steps 3-4) is skipped entirely, so
    // `(5).toString(undefined)` is `"5"`, NOT a RangeError. A literal
    // `undefined` / `void 0` argument would otherwise floor to NaN and hit
    // the NaN→RangeError guard (or trap on the externref→f64 coercion). Treat
    // it as the 0-arg (default base-10) case.
    const radixArg = expr.arguments.length > 0 ? expr.arguments[0]! : undefined;
    const radixArgIsUndefined =
      radixArg !== undefined &&
      ((ts.isIdentifier(radixArg) && radixArg.text === "undefined") ||
        (ts.isVoidExpression(radixArg) && ts.isNumericLiteral(radixArg.expression)));
    if (radixArg !== undefined && !radixArgIsUndefined) {
      compileExpression(ctx, fctx, radixArg, { kind: "f64" });
      // Floor the radix (ToInteger semantics: NaN→0, 2.5→2, etc.)
      fctx.body.push({ op: "f64.floor" });
      radixLocalIdx = allocLocal(fctx, `__radix_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: radixLocalIdx });
      // Check radix < 2 (also catches NaN since NaN < 2 after floor(NaN)=NaN is still false)
      fctx.body.push({ op: "f64.const", value: 2 });
      fctx.body.push({ op: "f64.lt" });
      // Check radix > 36
      fctx.body.push({ op: "local.get", index: radixLocalIdx });
      fctx.body.push({ op: "f64.const", value: 36 });
      fctx.body.push({ op: "f64.gt" });
      fctx.body.push({ op: "i32.or" });
      // Check radix is NaN (NaN != NaN)
      fctx.body.push({ op: "local.get", index: radixLocalIdx });
      fctx.body.push({ op: "local.get", index: radixLocalIdx });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({ op: "i32.or" });
      {
        // (#3175) Throw a real RangeError INSTANCE so the raw-`try`/`catch` +
        // `assert(e instanceof RangeError)` corpus passes (not a bare string).
        const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
        const throwInstrs = buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: throwInstrs,
          else: [],
        });
      }
      // radix was consumed by the validation comparisons above (via local.tee);
      // the original (floored) value is preserved in radixLocalIdx for the call.
    }
    // (#2160 number-wrapper) Recover the f64 receiver — primitive directly, or
    // a standalone `new Number(x)` wrapper via __to_primitive/__unbox_number.
    emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
    // #1321: when a radix was provided, route to the 2-arg host import that
    // actually uses it. The legacy 1-arg `number_toString` only handled base 10
    // and silently dropped the radix — `(255).toString(16)` returned "255".
    // #1335: in standalone / WASI (nativeStrings) mode the native
    // number_toString[_radix] helpers return an externref that wraps a
    // `$NativeString`. Downstream string consumers (`.charAt`, `+`, return)
    // coerce externref→native via `any.convert_extern` + `ref.cast`; if we
    // report the value type as `externref` here, a consumer that ALSO
    // unwraps applies a SECOND `any.convert_extern` to the already-native
    // ref ("any.convert_extern expected externref, found native ref"). Unwrap
    // once at the call site and report the native string type so consumers
    // see a native receiver directly. JS-host mode keeps the externref.
    //
    // (#3912) The old third conjunct was `(ctx.standalone || ctx.wasi)` — the
    // SAME between-family mismatch this issue fixes in `import-collector.ts`,
    // one layer down. `fast` sets `nativeStrings` but neither of those, so
    // `.toString()` reported a bare `externref` that in fact wrapped an
    // `$AnyString`. Consumers then had to re-discover the representation
    // dynamically (`ref.test $AnyString`), and any consumer that could NOT —
    // notably a JS-host import argument like `parseInt` — silently received an
    // opaque WasmGC struct. Since #3912 makes the formatter native whenever
    // `usesNativeNumberFormat`, "are strings native here?" is the whole
    // question, so the target-specific conjunct is gone.
    const unwrapToNative = ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && usesNativeNumberFormat(ctx);
    if (radixLocalIdx !== undefined) {
      const radixFuncIdx = ctx.funcMap.get("number_toString_radix");
      if (radixFuncIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "call", funcIdx: radixFuncIdx });
        if (unwrapToNative) {
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
          return nativeStringType(ctx);
        }
        return { kind: "externref" };
      }
    }
    const funcIdx = ctx.funcMap.get("number_toString");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      if (unwrapToNative) {
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
        return nativeStringType(ctx);
      }
      return { kind: "externref" };
    }
  }
  // (#2160) Number.prototype.toLocaleString() with no arguments, STANDALONE/
  // WASI only. Without ECMA-402 the result equals ToString(value) base 10
  // (§21.1.3.4), so route it to the same `number_toString` lowering as the
  // 0-arg `.toString()` arm above. This removes the standalone/WASI
  // `__extern_toLocaleString` dynamic-shape refusal (a host-only import with
  // no native fallback). Host (gc) mode is intentionally excluded: it keeps
  // the `__extern_toLocaleString` path below for real Intl grouping. A call
  // WITH a locale argument also falls through to that host path.
  if (
    (ctx.standalone || ctx.wasi) &&
    isNumberMethodReceiver(ctx, receiverType) &&
    propAccess.name.text === "toLocaleString" &&
    expr.arguments.length === 0
  ) {
    // (#2160 number-wrapper) f64 receiver recovery (primitive or wrapper).
    emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
    const funcIdx = ctx.funcMap.get("number_toString");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      const unwrapToNative = ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && (ctx.standalone || ctx.wasi);
      if (unwrapToNative) {
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
        return nativeStringType(ctx);
      }
      return { kind: "externref" };
    }
  }
  // (#1644 Slice D) BigInt.prototype.toString — bigint receivers cross the
  // boundary as i64. Mirror the number branch: validate radix range (2-36),
  // throw RangeError otherwise, then call bigint_toString_radix (or the
  // 1-arg bigint_toString for the default radix-10 case).
  if (isBigIntType(receiverType) && propAccess.name.text === "toString") {
    let radixLocalIdx: number | undefined;
    if (expr.arguments.length > 0) {
      compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
      fctx.body.push({ op: "f64.floor" });
      radixLocalIdx = allocLocal(fctx, `__bi_radix_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: radixLocalIdx });
      fctx.body.push({ op: "f64.const", value: 2 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "local.get", index: radixLocalIdx });
      fctx.body.push({ op: "f64.const", value: 36 });
      fctx.body.push({ op: "f64.gt" });
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({ op: "local.get", index: radixLocalIdx });
      fctx.body.push({ op: "local.get", index: radixLocalIdx });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
          else: [],
        });
      }
    }
    const exprType = compileExpression(ctx, fctx, propAccess.expression);
    if (exprType && exprType.kind === "i32") {
      fctx.body.push({ op: "i64.extend_i32_s" });
    }
    if (radixLocalIdx !== undefined) {
      const radixFuncIdx = ctx.funcMap.get("bigint_toString_radix");
      if (radixFuncIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: radixLocalIdx });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        fctx.body.push({ op: "call", funcIdx: radixFuncIdx });
        return { kind: "externref" };
      }
    }
    const funcIdx = ctx.funcMap.get("bigint_toString");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
  }

  // (#2163) Symbol.prototype.toString / valueOf on a symbol-typed receiver.
  // The symbol value is a bare i32 counter id; without a dedicated handler the
  // generic .toString() fallback drops the id and emits "[object Object]" via a
  // string-constant global that, in native-strings/standalone mode, resolves to
  // the -1 sentinel (the late-import index-shift CE, #2043). In native-strings
  // mode build the spec descriptive string natively (§20.4.3.3.1
  // SymbolDescriptiveString → "Symbol(" + (desc ?? "") + ")") with zero host
  // imports; valueOf returns the symbol primitive (the i32 id) itself.
  if (isSymbolType(receiverType)) {
    const method = propAccess.name.text;
    if (method === "valueOf" && expr.arguments.length === 0) {
      // Symbol.prototype.valueOf() → the symbol primitive itself (i32 id).
      return compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
    }
    if (method === "toString" && expr.arguments.length === 0 && ctx.nativeStrings) {
      const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "i32" });
      if (recvType && recvType.kind !== "i32") {
        coerceType(ctx, fctx, recvType, { kind: "i32" });
      }
      emitSymbolToString(ctx, fctx);
      return nativeStringType(ctx);
    }
    // (#3085) Host mode: box the symbol id to a JS Symbol and route through the
    // host SymbolDescriptiveString (§20.4.3.3). Without this the generic
    // `.toString()` fallback drops the id and emits "[object Object]". Mirrors
    // the `.description` host path (property-access.ts); the native-strings path
    // above is the standalone fallback.
    if (method === "toString" && expr.arguments.length === 0 && !ctx.nativeStrings) {
      const symToStrIdx = ensureLateImport(ctx, "__symbol_to_string", [{ kind: "externref" }], [{ kind: "externref" }]);
      if (symToStrIdx !== undefined) {
        const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        if (recvType && recvType.kind !== "externref") {
          coerceType(ctx, fctx, recvType, { kind: "externref" });
        }
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: symToStrIdx });
        return { kind: "externref" };
      }
    }
  }

  if (isNumberMethodReceiver(ctx, receiverType) && propAccess.name.text === "toFixed") {
    // (#2160 number-wrapper) f64 receiver recovery (primitive or wrapper).
    emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
    // Compile the digits argument (default 0)
    if (expr.arguments.length > 0) {
      // ToInteger(fractionDigits) begins with ToNumber (§21.1.3.3 step 4).
      // A non-f64 argument (externref/ref, e.g. a Symbol) must funnel through
      // ToNumber, which throws TypeError on Symbol; coerce to f64 here so the
      // subsequent f64 local.tee is type-correct and Symbols throw (#1564).
      coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
      // RangeError: fractionDigits must be 0-100
      const digitsLocal = allocLocal(fctx, `__toFixed_digits_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: digitsLocal });
      // (#3175) §21.1.3.3 step 1: f = ToIntegerOrInfinity(fractionDigits),
      // which TRUNCATES toward zero (then maps NaN → 0). This must run BEFORE
      // the [0,100] RangeError gate: `(5).toFixed(-0.1)` truncates to -0 (in
      // range → "5"), NOT RangeError; `(5).toFixed(1.9)` truncates to 1. And a
      // NaN/non-numeric-string count (`(5).toFixed(NaN)` / `.toFixed("x")`)
      // maps to 0 — without normalisation NaN reaches the native
      // `number_toFixed`, whose `i32.trunc_f64_s(NaN)` traps ("float
      // unrepresentable in integer range"). Mirrors the toPrecision arm's
      // ToIntegerOrInfinity handling.
      fctx.body.push({ op: "local.get", index: digitsLocal });
      fctx.body.push({ op: "f64.trunc" });
      fctx.body.push({ op: "local.set", index: digitsLocal });
      normalizeNaNToZero(fctx, digitsLocal);
      // Check digits < 0
      fctx.body.push({ op: "local.get", index: digitsLocal });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      // Check digits > 100
      fctx.body.push({ op: "local.get", index: digitsLocal });
      fctx.body.push({ op: "f64.const", value: 100 });
      fctx.body.push({ op: "f64.gt" });
      fctx.body.push({ op: "i32.or" });
      {
        // (#3175) Real RangeError INSTANCE (see the toString radix gate).
        const rangeErrMsg = "RangeError: toFixed() digits argument must be between 0 and 100";
        const throwInstrs = buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: throwInstrs,
          else: [],
        });
      }
      fctx.body.push({ op: "local.get", index: digitsLocal });
    } else {
      fctx.body.push({ op: "f64.const", value: 0 });
    }
    const funcIdx = ctx.funcMap.get("number_toFixed");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
  }
  // number.toPrecision(precision)
  if (isNumberMethodReceiver(ctx, receiverType) && propAccess.name.text === "toPrecision") {
    // (#2160 number-wrapper) f64 receiver recovery (primitive or wrapper).
    emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
    // (#3078) §21.1.3.5 step 2: an explicit `undefined` precision is
    // spec-equivalent to no argument → `return ! ToString(x)`. It is NOT
    // ToIntegerOrInfinity(undefined)=0 (which would trip the [1,100] RangeError
    // gate). undefined and NaN both compile to f64 NaN, so they are
    // indistinguishable at the value site — route the STATIC undefined literal
    // to the no-arg branch (NaN sentinel) at the AST level.
    // test262 toPrecision/undefined-precision-arg.js.
    if (expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
      // (#49) Spec §21.1.3.5 step 4 says: if x is non-finite, return
      // Number::toString(x) BEFORE the precision range check. Save the
      // receiver into a local, check finiteness, and only run the
      // range check when x is finite. Non-finite v with bad precision
      // (e.g. `(NaN).toPrecision(Infinity)`) must return "NaN" not
      // throw RangeError.
      const recvLocalP = allocLocal(fctx, `__toPrecision_recv_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: recvLocalP });
      // ToNumber(precision) funnel — Symbol args must throw TypeError (#1564).
      coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
      const precLocal = allocLocal(fctx, `__toPrecision_prec_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: precLocal });

      // (#1735) §21.1.3.5 step 5: p = ToIntegerOrInfinity(precision), NaN → 0.
      // The `number_toPrecision` runtime helper uses NaN as its "no precision
      // supplied" sentinel, so an explicit NaN precision (`(1).toPrecision(NaN)`)
      // must be normalised to 0 here so it isn't mistaken for no-arg. (A 0
      // precision then trips the RangeError gate below — 0 is out of [1,100] —
      // which matches V8: explicit NaN precision throws RangeError.)
      normalizeNaNToZero(fctx, precLocal);

      // Re-push receiver for the runtime call.
      fctx.body.push({ op: "local.get", index: recvLocalP });

      // Range-check fires only when receiver is finite.
      // isFinite(v) ⇔ v - v == 0 ⇔ v != NaN AND |v| != Infinity. We
      // detect non-finite via `v + (-v) != 0`: NaN gives NaN (≠ 0),
      // ±Infinity gives NaN (≠ 0). Equivalent to `!Number.isFinite(v)`.
      // Use the simpler `v == v` (false for NaN) followed by
      // `abs(v) != Infinity` — but Wasm has no abs/Infinity literal in
      // f64 const. Use the spec-equivalent `!isNaN(v) && v != ±Inf`:
      //   isFinite(v)  ≡  (v - v) == 0
      // The `i32.eqz` of that is "is non-finite".
      const isFiniteLocal = allocLocal(fctx, `__toPrecision_finite_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: recvLocalP });
      fctx.body.push({ op: "local.get", index: recvLocalP });
      fctx.body.push({ op: "f64.sub" });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" });
      fctx.body.push({ op: "local.set", index: isFiniteLocal });

      // RangeError gate: only when v is finite.
      fctx.body.push({ op: "local.get", index: isFiniteLocal });
      const rangeErrMsg = "RangeError: toPrecision() argument must be between 1 and 100";
      addStringConstantGlobal(ctx, rangeErrMsg);
      const tagIdx = ensureExnTag(ctx);
      const rangeCheckBody: Instr[] = [];
      // Build: if (p < 1 || p > 100 || p != p) throw RangeError
      rangeCheckBody.push({ op: "local.get", index: precLocal });
      rangeCheckBody.push({ op: "f64.const", value: 1 });
      rangeCheckBody.push({ op: "f64.lt" });
      rangeCheckBody.push({ op: "local.get", index: precLocal });
      rangeCheckBody.push({ op: "f64.const", value: 100 });
      rangeCheckBody.push({ op: "f64.gt" });
      rangeCheckBody.push({ op: "i32.or" });
      rangeCheckBody.push({ op: "local.get", index: precLocal });
      rangeCheckBody.push({ op: "local.get", index: precLocal });
      rangeCheckBody.push({ op: "f64.ne" });
      rangeCheckBody.push({ op: "i32.or" });
      rangeCheckBody.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
        else: [],
      });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: rangeCheckBody,
        else: [],
      });

      fctx.body.push({ op: "local.get", index: precLocal });
    } else {
      // No argument → push NaN sentinel; the `number_toPrecision` host runtime
      // recognises NaN as "no precision provided" and returns String(v).
      fctx.body.push({ op: "f64.const", value: NaN });
    }
    const funcIdx = ctx.funcMap.get("number_toPrecision");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
  }
  // number.toExponential(fractionDigits)
  if (isNumberMethodReceiver(ctx, receiverType) && propAccess.name.text === "toExponential") {
    // (#2160 number-wrapper) f64 receiver recovery (primitive or wrapper).
    emitNumberMethodReceiverF64(ctx, fctx, propAccess, receiverType);
    // (#3078) §21.1.3.3 step 2: an explicit `undefined` fractionDigits is
    // spec-equivalent to no argument → variable-precision exponential (as many
    // digits as needed), NOT ToIntegerOrInfinity(undefined)=0 (which gives
    // fixed 0 digits). undefined and NaN both compile to f64 NaN and are
    // indistinguishable at the value site — route the STATIC undefined literal
    // to the no-arg branch (NaN sentinel) at the AST level.
    // test262 toExponential/undefined-fractiondigits.js.
    if (expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
      // (#49) Spec §21.1.3.3 step 3: if x is non-finite, return
      // Number::toString(x) BEFORE the fractionDigits range check.
      // Save receiver, run range check only when x is finite. The
      // runtime helper `number_toExponential` short-circuits for
      // non-finite x; pre-check would fire for
      // `(NaN).toExponential(101)` which spec requires to return "NaN".
      const recvLocalE = allocLocal(fctx, `__toExponential_recv_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: recvLocalE });
      // ToNumber(fractionDigits) funnel — Symbol args must throw TypeError (#1564).
      coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
      const digitsLocal = allocLocal(fctx, `__toExponential_digits_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: digitsLocal });

      // (#1735) §21.1.3.3 step 5: f = ToIntegerOrInfinity(fractionDigits),
      // which maps NaN → 0. The `number_toExponential` runtime helper reads
      // NaN as its "no argument supplied" sentinel (see else-branch below),
      // so an *explicit* NaN argument — e.g. `(1).toExponential(NaN)` or
      // `(1).toExponential(0/0)` — must be normalised to 0 here, otherwise it
      // collides with the sentinel and is wrongly treated as no-arg (variable
      // digits) instead of 0 digits. Spec: explicit NaN → 0 → "Ne+E"; genuine
      // no-arg → variable digits. test262
      // Number/prototype/toExponential/tointeger-fractiondigits.js.
      normalizeNaNToZero(fctx, digitsLocal);

      // Re-push receiver for the runtime call.
      fctx.body.push({ op: "local.get", index: recvLocalE });

      // isFinite(v): (v - v) == 0 (NaN/Infinity give NaN ≠ 0).
      const isFiniteLocal = allocLocal(fctx, `__toExponential_finite_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: recvLocalE });
      fctx.body.push({ op: "local.get", index: recvLocalE });
      fctx.body.push({ op: "f64.sub" });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.eq" });
      fctx.body.push({ op: "local.set", index: isFiniteLocal });

      // Range check gate: only when v is finite.
      const rangeErrMsg = "RangeError: toExponential() argument must be between 0 and 100";
      addStringConstantGlobal(ctx, rangeErrMsg);
      const tagIdx = ensureExnTag(ctx);
      const rangeCheckBody: Instr[] = [];
      rangeCheckBody.push({ op: "local.get", index: digitsLocal });
      rangeCheckBody.push({ op: "f64.const", value: 0 });
      rangeCheckBody.push({ op: "f64.lt" });
      rangeCheckBody.push({ op: "local.get", index: digitsLocal });
      rangeCheckBody.push({ op: "f64.const", value: 100 });
      rangeCheckBody.push({ op: "f64.gt" });
      rangeCheckBody.push({ op: "i32.or" });
      rangeCheckBody.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
        else: [],
      });
      fctx.body.push({ op: "local.get", index: isFiniteLocal });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: rangeCheckBody,
        else: [],
      });

      fctx.body.push({ op: "local.get", index: digitsLocal });
    } else {
      // No argument → pass NaN as sentinel for "no argument provided"
      fctx.body.push({ op: "f64.const", value: NaN });
    }
    const funcIdx = ctx.funcMap.get("number_toExponential");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
  }

  // (#2576, extends #2187) Runtime-guarded native string method on an
  // `any`/unknown receiver whose value MAY be a native `$AnyString` at runtime
  // but whose receiver is an opaque externref (object property value, generator
  // yield read, indexed element read, …) — i.e. the value-rep cases that
  // #2187's static `receiverIsNativeStringValType` (bare-identifier-with-
  // string-ref-local) cannot recognise. A runtime `ref.test $AnyString` keeps a
  // non-string `any` (array, number, null) on its benign default. Scoped to a
  // known STRING_METHODS name (+`charCodeAt`/`substr`, which have dedicated
  // native arms but are not in the table), native-string mode, and an
  // `any`/unknown receiver NOT already handled by the static string arms below.
  // (#3673) `substr` is Annex-B and deliberately absent from `STRING_METHODS`
  // (that table doubles as the JS-host `string_<method>` import manifest), but
  // `compileNativeStringMethodCall` HAS a native `__str_substr` arm. Without
  // this name in the gate, a dynamic `obj.field.substr(a, b)` fell through to
  // the generic `__extern_method_call` ladder, whose string-brand arm returns
  // undefined ⇒ the empty string standalone. That is exactly how compiled
  // acorn's octal-escape reader (`this.input.substr(this.pos - 1, 3)`) got ""
  // and then threw on `.match(/^[0-7]+/)[0]`.
  if (
    ctx.nativeStrings &&
    ctx.nativeStrTypeIdx >= 0 &&
    (Object.prototype.hasOwnProperty.call(STRING_METHODS, propAccess.name.text) ||
      propAccess.name.text === "charCodeAt" ||
      propAccess.name.text === "substr") &&
    !isStringType(receiverType) &&
    !receiverIsCaughtErrorStringRead(ctx, propAccess.expression) &&
    !receiverIsNativeStringValType(ctx, fctx, propAccess.expression) &&
    !(propAccess.name.text === "substring" && sourceHasMethodReassignment(ctx, propAccess.expression, "substring")) &&
    receiverMayBeNativeStringAtRuntime(ctx, propAccess.expression)
  ) {
    const guarded = compileGuardedNativeStringMethodCall(ctx, fctx, expr, propAccess, propAccess.name.text);
    if (guarded !== null) return guarded;
    // Fall through to the generic dispatch on a build failure.
  }

  // String method calls
  // (#2192 follow-up) Also fire for a caught-Error string-field read receiver
  // (`e.message.charCodeAt(0)`, `e.name.slice(...)`) whose static type is `any`
  // but which lowers to a native-string ref in standalone mode — the
  // isStringType gate alone misses it, so the call fell through to the host
  // `__extern_get`/dynamic path (null standalone). compileNativeStringMethodCall
  // compiles + flattens the receiver, which already yields a $AnyString ref.
  if (
    (isStringType(receiverType) ||
      receiverIsCaughtErrorStringRead(ctx, propAccess.expression) ||
      receiverIsNativeStringValType(ctx, fctx, propAccess.expression)) &&
    !declinesToOwnOrInheritedSlot(ctx, receiverType, propAccess.name.text)
  ) {
    const method = propAccess.name.text;

    const derivedSubstringChar = tryCompileDerivedHostSubstringCharCodeAt(ctx, fctx, expr, propAccess, method);
    if (derivedSubstringChar) return derivedSubstringChar;

    const hostPrefixSuffix = tryCompileHostStringPredicate(
      ctx,
      fctx,
      expr,
      propAccess,
      method,
      !isStringWrapperType(receiverType) && !sourceHasMethodReassignment(ctx, propAccess.expression, method),
    );
    if (hostPrefixSuffix) return hostPrefixSuffix;

    // string.toString() and string.valueOf() — identity, just return the string itself.
    // (#1397) Skip the identity short-circuit when the receiver is a String
    // wrapper object (`new String(...)`) AND the source has a reassignment
    // of the form `<id>.toString = ...` / `.valueOf = ...`. For wrappers
    // the .toString / .valueOf property is reassignable, and the identity
    // short-circuit silently ignores the override; the runtime spec
    // requires dispatch through the actual property. Primitive strings
    // can't have own properties, so the short-circuit stays correct.
    if (method === "toString" || method === "valueOf") {
      const skipForReassignment =
        isStringWrapperType(receiverType) && sourceHasMethodReassignment(ctx, propAccess.expression, method);
      if (!skipForReassignment) {
        return compileExpression(ctx, fctx, propAccess.expression);
      }
      // Fall through — let the generic externref method-call path at the
      // bottom of compileMethodCall handle dynamic dispatch.
    }

    // Fast mode: native string method dispatch
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      // (#2160 wrapper-strmethod) A String WRAPPER receiver (`new String(x)`)
      // reaches here because `isStringType` deliberately also matches the
      // wrapper Object type (for primitive-string method dispatch — see the
      // cs-2160 `resolveWasmType` note). But the wrapper lowers to a `$Object`
      // externref, NOT a native string ref, so the default receiver emitter
      // (`compileExpression(propAccess.expression)` → `__str_flatten`'s
      // `ref.cast $NativeString`) traps at runtime with "illegal cast" /
      // "null pointer" for every String.prototype method (`charAt`, `slice`,
      // `indexOf`, `toUpperCase`, …). The wrapper `.valueOf()`/`.toString()`
      // slice (cs-2160) already recovers the internal `[[PrimitiveValue]]` slot
      // via the native `__to_primitive` engine helper; reuse the SAME helper
      // here as the receiver so the method dispatches against the wrapped
      // primitive string. Gated on `ctx.standalone` (the native object-runtime
      // / `__to_primitive` machinery is standalone-only — WASI keeps the host
      // object path). No new coercion site: `__to_primitive` is the existing
      // §7.1.1.1 engine helper.
      if (ctx.standalone && isStringWrapperType(receiverType) && method !== "toString" && method !== "valueOf") {
        ensureObjectRuntime(ctx);
        const toPrimIdx = ctx.funcMap.get("__to_primitive");
        if (toPrimIdx !== undefined && ctx.anyStrTypeIdx >= 0) {
          const wrapperReceiverOverride = (): ValType => {
            // wrapper externref → __to_primitive(hint "string") → externref
            // (the internal slot IS a native string) → back to `ref $AnyString`.
            compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
            addStringConstantGlobal(ctx, "string");
            fctx.body.push(...stringConstantExternrefInstrs(ctx, "string"));
            fctx.body.push({ op: "call", funcIdx: toPrimIdx });
            fctx.body.push({ op: "any.convert_extern" });
            fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
            return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
          };
          return compileNativeStringMethodCall(ctx, fctx, expr, propAccess, method, wrapperReceiverOverride);
        }
      }
      return compileNativeStringMethodCall(ctx, fctx, expr, propAccess, method);
    }

    // charCodeAt: uses wasm:js-string charCodeAt import (not string_charCodeAt)
    // Use jsStringImports to avoid shadowing by user-defined functions (#1072).
    if (method === "charCodeAt") {
      // #2003 — the wasm:js-string `charCodeAt` builtin TRAPS on an
      // out-of-range index, but §22.1.3.3 requires `NaN` for any index
      // `< 0` or `>= length`. Emit a bounds guard around the builtin and
      // return f64 so the NaN case is representable:
      //   idx = ToInteger(arg); len = s.length
      //   (idx >= 0 && idx < len) ? f64(charCodeAt(s, idx)) : NaN
      const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
      const lengthIdx = ctx.jsStringImports.get("length");
      if (charCodeAtIdx !== undefined && lengthIdx !== undefined) {
        // Save receiver to a temp so we can read both its length and its char.
        compileExpression(ctx, fctx, propAccess.expression);
        const recvLocal = allocLocal(fctx, `__cca_recv_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: recvLocal });
        // Compute the (truncated) index into an i32 temp.
        if (expr.arguments.length > 0) {
          const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
          if (!argType) {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (argType.kind === "f64") {
            fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          }
        } else {
          fctx.body.push({ op: "i32.const", value: 0 });
        }
        // (the receiver pushed by local.tee is still on the stack below idx;
        //  drop it — we re-load from the temp inside each branch.)
        const idxLocal = allocLocal(fctx, `__cca_idx_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.set", index: idxLocal });
        fctx.body.push({ op: "drop" }); // drop the receiver left by local.tee
        // Bounds test: (idx >= 0) & (idx < len)
        fctx.body.push({ op: "local.get", index: idxLocal });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.ge_s" });
        fctx.body.push({ op: "local.get", index: idxLocal });
        fctx.body.push({ op: "local.get", index: recvLocal });
        fctx.body.push({ op: "call", funcIdx: lengthIdx });
        fctx.body.push({ op: "i32.lt_s" });
        fctx.body.push({ op: "i32.and" });
        // then: f64(charCodeAt(recv, idx)) ; else: NaN
        const thenInstrs: Instr[] = [
          { op: "local.get", index: recvLocal },
          { op: "local.get", index: idxLocal },
          { op: "call", funcIdx: charCodeAtIdx },
          { op: "f64.convert_i32_u" },
        ];
        const elseInstrs: Instr[] = [{ op: "f64.const", value: Number.NaN }];
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: thenInstrs,
          else: elseInstrs,
        });
        return { kind: "f64" };
      }
    }

    const importName = `string_${method}`;
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      // #1445 — ECMA-262 §7.1.4 ToNumber throws TypeError on BigInt /
      // Symbol arguments. String.prototype methods feed certain args
      // through ToInteger / ToLength (which call ToNumber). For those
      // arg positions, emit a static TypeError throw when the arg's
      // static TS type is `bigint` or `symbol`.
      //
      // Map: method → set of arg indices that are ToInteger-coerced.
      const TO_INTEGER_ARG_INDICES: Record<string, ReadonlyArray<number>> = {
        charAt: [0],
        charCodeAt: [0],
        codePointAt: [0],
        at: [0],
        substring: [0, 1],
        slice: [0, 1],
        substr: [0, 1],
        indexOf: [1],
        lastIndexOf: [1],
        includes: [1],
        startsWith: [1],
        endsWith: [1],
        padStart: [0],
        padEnd: [0],
        repeat: [0],
      };
      const integerArgs = TO_INTEGER_ARG_INDICES[method];
      if (integerArgs) {
        for (const idx of integerArgs) {
          const arg = expr.arguments[idx];
          if (!arg) continue;
          let argTsType: ts.Type | undefined;
          try {
            argTsType = ctx.checker.getTypeAtLocation(arg);
          } catch {
            continue;
          }
          if (!argTsType) continue;
          const isBig = isBigIntType(argTsType);
          const isSym = isSymbolType(argTsType);
          if (!isBig && !isSym) continue;
          const msg = isBig
            ? "TypeError: Cannot convert a BigInt value to a number"
            : "TypeError: Cannot convert a Symbol value to a number";
          addStringConstantGlobal(ctx, msg);
          const strIdx = ctx.stringGlobalMap.get(msg)!;
          // #1473 — no JS host: throw a TypeError INSTANCE via the in-module
          // constructor (no `__throw_type_error` host import).
          if (usesNativeJsErrors(ctx)) {
            emitThrowTypeError(ctx, fctx, msg);
            fctx.body.push({ op: "unreachable" });
          } else {
            const throwIdx = ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
            if (throwIdx !== undefined) {
              flushLateImportShifts(ctx, fctx);
              const throwFuncIdx = ctx.funcMap.get("__throw_type_error")!;
              fctx.body.push({ op: "global.get", index: strIdx });
              fctx.body.push({ op: "call", funcIdx: throwFuncIdx });
              fctx.body.push({ op: "unreachable" });
            } else {
              const tagIdx = ensureExnTag(ctx);
              fctx.body.push({ op: "global.get", index: strIdx });
              fctx.body.push({ op: "throw", tagIdx });
            }
          }
          // After unreachable / throw, the wasm stack is polymorphic.
          // Push a sentinel matching the method's return type so any
          // downstream consumer (the implicit drop / coercion in the
          // statement context) still validates cleanly.
          const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
          const returnsNum =
            method === "indexOf" || method === "lastIndexOf" || method === "codePointAt" || method === "search";
          if (returnsBool) {
            fctx.body.push({ op: "i32.const", value: 0 });
            return { kind: "i32" };
          }
          if (returnsNum) {
            fctx.body.push({ op: "f64.const", value: 0 });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
      // #1248: substring/slice with a single argument default the missing
      // `end` to `s.length`, NOT 0. Without this, the generic padding loop
      // below pushes f64.const 0, and the host import calls
      // `s.substring(start, 0)` — which JS spec swaps to `substring(0, start)`,
      // returning the wrong prefix instead of the suffix from `start`.
      // Save the receiver into a temp local so we can re-compute its length
      // when padding the missing `end` arg.
      const args = expr.arguments;
      const paramTypes = getFuncParamTypes(ctx, funcIdx);
      // #1248 + no-arg: substring/slice with a missing `end` (0 OR 1 args)
      // default `end` to `s.length` per §22.1.3.24 (substring: end ?? len) /
      // §22.1.3.21 (slice: ToIntegerOrInfinity(end ?? len)). With only the
      // single-arg case handled, `s.substring()` / `s.slice()` padded BOTH
      // start and end to 0 → host called `s.substring(0, 0)` → "" instead of
      // the whole string. The pad loop's `pi === 2` branch supplies s.length
      // for the missing end; the missing start (pi === 1) correctly pads to 0.
      // (#2124) An explicit `undefined` end arg is spec-equivalent to absent:
      // substring/slice default `end` to `s.length`. Without this, the f64
      // slot coerces `undefined` → NaN and the host runs `substring(1, NaN)`
      // → wrong length. Detect a statically-undefined end so the same
      // length-default path that handles a missing end fires.
      const isStaticUndefinedExpr = (a: ts.Expression | undefined): boolean => {
        if (a === undefined) return false;
        let cur: ts.Expression = a;
        while (
          ts.isParenthesizedExpression(cur) ||
          ts.isAsExpression(cur) ||
          ts.isNonNullExpression(cur) ||
          ts.isTypeAssertionExpression(cur)
        ) {
          cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion)
            .expression;
        }
        return (
          (ts.isIdentifier(cur) && cur.text === "undefined") ||
          (ts.isVoidExpression(cur) && ts.isNumericLiteral(cur.expression))
        );
      };
      const substringEndUndefined =
        (method === "substring" || method === "slice") && args.length === 2 && isStaticUndefinedExpr(args[1]);
      const needsLengthDefault =
        (method === "substring" || method === "slice") &&
        (args.length <= 1 || substringEndUndefined) &&
        paramTypes !== undefined &&
        paramTypes.length === 3;
      let savedReceiverLocal: number | undefined;
      if (needsLengthDefault) {
        // Ensure wasm:js-string.length is registered so we can compute s.length below.
        addStringImports(ctx);
        // Compile receiver, save to temp, leave on stack for the call.
        compileExpression(ctx, fctx, propAccess.expression);
        savedReceiverLocal = allocLocal(fctx, `__substr_recv_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: savedReceiverLocal });
      } else {
        compileExpression(ctx, fctx, propAccess.expression);
      }
      // Cap at declared param count (excluding self) to avoid pushing extra values
      const userParamCount = paramTypes ? paramTypes.length - 1 : args.length;
      for (let ai = 0; ai < args.length; ai++) {
        if (substringEndUndefined && ai === 1 && savedReceiverLocal !== undefined) {
          // Explicit `undefined` end → s.length (#2124). Skip compiling the
          // undefined arg; emit the receiver's length for the f64 end slot.
          const lenIdx = ctx.jsStringImports.get("length");
          if (lenIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: savedReceiverLocal });
            fctx.body.push({ op: "call", funcIdx: lenIdx });
            fctx.body.push({ op: "f64.convert_i32_u" });
          } else {
            fctx.body.push({ op: "f64.const", value: 0x7fffffff });
          }
          continue;
        }
        if (method === "indexOf" && ai === 0 && tryCompileIndexOfHoistedUndefinedSearch(ctx, fctx, args[ai]!)) continue;
        if (ai < userParamCount) {
          const expectedArgType = paramTypes?.[ai + 1]; // +1 for self param
          const argResult = compileExpression(ctx, fctx, args[ai]!, expectedArgType);
          if (!argResult) {
            // void/null result — push a default value for the expected type
            pushDefaultValue(fctx, expectedArgType ?? { kind: "f64" }, ctx);
          } else if (expectedArgType && argResult.kind !== expectedArgType.kind) {
            coerceType(ctx, fctx, argResult, expectedArgType);
          }
        } else {
          // Extra argument beyond function's parameter count — evaluate for
          // side effects and drop the result
          const extraType = compileExpression(ctx, fctx, args[ai]!);
          if (extraType !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      // Pad missing optional args with defaults (e.g. indexOf 2nd arg)
      if (paramTypes && args.length + 1 < paramTypes.length) {
        // #1381 — `endsWith`/`startsWith`/`includes`/`lastIndexOf` distinguish
        // null vs undefined for the position arg (endsWith(s) ⇒ pos defaults
        // to length, but endsWith(s, null) ⇒ ToInteger(null)=0 ⇒ "" check).
        // Pad missing externref position args with JS undefined (via
        // `__get_undefined`) so the host sees the spec-correct "not passed"
        // value instead of `null`.
        // #1740 — padStart/padEnd: an OMITTED fillString must default to a
        // single space " " (§22.1.3.17 StringPad: if fillString is
        // undefined, set it to " "). Padding the missing externref arg with
        // `ref.null.extern` makes the host see JS `null`, which ToString-
        // coerces to "null" → e.g. `"abc".padStart(6)` returned "nulabc"
        // instead of "   abc". Pass JS `undefined` so the host applies the
        // spec default. (Same null-vs-undefined distinction as endsWith.)
        const padsUndefined =
          method === "endsWith" || method === "lastIndexOf" || method === "padStart" || method === "padEnd";
        let undefIdx: number | undefined;
        if (padsUndefined) {
          undefIdx = ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
        }
        for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
          const pt = paramTypes[pi]!;
          if (needsLengthDefault && pi === 2 && savedReceiverLocal !== undefined && pt.kind === "f64") {
            // #1248: For substring/slice missing-end, push s.length instead of 0.
            const lenIdx = ctx.jsStringImports.get("length");
            if (lenIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: savedReceiverLocal });
              fctx.body.push({ op: "call", funcIdx: lenIdx });
              fctx.body.push({ op: "f64.convert_i32_u" });
            } else {
              // Fallback if length import is unavailable for some reason
              fctx.body.push({ op: "f64.const", value: 0x7fffffff });
            }
          } else if (pt.kind === "externref") {
            if (padsUndefined && undefIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: undefIdx });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else if (pt.kind === "f64") {
            // #3761 — `split` uses -1 for omission so explicit NaN still
            // reaches host ToUint32(NaN) === 0.
            // #2002 — includes/startsWith/endsWith likewise use NaN for an
            // omitted position so the host shim drops it and the JS method
            // applies its spec default (0 for includes/startsWith, length
            // for endsWith) instead of ToInteger(NaN)=0.
            if (method === "split" || method === "includes" || method === "startsWith" || method === "endsWith") {
              const sentinel = method === "split" ? -1 : Number.NaN;
              fctx.body.push({ op: "f64.const", value: sentinel });
            } else {
              fctx.body.push({ op: "f64.const", value: 0 });
            }
          } else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
        }
      }
      fctx.body.push({ op: "call", funcIdx });
      const returnsBool = method === "includes" || method === "startsWith" || method === "endsWith";
      const returnsNum =
        method === "indexOf" || method === "lastIndexOf" || method === "codePointAt" || method === "search";
      return returnsBool ? { kind: "i32" } : returnsNum ? { kind: "f64" } : { kind: "externref" };
    }
  }

  // Boolean method calls: bool.toString(), bool.valueOf()
  if (isBooleanType(receiverType)) {
    const method = propAccess.name.text;
    if (method === "toString") {
      compileExpression(ctx, fctx, propAccess.expression);
      return emitBoolToString(ctx, fctx);
    }
    if (method === "valueOf") {
      // Boolean.valueOf() returns the boolean primitive — just compile the expression
      return compileExpression(ctx, fctx, propAccess.expression);
    }
  }

  // number.valueOf() — return the number itself
  if (isNumberType(receiverType) && propAccess.name.text === "valueOf") {
    return compileExpression(ctx, fctx, propAccess.expression);
  }

  // Fallback .toLocaleString() — delegates to the JS host so that
  // Array/TypedArray/wrapped-object instances return the real
  // locale-formatted string and — critically for test262 — any abrupt
  // completion from the element's patched toLocaleString/valueOf
  // propagates as a real JS exception instead of being silently dropped.
  // Without this path, sample.toLocaleString() on a TypedArray hits the
  // graceful null-extern fallback and the test fails with "null/undefined
  // access" instead of reaching the expected throw.
  if (propAccess.name.text === "toLocaleString" && expr.arguments.length === 0) {
    // (#2863 Phase 2) Standalone/WASI have no host `__extern_toLocaleString`
    // (it's a dynamic-shape refusal — a host-only import with no native
    // carrier). Without ECMA-402 the spec default
    // `Object.prototype.toLocaleString` (§20.1.3.5) just calls the receiver's
    // `toString`, and `Array.prototype.toLocaleString` (§23.1.3.32) joins the
    // per-element `toLocaleString` results — both collapse to the same comma-
    // join as `toString` in a locale-independent runtime. Route to the NATIVE
    // `__extern_toString` (registered host-free under standalone via #1866),
    // which removes the CE while matching the locale-independent value. Host
    // (gc) mode keeps `__extern_toLocaleString` for real Intl grouping.
    const toLSName = ctx.standalone || ctx.wasi ? "__extern_toString" : "__extern_toLocaleString";
    const toLSIdx = ensureLateImport(ctx, toLSName, [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (toLSIdx !== undefined) {
      const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
      if (recvType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (recvType.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
      fctx.body.push({ op: "call", funcIdx: toLSIdx });
      return { kind: "externref" };
    }
  }

  // Fallback .toString() for any type not already handled above
  // Handles: function.toString(), object.toString(), array.toString(), class instance.toString()
  if (
    propAccess.name.text === "toString" &&
    expr.arguments.length === 0 &&
    // (#4482) …unless the program installed its OWN `toString` on THIS
    // binding. Everything below answers `Object.prototype.toString` /
    // `<Builtin>.prototype.toString` from the receiver's static type, which is
    // right only while no own slot shadows it. §15.7.4.2 requires
    // `Object.defineProperty(d, "toString", {value: Number.prototype.toString});
    // d.toString()` on a Date to run the TRANSFERRED intrinsic and throw a
    // real `TypeError`. Declining routes it to the stored-member closure arm,
    // whose brand preamble does that (the expando-named half of the same rows,
    // `d.myToString = …`, already threw before this change).
    // Receiver-precise (`sourceOverridesMethodOnReceiver`): a module that does not
    // override `toString` on this binding compiles byte-identically. (#4482: `ctx`
    // widens "this binding" to a `new A(…)` binding whose ctor installs the slot.)
    !(ctx.standalone && sourceOverridesMethodOnReceiver(propAccess.expression, "toString", ctx))
  ) {
    // #1463 — `someFn.toString()` where `someFn` is a top-level function
    // declaration → return the captured source text directly. Must happen
    // BEFORE the externref-routes-to-JS fallback below: top-level functions
    // resolve to externref at the type system level, so the default path
    // would call `__extern_toString` on a Wasm closure (which JS doesn't
    // know how to stringify) and the spec text would be lost.
    if (ts.isIdentifier(propAccess.expression)) {
      const captured = ctx.funcSourceText.get(propAccess.expression.text);
      if (captured) {
        // (#2515 S0) sentinel-safe materialization (standalone bakes `-1`).
        addStringConstantGlobal(ctx, captured);
        fctx.body.push(...stringConstantExternrefInstrs(ctx, captured));
        return { kind: "externref" };
      }
    }
    const tsType = ctx.checker.getTypeAtLocation(propAccess.expression);
    const wasm = resolveWasmType(ctx, tsType);

    // For externref values (e.g. RegExp.exec result, host objects), delegate to JS toString
    if (wasm.kind === "externref") {
      const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (toStrIdx !== undefined) {
        // (#2934 2b) The STATIC type says externref, but the receiver can
        // COMPILE to a concrete ref — e.g. `regObj.exec(str).toString()`
        // standalone lowers exec natively to a capture-array vec `(ref null
        // $Vec)`. Feeding that raw ref to `__extern_toString(externref)` is
        // invalid Wasm (`call[0] expected externref, found (ref null …)`).
        // Coerce the COMPILED type, mirroring the #2934 2a receiver fix in
        // compilePropertyIntrospection (object-ops.ts).
        const recvType = compileExpression(ctx, fctx, propAccess.expression);
        if (recvType && recvType.kind !== "externref" && recvType.kind !== "ref_extern") {
          coerceType(ctx, fctx, recvType, { kind: "externref" });
        }
        fctx.body.push({ op: "call", funcIdx: toStrIdx });
        return { kind: "externref" };
      }
    }

    const exprType = compileExpression(ctx, fctx, propAccess.expression);
    if (exprType) {
      // If the compiled expression produced an externref, try JS toString
      if (exprType.kind === "externref") {
        const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (toStrIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: toStrIdx });
          return { kind: "externref" };
        }
      }
      fctx.body.push({ op: "drop" });
    }
    // Check if it's an array type (ref to vec struct)
    let isArray = false;
    if (wasm.kind === "ref" || wasm.kind === "ref_null") {
      const arrInfo = resolveArrayInfo(ctx, tsType);
      if (arrInfo) isArray = true;
    }
    // Check if this is a function type (has call signatures, is not a class/interface)
    const callSigs = tsType.getCallSignatures?.();
    const isFunc = callSigs && callSigs.length > 0 && !tsType.getProperties?.()?.length;

    if (isFunc) {
      // #1463 — return captured source text when the receiver is an
      // identifier resolving to a known top-level function declaration.
      // Falls back to the legacy placeholder for arrow functions, method
      // references, or any receiver we can't resolve statically.
      let toStrStr = "function () { [native code] }";
      if (ts.isIdentifier(propAccess.expression)) {
        const captured = ctx.funcSourceText.get(propAccess.expression.text);
        if (captured) toStrStr = captured;
      }
      // (#2515 S0) sentinel-safe — standalone stores `-1` for the string
      // constant, so materialize inline rather than baking `global.get -1`.
      addStringConstantGlobal(ctx, toStrStr);
      fctx.body.push(...stringConstantExternrefInstrs(ctx, toStrStr));
    } else {
      const str = isArray ? "[object Array]" : "[object Object]";
      addStringConstantGlobal(ctx, str);
      fctx.body.push(...stringConstantExternrefInstrs(ctx, str));
    }
    return { kind: "externref" };
  }

  const valueOfFallback = tryEmitValueOfFallback(ctx, fctx, expr, propAccess);
  if (valueOfFallback !== undefined) return valueOfFallback;

  const lateFnctorCall = tryCompileLateFnctorPrototypeMethodCall(ctx, fctx, expr, propAccess);
  if (lateFnctorCall !== undefined) return lateFnctorCall;

  // Generic dynamic fallback; the native tail reuses this receiver resolution.
  const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
  // A mixed mutable local's physical carrier outranks its stale checker type.
  const recvWasm = effectiveLocalCarrier(fctx, propAccess.expression, resolveWasmType(ctx, recvTsType));
  if (
    process.env.DEBUG_MARKED_CODEGEN === "1" &&
    fctx.name.includes("closure") &&
    propAccess.name.text === "preprocess"
  ) {
    console.error(
      "[marked-preprocess-fallback]",
      fctx.name,
      propAccess.expression.getText?.(),
      "flags",
      recvTsType.flags,
      "symbol",
      recvTsType.getSymbol?.()?.name,
      "wasm",
      recvWasm,
      "fieldShadow",
      [...ctx.structFields.entries()].some(
        ([structName, fields]) =>
          fields.some((field) => field.name === "preprocess" && field.type.kind === "externref") &&
          ctx.funcMap.has(classMemberFuncKey(ctx, `${structName}_preprocess`, "instance")),
      ),
    );
  }
  {
    const isAnyOrExternref = (recvTsType.flags & ts.TypeFlags.Any) !== 0 || recvWasm.kind === "externref";

    if (isAnyOrExternref) {
      const methodName = propAccess.name.text;
      const nativeResult = tryCompileNativeGeneratorMethodCall(
        ctx,
        fctx,
        propAccess.expression,
        methodName,
        expr.arguments,
      );
      if (nativeResult !== undefined) return nativeResult;

      // Generator protocol: .next(), .return(value), .throw(error) on any/externref
      // These are very common in test262 generator tests where variables are typed as `any`.
      if (methodName === "next") {
        // (#2865) An any-typed receiver may hold a DRIVEN async-gen frame
        // (`var f; f = async function*(){…}; f().next()` — the dominant
        // test262 shape). Runtime ref.test-dispatch to the per-gen driver;
        // the miss arm preserves this site's original `__gen_next` behavior
        // (see tryEmitAsyncGenNextDispatch). Zero-arg only.
        if (expr.arguments.length === 0) {
          const dispatched = tryEmitAsyncGenNextDispatch(ctx, fctx, propAccess.expression);
          if (dispatched !== null) return dispatched;
        }
        const genNextIdx = ctx.funcMap.get("__gen_next");
        if (genNextIdx !== undefined) {
          compileExpression(ctx, fctx, propAccess.expression, {
            kind: "externref",
          });
          // Drop any arguments (generator .next() with args not yet supported)
          for (const arg of expr.arguments) {
            const argType = compileExpression(ctx, fctx, arg);
            if (argType) {
              fctx.body.push({ op: "drop" });
            }
          }
          fctx.body.push({ op: "call", funcIdx: genNextIdx });
          return { kind: "externref" };
        }
      }
      if (methodName === "return") {
        const genReturnIdx = ctx.funcMap.get("__gen_return");
        if (genReturnIdx !== undefined) {
          compileExpression(ctx, fctx, propAccess.expression, {
            kind: "externref",
          });
          if (expr.arguments.length > 0) {
            compileExpression(ctx, fctx, expr.arguments[0]!, {
              kind: "externref",
            });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx: genReturnIdx });
          return { kind: "externref" };
        }
      }
      if (methodName === "throw") {
        const genThrowIdx = ctx.funcMap.get("__gen_throw");
        if (genThrowIdx !== undefined) {
          compileExpression(ctx, fctx, propAccess.expression, {
            kind: "externref",
          });
          if (expr.arguments.length > 0) {
            compileExpression(ctx, fctx, expr.arguments[0]!, {
              kind: "externref",
            });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "call", funcIdx: genThrowIdx });
          return { kind: "externref" };
        }
      }

      // Try to resolve via registered extern classes (e.g. Set.union, Map.get)
      // when the receiver type is `any` but the method matches a built-in.
      {
        const builtinNamespace = ctx.standalone
          ? resolveBuiltinNamespaceValueName(ctx, propAccess.expression)
          : undefined;
        const preferOpenBuiltinNamespace =
          builtinNamespace !== undefined && isSupportedBuiltinStaticProperty(builtinNamespace, methodName);
        if (!preferOpenBuiltinNamespace) {
          const externResult = tryExternClassMethodOnAny(ctx, fctx, expr, propAccess, methodName);
          if (externResult !== null) return externResult;
        }
      }

      // An any/externref receiver can be a closed object literal whose own
      // callable field shadows a same-spelled class method. The closed method
      // dispatcher cannot know which instance field is populated and would
      // claim the prototype arm first (Marked's hooks use this shape). Keep
      // this host-only and narrow it to names for which both a callable field
      // and a compiled instance method exist; the normal host object bridge
      // performs the live JavaScript property lookup.
      if (!ctx.standalone && !ctx.wasi) {
        // A closed object literal may store a callable in an externref field
        // even when the checker reports `any` at this call site.  Prefer the
        // host's live property lookup for those fields.  Do not use the
        // syntactic fact that the receiver is a property access as a signal:
        // Marked's `this.tokenizer.space()` has the same `any` checker type,
        // but `space` is a compiled class method and must stay on the closed
        // Wasm dispatcher.  The field table is the semantic distinction.
        const hasCallableField = [...ctx.structFields.values()].some((fields) =>
          fields.some((field) => field.name === methodName && field.type.kind === "externref"),
        );
        const receiverPropertySymbol = ts.isPropertyAccessExpression(propAccess.expression)
          ? ctx.checker.getSymbolAtLocation(propAccess.expression.name)
          : undefined;
        // A declared class property (for example `this.tokenizer`) still has
        // a concrete Wasm owner even when allowJs reports `any`; let the
        // closed dispatcher resolve its methods.  An unknown owner (`i.hooks`)
        // or a local object literal is genuinely late-bound and needs the
        // host's live callable-field lookup.
        const receiverOwnerIsUnknown =
          !ts.isPropertyAccessExpression(propAccess.expression) || receiverPropertySymbol === undefined;
        if (hasCallableField && receiverOwnerIsUnknown) {
          if (process.env.DEBUG_MARKED_CODEGEN === "1") {
            console.error(
              "[marked-callable-field-fallback]",
              fctx.name,
              methodName,
              propAccess.expression.getText?.(),
              [...ctx.structFields.entries()]
                .filter(([, fields]) =>
                  fields.some((field) => field.name === methodName && field.type.kind === "externref"),
                )
                .map(([name]) => name),
            );
          }
          const dynamicFieldCall = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, methodName, expr);
          if (process.env.DEBUG_MARKED_CODEGEN === "1") {
            console.error("[marked-callable-field-result]", fctx.name, methodName, dynamicFieldCall);
          }
          if (dynamicFieldCall !== null) return dynamicFieldCall;
        }
      }

      // (#2151) Standalone/WASI closed-struct method dispatch. An object
      // literal `{ m(){…} }` is a CLOSED nominal WasmGC struct; the generic
      // __extern_method_call below only handles the OPEN $Object receiver
      // (ref.test $Object), so `o.m()` on a closed struct returns null/0 and
      // never invokes the method (standalone analog of the JS-host #2015 bug).
      // Route 0-arg any-receiver calls through a reserved per-name dispatcher
      // `__call_m_<name>` that type-switches over every closed struct having
      // `<Struct>_<name>` (threading the struct as `this`) and falls through to
      // __extern_method_call for the open-$Object case. Reserve-then-fill
      // (#1719): the body is built at finalize once all structs are known.
      // Slice 1: zero-arg only (covers next()/getx()/iterator protocol); calls
      // with arguments keep the existing generic path below.
      const recvIsBuiltinClass =
        ts.isIdentifier(propAccess.expression) && BUILTIN_CLASS_NAMES.has(propAccess.expression.text);
      // (#2151 Slice 2) N-ary: the dispatcher is arity-specialized
      // `__call_m_<name>_<arity>(recv, arg0..arg{arity-1})` (all externref).
      // (#2151 Slice 3) Spread of an ARRAY LITERAL (`o.m(...[2,3])`) flattens
      // to a fixed argument list at compile time, so it can use the same
      // arity-specialized dispatcher. A spread of a DYNAMIC source
      // (`o.m(...xs)`) has no statically-known arity → flattenCallArgs returns
      // null and it falls through to the generic path.
      const hasSpreadArg = expr.arguments.some((a) => ts.isSpreadElement(a));
      const dispatchArgs: ts.Expression[] | null = hasSpreadArg ? flattenCallArgs(expr.arguments) : [...expr.arguments];
      const hasKnownUserClassMethod = [...ctx.classSet].some((className) => {
        const fullName = `${className}_${methodName}`;
        // The closed dispatcher carries an instance receiver as its first
        // argument. Static class methods have no such slot and must stay on
        // the class-object/host bridge (otherwise `anyClass.staticMethod()`
        // passes the constructor as the first user argument). Only instance
        // members can be safely represented by this dispatcher.
        return (
          ctx.classMethodSet.has(fullName) &&
          (ctx.funcMap.has(classMemberFuncKey(ctx, fullName, "instance")) || ctx.funcMap.has(fullName))
        );
      });
      const userMethodArities: number[] = [];
      const userMethodFuncsByCarrierShape = new Map<string, Set<number>>();
      const seenUserMethodCarriers = new Set<string>();
      let hasUserRestMethod = false;
      for (const [rawStructName] of ctx.structFields) {
        const structName = ctx.classExprNameMap.get(rawStructName) ?? rawStructName;
        if (seenUserMethodCarriers.has(structName)) continue;
        seenUserMethodCarriers.add(structName);
        const fullName = `${structName}_${methodName}`;
        // Static-only members share the class object's struct carrier but do
        // not accept the instance receiver expected by this dispatcher.
        if (!ctx.classMethodSet.has(fullName)) continue;
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "instance")) ?? ctx.funcMap.get(fullName);
        if (funcIdx === undefined) continue;
        const params = getFuncParamTypes(ctx, funcIdx);
        if (params) userMethodArities.push(Math.max(0, params.length - 1));
        const fields = ctx.structFields.get(structName) ?? [];
        const typeIdx = ctx.structMap.get(structName);
        const typeDef = typeIdx === undefined ? undefined : ctx.mod.types[typeIdx];
        const superTypeIdx = typeDef?.kind === "struct" ? typeDef.superTypeIdx : -1;
        const carrierShape = `${superTypeIdx};${fields
          .map((field) =>
            field.type.kind === "ref" || field.type.kind === "ref_null"
              ? `${field.type.kind}:${field.type.typeIdx}`
              : field.type.kind,
          )
          .join(",")}`;
        let funcsForShape = userMethodFuncsByCarrierShape.get(carrierShape);
        if (!funcsForShape) {
          funcsForShape = new Set<number>();
          userMethodFuncsByCarrierShape.set(carrierShape, funcsForShape);
        }
        funcsForShape.add(funcIdx);
        if (ctx.funcRestParams.has(fullName)) hasUserRestMethod = true;
      }
      // The generated dispatcher currently specializes one fixed method ABI.
      // Activate it on the host lane only when every concrete source candidate
      // has that same non-rest ABI. Otherwise a subclass override with another
      // arity can satisfy its base struct's ref.test and silently run the base
      // body, while a rest vec would be mistaken for one positional argument.
      const hasUniformUserMethodAbi =
        userMethodArities.length > 0 &&
        !hasUserRestMethod &&
        userMethodArities.every((arity) => arity === userMethodArities[0]) &&
        [...userMethodFuncsByCarrierShape.values()].every((funcs) => funcs.size === 1);
      // A callable class field shadows a prototype method of the same name.
      // A closed method dispatcher cannot represent that per-instance choice:
      // its method arm would win before the field closure is read. Leave this
      // collision on the generic host path, whose normal property lookup sees
      // the actual field value (Marked's `parse`/`parseInline` shape).
      const hasUserClassField = [...ctx.classSet].some((className) =>
        (ctx.structFields.get(className) ?? []).some(
          (field) => field.name === methodName && field.type.kind === "externref",
        ),
      );
      const needsRuntimeUserMethodDispatch =
        dispatchArgs !== null &&
        hasUniformUserMethodAbi &&
        (sourceDefinesFunctionMember(expr.getSourceFile(), methodName) || hasKnownUserClassMethod) &&
        !(hasUserClassField && hasKnownUserClassMethod);
      if (
        process.env.DEBUG_MARKED_CODEGEN === "1" &&
        fctx.name.includes("debugMarkedDynamicFunctionFieldObjectLiteral")
      ) {
        console.error(
          "[marked-any-dispatch]",
          fctx.name,
          methodName,
          "dispatchArgs",
          dispatchArgs?.length,
          "sourceMember",
          sourceDefinesFunctionMember(expr.getSourceFile(), methodName),
          "knownUser",
          hasKnownUserClassMethod,
          "uniform",
          hasUniformUserMethodAbi,
          "field",
          hasUserClassField,
          "matchingFields",
          [...ctx.classSet]
            .map((name) => ({
              name,
              fields: (ctx.structFields.get(name) ?? []).filter((field) => field.name === methodName),
            }))
            .filter((entry) => entry.fields.length > 0),
          "needs",
          needsRuntimeUserMethodDispatch,
          "classes",
          [...ctx.classSet],
          "structNames",
          [...ctx.structFields.keys()],
          "arities",
          userMethodArities,
        );
      }
      // The closed dispatcher is also the JS-host implementation for an
      // any-typed call into a compiled class.  Mark the name before reserving
      // it so finalization can preserve JavaScript's ordinary under-application
      // semantics (missing parameters are `undefined`, even when the checker
      // did not recover an optional marker from an allowJs source).
      if (needsRuntimeUserMethodDispatch && !ctx.standalone && !ctx.wasi) {
        ctx.hostDynamicClassMethodNames.add(methodName);
      }
      if (
        (ctx.standalone || ctx.wasi || needsRuntimeUserMethodDispatch) &&
        dispatchArgs !== null &&
        !recvIsBuiltinClass
      ) {
        const arity = dispatchArgs.length;
        if (
          process.env.DEBUG_MARKED_CODEGEN === "1" &&
          fctx.name.includes("debugMarkedDynamicFunctionFieldObjectLiteral")
        ) {
          console.error("[marked-any-reserve]", fctx.name, methodName, arity, "standalone", ctx.standalone);
        }
        const dispatchIdx = reserveClosedMethodDispatch(ctx, methodName, arity);
        // #3507 — reserve the native RegExp carrier helper while function
        // indices are still append-safe. The dispatcher fill only reads it.
        if (ctx.standalone && methodName === "test" && arity === 1) {
          ensureStandaloneRegExpCarrierTestHelper(ctx);
        }
        // (#2927) For the in-place array mutation forms (`push` arity 1 / `pop`
        // arity 0) the closed-method dispatcher grows a native `$__vec_base`
        // brand arm (fillClosedMethodDispatch) that routes an `any`/externref
        // vec receiver to these carrier-generic helpers. Reserve them here — the
        // dispatcher's fill only READS funcMap, and reserving from this module
        // (which already imports `reserveVecMethodHelper`) avoids the eval-time
        // import cycle that reserving from `closed-method-dispatch.ts` would form.
        if ((methodName === "push" && arity === 1) || (methodName === "pop" && arity === 0)) {
          reserveVecMethodHelper(ctx, methodName === "push" ? "push" : "pop");
        }
        // (#3173) DataView get*/set* on an `any` receiver — mint the shared
        // native accessor helper NOW so the dispatcher fill (which only READS
        // funcMap, #1719) can add its `$__dv_window` brand arm. Reserved from
        // this module (which already imports dataview-native) to avoid the
        // eval-time import cycle a closed-method-dispatch.ts import would form
        // (same reasoning as the #2927 reserveVecMethodHelper placement above).
        if (usesNativeDataViewProvider(ctx) && isDataViewAccessor(methodName)) {
          ensureDvAccessorHelper(ctx, methodName);
        }
        flushLateImportShifts(ctx, fctx);
        // (#3177 slice 5) `%TypedArray%.of` / `%TypedArray%.from` STATIC methods
        // on a `$__ta_ctor` receiver VALUE — see `tryEmitTaStaticOfFrom`.
        if (noJsHost(ctx) && ctx.taCtorTypeIdx >= 0 && (methodName === "of" || methodName === "from")) {
          const taStatic = tryEmitTaStaticOfFrom(ctx, fctx, propAccess, dispatchArgs, methodName, dispatchIdx);
          if (taStatic !== null) return taStatic;
        }
        // (#2872) A mutating `%TypedArray%.prototype` method on a receiver
        // that is a `$__ta_dyn_view` at RUNTIME (a dynamically-constructed TA
        // — `new TA([…]).fill(8, 1)` / `.copyWithin(0,2)` / `.reverse()` in
        // the testWithTypedArrayConstructors harness) must operate on the
        // view's shared buffer and return `this`; the dispatcher's open-object
        // arm silently returned undefined and mutated nothing. Emit a
        // runtime-gated two-arm: `ref.test $__ta_dyn_view` → the native
        // `__ta_dyn_<m>` helper, else → the ordinary dispatcher (closed
        // structs / vec arms / open objects keep their EXACT behavior). All
        // three helpers share the `(recv, v1, v2, v3, argc)` signature (unused
        // slots padded with `ref.null.extern`), so ONE emit block serves them
        // (slice-1 fill path is byte-identical — same helper funcIdx/arity).
        // Helpers mint defined functions only (no imports — post-flush safe).
        let taFillIdx: number | undefined;
        if (ctx.moduleUsesDynTaView && arity <= 3) {
          if (methodName === "fill") taFillIdx = ensureTaDynFillHelper(ctx);
          else if (methodName === "copyWithin") taFillIdx = ensureTaDynCopyWithinHelper(ctx);
          else if (methodName === "reverse") taFillIdx = ensureTaDynReverseHelper(ctx);
        }
        if (taFillIdx !== undefined && ctx.taDynViewTypeIdx >= 0) {
          const dynIdx = ctx.taDynViewTypeIdx;
          const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvT && recvT.kind !== "externref") {
            coerceType(ctx, fctx, recvT, { kind: "externref" });
          } else if (recvT === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          const recvLocal = allocLocal(fctx, `__tafill_recv_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: recvLocal });
          const argLocals: number[] = [];
          for (const arg of dispatchArgs) {
            const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
            const aLocal = allocLocal(fctx, `__tafill_arg_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: aLocal });
            argLocals.push(aLocal);
          }
          const thenArm: Instr[] = [{ op: "local.get", index: recvLocal }];
          for (let a = 0; a < 3; a++) {
            thenArm.push(a < argLocals.length ? { op: "local.get", index: argLocals[a]! } : { op: "ref.null.extern" });
          }
          thenArm.push({ op: "i32.const", value: arity });
          thenArm.push({ op: "call", funcIdx: taFillIdx });
          const elseArm: Instr[] = [{ op: "local.get", index: recvLocal }];
          for (const aLocal of argLocals) elseArm.push({ op: "local.get", index: aLocal });
          elseArm.push({ op: "call", funcIdx: dispatchIdx });
          fctx.body.push({ op: "local.get", index: recvLocal });
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "ref.test", typeIdx: dynIdx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: thenArm,
            else: elseArm,
          });
          return { kind: "externref" };
        }
        // (#3140) `.bind` on an `any`-typed receiver that is a CLOSURE at
        // RUNTIME — the test262 TypedArray harness shape
        // (`argFactory.bind(undefined, constructor)` where `argFactory` is an
        // array element). The typed `compileFunctionBind` route requires TS
        // call signatures, so an `any` receiver fell to the open-object
        // dispatcher arm and returned undefined (a non-callable — every
        // makeCtorArg-style test then failed at the harness level). Emit the
        // closure-classifier runtime arms: a callable receiver mints the
        // native `$__bound_fn` carrier; anything else keeps the EXACT
        // dispatcher path (closed-struct `bind` methods, open objects).
        if (methodName === "bind" && usesNativeFunctionBindProvider(ctx)) {
          // Reserve-then-fill (#1719 discipline): the callable test needs the
          // COMPLETE closure-classifier root list, which is only settled at
          // finalize — baking `buildClosureRefTestArms` here would miss every
          // closure registered after this call site compiles (#1896's exact
          // hazard). `__bind_dyn(recv, argsVec)` is filled by
          // `fillBindDynHelper`: callable → mint `$__bound_fn`; anything else
          // → the open-object `__extern_method_call(recv, "bind", args)`
          // legacy route (undefined), preserving prior behavior.
          const bindDynIdx = reserveBindDynHelper(ctx);
          flushLateImportShifts(ctx, fctx);
          const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvT && recvT.kind !== "externref") {
            coerceType(ctx, fctx, recvT, { kind: "externref" });
          } else if (recvT === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          const recvLocal = allocLocal(fctx, `__bindany_recv_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: recvLocal });
          const { newIdx: bvNewIdx, pushIdx: bvPushIdx } = ensureObjVecBuilders(ctx);
          const vecLocal = allocLocal(fctx, `__bindany_vec_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "call", funcIdx: bvNewIdx });
          fctx.body.push({ op: "local.set", index: vecLocal });
          for (const arg of dispatchArgs) {
            fctx.body.push({ op: "local.get", index: vecLocal });
            const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
            fctx.body.push({ op: "call", funcIdx: bvPushIdx });
          }
          fctx.body.push({ op: "local.get", index: recvLocal });
          fctx.body.push({ op: "local.get", index: vecLocal });
          fctx.body.push({ op: "call", funcIdx: bindDynIdx });
          return { kind: "externref" };
        }
        // Receiver as externref.
        const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        if (recvType && recvType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        } else if (recvType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        }
        // Each argument compiled and boxed to externref (the dispatcher unboxes
        // to the method's declared param type per candidate struct).
        for (const arg of dispatchArgs) {
          // (#3098) An inline arrow/function-expression callback to a native-
          // HOF-served method compiles as a raw GC CLOSURE struct (crossing as
          // externref), NOT via the `__make_callback` host bridge that
          // `isHostCallbackArgument` would pick for the HOST_CALLBACK_METHODS
          // names: standalone has no host, so that env import leaked and the
          // whole module failed to instantiate (the #2 leaked import of the
          // 2026-06-26 standalone JSONL). The dispatcher's `$__vec_base`/
          // `$ObjVec` HOF arm invokes the closure natively via
          // `__apply_closure` (same rep an identifier-held callback already
          // crosses with). Mirrors the `Object.groupBy` / `.call`/`.apply`
          // (#3016) precedent; standalone-gated so gc/wasi stay byte-identical.
          if (
            ctx.standalone &&
            (NATIVE_HOF_METHODS.has(methodName) || LAZY_ITER_METHODS.has(methodName)) &&
            (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
          ) {
            const at = compileArrowAsClosure(ctx, fctx, arg);
            if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
            else if (at === null) fctx.body.push({ op: "ref.null.extern" });
            continue;
          }
          const at = compileExpression(ctx, fctx, arg, { kind: "externref" });
          if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
          else if (at === null) fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "call", funcIdx: dispatchIdx });
        return { kind: "externref" };
      }

      // (#2151 Slice 4) DYNAMIC-spread any-receiver dispatch: `o.m(...xs)` where
      // `xs` is a runtime array (arity unknown at compile time), so the
      // fixed-arity `__call_m_<name>_<arity>` dispatcher above does not apply
      // (flattenCallArgs returned null). Scope: a SINGLE pure spread argument —
      // the dominant shape (`o.m(...xs)`). The vararg dispatcher
      // `__call_m_<name>_vararg(recv, args)` reads each declared param from the
      // spread array via `__extern_get_idx(args, i)`, so the array is passed
      // directly (the native indexer handles wasm vecs and $ObjVec). Mixed
      // `o.m(a, ...xs)` keeps falling through to the generic path (no
      // regression — it returns the same value as before this slice).
      //
      // Gated to `ctx.standalone` ONLY (not wasi): the `__extern_get_idx`
      // array-like / wasm-vec indexing arms the dispatcher relies on are
      // emitted only under standalone (`objArrayLikeArms = ctx.standalone` in
      // object-runtime.ts). Under wasi they are absent, so a vararg dispatcher
      // would read null args — wasi keeps the existing fall-through behaviour
      // (the same pre-existing wasi arg-vec gap noted in the issue). Widening
      // the array-like arms to wasi is a separate, broader change.
      const isSingleDynamicSpread =
        (ctx.standalone || needsRuntimeUserMethodDispatch) &&
        !recvIsBuiltinClass &&
        expr.arguments.length === 1 &&
        ts.isSpreadElement(expr.arguments[0]!);
      if (isSingleDynamicSpread) {
        const dispatchIdx = reserveClosedMethodDispatchVararg(ctx, methodName);
        flushLateImportShifts(ctx, fctx);
        // Receiver as externref.
        const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        if (recvType && recvType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        } else if (recvType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        }
        // The spread source array as externref — passed directly to the vararg
        // dispatcher, which indexes it via __extern_get_idx.
        const spreadExpr = (expr.arguments[0] as ts.SpreadElement).expression;
        const argsType = compileExpression(ctx, fctx, spreadExpr, { kind: "externref" });
        if (argsType && argsType.kind !== "externref") coerceType(ctx, fctx, argsType, { kind: "externref" });
        else if (argsType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "call", funcIdx: dispatchIdx });
        return { kind: "externref" };
      }

      // (#2151 Slice 5) MIXED-spread any-receiver dispatch: `o.m(a, ...xs)` —
      // fixed leading args followed by a single trailing DYNAMIC spread (arity
      // unknown at compile time). The fixed-arity dispatcher cannot apply
      // (flattenCallArgs returned null), and the pure-dynamic-spread vararg
      // routing above requires exactly one spread arg with no fixed leading
      // args. Here we build the combined arg vector at runtime — a fresh
      // `$ObjVec`, push each fixed leading arg (boxed to externref), then
      // loop-append the spread source's elements (`__extern_length` +
      // `__extern_get_idx`) — and hand it to the SAME
      // `__call_m_<name>_vararg(recv, args)` dispatcher, which reads each
      // declared param from the vec via `__extern_get_idx`. (`$ObjVec` is
      // exactly what `__extern_get_idx` and `__objvec_push` operate on.)
      //
      // Gated to `ctx.standalone` ONLY (same constraint as Slice 4 — the
      // `__extern_get_idx` array-like / wasm-vec indexing arms the dispatcher
      // and the loop-append rely on are emitted only under standalone). Scope:
      // exactly ONE spread, which must be the LAST argument; any other spread
      // shape (leading/middle spread, multiple spreads) keeps the existing
      // fall-through (no regression).
      const spreadCount = expr.arguments.filter((a) => ts.isSpreadElement(a)).length;
      const lastArg = expr.arguments[expr.arguments.length - 1];
      const isMixedTrailingSpread =
        ctx.standalone &&
        !recvIsBuiltinClass &&
        expr.arguments.length >= 2 &&
        spreadCount === 1 &&
        lastArg !== undefined &&
        ts.isSpreadElement(lastArg);
      if (isMixedTrailingSpread) {
        const dispatchIdx = reserveClosedMethodDispatchVararg(ctx, methodName);
        ensureObjVecBuilders(ctx);
        ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
        ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        // Re-resolve every funcIdx by name AFTER the last shift (late-import
        // index-shift class #2043): the `ensureLateImport`s above added imports,
        // which shifted EVERY defined-function index — including the vararg
        // dispatcher reserved above. funcMap holds the post-shift truth. These
        // are all unconditionally registered in standalone (the object runtime
        // provides `__objvec_*` / `__extern_*`); `!` is safe here.
        const dispatchResolvedIdx = ctx.funcMap.get(`__call_m_${methodName}_vararg`) ?? dispatchIdx;
        const objVecNew = ctx.funcMap.get("__objvec_new")!;
        const objVecPush = ctx.funcMap.get("__objvec_push")!;
        const lenFn = ctx.funcMap.get("__extern_length")!;
        const getIdxFn = ctx.funcMap.get("__extern_get_idx")!;

        // Receiver as externref → local (read once; the vec build below also
        // pushes onto the value stack, so stash the receiver first).
        const recvLocal = allocLocal(fctx, `__mspread_recv_${fctx.locals.length}`, { kind: "externref" });
        const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
        if (recvType && recvType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
        else if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: recvLocal });

        // combined = __objvec_new()
        const argsVecLocal = allocLocal(fctx, `__mspread_args_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "call", funcIdx: objVecNew });
        fctx.body.push({ op: "local.set", index: argsVecLocal });

        // Push each fixed leading arg (all but the trailing spread).
        for (let i = 0; i < expr.arguments.length - 1; i++) {
          fctx.body.push({ op: "local.get", index: argsVecLocal });
          const at = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
          if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
          else if (at === null) fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "call", funcIdx: objVecPush });
        }

        // Loop-append the spread source's elements.
        const spreadSrcLocal = allocLocal(fctx, `__mspread_src_${fctx.locals.length}`, { kind: "externref" });
        const spreadExpr = (lastArg as ts.SpreadElement).expression;
        const srcType = compileExpression(ctx, fctx, spreadExpr, { kind: "externref" });
        if (srcType && srcType.kind !== "externref") coerceType(ctx, fctx, srcType, { kind: "externref" });
        else if (srcType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: spreadSrcLocal });

        const spreadLenLocal = allocLocal(fctx, `__mspread_len_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.get", index: spreadSrcLocal });
        fctx.body.push({ op: "call", funcIdx: lenFn });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        fctx.body.push({ op: "local.set", index: spreadLenLocal });

        const spreadIdxLocal = allocLocal(fctx, `__mspread_idx_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: spreadIdxLocal });
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // if idx >= len break
                { op: "local.get", index: spreadIdxLocal },
                { op: "local.get", index: spreadLenLocal },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // __objvec_push(combined, __extern_get_idx(src, idx))
                { op: "local.get", index: argsVecLocal },
                { op: "local.get", index: spreadSrcLocal },
                { op: "local.get", index: spreadIdxLocal },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: getIdxFn },
                { op: "call", funcIdx: objVecPush },
                // idx++
                { op: "local.get", index: spreadIdxLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: spreadIdxLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        });

        // __call_m_<name>_vararg(recv, combined)
        fctx.body.push({ op: "local.get", index: recvLocal });
        fctx.body.push({ op: "local.get", index: argsVecLocal });
        fctx.body.push({ op: "call", funcIdx: dispatchResolvedIdx });
        return { kind: "externref" };
      }

      // (#2784 S3) Native-vec-aware method dispatch. A `.push`/`.pop` on an
      // `any`/externref receiver that is actually a NATIVE vec (a reconstructed-
      // fnctor `T[]` field read as externref — acorn's `this.scopeStack`) MUST use
      // the WASM `__vec_push`/`__vec_pop` (which mutate the native array), NOT the
      // host `__extern_method_call` bridge. The host cannot introspect the opaque
      // WasmGC vec-struct, so a host `.push` lands the element in a JS-side array
      // that the native `[i]` read (`__vec_get`) never sees — a read/write STORAGE
      // SPLIT that loses the stored struct's identity (the #2784 NaN/hang). Guard:
      // `ref.test` the registered vec carriers; on hit call the native op, else
      // fall through to the host bridge in the `else` arm. Host/gc mode only (acorn
      // dogfoods there); standalone keeps the existing path (a noted follow-up).
      if (
        ctx.targetProfile.semanticProviders !== "native-first" &&
        !ctx.standalone &&
        (methodName === "push" || methodName === "pop") &&
        ctx.vecTypeMap.size > 0
      ) {
        // (#2784 S3) Add ALL late imports FIRST and flush, so the index space is
        // settled BEFORE reserving the native-vec helper funcIdx (a function push,
        // which does not itself shift). Reserving the helper before these imports
        // would leave its baked funcIdx stale after the import shift.
        const mcIdx = ensureLateImport(
          ctx,
          "__extern_method_call",
          [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
        const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
        const boxNumIdx =
          methodName === "push"
            ? ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }])
            : undefined;
        addStringConstantGlobal(ctx, methodName);
        flushLateImportShifts(ctx, fctx);
        // Reserve the helper AFTER the imports settle — its funcIdx is now final.
        // (Its body is filled in the finalize vec-export pass.)
        const vecOpIdx = reserveVecMethodHelper(ctx, methodName === "push" ? "push" : "pop");
        if (
          vecOpIdx !== undefined &&
          mcIdx !== undefined &&
          arrNewIdx !== undefined &&
          arrPushIdx !== undefined &&
          (methodName === "pop" || boxNumIdx !== undefined)
        ) {
          // Receiver → externref → recvLocal.
          const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
          if (recvT && recvT.kind !== "externref") coerceType(ctx, fctx, recvT, { kind: "externref" });
          else if (!recvT) fctx.body.push({ op: "ref.null.extern" });
          const recvLocal = allocLocal(fctx, `__nvm_recv_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: recvLocal });
          // push's single element → argLocal (evaluate side effects once, up front).
          let argLocal: number | undefined;
          if (methodName === "push") {
            const a = expr.arguments[0];
            if (a) {
              const at = compileExpression(ctx, fctx, a, { kind: "externref" });
              if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
              else if (!at) fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            argLocal = allocLocal(fctx, `__nvm_arg_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: argLocal });
          }
          // isVec = OR of ref.test over every registered vec carrier.
          const anyTmp = allocLocal(fctx, `__nvm_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
          fctx.body.push({ op: "local.get", index: recvLocal });
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push({ op: "local.set", index: anyTmp });
          let emitted = false;
          for (const vi of new Set(ctx.vecTypeMap.values())) {
            fctx.body.push({ op: "local.get", index: anyTmp });
            fctx.body.push({ op: "ref.test", typeIdx: vi });
            if (emitted) fctx.body.push({ op: "i32.or" });
            emitted = true;
          }
          // THEN (native vec op) — emit then splice into a detached arm.
          const thenStart = fctx.body.length;
          if (methodName === "push") {
            fctx.body.push({ op: "local.get", index: recvLocal });
            fctx.body.push({ op: "local.get", index: argLocal! });
            fctx.body.push({ op: "call", funcIdx: vecOpIdx }); // -> i32 new length
            fctx.body.push({ op: "f64.convert_i32_s" });
            fctx.body.push({ op: "call", funcIdx: boxNumIdx! }); // -> externref
          } else {
            fctx.body.push({ op: "local.get", index: recvLocal });
            fctx.body.push({ op: "call", funcIdx: vecOpIdx }); // -> externref
          }
          const thenInstrs = fctx.body.splice(thenStart);
          // ELSE (host bridge) — build the args array, then __extern_method_call.
          const elseStart = fctx.body.length;
          fctx.body.push({ op: "call", funcIdx: arrNewIdx });
          const argsLocal = allocLocal(fctx, `__nvm_args_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: argsLocal });
          if (methodName === "push") {
            fctx.body.push({ op: "local.get", index: argsLocal });
            fctx.body.push({ op: "local.get", index: argLocal! });
            fctx.body.push({ op: "call", funcIdx: arrPushIdx });
          }
          fctx.body.push({ op: "local.get", index: recvLocal });
          fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
          fctx.body.push({ op: "local.get", index: argsLocal });
          fctx.body.push({ op: "call", funcIdx: mcIdx });
          const elseInstrs = fctx.body.splice(elseStart);
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } as ValType },
            then: thenInstrs,
            else: elseInstrs,
          });
          return { kind: "externref" };
        }
      }

      // (#799 WI3) Generic host-delegated method call for any/externref receivers.
      // #965: resolve known built-in receivers through __get_builtin rather than null.
      {
        // A dynamic receiver can still be a compiled ordinary class instance.
        // Record the property name so finalization can expose the matching
        // WasmGC method bridge to the host runtime (fnctor subclasses already
        // use the same bridge, but ordinary classes need the discriminator too).
        if (!ctx.standalone && !ctx.wasi) ctx.hostDynamicClassMethodNames.add(methodName);
        observeHostDynamicMethodCallArity(ctx, expr.arguments);
        if (tryEmitFixedHostMethodCall(ctx, fctx, expr, propAccess, methodName)) return { kind: "externref" };
        // #1888: standalone builds a native $ObjVec; fixed JS-host calls were
        // handled above. Larger/spread host calls and WASI use the array bridge.
        // #1472: the JS-array builders are not globally safe to alias.
        let arrNewIdx: number | undefined;
        let arrPushIdx: number | undefined;
        if (ctx.targetProfile.semanticProviders === "native-first") {
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
        // For built-in class identifiers, import __get_builtin to resolve real JS object
        const receiverIsBuiltin =
          ts.isIdentifier(propAccess.expression) && BUILTIN_CLASS_NAMES.has(propAccess.expression.text);
        const getBuiltinIdx = receiverIsBuiltin
          ? ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }])
          : undefined;
        flushLateImportShifts(ctx, fctx);

        if (methodCallIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
          // Compile receiver as externref.
          // For known built-in class identifiers, use __get_builtin to get the real JS object
          // instead of the null produced by compileIdentifier's graceful fallback.
          let recvType: ValType | null;
          if (receiverIsBuiltin && getBuiltinIdx !== undefined) {
            const builtinName = (propAccess.expression as ts.Identifier).text;
            addStringConstantGlobal(ctx, builtinName);
            fctx.body.push(...stringConstantExternrefInstrs(ctx, builtinName));
            fctx.body.push({ op: "call", funcIdx: getBuiltinIdx });
            recvType = { kind: "externref" };
          } else {
            recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
            if (recvType && recvType.kind !== "externref") {
              fctx.body.push({ op: "extern.convert_any" });
            }
          }
          const recvLocal = allocLocal(fctx, `__emc_recv_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: recvLocal });

          // Build args array
          fctx.body.push({ op: "call", funcIdx: arrNewIdx });
          const argsLocal = allocLocal(fctx, `__emc_args_${fctx.locals.length}`, { kind: "externref" });
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
            // (#3429) A statically-name-resolvable compiled function/class
            // argument (e.g. `assert.throws(MyError, fn)`) gets its real
            // `.name` stamped before crossing — see maybeStampCompiledFunctionArgName.
            maybeStampCompiledFunctionArgName(ctx, fctx, arg);
            fctx.body.push({ op: "call", funcIdx: arrPushIdx });
          }

          // Push receiver, method name, args array → call __extern_method_call
          fctx.body.push({ op: "local.get", index: recvLocal });
          addStringConstantGlobal(ctx, methodName);
          fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
          fctx.body.push({ op: "local.get", index: argsLocal });
          fctx.body.push({ op: "call", funcIdx: methodCallIdx });
          return { kind: "externref" };
        }

        // Fallback if imports unavailable: evaluate for side effects, return null
        const recvType = compileExpression(ctx, fctx, propAccess.expression);
        if (recvType) {
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
  }

  // (#3201) Unknown-method fallback for NATIVE (ref/ref_null) receivers on
  // the JS-host lane. Every arm above has declined — historically this fell
  // through to the calls.ts "graceful fallback" (compile callee + args for
  // side effects, return null), which silently nulled Sputnik's expando-
  // classifier idiom (`arr.getClass = Object.prototype.toString;
  // arr.getClass()` — 65+ test262 fails across splice/slice/concat) and any
  // other method stored as an expando on a struct/vec. The host mirror DOES
  // carry expando writes (`__extern_set_strict`) and reads (`__extern_get`),
  // so delegate to the same `__extern_method_call(recv, name, args)` generic
  // the any/externref ladder (#799 WI3) and the fnctor-subclass miss (#3123)
  // use — `fn.apply(recv, args)` with correct `this` binding on the host
  // side. Host (gc) lane only: #3201's scope is the default lane and its
  // acceptance forbids standalone regressions (the native dispatcher's
  // struct-expando coverage is a follow-up).
  if (!ctx.standalone && !ctx.wasi) {
    // recvWasm hoisted above the any-arm block — one checker resolution
    // serves both fallbacks (oracle ratchet #1930/#3273).
    //
    // (#3176 merge-queue park) The arm must only claim TRUE expandos —
    // methods NOT declared on the static receiver type. The original
    // unconditional delegation hijacked calls the downstream compiled paths
    // handled correctly (compiled class instance methods like Temporal's
    // polyfill `since`/`until`, and static class fields like
    // `class C { static f = () => this }` — C.f is a declared member) into
    // `__extern_method_call`, whose host mirror does NOT carry compiled
    // class methods → "since is not a function" / null cascades: 215
    // merge_group regressions (211 Temporal + class static-field arrows).
    // `recvTsType.getProperty` / `.isClass` are Type-object reads on the
    // ALREADY-hoisted resolution — no net-new direct checker usage
    // (ratchet #1930/#3273). The Sputnik classifier idiom
    // (`arr.getClass = …` on a vec/struct or object literal) is by
    // definition undeclared on the receiver's type, so the #3201 wins keep
    // hitting the arm.
    //
    // Class-declared instance types are ALSO declined even when getProperty
    // misses: a class extending an unresolvable base (e.g.
    // `class X extends Temporal.PlainYearMonth` — no TS lib typings for the
    // base) has an incomplete member set, so a getProperty miss is not
    // evidence of an expando (Temporal/PlainYearMonth/prototype/equals/
    // use-internal-slots.js regressed exactly this way). Declining restores
    // the pre-#3201 downstream path, which handled these correctly.
    if (
      (recvWasm.kind === "ref" || recvWasm.kind === "ref_null") &&
      recvTsType.getProperty(propAccess.name.text) === undefined &&
      !(recvTsType.isClass?.() ?? false)
    ) {
      // rawStructReceiver: the expando sidecar (`_wasmStructProps`) is keyed
      // by the RAW struct ref — an externref expected-type compile would
      // route a vec receiver through `__make_iterable`'s copy, losing the
      // identity the sidecar lookup needs.
      const delegated = emitFnctorSubclassDynamicMethodCall(
        ctx,
        fctx,
        expr,
        propAccess,
        propAccess.name.text,
        /* rawStructReceiver */ true,
      );
      if (delegated !== undefined) return delegated;
    }
  }
  return undefined;
}
