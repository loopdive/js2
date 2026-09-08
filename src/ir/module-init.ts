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

/**
 * (#5332) The first `export default …` / `export = …` statement, which is
 * module-init WORK the direct front end performs but the population above
 * deliberately excludes.
 *
 * `collectModuleInitPopulation` answers "which statements can the IR module-init
 * body lower?", and an `ExportAssignment` is not a statement that can appear in
 * a function body at all — so excluding it there is right and stays right.
 * But the direct front end DOES queue one into `ctx.moduleInitStatements`
 * (`declarations.ts`, the `__default_expr_N` snapshot-cell arm), and
 * `buildIrModuleInitPlan` correspondingly records an `export-assignment`
 * evaluation so that `reconcileIrModuleInitPlan` lines up with that queue.
 *
 * Identity had no third answer for "the source performs module-init work that
 * this population cannot express", so a source whose ONLY top-level statement
 * was `export default g;` minted no module-init terminal while its plan read
 * `executable` — the disagreement #3525's census turned into a hard
 * `terminal-join` error. This predicate is that third answer: it decides
 * whether the source OWNS a module-init terminal, independently of what that
 * terminal's lowerable population contains.
 *
 * `identity.ts` uses it as the terminal's fallback ANCHOR, so the export
 * assignment gets a terminal without joining the scanned population — it keeps
 * its own `export-assignment` support unit, an empty population keeps
 * `assessModuleInit` at `stmtCount: 0`, and every module-init consumer requires
 * `stmtCount > 0`. So the terminal is minted and the direct path stays the
 * emitter; nothing that compiled before changes route.
 */
export function moduleInitExportAssignment(sourceFile: ts.SourceFile): ts.ExportAssignment | undefined {
  return sourceFile.statements.find(ts.isExportAssignment);
}

/**
 * Whether the source owns a `module-init` terminal unit: it has lowerable
 * top-level statements, or export-assignment work the population cannot carry.
 * Static class initialization is a third owner and is decided by its caller,
 * which already walks the class members it needs for the refusal detail.
 *
 * The selector must PREDICT exactly what `identity.ts` mints:
 * `assessIdentityModuleInit` raises `invalid-module-init` for an inventory
 * module-init terminal it did not expect, so the two sides share this one
 * predicate rather than each spelling the rule out.
 */
export function sourceOwnsModuleInitUnit(sourceFile: ts.SourceFile): boolean {
  return collectModuleInitPopulation(sourceFile).length !== 0 || moduleInitExportAssignment(sourceFile) !== undefined;
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
