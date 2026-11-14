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
import { irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import type { OwnPropertyTest } from "./nodes.js";
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

/**
 * `Object.defineProperty(object, key, { <fields> })` through the native
 * applier, over a fresh `$Object` descriptor with one `__extern_set` per field
 * in source order. The applier returns null for a [[DefineOwnProperty]]
 * rejection, which §20.1.2.4 turns into a TypeError — the message legacy's
 * rejection throw uses.
 */
export function emitOpenCarrierDefine(
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
 * One object-runtime helper over carrier operands, typed `result`: the call
 * every `Object` static with a helper makes, and propertyHelper's stored
 * aliases of a static (`__getOwnPropertyDescriptor(o, k)`, `__isArray(x)`).
 */
export function emitObjectRuntimeCall(
  builder: IrFunctionBuilder,
  provider: string,
  operands: readonly IrValueId[],
  result: IrType,
): IrValueId {
  const value = builder.emitCall(irRuntimeFuncRef(provider), [...operands], result);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (value === null) throw new Error(`ir/open-object-carrier: ${provider} produced no value`);
  return value;
}

/**
 * #7338 — an admitted `Object.<static>(…)` (`object-statics.ts`) over its
 * values, each lowered to a `dynamic` carrier by its thunk, and its
 * definitions, all evaluated before (every argument is, before the static's
 * first step):
 *   - the row's demand on the first value (an Object, or not nullish),
 *     where its helper does not make it;
 *   - the row's helper over the values, when it has one;
 *   - each definition, on the object the static answers: the helper's
 *     result, or the first value of a static that only defines.
 * Answers that object as a `dynamic` carrier.
 *
 * (#7339) An own-property test row (`R.<name>(k)`) reads its method from the
 * receiver first, so the receiver's nullish test runs before the key is
 * evaluated (§13.3.6.1 evaluates the member, then the arguments). It answers
 * the test's boolean.
 */
export function emitObjectStaticCall(
  builder: IrFunctionBuilder,
  call: Pick<ObjectStaticCall, "name" | "provider" | "requires" | "test">,
  operands: readonly (() => IrValueId)[],
  definitions: () => readonly ObjectStaticDefinitionValues[],
): IrValueId {
  const first = operands[0]!();
  if (!call.test) {
    const rest = operands.slice(1).map((operand) => operand());
    const defined = definitions();
    emitFirstValueDemand(builder, call, first);
    const values = [first, ...rest];
    const answer =
      call.provider === undefined ? first : emitObjectRuntimeCall(builder, call.provider, values, irDynamic());
    if (defined.length > 0) {
      const object = builder.emitCoerceToExternref(answer);
      for (const definition of defined) emitOpenCarrierDefine(builder, object, definition);
    }
    return answer;
  }
  emitFirstValueDemand(builder, call, first);
  return builder.emitDynOwnProperty(first, operands[1]!(), call.name as OwnPropertyTest);
}

/** The row's TypeError for a first value that is not an Object, or is `undefined` / `null`. */
function emitFirstValueDemand(
  builder: IrFunctionBuilder,
  call: Pick<ObjectStaticCall, "name" | "requires">,
  first: IrValueId,
): void {
  if (call.requires === "object") {
    emitThrowTypeErrorUnlessObject(builder, first, `Object.${call.name} called on non-object`);
  } else if (call.requires === "coercible") {
    emitThrowTypeErrorIfNullish(builder, first, "Cannot convert undefined or null to object");
  }
}
