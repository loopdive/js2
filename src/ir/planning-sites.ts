// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Frontend AST ownership checks; not a source-free IR/runtime contract.
import { ts } from "../ts-api.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningOwnerUnitId,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "./planning-identity.js";

function planningInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

export function requireExactSourceFunctionOwner(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  ownerUnitId: IrUnitId,
  ownerName?: string,
): ts.FunctionDeclaration {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  const unit = identityContext.unitByUnitId.get(ownerUnitId);
  if (!unit) {
    planningInvariant(
      "missing-planning-owner",
      `IR overlay owner ${ownerUnitId} is absent from the authoritative planning inventory`,
    );
  }
  if (unit.sourceId !== sourceId) {
    planningInvariant(
      "source-record-mismatch",
      `IR overlay owner ${ownerUnitId} belongs to source ${unit.sourceId}, not ${sourceId}`,
    );
  }
  const terminal = identityContext.terminalByUnitId.get(ownerUnitId);
  if (!terminal || terminal !== unit || !terminal.terminal || terminal.terminalOwnerId !== ownerUnitId) {
    planningInvariant("terminal-record-mismatch", `IR overlay owner ${ownerUnitId} is not an exact terminal unit`);
  }
  const declaration = identityContext.declarationByUnitId.get(ownerUnitId);
  if (
    !declaration ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.parent !== sourceFile ||
    !sourceFile.statements.includes(declaration) ||
    !declaration.body ||
    identityContext.unitIdByDeclaration.get(declaration) !== ownerUnitId
  ) {
    planningInvariant(
      "unit-record-mismatch",
      `IR overlay owner ${ownerUnitId} is not an exact executable function in ${sourceFile.fileName}`,
    );
  }
  if (ownerName !== undefined && terminal.legacyMatchName !== ownerName) {
    planningInvariant(
      "unit-record-mismatch",
      `IR overlay owner label ${JSON.stringify(ownerName)} does not match ${ownerUnitId}`,
    );
  }
  return declaration;
}

function exactNodeIsReachableFrom(root: ts.Node, target: ts.Node): boolean {
  let reachable = false;
  const visit = (node: ts.Node): void => {
    if (reachable) return;
    if (node === target) {
      reachable = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return reachable;
}

export function requireExactPlanSiteOwner(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  ownerUnitId: IrUnitId,
  ownerName: string,
  site: ts.Node,
  planKind: string,
): void {
  const owner = requireExactSourceFunctionOwner(sourceFile, identityContext, ownerUnitId, ownerName);
  const actualOwner = requireIrPlanningOwnerUnitId(identityContext, site);
  if (actualOwner !== ownerUnitId) {
    planningInvariant(
      "terminal-record-mismatch",
      `${planKind} site belongs to ${actualOwner}, not retained owner ${ownerUnitId}`,
    );
  }
  if (!exactNodeIsReachableFrom(owner.body!, site)) {
    planningInvariant(
      "unit-record-mismatch",
      `${planKind} site is no longer reachable from the exact current body of ${ownerUnitId}`,
    );
  }
}
