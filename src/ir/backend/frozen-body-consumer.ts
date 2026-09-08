// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3528 L0-P1 — authenticated backend consumption of FrozenIrBodyBatch.
//
// The consumer is intentionally boring: it validates the complete immutable
// batch and an independent backend plan, then drives the existing generic
// lowerer. It has no source/checker/resolver-discovery hooks and no direct
// fallback. A backend plan that promised an owner and cannot lower it is an
// invariant failure.

import type { IrFunction } from "../nodes.js";
import type { IrUnitId } from "../identity.js";
import { lowerIrFunctionBody, type IrLowerResolver, type IrLoweredBody } from "../lower.js";
import type { TypeConverter } from "./contract.js";
import type { BackendEmitter } from "./emitter.js";
import { verifyIrBackendLegality, type IrBackendKind } from "./legality.js";
import {
  assertFrozenIrBodyBatch,
  type FrozenIrBodyBatch,
  FrozenIrBodyBatchInvariantError,
} from "../frozen-body-batch.js";
import type { Instr } from "../types.js";

export interface FrozenIrBackendFunctionPlan<S = Instr[], Slot = unknown> {
  readonly resolver: IrLowerResolver;
  readonly emitter: BackendEmitter<S>;
  readonly typeConverter: TypeConverter<Slot>;
  /** Physical slot grouping promised for this exact logical signature. */
  readonly signature: FrozenIrBackendFunctionSignature<Slot>;
}

export interface FrozenIrBackendFunctionSignature<Slot = unknown> {
  readonly params: readonly (readonly Slot[])[];
  readonly results: readonly (readonly Slot[])[];
}

export interface FrozenIrBackendSessionOptions {
  readonly moduleSession?: object;
  readonly ownerIds?: readonly IrUnitId[];
}

export interface FrozenIrBackendSession {
  readonly backend: IrBackendKind;
  readonly batchDigest: string;
  readonly ownerIds: readonly IrUnitId[];
}

export interface FrozenIrBackendOutput<S = Instr[], Slot = unknown> {
  readonly ownerUnitId: IrUnitId;
  readonly func: IrFunction;
  readonly lowered: IrLoweredBody<S, Slot>;
  readonly emitter: BackendEmitter<S>;
}

export interface FrozenIrBackendPlanFactories<S = Instr[], Slot = unknown> {
  readonly resolver: IrLowerResolver;
  readonly makeTypeConverter: (func: IrFunction) => TypeConverter<Slot>;
  readonly makeEmitter: (func: IrFunction) => BackendEmitter<S>;
  readonly moduleSession?: object;
}

const sessions = new WeakMap<
  object,
  {
    readonly batch: FrozenIrBodyBatch;
    readonly backend: IrBackendKind;
    readonly moduleSession?: object;
    readonly ownerIds: readonly IrUnitId[];
  }
>();
const consumedSessions = new WeakSet<object>();

function invariant(detail: string): never {
  throw new FrozenIrBodyBatchInvariantError(`backend consumer: ${detail}`);
}

function functionOwnerIds(batch: FrozenIrBodyBatch): readonly IrUnitId[] {
  return batch.module.functions.map((fn) => fn.unitId);
}

function sameIds(left: readonly IrUnitId[], right: readonly IrUnitId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function requireUniqueIds(ids: readonly IrUnitId[], label: string): void {
  const seen = new Set<IrUnitId>();
  for (const id of ids) {
    if (seen.has(id)) invariant(`${label} contains duplicate owner ${id}`);
    seen.add(id);
  }
}

function sameSlotValue(left: unknown, right: unknown, seen = new WeakMap<object, WeakSet<object>>()): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  let paired = seen.get(left);
  if (paired?.has(right)) return true;
  if (!paired) {
    paired = new WeakSet<object>();
    seen.set(left, paired);
  }
  paired.add(right);
  const leftKeys = Reflect.ownKeys(left).sort((a, b) => String(a).localeCompare(String(b)));
  const rightKeys = Reflect.ownKeys(right).sort((a, b) => String(a).localeCompare(String(b)));
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const leftKey = leftKeys[index]!;
    const rightKey = rightKeys[index]!;
    if (
      typeof leftKey !== typeof rightKey ||
      (typeof leftKey === "symbol" ? leftKey !== rightKey : leftKey !== rightKey)
    ) {
      return false;
    }
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, leftKey);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, rightKey);
    if (!leftDescriptor || !rightDescriptor || !("value" in leftDescriptor) || !("value" in rightDescriptor)) {
      return false;
    }
    if (!sameSlotValue(leftDescriptor.value, rightDescriptor.value, seen)) return false;
  }
  return true;
}

