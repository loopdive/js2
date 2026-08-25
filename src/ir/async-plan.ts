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

import {
  ASYNC_RUNTIME_FEATURES,
  isAsyncRuntimeFeature,
  type AsyncHostCapabilityId,
  type AsyncRuntimeFeature,
} from "./async-runtime-providers.js";
import type { IrUnitId } from "./identity.js";
import {
  collectUses,
  forEachInstrDeep,
  irTypeEquals,
  type IrFuncRef,
  type IrInstr,
  type IrType,
  type IrVecLayoutRef,
  type IrValueId,
} from "./nodes.js";

export type IrAsyncStateId = number & { readonly __brand: "IrAsyncStateId" };
export type IrAsyncHandlerId = number & { readonly __brand: "IrAsyncHandlerId" };

export function asAsyncStateId(value: number): IrAsyncStateId {
  return value as IrAsyncStateId;
}

export function asAsyncHandlerId(value: number): IrAsyncHandlerId {
  return value as IrAsyncHandlerId;
}

/** One ABI for every prepared async function: callers always receive a Promise. */
export interface IrCanonicalPromiseAbi {
  readonly kind: "canonical-promise";
  readonly version: 1;
  readonly fulfillmentType: IrType | null;
  readonly rejectionType: "dynamic";
  readonly consumerContract: "promise-only";
  readonly settlementTiming: "always-async";
}

export function canonicalPromiseAbi(fulfillmentType: IrType | null): IrCanonicalPromiseAbi {
  return Object.freeze({
    kind: "canonical-promise",
    version: 1,
    fulfillmentType,
    rejectionType: "dynamic",
    consumerContract: "promise-only",
    settlementTiming: "always-async",
  });
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

/**
 * Backend attachment created only after the semantic runtime manifest freezes.
 * The plan above stays target-neutral; this lookup-only record gives prepared
 * component sealing exact symbolic dependencies for the selected adapter.
 */
export interface PreparedIrAsyncHostAdapter {
  readonly capability: AsyncHostCapabilityId;
  readonly target: IrFuncRef;
}

interface PreparedIrAsyncRuntimeBase {
  /** Backend-only layouts keyed by the exact logical types in `asyncPlan`. */
  readonly typeLayouts?: readonly {
    readonly logicalType: IrType;
    readonly layout: IrVecLayoutRef;
    /** Present only for a host-fulfilled resume value that crosses representations. */
    readonly fromExtern?: IrFuncRef;
  }[];
  /** State bodies with post-freeze intrinsic provider attachments. */
  readonly states: readonly IrAsyncState[];
}

export type PreparedIrAsyncRuntime =
  | (PreparedIrAsyncRuntimeBase & {
      readonly kind: "host-wasmgc";
      readonly adapters: readonly PreparedIrAsyncHostAdapter[];
    })
  | (PreparedIrAsyncRuntimeBase & {
      readonly kind: "standalone-native-wasmgc";
      readonly adapters: readonly [];
    });

export type IrAsyncPlanInvariantCode =
  | "forbidden-data"
  | "invalid-owner"
  | "invalid-abi"
  | "duplicate-value"
  | "unknown-value"
  | "value-type-mismatch"
  | "missing-value-definition"
  | "duplicate-value-definition"
  | "duplicate-spill"
  | "missing-spill"
  | "unused-spill"
  | "unknown-spill-update"
  | "duplicate-spill-update"
  | "spill-update-type-mismatch"
  | "invalid-spill-update"
  | "duplicate-state"
  | "unknown-state"
  | "unreachable-state"
  | "invalid-resume"
  | "unlowered-async-control"
  | "duplicate-handler"
  | "unknown-handler"
  | "handler-cycle"
  | "invalid-handler"
  | "unknown-runtime-intent"
  | "duplicate-runtime-intent"
  | "missing-runtime-intent"
  | "liveness-mismatch";

export interface IrAsyncPlanVerifyError {
  readonly code: IrAsyncPlanInvariantCode;
  readonly message: string;
  readonly path?: string;
  readonly state?: IrAsyncStateId;
}

export class IrAsyncPlanInvariantError extends Error {
  constructor(readonly errors: readonly IrAsyncPlanVerifyError[]) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join("\n"));
    this.name = "IrAsyncPlanInvariantError";
  }
}

