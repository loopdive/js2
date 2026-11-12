// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7128 S1 — lowering for the open-object carrier (selection:
 * `empty-object-literal.ts`) and (#7338) for the `Object` statics that reach
 * it. The carrier is legacy's open-hash `$Object`, built by
 * `__new_plain_object`; a define runs the native `__obj_define_from_desc`
 * applier over a `$Object` descriptor, exactly the object legacy's descriptor
 * reify hands it.
 */

import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irVal, type IrType, type IrValueId } from "./nodes.js";
import type { ObjectStaticCall } from "./object-statics.js";
import {
  emitThrowTypeErrorIf,
  emitThrowTypeErrorIfNullish,
  emitThrowTypeErrorUnlessObject,
} from "./throw-type-error.js";

/** A fresh open-hash `$Object` from `__new_plain_object`, typed `type`. */
export function emitNewPlainObject(builder: IrFunctionBuilder, type: IrType): IrValueId {
  const object = builder.emitCall(irRuntimeFuncRef("__new_plain_object"), [], type);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (object === null) throw new Error("ir/open-object-carrier: __new_plain_object produced no value");
  return object;
}

/** One literal descriptor field, its value a `dynamic` carrier. */
export interface DescriptorFieldValue {
  readonly name: string;
  readonly value: IrValueId;
}

/** One definition of an `Object` static: its key (a `dynamic` carrier, or a static name) and its field values. */
export interface ObjectStaticDefinitionValues {
  readonly key: IrValueId | string;
  readonly fields: readonly DescriptorFieldValue[];
}

/** A `dynamic` carrier as the raw `externref` the object runtime takes; a fresh `{}` already is one. */
function asExternref(builder: IrFunctionBuilder, value: IrValueId): IrValueId {
  return builder.typeOf(value).kind === "dynamic" ? builder.emitCoerceToExternref(value) : value;
}

/**
 * `Object.defineProperty(object, key, { <fields> })` through the native
 * applier, over a fresh `$Object` descriptor with one `__extern_set` per field
 * in source order. The applier returns null for a [[DefineOwnProperty]]
 * rejection, which §20.1.2.4 turns into a TypeError — the message legacy's
 * rejection throw uses.
 */
function emitDefineFromDescriptor(
  builder: IrFunctionBuilder,
  object: IrValueId,
  { key, fields }: ObjectStaticDefinitionValues,
): void {
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
  const propertyKey = builder.emitCoerceToExternref(typeof key === "string" ? builder.emitStringConst(key) : key);
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
}

/**
 * #7338 — an admitted `Object.<static>(…)` (`object-statics.ts`). Each operand
 * is a `dynamic` carrier, or the raw `$Object` of an inline `{}`:
 *   - the static's demand of a carried first operand (an Object, or not
 *     nullish); a fresh `{}` is an Object by construction;
 *   - the row's helper over the operands, when it has one;
 *   - each definition, produced when it is applied, on the object the static
 *     answers: the helper's result, or the first operand of a static that only
 *     defines.
 * Answers that object: a raw `externref`, or the first operand as it came.
 */
export function emitObjectStaticCall(
  builder: IrFunctionBuilder,
  call: Pick<ObjectStaticCall, "name" | "provider" | "first">,
  operands: readonly IrValueId[],
  definitions: readonly (() => ObjectStaticDefinitionValues)[],
): IrValueId {
  const first = operands[0]!;
  if (builder.typeOf(first).kind === "dynamic") {
    if (call.first === "object") {
      emitThrowTypeErrorUnlessObject(builder, first, `Object.${call.name} called on non-object`);
    } else {
      emitThrowTypeErrorIfNullish(builder, first, "Cannot convert undefined or null to object");
    }
  }
  const externs = operands.map((operand) => asExternref(builder, operand));
  const answer =
    call.provider === undefined
      ? externs[0]!
      : builder.emitCall(irRuntimeFuncRef(call.provider), externs, irVal({ kind: "externref" }));
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (answer === null) throw new Error(`ir/open-object-carrier: ${call.provider} produced no value`);
  for (const definition of definitions) emitDefineFromDescriptor(builder, answer, definition());
  return call.provider === undefined ? first : answer;
}
