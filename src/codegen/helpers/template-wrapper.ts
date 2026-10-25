// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106) The template mechanics every template-built IR wrapper shares: a
 * detached template parsed into its own file (so legacy's checker queries on
 * it answer "unknown" — the facts of an `any` site — and its emitters take
 * their dynamic arms), and one template expression compiled as a value of the
 * wrapper's carrier type. The helper `FunctionContext` and its publication
 * are `receiverHelperContext` / `publishReceiverHelper` in
 * `ir-dynamic-construct.ts`. Wrappers: the dynamic method-call wrapper
 * (#7119, `object-model/ir-dynamic-method-call.ts`) and the Array.prototype
 * borrow wrapper (`array/ir-array-prototype-borrow.ts`).
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression, VOID_RESULT } from "../shared.js";
import { coerceType } from "../type-coercion.js";
import { emitUndefined } from "../expressions/late-imports.js";

/**
 * Parse a template function `text` in its own detached file and return the
 * expressions of its `count` expression statements. Throws when the text does
 * not hold exactly `count` statements.
 */
export function parseDetachedTemplate(fileName: string, text: string, count: number): readonly ts.Expression[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const fn = file.statements[0];
  const statements = fn && ts.isFunctionDeclaration(fn) ? fn.body?.statements : undefined;
  const expressions = (statements ?? []).flatMap((statement) =>
    ts.isExpressionStatement(statement) ? [statement.expression] : [],
  );
  if (expressions.length !== count)
    throw new Error(`ir/template: ${fileName} did not parse (${expressions.length}/${count})`);
  return expressions;
}

/** Compile one template expression as a value of `type` onto `helper.body` (undefined for a void result). */
export function compileTemplateExpressionAs(
  ctx: CodegenContext,
  helper: FunctionContext,
  expression: ts.Expression,
  type: ValType,
): void {
  const result = compileExpression(ctx, helper, expression, type);
  if (result === null || (result as unknown) === VOID_RESULT) emitUndefined(ctx, helper);
  else if (result.kind !== type.kind) coerceType(ctx, helper, result, type);
}
