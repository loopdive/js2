// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

/** (#3142) The synthetic claim-unit name for the module-level statement list. */
export const MODULE_INIT_UNIT_NAME = "<module-init>";

/** Collect the runtime top-level statements routed into legacy `__module_init`. */
export function collectModuleInitPopulation(sourceFile: ts.SourceFile): ts.Statement[] {
  const population: ts.Statement[] = [];
  for (const stmt of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isImportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt) ||
      ts.isEmptyStatement(stmt)
    ) {
      continue;
    }
    population.push(stmt);
  }
  return population;
}

/** Build the shared void function shape assessed by selection and lowered by integration. */
export function makeModuleInitSynthetic(population: readonly ts.Statement[]): ts.FunctionDeclaration {
  return ts.factory.createFunctionDeclaration(
    /* modifiers */ undefined,
    /* asteriskToken */ undefined,
    MODULE_INIT_UNIT_NAME,
    /* typeParameters */ undefined,
    /* parameters */ [],
    /* type */ undefined,
    ts.factory.createBlock([...population], /* multiLine */ true),
  );
}
