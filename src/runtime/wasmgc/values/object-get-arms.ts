// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr } from "../../../wasm/model/instructions.js";

/** Captured operands, not evidence of a completed native resource owner. */
export interface TemplateRawReadBinding {
  readonly testStringType: number;
  readonly castStringType: number;
  readonly vectorType: number;
  readonly flatten: FuncHandle;
  readonly equals: FuncHandle;
  readonly rawLiteral: readonly Instr[];
}

export type ProtoIndexReadBinding =
  | { readonly kind: "direct"; readonly receiver: number; readonly key: number; readonly get: FuncHandle }
  | {
      readonly kind: "split-receiver";
      readonly receiver: number;
      readonly key: number;
      readonly accessorReceiver: number;
      readonly brandOffset: FuncHandle;
      readonly getKey: FuncHandle;
    };

export interface GeneratorReadBinding {
  readonly get: FuncHandle;
  readonly valueLocal: number;
}

export interface InstanceReadBinding {
  readonly isCarrier: FuncHandle;
  readonly get: FuncHandle;
  readonly scratchLocal: number;
  readonly generator: GeneratorReadBinding | undefined;
}

export type ClosureReadBinding =
  | { readonly kind: "legacy-missing"; readonly undefinedValue: readonly Instr[] }
  | {
      readonly kind: "closure";
      readonly get: FuncHandle;
      readonly companion: { readonly isCarrier: FuncHandle; readonly read: ProtoIndexReadBinding } | undefined;
    };

export interface VecOrClosureReadBinding {
  readonly vector:
    | {
        readonly isCarrier: FuncHandle;
        readonly get: FuncHandle;
        readonly accessorReceiver?: number;
      }
    | undefined;
  readonly closure: ClosureReadBinding;
}

export interface ReversePeerReadBinding {
  readonly get: FuncHandle;
  readonly ownedGlobal: number;
}

export function buildTemplateRawRead(binding: TemplateRawReadBinding | undefined): Instr[] {
  if (binding === undefined) return [];
  return [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: binding.testStringType },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: binding.castStringType },
        { op: "call", funcIdx: binding.flatten },
        ...binding.rawLiteral,
        { op: "call", funcIdx: binding.equals },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 4 },
            { op: "ref.test", typeIdx: binding.vectorType },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 4 },
                { op: "ref.cast", typeIdx: binding.vectorType },
                { op: "struct.get", typeIdx: binding.vectorType, fieldIdx: 2 },
                { op: "extern.convert_any" },
                { op: "return" },
              ],
            },
          ],
        },
      ],
    },
  ];
}

export function buildProtoIndexRead(binding: ProtoIndexReadBinding | undefined): Instr[] | undefined {
  if (binding === undefined) return undefined;
  if (binding.kind === "split-receiver") {
    return [
      { op: "local.get", index: binding.accessorReceiver },
      { op: "local.get", index: binding.key },
      { op: "local.get", index: binding.receiver },
      { op: "call", funcIdx: binding.brandOffset },
      { op: "call", funcIdx: binding.getKey },
    ];
  }
  return [
    { op: "local.get", index: binding.receiver },
    { op: "local.get", index: binding.key },
    { op: "call", funcIdx: binding.get },
  ];
}

export function buildGeneratorRead(binding: GeneratorReadBinding | undefined): Instr[] {
  if (binding === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: binding.get },
    { op: "local.set", index: binding.valueLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: binding.valueLocal }, { op: "return" }],
      else: [],
    },
  ];
}

export function buildInstanceRead(binding: InstanceReadBinding | undefined): Instr[] {
  if (binding === undefined) return [];
  return [
    ...buildGeneratorRead(binding.generator),
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: binding.isCarrier },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: binding.get },
        { op: "local.tee", index: binding.scratchLocal },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: binding.scratchLocal }, { op: "return" }],
        },
      ],
    },
  ];
}

export function buildClosureRead(binding: ClosureReadBinding): Instr[] {
  if (binding.kind === "legacy-missing") return [...binding.undefinedValue, { op: "return" }];
  return [
    ...(binding.companion === undefined
      ? []
      : ([
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: binding.companion.isCarrier },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...buildProtoIndexRead(binding.companion.read)!, { op: "return" }],
          },
        ] satisfies Instr[])),
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: binding.get },
    { op: "return" },
  ];
}

export function buildVecOrClosureRead(binding: VecOrClosureReadBinding): Instr[] {
  const closureArm = buildClosureRead(binding.closure);
  if (binding.vector === undefined) return closureArm;
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: binding.vector.isCarrier },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        ...(binding.vector.accessorReceiver === undefined
          ? []
          : [{ op: "local.get", index: binding.vector.accessorReceiver } as Instr]),
        { op: "call", funcIdx: binding.vector.get },
        { op: "return" },
      ],
    },
    ...closureArm,
  ];
}

/** The owned channel makes a present null distinguishable from an unhandled read. */
export function buildReversePeerRead(binding: ReversePeerReadBinding | undefined, resultLocal: number): Instr[] {
  if (binding === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: binding.get },
    { op: "local.tee", index: resultLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: binding.ownedGlobal },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: resultLocal }, { op: "return" }],
        },
      ],
      else: [{ op: "local.get", index: resultLocal }, { op: "return" }],
    },
  ];
}
