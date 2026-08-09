// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Escape analysis and scalar projection for proven-ASCII case conversions.
 *
 * A const `toLowerCase()` / `toUpperCase()` result observed only through
 * `.length` and `.charCodeAt()` does not need an allocated backing array. When
 * the receiver can only be immutable ASCII literals, retain its flat
 * (data, offset, length) descriptor and apply the one-code-unit case mapping
 * at each character projection instead.
 */
import { forEachChild, ts } from "../ts-api.js";
import type { Instr } from "../ir/types.js";
import { staticConstStringValues } from "./analysis/static-string-values.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureNativeStringHelpers, flatStringType } from "./native-strings.js";
import { coerceType, compileExpression } from "./shared.js";
import { emitTdzInit } from "./statements/tdz.js";

export function tryCompileDerivedAsciiCaseBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.VariableStatement,
  decl: ts.VariableDeclaration,
): boolean {
  if (
    process.env.JS2WASM_NATIVE_ASCII_CASE_SCALAR === "0" ||
    !ctx.nativeStrings ||
    !(stmt.declarationList.flags & ts.NodeFlags.Const) ||
    !ts.isIdentifier(decl.name) ||
    !decl.initializer ||
    !ts.isCallExpression(decl.initializer)
  ) {
    return false;
  }
  const call = decl.initializer;
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    (call.expression.name.text !== "toLowerCase" && call.expression.name.text !== "toUpperCase") ||
    call.arguments.length !== 0
  ) {
    return false;
  }
  ensureNativeStringHelpers(ctx);
  if (ctx.nativeStrTypeIdx < 0 || ctx.nativeStrDataTypeIdx < 0) return false;
  const receiver = call.expression.expression;
  const receiverValues = staticConstStringValues(ctx, receiver);
  if (!receiverValues?.length || !receiverValues.every(isAscii)) return false;

  if (!caseResultHasDescriptorOnlyUses(ctx, decl)) return false;

  const flatLocal = allocLocal(fctx, `__ascii_case_flat_${fctx.locals.length}`, flatStringType(ctx));
  const receiverType = compileExpression(ctx, fctx, receiver);
  if (receiverType?.kind === "externref" || receiverType?.kind === "ref_extern") {
    coerceType(ctx, fctx, receiverType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
  }
  // The immutable-literal proof excludes cons-string producers. The cast also
  // preserves the ordinary null/OOB trap of evaluating the source expression.
  fctx.body.push({ op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx });
  fctx.body.push({ op: "local.set", index: flatLocal });

  const dataLocal = allocLocal(fctx, `__ascii_case_data_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.nativeStrDataTypeIdx,
  });
  const offLocal = allocLocal(fctx, `__ascii_case_off_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__ascii_case_len_${fctx.locals.length}`, { kind: "i32" });
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
  );
  (fctx.derivedSubstringReads ??= new Map()).set(decl, {
    kind: call.expression.name.text === "toLowerCase" ? "lower" : "upper",
    dataLocal,
    offLocal,
    lenLocal,
    minLen: Math.min(...receiverValues.map((value) => value.length)),
  });
  emitTdzInit(ctx, fctx, decl.name.text);
  return true;
}

export function emitDerivedNativeCharCodeRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  descriptor: { kind: "native" | "lower" | "upper"; dataLocal: number; offLocal: number },
  idxLocal: number,
): Instr[] {
  const read: Instr[] = [
    { op: "local.get", index: descriptor.dataLocal },
    { op: "local.get", index: descriptor.offLocal },
    { op: "local.get", index: idxLocal },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
  ];
  if (descriptor.kind !== "native") {
    const charLocal = allocLocal(fctx, `__ascii_case_char_${fctx.locals.length}`, { kind: "i32" });
    const lo = descriptor.kind === "lower" ? 65 : 97;
    const delta = descriptor.kind === "lower" ? 32 : -32;
    read.push(
      { op: "local.tee", index: charLocal },
      { op: "i32.const", value: lo },
      { op: "i32.sub" },
      { op: "i32.const", value: 25 },
      { op: "i32.le_u" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "local.get", index: charLocal }, { op: "i32.const", value: delta }, { op: "i32.add" }],
        else: [{ op: "local.get", index: charLocal }],
      },
    );
  }
  read.push({ op: "f64.convert_i32_u" });
  return read;
}

export function selectProvenAsciiCaseHelper(
  ctx: CodegenContext,
  receiver: ts.Expression,
  fallback: string,
  proofAllowed: boolean,
): string {
  const values =
    proofAllowed && process.env.JS2WASM_NATIVE_PROVEN_ASCII_CASE !== "0"
      ? staticConstStringValues(ctx, receiver)
      : undefined;
  return values?.length && values.every(isAscii) ? `${fallback}_ascii` : fallback;
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) >= 0x80) return false;
  }
  return true;
}

function caseResultHasDescriptorOnlyUses(ctx: CodegenContext, declaration: ts.VariableDeclaration): boolean {
  let safe = true;
  let scope: ts.Node = declaration;
  while (scope.parent && !ts.isFunctionLike(scope.parent) && !ts.isSourceFile(scope.parent)) scope = scope.parent;
  scope = scope.parent ?? scope;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (node !== scope && ts.isFunctionLike(node)) {
      let captured = false;
      const findCapture = (child: ts.Node): void => {
        if (captured) return;
        if (ts.isIdentifier(child) && ctx.oracle.valueDeclarationOf(child) === declaration) captured = true;
        else forEachChild(child, findCapture);
      };
      forEachChild(node, findCapture);
      if (captured) safe = false;
      return;
    }
    if (ts.isIdentifier(node) && ctx.oracle.valueDeclarationOf(node) === declaration) {
      if (node === declaration.name) return;
      const property = node.parent;
      if (!ts.isPropertyAccessExpression(property) || property.expression !== node) {
        safe = false;
        return;
      }
      if (property.name.text === "length") {
        const use = property.parent;
        if (
          (ts.isBinaryExpression(use) &&
            use.left === property &&
            use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            use.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
          ((ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use)) && use.operand === property) ||
          (ts.isDeleteExpression(use) && use.expression === property)
        ) {
          safe = false;
          return;
        }
      } else if (
        property.name.text !== "charCodeAt" ||
        !ts.isCallExpression(property.parent) ||
        property.parent.expression !== property ||
        property.parent.arguments.length > 1
      ) {
        safe = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(scope);
  return safe;
}