interface StateLiveness {
  readonly defs: ReadonlySet<IrValueId>;
  readonly usesBeforeDef: ReadonlySet<IrValueId>;
}

interface StateEdge {
  readonly target: IrAsyncStateId;
  readonly source: "control" | "fulfilled" | "rejected";
  /** Value materialized by this edge and therefore not spilled by its source. */
  readonly boundValue?: IrValueId;
}

const runtimeIntentOrder: readonly IrAsyncRuntimeIntent[] = ASYNC_RUNTIME_FEATURES;

const runtimeIntentRank = new Map(runtimeIntentOrder.map((intent, index) => [intent, index] as const));

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function compareNumber(a: number, b: number): number {
  return a - b;
}

function sameValueSet(left: ReadonlySet<IrValueId>, right: ReadonlySet<IrValueId>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function describeValues(values: ReadonlySet<IrValueId>): string {
  return `[${[...values].map(Number).sort(compareNumber).join(", ")}]`;
}

function terminatorUses(terminator: IrAsyncTerminator): readonly IrValueId[] {
  switch (terminator.kind) {
    case "suspend":
      return [terminator.awaited];
    case "branch":
      return [terminator.condition];
    case "resolve":
      return terminator.value === undefined ? [] : [terminator.value];
    case "reject":
      return [terminator.reason];
    case "goto":
    case "complete":
      return [];
  }
}

function stateUpdates(state: IrAsyncState): readonly IrAsyncSpillUpdate[] {
  return state.updates ?? [];
}

function updateMap(state: IrAsyncState): ReadonlyMap<IrValueId, IrValueId> {
  return new Map(stateUpdates(state).map((update) => [update.target, update.value] as const));
}

function stateEdges(
  state: IrAsyncState,
  handlers: ReadonlyMap<IrAsyncHandlerId, IrAsyncHandler>,
): readonly StateEdge[] {
  const terminator = state.terminator;
  switch (terminator.kind) {
    case "goto":
      return [{ target: terminator.target, source: "control" }];
    case "branch":
      return [
        { target: terminator.ifTrue, source: "control" },
        { target: terminator.ifFalse, source: "control" },
      ];
    case "suspend": {
      const edges: StateEdge[] = [
        { target: terminator.resume.state, source: "fulfilled", boundValue: terminator.resume.value },
      ];
      if (terminator.rejected.kind === "handler") {
        const handler = handlers.get(terminator.rejected.handler);
        if (handler) edges.push({ target: handler.entry, source: "rejected" });
      }
      return edges;
    }
    case "resolve":
    case "reject":
    case "complete":
      return [];
  }
}

function stateLiveness(state: IrAsyncState, isEntry: boolean, params: readonly IrAsyncPlanValue[]): StateLiveness {
  const defs = new Set<IrValueId>();
  if (isEntry) for (const param of params) defs.add(param.value);
  if (state.resume) defs.add(state.resume.value);
  for (const instr of state.body) {
    forEachInstrDeep(instr, (nested) => {
      if (nested.result !== null) defs.add(nested.result);
    });
  }
  const usesBeforeDef = new Set<IrValueId>();
  for (const instr of state.body) {
    for (const value of collectUses(instr, { deep: true })) {
      if (!defs.has(value)) usesBeforeDef.add(value);
    }
  }
  const updatedTargets = new Set<IrValueId>();
  for (const update of stateUpdates(state)) {
    updatedTargets.add(update.target);
    if (!defs.has(update.value)) usesBeforeDef.add(update.value);
  }
  for (const value of terminatorUses(state.terminator)) {
    if (!defs.has(value) && !updatedTargets.has(value)) usesBeforeDef.add(value);
  }
  return { defs, usesBeforeDef };
}

function addPurityError(errors: IrAsyncPlanVerifyError[], path: string, message: string): void {
  errors.push({ code: "forbidden-data", path, message });
}

function verifyPureData(value: unknown, errors: IrAsyncPlanVerifyError[]): void {
  const active = new Set<object>();
  const visit = (candidate: unknown, path: string): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) addPurityError(errors, path, "non-finite numbers are not canonical plan data");
      return;
    }
    if (typeof candidate === "bigint") return;
    if (candidate === undefined || typeof candidate === "function" || typeof candidate === "symbol") {
      addPurityError(errors, path, `contains non-data value ${typeof candidate}`);
      return;
    }
    if (typeof candidate !== "object") {
      addPurityError(errors, path, `contains unsupported ${typeof candidate}`);
      return;
    }
    if (active.has(candidate)) {
      addPurityError(errors, path, "contains a cycle");
      return;
    }
    active.add(candidate);
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index++) visit(candidate[index], `${path}[${index}]`);
      active.delete(candidate);
      return;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      addPurityError(errors, path, `contains mutable/non-IR ${prototype?.constructor?.name ?? "object"}`);
      active.delete(candidate);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (record.kind === "raw.wasm") addPurityError(errors, path, "contains raw Wasm instructions");
    if (typeof record.kind === "number" && typeof record.pos === "number" && typeof record.end === "number") {
      addPurityError(errors, path, "contains a TypeScript AST node");
    }
    for (const key of Object.keys(record)) {
      const childPath = `${path}.${key}`;
      if (
        key === "emit" ||
        key === "postDeliverEmit" ||
        key === "ctx" ||
        key === "fctx" ||
        key === "checker" ||
        key === "declaration" ||
        key === "sourceNode" ||
        key === "backend" ||
        key === "wasmType" ||
        key === "valType" ||
        /(?:func|type|global|local|field)(?:Idx|Index)$/i.test(key)
      ) {
        addPurityError(errors, childPath, `property ${key} crosses the async-plan boundary`);
      }
      if (
        key === "target" &&
        typeof record[key] === "string" &&
        ["gc", "standalone", "wasi", "linear"].includes(record[key])
      ) {
        addPurityError(errors, childPath, "target selection belongs to backend lowering");
      }
      visit(record[key], childPath);
    }
    active.delete(candidate);
  };
  visit(value, "$plan");
}

