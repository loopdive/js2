// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irTypeEquals, type IrType } from "./types.js";

/** Existing scalar joins, or the authenticated synchronous vector arm contract. */
export function conditionalBranchTypesAgree(left: IrType, right: IrType, logical?: IrType): boolean {
  if (logical !== undefined)
    return (
      logical.kind === "vec" &&
      [left, right].every(
        (type) =>
          type.kind === "vec" &&
          irTypeEquals(type.elementType, logical.elementType) &&
          (!type.nullable || logical.nullable),
      )
    );
  return (left.kind === "val" && right.kind === "val" && left.val.kind === right.val.kind) || irTypeEquals(left, right);
}
