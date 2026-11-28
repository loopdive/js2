// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The sites of the literal dynamic-code relation (`literal-dynamic-code.ts`), lowered. Admission already refused the
 * program unless every site lowers (`literalDynamicCodeSiteRefusal`), so each arm only emits its site: an eval runs
 * the called script that holds its text, a `Function` site makes a fresh function object of its source's declaration.
 */
import { ts } from "../ts-api.js";
import { emitFunctionDeclarationObject, type FunctionValueHost } from "./function-declaration-values.js";
import type { IrFromAstResolver } from "./from-ast.js";
import type { IrValueId } from "./nodes.js";

/** The slice of the lowering context a site is lowered in. */
export interface LiteralDynamicCodeHost extends FunctionValueHost {
  readonly resolver?: Pick<
    IrFromAstResolver,
    "literalEvalCalledInit" | "literalFunctionUnit" | "closureCodeStrictness"
  >;
}

/** A site of the relation, lowered; undefined when the node is none. A `new` is only ever a `Function` site. */
export function lowerLiteralDynamicCodeSite(site: ts.NewExpression, cx: LiteralDynamicCodeHost): IrValueId | undefined;
export function lowerLiteralDynamicCodeSite(
  site: ts.CallExpression,
  cx: LiteralDynamicCodeHost,
): IrValueId | null | undefined;
export function lowerLiteralDynamicCodeSite(
  site: ts.CallExpression | ts.NewExpression,
  cx: LiteralDynamicCodeHost,
): IrValueId | null | undefined {
  const init = ts.isCallExpression(site) ? cx.resolver?.literalEvalCalledInit?.(site) : undefined;
  // (#7363 A4) The eval's text, a called script of the program; `null` when the text runs nothing.
  if (init !== undefined) {
    if (init !== null) cx.builder.emitCall(init, [], null);
    return null;
  }
  // (#7487) CreateDynamicFunction's function object, named "anonymous"; a fresh one each time the site runs.
  const unit = cx.resolver?.literalFunctionUnit?.(site);
  return unit === undefined ? undefined : emitFunctionDeclarationObject(cx, unit, "anonymous");
}
