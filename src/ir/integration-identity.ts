// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrIntegrationLoweringPlans } from "./ast-lowering-plans.js";
import type { IrClassId, IrSourceId, IrTerminalUnitRecord, IrUnitId } from "./identity.js";
import { IrInvariantError } from "./outcomes.js";
import {
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "./planning-identity.js";
import {
  classElementIsStatic,
  collectModuleInitPopulation,
  MODULE_INIT_UNIT_NAME,
  phase1MemberName,
  type IrSelection,
} from "./select.js";

type IntegrationIdentityPlans = Pick<
  IrIntegrationLoweringPlans,
  "identityContext" | "ownerProjection" | "ownerUnitIdByLegacyName"
>;

export interface IrValidatedIntegrationPopulation {
  readonly sourceId: IrSourceId;
  readonly ownerUnitIdByDeclaration: ReadonlyMap<ts.Node, IrUnitId>;
  readonly moduleInitUnitId?: IrUnitId;
  readonly moduleInitPopulation?: readonly ts.Statement[];
}

function planningInvariant(code: IrPlanningIdentityInvariantCode, detail: string): never {
  throw new IrPlanningIdentityInvariantError(code, `IR integration identity: ${detail}`);
}

function integrationMismatch(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "resolve", `IR integration identity: ${detail}`);
}

function requireExactSource(sourceFile: ts.SourceFile, context: IrPlanningIdentityContext): IrSourceId {
  const sourceId = requireIrPlanningSourceId(context, sourceFile);
  const sourceRecord = context.inventory.sources.find((candidate) => candidate.id === sourceId);
  if (
    context.sourceFileBySourceId.get(sourceId) !== sourceFile ||
    !sourceRecord ||
    sourceRecord.originalFileName !== sourceFile.fileName
  ) {
    return planningInvariant(
      "source-record-mismatch",
      `source ${sourceFile.fileName} does not resolve bidirectionally to ${sourceId}`,
    );
  }
  return sourceId;
}

function requireExactTerminalDeclaration(
  declaration: ts.Node,
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  legacyName: string,
  observedKind: "function" | "class-member",
  context: IrPlanningIdentityContext,
): IrTerminalUnitRecord {
  const unitId = context.unitIdByDeclaration.get(declaration);
  if (unitId === undefined) {
    return planningInvariant(
      "missing-unit-declaration",
      `selected ${observedKind} ${JSON.stringify(legacyName)} has no authoritative declaration unit`,
    );
  }
  const unit = context.unitByUnitId.get(unitId);
  const terminal = context.terminalByUnitId.get(unitId);
  if (
    context.declarationByUnitId.get(unitId) !== declaration ||
    unit !== terminal ||
    !terminal ||
    !terminal.terminal ||
    terminal.terminalOwnerId !== unitId ||
    terminal.observedKind !== observedKind
  ) {
    return planningInvariant(
      "terminal-record-mismatch",
      `selected ${observedKind} ${JSON.stringify(legacyName)} does not resolve bidirectionally to terminal ${unitId}`,
    );
  }
  if (
    terminal.sourceId !== sourceId ||
    declaration.getSourceFile() !== sourceFile ||
    terminal.declarationStart !== declaration.getStart(sourceFile) ||
    terminal.declarationEnd !== declaration.end
  ) {
    return planningInvariant(
      "source-record-mismatch",
      `selected ${observedKind} ${unitId} does not retain its exact source and declaration span`,
    );
  }
  if (terminal.legacyMatchName !== legacyName) {
    return planningInvariant(
      "unit-record-mismatch",
      `selected label ${JSON.stringify(legacyName)} does not match terminal ${unitId} / ${JSON.stringify(terminal.legacyMatchName)}`,
    );
  }
  return terminal;
}

