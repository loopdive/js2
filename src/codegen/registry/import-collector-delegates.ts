// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Late-bound unified source-import collector hooks. */
import type { CodegenContext } from "../context/types.js";
import type { UnifiedCollectorState } from "../declarations/import-collector.js";
import { ts } from "../../ts-api.js";

type CollectorState = UnifiedCollectorState;
type CreateCollector = (sourceFile: ts.SourceFile) => CollectorState;
type VisitCollector = (ctx: CodegenContext, state: CollectorState, node: ts.Node) => void;
type FinalizeCollector = (ctx: CodegenContext, state: CollectorState) => void;

let createCollector: CreateCollector | undefined;
let visitCollector: VisitCollector | undefined;
let finalizeCollector: FinalizeCollector | undefined;

export function registerImportCollectorDelegates(
  create: CreateCollector,
  visit: VisitCollector,
  finalize: FinalizeCollector,
): void {
  createCollector = create;
  visitCollector = visit;
  finalizeCollector = finalize;
}

export function createUnifiedCollectorState(sourceFile: ts.SourceFile): CollectorState {
  if (!createCollector) throw new Error("unified import collector is not registered");
  return createCollector(sourceFile);
}

export function unifiedVisitNode(ctx: CodegenContext, state: CollectorState, node: ts.Node): void {
  if (!visitCollector) throw new Error("unified import collector is not registered");
  visitCollector(ctx, state, node);
}

export function finalizeUnifiedCollector(ctx: CodegenContext, state: CollectorState): void {
  if (!finalizeCollector) throw new Error("unified import collector is not registered");
  finalizeCollector(ctx, state);
}
