// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, FuncHandle } from "../../../wasm/model/instructions.js";
export interface NativeClosureIdentity {
  readonly allocationTypeIdx: number;
  readonly funcTypeIdx: number;
  readonly realm?: { readonly stateField: number; readonly stateType: number; readonly global: number };
}
/** The carrier guard dominates all field reads; callability never inspects user arguments. */
export function buildNativeClosureIdentityMatch(
  entry: NativeClosureIdentity,
  anyLocal: number,
  funcLocal: number,
): Instr[] {
  if (!entry.realm)
    return [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: entry.allocationTypeIdx },
      { op: "local.get", index: funcLocal },
      { op: "ref.test", typeIdx: entry.funcTypeIdx },
      { op: "i32.and" },
    ];
  const identity: Instr[] = [
    { op: "local.get", index: funcLocal },
    { op: "ref.test", typeIdx: entry.funcTypeIdx },
  ];
  identity.push(
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: entry.allocationTypeIdx },
    { op: "struct.get", typeIdx: entry.allocationTypeIdx, fieldIdx: entry.realm.stateField },
    { op: "struct.get", typeIdx: entry.realm.stateType, fieldIdx: 1 },
    { op: "global.get", index: entry.realm.global },
    { op: "ref.eq" },
    { op: "i32.and" },
  );
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: entry.allocationTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: identity,
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}
/** A failed builtin identity must never fall through to structurally compatible source carriers. */
export function buildBuiltinCarrierRejection(
  carriers: readonly number[],
  local: number,
  failure: readonly Instr[],
): Instr[] {
  return carriers.flatMap((typeIdx): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx },
    { op: "if", blockType: { kind: "empty" }, then: structuredClone([...failure]) },
  ]);
}
export function buildNativeClosureCallableDefinition(
  root: number,
  entries: readonly NativeClosureIdentity[],
  builtin: { readonly match: FuncHandle; readonly carriers: readonly number[] },
) {
  const no: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  return {
    locals: [
      { name: "candidate", type: { kind: "anyref" as const } },
      { name: "function", type: { kind: "funcref" as const } },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: builtin.match },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
      ...buildBuiltinCarrierRejection(builtin.carriers, 0, no),
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: root },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: no },
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: root },
      { op: "struct.get", typeIdx: root, fieldIdx: 0 },
      { op: "local.set", index: 2 },
      ...entries.flatMap((entry): Instr[] => [
        ...buildNativeClosureIdentityMatch(entry, 1, 2),
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
      ]),
      { op: "i32.const", value: 0 },
    ] satisfies Instr[],
  };
}
