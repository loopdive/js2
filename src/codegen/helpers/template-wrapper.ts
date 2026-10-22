// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106) The mechanics every template-built IR wrapper shares: a fresh helper
 * `FunctionContext` over fixed parameters, a detached template parsed into its
 * own file (so legacy's checker queries on it answer "unknown" — the facts of
 * an `any` site — and its emitters take their dynamic arms), and publication
 * as a defined function under the wrapper's name. Wrappers: the `Number(v)`
 * provider here, the dynamic method-call and Array.prototype borrow wrappers
 * (#7119, #6874 — their copies move here when they land).
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addFuncType } from "../registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";

/** A fresh helper `FunctionContext` whose parameters are addressable by name. */
export function receiverHelperContext(
  name: string,
  params: { name: string; type: ValType }[],
  returnType: ValType,
): FunctionContext {
  return {
    name,
    params,
    locals: [],
    localMap: new Map(params.map((param, index) => [param.name, index])),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

/** Register the finished helper as a defined function under its name; returns its index. */
export function publishReceiverHelper(ctx: CodegenContext, helper: FunctionContext, results: ValType[]): number {
  const typeIdx = addFuncType(
    ctx,
    helper.params.map((param) => param.type),
    results,
  );
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helper.name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: helper.name,
    typeIdx,
    locals: helper.locals,
    body: helper.body,
    exported: false,
  });
  return funcIdx;
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
