// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFunctionBuilder } from "./builder.js";
import { irTypeIsBoolean, irBool } from "./boolean-brand.js";
import { asVal, irDynamic, irVal, type IrValueId } from "./nodes.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { IrPrimitiveExpressionFamily } from "./module-bindings.js";

/** Preserve the source brand at the native property-key boundary. */
export function boxNativeInKey(
  builder: IrFunctionBuilder,
  value: IrValueId,
  family: IrPrimitiveExpressionFamily | undefined,
): IrValueId {
  const type = builder.typeOf(value);
  if (type.kind === "dynamic" || type.kind === "extern" || type.kind === "callable") return value;
  if (type.kind === "string") return builder.emitBox(value, irDynamic(JS_TAG_IDS.String));
  if (type.kind === "closure") return builder.emitCallablePack(value, type.signature);
  const val = asVal(type);
  if (irTypeIsBoolean(type) || (val?.kind === "i32" && family === "boolean")) {
    return builder.emitBox(value, irDynamic(JS_TAG_IDS.Boolean));
  }
  if (
    val?.kind === "f64" ||
    (val?.kind === "i32" && family === "number" && type.kind === "val" && type.signed !== false)
  ) {
    return builder.emitBox(value, irDynamic(JS_TAG_IDS.NumberF64));
  }
  if (
    type.kind === "object" ||
    type.kind === "class" ||
    type.kind === "vec" ||
    val?.kind === "externref" ||
    val?.kind === "ref" ||
    val?.kind === "ref_null" ||
    val?.kind === "eqref" ||
    val?.kind === "anyref"
  )
    return builder.emitCoerceToExternref(value);
  throw new IrUnsupportedError(
    "operand-coercion-unsupported",
    "build",
    "native in key has no certified boxing carrier",
  );
}

/** §13.10.1: validate the evaluated RHS before observable ToPropertyKey. */
export function lowerNativeIn(builder: IrFunctionBuilder, key: IrValueId, receiver: IrValueId): IrValueId {
  const object = builder.emitTagTest(receiver, JS_TAG_IDS.Object);
  const callable = builder.emitTagTest(receiver, JS_TAG_IDS.Function);
  const valid = builder.emitBinary("i32.or", object, callable, irBool());
  const invalid = builder.emitUnary("i32.eqz", valid, irBool());
  const then = builder.collectBodyInstrs(() => {
    const message = builder.emitBox(
      builder.emitStringConst("Cannot use 'in' operator to search for property in a non-object"),
      irDynamic(JS_TAG_IDS.String),
    );
    const error = builder.emitCall(irRuntimeFuncRef("__new_TypeError"), [message], irVal({ kind: "externref" }));
    if (error === null) throw new Error("TypeError constructor returned no value for native in");
    builder.emitThrow(error);
  });
  builder.emitIfStmt({ cond: invalid, then, else: [] });
  const propertyKey = builder.emitCall(irRuntimeFuncRef("__to_property_key"), [key], irDynamic());
  if (propertyKey === null) throw new Error("ToPropertyKey returned no value for native in");
  const result = builder.emitCall(irRuntimeFuncRef("__extern_has"), [receiver, propertyKey], irBool());
  if (result === null) throw new Error("HasProperty returned no value for native in");
  return result;
}
