// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type { StructTypeDef } from "../../../wasm/model/module-records.js";
import type { IrClosureLowering } from "./closure-layouts.js";

/** Data for the native IR allocator, not a callable/body completion capability. */
export interface NativeSourceCodeLowering extends IrClosureLowering {
  readonly nativeSourceCodeIdentityGlobal: number;
}
export function withNativeSourceCodeIdentity(layout: IrClosureLowering, global: number): NativeSourceCodeLowering {
  if (!Number.isSafeInteger(global) || global < 0 || global > 0xffffffff)
    throw Error("source code identity: invalid global coordinate");
  return Object.freeze({ ...layout, nativeSourceCodeIdentityGlobal: global });
}
/** Extend native allocations without changing the historically retained closure-layout contract. */
export function buildNativeSourceCodeIdentityOperand(layout: IrClosureLowering): Instr[] {
  const field = Object.getOwnPropertyDescriptor(layout, "nativeSourceCodeIdentityGlobal");
  if (!field) {
    if ("nativeSourceCodeIdentityGlobal" in layout) throw Error("source code identity: inherited allocator operand");
    return [];
  }
  if (
    !Object.hasOwn(field, "value") ||
    !field.enumerable ||
    !Number.isSafeInteger(field.value) ||
    field.value < 0 ||
    field.value > 0xffffffff ||
    layout.realmStateInitializer === undefined ||
    layout.domCallbackAuthorityGlobalIdx !== undefined
  )
    throw Error("source code identity: invalid native allocator operand");
  return [{ op: "global.get", index: field.value }];
}
export function createNativeSourceCodeIdentityType(name: string): StructTypeDef {
  return {
    kind: "struct",
    name,
    final: true,
    fields: [{ name: "[[Code]]", type: { kind: "funcref" }, mutable: false }],
  };
}
export function buildNativeSourceCodeIdentityInitializer(typeIdx: number, target: FuncHandle): Instr[] {
  return [
    { op: "ref.func", funcIdx: target },
    { op: "struct.new", typeIdx },
  ];
}
export interface NativeSourceCodeMatchOperands {
  readonly realmGlobal: number;
  readonly stateTypeIdx: number;
  readonly codeTypeIdx: number;
  readonly entries: readonly {
    readonly sourceTypeIdx: number;
    readonly stateField: number;
    readonly codeField: number;
    readonly codeGlobal: number;
  }[];
}
/** Match code-box authority and live realm. Does not inspect or certify the compatibility header target. */
export function buildNativeSourceCodeMatch(d: NativeSourceCodeMatchOperands): { locals: LocalDef[]; body: Instr[] } {
  const get = (): Instr => ({ op: "local.get", index: 0 });
  const cast = (typeIdx: number): Instr[] => [get(), { op: "any.convert_extern" }, { op: "ref.cast", typeIdx }];
  return {
    locals: [],
    body: [
      { op: "global.get", index: d.realmGlobal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -2 }, { op: "return" }],
      },
      ...d.entries.flatMap((entry, index): Instr[] => [
        get(),
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: entry.sourceTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...cast(entry.sourceTypeIdx),
            { op: "struct.get", typeIdx: entry.sourceTypeIdx, fieldIdx: entry.stateField },
            { op: "struct.get", typeIdx: d.stateTypeIdx, fieldIdx: 1 },
            { op: "global.get", index: d.realmGlobal },
            { op: "ref.eq" },
            ...cast(entry.sourceTypeIdx),
            { op: "struct.get", typeIdx: entry.sourceTypeIdx, fieldIdx: entry.codeField },
            { op: "global.get", index: entry.codeGlobal },
            { op: "ref.eq" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: index + 1 }, { op: "return" }],
            },
          ],
        },
      ]),
      { op: "i32.const", value: 0 },
    ],
  };
}
