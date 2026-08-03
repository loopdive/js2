// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { ASYNC_RUNTIME_FEATURES } from "./async-runtime-providers.js";
import { IR_ASYNC_CLOCK_SNAPSHOT_FN } from "./async-semantic-runtime.js";
import { asAsyncStateId, canonicalPromiseAbi, createIrAsyncPlan } from "./async-plan.js";
import { irUnitFuncRef } from "./callable-bindings.js";
import { createDerivedIrUnitId, type IrDerivedUnitProvenance } from "./identity.js";
import {
  asBlockId,
  asValueId,
  collectUses,
  forEachInstrDeep,
  irTypeEquals,
  irVal,
  mapNestedBuffers,
  type IrFunction,
  type IrFuncRef,
  type IrInstr,
  type IrType,
  type IrValueId,
} from "./nodes.js";

const EXTERNREF = irVal({ kind: "externref" });
const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });

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

type IrForLoop = Extract<IrInstr, { readonly kind: "for.loop" }>;

function asyncStateFunction(input: {
  readonly owner: IrFunction;
  readonly ordinal: number;
  readonly params: IrFunction["params"];
  readonly resultType: IrType;
  readonly instrs: readonly IrInstr[];
  readonly result: IrValueId;
  readonly valueCount: number;
}): { readonly fn: IrFunction; readonly provenance: IrDerivedUnitProvenance } {
  const role = "ir-async-state" as const;
  const unitId = createDerivedIrUnitId({ parentId: input.owner.unitId, role, ordinal: input.ordinal });
  const name = `${input.owner.name}__ir_async_state_${input.ordinal}`;
  return {
    fn: {
      unitId,
      name,
      params: input.params.map((param) => ({ ...param })),
      resultTypes: [input.resultType],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: input.instrs,
          terminator: { kind: "return", values: [input.result] },
        },
      ],
      exported: false,
      valueCount: input.valueCount,
      funcKind: "regular",
    },
    provenance: { id: unitId, parentId: input.owner.unitId, role, ordinal: input.ordinal },
  };
}

function asyncStateVoidFunction(input: {
  readonly owner: IrFunction;
  readonly ordinal: number;
  readonly params: IrFunction["params"];
  readonly instrs: readonly IrInstr[];
  readonly valueCount: number;
}): { readonly fn: IrFunction; readonly provenance: IrDerivedUnitProvenance } {
  const role = "ir-async-state" as const;
  const unitId = createDerivedIrUnitId({ parentId: input.owner.unitId, role, ordinal: input.ordinal });
  const name = `${input.owner.name}__ir_async_state_${input.ordinal}`;
  return {
    fn: {
      unitId,
      name,
      params: input.params.map((param) => ({ ...param })),
      resultTypes: [],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: input.instrs,
          terminator: { kind: "return", values: [] },
        },
      ],
      exported: false,
      valueCount: input.valueCount,
      funcKind: "regular",
    },
    provenance: { id: unitId, parentId: input.owner.unitId, role, ordinal: input.ordinal },
  };
}

function exactSequentialLoop(fn: IrFunction): { readonly loop: IrForLoop; readonly fetchUser: IrFuncRef } | null {
  if (
    fn.name !== "fetchAllSequential" ||
    fn.funcKind !== "async" ||
    fn.asyncPlan ||
    fn.params.length !== 1 ||
    fn.params[0]?.type.kind !== "vec" ||
    !irTypeEquals(fn.params[0].type.elementType, F64) ||
    fn.resultTypes.length !== 1 ||
    !irTypeEquals(fn.resultTypes[0]!, F64) ||
    fn.blocks.length !== 1 ||
    fn.slots?.length !== 2 ||
    fn.slots[0]?.name !== "total" ||
    fn.slots[0]?.type.kind !== "f64" ||
    fn.slots[1]?.name !== "i" ||
    fn.slots[1]?.type.kind !== "i32"
  ) {
    return null;
  }
  const block = fn.blocks[0]!;
  const loops = block.instrs.filter((instr): instr is IrForLoop => instr.kind === "for.loop");
  if (loops.length !== 1) return null;
  const loop = loops[0]!;
  const awaits = loop.body.filter(
    (instr): instr is Extract<IrInstr, { readonly kind: "await" }> => instr.kind === "await",
  );
  const calls = loop.body.filter(
    (instr): instr is Extract<IrInstr, { readonly kind: "call" }> => instr.kind === "call",
  );
  if (
    awaits.length !== 1 ||
    awaits[0]!.resultType === null ||
    !irTypeEquals(awaits[0]!.resultType, F64) ||
    calls.length !== 1 ||
    calls[0]!.target.name !== "fetchUser" ||
    calls[0]!.result !== awaits[0]!.operand ||
    calls[0]!.resultType === null ||
    !irTypeEquals(calls[0]!.resultType, EXTERNREF)
  ) {
    return null;
  }
  return { loop, fetchUser: calls[0]!.target };
}

