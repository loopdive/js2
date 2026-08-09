// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared tail for arguments-object construction. Kept outside the nested
// declaration driver so the god-file remains within its LOC budget.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";

interface ArgumentsVecTailOptions {
  readonly paramTypes: ValType[];
  readonly paramOffset: number;
  readonly numArgs: number;
  readonly vecTypeIdx: number;
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
        { op: "struct.get", typeIdx: vti, fieldIdx: 1 },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: extrasLenLocal },
        { op: "array.copy", dstTypeIdx: ati, srcTypeIdx: ati },
      ],
    },
    { op: "local.get", index: totalLenLocal },
    { op: "local.get", index: arrTmp },
    { op: "struct.new", typeIdx: vti },
    { op: "local.set", index: argsLocal },
  );

  if (numArgs !== 0) {
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
