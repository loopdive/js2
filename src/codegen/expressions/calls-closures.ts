// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Closure and callable property call compilation:
 * - compileClosureCall — call to a closure variable
 * - compileGetterCallable — call where property is a getter returning a callable
 * - compileObjectPrototypeFallback — Object.prototype methods on class instances
 * - compileCallablePropertyCall — call to a callable struct field
 * - tryExternClassMethodOnAny — resolve method call on any-typed receiver via extern classes
 */
import { ts } from "../../ts-api.js";
import { isVoidType, isPromiseType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import {
  getClosureFuncSelfTypeIdx,
  getFuncRefWrapperRootTypeIdx,
  getOrCreateFuncRefWrapperTypes,
} from "../closures.js";
import { compileArrayJoinExtern, emitBoundsCheckedArrayGet } from "../array-methods.js";
import { tryCompileNativeDisposableStackAnyMethodCall } from "../disposable-runtime.js";
import { noJsHost } from "../js-errors.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { emitRuntimeEvalCarrierUnwrapAny } from "../runtime-eval-callable.js";
import { expressionDescendsFromRealmStructuralBinding } from "../analysis/realm-global-structural-carrier.js";
import { allocLocal } from "../context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import { addFuncType, addImport, localGlobalIdx, resolveWasmType } from "../index.js";
import {
  emitExternrefToStructGet,
  emitNullCheckThrow,
  emitNullGuardedStructGet,
  typeErrorThrowInstrs,
} from "../property-access.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, resolveComputedKeyExpression, valTypesMatch, VOID_RESULT } from "../shared.js";
import {
  defaultValueInstrs,
  emitGuardedFuncRefCast,
  emitGuardedRefCast,
  getVecInfo,
  pushDefaultValue,
} from "../type-coercion.js";
import { getFuncParamTypes, getWasmFuncReturnType, isEffectivelyVoidReturn, wasmFuncReturnsVoid } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "./late-imports.js";
import { compileInternalCallArgument } from "./internal-call-argument.js";
import {
  emitFnctorSubclassDynamicMethodCall,
  emitClosureCallArgcExtras,
  emitResetArgcExtras,
  emitSetArgc,
  emitWrapperDynamicMethodCall,
  flattenCallArgs,
  STANDALONE_TA_SCALAR_HOFS,
} from "./calls.js";
import { tryEmitTransferredNativeProtoMethodCall } from "./transferred-native-proto-call.js";
import { buildArgcExtrasSetupFromLocals } from "./argc-extras.js";
import { tryCompileGetPrototypeOfIsPrototypeOf } from "./object-get-prototype-of.js";
import { tryEmitStaticOrNativeIsPrototypeOf } from "../native-is-prototype-of.js";
import { ensureFunctionNativeProtoGlue } from "../array-object-proto.js";
import { ensureFunctionProtoEdge, FUNCTION_PROTO_HAS_INSTANCE_MEMBER } from "../function-proto-has-instance.js";
import { ensureStandaloneNativeMethodClosure } from "../native-proto.js";
import { pushBuiltinFnSingletonValueInstrs } from "../builtin-fn-meta.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import type { ObjectLiteralMethodReceiverBind } from "../object-literal-method-receiver.js";
import { sourceAssignsAliasedFunctionMember, sourceDefinesFunctionMember } from "../source-function-members.js";
import {
  captureObjectLiteralMethodReceiver,
  emitObjectLiteralMethodThisInstall,
  emitStandaloneReceiverCapture,
  finishObjectLiteralMethodCall,
  planElementAccessMethodReceiverBind,
  planObjectLiteralMethodReceiverBind,
} from "../object-literal-method-receiver.js";

/**
 * (#3205) A single funcref-type dispatch candidate for a callable property /
 * element call: the concrete closure struct type, its lifted funcref type, and
 * the wasm return type that funcref yields.
 */
type FuncCandidate = { funcTypeIdx: number; structTypeIdx: number; returnType: ValType | null };

/** `fillApplyClosure` only emits dynamic method dispatchers for arities 0..8. */
const REALM_DYNAMIC_CALL_MAX_ARITY = 8;

/**
 * TypeScript gives an unannotated JavaScript function that reads `arguments`
 * a synthetic trailing rest symbol in its checker signature. That symbol is
 * not a source formal and is not present in the lifted Wasm closure ABI: the
 * real overflow values travel through `__argc` / `__extras_argv` instead.
 *
 * Use the source declaration's smaller arity when it proves that the final
 * checker symbols are synthetic. Real source rest parameters remain present
 * in `declaration.parameters`, and declaration-file signatures keep their
 * checker-authored parameter list unchanged.
 */
export function runtimeSignatureParameters(sig: ts.Signature): readonly ts.Symbol[] {
  const declaration = sig.getDeclaration();
  if (
    declaration !== undefined &&
    ts.isFunctionLike(declaration) &&
    !declaration.getSourceFile().isDeclarationFile &&
    declaration.parameters.length < sig.parameters.length
  ) {
    return sig.parameters.slice(0, declaration.parameters.length);
  }
  return sig.parameters;
}

/**
 * (#3205) Build the funcref-type candidate set for a callable-property dispatch.
 *
 * A closure stored in an object field / array element may have a DIFFERENT
 * actual signature than the field's DECLARED type — a covariant return
 * (`() => number` stored in a `() => void` field) or an activated async closure
 * (its result was rewritten to externref/Promise). Every no-capture wrapper
 * struct is a layout-identical `(struct (field funcref))`, but
 * `getOrCreateFuncRefWrapperTypes` places each later signature in a distinct
 * direct child under the module's FIRST wrapper (the permanently-open root).
 * WasmGC isorecursive
 * canonicalization keys on (fields, supertype, finality), so the siblings do NOT
 * merge: a `ref.cast` of the value to the DECLARED wrapper (and of its funcref
 * to the declared funcref type) nulls out whenever the value's actual wrapper
 * differs, and `call_ref` then traps on the null funcref ("dereferencing a null
 * pointer"). This scans the registered closures of the SAME param arity/types
 * whose funcref type differs, so the dispatch can discriminate on the funcref's
 * exact (true-signature) type instead. Mirrors the calls.ts callable-param fix
 * (#2873).
 */
function buildClosureFuncCandidates(
  ctx: CodegenContext,
  declared: FuncCandidate,
  sigParamCount: number,
  sigParamWasmTypes: ValType[],
): FuncCandidate[] {
  const funcCandidates: FuncCandidate[] = [declared];
  const seen = new Set<number>([declared.funcTypeIdx]);

  // (#3205) Speculatively admit the externref-return and void-return variants
  // even when no such closure is registered yet — the stored closure may be
  // compiled AFTER this dispatch site (a forward reference: `class C { fn: () =>
  // void } … new C(asyncOrValueReturningClosure)`, wrapped only when the `new`
  // site compiles). An ACTIVATED ASYNC closure's result is rewritten to
  // externref (the Promise), and a covariant object/string return is externref
  // too, so the externref variant is the one the corpus async/asyncTest cluster
  // needs. Mirrors calls.ts `tryAltFuncType` (#1131/#2873). `getOrCreateFunc-
  // RefWrapperTypes` is signature-cached, so a later value site reuses the same
  // funcTypeIdx the dispatch discriminates on.
  const tryAlt = (retTypes: ValType[]): void => {
    const alt = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, retTypes);
    if (alt && !seen.has(alt.closureInfo.funcTypeIdx)) {
      seen.add(alt.closureInfo.funcTypeIdx);
      funcCandidates.push({
        funcTypeIdx: alt.closureInfo.funcTypeIdx,
        structTypeIdx: alt.closureInfo.structTypeIdx,
        returnType: alt.closureInfo.returnType,
      });
    }
  };
  // externref (async Promise / covariant object|string), void, and the numeric
  // returns (covariant `() => number`→f64, `() => boolean`→i32 discarded into a
  // `() => void` field) — the return kinds a covariant/forward-referenced stored
  // closure plausibly has. Ref-returning closures are caught by the scan below
  // when registered before this site (backward reference).
  const declaredKind = declared.returnType?.kind;
  if (declaredKind !== "externref") tryAlt([{ kind: "externref" }]);
  if (declared.returnType !== null) tryAlt([]);
  if (declaredKind !== "f64") tryAlt([{ kind: "f64" }]);
  if (declaredKind !== "i32") tryAlt([{ kind: "i32" }]);

  for (const [, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length !== sigParamCount) continue;
    if (seen.has(info.funcTypeIdx)) continue;
    let paramsMatch = true;
    for (let pi = 0; pi < sigParamCount; pi++) {
      if (!valTypesMatch(info.paramTypes[pi]!, sigParamWasmTypes[pi]!)) {
        paramsMatch = false;
        break;
      }
    }
    if (paramsMatch) {
      seen.add(info.funcTypeIdx);
      funcCandidates.push({
        funcTypeIdx: info.funcTypeIdx,
        structTypeIdx: info.structTypeIdx,
        returnType: info.returnType,
      });
    }
  }
  return funcCandidates;
}

/**
 * (#3205) Compile a callable-property/element call's arguments into locals so a
 * multi-arm funcref dispatch can re-push them in each candidate arm. Clamps to
 * the declared param count (excess args evaluated for side effects then
 * dropped) and pads missing args with defaults — matching the single-candidate
 * arg handling in the callers, but persisted to locals.
 */
function collectPropertyCallArgLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  paramTypes: ValType[],
  evaluateOverflow = true,
): number[] {
  const argLocals: number[] = [];
  const paramCount = paramTypes.length;
  for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
    compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes[i]);
    const al = allocLocal(fctx, `__cparg_${fctx.locals.length}`, paramTypes[i]!);
    fctx.body.push({ op: "local.set", index: al });
    argLocals.push(al);
  }
  // Some callers preserve excess values through the canonical arguments
  // protocol after this helper returns. The legacy element-call path still
  // evaluates and drops them here until it adopts that protocol too.
  if (evaluateOverflow) {
    for (let i = paramCount; i < expr.arguments.length; i++) {
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) fctx.body.push({ op: "drop" });
    }
  }
  // Pad missing args with defaults.
  for (let i = expr.arguments.length; i < paramCount; i++) {
    const pt = paramTypes[i]!;
    pushDefaultValue(fctx, pt, ctx);
    const al = allocLocal(fctx, `__cparg_${fctx.locals.length}`, pt);
    fctx.body.push({ op: "local.set", index: al });
    argLocals.push(al);
  }
  return argLocals;
}

/**
 * (#3205) Emit the order-independent multi-arm funcref dispatch for a callable
 * property/element call. `closureLocal` holds the field/element value already
 * cast to the wrapper ROOT (`(ref null rootIdx)` — the guaranteed supertype of
 * every wrapper struct) and already null-checked; `argLocals` hold the
 * coerced+padded arguments. The funcref is fetched off the root's field 0
 * (valid for a closure of ANY wrapper subtype), then dispatched on its exact
 * type. Each arm passes root self unchanged and coerces the return to
 * `expectedReturn`. When no candidate's funcref matches, a TypeError
 * is thrown (the callee was not a closure of any admitted signature). Mirrors
 * the calls.ts callable-param multi-funcref dispatch (#1131 / #2873).
 */
function emitRootFuncrefDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  closureLocal: number,
  rootIdx: number,
  funcCandidates: FuncCandidate[],
  argLocals: number[],
  expectedReturn: ValType | null,
): void {
  // Fetch the funcref off the ROOT (field 0 is the root's own field, present on
  // every wrapper subtype), then dispatch on its exact type.
  fctx.body.push({ op: "local.get", index: closureLocal });
  fctx.body.push({ op: "struct.get", typeIdx: rootIdx, fieldIdx: 0 });
  const funcrefLocal = allocLocal(fctx, `__cpfrd_${fctx.locals.length}`, { kind: "funcref" } as ValType);
  fctx.body.push({ op: "local.set", index: funcrefLocal });

  const retBlockType =
    expectedReturn === null ? ({ kind: "empty" } as const) : ({ kind: "val", type: expectedReturn } as const);
  const numericKind = (t: ValType): boolean => t.kind === "i32" || t.kind === "f64" || t.kind === "i64";

  // Build the dispatch chain bottom-up; innermost else = throw TypeError.
  let funcDispatch: Instr[] = typeErrorThrowInstrs(ctx);
  for (const fc of [...funcCandidates].reverse()) {
    const fcCallBody: Instr[] = [];
    // Shared lifted funcs take canonical-root self. Private/named closure funcs
    // retain a concrete self type, so their arms need a concrete cast to remain
    // statically call_ref-valid. An unrelated private carrier cannot pass the
    // wrapper-root gate; that candidate arm may therefore be unreachable.
    fcCallBody.push({ op: "local.get", index: closureLocal });
    const candidateSelfTypeIdx = getClosureFuncSelfTypeIdx(ctx, fc.funcTypeIdx) ?? rootIdx;
    if (candidateSelfTypeIdx !== rootIdx) {
      fcCallBody.push({ op: "ref.cast", typeIdx: candidateSelfTypeIdx });
    }
    for (const al of argLocals) fcCallBody.push({ op: "local.get", index: al });
    fcCallBody.push({ op: "local.get", index: funcrefLocal });
    fcCallBody.push({ op: "ref.cast", typeIdx: fc.funcTypeIdx });
    fcCallBody.push({ op: "call_ref", typeIdx: fc.funcTypeIdx });

    // Coerce the arm's return to the block's declared result type. Only the arm
    // whose funcref matches at runtime runs; the others are type-validity
    // padding, so the coercion MUST be import-free (a late import would shift
    // indices and corrupt already-baked ref.func operands — the #2174 hazard).
    const matchedDispatch = expectedReturn !== null && fc.returnType !== null;
    if (expectedReturn === null && fc.returnType !== null) {
      fcCallBody.push({ op: "drop" });
    } else if (expectedReturn !== null && fc.returnType === null) {
      fcCallBody.push(...defaultValueInstrs(expectedReturn));
    } else if (
      matchedDispatch &&
      !valTypesMatch(fc.returnType!, expectedReturn!) &&
      numericKind(expectedReturn!) &&
      numericKind(fc.returnType!)
    ) {
      const saved = fctx.body;
      fctx.body = fcCallBody;
      coerceType(ctx, fctx, fc.returnType!, expectedReturn!);
      fctx.body = saved;
    } else if (matchedDispatch && !valTypesMatch(fc.returnType!, expectedReturn!)) {
      fcCallBody.push({ op: "drop" });
      fcCallBody.push(...defaultValueInstrs(expectedReturn!));
    }

    funcDispatch = [
      { op: "local.get", index: funcrefLocal },
      { op: "ref.test", typeIdx: fc.funcTypeIdx },
      { op: "if", blockType: retBlockType, then: fcCallBody, else: funcDispatch },
    ];
  }
  fctx.body.push(...funcDispatch);
}

/**
 * Push the lifted Wasm arguments for a source closure with a rest parameter.
 * The final lifted formal is a vec struct, whereas the JS call site supplies
 * zero or more positional values. Return externref copies of those values so
 * callers that maintain `arguments` can populate `__extras_argv` without
 * evaluating an argument expression twice.
 */
function compileRestClosureArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  info: ClosureInfo,
): { fixedParamCount: number; restExternLocals: number[] } | null {
  if (info.hasRestParam !== true || info.paramTypes.length === 0) return null;

  const fixedParamCount = info.paramTypes.length - 1;
  const flattenedArgs = flattenCallArgs(expr.arguments);
  const dynamicSpreadIndex = flattenedArgs === null ? expr.arguments.findIndex((arg) => ts.isSpreadElement(arg)) : -1;
  const supportedDynamicSpread =
    dynamicSpreadIndex >= 0 &&
    dynamicSpreadIndex <= fixedParamCount &&
    dynamicSpreadIndex === expr.arguments.length - 1;
  // A non-literal spread mixed with fixed/rest values needs a runtime concat.
  // Leave that shape on the legacy path until it can be materialized exactly;
  // treating the spread source as one rest element is a silent wrong answer.
  if (flattenedArgs === null && !supportedDynamicSpread) return null;
  const callArgs = flattenedArgs ?? [...expr.arguments];

  const restType = info.paramTypes[fixedParamCount]!;
  if (flattenedArgs === null && dynamicSpreadIndex >= 0) {
    if (restType.kind !== "ref" && restType.kind !== "ref_null") return null;
    const vecInfo = getVecInfo(ctx, restType.typeIdx);
    if (vecInfo === null) return null;

    for (let i = 0; i < dynamicSpreadIndex; i++) {
      compileInternalCallArgument(ctx, fctx, callArgs[i]!, info.paramTypes[i]);
    }

    const spread = callArgs[dynamicSpreadIndex]!;
    if (!ts.isSpreadElement(spread)) return null;
    const spreadType = compileExpression(ctx, fctx, spread.expression, restType);
    if (spreadType === null) {
      pushDefaultValue(fctx, restType, ctx);
    } else if (!valTypesMatch(spreadType, restType)) {
      coerceType(ctx, fctx, spreadType, restType);
    }
    const spreadLocal = allocLocal(fctx, `__cc_spread_${fctx.locals.length}`, restType);
    fctx.body.push({ op: "local.set", index: spreadLocal });

    // A spread after every fixed formal is already exactly the rest vec.
    if (dynamicSpreadIndex === fixedParamCount) {
      fctx.body.push({ op: "local.get", index: spreadLocal });
      return { fixedParamCount, restExternLocals: [] };
    }

    const dataType: ValType = { kind: "ref", typeIdx: vecInfo.arrTypeIdx };
    const dataLocal = allocLocal(fctx, `__cc_spread_data_${fctx.locals.length}`, dataType);
    const lenLocal = allocLocal(fctx, `__cc_spread_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: spreadLocal });
    if (restType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.get", typeIdx: restType.typeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: lenLocal });
    fctx.body.push({ op: "local.get", index: spreadLocal });
    if (restType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.get", typeIdx: restType.typeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.set", index: dataLocal });

    const consumedByFixed = fixedParamCount - dynamicSpreadIndex;
    for (let offset = 0; offset < consumedByFixed; offset++) {
      fctx.body.push({ op: "local.get", index: dataLocal });
      fctx.body.push({ op: "i32.const", value: offset });
      emitBoundsCheckedArrayGet(fctx, vecInfo.arrTypeIdx, vecInfo.elemType, ctx);
      const expected = info.paramTypes[dynamicSpreadIndex + offset]!;
      if (!valTypesMatch(vecInfo.elemType, expected)) coerceType(ctx, fctx, vecInfo.elemType, expected);
    }

    const restLenLocal = allocLocal(fctx, `__cc_spread_rest_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "i32.const", value: consumedByFixed });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.tee", index: restLenLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: restLenLocal }],
      else: [{ op: "i32.const", value: 0 }],
    });
    fctx.body.push({ op: "local.set", index: restLenLocal });
    fctx.body.push({ op: "local.get", index: restLenLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: vecInfo.arrTypeIdx });
    const restDataLocal = allocLocal(fctx, `__cc_spread_rest_data_${fctx.locals.length}`, dataType);
    fctx.body.push({ op: "local.set", index: restDataLocal });
    fctx.body.push({ op: "local.get", index: restDataLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "i32.const", value: consumedByFixed });
    fctx.body.push({ op: "local.get", index: restLenLocal });
    fctx.body.push({
      op: "array.copy",
      dstTypeIdx: vecInfo.arrTypeIdx,
      srcTypeIdx: vecInfo.arrTypeIdx,
    });
    fctx.body.push({ op: "local.get", index: restLenLocal });
    fctx.body.push({ op: "local.get", index: restDataLocal });
    fctx.body.push({ op: "struct.new", typeIdx: restType.typeIdx });
    return { fixedParamCount, restExternLocals: [] };
  }

  for (let i = 0; i < Math.min(callArgs.length, fixedParamCount); i++) {
    compileInternalCallArgument(ctx, fctx, callArgs[i]!, info.paramTypes[i]);
  }
  for (let i = callArgs.length; i < fixedParamCount; i++) {
    pushDefaultValue(fctx, info.paramTypes[i]!, ctx);
  }

  const trailingArgs = callArgs.slice(fixedParamCount);
  if (trailingArgs.length === 1 && ts.isSpreadElement(trailingArgs[0]!)) {
    const spreadType = compileExpression(ctx, fctx, trailingArgs[0]!.expression, restType);
    if (spreadType === null) {
      pushDefaultValue(fctx, restType, ctx);
    } else if (!valTypesMatch(spreadType, restType)) {
      coerceType(ctx, fctx, spreadType, restType);
    }
    return { fixedParamCount, restExternLocals: [] };
  }
  if (restType.kind !== "ref" && restType.kind !== "ref_null") {
    pushDefaultValue(fctx, restType, ctx);
    return { fixedParamCount, restExternLocals: [] };
  }
  // TypeScript represents an unused `...rest` parameter as an empty tuple
  // struct rather than the ordinary `(length, data)` vec.  It is still a
  // non-null lifted formal, so padding it with `pushDefaultValue(ref)` emits
  // `ref.null; ref.as_non_null` and traps before the callee can materialize its
  // `arguments` object.  Construct the canonical empty tuple instead; the
  // arguments-object builder treats the parameter as a normal boxed formal.
  const restDef = ctx.mod.types[restType.typeIdx];
  if (restDef?.kind === "struct" && restDef.fields.length === 0) {
    fctx.body.push({ op: "struct.new", typeIdx: restType.typeIdx });
    return { fixedParamCount, restExternLocals: [] };
  }
  const vecInfo = getVecInfo(ctx, restType.typeIdx);
  if (vecInfo === null) {
    pushDefaultValue(fctx, restType, ctx);
    return { fixedParamCount, restExternLocals: [] };
  }

  const restLocals: number[] = [];
  const restExternLocals: number[] = [];
  for (let i = fixedParamCount; i < callArgs.length; i++) {
    const actualType = compileExpression(ctx, fctx, callArgs[i]!, vecInfo.elemType);
    if (actualType === null) pushDefaultValue(fctx, vecInfo.elemType, ctx);
    const restLocal = allocLocal(fctx, `__cc_rest_${fctx.locals.length}`, vecInfo.elemType);
    fctx.body.push({ op: "local.set", index: restLocal });
    restLocals.push(restLocal);

    fctx.body.push({ op: "local.get", index: restLocal });
    coerceType(ctx, fctx, vecInfo.elemType, { kind: "externref" });
    const externLocal = allocLocal(fctx, `__cc_rest_extern_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: externLocal });
    restExternLocals.push(externLocal);
  }
  fctx.body.push({ op: "i32.const", value: restLocals.length });
  for (const restLocal of restLocals) fctx.body.push({ op: "local.get", index: restLocal });
  fctx.body.push({ op: "array.new_fixed", typeIdx: vecInfo.arrTypeIdx, length: restLocals.length });
  fctx.body.push({ op: "struct.new", typeIdx: restType.typeIdx });

  return { fixedParamCount, restExternLocals };
}

/**
 * (#4394) Emit the argument sequence for a call through a MATCHED ClosureInfo
 * (the generic call-of-expression tails in call-tail-dispatch.ts, e.g.
 * `lazyResult(...)(...)`). Rest-aware: when the matched closure's lifted
 * signature ends in a rest VEC param, positional trailing args are packed into
 * that vec via `compileRestClosureArguments` — the old positional emit coerced
 * arg0 straight to the vec param (guarded cast → null) and the callee trapped
 * reading `rest.length` (deepEqual.js `acceptMappers(join)`). The non-rest
 * path is byte-identical to what those call sites emitted inline.
 */
export function emitMatchedClosureCallArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  info: ClosureInfo,
): void {
  const paramCount = info.paramTypes.length;
  const restArgs = info.hasRestParam === true ? compileRestClosureArguments(ctx, fctx, expr, info) : null;
  if (restArgs !== null) {
    fctx.body.push(...buildArgcExtrasSetupFromLocals(ctx, fctx, restArgs.fixedParamCount, restArgs.restExternLocals));
    emitSetArgc(ctx, fctx, expr.arguments.length, restArgs.fixedParamCount);
    return;
  }
  for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
    compileExpression(ctx, fctx, expr.arguments[i]!, info.paramTypes[i]);
  }
  for (let i = expr.arguments.length; i < paramCount; i++) {
    pushDefaultValue(fctx, info.paramTypes[i]!, ctx);
  }
  emitClosureCallArgcExtras(ctx, fctx, expr.arguments, paramCount);
}

/** Compile a call to a closure variable: closureVar(args...) */
export function compileClosureCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  varName: string,
  info: ClosureInfo,
): InnerResult {
  const localIdx = fctx.localMap.get(varName);
  const moduleIdx = localIdx === undefined ? ctx.moduleGlobals.get(varName) : undefined;
  if (localIdx === undefined && moduleIdx === undefined) return null;
  if (process.env.DEBUG_MARKED_CODEGEN === "1" && fctx.name.includes("closure")) {
    console.error(
      "[marked-closure-call-direct]",
      fctx.name,
      varName,
      "local",
      localIdx,
      "module",
      moduleIdx,
      "params",
      info.paramTypes,
      "return",
      info.returnType,
      "funcType",
      info.funcTypeIdx,
    );
  }

  // The lifted function type is authoritative for its self carrier. Shared
  // `__fn_wrap_*` functions use the canonical wrapper root; private/named
  // closure functions retain their concrete self struct. Reading this from the
  // func type avoids reintroducing module-local signature-wrapper order into
  // externref unpacking while preserving the private-closure path.
  const selfStructTypeIdx = getClosureFuncSelfTypeIdx(ctx, info.funcTypeIdx) ?? info.structTypeIdx;

  // Determine how to push the closure ref (local vs module global).
  // If the value is externref (e.g. captured in a __cb_N callback or a module
  // global like `var f; f = () => {...}`), we need to convert to the expected
  // struct ref type before struct.get can be used.
  let effectiveLocalIdx = localIdx;
  if (localIdx !== undefined) {
    const localType =
      localIdx < fctx.params.length ? fctx.params[localIdx]?.type : fctx.locals[localIdx - fctx.params.length]?.type;
    // Boxed capture: the local is a ref cell wrapping the real value. Unwrap
    // it first, then coerce the underlying externref to the closure struct type
    // (#1048).
    const boxed = fctx.boxedCaptures?.get(varName);
    if (boxed) {
      const castType: ValType = { kind: "ref_null", typeIdx: selfStructTypeIdx };
      const castLocal = allocLocal(fctx, `__closure_cast_${fctx.locals.length}`, castType);
      fctx.body.push({ op: "local.get", index: localIdx });
      // struct.get $refCell $value — unwrap to underlying value.
      fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
      // (#3547) The #3024 funcref-cell `struct.new` stopgap that used to live
      // here (rebuild the self carrier when the cell field-0 was a bare
      // funcref) is REMOVED on two grounds, both load-bearing:
      //   1. The one known PRODUCER of funcref-typed "cells" is gone: those
      //      cells were never real ref cells — the variables.ts declaration
      //      path retyped the capture's cell local to the closure STRUCT and
      //      re-registered that struct as `boxed.refCellTypeIdx` (field 0 =
      //      funcref). #3534/#3505 fixed the retype at the source (the
      //      declaration now writes THROUGH the cell and never retypes it).
      //   2. A zero-producer probe in `getOrRegisterRefCellType` (env-gated,
      //      see #3547's issue file for the recipe) confirmed NO ref cell is
      //      minted over funcref or any closure-struct carrier on the
      //      post-#3505 tree — across the closure corpus, dedicated
      //      mutual-recursion shapes, all matcher-invoking files, and the full
      //      `Function/prototype/toString` + class-elements test262 dirs.
      // Cells storing closures are externref cells; the externref arm below
      // unwraps and guard-casts them to the lifted self carrier.
      if (boxed.valType.kind === "externref") {
        fctx.body.push({ op: "any.convert_extern" });
      }
      // (#4307) A direct-eval binding cell holds the runtime-eval carrier once
      // the binding has crossed the seam. Unwrap it back to the closure it
      // wraps, or the guard cast below yields null and the call traps.
      emitRuntimeEvalCarrierUnwrapAny(ctx, fctx);
      emitGuardedRefCast(fctx, selfStructTypeIdx);
      fctx.body.push({ op: "local.set", index: castLocal });
      effectiveLocalIdx = castLocal;
    } else if (localType?.kind === "externref") {
      // Convert externref → anyref → the lifted function's self carrier.
      const castType: ValType = { kind: "ref_null", typeIdx: selfStructTypeIdx };
      const castLocal = allocLocal(fctx, `__closure_cast_${fctx.locals.length}`, castType);
      fctx.body.push({ op: "local.get", index: localIdx });
      fctx.body.push({ op: "any.convert_extern" });
      emitRuntimeEvalCarrierUnwrapAny(ctx, fctx);
      // Guard cast to avoid illegal cast traps (#778)
      emitGuardedRefCast(fctx, selfStructTypeIdx);
      fctx.body.push({ op: "local.set", index: castLocal });
      effectiveLocalIdx = castLocal;
    }
  } else if (moduleIdx !== undefined) {
    // Module global: `var f; f = () => {...}; f(...)` — the global stores
    // externref. Convert to the expected closure struct ref (#852).
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const globalType = globalDef?.type;
    if (globalType?.kind === "externref") {
      const castType: ValType = { kind: "ref_null", typeIdx: selfStructTypeIdx };
      const castLocal = allocLocal(fctx, `__closure_cast_${fctx.locals.length}`, castType);
      fctx.body.push({ op: "global.get", index: moduleIdx });
      fctx.body.push({ op: "any.convert_extern" });
      emitRuntimeEvalCarrierUnwrapAny(ctx, fctx);
      emitGuardedRefCast(fctx, selfStructTypeIdx);
      fctx.body.push({ op: "local.set", index: castLocal });
      effectiveLocalIdx = castLocal;
    }
  }

  const pushClosureRef = () => {
    if (effectiveLocalIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: effectiveLocalIdx });
    } else {
      // (#1730) Re-resolve the module-global index from `ctx.moduleGlobals` on
      // every push instead of reusing the `const moduleIdx` captured at entry.
      // A late string-constant import added while compiling the call arguments
      // (between the receiver push at the top and this funcref-re-resolution
      // push) shifts every module-global index by +1 and rewrites the
      // ALREADY-EMITTED `global.get` in `fctx.body` via `fixupModuleGlobalIndices`
      // (which also updates the `ctx.moduleGlobals` map). The stale captured
      // `moduleIdx` would emit a NEW `global.get` with the pre-shift index
      // AFTER the shift already ran, so the shifter never visits it — the
      // index then points at the late-added string-constant import global and
      // `ref.cast` of that externref to the closure struct traps "illegal cast"
      // (a module-level `const`-bound arrow called internally, #1730). Reading
      // the live map mirrors why `g = f; g(21)` works: the intermediate-local
      // path resolves through a local whose load lands in the outer body the
      // shifter does visit.
      const liveModuleIdx = ctx.moduleGlobals.get(varName) ?? moduleIdx!;
      fctx.body.push({ op: "global.get", index: liveModuleIdx });
    }
    // Null-check → TypeError instead of trap on struct.get (#728, #441)
    emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: selfStructTypeIdx });
  };

  // Stack for call_ref needs: [closure_ref, ...args, funcref]
  // where shared-wrapper lifted funcs use (ref $wrapperRoot, ...args) → results.

  // Push closure ref as first arg (self param of the lifted function)
  pushClosureRef();

  const paramCount = info.paramTypes.length;
  const restArgs = compileRestClosureArguments(ctx, fctx, expr, info);
  if (restArgs === null) {
    for (let i = 0; i < Math.min(expr.arguments.length, paramCount); i++) {
      compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, info.paramTypes[i]);
    }
    for (let i = expr.arguments.length; i < paramCount; i++) {
      pushDefaultValue(fctx, info.paramTypes[i]!, ctx);
    }
  }

  // (#779e/#1511) Overflow args beyond the closure's declared arity are NOT
  // pushed to the wasm stack — instead pack them into `__extras_argv` and set
  // `__argc` so a callee that reads `arguments` sees the true call-site length.
  // emitClosureCallArgcExtras evaluates the overflow args itself (into the
  // global), so we must NOT also evaluate them above. Cleanup after call_ref.
  if (restArgs !== null) {
    fctx.body.push(...buildArgcExtrasSetupFromLocals(ctx, fctx, restArgs.fixedParamCount, restArgs.restExternLocals));
    // buildArgcExtrasSetupFromLocals assumes every fixed slot was filled; an
    // under-arity JS call was not, so overwrite argc with the true clamped
    // call-site count while preserving the already-materialized extras vec.
    emitSetArgc(ctx, fctx, expr.arguments.length, restArgs.fixedParamCount);
  } else {
    emitClosureCallArgcExtras(ctx, fctx, expr.arguments, paramCount);
  }

  // Push the funcref from the closure struct (field 0) and cast to typed ref
  pushClosureRef();
  fctx.body.push({
    op: "struct.get",
    typeIdx: selfStructTypeIdx,
    fieldIdx: 0,
  });
  // Guard funcref cast to avoid illegal cast (#778)
  emitGuardedFuncRefCast(fctx, info.funcTypeIdx);
  emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: info.funcTypeIdx });

  // call_ref with the lifted function's type index
  fctx.body.push({ op: "call_ref", typeIdx: info.funcTypeIdx });

  // (#779e/#1511) Reset __argc / __extras_argv. A callee that doesn't read
  // `arguments` never consumed them and would otherwise leak stale values
  // into the next call that does. Preserve the return value across the reset.
  if (info.returnType === null || info.returnType === undefined) {
    emitResetArgcExtras(ctx, fctx);
  } else {
    const retLocal = allocLocal(fctx, `__cc_ret_${fctx.locals.length}`, info.returnType);
    fctx.body.push({ op: "local.set", index: retLocal });
    emitResetArgcExtras(ctx, fctx);
    fctx.body.push({ op: "local.get", index: retLocal });
  }

  // Return VOID_RESULT for void closures so compileExpression doesn't treat
  // the null return as a compilation failure and roll back the emitted instructions
  return info.returnType ?? VOID_RESULT;
}

/**
 * Handle calls where the property is a getter that returns a callable:
 * c.method(args) where `get method()` returns a function reference.
 *
 * Strategy: check if the getter returns a method of the same class
 * (common pattern: `get method() { return this.#method; }`).
 * If so, call the underlying method directly with the receiver.
 * Otherwise, call the getter and invoke the result via host import.
 */
export function compileGetterCallable(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  receiverClassName: string,
  getterIdx: number,
): InnerResult | undefined {
  // Get the getter's return type from the TS type system to find the call signature
  const propTsType = ctx.checker.getTypeAtLocation(propAccess);
  const callSigs = propTsType.getCallSignatures?.();
  if (!callSigs || callSigs.length === 0) return undefined;

  // The getter returns a callable. Check if we can resolve it to a known method
  // on the same class. Look for common patterns:
  // 1. get method() { return this.#privateMethod; } -> C___priv_privateMethod
  // 2. get method() { return this.otherMethod; } -> C_otherMethod

  // Try to find the underlying method by scanning known method names
  // Pattern: getter for propName might return a private method __priv_propName
  // or the same-named private method
  const methodName = ts.isPrivateIdentifier(propAccess.name)
    ? "__priv_" + propAccess.name.text.slice(1)
    : propAccess.name.text;
  const candidateNames = [
    `${receiverClassName}___priv_${methodName}`, // get method -> this.#method
    `${receiverClassName}_${methodName}`, // get method -> this.method (self-reference unlikely but check)
  ];
  // Also check all ancestor classes
  let ancestor = ctx.classParentMap.get(receiverClassName);
  while (ancestor) {
    candidateNames.push(`${ancestor}___priv_${methodName}`);
    candidateNames.push(`${ancestor}_${methodName}`);
    ancestor = ctx.classParentMap.get(ancestor);
  }

  for (const candidateName of candidateNames) {
    const candidateIdx = ctx.funcMap.get(candidateName);
    if (candidateIdx === undefined) continue;

    // Found the underlying method. Call it directly: C___priv_method(receiver, ...args)
    // or C___priv_method(...args) for static methods (no self parameter).
    const structTypeIdx = ctx.structMap.get(receiverClassName);
    const paramTypes = getFuncParamTypes(ctx, candidateIdx);
    // Static methods have no self parameter — their Wasm signature starts with
    // the first user argument. Treating them as instance methods here produced
    // `methodParamCount = -1` for zero-arg statics, which then iterated
    // `expr.arguments[-1]` (undefined) through `compileExpression` and
    // surfaced as "unexpected undefined AST node" during the compile of
    // static-private-generator getter chains (#1162).
    const isStatic = ctx.staticMethodSet.has(candidateName);

    if (isStatic) {
      // Evaluate receiver for side effects, then drop — static methods don't
      // take a self parameter. Matches the isStaticMethod branch in
      // compileCallExpression (calls.ts #2929 path).
      const recvType = compileExpression(ctx, fctx, propAccess.expression);
      if (recvType !== null) {
        fctx.body.push({ op: "drop" });
      }
    } else {
      const recvTypeHint = paramTypes?.[0];
      const recvType = compileExpression(ctx, fctx, propAccess.expression, recvTypeHint);

      // Coerce receiver to match the function's first parameter type
      if (recvType && recvTypeHint) {
        if (
          recvType.kind === "externref" &&
          (recvTypeHint.kind === "ref" || recvTypeHint.kind === "ref_null") &&
          structTypeIdx !== undefined
        ) {
          // externref -> struct: convert via any.convert_extern + guarded cast
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, structTypeIdx);
        } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvTypeHint.kind === "externref") {
          // struct -> externref: convert via extern.convert_any
          fctx.body.push({ op: "extern.convert_any" });
        } else if (recvType.kind !== recvTypeHint.kind) {
          // General type mismatch: use coerceType
          coerceType(ctx, fctx, recvType, recvTypeHint);
        }
      } else if (
        recvType &&
        recvType.kind === "externref" &&
        structTypeIdx !== undefined &&
        recvTypeHint === undefined
      ) {
        // Fallback: no param type info but we know the struct — cast to struct
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, structTypeIdx);
      }
    }

    // For static methods, Wasm params are exactly the user args; for instance
    // methods, param 0 is self so user args start at paramTypes[1].
    const selfOffset = isStatic ? 0 : 1;
    const methodParamCount = paramTypes ? Math.max(0, paramTypes.length - selfOffset) : expr.arguments.length;
    for (let i = 0; i < Math.min(expr.arguments.length, methodParamCount); i++) {
      compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + selfOffset]);
    }
    // Pad missing arguments
    if (paramTypes) {
      for (let i = Math.min(expr.arguments.length, methodParamCount) + selfOffset; i < paramTypes.length; i++) {
        pushDefaultValue(fctx, paramTypes[i]!, ctx);
      }
    }

    // (#779e/#1511) Overflow args beyond the method's declared arity go into
    // `__extras_argv` (with `__argc`) so a callee reading `arguments` sees the
    // true call-site length. emitClosureCallArgcExtras evaluates the overflow
    // args itself, so we must NOT also drop-evaluate them above.
    emitClosureCallArgcExtras(ctx, fctx, expr.arguments, methodParamCount);

    // Re-lookup: receiver/arg compilation may have triggered late imports
    // (e.g. emitUndefined for missing tuple elements) that shift function indices.
    const finalCandidateIdx = ctx.funcMap.get(candidateName) ?? candidateIdx;
    fctx.body.push({ op: "call", funcIdx: finalCandidateIdx });
    // Reset globals so a callee that doesn't read `arguments` can't leak stale
    // extras into the next call. Preserve the return value across the reset.
    {
      const retWasm = getWasmFuncReturnType(ctx, finalCandidateIdx);
      if (retWasm && !wasmFuncReturnsVoid(ctx, finalCandidateIdx)) {
        const retLocal = allocLocal(fctx, `__gc_ret_${fctx.locals.length}`, retWasm);
        fctx.body.push({ op: "local.set", index: retLocal });
        emitResetArgcExtras(ctx, fctx);
        fctx.body.push({ op: "local.get", index: retLocal });
      } else {
        emitResetArgcExtras(ctx, fctx);
      }
    }

    // Determine return type
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (isEffectivelyVoidReturn(ctx, retType, candidateName)) return VOID_RESULT;
      if (wasmFuncReturnsVoid(ctx, finalCandidateIdx)) return VOID_RESULT;
      return getWasmFuncReturnType(ctx, finalCandidateIdx) ?? resolveWasmType(ctx, retType);
    }
    return getWasmFuncReturnType(ctx, finalCandidateIdx) ?? VOID_RESULT;
  }

  return undefined; // Couldn't resolve to a known method
}

