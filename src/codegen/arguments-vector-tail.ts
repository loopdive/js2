// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared tail for arguments-object construction. Kept outside the nested
// declaration driver so the god-file remains within its LOC budget.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getArgumentsVecTypeIdx } from "./arguments-carrier-brand.js";
import { allocLocal } from "./context/locals.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { getVecInfo } from "./type-coercion.js";
import { hasRestParameter } from "./helpers/body-uses-arguments.js";
import type { ts } from "../ts-api.js";

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

/** A rest parameter the arguments builder can read (see {@link emitRestArgs}). */
export interface RestArgumentsSource {
  readonly restVecTypeIdx: number;
  readonly restArrTypeIdx: number;
  readonly elemKind: ValType["kind"];
}

/**
 * (#6651 I7) When `formals` ends in a rest parameter, resolve its lowered
 * vec (the last of `paramTypes`) for {@link emitRestArgs}, registering `__box_number` for numeric
 * elements BEFORE any instruction is emitted (a late import shifts indices).
 * Null — historical behaviour — when the formal is not a `__vec_*` (a
 * contextually-typed tuple struct) or holds packed elements.
 */
export function prepareRestArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: readonly ValType[],
  formals: readonly ts.ParameterDeclaration[] | undefined,
): RestArgumentsSource | null {
  if (!formals || !hasRestParameter(formals)) return null;
  const restType = paramTypes[paramTypes.length - 1];
  if (!restType || (restType.kind !== "ref" && restType.kind !== "ref_null")) return null;
  const restVec = getVecInfo(ctx, restType.typeIdx);
  const elemKind = restVec?.elemType.kind;
  if (!restVec || !elemKind || !["f64", "i32", "ref", "ref_null", "externref"].includes(elemKind)) return null;
  if (elemKind === "f64" || elemKind === "i32") {
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
  }
  return { restVecTypeIdx: restType.typeIdx, restArrTypeIdx: restVec.arrTypeIdx, elemKind };
}

/**
 * (#6651 I7) A trailing rest parameter is NOT an argument: §10.2.11 builds the
 * arguments object from the call's argument LIST (CreateUnmappedArgumentsObject),
 * and the rest array is only a binding over that list's tail. A direct call
 * packs the tail into the rest vec and publishes no `__argc`, so the historical
 * builder read "argc unknown → every formal", yielding `[x, restArray]` —
 * `arguments.length` was 2 for `f(x, ...a)` called with three arguments.
 *
 * Emitted right after the extras global has been consumed into `extrasLocal`:
 *   1. clamp `argc` to the fixed-formal count, so the rest slot is never copied
 *      in as a single element;
 *   2. when the caller published no extras (a direct / method / `new` / `super`
 *      call), use the rest vec's elements, boxed to externref, as the extras.
 * A closure call already publishes `argc` = supplied fixed args and the rest
 * elements as extras, so step 2 is skipped there and step 1 is a no-op.
 */
export function emitRestArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rest: RestArgumentsSource,
  locals: { restLocalIdx: number; fixedCount: number; argcLocalIdx: number; extrasLocalIdx: number },
): void {
  const { restVecTypeIdx, elemKind } = rest;
  const { restLocalIdx, fixedCount, argcLocalIdx, extrasLocalIdx } = locals;
  const extrasVecTypeIdx = ctx.extrasArgvVecTypeIdx;
  fctx.body.push(
    { op: "local.get", index: argcLocalIdx },
    { op: "i32.const", value: fixedCount },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: fixedCount },
        { op: "local.set", index: argcLocalIdx },
      ],
      else: [],
    },
  );
  let fill: Instr[];
  if (restVecTypeIdx === extrasVecTypeIdx) {
    fill = [
      { op: "local.get", index: restLocalIdx },
      { op: "local.set", index: extrasLocalIdx },
    ];
  } else {
    const boxIdx = ctx.funcMap.get("__box_number");
    const boxNumber: Instr[] =
      boxIdx !== undefined ? [{ op: "call", funcIdx: boxIdx }] : [{ op: "drop" }, { op: "ref.null.extern" }];
    const box: Instr[] =
      elemKind === "f64"
        ? boxNumber
        : elemKind === "i32"
          ? [{ op: "f64.convert_i32_s" }, ...boxNumber]
          : elemKind === "externref"
            ? []
            : [{ op: "extern.convert_any" }];
    const ati = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);
    const lenLocal = allocLocal(fctx, `__rest_args_len_${fctx.locals.length}`, { kind: "i32" });
    const arrLocal = allocLocal(fctx, `__rest_args_arr_${fctx.locals.length}`, { kind: "ref_null", typeIdx: ati });
    const idxLocal = allocLocal(fctx, `__rest_args_i_${fctx.locals.length}`, { kind: "i32" });
    fill = [
      { op: "local.get", index: restLocalIdx },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: restVecTypeIdx, fieldIdx: 0 },
      { op: "local.tee", index: lenLocal },
      { op: "array.new_default", typeIdx: ati },
      { op: "local.set", index: arrLocal },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: idxLocal },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: idxLocal },
              { op: "local.get", index: lenLocal },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: arrLocal },
              { op: "ref.as_non_null" },
              { op: "local.get", index: idxLocal },
              { op: "local.get", index: restLocalIdx },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: restVecTypeIdx, fieldIdx: 1 },
              { op: "local.get", index: idxLocal },
              { op: "array.get", typeIdx: rest.restArrTypeIdx },
              ...box,
              { op: "array.set", typeIdx: ati },
              { op: "local.get", index: idxLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: idxLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: lenLocal },
      { op: "local.get", index: arrLocal },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: extrasVecTypeIdx },
      { op: "local.set", index: extrasLocalIdx },
    ];
  }
  // extras == null && rest != null → take the rest elements.
  fctx.body.push(
    { op: "local.get", index: extrasLocalIdx },
    { op: "ref.is_null" },
    { op: "local.get", index: restLocalIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: fill, else: [] },
  );
}
