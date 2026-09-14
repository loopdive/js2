// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFunction, IrType } from "./core/nodes.js";

const promiseResults: readonly IrType[] = Object.freeze([
  Object.freeze({ kind: "val" as const, val: Object.freeze({ kind: "externref" as const }) }),
]);

/** Complete-program callers receive a Promise, independently of body fulfillment. */
export function preparedIrProgramCallableResults(fn: Pick<IrFunction, "funcKind" | "resultTypes">): readonly IrType[] {
  return fn.funcKind === "async" ? promiseResults : fn.resultTypes;
}
