// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  forEachInstrDeep,
  forEachNestedBuffer,
  type AllocSiteId,
  type IrInstr,
  type IrSiteId,
  type IrValueId,
} from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";
import { createVerifiedAllocationSnapshot } from "../analysis/allocations/snapshot.js";
import { assertFinalAllocProvenance } from "../analysis/alloc-verification.js";
import { verifyLinearPreparedAllocationFacts } from "../analysis/linear/allocation-facts.js";
import { assertPreparedIrFunctionAllocationTypesAndStates } from "./allocation-body-validation.js";
import { assertPreparedIrData, freezePreparedIrValue } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { PreparedLinearMemoryInput } from "./linear-allocation-facts.js";

export type PreparedLinearMemoryDemandPath = readonly (string | number)[];

/** A position in the exact selected module, including its semantic support bodies. */
export interface PreparedLinearMemoryDemandLocation {
  readonly functionIndex: number;
  readonly unitId: IrUnitId;
  readonly ownerFunction: string;
  readonly instructionPath: PreparedLinearMemoryDemandPath;
  readonly site?: IrSiteId;
}

/** Semantic lookups, separate from the canonical catalogue and physical dependency closure. */
export type PreparedLinearVectorLookup = "allocate" | "initialize-element" | "resolve-forwarding";

interface PreparedLinearVectorDemandBase extends PreparedLinearMemoryDemandLocation {
  readonly allocationId: AllocSiteId;
  readonly vectorValue: IrValueId;
  /** Exact defining position; never the first allocation or a function-name match. */
  readonly constructionPath: PreparedLinearMemoryDemandPath;
  readonly lookups: readonly PreparedLinearVectorLookup[];
}

export type PreparedLinearMemoryDemandOccurrence =
  | (PreparedLinearVectorDemandBase & {
      readonly kind: "vec.new_fixed";
      readonly length: number;
      readonly capacity: number;
    })
  | (PreparedLinearVectorDemandBase & {
      readonly kind: "vec.get" | "vec.len" | "vec.set";
    });

/**
 * Descriptive DATA only, not admission, a binding registry or a target plan.
 * The target planner must join these exact owners against the prepared program's
 * primary/support descriptors and reject allocating support and unapproved
 * storage policies before reservation. The checked input has no such descriptors.
 */
export interface PreparedLinearMemoryDemand {
  readonly occurrences: readonly PreparedLinearMemoryDemandOccurrence[];
}

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `linear memory demand: ${detail}`);
}

function unsupported(at: PreparedLinearMemoryDemandLocation, detail: string, allocationId?: AllocSiteId): never {
  throw new IrUnsupportedError("array-representation-unsupported", "resolve", detail, {
    ...at,
    ...(allocationId === undefined ? {} : { allocationId }),
  });
}

/** Locate canonical child buffers through DATA fields, without another instruction-kind catalogue. */
function childBufferPaths(instr: IrInstr, buffers: readonly (readonly IrInstr[])[]): PreparedLinearMemoryDemandPath[] {
  if (buffers.length === 0) return [];
  const paths: PreparedLinearMemoryDemandPath[] = [];
  const active = new Set<object>();
  const visit = (value: unknown, path: (string | number)[]): void => {
    if (buffers.includes(value as readonly IrInstr[])) {
      paths.push(path);
      return;
    }
    if (!value || typeof value !== "object" || active.has(value)) return;
    active.add(value);
    for (const key of Object.keys(value)) {
      const part = Array.isArray(value) ? Number(key) : key;
      visit((value as Record<string, unknown>)[key], [...path, part]);
    }
    active.delete(value);
  };
  visit(instr, []);
  return buffers.map((buffer) => {
    const index = paths.findIndex((path) => {
      let value: unknown = instr;
      for (const key of path) value = (value as Record<string | number, unknown>)[key];
      return value === buffer;
    });
    if (index < 0) invalid("canonical child buffer has no distinct DATA path");
    return paths.splice(index, 1)[0]!;
  });
}

/** Paths are checked against the canonical deep census, including repeated object occurrences. */
function positionedInstructions(
  root: IrInstr,
  path: PreparedLinearMemoryDemandPath,
): {
  readonly instr: IrInstr;
  readonly path: PreparedLinearMemoryDemandPath;
}[] {
  const positions: { instr: IrInstr; path: PreparedLinearMemoryDemandPath }[] = [];
  const locate = (instr: IrInstr, current: PreparedLinearMemoryDemandPath): void => {
    positions.push({ instr, path: current });
    const buffers: (readonly IrInstr[])[] = [];
    forEachNestedBuffer(instr, (buffer) => buffers.push(buffer));
    const paths = childBufferPaths(instr, buffers);
    buffers.forEach((buffer, ordinal) =>
      buffer.forEach((child, index) => locate(child, [...current, ...paths[ordinal]!, index])),
    );
  };
  locate(root, path);
  let index = 0;
  forEachInstrDeep(root, (instr) => {
    if (positions[index++]?.instr !== instr) invalid("instruction paths disagree with canonical deep traversal");
  });
  if (index !== positions.length) invalid("instruction paths have a foreign occurrence");
  return positions;
}

function f64(type: IrType | null | undefined): boolean {
  return type?.kind === "val" && type.val.kind === "f64";
}

