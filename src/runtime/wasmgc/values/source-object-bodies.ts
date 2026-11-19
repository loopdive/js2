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
 * `js.object.get(object, key, receiver)`: the kernel's [[Get]], whose absent answer already is `undefined`. Its
 * "incomplete parent" state is a miss at the realm's Object.prototype, which does not hold the specification's
 * properties yet: (#7354 O4) every caller refuses the keys Object.prototype defines (`builtin-prototype-keys.ts`), so
 * a miss there is a true miss and answers `undefined` too. Its "not an object" state (3), and any status outside the
 * kernel's four, traps: every object a source program reaches was built by `create-default` on this realm's
 * Object.prototype.
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

/**
 * (#7354 O2b) `js.object.has(object, key)`: the kernel's HasProperty, read as found (status 1). A miss at the realm's
 * Object.prototype (2) is absent, as in the get adapter: its one caller, OrdinaryToPrimitive, takes an absent
 * conversion method for the realm Object.prototype's own. Status 3 traps, as in the get adapter.
 */
export function buildSourceObjectHasDefinition(d: { readonly has: FuncHandle }): SourceObjectDefinition {
  return {
    locals: [{ name: "status", type: { kind: "i32" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.has },
      { op: "local.tee", index: 2 },
      { op: "i32.const", value: 2 },
      { op: "i32.gt_u" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
    ],
  };
}

/**
 * (#7354 O2b, interim) `js.object.uncatchable-type-error()`: fail loudly where a TypeError would reach a source catch
 * that cannot read it yet (`ordinary-object-callables.ts` says why this is a call and not an intrinsic).
 */
export function buildSourceObjectUncatchableTypeErrorDefinition(): SourceObjectDefinition {
  return { locals: [], body: [{ op: "unreachable" }] };
}
