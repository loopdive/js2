// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354) The calls of a program that a family of runtime declarations names (`js.object.*`, …), each paired with
 * its semantic original. A prepared projection may rewrite a function but must keep every such call: the same
 * population in the same order, with the same target, source site and region, so each execution call answers for
 * exactly one semantic call. A family adds what else the projection must keep of its calls (`samePair`).
 */
import type { IrInstrCall, IrValueId } from "../core/nodes.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import type { RuntimeFeature } from "../runtime/contracts/manifest.js";
import { nativeAsyncCallableValueTypes, nativeAsyncCallMismatch } from "../runtime/native-async-callables.js";
import { preparedIrDataMismatch } from "./data.js";
import type { NativeStringValueDemands } from "./native-string-value-demands.js";
import {
  indexNativeValueDefinitions,
  nativeValueBufferSelected,
  type NativeValueOccurrence,
  type NativeValueRepresentation,
} from "./native-value-definitions.js";

export type SourceCallDefinitions = ReadonlyMap<IrValueId, NativeValueOccurrence>;

/** A projected call of a family beside its semantic original, each with its own function's SSA definitions. */
export interface SourceCallPair {
  readonly demands: NativeStringValueDemands;
  readonly feature: RuntimeFeature;
  readonly call: IrInstrCall;
  readonly definitions: SourceCallDefinitions;
  readonly original: IrInstrCall;
  readonly originalDefinitions: SourceCallDefinitions;
}

export interface SourceCallFamily<F extends RuntimeFeature> {
  /** The family's declaration of a call target, by its exact semantic binding. */
  readonly declaration: (ref: IrFuncRef) => (IrRuntimeCallableDeclaration & { readonly feature: F }) | undefined;
  /** Fails when the projection changed what the family's calls need beyond their target, site and region. */
  readonly samePair?: (pair: SourceCallPair) => void;
}

/** One executed call of a family: its occurrence, its semantic original's, and the function that makes it. */
export interface SourceCall<F extends RuntimeFeature> {
  readonly occurrence: number;
  readonly semanticOccurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly feature: F;
}

interface Row<F extends RuntimeFeature> {
  readonly occurrence: number;
  readonly call: IrInstrCall;
  readonly family: SourceCallFamily<F>;
  readonly declaration: IrRuntimeCallableDeclaration & { readonly feature: F };
  readonly region: unknown;
}

function fail(detail: string): never {
  throw new Error("native source calls: " + detail);
}
function same(left: unknown, right: unknown, detail: string): void {
  if (preparedIrDataMismatch(left, right) !== undefined) fail(detail);
}

/** The SSA definitions of one function view, in one representation of its async states. */
export function sourceCallDefinitions(
  demands: NativeStringValueDemands,
  unitId: IrUnitId,
  view: "program" | "projection",
  representation: NativeValueRepresentation = "execution",
): SourceCallDefinitions {
  return indexNativeValueDefinitions(
    demands,
    unitId,
    view,
    () => fail("ambiguous prepared SSA definition"),
    representation,
  ).definitions;
}

function rows<F extends RuntimeFeature>(
  demands: NativeStringValueDemands,
  families: readonly SourceCallFamily<F>[],
  unitId: IrUnitId,
  view: "program" | "projection",
  representation: NativeValueRepresentation,
): Row<F>[] {
  return demands.occurrences.flatMap((row, occurrence) => {
    const buffer = demands.buffers[row.bufferIndex]!,
      call = row.instruction;
    if (
      buffer.ownerUnitId !== unitId ||
      buffer.view !== view ||
      call.kind !== "call" ||
      !nativeValueBufferSelected(demands, buffer, representation)
    )
      return [];
    for (const family of families) {
      const declaration = family.declaration(call.target);
      if (!declaration) continue;
      // An async function's runtime states re-cut its semantic plan: both name the plan's region.
      const region = {
        root: { ...buffer.root, kind: buffer.root.kind === "async-runtime" ? "async-plan" : buffer.root.kind },
        path: buffer.path,
      };
      return [{ occurrence, call, family, declaration, region }];
    }
    return [];
  });
}

function pairRows<F extends RuntimeFeature>(
  demands: NativeStringValueDemands,
  semantic: readonly Row<F>[],
  originalDefinitions: SourceCallDefinitions,
  projected: readonly Row<F>[],
  definitions: SourceCallDefinitions,
): readonly (readonly [Row<F>, number])[] {
  if (semantic.length !== projected.length) fail("semantic/projection source call population differs");
  return projected.map((row, index) => {
    const original = semantic[index]!;
    if (row.declaration.feature !== original.declaration.feature) fail("semantic/projection source call order differs");
    same(row.region, original.region, "source call region changed across projection");
    same(row.call.target.binding, original.call.target.binding, "source call binding changed across projection");
    same(row.call.site, original.call.site, "source call site changed across projection");
    row.family.samePair?.({
      demands,
      feature: row.declaration.feature,
      call: row.call,
      definitions,
      original: original.call,
      originalDefinitions,
    });
    return [row, original.occurrence] as const;
  });
}

/**
 * Every executed call the `families` declare, in occurrence order. The retained semantic plan of an async function and
 * its execution are each paired with the original; the execution's calls are the ones that run.
 */
export function pairedSourceCalls<F extends RuntimeFeature>(
  demands: NativeStringValueDemands,
  families: readonly SourceCallFamily<F>[],
): readonly SourceCall<F>[] {
  const calls: SourceCall<F>[] = [];
  for (const owner of demands.owners) {
    const originalDefinitions = sourceCallDefinitions(demands, owner.unitId, "program", "semantic");
    const semantic = rows(demands, families, owner.unitId, "program", "semantic");
    for (const representation of ["semantic", "execution"] as const) {
      const definitions = sourceCallDefinitions(demands, owner.unitId, "projection", representation);
      const projected = rows(demands, families, owner.unitId, "projection", representation);
      const pairs = pairRows(demands, semantic, originalDefinitions, projected, definitions);
      if (representation === "semantic") continue;
      const types = nativeAsyncCallableValueTypes(owner.projectedFunction);
      for (const [row, semanticOccurrence] of pairs) {
        const mismatch = nativeAsyncCallMismatch(row.call, row.declaration, types);
        if (mismatch) fail("call differs from its canonical declaration: " + mismatch);
        calls.push({
          occurrence: row.occurrence,
          semanticOccurrence,
          ownerUnitId: owner.unitId,
          feature: row.declaration.feature,
        });
      }
    }
  }
  return calls.sort((left, right) => left.occurrence - right.occurrence);
}