function sameSlotGroups<Slot>(left: readonly (readonly Slot[])[], right: readonly (readonly Slot[])[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (group, index) =>
        group.length === right[index]!.length &&
        group.every((slot, slotIndex) => sameSlotValue(slot, right[index]![slotIndex])),
    )
  );
}

/** Authenticate a backend/session pair to one exact immutable batch. */
export function createFrozenIrBackendSession(
  batch: FrozenIrBodyBatch,
  backend: IrBackendKind,
  options: FrozenIrBackendSessionOptions = {},
): FrozenIrBackendSession {
  assertFrozenIrBodyBatch(batch);
  const ownerIds = options.ownerIds ? [...options.ownerIds] : [...functionOwnerIds(batch)];
  const expected = functionOwnerIds(batch);
  requireUniqueIds(ownerIds, "session owners");
  if (!sameIds(ownerIds, expected)) invariant("session owner join does not match the batch module");
  const session = Object.freeze({
    backend,
    batchDigest: batch.digest,
    ownerIds: Object.freeze(ownerIds),
  });
  sessions.set(session, { batch, backend, moduleSession: options.moduleSession, ownerIds: session.ownerIds });
  return session;
}

function validateSession(
  batch: FrozenIrBodyBatch,
  session: FrozenIrBackendSession,
  backend: IrBackendKind,
  moduleSession: object | undefined,
): { readonly ownerIds: readonly IrUnitId[] } {
  assertFrozenIrBodyBatch(batch);
  if (!session || typeof session !== "object") invariant("backend session is absent");
  const payload = sessions.get(session as object);
  if (!payload || payload.batch !== batch) invariant("backend session is foreign to the supplied batch");
  if (payload.backend !== backend || session.backend !== backend) {
    invariant(`backend session kind ${session.backend} does not match ${backend}`);
  }
  if (session.batchDigest !== batch.digest) invariant("backend session digest does not match the batch");
  if (payload.moduleSession !== moduleSession) invariant("backend module/session join is not authenticated");
  if (consumedSessions.has(session as object)) invariant("backend session was already consumed");
  const expected = functionOwnerIds(batch);
  if (!sameIds(payload.ownerIds, expected)) invariant("backend session owners drifted from the batch");
  return { ownerIds: payload.ownerIds };
}

