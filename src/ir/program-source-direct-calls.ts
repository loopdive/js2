// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The Prepared source producer's direct-call plans that the program call graph does not hold. The call graph walks
 * each function declaration's own body, so it plans neither a call in top-level code (the module-init) nor (#7354
 * F1b, R7) a call inside a closure a unit creates. from-ast lowers a closure's body in its enclosing terminal unit's
 * context (the lifted body keeps that unit as its plan owner), so every such call is planned under that unit: a call
 * of a top-level function declaration by name is its direct call wherever it appears.
 */
import { ts } from "../ts-api.js";
import type { IrDirectCallLoweringPlan } from "./ast-lowering-plans.js";
import { irUnitFuncRef } from "./callable-bindings.js";
import type { IrType } from "./core/types.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import { makeIrIdentityImportedFunctionResolver } from "./imported-functions.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { buildIrPlanningIdentityContext } from "./planning-identity.js";
import type { IrModuleInitPlan } from "./program/startup.js";

type Signature = { readonly params: readonly IrType[]; readonly returnType: IrType | null };

/**
 * Plan every call of a top-level function by name in top-level code and in the closures of every unit, under the
 * terminal unit that lowers it (`diagnostic.active` names the unit being planned). A call the call graph planned
 * keeps its plan.
 */
export function prepareSourceDirectCalls(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  startup: readonly IrModuleInitPlan[],
  signatures: ReadonlyMap<IrUnitId, Signature>,
  directCalls: Map<ts.CallExpression, IrDirectCallLoweringPlan>,
  diagnostic: { active: IrUnitId | undefined },
): void {
  const callableResolver = makeIrIdentityImportedFunctionResolver(checker, sourceFiles, identity);
  const plan = (ownerUnitId: IrUnitId, call: ts.CallExpression): void => {
    if (directCalls.has(call) || !ts.isIdentifier(call.expression)) return;
    const target =
      callableResolver.resolveImportedFunctionTarget(call.expression) ??
      callableResolver.resolveTopLevelFunctionValueTarget(call.expression);
    if (!target) return;
    const signature = signatures.get(target.targetUnitId);
    if (!signature)
      throw new IrUnsupportedError(
        "type-resolution-unsupported",
        "build",
        `startup call ${target.targetUnitId} has no complete declared contract`,
      );
    directCalls.set(call, {
      ownerUnitId,
      target: irUnitFuncRef({ unitId: target.targetUnitId, name: target.targetName }),
      signature,
    });
  };
  /** `inClosure`: the node lies in a closure of the unit, whose calls the call graph does not plan. */
  const visit = (ownerUnitId: IrUnitId, node: ts.Node, inClosure: boolean): void => {
    if (ts.isFunctionDeclaration(node) && node.parent.kind === ts.SyntaxKind.SourceFile) return;
    const closure = inClosure || ts.isFunctionLike(node);
    if (closure && ts.isCallExpression(node)) plan(ownerUnitId, node);
    ts.forEachChild(node, (child) => visit(ownerUnitId, child, closure));
  };
  for (const startupPlan of startup) {
    if (!startupPlan.unitId) continue;
    diagnostic.active = startupPlan.unitId;
    const source = identity.sourceFileBySourceId.get(startupPlan.sourceId)!;
    for (const statement of identity.moduleInitPopulationBySourceFile.get(source) ?? [])
      visit(startupPlan.unitId, statement, true);
  }
  for (const unit of identity.inventory.terminalUnits) {
    const declaration = identity.declarationByUnitId.get(unit.id);
    if (unit.kind === "module-init" || !declaration || !ts.isFunctionDeclaration(declaration)) continue;
    diagnostic.active = unit.id;
    ts.forEachChild(declaration, (child) => visit(unit.id, child, false));
  }
}
