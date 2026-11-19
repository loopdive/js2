// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 C) Bodies of the realm's `js.function.*` functions. A source function object is its closure struct, which the
 * kernel's `match` recognises (one ordinal after the builtin entries); its own properties live in an ordinary object
 * in the closure's `$bag`. Each body puts one contract's signature in front of the kernel's algorithms (`match`,
 * `get`, `getPrototypeOf`, the descriptors' define), the invocation's `js.closure.call:N` and `__current_this`.
 */
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import { CLOSURE_BAG_FIELD_IDX } from "./closure-layouts.js";
import { buildFunctionLengthNameSeed, builtinTypeError, sourceClosureOrdinal } from "./builtin-function-bodies.js";
import {
  buildBuiltinFunctionParentStep,
  type BuiltinFunctionPrototypeOperands,
} from "./builtin-function-prototype-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "./ordinary-object-descriptor-common.js";
import {
  sourceObjectCreate,
  type SourceObjectCreateOperands,
  type SourceObjectDefinition,
} from "./source-object-bodies.js";

type Kernel = BuiltinFunctionPrototypeOperands;
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const empty = { kind: "empty" } as const;
const externref = { kind: "externref" } as const;
/** Descriptor words: `constructor` writable, configurable (0xbd); `prototype` writable only (0xb9). */
const CONSTRUCTOR_DESCRIPTOR = 0xbd;
const PROTOTYPE_DESCRIPTOR = 0xb9;

/** Type(value) is Object: a function object of this realm or an ordinary object (nonzero i32). */
function isObject(kernel: Kernel, local: number): Instr[] {
  return [
    get(local),
    call(kernel.match),
    get(local),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: kernel.objectTypeIdx },
    { op: "i32.or" },
  ];
}
/** Pop the kernel [[Get]]'s (status, value) of `object`'s `key`, keeping the value in `into`. */
function getInto(getFn: FuncHandle, object: number, key: readonly Instr[], into: number): Instr[] {
  return [get(object), ...structuredClone(key), get(object), call(getFn), set(into), { op: "drop" }];
}

/**
 * `js.function.is-callable(value)`: the realm's function objects are exactly the values `match` admits.
 * To fold when `claude/7354-fa-ty` lands: its `js.value.is_function` (`__typeof_function`) answers the same question
 * with `buildClosureRootTest` (closure-invocation-bodies.ts), a `ref.test` of the closure root that every source and
 * builtin function carrier descends from; the two must become one predicate body.
 */
export function buildSourceFunctionIsCallableDefinition(kernel: Pick<Kernel, "match">): SourceObjectDefinition {
  return { locals: [], body: [get(0), call(kernel.match), n(0), { op: "i32.ne" }] };
}

/**
 * `js.function.init(closure, name, length, flags)`: the bag, an ordinary object with a null [[Prototype]] (the
 * closure's own is %Function.prototype%, answered by the kernel); then `length` and `name` by the builtin seeding;
 * then, for a constructible function, MakeConstructor: a fresh ordinary `prototype` whose `constructor` is the
 * closure. Own keys are therefore in the spec's order. [[Construct]] is recorded in the bag's object flags.
 */
export function buildSourceFunctionInitDefinition(d: {
  readonly kernel: Kernel;
  readonly create: SourceObjectCreateOperands;
  readonly prototypeKey: readonly Instr[];
  readonly constructorKey: readonly Instr[];
  readonly constructible: number;
}): SourceObjectDefinition {
  const { kernel } = d;
  const bag = (): Instr[] => [get(4)];
  const bagObject = (): Instr[] => [
    get(4),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: kernel.objectTypeIdx },
  ];
  const define = (target: number, key: readonly Instr[], value: number, descriptor: number): Instr[] => [
    get(target),
    ...structuredClone(key),
    get(value),
    { op: "f64.const", value: descriptor },
    call(kernel.defineDataBody),
    { op: "drop" },
  ];
  return {
    locals: [
      { name: "bag", type: externref },
      { name: "prototype", type: externref },
    ],
    body: [
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: kernel.rootTypeIdx },
      call(kernel.createNull),
      { op: "local.tee", index: 4 },
      { op: "struct.set", typeIdx: kernel.rootTypeIdx, fieldIdx: CLOSURE_BAG_FIELD_IDX },
      ...buildFunctionLengthNameSeed(kernel, bag, kernel.defineDataBody, [get(2)], [get(1)]),
      get(3),
      { op: "i32.trunc_f64_u" },
      n(d.constructible),
      { op: "i32.and" },
      {
        op: "if",
        blockType: empty,
        then: [
          ...bagObject(),
          ...bagObject(),
          { op: "struct.get", typeIdx: kernel.objectTypeIdx, fieldIdx: 4 },
          n(flags.hasConstruct),
          { op: "i32.or" },
          { op: "struct.set", typeIdx: kernel.objectTypeIdx, fieldIdx: 4 },
          ...sourceObjectCreate(d.create, [call(d.create.objectPrototype)]),
          set(5),
          ...define(5, d.constructorKey, 0, CONSTRUCTOR_DESCRIPTOR),
          ...define(4, d.prototypeKey, 5, PROTOTYPE_DESCRIPTOR),
        ],
      },
    ],
  };
}

