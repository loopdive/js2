// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Receiver-capable SOURCE getter closures, separate from ordinary ClosureInfo. */
import type { GlobalDef, Instr, WasmFunction } from "../../ir/types.js";
import type { IrUnitId } from "../../ir/identity.js";
import type { CodegenContext } from "../context/types.js";
import { definedFuncHandleOf } from "../func-space.js";
import { ensureFnMetaSubtype, fnMetaField, registerFnMetaFamily } from "../function-instance-meta.js";
import { addFuncType } from "../registry/types.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { ensureGetUndefined } from "../expressions/late-imports.js";
import { getOrCreateFuncRefWrapperTypes } from "./funcref-wrapper-types.js";

interface SourceGetterReceiverFamily {
  readonly rootTypeIdx: number;
  readonly structTypeIdx: number;
  readonly capabilityTypeIdx: number;
  readonly funcTypeIdx: number;
  readonly bareFuncTypeIdx: number;
  readonly bareInfoTypeIdx: number;
  readonly capability: GlobalDef;
  readonly records: SourceGetterReceiverRecord[];
}

interface SourceGetterReceiverRecord {
  readonly sourceUnitId: IrUnitId;
  readonly cache: GlobalDef;
  readonly wrapper: WasmFunction;
  readonly bareWrapper: WasmFunction;
  readonly sourceBody: WasmFunction;
}

// Preparation-only ownership. Emitted instructions retain actual module handles;
// this map is not queried after physical type/global finalization or linking.
const families = new WeakMap<CodegenContext, SourceGetterReceiverFamily>();

/**
 * Uniform structural recognition is needed even in a caller with no local
 * getter. Ownership still requires an exact local cache record below; a foreign
 * SOURCE value is explicitly refused, never interpreted as an ordinary arg0.
 */
export function prepareSourceGetterReceiverFamily(ctx: CodegenContext): SourceGetterReceiverFamily {
  const existing = families.get(ctx);
  if (existing) return existing;
  ensureGetUndefined(ctx);
  const ordinary = getOrCreateFuncRefWrapperTypes(ctx, [], [{ kind: "externref" }], "support");
  if (!ordinary) throw new Error("SOURCE getter receiver has no canonical closure root");
  const rootTypeIdx = ordinary.liftedSelfTypeIdx;
  const root = ctx.mod.types[rootTypeIdx];
  if (!root || root.kind !== "struct" || root.fields.length !== 3) {
    throw new Error("SOURCE getter receiver requires the canonical func/arity/bag header");
  }
  const capabilityTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "__source_getter_receiver_capability",
    element: { kind: "i8" },
    mutable: false,
  });
  let metadataBaseTypeIdx = ensureFnMetaSubtype(ctx, ordinary.structTypeIdx);
  if (metadataBaseTypeIdx === undefined) {
    const base = ctx.mod.types[ordinary.structTypeIdx];
    if (!base || base.kind !== "struct" || base.fields.length !== 3)
      throw new Error("SOURCE getter has no exact signature wrapper");
    const metadataField = fnMetaField(ctx);
    metadataBaseTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name: "__source_getter_metadata_base",
      superTypeIdx: ordinary.structTypeIdx,
      fields: [...base.fields, metadataField],
    });
    registerFnMetaFamily(ctx, metadataBaseTypeIdx, 3);
  }
  const metadataBase = ctx.mod.types[metadataBaseTypeIdx];
  if (!metadataBase || metadataBase.kind !== "struct" || metadataBase.fields.length !== 4)
    throw new Error("SOURCE getter has no exact metadata prefix");
  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__source_getter_receiver_closure",
    superTypeIdx: metadataBaseTypeIdx,
    fields: [
      ...metadataBase.fields,
      { name: "__source_receiver_capability", type: { kind: "ref", typeIdx: capabilityTypeIdx }, mutable: false },
      { name: "__source_receiver_entry", type: { kind: "funcref" }, mutable: false },
    ],
  });
  registerFnMetaFamily(ctx, structTypeIdx, 3);
  const funcTypeIdx = addFuncType(
    ctx,
    [{ kind: "ref", typeIdx: rootTypeIdx }, { kind: "externref" }, { kind: "ref", typeIdx: capabilityTypeIdx }],
    [{ kind: "externref" }],
    "__source_getter_receiver_entry",
  );
  const capability: GlobalDef = {
    name: "__source_getter_receiver_authority",
    type: { kind: "ref", typeIdx: capabilityTypeIdx },
    mutable: false,
    init: [{ op: "array.new_fixed", typeIdx: capabilityTypeIdx, length: 0 }],
  };
  ctx.mod.globals.push(capability);
  const family = {
    rootTypeIdx,
    structTypeIdx,
    capabilityTypeIdx,
    funcTypeIdx,
    bareFuncTypeIdx: ordinary.liftedFuncTypeIdx,
    bareInfoTypeIdx: ordinary.structTypeIdx,
    capability,
    records: [],
  };
  families.set(ctx, family);
  return family;
}

function globalIndex(ctx: CodegenContext, global: GlobalDef): number {
  const local = ctx.mod.globals.indexOf(global);
  if (local < 0) throw new Error("SOURCE getter receiver lost its exact global allocator");
  return ctx.numImportGlobals + local;
}

export function sourceGetterReceiverCapability(ctx: CodegenContext): Instr[] {
  return [{ op: "global.get", index: globalIndex(ctx, prepareSourceGetterReceiverFamily(ctx).capability) }];
}

export function sourceGetterReceiverUndefined(ctx: CodegenContext): Instr[] {
  prepareSourceGetterReceiverFamily(ctx);
  return canonicalUndefinedExternInstrs(ctx);
}

