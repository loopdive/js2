// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** Semantic dependencies, not authenticated native-provider grants.
 * Unary predicates return i32; ToObject/ToPropertyKey return externref.
 * GetOwnProperty returns a descriptor record or canonical undefined, without Get.
 * DescriptorEnumerable reads the internal record, never the receiver's property.
 * Get(object,key,receiver) and Call0(callable,receiver) preserve original this.
 * GetPrototypeOf and every coercion/call propagate abrupt completion unchanged.
 * BooleanValue(i32) and UndefinedValue() return canonical language values.
 */
export interface ObjectPrototypeMethodBindings {
  readonly toObject: FuncHandle;
  readonly toPropertyKey: FuncHandle;
  readonly getOwnProperty: FuncHandle;
  readonly isUndefined: FuncHandle;
  readonly descriptorEnumerable: FuncHandle;
  readonly booleanValue: FuncHandle;
  readonly isObject: FuncHandle;
  readonly isNull: FuncHandle;
  readonly getPrototypeOf: FuncHandle;
  readonly sameValue: FuncHandle;
  readonly get: FuncHandle;
  readonly isCallable: FuncHandle;
  readonly call0: FuncHandle;
  readonly throwTypeError: FuncHandle;
  readonly toStringKey: readonly Instr[];
}
export type ObjectPrototypeMethod =
  | "hasOwnProperty"
  | "propertyIsEnumerable"
  | "isPrototypeOf"
  | "toLocaleString"
  | "valueOf";
type Definition = { locals: LocalDef[]; body: Instr[] };
const local = (index: number): Instr => ({ op: "local.get", index });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const extLocal = (name: string): LocalDef => ({ name, type: { kind: "externref" } });

function requireBindings(d: ObjectPrototypeMethodBindings): void {
  for (const key of [
    "toObject",
    "toPropertyKey",
    "getOwnProperty",
    "isUndefined",
    "descriptorEnumerable",
    "booleanValue",
    "isObject",
    "isNull",
    "getPrototypeOf",
    "sameValue",
    "get",
    "isCallable",
    "call0",
    "throwTypeError",
  ] as const)
    if (!d || !Number.isSafeInteger(d[key]) || d[key] < 0)
      throw new Error("object prototype methods: unresolved binding " + key);
  if (!Array.isArray(d.toStringKey) || !d.toStringKey.length)
    throw new Error("object prototype methods: unresolved toString key");
}
function booleanReturn(value: number, d: ObjectPrototypeMethodBindings): Instr[] {
  return [{ op: "i32.const", value }, call(d.booleanValue), { op: "return" }];
}

function ownPredicate(method: "hasOwnProperty" | "propertyIsEnumerable", d: ObjectPrototypeMethodBindings): Definition {
  return {
    locals: [extLocal("$key"), extLocal("$descriptor")],
    body: [
      local(1),
      call(d.toPropertyKey),
      { op: "local.set", index: 2 },
      local(0),
      call(d.toObject),
      local(2),
      call(d.getOwnProperty),
      { op: "local.tee", index: 3 },
      call(d.isUndefined),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 0 }],
        else: method === "hasOwnProperty" ? [{ op: "i32.const", value: 1 }] : [local(3), call(d.descriptorEnumerable)],
      },
      call(d.booleanValue),
    ],
  };
}
function buildPrototypeCheck(d: ObjectPrototypeMethodBindings): Definition {
  return {
    locals: [extLocal("$object"), extLocal("$cursor")],
    body: [
      local(1),
      call(d.isObject),
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: booleanReturn(0, d) },
      local(0),
      call(d.toObject),
      { op: "local.set", index: 2 },
      local(1),
      { op: "local.set", index: 3 },
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          local(3),
          call(d.getPrototypeOf),
          { op: "local.tee", index: 3 },
          call(d.isNull),
          { op: "if", blockType: { kind: "empty" }, then: booleanReturn(0, d) },
          local(2),
          local(3),
          call(d.sameValue),
          { op: "if", blockType: { kind: "empty" }, then: booleanReturn(1, d) },
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}
function buildLocaleString(d: ObjectPrototypeMethodBindings): Definition {
  return {
    locals: [extLocal("$method")],
    body: [
      local(0),
      call(d.toObject),
      ...structuredClone(d.toStringKey),
      local(0),
      call(d.get),
      { op: "local.tee", index: 1 },
      call(d.isCallable),
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [call(d.throwTypeError), { op: "unreachable" }],
      },
      local(1),
      local(0),
      call(d.call0),
    ],
  };
}

/** ECMA-262 §20.1.3.2–.5, .7. Receiver is parameter 0; key/value is 1 where present.
 * Results are canonical externrefs. No catch, prototype shortcut or primitive identity fallback.
 * The separate toString recipe owns §20.1.3.6; a backend must complete all dependencies.
 */
export function buildObjectPrototypeMethodDefinition(
  method: ObjectPrototypeMethod,
  d: ObjectPrototypeMethodBindings,
): Definition {
  requireBindings(d);
  switch (method) {
    case "hasOwnProperty":
    case "propertyIsEnumerable":
      return ownPredicate(method, d);
    case "isPrototypeOf":
      return buildPrototypeCheck(d);
    case "toLocaleString":
      return buildLocaleString(d);
    case "valueOf":
      return { locals: [], body: [local(0), call(d.toObject)] };
    default:
      throw new Error("object prototype methods: unknown method");
  }
}
