// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";
import { buildBuiltinFunctionArgument, type BuiltinFunctionDefinition } from "./builtin-function-bodies.js";

export interface NativeObjectExtensibilityOperands {
  readonly vectorTypeIdx: number;
  readonly vectorArrayTypeIdx: number;
  readonly undefinedGlobal: number;
  readonly undefinedTypeIdx: number;
  readonly isPrimitive: FuncHandle;
  readonly operation: FuncHandle;
  readonly boxBoolean: FuncHandle;
  readonly throwTypeError: Instr[];
}
const get = (index: number): Instr => ({ op: "local.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const when = (then: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then });

/** Native value ABI only. Unknown/unready values trap, never impersonate primitive results.
 * The downstream owner authenticates every carrier and operation before filling.
 * No ToObject, coercion, property access or host value conversion occurs here.
 */
export function buildNativeObjectExtensibilityDefinition(
  d: NativeObjectExtensibilityOperands,
  prevent: boolean,
): BuiltinFunctionDefinition {
  const primitive = (): Instr[] => [...(prevent ? [get(2)] : [n(0), call(d.boxBoolean)]), { op: "return" }];
  return {
    locals: [
      { name: "value", type: { kind: "externref" } },
      { name: "status", type: { kind: "i32" } },
    ],
    body: [
      ...buildBuiltinFunctionArgument(d, 1, 0),
      { op: "local.set", index: 2 },
      get(2),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: d.undefinedTypeIdx },
      when([
        get(2),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: d.undefinedTypeIdx },
        { op: "global.get", index: d.undefinedGlobal },
        { op: "ref.eq" },
        when(primitive()),
        // A tag/layout lookalike is not the canonical undefined singleton.
        { op: "unreachable" },
      ]),
      get(2),
      call(d.isPrimitive),
      when(primitive()),
      get(2),
      call(d.operation),
      { op: "local.set", index: 3 },
      // Internal Boolean/status ABI: only 0 and 1 are semantic results.
      get(3),
      n(1),
      { op: "i32.gt_u" },
      when([{ op: "unreachable" }]),
      ...(prevent
        ? [get(3), { op: "i32.eqz" } as Instr, when(structuredClone(d.throwTypeError)), get(2)]
        : [get(3), call(d.boxBoolean)]),
    ],
  };
}
