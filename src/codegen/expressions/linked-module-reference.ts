// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { coerceType, compileExpression } from "../shared.js";
import { compileComputedMemberKeyAfterBaseGuard, emitBaseCoercibilityGuard } from "./computed-member-reference.js";
import { ensureExternIsUndefinedImport, flushLateImportShifts } from "./late-imports.js";

/** Keep the entire remaining chain inside the non-nullish branch, including
 * computed keys and arguments. Saved bodies participate in late-import shifts. */
export function withLinkedOptionalReference(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: number,
  emit: () => void,
): void {
  ensureExternIsUndefinedImport(ctx);
  const missing = canonicalUndefinedExternInstrs(ctx);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push(
    { op: "local.get", index: value },
    { op: "ref.is_null" },
    { op: "local.get", index: value },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined")! },
    { op: "i32.or" },
  );
  const saved = pushBody(fctx);
  fctx.blockDepth++;
  try {
    emit();
  } finally {
    fctx.blockDepth--;
  }
  const present = fctx.body;
  popBody(fctx, saved);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: missing,
    else: present,
  });
}

export function unwrapLinkedCallReference(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

/** Resolve a reference once, retaining its receiver. Parenthesized inner
 * chains remain opaque so `(a?.b).c()` does not inherit the inner guard. */
export function emitLinkedModuleReference(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
  receiver: number,
  next: (value: number) => void,
): void {
  const value = allocLocal(fctx, "linkedReferenceValue", { kind: "externref" });
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    emitLinkedModuleReference(ctx, fctx, expression.expression, receiver, (base) => {
      const read = (): void => {
        if (ts.isPropertyAccessExpression(expression)) emitBaseCoercibilityGuard(ctx, fctx, base);
        const key = ts.isElementAccessExpression(expression)
          ? compileComputedMemberKeyAfterBaseGuard(ctx, fctx, base, expression.argumentExpression, "linkedImportKey")
          : undefined;
        if (key === null) throw new Error("Linked module call key could not be compiled");
        const literal = ts.isPropertyAccessExpression(expression)
          ? stringConstantExternrefInstrs(ctx, expression.name.text)
          : [];
        flushLateImportShifts(ctx, fctx);
        fctx.body.push(
          { op: "local.get", index: base },
          { op: "local.set", index: receiver },
          { op: "local.get", index: base },
          ...(key === undefined ? literal : [{ op: "local.get" as const, index: key }]),
          { op: "call", funcIdx: ctx.funcMap.get("__extern_get")! },
          { op: "local.set", index: value },
        );
        next(value);
      };
      if (expression.questionDotToken) withLinkedOptionalReference(ctx, fctx, base, read);
      else read();
    });
    return;
  }
  const type = compileExpression(ctx, fctx, expression, { kind: "externref" });
  if (type === null) throw new Error("Linked module call value could not be compiled");
  if (type.kind !== "externref") coerceType(ctx, fctx, type, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: value });
  next(value);
}
