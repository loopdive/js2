// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Generic AST-free producer for a top-level straight-line async function.
 *
 * The source selector proves the same shape in `async-linear-planning.ts`.
 * This pass deliberately consumes only lowered IR: every source await becomes
 * one plan suspension, mutable local slots become SSA aliases, and ordinary
 * instructions are lifted into deterministic derived helpers so an async
 * state body contains only constants and calls.
 */

import { ASYNC_RUNTIME_FEATURES } from "./async-runtime-providers.js";
import { asAsyncStateId, canonicalPromiseAbi, createIrAsyncPlan } from "./async-plan.js";
import { irUnitFuncRef } from "./callable-bindings.js";
import { createDerivedIrUnitId, type IrDerivedUnitProvenance } from "./identity.js";
import {
  asBlockId,
  asVal,
  collectUses,
  irTypeEquals,
  irVal,
  type IrFunction,
  type IrInstr,
  type IrSlotDef,
  type IrType,
  type IrValueId,
} from "./nodes.js";

const EXTERNREF = irVal({ kind: "externref" });
const F64 = irVal({ kind: "f64" });

export interface PreparedLinearIrFunction {
  readonly main: IrFunction;
  readonly stateFunctions: readonly IrFunction[];
  readonly provenance: readonly IrDerivedUnitProvenance[];
}

interface DerivedHelper {
  readonly fn: IrFunction;
  readonly provenance: IrDerivedUnitProvenance;
  readonly call: Extract<IrInstr, { readonly kind: "call" }>;
}

interface BuiltState {
  readonly id: number;
  readonly body: IrInstr[];
  readonly resume?: {
    readonly value: IrValueId;
    readonly type: IrType;
  };
  readonly suspension?: {
    readonly awaited: IrValueId;
    readonly resumeState: number;
    readonly resumeValue: IrValueId;
  };
  /** Value consumed by the terminal resolve edge, when the owner is non-void. */
  readonly terminalValue?: IrValueId;
}

function isUnsupportedControl(instr: IrInstr): boolean {
  switch (instr.kind) {
    case "if":
    case "forof.vec":
    case "forof.iter":
    case "forof.string":
    case "while.loop":
    case "for.loop":
    case "try":
    case "if.stmt":
    case "labeled.block":
    case "switch":
    case "br.label":
    case "throw":
    case "async.return":
    case "async.throw":
    case "early.return":
    case "gen.push":
    case "gen.epilogue":
    case "gen.yieldStar":
    case "gen.setReturn":
      return true;
    default:
      return false;
  }
}

function mapIds(ids: readonly IrValueId[], resolve: (value: IrValueId) => IrValueId): readonly IrValueId[] {
  return ids.map(resolve);
}

/**
 * Rewrite only SSA operands.  Every buffer-bearing instruction is rejected by
 * `isUnsupportedControl`; the explicit switch keeps slot indices, field
 * indices, labels, and other non-SSA numeric data untouched.
 */
