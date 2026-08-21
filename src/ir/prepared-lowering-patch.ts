// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, WasmFunction } from "./types.js";

/** One dependency-sealed IR body waiting for atomic allocator-slot replacement. */
export interface PreparedIrPendingPatch<Entry> {
  readonly entry: Entry;
  readonly funcIdx: number;
  readonly existing: WasmFunction;
  readonly wasmFunc: WasmFunction;
  readonly finalBody: Instr[];
}
