// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared tail for arguments-object construction. Kept outside the nested
// declaration driver so the god-file remains within its LOC budget.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getArgumentsVecTypeIdx } from "./arguments-carrier-brand.js";
import { allocLocal } from "./context/locals.js";

interface ArgumentsVecTailOptions {
  readonly paramTypes: ValType[];
  readonly paramOffset: number;
  readonly numArgs: number;
  readonly vecTypeIdx: number;
  /** Concrete subtype used for the arguments object itself. */
  readonly argumentsVecTypeIdx?: number;
  readonly arrTypeIdx: number;
  readonly argsLocalIdx: number;
  readonly arrTmpIdx: number;
  readonly extrasLocalIdx: number;
  readonly extrasLenLocalIdx: number;
  readonly totalLenLocalIdx: number;
  readonly argcLocalIdx: number;
}

/**
 * Finish an arguments-object vec after argc/extras lengths are available.
 *
 * A zero-formal function receives every call-site argument through
 * `__extras_argv`; when argc is zero, that vector is fresh for this call and
 * can be used directly. The general builder remains the fallback for empty
 * calls and defensive malformed-caller states.
 */
export function emitArgumentsVecTail(
  ctx: CodegenContext,
  fctx: FunctionContext,
  options: ArgumentsVecTailOptions,
): void {
  const {
    paramTypes,
    paramOffset,
    numArgs,
    vecTypeIdx: vti,
    argumentsVecTypeIdx = vti,
    arrTypeIdx: ati,
    argsLocalIdx: argsLocal,
    arrTmpIdx: arrTmp,
    extrasLocalIdx: extrasLocal,
    extrasLenLocalIdx: extrasLenLocal,
    totalLenLocalIdx: totalLenLocal,
    argcLocalIdx: argcLocal,
  } = options;
  const buildArgsBody: Instr[] = [
    { op: "local.get", index: totalLenLocal },
    { op: "array.new_default", typeIdx: ati },
    { op: "local.set", index: arrTmp },
  ];

  // Fill formals: arr[i] = box(param[i + paramOffset]). Guard each slot so a
  // short call cannot write past the newly-sized array.
  for (let i = 0; i < numArgs; i++) {
    const thenInstrs: Instr[] = [
      { op: "local.get", index: arrTmp },
      { op: "i32.const", value: i },
      { op: "local.get", index: i + paramOffset },
    ];
    const pt = paramTypes[i]!;
    if (pt.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      thenInstrs.push(
        ...(boxIdx === undefined
          ? [{ op: "drop" as const }, { op: "ref.null.extern" as const }]
          : [{ op: "call" as const, funcIdx: boxIdx }]),
      );
    } else if (pt.kind === "i32") {
      thenInstrs.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      thenInstrs.push(
        ...(boxIdx === undefined
          ? [{ op: "drop" as const }, { op: "ref.null.extern" as const }]
          : [{ op: "call" as const, funcIdx: boxIdx }]),
      );
    } else if (pt.kind === "ref" || pt.kind === "ref_null") {
      thenInstrs.push({ op: "extern.convert_any" });
    }
    thenInstrs.push({ op: "array.set", typeIdx: ati });
    buildArgsBody.push(
      { op: "i32.const", value: i },
      { op: "local.get", index: argcLocal },
      { op: "i32.lt_s" },
      { op: "if", blockType: { kind: "empty" }, then: thenInstrs, else: [] },
    );
  }

  // Copy non-empty extras after the ABI-supplied formal prefix (#3420).
  buildArgsBody.push(
    { op: "local.get", index: extrasLenLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: arrTmp },
        { op: "local.get", index: argcLocal },
        { op: "local.get", index: extrasLocal },
        { op: "ref.as_non_null" },
        // `extrasLocal` is the canonical protocol vec even when `vti` is the
        // nominal arguments subtype being constructed.
        { op: "struct.get", typeIdx: ctx.extrasArgvVecTypeIdx, fieldIdx: 1 },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: extrasLenLocal },
        { op: "array.copy", dstTypeIdx: ati, srcTypeIdx: ati },
      ],
    },
    { op: "local.get", index: totalLenLocal },
    { op: "local.get", index: arrTmp },
    // The nominal standalone arguments subtype appends its ordinary-property
    // state after the shared vec fields: `lengthAbsent`, an arbitrary
    // `lengthValue`, and the `lengthOverride` presence bit. Keep the parent
    // vec construction byte-for-byte unchanged for every other carrier.
    ...(argumentsVecTypeIdx === vti
      ? []
      : ([{ op: "i32.const", value: 0 }, { op: "ref.null.extern" }, { op: "i32.const", value: 0 }] satisfies Instr[])),
    { op: "struct.new", typeIdx: argumentsVecTypeIdx },
    { op: "local.set", index: argsLocal },
  );

  // An ordinary extras vec cannot be reused as the branded arguments subtype.
  if (numArgs !== 0 || argumentsVecTypeIdx !== vti) {
    fctx.body.push(...buildArgsBody);
    return;
  }

  // The extras global is the canonical parent vec. A nominal arguments child
  // cannot alias that value into its more-specific local, so always build the
  // child for zero-formal arguments objects as well. This preserves the brand
  // that IsArray must reject while retaining the same indexed contents.
  if (vti === getArgumentsVecTypeIdx(ctx)) {
    fctx.body.push(...buildArgsBody);
    return;
  }

  const aliasedArgsLocal = allocLocal(fctx, "__arguments_aliased", { kind: "i32" });
  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "local.set", index: aliasedArgsLocal },
    { op: "local.get", index: argcLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: extrasLocal },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [
            { op: "local.get", index: extrasLocal },
            { op: "ref.as_non_null" },
            { op: "local.set", index: argsLocal },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: aliasedArgsLocal },
          ],
        },
      ],
      else: [],
    },
    { op: "local.get", index: aliasedArgsLocal },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: buildArgsBody, else: [] },
  );
}
