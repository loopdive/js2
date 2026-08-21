// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrStandaloneDomOperation } from "./dom-capability.js";
import { IrInvariantError } from "./outcomes.js";

export type IrStandaloneDomArgumentBoundary = "native-string" | "dom-handle" | "native-callback-zero-void" | "nullish";

export function isDirectStandaloneDomMemberCall(
  operation: IrStandaloneDomOperation | undefined,
): operation is Extract<IrStandaloneDomOperation, { readonly kind: "member-call" }> {
  return operation?.kind === "member-call" && operation.importName !== "HTMLElement_addEventListener";
}

/** Return only DOM boundary families that the generic extern coercer may consume. */
export function coercibleStandaloneDomArgumentBoundary(
  operation: IrStandaloneDomOperation | undefined,
  index: number,
  funcName: string,
): "native-string" | "dom-handle" | undefined {
  const boundary = operation?.kind === "member-call" ? operation.argumentBoundaries[index] : undefined;
  if (boundary === "native-callback-zero-void" || boundary === "nullish") {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      `ir/from-ast: certified DOM argument boundary ${boundary} reached generic coercion (${funcName})`,
    );
  }
  return boundary;
}
