// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Scalar observations of non-escaping single-code-unit string splits. */
import { forEachChild, ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureNativeStringHelpers, flatStringType } from "./native-strings.js";
import { coerceType, compileExpression } from "./shared.js";
import { emitTdzInit } from "./statements/tdz.js";

const splitTailLengthLocals = new WeakMap<FunctionContext, Map<ts.Declaration, number>>();

export function tryCompileSingleUnitSplitLengthBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.VariableStatement,
  decl: ts.VariableDeclaration,
): boolean {
  if (
    !ctx.nativeStrings ||
    ctx.anyStrTypeIdx < 0 ||
    ctx.nativeStrTypeIdx < 0 ||
    ctx.nativeStrDataTypeIdx < 0 ||
    !(stmt.declarationList.flags & ts.NodeFlags.Const)
  ) {
    return false;
  }
  if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isCallExpression(decl.initializer)) return false;
  const call = decl.initializer;
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "split") return false;
  if (
    call.arguments.length !== 1 ||
    !ts.isStringLiteralLike(call.arguments[0]!) ||
    call.arguments[0]!.text.length !== 1
  ) {
    return false;
  }
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return false;

  let safe = true;
  let observesTailLength = false;
  let scope: ts.Node = decl;
  while (scope.parent && !ts.isFunctionLike(scope.parent) && !ts.isSourceFile(scope.parent)) scope = scope.parent;
  scope = scope.parent ?? scope;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (node !== scope && ts.isFunctionLike(node)) {
      let captured = false;
      const findCapture = (child: ts.Node): void => {
        if (captured) return;
        if (ts.isIdentifier(child) && ctx.oracle.valueDeclarationOf(child) === decl) captured = true;
        else forEachChild(child, findCapture);
      };
      forEachChild(node, findCapture);
      if (captured) safe = false;
      return;
    }
    if (ts.isIdentifier(node) && ctx.oracle.valueDeclarationOf(node) === decl) {
      if (node === decl.name) return;
      const property = node.parent;
      if (isSafeDirectLengthRead(property, node)) {
        // accepted
      } else if (
        process.env.JS2WASM_NATIVE_SPLIT_TAIL_SCALAR !== "0" &&
        isSplitTailLengthRead(ctx, property, node, decl)
      ) {
        observesTailLength = true;
      } else {
        safe = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(scope);
  if (!safe) return false;

  ensureNativeStringHelpers(ctx);
  const flatLocal = allocLocal(fctx, `__split_count_flat_${fctx.locals.length}`, flatStringType(ctx));
  const receiverType = compileExpression(ctx, fctx, call.expression.expression);
  if (receiverType?.kind === "externref") {
    coerceType(ctx, fctx, receiverType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
  }
  fctx.body.push({ op: "call", funcIdx: ctx.nativeStrHelpers.get("__str_flatten")! });
  fctx.body.push({ op: "local.set", index: flatLocal });

  const dataLocal = allocLocal(fctx, `__split_count_data_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.nativeStrDataTypeIdx,
  });
  const offLocal = allocLocal(fctx, `__split_count_off_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__split_count_len_${fctx.locals.length}`, { kind: "i32" });
  const indexLocal = allocLocal(fctx, `__split_count_i_${fctx.locals.length}`, { kind: "i32" });
  const countLocal = allocLocal(fctx, `__split_count_${decl.name.text}_${fctx.locals.length}`, { kind: "i32" });
  const tailStartLocal = observesTailLength
    ? allocLocal(fctx, `__split_tail_start_${fctx.locals.length}`, { kind: "i32" })
    : undefined;
  const tailLengthLocal = observesTailLength
    ? allocLocal(fctx, `__split_tail_len_${decl.name.text}_${fctx.locals.length}`, { kind: "i32" })
    : undefined;

  fctx.body.push(
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: dataLocal },
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: offLocal },
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: lenLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: indexLocal },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: countLocal },
  );
  if (tailStartLocal !== undefined) {
    fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: tailStartLocal });
  }

  const onSeparator: Instr[] = [
    { op: "local.get", index: countLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: countLocal },
  ];
  if (tailStartLocal !== undefined) {
    onSeparator.push(
      { op: "local.get", index: indexLocal },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: tailStartLocal },
    );
  }
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: indexLocal },
          { op: "local.get", index: lenLocal },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: dataLocal },
          { op: "local.get", index: offLocal },
          { op: "local.get", index: indexLocal },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
          { op: "i32.const", value: call.arguments[0]!.text.charCodeAt(0) },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: [...onSeparator] },
          { op: "local.get", index: indexLocal },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: indexLocal },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });
  (fctx.derivedStringArrayLengthLocals ??= new Map()).set(symbol, countLocal);
  if (tailStartLocal !== undefined && tailLengthLocal !== undefined) {
    fctx.body.push(
      { op: "local.get", index: lenLocal },
      { op: "local.get", index: tailStartLocal },
      { op: "i32.sub" },
      { op: "local.set", index: tailLengthLocal },
    );
    let tailLocals = splitTailLengthLocals.get(fctx);
    if (!tailLocals) splitTailLengthLocals.set(fctx, (tailLocals = new Map()));
    tailLocals.set(decl, tailLengthLocal);
  }
  emitTdzInit(ctx, fctx, decl.name.text);
  return true;
}

export function tryEmitDerivedLengthLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (propName !== "length") return undefined;
  if (ts.isIdentifier(expr.expression)) {
    const symbol = ctx.checker.getSymbolAtLocation(expr.expression);
    const substring = symbol?.valueDeclaration ? fctx.derivedSubstringReads?.get(symbol.valueDeclaration) : undefined;
    const local = substring?.lenLocal ?? (symbol ? fctx.derivedStringArrayLengthLocals?.get(symbol) : undefined);
    if (local === undefined) return undefined;
    fctx.body.push({ op: "local.get", index: local });
    return { kind: "i32" };
  }
  if (!ts.isElementAccessExpression(expr.expression)) return undefined;
  const element = expr.expression;
  if (!ts.isIdentifier(element.expression)) return undefined;
  const declaration = ctx.oracle.valueDeclarationOf(element.expression);
  if (!declaration) return undefined;
  const local = splitTailLengthLocals.get(fctx)?.get(declaration);
  if (local === undefined || !isLastElementIndex(ctx, element.argumentExpression, declaration)) return undefined;
  fctx.body.push({ op: "local.get", index: local });
  return { kind: "i32" };
}

function isSafeDirectLengthRead(parent: ts.Node, node: ts.Identifier): boolean {
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node || parent.name.text !== "length") {
    return false;
  }
  return propertyReadIsSafe(parent);
}

function isSplitTailLengthRead(
  ctx: CodegenContext,
  parent: ts.Node,
  node: ts.Identifier,
  declaration: ts.VariableDeclaration,
): boolean {
  if (!ts.isElementAccessExpression(parent) || parent.expression !== node) return false;
  const lengthRead = parent.parent;
  return (
    ts.isPropertyAccessExpression(lengthRead) &&
    lengthRead.expression === parent &&
    lengthRead.name.text === "length" &&
    propertyReadIsSafe(lengthRead) &&
    isLastElementIndex(ctx, parent.argumentExpression, declaration)
  );
}

function isLastElementIndex(
  ctx: CodegenContext,
  index: ts.Expression | undefined,
  declaration: ts.Declaration,
): boolean {
  return (
    index !== undefined &&
    ts.isBinaryExpression(index) &&
    index.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    ts.isPropertyAccessExpression(index.left) &&
    index.left.name.text === "length" &&
    ts.isIdentifier(index.left.expression) &&
    ctx.oracle.valueDeclarationOf(index.left.expression) === declaration &&
    ts.isNumericLiteral(index.right) &&
    Number(index.right.text) === 1
  );
}

function propertyReadIsSafe(property: ts.PropertyAccessExpression): boolean {
  const use = property.parent;
  return !(
    (ts.isBinaryExpression(use) &&
      use.left === property &&
      use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      use.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use)) && use.operand === property) ||
    (ts.isDeleteExpression(use) && use.expression === property)
  );
}
