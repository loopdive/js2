// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 Fa) The native setup a function value needs on standalone WasmGC: the realm bootstrap (function objects,
 * their property storage, the invocation substrate), the source-closure types and the closure invocation
 * population. The consumer reads the tokens from the owners' own inventories while it reserves them and records
 * their slots once every owner's `requireCompleted…` check has passed; the presentation's census then joins the
 * module's support receipts and reference slots to exactly this population (`prepared-provider-census.ts`).
 */
import type { nativeRealmReservationInventory } from "./native-realm.js";
import { nativeClosureReservationInventory } from "../resources/native-closures.js";
import { nativeInvocationFunctions, type NativeInvocationReservations } from "../resources/native-invocation.js";
import type { NativeSourceClosureTypes } from "../resources/native-source-closures.js";
import type {
  GlobalReservation,
  PhysicalModuleReservations,
  TypeReservation,
} from "../../../wasm/physical/module-reservations.js";

/** The setup's completed slots: its support functions' receipts and its reference type and global slots. */
export interface FunctionValueSetupSlots {
  readonly functions: readonly { readonly key: string; readonly index: number }[];
  readonly types: ReadonlySet<number>;
  readonly globals: ReadonlySet<number>;
}

export function functionValueSetupSlots(
  tx: PhysicalModuleReservations,
  realm: ReturnType<typeof nativeRealmReservationInventory>,
  sourceClosureTypes: NativeSourceClosureTypes | undefined,
  invocation: NativeInvocationReservations | undefined,
): FunctionValueSetupSlots {
  const closureTypes = sourceClosureTypes
    ? [
        ...sourceClosureTypes.shapes.map((shape) => shape.type),
        ...nativeClosureReservationInventory(tx, sourceClosureTypes.closures, sourceClosureTypes.closurePlan).filter(
          (row): row is TypeReservation => row.kind === "type",
        ),
      ]
    : [];
  const functions = [...realm.functions, ...(invocation ? nativeInvocationFunctions(tx, invocation) : [])];
  const globals: readonly GlobalReservation[] = [
    ...realm.globals,
    ...(invocation ? Object.values(invocation.globals) : []),
  ];
  return Object.freeze({
    functions: Object.freeze(
      functions.map((token) => Object.freeze({ key: token.key, index: tx.physicalIndex(token) })),
    ),
    types: new Set([...realm.types, ...closureTypes].map((token) => tx.physicalIndex(token))),
    globals: new Set(globals.map((token) => tx.physicalIndex(token))),
  });
}
