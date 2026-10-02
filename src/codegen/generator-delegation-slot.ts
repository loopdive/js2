// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A10, #2170) Reading a native generator's `yield*` delegation slot.
 *
 * `registerNativeGenerator` types each native-gen delegation slot from the
 * inner generator's registration: `ref null $InnerState` when the inner was
 * registered BEFORE the outer, and `eqref` when it was not yet — an inner
 * declared later in the source (`function* g() { yield* g2(); } function*
 * g2() {}`). Both slot readers (the `yield*` state and the `.return()` /
 * `.throw()` close forward) then narrowed the slot with `ref.as_non_null`,
 * which turns an `eqref` into a `(ref eq)` the inner's `(ref $InnerState)`
 * locals reject, so the module failed validation
 * (`statements/generators/yield-star-before-newline.js`).
 *
 * An `eqref` slot is cast to the inner state instead. A typed slot keeps its
 * `ref.as_non_null`, so every module whose slots were typed keeps its bytes.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, NativeGeneratorInfo } from "./context/types.js";

export function delegationSlotToInner(
  ctx: CodegenContext,
  info: NativeGeneratorInfo,
  slotFieldIdx: number,
  inner: NativeGeneratorInfo,
): Instr {
  const stateFields = ctx.structFields.get(ctx.typeIdxToStructName.get(info.stateTypeIdx) ?? "");
  return stateFields?.[slotFieldIdx]?.type.kind === "eqref"
    ? { op: "ref.cast", typeIdx: inner.stateTypeIdx }
    : { op: "ref.as_non_null" };
}
