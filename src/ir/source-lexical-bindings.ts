// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import type { IrValueId } from "./core/nodes.js";
import { emitNativeReferenceError, emitNativeTypeError } from "./native-errors.js";

export const SOURCE_LEXICAL_VALUE_TYPE = { kind: "val", val: { kind: "externref" } } as const;
export const SOURCE_LEXICAL_FLAG_TYPE = { kind: "val", val: { kind: "i32" } } as const;

/** Source mutability belongs to the binding; both retained runtime cells use existing layouts. */
export interface SourceLexicalBinding {
  readonly valueCell: IrValueId;
  readonly initializedCell: IrValueId;
  readonly mutable: boolean;
}

export function createSourceLexicalBinding(builder: IrFunctionBuilder, mutable: boolean): SourceLexicalBinding {
  const value = builder.emitConst({ kind: "null", ty: SOURCE_LEXICAL_VALUE_TYPE }, SOURCE_LEXICAL_VALUE_TYPE);
  const initialized = builder.emitConst({ kind: "i32", value: 0 }, SOURCE_LEXICAL_FLAG_TYPE);
  return {
    valueCell: builder.emitRefCellNew(value, SOURCE_LEXICAL_VALUE_TYPE.val),
    initializedCell: builder.emitRefCellNew(initialized, SOURCE_LEXICAL_FLAG_TYPE.val),
    mutable,
  };
}

/** Shared by local cells and symbolic module storage, preserving the canonical error payload. */
export function emitSourceInitializationGuard(builder: IrFunctionBuilder, initialized: IrValueId): void {
  const cond = builder.emitUnary("i32.eqz", initialized, SOURCE_LEXICAL_FLAG_TYPE);
  const body = builder.collectBodyInstrs(() => emitNativeReferenceError(builder));
  builder.emitIfStmt({ cond, then: body, else: [] });
}

export function initializeSourceLexicalBinding(
  builder: IrFunctionBuilder,
  binding: SourceLexicalBinding,
  value: IrValueId,
): void {
  builder.emitRefCellSet(binding.valueCell, value);
  const initialized = builder.emitConst({ kind: "i32", value: 1 }, SOURCE_LEXICAL_FLAG_TYPE);
  builder.emitRefCellSet(binding.initializedCell, initialized);
}

export function readSourceLexicalBinding(builder: IrFunctionBuilder, binding: SourceLexicalBinding): IrValueId {
  emitSourceInitializationGuard(builder, builder.emitRefCellGet(binding.initializedCell, SOURCE_LEXICAL_FLAG_TYPE));
  return builder.emitRefCellGet(binding.valueCell, SOURCE_LEXICAL_VALUE_TYPE);
}

/** The caller has already evaluated/GetValue'd the RHS before PutValue checks. */
export function writeSourceLexicalBinding(
  builder: IrFunctionBuilder,
  binding: SourceLexicalBinding,
  value: IrValueId,
): void {
  emitSourceInitializationGuard(builder, builder.emitRefCellGet(binding.initializedCell, SOURCE_LEXICAL_FLAG_TYPE));
  if (!binding.mutable) {
    emitNativeTypeError(builder, "Assignment to constant variable.");
    return;
  }
  builder.emitRefCellSet(binding.valueCell, value);
}
