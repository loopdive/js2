// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrUnitId } from "./identity.js";
import type { IrModuleInitPlan } from "./module-init-plan.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";

/**
 * Reuse the existing post-wasm-start TDZ fact for a complete program. Any
 * source function referenced by startup (including callbacks/function values)
 * is conservatively reachable before startup finishes, as are its callees.
 * No declared type or source-name convention proves initialization here.
 */
export function postStartupCallableUnits(
  checker: ts.TypeChecker,
  identity: IrPlanningIdentityContext,
  startup: readonly IrModuleInitPlan[],
): ReadonlySet<IrUnitId> {
  if (startup.some((plan) => plan.executable && plan.invocation.kind !== "wasm-start")) return new Set();
  const references = new Map<IrUnitId, Set<IrUnitId>>();
  const inspect = (owner: IrUnitId, node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
      const target = symbol?.valueDeclaration;
      const targetId = target ? identity.unitIdByDeclaration.get(target) : undefined;
      if (targetId && identity.terminalByUnitId.has(targetId)) {
        const targets = references.get(owner) ?? new Set<IrUnitId>();
        targets.add(targetId);
        references.set(owner, targets);
      }
    }
    ts.forEachChild(node, (child) => inspect(owner, child));
  };
  for (const terminal of identity.inventory.terminalUnits) {
    if (terminal.kind === "module-init") {
      const source = identity.sourceFileBySourceId.get(terminal.sourceId)!;
      for (const statement of identity.moduleInitPopulationBySourceFile.get(source) ?? [])
        inspect(terminal.id, statement);
    } else {
      const declaration = identity.declarationByUnitId.get(terminal.id);
      if (declaration) inspect(terminal.id, declaration);
    }
  }
  const early = new Set(startup.flatMap((plan) => (plan.unitId ? [plan.unitId] : [])));
  const work = [...early];
  for (let index = 0; index < work.length; index++)
    for (const target of references.get(work[index]!) ?? []) {
      if (!early.has(target)) {
        early.add(target);
        work.push(target);
      }
    }
  return new Set(
    identity.inventory.terminalUnits
      .filter((unit) => unit.kind !== "module-init" && !early.has(unit.id))
      .map((unit) => unit.id),
  );
}
