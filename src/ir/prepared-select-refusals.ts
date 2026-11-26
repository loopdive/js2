// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The select-stage refusals of the Prepared whole-program producer, applied before any body is lowered, so the path
// gives a named refusal instead of compiling a program with code missing.

import { ts } from "../ts-api.js";
import type { IrUnitInventory, IrUnitRecord } from "../shared/contracts/ir-unit-inventory.js";
import type { IrUnsupportedCode } from "../shared/contracts/ir-preparation-failure.js";
import { restrictedGlobalLexicalName } from "../shared/script-lexical-names.js";
import { classDefinitionExpressions, type ClassDefinitionExpression } from "./class-definition-expressions.js";
import { isAmbientDeclaration } from "../shared/ambient-declarations.js";
import type { IrClassId, IrSourceId } from "./identity.js";
import { localExportSpecifiers, localExportTargets } from "./module-init-plan.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
import { failureAt, locatedFailure, ownerAt } from "./program/owner.js";
import type { PreparedIrProgramFailure, PreparedIrSourceLocation } from "./program/prepared-contracts.js";

const EVALUATED = {
  decorator: "a decorator",
  extends: "its extends clause",
  "computed-key": "a computed key",
} as const;

/**
 * A key that evaluates nothing. Syntactic on purpose: `[('x')]` and `[-1]` evaluate nothing either, and are still
 * refused, because admitting them means evaluating expressions here, which is the lowering this rule stands in for.
 */
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

/** The class's constructor unit: explicit, or implicit (a root support unit when nothing else owns it). */
function constructorUnit(inventory: IrUnitInventory, classId: IrClassId | undefined): IrUnitRecord | undefined {
  return inventory.allUnits.find(
    (unit) =>
      unit.lexicalOwnerId === classId &&
      (unit.kind === "class-constructor" || unit.kind === "class-implicit-constructor"),
  );
}

function classRefusal(
  statement: ts.ClassDeclaration,
): { readonly code: IrUnsupportedCode; readonly detail: string } | undefined {
  const name = statement.name?.text ?? "<anonymous default class>";
  const entry = classDefinitionExpressions(statement).find(runsCode);
  if (entry)
    return {
      code: "class-definition-evaluation",
      detail: `class ${name} evaluates ${EVALUATED[entry.kind]} at its definition, which no Prepared body lowers`,
    };
  // `export class C` aliases the export to the class's constructor callable, which no Prepared producer plans.
  if (statement.name && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    return {
      code: "class-export-unsupported",
      detail: `class ${name} is exported, and the Prepared path has no class value to export`,
    };
  return undefined;
}

/**
 * (#7446) The inventory's own select-stage refusals (`directFailure`).
 * (#7488) A top-level class whose definition runs code: `<module-init>` lowers the script's statements, not its class
 * definitions, so the `extends` expression, a computed key or a decorator would never run.
 * (#7500) A top-level class exported by an `export` modifier, and a local `export { x }` whose `x` has no planned target
 * (`buildIrModuleInitPlan` would record it as an `unresolved-export-target` gap): either crashed after selection.
 * A class refusal is located at the class's constructor unit, which may be a root support unit; an export refusal at
 * its specifier, since such a file may have no unit at all.
 */
export function preparedSelectRefusal(
  inventory: IrUnitInventory,
  identity: IrPlanningIdentityContext,
): PreparedIrProgramFailure | undefined {
  for (const unit of inventory.terminalUnits)
    if (unit.directFailure) return locatedFailure({ inventory, derivedUnits: [] }, unit.id, unit.directFailure);
  for (const [sourceId, file] of identity.sourceFileBySourceId) {
    // (#7499) GlobalDeclarationInstantiation precedes every evaluation of the Script, so this refusal comes first among
    // the per-source rules; the inventory's `directFailure` refusals above are reported before it.
    const restricted = restrictedGlobalLexicalName(file);
    if (restricted)
      return failureAt(
        ownerAt(inventory, null, nodeLocation(sourceId, restricted)),
        {
          kind: "unsupported",
          code: "restricted-global-lexical",
          stage: "select",
          detail: `\`${restricted.text}\` is lexically declared in a Script: a SyntaxError at instantiation, which the Prepared path does not raise`,
        },
        `lexical ${restricted.text}`,
      );
    const targets = localExportTargets(file, sourceId, identity);
    for (const statement of file.statements) {
      if (ts.isClassDeclaration(statement) && !isAmbientDeclaration(statement)) {
        const refusal = classRefusal(statement);
        if (!refusal) continue;
        const unit = constructorUnit(inventory, identity.classIdByDeclaration.get(statement));
        const owner = unit && ownerAt(inventory, unit.id, unit);
        return failureAt(owner, { kind: "unsupported", stage: "select", ...refusal }, "the class's constructor unit");
      }
      const unresolved = localExportSpecifiers(statement)?.find(({ localName }) => !targets.has(localName));
      if (unresolved)
        return failureAt(
          ownerAt(inventory, null, nodeLocation(sourceId, unresolved.element)),
          {
            kind: "unsupported",
            code: "export-target-unsupported",
            stage: "select",
            detail: `export ${unresolved.element.name.text} has no local binding the Prepared path plans`,
          },
          `export ${unresolved.element.name.text}`,
        );
    }
  }
  return undefined;
}

function nodeLocation(sourceId: IrSourceId, node: ts.Node): PreparedIrSourceLocation {
  const file = node.getSourceFile();
  const start = node.getStart(file);
  const { line, character } = file.getLineAndCharacterOfPosition(start);
  return { sourceId, line: line + 1, column: character + 1, declarationStart: start, declarationEnd: node.end };
}