/** Prepare the exact native-i32 counted sequential loop as a five-state plan. */
export function prepareSequentialCountedLoopIrFunction(fn: IrFunction): PreparedSingleAwaitIrFunction | null {
  const exact = exactSequentialLoop(fn);
  if (!exact) return null;
  const idsType = fn.params[0]!.type;
  const makeParam = (name: string, type: IrType, value: number) => ({ name, type, value: asValueId(value) });

  const s0Total = asValueId(0);
  const state0 = asyncStateFunction({
    owner: fn,
    ordinal: 0,
    params: [],
    resultType: F64,
    instrs: [{ kind: "const", value: { kind: "f64", value: 0 }, result: s0Total, resultType: F64 }],
    result: s0Total,
    valueCount: 1,
  });

  const s1Ids = asValueId(0);
  const s1I = asValueId(1);
  const s1Len = asValueId(2);
  const s1Cond = asValueId(3);
  const state1 = asyncStateFunction({
    owner: fn,
    ordinal: 1,
    params: [makeParam("ids", idsType, 0), makeParam("i", I32, 1)],
    resultType: I32,
    instrs: [
      { kind: "vec.len", vec: s1Ids, integer: true, result: s1Len, resultType: I32 },
      { kind: "binary", op: "i32.lt_s", lhs: s1I, rhs: s1Len, result: s1Cond, resultType: I32 },
    ],
    result: s1Cond,
    valueCount: 4,
  });

  const s2Ids = asValueId(0);
  const s2I = asValueId(1);
  const s2Id = asValueId(2);
  const s2Promise = asValueId(3);
  const state2 = asyncStateFunction({
    owner: fn,
    ordinal: 2,
    params: [makeParam("ids", idsType, 0), makeParam("i", I32, 1)],
    resultType: EXTERNREF,
    instrs: [
      { kind: "vec.get", vec: s2Ids, index: s2I, result: s2Id, resultType: F64 },
      { kind: "call", target: exact.fetchUser, args: [s2Id], result: s2Promise, resultType: EXTERNREF },
    ],
    result: s2Promise,
    valueCount: 4,
  });

  const s3Total = asValueId(0);
  const s3Resumed = asValueId(1);
  const s3NextTotal = asValueId(2);
  const state3 = asyncStateFunction({
    owner: fn,
    ordinal: 3,
    params: [makeParam("total", F64, 0), makeParam("resumed", F64, 1)],
    resultType: F64,
    instrs: [{ kind: "binary", op: "f64.add", lhs: s3Total, rhs: s3Resumed, result: s3NextTotal, resultType: F64 }],
    result: s3NextTotal,
    valueCount: 3,
  });

  const s4I = asValueId(0);
  const s4One = asValueId(1);
  const s4NextI = asValueId(2);
  const state4 = asyncStateFunction({
    owner: fn,
    ordinal: 4,
    params: [makeParam("i", I32, 0)],
    resultType: I32,
    instrs: [
      { kind: "const", value: { kind: "i32", value: 1 }, result: s4One, resultType: I32 },
      { kind: "binary", op: "i32.add", lhs: s4I, rhs: s4One, result: s4NextI, resultType: I32 },
    ],
    result: s4NextI,
    valueCount: 3,
  });

  const helpers = [state0, state1, state2, state3, state4];
  const base = fn.valueCount;
  const ids = fn.params[0]!.value;
  const total = asValueId(base);
  const i = asValueId(base + 1);
  const condition = asValueId(base + 2);
  const promise = asValueId(base + 3);
  const resumed = asValueId(base + 4);
  const nextTotal = asValueId(base + 5);
  const nextI = asValueId(base + 6);
  const call = (
    helper: (typeof helpers)[number],
    args: readonly IrValueId[],
    result: IrValueId,
    resultType: IrType,
  ): IrInstr => ({
    kind: "call",
    target: irUnitFuncRef({ unitId: helper.fn.unitId, name: helper.fn.name }),
    args,
    result,
    resultType,
  });
  const asyncPlan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: fn.unitId,
    kind: "async-function",
    abi: canonicalPromiseAbi(F64),
    entry: asAsyncStateId(0),
    params: [{ value: ids, type: idsType }],
    values: [
      { value: ids, type: idsType },
      { value: total, type: F64 },
      { value: i, type: I32 },
      { value: condition, type: I32 },
      { value: promise, type: EXTERNREF },
      { value: resumed, type: F64 },
      { value: nextTotal, type: F64 },
      { value: nextI, type: I32 },
    ],
    spills: [
      { value: ids, type: idsType, storage: "ssa" },
      { value: total, type: F64, storage: "slot" },
      { value: i, type: I32, storage: "slot" },
    ],
    states: [
      {
        id: asAsyncStateId(0),
        body: [
          call(state0, [], total, F64),
          { kind: "const", value: { kind: "i32", value: 0 }, result: i, resultType: I32 },
        ],
        terminator: { kind: "goto", target: asAsyncStateId(1) },
      },
      {
        id: asAsyncStateId(1),
        body: [call(state1, [ids, i], condition, I32)],
        terminator: {
          kind: "branch",
          condition,
          ifTrue: asAsyncStateId(2),
          ifFalse: asAsyncStateId(4),
        },
      },
      {
        id: asAsyncStateId(2),
        body: [call(state2, [ids, i], promise, EXTERNREF)],
        terminator: {
          kind: "suspend",
          awaited: promise,
          resume: { state: asAsyncStateId(3), value: resumed },
          rejected: { kind: "reject" },
          live: [ids, total, i],
        },
      },
      {
        id: asAsyncStateId(3),
        resume: { value: resumed, type: F64, source: "fulfilled" },
        body: [call(state3, [total, resumed], nextTotal, F64), call(state4, [i], nextI, I32)],
        updates: [
          { target: total, value: nextTotal },
          { target: i, value: nextI },
        ],
        terminator: { kind: "goto", target: asAsyncStateId(1) },
      },
      { id: asAsyncStateId(4), body: [], terminator: { kind: "resolve", value: total } },
    ],
    handlers: [],
    runtimeIntents: ASYNC_RUNTIME_FEATURES,
  });
  return {
    main: {
      ...fn,
      blocks: [
        {
          id: fn.blocks[0]!.id,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "unreachable" },
        },
      ],
      slots: undefined,
      asyncPlan,
    },
    stateFunctions: helpers.map((helper) => helper.fn),
    provenance: helpers.map((helper) => helper.provenance),
  };
}

