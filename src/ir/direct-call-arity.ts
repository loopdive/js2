// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 S1i, #7354 L0b, #7562) A direct call's argument count against its callee's formals (§10.2.11: a missing
 * formal is `undefined`; §13.3.8.1: every argument is evaluated, an extra one is visible only through `arguments`).
 */
import { ts } from "../ts-api.js";
import type { IrDirectCallLoweringPlan } from "./ast-lowering-plans.js";
import type { IrUnitId } from "./identity.js";
import { ownArgumentsObjectUse } from "./analysis/ast-scope.js";
import { onPreparedDynamicLane, type LaneResolver } from "./function-object-lowering.js";

/**
 * How a direct call supplies its argument count, or `null` when this lowering cannot build it. The exact callee
 * declaration must be known (plain formals, no default or rest), so the argc decision is the callee's, not a guess.
 *
 * - Under arity (no spread argument): legacy pads each missing formal with the canonical `undefined` and publishes
 *   `__argc = actual` when the callee reads its own `arguments`. Admitted only when every missing formal is the dynamic
 *   carrier (a concrete formal takes legacy's `0` sentinel, not `undefined`).
 * - (#7562) Exact arity, unselected (Prepared): the call publishes too, as a dispatched caller's count is still
 *   installed.
 * - (#7354 L0b) Over arity (no spread argument), on the Prepared lane: the extra arguments are evaluated and dropped, so
 *   a callee that reads `arguments` keeps the refusal.
 */
export function directCallArityPlan(
  expr: ts.CallExpression,
  direct: IrDirectCallLoweringPlan,
  actual: number,
  cx: {
    readonly identityContext?: { readonly declarationByUnitId: ReadonlyMap<IrUnitId, ts.Node> };
    readonly resolver?: LaneResolver;
    readonly unselected?: true;
  },
): { readonly publishArgc: boolean } | null {
  const params = direct.signature.params;
  const over = actual > params.length;
  if (actual === params.length ? !cx.unselected : expr.arguments.some(ts.isSpreadElement)) return null;
  if (over && !onPreparedDynamicLane(cx.resolver)) return null;
  if (params.slice(actual).some((param) => param.kind !== "dynamic")) return null;
  const binding = direct.target.binding;
  const declaration = binding.kind === "unit" ? cx.identityContext?.declarationByUnitId.get(binding.unitId) : undefined;
  if (
    declaration === undefined ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.parameters.length !== params.length ||
    declaration.parameters.some((parameter) => parameter.initializer || parameter.dotDotDotToken)
  ) {
    return null;
  }
  const publishArgc = ownArgumentsObjectUse(declaration) !== "none";
  return over && publishArgc ? null : { publishArgc };
}
