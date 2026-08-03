// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { ASYNC_RUNTIME_FEATURES } from "./async-runtime-providers.js";
import { asAsyncStateId, canonicalPromiseAbi, createIrAsyncPlan } from "./async-plan.js";
import { irUnitFuncRef } from "./callable-bindings.js";
import { createDerivedIrUnitId, type IrDerivedUnitProvenance } from "./identity.js";
import {
  asBlockId,
  asValueId,
  forEachInstrDeep,
  irTypeEquals,
  irVal,
  mapNestedBuffers,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrValueId,
} from "./nodes.js";

const EXTERNREF = irVal({ kind: "externref" });

/**
 * First production suspension shape. It is deliberately syntax-small so the
 * selector and the post-build IR transform can prove the same two-state graph:
 *
 *   const value = await expression;
 *   return value;
 */
export function isSingleAwaitReturnAsyncCandidate(fn: ts.FunctionLikeDeclaration): boolean {
  if (!ts.isFunctionDeclaration(fn) || fn.asteriskToken || !fn.body) return false;
  if (!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  if (fn.body.statements.length !== 2) return false;
  const declarationStatement = fn.body.statements[0];
  const returned = fn.body.statements[1];
  if (
    !declarationStatement ||
    !ts.isVariableStatement(declarationStatement) ||
    declarationStatement.declarationList.declarations.length !== 1 ||
    !returned ||
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isIdentifier(returned.expression)
  ) {
    return false;
  }
  const declaration = declarationStatement.declarationList.declarations[0]!;
  return (
    ts.isIdentifier(declaration.name) &&
    declaration.initializer !== undefined &&
    ts.isAwaitExpression(declaration.initializer) &&
    returned.expression.text === declaration.name.text
  );
}

export interface PreparedSingleAwaitIrFunction {
  readonly main: IrFunction;
  readonly stateFunctions: readonly IrFunction[];
  readonly provenance: readonly IrDerivedUnitProvenance[];
}

function valueTypesOf(fn: IrFunction): Map<IrValueId, IrType> {
  const types = new Map(fn.params.map((param) => [param.value, param.type] as const));
  for (const block of fn.blocks) {
    for (let index = 0; index < block.blockArgs.length; index++) {
      types.set(block.blockArgs[index]!, block.blockArgTypes[index]!);
    }
    for (const instr of block.instrs) {
      if (instr.result !== null && instr.resultType !== null) types.set(instr.result, instr.resultType);
    }
  }
  return types;
}

function usedSlotIndices(instrs: readonly IrInstr[]): ReadonlySet<number> {
  const used = new Set<number>();
  for (const instr of instrs) {
    forEachInstrDeep(instr, (nested) => {
      if (nested.kind === "slot.read" || nested.kind === "slot.write") used.add(nested.slotIndex);
    });
  }
  return used;
}

function remapUsedSlots(
  fn: IrFunction,
  instrs: readonly IrInstr[],
  used = usedSlotIndices(instrs),
): { readonly instrs: readonly IrInstr[]; readonly slots?: IrFunction["slots"] } {
  if (used.size === 0) return { instrs };
  const oldIndices = [...used].sort((left, right) => left - right);
  const remap = new Map(oldIndices.map((oldIndex, newIndex) => [oldIndex, newIndex] as const));
  const slots = oldIndices.map((oldIndex, newIndex) => {
    const slot = fn.slots?.[oldIndex];
    if (!slot || slot.index !== oldIndex) {
      throw new Error(`IR async function ${fn.name} lost slot ${oldIndex} while splitting its suspension`);
    }
    return { ...slot, index: newIndex };
  });
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, (buffer) => buffer.map(mapInstr));
    if (nested.kind !== "slot.read" && nested.kind !== "slot.write") return nested;
    const slotIndex = remap.get(nested.slotIndex);
    if (slotIndex === undefined) {
      throw new Error(`IR async function ${fn.name} could not remap slot ${nested.slotIndex}`);
    }
    return { ...nested, slotIndex };
  };
  return { instrs: instrs.map(mapInstr), slots };
}

/**
 * Turn the exact one-await IR into a semantic two-state plan plus one derived
 * ordinary IR helper. The helper owns all pre-await computation; the async
 * backend only needs to invoke it, suspend on its Promise result, and settle
 * the source function with the delivered value.
 */
