// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Representation-aware JS coercion operations for the linear backend.
 *
 * The formatter owns Ryū arithmetic and memory layout; this module owns the
 * symbolic ToString operation and the stack-level call contract.
 */
import { ts } from "../ts-api.js";
import type { LinearContext, LinearFuncContext } from "./context.js";
import { linearStringLiteralInstrs } from "./string-literals.js";

export const NUMBER_TO_STRING_RUNTIME = "number_toString";

export function hasNumberToString(ctx: LinearContext): boolean {
  return ctx.funcMap.has(NUMBER_TO_STRING_RUNTIME);
}

export function emitNumberToStringCall(ctx: LinearContext, fctx: LinearFuncContext): void {
  const funcIdx = ctx.funcMap.get(NUMBER_TO_STRING_RUNTIME);
  if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
}

/** How ToString (§7.1.17) is lowered for one operand of a string `+` in the linear representation. */
type LinearToStringOperand = "string" | "number" | "boolean" | "null" | "undefined" | "unsupported";

const everyMember = (type: ts.Type, flags: ts.TypeFlags): boolean =>
  (type.flags & flags) !== 0 || (type.isUnion() && type.types.every((member) => (member.flags & flags) !== 0));

function classifyToStringOperand(checker: ts.TypeChecker, expr: ts.Expression): LinearToStringOperand {
  let inner = expr;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (inner.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isIdentifier(inner) && inner.text === "undefined") return "undefined";
  try {
    const type = checker.getTypeAtLocation(inner);
    // Mirrors the backend's `isStringExpr` (a `string | undefined` carrier is a string pointer).
    if (
      everyMember(type, ts.TypeFlags.StringLike) ||
      everyMember(checker.getNonNullableType(type), ts.TypeFlags.StringLike)
    ) {
      return "string";
    }
    if (everyMember(type, ts.TypeFlags.NumberLike)) return "number";
    if (everyMember(type, ts.TypeFlags.BooleanLike)) return "boolean";
  } catch {
    // Unresolvable operand: refused below rather than guessed.
  }
  return "unsupported";
}

/**
 * Source gate for the Ryū runtime (#6778): does this node make the lowering
 * stringify a number — a string `+`/`+=` with a numeric operand, or a numeric
 * template span? Kept beside {@link emitOperandToString} so the two agree.
 */
export function nodeStringifiesNumber(checker: ts.TypeChecker, node: ts.Node): boolean {
  if (ts.isTemplateSpan(node)) return classifyToStringOperand(checker, node.expression) === "number";
  if (!ts.isBinaryExpression(node)) return false;
  const op = node.operatorToken.kind;
  if (op !== ts.SyntaxKind.PlusToken && op !== ts.SyntaxKind.PlusEqualsToken) return false;
  const kinds = [classifyToStringOperand(checker, node.left), classifyToStringOperand(checker, node.right)];
  return kinds.includes("string") && kinds.includes("number");
}

/** The direct-lowering entry points the ToString emitter needs (index.ts owns them). */
export interface LinearToStringCompiler {
  readonly compileExpression: (ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression) => void;
  readonly compileExprToF64: (ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression) => void;
  readonly isStringExpr: (ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression) => boolean;
  readonly nodeLoc: (node: ts.Node) => { line: number; column: number };
}

/**
 * Push ToString(operand) as a linear string pointer (i32). An operand whose
 * representation the backend cannot stringify (objects, `any`, mixed unions,
 * bigint) is a hard codegen error — never a numeric fall-through (#6778).
 */
export function emitOperandToString(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  operand: ts.Expression,
  compiler: LinearToStringCompiler,
): void {
  if (compiler.isStringExpr(ctx, fctx, operand)) {
    compiler.compileExpression(ctx, fctx, operand);
    return;
  }
  const kind = classifyToStringOperand(ctx.checker, operand);
  if (kind === "null" || kind === "undefined") {
    fctx.body.push(...linearStringLiteralInstrs(ctx, kind));
    return;
  }
  if (kind === "boolean") {
    compiler.compileExprToF64(ctx, fctx, operand);
    fctx.body.push({ op: "f64.const", value: 0 }, { op: "f64.ne" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [...linearStringLiteralInstrs(ctx, "true")],
      else: [...linearStringLiteralInstrs(ctx, "false")],
    });
    return;
  }
  if (kind === "number" && hasNumberToString(ctx)) {
    compiler.compileExprToF64(ctx, fctx, operand);
    emitNumberToStringCall(ctx, fctx);
    return;
  }
  let typeText = "unknown";
  try {
    typeText = ctx.checker.typeToString(ctx.checker.getTypeAtLocation(operand));
  } catch {
    // keep "unknown"
  }
  ctx.errors.push({
    message:
      kind === "number"
        ? "linear backend: string concatenation needs the number formatter, which this module did not include"
        : `linear backend: cannot convert an operand of type '${typeText}' to a string for \`+\` concatenation`,
    ...compiler.nodeLoc(operand),
  });
  fctx.body.push({ op: "i32.const", value: 0 }); // keep the stack shape; the diagnostic fails the compile
}

/** `left + right` with either side a string: ToString both, then `__str_concat` (§13.15.3 step 3). */
export function emitStringConcat(
  ctx: LinearContext,
  fctx: LinearFuncContext,
  left: ts.Expression,
  right: ts.Expression,
  compiler: LinearToStringCompiler,
): void {
  emitOperandToString(ctx, fctx, left, compiler);
  emitOperandToString(ctx, fctx, right, compiler);
  const strConcatIdx = ctx.funcMap.get("__str_concat");
  if (strConcatIdx === undefined) throw new Error("linear string runtime: __str_concat helper missing");
  fctx.body.push({ op: "call", funcIdx: strConcatIdx });
}