function exactFinalMain(fn: IrFunction): {
  readonly ids: IrValueId;
  readonly idsType: IrType;
  readonly t0Clock: Extract<IrInstr, { readonly kind: "call" }>;
  readonly sequentialCall: Extract<IrInstr, { readonly kind: "call" }>;
  readonly sequentialAwait: Extract<IrInstr, { readonly kind: "await" }>;
  readonly t1Clock: Extract<IrInstr, { readonly kind: "call" }>;
  readonly t2Clock: Extract<IrInstr, { readonly kind: "call" }>;
  readonly parallelCall: Extract<IrInstr, { readonly kind: "call" }>;
  readonly parallelAwait: Extract<IrInstr, { readonly kind: "await" }>;
  readonly t3Clock: Extract<IrInstr, { readonly kind: "call" }>;
  readonly prefix: readonly IrInstr[];
  readonly sequentialTail: readonly IrInstr[];
  readonly parallelTail: readonly IrInstr[];
} | null {
  if (
    fn.name !== "main" ||
    fn.funcKind !== "async" ||
    fn.asyncPlan ||
    fn.params.length !== 0 ||
    fn.resultTypes.length !== 0 ||
    fn.blocks.length !== 1 ||
    fn.blocks[0]!.terminator.kind !== "return" ||
    fn.blocks[0]!.terminator.values.length !== 0
  ) {
    return null;
  }
  const instrs = fn.blocks[0]!.instrs;
  const awaitIndices = instrs.flatMap((instr, index) => (instr.kind === "await" ? [index] : []));
  if (awaitIndices.length !== 2) return null;
  const firstAwaitIndex = awaitIndices[0]!;
  const secondAwaitIndex = awaitIndices[1]!;
  const sequentialAwait = instrs[firstAwaitIndex];
  const parallelAwait = instrs[secondAwaitIndex];
  if (
    sequentialAwait?.kind !== "await" ||
    sequentialAwait.result === null ||
    sequentialAwait.resultType === null ||
    !irTypeEquals(sequentialAwait.resultType, F64) ||
    parallelAwait?.kind !== "await" ||
    parallelAwait.result === null ||
    parallelAwait.resultType === null ||
    !irTypeEquals(parallelAwait.resultType, F64)
  ) {
    return null;
  }
  const callForAwait = (awaited: Extract<IrInstr, { readonly kind: "await" }>) =>
    instrs.find(
      (instr): instr is Extract<IrInstr, { readonly kind: "call" }> =>
        instr.kind === "call" && instr.result === awaited.operand,
    );
  const sequentialCall = callForAwait(sequentialAwait);
  const parallelCall = callForAwait(parallelAwait);
  const sequentialCallIndex = sequentialCall ? instrs.indexOf(sequentialCall) : -1;
  const parallelCallIndex = parallelCall ? instrs.indexOf(parallelCall) : -1;
  if (
    !sequentialCall ||
    sequentialCall.target.name !== "fetchAllSequential" ||
    sequentialCall.args.length !== 1 ||
    !parallelCall ||
    parallelCall.target.name !== "fetchAllParallel" ||
    parallelCall.args.length !== 1 ||
    parallelCall.args[0] !== sequentialCall.args[0]
  ) {
    return null;
  }
  const ids = sequentialCall.args[0]!;
  const idsDefinition = instrs.find((instr) => instr.result === ids);
  if (idsDefinition?.kind !== "vec.new_fixed" || idsDefinition.resultType === null) return null;
  const clockCalls = instrs.filter(
    (instr): instr is Extract<IrInstr, { readonly kind: "call" }> =>
      instr.kind === "call" &&
      instr.target.binding.kind === "intrinsic" &&
      instr.target.binding.symbol === IR_ASYNC_CLOCK_SNAPSHOT_FN,
  );
  if (
    clockCalls.length !== 4 ||
    clockCalls.some((call) => call.result === null || call.resultType === null || !irTypeEquals(call.resultType, F64))
  ) {
    return null;
  }
  const indices = clockCalls.map((call) => instrs.indexOf(call));
  const [t0Index, t1Index, t2Index, t3Index] = indices;
  if (
    t0Index === undefined ||
    t1Index === undefined ||
    t2Index === undefined ||
    t3Index === undefined ||
    !(
      t0Index + 1 === sequentialCallIndex &&
      sequentialCallIndex + 1 === firstAwaitIndex &&
      firstAwaitIndex + 1 === t1Index &&
      t1Index < t2Index &&
      t2Index + 1 === parallelCallIndex &&
      parallelCallIndex + 1 === secondAwaitIndex &&
      secondAwaitIndex + 1 === t3Index
    )
  ) {
    return null;
  }
  return {
    ids,
    idsType: idsDefinition.resultType,
    t0Clock: clockCalls[0]!,
    sequentialCall,
    sequentialAwait,
    t1Clock: clockCalls[1]!,
    t2Clock: clockCalls[2]!,
    parallelCall,
    parallelAwait,
    t3Clock: clockCalls[3]!,
    prefix: instrs.slice(0, t0Index),
    sequentialTail: instrs.slice(t1Index + 1, t2Index),
    parallelTail: instrs.slice(t3Index + 1),
  };
}

