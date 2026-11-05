// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { irDynamic, irVal, type IrValueId } from "./nodes.js";

/** `if (cond) throw new TypeError(message)` through the native `__new_TypeError`. */
export function emitThrowTypeErrorIf(builder: IrFunctionBuilder, cond: IrValueId, message: string): void {
  const then = builder.collectBodyInstrs(() => {
    const boxed = builder.emitBox(builder.emitStringConst(message), irDynamic(JS_TAG_IDS.String));
    const error = builder.emitCall(irRuntimeFuncRef("__new_TypeError"), [boxed], irVal({ kind: "externref" }));
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (error === null) throw new Error("ir/throw-type-error: TypeError constructor returned no value");
    builder.emitThrow(error);
  });
  builder.emitIfStmt({ cond, then, else: [] });
}
