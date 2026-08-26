// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { localGlobalIdx } from "./registry/imports.js";

/**
 * Resolve an import whose target is `export default <expression>` to that
 * export's exact snapshot cell.
 *
 * This lives outside the expression compiler modules so identifier reads and
 * identifier calls can share it without creating an identifiers ↔ calls
 * initialization cycle.
 */
export function resolveDefaultExpressionImportGlobal(
  ctx: CodegenContext,
  id: ts.Identifier,
): { globalIdx: number; initializedGlobalIdx: number; type: ValType } | undefined {
  const binding = ctx.oracle.valueDeclarationOf(id);
  if (!binding || (!ts.isImportClause(binding) && !ts.isImportSpecifier(binding))) return undefined;
  const target = ctx.importBindingTargets?.get(binding);
  if (!target || !ts.isExportAssignment(target)) return undefined;

  const expressionGlobal = ctx.defaultExpressionGlobals?.get(target);
  if (!expressionGlobal) return undefined;
  const valueLocalIdx = ctx.mod.globals.indexOf(expressionGlobal.value);
  const initializedLocalIdx = ctx.mod.globals.indexOf(expressionGlobal.initialized);
  if (valueLocalIdx < 0 || initializedLocalIdx < 0) return undefined;
  const globalIdx = ctx.numImportGlobals + valueLocalIdx;
  const initializedGlobalIdx = ctx.numImportGlobals + initializedLocalIdx;
  const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  return { globalIdx, initializedGlobalIdx, type: globalDef?.type ?? expressionGlobal.type };
}
