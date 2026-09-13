// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ValType } from "../../../wasm/model/instructions.js";
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
const EXTERN: ValType = { kind: "externref" },
  F64: ValType = { kind: "f64" },
  I32: ValType = { kind: "i32" };
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
  const anyValue = tx.reserveType(key("any"), buildAnyValueType());
  const undefinedValue = tx.reserveGlobal(
    key("undefined"),
    "__undefined",
    { kind: "ref", typeIdx: anyValue.typeIndex },
    false,
  );
  const boxedNumber = tx.reserveType(key("number"), buildBoxNumberType());
  const boxedBoolean = tx.reserveType(key("boolean"), buildBoxBooleanType());
  // Preserve the union donor's number-related signature order. The legacy
  // adapter still interns ALL its unrelated signatures at the original sites.
  tx.internFunctionType([EXTERN], [I32]);
  tx.internFunctionType([EXTERN], [F64]);
  tx.internFunctionType([F64], [EXTERN]);
  const boxNumber = tx.reserveFunction(key("box-number"), "__box_number", { params: [F64], results: [EXTERN] });
  const unboxNumber = tx.reserveFunction(key("unbox-number"), "__unbox_number", { params: [EXTERN], results: [F64] });
  const isNumber = tx.reserveFunction(key("typeof-number"), "__typeof_number", { params: [EXTERN], results: [I32] });
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
