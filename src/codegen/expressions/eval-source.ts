// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../../ts-api.js";
import { EVAL_SOURCE_FILENAME } from "../../frontend/eval/script.js";

/** Whether `node` belongs to a foreign eval SourceFile (`EVAL_SOURCE_FILENAME`), parsed outside the Program. */
export function isForeignEvalNode(node: ts.Node): boolean {
  return node.getSourceFile().fileName === EVAL_SOURCE_FILENAME;
}
