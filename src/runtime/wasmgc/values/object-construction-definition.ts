// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { buildOrdinaryObjectCreateDefinition } from "./ordinary-object-storage-definitions.js";

/** Internal allocation only: caller owns prototype admission and completed realm selection.
 * Own storage has an explicit-null prefix; mixed prototype operations read ObjectState.
 * No default intrinsic is selected, and a missing realm allocation traps.
 */
export function buildRealmObjectConstructionAllocation(bindings: {
  readonly objectTypeIdx: number;
  readonly propMapTypeIdx: number;
  readonly ordinaryTypeIdx: number;
  readonly stateTypeIdx: number;
  readonly realmGlobalIdx: number;
}): { locals: LocalDef[]; body: Instr[] } {
  const own = buildOrdinaryObjectCreateDefinition({ ...bindings, initialCapacity: 8 }, "null");
  const allocation = own.body.at(-2);
  if (
    allocation?.op !== "struct.new" ||
    allocation.typeIdx !== bindings.objectTypeIdx ||
    own.body.at(-1)?.op !== "extern.convert_any"
  )
    throw Error("realm object allocation: canonical own-storage suffix changed");
  // Reuse the complete canonical six-field prefix, replacing only its allocation.
  return {
    locals: [],
    body: [
      ...own.body.slice(0, -2),
      { op: "local.get", index: 0 },
      { op: "global.get", index: bindings.realmGlobalIdx },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: bindings.stateTypeIdx },
      { op: "struct.new", typeIdx: bindings.ordinaryTypeIdx },
      { op: "extern.convert_any" },
    ],
  };
}

/** Compose existing ordinary Create/DefineData operations; this is not a second property engine. */
export function buildNativeObjectConstructionDefinition(bindings: {
  readonly create: FuncHandle;
  readonly defineData: FuncHandle;
  readonly parameterCount: number;
  readonly fields: readonly {
    readonly argument: number;
    readonly key: readonly Instr[];
    readonly conversion: readonly Instr[];
  }[];
}): { locals: LocalDef[]; body: Instr[] } {
  const result = bindings.parameterCount;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: bindings.create },
    { op: "local.set", index: result },
  ];
  const descriptorMask =
    flags.writable |
    flags.enumerable |
    flags.configurable |
    flags.writableSpecified |
    flags.enumerableSpecified |
    flags.configurableSpecified |
    flags.hasValue;
  for (const field of bindings.fields) {
    body.push(
      { op: "local.get", index: result },
      ...field.key,
      {
        op: "local.get",
        index: field.argument,
      },
      ...field.conversion,
    );
    body.push({ op: "f64.const", value: descriptorMask }, { op: "call", funcIdx: bindings.defineData });
  }
  body.push({ op: "local.get", index: result });
  return { locals: [{ name: "$constructed", type: { kind: "externref" } }], body };
}
