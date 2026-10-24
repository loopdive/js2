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

import {
  exactPreparedDynamicHelperRef,
  isDynamicInstruction,
  prepareStandaloneDynamicToNumberSupport,
  resolveIrDynamicCarrierType,
  type CodegenContext,
} from "./compiler-timer-shim-preparation.js";
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
import type { Import, ValType } from "./types.js";
import { jsTagToStaticType } from "./js-tag.js";
import { JS_TAG_IDS, jsTagOf } from "./runtime/js-tag-domain.js";

/** The owning integration observes its existing canonical box dispatcher. */
export type PreparedDynamicBoxObserver = (
  from: ValType,
  hint: ReturnType<typeof jsTagToStaticType>,
) => readonly IrFuncRef[] | undefined;

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
  readonly observeDynamicBoxHelpers?: PreparedDynamicBoxObserver;
}): ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence> {
  const { ctx, entries, callableImports } = input;
  const support = new Map<IrUnitId, PreparedDynamicInstructionSupportEvidence>();
  if (!ctx.programAbiTypes) return support;
  const carrierValType = resolveIrDynamicCarrierType(ctx);
  const native = ctx.targetProfile.semanticProviders === "native-first";
  const nativeExternref =
    native &&
    !ctx.fast &&
    ctx.targetProfile.environment !== "javascript" &&
    (ctx.standalone || ctx.wasi) &&
    carrierValType.kind === "externref";
  const plans = new Map<IrUnitId, Map<IrInstr, readonly IrFuncRef[]>>();
  const blocked = new Set<IrUnitId>();
  for (const entry of entries) {
    if (blocked.has(entry.terminalOwnerUnitId)) continue;
    let functionObjects = false;
    for (const block of entry.fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instr) => {
          // Closed runtime identity emitted by the certified producer, never a
          // source-name match or an admission marker in an unrelated body.
          if (
            instr.kind === "call" &&
            instr.target.binding.kind === "runtime" &&
            instr.target.binding.symbol === "__ir_dyn_call_box"
          )
            functionObjects = true;
        });
    const unitExternref =
      nativeExternref || (native && functionObjects && !ctx.fast && carrierValType.kind === "externref");
    const types = valueTypesOf(entry.fn);
    const planned = new Map<IrInstr, readonly IrFuncRef[]>();
    let nameable = true;
    for (const block of entry.fn.blocks)
      for (const root of block.instrs) {
        forEachInstrDeep(root, (instr) => {
          if (!isDynamicInstruction(instr)) return;
          // Bind the selected carrier's exact providers before dependency
          // discovery. Unsupported operations invalidate the whole terminal
          // sidecar; a sibling operation's evidence cannot cover them.
          if (unitExternref && instr.kind === "dyn.to_number") {
            if (ctx.standalone) {
              const refs = prepareStandaloneDynamicToNumberSupport(ctx, callableImports);
              if (refs === undefined) nameable = false;
              else planned.set(instr, refs);
            } else {
              const ref = exactPreparedDynamicHelperRef(
                ctx,
                callableImports,
                "__unbox_number",
                ctx.funcMap.get("__unbox_number"),
                [{ kind: "externref" }],
                [{ kind: "f64" }],
              );
              if (ref === undefined) nameable = false;
              else planned.set(instr, [ref]);
            }
            return;
          }
          if (
            native &&
            functionObjects &&
            !ctx.fast &&
            carrierValType.kind === "externref" &&
            (instr.kind === "dyn.truthy" || instr.kind === "dyn.typeof" || (instr.kind === "dyn.eq" && !instr.loose))
          ) {
            const name =
              instr.kind === "dyn.truthy"
                ? "__is_truthy"
                : instr.kind === "dyn.typeof"
                  ? "__typeof"
                  : "__extern_strict_eq";
            const params: readonly ValType[] =
              instr.kind === "dyn.eq" ? [{ kind: "externref" }, { kind: "externref" }] : [{ kind: "externref" }];
            const results: readonly ValType[] =
              instr.kind === "dyn.typeof" ? [{ kind: "externref" }] : [{ kind: "i32" }];
            const ref = exactPreparedDynamicHelperRef(
              ctx,
              callableImports,
              name,
              ctx.funcMap.get(name),
              params,
              results,
            );
            if (ref === undefined) nameable = false;
            else planned.set(instr, [ref]);
            return;
          }
          // (#7106 Stage 4) `message === undefined` / `thrown === null` over the
          // externref carrier: the host tag.test arms `emitTagTest` emits —
          // Undefined calls `__typeof_undefined`, Null is a bare `ref.is_null`
          // (no callable). Other partitions stay unnamed (unmeasured).
          if (
            native &&
            functionObjects &&
            !ctx.fast &&
            carrierValType.kind === "externref" &&
            instr.kind === "tag.test" &&
            instr.tagId !== undefined
          ) {
            if (instr.tagId === JS_TAG_IDS.Null) {
              planned.set(instr, []);
              return;
            }
            if (instr.tagId !== JS_TAG_IDS.Undefined) {
              nameable = false;
              return;
            }
            const ref = exactPreparedDynamicHelperRef(
              ctx,
              callableImports,
              "__typeof_undefined",
              ctx.funcMap.get("__typeof_undefined"),
              [{ kind: "externref" }],
              [{ kind: "i32" }],
            );
            if (ref === undefined) nameable = false;
            else planned.set(instr, [ref]);
            return;
          }
          // (#7106 Stage 4) `var x;` / missing-member reads produce the
          // carrier's undefined: on the native-string externref lane that is
          // the extern-wrapped `$undefined` singleton (`emitUndefined`), a
          // backend sequence that calls nothing.
          if (
            native &&
            functionObjects &&
            !ctx.fast &&
            ctx.nativeStrings &&
            carrierValType.kind === "externref" &&
            instr.kind === "dyn.undefined"
          ) {
            planned.set(instr, []);
            return;
          }
          if (
            native &&
            (functionObjects || nativeExternref) &&
            (instr.kind === "dyn.member_get" || instr.kind === "dyn.member_set")
          ) {
            const read = instr.kind === "dyn.member_get";
            const name = read
              ? "__dyn_member_get"
              : instr.sloppy === true
                ? "__dyn_member_set_sloppy"
                : "__dyn_member_set";
            const params = Array.from({ length: read ? 2 : 3 }, () => carrierValType);
            const ref = exactPreparedDynamicHelperRef(
              ctx,
              callableImports,
              name,
              ctx.funcMap.get(name),
              params,
              read ? [carrierValType] : [],
            );
            if (ref === undefined) nameable = false;
            else planned.set(instr, [ref]);
            return;
          }
          if (
            native &&
            (functionObjects || nativeExternref) &&
            instr.kind === "box" &&
            instr.toType.kind === "dynamic"
          ) {
            const operand = types.get(instr.value);
            const from: ValType | null =
              operand?.kind === "callable"
                ? { kind: "externref" }
                : operand?.kind === "string"
                  ? ctx.nativeStrings && ctx.anyStrTypeIdx >= 0
                    ? { kind: "ref", typeIdx: ctx.anyStrTypeIdx }
                    : { kind: "externref" }
                  : operand
                    ? asVal(operand)
                    : null;
            if (!from) {
              nameable = false;
              return;
            }
            if (!ctx.fast && (from.kind === "externref" || from.kind === "ref" || from.kind === "ref_null")) {
              planned.set(instr, []); // Backend identity/extern.convert_any: no callable.
              return;
            }
            if (!ctx.fast && carrierValType.kind === "externref" && from.kind === "i32") {
              // Same refinement split as makeDynamicLowering.emitBox: Boolean
              // i32 uses __box_boolean; an unrefined i32 first converts to f64
              // and uses __box_number. The conversion itself calls no helper.
              const boolean = instr.toType.tag === JS_TAG_IDS.Boolean;
              const name = boolean ? "__box_boolean" : "__box_number";
              const ref = exactPreparedDynamicHelperRef(
                ctx,
                callableImports,
                name,
                ctx.funcMap.get(name),
                [{ kind: boolean ? "i32" : "f64" }],
                [{ kind: "externref" }],
              );
              if (ref === undefined) nameable = false;
              else planned.set(instr, [ref]);
              return;
            }
            if (ctx.fast) {
              const tag = instr.toType.tag;
              const hint = jsTagToStaticType(tag === undefined ? undefined : jsTagOf(tag));
              const refs = input.observeDynamicBoxHelpers?.(from, hint);
              if (refs === undefined) nameable = false;
              else planned.set(instr, refs);
              return;
            }
          }
          const name = exactHostHelperName(instr, types);
          const ref =
            name === null
              ? undefined
              : exactPreparedDynamicHelperRef(
                  ctx,
                  callableImports,
                  name,
                  ctx.funcMap.get(name),
                  [{ kind: "f64" }],
                  [{ kind: "externref" }],
                );
          if (ref === undefined) nameable = false;
          else planned.set(instr, [ref]);
        });
      }
    if (!nameable) {
      blocked.add(entry.terminalOwnerUnitId);
      plans.delete(entry.terminalOwnerUnitId);
      continue;
    }
    if (planned.size === 0 && !carriesDynamicSurface(entry.fn, types)) continue;
    const existing = plans.get(entry.terminalOwnerUnitId);
    if (existing) for (const [instr, refs] of planned) existing.set(instr, refs);
    else plans.set(entry.terminalOwnerUnitId, planned);
  }
  if (plans.size === 0) return support;
  const carrier = ctx.programAbiTypes.prepareDynamicCarrier(carrierValType);
  for (const [unitId, instructionCallables] of plans)
    support.set(unitId, Object.freeze({ dynamicCarrierRef: carrier.carrierRef, instructionCallables }));
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
