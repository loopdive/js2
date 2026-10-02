// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

/** Complete internal operations. No predicate invokes or unwraps a proxy.
 * MakeAccessorDescriptor(callable,isSetter) returns only Getter OR Setter plus
 * Enumerable:true, Configurable:true; the opposite accessor field is absent.
 * DefineOwnProperty(object,key,descriptor) and SetPrototypeOf(object,proto) return
 * i32 success and preserve abrupt completion. Descriptor readers consume internal
 * records, never user properties. GetPrototypeOf preserves proxy behavior.
 * SetPrototypeOf must honor immutable-prototype exotic objects, including Object.prototype.
 * RequireObjectCoercible returns its input or throws; UndefinedValue returns canonical undefined.
 */
export interface ObjectPrototypeAccessorBindings {
  readonly toObject: FuncHandle;
  readonly toPropertyKey: FuncHandle;
  readonly isCallable: FuncHandle;
  readonly makeAccessorDescriptor: FuncHandle;
  readonly defineOwnProperty: FuncHandle;
  readonly throwTypeError: FuncHandle;
  readonly undefinedValue: FuncHandle;
  readonly getOwnProperty: FuncHandle;
  readonly isUndefined: FuncHandle;
  readonly isAccessorDescriptor: FuncHandle;
  readonly descriptorGetter: FuncHandle;
  readonly descriptorSetter: FuncHandle;
  readonly getPrototypeOf: FuncHandle;
  readonly isNull: FuncHandle;
  readonly requireObjectCoercible: FuncHandle;
  readonly isObject: FuncHandle;
  readonly setPrototypeOf: FuncHandle;
}
export type ObjectPrototypeAccessorMethod =
  | "__defineGetter__"
  | "__defineSetter__"
  | "__lookupGetter__"
  | "__lookupSetter__"
  | "get __proto__"
  | "set __proto__";
type Definition = { locals: LocalDef[]; body: Instr[] };
const local = (index: number): Instr => ({ op: "local.get", index });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const extLocal = (name: string): LocalDef => ({ name, type: { kind: "externref" } });
function requireBindings(d: ObjectPrototypeAccessorBindings): void {
  for (const key of [
    "toObject",
    "toPropertyKey",
    "isCallable",
    "makeAccessorDescriptor",
    "defineOwnProperty",
    "throwTypeError",
    "undefinedValue",
    "getOwnProperty",
    "isUndefined",
    "isAccessorDescriptor",
    "descriptorGetter",
    "descriptorSetter",
    "getPrototypeOf",
    "isNull",
    "requireObjectCoercible",
    "isObject",
    "setPrototypeOf",
  ] as const)
    if (!d || !Number.isSafeInteger(d[key]) || d[key] < 0)
      throw new Error("object prototype accessors: unresolved binding " + key);
}
function throwIfFalse(d: ObjectPrototypeAccessorBindings): Instr[] {
  return [
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [call(d.throwTypeError), { op: "unreachable" }],
    },
  ];
}
function undefinedReturn(d: ObjectPrototypeAccessorBindings): Instr[] {
  return [call(d.undefinedValue), { op: "return" }];
}
function defineAccessor(setter: boolean, d: ObjectPrototypeAccessorBindings): Definition {
  return {
    locals: [extLocal("$object"), extLocal("$descriptor"), extLocal("$key")],
    body: [
      local(0),
      call(d.toObject),
      { op: "local.set", index: 3 },
      local(2),
      call(d.isCallable),
      ...throwIfFalse(d),
      local(2),
      { op: "i32.const", value: setter ? 1 : 0 },
      call(d.makeAccessorDescriptor),
      { op: "local.set", index: 4 },
      local(1),
      call(d.toPropertyKey),
      { op: "local.set", index: 5 },
      local(3),
      local(5),
      local(4),
      call(d.defineOwnProperty),
      ...throwIfFalse(d),
      call(d.undefinedValue),
    ],
  };
}
function lookupAccessor(setter: boolean, d: ObjectPrototypeAccessorBindings): Definition {
  return {
    locals: [extLocal("$cursor"), extLocal("$key"), extLocal("$descriptor")],
    body: [
      local(0),
      call(d.toObject),
      { op: "local.set", index: 2 },
      local(1),
      call(d.toPropertyKey),
      { op: "local.set", index: 3 },
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          local(2),
          local(3),
          call(d.getOwnProperty),
          { op: "local.tee", index: 4 },
          call(d.isUndefined),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              local(4),
              call(d.isAccessorDescriptor),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [local(4), call(setter ? d.descriptorSetter : d.descriptorGetter), { op: "return" }],
              },
              ...undefinedReturn(d),
            ],
          },
          local(2),
          call(d.getPrototypeOf),
          { op: "local.tee", index: 2 },
          call(d.isNull),
          { op: "if", blockType: { kind: "empty" }, then: undefinedReturn(d) },
          { op: "br", depth: 0 },
        ],
      },
      { op: "unreachable" },
    ],
  };
}
function setProto(d: ObjectPrototypeAccessorBindings): Definition {
  return {
    locals: [],
    body: [
      local(0),
      call(d.requireObjectCoercible),
      { op: "drop" },
      local(1),
      call(d.isObject),
      local(1),
      call(d.isNull),
      { op: "i32.or" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: undefinedReturn(d) },
      local(0),
      call(d.isObject),
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: undefinedReturn(d) },
      local(0),
      local(1),
      call(d.setPrototypeOf),
      ...throwIfFalse(d),
      call(d.undefinedValue),
    ],
  };
}
/** ECMA-262 §20.1.3.8–.9 (formerly Annex B). Receiver is 0; key/proto is 1;
 * defining callable is 2. Returned language values are externrefs, including undefined.
 * The backend owner must authenticate and complete the supplied dependencies.
 */
export function buildObjectPrototypeAccessorDefinition(
  method: ObjectPrototypeAccessorMethod,
  d: ObjectPrototypeAccessorBindings,
): Definition {
  requireBindings(d);
  switch (method) {
    case "__defineGetter__":
      return defineAccessor(false, d);
    case "__defineSetter__":
      return defineAccessor(true, d);
    case "__lookupGetter__":
      return lookupAccessor(false, d);
    case "__lookupSetter__":
      return lookupAccessor(true, d);
    case "get __proto__":
      return { locals: [], body: [local(0), call(d.toObject), call(d.getPrototypeOf)] };
    case "set __proto__":
      return setProto(d);
    default:
      throw new Error("object prototype accessors: unknown method");
  }
}