function requireExactClass(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  sourceFile: ts.SourceFile,
  sourceId: IrSourceId,
  context: IrPlanningIdentityContext,
): IrClassId {
  const classId = context.classIdByDeclaration.get(declaration);
  const record = context.inventory.classes.find((candidate) => candidate.id === classId);
  if (
    classId === undefined ||
    context.declarationByClassId.get(classId) !== declaration ||
    !record ||
    record.sourceId !== sourceId ||
    declaration.getSourceFile() !== sourceFile ||
    (record.lexicalOwnerId === null && (!ts.isClassDeclaration(declaration) || declaration.parent !== sourceFile)) ||
    record.declarationStart !== declaration.getStart(sourceFile) ||
    record.declarationEnd !== declaration.end
  ) {
    return planningInvariant(
      "class-record-mismatch",
      `class ${declaration.name?.text ?? "<anonymous>"} is not this source's exact authoritative declaration`,
    );
  }
  return classId;
}

function classMemberLegacyName(className: string, member: ts.ClassElement): string | undefined {
  if (ts.isConstructorDeclaration(member)) return `${className}_new`;
  if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) {
    return undefined;
  }
  if (!member.body || !member.name) return undefined;
  const memberName = phase1MemberName(member.name);
  if (memberName === null) return undefined;
  if (ts.isGetAccessorDeclaration(member)) return `${className}_get_${memberName}`;
  if (ts.isSetAccessorDeclaration(member)) return `${className}_set_${memberName}`;
  return `${className}_${memberName}`;
}

function addExpectedOwner(expected: Map<string, IrUnitId>, legacyName: string, unitId: IrUnitId): void {
  if (expected.has(legacyName)) {
    integrationMismatch(`selected owner ${JSON.stringify(legacyName)} occurs more than once in the current AST`);
  }
  expected.set(legacyName, unitId);
}

function validateProjectedOwners(expected: ReadonlyMap<string, IrUnitId>, plans: IntegrationIdentityPlans): void {
  if (plans.ownerProjection.entries.length !== expected.size || plans.ownerUnitIdByLegacyName.size !== expected.size) {
    integrationMismatch(
      `selected owner population (${expected.size}) disagrees with projected owners (${plans.ownerProjection.entries.length})`,
    );
  }
  for (const [legacyName, unitId] of expected) {
    const byName = plans.ownerProjection.getByLegacyName(legacyName);
    const byUnit = plans.ownerProjection.getByUnitId(unitId);
    if (
      !byName ||
      byName !== byUnit ||
      byName.unitId !== unitId ||
      byName.legacyName !== legacyName ||
      plans.ownerUnitIdByLegacyName.get(legacyName) !== unitId
    ) {
      integrationMismatch(`selected owner ${JSON.stringify(legacyName)} / ${unitId} has a stale projection`);
    }
  }
  for (const [legacyName, unitId] of plans.ownerUnitIdByLegacyName) {
    if (expected.get(legacyName) !== unitId) {
      integrationMismatch(`projected owner ${JSON.stringify(legacyName)} / ${unitId} is outside the selected AST`);
    }
  }
}

/**
 * Validate the exact AST population before the legacy name seam reaches
 * AST-to-IR lowering. The returned IDs are the only IDs integration may pass
 * to the lowerer; callers never re-read a name-keyed plan after this check.
 */