/**
 * Object.prototype method fallback for known class instances (#799 WI1).
 *
 * When a method call like `obj.toString()` cannot be resolved on a user-defined
 * class or its ancestors, this function checks if the method is an Object.prototype
 * method and emits host-delegated code via externref conversion.
 */
export function compileObjectPrototypeFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  receiverClassName: string,
  methodName: string,
): InnerResult | undefined {
  const compileReceiverAsExternref = (): void => {
    const receiverType = compileExpression(ctx, fctx, propAccess.expression);
    if (receiverType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (receiverType.kind !== "externref" && receiverType.kind !== "ref_extern") {
      coerceType(ctx, fctx, receiverType, { kind: "externref" });
    }
  };

  // toString: coerce receiver to externref and call __extern_toString
  if (methodName === "toString") {
    const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (toStrIdx !== undefined) {
      // A nominal class expression can be loaded through dynamic storage and
      // therefore emit externref. Convert the actual compiled representation
      // rather than blindly assuming a WasmGC class ref (#3999).
      compileReceiverAsExternref();
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      return { kind: "externref" };
    }
    return undefined;
  }

  // toLocaleString: delegate to toString (ES spec default behavior)
  if (methodName === "toLocaleString") {
    const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (toStrIdx !== undefined) {
      compileReceiverAsExternref();
      fctx.body.push({ op: "call", funcIdx: toStrIdx });
      return { kind: "externref" };
    }
    return undefined;
  }

  // valueOf: return the receiver itself (Object.prototype.valueOf returns this)
  if (methodName === "valueOf") {
    compileReceiverAsExternref();
    return { kind: "externref" };
  }

  // hasOwnProperty: delegate to __hasOwnProperty host import
  if (methodName === "hasOwnProperty") {
    const hopIdx = ensureLateImport(
      ctx,
      "__hasOwnProperty",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (hopIdx !== undefined) {
      compileReceiverAsExternref();
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: hopIdx });
      return { kind: "i32" };
    }
    return undefined;
  }

  // propertyIsEnumerable: delegate to __propertyIsEnumerable host import
  if (methodName === "propertyIsEnumerable") {
    const pieIdx = ensureLateImport(
      ctx,
      "__propertyIsEnumerable",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (pieIdx !== undefined) {
      compileReceiverAsExternref();
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: pieIdx });
      return { kind: "i32" };
    }
    return undefined;
  }

  // isPrototypeOf: delegate to host __isPrototypeOf
  if (methodName === "isPrototypeOf") {
    const ipIdx = ensureLateImport(
      ctx,
      "__isPrototypeOf",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (ipIdx !== undefined) {
      compileReceiverAsExternref();
      if (expr.arguments.length > 0) {
        compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: ipIdx });
      return { kind: "i32" };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Handle calls to callable struct fields: obj.callback() where callback
 * is a function-typed property stored in a struct field (not a method).
 * Returns undefined if the property is not a callable struct field,
 * allowing the caller to fall through to other handling.
 */
export function compileCallablePropertyCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  className: string,
  precompiledReceiver?: { localIdx: number; type: ValType },
): InnerResult | undefined {
  const methodName = ts.isPrivateIdentifier(propAccess.name)
    ? "__priv_" + propAccess.name.text.slice(1)
    : propAccess.name.text;

  if (
    process.env.DEBUG_MARKED_CODEGEN === "1" &&
    (fctx.name.includes("debugMarkedDynamicFunctionFieldObjectLiteral") || methodName === "preprocess")
  ) {
    console.error("[marked-callable-enter]", fctx.name, className, methodName);
  }

  // (#2875 b2) `o.charAt(1)` where `o`'s literal seeded `charAt` from
  // `String.prototype.charAt` — the arity-filtered dispatch below can never
  // match that lifted `(self, this, …args)` closure. See
  // transferred-native-proto-call.ts; declines silently for every other shape.
  const transferred = tryEmitTransferredNativeProtoMethodCall(ctx, fctx, expr, propAccess);
  if (transferred !== undefined) return transferred;

  // (#1712) Function-style-constructor instances NEVER carry their prototype
  // methods as struct fields: compileFnctorNew synthesizes the runtime
  // instance struct from ctor `this.*` writes only, while the TS checker's
  // shape (className here) models prototype-assigned methods as instance
  // members. The guarded receiver cast below can therefore never match (the
  // two shapes have no subtype relation) — the cast nulls out and the
  // `struct.get` traps "dereferencing a null pointer" (acorn:
  // `new this(options, input).parse()` in the static `Parser.parse`). Route
  // the call through dynamic dispatch instead. JS-host resolves the closure's
  // vivified prototype; approved standalone fnctors resolve through their
  // native per-fnctor `$Object` prototype and invoke with `__apply_closure`.
  // The funcConstructorMap check covers already-compiled fnctors and the
  // declaration check covers compile-order races (member call compiled before
  // the first `new`).
  if (!ctx.wasi && !ts.isPrivateIdentifier(propAccess.name)) {
    const recvTsType = ctx.checker.getTypeAtLocation(propAccess.expression);
    const recvSym = recvTsType?.symbol;
    const decl = recvSym?.valueDeclaration;
    const isFnCtorInstance =
      ctx.funcConstructorMap.has(className) ||
      (recvSym?.name !== undefined && ctx.funcConstructorMap.has(recvSym.name)) ||
      (!!decl &&
        (ts.isFunctionDeclaration(decl) ||
          ts.isFunctionExpression(decl) ||
          (ts.isVariableDeclaration(decl) && !!decl.initializer && ts.isFunctionExpression(decl.initializer))));
    const approvedStandaloneFnctor =
      ctx.standalone &&
      (ctx.fnctorEscapeGate?.approvedNames.has(className) === true ||
        (recvSym?.name !== undefined && ctx.fnctorEscapeGate?.approvedNames.has(recvSym.name) === true));
    if (isFnCtorInstance && (!ctx.standalone || approvedStandaloneFnctor)) {
      if (ctx.standalone) {
        const dyn = emitFnctorSubclassDynamicMethodCall(ctx, fctx, expr, propAccess, methodName);
        if (dyn !== undefined) return dyn;
      } else {
        const dyn = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, methodName, expr);
        if (dyn !== null) return dyn;
      }
    }
  }

  // Check if this property name is a struct field
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return undefined;

  const fieldIdx = fields.findIndex((f) => f.name === methodName);
  if (fieldIdx === -1) return undefined;

  const fieldType = fields[fieldIdx]!.type;
  // (#1734) Compile the receiver and extract the callable field.
  //
  // The receiver expression's compiled wasm type can disagree with the resolved
  // struct type `structTypeIdx`: a receiver that is itself a call (e.g. a lifted
  // closure / static factory whose declared return is `externref` but whose body
  // returns a wider struct, or simply a method returning the object as externref)
  // leaves an `externref` (or a different struct ref) on the stack. Emitting
  // `struct.get structTypeIdx` directly on that value is ill-typed and fails Wasm
  // validation (`struct.get expected (ref null N), found … M`). Route the value
  // through `any.convert_extern` (when externref) + a `ref.test`-guarded cast to
  // `structTypeIdx`, mirroring the guarded cast already used for the closure
  // field itself below, so the `struct.get` operand is always the right struct.
  // An object-literal property holding a `this`-reading function expression is
  // called with the CLOSURE ref as `self` and no receiver, so `this` inside it
  // read `undefined` — see object-literal-method-receiver.ts. `bind` is
  // `undefined` (and no local is allocated) for every other shape, which is what
  // keeps their emitted bytes unchanged. Each arm plans it immediately before
  // compiling the receiver, so the capture below rides the ONE evaluation.
  let bind: ObjectLiteralMethodReceiverBind | undefined;

  const compileReceiver = (expectedType?: ValType): ValType | null => {
    if (precompiledReceiver === undefined) {
      return compileExpression(ctx, fctx, propAccess.expression, expectedType);
    }
    fctx.body.push({ op: "local.get", index: precompiledReceiver.localIdx });
    if (expectedType !== undefined && !valTypesMatch(precompiledReceiver.type, expectedType)) {
      coerceType(ctx, fctx, precompiledReceiver.type, expectedType);
      return expectedType;
    }
    return precompiledReceiver.type;
  };

  const compileCallableFieldValue = (): void => {
    const recvResult = compileReceiver();
    if (bind) {
      const recvType = recvResult === null || typeof recvResult === "symbol" ? undefined : recvResult;
      if (!recvType || !captureObjectLiteralMethodReceiver(fctx, recvType, bind)) bind = undefined;
    }
    // Already exactly the target struct type (or its nullable form) — retain
    // the direct field read.
    if (
      recvResult &&
      (recvResult.kind === "ref" || recvResult.kind === "ref_null") &&
      (recvResult as { typeIdx: number }).typeIdx === structTypeIdx
    ) {
      emitNullGuardedStructGet(ctx, fctx, recvResult, fieldType, structTypeIdx, fieldIdx, methodName, true);
      return;
    }
    // A JavaScript property may be replaced with an object of another closed
    // shape. The field's stable carrier is then externref even though the
    // checker still describes the original literal. Dispatch the read across
    // every runtime shape instead of guarded-casting to the stale shape and
    // immediately applying a bare struct.get to the resulting null. ReactDOM's
    // shared dispatcher does exactly this (`Internals.d = { f, ... }`) before
    // `flushSync` calls `Internals.d.f()`.
    if (recvResult && recvResult.kind === "externref") {
      emitExternrefToStructGet(ctx, fctx, fieldType, structTypeIdx, fieldIdx, methodName, true);
      return;
    }
    // A different struct ref can likewise be another valid closed shape.
    if (recvResult && (recvResult.kind === "ref" || recvResult.kind === "ref_null")) {
      emitNullGuardedStructGet(
        ctx,
        fctx,
        { kind: "ref_null", typeIdx: recvResult.typeIdx },
        fieldType,
        structTypeIdx,
        fieldIdx,
        methodName,
        true,
      );
      return;
    }
    // Anything else (primitive / void) — leave the stack as the legacy bare
    // `struct.get` path expected; guarding a non-reference operand would itself
    // be ill-typed. This preserves prior behavior for shapes that never reach
    // the #1734 mismatch.
  };

  // The field must be a callable type — check via TS type checker
  const propTsType = ctx.checker.getTypeAtLocation(propAccess);
  let callSigs = propTsType.getCallSignatures?.();
  if (!callSigs || callSigs.length === 0) {
    // Field typed as `Fn | null` / `Fn | undefined` — strip nullable
    // members and retry. Storage is externref either way (#1298).
    const nonNull = ctx.checker.getNonNullableType(propTsType);
    callSigs = nonNull.getCallSignatures?.();
  }
  if (!callSigs || callSigs.length === 0) {
    // Published JavaScript often declares a class field without a type and
    // installs its closure through a computed write (`this[name] = (...) =>`),
    // so TypeScript cannot recover a call signature for the named field. The
    // runtime field still carries the real closure. On the JS-host lane, call
    // it through the ordinary host method bridge instead of letting the
    // downstream graceful fallback silently drop the invocation.
    if (fieldType.kind === "externref" && !noJsHost(ctx)) {
      const dynamic = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, methodName, expr);
      if (dynamic !== null) return dynamic;
    }
    return undefined;
  }

  const sig = callSigs[0]!;
  const sigParameters = runtimeSignatureParameters(sig);
  const sigParamCount = sigParameters.length;
  const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
  const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
  const sigParamWasmTypes: ValType[] = [];
  for (let i = 0; i < sigParamCount; i++) {
    const paramType = ctx.checker.getTypeOfSymbol(sigParameters[i]!);
    sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
  }

  // A structural contract asserted over a live realm-global capability keeps
  // an open externref carrier (#4376). Its callable properties are likewise
  // live JavaScript properties: the function installed at runtime need not use
  // the wrapper ABI inferred from the erased TypeScript signature. Fetch the
  // exact property value before evaluating arguments, retain the original
  // receiver for `this`, and invoke through the native dynamic-closure bridge.
  //
  // This is intentionally restricted to the declaration-proven carrier above
  // and fixed argument lists. Ordinary closed structs retain the typed
  // call_ref path, while a dynamic spread stays on the existing fallback until
  // it has a value-preserving ObjVec concat.
  if (
    (ctx.standalone || ctx.wasi) &&
    !expr.arguments.some((argument) => ts.isSpreadElement(argument)) &&
    expr.arguments.length <= REALM_DYNAMIC_CALL_MAX_ARITY &&
    expressionDescendsFromRealmStructuralBinding(ctx, fctx, propAccess.expression)
  ) {
    const { newIdx: objVecNewIdx, pushIdx: objVecPushIdx } = ensureObjVecBuilders(ctx);
    const applyClosureIdx = reserveApplyClosure(ctx);
    addStringConstantGlobal(ctx, methodName);
    flushLateImportShifts(ctx, fctx);
    const externGetIdx = ctx.funcMap.get("__extern_get");
    if (externGetIdx !== undefined) {
      const receiverType = compileReceiver({ kind: "externref" });
      if (receiverType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      } else if (receiverType.kind !== "externref") {
        coerceType(ctx, fctx, receiverType, { kind: "externref" });
      }
      const receiverLocal = allocLocal(fctx, `__realm_call_recv_${fctx.locals.length}`, {
        kind: "externref",
      });
      fctx.body.push({ op: "local.set", index: receiverLocal });

      fctx.body.push({ op: "local.get", index: receiverLocal });
      fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx });
      const calleeLocal = allocLocal(fctx, `__realm_call_fn_${fctx.locals.length}`, {
        kind: "externref",
      });
      fctx.body.push({ op: "local.set", index: calleeLocal });

      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? objVecNewIdx });
      const argsLocal = allocLocal(fctx, `__realm_call_args_${fctx.locals.length}`, {
        kind: "externref",
      });
      fctx.body.push({ op: "local.set", index: argsLocal });
      for (const argument of expr.arguments) {
        fctx.body.push({ op: "local.get", index: argsLocal });
        const argumentType = compileExpression(ctx, fctx, argument, { kind: "externref" });
        if (argumentType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (argumentType.kind !== "externref") {
          coerceType(ctx, fctx, argumentType, { kind: "externref" });
        }
        fctx.body.push({
          op: "call",
          funcIdx: ctx.funcMap.get("__objvec_push") ?? objVecPushIdx,
        });
      }

      fctx.body.push({ op: "local.get", index: calleeLocal });
      fctx.body.push({ op: "local.get", index: receiverLocal });
      fctx.body.push({ op: "local.get", index: argsLocal });
      fctx.body.push({
        op: "call",
        funcIdx: ctx.funcMap.get("__apply_closure") ?? applyClosureIdx,
      });
      return { kind: "externref" };
    }
  }

  // A synthetic wrapper derived from a field's call signature cannot encode
  // whether its final vec parameter came from source `...rest` or was an
  // explicit array parameter. If a real stored closure of the same signature
  // is variadic, the static wrapper path would pass the final positional value
  // as the vec itself and lose every trailing argument. Let the host bridge
  // inspect the actual closure allocation and use the rest-aware dispatcher.
  if (
    fieldType.kind === "externref" &&
    !noJsHost(ctx) &&
    [...ctx.closureInfoByTypeIdx.values()].some(
      (candidate) =>
        candidate.hasRestParam === true &&
        candidate.paramTypes.length === sigParamWasmTypes.length &&
        candidate.paramTypes.every((param, index) => valTypesMatch(param, sigParamWasmTypes[index]!)),
    )
  ) {
    const dynamic = emitWrapperDynamicMethodCall(ctx, fctx, propAccess.expression, methodName, expr);
    if (dynamic !== null) return dynamic;
  }

  // If the field is a ref type, check if it's a known closure struct
  if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
    const closureInfo = ctx.closureInfoByTypeIdx.get((fieldType as { typeIdx: number }).typeIdx);
    if (closureInfo) {
      // Compile receiver (normalized to the struct type, #1734), get field value.
      bind = planObjectLiteralMethodReceiverBind(ctx, fctx, propAccess.name);
      compileCallableFieldValue();

      const closureLocal = allocLocal(fctx, `__cprop_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as first arg (self param) — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }

      const restArgs = compileRestClosureArguments(ctx, fctx, expr, closureInfo);
      if (restArgs === null) {
        // Push call arguments (only up to declared param count)
        const cpParamCount = closureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, cpParamCount); i++) {
          compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
        }
        // Drop excess arguments beyond param count (side effects only)
        for (let i = cpParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
        // Pad missing arguments
        for (let i = expr.arguments.length; i < closureInfo.paramTypes.length; i++) {
          pushDefaultValue(fctx, closureInfo.paramTypes[i]!, ctx);
        }
      }

      // Get funcref from closure struct field 0 and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      fctx.body.push({
        op: "struct.get",
        typeIdx: (fieldType as { typeIdx: number }).typeIdx,
        fieldIdx: 0,
      });
      // Guard funcref cast to avoid illegal cast (#778)
      emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
      // Install the receiver LAST — after the arguments, which may themselves
      // read the caller's `this` through the same global.
      if (bind) emitObjectLiteralMethodThisInstall(ctx, fctx, bind);
      fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

      return finishObjectLiteralMethodCall(ctx, fctx, bind, closureInfo.returnType ?? VOID_RESULT);
    }
  }

  // Field is externref — try to find or create matching closure wrapper types
  if (fieldType.kind === "externref") {
    const resultTypes = sigRetWasm ? [sigRetWasm] : [];
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, resultTypes);

    if (
      process.env.DEBUG_MARKED_CODEGEN === "1" &&
      (fctx.name.includes("debugMarkedDynamicFunctionFieldObjectLiteral") || methodName === "preprocess")
    ) {
      console.error(
        "[marked-callable-field]",
        fctx.name,
        className,
        methodName,
        "struct",
        structTypeIdx,
        "field",
        fieldIdx,
        "fieldType",
        fieldType,
        "sigParams",
        sigParamWasmTypes,
        "sigRet",
        sigRetWasm,
        "wrapper",
        wrapperTypes && {
          structTypeIdx: wrapperTypes.structTypeIdx,
          funcTypeIdx: wrapperTypes.closureInfo.funcTypeIdx,
          returnType: wrapperTypes.closureInfo.returnType,
        },
        "closures",
        [...ctx.closureInfoByTypeIdx.values()]
          .filter((candidate) => candidate.paramTypes.length === sigParamWasmTypes.length)
          .map((candidate) => ({
            structTypeIdx: candidate.structTypeIdx,
            funcTypeIdx: candidate.funcTypeIdx,
            returnType: candidate.returnType,
          })),
      );
    }

    if (wrapperTypes) {
      const { structTypeIdx: wrapperStructIdx, closureInfo: matchedClosureInfo } = wrapperTypes;

      // (#3205) Candidate set: the declared wrapper + every same-arity closure
      // whose funcref type differs (covariant return / activated async closure).
      // A byte-neutral read of ctx.closureInfoByTypeIdx (no emission).
      const funcCandidates = buildClosureFuncCandidates(
        ctx,
        {
          funcTypeIdx: matchedClosureInfo.funcTypeIdx,
          structTypeIdx: wrapperStructIdx,
          returnType: matchedClosureInfo.returnType,
        },
        sigParamCount,
        sigParamWasmTypes,
      );

      // Compile receiver (normalized to the struct type, #1734), get field value.
      bind = planObjectLiteralMethodReceiverBind(ctx, fctx, propAccess.name);
      compileCallableFieldValue();

      if (funcCandidates.length <= 1) {
        // ── Single-candidate path ──
        // The only closure of this arity in the module is the declared
        // signature, so dispatch needs only one funcref test. The wrapper itself
        // still crosses an externref boundary and must normalize to the lifted
        // function's self carrier (canonical root for shared wrapper funcs), not
        // the module-local per-signature allocation wrapper.
        const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, matchedClosureInfo.funcTypeIdx) ?? wrapperStructIdx;
        const closureRefType: ValType = {
          kind: "ref_null",
          typeIdx: selfTypeIdx,
        };
        const closureLocal = allocLocal(fctx, `__cprop_ext_${fctx.locals.length}`, closureRefType);
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, selfTypeIdx);
        fctx.body.push({ op: "local.set", index: closureLocal });

        // Push closure ref as first arg (self param) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, closureRefType);

        // Push call arguments (only up to declared param count)
        {
          const wpParamCount = matchedClosureInfo.paramTypes.length;
          for (let i = 0; i < Math.min(expr.arguments.length, wpParamCount); i++) {
            compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
          }
          for (let i = wpParamCount; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) {
              fctx.body.push({ op: "drop" });
            }
          }
        }
        // Pad missing arguments
        for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
          pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
        }

        // Get funcref from closure struct and call_ref — null-check → TypeError (#728)
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
        if (bind) emitObjectLiteralMethodThisInstall(ctx, fctx, bind);
        fctx.body.push({
          op: "call_ref",
          typeIdx: matchedClosureInfo.funcTypeIdx,
        });

        return finishObjectLiteralMethodCall(ctx, fctx, bind, matchedClosureInfo.returnType ?? VOID_RESULT);
      }

      // ── (#3205) Multi-candidate order-independent dispatch ──
      // The value's actual wrapper may be a different root-child sibling than
      // the declared wrapper (covariant return, activated async closure). Cast to
      // the wrapper ROOT (supertype of every wrapper), fetch the funcref off the
      // root, and dispatch on its exact type. When the field's declared return is
      // Promise<T> but a stored async closure yields the raw Promise (externref),
      // widen the dispatch result to externref so the Promise flows through
      // intact (mirrors calls.ts #2174).
      const calleeIsAsync = isPromiseType(sigRetType);
      const expectedReturn: ValType | null = calleeIsAsync ? { kind: "externref" } : matchedClosureInfo.returnType;
      const rootIdx = getFuncRefWrapperRootTypeIdx(ctx) ?? wrapperStructIdx;
      const rootRefType: ValType = { kind: "ref_null", typeIdx: rootIdx };
      const closureLocal = allocLocal(fctx, `__cprop_ext_${fctx.locals.length}`, rootRefType);
      fctx.body.push({ op: "any.convert_extern" });
      emitGuardedRefCast(fctx, rootIdx);
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Null-check self while the guarded-cast backup is still the raw externref
      // (compiling args below overwrites __lastGuardedCastBackup). The value is
      // re-pushed per dispatch arm, so drop the on-stack copy this leaves.
      fctx.body.push({ op: "local.get", index: closureLocal });
      emitNullCheckThrow(ctx, fctx, rootRefType);
      fctx.body.push({ op: "drop" });

      // Save args to locals so each dispatch arm can re-push them.
      const argLocals = collectPropertyCallArgLocals(ctx, fctx, expr, matchedClosureInfo.paramTypes, false);

      // (#4373) A property value can be a lower-arity JavaScript closure whose
      // body reads `arguments`. Preserve every overflow value and the exact
      // call-site count instead of dropping the values before the funcref
      // ladder. All candidates in this ladder share the declared formal arity,
      // so one setup is valid for every arm.
      emitClosureCallArgcExtras(ctx, fctx, expr.arguments, matchedClosureInfo.paramTypes.length);

      // After the args (they may read the caller's `this`), before the ladder.
      if (bind) emitObjectLiteralMethodThisInstall(ctx, fctx, bind);
      emitRootFuncrefDispatch(ctx, fctx, closureLocal, rootIdx, funcCandidates, argLocals, expectedReturn);

      // A target that does not itself read `arguments` leaves the module
      // globals untouched. Clear them after the indirect call while preserving
      // its result on the stack.
      if (expectedReturn === null) {
        emitResetArgcExtras(ctx, fctx);
      } else {
        const returnLocal = allocLocal(fctx, `__cp_ret_${fctx.locals.length}`, expectedReturn);
        fctx.body.push({ op: "local.set", index: returnLocal });
        emitResetArgcExtras(ctx, fctx);
        fctx.body.push({ op: "local.get", index: returnLocal });
      }
      return finishObjectLiteralMethodCall(ctx, fctx, bind, expectedReturn ?? VOID_RESULT);
    }
  }

  // For ref types that aren't known closures, try matching against registered closure types
  if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
    // Try to find a matching closure type by signature
    let matchedClosureInfo: ClosureInfo | undefined;
    let matchedStructTypeIdx: number | undefined;

    for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
      if (info.paramTypes.length !== sigParamCount) continue;
      if (sigRetWasm === null && info.returnType !== null) continue;
      if (sigRetWasm !== null && info.returnType === null) continue;
      if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
      let paramsMatch = true;
      for (let i = 0; i < sigParamCount; i++) {
        if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
          paramsMatch = false;
          break;
        }
      }
      if (paramsMatch) {
        matchedClosureInfo = info;
        matchedStructTypeIdx = typeIdx;
        break;
      }
    }

    if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
      // Compile receiver, get field value
      bind = planObjectLiteralMethodReceiverBind(ctx, fctx, propAccess.name);
      const recvResult = compileExpression(ctx, fctx, propAccess.expression);
      if (bind) {
        const recvType = recvResult === null || typeof recvResult === "symbol" ? undefined : recvResult;
        if (!recvType || !captureObjectLiteralMethodReceiver(fctx, recvType, bind)) bind = undefined;
      }
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      const closureLocal = allocLocal(fctx, `__cprop_ref_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.set", index: closureLocal });

      // Push closure ref as self — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      // May need to cast to matching struct type — guard with ref.test (#778)
      if ((fieldType as { typeIdx: number }).typeIdx !== matchedStructTypeIdx) {
        emitGuardedRefCast(fctx, matchedStructTypeIdx!);
      }

      // Push call arguments (only up to declared param count)
      {
        const cpRefParamCount = matchedClosureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, cpRefParamCount); i++) {
          compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, matchedClosureInfo.paramTypes[i]);
        }
        for (let i = cpRefParamCount; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
          if (extraType !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
      for (let i = expr.arguments.length; i < matchedClosureInfo.paramTypes.length; i++) {
        pushDefaultValue(fctx, matchedClosureInfo.paramTypes[i]!, ctx);
      }

      // Get funcref and call_ref — null-check → TypeError (#728)
      fctx.body.push({ op: "local.get", index: closureLocal });
      if (fieldType.kind === "ref_null") {
        emitNullCheckThrow(ctx, fctx, fieldType);
      }
      if ((fieldType as { typeIdx: number }).typeIdx !== matchedStructTypeIdx) {
        emitGuardedRefCast(fctx, matchedStructTypeIdx!);
      }
      fctx.body.push({
        op: "struct.get",
        typeIdx: matchedStructTypeIdx,
        fieldIdx: 0,
      });
      // Guard funcref cast to avoid illegal cast (#778)
      emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
      emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });
      if (bind) emitObjectLiteralMethodThisInstall(ctx, fctx, bind);
      fctx.body.push({
        op: "call_ref",
        typeIdx: matchedClosureInfo.funcTypeIdx,
      });

      return finishObjectLiteralMethodCall(ctx, fctx, bind, matchedClosureInfo.returnType ?? VOID_RESULT);
    }
  }

  return undefined;
}

