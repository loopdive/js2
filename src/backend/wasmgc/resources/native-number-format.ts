// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import type {
  NativeResourceRecipe,
  NativeDeclaredValType,
  NativeDeclaredSignature,
  NativeStringValueDeclaration,
  NativeStringValueReservationStep,
} from "../../../runtime/wasmgc/values/native-resource-declaration-types.js";
import {
  numberFormatSignatures,
  buildNumberFormatFinalizeBody,
  buildNumberFormatToStringBody,
  buildNumberFormatNativeAdapterBody,
} from "../../../runtime/wasmgc/values/number-format-bodies.js";
import {
  buildNumberFormatNewBody,
  buildNumberFormatGetBody,
  buildNumberFormatSetBody,
  buildNumberFormatTrapBody,
  buildNumberFormatFinBody,
  buildNumberFormatRadixThunkBody,
} from "../../../runtime/wasmgc/values/number-format-radix-bodies.js";
import {
  nativeStringTypeKeys,
  nativeStringLiteralReservationInventory,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  declareNativeRyuResources,
  reserveNativeRyuResources,
  requireNativeRyuReservations,
  fillNativeRyuResources,
  requireCompletedNativeRyu,
  type NativeRyuReservations,
} from "./native-number-ryu.js";
import {
  executeNativeResourceRecipe,
  freezeNativeResourceRecipe,
  requireNativeDeclaredReservation,
} from "./native-resource-declarations.js";

export interface NativeNumberFormatResourceInput {
  readonly key: string;
  readonly stringKey: string;
  readonly integerBeforeScratch: boolean;
}
export type NativeNumberFormatFunctionRole =
  | "finalize"
  | "new"
  | "get"
  | "set"
  | "trap"
  | "fin"
  | "radix-body"
  | "radix-thunk"
  | "to-string"
  | "native-to-string";
export interface NativeNumberFormatReservations {
  readonly strings: NativeStringLiteralReservations;
  readonly ryu: NativeRyuReservations;
  readonly functions: Readonly<Record<NativeNumberFormatFunctionRole, FunctionReservation>>;
}
export type NativeNumberFormatResourceRow =
  | { readonly key: string; readonly space: "type"; readonly reservation: TypeReservation }
  | { readonly key: string; readonly space: "global"; readonly reservation: GlobalReservation }
  | { readonly key: string; readonly space: "function"; readonly reservation: FunctionReservation };

