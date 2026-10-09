// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  forEachNestedBuffer,
  type AllocSiteId,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrValueId,
} from "../../core/nodes.js";
import { irTypeEquals, type IrType } from "../../core/types.js";
import { AccessSet } from "../lattice.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import type {
  AllocationEvidenceCensus,
  AllocationEvidenceFailure,
  AllocationEvidenceLocation,
  AllocationEvidenceCursor as Cursor,
  AllocationEvidenceBufferTask as BufferTask,
  AllocationEvidenceTask as Task,
} from "./contracts.js";
import {
  allocationEvidenceEffect,
  primitiveKind,
  profileFunctionExclusion,
  profileInstructionExclusion,
  profileOperandPopulationMatches,
  profileOperands,
} from "./effect-rules.js";

type Counts = { -readonly [K in keyof AllocationEvidenceCensus]: number };
interface State {
  readonly fn: IrFunction;
  readonly registry: AllocRegistrySnapshot;
  readonly counts: Counts;
  readonly allocations: Map<AllocSiteId, AccessSet>;
  readonly visible: Map<IrValueId, IrType>;
  readonly seen: Set<IrValueId>;
  readonly undo: IrValueId[];
  readonly roots: Map<IrValueId, { readonly root: number; readonly id: AllocSiteId }>;
  readonly active: Set<readonly IrInstr[]>;
}
export interface AllocationEvidenceCapture {
  readonly kind: "captured";
  readonly census: AllocationEvidenceCensus;
  readonly allocations: ReadonlyMap<AllocSiteId, AccessSet>;
}

function location(at: Cursor): AllocationEvidenceLocation {
  const arms: { arm: "then" | "else"; index: number }[] = [];
  for (let path = at.path; path; path = path.parent) arms.push({ arm: path.arm, index: path.index });
  arms.reverse();
  return {
    kind: "instruction",
    unitId: at.fn.unitId,
    block: at.block.id,
    root: at.root,
    arms,
    ...(Object.hasOwn(at.instr, "site") ? { site: at.instr.site } : {}),
  };
}
function invalid(
  code: Extract<AllocationEvidenceFailure, { kind: "invalid" }>["code"],
  at: Cursor,
): AllocationEvidenceFailure {
  return { kind: "invalid", code, at: location(at) };
}
function uncovered(
  reason: Extract<AllocationEvidenceFailure, { kind: "not-covered" }>["reason"],
  at: Cursor,
): AllocationEvidenceFailure {
  return { kind: "not-covered", reason, at: location(at) };
}

function defineResult(state: State, at: Cursor): AllocationEvidenceFailure | undefined {
  const { result, resultType } = at.instr;
  if (result === null) return undefined;
  if (state.seen.has(result) || resultType === null) return invalid("lexical-definition", at);
  state.seen.add(result);
  state.visible.set(result, resultType);
  state.undo.push(result);
  return undefined;
}

function checkOperands(state: State, at: Cursor): AllocationEvidenceFailure | undefined {
  const operands = profileOperands(at.instr);
  if (!profileOperandPopulationMatches(at.instr, operands)) return invalid("occurrence-mismatch", at);
  for (const [index, operand] of operands.entries()) {
    if (at.instr.kind === "if" && index > 0) continue;
    const type = state.visible.get(operand.value);
    if (!type) return invalid("lexical-definition", at);
    if (operand.role !== "receiver") {
      if (primitiveKind(type) !== operand.role) return uncovered("reference-carrier", at);
      continue;
    }
    const root = state.roots.get(operand.value);
    if (!root) return uncovered("nonroot-receiver", at);
    if (root.root >= at.root) return invalid("lexical-definition", at);
  }
  return undefined;
}

function registerAllocation(state: State, at: Cursor): AllocationEvidenceFailure | undefined {
  const instr = at.instr;
  if (instr.kind !== "vec.new_fixed") return undefined;
  if (at.path) return uncovered("nested-allocation", at);
  const id = instr.alloc;
  if (id === undefined) return invalid("allocation-provenance", at);
  const slot = state.registry.entries[id];
  if (slot?.state === "aliased") return uncovered("allocation-alias", at);
  if (slot?.state !== "live" || slot.site.kind !== "array") return invalid("allocation-provenance", at);
  if (!instr.resultType || !irTypeEquals(slot.site.type, instr.resultType)) return invalid("site-result-type", at);
  if (instr.result === null) return invalid("lexical-definition", at);
  if (state.allocations.has(id)) return uncovered("allocation-site-reuse", at);
  state.allocations.set(id, AccessSet.empty());
  state.roots.set(instr.result, { root: at.root, id });
  state.counts.allocations++;
  return undefined;
}

function applyEffects(state: State, at: Cursor): AllocationEvidenceFailure | undefined {
  const effect = allocationEvidenceEffect(at.instr);
  if (effect.kind === "unsupported") return uncovered("instruction-kind", at);
  for (const operand of effect.ownership) {
    if (operand.op === "escape") continue; // Stored primitives cannot alias an eligible array.
    const root = state.roots.get(operand.value);
    if (!root) return uncovered("nonroot-receiver", at);
    state.allocations.set(root.id, state.allocations.get(root.id)!.with(operand.op));
    if (operand.op === "read") state.counts.vectorReads++;
    else state.counts.vectorWrites++;
  }
  return undefined;
}

