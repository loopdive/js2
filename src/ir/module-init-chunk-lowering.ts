// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106) `<module-init>` lowering under the shared chunk budget.
 *
 * Legacy emits a large module initializer as private `[] -> []` helpers so no
 * single Wasm body outgrows what an optimizing compiler handles in linear time
 * (`src/shared/module-init-chunk-plan.ts`, #4376).  The IR lowers the same
 * plan the same way: every planned chunk becomes one derived IR function and
 * `<module-init>` calls them through the planner's bounded dispatch tree.
 *
 * Splitting at complete top-level statements is sound for the IR because no
 * value crosses a chunk: integration binds every top-level declaration of a
 * claimed initializer to a module global (`buildModuleBindingsMap` refuses one
 * without legacy storage), and a statement's own temporaries stay inside it.
 */
import type { ts } from "../ts-api.js";
import type { AllocSiteRegistry } from "./alloc-registry.js";
import { IrFunctionBuilder } from "./builder.js";
import { irUnitFuncRef } from "./callable-bindings.js";
import { allocateLiftedFunctionArtifact, type IrDerivedUnitProvenance, type IrUnitId } from "./identity.js";
import type { IrFuncRef, IrFunction } from "./nodes.js";
import { demoteToLegacy } from "./outcomes.js";
import {
  MODULE_INIT_CHUNK_FUNCTION_PREFIX,
  planModuleInitChunkDispatch,
  planModuleInitChunks,
} from "../shared/module-init-chunk-plan.js";

/** The slice of the `<module-init>` lowering context this module reads and extends. */
export interface ModuleInitChunkHost {
  readonly builder: IrFunctionBuilder;
  readonly ownerUnitId: IrUnitId;
  readonly liftedCounter: { value: number };
  readonly lifted: IrFunction[];
  readonly liftedUnitProvenance: IrDerivedUnitProvenance[];
  readonly allocRegistry?: AllocSiteRegistry;
  readonly sourceMap?: object;
}

/**
 * Lower the initializer's statements with `lowerStatement`: in place when they
 * fit one chunk, else one derived function per planned chunk plus the dispatch
 * calls.  Returns the derived functions' unit ids (chunks and dispatchers),
 * which no later inliner may fold back into the initializer.
 */
export function lowerModuleInitStatements<C extends ModuleInitChunkHost>(
  statements: readonly ts.Statement[],
  cx: C,
  lowerStatement: (statement: ts.Statement, cx: C) => void,
): readonly IrUnitId[] {
  const chunks = planModuleInitChunks(statements.map((node) => ({ node })));
  if (chunks.length <= 1) {
    for (const statement of statements) lowerStatement(statement, cx);
    return [];
  }
  if (cx.sourceMap) {
    demoteToLegacy("module-init-legacy-coupling", "ir/module-init: chunked initializer under source maps");
  }
  const derived: IrUnitId[] = [];
  const leaves = chunks.map((chunk, index) =>
    liftChunkFunction(cx, derived, `${MODULE_INIT_CHUNK_FUNCTION_PREFIX}ir_${index}`, (builder) => {
      const chunkCx = { ...cx, builder };
      for (const entry of chunk) lowerStatement(entry.node, chunkCx);
    }),
  );
  const roots = planModuleInitChunkDispatch(leaves, (members, level, ordinal) =>
    liftChunkFunction(cx, derived, `${MODULE_INIT_CHUNK_FUNCTION_PREFIX}ir_dispatch_${level}_${ordinal}`, (builder) =>
      emitDispatch(builder, members),
    ),
  );
  emitDispatch(cx.builder, roots);
  return derived;
}

function emitDispatch(builder: IrFunctionBuilder, callees: readonly IrFuncRef[]): void {
  for (const callee of callees) builder.emitCall(callee, [], null);
}

/** One private `[] -> []` derived function of the initializer. */
function liftChunkFunction(
  cx: ModuleInitChunkHost,
  derived: IrUnitId[],
  name: string,
  fill: (builder: IrFunctionBuilder) => void,
): IrFuncRef {
  const identity = allocateLiftedFunctionArtifact(cx, () => name);
  cx.liftedUnitProvenance.push({
    id: identity.unitId,
    parentId: identity.parentId,
    role: identity.role,
    ordinal: identity.ordinal,
  });
  derived.push(identity.unitId);
  const builder = new IrFunctionBuilder(identity, [], false, cx.allocRegistry);
  builder.openBlock();
  fill(builder);
  builder.terminate({ kind: "return", values: [] });
  cx.lifted.push(builder.finish());
  return irUnitFuncRef(identity);
}
