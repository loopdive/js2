// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Optional call expression compilation:
 * - obj?.method(args) — compileOptionalCallExpression
 */
import { ts } from "../../ts-api.js";
import { isExternalDeclaredClass, isStringType, isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addStringImports, resolveWasmType } from "../index.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, ensureLateImport, valTypesMatch, VOID_RESULT } from "../shared.js";
import { compileNativeStringMethodCall } from "../string-ops.js";
import { defaultValueInstrs, pushDefaultValue } from "../type-coercion.js";
import { undefinedSingletonActive } from "../any-helpers.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { compileCallablePropertyCall } from "./calls-closures.js";
import { ensureExternIsUndefinedImport, flushLateImportShifts } from "./late-imports.js";
import { getFuncParamTypes } from "./helpers.js";
import { resolveStructName } from "./misc.js";
import { compileReceiverMethodCall } from "./call-receiver-method.js";

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
  let resultType: ValType = callReturnType === VOID_RESULT ? { kind: "externref" } : callReturnType;

  // `?.` short-circuits on null/undefined. `ref.is_null` only validates on a
  // reference operand, but the receiver can lower to a non-reference value type
  // (e.g. a `const x = undefined` stored as an i32 global — #1603). A
  // non-reference receiver here is the compiler's representation of
  // `undefined`/`null`, which short-circuits the call: drop it and emit the
  // default result.
  if (objType.kind !== "ref" && objType.kind !== "ref_null" && objType.kind !== "externref") {
    fctx.body.push({ op: "drop" });
    let shortType: ValType = resultType;
    if (shortType.kind === "ref") shortType = { kind: "ref_null", typeIdx: shortType.typeIdx };
    fctx.body.push(...defaultValueInstrs(shortType));
    return shortType;
  }

  const tmp = allocLocal(fctx, `__optcall_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  // (#2106 S1) Under the `undefinedSingleton` regime standalone `undefined` is
  // a NON-null externref, so the short-circuit must also test the singleton.
  if (undefinedSingletonActive(ctx) && objType.kind === "externref") {
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

  if (!methodResolved && isStringType(tsReceiverType)) {
    if (ctx.fast && ctx.nativeStrTypeIdx >= 0) {
      const nativeResult = compileNativeStringMethodCall(ctx, fctx, expr, propAccess, methodName);
      if (nativeResult !== null) {
        resultType = nativeResult;
        methodResolved = true;
      }
    } else {
      const importName = `string_${methodName}`;
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmp });
        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const userParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
        for (let i = 0; i < expr.arguments.length; i++) {
          if (i >= userParamCount) {
            const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
            if (extraType !== null) fctx.body.push({ op: "drop" });
            continue;
          }
          const expected = paramTypes?.[i + 1];
          const actual = compileExpression(ctx, fctx, expr.arguments[i]!, expected);
          if (actual === null) {
            pushDefaultValue(fctx, expected ?? { kind: "externref" }, ctx);
          } else if (expected && !valTypesMatch(actual, expected)) {
            coerceType(ctx, fctx, actual, expected);
          }
        }
        if (paramTypes) {
          for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
            const paramType = paramTypes[i]!;
            if ((methodName === "substring" || methodName === "slice") && i === 2 && paramType.kind === "f64") {
              addStringImports(ctx);
              const lengthIdx = ctx.jsStringImports.get("length");
              if (lengthIdx === undefined) {
                fctx.body.push({ op: "f64.const", value: 0x7fffffff });
              } else {
                fctx.body.push(
                  { op: "local.get", index: tmp },
                  { op: "call", funcIdx: lengthIdx },
                  { op: "f64.convert_i32_u" },
                );
              }
            } else if (paramType.kind === "externref") {
              const undefinedIdx = ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
              flushLateImportShifts(ctx, fctx);
              if (undefinedIdx === undefined) fctx.body.push({ op: "ref.null.extern" });
              else fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__get_undefined")! });
            } else if (paramType.kind === "f64") {
              const value =
                methodName === "split"
                  ? -1
                  : methodName === "includes" || methodName === "startsWith" || methodName === "endsWith"
                    ? Number.NaN
                    : 0;
              fctx.body.push({ op: "f64.const", value });
            } else {
              pushDefaultValue(fctx, paramType, ctx);
            }
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
  // Delegate repeatable local dynamic receivers to the same generic runtime
  // method ladder as a non-optional call; the outer branch has already applied
  // the nullish short-circuit. The delegated path re-evaluates its receiver, so
  // property chains are deliberately excluded: even a syntactically simple
  // `box.value` can invoke an observable getter.
  if (
    !methodResolved &&
    (tsReceiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 &&
    isRepeatableDynamicOptionalReceiver(propAccess.expression)
  ) {
    const delegated = compileReceiverMethodCall(ctx, fctx, expr, propAccess);
    if (delegated !== undefined) {
      if (delegated === VOID_RESULT || delegated === null) {
        fctx.body.push(...defaultValueInstrs(resultType));
      } else {
        resultType = delegated;
      }
      methodResolved = true;
    }
  }

  // Closure-field / function-typed-property callee (e.g. `o?.f(x)` where `f`
  // holds a closure on an object/struct, not a named method). None of the
  // method-resolution branches above match these, so without this fallback the
  // non-null branch would emit a default value and the call would never happen
  // (#2049). `compileCallablePropertyCall` implements exactly this — extract the
  // closure field, push self + args, `call_ref` — and already normalizes a
  // nullable receiver via a guarded cast. It recompiles the receiver
  // (`propAccess.expression`) once inside this non-null branch, which runs only
  // when the receiver is non-null, so re-evaluation is restricted to
  // side-effect-free receivers to preserve `?.` short-circuit semantics.
  if (!methodResolved && isSideEffectFreeOptionalReceiver(propAccess.expression)) {
    const structName = resolveStructName(ctx, tsReceiverType);
    if (structName) {
      const delegated = compileCallablePropertyCall(ctx, fctx, expr, propAccess, structName);
      if (delegated !== undefined) {
        if (delegated !== null && delegated !== VOID_RESULT) {
          resultType = delegated;
        } else if (delegated === VOID_RESULT) {
          fctx.body.push(...defaultValueInstrs(resultType));
        }
        methodResolved = true;
      }
    }
  }

  if (!methodResolved) fctx.body.push(...defaultValueInstrs(resultType));

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  if (resultType.kind === "ref") resultType = { kind: "ref_null", typeIdx: resultType.typeIdx };

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
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
  const getIdx = ensureLateImport(ctx, "__extern_get", [externref, externref], [externref]);
  const isUndefinedIdx = ensureExternIsUndefinedImport(ctx);
  const arrayNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externref]);
  const arrayPushIdx = ensureLateImport(ctx, "__js_array_push", [externref, externref], []);
  const callIdx = ensureLateImport(ctx, "__call_function", [externref, externref, externref], [externref]);
  const getUndefinedIdx = ensureLateImport(ctx, "__get_undefined", [], [externref]);
  addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);
  const resolvedGetIdx = ctx.funcMap.get("__extern_get") ?? getIdx;
  const resolvedNewIdx = ctx.funcMap.get("__js_array_new") ?? arrayNewIdx;
  const resolvedPushIdx = ctx.funcMap.get("__js_array_push") ?? arrayPushIdx;
  const resolvedCallIdx = ctx.funcMap.get("__call_function") ?? callIdx;
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
  for (const argument of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, ts.isSpreadElement(argument) ? argument.expression : argument);
    if (argType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, externref);
    fctx.body.push({ op: "call", funcIdx: resolvedPushIdx });
  }
  fctx.body.push({ op: "local.get", index: calleeLocal });
  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: resolvedCallIdx });
  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  const resolvedUndefinedIdx = ctx.funcMap.get("__get_undefined") ?? getUndefinedIdx;
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: externref },
    then:
      resolvedUndefinedIdx === undefined
        ? [{ op: "ref.null.extern" }]
        : [{ op: "call", funcIdx: resolvedUndefinedIdx }],
    else: elseInstrs,
  });
  return externref;
}

/** A dynamic optional-method receiver that can be read twice observably safely. */
function isRepeatableDynamicOptionalReceiver(expr: ts.Expression): boolean {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return ts.isIdentifier(cur) || cur.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * The closure-field fallback in `compileOptionalCallExpression` re-evaluates the
 * receiver inside the non-null branch by delegating to the regular call path.
 * That is only correct when evaluating the receiver has no observable side
 * effect. Identifiers, `this`, and member chains rooted in those qualify;
 * calls and element access do not.
 */
function isSideEffectFreeOptionalReceiver(expr: ts.Expression): boolean {
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
