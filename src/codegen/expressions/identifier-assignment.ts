// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Resolved identifier writes and their module-lexical TDZ guard. */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getLocalType } from "../context/locals.js";
import { localGlobalIdx } from "../registry/imports.js";
import { coerceType, valTypesMatch } from "../shared.js";
import { emitTdzCheck } from "../statements/tdz.js";
import { analyzeIdentifierTdzAccess, emitStaticTdzThrow } from "./identifiers.js";
import { identifierResolvesToCurrentTopLevelLexical } from "./identifier-module-storage.js";

function moduleLexicalAssignmentTdzDecision(
  ctx: CodegenContext,
  id: ts.Identifier,
  allowUnresolvedTopLevelVariable: boolean,
): "skip" | "throw" | "check" | undefined {
  if (!ctx.moduleGlobals.has(id.text) || !ctx.tdzGlobals.has(id.text)) return undefined;
  if (!identifierResolvesToCurrentTopLevelLexical(ctx, id, allowUnresolvedTopLevelVariable)) return undefined;
  return analyzeIdentifierTdzAccess(ctx, id);
}

function emitModuleLexicalAssignmentTdzGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  allowUnresolvedTopLevelVariable: boolean,
): void {
  const decision = moduleLexicalAssignmentTdzDecision(ctx, id, allowUnresolvedTopLevelVariable);
  if (decision === "throw") emitStaticTdzThrow(ctx, fctx, id.text);
  else if (decision === "check") emitTdzCheck(ctx, fctx, id.text, true);
}

/** Consume one precomputed stack value through an already-resolved target. */
export function emitResolvedIdentifierWriteFromStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  valueType: ValType,
  localIdx: number | undefined,
  moduleGlobalIdx: number | undefined,
  allowUnresolvedTopLevelVariable = false,
): boolean {
  // A provider or string constant settled while evaluating the value may have
  // inserted an import global. Treat the caller's index as target identity
  // only; re-read the graph-global name map before inspecting its type.
  const currentModuleGlobalIdx = moduleGlobalIdx === undefined ? undefined : ctx.moduleGlobals.get(id.text);
  const targetType =
    localIdx !== undefined
      ? getLocalType(fctx, localIdx)
      : currentModuleGlobalIdx !== undefined
        ? ctx.mod.globals[localGlobalIdx(ctx, currentModuleGlobalIdx)]?.type
        : undefined;
  if (localIdx === undefined && currentModuleGlobalIdx === undefined) return false;
  if (targetType && !valTypesMatch(valueType, targetType)) coerceType(ctx, fctx, valueType, targetType);
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.set", index: localIdx });
    return true;
  }
  emitModuleLexicalAssignmentTdzGuard(ctx, fctx, id, allowUnresolvedTopLevelVariable);
  // Re-read after coercion/guard helpers: either can settle imports/globals.
  fctx.body.push({ op: "global.set", index: ctx.moduleGlobals.get(id.text)! });
  return true;
}
