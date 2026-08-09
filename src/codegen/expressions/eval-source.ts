// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../../ts-api.js";

/**
 * Synthetic file name for the foreign `SourceFile` parsed by static eval
 * inlining. Nodes in this file are intentionally absent from the enclosing
 * TypeScript Program, so `getSymbolAtLocation` returns `undefined` and checker
 * queries that require bindings must not run. Keep this sentinel independent
 * of eval-inline.ts so lower-level codegen modules can use it without a cycle.
 */
export const EVAL_SOURCE_FILENAME = "<eval>.ts";

export function isForeignEvalNode(node: ts.Node): boolean {
  return node.getSourceFile().fileName === EVAL_SOURCE_FILENAME;
}
