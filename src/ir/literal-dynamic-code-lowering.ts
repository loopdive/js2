// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The sites of the literal dynamic-code relation (`literal-dynamic-code.ts`), lowered. Each runs its source only
 * while the global it names (`eval`, `Function`) is the realm's built-in. That holds at every site when no source
 * rebinds the name (`isPristineBuiltinGlobal`, over every source, the dynamic-code ones included) and no sloppy
 * function lets the global object escape through its `this` (`ambientThisMayBeGlobal`), which would write the name
 * unseen. Otherwise the site refuses at select, by name.
 */
import { ts } from "../ts-api.js";
import { emitFunctionDeclarationObject, type FunctionValueHost } from "./function-declaration-values.js";
import type { IrFromAstResolver } from "./from-ast.js";
import type { IrFuncRef, IrValueId } from "./nodes.js";
import { demoteToLegacy } from "./outcomes.js";

/** The slice of the lowering context a site is lowered in. */
export interface LiteralDynamicCodeHost extends FunctionValueHost {
  readonly funcName: string;
  readonly resolver?: Pick<
    IrFromAstResolver,
    "literalEvalCalledInit" | "literalFunctionUnit" | "isPristineBuiltinGlobal" | "ambientThisMayBeGlobal"
  >;
}

/** A call that is a site of the relation, lowered; undefined when it is none. */
export function lowerLiteralDynamicCodeCall(
  call: ts.CallExpression,
  statementPosition: boolean,
  cx: LiteralDynamicCodeHost,
): IrValueId | null | undefined {
  const init = cx.resolver?.literalEvalCalledInit?.(call);
  return init !== undefined ? lowerLiteralEvalCall(call, init, statementPosition, cx) : lowerLiteralFunction(call, cx);
}

/**
 * (#7487) A literal `Function` site, called or constructed: a fresh function object of its source's declaration each
 * time it runs, named `"anonymous"` (CreateDynamicFunction); undefined when the site is none.
 */
export function lowerLiteralFunction(
  site: ts.CallExpression | ts.NewExpression,
  cx: LiteralDynamicCodeHost,
): IrValueId | undefined {
  const unit = cx.resolver?.literalFunctionUnit?.(site);
  if (unit === undefined) return undefined;
  if (!builtinIsPristine(site.expression as ts.Identifier, cx))
    refuse(`Function literal: the global Function is not pristine (#7487)`, cx);
  return emitFunctionDeclarationObject(cx, unit, "anonymous");
}

/**
 * (#7363 A4) A literal direct eval runs its text, a called script of the program (`init`: its module-init, `null` when
 * the text runs nothing). The site's completion value is A5's.
 */
function lowerLiteralEvalCall(
  call: ts.CallExpression,
  init: IrFuncRef | null,
  statementPosition: boolean,
  cx: LiteralDynamicCodeHost,
): null {
  if (!statementPosition) refuse("eval literal: its completion value needs #7363 A5", cx);
  if (!builtinIsPristine(call.expression as ts.Identifier, cx))
    refuse("eval literal: the global eval is not pristine (#7363 A4)", cx);
  if (init !== null) cx.builder.emitCall(init, [], null);
  return null;
}

function builtinIsPristine(name: ts.Identifier, cx: LiteralDynamicCodeHost): boolean {
  return cx.resolver?.isPristineBuiltinGlobal?.(name) === true && cx.resolver.ambientThisMayBeGlobal?.() === false;
}

function refuse(gap: string, cx: LiteralDynamicCodeHost): never {
  return demoteToLegacy("call-resolution-unsupported", `ir/from-ast: ${gap} in ${cx.funcName}`);
}