function validatePlans<S, Slot>(
  batch: FrozenIrBodyBatch,
  backend: IrBackendKind,
  plans: ReadonlyMap<IrUnitId, FrozenIrBackendFunctionPlan<S, Slot>>,
  expectedOwnerIds: readonly IrUnitId[],
): void {
  if (!plans || typeof plans !== "object" || typeof plans.keys !== "function" || typeof plans.get !== "function") {
    invariant("backend function plan map is absent");
  }
  const planIds = [...plans.keys()];
  requireUniqueIds(planIds, "backend function plans");
  if (!sameIds(planIds, expectedOwnerIds)) invariant("backend function plans do not exactly join batch owners");
  for (const fn of batch.module.functions) {
    const plan = plans.get(fn.unitId);
    if (!plan) invariant(`backend plan is missing owner ${fn.unitId}`);
    if (plan.emitter.backend !== backend || plan.typeConverter.backend !== backend) {
      invariant(`backend plan for ${fn.unitId} has mismatched emitter/type-converter backend`);
    }
    if (!plan.signature || typeof plan.signature !== "object") {
      invariant(`backend plan for ${fn.unitId} has no physical signature evidence`);
    }
    const errors = verifyIrBackendLegality(fn, backend, plan.resolver);
    if (errors.length > 0) {
      throw new FrozenIrBodyBatchInvariantError(
        `backend consumer: ${backend} legality rejected prepared owner ${fn.unitId}: ${errors[0]!.message}`,
      );
    }
    let expectedParams: readonly (readonly Slot[])[];
    let expectedResults: readonly (readonly Slot[])[];
    try {
      expectedParams = fn.params.map((param) => plan.typeConverter.convertType(param.type));
      expectedResults = fn.resultTypes.map((result) => plan.typeConverter.convertType(result));
    } catch (error) {
      invariant(
        `backend plan for ${fn.unitId} cannot produce its physical signature: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      !sameSlotGroups(plan.signature.params, expectedParams) ||
      !sameSlotGroups(plan.signature.results, expectedResults)
    ) {
      invariant(`backend plan for ${fn.unitId} has a stale physical signature`);
    }
  }
}

/**
 * Validate and lower every function in the batch through one authenticated
 * backend plan. All legality checks run before the first body is lowered.
 */
export function consumeFrozenIrBodyBatch<S = Instr[], Slot = unknown>(input: {
  readonly batch: FrozenIrBodyBatch;
  readonly session: FrozenIrBackendSession;
  readonly backend: IrBackendKind;
  readonly moduleSession?: object;
  readonly plans: ReadonlyMap<IrUnitId, FrozenIrBackendFunctionPlan<S, Slot>>;
}): readonly FrozenIrBackendOutput<S, Slot>[] {
  const { batch, session, backend, moduleSession, plans } = input;
  const { ownerIds } = validateSession(batch, session, backend, moduleSession);
  validatePlans(batch, backend, plans, ownerIds);
  // A promised backend attempt is single-shot even when a late emitter or
  // converter failure occurs. The first body may already have registered
  // layouts or emitted into a private sink, so retrying would reuse partial
  // side effects under a supposedly fresh plan.
  consumedSessions.add(session as object);
  const lowered: FrozenIrBackendOutput<S, Slot>[] = [];
  for (const fn of batch.module.functions) {
    const plan = plans.get(fn.unitId)!;
    try {
      const body = lowerIrFunctionBody(fn, plan.resolver, plan.emitter, plan.typeConverter);
      lowered.push({ ownerUnitId: fn.unitId, func: fn, lowered: body, emitter: plan.emitter });
    } catch (error) {
      throw new FrozenIrBodyBatchInvariantError(
        `backend consumer: accepted owner ${fn.unitId} failed during lowering: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return Object.freeze(lowered);
}

/** Build one exact physical plan per owner, then consume that batch once. */
export function consumeFrozenIrBodyBatchWithFactories<S = Instr[], Slot = unknown>(input: {
  readonly batch: FrozenIrBodyBatch;
  readonly backend: IrBackendKind;
  readonly factories: FrozenIrBackendPlanFactories<S, Slot>;
}): readonly FrozenIrBackendOutput<S, Slot>[] {
  const plans = new Map<IrUnitId, FrozenIrBackendFunctionPlan<S, Slot>>();
  for (const fn of input.batch.module.functions) {
    const typeConverter = input.factories.makeTypeConverter(fn);
    plans.set(fn.unitId, {
      resolver: input.factories.resolver,
      emitter: input.factories.makeEmitter(fn),
      typeConverter,
      signature: {
        params: fn.params.map((param) => typeConverter.convertType(param.type)),
        results: fn.resultTypes.map((result) => typeConverter.convertType(result)),
      },
    });
  }
  const session = createFrozenIrBackendSession(input.batch, input.backend, {
    moduleSession: input.factories.moduleSession,
  });
  return consumeFrozenIrBodyBatch({
    batch: input.batch,
    session,
    backend: input.backend,
    moduleSession: input.factories.moduleSession,
    plans,
  });
}
