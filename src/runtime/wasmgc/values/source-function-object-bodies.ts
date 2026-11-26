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
/** The realm `$Object`'s flags field (`ordinaryParent` reads its null-prototype bit 0x80 there). */
const OBJECT_FLAGS_FIELD = 4;
/** (#7354 O2) A bit of a function's bag's flags, free on the realm `$Object`: the function has no [[Construct]]. */
const NOT_CONSTRUCTOR = 0x40;
/** The flags word of the bag `bag` leaves (an externref). */
function bagFlags(kernel: BuiltinFunctionPrototypeOperands, bag: readonly Instr[]): Instr[] {
  return [
    ...bag,
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: kernel.objectTypeIdx },
    { op: "struct.get", typeIdx: kernel.objectTypeIdx, fieldIdx: OBJECT_FLAGS_FIELD },
  ];
}

/**
 * `js.object.init-function(closure, name, length, constructor)`: the bag, an ordinary object with a null
 * [[Prototype]] (the closure's own [[Prototype]] is %Function.prototype%, which the kernel answers); then
 * OrdinaryFunctionCreate's `length` and SetFunctionName's `name` (the builtin seeding); then, for a constructor (a
 * function declaration or expression; not an arrow, method or accessor), MakeConstructor's `prototype`, a fresh
 * ordinary object whose `constructor` is the closure. Own keys are therefore in the specification's order. (#7354 O2)
 * Where the program asks IsConstructor (`marksNonConstructors`), a function without [[Construct]] gets the bag's
 * {@link NOT_CONSTRUCTOR} bit; elsewhere no `new` asks, and the body is unchanged.
 */
export function buildSourceFunctionInitDefinition(d: {
  readonly kernel: BuiltinFunctionPrototypeOperands;
  readonly create: SourceObjectCreateOperands;
  readonly prototypeKey: readonly Instr[];
  readonly constructorKey: readonly Instr[];
  readonly marksNonConstructors: boolean;
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
        ...(d.marksNonConstructors
          ? {
              else: [
                get(bag),
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: kernel.objectTypeIdx },
                ...bagFlags(kernel, [get(bag)]),
                { op: "i32.const", value: NOT_CONSTRUCTOR },
                { op: "i32.or" },
                { op: "struct.set", typeIdx: kernel.objectTypeIdx, fieldIdx: OBJECT_FLAGS_FIELD },
              ] satisfies Instr[],
            }
          : {}),
      },
    ],
  };
}

/** (#7354 O2) `js.object.is-constructor(function) -> i32`: IsConstructor of a function object, its bag's bit. */
export function buildSourceFunctionIsConstructorDefinition(
  kernel: BuiltinFunctionPrototypeOperands,
): SourceObjectDefinition {
  return {
    locals: [],
    body: [
      ...bagFlags(kernel, [get(0), { op: "call", funcIdx: kernel.bag }]),
      { op: "i32.const", value: NOT_CONSTRUCTOR },
      { op: "i32.and" },
      { op: "i32.eqz" },
    ],
  };
}
