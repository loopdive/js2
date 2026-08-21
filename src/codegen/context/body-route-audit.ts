// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ArrowFunction, FunctionDeclaration, FunctionExpression } from "typescript";
import type { IrPlanningIdentityContext } from "../../ir/planning-identity.js";
import type { IrCompileRoute } from "../../ir/standalone-route-manifest.js";
import type { CompileTargetProfile } from "../../target-profile.js";
import { IrBodyRouteAuditSession, type IrBodyRouteAudit } from "../legacy-body-audit.js";

export interface Result {
  /** Opt-in physical direct-body route census paired with the IR outcome ledger. */
  irBodyRouteAudit?: IrBodyRouteAudit;
}

export interface Options {
  /** Internal public-entry identity for the opt-in physical cutover audit. */
  irCutoverRoute?: IrCompileRoute;
}

export interface Context {
  /** Physical direct-AST body entry recorder, allocated with IR outcome tracking. */
  irBodyRouteAuditSession?: IrBodyRouteAuditSession;
}

export function createBodyRouteAudit(
  options: (Options & { trackIrOutcomes?: boolean }) | undefined,
  identity: IrPlanningIdentityContext | undefined,
  target: CompileTargetProfile["target"],
): IrBodyRouteAuditSession | undefined {
  return options?.trackIrOutcomes && identity && options.irCutoverRoute
    ? new IrBodyRouteAuditSession(identity, target, options.irCutoverRoute)
    : undefined;
}

/** Return the already-validated name while recording only the executable, non-reservation pass. */
export function recordNestedFunctionBody(
  context: Context,
  declaration: FunctionDeclaration,
  preRegisterOnly: boolean | undefined,
): string {
  const name = declaration.name!.text;
  if (!preRegisterOnly)
    context.irBodyRouteAuditSession?.recordRoot("compileNestedFunctionDeclaration", name, declaration);
  return name;
}

/** Preserve a closure's body value while recording entry into its direct lowering route. */
export function recordClosureBody(
  context: Context,
  entryPoint: "compileLiftedClosureBody" | "compileArrowAsClosure",
  bodyName: string,
  closure: ArrowFunction | FunctionExpression,
): ArrowFunction["body"] {
  context.irBodyRouteAuditSession?.recordRoot(entryPoint, bodyName, closure);
  return closure.body;
}
