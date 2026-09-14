// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Backend-neutral async suspension plan.
 *
 * This is the preparation boundary needed by #1042/#1373b: source analysis
 * produces one immutable state graph and every async backend consumes that
 * graph. The contract deliberately contains only structural IR identities,
 * IR values/types/instructions, and semantic Promise/scheduler intents. It has
 * no TypeScript AST, checker, codegen context, callbacks, target selection, or
 * concrete Wasm indices.
 *
 * This slice defines and verifies the contract only. Production routing stays
 * unchanged until a later slice teaches the existing async frame engine to
 * consume an IrAsyncPlan.
 */

import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { AsyncRuntimeFeature } from "./async-intents.js";
import type { IrInstr, IrValueId } from "./nodes.js";
import type { IrType } from "./types.js";

export type IrAsyncStateId = number & { readonly __brand: "IrAsyncStateId" };

export type IrAsyncHandlerId = number & { readonly __brand: "IrAsyncHandlerId" };

/** One ABI for every prepared async function: callers always receive a Promise. */
export interface IrCanonicalPromiseAbi {
  readonly kind: "canonical-promise";
  readonly version: 1;
  readonly fulfillmentType: IrType | null;
  readonly rejectionType: "dynamic";
  readonly consumerContract: "promise-only";
  readonly settlementTiming: "always-async";
}

/** Semantic requirements. A backend selects providers only after preparation. */
export type IrAsyncRuntimeIntent = AsyncRuntimeFeature;

export interface IrAsyncPlanValue {
  readonly value: IrValueId;
  readonly type: IrType;
}

export type IrAsyncSpillStorage = "ssa" | "slot" | "ref-cell" | "receiver";

/**
 * One typed frame entry. The value identity is semantic; a backend chooses the
 * concrete field/local representation after the whole program ABI is sealed.
 */
export interface IrAsyncSpill {
  readonly value: IrValueId;
  readonly type: IrType;
  readonly storage: IrAsyncSpillStorage;
}

export interface IrAsyncResumeValue {
  /** Successor-defined result of the preceding fulfillment/rejection edge. */
  readonly value: IrValueId;
  readonly type: IrType;
  readonly source: "fulfilled" | "rejected";
}

/**
 * A typed assignment to a frame carrier performed after the state body and
 * before its terminator. This is the backend-neutral phi/update boundary for
 * loop-carried values: `value` remains ordinary SSA while `target` names the
 * stable spill identity observed by successor states.
 */
export interface IrAsyncSpillUpdate {
  readonly target: IrValueId;
  readonly value: IrValueId;
}

export interface IrAsyncState {
  readonly id: IrAsyncStateId;
  /** At most one scheduler-delivered value is bound when this state begins. */
  readonly resume?: IrAsyncResumeValue;
  readonly body: readonly IrInstr[];
  readonly updates?: readonly IrAsyncSpillUpdate[];
  readonly terminator: IrAsyncTerminator;
}

export interface IrAsyncHandler {
  readonly id: IrAsyncHandlerId;
  readonly kind: "catch";
  readonly entry: IrAsyncStateId;
  readonly parent: IrAsyncHandlerId | null;
}

export interface IrAsyncSuspendTerminator {
  readonly kind: "suspend";
  readonly awaited: IrValueId;
  readonly resume: {
    readonly state: IrAsyncStateId;
    /** Must be the target state's fulfilled resume value. */
    readonly value: IrValueId;
  };
  readonly rejected: { readonly kind: "handler"; readonly handler: IrAsyncHandlerId } | { readonly kind: "reject" };
  /** Exact values that must survive while the activation is suspended. */
  readonly live: readonly IrValueId[];
}

export interface IrAsyncGotoTerminator {
  readonly kind: "goto";
  readonly target: IrAsyncStateId;
}

export interface IrAsyncBranchTerminator {
  readonly kind: "branch";
  readonly condition: IrValueId;
  readonly ifTrue: IrAsyncStateId;
  readonly ifFalse: IrAsyncStateId;
}

export interface IrAsyncResolveTerminator {
  readonly kind: "resolve";
  /** Absent for Promise<void>. */
  readonly value?: IrValueId;
}

export interface IrAsyncRejectTerminator {
  readonly kind: "reject";
  readonly reason: IrValueId;
}

export interface IrAsyncCompleteTerminator {
  readonly kind: "complete";
}

export type IrAsyncTerminator =
  | IrAsyncSuspendTerminator
  | IrAsyncGotoTerminator
  | IrAsyncBranchTerminator
  | IrAsyncResolveTerminator
  | IrAsyncRejectTerminator
  | IrAsyncCompleteTerminator;

export interface IrAsyncPlan {
  readonly schemaVersion: 1;
  readonly ownerUnitId: IrUnitId;
  readonly kind: "async-function";
  readonly abi: IrCanonicalPromiseAbi;
  readonly entry: IrAsyncStateId;
  readonly params: readonly IrAsyncPlanValue[];
  /** Exhaustive value/type table, including params, resumes, and body defs. */
  readonly values: readonly IrAsyncPlanValue[];
  readonly spills: readonly IrAsyncSpill[];
  readonly states: readonly IrAsyncState[];
  readonly handlers: readonly IrAsyncHandler[];
  readonly runtimeIntents: readonly IrAsyncRuntimeIntent[];
}
