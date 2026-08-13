// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4222 ES5 residual) Runtime presence arm for the dedicated sparse
// `new Array(n)` carrier. It is intentionally separate from generic vec
// enumeration: only this nominal subtype can contain `$Hole` sentinels.

import type { Instr } from "../ir/types.js";
import { holeTestInstrs } from "./array-holes.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";

/**
 * Prepend a nominal `$__holey_array` arm to `__extern_has_idx`.
 *
 * The dedicated IR filter calls this chokepoint before `Get`; returning false
 * for `$Hole` means the generic reader never observes the internal sentinel.
 * The pre-scan rejects prototype-index mutation for this slice, so a hole's
 * miss is exactly `false` rather than a partially modelled prototype lookup.
 */
export function fillHoleyArrayHasIdxArm(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.holeyArrayTypeIdx < 0) return;
  const funcIdx = ctx.funcMap.get("__extern_has_idx");
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn || fn.locals.some((local) => local.name === "__holey_has_any")) return;

  const holeyTypeIdx = ctx.holeyArrayTypeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, holeyTypeIdx);
  if (arrTypeIdx < 0) return;

  const anyLocal = 2 + fn.locals.length;
  const indexLocal = anyLocal + 1;
  fn.locals.push(
    { name: "__holey_has_any", type: { kind: "anyref" } },
    { name: "__holey_has_i", type: { kind: "i32" } },
  );

  const presentValue: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: holeyTypeIdx },
    { op: "struct.get", typeIdx: holeyTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: indexLocal },
    { op: "array.get", typeIdx: arrTypeIdx },
    ...holeTestInstrs(ctx),
    { op: "i32.eqz" },
  ];
  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: holeyTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "i32.trunc_sat_f64_s" },
        { op: "local.tee", index: indexLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        { op: "local.get", index: indexLocal },
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: holeyTypeIdx },
        { op: "struct.get", typeIdx: holeyTypeIdx, fieldIdx: 0 },
        { op: "i32.lt_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: presentValue,
          else: [{ op: "i32.const", value: 0 }],
        },
        { op: "return" },
      ],
    },
  ];
  fn.body.splice(0, 0, ...arm);
}
