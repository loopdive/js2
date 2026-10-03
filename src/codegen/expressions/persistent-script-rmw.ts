// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { compileExpression } from "../expressions.js";
import { coerceType } from "../type-coercion.js";
import { emitToNumber, runtimeToPrimitiveInstrs } from "../coercion-engine.js";
import { ensureNativeBigIntCarrierUpdate } from "../bigint-carrier-update.js";
import { pushBody, popBody } from "../context/bodies.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { isUnresolvableIdent } from "./unresolvable-assign.js";
import {
  identifierHasOnlyAmbientDeclarations,
  identifierHasCurrentSourceTopLevelLexicalDeclaration,
} from "./identifier-module-storage.js";
import {
  capturePersistentScriptReference,
  emitPersistentScriptReferenceRead,
  emitPersistentScriptReferenceWrite,
} from "./persistent-script-lexical-assign.js";

export function usesPersistentScriptReference(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): boolean {
  return (
    !!ctx.standaloneScriptLexicalImport &&
    !ctx.sourceIsModule &&
    !fctx.withScopes?.length &&
    !identifierHasOnlyAmbientDeclarations(ctx, id) &&
    isUnresolvableIdent(ctx, fctx, id)
  );
}

/** Own top-level lexicals use the same canonical cell as later Scripts. Never
 * infer that ownership from a bare name: block/function shadows stay private. */
export function usesPersistentScriptUpdateReference(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
): boolean {
  if (usesPersistentScriptReference(ctx, fctx, id)) return true;
  return (
    !!ctx.standaloneScriptLexicalImport &&
    !ctx.sourceIsModule &&
    !fctx.withScopes?.length &&
    !fctx.localMap.has(id.text) &&
    !fctx.boxedCaptures?.has(id.text) &&
    ctx.globalLexicalBindings?.has(id.text) === true &&
    ctx.moduleGlobals.has(id.text) &&
    identifierHasCurrentSourceTopLevelLexicalDeclaration(ctx, id)
  );
}

export function persistentScriptUpdateMayBeBigInt(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
): boolean {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    expression = expression.expression;
  return (
    (ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)) &&
    (expression.operator === ts.SyntaxKind.PlusPlusToken || expression.operator === ts.SyntaxKind.MinusMinusToken) &&
    ts.isIdentifier(expression.operand) &&
    usesPersistentScriptUpdateReference(ctx, fctx, expression.operand)
  );
}

/** The ordinary binary emitter owns numeric/string/BigInt operator semantics;
 * this layer owns Reference evaluation, GetValue ordering and PutValue only. */
export function compilePersistentScriptCompound(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  rhs: ts.Expression,
  binaryOperator: ts.BinaryOperator,
): ValType | null {
  const ext: ValType = { kind: "externref" };
  const reference = capturePersistentScriptReference(ctx, fctx, id.text);
  emitPersistentScriptReferenceRead(ctx, fctx, reference);
  const leftName = `__script_compound_left_${fctx.locals.length}`;
  const left = allocLocal(fctx, leftName, ext);
  fctx.body.push({ op: "local.set", index: left });
  const rightType = compileExpression(ctx, fctx, rhs);
  if (!rightType) return null;
  const rightName = `__script_compound_right_${fctx.locals.length}`;
  const right = allocLocal(fctx, rightName, rightType);
  fctx.body.push({ op: "local.set", index: right });
  const rightIdentifier = ts.setOriginalNode(ts.factory.createIdentifier(rightName), rhs);
  // Carry the RHS's proven BigInt physical brand into the synthetic binary
  // expression. Losing it makes the ordinary emitter choose Number arithmetic.
  const expression = ts.factory.createBinaryExpression(
    ts.factory.createIdentifier(leftName),
    binaryOperator,
    rightIdentifier,
  );
  const resultType = compileExpression(ctx, fctx, expression);
  if (!resultType) return null;
  const result = allocLocal(fctx, `__script_compound_result_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: result }, { op: "local.get", index: result });
  if (resultType.kind !== "externref") coerceType(ctx, fctx, resultType, ext);
  const value = allocLocal(fctx, `__script_compound_value_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: value });
  emitPersistentScriptReferenceWrite(ctx, fctx, reference, value, isStrictContext(id, ctx.inferModuleStrictArguments));
  fctx.body.push({ op: "local.get", index: result });
  return resultType;
}

