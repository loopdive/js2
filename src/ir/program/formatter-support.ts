// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createDerivedIrUnitId } from "../../shared/contracts/identity-values.js";
import type { IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irSupportFuncRef } from "../core/callable-bindings.js";
import { irSupportTypeRef } from "../core/type-references.js";
import { irSupportRef, type IrType } from "../core/types.js";
import { freezePreparedIrValue } from "./data.js";
import type { IrFormatterKernelRole, IrNumberFormatRadixSupport, IrRuntimeSupportCallable } from "./runtime-support.js";

const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const STRING: IrType = Object.freeze({ kind: "string" });

/** One signature authority shared by the frontend producer and program validation. */
export function numberFormatRadixSupportDeclarations(sourceId: IrSourceId): {
  readonly ownerUnitId: IrUnitId;
  readonly scratch: IrNumberFormatRadixSupport["scratch"];
  readonly kernels: IrNumberFormatRadixSupport["kernels"];
  readonly implementation: IrRuntimeSupportCallable;
} {
  const scratch = {
    type: irSupportRef(irSupportTypeRef(sourceId, "number-format-radix:scratch", "__nfd_buffer"), true),
    storage: { kind: "array" as const, element: "i16" as const, mutable: true as const },
    stringDataRole: ["string-type", "data"] as const,
  };
  const kernel = <R extends IrFormatterKernelRole>(
    role: R,
    name: string,
    params: readonly IrType[],
    results: readonly IrType[],
  ): IrRuntimeSupportCallable & { readonly role: R } => ({
    role,
    ref: irSupportFuncRef(sourceId, "number-format-radix:" + role, name),
    params,
    results,
  });
  const declarations = {
    ownerUnitId: createDerivedIrUnitId({
      parentId: sourceId,
      role: "runtime-support:number-format-radix",
      ordinal: 0,
    }),
    scratch,
    kernels: [
      kernel("new", "__nfd_new", [F64], [scratch.type]),
      kernel("get", "__nfd_get", [scratch.type, F64], [F64]),
      kernel("set", "__nfd_set", [scratch.type, F64, F64], []),
      kernel("fin", "__nfd_fin", [scratch.type, F64], [STRING]),
      kernel("trap", "__num_fmt_trap", [], []),
    ] as const,
    implementation: {
      ref: irSupportFuncRef(sourceId, "number-format-radix:body", "__sh_num_toString_radix"),
      params: [F64, F64],
      results: [STRING],
    },
  };
  return freezePreparedIrValue(declarations) as typeof declarations;
}
