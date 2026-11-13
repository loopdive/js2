// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { irDynamic, irVal, type IrValueId } from "./nodes.js";

/** `throw new TypeError(message)` through the native `__new_TypeError`. */
function emitThrowTypeError(builder: IrFunctionBuilder, message: string): void {
  const boxed = builder.emitBox(builder.emitStringConst(message), irDynamic(JS_TAG_IDS.String));
  const error = builder.emitCall(irRuntimeFuncRef("__new_TypeError"), [boxed], irVal({ kind: "externref" }));
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (error === null) throw new Error("ir/throw-type-error: TypeError constructor returned no value");
  builder.emitThrow(error);
}

/** `if (cond) throw new TypeError(message)`. */
export function emitThrowTypeErrorIf(builder: IrFunctionBuilder, cond: IrValueId, message: string): void {
  builder.emitIfStmt({ cond, then: builder.collectBodyInstrs(() => emitThrowTypeError(builder, message)), else: [] });
}

/** `if (Type(value) is not Object) throw new TypeError(message)`, for a `dynamic` value: neither an object nor a function. */
export function emitThrowTypeErrorUnlessObject(builder: IrFunctionBuilder, value: IrValueId, message: string): void {
  const unlessFunction = builder.collectBodyInstrs(() => {
    const neither = builder.collectBodyInstrs(() => emitThrowTypeError(builder, message));
    builder.emitIfStmt({ cond: builder.emitTagTest(value, JS_TAG_IDS.Function), then: [], else: neither });
  });
  builder.emitIfStmt({ cond: builder.emitTagTest(value, JS_TAG_IDS.Object), then: [], else: unlessFunction });
}

/** §7.1.18 ToObject's TypeError, for a `dynamic` value: `undefined` or `null`. */
export function emitThrowTypeErrorIfNullish(builder: IrFunctionBuilder, value: IrValueId, message: string): void {
  emitThrowTypeErrorIf(builder, builder.emitTagTest(value, JS_TAG_IDS.Undefined), message);
  emitThrowTypeErrorIf(builder, builder.emitTagTest(value, JS_TAG_IDS.Null), message);
}
