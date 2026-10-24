// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import {
  allocateLiftedFunctionArtifact,
  type IrLiftedFunctionArtifactOwner,
  type IrLiftedFunctionArtifactIdentity,
  type IrUnitId,
} from "./identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import type { IrClosureLiteral } from "./source-closure-entry.js";

export function allocateLoweredLiftedFunctionArtifact(
  declaration: ts.FunctionDeclaration | IrClosureLiteral,
  cx: IrLiftedFunctionArtifactOwner & {
    readonly identityContext?: IrPlanningIdentityContext;
    readonly funcName: string;
  },
  displayNameForOrdinal: (ordinal: number) => string,
  preserveDerivedIdentity = false,
): IrLiftedFunctionArtifactIdentity {
  // Exact host plans allocate their targets before AST lowering and compare
  // against those derived identities when the plan is consumed. They are
  // compiler-owned artifacts even though their syntax is a source closure;
  // do not replace their planned target with the source node's unit ID.
  if (preserveDerivedIdentity) return allocateLiftedFunctionArtifact(cx, displayNameForOrdinal);

  // Mutable-capture/usage transforms may retain the terminal declaration but
  // clone a nested function-like. TypeScript preserves the exact pre-transform
  // node through getOriginalNode; consult it before classifying the lift as a
  // compiler-created artifact, otherwise a real source arrow incorrectly
  // escapes into the derived-unit namespace.
  const originalDeclaration = ts.getOriginalNode(declaration);
  const expectedSourceKind = ts.isFunctionDeclaration(declaration)
    ? "nested-function"
    : ts.isGetAccessorDeclaration(declaration)
      ? "object-getter"
      : ts.isSetAccessorDeclaration(declaration)
        ? "object-setter"
        : ts.isMethodDeclaration(declaration)
          ? "object-method"
          : ts.isFunctionExpression(declaration)
            ? "function-expression"
            : "arrow-function";
  let sourceUnitId =
    cx.identityContext?.unitIdByDeclaration.get(declaration) ??
    (originalDeclaration !== declaration
      ? cx.identityContext?.unitIdByDeclaration.get(originalDeclaration)
      : undefined);
  if (!sourceUnitId && cx.identityContext) {
    // A few checker/usage transforms clone the nested node without preserving
    // TypeScript's original-node link. Recover only one exact-span source
    // record under this terminal owner; kind, source, owner, and offsets must
    // all agree with the frozen inventory.
    const owner = cx.identityContext.unitByUnitId.get(cx.ownerUnitId);
    const sourceFile = declaration.getSourceFile();
    const candidates = owner
      ? cx.identityContext.inventory.allUnits.filter(
          (unit) =>
            unit.sourceId === owner.sourceId &&
            unit.kind === expectedSourceKind &&
            unit.terminalOwnerId === cx.ownerUnitId &&
            unit.declarationStart === declaration.getStart(sourceFile) &&
            unit.declarationEnd === declaration.end,
        )
      : [];
    if (candidates.length === 1) sourceUnitId = candidates[0]!.id;
  }
  const sourceUnit = sourceUnitId ? cx.identityContext?.unitByUnitId.get(sourceUnitId) : undefined;
  if (sourceUnitId && sourceUnit) {
    if (
      sourceUnit.kind !== expectedSourceKind ||
      sourceUnit.terminalOwnerId !== cx.ownerUnitId ||
      sourceUnit.lexicalOwnerId === null ||
      !cx.identityContext?.unitByUnitId.has(sourceUnit.lexicalOwnerId as IrUnitId)
    ) {
      // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
      throw new Error(`ir/from-ast: lifted source identity diverged (${cx.funcName})`);
    }
    const displayOrdinal = cx.liftedCounter.value++;
    return {
      unitId: sourceUnitId,
      name: displayNameForOrdinal(displayOrdinal),
      parentId: sourceUnit.lexicalOwnerId as IrUnitId,
      role: "lifted-closure",
      ordinal: sourceUnit.ordinal,
      sourceUnit: true,
    };
  }
  return allocateLiftedFunctionArtifact(cx, displayNameForOrdinal);
}
