// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { BUILTIN_TYPE_TAGS } from "./builtin-tags.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { buildLazyNativeProtoGetInstrs } from "./native-proto.js";
import {
  ensureErrorNativeProtoGlue,
  ensureNativeErrorNativeProtoGlue,
  ensureObjectNativeProtoGlue,
} from "./array-object-proto.js";

const NAMES = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"] as const;

/** Fill the generic reflection path, not the syntax-only new Error shortcut. */
export function fillErrorPrototypeArms(ctx: CodegenContext): void {
  if (!ctx.standalone && !ctx.wasi) return;
  const errorType = ctx.errorStructTypeIdx;
  const fn = ctx.mod.functions.find((f) => f.name === "__getPrototypeOf");
  if (errorType < 0 || !fn) return;
  ensureObjectNativeProtoGlue(ctx);
  ensureErrorNativeProtoGlue(ctx);
  for (const name of NAMES) if (name !== "Error") ensureNativeErrorNativeProtoGlue(ctx, name);
  const value = 1 + fn.locals.length;
  fn.locals.push({ name: "__error_proto_value", type: { kind: "anyref" } });
  const ref = (typeIdx: number): Instr[] => [
    { op: "local.get", index: value },
    { op: "ref.cast", typeIdx },
  ];
  const dispatch = (typeIdx: number, fieldIdx: number, entries: readonly (readonly [number, number])[]): Instr[] => {
    const arms: Instr[] = [];
    for (const [tag, brand] of entries) {
      const answer = buildLazyNativeProtoGetInstrs(ctx, brand);
      if (!answer) throw new Error(`Missing native Error prototype brand ${brand}`);
      arms.push(
        ...ref(typeIdx),
        { op: "struct.get", typeIdx, fieldIdx },
        { op: "i32.const", value: tag },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [...answer, { op: "return" }] },
      );
    }
    return arms;
  };
  const instances = dispatch(
    errorType,
    6,
    NAMES.map((name) => [BUILTIN_TYPE_TAGS[name], BUILTIN_BRAND_TABLE[name]]),
  );
  const protoType = ctx.nativeProtoTypeIdx;
  if (protoType === undefined) throw new Error("Missing native Error prototype carrier");
  const parents = dispatch(
    protoType,
    0,
    NAMES.map((name) => [
      BUILTIN_BRAND_TABLE[name],
      name === "Error" ? BUILTIN_BRAND_TABLE.Object : BUILTIN_BRAND_TABLE.Error,
    ]),
  );
  // Keep existing user-subclass handling. Its userClassId is not the native
  // sentinel; answering its parent's intrinsic prototype would be incorrect.
  fn.body.splice(
    0,
    0,
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: value },
    { op: "local.get", index: value },
    { op: "ref.test", typeIdx: errorType },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...ref(errorType),
        { op: "struct.get", typeIdx: errorType, fieldIdx: 4 },
        { op: "i32.const", value: -1 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: instances },
      ],
    },
    { op: "local.get", index: value },
    { op: "ref.test", typeIdx: protoType },
    { op: "if", blockType: { kind: "empty" }, then: parents },
  );
}
