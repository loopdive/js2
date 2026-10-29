// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106) The detached template every template-built IR wrapper parses: its
 * own source file, so legacy's checker queries on it answer "unknown" — the
 * facts of an `any` site — and its emitters take their dynamic arms. The
 * helper `FunctionContext` and its publication are `ir-helper-function.ts`'s
 * (`helperFunctionContext` / `publishHelperFunction`), shared with every IR
 * wrapper.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { noJsHost } from "../js-errors.js";

/**
 * The lanes every template-built IR wrapper serves: host-free and non-fast,
 * where legacy's `any` (the template's parameter type) is the IR's externref
 * carrier. A host lane's adapter may refuse a legacy import the emitters reach
 * (`__js_array_new` under the native-first kill switch, measured, #7119).
 */
export function irTemplateWrapperLane(ctx: CodegenContext): boolean {
  return noJsHost(ctx) && !ctx.fast;
}

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
