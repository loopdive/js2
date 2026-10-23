// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import {
  buildOrdinaryObjectStoragePrefix,
  type OrdinaryObjectCreateResources,
} from "./ordinary-object-storage-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING } from "./ordinary-object-descriptor-common.js";

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
      ...buildOrdinaryObjectStoragePrefix(storage, undefined, [
        { op: "i32.const", value: ORDINARY_OBJECT_DESCRIPTOR_ENCODING.nullPrototype },
      ]),
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: initializeState },
      { op: "struct.new", typeIdx: ordinaryType },
      { op: "extern.convert_any" },
    ],
  };
}
