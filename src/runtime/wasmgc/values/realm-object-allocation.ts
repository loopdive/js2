// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import {
  buildOrdinaryObjectStoragePrefix,
  type OrdinaryObjectCreateResources,
} from "./ordinary-object-storage-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "./ordinary-object-descriptor-common.js";

/** Shared six-field storage prefix plus the actual state; leaves a GC reference. */
export function buildRealmOrdinaryObjectAllocationBody(
  storage: OrdinaryObjectCreateResources,
  ordinaryType: TypeHandle,
  state: readonly Instr[],
  flags?: readonly Instr[],
): Instr[] {
  return [
    ...buildOrdinaryObjectStoragePrefix(storage, undefined, flags),
    ...state,
    { op: "struct.new", typeIdx: ordinaryType },
  ];
}

/** Internal OrdinaryObjectCreate: the caller admits the evaluated Object-or-null parent.
 * Only ObjectState owns the logical prototype; the prefix is own-property storage.
 */
export function buildRealmOrdinaryObjectAllocation(
  storage: OrdinaryObjectCreateResources,
  ordinaryType: TypeHandle,
  initializeState: FuncHandle,
): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [],
    body: [
      ...buildRealmOrdinaryObjectAllocationBody(
        storage,
        ordinaryType,
        [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: initializeState },
        ],
        [{ op: "i32.const", value: ORDINARY_OBJECT_DESCRIPTOR_ENCODING.nullPrototype }],
      ),
      { op: "extern.convert_any" },
    ],
  };
}