export function sourceGetterReceiverFamilyType(ctx: CodegenContext): number {
  return prepareSourceGetterReceiverFamily(ctx).structTypeIdx;
}

/** Validate the complete ordinary allocation registry, not a family-name list. */
export function assertSourceGetterReceiverSignatureSeparation(ctx: CodegenContext): void {
  prepareSourceGetterReceiverFamily(ctx);
  for (const info of ctx.closureInfoByTypeIdx.values()) {
    const signature = ctx.mod.types[info.funcTypeIdx];
    if (!signature || signature.kind !== "func" || signature.params.length !== 3) continue;
    const receiver = signature.params[1];
    const token = signature.params[2];
    if (receiver?.kind !== "externref" || (token?.kind !== "ref" && token?.kind !== "ref_null")) continue;
    const type = ctx.mod.types[token.typeIdx];
    if (type?.kind === "array" && type.element.kind === "i8" && !type.mutable) {
      throw new Error("ordinary ClosureInfo collides with the reserved SOURCE getter receiver ABI");
    }
  }
}

/** The caller has already joined source declaration/UnitId and both functions. */
export function observeSourceGetterReceiverClosure(ctx: CodegenContext, record: SourceGetterReceiverRecord): void {
  const family = prepareSourceGetterReceiverFamily(ctx);
  const sourceSignature = ctx.mod.types[record.sourceBody.typeIdx];
  if (
    definedFuncHandleOf(ctx, record.wrapper) === undefined ||
    definedFuncHandleOf(ctx, record.bareWrapper) === undefined ||
    definedFuncHandleOf(ctx, record.sourceBody) === undefined ||
    record.wrapper.typeIdx !== family.funcTypeIdx ||
    record.bareWrapper.typeIdx !== family.bareFuncTypeIdx ||
    !ctx.mod.globals.includes(record.cache) ||
    sourceSignature?.kind !== "func" ||
    sourceSignature.params.length !== 1 ||
    sourceSignature.params[0]?.kind !== "externref" ||
    sourceSignature.results.length !== 1 ||
    sourceSignature.results[0]?.kind !== "externref"
  ) {
    throw new Error("SOURCE getter receiver does not match its actual callable/cache allocators");
  }
  const prior = family.records.find((row) => row.cache === record.cache);
  if (prior) {
    if (
      prior.wrapper !== record.wrapper ||
      prior.bareWrapper !== record.bareWrapper ||
      prior.sourceBody !== record.sourceBody ||
      prior.sourceUnitId !== record.sourceUnitId
    ) {
      throw new Error("SOURCE getter receiver cache has conflicting source ownership");
    }
    return;
  }
  family.records.push(record);
}

/**
 * Insert AFTER callable/facade recovery but BEFORE normalized-this publication.
 * This path does not mutate __current_this; nesting and abrupt completion keep
 * the caller's receiver untouched. Argument-state setup uses SOURCE arity zero.
 */
export function buildSourceGetterReceiverDispatch(
  ctx: CodegenContext,
  closureAnyLocal: number,
  rawReceiver: readonly Instr[],
  argumentState: readonly Instr[],
  failure: readonly Instr[],
  success: Instr = { op: "return" },
): Instr[] {
  const family = prepareSourceGetterReceiverFamily(ctx);
  const source: Instr[] = [];
  for (const record of family.records) {
    const handle = definedFuncHandleOf(ctx, record.wrapper);
    if (handle === undefined || record.wrapper.typeIdx !== family.funcTypeIdx) {
      throw new Error("SOURCE getter receiver wrapper changed before dispatcher binding");
    }
    const cache = globalIndex(ctx, record.cache);
    source.push(
      { op: "global.get", index: cache },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      { op: "global.get", index: cache },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: family.structTypeIdx },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: closureAnyLocal },
          { op: "ref.cast", typeIdx: family.structTypeIdx },
          { op: "global.get", index: cache },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: family.structTypeIdx },
          { op: "ref.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...structuredClone(argumentState),
              { op: "local.get", index: closureAnyLocal },
              { op: "ref.cast", typeIdx: family.rootTypeIdx },
              ...structuredClone(rawReceiver),
              ...sourceGetterReceiverCapability(ctx),
              { op: "call", funcIdx: handle },
              structuredClone(success),
            ],
          },
        ],
      },
    );
  }
  source.push(...structuredClone(failure));
  return [
    { op: "local.get", index: closureAnyLocal },
    { op: "ref.test", typeIdx: family.structTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: source },
    // A clone/linked wrapper with the private raw-receiver function signature
    // but without our SOURCE layout must not reach ordinary signature dispatch.
    { op: "local.get", index: closureAnyLocal },
    { op: "ref.test", typeIdx: family.rootTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: closureAnyLocal },
        { op: "ref.cast", typeIdx: family.rootTypeIdx },
        { op: "struct.get", typeIdx: family.rootTypeIdx, fieldIdx: 0 },
        { op: "ref.test", typeIdx: family.funcTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: [...structuredClone(failure)] },
      ],
    },
  ];
}

/** Expression form: the three nested ownership guards exit this result block. */
export function buildSourceGetterReceiverValueCall(
  ctx: CodegenContext,
  closureAnyLocal: number,
  rawReceiver: readonly Instr[],
  argumentState: readonly Instr[],
  failure: readonly Instr[],
): Instr[] {
  return [
    {
      op: "block",
      blockType: { kind: "val", type: { kind: "externref" } },
      body: [
        ...buildSourceGetterReceiverDispatch(ctx, closureAnyLocal, rawReceiver, argumentState, failure, {
          op: "br",
          depth: 3,
        }),
        ...structuredClone(failure),
      ],
    },
  ];
}
