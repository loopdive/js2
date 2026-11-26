// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Optional call expression compilation:
 * - obj?.method(args) — compileOptionalCallExpression
 */
import { ts } from "../../ts-api.js";
import { isExternalDeclaredClass, isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal, withPreEvaluatedExpression } from "../context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "../context/speculative.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolveWasmType } from "../index.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, ensureLateImport, VOID_RESULT } from "../shared.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "../object-runtime.js";
import { defaultValueInstrs, pushDefaultValue } from "../type-coercion.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { compileCallablePropertyCall } from "./calls-closures.js";
import { ensureExternIsUndefinedImport, flushLateImportShifts } from "./late-imports.js";
import { getFuncParamTypes } from "./helpers.js";
import { resolveStructName } from "./misc.js";
import { compileReceiverMethodCall } from "./call-receiver-method.js";
import { tryEmitSpreadHostArgs } from "../host-method-args.js";
import { tryCompileStandaloneRegExpMethod } from "../regexp-standalone.js";
import { isBuiltinTypeName } from "../builtin-tags.js";
import { emitIsUndefF64, f64MayHoldUndefined, pushUndefF64 } from "../value-tags.js";

export function compileOptionalCallExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  // `obj.method?.(args)` short-circuits on the METHOD VALUE, not on `obj`.
  // It is a distinct AST shape from `obj?.method(args)`: the question-dot is
  // carried by the CallExpression while the PropertyAccessExpression is plain.
  // Keeping it in the receiver-null path below made `{ }.rng?.()` attempt an
  // ordinary call and throw "rng is not a function" (uuid v1/v6/v7). `super`
  // remains on the static class-method lane: converting its typed receiver to
  // a host call loses the instance identity used as the method's `this`.
  if (
    expr.questionDotToken &&
    !propAccess.questionDotToken &&
    propAccess.expression.kind !== ts.SyntaxKind.SuperKeyword
  ) {
    return compileOptionalPropertyValueCall(ctx, fctx, expr, propAccess);
  }
  const objType = compileExpression(ctx, fctx, propAccess.expression);
  if (!objType) return null;

  let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) callReturnType = resolveWasmType(ctx, retType);
  }
  const declaredType: ValType = callReturnType === VOID_RESULT ? { kind: "externref" } : callReturnType;
  let resultType = declaredType;

  // `?.` short-circuits on null/undefined. `ref.is_null` only validates on a
  // reference operand, but the receiver can lower to a non-reference value type.
  // (#7370) A primitive receiver (`x: number | undefined` as an f64) calls its
  // method unless it holds the `undefined` sentinel. Any other non-reference
  // receiver is the compiler's representation of `undefined`/`null` (e.g. a
  // `const x = undefined` stored as an i32 global — #1603), which
  // short-circuits the call: drop it and emit the default result.
  if (objType.kind !== "ref" && objType.kind !== "ref_null" && objType.kind !== "externref") {
    const valueCall = compileOptionalValueReceiverCall(ctx, fctx, expr, propAccess, objType, resultType);
    if (valueCall !== undefined) return valueCall;
    fctx.body.push({ op: "drop" });
    const shortType = nullableJoin(resultType);
    fctx.body.push(...defaultValueInstrs(shortType));
    return shortType;
  }

  const tmp = allocLocal(fctx, `__optcall_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  // An externref can carry host JavaScript `undefined` as a non-null reference
  // even when the standalone undefined-singleton regime is inactive (for
  // example an omitted argument supplied by the generic call wrapper).
  // Optional chaining must short-circuit both representations.
  if (objType.kind === "externref") {
    const isUndefIdx = ensureExternIsUndefinedImport(ctx);
    if (isUndefIdx !== undefined) {
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "call", funcIdx: isUndefIdx });
      fctx.body.push({ op: "i32.or" });
    }
  }

  const savedBody = pushBody(fctx);
  // The receiver of an optional chain is nullable by construction (`K | null`),
  // so `getTypeAtLocation` yields a union whose `getSymbol()` does not resolve
  // to the underlying class/struct. Strip null/undefined first so method
  // resolution sees the concrete declared type (#2049).
  const tsReceiverType = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(propAccess.expression));
  const methodName = ts.isPrivateIdentifier(propAccess.name) ? propAccess.name.text.slice(1) : propAccess.name.text;
  let methodResolved = false;

  if (!methodResolved && isExternalDeclaredClass(tsReceiverType, ctx.checker)) {
    const className = tsReceiverType.getSymbol()?.name;
    if (className) {
      let current: string | undefined = className;
      while (current) {
        const info = ctx.externClasses.get(current);
        if (info?.methods.has(methodName)) {
          const importName = `${info.importPrefix}_${methodName}`;
          const funcIdx = ctx.funcMap.get(importName);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: tmp });
            for (const arg of expr.arguments) compileExpression(ctx, fctx, arg);
            fctx.body.push({ op: "call", funcIdx });
            methodResolved = true;
          }
          break;
        }
        current = ctx.externClassParent.get(current);
      }
    }
  }

  if (!methodResolved) {
    let receiverClassName = tsReceiverType.getSymbol()?.name;
    if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
      receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
    }
    if (receiverClassName && ctx.classSet.has(receiverClassName)) {
      let fullName = `${receiverClassName}_${methodName}`;
      let funcIdx = ctx.funcMap.get(fullName);
      if (funcIdx === undefined) {
        let ancestor = ctx.classParentMap.get(receiverClassName);
        while (ancestor && funcIdx === undefined) {
          fullName = `${ancestor}_${methodName}`;
          funcIdx = ctx.funcMap.get(fullName);
          ancestor = ctx.classParentMap.get(ancestor);
        }
      }
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmp });
        if (objType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
        }
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        methodResolved = true;
      }
    }
  }

  if (!methodResolved) {
    const structTypeName = resolveStructName(ctx, tsReceiverType);
    if (structTypeName) {
      const fullName = `${structTypeName}_${methodName}`;
      const funcIdx = ctx.funcMap.get(fullName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmp });
        if (objType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        for (let i = 0; i < expr.arguments.length; i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
        }
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        fctx.body.push({ op: "call", funcIdx });
        methodResolved = true;
      }
    }
  }

  // (#4292) An optional call on an unannotated/dynamic receiver still has to
  // perform ordinary method dispatch in the non-null branch. Hono's published
  // `mergePath(base, ...)` uses `base?.at(-1)` where `base` is an unannotated
  // JavaScript parameter: the static string arm above cannot prove its brand,
  // but at runtime it is a native string. The old fallback emitted only the
  // default result, so `.at()` became undefined even for a non-null receiver.
  // Delegate dynamic receivers to the same generic runtime method ladder as a
  // non-optional call; the outer branch has already applied the nullish
  // short-circuit. (#7370, #7395) The same holds for a primitive (`x?: number`,
  // `s: string | undefined`) or built-in (`a: number[] | undefined`) receiver:
  // no arm above dispatches their methods.
  const ladderReceiver = isLadderMethodReceiver(tsReceiverType);
  // (#7430, #7469) `o?.f?.(args)` also short-circuits on the callee VALUE, which neither the typed closure-field call
  // (an undefined field traps it) nor the dynamic method ladder (an undefined property throws) can do. Unless a declared
  // or built-in method resolves it, past the receiver test it is the `o.f?.(args)` call on the held receiver, for a
  // struct and a dynamic receiver alike; the receiver's short-circuit must match that call's `undefined` result.
  const calleeValueCall = !methodResolved && !ladderReceiver && expr.questionDotToken !== undefined;
  if (calleeValueCall) {
    const delegated = withPreEvaluatedExpression(fctx, propAccess.expression, tmp, () =>
      compileOptionalPropertyValueCall(ctx, fctx, expr, propAccess),
    );
    resultType = settleDelegatedResult(fctx, delegated, resultType);
    methodResolved = true;
  }
  if (!methodResolved && ((tsReceiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || ladderReceiver)) {
    const delegated = compileHeldReceiverMethodCall(ctx, fctx, expr, propAccess, tmp);
    if (delegated !== undefined) {
      resultType = settleDelegatedResult(fctx, delegated, resultType);
      methodResolved = true;
    }
  }

  // Closure-field / function-typed-property callee (e.g. `o?.f(x)` where `f`
  // holds a closure on an object/struct, not a named method). None of the
  // method-resolution branches above match these, so without this fallback the
  // non-null branch would emit a default value and the call would never happen
  // (#2049). `compileCallablePropertyCall` implements exactly this — extract the
  // closure field, push self + args, `call_ref` — and already normalizes a
  // nullable receiver via a guarded cast. The receiver is the one already held
  // for the nullish test, so a live property chain is not evaluated twice.
  if (!methodResolved && isSupportedOptionalCallableReceiverShape(propAccess.expression)) {
    const structName = resolveStructName(ctx, tsReceiverType);
    if (structName) {
      const delegated = withPreEvaluatedExpression(fctx, propAccess.expression, tmp, () =>
        compileCallablePropertyCall(ctx, fctx, expr, propAccess, structName),
      );
      if (delegated !== undefined) {
        resultType = settleDelegatedResult(fctx, delegated, resultType);
        methodResolved = true;
      }
    }
  }

  if (!methodResolved) fctx.body.push(...defaultValueInstrs(resultType));
  if (ladderReceiver) resultType = undefinableJoin(fctx, resultType, declaredType);

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  resultType = nullableJoin(resultType);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: ladderReceiver || calleeValueCall ? optionalUndefinedInstrs(ctx, resultType) : defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
}

/**
 * (#7370, #7395) The value a short-circuited `?.` call yields: the lane's real `undefined` for an externref result, the
 * `undefined` sentinel for an f64 one.
 */
function optionalUndefinedInstrs(ctx: CodegenContext, type: ValType): Instr[] {
  if (type.kind === "externref") return canonicalUndefinedExternInstrs(ctx);
  if (type.kind !== "f64") return defaultValueInstrs(type);
  const undef: Instr[] = [];
  pushUndefF64(undef);
  return undef;
}

function compileOptionalPropertyValueCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): InnerResult {
  const externref: ValType = { kind: "externref" };
  const receiverType = compileExpression(ctx, fctx, propAccess.expression);
  if (receiverType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (receiverType.kind !== "externref") {
    coerceType(ctx, fctx, receiverType, externref);
  }
  const receiverLocal = allocLocal(fctx, `__optprop_recv_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: receiverLocal });

  const methodName = ts.isPrivateIdentifier(propAccess.name) ? propAccess.name.text.slice(1) : propAccess.name.text;
  // (#5383 / #2961, #6979) `recv.m?.(args)` builds its argument list with the
  // object-runtime vec builders (`__objvec_new` / `__objvec_push`) and invokes
  // the callee through `__apply_closure`, which has the `(callee, thisArg,
  // args) -> result` signature of the retired host `__call_function`;
  // `canonicalUndefinedExternInstrs` supplies the lane's real `undefined`.
  const getIdx = ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]);
  const isUndefinedIdx = ensureExternIsUndefinedImport(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const vecBuilders = ensureObjVecBuilders(ctx);
  const arrayNewIdx = vecBuilders?.newIdx;
  const arrayPushIdx = vecBuilders?.pushIdx;
  const callIdx = applyIdx;
  addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);
  const resolvedGetIdx = ctx.funcMap.get("__extern_get") ?? getIdx;
  const resolvedNewIdx = ctx.funcMap.get("__objvec_new") ?? arrayNewIdx;
  const resolvedPushIdx = ctx.funcMap.get("__objvec_push") ?? arrayPushIdx;
  const resolvedCallIdx = ctx.funcMap.get("__apply_closure") ?? callIdx;
  if (
    resolvedGetIdx === undefined ||
    resolvedNewIdx === undefined ||
    resolvedPushIdx === undefined ||
    resolvedCallIdx === undefined
  ) {
    fctx.body.push(...defaultValueInstrs(externref));
    return externref;
  }

  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
  fctx.body.push({ op: "call", funcIdx: resolvedGetIdx });
  const calleeLocal = allocLocal(fctx, `__optprop_fn_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.tee", index: calleeLocal });
  fctx.body.push({ op: "ref.is_null" });
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: calleeLocal });
    fctx.body.push({ op: "call", funcIdx: isUndefinedIdx });
    fctx.body.push({ op: "i32.or" });
  }

  const savedBody = pushBody(fctx);
  fctx.body.push({ op: "call", funcIdx: resolvedNewIdx });
  const argsLocal = allocLocal(fctx, `__optprop_args_${fctx.locals.length}`, externref);
  fctx.body.push({ op: "local.set", index: argsLocal });
  // (#7430) A spread contributes its runtime element count, so it goes through the shared expander.
  if (!tryEmitSpreadHostArgs(ctx, fctx, expr.arguments, argsLocal, "__objvec_push", resolvedPushIdx)) {
    for (const argument of expr.arguments) {
      fctx.body.push({ op: "local.get", index: argsLocal });
      const argType = compileExpression(ctx, fctx, argument);
      if (argType === null) fctx.body.push({ op: "ref.null.extern" });
      else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, externref);
      fctx.body.push({ op: "call", funcIdx: resolvedPushIdx });
    }
  }
  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  // Expanding a spread can register late imports, which shift a defined function's index: re-resolve it by name.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? resolvedCallIdx });
  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: externref },
    then: canonicalUndefinedExternInstrs(ctx),
    else: elseInstrs,
  });
  return externref;
}

const PRIMITIVE_METHOD_RECEIVER =
  ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.StringLike;

/**
 * Receiver types whose methods only the generic receiver-method ladder dispatches: a built-in object (`Array`, `Map`,
 * `Set`, …) or a primitive, including the `true | false` union that `boolean` is.
 */
function isLadderMethodReceiver(type: ts.Type): boolean {
  const name = type.getSymbol()?.name;
  if (name !== undefined && isBuiltinTypeName(name)) return true;
  return type.isUnion()
    ? type.types.every((member) => (member.flags & PRIMITIVE_METHOD_RECEIVER) !== 0)
    : (type.flags & PRIMITIVE_METHOD_RECEIVER) !== 0;
}

/**
 * (#7370) `x?.m(args)` on a receiver that lowered to a Wasm value type, with its value on the stack. A receiver that
 * can hold `undefined` (`f64MayHoldUndefined`) short-circuits on the sentinel; one whose static type admits neither
 * `null` nor `undefined` is a primitive and the method always runs. Any other value slot is left to the caller.
 * `undefined` leaves the stack untouched for the caller's fallback.
 */
function compileOptionalValueReceiverCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  receiverType: ValType,
  resultType: ValType,
): InnerResult | undefined {
  const holdsUndefined = f64MayHoldUndefined(ctx, propAccess.expression, receiverType);
  const nullability = ctx.oracle.nullabilityOf(propAccess.expression);
  if (!holdsUndefined && (nullability.nullable || nullability.undefinable)) return undefined;
  // The ladder reads the receiver from its local while it compiles, so the local exists first; an unclaimed call
  // rolls it back with everything the attempt allocated.
  const attempt = snapshotSpeculative(ctx, fctx);
  const receiverLocal = allocLocal(fctx, `__optcall_${fctx.locals.length}`, receiverType);
  const savedBody = pushBody(fctx);
  const delegated = compileHeldReceiverMethodCall(ctx, fctx, expr, propAccess, receiverLocal);
  if (delegated === undefined) {
    popBody(fctx, savedBody);
    rollbackSpeculative(ctx, fctx, attempt);
    return undefined;
  }
  const settled = settleDelegatedResult(fctx, delegated, resultType);
  const callType = holdsUndefined ? undefinableJoin(fctx, settled, resultType) : settled;
  const callInstrs = fctx.body;
  popBody(fctx, savedBody);
  // A receiver that cannot be nullish is a primitive: the call always runs, on the held value.
  if (!holdsUndefined) {
    fctx.body.push({ op: "local.set", index: receiverLocal }, ...callInstrs);
    return callType;
  }
  fctx.body.push({ op: "local.tee", index: receiverLocal });
  emitIsUndefF64(fctx.body);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: callType },
    then: optionalUndefinedInstrs(ctx, callType),
    else: callInstrs,
  });
  return callType;
}

/** The result of a short-circuiting branch joined with a default: a non-null reference widens to its nullable form. */
function nullableJoin(type: ValType): ValType {
  return type.kind === "ref" ? { kind: "ref_null", typeIdx: type.typeIdx } : type;
}

/**
 * (#7395) The type of a call result joined with the `undefined` that `optionalUndefinedInstrs` yields, converting the
 * result on the stack where needed: a number (`declared` f64, even when the method lowers to an i32 such as a string
 * `indexOf`) becomes an f64 carrying the sentinel, an anyref (`Map.get`) an externref, and any other reference its
 * nullable form. An i32 the declared type calls a boolean (`Set.has`) keeps the boolean brand, so `String(r)` reads
 * "true"; its `undefined` still reads as `false` (#7406).
 */
function undefinableJoin(fctx: FunctionContext, type: ValType, declared: ValType): ValType {
  if (type.kind === "i32" && declared.kind === "i32") return declared;
  if (type.kind === "anyref") {
    fctx.body.push({ op: "extern.convert_any" });
    return { kind: "externref" };
  }
  if (type.kind === "i32" && declared.kind === "f64") fctx.body.push({ op: "f64.convert_i32_s" });
  else if (type.kind !== "f64") return nullableJoin(type);
  return { kind: "f64", undefSentinel: true };
}

/** The type a delegated call leaves on the stack: a value-less result (`void`, a failed compile) pushes a default. */
function settleDelegatedResult(
  fctx: FunctionContext,
  delegated: ValType | null | typeof VOID_RESULT,
  fallback: ValType,
): ValType {
  if (delegated !== null && delegated !== VOID_RESULT) return delegated;
  fctx.body.push(...defaultValueInstrs(fallback));
  return fallback;
}

/**
 * (#7374) The receiver-method ladder for `recv?.m(args)` with `recv` read from `receiverLocal`, which already holds the
 * value the nullish test saw: a call or a getter in `recv` runs once.
 */
function compileHeldReceiverMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  receiverLocal: number,
): InnerResult | undefined {
  return withPreEvaluatedExpression(fctx, propAccess.expression, receiverLocal, () => {
    const regExpMethod = tryCompileStandaloneRegExpMethod(ctx, fctx, expr, propAccess);
    return regExpMethod !== undefined ? regExpMethod : compileReceiverMethodCall(ctx, fctx, expr, propAccess);
  });
}

/**
 * Receiver shapes supported by the closure-field fallback. The receiver value
 * itself is captured before delegation, so a property chain may contain a live
 * getter without being evaluated twice. Calls and element access remain on
 * their existing optional-call paths.
 */
function isSupportedOptionalCallableReceiverShape(expr: ts.Expression): boolean {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isIdentifier(cur) || cur.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return false;
  }
}
