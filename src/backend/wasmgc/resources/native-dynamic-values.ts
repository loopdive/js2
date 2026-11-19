// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 D1) The dynamic value's own runtime functions on the Prepared
 * standalone lane: strict equality, ToBoolean (#7354 T), the `undefined` value,
 * the `undefined` probe, (#7354 Ty) the string `typeof` test and (#7352) a string's own index read. Every body is a
 * shared pure builder; the number and Boolean carrier functions they call are the issued primitive owners', never a
 * lookalike.
 */
import type { PhysicalModuleReservations, FunctionReservation } from "../../../wasm/physical/module-reservations.js";
import type { IrInstrIntrinsic } from "../../../ir/core/nodes.js";
import type { NativeValueResourcePlan } from "../../../ir/program/native-value-resources.js";
import { buildObjectSameValueBody } from "../../../runtime/wasmgc/values/object-same-value-body.js";
import { buildStringCodeUnitReadDefinition } from "../../../runtime/wasmgc/values/string-exotic-bodies.js";
import {
  buildExternRefTestBody,
  buildIsUndefinedBody,
  buildToBooleanBody,
  buildToBooleanLocals,
} from "../../../runtime/wasmgc/values/primitive-layouts.js";
import type {
  NativeDeclaredValType,
  NativeStringValueDeclaration,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import { UNDEF_F64_BITS } from "../../../shared/contracts/f64-value-markers.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";
import { requireCompletedNativeBooleans, type NativeBooleanReservations } from "./native-booleans.js";
import {
  requireCompletedNativeValues,
  requireNativeValueReservations,
  type NativeValueDependencies,
  type NativeValueReservations,
} from "./native-values.js";

/** Which of the functions the projection's intrinsics demand. */
export interface NativeDynamicValueSelection {
  readonly strictEq: boolean;
  /** (#7354 Str) A native string can reach the carrier, so strict equality takes the string arm. */
  readonly strictEqStrings: boolean;
  readonly toBoolean: boolean;
  readonly undefinedValue: boolean;
  readonly isUndefined: boolean;
  /** (#7354 Ty) `typeof v === "string"`. */
  readonly isString: boolean;
  /** (#7354 Str2) The native string of a string-kinded value (ToString's string arm). */
  readonly asString: boolean;
  /** (#7352) A string-kinded value's own property at a number key. */
  readonly charAt: boolean;
}

/**
 * The functions the projection's executable dynamic-value intrinsics demand, or
 * `undefined` when it has none. The `undefined` probe counts only when the
 * manifest bound it to the native runtime function, not the host import.
 */
export function selectNativeDynamicValues(
  intrinsics: readonly IrInstrIntrinsic[],
  stringsCarried: boolean,
): NativeDynamicValueSelection | undefined {
  const has = (id: string) => intrinsics.some((instruction) => instruction.id === id);
  const selection = {
    strictEq: has("js.value.strict_eq"),
    strictEqStrings: stringsCarried && has("js.value.strict_eq"),
    toBoolean: has("js.value.to_boolean"),
    undefinedValue: has("js.value.undefined"),
    isUndefined: intrinsics.some(
      (instruction) =>
        instruction.id === "js.extern.is_undefined" &&
        instruction.provider?.kind === "callable" &&
        instruction.provider.target.binding.kind === "runtime",
    ),
    isString: has("js.value.is_string"),
    asString: has("js.value.as_string"),
    charAt: has("js.value.char_at"),
  };
  return Object.values(selection).some(Boolean) ? selection : undefined;
}

const EXTERNREF = { kind: "externref" } as const;
const I32 = { kind: "i32" } as const;
const F64 = { kind: "f64" } as const;
const ROWS = [
  ["strictEq", "strict-eq", "__js_strict_eq", { params: [EXTERNREF, EXTERNREF], results: [I32] }],
  ["toBoolean", "to-boolean", "__is_truthy", { params: [EXTERNREF], results: [I32] }],
  ["undefinedValue", "undefined-value", "__js_undefined", { params: [], results: [EXTERNREF] }],
  ["isUndefined", "is-undefined", "__extern_is_undefined", { params: [EXTERNREF], results: [I32] }],
  ["isString", "typeof-string", "__typeof_string", { params: [EXTERNREF], results: [I32] }],
  // (#7354 Str2) The result is the string owner's AnyString type, resolved by key.
  ["asString", "as-string", "__js_as_string", { params: [EXTERNREF], results: ["any-string"] }],
  ["charAt", "char-at", "__js_char_at", { params: [EXTERNREF, F64], results: [EXTERNREF] }],
] as const;

/** `stringKey` names the native string owner whose AnyString type `as_string` answers. */
export function declareNativeDynamicValueResources(
  key: string,
  selection: NativeDynamicValueSelection,
  stringKey: string,
) {
  const anyString: NativeDeclaredValType = { kind: "ref", typeKey: nativeStringTypeKeys(stringKey).any };
  const declarations: NativeStringValueDeclaration[] = ROWS.filter(([field]) => selection[field]).map(
    ([, role, name, signature]) => ({
      key: key + ":" + role,
      role: ["values", role],
      space: "function",
      name,
      signature: {
        params: [...signature.params],
        results: signature.results.map((type) => (type === "any-string" ? anyString : type)),
      },
    }),
  );
  return freezeNativeResourceRecipe({
    declarations,
    reservationSteps: declarations.map((row) => ({
      phase: "resources" as const,
      kind: "reserve" as const,
      resourceKey: row.key,
    })),
  });
}

export interface NativeDynamicValueReservations {
  readonly strictEq?: FunctionReservation;
  readonly toBoolean?: FunctionReservation;
  readonly undefinedValue?: FunctionReservation;
  readonly isUndefined?: FunctionReservation;
  readonly isString?: FunctionReservation;
  readonly asString?: FunctionReservation;
  readonly charAt?: FunctionReservation;
}
/** The issued string resources the bodies call. */
export interface NativeDynamicValueStrings {
  readonly flatten: FunctionReservation;
  /** (#7354 Str) Present exactly when strict equality takes its string arm (`strictEqStrings`). */
  readonly equals: FunctionReservation | undefined;
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly values: NativeValueReservations;
  readonly strings: NativeDynamicValueStrings;
  readonly booleans: NativeBooleanReservations | undefined;
  readonly requirements: NativeValueResourcePlan;
  readonly dependencies: NativeValueDependencies;
  filled: boolean;
}
const owners = new WeakMap<NativeDynamicValueReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native dynamic value resources: " + detail);
}

/** The dynamic-value lane's value resources always depend on the native string owner (native-string-values.ts). */
function carrierStringPack(dependencies: NativeValueDependencies): NativeStringLiteralReservations {
  if (dependencies.strings.kind !== "native-string") fail("the dynamic value requires the native string owner");
  return dependencies.strings.stringPack;
}

/** Strict equality reads Boolean payloads, so it requires the issued Boolean predicates. */
export function reserveNativeDynamicValueResources(
  tx: PhysicalModuleReservations,
  key: string,
  selection: NativeDynamicValueSelection,
  values: NativeValueReservations,
  booleans: NativeBooleanReservations | undefined,
  requirements: NativeValueResourcePlan,
  dependencies: NativeValueDependencies,
  strings: NativeDynamicValueStrings,
): NativeDynamicValueReservations {
  if (!key || tx.state !== "reserving") fail("invalid reservation phase/key");
  if (selection.strictEq && !booleans) fail("strict equality requires the Boolean predicates");
  requireNativeValueReservations(tx, values, requirements, dependencies);
  const stringPack = carrierStringPack(dependencies);
  const { typePack } = nativeStringLiteralReservationInventory(tx, stringPack);
  const records = executeNativeResourceRecipe(
    tx,
    declareNativeDynamicValueResources(key, selection, typePack.key),
    new Map(typePack.types.map((token) => [token.key, token])),
  );
  const pack: NativeDynamicValueReservations = Object.freeze(
    Object.fromEntries(
      ROWS.filter(([field]) => selection[field]).map(([field, role]) => [
        field,
        requireNativeDeclaredReservation(records, key + ":" + role, "function"),
      ]),
    ),
  );
  owners.set(pack, { tx, values, strings, booleans, requirements, dependencies, filled: false });
  return pack;
}

export function fillNativeDynamicValueResources(
  tx: PhysicalModuleReservations,
  pack: NativeDynamicValueReservations,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign resource owner");
  if (owner.filled) fail("duplicate fill");
  const { values, booleans, strings } = owner;
  requireCompletedNativeValues(tx, values, owner.requirements, owner.dependencies);
  if (pack.strictEq) {
    requireCompletedNativeBooleans(tx, booleans!, values, owner.requirements, owner.dependencies);
    tx.fillFunction(pack.strictEq, {
      locals: [
        { name: "aa", type: { kind: "anyref" } },
        { name: "ba", type: { kind: "anyref" } },
      ],
      // IsStrictlyEqual (§7.2.15) is SameValue's dispatch with Number::equal. No BigInt enters a Prepared dynamic
      // value, so the BigInt arm is absent; (#7354 T) the null reference takes the body's null arm; (#7354 Str)
      // the string arm compares code units whenever a native string can reach the carrier.
      body: buildObjectSameValueBody({
        typeofNumIdx: values.functions.isNumber.handle,
        typeofBoolIdx: booleans!.isBoolean.handle,
        unboxNumIdx: values.functions.unboxNumber.handle,
        unboxBoolIdx: booleans!.unboxBoolean.handle,
        numberEquality: "number-equal",
        // The string arm is built exactly when string equality is issued.
        anyStrTypeIdx: carrierStringPack(owner.dependencies).layout.anyStrTypeIdx,
        strFlattenIdx: strings.flatten.handle,
        strEqualsIdx: strings.equals?.handle,
      }),
    });
  }
  // The admitted carriers are the number and Boolean boxes, the `undefined` singleton, the null reference and
  // (#7354 Str) a native string, falsy when empty; no BigInt reaches a Prepared dynamic value, so that arm is absent.
  const carrierStrings = owner.dependencies.strings;
  if (pack.toBoolean)
    tx.fillFunction(pack.toBoolean, {
      locals: buildToBooleanLocals(),
      body: buildToBooleanBody({
        anyValueTypeIdx: values.types.anyValue.typeIndex,
        internalizeOnce: true,
        boxNumberTypeIdx: values.types.boxedNumber.typeIndex,
        boxBooleanTypeIdx: values.types.boxedBoolean.typeIndex,
        bigIntTypeIdx: undefined,
        anyStringTypeIdx:
          carrierStrings.kind === "native-string" ? carrierStrings.stringPack.layout.anyStrTypeIdx : undefined,
      }),
    });
  if (pack.undefinedValue)
    tx.fillFunction(pack.undefinedValue, {
      locals: [],
      body: [{ op: "global.get", index: tx.physicalIndex(values.globals.undefined) }, { op: "extern.convert_any" }],
    });
  if (pack.isUndefined)
    tx.fillFunction(pack.isUndefined, {
      locals: [{ name: "any", type: { kind: "anyref" } }],
      body: buildIsUndefinedBody(
        values.types.anyValue.typeIndex,
        values.types.boxedNumber.typeIndex,
        1,
        UNDEF_F64_BITS,
      ),
    });
  const { anyStrTypeIdx, nativeStrTypeIdx } = carrierStringPack(owner.dependencies).layout;
  if (pack.isString) tx.fillFunction(pack.isString, { locals: [], body: buildExternRefTestBody(anyStrTypeIdx) });
  // The string reads are called only on a value `is_string` answered: their casts cannot fail.
  if (pack.asString)
    tx.fillFunction(pack.asString, {
      locals: [],
      body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: anyStrTypeIdx }],
    });
  if (pack.charAt)
    tx.fillFunction(
      pack.charAt,
      buildStringCodeUnitReadDefinition({
        anyStrTypeIdx,
        nativeStrTypeIdx,
        flattenIdx: strings.flatten.handle,
        undefinedGlobalIdx: tx.physicalIndex(values.globals.undefined),
      }),
    );
  owner.filled = true;
}

export function requireCompletedNativeDynamicValues(
  tx: PhysicalModuleReservations,
  pack: NativeDynamicValueReservations,
): NativeDynamicValueReservations {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign resource owner");
  if (!owner.filled) fail("incomplete resources");
  for (const token of Object.values(pack)) tx.assertCompletedReservation(token);
  return pack;
}
