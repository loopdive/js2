// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Exact-shape property reads for structural contracts and nominal classes.
 *
 * WasmGC canonicalises structurally equal layouts, so runtime identity must be
 * decided by the compiler's shape/class stamps before reading a field.
 */
import { ts } from "../ts-api.js";
import type { FieldDef, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureExternrefToNumberProvider } from "./coercion-engine.js";
import { allocLocal } from "./context/locals.js";
import { emitPrivateBrandPredicate } from "./expressions/helpers.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import {
  emitExternrefToStructGet,
  emitNullCheckThrow,
  emitNullGuardedStructGet,
  isProvablyNonNull,
  typeErrorThrowInstrs,
} from "./property-access.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { emitRuntimeEvalSharedValueUnwrap } from "./global-environment.js";

function isStructuralObjectContract(ctx: CodegenContext, objType: ts.Type, typeName?: string): boolean {
  if (typeName !== undefined && ctx.classSet.has(typeName)) return false;
  if (typeName?.startsWith("__anon_") && !typeName.startsWith("__anonClass_")) return true;
  if (objType.isUnion()) {
    const nonNullish = objType.types.filter(
      (member) =>
        (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) === 0,
    );
    return (
      nonNullish.length > 0 &&
      nonNullish.every((member) => isStructuralObjectContract(ctx, member, member.getSymbol()?.name))
    );
  }
  const symbols = [objType.aliasSymbol, objType.getSymbol()].filter(
    (symbol): symbol is ts.Symbol => symbol !== undefined,
  );
  return symbols.some((symbol) =>
    symbol.declarations?.some(
      (decl) =>
        ts.isInterfaceDeclaration(decl) ||
        ts.isTypeAliasDeclaration(decl) ||
        ts.isTypeLiteralNode(decl) ||
        ts.isObjectLiteralExpression(decl),
    ),
  );
}

function emitStructuralExternrefFieldGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  receiverAlreadyNullChecked = false,
): ValType | undefined {
  const accessFact = ctx.oracle.typeFactOf(expr);
  const accessWasm: ValType =
    accessFact.kind === "number"
      ? { kind: "f64" }
      : accessFact.kind === "boolean"
        ? { kind: "i32", boolean: true }
        : { kind: "externref" };
  const mayBeUndefined = ctx.oracle.nullabilityOf(expr).undefinable;
  const resultType: ValType =
    !mayBeUndefined && (accessWasm.kind === "f64" || accessWasm.kind === "i32") ? accessWasm : { kind: "externref" };
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  let unboxIdx: number | undefined;
  if (resultType.kind === "f64" || resultType.kind === "i32") {
    unboxIdx = ensureExternrefToNumberProvider(ctx, fctx);
  }
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined) return undefined;
  if (!receiverAlreadyNullChecked) emitNullCheckThrow(ctx, fctx, { kind: "externref" }, expr);
  addStringConstantGlobal(ctx, propName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "call", funcIdx: getIdx });
  if (ctx.runtimeEvalGlobalFunctionBindings === true) {
    emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
  }
  if (resultType.kind === "f64" && unboxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: unboxIdx });
  } else if (resultType.kind === "i32" && unboxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: unboxIdx }, { op: "i32.trunc_sat_f64_s" });
  }
  return resultType;
}

function emitNominalExternrefClassFieldGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  className: string,
  structTypeIdx: number,
  fieldIdx: number,
  fieldType: ValType,
  recvType?: ValType | null,
): ValType {
  // (#4157) `recvType` is the receiver BEFORE the `extern.convert_any` the
  // caller applied; a non-nullable `(ref $T)` cannot become a null externref.
  emitNullCheckThrow(ctx, fctx, { kind: "externref" }, expr, {
    site: "exact-shapes:nominal-class-recv",
    compiled: recvType,
    expr: expr.expression,
  });
  fctx.body.push({ op: "any.convert_extern" });
  const receiverLocal = allocLocal(fctx, `__nominal_recv_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: receiverLocal });
  emitPrivateBrandPredicate(ctx, fctx, receiverLocal, className, structTypeIdx);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: fieldType },
    then: [
      { op: "local.get", index: receiverLocal },
      { op: "ref.cast", typeIdx: structTypeIdx },
      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
    ],
    else: typeErrorThrowInstrs(ctx, expr),
  });
  return fieldType;
}

/**
 * Compile the complete exact field-read band when the named struct owns the
 * field. Undefined means the struct has no such field and the caller should
 * continue with its prototype/dynamic fallback bands.
 */
export function tryEmitExactStructFieldGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
  typeName: string,
  structTypeIdx: number,
  fields: FieldDef[],
): ValType | undefined {
  const fieldIdx = fields.findIndex((field) => field.name === propName);
  if (fieldIdx === -1) return undefined;
  const objResult = compileExpression(ctx, fctx, expr.expression);
  const fieldType = fields[fieldIdx]!.type;
  if (
    ctx.standalone &&
    objResult &&
    ctx.classSet.has(typeName) &&
    (objResult.kind === "externref" || objResult.kind === "ref" || objResult.kind === "ref_null")
  ) {
    if (objResult.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
    return emitNominalExternrefClassFieldGet(ctx, fctx, expr, typeName, structTypeIdx, fieldIdx, fieldType, objResult);
  }
  if (objResult?.kind === "ref_null") {
    emitNullGuardedStructGet(ctx, fctx, objResult, fieldType, structTypeIdx, fieldIdx, propName, false, {
      site: "exact-shapes:struct-get-recv",
      compiled: objResult,
      expr: expr.expression,
    });
    return fieldType.kind === "ref" ? { kind: "ref_null", typeIdx: fieldType.typeIdx } : fieldType;
  }
  if (objResult?.kind === "externref") {
    if ((!ctx.standalone && !ctx.wasi) || isStructuralObjectContract(ctx, objType, typeName)) {
      const structuralResult = emitStructuralExternrefFieldGet(ctx, fctx, expr, propName);
      if (structuralResult !== undefined) return structuralResult;
    }
    emitExternrefToStructGet(ctx, fctx, fieldType, structTypeIdx, fieldIdx, propName, true);
    return fieldType.kind === "ref" ? { kind: "ref_null", typeIdx: fieldType.typeIdx } : fieldType;
  }
  if (objResult?.kind === "ref") {
    // The value is a NON-nullable ref; the widening below is a codegen
    // convenience, not a claim that it can be null (#4157).
    const nullableObj: ValType = { kind: "ref_null", typeIdx: objResult.typeIdx ?? structTypeIdx };
    emitNullGuardedStructGet(ctx, fctx, nullableObj, fieldType, structTypeIdx, fieldIdx, propName, false, {
      site: "exact-shapes:struct-get-recv-widened",
      compiled: objResult,
      expr: expr.expression,
    });
    return fieldType.kind === "ref" ? { kind: "ref_null", typeIdx: fieldType.typeIdx } : fieldType;
  }
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
  return fieldType;
}

export function tryEmitStructuralContractReadFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
  objType: ts.Type,
  typeName: string | undefined,
  receiverLocal: number,
): ValType | undefined {
  if (!ctx.standalone || !isStructuralObjectContract(ctx, objType, typeName)) return undefined;
  fctx.body.push({ op: "local.get", index: receiverLocal });
  const result = emitStructuralExternrefFieldGet(ctx, fctx, expr, propName, true);
  if (result === undefined) fctx.body.push({ op: "drop" });
  return result;
}
