// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5297) Generalize the compiler-timer-shim dynamic sidecar to EVERY prepared
// unit whose final IR carries the externref dynamic surface.
//
// The `dynamic` arm of `recordImplicitTypeRequirement`
// (`prepared-component-dependencies.ts`) blocks whenever no `dynamicCarrierRef`
// reaches it, and `preparedDynamicCarrierRef` reads two sidecars only:
// `classAccessorWritebacks` and `dynamicInstructionSupport`. Measured on
// `origin/main 42a0adf7d4`: an ordinary compatibility-lane module-init that
// stores `1` into an `any` binding has NEITHER (the writeback map exists but
// carries no entry for the unit; the instruction-support map is absent
// entirely), so it demotes on
// `implicit-support-reference-unavailable` AFTER #5525 admitted its storage.
//
// This module supplies exactly what that arm asks for, and nothing else:
//   - the ONE carrier the module already selected
//     (`prepareDynamicCarrier(resolveIrDynamicCarrierType(ctx))` — the same
//     mint `integration.ts` and the timer shim use), and
//   - for each dynamic instruction, the EXACT physical helper the module's own
//     `emitBox` arm calls, bound through `exactPreparedDynamicHelperRef` (the
//     #3526 F1-S3 precedent: the manifest still decides which symbol answers,
//     the seam only binds it through the kind the observation path accepts).
//
// It is fail-closed by construction: a unit whose dynamic instructions this
// slice cannot name to an exact physical symbol is left exactly as the base
// tree leaves it, and no ABI binding is minted for it.

import { resolveIrDynamicCarrierType } from "../codegen/any-helpers.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { exactPreparedDynamicHelperRef, isDynamicInstruction } from "./compiler-timer-shim-preparation.js";
import type { IrUnitId } from "./identity.js";
import {
  asVal,
  forEachInstrDeep,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrValueId,
} from "./nodes.js";
import type { PreparedDynamicInstructionSupportEvidence } from "./prepared-instruction-support.js";
import type { Import } from "./types.js";

/** One prepared artifact body and the terminal unit that owns it. */
export interface PreparedDynamicSupportEntry {
  readonly terminalOwnerUnitId: IrUnitId;
  readonly fn: IrFunction;
}

/**
 * The host arm of `makeDynamicLowering`'s `emitBox` reads the OPERAND's
 * ValType kind (`integration.ts`, `case "f64": [callImport("__box_number")]`).
 * `null` means "this slice cannot name the physical symbol for this
 * instruction" — the owning unit is then dropped, never guessed at.
 *
 * Deliberately narrow, and narrow BY MEASUREMENT: the externref arms of
 * `emitBox`/`emitUnbox` are identity sequences that call nothing at all (so no
 * callable ref can honestly satisfy `implicitSupportRequirement`), and no unit
 * in the measured cohort reaches a prepared component with an `unbox` or a
 * `dyn.*` instruction, so naming a helper for those would be unverifiable code.
 */
function exactHostHelperName(instr: IrInstr, types: ReadonlyMap<IrValueId, IrType>): "__box_number" | null {
  if (instr.kind !== "box" || instr.toType.kind !== "dynamic") return null;
  const operand = types.get(instr.value);
  // The host arm dispatches on the OPERAND kind FIRST: an f64 operand calls
  // `__box_number` whatever the tag refinement says (measured — the module-init
  // box of `let a: any = 1` carries tag 3 and still takes the f64 arm). The
  // hint only picks a different symbol on the i32 arm (`__box_boolean`), which
  // this slice deliberately does not name.
  return operand !== undefined && asVal(operand)?.kind === "f64" ? "__box_number" : null;
}

/** Value → IrType for one body, the same population `valueTypesOf` visits. */
function valueTypesOf(fn: IrFunction): Map<IrValueId, IrType> {
  const types = new Map<IrValueId, IrType>();
  for (const param of fn.params) types.set(param.value, param.type);
  for (const value of fn.asyncPlan?.values ?? []) types.set(value.value, value.type);
  for (const block of fn.blocks) {
    block.blockArgs.forEach((value, index) => {
      const type = block.blockArgTypes[index];
      if (type) types.set(value, type);
    });
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => {
        if (nested.result !== null && nested.resultType !== null) types.set(nested.result, nested.resultType);
      });
    }
  }
  return types;
}

