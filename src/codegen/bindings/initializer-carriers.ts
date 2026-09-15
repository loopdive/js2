// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getLocalType } from "../context/locals.js";
import { resolveWasmType } from "../index.js";
import { inferTaViewType } from "../statements/variables.js";
import { inferNativeTaViewCallResultType } from "../dataview-native.js";
import { genericStructFactoryExpression } from "../generic-struct-factory.js";
import { readonlyErasureMappedAliasTarget } from "../readonly-erasure-mapped-type.js";
import { canEmitAssertedStructExtension } from "../type-coercion.js";
import { getOrRegisterSubviewType } from "../registry/types.js";
import { localGlobalIdx } from "../registry/imports.js";
import { ensureRegexMatchVecType } from "../native-regex.js";

function isVecStructType(ctx: CodegenContext, type: ValType | undefined): type is ValType & { typeIdx: number } {
  if (!type || (type.kind !== "ref" && type.kind !== "ref_null")) return false;
  const def = ctx.mod.types[type.typeIdx];
  return def?.kind === "struct" && def.fields[0]?.name === "length" && def.fields[1]?.name === "data";
}

function stripRegExpInferenceWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}

function isStaticRegExpExpressionForInference(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripRegExpInferenceWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if (ts.isNewExpression(unwrapped) || (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken)) {
    const callee = stripRegExpInferenceWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && callee.text === "RegExp";
  }
  if (ts.isIdentifier(unwrapped)) {
    const sym = ctx.checker.getSymbolAtLocation(unwrapped);
    const decl = sym?.getDeclarations()?.find((d) => ts.isVariableDeclaration(d)) as ts.VariableDeclaration | undefined;
    return decl?.initializer !== undefined && isStaticRegExpExpressionForInference(ctx, decl.initializer);
  }
  return false;
}

function nativeStringVecTypeForStandaloneRegExp(ctx: CodegenContext): ValType | null {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;
  // The match result is the match-vec SUBTYPE of the nstr vec (#1914) — the
  // precise local type keeps `.index`/`.input` reads cast-free while every
  // base-vec consumer still applies via subsumption.
  const vecTypeIdx = ensureRegexMatchVecType(ctx);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/** True for the computed key `Symbol.match` (the @@match well-known symbol). */
function isSymbolMatchKeyForInference(arg: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(arg) &&
    ts.isIdentifier(arg.expression) &&
    arg.expression.text === "Symbol" &&
    arg.name.text === "match"
  );
}

function inferStandaloneRegExpMatchArrayType(
  ctx: CodegenContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!ctx.standalone || !initializer) return null;
  const unwrapped = stripRegExpInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped)) return null;
  if (ts.isPropertyAccessExpression(unwrapped.expression)) {
    const method = unwrapped.expression.name.text;
    if (method === "exec") {
      return isStaticRegExpExpressionForInference(ctx, unwrapped.expression.expression)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
    if (method === "match" && unwrapped.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, unwrapped.arguments[0]!)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
    return null;
  }
  // `re[Symbol.match](s)` (#2161) — symbol-protocol dual of `s.match(re)`.
  if (ts.isElementAccessExpression(unwrapped.expression)) {
    const elem = unwrapped.expression;
    if (isSymbolMatchKeyForInference(elem.argumentExpression) && unwrapped.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, elem.expression)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
  }
  return null;
}

