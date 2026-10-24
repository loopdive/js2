// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { emitNativeTypeError } from "./native-errors.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irBool } from "./boolean-brand.js";
import { irDynamic, type IrValueId } from "./nodes.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";

export { boxNativeValue as boxNativeInKey } from "./native-value-carrier.js";

/** §13.10.1: validate the evaluated RHS before observable ToPropertyKey. */
export function lowerNativeIn(builder: IrFunctionBuilder, key: IrValueId, receiver: IrValueId): IrValueId {
  const object = builder.emitTagTest(receiver, JS_TAG_IDS.Object);
  const callable = builder.emitTagTest(receiver, JS_TAG_IDS.Function);
  const valid = builder.emitBinary("i32.or", object, callable, irBool());
  const invalid = builder.emitUnary("i32.eqz", valid, irBool());
  const then = builder.collectBodyInstrs(() => {
    emitNativeTypeError(builder, "Cannot use 'in' operator to search for property in a non-object");
  });
  builder.emitIfStmt({ cond: invalid, then, else: [] });
  const propertyKey = builder.emitCall(irRuntimeFuncRef("__to_property_key"), [key], irDynamic());
  if (propertyKey === null) throw new Error("ToPropertyKey returned no value for native in");
  const result = builder.emitCall(irRuntimeFuncRef("__extern_has"), [receiver, propertyKey], irBool());
  if (result === null) throw new Error("HasProperty returned no value for native in");
  return result;
}
