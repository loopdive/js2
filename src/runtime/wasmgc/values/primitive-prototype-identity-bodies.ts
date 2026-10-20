// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES,
  type NativePrimitivePrototypeKind,
} from "../../contracts/native-primitive-prototype-identities.js";
import type { NativeDeclaredType } from "./native-resource-declaration-types.js";
import type { Instr, FuncHandle } from "../../../wasm/model/instructions.js";
import type { BuiltinFunctionDefinition } from "./builtin-function-bodies.js";

/** Immutable fields prevent a language-level prototype mutation from changing role identity. */
export function primitivePrototypeIdentityDeclaration(realm: string, objectPrototype: string): NativeDeclaredType {
  return {
    kind: "struct",
    name: "$PrimitivePrototypeIdentities",
    fields: [
      { name: "[[Realm]]", type: { kind: "ref", typeKey: realm }, mutable: false },
      { name: "[[ObjectPrototype]]", type: { kind: "ref", typeKey: objectPrototype }, mutable: false },
      ...NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => ({
        name: row.intrinsic,
        type: { kind: "externref" as const },
        mutable: false,
      })),
    ],
  };
}
export interface PrimitivePrototypeIdentityOperands {
  readonly capsuleType: number;
  readonly capsuleGlobal: number;
  readonly realmGlobal: number;
  readonly objectPrototypeGlobal: number;
  readonly classify: FuncHandle;
  readonly booleanAllocation: FuncHandle;
  readonly numberAllocation: FuncHandle;
  readonly stringCreate: FuncHandle;
  readonly ordinaryAllocation: FuncHandle;
  readonly emptyString: readonly Instr[];
}
const global = (index: number): Instr => ({ op: "global.get", index });
const call = (funcIdx: FuncHandle): Instr => ({ op: "call", funcIdx });
const when = (then: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then });
const capsuleField = (d: PrimitivePrototypeIdentityOperands, fieldIdx: number): Instr[] => [
  global(d.capsuleGlobal),
  { op: "ref.as_non_null" },
  { op: "struct.get", typeIdx: d.capsuleType, fieldIdx },
];
const sameGeneration = (d: PrimitivePrototypeIdentityOperands): Instr[] => [
  ...capsuleField(d, 0),
  global(d.realmGlobal),
  { op: "ref.eq" },
  ...capsuleField(d, 1),
  global(d.objectPrototypeGlobal),
  { op: "ref.eq" },
  { op: "i32.and" },
];
const baseGuard = (d: PrimitivePrototypeIdentityOperands): Instr[] => [
  global(d.realmGlobal),
  { op: "ref.is_null" },
  when([{ op: "unreachable" }]),
  global(d.objectPrototypeGlobal),
  { op: "ref.is_null" },
  when([{ op: "unreachable" }]),
  global(d.objectPrototypeGlobal),
  { op: "extern.convert_any" },
  call(d.classify),
  { op: "i32.const", value: 0 },
  { op: "i32.le_s" },
  when([{ op: "unreachable" }]),
];

/** No user callback/coercion; the sole publication occurs after all allocations. */
export function buildPrimitivePrototypeIdentityInitializer(
  d: PrimitivePrototypeIdentityOperands,
): BuiltinFunctionDefinition {
  const parent = (): Instr[] => [global(d.objectPrototypeGlobal), { op: "extern.convert_any" }];
  const allocate = (body: Instr[], index: number): Instr[] => [...parent(), ...body, { op: "local.set", index }];
  return {
    locals: NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => ({ name: row.kind, type: { kind: "externref" } })),
    body: [
      ...baseGuard(d),
      global(d.capsuleGlobal),
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      when([...sameGeneration(d), when([{ op: "return" }])]),
      ...allocate([{ op: "i32.const", value: 0 }, call(d.booleanAllocation)], 0),
      ...allocate([{ op: "f64.const", value: 0 }, call(d.numberAllocation)], 1),
      ...allocate([...structuredClone(d.emptyString), call(d.stringCreate)], 2),
      ...allocate([call(d.ordinaryAllocation)], 3),
      ...allocate([call(d.ordinaryAllocation)], 4),
      global(d.realmGlobal),
      { op: "ref.as_non_null" },
      global(d.objectPrototypeGlobal),
      { op: "ref.as_non_null" },
      ...NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((_, index): Instr => ({ op: "local.get", index })),
      { op: "struct.new", typeIdx: d.capsuleType },
      { op: "global.set", index: d.capsuleGlobal },
    ],
  };
}
export function buildPrimitivePrototypeIdentityRead(
  d: PrimitivePrototypeIdentityOperands,
  kind: NativePrimitivePrototypeKind,
): BuiltinFunctionDefinition {
  const index = NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.findIndex((row) => row.kind === kind);
  if (index < 0) throw Error("primitive prototype identity: invalid fixed role");
  return {
    locals: [],
    body: [
      ...baseGuard(d),
      global(d.capsuleGlobal),
      { op: "ref.is_null" },
      when([{ op: "unreachable" }]),
      ...sameGeneration(d),
      { op: "i32.eqz" },
      when([{ op: "unreachable" }]),
      ...capsuleField(d, index + 2),
    ],
  };
}