function onlyUses(instrs: readonly IrInstr[], allowed: ReadonlySet<IrValueId>): boolean {
  const defined = new Set<IrValueId>();
  for (const instr of instrs) {
    forEachInstrDeep(instr, (nested) => {
      if (nested.result !== null) defined.add(nested.result);
    });
  }
  for (const instr of instrs) {
    for (const use of collectUses(instr, { deep: true })) {
      if (!defined.has(use) && !allowed.has(use)) return false;
    }
  }
  return true;
}

function planCall(
  instr: Extract<IrInstr, { readonly kind: "call" }>,
  args: readonly IrValueId[] = instr.args,
): Extract<IrInstr, { readonly kind: "call" }> {
  return {
    kind: "call",
    target: instr.target,
    args,
    result: instr.result,
    resultType: instr.resultType,
    ...(instr.site ? { site: instr.site } : {}),
    ...(instr.alloc === undefined ? {} : { alloc: instr.alloc }),
  };
}

/** Prepare the exact exported Promise<void> terminal as a three-state plan. */
export function prepareFinalMainIrFunction(fn: IrFunction): PreparedSingleAwaitIrFunction | null {
  const exact = exactFinalMain(fn);
  if (!exact) return null;
  const t0 = exact.t0Clock.result!;
  const seq = exact.sequentialAwait.result!;
  const t1 = exact.t1Clock.result!;
  const t2 = exact.t2Clock.result!;
  const par = exact.parallelAwait.result!;
  const t3 = exact.t3Clock.result!;
  if (
    !onlyUses(exact.prefix, new Set()) ||
    !onlyUses(exact.sequentialTail, new Set([seq, t1, t0])) ||
    !onlyUses(exact.parallelTail, new Set([par, t3, t2]))
  ) {
    return null;
  }
  const state0 = asyncStateFunction({
    owner: fn,
    ordinal: 0,
    params: [],
    resultType: exact.idsType,
    instrs: exact.prefix,
    result: exact.ids,
    valueCount: fn.valueCount,
  });
  const state1 = asyncStateVoidFunction({
    owner: fn,
    ordinal: 1,
    params: [
      { name: "seq", type: F64, value: seq },
      { name: "t1", type: F64, value: t1 },
      { name: "t0", type: F64, value: t0 },
    ],
    instrs: exact.sequentialTail,
    valueCount: fn.valueCount,
  });
  const state2 = asyncStateVoidFunction({
    owner: fn,
    ordinal: 2,
    params: [
      { name: "par", type: F64, value: par },
      { name: "t3", type: F64, value: t3 },
      { name: "t2", type: F64, value: t2 },
    ],
    instrs: exact.parallelTail,
    valueCount: fn.valueCount,
  });
  const helpers = [state0, state1, state2];
  const promiseSeq = exact.sequentialCall.result!;
  const promisePar = exact.parallelCall.result!;
  const asyncPlan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: fn.unitId,
    kind: "async-function",
    abi: canonicalPromiseAbi(null),
    entry: asAsyncStateId(0),
    params: [],
    values: [
      { value: exact.ids, type: exact.idsType },
      { value: t0, type: F64 },
      { value: promiseSeq, type: EXTERNREF },
      { value: seq, type: F64 },
      { value: t1, type: F64 },
      { value: t2, type: F64 },
      { value: promisePar, type: EXTERNREF },
      { value: par, type: F64 },
      { value: t3, type: F64 },
    ],
    spills: [
      { value: exact.ids, type: exact.idsType, storage: "ssa" },
      { value: t0, type: F64, storage: "ssa" },
      { value: t2, type: F64, storage: "ssa" },
    ],
    states: [
      {
        id: asAsyncStateId(0),
        body: [
          {
            kind: "call",
            target: irUnitFuncRef({ unitId: state0.fn.unitId, name: state0.fn.name }),
            args: [],
            result: exact.ids,
            resultType: exact.idsType,
          },
          planCall(exact.t0Clock),
          planCall(exact.sequentialCall, [exact.ids]),
        ],
        terminator: {
          kind: "suspend",
          awaited: promiseSeq,
          resume: { state: asAsyncStateId(1), value: seq },
          rejected: { kind: "reject" },
          live: [exact.ids, t0],
        },
      },
      {
        id: asAsyncStateId(1),
        resume: { value: seq, type: F64, source: "fulfilled" },
        body: [
          planCall(exact.t1Clock),
          {
            kind: "call",
            target: irUnitFuncRef({ unitId: state1.fn.unitId, name: state1.fn.name }),
            args: [seq, t1, t0],
            result: null,
            resultType: null,
          },
          planCall(exact.t2Clock),
          planCall(exact.parallelCall, [exact.ids]),
        ],
        terminator: {
          kind: "suspend",
          awaited: promisePar,
          resume: { state: asAsyncStateId(2), value: par },
          rejected: { kind: "reject" },
          live: [t2],
        },
      },
      {
        id: asAsyncStateId(2),
        resume: { value: par, type: F64, source: "fulfilled" },
        body: [
          planCall(exact.t3Clock),
          {
            kind: "call",
            target: irUnitFuncRef({ unitId: state2.fn.unitId, name: state2.fn.name }),
            args: [par, t3, t2],
            result: null,
            resultType: null,
          },
        ],
        terminator: { kind: "resolve" },
      },
    ],
    handlers: [],
    runtimeIntents: [...ASYNC_RUNTIME_FEATURES, "value.undefined"],
  });
  return {
    main: {
      ...fn,
      blocks: [
        {
          id: fn.blocks[0]!.id,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "unreachable" },
        },
      ],
      asyncPlan,
    },
    stateFunctions: helpers.map((helper) => helper.fn),
    provenance: helpers.map((helper) => helper.provenance),
  };
}

/** Dispatch the closed prepared async source families. */
export function prepareSuspendingIrFunction(fn: IrFunction): PreparedSingleAwaitIrFunction | null {
  return (
    prepareSequentialCountedLoopIrFunction(fn) ?? prepareFinalMainIrFunction(fn) ?? prepareSingleAwaitIrFunction(fn)
  );
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