export function validateIrIntegrationPopulation(
  sourceFile: ts.SourceFile,
  selection: Pick<IrSelection, "funcs" | "classMembers" | "classMemberUnitIds" | "moduleInit">,
  plans: IntegrationIdentityPlans,
): IrValidatedIntegrationPopulation {
  const context = plans.identityContext;
  const sourceId = requireExactSource(sourceFile, context);
  const expectedOwners = new Map<string, IrUnitId>();
  const ownerUnitIdByDeclaration = new Map<ts.Node, IrUnitId>();
  const missingFunctions = new Set(selection.funcs);

  for (const declaration of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.name || !declaration.body) continue;
    const legacyName = declaration.name.text;
    if (!selection.funcs.has(legacyName)) continue;
    if (!missingFunctions.delete(legacyName) || declaration.parent !== sourceFile) {
      integrationMismatch(`selected function ${JSON.stringify(legacyName)} is not unique in the current AST`);
    }
    const terminal = requireExactTerminalDeclaration(
      declaration,
      sourceFile,
      sourceId,
      legacyName,
      "function",
      context,
    );
    const compilerTopLevel =
      terminal.kind === "synthetic-support" && terminal.syntheticRole?.startsWith("compiler-unit:");
    if ((terminal.kind !== "top-level-function" && !compilerTopLevel) || terminal.lexicalOwnerId !== null) {
      planningInvariant(
        "terminal-record-mismatch",
        `selected function ${terminal.id} is not a source-owned top-level terminal`,
      );
    }
    ownerUnitIdByDeclaration.set(declaration, terminal.id);
    addExpectedOwner(expectedOwners, legacyName, terminal.id);
  }
  if (missingFunctions.size > 0) {
    integrationMismatch(
      `selected functions are absent from the current AST: ${[...missingFunctions].sort().join(", ")}`,
    );
  }

  if (selection.classMemberUnitIds !== undefined) {
    const selectedLegacyNames = new Set<string>();
    for (const unitId of selection.classMemberUnitIds) {
      const member = context.declarationByUnitId.get(unitId);
      const terminal = context.terminalByUnitId.get(unitId);
      if (
        !member ||
        (!ts.isClassDeclaration(member) &&
          !ts.isClassExpression(member) &&
          !ts.isConstructorDeclaration(member) &&
          !ts.isMethodDeclaration(member) &&
          !ts.isGetAccessorDeclaration(member) &&
          !ts.isSetAccessorDeclaration(member)) ||
        !terminal
      ) {
        integrationMismatch(`selected exact class member ${unitId} has no callable declaration`);
      }
      const implicitConstructor = terminal.kind === "class-implicit-constructor";
      const owner = implicitConstructor ? member : member.parent;
      if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) {
        planningInvariant("class-record-mismatch", `selected exact class member ${unitId} has no class owner`);
      }
      let staticClassMember = false;
      if (!implicitConstructor) {
        if (ts.isClassDeclaration(member) || ts.isClassExpression(member)) {
          planningInvariant(
            "terminal-record-mismatch",
            `selected non-implicit class member ${unitId} resolves to a class declaration`,
          );
        }
        staticClassMember = classElementIsStatic(member);
      }
      const classId = requireExactClass(owner, sourceFile, sourceId, context);
      const exactTerminal = requireExactTerminalDeclaration(
        member,
        sourceFile,
        sourceId,
        terminal.legacyMatchName,
        "class-member",
        context,
      );
      if (
        exactTerminal.id !== unitId ||
        exactTerminal.lexicalOwnerId !== classId ||
        exactTerminal.staticClassMember !== staticClassMember
      ) {
        planningInvariant(
          "terminal-record-mismatch",
          `selected exact class member ${unitId} does not retain its exact class/static placement`,
        );
      }
      ownerUnitIdByDeclaration.set(member, unitId);
      addExpectedOwner(expectedOwners, terminal.legacyMatchName, unitId);
      selectedLegacyNames.add(terminal.legacyMatchName);
    }
    for (const legacyName of selection.classMembers ?? []) {
      if (!selectedLegacyNames.has(legacyName)) {
        integrationMismatch(`compatibility class member ${JSON.stringify(legacyName)} has no exact selected owner`);
      }
    }
  } else {
    const missingMembers = new Set(selection.classMembers ?? []);
    for (const declaration of sourceFile.statements) {
      if (!ts.isClassDeclaration(declaration) || !declaration.name) continue;
      const selectedMembers = declaration.members.flatMap((member) => {
        const legacyName = classMemberLegacyName(declaration.name!.text, member);
        return legacyName !== undefined && selection.classMembers?.has(legacyName) ? [{ member, legacyName }] : [];
      });
      if (selectedMembers.length === 0) continue;
      const classId = requireExactClass(declaration, sourceFile, sourceId, context);
      for (const { member, legacyName } of selectedMembers) {
        if (!missingMembers.delete(legacyName) || member.parent !== declaration) {
          integrationMismatch(`selected class member ${JSON.stringify(legacyName)} is not unique in the current AST`);
        }
        const terminal = requireExactTerminalDeclaration(
          member,
          sourceFile,
          sourceId,
          legacyName,
          "class-member",
          context,
        );
        const isStatic = classElementIsStatic(member);
        if (terminal.lexicalOwnerId !== classId || terminal.staticClassMember !== isStatic) {
          planningInvariant(
            "terminal-record-mismatch",
            `selected class member ${terminal.id} does not retain its exact class/static owner`,
          );
        }
        ownerUnitIdByDeclaration.set(member, terminal.id);
        addExpectedOwner(expectedOwners, legacyName, terminal.id);
      }
    }
    if (missingMembers.size > 0) {
      integrationMismatch(
        `selected class members are absent from the current AST: ${[...missingMembers].sort().join(", ")}`,
      );
    }
  }

  const population = collectModuleInitPopulation(sourceFile);
  if (selection.moduleInit && selection.moduleInit.stmtCount !== population.length) {
    integrationMismatch(
      `module-init population changed from ${selection.moduleInit.stmtCount} to ${population.length} statements`,
    );
  }
  const authoritativePopulation = context.moduleInitPopulationBySourceFile.get(sourceFile);
  if (!authoritativePopulation) {
    planningInvariant("source-record-mismatch", `source ${sourceId} has no authoritative module-init population`);
  }
  if (selection.moduleInit && selection.moduleInit.stmtCount !== authoritativePopulation.length) {
    integrationMismatch(
      `selected module-init population (${selection.moduleInit.stmtCount}) disagrees with its authoritative population (${authoritativePopulation.length})`,
    );
  }
  if (selection.moduleInit) {
    for (let index = 0; index < population.length; index++) {
      if (population[index] !== authoritativePopulation[index]) {
        planningInvariant(
          "invalid-module-init",
          `current module-init statement ${index} is not the exact authoritative statement for ${sourceId}`,
        );
      }
    }
  }
  let moduleInitUnitId: IrUnitId | undefined;
  let moduleInitPopulation: readonly ts.Statement[] | undefined;
  if (selection.moduleInit?.reason === null && selection.moduleInit.stmtCount > 0) {
    moduleInitUnitId = context.moduleInitUnitIdBySourceFile.get(sourceFile);
    const terminal = moduleInitUnitId && context.terminalByUnitId.get(moduleInitUnitId);
    if (
      moduleInitUnitId === undefined ||
      context.moduleInitUnitIdBySourceId.get(sourceId) !== moduleInitUnitId ||
      !terminal ||
      context.unitByUnitId.get(moduleInitUnitId) !== terminal ||
      terminal.sourceId !== sourceId ||
      terminal.kind !== "module-init" ||
      terminal.observedKind !== "module-init" ||
      terminal.lexicalOwnerId !== null ||
      terminal.terminalOwnerId !== moduleInitUnitId ||
      terminal.legacyMatchName !== MODULE_INIT_UNIT_NAME
    ) {
      planningInvariant("invalid-module-init", `source ${sourceId} has no exact module-init terminal`);
    }
    for (const statement of authoritativePopulation) {
      if (statement.parent !== sourceFile || statement.getSourceFile() !== sourceFile) {
        planningInvariant(
          "invalid-module-init",
          `authoritative module-init statement at ${statement.pos} is detached from ${moduleInitUnitId}`,
        );
      }
    }
    moduleInitPopulation = authoritativePopulation;
    addExpectedOwner(expectedOwners, MODULE_INIT_UNIT_NAME, moduleInitUnitId);
  }

  validateProjectedOwners(expectedOwners, plans);
  return Object.freeze({
    sourceId,
    ownerUnitIdByDeclaration,
    ...(moduleInitUnitId === undefined ? {} : { moduleInitUnitId, moduleInitPopulation }),
  });
}
