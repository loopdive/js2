// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { NativeStringLiteralReservations } from "./native-string-literals.js";
import {
  requireNativeStringNumberReservations,
  requireCompletedNativeStringNumber,
  type NativeStringNumberReservations,
} from "./native-string-number.js";
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import {
  assertNativeValueResourcePlan,
  type NativeValueResourcePlan,
} from "../../../ir/program/native-value-resources.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import {
  buildAnyValueType,
  buildUndefinedInitializer,
  buildBoxNumberType,
  buildBoxBooleanType,
} from "../../../runtime/wasmgc/values/primitive-layouts.js";
import {
  buildBoxNumberBody,
  buildBoxNumberLocals,
  buildUnboxNumberBody,
  buildUnboxNumberLocals,
  buildTypeofNumberBody,
  type NativeNumberStringConversion,
} from "../../../runtime/wasmgc/values/number-bodies.js";
import type {
  NativeResourceRecipe,
  NativeDeclaredSignature,
  NativeStringValueDeclaration,
  NativeStringValueReservationStep,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  nativeScalarTypeDeclaration,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export function declareNativeValueResources(anchor: NativeValueResourcePlan["anchor"]): NativeResourceRecipe {
  const key = (role: string) => "physical:values:" + JSON.stringify(anchor) + ":" + role;
  const isNumber: NativeDeclaredSignature = { params: [{ kind: "externref" }], results: [{ kind: "i32" }] };
  const unbox: NativeDeclaredSignature = { params: [{ kind: "externref" }], results: [{ kind: "f64" }] };
  const box: NativeDeclaredSignature = { params: [{ kind: "f64" }], results: [{ kind: "externref" }] };
  const declarations: NativeStringValueDeclaration[] = [
    {
      key: key("any"),
      role: ["values", "any"],
      space: "type",
      shape: nativeScalarTypeDeclaration(buildAnyValueType()),
    },
    {
      key: key("undefined"),
      role: ["values", "undefined"],
      space: "global",
      name: "__undefined",
      valueType: { kind: "ref", typeKey: key("any") },
      mutable: false,
    },
    {
      key: key("number"),
      role: ["values", "number"],
      space: "type",
      shape: nativeScalarTypeDeclaration(buildBoxNumberType()),
    },
    {
      key: key("boolean"),
      role: ["values", "boolean"],
      space: "type",
      shape: nativeScalarTypeDeclaration(buildBoxBooleanType()),
    },
    { key: key("box-number"), role: ["values", "box-number"], space: "function", name: "__box_number", signature: box },
    {
      key: key("unbox-number"),
      role: ["values", "unbox-number"],
      space: "function",
      name: "__unbox_number",
      signature: unbox,
    },
    {
      key: key("typeof-number"),
      role: ["values", "typeof-number"],
      space: "function",
      name: "__typeof_number",
      signature: isNumber,
    },
  ];
  const reserve = (row: NativeStringValueDeclaration): NativeStringValueReservationStep => ({
    phase: "resources",
    kind: "reserve",
    resourceKey: row.key,
  });
  // These explicit interns precede the helpers even when all three signatures already exist.
  const reservationSteps: NativeStringValueReservationStep[] = [
    ...declarations.slice(0, 4).map(reserve),
    ...[isNumber, unbox, box].map(
      (signature): NativeStringValueReservationStep => ({ phase: "resources", kind: "intern-signature", signature }),
    ),
    ...declarations.slice(4).map(reserve),
  ];
  return freezeNativeResourceRecipe({ declarations, reservationSteps });
}

export type NativeValueStringDependency =
  | {
      readonly kind: "native-string";
      readonly stringPack: NativeStringLiteralReservations;
      readonly scanner: NativeStringNumberReservations;
    }
  | { readonly kind: "absent" };
export interface NativeValueDependencies {
  readonly strings: NativeValueStringDependency;
}
export interface NativeValueReservations {
  readonly types: {
    readonly anyValue: TypeReservation;
    readonly boxedNumber: TypeReservation;
    readonly boxedBoolean: TypeReservation;
  };
  readonly globals: { readonly undefined: GlobalReservation };
  readonly functions: {
    readonly boxNumber: FunctionReservation;
    readonly unboxNumber: FunctionReservation;
    readonly isNumber: FunctionReservation;
  };
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativeValueResourcePlan;
  readonly dependency: NativeValueStringDependency;
}
const owners = new WeakMap<NativeValueReservations, Owner>();
function fail(detail: string): never {
  throw new Error("native value resources: " + detail);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}

function requireDependency(
  tx: PhysicalModuleReservations,
  requirements: NativeValueResourcePlan,
  dependencies: NativeValueDependencies,
): NativeValueStringDependency {
  const strings = dependencies?.strings;
  if (requirements.strings === "primitive-only") {
    if (strings?.kind !== "absent") fail("primitive-only requirements contradict the scanner dependency");
  } else if (strings?.kind !== "native-string") {
    fail("selected native strings require the actual StringToNumber dependency");
  }
  if (strings.kind === "native-string") {
    requireNativeStringNumberReservations(tx, strings.scanner, requirements, strings.stringPack);
  }
  return strings;
}

/** Reserve on the existing transaction only; no freezes, fills or publication here. */
export function reserveNativeValueResources(
  tx: PhysicalModuleReservations,
  requirements: NativeValueResourcePlan,
  dependencies: NativeValueDependencies,
): NativeValueReservations {
  assertNativeValueResourcePlan(requirements);
  const strings = requireDependency(tx, requirements, dependencies);
  const key = (role: string) => "physical:values:" + JSON.stringify(requirements.anchor) + ":" + role;
  const records = executeNativeResourceRecipe(tx, declareNativeValueResources(requirements.anchor));
  const anyValue = requireNativeDeclaredReservation(records, key("any"), "type");
  const undefinedValue = requireNativeDeclaredReservation(records, key("undefined"), "global");
  const boxedNumber = requireNativeDeclaredReservation(records, key("number"), "type");
  const boxedBoolean = requireNativeDeclaredReservation(records, key("boolean"), "type");
  const boxNumber = requireNativeDeclaredReservation(records, key("box-number"), "function");
  const unboxNumber = requireNativeDeclaredReservation(records, key("unbox-number"), "function");
  const isNumber = requireNativeDeclaredReservation(records, key("typeof-number"), "function");
  const result = Object.freeze({
    types: Object.freeze({ anyValue, boxedNumber, boxedBoolean }),
    globals: Object.freeze({ undefined: undefinedValue }),
    functions: Object.freeze({ boxNumber, unboxNumber, isNumber }),
  });
  owners.set(result, {
    tx,
    requirements,
    dependency:
      strings.kind === "absent"
        ? Object.freeze({ kind: "absent" })
        : Object.freeze({ kind: "native-string", stringPack: strings.stringPack, scanner: strings.scanner }),
  });
  return result;
}

/** Fill the exact reserved objects after freeze. The ledger remains completion authority. */
export function fillNativeValueResources(
  tx: PhysicalModuleReservations,
  reservations: NativeValueReservations,
  dependencies: NativeValueDependencies,
): void {
  const owner = owners.get(reservations);
  if (!owner || owner.tx !== tx) fail("foreign native value reservations");
  assertNativeValueResourcePlan(owner.requirements);
  const strings = requireDependency(tx, owner.requirements, dependencies);
  if (
    strings.kind !== owner.dependency.kind ||
    (strings.kind === "native-string" &&
      (owner.dependency.kind !== "native-string" ||
        strings.stringPack !== owner.dependency.stringPack ||
        strings.scanner !== owner.dependency.scanner))
  )
    fail("substituted native string conversion dependency");
  const { anyValue, boxedNumber, boxedBoolean } = reservations.types;
  for (const [token, expected] of [
    [anyValue, buildAnyValueType()],
    [boxedNumber, buildBoxNumberType()],
    [boxedBoolean, buildBoxBooleanType()],
  ] as const) {
    if (tx.physicalIndex(token) !== token.typeIndex) fail("stale primitive layout coordinate");
    same(token.object, expected, "altered primitive layout");
  }
  for (const token of Object.values(reservations.functions)) tx.physicalIndex(token);
  tx.physicalIndex(reservations.globals.undefined);
  let conversion: NativeNumberStringConversion;
  if (strings.kind === "native-string") {
    const scanner = requireCompletedNativeStringNumber(tx, strings.scanner, owner.requirements, strings.stringPack);
    conversion = {
      kind: "native-string",
      anyStringTypeIdx: strings.stringPack.layout.anyStrTypeIdx,
      toNumber: scanner.toNumber.handle,
    };
  } else {
    conversion = { kind: "absent", evidence: "selected-primitive-only" };
  }
  tx.fillGlobal(reservations.globals.undefined, buildUndefinedInitializer(anyValue.typeIndex));
  tx.fillFunction(reservations.functions.boxNumber, {
    locals: buildBoxNumberLocals(),
    body: buildBoxNumberBody(boxedNumber.typeIndex),
  });
  tx.fillFunction(reservations.functions.unboxNumber, {
    locals: buildUnboxNumberLocals(),
    body: buildUnboxNumberBody(boxedNumber.typeIndex, boxedBoolean.typeIndex, conversion),
  });
  tx.fillFunction(reservations.functions.isNumber, { locals: [], body: buildTypeofNumberBody(boxedNumber.typeIndex) });
}
