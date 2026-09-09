// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  forEachNestedBuffer,
  type IrInstr,
  type IrInstrStringConst,
  type IrInstrIntrinsic,
  type IrBlockId,
  type AllocSiteId,
} from "../core/nodes.js";
import type { IrAsyncStateId } from "../core/async-plan.js";
import type { PreparedIrFunction } from "../runtime/contracts/prepared.js";
import type { AllocRegistrySnapshot, AllocRegistryMetadataSnapshot } from "../analysis/contracts/allocations.js";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "../analysis/alloc-registry.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export type NativeStringValuePresence<T> = { readonly present: false } | { readonly present: true; readonly value: T };

export type NativeStringValueView = "program" | "projection";

export type NativeStringValueBufferRoot =
  | {
      readonly kind: "block";
      readonly index: number;
      readonly id: IrBlockId;
    }
  | {
      readonly kind: "async-plan";
      readonly index: number;
      readonly id: IrAsyncStateId;
    }
  | {
      readonly kind: "async-runtime";
      readonly index: number;
      readonly id: IrAsyncStateId;
    };

export interface NativeStringValueBuffer {
  readonly ownerUnitId: IrUnitId;
  readonly view: NativeStringValueView;
  readonly root: NativeStringValueBufferRoot;

  /** Nested-buffer coordinates, in canonical child-buffer order. */
  readonly path: readonly {
    readonly instructionIndex: number;
    readonly childBufferIndex: number;
  }[];

  readonly instructions: readonly IrInstr[];
}

export interface NativeStringValueOccurrence {
  /** Index into NativeStringValueDemands.buffers. */
  readonly bufferIndex: number;
  readonly instructionIndex: number;
  readonly instruction: IrInstr;
}

export interface NativeStringValueAllocationEvidence {
  readonly allocation: NativeStringValuePresence<AllocSiteId | undefined>;

  /** Null only when no allocation identity was supplied. */
  readonly canonicalAllocation: AllocSiteId | null;

  readonly metadataRow: NativeStringValuePresence<AllocRegistryMetadataSnapshot>;

  /** Existing unknown metadata payload, not an erased encoding schema. */
  readonly encoding: NativeStringValuePresence<unknown>;
}

export type NativeStringValueLiteralDemand =
  | {
      readonly kind: "string.const";
      readonly occurrence: number;
      readonly instruction: IrInstrStringConst;
      readonly allocation: NativeStringValueAllocationEvidence;
    }
  | {
      readonly kind: "extern.regex";
      readonly occurrence: number;
      readonly part: "pattern" | "flags";
      readonly value: string;
    };

export interface NativeStringValueIntrinsicDemand {
  readonly occurrence: number;
  readonly instruction: IrInstrIntrinsic;
}

export interface NativeStringValueDemands {
  /** Borrowed exact prepared objects; these are not acceptance tokens. */
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;

  readonly owners: readonly {
    readonly unitId: IrUnitId;
    readonly programFunction: PreparedIrFunction;
    readonly projectedFunction: PreparedIrFunction;
  }[];

  /** Preserve the complete snapshot, including unused namespaces/rows. */
  readonly allocations: AllocRegistrySnapshot;

  readonly buffers: readonly NativeStringValueBuffer[];
  readonly occurrences: readonly NativeStringValueOccurrence[];
  readonly literals: readonly NativeStringValueLiteralDemand[];
  readonly intrinsics: readonly NativeStringValueIntrinsicDemand[];
}

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native string/value demands: " + detail);
}
function absent<T>(): NativeStringValuePresence<T> {
  return Object.freeze({ present: false });
}
function present<T>(value: T): NativeStringValuePresence<T> {
  return Object.freeze({ present: true, value });
}
function dense<T>(values: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(values)) fail("missing " + label);
  for (let index = 0; index < values.length; index++)
    if (!Object.hasOwn(values, index) || values[index] === undefined) fail("missing " + label + " occurrence");
  return values;
}

