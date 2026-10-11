// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, GlobalHandle, Instr, LocalDef, TypeHandle } from "../../../wasm/model/instructions.js";
import { buildOrdinaryObjectDataDescriptorBody } from "./ordinary-object-descriptor-data.js";
import {
  buildOrdinaryObjectAccessorDescriptorBody,
  type OrdinaryAccessorDescriptorResources,
} from "./ordinary-object-descriptor-accessor.js";
import {
  descriptorFlagBit,
  descriptorTypeError,
  type OrdinaryDescriptorResources,
  type OrdinaryDescriptorErrors,
} from "./ordinary-object-descriptor-common.js";
import { buildClosureUndefinedTest } from "./closure-receiver-bodies.js";

/** Exact local coordinates of the retained return-object donor bodies. */
function locals(d: OrdinaryDescriptorResources): LocalDef[] {
  return [
    { name: "o", type: { kind: "ref_null", typeIdx: d.objectTypeIdx } },
    { name: "any", type: { kind: "anyref" } },
    ...["cap", "load", "nflags", "hf", "seq"].map((name) => ({ name, type: { kind: "i32" } as const })),
    { name: "e", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
    { name: "efl", type: { kind: "i32" } },
  ];
}
export function buildOrdinaryDataDescriptorDefinition(
  d: OrdinaryDescriptorResources,
  undefinedAnyValue: readonly Instr[],
) {
  return {
    locals: locals(d),
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 5 },
      ...buildOrdinaryObjectDataDescriptorBody(d, undefinedAnyValue),
    ] as Instr[],
  };
}
export function buildOrdinaryAccessorDescriptorDefinition(d: OrdinaryAccessorDescriptorResources) {
  return {
    locals: [
      ...locals(d),
      { name: "getSpec", type: { kind: "i32" } as const },
      { name: "setSpec", type: { kind: "i32" } as const },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 6 },
      ...buildOrdinaryObjectAccessorDescriptorBody(d),
    ] as Instr[],
  };
}

export interface OrdinaryDescriptorCallBindings {
  readonly objectTypeIdx: TypeHandle;
  readonly anyValueTypeIdx: TypeHandle;
  readonly closureRootTypeIdx: TypeHandle;
  readonly undefinedGlobalIdx: GlobalHandle;
  readonly dataIdx: FuncHandle;
  readonly accessorIdx: FuncHandle;
  /** Receiver/mask/callable validation literals, not prebuilt semantic arms. */
  readonly errors: OrdinaryDescriptorErrors;
}
function undefinedValue(d: OrdinaryDescriptorCallBindings): Instr[] {
  return [{ op: "global.get", index: d.undefinedGlobalIdx }, { op: "extern.convert_any" }];
}
function preflight(d: OrdinaryDescriptorCallBindings, flagLocal: number, allowed: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: d.objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: descriptorTypeError(d.errors, 0) },
    // Reject NaN, fractional, negative or undeclared bits before trapping conversion.
    { op: "local.get", index: flagLocal },
    { op: "f64.const", value: 0 },
    { op: "f64.ge" },
    { op: "local.get", index: flagLocal },
    { op: "f64.const", value: allowed },
    { op: "f64.le" },
    { op: "i32.and" },
    { op: "local.get", index: flagLocal },
    { op: "f64.trunc" },
    { op: "local.get", index: flagLocal },
    { op: "f64.eq" },
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: descriptorTypeError(d.errors, 1) },
    { op: "local.get", index: flagLocal },
    { op: "i32.trunc_f64_s" },
    { op: "i32.const", value: ~allowed },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: descriptorTypeError(d.errors, 1) },
  ];
}

/** Canonical void ABI. The donor's return object is consumed, never misbound as void. */
export function buildOrdinaryDefineDataDefinition(d: OrdinaryDescriptorCallBindings): {
  locals: LocalDef[];
  body: Instr[];
} {
  return {
    locals: [{ name: "flags", type: { kind: "i32" } }],
    body: [
      ...preflight(d, 3, 191),
      { op: "local.get", index: 3 },
      { op: "i32.trunc_f64_s" },
      { op: "local.set", index: 4 },
      ...descriptorFlagBit(4, 128),
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...undefinedValue(d), { op: "local.set", index: 2 }],
      },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "f64.convert_i32_s" },
      { op: "call", funcIdx: d.dataIdx },
      { op: "drop" },
    ],
  };
}

function normalizeHalf(d: OrdinaryDescriptorCallBindings, local: number, bit: number): Instr[] {
  return [
    { op: "local.get", index: 4 },
    { op: "i32.trunc_f64_s" },
    { op: "i32.const", value: bit },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...buildClosureUndefinedTest(local, d.anyValueTypeIdx),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "ref.null.extern" }, { op: "local.set", index: local }],
          else: [
            { op: "local.get", index: local },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: d.closureRootTypeIdx },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: descriptorTypeError(d.errors, 2) },
          ],
        },
      ],
      else: [{ op: "ref.null.extern" }, { op: "local.set", index: local }],
    },
  ];
}
export function buildOrdinaryDefineAccessorDefinition(d: OrdinaryDescriptorCallBindings): {
  locals: LocalDef[];
  body: Instr[];
} {
  return {
    locals: [],
    body: [
      ...preflight(d, 4, 822),
      { op: "local.get", index: 4 },
      { op: "i32.trunc_f64_s" },
      { op: "i32.const", value: 768 },
      { op: "i32.and" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: descriptorTypeError(d.errors, 1) },
      ...normalizeHalf(d, 2, 256),
      ...normalizeHalf(d, 3, 512),
      ...[0, 1, 2, 3, 4].map((index): Instr => ({ op: "local.get", index })),
      { op: "call", funcIdx: d.accessorIdx },
      { op: "drop" },
    ],
  };
}
export function buildOrdinaryDefineAttributesDefinition(
  d: OrdinaryDescriptorCallBindings,
  defineDataIdx: FuncHandle,
): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [],
    body: [
      ...preflight(d, 2, 54),
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      ...undefinedValue(d),
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: defineDataIdx },
    ],
  };
}
