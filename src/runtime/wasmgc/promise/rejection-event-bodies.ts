// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, TypeHandle } from "../../../wasm/model/instructions.js";

/** Optional same-graph Deno event dispatcher: (number, any, any) -> void.
 * The adapter must retain event order and identity without reentering a
 * borrowed runtime. No dispatcher means byte-inert ordinary compilation.
 */
export function buildPromiseRejectionEvent(
  dispatch: FuncHandle | undefined,
  event: 0 | 1 | 2 | 3,
  promise: readonly Instr[],
  value: readonly Instr[],
): Instr[] {
  if (dispatch === undefined) return [];
  return [
    { op: "f64.const", value: event },
    ...promise,
    { op: "extern.convert_any" },
    ...value,
    { op: "call", funcIdx: dispatch },
  ];
}

/** Attach a real reaction. Mark before dispatch to prevent reentrant duplicate
 * handle events. Explicit Promise::MarkAsHandled must not use this helper.
 */
export function buildPromiseReactionHandled(
  dispatch: FuncHandle | undefined,
  typeIdx: TypeHandle,
  local: number,
  carrier: "gc" | "extern" = "gc",
): Instr[] {
  const promise = (): Instr[] => [
    { op: "local.get", index: local },
    ...(carrier === "extern" ? [{ op: "any.convert_extern" } as Instr, { op: "ref.cast", typeIdx } as Instr] : []),
  ];
  const mark = (): Instr[] => [...promise(), { op: "i32.const", value: 1 }, { op: "struct.set", typeIdx, fieldIdx: 4 }];
  if (dispatch === undefined) return mark();
  return [
    ...promise(),
    { op: "struct.get", typeIdx, fieldIdx: 4 },
    { op: "i32.eqz" },
    ...promise(),
    { op: "struct.get", typeIdx, fieldIdx: 0 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...mark(), ...buildPromiseRejectionEvent(dispatch, 1, promise(), [{ op: "ref.null.extern" }])],
      else: mark(),
    },
  ];
}
