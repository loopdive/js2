// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) Bodies of the public source-object functions: each puts one `js.object.*` contract's signature in front
 * of the realm kernel's own algorithm, so no object algorithm is written twice.
 */
import type { FuncHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";

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
 * The kernel's [[Get]] of the (object, key, receiver) on the stack, whose absent answer already is `undefined`;
 * `value` is an externref scratch local. A status above `answered` traps. The kernel's incomplete states are 2, a
 * lookup that ended at a parent outside the realm or at the realm's Object.prototype (which holds only part of its
 * standard properties, so a miss there is not proven absence), and 3, a carrier that is not an object; every object
 * a source program reaches was built by a `create-*` contract on this realm's prototypes, so 3 cannot occur.
 */
export function sourceObjectGet(get: FuncHandle, value: number, answered: 1 | 2 = 1): Instr[] {
  return [
    { op: "call", funcIdx: get },
    { op: "local.set", index: value },
    { op: "i32.const", value: answered + 1 },
    { op: "i32.ge_u" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
    { op: "local.get", index: value },
  ];
}

/** `js.object.get(object, key, receiver)`: the kernel's [[Get]]. */
export function buildSourceObjectGetDefinition(d: { readonly get: FuncHandle }): SourceObjectDefinition {
  return {
    locals: [{ name: "value", type: { kind: "externref" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      ...sourceObjectGet(d.get, 3),
    ],
  };
}
