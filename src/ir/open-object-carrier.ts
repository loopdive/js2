// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7128 S1 — lowering for the open-object carrier (selection:
 * `empty-object-literal.ts`). The carrier is legacy's open-hash `$Object`,
 * built by `__new_plain_object`; a U1 define runs the native
 * `__obj_define_from_desc` applier over a `$Object` descriptor, exactly the
 * object legacy's descriptor reify hands it.
 */

import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irVal, type IrType, type IrValueId } from "./nodes.js";
import { emitThrowTypeErrorIf } from "./throw-type-error.js";

/** A fresh open-hash `$Object` from `__new_plain_object`, typed `type`. */
export function emitNewPlainObject(builder: IrFunctionBuilder, type: IrType): IrValueId {
  const object = builder.emitCall(irRuntimeFuncRef("__new_plain_object"), [], type);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (object === null) throw new Error("ir/open-object-carrier: __new_plain_object produced no value");
  return object;
}

/**
 * `Object.defineProperty(object, key, { <fields> })` through the native
 * applier. Each field value is already a dynamic carrier; the
 * descriptor gets one `__extern_set` per field in source order. The applier
 * returns null for a [[DefineOwnProperty]] rejection, which §20.1.2.4 turns
 * into a TypeError — the message legacy's rejection throw uses.
 */
export function emitOpenCarrierDefine(
  builder: IrFunctionBuilder,
  object: IrValueId,
  key: string,
  fields: readonly { readonly name: string; readonly value: IrValueId }[],
): IrValueId {
  const externref = irVal({ kind: "externref" });
  const descriptor = emitNewPlainObject(builder, externref);
  for (const field of fields) {
    const fieldKey = builder.emitCoerceToExternref(builder.emitStringConst(field.name));
    builder.emitCall(
      irRuntimeFuncRef("__extern_set"),
      [descriptor, fieldKey, builder.emitCoerceToExternref(field.value)],
      null,
    );
  }
  const propertyKey = builder.emitCoerceToExternref(builder.emitStringConst(key));
  const result = builder.emitCall(
    irRuntimeFuncRef("__obj_define_from_desc"),
    [object, propertyKey, descriptor],
    externref,
  );
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (result === null) throw new Error("ir/open-object-carrier: Object.defineProperty applier produced no result");
  emitThrowTypeErrorIf(
    builder,
    builder.emitRefIsNull(result),
    "Cannot define property, object is not extensible or index is invalid",
  );
  return result;
}
