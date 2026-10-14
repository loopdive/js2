// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrFunction, type IrInstr, type IrModule, type IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";
import { collectLinearVectorFlow } from "./linear-vector-flow.js";
import { isNativeNumericAppendCall } from "../analysis/allocation-evidence/numeric-append-protocol.js";
import { irGlobalBindingKey } from "../core/global-binding-keys.js";
import {
  checkNativeModuleVectorWriters,
  checkNativeModuleVectorReads,
  type NativeModuleGlobalEvidence,
} from "../analysis/allocation-evidence/module-vector-globals.js";

interface NumericStore {
  readonly fn: IrFunction;
  readonly instruction: Extract<IrInstr, { kind: "vec.set" }>;
  readonly index: number | undefined;
}
export interface NativeVectorStoreFailure {
  readonly unitId: IrUnitId;
  readonly detail: string;
}

function instructions(fn: IrFunction): IrInstr[] {
  const result: IrInstr[] = [];
  for (const buffer of [...fn.blocks.map((block) => block.instrs), ...(fn.asyncPlan?.states.map((s) => s.body) ?? [])])
    for (const root of buffer) forEachInstrDeep(root, (instruction) => result.push(instruction));
  return result;
}

function numericStores(module: IrModule): NumericStore[] {
  const result: NumericStore[] = [];
  for (const fn of module.functions) {
    const body = instructions(fn);
    const types = new Map(fn.params.map((param) => [param.value, param.type]));
    for (const block of fn.blocks)
      block.blockArgs.forEach((value, index) => types.set(value, block.blockArgTypes[index]!));
    const definitions = new Map(body.filter((i) => i.result !== null).map((i) => [i.result!, i]));
    for (const instruction of body)
      if (instruction.result !== null && instruction.resultType !== null)
        types.set(instruction.result, instruction.resultType);
    for (const instruction of body) {
      if (instruction.kind !== "vec.set") continue;
      const type = types.get(instruction.vec),
        index = definitions.get(instruction.index);
      if (type?.kind !== "vec" || type.layout || type.elementType.kind !== "val" || type.elementType.val.kind !== "f64")
        continue;
      result.push({
        fn,
        instruction,
        index: index?.kind === "const" && index.value.kind === "i32" ? index.value.value : undefined,
      });
    }
  }
  return result;
}

// A closed first domain: unrelated opaque effects also refuse. No absence of a
// vector argument can excuse a scalar helper that mutates a global vector.
const closedKinds = new Set<IrInstr["kind"]>([
  "const",
  "unary",
  "binary",
  "select",
  "if",
  "if.stmt",
  "while.loop",
  "for.loop",
  "early.return",
  "br.label",
  "labeled.block",
  "switch",
  "slot.read",
  "slot.write",
  "global.get",
  "global.set",
  "vec.new_fixed",
  "vec.get",
  "vec.set",
  "vec.len",
  "call",
  "throw",
]);
function closedEffects(module: IrModule): string | undefined {
  const functions = new Map(module.functions.map((fn) => [fn.unitId, fn]));
  const calls = new Map<IrUnitId, IrUnitId[]>();
  for (const fn of module.functions) {
    if (
      (fn.funcKind !== undefined && fn.funcKind !== "regular") ||
      ["asyncPlan", "asyncRuntime", "closureSubtype", "captures", "generatorBufferSlot"].some((key) =>
        Object.hasOwn(fn, key),
      )
    )
      return "constant stores require a complete synchronous uncaptured population";
    const targets: IrUnitId[] = [];
    for (const instruction of instructions(fn)) {
      if (!closedKinds.has(instruction.kind)) return `unproved ${instruction.kind} effect in ${fn.unitId}`;
      if (instruction.kind !== "call" || isNativeNumericAppendCall(instruction)) continue;
      const binding = instruction.target.binding;
      // Canonical runtime/ABI validation authenticates this native error
      // constructor; its only effect is allocation, followed by the TDZ throw.
      if (binding.kind === "runtime" && binding.symbol === "__new_ReferenceError") continue;
      if (binding.kind !== "unit" || !functions.has(binding.unitId))
        return `constant store has an unclassified call effect in ${fn.unitId}`;
      targets.push(binding.unitId);
    }
    calls.set(fn.unitId, targets);
  }
  const done = new Set<IrUnitId>(),
    active = new Set<IrUnitId>();
  const visit = (id: IrUnitId): boolean => {
    if (active.has(id)) return false;
    if (done.has(id)) return true;
    active.add(id);
    if (!calls.get(id)!.every(visit)) return false;
    active.delete(id);
    done.add(id);
    return true;
  };
  return module.functions.every((fn) => visit(fn.unitId)) ? undefined : "recursive constant-store effect population";
}

function loopContains(loop: Extract<IrInstr, { kind: "for.loop" }>, store: IrInstr): boolean {
  let found = false;
  for (const root of loop.body)
    forEachInstrDeep(root, (i) => {
      found ||= i === store;
    });
  return found;
}

/** Replay the actual live guard and unit-step counter; no source names/marks. */
function sameReceiver(
  left: IrValueId,
  right: IrValueId,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  globals?: ReadonlyMap<string, NativeModuleGlobalEvidence>,
): boolean {
  if (left === right) return true;
  const a = definitions.get(left),
    b = definitions.get(right);
  return (
    a?.kind === "global.get" &&
    b?.kind === "global.get" &&
    globals?.get(irGlobalBindingKey(a.target.binding))?.tdzKey !== undefined &&
    irGlobalBindingKey(a.target.binding) === irGlobalBindingKey(b.target.binding)
  );
}

