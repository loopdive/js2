// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6998) ToNumber for the string (tag 5) and object (tag 6) payloads of an
 * `$AnyValue` box, for `coerceType`'s inline `$AnyValue → f64` dispatch.
 *
 * That dispatch decodes the numeric tags in place (2/4 → `i32val`, 1 → NaN,
 * 0/3 → `f64val`) and used to read `f64val` for tags 5 and 6 as well — a field
 * that is `0` for a string or an object. So a `string | number` holding `"9"`
 * multiplied by 2 gave 0, `"abc"` gave 0 instead of NaN, and an object's
 * `valueOf` was never called.
 *
 * Tags 5/6 carry their payload as a reference (tag 5: `externval`, tag 6:
 * `refval`), so the correct conversion is the one every dynamic externref
 * already takes on a host-free target: §7.1.1 ToPrimitive (`__to_primitive`)
 * then §7.1.4 ToNumber (`__unbox_number`, whose native body runs the
 * StringToNumber scanner). Both instruction runs come from the coercion engine
 * (`runtimeToPrimitiveInstrs` / `runtimeToNumberInstrs`), so this file adds no
 * coercion vocabulary of its own.
 *
 * Host-free targets only: the js-host lane keeps its bytes.
 */
import type { Instr } from "../ir/types.js";
import { coercionMode, runtimeToNumberInstrs, runtimeToPrimitiveInstrs } from "./coercion-engine.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addUnionImports } from "./registry/imports.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { flushLateImportShifts } from "./shared.js";

const TAG_STRING = 5;
const TAG_OBJECT = 6;
const FIELD_F64 = 2;
const FIELD_REF = 3;
const FIELD_EXTERN = 4;

/**
 * Register the ToPrimitive/ToNumber providers and return the `externref → f64`
 * conversion run, or `null` on a js-host target (or if ToNumber is missing).
 * Call BEFORE building the dispatch: it may flush late-import shifts.
 */
export function prepareAnyValueDynamicToNumber(
  ctx: CodegenContext,
  fctx: FunctionContext,
  hint: "number" | "string" | "default" | undefined,
): Instr[] | null {
  if (coercionMode(ctx) !== "standalone") return null;
  addUnionImports(ctx);
  // Mirrors coerceType's externref → f64 arm: ToPrimitive runs natively on
  // `--target standalone` (the object runtime owns `__to_primitive`, as for
  // `emitAnyRelational`); WASI keeps that arm's bare ToNumber.
  const nativeToPrimitive = ctx.standalone && ctx.targetProfile.semanticProviders === "native-first";
  if (nativeToPrimitive) ensureObjectRuntime(ctx);
  flushLateImportShifts(ctx, fctx);
  const toPrimitive = (nativeToPrimitive ? runtimeToPrimitiveInstrs(ctx, hint ?? "number") : null) ?? [];
  const toNumber = runtimeToNumberInstrs(ctx);
  if (toNumber === null) return null;
  return [...toPrimitive, ...toNumber];
}

/**
 * The dispatch's final arm (tags 0/3/5/6 reach it). Without a host-free
 * conversion this is the historical `f64val` read; with one, tags 5/6 extract
 * their reference payload and convert it.
 */
export function anyValueF64DefaultArm(
  anyTypeIdx: number,
  anyLocal: number,
  tagLocal: number,
  dynamicToNumber: Instr[] | null,
): Instr[] {
  const readF64: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: FIELD_F64 },
  ];
  if (dynamicToNumber === null) return readF64;
  const isTag = (tag: number): Instr[] => [
    { op: "local.get", index: tagLocal },
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
  ];
  const f64: { kind: "val"; type: { kind: "f64" } } = { kind: "val", type: { kind: "f64" } };
  return [
    ...isTag(TAG_STRING),
    {
      op: "if",
      blockType: f64,
      then: [
        { op: "local.get", index: anyLocal },
        { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: FIELD_EXTERN },
        ...dynamicToNumber,
      ],
      else: [
        ...isTag(TAG_OBJECT),
        {
          op: "if",
          blockType: f64,
          then: [
            { op: "local.get", index: anyLocal },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: FIELD_REF },
            { op: "extern.convert_any" },
            ...dynamicToNumber,
          ],
          else: readF64,
        },
      ],
    },
  ];
}