function rewriteInstruction(instr: IrInstr, resolve: (value: IrValueId) => IrValueId): IrInstr | null {
  if (isUnsupportedControl(instr)) return null;
  switch (instr.kind) {
    case "const":
    case "global.get":
    case "raw.wasm":
    case "string.const":
    case "slot.read":
    case "extern.regex":
      return instr;
    case "call":
      return { ...instr, args: mapIds(instr.args, resolve) };
    case "intrinsic":
      return { ...instr, args: mapIds(instr.args, resolve) };
    case "global.set":
      return { ...instr, value: resolve(instr.value) };
    case "binary":
      return { ...instr, lhs: resolve(instr.lhs), rhs: resolve(instr.rhs) };
    case "unary":
      return { ...instr, rand: resolve(instr.rand) };
    case "select":
      return {
        ...instr,
        condition: resolve(instr.condition),
        whenTrue: resolve(instr.whenTrue),
        whenFalse: resolve(instr.whenFalse),
      };
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number":
      return { ...instr, value: resolve(instr.value) };
    case "dyn.eq":
    case "string.concat":
    case "string.eq":
      return { ...instr, lhs: resolve(instr.lhs), rhs: resolve(instr.rhs) };
    case "string.repeat":
      return { ...instr, value: resolve(instr.value), count: resolve(instr.count) };
    case "dyn.member_get":
      return { ...instr, recv: resolve(instr.recv), key: resolve(instr.key) };
    case "dyn.member_set":
      return {
        ...instr,
        recv: resolve(instr.recv),
        key: resolve(instr.key),
        value: resolve(instr.value),
      };
    case "string.len":
      return { ...instr, value: resolve(instr.value) };
    case "string.char_at":
    case "string.char_code_at":
      return { ...instr, value: resolve(instr.value), index: resolve(instr.index) };
    case "fnctor.new":
      return {
        ...instr,
        captureArgs: mapIds(instr.captureArgs, resolve),
        args: mapIds(instr.args, resolve),
        constructorIdentity: instr.constructorIdentity === null ? null : resolve(instr.constructorIdentity),
      };
    case "fnctor.get":
      return { ...instr, value: resolve(instr.value) };
    case "object.new":
      return { ...instr, values: mapIds(instr.values, resolve) };
    case "object.get":
      return { ...instr, value: resolve(instr.value) };
    case "object.set":
      return { ...instr, value: resolve(instr.value), newValue: resolve(instr.newValue) };
    case "closure.new":
      return { ...instr, captures: mapIds(instr.captures, resolve) };
    case "closure.cap":
      return { ...instr, self: resolve(instr.self) };
    case "closure.call":
      return { ...instr, callee: resolve(instr.callee), args: mapIds(instr.args, resolve) };
    case "refcell.new":
      return { ...instr, value: resolve(instr.value) };
    case "refcell.get":
      return { ...instr, cell: resolve(instr.cell) };
    case "refcell.set":
      return { ...instr, cell: resolve(instr.cell), value: resolve(instr.value) };
    case "class.new":
      return { ...instr, args: mapIds(instr.args, resolve) };
    case "class.get":
      return { ...instr, value: resolve(instr.value) };
    case "class.set":
      return { ...instr, value: resolve(instr.value), newValue: resolve(instr.newValue) };
    case "class.call":
      return { ...instr, receiver: resolve(instr.receiver), args: mapIds(instr.args, resolve) };
    case "class.super_init":
      return { ...instr, self: resolve(instr.self), args: mapIds(instr.args, resolve) };
    case "class.super_call":
      return { ...instr, receiver: resolve(instr.receiver), args: mapIds(instr.args, resolve) };
    case "class.instanceof":
      return { ...instr, value: resolve(instr.value) };
    case "class.static_call":
      return { ...instr, args: mapIds(instr.args, resolve) };
    case "slot.write":
      return { ...instr, value: resolve(instr.value) };
    case "vec.len":
      return { ...instr, vec: resolve(instr.vec) };
    case "vec.get":
      return { ...instr, vec: resolve(instr.vec), index: resolve(instr.index) };
    case "vec.set":
      return {
        ...instr,
        vec: resolve(instr.vec),
        index: resolve(instr.index),
        newValue: resolve(instr.newValue),
      };
    case "vec.set_length":
      return { ...instr, vec: resolve(instr.vec), length: resolve(instr.length) };
    case "vec.new_fixed":
      return { ...instr, elements: mapIds(instr.elements, resolve) };
    case "coerce.to_externref":
      return { ...instr, value: resolve(instr.value) };
    case "iter.new":
      return { ...instr, iterable: resolve(instr.iterable) };
    case "iter.next":
      return { ...instr, iter: resolve(instr.iter) };
    case "iter.done":
    case "iter.value":
      return { ...instr, resultObj: resolve(instr.resultObj) };
    case "iter.return":
      return { ...instr, iter: resolve(instr.iter) };
    case "extern.new":
      return { ...instr, args: mapIds(instr.args, resolve) };
    case "extern.call":
      return { ...instr, receiver: resolve(instr.receiver), args: mapIds(instr.args, resolve) };
    case "extern.prop":
      return { ...instr, receiver: resolve(instr.receiver) };
    case "extern.propSet":
      return { ...instr, receiver: resolve(instr.receiver), value: resolve(instr.value) };
    case "await":
      return null;
    default:
      return null;
  }
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

function isAwaitCarrier(type: IrType): boolean {
  const scalar = asVal(type);
  return scalar?.kind === "externref" || type.kind === "extern";
}

function makeHelper(
  owner: IrFunction,
  ordinal: number,
  instr: IrInstr,
  valueTypes: ReadonlyMap<IrValueId, IrType>,
): DerivedHelper | null {
  const uses = [...new Set(collectUses(instr))];
  const params = uses.map((value, index) => {
    const type = valueTypes.get(value);
    if (!type) return null;
    return { name: `p${index}`, type, value };
  });
  if (params.some((param) => param === null)) return null;
  const role = "ir-async-state" as const;
  const unitId = createDerivedIrUnitId({ parentId: owner.unitId, role, ordinal });
  const name = `${owner.name}__ir_async_state_${ordinal}`;
  const resultType = instr.result === null ? null : instr.resultType;
  if (instr.result !== null && resultType === null) return null;
  const fn: IrFunction = {
    unitId,
    name,
    params: params as { name: string; type: IrType; value: IrValueId }[],
    resultTypes: resultType === null ? [] : [resultType],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [instr],
        terminator: {
          kind: "return",
          values: instr.result === null ? [] : [instr.result],
        },
      },
    ],
    exported: false,
    valueCount: owner.valueCount,
    funcKind: "regular",
  };
  const call: Extract<IrInstr, { readonly kind: "call" }> = {
    kind: "call",
    target: irUnitFuncRef({ unitId, name }),
    args: uses,
    result: instr.result,
    resultType,
    ...(instr.site ? { site: instr.site } : {}),
  };
  return {
    fn,
    call,
    provenance: { id: unitId, parentId: owner.unitId, role, ordinal },
  };
}

