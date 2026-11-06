// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6880 group 3) An externref-carried `filter` receiver that already IS the
 * target vec keeps its identity.
 *
 * The callback HOF loops take an externref receiver through
 * `buildVecFromExternref`, which always builds a FRESH vec. That is right for
 * a host array or a cross-representation source and wrong for a compiled vec
 * that only travelled as externref. Under the native regime that is every
 * eval-visible script global (`registerReassignedFunctionGlobals` widens them
 * to externref when the module carries a live direct `eval`, which every
 * test262 row does through the `$262.evalScript` shim). `filter` then walked a
 * snapshot, so a callback that writes, deletes or truncates the source array
 * was invisible (`Array.prototype.filter` 15.4.4.20-9-{2,3,4}).
 *
 * Only `filter` (loop tag `"flt"`) takes the identity arm, because its loop
 * reads every element through HasProperty/Get on the receiver
 * (`array-filter-spec-access.ts`), which sees accessors and holes. The other
 * HOF loops read the vec's backing array directly, and for them the
 * materialized copy is what makes an accessor defined on an index visible
 * (measured: identity for `reduceRight` lost 9 `15.4.4.22-*` accessor rows).
 *
 * Mirrors the identity short-circuit of `buildVecFromExternMaterializer`
 * (type-coercion.ts). Native regime only (`ctx.standalone`); the host lane's
 * output is unchanged.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

/**
 * Wrap `fresh` (the `buildVecFromExternref` materialization of `externLocal`)
 * in a `ref.test` identity arm, or return it unchanged off the filter loop or
 * the native regime. Takes the materialization as a value so this module
 * stays out of the type-coercion import cycle.
 */
export function vecReceiverIdentityArm(
  ctx: CodegenContext,
  externLocal: number,
  vecTypeIdx: number,
  loopTag: string,
  fresh: Instr[],
): Instr[] {
  if (!ctx.standalone || loopTag !== "flt") return fresh;
  return [
    { op: "local.get", index: externLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: vecTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: vecTypeIdx } },
      then: [
        { op: "local.get", index: externLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: vecTypeIdx },
      ],
      else: fresh,
    },
  ];
}