function addError(
  errors: IrAsyncPlanVerifyError[],
  code: IrAsyncPlanInvariantCode,
  message: string,
  state?: IrAsyncStateId,
): void {
  errors.push({ code, message, ...(state === undefined ? {} : { state }) });
}

type AsyncValueChecker = (value: IrValueId, owner: string, state?: IrAsyncStateId) => IrType | undefined;

function verifyResumeIncomingEdges(
  plan: IrAsyncPlan,
  handlers: ReadonlyMap<IrAsyncHandlerId, IrAsyncHandler>,
  errors: IrAsyncPlanVerifyError[],
): void {
  const incomingEdges = new Map<IrAsyncStateId, StateEdge[]>();
  for (const source of plan.states) {
    for (const edge of stateEdges(source, handlers)) {
      const incoming = incomingEdges.get(edge.target) ?? [];
      incoming.push(edge);
      incomingEdges.set(edge.target, incoming);
    }
  }
  for (const state of plan.states) {
    if (!state.resume) continue;
    for (const edge of incomingEdges.get(state.id) ?? []) {
      const matchingSource = edge.source === state.resume.source;
      const matchingValue = edge.source !== "fulfilled" || edge.boundValue === state.resume.value;
      if (!matchingSource || !matchingValue) {
        addError(
          errors,
          "invalid-resume",
          `state ${state.id} resume binding is reachable from an incompatible ${edge.source} edge`,
          state.id,
        );
      }
    }
  }
}

function verifySpillUpdates(
  plan: IrAsyncPlan,
  values: ReadonlyMap<IrValueId, IrType>,
  spillByValue: ReadonlyMap<IrValueId, IrAsyncSpill>,
  checkValue: AsyncValueChecker,
  errors: IrAsyncPlanVerifyError[],
): void {
  const paramValues = new Set(plan.params.map((param) => param.value));
  for (const state of plan.states) {
    const updates = stateUpdates(state);
    const allUpdatedTargets = new Set(updates.map((update) => update.target));
    const updatedTargets = new Set<IrValueId>();
    for (const update of updates) {
      const targetType = values.get(update.target);
      const sourceType = checkValue(update.value, `state ${state.id} spill update`, state.id);
      if (!spillByValue.has(update.target)) {
        addError(
          errors,
          "unknown-spill-update",
          `state ${state.id} updates value ${update.target}, which is not a frame spill`,
          state.id,
        );
      }
      if (updatedTargets.has(update.target)) {
        addError(
          errors,
          "duplicate-spill-update",
          `state ${state.id} updates spill ${update.target} more than once`,
          state.id,
        );
      }
      updatedTargets.add(update.target);
      if (paramValues.has(update.target)) {
        addError(
          errors,
          "invalid-spill-update",
          `state ${state.id} updates parameter spill ${update.target}; immutable parameter carriers cannot be phi targets`,
          state.id,
        );
      }
      if (allUpdatedTargets.has(update.value)) {
        addError(
          errors,
          "invalid-spill-update",
          `state ${state.id} update for spill ${update.target} depends on simultaneously updated spill ${update.value}`,
          state.id,
        );
      }
      if (targetType && sourceType && !irTypeEquals(targetType, sourceType)) {
        addError(
          errors,
          "spill-update-type-mismatch",
          `state ${state.id} update source ${update.value} does not match spill ${update.target}`,
          state.id,
        );
      }
    }
  }
}