export function compilePersistentScriptUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  increment: boolean,
  prefix: boolean,
): ValType {
  const ext: ValType = { kind: "externref" };
  const reference = capturePersistentScriptReference(ctx, fctx, id.text);
  emitPersistentScriptReferenceRead(ctx, fctx, reference);
  const primitiveInstructions = runtimeToPrimitiveInstrs(ctx, "number");
  if (!primitiveInstructions) throw new Error("Persistent Script update requires native ToPrimitive");
  fctx.body.push(...primitiveInstructions);
  const primitive = allocLocal(fctx, `__script_update_primitive_${fctx.locals.length}`, ext);
  const value = allocLocal(fctx, `__script_update_value_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: primitive });
  const big = ensureLateImport(ctx, "__typeof_bigint", [ext], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (big === undefined) throw new Error("Persistent Script update requires native BigInt testing");
  fctx.body.push(
    { op: "local.get", index: primitive },
    { op: "call", funcIdx: ctx.funcMap.get("__typeof_bigint") ?? big },
  );

  const savedBig = pushBody(fctx);
  const update = ensureNativeBigIntCarrierUpdate(ctx);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push(
    { op: "local.get", index: primitive },
    { op: "i32.const", value: increment ? 1 : -1 },
    { op: "call", funcIdx: ctx.funcMap.get("__bigint_carrier_update") ?? update },
    { op: "local.set", index: value },
    { op: "local.get", index: prefix ? value : primitive },
  );
  const bigintBody = fctx.body;
  popBody(fctx, savedBig);
  fctx.savedBodies.push(bigintBody);

  const savedNumber = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: primitive });
  emitToNumber(ctx, fctx, ext);
  const oldValue = allocLocal(fctx, `__script_update_old_${fctx.locals.length}`, { kind: "f64" });
  const newValue = allocLocal(fctx, `__script_update_new_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push(
    { op: "local.tee", index: oldValue },
    { op: "f64.const", value: 1 },
    { op: increment ? "f64.add" : "f64.sub" },
    { op: "local.tee", index: newValue },
  );
  coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: value });
  fctx.body.push({ op: "local.get", index: prefix ? newValue : oldValue });
  coerceType(ctx, fctx, { kind: "f64" }, ext);
  const numberBody = fctx.body;
  popBody(fctx, savedNumber);
  fctx.savedBodies.splice(fctx.savedBodies.lastIndexOf(bigintBody), 1);
  fctx.body.push({ op: "if", blockType: { kind: "val", type: ext }, then: bigintBody, else: numberBody });
  const result = allocLocal(fctx, `__script_update_result_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: result });
  emitPersistentScriptReferenceWrite(ctx, fctx, reference, value, isStrictContext(id, ctx.inferModuleStrictArguments));
  fctx.body.push({ op: "local.get", index: result });
  return ext;
}

export function compilePersistentScriptLogical(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  rhs: ts.Expression,
  operator: ts.SyntaxKind,
): ValType | null {
  const ext: ValType = { kind: "externref" };
  const reference = capturePersistentScriptReference(ctx, fctx, id.text);
  emitPersistentScriptReferenceRead(ctx, fctx, reference);
  const old = allocLocal(fctx, `__script_logical_old_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: old });
  if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    const nullish = ensureLateImport(ctx, "__extern_is_nullish", [ext], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    if (nullish === undefined) throw new Error("Persistent Script logical assignment requires native nullish testing");
    fctx.body.push(
      { op: "local.get", index: old },
      { op: "call", funcIdx: ctx.funcMap.get("__extern_is_nullish") ?? nullish },
    );
  } else {
    const truthy = ensureLateImport(ctx, "__is_truthy", [ext], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    if (truthy === undefined) throw new Error("Persistent Script logical assignment requires native truthiness");
    fctx.body.push({ op: "local.get", index: old }, { op: "call", funcIdx: ctx.funcMap.get("__is_truthy") ?? truthy });
    if (operator === ts.SyntaxKind.BarBarEqualsToken) fctx.body.push({ op: "i32.eqz" });
  }
  const saved = pushBody(fctx);
  const type = compileExpression(ctx, fctx, rhs);
  if (!type) {
    popBody(fctx, saved);
    return null;
  }
  if (type.kind !== "externref") coerceType(ctx, fctx, type, ext);
  const value = allocLocal(fctx, `__script_logical_value_${fctx.locals.length}`, ext);
  fctx.body.push({ op: "local.set", index: value });
  emitPersistentScriptReferenceWrite(ctx, fctx, reference, value, isStrictContext(id, ctx.inferModuleStrictArguments));
  fctx.body.push({ op: "local.get", index: value });
  const assign = fctx.body;
  popBody(fctx, saved);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: ext },
    then: assign,
    else: [{ op: "local.get", index: old }],
  });
  return ext;
}
