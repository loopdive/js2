// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import { definedFuncAt, definedFuncHandleOf } from "../codegen/func-space.js";
import { planProgramAbiUnitCallable } from "../codegen/program-abi-planning.js";
import { irCallableBindingKey, irUnitCallableBindingId, irUnitFuncRef } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId } from "./identity.js";
import type { IrFuncRef, IrFunction } from "./nodes.js";
import { IrInvariantError } from "./outcomes.js";
import type { WasmFunction } from "./types.js";

/** Exact binding of one structural source unit to its settled Wasm slot. */
export interface PreparedIrUnitCallableSlot {
  readonly funcIdx: number;
  readonly physicalName: string;
  readonly compatibilityNames: Set<string>;
  programAbiBindingId?: IrBindingId;
}

/** Exact pre-sealed callable owner; a planned binding alone is insufficient. */
export function exactPreparedUnitCallableBindingId(
  session: Pick<NonNullable<CodegenContext["programAbiSession"]>, "hasPlan" | "hasLocator">,
  unitId: IrUnitId,
  func: WasmFunction,
): IrBindingId | undefined {
  const bindingId = irUnitCallableBindingId(unitId);
  return session.hasPlan(bindingId) && session.hasLocator(bindingId, func) ? bindingId : undefined;
}

/** Reuse a sealed unit binding or plan its exact settled source callable. */
export function preparedUnitProgramAbiBinding(
  ctx: CodegenContext,
  ref: IrFuncRef,
  func: WasmFunction,
): IrBindingId | undefined {
  if (ref.binding.kind !== "unit" || !ctx.programAbiSession) return undefined;
  const exact = exactPreparedUnitCallableBindingId(ctx.programAbiSession, ref.binding.unitId, func);
  if (exact) return exact;
  if (
    !ctx.programAbiSession.hasKnownUnit(ref.binding.unitId) ||
    ctx.programAbiSession.registeredDerivedUnit(ref.binding.unitId)
  ) {
    return undefined;
  }
  const signature = ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "resolve",
      `prepared unit ${ref.binding.unitId} / ${ref.name} has non-function type ${func.typeIdx}`,
    );
  }
  return planProgramAbiUnitCallable(ctx, { ref, signature, func });
}

/** Resolve one exact prepared source-unit callable through its allocator object. */
export function resolvePreparedUnitCallable(
  ctx: CodegenContext,
  ref: IrFuncRef,
  slots: ReadonlyMap<IrUnitId, PreparedIrUnitCallableSlot>,
): number {
  if (ref.binding.kind !== "unit") {
    throw new IrInvariantError("unknown-function-ref", "lower", `non-unit prepared callable ${ref.name}`);
  }
  const slot = slots.get(ref.binding.unitId);
  if (!slot || !slot.compatibilityNames.has(ref.name)) {
    throw new IrInvariantError(
      "unknown-function-ref",
      "lower",
      `unknown exact function ref ${ref.binding.unitId} / ${JSON.stringify(ref.name)}`,
    );
  }
  if (!ctx.programAbiSession || !slot.programAbiBindingId) return slot.funcIdx;
  const exact = ctx.irUnitFuncMap.get(ref.binding.unitId);
  const handle = exact ? definedFuncHandleOf(ctx, exact) : undefined;
  if (
    !exact ||
    handle === undefined ||
    exact !== definedFuncAt(ctx, slot.funcIdx) ||
    !ctx.programAbiSession.hasLocator(slot.programAbiBindingId, exact)
  ) {
    throw new IrInvariantError(
      "unknown-function-ref",
      "lower",
      `prepared unit ${ref.binding.unitId} lost its exact allocator-owned callable`,
    );
  }
  return handle;
}

/** Resolve a sealed support callable without trusting a shifted numeric index. */
export function resolvePreparedSupportCallable(ctx: CodegenContext, ref: IrFuncRef): number {
  if (ref.binding.kind !== "support") {
    throw new IrInvariantError("unknown-function-ref", "lower", `non-support prepared callable ${ref.name}`);
  }
  const session = ctx.programAbiSession;
  if (!session?.hasPlan(ref.binding.bindingId)) {
    throw new IrInvariantError(
      "unknown-function-ref",
      "lower",
      `unplanned support ${irCallableBindingKey(ref.binding)}`,
    );
  }
  const bindingId = ref.binding.bindingId;
  if (!session.hasLocator(bindingId)) {
    return session.resolveCurrentIndex(bindingId, "function", irCallableBindingKey(ref.binding));
  }
  const matches = ctx.mod.functions.filter((candidate) => session.locatorBindingId(candidate) === bindingId);
  const exact = matches.length === 1 ? matches[0] : undefined;
  const handle = exact ? definedFuncHandleOf(ctx, exact) : undefined;
  if (!exact || handle === undefined || !session.hasLocator(bindingId, exact)) {
    throw new IrInvariantError(
      "unknown-function-ref",
      "lower",
      `support callable ${bindingId} lost its exact allocator object`,
    );
  }
  return handle;
}

/** Publish or validate the settled callable for one derived IR artifact. */
export function settlePreparedDerivedCallable(
  ctx: CodegenContext,
  entry: {
    readonly artifactUnitId: IrUnitId;
    readonly derivedUnit?: unknown;
    readonly fn: IrFunction;
  },
  replacement: WasmFunction,
  slot: PreparedIrUnitCallableSlot | undefined,
): void {
  if (!entry.derivedUnit || !ctx.programAbiSession) return;
  if (!slot) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `derived unit ${entry.artifactUnitId} has no unique unsettled callable slot`,
    );
  }
  if (slot.programAbiBindingId) {
    const expected = irUnitCallableBindingId(entry.artifactUnitId);
    if (slot.programAbiBindingId !== expected || !ctx.programAbiSession.hasLocator(expected, replacement)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "patch",
        `prepared derived unit ${entry.artifactUnitId} lost its exact settled callable locator`,
      );
    }
    return;
  }
  const signature = ctx.mod.types[replacement.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new IrInvariantError(
      "abi-type-index-mismatch",
      "patch",
      `derived unit ${entry.artifactUnitId} has non-function type ${replacement.typeIdx}`,
    );
  }
  if (!ctx.programAbiSession.registeredDerivedUnit(entry.artifactUnitId)) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `derived unit ${entry.artifactUnitId} was not registered before callable ordering`,
    );
  }
  const bindingId = planProgramAbiUnitCallable(ctx, {
    ref: irUnitFuncRef(entry.fn),
    signature,
    func: replacement,
  });
  if (!bindingId) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "patch",
      `derived unit ${entry.artifactUnitId} was not accepted by Program ABI planning`,
    );
  }
  slot.programAbiBindingId = bindingId;
}
