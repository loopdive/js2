// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 C, F1b) The body of `js.object.init-function`. A source function object is its closure struct, which the
 * builtin-object kernel's `match` recognises (one ordinal after the builtin entries); its own properties live in an
 * ordinary object in the closure's `$bag`, which this body creates, so the kernel's [[Get]] / [[Set]] answer for a
 * source function as for a builtin one.
 */
import type { Instr } from "../../../wasm/model/instructions.js";
import { CLOSURE_BAG_FIELD_IDX } from "./closure-layouts.js";
import { buildFunctionLengthNameSeed } from "./builtin-function-bodies.js";
import type { BuiltinFunctionPrototypeOperands } from "./builtin-function-prototype-bodies.js";
import {
  sourceObjectCreate,
  type SourceObjectCreateOperands,
  type SourceObjectDefinition,
} from "./source-object-bodies.js";

const get = (index: number): Instr => ({ op: "local.get", index });
/** Descriptor words: `constructor` writable and configurable (0xbd); `prototype` writable only (0xb9). */
const CONSTRUCTOR_DESCRIPTOR = 0xbd;
const PROTOTYPE_DESCRIPTOR = 0xb9;

/**
 * `js.object.init-function(closure, name, length, constructor)`: the bag, an ordinary object with a null
 * [[Prototype]] (the closure's own [[Prototype]] is %Function.prototype%, which the kernel answers); then
 * OrdinaryFunctionCreate's `length` and SetFunctionName's `name` (the builtin seeding); then, for a constructor (a
 * function declaration or expression; not an arrow, method or accessor), MakeConstructor's `prototype`, a fresh
 * ordinary object whose `constructor` is the closure. Own keys are therefore in the specification's order.
 */
export function buildSourceFunctionInitDefinition(d: {
  readonly kernel: BuiltinFunctionPrototypeOperands;
  readonly create: SourceObjectCreateOperands;
  readonly prototypeKey: readonly Instr[];
  readonly constructorKey: readonly Instr[];
}): SourceObjectDefinition {
  const { kernel } = d;
  const [bag, prototype] = [4, 5];
  const define = (target: number, key: readonly Instr[], value: number, descriptor: number): Instr[] => [
    get(target),
    ...structuredClone(key),
    get(value),
    { op: "f64.const", value: descriptor },
    { op: "call", funcIdx: kernel.defineDataBody },
    { op: "drop" },
  ];
  return {
    locals: [
      { name: "bag", type: { kind: "externref" } },
      { name: "prototype", type: { kind: "externref" } },
    ],
    body: [
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: kernel.rootTypeIdx },
      { op: "call", funcIdx: kernel.createNull },
      { op: "local.tee", index: bag },
      { op: "struct.set", typeIdx: kernel.rootTypeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX },
      ...buildFunctionLengthNameSeed(kernel, () => [get(bag)], kernel.defineDataBody, [get(2)], [get(1)]),
      get(3),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...sourceObjectCreate(d.create),
          { op: "local.set", index: prototype },
          ...define(prototype, d.constructorKey, 0, CONSTRUCTOR_DESCRIPTOR),
          ...define(bag, d.prototypeKey, prototype, PROTOTYPE_DESCRIPTOR),
        ],
      },
    ],
  };
}