export function prepareSingleAwaitIrFunction(fn: IrFunction): PreparedSingleAwaitIrFunction | null {
  if (fn.funcKind !== "async" || fn.asyncPlan || fn.blocks.length !== 1 || fn.resultTypes.length !== 1) return null;
  const block = fn.blocks[0]!;
  if (block.blockArgs.length !== 0 || block.terminator.kind !== "return" || block.terminator.values.length !== 1) {
    return null;
  }
  const awaitIndices = block.instrs.flatMap((instr, index) => (instr.kind === "await" ? [index] : []));
  if (awaitIndices.length !== 1) return null;
  const awaitIndex = awaitIndices[0]!;
  const awaited = block.instrs[awaitIndex]!;
  if (
    awaited.kind !== "await" ||
    awaited.result === null ||
    awaited.resultType === null ||
    block.terminator.values[0] === undefined
  ) {
    return null;
  }
  const valueTypes = valueTypesOf(fn);
  const operandType = valueTypes.get(awaited.operand);
  if (
    !operandType ||
    (!irTypeEquals(operandType, EXTERNREF) && !(operandType.kind === "extern" && operandType.className === "Promise"))
  ) {
    return null;
  }

  const role = "ir-async-state" as const;
  const stateUnitId = createDerivedIrUnitId({ parentId: fn.unitId, role, ordinal: 0 });
  const stateName = `${fn.name}__ir_async_state_0`;
  const prefixInstrs = block.instrs.slice(0, awaitIndex);
  const suffixInstrs = block.instrs.slice(awaitIndex + 1);
  const prefixSlots = usedSlotIndices(prefixInstrs);
  const suffixSlots = usedSlotIndices(suffixInstrs);
  if ([...prefixSlots].some((slotIndex) => suffixSlots.has(slotIndex))) {
    // The first prepared frame contract has no spills. Independently reject a
    // mutable local whose slot would otherwise be cloned into unrelated entry
    // and continuation helpers and silently lose its pre-await value.
    return null;
  }
  const prefix = remapUsedSlots(fn, prefixInstrs, prefixSlots);
  const entryFunction: IrFunction = {
    unitId: stateUnitId,
    name: stateName,
    params: fn.params.map((param) => ({ ...param })),
    resultTypes: [operandType],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: prefix.instrs,
        terminator: { kind: "return", values: [awaited.operand] },
      },
    ],
    exported: false,
    valueCount: fn.valueCount,
    ...(prefix.slots ? { slots: prefix.slots } : {}),
    funcKind: "regular",
  };

  const suffix = remapUsedSlots(fn, suffixInstrs, suffixSlots);
  const returned = block.terminator.values[0]!;
  const fulfillmentType = fn.resultTypes[0]!;
  const carrierUnbox = suffix.instrs.length === 1 ? suffix.instrs[0] : undefined;
  const elidesNumericCarrierRoundTrip =
    carrierUnbox?.kind === "call" &&
    carrierUnbox.target.name === "__unbox_number" &&
    carrierUnbox.target.binding.kind === "import" &&
    carrierUnbox.target.binding.module === "env" &&
    carrierUnbox.target.binding.field === "__unbox_number" &&
    carrierUnbox.args.length === 1 &&
    carrierUnbox.args[0] === awaited.result &&
    carrierUnbox.result === returned &&
    carrierUnbox.resultType !== null &&
    irTypeEquals(carrierUnbox.resultType, fulfillmentType);
  const directIdentity =
    suffix.instrs.length === 0 && returned === awaited.result && irTypeEquals(awaited.resultType, fulfillmentType);
  const identityContinuation = directIdentity || elidesNumericCarrierRoundTrip;
  // The frame carrier delivers an externref, but the canonical Promise ABI
  // already represents its fulfillment as T. Avoid the direct backend's
  // redundant externref→f64→externref round trip for the exact numeric tail.
  const resumedType = elidesNumericCarrierRoundTrip ? fulfillmentType : awaited.resultType;
  const continuationUnitId = identityContinuation
    ? null
    : createDerivedIrUnitId({ parentId: fn.unitId, role, ordinal: 1 });
  const continuationName = `${fn.name}__ir_async_state_1`;
  const continuationFunction: IrFunction | null = continuationUnitId
    ? {
        unitId: continuationUnitId,
        name: continuationName,
        params: [{ name: "__resumed", type: resumedType, value: awaited.result }],
        resultTypes: [fulfillmentType],
        blocks: [
          {
            id: asBlockId(0),
            blockArgs: [],
            blockArgTypes: [],
            instrs: suffix.instrs,
            terminator: { kind: "return", values: [returned] },
          },
        ],
        exported: false,
        valueCount: fn.valueCount,
        ...(suffix.slots ? { slots: suffix.slots } : {}),
        funcKind: "regular",
      }
    : null;

  const helperResult = asValueId(fn.valueCount);
  const resumed = asValueId(fn.valueCount + 1);
  const resolved = asValueId(fn.valueCount + 2);
  const asyncPlan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: fn.unitId,
    kind: "async-function",
    abi: canonicalPromiseAbi(fulfillmentType),
    entry: asAsyncStateId(0),
    params: fn.params.map((param) => ({ value: param.value, type: param.type })),
    values: [
      ...fn.params.map((param) => ({ value: param.value, type: param.type })),
      { value: helperResult, type: operandType },
      { value: resumed, type: resumedType },
      ...(continuationFunction ? [{ value: resolved, type: fulfillmentType }] : []),
    ],
    spills: [],
    states: [
      {
        id: asAsyncStateId(0),
        body: [
          {
            kind: "call",
            target: irUnitFuncRef({ unitId: stateUnitId, name: stateName }),
            args: fn.params.map((param) => param.value),
            result: helperResult,
            resultType: operandType,
          },
        ],
        terminator: {
          kind: "suspend",
          awaited: helperResult,
          resume: { state: asAsyncStateId(1), value: resumed },
          rejected: { kind: "reject" },
          live: [],
        },
      },
      {
        id: asAsyncStateId(1),
        resume: { value: resumed, type: resumedType, source: "fulfilled" },
        body: continuationFunction
          ? [
              {
                kind: "call",
                target: irUnitFuncRef({ unitId: continuationFunction.unitId, name: continuationFunction.name }),
                args: [resumed],
                result: resolved,
                resultType: fulfillmentType,
              },
            ]
          : [],
        terminator: { kind: "resolve", value: continuationFunction ? resolved : resumed },
      },
    ],
    handlers: [],
    runtimeIntents: ASYNC_RUNTIME_FEATURES,
  });

  return {
    main: {
      ...fn,
      blocks: [
        {
          id: block.id,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "unreachable" },
        },
      ],
      slots: undefined,
      asyncPlan,
    },
    stateFunctions: continuationFunction ? [entryFunction, continuationFunction] : [entryFunction],
    provenance: [
      { id: stateUnitId, parentId: fn.unitId, role, ordinal: 0 },
      ...(continuationFunction
        ? [{ id: continuationFunction.unitId, parentId: fn.unitId, role, ordinal: 1 } as const]
        : []),
    ],
  };
}