function verifyCanonicalPromiseAbi(plan: IrAsyncPlan, errors: IrAsyncPlanVerifyError[]): void {
  const abi = plan.abi;
  if (
    abi.kind !== "canonical-promise" ||
    abi.version !== 1 ||
    abi.rejectionType !== "dynamic" ||
    abi.consumerContract !== "promise-only" ||
    abi.settlementTiming !== "always-async"
  ) {
    addError(
      errors,
      "invalid-abi",
      "async functions must expose canonical Promise ABI v1 with always-async settlement",
    );
  }
}

function requiredRuntimeIntents(plan: IrAsyncPlan): ReadonlySet<IrAsyncRuntimeIntent> {
  const required = new Set<IrAsyncRuntimeIntent>(["promise.capability.create"]);
  if (plan.abi.fulfillmentType === null) required.add("value.undefined");
  for (const state of plan.states) {
    switch (state.terminator.kind) {
      case "suspend":
        required.add("promise.resolve");
        required.add("promise.react");
        required.add("scheduler.enqueue");
        required.add("scheduler.drain");
        if (state.terminator.rejected.kind === "reject") required.add("promise.settle.reject");
        break;
      case "resolve":
        required.add("promise.settle.fulfill");
        break;
      case "reject":
        required.add("promise.settle.reject");
        break;
      case "goto":
      case "branch":
      case "complete":
        break;
    }
  }
  return required;
}

/**
 * Verify the complete plan graph. Unknown/malformed data is always an
 * invariant; there is no fallback policy at this boundary.
 */
