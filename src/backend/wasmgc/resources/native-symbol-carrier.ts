// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  FunctionReservation,
} from "../../../wasm/physical/module-reservations.js";
import {
  nativeStringLiteralReservationInventory,
  nativeStringTypeKeys,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
} from "./native-string-literals.js";
import {
  createSymbolCarrierShape,
  createSymbolCarrierType,
  createSymbolInternArrayType,
  buildSymbolBoxDefinition,
} from "../../../runtime/wasmgc/values/symbol-carrier-bodies.js";

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function fail(detail: string): never {
  throw new Error("native symbol carrier: " + detail);
}

/** Symbol-specific symbolic name; the issued token supplies its numeric suffix. */
export function declareNativeSymbolCarrierResources(key: string, anyStringTypeKey: string) {
  if (typeof key !== "string" || !key || typeof anyStringTypeKey !== "string" || !anyStringTypeKey)
    fail("invalid declaration key/string dependency");
  const symbolKey = `${key}:symbol`,
    arrayKey = `${key}:intern-array`;
  return freeze({
    key,
    anyStringTypeKey,
    declarations: [
      {
        key: symbolKey,
        role: "symbol-type",
        space: "type",
        shape: createSymbolCarrierShape({ kind: "ref_null" as const, typeKey: anyStringTypeKey }),
      },
      {
        key: arrayKey,
        role: "intern-array",
        space: "type",
        shape: {
          kind: "array",
          name: { kind: "symbol-index", prefix: "__arr_symref_", typeKey: symbolKey },
          element: { kind: "ref_null", typeKey: symbolKey },
          mutable: true,
        },
      },
      {
        key: `${key}:intern-table`,
        role: "intern-table",
        space: "global",
        name: "__symbol_intern_table",
        type: { kind: "ref_null", typeKey: arrayKey },
        mutable: true,
      },
      {
        key: `${key}:box`,
        role: "box",
        space: "function",
        name: "__box_symbol",
        signature: { params: [{ kind: "i32" }], results: [{ kind: "externref" }] },
      },
    ] as const,
  });
}
export type NativeSymbolCarrierPlan = ReturnType<typeof declareNativeSymbolCarrierResources>;
export interface NativeSymbolCarrierReservations {
  readonly types: { readonly symbol: TypeReservation; readonly internArray: TypeReservation };
  readonly globals: { readonly internTable: GlobalReservation };
  readonly functions: { readonly box: FunctionReservation };
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly strings: NativeStringLiteralReservations;
  readonly plan: NativeSymbolCarrierPlan;
  readonly inventory: {
    readonly plan: NativeSymbolCarrierPlan;
    readonly strings: NativeStringLiteralReservations;
    readonly resources: readonly {
      readonly declaration: NativeSymbolCarrierPlan["declarations"][number];
      readonly reservation: TypeReservation | GlobalReservation | FunctionReservation;
    }[];
  };
  filled: boolean;
}
const owners = new WeakMap<NativeSymbolCarrierReservations, Owner>();

/** Authenticate all real prerequisites before the first dependent allocation. */
export function reserveNativeSymbolCarrierResources(
  tx: PhysicalModuleReservations,
  key: string,
  strings: NativeStringLiteralReservations,
): NativeSymbolCarrierReservations {
  if (tx.state !== "reserving" || typeof key !== "string" || !key) fail("invalid reservation phase/key");
  const { typePack } = nativeStringLiteralReservationInventory(tx, strings);
  const plan = declareNativeSymbolCarrierResources(key, nativeStringTypeKeys(typePack.key).any);
  tx.assertReservationKeysAvailable(plan.declarations.map((row) => row.key));
  const [symbolRow, arrayRow, globalRow, boxRow] = plan.declarations;
  const symbol = tx.reserveType(symbolRow.key, createSymbolCarrierType(strings.layout.anyStrTypeIdx));
  const internArray = tx.reserveType(arrayRow.key, createSymbolInternArrayType(symbol.typeIndex));
  const internTable = tx.reserveGlobal(
    globalRow.key,
    globalRow.name,
    { kind: "ref_null", typeIdx: internArray.typeIndex },
    globalRow.mutable,
  );
  // Match the donor's explicit intern before reserving the defined function.
  tx.internFunctionType(boxRow.signature.params, boxRow.signature.results);
  const box = tx.reserveFunction(boxRow.key, boxRow.name, boxRow.signature);
  const pack = Object.freeze({
    types: Object.freeze({ symbol, internArray }),
    globals: Object.freeze({ internTable }),
    functions: Object.freeze({ box }),
  });
  const inventory = Object.freeze({
    plan,
    strings,
    resources: Object.freeze(
      [symbol, internArray, internTable, box].map((reservation, i) =>
        Object.freeze({ declaration: plan.declarations[i]!, reservation }),
      ),
    ),
  });
  owners.set(pack, { tx, strings, plan, inventory, filled: false });
  return pack;
}

function authenticate(tx: PhysicalModuleReservations, pack: NativeSymbolCarrierReservations) {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied resource owner");
  nativeStringLiteralReservationInventory(tx, owner.strings);
  if (tx.state === "reserving") {
    tx.assertTypeReservation(pack.types.symbol);
    tx.assertTypeReservation(pack.types.internArray);
  } else {
    for (const row of owner.inventory.resources) tx.physicalIndex(row.reservation);
  }
  return owner;
}

/** Complete current four-resource census, preserving exact owner and plan identity. */
export function nativeSymbolCarrierReservationInventory(
  tx: PhysicalModuleReservations,
  pack: NativeSymbolCarrierReservations,
) {
  return authenticate(tx, pack).inventory;
}
export function requireNativeSymbolCarrierReservations(
  tx: PhysicalModuleReservations,
  pack: NativeSymbolCarrierReservations,
  expectedStrings: NativeStringLiteralReservations,
): NativeSymbolCarrierReservations {
  const owner = authenticate(tx, pack);
  if (owner.strings !== expectedStrings) fail("substituted string dependency");
  return pack;
}
export function fillNativeSymbolCarrierResources(
  tx: PhysicalModuleReservations,
  pack: NativeSymbolCarrierReservations,
): void {
  const owner = authenticate(tx, pack);
  if (owner.filled) fail("duplicate fill");
  if (tx.state !== "filling") fail("fill requires frozen reservations");
  requireCompletedNativeStringLiterals(tx, owner.strings);
  const internArrTypeIdx = tx.physicalIndex(pack.types.internArray);
  const definition = buildSymbolBoxDefinition({
    symIdx: tx.physicalIndex(pack.types.symbol),
    anyStrTypeIdx: owner.strings.layout.anyStrTypeIdx,
    internArrTypeIdx,
    internGlobalIdx: tx.physicalIndex(pack.globals.internTable),
  });
  tx.fillGlobal(pack.globals.internTable, [{ op: "ref.null", typeIdx: internArrTypeIdx }]);
  tx.fillFunction(pack.functions.box, definition);
  owner.filled = true;
}
export function requireCompletedNativeSymbolCarrier(
  tx: PhysicalModuleReservations,
  pack: NativeSymbolCarrierReservations,
  expectedStrings: NativeStringLiteralReservations,
): NativeSymbolCarrierReservations {
  requireNativeSymbolCarrierReservations(tx, pack, expectedStrings);
  const owner = owners.get(pack)!;
  if (!owner.filled) fail("missing canonical fill");
  requireCompletedNativeStringLiterals(tx, owner.strings);
  tx.assertCompletedReservation(pack.globals.internTable);
  tx.assertCompletedReservation(pack.functions.box);
  return pack;
}