/** Descriptive census only. The coordinator still authenticates the complete program. */
export function collectNativeStringValueDemands(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeStringValueDemands {
  if (program.schema !== "prepared-ir-program-v1") fail("program schema is not prepared-ir-program-v1");
  if (program.sealed !== true) fail("program is not sealed");
  if (program.reconciliation !== "complete") fail("program reconciliation is not complete");
  if (!program.runtime.includes(projection)) fail("foreign selected projection");
  if (
    projection.backend !== "wasmgc" ||
    projection.target !== "standalone" ||
    projection.prepared.manifest.policy.backend !== "wasmgc" ||
    projection.prepared.manifest.policy.target !== "standalone"
  )
    fail("selected projection is not consistently standalone WasmGC");
  const original = dense(program.ir.functions, "program owners"),
    selected = dense(projection.prepared.functions, "projection owners");
  if (!original.length || original.length !== selected.length) fail("missing complete owner population");
  const seen = new Set<IrUnitId>();
  const owners = original.map((fn, index) => {
    const projectedFunction = selected[index];
    if (!fn || !projectedFunction || !fn.unitId || seen.has(fn.unitId) || projectedFunction.unitId !== fn.unitId)
      fail("duplicate, missing or reordered owner identity");
    seen.add(fn.unitId);
    return Object.freeze({ unitId: fn.unitId, programFunction: fn, projectedFunction });
  });
  // Restoration is a private read authority. Output evidence always borrows the
  // ORIGINAL snapshot rows/payloads, not the registry's detached copy.
  let registry: AllocSiteRegistry;
  try {
    registry = AllocSiteRegistry.fromSnapshot(program.allocations);
  } catch (error) {
    return fail("invalid allocation snapshot: " + (error instanceof Error ? error.message : String(error)));
  }
  const rows = new Map(program.allocations.metadata.map((row) => [row.id, row]));
  function evidence(instruction: IrInstrStringConst): NativeStringValueAllocationEvidence {
    const allocation = Object.hasOwn(instruction, "alloc")
      ? present(instruction.alloc)
      : absent<AllocSiteId | undefined>();
    const id = allocation.present ? allocation.value : undefined;
    if (id === undefined)
      return Object.freeze({
        allocation,
        canonicalAllocation: null,
        metadataRow: absent<AllocRegistryMetadataSnapshot>(),
        encoding: absent<unknown>(),
      });
    if (!Number.isSafeInteger(id) || id < 0) fail("invalid live literal allocation identity");
    const site = registry.resolve(id);
    if (!site) fail("unknown, retired or broken live literal allocation " + id);
    const row = rows.get(site.id);
    const encoding = row?.entries.find(([namespace]) => namespace === ALLOC_NAMESPACES.encoding);
    return Object.freeze({
      allocation,
      canonicalAllocation: site.id,
      metadataRow: row ? present(row) : absent<AllocRegistryMetadataSnapshot>(),
      encoding: encoding ? present(encoding[1]) : absent<unknown>(),
    });
  }
  const buffers: NativeStringValueBuffer[] = [],
    occurrences: NativeStringValueOccurrence[] = [],
    literals: NativeStringValueLiteralDemand[] = [],
    intrinsics: NativeStringValueIntrinsicDemand[] = [];
  // Active-path detection rejects cycles without deduplicating shared siblings,
  // roots, states, functions or the two prepared views.
  const active = new Set<readonly IrInstr[]>();
  function visit(
    ownerUnitId: IrUnitId,
    view: NativeStringValueView,
    root: NativeStringValueBufferRoot,
    path: NativeStringValueBuffer["path"],
    instructions: readonly IrInstr[],
  ): void {
    if (!Array.isArray(instructions)) fail("missing instruction buffer");
    if (active.has(instructions)) fail("cyclic nested instruction buffer");
    active.add(instructions);
    const bufferIndex = buffers.length;
    buffers.push(Object.freeze({ ownerUnitId, view, root, path, instructions }));
    for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex++) {
      const instruction = instructions[instructionIndex];
      if (!instruction || !Object.hasOwn(instructions, instructionIndex)) fail("missing instruction occurrence");
      const occurrence = occurrences.length;
      occurrences.push(Object.freeze({ bufferIndex, instructionIndex, instruction }));
      if (instruction.kind === "string.const")
        literals.push(
          Object.freeze({ kind: "string.const", occurrence, instruction, allocation: evidence(instruction) }),
        );
      else if (instruction.kind === "extern.regex") {
        literals.push(Object.freeze({ kind: "extern.regex", occurrence, part: "pattern", value: instruction.pattern }));
        literals.push(Object.freeze({ kind: "extern.regex", occurrence, part: "flags", value: instruction.flags }));
      } else if (instruction.kind === "intrinsic") intrinsics.push(Object.freeze({ occurrence, instruction }));
      let childBufferIndex = 0;
      forEachNestedBuffer(instruction, (child) => {
        const coordinate = Object.freeze({ instructionIndex, childBufferIndex: childBufferIndex++ });
        visit(ownerUnitId, view, root, Object.freeze([...path, coordinate]), child);
      });
    }
    active.delete(instructions);
  }
  for (const owner of owners) {
    for (const [view, fn] of [
      ["program", owner.programFunction],
      ["projection", owner.projectedFunction],
    ] as const) {
      dense(fn.blocks, "blocks").forEach((block, index) =>
        visit(
          owner.unitId,
          view,
          Object.freeze({ kind: "block", index, id: block.id }),
          Object.freeze([]),
          block.instrs,
        ),
      );
      if (fn.asyncPlan)
        dense(fn.asyncPlan.states, "async-plan states").forEach((state, index) =>
          visit(
            owner.unitId,
            view,
            Object.freeze({ kind: "async-plan", index, id: state.id }),
            Object.freeze([]),
            state.body,
          ),
        );
      if (fn.asyncRuntime)
        dense(fn.asyncRuntime.states, "async-runtime states").forEach((state, index) =>
          visit(
            owner.unitId,
            view,
            Object.freeze({ kind: "async-runtime", index, id: state.id }),
            Object.freeze([]),
            state.body,
          ),
        );
    }
  }
  return Object.freeze({
    program,
    projection,
    owners: Object.freeze(owners),
    allocations: program.allocations,
    buffers: Object.freeze(buffers),
    occurrences: Object.freeze(occurrences),
    literals: Object.freeze(literals),
    intrinsics: Object.freeze(intrinsics),
  });
}
