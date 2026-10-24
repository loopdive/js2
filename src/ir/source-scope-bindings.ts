// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import type { IrClosureSignature, IrFuncRef, IrGlobalRef, IrType, IrValueId } from "./core/nodes.js";
import type { Encoding } from "./analysis/encoding.js";
import { bindSourceClosureCaptures, type ClosureCaptureBinding } from "./source-closure-capture-bindings.js";
import { SOURCE_LEXICAL_VALUE_TYPE, type SourceLexicalBinding } from "./source-lexical-bindings.js";

/** Frontend storage, shared by ordinary and original member closure entries. */
export type ScopeBinding =
  | { kind: "local"; value: IrValueId; type: IrType; stringEncoding?: Encoding }
  | { kind: "lexical"; storage: SourceLexicalBinding; type: typeof SOURCE_LEXICAL_VALUE_TYPE }
  | { kind: "withField"; receiver: IrValueId; name: string; type: IrType; stringEncoding?: Encoding }
  | { kind: "moduleGlobal"; globalRef: IrGlobalRef; type: IrType; stringEncoding?: Encoding }
  | { kind: "nestedFunc"; target: IrFuncRef; signature: IrClosureSignature; captures: readonly NestedCapture[] }
  | {
      kind: "slot";
      slotIndex: number;
      type: IrType;
      /** Logical string reads can retain a named type over their physical reference slot. */
      asType?: IrType;
      /** Physical i32 storage still exposes f64 on every source-level read. */
      i32Storage?: true;
      stringEncoding?: Encoding;
    };

/** Mutable ordinary captures retain cells; with-fields retain the original receiver. */
export interface NestedCapture {
  readonly name: string;
  readonly type: IrType;
  readonly mutable: boolean;
  readonly outerValue: IrValueId;
  readonly withField?: { readonly name: string; readonly type: IrType };
  readonly lexicalBinding?: { readonly initializedCell: IrValueId; readonly mutable: boolean };
}

export function bindSourceClosureScope(
  captures: readonly ClosureCaptureBinding[],
  captureFieldTypes: readonly IrType[],
  self: IrValueId,
  builder: IrFunctionBuilder,
  scope: Map<string, ScopeBinding>,
): void {
  bindSourceClosureCaptures(captures, captureFieldTypes, self, builder, (capture, value, type, initialized) => {
    if (capture.lexical) {
      scope.set(capture.name, {
        kind: "lexical",
        type: SOURCE_LEXICAL_VALUE_TYPE,
        storage: { valueCell: value, initializedCell: initialized!, mutable: capture.lexical.mutable },
      });
    } else if (capture.withField) {
      scope.set(capture.name, {
        kind: "withField",
        receiver: value,
        name: capture.withField.name,
        type: capture.withField.type,
      });
    } else scope.set(capture.name, { kind: "local", value, type });
  });
}
