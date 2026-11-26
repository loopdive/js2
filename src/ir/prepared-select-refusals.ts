// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The select-stage refusals of the Prepared whole-program producer, applied before any body is lowered, so the path
// gives a named refusal instead of compiling a program with code missing.

import { ts } from "../ts-api.js";
import type { IrUnitInventory } from "../shared/contracts/ir-unit-inventory.js";
import { classDefinitionExpressions, type ClassDefinitionExpression } from "./class-definition-expressions.js";
import { hasDeclareModifier } from "./identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import { failureAt, locatedFailure, unitOwner } from "./program/owner.js";
import type { PreparedIrProgramFailure } from "./program/prepared-contracts.js";

const EVALUATED = {
  decorator: "a decorator",
  extends: "its extends clause",
  "computed-key": "a computed key",
} as const;

/** Syntactic on purpose: `[('x')]` and `[-1]` evaluate nothing either, and are still refused. */
function isLiteralKey(expression: ts.Expression): boolean {
  return (
    ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
  );
}

type EvaluatingExpression = ClassDefinitionExpression & { readonly kind: keyof typeof EVALUATED };

function runsCode(entry: ClassDefinitionExpression): entry is EvaluatingExpression {
  if (entry.kind === "implements") return false;
  return entry.kind !== "computed-key" || !isLiteralKey(entry.expression);
}

/**
 * (#7446) The inventory's own select-stage refusals (`directFailure`).
 * (#7488) A top-level class whose definition runs code: `<module-init>` lowers the script's statements, not its class
 * definitions, so the `extends` expression, a computed key or a decorator would never run. The refusal is located at
 * the class's constructor unit, which may be a root support unit (`class C extends 5 {}` alone has no terminal unit).
 */
export function preparedSelectRefusal(
  inventory: IrUnitInventory,
  identity: IrPlanningIdentityContext,
  sourceFiles: readonly ts.SourceFile[],
): PreparedIrProgramFailure | undefined {
  const refused = inventory.terminalUnits.find((unit) => unit.directFailure !== undefined);
  if (refused) return locatedFailure({ inventory, derivedUnits: [] }, refused.id, refused.directFailure!);
  for (const file of sourceFiles)
    for (const statement of file.statements) {
      if (!ts.isClassDeclaration(statement) || hasDeclareModifier(statement)) continue;
      const entry = classDefinitionExpressions(statement).find(runsCode);
      if (!entry) continue;
      const classId = identity.classIdByDeclaration.get(statement);
      const constructorUnit = inventory.allUnits.find(
        (unit) =>
          unit.lexicalOwnerId === classId &&
          (unit.kind === "class-constructor" || unit.kind === "class-implicit-constructor"),
      )!;
      const name = statement.name?.text ?? "<anonymous default class>";
      return failureAt(unitOwner(inventory, constructorUnit)!, {
        kind: "unsupported",
        code: "class-definition-evaluation",
        stage: "select",
        detail: `class ${name} evaluates ${EVALUATED[entry.kind]} at its definition, which no Prepared body lowers`,
      });
    }
  return undefined;
}