/** Does this body carry the dynamic surface at all (type OR instruction)? */
function carriesDynamicSurface(fn: IrFunction, types: ReadonlyMap<IrValueId, IrType>): boolean {
  if (fn.params.some((param) => param.type.kind === "dynamic")) return true;
  if (fn.resultTypes.some((type) => type.kind === "dynamic")) return true;
  for (const type of types.values()) if (type.kind === "dynamic") return true;
  return false;
}

/**
 * Prepare the dynamic sidecar for every terminal unit that needs it.
 *
 * Not gated on `ctx.fast`: the gate is the module's OWN resolved carrier. The
 * `$AnyValue` lane routes `emitBox` through `boxToAny`'s `__any_box_*` family,
 * whose symbolization is a later slice, so it is skipped by measuring the
 * carrier rather than by reading the mode flag. Nothing above the first gate
 * runs for a module with no dynamic-carrying prepared unit, so an unaffected
 * compilation mints no binding and observes no provider.
 */
export function prepareDynamicInstructionSupportForUnits(input: {
  readonly ctx: CodegenContext;
  readonly entries: readonly PreparedDynamicSupportEntry[];
  readonly callableImports: ReadonlyMap<string, Import>;
}): ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence> {
  const { ctx, entries, callableImports } = input;
  const support = new Map<IrUnitId, PreparedDynamicInstructionSupportEvidence>();
  // Plan first, mint nothing: `plans` holds only units whose every dynamic
  // instruction resolved to an exact physical symbol.
  const plans = new Map<IrUnitId, Map<IrInstr, "__box_number">>();
  for (const entry of entries) {
    const types = valueTypesOf(entry.fn);
    const planned = new Map<IrInstr, "__box_number">();
    let nameable = true;
    for (const block of entry.fn.blocks) {
      for (const root of block.instrs) {
        forEachInstrDeep(root, (instr) => {
          if (!isDynamicInstruction(instr)) return;
          const name = exactHostHelperName(instr, types);
          if (name === null) nameable = false;
          else planned.set(instr, name);
        });
      }
    }
    if (!nameable || (planned.size === 0 && !carriesDynamicSurface(entry.fn, types))) {
      plans.delete(entry.terminalOwnerUnitId);
      continue;
    }
    const existing = plans.get(entry.terminalOwnerUnitId);
    if (existing) for (const [instr, name] of planned) existing.set(instr, name);
    else plans.set(entry.terminalOwnerUnitId, planned);
  }
  if (plans.size === 0 || !ctx.programAbiTypes) return support;
  const carrierValType = resolveIrDynamicCarrierType(ctx);
  if (carrierValType.kind !== "externref") return support;
  const needsBoxNumber = [...plans.values()].some((planned) => planned.size > 0);
  const boxNumber = needsBoxNumber
    ? exactPreparedDynamicHelperRef(
        ctx,
        callableImports,
        "__box_number",
        ctx.funcMap.get("__box_number"),
        [{ kind: "f64" }],
        [{ kind: "externref" }],
      )
    : undefined;
  const usable = [...plans].filter(([, planned]) => planned.size === 0 || boxNumber !== undefined);
  if (usable.length === 0) return support;
  const carrier = ctx.programAbiTypes.prepareDynamicCarrier(carrierValType);
  for (const [unitId, planned] of usable) {
    const instructionCallables = new Map<IrInstr, readonly IrFuncRef[]>();
    if (boxNumber) for (const instr of planned.keys()) instructionCallables.set(instr, [boxNumber]);
    support.set(unitId, Object.freeze({ dynamicCarrierRef: carrier.carrierRef, instructionCallables }));
  }
  return support;
}

/**
 * Merge the timer-shim sidecar with the general one. Unit ids are disjoint by
 * construction (a timer-shim terminal is a `synthetic-support` unit that this
 * module's `box`-only arm never names), so an overlap means one of the two
 * producers changed its population — fail closed rather than prefer either.
 */
export function mergeDynamicInstructionSupport(
  first: ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence> | undefined,
  second: ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence>,
  onOverlap: (unitId: IrUnitId) => never,
): ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence> | undefined {
  if (!first || first.size === 0) return second.size === 0 ? first : second;
  if (second.size === 0) return first;
  const merged = new Map(first);
  for (const [unitId, evidence] of second) {
    if (merged.has(unitId)) onOverlap(unitId);
    merged.set(unitId, evidence);
  }
  return merged;
}
