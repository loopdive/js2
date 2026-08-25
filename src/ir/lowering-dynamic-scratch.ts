// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "./nodes.js";
import type { LocalDef, ValType } from "./types.js";

type DynamicScratchLocal = LocalDef & { readonly logicalType: IrType };

export interface IrDynamicScratchLocals {
  tag(carrier: ValType): number;
  toNumber(): number;
  instanceofTag(): number;
}

/** Lazily allocate the three dynamic-operation scratch slots in source order. */
export function createIrDynamicScratchLocals(
  paramCount: number,
  locals: DynamicScratchLocal[],
): IrDynamicScratchLocals {
  let tagIndex: number | null = null;
  let toNumberIndex: number | null = null;
  let instanceofTagIndex: number | null = null;
  const allocate = (name: string, type: ValType): number => {
    const index = paramCount + locals.length;
    locals.push({ name, type, logicalType: { kind: "val", val: type } });
    return index;
  };
  return {
    tag: (carrier) => {
      tagIndex ??= allocate("$dyn_tag_scratch", carrier);
      return tagIndex;
    },
    toNumber: () => {
      toNumberIndex ??= allocate(`__tmp_${locals.length}`, { kind: "externref" });
      return toNumberIndex;
    },
    instanceofTag: () => {
      instanceofTagIndex ??= allocate("$instanceof_tag_scratch", { kind: "i32" });
      return instanceofTagIndex;
    },
  };
}