function countedLoopStore(store: NumericStore, globals?: ReadonlyMap<string, NativeModuleGlobalEvidence>): boolean {
  const body = instructions(store.fn);
  const definitions = new Map<IrValueId, IrInstr>(body.filter((i) => i.result !== null).map((i) => [i.result!, i]));
  const index = definitions.get(store.instruction.index);
  if (index?.kind !== "slot.read" || store.fn.blocks.length !== 1) return false;
  const writes = body.filter(
    (i): i is Extract<IrInstr, { kind: "slot.write" }> => i.kind === "slot.write" && i.slotIndex === index.slotIndex,
  );
  if (writes.length !== 2) return false;
  for (const loop of body) {
    if (loop.kind !== "for.loop" || !loopContains(loop, store.instruction) || !loopContains(loop, index)) continue;
    const [read, convert] = loop.cond;
    const length = loop.cond.at(-2),
      compare = loop.cond.at(-1);
    const globalReceiver = length?.kind === "vec.len" ? definitions.get(length.vec) : undefined;
    const canonicalGlobalLoad =
      loop.cond.length === 8 &&
      globalReceiver?.kind === "global.get" &&
      loop.cond[5] === globalReceiver &&
      globals?.get(irGlobalBindingKey(globalReceiver.target.binding))?.tdzKey !== undefined;
    if (
      (loop.cond.length !== 4 && !canonicalGlobalLoad) ||
      read?.kind !== "slot.read" ||
      read.slotIndex !== index.slotIndex ||
      convert?.kind !== "unary" ||
      convert.op !== "f64.convert_i32_s" ||
      convert.rand !== read.result ||
      length?.kind !== "vec.len" ||
      length.integer ||
      !sameReceiver(length.vec, store.instruction.vec, definitions, globals) ||
      compare?.kind !== "binary" ||
      compare.op !== "f64.lt" ||
      compare.lhs !== convert.result ||
      compare.rhs !== length.result ||
      loop.condValue !== compare.result
    )
      continue;
    const [old, one, add, write] = loop.update;
    if (
      loop.update.length !== 4 ||
      old?.kind !== "slot.read" ||
      old.slotIndex !== index.slotIndex ||
      one?.kind !== "const" ||
      one.value.kind !== "i32" ||
      one.value.value !== 1 ||
      add?.kind !== "binary" ||
      add.op !== "i32.add" ||
      add.lhs !== old.result ||
      add.rhs !== one.result ||
      write?.kind !== "slot.write" ||
      write.slotIndex !== index.slotIndex ||
      write.value !== add.result ||
      !writes.includes(write)
    )
      continue;
    const initial = writes.find((i) => i !== write)!;
    const value = definitions.get(initial.value);
    if (
      value?.kind !== "const" ||
      value.value.kind !== "i32" ||
      !Number.isInteger(value.value.value) ||
      value.value.value < 0 ||
      value.value.value > 2147483647
    )
      continue;
    // Initialization must be immediately before this loop in its actual
    // executable buffer, not in a sibling branch or another iteration.
    let initialized = false;
    for (const root of store.fn.blocks[0]!.instrs)
      forEachInstrDeep(root, (i) => {
        if (i !== loop) return;
        const buffers = [
          store.fn.blocks[0]!.instrs,
          ...body.flatMap((parent) => {
            if (parent.kind === "for.loop") return [parent.body];
            if (parent.kind === "while.loop") return [parent.body];
            if (parent.kind === "if.stmt") return [parent.then, parent.else ?? []];
            return [];
          }),
        ];
        initialized = buffers.some(
          (buffer) => buffer.indexOf(loop) > 0 && buffer[buffer.indexOf(loop) - 1] === initial,
        );
      });
    if (initialized) return true;
  }
  return false;
}

/** Recompute logical bounds; requested capacity and physical extent grant no JS store authority. */
export function nativeVectorStoreFailure(
  module: IrModule,
  evidence?: () => ReadonlyMap<string, NativeModuleGlobalEvidence>,
): NativeVectorStoreFailure | undefined {
  const stores = numericStores(module);
  if (stores.length === 0) return undefined;
  const globals = evidence?.();
  const failure = (detail: string, unitId = stores[0]!.fn.unitId): NativeVectorStoreFailure => ({
    unitId,
    detail: `native vector original-length store proof: ${detail}`,
  });
  // Flow replays the exact append protocol before an append can preserve L.
  let flow: ReturnType<typeof collectLinearVectorFlow>;
  try {
    flow = collectLinearVectorFlow(module);
  } catch (error) {
    if (!(error instanceof IrUnsupportedError)) throw error;
    return failure(error.message);
  }
  const effects = closedEffects(module);
  if (effects) return failure(effects);
  if (globals) {
    const issue = checkNativeModuleVectorWriters(module, globals) ?? checkNativeModuleVectorReads(module, globals);
    if (issue) return failure("canonical module-vector initialization/read protocol is not complete");
  }
  for (const store of stores) {
    const origins = flow.get(store.fn.unitId)?.get(store.instruction.vec);
    if (!origins?.length || origins.some((origin) => origin.instruction.elements.length > 2147483647))
      return failure("receiver lacks complete finite original lengths", store.fn.unitId);
    if (store.index === undefined) {
      if (!countedLoopStore(store, globals))
        return failure("dynamic store lacks its actual dominating counted-loop proof", store.fn.unitId);
    } else if (
      !Number.isInteger(store.index) ||
      store.index < 0 ||
      origins.some((origin) => store.index! >= origin.instruction.elements.length)
    )
      return failure("constant index is not below every original constructor logical length", store.fn.unitId);
  }
  return undefined;
}
