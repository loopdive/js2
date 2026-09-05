// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import { definedFuncAt, definedFuncHandleOf } from "../codegen/func-space.js";
import { planProgramAbiUnitCallable } from "../codegen/program-abi-planning.js";
import { irCallableBindingKey, irUnitCallableBindingId, irUnitFuncRef } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId } from "./identity.js";
import type { IrFuncRef, IrFunction } from "./nodes.js";
import { IrInvariantError } from "./outcomes.js";
import type { WasmFunction } from "./types.js";
import type { PreparedComponentScopeLookup } from "./prepared-component-sealing.js";

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
  preparedScopeLookup?: PreparedComponentScopeLookup,
): IrBindingId | undefined {
  if (ref.binding.kind !== "unit" || !ctx.programAbiSession) return undefined;
  if (preparedScopeLookup) {
    const bindingId = irUnitCallableBindingId(ref.binding.unitId);
    if (preparedScopeLookup.get(bindingId) && preparedScopeLookup.locatorObject(bindingId) === func) {
      return bindingId;
    }
    return undefined;
  }
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
    // (#4618) A fresh allocator slot for a lifted unit whose owner is
    // CPS-lowered (async parent) is still an unpatched placeholder here —
    // typeIdx 0, empty body — because the async path reaches slot binding
    // before Phase 3 lowers the lifted body and patches the real type.
    // Defer program-ABI planning for it: the slot resolves by funcIdx (the
    // low-level compatibility path) and the Phase-3 patch lands in place.
    // A REAL function with a broken type index still fails loudly.
    if (func.body.length === 0) return undefined;
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
  preparedScopeLookup?: PreparedComponentScopeLookup,
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
  const locatorIsCurrent = preparedScopeLookup
    ? preparedScopeLookup.locatorObject(slot.programAbiBindingId) === exact
    : ctx.programAbiSession.hasLocator(slot.programAbiBindingId, exact);
  if (
    !exact ||
    handle === undefined ||
    exact !== definedFuncAt(ctx, slot.funcIdx) ||
    !locatorIsCurrent ||
    (preparedScopeLookup !== undefined && preparedScopeLookup.get(slot.programAbiBindingId) === undefined)
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
export function resolvePreparedSupportCallable(
  ctx: CodegenContext,
  ref: IrFuncRef,
  preparedScopeLookup?: PreparedComponentScopeLookup,
): number {
  if (ref.binding.kind !== "support") {
    throw new IrInvariantError("unknown-function-ref", "lower", `non-support prepared callable ${ref.name}`);
  }
  const session = ctx.programAbiSession;
  if (!session?.hasPlan(ref.binding.bindingId) && !preparedScopeLookup?.get(ref.binding.bindingId)) {
    throw new IrInvariantError(
      "unknown-function-ref",
      "lower",
      `unplanned support ${irCallableBindingKey(ref.binding)}`,
    );
  }
  const bindingId = ref.binding.bindingId;
  if (preparedScopeLookup) {
    const locator = preparedScopeLookup.getLocator(bindingId);
    if (!locator)
      return preparedScopeLookup.resolveCurrentIndex(bindingId, "function", irCallableBindingKey(ref.binding));
    const exact = preparedScopeLookup.locatorObject(bindingId);
    const handle =
      exact && ctx.mod.functions.includes(exact as WasmFunction)
        ? definedFuncHandleOf(ctx, exact as WasmFunction)
        : undefined;
    if (handle === undefined) {
      throw new IrInvariantError(
        "unknown-function-ref",
        "lower",
        `support callable ${bindingId} lost its exact overlay allocator object`,
      );
    }
    return handle;
  }
  if (!session!.hasLocator(bindingId)) {
    return session!.resolveCurrentIndex(bindingId, "function", irCallableBindingKey(ref.binding));
  }
  const matches = ctx.mod.functions.filter((candidate) => session!.locatorBindingId(candidate) === bindingId);
  const exact = matches.length === 1 ? matches[0] : undefined;
  const handle = exact ? definedFuncHandleOf(ctx, exact) : undefined;
  if (!exact || handle === undefined || !session!.hasLocator(bindingId, exact)) {
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
