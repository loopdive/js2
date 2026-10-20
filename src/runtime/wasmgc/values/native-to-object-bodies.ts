// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, FuncHandle } from "../../../wasm/model/instructions.js";
import type { BuiltinFunctionDefinition } from "./builtin-function-bodies.js";
import { buildToObjectDefinition, type ToObjectBindings } from "./to-object-body.js";
import type { NativePrimitivePrototypeKind } from "../../contracts/native-primitive-prototype-identities.js";

const get = (): Instr => ({ op: "local.get", index: 0 });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const when = (then: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then });

/** Fixed private bridges, not caller/provider ownership evidence. */
export function buildNativeToObjectUndefinedDefinition(typeIdx: number, global: number): BuiltinFunctionDefinition {
  return {
    locals: [],
    body: [
      get(),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          get(),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx },
          { op: "global.get", index: global },
          { op: "ref.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ],
  };
}
export function buildNativeToObjectNullDefinition(): BuiltinFunctionDefinition {
  return { locals: [], body: [get(), { op: "ref.is_null" }] };
}
export function buildNativeToObjectStringDefinition(typeIdx: number): BuiltinFunctionDefinition {
  return { locals: [], body: [get(), { op: "any.convert_extern" }, { op: "ref.test", typeIdx }] };
}

export interface NativeToObjectFactoryOperands {
  readonly prototypes: Readonly<Record<NativePrimitivePrototypeKind, FuncHandle>>;
  readonly allocation: Readonly<Record<NativePrimitivePrototypeKind, FuncHandle>>;
  readonly unboxBoolean: FuncHandle;
  readonly unboxNumber: FuncHandle;
  readonly stringType: number;
  readonly symbolType: number;
}
/** Input is already admitted as this exact primitive family by the owned kernel. */
export function buildNativeToObjectFactoryDefinition(
  kind: NativePrimitivePrototypeKind,
  d: NativeToObjectFactoryOperands,
): BuiltinFunctionDefinition {
  let payload: Instr[];
  switch (kind) {
    case "Boolean":
      payload = [get(), call(d.unboxBoolean)];
      break;
    case "Number":
      payload = [get(), call(d.unboxNumber)];
      break;
    case "String":
      payload = [get(), { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: d.stringType }];
      break;
    case "Symbol":
      payload = [get(), { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: d.symbolType }];
      break;
    case "BigInt":
      payload = [get()];
      break;
    default:
      throw Error("native ToObject factory: invalid fixed primitive role");
  }
  return { locals: [], body: [call(d.prototypes[kind]), ...payload, call(d.allocation[kind])] };
}

/** Authenticate the private domain before the shared ECMA ToObject body can pass an Object through.
 * Native source/foreign references require their real admission owners; structural lookalikes trap.
 * Full prototype/member population and source/public provider completion remain downstream duties.
 */
export function buildNativeToObjectDefinition(d: {
  readonly undefinedType: number;
  readonly isPrimitive: FuncHandle;
  readonly classify: FuncHandle;
  readonly bindings: ToObjectBindings;
}): BuiltinFunctionDefinition {
  const semantic = buildToObjectDefinition(d.bindings);
  return {
    locals: semantic.locals,
    body: [
      get(),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: d.undefinedType },
      when([get(), call(d.bindings.isUndefined), { op: "i32.eqz" }, when([{ op: "unreachable" }])]),
      get(),
      call(d.isPrimitive),
      { op: "i32.eqz" },
      when([get(), call(d.classify), { op: "i32.const", value: 0 }, { op: "i32.le_s" }, when([{ op: "unreachable" }])]),
      ...semantic.body,
    ],
  };
}