export function inferLetConstInitializerWasmType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  declaration: ts.VariableDeclaration,
): ValType | null {
  const initializer = declaration.initializer;
  if (!initializer) return null;
  // (#4376) Keep the authoritative pre-hoisted slot type in lockstep with
  // compileVariableStatement. A buffer-backed typed array is represented by a
  // shared-backing `$__ta_view`, not the checker-inferred plain vector. Nested
  // functions record their capture signatures before declaration lowering, so
  // missing this override made reifying a closure cast the real view value to
  // an unrelated vector type and trap during Deno core bootstrap.
  const taViewType = inferTaViewType(ctx, initializer);
  if (taViewType !== null) return taViewType;
  const taViewCallResultType = inferNativeTaViewCallResultType(ctx, initializer);
  if (taViewCallResultType !== null) return taViewCallResultType;
  const standaloneRegExpMatchArrayType = inferStandaloneRegExpMatchArrayType(ctx, initializer);
  if (standaloneRegExpMatchArrayType !== null) return standaloneRegExpMatchArrayType;

  const genericFactory = genericStructFactoryExpression(ctx, initializer);
  if (genericFactory) {
    const target = resolveWasmType(ctx, genericFactory.target);
    if (target.kind === "ref" || target.kind === "ref_null") {
      // Wasm locals must be defaultable. The call emitter materializes the
      // concrete target before the initializer is stored into this slot.
      return { kind: "ref_null", typeIdx: target.typeIdx };
    }
    if (
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      genericFactory.sourceResultAbi === true &&
      (target.kind === "externref" || target.kind === "ref_extern")
    ) {
      const source = resolveWasmType(ctx, genericFactory.sourceConstraint);
      if (source.kind === "ref" || source.kind === "ref_null") {
        // An unmaterializable logical T does not change what the proven fresh
        // factory allocated. Preserve that source carrier in the authoritative
        // pre-hoisted slot so its physical fields remain observable.
        return { kind: "ref_null", typeIdx: source.typeIdx };
      }
    }
  }

  const unwrapped = stripRegExpInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped) || !ts.isPropertyAccessExpression(unwrapped.expression)) {
    return null;
  }

  const methodName = unwrapped.expression.name.text;
  if (methodName !== "subarray" && methodName !== "slice") return null;

  const receiver = unwrapped.expression.expression;
  let receiverType: ValType | undefined;
  if (ts.isIdentifier(receiver)) {
    const localIdx = fctx.localMap.get(receiver.text);
    if (localIdx !== undefined) receiverType = getLocalType(fctx, localIdx);
    else {
      const globalIdx = ctx.moduleGlobals.get(receiver.text);
      if (globalIdx !== undefined) receiverType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
    }
  }
  receiverType ??= resolveWasmType(ctx, ctx.checker.getTypeAtLocation(receiver));
  if (!isVecStructType(ctx, receiverType)) return null;
  // (#2357/#47) Standalone `subarray` produces a `$__subview` that shares the
  // parent's backing array (true aliasing). Resolving the binding to the subview
  // type here is what makes element access pick the windowed lowering at COMPILE
  // time (so plain-array `a[i]` stays zero-cost). `slice` still returns an
  // independent copy (a plain vec). The receiver may itself be a subview (nested
  // subarray) — its element kind is recovered from the base vec.
  if (methodName === "subarray" && (ctx.standalone || ctx.wasi)) {
    const recvIdx = (receiverType as { typeIdx: number }).typeIdx;
    // elemKind from the receiver's struct name: `__vec_<elem>` (plain typed array)
    // or `__subview_<elem>` (nested subarray over a subview).
    const recvName = ctx.typeIdxToStructName.get(recvIdx);
    const elemKind = recvName?.replace(/^__vec_/, "").replace(/^__subview_/, "");
    if (elemKind !== undefined && elemKind !== recvName) {
      const svIdx = getOrRegisterSubviewType(ctx, elemKind);
      return { kind: "ref_null", typeIdx: svIdx };
    }
  }
  return { kind: "ref_null", typeIdx: receiverType.typeIdx };
}

/** Declaration evidence includes destination-extension recovery; hoisting does not. */
export function planDeclarationFreshFactoryCarrier(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  varType: ts.Type,
): { source: ValType | null; target: ValType | null; initializerType: ValType | null } {
  const genericFactory = decl.initializer ? genericStructFactoryExpression(ctx, decl.initializer) : null;
  const genericFactorySource = genericFactory ? resolveWasmType(ctx, genericFactory.sourceConstraint) : null;
  const genericFactorySignatureTarget = genericFactory ? resolveWasmType(ctx, genericFactory.target) : null;
  const genericFactoryBindingTarget = genericFactory
    ? resolveWasmType(ctx, readonlyErasureMappedAliasTarget(varType) ?? varType)
    : null;
  // Program-ABI replay can retain the concrete binding type while collapsing
  // the call's instantiated return back to its generic constraint. Recover
  // the binding destination only for an already-proven fresh factory and
  // only when it is a physically compatible strict extension of that source.
  const genericFactoryTarget =
    genericFactorySource &&
    genericFactorySignatureTarget &&
    genericFactoryBindingTarget &&
    (genericFactorySource.kind === "ref" || genericFactorySource.kind === "ref_null") &&
    (genericFactorySignatureTarget.kind === "ref" || genericFactorySignatureTarget.kind === "ref_null") &&
    (genericFactoryBindingTarget.kind === "ref" || genericFactoryBindingTarget.kind === "ref_null") &&
    genericFactorySignatureTarget.typeIdx === genericFactorySource.typeIdx &&
    genericFactoryBindingTarget.typeIdx !== genericFactorySource.typeIdx &&
    canEmitAssertedStructExtension(
      ctx,
      { kind: "ref_null", typeIdx: genericFactorySource.typeIdx },
      { kind: "ref_null", typeIdx: genericFactoryBindingTarget.typeIdx },
    )
      ? genericFactoryBindingTarget
      : genericFactorySignatureTarget;
  const genericFactoryInitializerType: ValType | null =
    genericFactoryTarget?.kind === "ref" || genericFactoryTarget?.kind === "ref_null"
      ? { kind: "ref_null", typeIdx: genericFactoryTarget.typeIdx }
      : (decl.parent.flags & ts.NodeFlags.Const) !== 0 &&
          genericFactory?.sourceResultAbi === true &&
          (genericFactoryTarget?.kind === "externref" || genericFactoryTarget?.kind === "ref_extern") &&
          (genericFactorySource?.kind === "ref" || genericFactorySource?.kind === "ref_null")
        ? // Keep this declaration in lockstep with the let/const pre-hoister:
          // an opaque logical T still carries the proven factory's physical
          // source fields.
          { kind: "ref_null", typeIdx: genericFactorySource.typeIdx }
        : null;
  return { source: genericFactorySource, target: genericFactoryTarget, initializerType: genericFactoryInitializerType };
}
