// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import { buildBuiltinFunctionArgument, type BuiltinFunctionDefinition } from "./builtin-function-bodies.js";

export interface NativeObjectSetPrototypeOperands {
  readonly vectorTypeIdx: number;
  readonly vectorArrayTypeIdx: number;
  readonly undefinedGlobal: number;
  readonly undefinedTypeIdx: number;
  readonly isPrimitive: FuncHandle;
  readonly classify: FuncHandle;
  readonly setPrototypeOf: FuncHandle;
  readonly throwTypeError: Instr[];
}
const get = (index: number): Instr => ({ op: "local.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const when = (then: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then });

/** Native ABI only; private admission is not source/foreign-object authority. */
export function buildNativeObjectSetPrototypeDefinition(
  d: NativeObjectSetPrototypeOperands,
): BuiltinFunctionDefinition {
  return definition(d, false);
}

/** The retained accessor setter consumes this/argv[0], not argv[0]/argv[1]. */
export function buildNativeObjectPrototypeSetterDefinition(
  d: NativeObjectSetPrototypeOperands,
): BuiltinFunctionDefinition {
  return definition(d, true);
}

function definition(d: NativeObjectSetPrototypeOperands, setter: boolean): BuiltinFunctionDefinition {
  const error = () => structuredClone(d.throwTypeError);
  const undefinedValue = (): Instr[] => [{ op: "global.get", index: d.undefinedGlobal }, { op: "extern.convert_any" }];
  const invalidPrototype = (): Instr[] => (setter ? [...undefinedValue(), { op: "return" }] : error());
  const result = (): Instr[] => (setter ? undefinedValue() : [get(2)]);
  const undefinedGuard = (local: number, prototype = false): Instr[] => [
    get(local),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: d.undefinedTypeIdx },
    when([
      get(local),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.undefinedTypeIdx },
      { op: "global.get", index: d.undefinedGlobal },
      { op: "ref.eq" },
      when(prototype ? invalidPrototype() : error()),
      // A lookalike/tagged value is not the canonical undefined input.
      { op: "unreachable" },
    ]),
  ];
  const objectGuard = (local: number): Instr[] => [
    get(local),
    call(d.classify),
    n(0),
    { op: "i32.le_s" },
    when([{ op: "unreachable" }]),
  ];
  return {
    locals: [
      { name: "object", type: { kind: "externref" } },
      { name: "prototype", type: { kind: "externref" } },
      { name: "primitive", type: { kind: "i32" } },
      { name: "status", type: { kind: "i32" } },
    ],
    body: [
      ...(setter ? [get(0)] : buildBuiltinFunctionArgument(d, 1, 0)),
      { op: "local.set", index: 2 },
      // RequireObjectCoercible precedes even reading the prototype argument.
      get(2),
      { op: "ref.is_null" },
      when(error()),
      ...undefinedGuard(2),
      get(2),
      call(d.isPrimitive),
      { op: "local.tee", index: 4 },
      { op: "i32.eqz" },
      when(objectGuard(2)),
      ...buildBuiltinFunctionArgument(d, 1, setter ? 0 : 1),
      { op: "local.set", index: 3 },
      get(3),
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      when([...undefinedGuard(3, true), get(3), call(d.isPrimitive), when(invalidPrototype()), ...objectGuard(3)]),
      // Prototype validity is required even when O is a non-null primitive.
      get(4),
      when([...result(), { op: "return" }]),
      get(2),
      get(3),
      call(d.setPrototypeOf),
      { op: "local.set", index: 5 },
      get(5),
      n(1),
      { op: "i32.gt_u" },
      when([{ op: "unreachable" }]),
      get(5),
      { op: "i32.eqz" },
      when(error()),
      ...result(),
    ],
  };
}
