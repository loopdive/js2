// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

const emitted = new WeakSet<CodegenContext>();

/**
 * Expose the native `$__Date` carrier to the JS host method bridge.
 *
 * Dynamic property reads erase the carrier to externref, so a subsequent
 * `value.getTime()` cannot use the statically typed Date lowering. These
 * NUL-named exports let the runtime positively classify and read/write the
 * carrier without mistaking an ordinary `{ timestamp }` object for a Date.
 */
export function emitDateHostBridge(ctx: CodegenContext): void {
  if (emitted.has(ctx)) return;
  const dateTypeIdx = ctx.structMap.get("__Date");
  if (dateTypeIdx === undefined) return;
  emitted.add(ctx);

  const publish = (
    name: string,
    params: Parameters<typeof addFuncType>[1],
    results: Parameters<typeof addFuncType>[2],
    body: import("../ir/types.js").Instr[],
  ): void => {
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({ name, typeIdx, locals: [], body, exported: true });
    ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
  };

  publish(
    "__\0js2_is_date",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: dateTypeIdx }],
  );
  publish(
    "__\0js2_date_value",
    [{ kind: "externref" }],
    [{ kind: "i64" }],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: dateTypeIdx },
      { op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 },
    ],
  );
  publish(
    "__\0js2_date_set_value",
    [{ kind: "ref", typeIdx: dateTypeIdx }, { kind: "i64" }],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "struct.set", typeIdx: dateTypeIdx, fieldIdx: 0 },
    ],
  );
}
