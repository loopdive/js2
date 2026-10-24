// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { emitNativeTypeError } from "./native-errors.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irBool } from "./boolean-brand.js";
import { irVal, type IrValueId } from "./nodes.js";

/** Evaluated operands enter the canonical operator; its error sentinel throws in IR. */
export function lowerNativeInstanceof(builder: IrFunctionBuilder, value: IrValueId, target: IrValueId): IrValueId {
  const result = builder.emitCall(irRuntimeFuncRef("__instanceof_operator"), [value, target], irVal({ kind: "i32" }));
  if (result === null) throw new Error("native instanceof operator returned void");
  const invalid = builder.emitBinary(
    "i32.eq",
    result,
    builder.emitConst({ kind: "i32", value: 2 }, irVal({ kind: "i32" })),
    irBool(),
  );
  const then = builder.collectBodyInstrs(() => {
    emitNativeTypeError(builder, "Right-hand side of 'instanceof' is not callable");
  });
  builder.emitIfStmt({ cond: invalid, then, else: [] });
  return builder.emitBinary(
    "i32.ne",
    result,
    builder.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" })),
    irBool(),
  );
}