function fail(detail: string): never {
  throw new Error("native number format: " + detail);
}
function validateInput(input: NativeNumberFormatResourceInput): void {
  if (
    !input ||
    typeof input.key !== "string" ||
    !input.key ||
    typeof input.stringKey !== "string" ||
    !input.stringKey ||
    typeof input.integerBeforeScratch !== "boolean"
  )
    fail("invalid resource input");
}
function recipes(input: NativeNumberFormatResourceInput) {
  validateInput(input);
  const keys = nativeStringTypeKeys(input.stringKey);
  const signatures = numberFormatSignatures<NativeDeclaredValType>({
    data: { kind: "ref", typeKey: keys.data },
    nullableData: { kind: "ref_null", typeKey: keys.data },
    anyString: { kind: "ref", typeKey: keys.any },
  });
  const row = (
    role: NativeNumberFormatFunctionRole,
    name: string,
    signature: NativeDeclaredSignature,
  ): NativeStringValueDeclaration => ({
    key: `${input.key}:${role}`,
    role: ["number-format", role],
    space: "function",
    name,
    signature,
  });
  const prelude = [
    row("finalize", "__num_fmt_finalize", signatures.finalize),
    row("new", "__nfd_new", signatures.new),
    row("get", "__nfd_get", signatures.get),
    row("set", "__nfd_set", signatures.set),
    row("trap", "__num_fmt_trap", signatures.trap),
    row("fin", "__nfd_fin", signatures.fin),
    row("radix-body", "__sh_num_toString_radix", signatures.radixBody),
    row("radix-thunk", "number_toString_radix", signatures.radixThunk),
  ];
  const suffix = [
    row("to-string", "number_toString", signatures.toString),
    row("native-to-string", "__ir_number_toString_native", signatures.nativeToString),
  ];
  const make = (declarations: NativeStringValueDeclaration[]): NativeResourceRecipe => {
    const reservationSteps: NativeStringValueReservationStep[] = [];
    for (const declaration of declarations) {
      const role = declaration.role[1];
      // Legacy emitFunc explicitly names first signature misses; the following
      // function reservation performs the original cache-hit intern operation.
      if (
        declaration.space === "function" &&
        (role === "new" ||
          role === "get" ||
          role === "set" ||
          role === "trap" ||
          role === "fin" ||
          role === "radix-thunk")
      )
        reservationSteps.push({
          phase: "resources",
          kind: "intern-signature",
          signature: declaration.signature,
          name: `${declaration.name}_type`,
        });
      reservationSteps.push({ phase: "resources", kind: "reserve", resourceKey: declaration.key });
    }
    return freezeNativeResourceRecipe({ declarations, reservationSteps });
  };
  return {
    prelude: make(prelude),
    ryu: declareNativeRyuResources(`${input.key}:ryu`, input.stringKey),
    suffix: make(suffix),
  };
}
export function declareNativeNumberFormatResources(input: NativeNumberFormatResourceInput): NativeResourceRecipe {
  const parts = recipes(input);
  return freezeNativeResourceRecipe({
    declarations: [...parts.prelude.declarations, ...parts.ryu.declarations, ...parts.suffix.declarations],
    reservationSteps: [
      ...parts.prelude.reservationSteps,
      ...parts.ryu.reservationSteps,
      ...parts.suffix.reservationSteps,
    ],
  });
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly input: NativeNumberFormatResourceInput;
  readonly strings: NativeStringLiteralReservations;
  readonly ryu: NativeRyuReservations;
  readonly functions: NativeNumberFormatReservations["functions"];
  readonly inventory: readonly NativeNumberFormatResourceRow[];
  filled: boolean;
  fillStarted: boolean;
}
const owners = new WeakMap<NativeNumberFormatReservations, Owner>();
function ownerFor(tx: PhysicalModuleReservations, pack: NativeNumberFormatReservations): Owner {
  const owner = owners.get(pack);
  if (
    !owner ||
    owner.tx !== tx ||
    owner.strings !== pack.strings ||
    owner.ryu !== pack.ryu ||
    owner.functions !== pack.functions
  )
    fail("foreign or substituted resource owner");
  const { typePack } = nativeStringLiteralReservationInventory(tx, owner.strings);
  if (typePack.key !== owner.input.stringKey) fail("changed string key");
  requireNativeRyuReservations(tx, owner.ryu, `${owner.input.key}:ryu`, owner.strings);
  for (const row of owner.inventory) {
    if (tx.state === "reserving") {
      if (row.space === "type") tx.assertTypeReservation(row.reservation);
    } else tx.physicalIndex(row.reservation);
  }
  return owner;
}
export function requireNativeNumberFormatReservations(
  tx: PhysicalModuleReservations,
  pack: NativeNumberFormatReservations,
  input: NativeNumberFormatResourceInput,
  strings: NativeStringLiteralReservations,
): void {
  validateInput(input);
  const owner = ownerFor(tx, pack);
  if (
    strings !== owner.strings ||
    input.key !== owner.input.key ||
    input.stringKey !== owner.input.stringKey ||
    input.integerBeforeScratch !== owner.input.integerBeforeScratch
  )
    fail("changed resource input");
}
export function reserveNativeNumberFormatResources(
  tx: PhysicalModuleReservations,
  input: NativeNumberFormatResourceInput,
  strings: NativeStringLiteralReservations,
): NativeNumberFormatReservations {
  validateInput(input);
  if (tx.state !== "reserving") fail("invalid reservation phase");
  const { typePack } = nativeStringLiteralReservationInventory(tx, strings);
  if (typePack.key !== input.stringKey) fail("foreign string key");
  const parts = recipes(input);
  const types = new Map(typePack.types.map((token) => [token.key, token]));
  const prelude = executeNativeResourceRecipe(tx, parts.prelude, types);
  const ryu = reserveNativeRyuResources(tx, `${input.key}:ryu`, strings);
  const suffix = executeNativeResourceRecipe(tx, parts.suffix, types);
  const get = (role: NativeNumberFormatFunctionRole) =>
    requireNativeDeclaredReservation(
      prelude.has(`${input.key}:${role}`) ? prelude : suffix,
      `${input.key}:${role}`,
      "function",
    );
  const functions = Object.freeze({
    finalize: get("finalize"),
    new: get("new"),
    get: get("get"),
    set: get("set"),
    trap: get("trap"),
    fin: get("fin"),
    "radix-body": get("radix-body"),
    "radix-thunk": get("radix-thunk"),
    "to-string": get("to-string"),
    "native-to-string": get("native-to-string"),
  });
  const functionRow = (token: FunctionReservation): NativeNumberFormatResourceRow =>
    Object.freeze({ key: token.key, space: "function", reservation: token });
  const inventory: readonly NativeNumberFormatResourceRow[] = Object.freeze([
    ...[
      functions.finalize,
      functions.new,
      functions.get,
      functions.set,
      functions.trap,
      functions.fin,
      functions["radix-body"],
      functions["radix-thunk"],
    ].map(functionRow),
    functionRow(ryu.mulShift),
    Object.freeze({ key: ryu.tableType.key, space: "type" as const, reservation: ryu.tableType }),
    Object.freeze({ key: ryu.inverse.key, space: "global" as const, reservation: ryu.inverse }),
    Object.freeze({ key: ryu.powers.key, space: "global" as const, reservation: ryu.powers }),
    functionRow(ryu.digits),
    functionRow(ryu.toBuffer),
    functionRow(functions["to-string"]),
    functionRow(functions["native-to-string"]),
  ]);
  const pack = Object.freeze({ strings, ryu, functions });
  owners.set(pack, {
    tx,
    input: Object.freeze({ ...input }),
    strings,
    ryu,
    functions,
    inventory,
    filled: false,
    fillStarted: false,
  });
  return pack;
}
export function nativeNumberFormatReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeNumberFormatReservations,
): readonly NativeNumberFormatResourceRow[] {
  return ownerFor(tx, pack).inventory;
}
export function fillNativeNumberFormatResources(
  tx: PhysicalModuleReservations,
  pack: NativeNumberFormatReservations,
): void {
  const owner = ownerFor(tx, pack);
  if (owner.fillStarted || tx.state !== "filling") fail("duplicate fill or invalid fill phase");
  requireCompletedNativeStringLiterals(tx, owner.strings);
  owner.fillStarted = true;
  const layout = owner.strings.layout;
  const types = {
    dataTypeIdx: layout.nativeStrDataTypeIdx,
    nativeStringTypeIdx: layout.nativeStrTypeIdx,
    anyStringTypeIdx: layout.anyStrTypeIdx,
  };
  const functions = owner.functions;
  tx.fillFunction(functions.finalize, buildNumberFormatFinalizeBody(types));
  tx.fillFunction(functions.new, buildNumberFormatNewBody(types));
  tx.fillFunction(functions.get, buildNumberFormatGetBody(types));
  tx.fillFunction(functions.set, buildNumberFormatSetBody(types));
  tx.fillFunction(functions.trap, buildNumberFormatTrapBody());
  tx.fillFunction(functions.fin, buildNumberFormatFinBody(types));
  // The prepared D1 lowerer owns radix-body. Never install a placeholder here.
  tx.fillFunction(functions["radix-thunk"], buildNumberFormatRadixThunkBody(functions["radix-body"].handle));
  fillNativeRyuResources(tx, owner.ryu);
  tx.fillFunction(
    functions["to-string"],
    buildNumberFormatToStringBody({
      types,
      finalize: functions.finalize.handle,
      radix: functions["radix-thunk"].handle,
      ryuToBuffer: owner.ryu.toBuffer.handle,
      integerBeforeScratch: owner.input.integerBeforeScratch,
    }),
  );
  tx.fillFunction(
    functions["native-to-string"],
    buildNumberFormatNativeAdapterBody({
      toString: functions["to-string"].handle,
      anyStringTypeIdx: types.anyStringTypeIdx,
    }),
  );
  owner.filled = true;
}
export function requireCompletedNativeNumberFormat(
  tx: PhysicalModuleReservations,
  pack: NativeNumberFormatReservations,
): void {
  const owner = ownerFor(tx, pack);
  if (tx.state !== "sealed" || !owner.filled) fail("missing sealed canonical completion");
  requireCompletedNativeStringLiterals(tx, owner.strings);
  requireCompletedNativeRyu(tx, owner.ryu, owner.strings);
}
