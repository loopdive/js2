// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { TypeOracle } from "../checker/oracle.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ts } from "../ts-api.js";
import { hasDeclareModifier, hasExportModifier } from "./ast-modifiers.js";

function exactRelativeModuleSourceKey(importerSourceKey: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const parts = importerSourceKey.split("/").slice(0, -1);
  for (const part of specifier.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/** Resolve one exact direct named import through the canonical source inventory. */
export function resolveMultiPreparedFunctionValueImportTarget(input: {
  readonly oracle: Pick<TypeOracle, "declarationsOf" | "valueDeclarationOf">;
  readonly sourceFile: ts.SourceFile;
  readonly callee: ts.Identifier;
  readonly identityContext: IrPlanningIdentityContext;
}): ts.FunctionDeclaration | undefined {
  const { callee, identityContext, oracle, sourceFile } = input;
  const localImport = oracle.valueDeclarationOf(callee);
  const localDeclarations = oracle.declarationsOf(callee);
  if (
    !localImport ||
    !ts.isImportSpecifier(localImport) ||
    localImport.isTypeOnly ||
    localImport.name.text !== callee.text ||
    localDeclarations.length !== 1 ||
    localDeclarations[0] !== localImport
  ) {
    return undefined;
  }
  const namedImports = localImport.parent;
  const importClause = namedImports.parent;
  const importDeclaration = importClause.parent;
  if (
    !ts.isNamedImports(namedImports) ||
    !ts.isImportClause(importClause) ||
    importClause.isTypeOnly ||
    importClause.namedBindings !== namedImports ||
    !ts.isImportDeclaration(importDeclaration) ||
    importDeclaration.parent !== sourceFile ||
    importDeclaration.importClause !== importClause ||
    !ts.isStringLiteral(importDeclaration.moduleSpecifier)
  ) {
    return undefined;
  }
  const importerSourceId = identityContext.sourceIdBySourceFile.get(sourceFile);
  const importerRecord = identityContext.inventory.sources.find((record) => record.id === importerSourceId);
  if (
    !importerSourceId ||
    !importerRecord ||
    identityContext.sourceFileBySourceId.get(importerSourceId) !== sourceFile
  ) {
    return undefined;
  }
  const targetSourceKey = exactRelativeModuleSourceKey(
    importerRecord.sourceKey,
    importDeclaration.moduleSpecifier.text,
  );
  const targetRecords = targetSourceKey
    ? identityContext.inventory.sources.filter((record) => record.sourceKey === targetSourceKey)
    : [];
  const targetRecord = targetRecords.length === 1 ? targetRecords[0] : undefined;
  const targetSourceFile = targetRecord ? identityContext.sourceFileBySourceId.get(targetRecord.id) : undefined;
  if (!targetRecord || !targetSourceFile || targetSourceFile === sourceFile || targetSourceFile.isDeclarationFile) {
    return undefined;
  }
  const importedName = (localImport.propertyName ?? localImport.name).text;
  const syntacticTargets = targetSourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      !!statement.name &&
      statement.name.text === importedName &&
      !!statement.body &&
      hasExportModifier(statement) &&
      !hasDeclareModifier(statement),
  );
  if (syntacticTargets.length !== 1) return undefined;
  const target = syntacticTargets[0]!;
  return target.name && oracle.valueDeclarationOf(target.name) === target ? target : undefined;
}