function checkedVector(type: IrType | null | undefined, at: PreparedLinearMemoryDemandLocation): void {
  if (type?.kind !== "vec" || !f64(type.elementType))
    unsupported(at, "native Linear memory demand requires a fixed f64 vector");
  if (type.layout !== undefined) unsupported(at, "native Linear vector demand cannot carry a persisted GC layout");
}

/**
 * Consume the existing checked final input without source/checker/solver work.
 * Recheck facts before any coverage refusal so detached mutation cannot demote
 * malformed evidence. All module functions and async state buffers are visited.
 */
export function collectPreparedLinearMemoryDemand(input: PreparedLinearMemoryInput): PreparedLinearMemoryDemand {
  assertPreparedIrData(input);
  try {
    const lookup = createVerifiedAllocationSnapshot(input.facts.registry);
    for (const fn of input.module.functions) {
      assertFinalAllocProvenance(fn, lookup);
      assertPreparedIrFunctionAllocationTypesAndStates(fn, lookup);
    }
    verifyLinearPreparedAllocationFacts(input.module, input.facts);
  } catch (error) {
    if (error instanceof PreparedIrProgramInvariantError) throw error;
    invalid(error instanceof Error ? error.message : String(error));
  }

  const occurrences: PreparedLinearMemoryDemandOccurrence[] = [];
  input.module.functions.forEach((fn, functionIndex) => {
    const owner = { functionIndex, unitId: fn.unitId, ownerFunction: fn.name };
    if (fn.exported) {
      for (let index = 0; index < fn.params.length; index++) {
        if (fn.params[index]!.type.kind === "vec")
          unsupported(
            { ...owner, instructionPath: ["functions", functionIndex, "params", index, "type"] },
            "native Linear public vector parameter ABI is unsupported",
          );
      }
      for (let index = 0; index < fn.resultTypes.length; index++) {
        if (fn.resultTypes[index]!.kind === "vec")
          unsupported(
            { ...owner, instructionPath: ["functions", functionIndex, "resultTypes", index] },
            "native Linear public vector result ABI is unsupported",
          );
      }
    }
    const positions: ReturnType<typeof positionedInstructions> = [];
    fn.blocks.forEach((block, blockIndex) =>
      block.instrs.forEach((instr, index) =>
        positions.push(
          ...positionedInstructions(instr, ["functions", functionIndex, "blocks", blockIndex, "instrs", index]),
        ),
      ),
    );
    fn.asyncPlan?.states.forEach((state, stateIndex) =>
      state.body.forEach((instr, index) =>
        positions.push(
          ...positionedInstructions(instr, [
            "functions",
            functionIndex,
            "asyncPlan",
            "states",
            stateIndex,
            "body",
            index,
          ]),
        ),
      ),
    );
    // This is an exact local defining-instruction join, not ownership/escape
    // analysis or an inferred interprocedural vector ABI.
    const constructions = new Map<IrValueId, (typeof positions)[number]>();
    for (const position of positions) {
      if (position.instr.kind === "vec.new_fixed" && position.instr.result !== null) {
        if (constructions.has(position.instr.result)) invalid(`duplicate vector definition in ${fn.unitId}`);
        constructions.set(position.instr.result, position);
      }
    }
    for (const { instr, path } of positions) {
      const at = { ...owner, instructionPath: path, ...(instr.site === undefined ? {} : { site: instr.site }) };
      if (instr.kind === "vec.set_length" || instr.kind === "forof.vec")
        unsupported(at, `native Linear semantic demand does not admit ${instr.kind}`);
      if (instr.alloc !== undefined && instr.kind !== "vec.new_fixed")
        unsupported(at, `native Linear memory demand does not admit allocating ${instr.kind}`, instr.alloc);
      if (instr.kind === "vec.new_fixed") {
        checkedVector(instr.resultType, at);
        if (!f64(instr.elementType)) unsupported(at, "native Linear construction requires f64 elements", instr.alloc);
        if (instr.result === null || instr.alloc === undefined)
          invalid(`construction lacks its result/site in ${fn.unitId}`);
        const capacity = instr.capacity ?? instr.elements.length;
        if (!Number.isSafeInteger(capacity) || capacity < instr.elements.length || capacity > 0xffffffff)
          unsupported(at, "native Linear fixed vector capacity is unsupported", instr.alloc);
        occurrences.push({
          ...at,
          kind: instr.kind,
          allocationId: instr.alloc,
          vectorValue: instr.result,
          constructionPath: path,
          length: instr.elements.length,
          capacity,
          // emitVecNewFixed resolves the initializer even for an empty literal.
          lookups: ["allocate", "initialize-element"],
        });
      } else if (instr.kind === "vec.get" || instr.kind === "vec.len" || instr.kind === "vec.set") {
        const construction = constructions.get(instr.vec);
        if (!construction || construction.instr.kind !== "vec.new_fixed")
          unsupported(at, "native Linear vector operand has no exact local fixed-construction allocation");
        checkedVector(construction.instr.resultType, at);
        const allocationId = construction.instr.alloc;
        if (allocationId === undefined) invalid(`vector operand lost its construction allocation in ${fn.unitId}`);
        occurrences.push({
          ...at,
          kind: instr.kind,
          allocationId,
          vectorValue: instr.vec,
          constructionPath: construction.path,
          lookups: ["resolve-forwarding"],
        });
      }
    }
  });
  return freezePreparedIrValue({ occurrences }) as PreparedLinearMemoryDemand;
}
