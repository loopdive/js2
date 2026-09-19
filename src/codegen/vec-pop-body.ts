// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, ValType } from "../ir/types.js";

/** Physical facts prepared and validated by the existing vec bridge owner. */
export interface VecPopEntry {
  readonly elemKey: string;
  readonly vecTypeIdx: number;
  readonly arrTypeIdx: number;
  readonly isNativeStr: boolean;
  readonly storageGet: FuncHandle | undefined;
}

/** Closed pop body construction; no module allocation or callable publication. */
export function buildVecPopBody(
  entries: readonly (Readonly<VecPopEntry> | undefined)[],
  boxNumHandle: FuncHandle | undefined,
): { locals: { name: string; type: ValType }[]; body: Instr[] } {
  const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  let current: Instr[] = [{ op: "ref.null.extern" }, { op: "return" }];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const { elemKey, vecTypeIdx, arrTypeIdx, isNativeStr, storageGet } = entry;
    const base = 1 + locals.length; // 1 param + locals so far
    const vecL = base;
    const lenL = base + 1;
    locals.push(
      { name: `__vpop_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
      { name: `__vpop_len_${vecTypeIdx}`, type: { kind: "i32" } },
    );
    // (#2593) Packed i8/i16 elements need array.get_u and unsigned→f64; plain
    // `array.get` is invalid Wasm on a packed array. Generic dynamic path reads
    // zero-extended (the per-view signedness is at the typed `a[i]` site).
    // (#2835) `i32_byte` (ArrayBuffer/DataView byte buffer) is now packed i8 too
    // — same unsigned read/box. `i32_elem` (Int32/Uint32 element storage) stays
    // full-width signed (plain `array.get`), preserving its pre-split behaviour.
    const isPackedByte = elemKey === "i8_byte" || elemKey === "i16_byte" || elemKey === "i32_byte";
    const boxInstrs: Instr[] =
      elemKey === "externref"
        ? []
        : // (#3311) native-string element (`ref null $AnyString`) → externref via
          // the plain anyref→externref box (no `__box_number`).
          // (#4531/#4527) struct-ref elements box the same way.
          isNativeStr || elemKey === "structref"
          ? [{ op: "extern.convert_any" }]
          : elemKey === "f64"
            ? [{ op: "call", funcIdx: boxNumHandle! }]
            : isPackedByte
              ? [{ op: "f64.convert_i32_u" }, { op: "call", funcIdx: boxNumHandle! }]
              : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumHandle! }];
    const thenBranch: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: vecTypeIdx },
      { op: "local.set", index: vecL },
      { op: "local.get", index: vecL },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: lenL },
      // empty → undefined
      { op: "local.get", index: lenL },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // value = data[len-1] (boxed)
      { op: "local.get", index: vecL },
      ...(storageGet === undefined
        ? [{ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr]
        : [{ op: "extern.convert_any" } as Instr]),
      { op: "local.get", index: lenL },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      ...(storageGet === undefined
        ? [{ op: isPackedByte ? "array.get_u" : "array.get", typeIdx: arrTypeIdx } as Instr]
        : [{ op: "call", funcIdx: storageGet } as Instr]),
      ...boxInstrs,
      // vec.length = len - 1 (value stays beneath on the stack)
      { op: "local.get", index: vecL },
      { op: "local.get", index: lenL },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "return" },
    ];
    current = [
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: vecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: thenBranch,
        else: current,
      },
    ];
  }
  body.push(...current);
  return { locals, body };
}