/**
 * Handle calls where the callee is an element-access expression on a value
 * whose element type has TS call signatures: `arr[i](args)`, `arr[const](args)`,
 * `arr["0"](args)`. This mirrors the externref-field branch of
 * `compileCallablePropertyCall` but routes through the existing element-access
 * codegen for the receiver, so it works for vec-of-callable, ref-of-callable,
 * tuple-of-callable, and any other element-access shape.
 *
 * Returns undefined when the element type has no call signature (e.g. native
 * `i32[]` / `f64[]`), letting the caller fall through to the historical
 * `ref.null.extern; drop` fallback.
 *
 * #1306: `mws[idx](c, next)` on a closure-typed array previously dropped the
 * call. With this helper the value is loaded via __vec_get / array.get, unboxed
 * (externref → __fn_wrap struct) and dispatched via call_ref.
 */
export function compileCallableElementAccessCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  elemAccess: ts.ElementAccessExpression,
): InnerResult | undefined {
  // `%Function.prototype%[@@hasInstance]` is a native method closure whose
  // first user parameter is the dynamic `this` receiver. The generic element
  // call path treats the value as an ordinary one-argument closure and thus
  // drops that receiver, selecting the wrong lifted signature (and eventually
  // calling a null funcref). Bind the receiver explicitly and call the native
  // closure ABI directly; this is deliberately limited to the statically
  // resolvable Function-prototype symbol and standalone mode.
  if (
    ctx.standalone &&
    resolveComputedKeyExpression(ctx, elemAccess.argumentExpression) === FUNCTION_PROTO_HAS_INSTANCE_MEMBER
  ) {
    const receiver = elemAccess.expression;
    const fact = ctx.oracle.typeFactOf(receiver);
    const directFunctionProto =
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === "prototype" &&
      ts.isIdentifier(receiver.expression) &&
      receiver.expression.text === "Function" &&
      !fctx.localMap.has("Function") &&
      !(fctx.boxedCaptures?.has("Function") ?? false);
    const sourceText = elemAccess.getSourceFile().text;
    const hasCustomPrototype =
      sourceText.includes("prototype") && (sourceText.includes("defineProperty") || /\.prototype\s*=/.test(sourceText));
    if (
      (fact.kind === "function" || (fact.kind === "builtin" && fact.name === "Function") || directFunctionProto) &&
      !hasCustomPrototype
    ) {
      ensureFunctionProtoEdge(ctx, fctx, receiver);
      const receiverType = compileExpression(ctx, fctx, receiver, { kind: "externref" });
      if (receiverType !== null) {
        if (receiverType.kind !== "externref") coerceType(ctx, fctx, receiverType, { kind: "externref" });
        const receiverLocal = allocLocal(fctx, `__has_instance_recv_${fctx.locals.length}`, {
          kind: "externref",
        });
        fctx.body.push({ op: "local.set", index: receiverLocal });

        const brand = ensureFunctionNativeProtoGlue(ctx);
        const closure =
          brand === undefined
            ? null
            : ensureStandaloneNativeMethodClosure(ctx, brand, FUNCTION_PROTO_HAS_INSTANCE_MEMBER, "method", {
                refusalBodyFallback: true,
              });
        const closureInfo = closure ? ctx.closureInfoByTypeIdx.get(closure.type.typeIdx) : undefined;
        if (closure && closureInfo) {
          const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, closureInfo.funcTypeIdx) ?? closure.type.typeIdx;
          const closureLocal = allocLocal(fctx, `__has_instance_fn_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx: selfTypeIdx,
          });
          fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
          fctx.body.push({ op: "extern.convert_any" });
          emitGuardedRefCast(fctx, selfTypeIdx);
          fctx.body.push({ op: "local.set", index: closureLocal });

          // Native-method ABI: (closure self, this, value). Extra source
          // arguments are evaluated for side effects and ignored by the
          // one-parameter @@hasInstance operation.
          fctx.body.push({ op: "local.get", index: closureLocal });
          fctx.body.push({ op: "local.get", index: receiverLocal });
          if (expr.arguments.length > 0) {
            const argType = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
            if (argType !== null && argType.kind !== "externref") coerceType(ctx, fctx, argType, { kind: "externref" });
          } else {
            pushDefaultValue(fctx, { kind: "externref" }, ctx);
          }
          for (let i = 1; i < expr.arguments.length; i++) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "local.get", index: closureLocal });
          fctx.body.push({ op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 });
          emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
          emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
          fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
          return closureInfo.returnType ?? VOID_RESULT;
        }
      }
    }
  }

  // 1. Resolve element type's call signatures (with NonNullable fallback)
  const elemTsType = ctx.checker.getTypeAtLocation(elemAccess);
  let callSigs = elemTsType.getCallSignatures?.();
  if (!callSigs || callSigs.length === 0) {
    const nn = ctx.checker.getNonNullableType(elemTsType);
    callSigs = nn.getCallSignatures?.();
  }
  if (!callSigs || callSigs.length === 0) return undefined;

  const sig = callSigs[0]!;
  const sigParamCount = sig.parameters.length;
  const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
  const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
  const sigParamWasmTypes: ValType[] = [];
  for (let i = 0; i < sigParamCount; i++) {
    const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
    sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
  }

  // 2. Eagerly create / find the wrapper struct (signature-keyed cache)
  const resultTypes = sigRetWasm ? [sigRetWasm] : [];
  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, sigParamWasmTypes, resultTypes);
  if (!wrapperTypes) return undefined;
  const { structTypeIdx: wrapperStructIdx, closureInfo } = wrapperTypes;

  // (#3205) Candidate set: the declared wrapper + covariant/async variants (the
  // stored element may return a value discarded into a `() => void` element
  // type, or be an activated async closure whose result was rewritten to
  // externref). See buildClosureFuncCandidates + compileCallablePropertyCall.
  const funcCandidates = buildClosureFuncCandidates(
    ctx,
    { funcTypeIdx: closureInfo.funcTypeIdx, structTypeIdx: wrapperStructIdx, returnType: closureInfo.returnType },
    sigParamCount,
    sigParamWasmTypes,
  );

  // 3. Compile elemAccess to push the element value. For an `Mw[]` (vec of
  //    callables) the element will be externref (boxed __fn_wrap). For a
  //    structurally-typed `(Mw, Mw)` tuple it may already be a closure
  //    struct ref. For native primitive arrays callSigs is empty above,
  //    so we never get here.
  // `obj["m"]()` on a `this`-reading object-literal function property RAN the
  // callee but bound no receiver (measured: side effect observed, `this.x`
  // undefined) — the property-access twin of the same defect. The element-access
  // lowering fuses receiver and key, so the receiver is compiled once more here;
  // the plan admits only an identifier receiver, for which that is free.
  let bind = planElementAccessMethodReceiverBind(ctx, fctx, elemAccess);
  if (bind && !emitStandaloneReceiverCapture(fctx, compileExpression(ctx, fctx, elemAccess.expression), bind)) {
    bind = undefined;
  }

  const elemResult = compileExpression(ctx, fctx, elemAccess);
  if (!elemResult) return undefined;
  if (elemResult.kind !== "externref" && elemResult.kind !== "ref" && elemResult.kind !== "ref_null") {
    // Primitive element type with call signatures shouldn't happen — bail
    // to the historical fallback which drops everything for side effects.
    // (The value pushed above is consumed by the fallback's own path.)
    return undefined;
  }

  if (funcCandidates.length <= 1) {
    // ── Single-candidate path ──
    // 4. Normalize to the lifted function's self carrier. Shared wrapper funcs
    // use the canonical root even when this module's signature wrapper is a
    // child; private/named funcs retain concrete self.
    const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, closureInfo.funcTypeIdx) ?? wrapperStructIdx;
    const closureRefType: ValType = { kind: "ref_null", typeIdx: selfTypeIdx };
    const closureLocal = allocLocal(fctx, `__cea_${fctx.locals.length}`, closureRefType);
    if (elemResult.kind === "externref") {
      fctx.body.push({ op: "any.convert_extern" });
      emitGuardedRefCast(fctx, selfTypeIdx);
    } else {
      // Already a struct ref — guard cast if the shape differs from the
      // self carrier the lifted function expects.
      if ((elemResult as { typeIdx: number }).typeIdx !== selfTypeIdx) {
        emitGuardedRefCast(fctx, selfTypeIdx);
      }
    }
    fctx.body.push({ op: "local.set", index: closureLocal });

    // 5. Push self (closureRef) as first lifted-fn arg, null-check throw
    fctx.body.push({ op: "local.get", index: closureLocal });
    emitNullCheckThrow(ctx, fctx, closureRefType);

    // 6. Compile call args (clamped/padded — copy lines 462-478 of
    //    compileCallablePropertyCall)
    const cpParamCount = closureInfo.paramTypes.length;
    for (let i = 0; i < Math.min(expr.arguments.length, cpParamCount); i++) {
      compileInternalCallArgument(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
    }
    for (let i = cpParamCount; i < expr.arguments.length; i++) {
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) fctx.body.push({ op: "drop" });
    }
    for (let i = expr.arguments.length; i < cpParamCount; i++) {
      pushDefaultValue(fctx, closureInfo.paramTypes[i]!, ctx);
    }

    // 7. Extract funcref + call_ref (mirror lines 543-557)
    fctx.body.push({ op: "local.get", index: closureLocal });
    emitNullCheckThrow(ctx, fctx, closureRefType);
    fctx.body.push({ op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 });
    emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
    emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx });
    if (bind) emitObjectLiteralMethodThisInstall(ctx, fctx, bind);
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });

    return finishObjectLiteralMethodCall(ctx, fctx, bind, closureInfo.returnType ?? VOID_RESULT);
  }

  // ── (#3205) Multi-candidate order-independent dispatch ──
  const calleeIsAsync = isPromiseType(sigRetType);
  const expectedReturn: ValType | null = calleeIsAsync ? { kind: "externref" } : closureInfo.returnType;
  const rootIdx = getFuncRefWrapperRootTypeIdx(ctx) ?? wrapperStructIdx;
  const rootRefType: ValType = { kind: "ref_null", typeIdx: rootIdx };
  const closureLocal = allocLocal(fctx, `__cea_${fctx.locals.length}`, rootRefType);
  if (elemResult.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  }
  emitGuardedRefCast(fctx, rootIdx);
  fctx.body.push({ op: "local.set", index: closureLocal });

  // Null-check self while the guarded-cast backup is still the element value
  // (arg compilation below overwrites __lastGuardedCastBackup); re-pushed per arm.
  fctx.body.push({ op: "local.get", index: closureLocal });
  emitNullCheckThrow(ctx, fctx, rootRefType);
  fctx.body.push({ op: "drop" });

  const argLocals = collectPropertyCallArgLocals(ctx, fctx, expr, closureInfo.paramTypes);
  if (bind) emitObjectLiteralMethodThisInstall(ctx, fctx, bind);
  emitRootFuncrefDispatch(ctx, fctx, closureLocal, rootIdx, funcCandidates, argLocals, expectedReturn);
  return finishObjectLiteralMethodCall(ctx, fctx, bind, expectedReturn ?? VOID_RESULT);
}

/** Resolve an `any`-typed receiver method through registered extern classes. */
export function tryExternClassMethodOnAny(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  methodName: string,
): InnerResult {
  // #3507 — `RegExp.prototype.test` is ambiguous on an any-typed receiver.
  // The first ambient extern-class match binds `env.RegExp_test` before the
  // standalone runtime can inspect the receiver's real `$NativeRegExp` brand.
  // Let the closed-method dispatcher perform that runtime identity check.
  //
  // (#4233) `exec` has the SAME shape and was left behind: the only extern
  // class declaring it is `RegExp`, so the first-match loop below bound
  // `env::RegExp_exec` for the §22.2.6.2 reflective idiom
  // (`o.exec = RegExp.prototype.exec; o.exec(s)`) — an unsatisfiable host
  // import that made the whole module fail to instantiate in standalone mode
  // (`host_import_leak: env::RegExp_exec`, the 15.10.6.2_A2_* battery). The
  // arity guard is dropped for both members: `exec()` / `test()` with ZERO
  // args is the §22.2.6.2 step-3 `ToString(undefined)` case, and it must reach
  // the brand-checking native closure just as the one-arg form does.
  if (ctx.standalone && (methodName === "test" || methodName === "exec") && expr.arguments.length <= 1) {
    return null;
  }

  if (methodName === "isPrototypeOf") {
    const prototypeResult = tryCompileGetPrototypeOfIsPrototypeOf(ctx, fctx, expr, propAccess.expression);
    if (prototypeResult) return prototypeResult;
  }

  // (#2994) Static fold for a provable `Object.prototype` / `Function.prototype`
  // receiver, then (#2916) the host-free `$Object.$proto` walk for every
  // remaining shape — without it the extern-class resolver below binds
  // `env::Object_isPrototypeOf` (Object is the ROOT extern class), which a
  // standalone/wasi binary cannot satisfy. Both live in native-is-prototype-of.ts.
  if (methodName === "isPrototypeOf") {
    const answered = tryEmitStaticOrNativeIsPrototypeOf(ctx, fctx, propAccess.expression, expr);
    if (answered !== null) return answered;
  }

  // `.slice` is ambiguous across String, Array, ArrayBuffer, Blob, and every
  // TypedArray. When a RegExp literal elsewhere in the module causes typed
  // array extern classes to register before the call is compiled, first-match
  // iteration order binds `value.slice(n)` on an `any` receiver to
  // e.g. `Uint8ClampedArray_slice`, whose externref return type is incompatible
  // with an f64-expected context like `parseInt(value.slice(2), 2)` and
  // produces an invalid Wasm module (#1062). For `.slice` specifically we
  // refuse extern-class dispatch entirely and let the regular String/Array
  // code path handle it — other ambiguous methods (forEach, indexOf, etc.)
  // keep the historical first-match behavior.
  if (methodName === "slice" || methodName === "valueOf") return null;

  // `createElement` is shared by React's CommonJS namespace and the DOM
  // `Document` extern class.  An `any` receiver carries no evidence that it is
  // a Document, so binding the first ambient match would turn
  // `React.createElement(...)` into `Document_createElement` and discard the
  // real receiver at the host boundary.  Typed Document receivers have
  // already taken the exact extern-class path above; leave unknown receivers
  // on the generic dynamic dispatcher so their runtime identity is preserved.
  if (methodName === "createElement") return null;

  // (#1712) `replace` / `replaceAll` are core String.prototype methods, but
  // SEVERAL DOM extern classes also declare a `replace` (CSSStyleSheet.replace
  // takes one arg, DOMTokenList.replace takes two and returns a boolean). When
  // a RegExp literal or other DOM type elsewhere in the module registers those
  // extern classes, first-match iteration binds an `any`-typed receiver's
  // `value.replace(search, replacement)` to one of them — silently dropping or
  // mis-typing the replacement. The concrete acorn failure: `wordsRegexp(words)
  // { return new RegExp("^(?:" + words.replace(/ /g, "|") + ")$") }` produced
  // `^(?:varundefinedreturn…)$` (CSSStyleSheet.replace, replacement dropped) or
  // `^(?:false)$` (DOMTokenList.replace, boolean result) instead of
  // `^(?:var|return|…)$`, so keyword recognition failed and the tokenizer
  // looped forever (#1712 dogfood). On an `any` receiver in untyped JS these
  // are overwhelmingly String operations; refuse extern-class dispatch and let
  // the generic `__extern_method_call` host path forward all args to the real
  // `String.prototype.replace`. Mirrors the `.slice` ambiguity refusal above.
  if (methodName === "replace" || methodName === "replaceAll") return null;

  // (#3014) `forEach` / `some` are core Array.prototype iteration methods, but
  // every TypedArray extern class (Uint8ClampedArray, Int8Array, …) also
  // declares them with an all-externref signature. When a TypedArray (or a
  // DOM type whose lib.d.ts pulls the TypedArray declarations in) registers
  // its extern class before this call is compiled, first-match iteration over
  // `ctx.externClasses` binds an `any`-typed receiver's `xs.forEach(cb)` /
  // `xs.some(pred)` to e.g. `Uint8ClampedArray_forEach` / `_some` — a host
  // import the standalone runtime cannot satisfy (round-6 leak analysis:
  // 16 execution-verified sole-import leaky passes, GENUINE via inject-throw).
  // On an `any` receiver in untyped JS these are overwhelmingly Array
  // operations; refuse extern-class dispatch and let the generic host /
  // native-struct path handle the receiver by its real runtime shape. Mirrors
  // the `.slice` and `.replace`/`.replaceAll` ambiguity refusals above.
  // (A genuinely-`Uint8ClampedArray`-typed receiver never reaches here — it is
  // handled by the native array-method path before the `any` fallback.)
  //
  // (#3139) Extended to the REST of the Array.prototype iteration/search
  // generics for the same reason and with the same fallback: the mis-bind is
  // not merely a standalone leak — `Uint8ClampedArray_every` runs the host
  // %TypedArray% bridge on a receiver with no [[TypedArrayName]] slot, so a
  // fnctor-instance array-like (`foo.prototype = new Array(1,2,3); new
  // foo().every(cb)`, the 15.4.4.x applied-to-object test262 family) silently
  // iterates ZERO elements. The generic `__extern_method_call` /
  // `__proto_method_call` paths dispatch on the runtime shape and (post-#3138
  // + the #3139 prototype-inclusive `__extern_length`/`__extern_get_idx`/
  // `__extern_has_idx` handlers) resolve inherited length/elements correctly.
  // `indexOf`/`lastIndexOf` are String∩Array-ambiguous exactly like `.slice`.
  if (
    methodName === "forEach" ||
    methodName === "some" ||
    methodName === "every" ||
    methodName === "filter" ||
    methodName === "map" ||
    methodName === "reduce" ||
    methodName === "reduceRight" ||
    methodName === "find" ||
    methodName === "findIndex" ||
    methodName === "indexOf" ||
    methodName === "lastIndexOf"
  ) {
    return null;
  }

  // (#2872) `fill` is a core Array.prototype / %TypedArray%.prototype method,
  // but `CanvasRenderingContext2D` (and Path2D-adjacent DOM classes) also
  // declare a `fill`. First-match iteration bound an `any`-typed receiver's
  // `ta.fill(v)` to `CanvasRenderingContext2D_fill` — a host import the
  // standalone runtime cannot satisfy (the dominant leak of the
  // built-ins/TypedArray/prototype/fill standalone cluster; the receiver there
  // is a dynamically-constructed TA view). On an `any` receiver `fill` is
  // overwhelmingly an Array/TypedArray operation; refuse extern-class dispatch
  // and let the generic dynamic dispatch (which now carries the native
  // `$__ta_dyn_view` fill arm) resolve by runtime shape. Mirrors the `.slice` /
  // `.replace` / `.forEach`/`.some` ambiguity refusals above.
  if (methodName === "fill") return null;

  // (#2872 slice 2) `copyWithin` / `reverse` — core Array.prototype /
  // %TypedArray%.prototype mutators with the same first-match hijack hazard as
  // `fill` (an ambient extern class declaring the name binds an `any`-typed
  // `ta.copyWithin(…)`/`ta.reverse()` to a host import the standalone runtime
  // cannot satisfy). On an `any` receiver these are overwhelmingly Array/TA
  // operations; refuse extern-class dispatch so the generic dynamic dispatch
  // (which now carries the native `$__ta_dyn_view` copyWithin/reverse arms)
  // resolves by runtime shape. Mirrors the `fill` refusal above.
  if (methodName === "copyWithin" || methodName === "reverse") return null;

  // (#2872 slice 5) Scalar-HOF family decline under noJsHost — the SHARED
  // standalone guarantee for every `%TypedArray%.prototype` scalar callback
  // HOF (`STANDALONE_TA_SCALAR_HOFS`: find/findIndex/findLast/findLastIndex/
  // forEach/some/every/reduce/reduceRight). Most members already return null
  // unconditionally above (#3014/#3139), but `findLast`/`findLastIndex` were
  // missing from that list, so the first-match loop below bound an
  // `any`-typed receiver's `ta.findLast(cb)` to `env::Uint8ClampedArray_findLast`
  // — a host import the standalone runtime cannot satisfy (measured
  // host_import_leak ×33 across TypedArray/prototype/findLast{,Index}; the
  // leak is emitted at COMPILE time by the #3058 two-arm's never-executed
  // ELSE arm, so the whole module fails to instantiate). Declining lets the
  // standalone ladder bottom out at the #2151 closed-method dispatcher, whose
  // #3098 HOF arm drives the native backward `__hof_findLast[Index]` loops by
  // runtime shape. noJsHost-gated (the `join` precedent below): the HOST lane
  // keeps its extern binding byte-identical — the import is satisfiable there.
  if (noJsHost(ctx) && STANDALONE_TA_SCALAR_HOFS.has(methodName)) return null;

  // (#3309) Collection methods (`get`/`set`/`has`/`add`/`delete`/`clear`) on an
  // `any` receiver under standalone/wasi. The candidate pool below still
  // contains the WeakMap/Set/WeakSet extern classes even in nativeStrings mode
  // (the lib .d.ts declare-var scan gates only `"Map"` —
  // `collectExternFromDeclareVar`, extern-declarations.ts), so first-match
  // bound `m.set(k, v)` on a Map held in `any` to `env.WeakMap_set` /
  // `env.WeakMap_get` / `env.WeakMap_has` and `s.add(v)` to `env.Set_add` —
  // host imports the standalone runtime cannot satisfy, while the WasmGC-native
  // Map/Set runtime (map-runtime.ts / set-runtime.ts) sits unused. Refuse
  // extern-class dispatch so the call falls through to the #2151 closed-method
  // dispatcher, whose `$Map` brand arm (closed-method-dispatch.ts) resolves by
  // runtime shape: all four collections share the `$Map` struct with a `kind`
  // brand tag (#3171). Closed-struct/user-object receivers with these method
  // names keep their arms; open-`$Object` receivers keep the
  // `__extern_method_call` bottom arm. JS-host mode is untouched (the generic
  // WeakMap_* host bridge is satisfiable and correct there).
  if (
    (ctx.standalone || ctx.wasi) &&
    (methodName === "get" ||
      methodName === "set" ||
      methodName === "has" ||
      methodName === "add" ||
      methodName === "delete" ||
      methodName === "clear")
  ) {
    return null;
  }

  // (#3033) If the program's OWN code defines a function-valued member of this
  // name (prototype-method assignment, function-valued property, object-literal
  // method, class method), the receiver is far more plausibly a user object
  // than an ambient DOM/extern instance — and the first-match binding below
  // would hijack the call to the extern import (acorn's `p.check()` bound to
  // FontFaceSet_check; parseIdent/finishToken shadow DOM names too). Refuse and
  // let the generic dynamic dispatch resolve by runtime identity — which also
  // handles genuine extern receivers correctly host-side.
  if (
    sourceDefinesFunctionMember(expr.getSourceFile(), methodName) ||
    // (#4439) `noJsHost` widens the alias shape to a borrowed BUILTIN method
    // (`o.match = String.prototype.match`), which otherwise first-matched the
    // DOM `Cache.match` extern class and leaked `env::Cache_match` host-free.
    // Host lane keeps the identifier-only answer, byte-identical.
    sourceAssignsAliasedFunctionMember(expr.getSourceFile(), propAccess.expression, methodName, noJsHost(ctx))
  ) {
    return null;
  }

  // (#1283) The dispatch below emits `externref` hints for every arg and
  // assumes the call's params are all-externref. When iterating in
  // insertion order we may otherwise hit an extern class whose method has a
  // mixed param signature — e.g. TypedArray.set is `(externref, externref,
  // f64)` and would mismatch the externref args we push. Concretely this
  // hit WeakMap.set on `wm: any`: TypedArray's `set` was registered before
  // WeakMap's, so first-match picked Uint8ClampedArray_set and produced an
  // invalid Wasm module ("call[0] expected externref, found f64").
  //
  // Filter candidates to all-externref param signatures so arg coercions
  // are always type-correct. Result types are NOT filtered — the dispatch
  // returns sig.results[0]! to the caller verbatim, so methods like
  // TypedArray.some `(externref, externref) -> f64` (boolean → f64) and
  // Array.indexOf `(externref, externref, externref) -> f64` are valid
  // first-match candidates. Filtering on results was too aggressive and
  // forced these into __extern_method_call host-side dispatch, where wasm
  // vec receivers are opaque to JS and `arr.some` returned undefined,
  // surfacing as "some is not a function" runtime errors in test262.
  const isAllExternrefParams = (sig: { params: ValType[] }): boolean => {
    for (const p of sig.params) if (p.kind !== "externref") return false;
    return true;
  };

  // (#3237 Slice 1/2) Native `DisposableStack` dispatch on an `any` receiver.
  // Reaching here means every ambiguity/user-member refusal above already
  // passed, so if `DisposableStack` is a registered extern class declaring this
  // method the first-match loop below WOULD bind it to the `DisposableStack_*`
  // HOST import (unsatisfiable standalone → module fails to instantiate before
  // dispose runs). In `nativeStrings` mode, run a `ref.test $DisposableStack`
  // runtime dispatch to the native driver instead (miss → clean TypeError, never
  // the import). The helper handles `dispose` (Slice 1) + `defer`/`adopt`/`use`
  // (Slice 2); other methods fall through to the loop unchanged. Host lane
  // (`!nativeStrings`) is untouched.
  if (ctx.nativeStrings && ctx.externClasses.get("DisposableStack")?.methods.has(methodName)) {
    const dsAny = tryCompileNativeDisposableStackAnyMethodCall(ctx, fctx, propAccess, expr, methodName);
    if (dsAny !== undefined) return dsAny;
  }

  // (#3342) `join` on an `any` receiver: the first-match loop below binds the
  // first extern class declaring it — a TypedArray (`env::Uint8ClampedArray_join`),
  // unsatisfiable standalone (e.g. `(Object.values(o) as any).join(",")`). Route
  // to the native externref `join` (host-free under noJsHost since #3155); host
  // lane keeps the existing binding (byte-identical).
  if (noJsHost(ctx) && methodName === "join") {
    const nativeJoin = compileArrayJoinExtern(ctx, fctx, propAccess, expr);
    if (nativeJoin !== null) return nativeJoin;
  }

  for (const [key, info] of ctx.externClasses) {
    if (key !== info.className) continue;
    const sig = info.methods.get(methodName);
    if (!sig) continue;
    if (!isAllExternrefParams(sig)) continue;

    // (#1712) Never bind a candidate that would DROP arguments the call
    // actually provided. `sig.params` includes `self`, so the method's
    // user-visible arity is `params.length - 1`; if the call passes MORE
    // args than that, the loop below silently `drop`s the extras — which is
    // never the right semantics for a name collision. The concrete failure:
    // an `any`-typed receiver's `value.replace(/re/g, "rep")` first-matched
    // `CSSStyleSheet.prototype.replace(text)` (one user arg), so the
    // replacement string was emitted then immediately dropped and the host
    // `replace` ran with `undefined` as the replacement (`"a b".replace(/ /,
    // "|")` → `"aundefinedb"`). This silently broke acorn's
    // `wordsRegexp(words){ return new RegExp("^(?:"+words.replace(/ /g,"|")+
    // ")$") }` — keyword recognition failed (`varundefinedreturn…`), so every
    // identifier mis-tokenized as `name` and the tokenizer looped forever
    // (#1712 acorn dogfood). Refusing here lets the call fall through to the
    // generic `__extern_method_call` host dispatch, which forwards ALL args to
    // the correct `String.prototype.replace`. Mirrors the `.slice` refusal
    // above (ambiguous String/Array/DOM method names on an `any` receiver).
    const userArity = sig.params.length - 1;
    if (expr.arguments.length > userArity) continue;

    const importName = `${info.importPrefix}_${methodName}`;
    let funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const typeIdx = addFuncType(ctx, sig.params, sig.results);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      funcIdx = ctx.funcMap.get(importName);
    }
    if (funcIdx === undefined) continue;

    compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
    const argCount = sig.params.length - 1; // skip self
    for (let i = 0; i < expr.arguments.length && i < argCount; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
    }
    for (let i = expr.arguments.length; i < argCount; i++) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    for (let i = argCount; i < expr.arguments.length; i++) {
      const argType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (argType) fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "call", funcIdx });
    if (sig.results.length === 0) return VOID_RESULT;
    return sig.results[0]!;
  }
  return null;
}