export function verifyIrAsyncPlan(plan: IrAsyncPlan): readonly IrAsyncPlanVerifyError[] {
  const errors: IrAsyncPlanVerifyError[] = [];
  verifyPureData(plan, errors);
  if (plan.schemaVersion !== 1 || plan.kind !== "async-function") {
    addError(errors, "invalid-abi", "unsupported async-plan schema or callable kind");
  }
  if (typeof plan.ownerUnitId !== "string" || !plan.ownerUnitId.startsWith("ir-unit:v1:")) {
    addError(errors, "invalid-owner", "ownerUnitId must be a structural IrUnitId");
  }
  verifyCanonicalPromiseAbi(plan, errors);

  const values = new Map<IrValueId, IrType>();
  for (const entry of plan.values) {
    if (values.has(entry.value)) addError(errors, "duplicate-value", `value ${entry.value} is declared more than once`);
    else values.set(entry.value, entry.type);
  }
  const definitions = new Map<IrValueId, string>();
  const define = (value: IrValueId, owner: string): void => {
    const previous = definitions.get(value);
    if (previous) {
      addError(errors, "duplicate-value-definition", `value ${value} is defined by ${previous} and ${owner}`);
    } else {
      definitions.set(value, owner);
    }
  };
  const checkValue = (value: IrValueId, owner: string, state?: IrAsyncStateId): IrType | undefined => {
    const type = values.get(value);
    if (!type) addError(errors, "unknown-value", `${owner} references undeclared value ${value}`, state);
    return type;
  };
  for (const param of plan.params) {
    const type = checkValue(param.value, "parameter");
    if (type && !irTypeEquals(type, param.type)) {
      addError(errors, "value-type-mismatch", `parameter ${param.value} type does not match the value table`);
    }
    define(param.value, "parameter");
  }

  const handlers = new Map<IrAsyncHandlerId, IrAsyncHandler>();
  for (const handler of plan.handlers) {
    if (!isNonNegativeSafeInteger(handler.id)) {
      addError(errors, "unknown-handler", `handler id ${handler.id} is invalid`);
    }
    if (handlers.has(handler.id))
      addError(errors, "duplicate-handler", `handler ${handler.id} is declared more than once`);
    else handlers.set(handler.id, handler);
  }
  const states = new Map<IrAsyncStateId, IrAsyncState>();
  for (const state of plan.states) {
    if (!isNonNegativeSafeInteger(state.id)) addError(errors, "unknown-state", `state id ${state.id} is invalid`);
    if (states.has(state.id)) addError(errors, "duplicate-state", `state ${state.id} is declared more than once`);
    else states.set(state.id, state);
  }
  if (!states.has(plan.entry)) addError(errors, "unknown-state", `entry state ${plan.entry} is not declared`);
  if (states.get(plan.entry)?.resume) {
    addError(errors, "invalid-resume", `entry state ${plan.entry} cannot bind a resume value`, plan.entry);
  }

  for (const state of plan.states) {
    if (state.resume) {
      const type = checkValue(state.resume.value, `state ${state.id} resume`, state.id);
      if (type && !irTypeEquals(type, state.resume.type)) {
        addError(
          errors,
          "value-type-mismatch",
          `state ${state.id} resume type does not match value ${state.resume.value}`,
          state.id,
        );
      }
      define(state.resume.value, `state ${state.id} resume`);
    }
    for (const instr of state.body) {
      for (const use of collectUses(instr, { deep: true })) checkValue(use, `state ${state.id} body`, state.id);
      forEachInstrDeep(instr, (nested) => {
        if (nested.kind === "await" || nested.kind === "async.return" || nested.kind === "async.throw") {
          addError(
            errors,
            "unlowered-async-control",
            `state ${state.id} contains ${nested.kind}; async control must be represented by a plan terminator`,
            state.id,
          );
        }
        if (nested.result === null) return;
        const type = checkValue(nested.result, `state ${state.id} result`, state.id);
        if (type && nested.resultType && !irTypeEquals(type, nested.resultType)) {
          addError(
            errors,
            "value-type-mismatch",
            `state ${state.id} result ${nested.result} type does not match the value table`,
            state.id,
          );
        }
        define(nested.result, `state ${state.id} body`);
      });
    }
    for (const use of terminatorUses(state.terminator)) checkValue(use, `state ${state.id} terminator`, state.id);
    const terminator = state.terminator;
    if (terminator.kind === "suspend") {
      checkValue(terminator.resume.value, `state ${state.id} resume edge`, state.id);
      const target = states.get(terminator.resume.state);
      if (!target) {
        addError(
          errors,
          "unknown-state",
          `state ${state.id} resumes at unknown state ${terminator.resume.state}`,
          state.id,
        );
      } else if (target.resume?.value !== terminator.resume.value || target.resume.source !== "fulfilled") {
        addError(
          errors,
          "invalid-resume",
          `state ${state.id} resume edge does not match state ${target.id}'s resume binding`,
          state.id,
        );
      }
    }
    if (terminator.kind === "suspend" && terminator.rejected.kind === "handler") {
      if (!handlers.has(terminator.rejected.handler)) {
        addError(
          errors,
          "unknown-handler",
          `state ${state.id} rejects to unknown handler ${terminator.rejected.handler}`,
          state.id,
        );
      }
    }
    if (terminator.kind === "resolve") {
      const fulfillmentType = plan.abi.fulfillmentType;
      if (terminator.value === undefined ? fulfillmentType !== null : fulfillmentType === null) {
        addError(
          errors,
          "value-type-mismatch",
          `state ${state.id} resolve arity does not match its Promise ABI`,
          state.id,
        );
      } else if (terminator.value !== undefined && fulfillmentType !== null) {
        const valueType = values.get(terminator.value);
        if (valueType && !irTypeEquals(valueType, fulfillmentType)) {
          addError(
            errors,
            "value-type-mismatch",
            `state ${state.id} resolve type does not match its Promise ABI`,
            state.id,
          );
        }
      }
    }
    for (const edge of stateEdges(state, handlers)) {
      if (!states.has(edge.target)) {
        addError(errors, "unknown-state", `state ${state.id} targets unknown state ${edge.target}`, state.id);
      }
    }
  }

  for (const value of values.keys()) {
    if (!definitions.has(value)) {
      addError(
        errors,
        "missing-value-definition",
        `value ${value} has no parameter, resume, or instruction definition`,
      );
    }
  }

  for (const handler of plan.handlers) {
    const state = states.get(handler.entry);
    if (!state) {
      addError(errors, "unknown-state", `handler ${handler.id} targets unknown state ${handler.entry}`);
    } else if (state.resume?.source !== "rejected") {
      addError(errors, "invalid-handler", `catch handler ${handler.id} must enter a rejected-value state`);
    }
    if (handler.parent !== null && !handlers.has(handler.parent)) {
      addError(errors, "unknown-handler", `handler ${handler.id} has unknown parent ${handler.parent}`);
    }
    const visited = new Set<IrAsyncHandlerId>();
    let cursor: IrAsyncHandler | undefined = handler;
    while (cursor && cursor.parent !== null) {
      if (visited.has(cursor.id)) {
        addError(errors, "handler-cycle", `handler ${handler.id} participates in a parent cycle`);
        break;
      }
      visited.add(cursor.id);
      cursor = handlers.get(cursor.parent);
    }
  }

  verifyResumeIncomingEdges(plan, handlers, errors);

  const spillByValue = new Map<IrValueId, IrAsyncSpill>();
  for (const spill of plan.spills) {
    if (spillByValue.has(spill.value))
      addError(errors, "duplicate-spill", `value ${spill.value} has duplicate spill entries`);
    else spillByValue.set(spill.value, spill);
    const type = checkValue(spill.value, "spill");
    if (type && !irTypeEquals(type, spill.type)) {
      addError(errors, "value-type-mismatch", `spill ${spill.value} type does not match the value table`);
    }
  }

  verifySpillUpdates(plan, values, spillByValue, checkValue, errors);

  const livenessByState = new Map<IrAsyncStateId, StateLiveness>();
  for (const state of plan.states) {
    livenessByState.set(state.id, stateLiveness(state, state.id === plan.entry, plan.params));
  }
  const liveIn = new Map<IrAsyncStateId, Set<IrValueId>>();
  for (const state of plan.states) liveIn.set(state.id, new Set(livenessByState.get(state.id)!.usesBeforeDef));
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = plan.states.length - 1; index >= 0; index--) {
      const state = plan.states[index]!;
      const local = livenessByState.get(state.id)!;
      const liveOut = new Set<IrValueId>();
      const updates = updateMap(state);
      for (const edge of stateEdges(state, handlers)) {
        for (const value of liveIn.get(edge.target) ?? []) {
          if (value === edge.boundValue) continue;
          liveOut.add(updates.get(value) ?? value);
        }
      }
      const next = new Set(local.usesBeforeDef);
      for (const value of liveOut) if (!local.defs.has(value)) next.add(value);
      const current = liveIn.get(state.id)!;
      if (!sameValueSet(next, current)) {
        liveIn.set(state.id, next);
        changed = true;
      }
    }
  }

  const requiredSpills = new Set<IrValueId>();
  for (const state of plan.states) {
    const terminator = state.terminator;
    if (terminator.kind !== "suspend") continue;
    const expected = new Set<IrValueId>();
    for (const edge of stateEdges(state, handlers)) {
      for (const value of liveIn.get(edge.target) ?? []) {
        if (value !== edge.boundValue) expected.add(value);
      }
    }
    const declared = new Set(terminator.live);
    if (declared.size !== terminator.live.length) {
      addError(errors, "liveness-mismatch", `state ${state.id} declares duplicate live values`, state.id);
    }
    for (const value of declared) checkValue(value, `state ${state.id} liveness`, state.id);
    if (!sameValueSet(expected, declared)) {
      addError(
        errors,
        "liveness-mismatch",
        `state ${state.id} live set ${describeValues(declared)} must equal ${describeValues(expected)}`,
        state.id,
      );
    }
    for (const value of expected) requiredSpills.add(value);
  }
  for (const value of requiredSpills) {
    if (!spillByValue.has(value)) addError(errors, "missing-spill", `live value ${value} has no frame spill`);
  }
  for (const value of spillByValue.keys()) {
    if (!requiredSpills.has(value))
      addError(errors, "unused-spill", `spill value ${value} is never live across suspension`);
  }

  if (states.has(plan.entry)) {
    const reachable = new Set<IrAsyncStateId>();
    const work = [plan.entry];
    while (work.length > 0) {
      const stateId = work.pop()!;
      if (reachable.has(stateId)) continue;
      reachable.add(stateId);
      const state = states.get(stateId);
      if (!state) continue;
      for (const edge of stateEdges(state, handlers)) work.push(edge.target);
    }
    for (const state of plan.states) {
      if (!reachable.has(state.id)) addError(errors, "unreachable-state", `state ${state.id} is unreachable`, state.id);
    }
  }

  const intents = new Set<IrAsyncRuntimeIntent>();
  for (const intent of plan.runtimeIntents) {
    if (!isAsyncRuntimeFeature(intent)) {
      addError(errors, "unknown-runtime-intent", `runtime intent ${String(intent)} is not semantic async vocabulary`);
      continue;
    }
    if (intents.has(intent)) addError(errors, "duplicate-runtime-intent", `runtime intent ${intent} is duplicated`);
    intents.add(intent);
  }
  for (const intent of requiredRuntimeIntents(plan)) {
    if (!intents.has(intent)) addError(errors, "missing-runtime-intent", `runtime intent ${intent} is required`);
  }
  return Object.freeze(errors);
}

