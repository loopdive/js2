// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7368) The `Object` statics' object runtime on the Prepared whole-program path: the `js.object.*` contracts
 * (`runtime/ordinary-object-callables.ts`) in the shape `emitObjectStaticCall` asks (`ObjectStaticRuntime`,
 * `open-object-carrier.ts`). The realm kernel serves each contract (`native-source-objects.ts`), so a define is the
 * descriptor pack's ValidateAndApplyPropertyDescriptor and no descriptor object is built.
 *
 * A carrier crosses to a contract as the externref it already is, and a key as its ToPropertyKey string.
 */
import type { IrFunctionBuilder } from "./builder.js";
import { irIntrinsicFuncRef } from "./callable-bindings.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import type { ObjectStaticProvider } from "./object-statics.js";
import type { DescriptorFieldValue, ObjectStaticRuntime } from "./open-object-carrier.js";
import { demoteToLegacy } from "./outcomes.js";
import type { OrdinaryObjectRuntimeFeature } from "./runtime/contracts/manifest.js";
import { ORDINARY_DESCRIPTOR_WORD } from "./runtime/ordinary-object-callables.js";

const EXTERNREF = irVal({ kind: "externref" });
const WORD = irVal({ kind: "f64" });
const BOOLEAN = irVal({ kind: "i32", boolean: true });

const ATTRIBUTE_BIT: Readonly<Record<string, number>> = ORDINARY_DESCRIPTOR_WORD.attribute;
const VALUE_PRESENT: Readonly<Record<string, number>> = ORDINARY_DESCRIPTOR_WORD.field;

/**
 * The contract behind each helper a statics row names, or why the row has none on the Prepared path: a static whose
 * answer the realm cannot build yet refuses by name.
 */
const PROVIDER_CONTRACT: Readonly<Record<ObjectStaticProvider, OrdinaryObjectRuntimeFeature | { refusal: string }>> = {
  __getOwnPropertyDescriptor: "js.object.get-own-property",
  __getOwnPropertyNames: { refusal: "its answer is an array, which no js.object contract builds yet" },
  __object_create: { refusal: "a prototype other than null has no js.object contract yet" },
};

function contract(
  builder: IrFunctionBuilder,
  feature: OrdinaryObjectRuntimeFeature,
  args: readonly IrValueId[],
  result: IrType,
): IrValueId {
  const value = builder.emitCall(irIntrinsicFuncRef(feature), args, result);
  // invariant (producer-promise): a contract declared with a result returned no SSA value — #4502.
  if (value === null) throw new Error(`ir/ordinary-object-statics: ${feature} produced no value`);
  return value;
}

/**
 * ToPropertyKey (§7.1.19) of a static name or a key carrier. No carrier kind is a Symbol, so it is ToString, and a
 * carrier refined to the String partition is its own key.
 */
function propertyKey(builder: IrFunctionBuilder, key: IrValueId | string): IrValueId {
  if (typeof key === "string") return builder.emitCoerceToExternref(builder.emitStringConst(key));
  const type = builder.typeOf(key);
  const isString = type.kind === "dynamic" && type.tag === JS_TAG_IDS.String;
  return builder.emitCoerceToExternref(isString ? key : builder.emitDynToString(key));
}

/** ToPropertyDescriptor's word (§6.2.5.5): each field's presence, and ToBoolean of each attribute it holds. */
function descriptorWord(builder: IrFunctionBuilder, fields: readonly DescriptorFieldValue[]): IrValueId {
  const bit = (value: number) => builder.emitConst({ kind: "f64", value }, WORD);
  const zero = bit(0);
  let present = 0;
  const set: IrValueId[] = [];
  for (const { name, value } of fields) {
    const attribute = ATTRIBUTE_BIT[name];
    present += attribute === undefined ? VALUE_PRESENT[name]! : attribute << ORDINARY_DESCRIPTOR_WORD.presenceShift;
    if (attribute !== undefined) set.push(builder.emitSelect(builder.emitDynTruthy(value), bit(attribute), zero, WORD));
  }
  return set.reduce((word, term) => builder.emitBinary("f64.add", word, term, WORD), bit(present));
}

export const ORDINARY_OBJECT_RUNTIME: ObjectStaticRuntime = {
  newObject: (builder) =>
    builder.emitBox(contract(builder, "js.object.create-default", [], EXTERNREF), irDynamic(JS_TAG_IDS.Object)),

  call(builder, provider, operands) {
    const feature = PROVIDER_CONTRACT[provider];
    if (typeof feature !== "string")
      demoteToLegacy("call-resolution-unsupported", `ir/ordinary-object-statics: ${provider}: ${feature.refusal}`);
    const [object, key] = operands;
    return contract(
      builder,
      feature,
      [builder.emitCoerceToExternref(object!), propertyKey(builder, key!)],
      irDynamic(),
    );
  },

  /**
   * §20.1.2.4 step 4 as the contract of the descriptor's kind: an accessor descriptor (a `get` or `set` field), a
   * data descriptor (`value` or `writable`), else a generic one, which changes attributes only. A half or value the
   * literal does not hold is absent by its presence bit, whatever is passed in its place.
   */
  define(builder, object, { key, fields }) {
    const name = propertyKey(builder, key);
    const word = descriptorWord(builder, fields);
    const absent = () => builder.emitConst({ kind: "null", ty: EXTERNREF }, EXTERNREF);
    const field = (wanted: string) => {
      const held = fields.find((candidate) => candidate.name === wanted);
      return held === undefined ? absent() : builder.emitCoerceToExternref(held.value);
    };
    const holds = (...names: string[]) => fields.some((candidate) => names.includes(candidate.name));
    const define = (feature: OrdinaryObjectRuntimeFeature, values: readonly IrValueId[]) =>
      void builder.emitCall(irIntrinsicFuncRef(feature), [object, name, ...values, word], null);
    if (holds("get", "set")) define("js.object.define-accessor", [field("get"), field("set")]);
    else if (holds("value", "writable")) define("js.object.define-data", [field("value")]);
    else define("js.object.define-attributes", []);
  },

  ownProperty: (builder, receiver, key, test) =>
    contract(
      builder,
      test === "hasOwnProperty" ? "js.object.has-own" : "js.object.property-is-enumerable",
      [builder.emitCoerceToExternref(receiver), propertyKey(builder, key)],
      BOOLEAN,
    ),
};