function visitInstruction(state: State, at: Cursor, tasks: Task[]): AllocationEvidenceFailure | undefined {
  state.counts.instructions++;
  const reason = profileInstructionExclusion(at.instr);
  if (reason) return uncovered(reason, at);
  const failure = checkOperands(state, at) ?? registerAllocation(state, at) ?? applyEffects(state, at);
  if (failure) return failure;
  if (at.instr.kind !== "if") return defineResult(state, at);
  const instr = at.instr;
  const children: (readonly IrInstr[])[] = [];
  forEachNestedBuffer(instr, (buffer) => children.push(buffer));
  if (children.length !== 2 || children[0] !== instr.then || children[1] !== instr.else)
    return invalid("occurrence-mismatch", at);
  tasks.push({ kind: "define", at });
  for (const arm of ["else", "then"] as const)
    tasks.push({
      kind: "enter",
      buffer: instr[arm],
      index: 0,
      mark: 0,
      parent: at,
      arm,
      end: { value: arm === "then" ? instr.thenValue : instr.elseValue, type: instr.resultType!, at },
    });
  return undefined;
}

function finishBuffer(state: State, task: BufferTask): AllocationEvidenceFailure | undefined {
  if (task.end) {
    const type = state.visible.get(task.end.value);
    if (!type || !irTypeEquals(type, task.end.type)) return invalid("lexical-definition", task.end.at);
  } else {
    const terminator = state.fn.blocks[0]!.terminator;
    if (terminator.kind === "return")
      for (const [index, value] of terminator.values.entries()) {
        const type = state.visible.get(value);
        if (!type || !state.fn.resultTypes[index] || !irTypeEquals(type, state.fn.resultTypes[index]!))
          return { kind: "invalid", code: "lexical-definition", at: { kind: "function", unitId: state.fn.unitId } };
      }
  }
  while (state.undo.length > task.mark) state.visible.delete(state.undo.pop()!);
  state.active.delete(task.buffer);
  return undefined;
}

function visitProfileBuffers(state: State): AllocationEvidenceFailure | undefined {
  const tasks: Task[] = [{ kind: "enter", buffer: state.fn.blocks[0]!.instrs, index: 0, mark: 0 }];
  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.kind === "define") {
      const failure = defineResult(state, task.at);
      if (failure) return failure;
    } else if (task.kind === "enter") {
      if (state.active.has(task.buffer)) return invalid("occurrence-mismatch", task.parent!);
      state.active.add(task.buffer);
      state.counts.buffers++;
      tasks.push({ ...task, kind: "buffer", mark: state.undo.length });
    } else if (task.index === task.buffer.length) {
      const failure = finishBuffer(state, task);
      if (failure) return failure;
    } else {
      const at: Cursor = {
        fn: state.fn,
        block: state.fn.blocks[0]!,
        root: task.parent?.root ?? task.index,
        instr: task.buffer[task.index]!,
        ...(task.parent && task.arm ? { path: { parent: task.parent.path, arm: task.arm, index: task.index } } : {}),
      };
      tasks.push({ ...task, index: task.index + 1 });
      const failure = visitInstruction(state, at, tasks);
      if (failure) return failure;
    }
  }
  return undefined;
}

export function captureAllocationEvidenceCensus(
  module: IrModule,
  registry: AllocRegistrySnapshot,
): AllocationEvidenceCapture | AllocationEvidenceFailure {
  const counts: Counts = {
    functions: 0,
    buffers: 0,
    instructions: 0,
    allocations: 0,
    vectorReads: 0,
    vectorWrites: 0,
    registrySlots: registry.size,
  };
  const allocations = new Map<AllocSiteId, AccessSet>();
  const owners = new Set<IrFunction["unitId"]>();
  for (const fn of module.functions) {
    if (owners.has(fn.unitId))
      return { kind: "invalid", code: "occurrence-mismatch", at: { kind: "function", unitId: fn.unitId } };
    owners.add(fn.unitId);
    counts.functions++;
    const reason = profileFunctionExclusion(fn);
    if (reason) return { kind: "not-covered", reason, at: { kind: "function", unitId: fn.unitId } };
    const state: State = {
      fn,
      registry,
      counts,
      allocations,
      visible: new Map(),
      seen: new Set(),
      undo: [],
      roots: new Map(),
      active: new Set(),
    };
    for (const param of fn.params) {
      if (state.seen.has(param.value))
        return { kind: "invalid", code: "lexical-definition", at: { kind: "function", unitId: fn.unitId } };
      state.seen.add(param.value);
      state.visible.set(param.value, param.type);
    }
    const failure = visitProfileBuffers(state);
    if (failure) return failure;
  }
  return { kind: "captured", census: counts, allocations };
}
