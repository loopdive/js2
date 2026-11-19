// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) Bodies of the public source-object functions: each puts one `js.object.*` contract's signature in front
 * of the realm kernel's own algorithm, so no object algorithm is written twice.
 */
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import { markIdentityOnly } from "./builtin-function-bodies.js";

export interface SourceObjectDefinition {
  readonly locals: LocalDef[];
  readonly body: Instr[];
}

/**
 * `js.object.create-default`: OrdinaryObjectCreate(%Object.prototype%) with an explicit link to the realm's
 * Object.prototype, so a lookup never meets the storage's implicit-prototype state.
 */
export function buildSourceObjectCreateDefinition(d: {
  readonly objectTypeIdx: TypeHandle;
  readonly objectPrototype: FuncHandle;
  readonly createWithPrototype: FuncHandle;
}): SourceObjectDefinition {
  return {
    locals: [],
    body: [
      { op: "call", funcIdx: d.objectPrototype },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.objectTypeIdx },
      { op: "call", funcIdx: d.createWithPrototype },
    ],
  };
}

/**
 * `js.object.get(object, key, receiver)`: the kernel's [[Get]], whose absent answer already is `undefined`. Its
 * "incomplete parent" state is a miss at the realm's Object.prototype, which does not hold the specification's
 * properties yet: (#7354 O4) every caller refuses the keys Object.prototype defines (`builtin-prototype-keys.ts`), so
 * a miss there is a true miss and answers `undefined` too. Its "not an object" state (3), and any status outside the
 * kernel's four, traps: every object a source program reaches was built by `create-default` on this realm's
 * Object.prototype, or is (#7350 B2b) the realm's global object or a built-in read off it. A miss among a built-in's
 * own properties (4) is unknown, the realm models its identity only: it traps too, never `undefined`, never a JS error.
 */
export function buildSourceObjectGetDefinition(d: { readonly get: FuncHandle }): SourceObjectDefinition {
  return {
    locals: [{ name: "value", type: { kind: "externref" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: d.get },
      { op: "local.set", index: 3 },
      { op: "i32.const", value: 2 },
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 3 },
    ],
  };
}

/** (#7350 B2b) One own data property of the global object: its key, its value's producer and its descriptor word. */
export interface SourceObjectGlobalProperty {
  readonly key: readonly Instr[];
  /** A kernel function object (its singleton getter), or a fresh identity-only namespace object. */
  readonly value: { readonly kind: "intrinsic"; readonly getter: FuncHandle } | { readonly kind: "namespace" };
  readonly descriptor: number;
}

/**
 * (#7350 B2b) `js.object.global`: the realm's global object, an ordinary object on the realm's Object.prototype whose
 * own properties are the globals the program reads. It is built on the first call and kept in the realm global
 * `cache`, so every read answers the same object.
 */
export function buildSourceObjectGlobalDefinition(d: {
  readonly cache: number;
  readonly objectTypeIdx: TypeHandle;
  readonly objectPrototype: FuncHandle;
  readonly createWithPrototype: FuncHandle;
  readonly defineData: FuncHandle;
  readonly properties: readonly SourceObjectGlobalProperty[];
}): SourceObjectDefinition {
  const create: Instr[] = [
    { op: "call", funcIdx: d.objectPrototype },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.objectTypeIdx },
    { op: "call", funcIdx: d.createWithPrototype },
  ];
  const value = (property: SourceObjectGlobalProperty): Instr[] =>
    property.value.kind === "intrinsic"
      ? [{ op: "call", funcIdx: property.value.getter }]
      : [
          ...create,
          { op: "local.set", index: 1 },
          ...markIdentityOnly(d.objectTypeIdx, () => [{ op: "local.get", index: 1 }]),
          { op: "local.get", index: 1 },
        ];
  return {
    locals: [
      { name: "global", type: { kind: "externref" } },
      { name: "namespace", type: { kind: "externref" } },
    ],
    body: [
      { op: "global.get", index: d.cache },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...create,
          { op: "local.set", index: 0 },
          ...d.properties.flatMap((property): Instr[] => [
            { op: "local.get", index: 0 },
            ...structuredClone(property.key),
            ...value(property),
            { op: "f64.const", value: property.descriptor },
            { op: "call", funcIdx: d.defineData },
          ]),
          { op: "local.get", index: 0 },
          { op: "global.set", index: d.cache },
        ],
      },
      { op: "global.get", index: d.cache },
    ],
  };
}
