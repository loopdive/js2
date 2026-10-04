// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "./context/types.js";
import { ITER_FAMILY_ARRAY } from "./iterator-native.js";
import { consumeReflectGetReceiver } from "./reflect-get-receiver-read.js";

const filled = new WeakSet<CodegenContext>();

/** Native factory results expose their real, mutable intrinsic prototype.
 * Classify the explicit family, not the overlapping VEC iterator kind. */
export function fillArrayIteratorPropertyRead(ctx: CodegenContext): void {
  if (!ctx.standalone || filled.has(ctx)) return;
  const record = ctx.structMap.get("__IterRec");
  const prototype = ctx.builtinObjectGlobals.get("__native_array_iterator_prototype");
  const get = ctx.funcMap.get("__reflect_get_receiver");
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (record === undefined || prototype === undefined || get === undefined || !fn) return;
  filled.add(ctx);
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: record },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: record },
        { op: "struct.get", typeIdx: record, fieldIdx: 4 },
        { op: "i32.const", value: ITER_FAMILY_ARRAY },
        { op: "i32.eq" },
        { op: "global.get", index: prototype },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "global.get", index: prototype },
            { op: "local.get", index: 1 },
            ...consumeReflectGetReceiver(ctx),
            { op: "call", funcIdx: get },
            { op: "return" },
          ],
        },
      ],
    },
  );
}
