// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "../core/types.js";
import type { PreparedIrFunction } from "../runtime/contracts/prepared.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export type NativeValueStringRepresentation = "native-string" | "primitive-only";
export interface NativeValueResourcePlan {
  readonly anchor: string;
  readonly owners: readonly IrUnitId[];
  readonly strings: NativeValueStringRepresentation;
}
interface Source {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly strings: NativeValueStringRepresentation;
}
const sources = new WeakMap<NativeValueResourcePlan, Source>();

function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native value resources: " + detail);
}

function primitive(type: IrType): boolean {
  return (
    type.kind === "val" &&
    !type.typeRef &&
    (type.val.kind === "f64" || type.val.kind === "f32" || (type.val.kind === "i32" && !type.val.symbol))
  );
}

/** Deliberately narrow affirmative absence proof, not a no-binding fallback. */
function assertPrimitiveOwner(fn: PreparedIrFunction): void {
  if (fn.asyncPlan || fn.asyncRuntime || fn.closureSubtype || (fn.funcKind !== undefined && fn.funcKind !== "regular"))
    fail("primitive-only representation has a runtime-created carrier in " + fn.name);
  if (![...fn.params.map((p) => p.type), ...fn.resultTypes].every(primitive))
    fail("primitive-only representation has a reference/unknown signature in " + fn.name);
  if (fn.slots?.length) fail("primitive-only absence proof does not cover local slots in " + fn.name);
  if (!fn.blocks.length) fail("empty owner body in " + fn.name);
  for (const block of fn.blocks) {
    if (!block.blockArgTypes.every(primitive)) fail("nonprimitive block argument in " + fn.name);
    for (const instr of block.instrs) {
      // This proof covers only scalar leaves. Calls, raw Wasm, allocations,
      // globals, nested buffers and future instruction kinds require a scanner.
      if (
        !["const", "binary", "unary", "select"].includes(instr.kind) ||
        !instr.resultType ||
        !primitive(instr.resultType) ||
        Object.hasOwn(instr, "alloc")
      )
        fail("primitive-only absence proof does not cover " + instr.kind + " in " + fn.name);
    }
  }
}

function calculate({ program, projection, strings }: Source): NativeValueResourcePlan {
  if (program.schema !== "prepared-ir-program-v1" || program.sealed !== true || program.reconciliation !== "complete")
    fail("program is not a complete prepared program");
  if (
    !program.runtime.includes(projection) ||
    projection.backend !== "wasmgc" ||
    projection.target !== "standalone" ||
    projection.prepared.manifest.policy.backend !== "wasmgc" ||
    projection.prepared.manifest.policy.target !== "standalone"
  )
    fail("selected projection does not belong to standalone WasmGC");
  if (strings !== "native-string" && strings !== "primitive-only")
    fail("missing explicit native string representation");
  const entry = program.inventory.sources.find((source) => source.kind === "entry");
  if (!entry || !program.ir.functions.length) fail("missing source anchor or complete owner population");
  const owners = program.ir.functions.map((fn) => fn.unitId);
  if (
    new Set(owners).size !== owners.length ||
    preparedIrDataMismatch(
      owners,
      projection.prepared.functions.map((fn) => fn.unitId),
    ) !== undefined
  )
    fail("selected owner population/order differs");
  if (strings === "primitive-only") {
    if (projection.prepared.manifest.providers.length || program.allocations.size)
      fail("primitive-only absence proof has runtime providers or allocations");
    for (const init of program.startup) {
      if (init.bindings.length || init.liveSeeds.length || init.gaps.length)
        fail("primitive-only absence proof does not cover startup bindings, live seeds or gaps");
      if (init.executable && !owners.includes(init.unitId!)) fail("primitive-only startup owner is absent");
    }
    program.ir.functions.forEach(assertPrimitiveOwner);
    projection.prepared.functions.forEach(assertPrimitiveOwner);
    for (const entry of program.abi.entries) {
      if (entry.contract.kind === "callable") {
        if (![...entry.contract.params, ...entry.contract.results].every(primitive))
          fail("primitive-only ABI includes a reference/unknown callable");
      } else if (entry.contract.kind !== "export" && entry.contract.kind !== "support") {
        fail("primitive-only absence proof does not cover ABI " + entry.contract.kind);
      }
    }
  }
  return { anchor: entry.id, owners, strings };
}

/**
 * Derive selected resources from the actual complete program/projection.
 * Full program/current-attachment authentication remains in the parent's checked
 * wrapper. Primitive-only absence is bounded; it cannot admit the async family.
 */
export function deriveNativeValueResourcePlan(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
  strings: NativeValueStringRepresentation,
): NativeValueResourcePlan {
  const source = { program, projection, strings };
  const plan = freezePreparedIrValue(calculate(source)) as NativeValueResourcePlan;
  sources.set(plan, source);
  return plan;
}

/** Require the issued plan and recheck its live selected source; never accept a copied absence flag. */
export function assertNativeValueResourcePlan(plan: NativeValueResourcePlan): void {
  const source = sources.get(plan);
  if (!source || preparedIrDataMismatch(plan, calculate(source)) !== undefined)
    fail("unissued or stale selected native value requirements");
}
