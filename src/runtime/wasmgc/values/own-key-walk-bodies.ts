// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7377) The realm's one walk over an object's own keys, and the for-in key snapshot built on it. ObjectDefineProperties
 * (`object-static-bodies.ts`) and EnumerateObjectProperties both read every own key with its enumerable attribute in
 * the kernel's [[OwnPropertyKeys]] order; neither re-derives the order or the attribute.
 */
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import { argumentVectorEach, argumentVectorElement, type ArgumentVectorTypes } from "./argument-vector-bodies.js";
import { ordinaryParent, type BuiltinFunctionPrototypeOperands } from "./builtin-function-prototype-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import type { SourceObjectDefinition } from "./source-object-bodies.js";

/** The kernel's own-key list and own-property read, and the vector its list is. */
export interface OwnKeyWalkOperands extends ArgumentVectorTypes {
  readonly ownKeys: FuncHandle;
  readonly ownDescriptor: FuncHandle;
}

/** The locals a walk writes: the key list, the position in it, the key, and the key's attribute word. */
export interface OwnKeyWalkLocals {
  readonly keys: number;
  readonly index: number;
  readonly key: number;
  readonly word: number;
}

/**
 * `body` for every own key of the object `object` leaves, in [[OwnPropertyKeys]] order (the kernel's `ownKeys`: array
 * indices ascending, then strings in insertion order, then Symbols), with the key in `key` and its attribute word in
 * `word` (`ownDescriptor`'s; 0 for a key `body` removed meanwhile, which is not enumerable). Symbols are walked too:
 * a caller that wants string keys skips the others.
 */
export function eachOwnKey(
  d: OwnKeyWalkOperands,
  object: readonly Instr[],
  locals: OwnKeyWalkLocals,
  body: readonly Instr[],
): Instr[] {
  const { keys, index, key, word } = locals;
  return [
    ...object,
    { op: "call", funcIdx: d.ownKeys },
    { op: "local.set", index: keys },
    ...argumentVectorEach(d, [{ op: "local.get", index: keys }], index, 1, [
      ...argumentVectorElement(d, [{ op: "local.get", index: keys }], [{ op: "local.get", index }]),
      { op: "local.set", index: key },
      ...object,
      { op: "local.get", index: key },
      { op: "call", funcIdx: d.ownDescriptor },
      { op: "drop" },
      { op: "drop" },
      { op: "drop" },
      { op: "local.set", index: word },
      { op: "drop" },
      ...body,
    ]),
  ];
}

/** What the for-in snapshot reads beyond the walk: the kernel's carriers, chain and SameValue, and the string type. */
export interface ForInKeysOperands extends BuiltinFunctionPrototypeOperands, OwnKeyWalkOperands {
  readonly anyStrTypeIdx: number;
}

/**
 * `js.object.for-in-keys(object) -> list`: EnumerateObjectProperties (§14.7.5.9) as a snapshot, the argument vector of
 * the string keys a for-in visits. `undefined` and `null` give the empty list (§14.7.5.6 step 6.b). An ordinary or a
 * function object of this realm (the carriers the kernel's `ownKeys` serves) is walked from itself along its
 * [[Prototype]] links to the end of the chain: each object's string keys in own-key order, a key already seen on the
 * way (enumerable or not) skipped, an enumerable one listed. Symbols are never listed. Keys added after the snapshot are
 * not visited, which the specification allows.
 *
 * Every other value aborts at run time (`unreachable`): a primitive needs ToObject and its wrapper's keys (a string's
 * indices), and an unknown carrier is no object the kernel can walk. So does a link that ends at an object whose
 * prototype the kernel has not settled (`ordinaryParent`'s gap) anywhere but at the realm's Object.prototype, whose
 * own properties are user additions only: the specification's are all non-enumerable, and nothing lies beyond it.
 */
export function buildForInKeysDefinition(d: ForInKeysOperands): SourceObjectDefinition {
  const [result, seen, cursor, next, keys, index, key, word, probe, hidden] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const get = (local: number): Instr => ({ op: "local.get", index: local });
  const set = (local: number): Instr => ({ op: "local.set", index: local });
  const push = (list: number): Instr[] => [get(list), get(key), { op: "call", funcIdx: d.push }];
  const isSeen: Instr[] = [
    { op: "i32.const", value: 0 },
    set(hidden),
    ...argumentVectorEach(d, [get(seen)], probe, 1, [
      ...argumentVectorElement(d, [get(seen)], [get(probe)]),
      get(key),
      { op: "call", funcIdx: d.sameValue },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, set(hidden)] },
    ]),
    get(hidden),
  ];
  // A string key not seen on the way: it hides any later one of its name, and is listed when enumerable.
  const visit: Instr[] = [
    get(key),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: d.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...isSeen,
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...push(seen),
            get(word),
            { op: "i32.const", value: flags.enumerable },
            { op: "i32.and" },
            { op: "if", blockType: { kind: "empty" }, then: push(result) },
          ],
        },
      ],
    },
  ];
  // A function's [[Prototype]] is the kernel's; an ordinary object's is its link.
  const link: Instr[] = [
    get(cursor),
    { op: "call", funcIdx: d.match },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [get(cursor), { op: "call", funcIdx: d.getPrototypeOf }, set(next)],
      else: ordinaryParent(d, cursor, next, [
        get(cursor),
        { op: "global.get", index: d.objectPrototype },
        { op: "call", funcIdx: d.sameValue },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      ]),
    },
  ];
  const empty: Instr[] = [get(result), { op: "return" }];
  return {
    locals: [
      ...["result", "seen", "cursor", "next", "keys"].map((name) => ({ name, type: { kind: "externref" } as const })),
      { name: "index", type: { kind: "i32" } },
      { name: "key", type: { kind: "externref" } },
      ...["word", "probe", "hidden"].map((name) => ({ name, type: { kind: "i32" } as const })),
    ],
    body: [
      { op: "call", funcIdx: d.initializer },
      { op: "call", funcIdx: d.newVector },
      set(result),
      get(0),
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: empty },
      get(0),
      { op: "global.get", index: d.undefinedGlobal },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: d.sameValue },
      { op: "if", blockType: { kind: "empty" }, then: empty },
      // (#7354 O2b convention) Run-time abort, never a wrong answer: a primitive or an unknown carrier is no object
      // the kernel walks.
      get(0),
      { op: "call", funcIdx: d.match },
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: d.objectTypeIdx },
      { op: "i32.or" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
      { op: "call", funcIdx: d.newVector },
      set(seen),
      get(0),
      set(cursor),
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          ...eachOwnKey(d, [get(cursor)], { keys, index, key, word }, visit),
          ...link,
          get(next),
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "empty" }, then: empty },
          get(next),
          set(cursor),
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}
