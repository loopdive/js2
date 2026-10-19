// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../ts-api.js";
import type { IrSelectionOptions } from "./select.js";

/** Exact dynamic-carrier proof; the caller retains its source-shape transaction. */
export function nativeDynamicInstanceOfShape(
  expr: ts.BinaryExpression,
  options: IrSelectionOptions | undefined,
  shape: () => boolean,
): boolean {
  return (
    options?.supportsBackendCapability?.("native-dynamic-instanceof") === true &&
    options.isDynamicForInReceiver?.(expr.right) === true &&
    (options.isDynamicForInReceiver?.(expr.left) === true ||
      options.classifyPrimitiveExpression?.(expr.left) !== undefined) &&
    shape()
  );
}
