// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../ir/types.js";

/**
 * Guard a vec read with JavaScript's out-of-bounds `undefined` semantics.
 *
 * (#4434) The bound is `min(vec.length, array.len(vec.data))`, not `vec.length`
 * alone. Those two are equal for every array the compiler grows itself, but the
 * `a.length = N` setter bumps the logical length WITHOUT growing the backing
 * (see `vec-index-domain.ts` §2), and JavaScript requires exactly that — a
 * legal `a.length = 4294967294` must not allocate four billion slots. Indices
 * in `[capacity, length)` are HOLES.
 *
 * Checking only the logical length let the `array.get` inside `elementRead` run
 * on an index the backing does not hold, which is an UNCATCHABLE Wasm trap
 * rather than a value:
 *
 * ```js
 * var a = [];
 * a.length = 3;
 * a[1];        // trapped "array element access out of bounds"; expected undefined
 * ```
 *
 * This affects the DEFAULT (host) lane too — `__vec_get` is the host bridge —
 * so the extra conjunct is deliberately not standalone-gated. It cannot
 * regress anything: the only behaviour it changes is a terminal trap, which no
 * passing program can depend on.
 *
 * @param arrTypeIdx the `data` array type, for the `array.len` capacity read
 */
export function guardVecElementRead(
  vecTypeIdx: number,
  arrTypeIdx: number,
  elementRead: Instr[],
  undefinedInstrs: Instr[],
): Instr[] {
  const logicalLength: Instr[] = [
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
  ];
  const capacity: Instr[] = [
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: vecTypeIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "array.len", typeIdx: arrTypeIdx } as Instr,
  ];
  return [
    { op: "local.get", index: 1 },
    ...logicalLength,
    { op: "i32.lt_u" },
    { op: "local.get", index: 1 },
    ...capacity,
    { op: "i32.lt_u" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: elementRead,
      else: undefinedInstrs.map((instr) => ({ ...instr })),
    },
    { op: "return" },
  ];
}
