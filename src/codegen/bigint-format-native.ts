// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

const BUFFER_CAPACITY = 66; // sign + 64 binary digits + spare

function pushFunction(
  ctx: CodegenContext,
  name: string,
  typeIdx: number,
  locals: WasmFunction["locals"],
  body: Instr[],
): number {
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/** Emit exact signed-i64 BigInt formatting for radices 2..36. */
export function emitNativeBigIntFormat(ctx: CodegenContext, which: ReadonlySet<string>): void {
  if (!which.has("bigint_toString") && !which.has("bigint_toString_radix")) return;
  ensureNativeStringHelpers(ctx);

  const i32: ValType = { kind: "i32" };
  const i64: ValType = { kind: "i64" };
  const extern: ValType = { kind: "externref" };
  const bufferType: ValType = { kind: "ref", typeIdx: ctx.nativeStrDataTypeIdx };

  let radixIdx = ctx.funcMap.get("bigint_toString_radix");
  if (radixIdx === undefined) {
    const L_VALUE = 0;
    const L_RADIX = 1;
    const L_BUFFER = 2;
    const L_CURSOR = 3;
    const L_MAGNITUDE = 4;
    const L_DIGIT = 5;
    const writeAtCursor = (code: Instr[]): Instr[] => [
      { op: "local.get", index: L_BUFFER },
      { op: "local.get", index: L_CURSOR },
      ...code,
      { op: "array.set", typeIdx: ctx.nativeStrDataTypeIdx },
      { op: "local.get", index: L_CURSOR },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: L_CURSOR },
    ];

    const body: Instr[] = [
      { op: "i32.const", value: BUFFER_CAPACITY },
      { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
      { op: "local.set", index: L_BUFFER },
      { op: "i32.const", value: BUFFER_CAPACITY - 1 },
      { op: "local.set", index: L_CURSOR },
      // Unsigned magnitude makes -2^63 representable without overflow.
      { op: "local.get", index: L_VALUE },
      { op: "i64.const", value: 0n },
      { op: "i64.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: i64 },
        then: [{ op: "i64.const", value: 0n }, { op: "local.get", index: L_VALUE }, { op: "i64.sub" }],
        else: [{ op: "local.get", index: L_VALUE }],
      },
      { op: "local.set", index: L_MAGNITUDE },
      { op: "local.get", index: L_MAGNITUDE },
      { op: "i64.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: writeAtCursor([{ op: "i32.const", value: 48 }]),
        else: [
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: L_MAGNITUDE },
                  { op: "i64.eqz" },
                  { op: "br_if", depth: 1 },
                  { op: "local.get", index: L_MAGNITUDE },
                  { op: "local.get", index: L_RADIX },
                  { op: "i64.extend_i32_u" },
                  { op: "i64.rem_u" },
                  { op: "i32.wrap_i64" },
                  { op: "local.set", index: L_DIGIT },
                  ...writeAtCursor([
                    { op: "local.get", index: L_DIGIT },
                    { op: "i32.const", value: 10 },
                    { op: "i32.lt_u" },
                    {
                      op: "if",
                      blockType: { kind: "val", type: i32 },
                      then: [{ op: "local.get", index: L_DIGIT }, { op: "i32.const", value: 48 }, { op: "i32.add" }],
                      else: [{ op: "local.get", index: L_DIGIT }, { op: "i32.const", value: 87 }, { op: "i32.add" }],
                    },
                  ]),
                  { op: "local.get", index: L_MAGNITUDE },
                  { op: "local.get", index: L_RADIX },
                  { op: "i64.extend_i32_u" },
                  { op: "i64.div_u" },
                  { op: "local.set", index: L_MAGNITUDE },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
        ],
      },
      { op: "local.get", index: L_VALUE },
      { op: "i64.const", value: 0n },
      { op: "i64.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: writeAtCursor([{ op: "i32.const", value: 45 }]),
        else: [],
      },
      // NativeString(len, offset, backing data); no copy is required.
      { op: "i32.const", value: BUFFER_CAPACITY - 1 },
      { op: "local.get", index: L_CURSOR },
      { op: "i32.sub" },
      { op: "local.get", index: L_CURSOR },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.get", index: L_BUFFER },
      { op: "struct.new", typeIdx: ctx.nativeStrTypeIdx },
      { op: "extern.convert_any" },
      { op: "return" },
    ];
    const typeIdx = addFuncType(ctx, [i64, i32], [extern]);
    radixIdx = pushFunction(
      ctx,
      "bigint_toString_radix",
      typeIdx,
      [
        { name: "buffer", type: bufferType },
        { name: "cursor", type: i32 },
        { name: "magnitude", type: i64 },
        { name: "digit", type: i32 },
      ],
      body,
    );
  }

  if (which.has("bigint_toString") && !ctx.funcMap.has("bigint_toString")) {
    const typeIdx = addFuncType(ctx, [i64], [extern]);
    pushFunction(
      ctx,
      "bigint_toString",
      typeIdx,
      [],
      [
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 10 },
        { op: "call", funcIdx: radixIdx },
        { op: "return" },
      ],
    );
  }
}
