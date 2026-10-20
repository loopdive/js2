// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, FuncHandle, TypeHandle } from "../../../wasm/model/instructions.js";
import { NATIVE_REALM_CATALOG, type NativeRealmPropertyValue } from "../../contracts/native-realm-catalog.js";
import { WELL_KNOWN_SYMBOL_IDS } from "../../contracts/well-known-symbols.js";
import { CLOSURE_BAG_FIELD_IDX } from "./closure-layouts.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import { buildOrdinaryObjectCreateDefinition } from "./ordinary-object-storage-definitions.js";

/** Resolved operands only, never a resource-owner or whole-realm completion capability. */
export interface RealmPopulationOperands {
  readonly identityType: TypeHandle;
  readonly objectPrototypeType: TypeHandle;
  readonly objectType: TypeHandle;
  readonly propMapType: TypeHandle;
  readonly realmGlobal: number;
  readonly objectPrototypeGlobal: number;
  readonly stateGlobal: number;
  readonly functions: readonly {
    readonly id: string;
    readonly type: TypeHandle;
    readonly lifted: FuncHandle;
    readonly metadataId: number;
    readonly singleton: number;
  }[];
  readonly createNull: FuncHandle;
  readonly defineData: FuncHandle;
  readonly defineAccessor: FuncHandle;
  readonly boxNumber: FuncHandle;
  readonly boxSymbol: FuncHandle;
  /** Fresh native string reference, not its external representation. */
  readonly literal: (value: string) => Instr[];
  /** A native TypeError followed by the actual exception throw. */
  readonly failure: readonly Instr[];
}
const get = (index: number): Instr => ({ op: "local.get", index });
const number = (value: number): Instr => ({ op: "i32.const", value });
const global = (index: number): Instr => ({ op: "global.get", index });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const nonNull = (): Instr => ({ op: "ref.as_non_null" });
const external = (): Instr => ({ op: "extern.convert_any" });

/** Full retained Object/Function catalog. No algorithm bodies or public readiness are invented. */
export function buildRealmPopulationDefinition(d: RealmPopulationOperands): { locals: LocalDef[]; body: Instr[] } {
  const catalog = NATIVE_REALM_CATALOG.intrinsics;
  const callables = catalog.filter((row) => row.callable);
  if (d.functions.length !== callables.length || callables.some((row, i) => row.id !== d.functions[i]?.id))
    throw Error("realm population: exact complete callable catalog operands required");
  const slots = new Map([["%Object.prototype%", 1], ...d.functions.map((row, i) => [row.id, i + 2] as const)]);
  const local = (id: string) => {
    const index = slots.get(id);
    if (index === undefined) throw Error("realm population: absent intrinsic " + id);
    return index;
  };
  const ref = (id: string): Instr[] => [get(local(id)), nonNull()];
  const externalRef = (id: string): Instr[] => [...ref(id), external()];
  const state = (value: number): Instr[] => [number(value), { op: "global.set", index: d.stateGlobal }];
  const fail = (): Instr[] => [...state(-1), ...structuredClone(d.failure)];
  const literal = (value: string): Instr[] => structuredClone(d.literal(value));
  const value = (v: NativeRealmPropertyValue): Instr[] => {
    switch (v.kind) {
      case "intrinsic":
        return externalRef(v.id);
      case "string":
        return [...literal(v.value), external()];
      case "number":
        return [{ op: "f64.const", value: v.value }, call(d.boxNumber)];
    }
  };
  const ownBag = (id: string): Instr[] => {
    if (id === "%Object.prototype%") return ref(id);
    const row = d.functions[local(id) - 2]!;
    return [
      ...ref(id),
      { op: "struct.get", typeIdx: row.type, fieldIdx: CLOSURE_BAG_FIELD_IDX },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.objectType },
    ];
  };
  const allocate: Instr[] = [
    { op: "struct.new", typeIdx: d.identityType },
    { op: "local.set", index: 0 },
    ...buildOrdinaryObjectCreateDefinition(
      { objectTypeIdx: d.objectPrototypeType, propMapTypeIdx: d.propMapType, initialCapacity: 8 },
      "null",
    ).body,
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.objectPrototypeType },
    { op: "local.set", index: 1 },
  ];
  d.functions.forEach((row, i) => {
    const intrinsic = callables[i]!;
    allocate.push(
      { op: "ref.func", funcIdx: row.lifted },
      number(intrinsic.callable!.length),
      call(d.createNull),
      number(0),
      number(row.metadataId),
      ...externalRef(intrinsic.prototype!),
      get(0),
      nonNull(),
      ...literal(intrinsic.callable!.initialName),
      { op: "struct.new", typeIdx: row.type },
      { op: "local.set", index: i + 2 },
    );
  });
  const populate: Instr[] = [];
  for (const row of catalog) {
    for (const property of row.properties) {
      populate.push(...ownBag(row.id), external());
      populate.push(
        ...(property.key.kind === "string"
          ? [...literal(property.key.value), external()]
          : [number(WELL_KNOWN_SYMBOL_IDS.hasInstance), call(d.boxSymbol)]),
      );
      const common =
        flags.enumerableSpecified |
        flags.configurableSpecified |
        (property.enumerable ? flags.enumerable : 0) |
        (property.configurable ? flags.configurable : 0);
      if (property.kind === "data")
        populate.push(
          ...value(property.value),
          {
            op: "f64.const",
            value: common | flags.hasValue | flags.writableSpecified | (property.writable ? flags.writable : 0),
          },
          call(d.defineData),
        );
      else
        populate.push(
          ...externalRef(property.get),
          ...externalRef(property.set),
          { op: "f64.const", value: common | flags.getterSpecified | flags.setterSpecified },
          call(d.defineAccessor),
        );
    }
    if (!row.extensible)
      populate.push(
        ...ownBag(row.id),
        ...ownBag(row.id),
        { op: "struct.get", typeIdx: d.objectType, fieldIdx: 4 },
        number(flags.nonExtensible),
        { op: "i32.or" },
        { op: "struct.set", typeIdx: d.objectType, fieldIdx: 4 },
      );
  }
  // No calls/allocations after this guard: publication cannot expose a partial graph.
  const publish: Instr[] = [
    global(d.stateGlobal),
    number(1),
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "empty" }, then: fail() },
    get(0),
    nonNull(),
    { op: "global.set", index: d.realmGlobal },
    ...ref("%Object.prototype%"),
    { op: "global.set", index: d.objectPrototypeGlobal },
  ];
  d.functions.forEach((row) =>
    publish.push(...ref(row.id), ...(row.id === "%Function.prototype%" ? [external()] : []), {
      op: "global.set",
      index: row.singleton,
    }),
  );
  publish.push(...state(2));
  return {
    locals: [
      { name: "realm", type: { kind: "ref_null", typeIdx: d.identityType } },
      { name: "Object.prototype", type: { kind: "ref_null", typeIdx: d.objectPrototypeType } },
      ...d.functions.map((row): LocalDef => ({ name: row.id, type: { kind: "ref_null", typeIdx: row.type } })),
    ],
    body: [
      global(d.stateGlobal),
      number(2),
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      global(d.stateGlobal),
      { op: "if", blockType: { kind: "empty" }, then: fail() },
      ...state(1),
      {
        op: "try",
        blockType: { kind: "empty" },
        body: [...allocate, ...populate, ...publish],
        catches: [],
        catchAll: [...state(-1), { op: "rethrow", depth: 0 }],
      },
    ],
  };
}
