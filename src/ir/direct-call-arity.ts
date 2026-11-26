// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106 S1i, #7354 L0b) A direct call whose argument count differs from its callee's formals (§10.2.11: a missing
 * formal is `undefined`; §13.3.8.1: every argument is evaluated, an extra one is visible only through `arguments`).
 */
import { ts } from "../ts-api.js";
import type { IrDirectCallLoweringPlan } from "./ast-lowering-plans.js";
import type { IrUnitId } from "./identity.js";
import { directCallPublishesArgc } from "./select.js";

/**
 * The plan of a call (without spread arguments) that is not exactly the callee's arity, or `null` when this lowering
 * cannot build it. The exact callee declaration must be known (plain formals, no default or rest), so the argc
 * decision is the callee's, not a guess.
 *
 * - Under arity: legacy pads each missing formal with the canonical `undefined` and publishes `__argc = actual` when
 *   the callee reads its own `arguments`. Admitted only when every missing formal is the dynamic carrier (a concrete
 *   formal takes legacy's `0` sentinel, not `undefined`).
 * - (#7354 L0b) Over arity, on the Prepared lane: the extra arguments are evaluated and dropped, so a callee that
 *   reads `arguments` keeps the refusal.
 */
export function directCallArityPlan(
  expr: ts.CallExpression,
  direct: IrDirectCallLoweringPlan,
  declarationByUnitId: ReadonlyMap<IrUnitId, ts.Node> | undefined,
  lane: boolean,
): { readonly publishArgc: boolean } | null {
  const params = direct.signature.params;
  const actual = expr.arguments.length;
  if (actual === params.length || expr.arguments.some(ts.isSpreadElement)) return null;
  const over = actual > params.length;
  if (over ? !lane : params.slice(actual).some((param) => param.kind !== "dynamic")) return null;
  const binding = direct.target.binding;
  const declaration = binding.kind === "unit" ? declarationByUnitId?.get(binding.unitId) : undefined;
  if (
    declaration === undefined ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.parameters.length !== params.length ||
    declaration.parameters.some((parameter) => parameter.initializer || parameter.dotDotDotToken)
  ) {
    return null;
  }
  const publishArgc = directCallPublishesArgc(declaration);
  return over && publishArgc ? null : { publishArgc };
}
