// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId, IrGlobalRef, IrStringLengthProvider } from "../nodes.js";
import type { IrStringConcatMode, IrStringEncoding } from "../string-runtime.js";

/**
 * Typed lowering boundary for shared string instructions. Operands are already
 * present in source order on the sink; each method consumes them and pushes
 * exactly the result described by `IR_STRING_RUNTIME`.
 */
export interface StringBackendEmitter<Sink> {
  emitStringConst(value: string, alloc: AllocSiteId | undefined, out: Sink, storage?: IrGlobalRef): void;
  emitStringConcat(alloc: AllocSiteId | undefined, mode: IrStringConcatMode, out: Sink): void;
  emitStringEquals(negate: boolean, out: Sink): void;
  emitStringLength(inputEncoding: IrStringEncoding | undefined, out: Sink, provider?: IrStringLengthProvider): void;
  emitStringCharAt(alloc: AllocSiteId | undefined, inputEncoding: IrStringEncoding, out: Sink): void;
  emitStringCharCodeAt(inputEncoding: IrStringEncoding, out: Sink): void;
}
