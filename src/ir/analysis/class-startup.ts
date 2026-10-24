// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import { isAmbientDeclaration } from "./ambient-declarations.js";
import { hasStaticModifier } from "./class-definition-syntax.js";
import { requireIrPlanningClassRecord, type IrPlanningIdentityContext } from "../planning-identity.js";
import type { IrClassId } from "../../shared/contracts/ir-identity.js";
import type { IrModuleInitEvaluationKind } from "../program/startup.js";

interface IrClassStartupOccurrence {
  readonly node: ts.Node;
  readonly kind: IrModuleInitEvaluationKind;
  readonly classId: IrClassId;
  readonly nestedOrdinal: number;
  readonly legacyKind: "statement" | "static";
}

/** Definition execution is one startup action; its static work is not a second action. */
export function classStartupOccurrences(
  identity: IrPlanningIdentityContext,
  declaration: ts.ClassDeclaration,
): readonly IrClassStartupOccurrence[] {
  const record = requireIrPlanningClassRecord(identity, declaration);
  if (identity.moduleInitPopulationBySourceFile.get(declaration.getSourceFile())?.includes(declaration))
    return [
      { node: declaration, kind: "class-definition", classId: record.id, nestedOrdinal: 0, legacyKind: "statement" },
    ];
  if (isAmbientDeclaration(declaration)) return [];
  const occurrences: IrClassStartupOccurrence[] = [];
  for (const member of declaration.members) {
    const node = ts.isClassStaticBlockDeclaration(member)
      ? member
      : hasStaticModifier(member) && ts.isPropertyDeclaration(member)
        ? member.initializer
        : undefined;
    if (node)
      occurrences.push({
        node,
        kind: ts.isClassStaticBlockDeclaration(member) ? "class-static-block" : "class-static-field",
        classId: record.id,
        nestedOrdinal: occurrences.length,
        legacyKind: "static",
      });
  }
  return occurrences;
}
