// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The Prepared source producer's direct-call plans: the program call graph's, and those it does not hold. The call
 * graph walks each function declaration's own body, so it plans neither a call in top-level code (the module-init) nor
 * (#7354 F1b, R7) a call inside a closure a unit creates. from-ast lowers a closure's body in its enclosing terminal
 * unit's context (the lifted body keeps that unit as its plan owner), so every such call is planned under that unit: a
 * call of a top-level function declaration by name is its direct call wherever it appears.
 *
 * (#7354 C2, C2-D2) A function that binds its own `this` reads the receiver the dispatcher installed, so it may be
 * entered only through the dispatcher (a call through its value, `new`): a direct call installs no receiver and
 * refuses by name.
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
import type { buildIrProgramCallableBindingGraph } from "./program-callable-bindings.js";
import type { ProgramDynamicContracts } from "./source-dynamic-contracts.js";

type Signature = { readonly params: readonly IrType[]; readonly returnType: IrType | null };

function unsupported(detail: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", detail);
}

/**
 * Every direct call of the program: the call graph's `uses`, then every call of a top-level function by name in
 * top-level code and in the closures of every unit, under the terminal unit that lowers it (`diagnostic.active` names
 * the unit being planned).
 */
export function prepareSourceDirectCalls(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  startup: readonly IrModuleInitPlan[],
  signatures: ReadonlyMap<IrUnitId, Signature>,
  uses: ReturnType<typeof buildIrProgramCallableBindingGraph>["uses"],
  codeStrictness: ProgramDynamicContracts["codeStrictness"],
  diagnostic: { active: IrUnitId | undefined },
): ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan> {
  const directCalls = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
  for (const use of uses) {
    diagnostic.active = use.ownerUnitId;
    const signature = signatures.get(use.targetUnitId);
    const target = identity.terminalByUnitId.get(use.targetUnitId);
    if (!signature || !target) unsupported(`direct call ${use.bindingId} has no complete target contract`);
    directCalls.set(use.node, {
      ownerUnitId: use.ownerUnitId,
      target: irUnitFuncRef({ unitId: use.targetUnitId, name: target.displayName }),
      signature,
    });
  }
  const callableResolver = makeIrIdentityImportedFunctionResolver(checker, sourceFiles, identity);
  const plan = (ownerUnitId: IrUnitId, call: ts.CallExpression): void => {
    if (directCalls.has(call) || !ts.isIdentifier(call.expression)) return;
    const target =
      callableResolver.resolveImportedFunctionTarget(call.expression) ??
      callableResolver.resolveTopLevelFunctionValueTarget(call.expression);
    if (!target) return;
    const signature = signatures.get(target.targetUnitId);
    if (!signature) unsupported(`startup call ${target.targetUnitId} has no complete declared contract`);
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
  for (const { ownerUnitId, target } of directCalls.values()) {
    const declaration =
      target.binding.kind === "unit" ? identity.declarationByUnitId.get(target.binding.unitId) : undefined;
    diagnostic.active = ownerUnitId;
    if (
      declaration &&
      ts.isFunctionDeclaration(declaration) &&
      codeStrictness(declaration).ambientThisStrict !== undefined
    )
      unsupported(`a direct call of ${target.name} installs no receiver for its 'this'`);
  }
  return directCalls;
}