/**
 * `js.function.construct:N(callee, ...N)`: [[Construct]] of a source function. IsConstructor, then
 * OrdinaryCreateFromConstructor (`prototype`, or the realm's Object.prototype when that is not an object), then the
 * closure call with the new object as receiver; an object result replaces it. An ordinary object cannot hold a
 * function as its [[Prototype]], so a function-valued `prototype` is a named gap.
 */
export function buildSourceFunctionConstructDefinition(
  d: {
    readonly kernel: Kernel;
    readonly get: FuncHandle;
    readonly create: SourceObjectCreateOperands;
    readonly call: FuncHandle;
    readonly prototypeKey: readonly Instr[];
    readonly notConstructor: readonly Instr[];
    readonly functionPrototype: readonly Instr[];
  },
  arity: number,
): SourceObjectDefinition {
  const { kernel } = d;
  const [proto, object, result] = [arity + 1, arity + 2, arity + 3];
  return {
    locals: [
      { name: "prototype", type: externref },
      { name: "object", type: externref },
      { name: "result", type: externref },
    ],
    body: [
      get(0),
      call(kernel.match),
      n(sourceClosureOrdinal(kernel)),
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          get(0),
          call(kernel.bag),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: kernel.objectTypeIdx },
          { op: "struct.get", typeIdx: kernel.objectTypeIdx, fieldIdx: 4 },
          n(flags.hasConstruct),
          { op: "i32.and" },
        ],
        else: [n(0)],
      },
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: builtinTypeError(kernel, d.notConstructor) },
      ...getInto(d.get, 0, d.prototypeKey, proto),
      get(proto),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: kernel.objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: empty,
        then: [
          get(proto),
          call(kernel.match),
          { op: "if", blockType: empty, then: builtinTypeError(kernel, d.functionPrototype) },
          call(d.create.objectPrototype),
          set(proto),
        ],
      },
      ...sourceObjectCreate(d.create, [get(proto)]),
      set(object),
      get(object),
      ...Array.from({ length: arity + 1 }, (_, index) => get(index)),
      call(d.call),
      set(result),
      ...isObject(kernel, result),
      { op: "if", blockType: { kind: "val", type: externref }, then: [get(result)], else: [get(object)] },
    ],
  };
}

/**
 * `js.function.has-instance(value, callee)`: instanceof's TypeError for a non-callable callee, then
 * OrdinaryHasInstance. Its first step is the walk's own: a value that is no object has no [[GetPrototypeOf]], so it
 * answers false before `prototype` is read, as the spec orders it. Every object a source program reaches has an
 * actual link (`create-default`, `construct` and the bag set one), so the walk meets no unknown or unresolved parent.
 */
export function buildSourceFunctionHasInstanceDefinition(d: {
  readonly kernel: Kernel;
  readonly get: FuncHandle;
  readonly prototypeKey: readonly Instr[];
  readonly notCallable: readonly Instr[];
  readonly nonObjectPrototype: readonly Instr[];
}): SourceObjectDefinition {
  const { kernel } = d;
  const [proto, cursor, next] = [2, 3, 4];
  const trap: Instr[] = [{ op: "unreachable" }];
  return {
    locals: [
      { name: "prototype", type: externref },
      { name: "cursor", type: externref },
      { name: "next", type: externref },
    ],
    body: [
      get(1),
      call(kernel.match),
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: builtinTypeError(kernel, d.notCallable) },
      ...buildBuiltinFunctionParentStep(kernel, 0, cursor, [n(0), { op: "return" }], trap),
      ...getInto(d.get, 1, d.prototypeKey, proto),
      ...isObject(kernel, proto),
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: builtinTypeError(kernel, d.nonObjectPrototype) },
      {
        op: "loop",
        blockType: empty,
        body: [
          get(cursor),
          { op: "ref.is_null" },
          { op: "if", blockType: empty, then: [n(0), { op: "return" }] },
          get(cursor),
          get(proto),
          call(kernel.sameValue),
          { op: "if", blockType: empty, then: [n(1), { op: "return" }] },
          ...buildBuiltinFunctionParentStep(kernel, cursor, next, trap, trap),
          get(next),
          set(cursor),
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}

/**
 * `js.function.this(strict)`: OrdinaryCallBindThis over the receiver the closure dispatcher installed. Strict code
 * takes it as is. Sloppy code would take the global object for `undefined` / `null` and ToObject for a primitive; the
 * realm has neither yet, so both are named errors rather than a wrong `this`.
 */
export function buildSourceFunctionThisDefinition(d: {
  readonly kernel: Kernel;
  readonly currentThis: number;
  readonly isUndefined: FuncHandle;
  readonly unboundSloppy: readonly Instr[];
  readonly primitiveSloppy: readonly Instr[];
}): SourceObjectDefinition {
  const { kernel } = d;
  return {
    locals: [{ name: "receiver", type: externref }],
    body: [
      { op: "global.get", index: d.currentThis },
      set(1),
      get(0),
      { op: "if", blockType: empty, then: [get(1), { op: "return" }] },
      get(1),
      { op: "ref.is_null" },
      get(1),
      call(d.isUndefined),
      { op: "i32.or" },
      // The realm's global object, `js.object.global` (#7350 B2b), answers here once it lands.
      { op: "if", blockType: empty, then: builtinTypeError(kernel, d.unboundSloppy) },
      ...isObject(kernel, 1),
      { op: "i32.eqz" },
      { op: "if", blockType: empty, then: builtinTypeError(kernel, d.primitiveSloppy) },
      get(1),
    ],
  };
}
