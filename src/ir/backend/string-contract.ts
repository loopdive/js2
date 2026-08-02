// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId, IrFuncRef, IrGlobalRef, IrStringLengthProvider } from "../nodes.js";
import type { IrStringConcatMode, IrStringEncoding } from "../string-runtime.js";

/**
 * Typed lowering boundary for shared string instructions. Operands are already
 * present in source order on the sink; each method consumes them and pushes
 * exactly the result described by `IR_STRING_RUNTIME`.
 */
export interface StringBackendEmitter<Sink> {
  emitStringConst(
    value: string,
    alloc: AllocSiteId | undefined,
    out: Sink,
    storage?: IrGlobalRef,
    materializer?: IrFuncRef,
  ): void;
  emitStringConcat(alloc: AllocSiteId | undefined, mode: IrStringConcatMode, out: Sink, provider?: IrFuncRef): void;
  emitStringEquals(negate: boolean, out: Sink, provider?: IrFuncRef): void;
  emitStringLength(inputEncoding: IrStringEncoding | undefined, out: Sink, provider?: IrStringLengthProvider): void;
  emitStringCharAt(
    alloc: AllocSiteId | undefined,
    inputEncoding: IrStringEncoding,
    out: Sink,
    provider?: IrFuncRef,
  ): void;
  emitStringCharCodeAt(inputEncoding: IrStringEncoding, out: Sink, provider?: IrFuncRef): void;
}