export function assertIrAsyncPlan(plan: IrAsyncPlan): void {
  const errors = verifyIrAsyncPlan(plan);
  if (errors.length > 0) throw new IrAsyncPlanInvariantError(errors);
}

function clonePlanData(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value))
    throw new IrAsyncPlanInvariantError([{ code: "forbidden-data", message: "plan contains a cycle" }]);
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return Object.freeze(value.map((item) => clonePlanData(item, next)));
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) copy[key] = clonePlanData((value as Record<string, unknown>)[key], next);
  return Object.freeze(copy);
}

function canonicalPlanInput(plan: IrAsyncPlan): IrAsyncPlan {
  const states = [...plan.states]
    .sort((left, right) => compareNumber(left.id, right.id))
    .map((state) => ({
      ...state,
      ...(state.updates
        ? {
            updates: [...state.updates].sort(
              (left, right) => compareNumber(left.target, right.target) || compareNumber(left.value, right.value),
            ),
          }
        : {}),
      ...(state.terminator.kind === "suspend"
        ? { terminator: { ...state.terminator, live: [...state.terminator.live].sort(compareNumber) } }
        : {}),
    }));
  return {
    ...plan,
    params: [...plan.params],
    values: [...plan.values].sort((left, right) => compareNumber(left.value, right.value)),
    spills: [...plan.spills].sort((left, right) => compareNumber(left.value, right.value)),
    states,
    handlers: [...plan.handlers].sort((left, right) => compareNumber(left.id, right.id)),
    runtimeIntents: [...plan.runtimeIntents].sort(
      (left, right) =>
        (runtimeIntentRank.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (runtimeIntentRank.get(right) ?? Number.MAX_SAFE_INTEGER) || String(left).localeCompare(String(right)),
    ),
  };
}

/** Validate, canonicalize, copy, and deeply freeze one prepared plan. */
export function createIrAsyncPlan(plan: IrAsyncPlan): IrAsyncPlan {
  const canonical = canonicalPlanInput(plan);
  assertIrAsyncPlan(canonical);
  return clonePlanData(canonical) as IrAsyncPlan;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return `{"$bigint":${JSON.stringify(value.toString(10))}}`;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return `{"$number":"-0"}`;
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Target-independent serialization used by readiness and differential gates. */
export function serializeIrAsyncPlan(plan: IrAsyncPlan): string {
  return canonicalJson(createIrAsyncPlan(plan));
}

/** Stable content fingerprint (FNV-1a-64; identity aid, not a security hash). */
export function hashIrAsyncPlan(plan: IrAsyncPlan): string {
  const bytes = new TextEncoder().encode(serializeIrAsyncPlan(plan));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `ir-async-plan:v1:${hash.toString(16).padStart(16, "0")}`;
}
