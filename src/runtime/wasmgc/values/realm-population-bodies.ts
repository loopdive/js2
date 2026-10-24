// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, FuncHandle } from "../../../wasm/model/instructions.js";
import type { NativeRealmIntrinsic, NativeRealmProperty } from "../../contracts/native-realm-catalog.js";
import {
  buildBuiltinFunctionAllocation,
  type BuiltinFunctionEntryOperands,
  type BuiltinFunctionDefinition,
} from "./builtin-function-bodies.js";
import { buildOrdinaryObjectCreateDefinition } from "./ordinary-object-storage-definitions.js";
import { buildPrototypeSeedDataTail } from "./prototype-seeder-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { CLOSURE_BAG_FIELD_IDX } from "./closure-layouts.js";

export interface RealmPopulationEntry extends Pick<
  BuiltinFunctionEntryOperands,
  "lifted" | "userFormalCount" | "metadataId" | "initialName" | "typeIdx" | "singleton" | "singletonExtern"
> {
  readonly intrinsic: NativeRealmIntrinsic;
}
export interface RealmPopulationOperands {
  readonly entries: readonly RealmPopulationEntry[];
  readonly objectPrototype: number;
  readonly objectPrototypeType: number;
  readonly objectIntrinsic: NativeRealmIntrinsic;
  readonly objectType: number;
  readonly propMapType: number;
  readonly realm: number;
  readonly realmType: number;
  readonly state: number;
  readonly createNull: FuncHandle;
  readonly boxNumber: FuncHandle;
  readonly defineData: FuncHandle;
  readonly defineAccessor: FuncHandle;
  readonly hasInstance: FuncHandle;
  readonly failure: readonly Instr[];
  readonly literal: (text: string, external?: boolean) => Instr[];
}
const global = (index: number): Instr => ({ op: "global.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
function value(d: RealmPopulationOperands, id: string): Instr[] {
  if (id === d.objectIntrinsic.id) return [global(d.objectPrototype), { op: "extern.convert_any" }];
  const entry = d.entries.find((entry) => entry.intrinsic.id === id);
  if (!entry) throw Error("realm population: missing intrinsic " + id);
  return [global(entry.singleton), ...(entry.singletonExtern ? [] : [{ op: "extern.convert_any" } as Instr])];
}
function bag(d: RealmPopulationOperands, entry?: RealmPopulationEntry): Instr[] {
  return entry
    ? [
        ...value(d, entry.intrinsic.id),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: entry.typeIdx },
        { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX },
      ]
    : value(d, d.objectIntrinsic.id);
}
function install(d: RealmPopulationOperands, property: NativeRealmProperty, entry?: RealmPopulationEntry): Instr[] {
  const prefix: Instr[] = [
    ...bag(d, entry),
    ...(property.key.kind === "string"
      ? d.literal(property.key.value)
      : [{ op: "call", funcIdx: d.hasInstance } as Instr]),
  ];
  const attributes =
    flags.enumerableSpecified |
    flags.configurableSpecified |
    (property.enumerable ? flags.enumerable : 0) |
    (property.configurable ? flags.configurable : 0);
  if (property.kind === "accessor")
    return [
      ...prefix,
      ...value(d, property.get),
      ...value(d, property.set),
      ...buildPrototypeSeedDataTail(d.defineAccessor, attributes | flags.getterSpecified | flags.setterSpecified),
    ];
  const v = property.value;
  return [
    ...prefix,
    ...(v.kind === "intrinsic"
      ? value(d, v.id)
      : v.kind === "string"
        ? d.literal(v.value)
        : ([
            { op: "f64.const", value: v.value },
            { op: "call", funcIdx: d.boxNumber },
          ] as Instr[])),
    ...buildPrototypeSeedDataTail(
      d.defineData,
      attributes | flags.writableSpecified | flags.hasValue | (property.writable ? flags.writable : 0),
    ),
  ];
}
function populate(d: RealmPopulationOperands): Instr[] {
  // The shared object prefix keeps its ordinary parent type; allocation uses the real dedicated subtype.
  const object = buildOrdinaryObjectCreateDefinition(
    {
      objectTypeIdx: d.objectType,
      propMapTypeIdx: d.propMapType,
      initialCapacity: 8,
    },
    "null",
    d.objectPrototypeType,
  );
  const allocate: Instr[] = [
    { op: "struct.new", typeIdx: d.realmType },
    { op: "global.set", index: d.realm },
    ...object.body,
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.objectPrototypeType },
    { op: "global.set", index: d.objectPrototype },
  ];
  for (const entry of d.entries)
    allocate.push(
      ...buildBuiltinFunctionAllocation(entry, {
        createNull: d.createNull,
        realm: d.realm,
        prototype:
          entry.intrinsic.prototype === null ? [{ op: "ref.null.extern" }] : value(d, entry.intrinsic.prototype),
      }),
    );
  const seed = d.objectIntrinsic.properties.flatMap((property) => install(d, property));
  for (const entry of d.entries) {
    seed.push(...entry.intrinsic.properties.flatMap((property) => install(d, property, entry)));
    if (!entry.intrinsic.extensible)
      seed.push(
        ...bag(d, entry),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: d.objectType },
        n(flags.nullPrototype | flags.nonExtensible),
        { op: "struct.set", typeIdx: d.objectType, fieldIdx: 4 },
      );
  }
  return [...allocate, ...seed];
}
/** State 2 certifies installed identities/descriptors only; algorithm admission is a separate owner. */
export function buildRealmPopulationInitializer(d: RealmPopulationOperands): BuiltinFunctionDefinition {
  return {
    locals: [],
    body: [
      global(d.state),
      n(2),
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      global(d.state),
      { op: "if", blockType: { kind: "empty" }, then: [...structuredClone(d.failure)] },
      n(1),
      { op: "global.set", index: d.state },
      {
        op: "try",
        blockType: { kind: "empty" },
        body: [...populate(d), n(2), { op: "global.set", index: d.state }],
        catches: [],
        catchAll: [n(-1), { op: "global.set", index: d.state }, { op: "rethrow", depth: 0 }],
      },
    ],
  };
}
