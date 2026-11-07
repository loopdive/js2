// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId, IrFuncRef, IrGlobalRef, IrStringLengthProvider } from "../nodes.js";
import type { IrStringConcatMode, IrStringEncoding } from "../string-runtime.js";
import type { ValType } from "../types.js";
import type { StringBuilderScratch, StringBuilderSlots } from "./wasm-string-builder.js";

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
  emitStringRepeat(
    alloc: AllocSiteId | undefined,
    inputEncoding: IrStringEncoding,
    out: Sink,
    provider?: IrFuncRef,
    countedStringAppendTripCount?: number,
  ): void;
  emitStringEquals(negate: boolean, out: Sink, provider?: IrFuncRef): void;
  emitStringLength(inputEncoding: IrStringEncoding | undefined, out: Sink, provider?: IrStringLengthProvider): void;
  emitStringCharAt(
    alloc: AllocSiteId | undefined,
    inputEncoding: IrStringEncoding,
    out: Sink,
    provider?: IrFuncRef,
  ): void;
  emitStringCharCodeAt(inputEncoding: IrStringEncoding, out: Sink, provider?: IrFuncRef): void;
  /** (#7291) The scalarised string builder, when this backend lowers one. */
  stringBuilder?(): StringBuilderEmitter<Sink> | undefined;
}

/**
 * (#7291) A `let s = ""` builder slot kept as buffer locals. Each append
 * consumes its operands from the sink and pushes nothing.
 */
export interface StringBuilderEmitter<Sink> {
  /** Local types: the code-unit buffer and a flattened string. */
  readonly bufType: ValType;
  readonly flatType: ValType;
  init(sb: StringBuilderSlots, out: Sink): void;
  /** Consumes a string. */
  appendString(sb: StringBuilderSlots, scratch: StringBuilderScratch, out: Sink): void;
  /** Consumes an i32 code unit. */
  appendCodeUnit(sb: StringBuilderSlots, scratch: StringBuilderScratch, out: Sink): void;
  /** Consumes a string and an i32 index; appends `charAt(index)`. */
  appendCharAt(sb: StringBuilderSlots, scratch: StringBuilderScratch, out: Sink): void;
  /** Pushes the contents as a string. */
  read(sb: StringBuilderSlots, out: Sink): void;
  /** Pushes the length as f64. */
  length(sb: StringBuilderSlots, out: Sink): void;
}