function stateLiveness(
  state: BuiltState,
  isEntry: boolean,
  params: readonly { readonly value: IrValueId }[],
): { readonly defs: ReadonlySet<IrValueId>; readonly usesBeforeDef: ReadonlySet<IrValueId> } {
  const defs = new Set<IrValueId>();
  if (isEntry) for (const param of params) defs.add(param.value);
  if (state.resume) defs.add(state.resume.value);
  for (const instr of state.body) if (instr.result !== null) defs.add(instr.result);

  const usesBeforeDef = new Set<IrValueId>();
  for (const instr of state.body) {
    for (const value of collectUses(instr, { deep: true })) if (!defs.has(value)) usesBeforeDef.add(value);
  }
  if (state.suspension && !defs.has(state.suspension.awaited)) usesBeforeDef.add(state.suspension.awaited);
  if (state.terminalValue !== undefined && !defs.has(state.terminalValue)) {
    usesBeforeDef.add(state.terminalValue);
  }
  return { defs, usesBeforeDef };
}

function sameValueSet(left: ReadonlySet<IrValueId>, right: ReadonlySet<IrValueId>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function computeLiveSets(
  states: readonly BuiltState[],
  params: readonly { readonly value: IrValueId }[],
): ReadonlyMap<number, ReadonlySet<IrValueId>> {
  const local = states.map((state) => stateLiveness(state, state.id === 0, params));
  const liveIn = states.map((state, index) => {
    void state;
    return new Set<IrValueId>(local[index]!.usesBeforeDef);
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = states.length - 1; index >= 0; index--) {
      const state = states[index]!;
      const info = local[index]!;
      const liveOut = new Set<IrValueId>();
      if (state.suspension) {
        const target = liveIn[state.suspension.resumeState]!;
        for (const value of target) if (value !== state.suspension.resumeValue) liveOut.add(value);
      }
      const next = new Set<IrValueId>(info.usesBeforeDef);
      for (const value of liveOut) if (!info.defs.has(value)) next.add(value);
      if (!sameValueSet(next, liveIn[index]!)) {
        liveIn[index] = next;
        changed = true;
      }
    }
  }
  return new Map(states.map((state, index) => [state.id, liveIn[index]!] as const));
}

function sortedValues(values: Iterable<IrValueId>): IrValueId[] {
  return [...new Set(values)].sort((left, right) => Number(left) - Number(right));
}

/**
 * Split one lowered flat async block at every await and construct its exact
 * canonical plan.  A null result is a typed producer refusal; the caller
 * turns it into the existing post-claim body-shape error.
 */
export function prepareLinearSuspendingIrFunction(fn: IrFunction): PreparedLinearIrFunction | null {
  if (
    fn.funcKind !== "async" ||
    fn.asyncPlan ||
    fn.blocks.length !== 1 ||
    fn.blocks[0]!.blockArgs.length !== 0 ||
    fn.blocks[0]!.terminator.kind !== "return" ||
    fn.resultTypes.length > 1
  ) {
    return null;
  }
  const block = fn.blocks[0]!;
  if (block.terminator.kind !== "return") return null;
  const terminator = block.terminator;
  if (terminator.values.length !== fn.resultTypes.length) return null;
  if (fn.resultTypes.length === 1 && !irTypeEquals(fn.resultTypes[0]!, F64)) return null;

  const valueTypes = valueTypesOf(fn);
  const slotDefs = new Map<number, IrSlotDef>();
  for (const slot of fn.slots ?? []) {
    if (slotDefs.has(slot.index) || slot.index < 0 || !Number.isSafeInteger(slot.index)) return null;
    slotDefs.set(slot.index, slot);
  }
  const slotAliases = new Map<number, IrValueId>();
  const aliases = new Map<IrValueId, IrValueId>();
  const slotBackedValues = new Set<IrValueId>();
  const resolve = (value: IrValueId): IrValueId => {
    let current = value;
    const visited = new Set<IrValueId>();
    while (aliases.has(current)) {
      if (visited.has(current)) return value;
      visited.add(current);
      current = aliases.get(current)!;
    }
    return current;
  };

  const states: BuiltState[] = [{ id: 0, body: [] }];
  const helpers: DerivedHelper[] = [];
  let currentState = states[0]!;
  let helperOrdinal = 0;
  let awaitCount = 0;
  const awaitResults = new Set<IrValueId>();
  const slotReadResults = new Set<IrValueId>();

  for (const sourceInstr of block.instrs) {
    if (sourceInstr.kind === "slot.write") {
      const slot = slotDefs.get(sourceInstr.slotIndex);
      const source = resolve(sourceInstr.value);
      const sourceType = valueTypes.get(source);
      if (!slot || !sourceType || !irTypeEquals(sourceType, irVal(slot.type))) return null;
      slotAliases.set(sourceInstr.slotIndex, source);
      slotBackedValues.add(source);
      continue;
    }
    if (sourceInstr.kind === "slot.read") {
      const slot = slotDefs.get(sourceInstr.slotIndex);
      const source = slotAliases.get(sourceInstr.slotIndex);
      if (!slot || source === undefined || sourceInstr.result === null || sourceInstr.resultType === null) return null;
      if (!irTypeEquals(sourceInstr.resultType, irVal(slot.type))) return null;
      aliases.set(sourceInstr.result, source);
      slotReadResults.add(sourceInstr.result);
      slotBackedValues.add(source);
      continue;
    }
    if (sourceInstr.kind === "await") {
      if (sourceInstr.result === null || sourceInstr.resultType === null || awaitResults.has(sourceInstr.result))
        return null;
      if (!irTypeEquals(sourceInstr.resultType, F64)) return null;
      const awaited = resolve(sourceInstr.operand);
      const awaitedType = valueTypes.get(awaited);
      if (!awaitedType || !isAwaitCarrier(awaitedType)) return null;
      const nextId = currentState.id + 1;
      currentState = {
        ...currentState,
        suspension: { awaited, resumeState: nextId, resumeValue: sourceInstr.result },
      };
      states[currentState.id] = currentState;
      states.push({
        id: nextId,
        body: [],
        resume: { value: sourceInstr.result, type: sourceInstr.resultType },
      });
      currentState = states[nextId]!;
      awaitResults.add(sourceInstr.result);
      awaitCount++;
      continue;
    }

    const rewritten = rewriteInstruction(sourceInstr, resolve);
    if (!rewritten || rewritten.kind === "await" || rewritten.kind === "slot.read" || rewritten.kind === "slot.write") {
      return null;
    }
    if (rewritten.result !== null && rewritten.resultType === null) return null;
    if (rewritten.kind === "const") {
      currentState.body.push(rewritten);
      continue;
    }
    const helper = makeHelper(fn, helperOrdinal++, rewritten, valueTypes);
    if (!helper) return null;
    helpers.push(helper);
    currentState.body.push(helper.call);
  }

  if (awaitCount === 0 || states.length !== awaitCount + 1) return null;
  const returned = terminator.values[0];
  const resolvedReturn = returned === undefined ? undefined : resolve(returned);
  if (fn.resultTypes.length === 1 && resolvedReturn === undefined) return null;
  if (fn.resultTypes.length === 1 && resolvedReturn !== undefined) {
    const returnType = valueTypes.get(resolvedReturn);
    if (!returnType || !irTypeEquals(returnType, fn.resultTypes[0]!)) return null;
  }
  // The terminal resolve operand is a real use.  Record it before the
  // backwards pass so a value produced before the final await (including a
  // parameter, an earlier resume value, or a computed live value) is carried
  // through every intervening state instead of disappearing from `live` and
  // `spills` merely because the final state body is empty.
  if (resolvedReturn !== undefined) {
    const finalState = states[states.length - 1]!;
    states[states.length - 1] = { ...finalState, terminalValue: resolvedReturn };
  }

  const params = fn.params.map((param) => ({ value: param.value, type: param.type }));
  const liveIn = computeLiveSets(states, params);
  const requiredSpills = new Set<IrValueId>();
  const planStates = states.map((state) => {
    if (!state.suspension) {
      return {
        id: asAsyncStateId(state.id),
        ...(state.resume ? { resume: { ...state.resume, source: "fulfilled" as const } } : {}),
        body: state.body,
        terminator:
          fn.resultTypes.length === 0
            ? ({ kind: "resolve" as const } as const)
            : ({ kind: "resolve" as const, value: resolvedReturn! } as const),
      };
    }
    const targetLive = liveIn.get(state.suspension.resumeState) ?? new Set<IrValueId>();
    const live = sortedValues([...targetLive].filter((value) => value !== state.suspension!.resumeValue));
    for (const value of live) requiredSpills.add(value);
    return {
      id: asAsyncStateId(state.id),
      ...(state.resume ? { resume: { ...state.resume, source: "fulfilled" as const } } : {}),
      body: state.body,
      terminator: {
        kind: "suspend" as const,
        awaited: state.suspension.awaited,
        resume: {
          state: asAsyncStateId(state.suspension.resumeState),
          value: state.suspension.resumeValue,
        },
        rejected: { kind: "reject" as const },
        live,
      },
    };
  });
  const spills = sortedValues(requiredSpills).map((value) => {
    const type = valueTypes.get(value);
    if (!type) throw new Error(`IR async function ${fn.name} lost live value ${value}`);
    return { value, type, storage: slotBackedValues.has(value) ? ("slot" as const) : ("ssa" as const) };
  });

  const values = [...valueTypes.entries()]
    .filter(([value]) => !slotReadResults.has(value))
    .map(([value, type]) => ({ value, type }));
  const fulfillmentType = fn.resultTypes.length === 0 ? null : fn.resultTypes[0]!;
  const asyncPlan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: fn.unitId,
    kind: "async-function",
    abi: canonicalPromiseAbi(fulfillmentType),
    entry: asAsyncStateId(0),
    params,
    values,
    spills,
    states: planStates,
    handlers: [],
    runtimeIntents:
      fn.resultTypes.length === 0 ? [...ASYNC_RUNTIME_FEATURES, "value.undefined"] : ASYNC_RUNTIME_FEATURES,
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
    stateFunctions: helpers.map((helper) => helper.fn),
    provenance: helpers.map((helper) => helper.provenance),
  };
}
