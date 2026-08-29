// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { localGlobalIdx } from "./registry/imports.js";
import { coerceType, compileExpression, compileStatement, valTypesMatch } from "./shared.js";

type ClassExpressionStaticInitEntry =
  CodegenContext["classExpressionStaticInitExprs"] extends Map<ts.ClassExpression, infer EntryArray>
    ? EntryArray extends (infer Entry)[]
      ? Entry
      : never
    : never;

function staticStorageTargets(
  ctx: CodegenContext,
  entries: readonly ClassExpressionStaticInitEntry[],
): { globalIdx: number; type: ValType }[] {
  const targets: { globalIdx: number; type: ValType }[] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    if (entry.staticPropKey === undefined) continue;
    const globalIdx = ctx.staticProps.get(entry.staticPropKey);
    if (globalIdx === undefined || seen.has(globalIdx)) continue;
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
    if (!globalDef) continue;
    seen.add(globalIdx);
    targets.push({ globalIdx, type: globalDef.type });
  }
  return targets;
}

/**
 * Emit the static fields/blocks of a class expression at its exact evaluation
 * point (§15.7.14 ClassDefinitionEvaluation), before the expression returns
 * its class value. Class declarations deliberately remain on the module-level
 * source-order timeline.
 *
 * Variable-bound class expressions are registered under a visible name and a
 * synthetic identity. Those registrations may own separate backing globals,
 * but they describe one source field: evaluate it once, then copy that result
 * to every internal alias.
 */
export function emitClassExpressionStaticInitialization(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ClassExpression,
): void {
  const entries = ctx.classExpressionStaticInitExprs.get(expr);
  if (!entries || entries.length === 0) return;

  const canonicalClassName = ctx.anonClassExprNames.get(expr) ?? expr.name?.text ?? entries[0]?.className;
  const savedEnclosing = fctx.enclosingClassName;
  const savedIsStatic = fctx.isStaticContext;
  if (canonicalClassName !== undefined) {
    fctx.enclosingClassName = canonicalClassName;
    fctx.isStaticContext = true;
  }

  const emittedBlocks = new Set<ts.ClassStaticBlockDeclaration>();
  const emittedInitializers = new Set<ts.Expression>();
  try {
    for (const entry of entries) {
      if (entry.staticBlock) {
        if (emittedBlocks.has(entry.staticBlock)) continue;
        emittedBlocks.add(entry.staticBlock);
        for (const statement of entry.staticBlock.body.statements) {
          compileStatement(ctx, fctx, statement);
        }
        continue;
      }

      const initializer = entry.initializer;
      if (!initializer || emittedInitializers.has(initializer)) continue;
      emittedInitializers.add(initializer);

      const aliases = entries.filter((candidate) => candidate.initializer === initializer);
      const primary = staticStorageTargets(ctx, aliases)[0];
      const actualType = compileExpression(ctx, fctx, initializer, primary?.type);
      if (actualType === null) continue;
      if (!primary) {
        fctx.body.push({ op: "drop" });
        continue;
      }

      if (!valTypesMatch(actualType, primary.type)) {
        coerceType(ctx, fctx, actualType, primary.type);
      }
      const valueLocal = allocTempLocal(fctx, primary.type);
      fctx.body.push({ op: "local.set", index: valueLocal });
      // Compiling the initializer may reserve late imports/globals and shift
      // every absolute global index. Resolve storage from the shifted
      // `staticProps` authority only after that compilation has completed.
      const targets = staticStorageTargets(ctx, aliases);
      for (const target of targets) {
        fctx.body.push({ op: "local.get", index: valueLocal });
        if (!valTypesMatch(primary.type, target.type)) {
          coerceType(ctx, fctx, primary.type, target.type);
        }
        fctx.body.push({ op: "global.set", index: target.globalIdx });
      }
      releaseTempLocal(fctx, valueLocal);
    }
  } finally {
    fctx.enclosingClassName = savedEnclosing;
    fctx.isStaticContext = savedIsStatic;
  }
}

/** Preserve a class value already on the stack while its statics execute. */
export function emitClassExpressionStaticsBeforeValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ClassExpression,
  valueType: ValType,
): ValType {
  if ((ctx.classExpressionStaticInitExprs.get(expr)?.length ?? 0) === 0) return valueType;
  const valueLocal = allocTempLocal(fctx, valueType);
  fctx.body.push({ op: "local.set", index: valueLocal });
  emitClassExpressionStaticInitialization(ctx, fctx, expr);
  fctx.body.push({ op: "local.get", index: valueLocal });
  releaseTempLocal(fctx, valueLocal);
  return valueType;
}
