// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrClassId, IrUnitId } from "./identity.js";
import type { IrClassShape, IrClosureSignature, IrFuncRef, IrGlobalRef, IrType } from "./nodes.js";
import type { IrLegacyUnitProjection, IrPlanningIdentityContext } from "./planning-identity.js";
import type { IrPromiseDelayLoweringPlans } from "./promise-delay-lowering.js";
import { ts } from "../ts-api.js";
import { requireCompilerTimerShimPlan } from "./timer-shim-lowering.js";

export interface IrImportedOptionalParamPlan {
  readonly constantDefault?:
    | { readonly kind: "f64"; readonly value: number }
    | { readonly kind: "i32"; readonly value: number };
  readonly hasExpressionDefault?: boolean;
}

export interface IrImportedCallLoweringPlan {
  /** Module-body source-unit import or same-file ambient host import (#3657). */
  readonly source: "module-import" | "ambient-host" | "compiler-timer-shim";
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  /** Exact source-unit target. `name` is diagnostic/adapter metadata only. */
  readonly target: IrFuncRef;
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
  readonly optionalParams: ReadonlyMap<number, IrImportedOptionalParamPlan>;
  readonly needsArgc: boolean;
  /** Exact runtime argc state; present iff {@link needsArgc} is true. */
  readonly argcGlobal?: IrGlobalRef;
}

export function requireValidImportedCallTarget(plan: IrImportedCallLoweringPlan): void {
  if (plan.source === "compiler-timer-shim") {
    requireCompilerTimerShimPlan(plan);
    return;
  }
  if (plan.source === "ambient-host") {
    if (plan.target.binding.kind === "import" && plan.target.binding.module === "env") return;
    throw new Error(`ir/from-ast: ambient host call target ${plan.target.name} is not backed by an env import`);
  }
  if (plan.target.binding.kind !== "unit") {
    throw new Error(`ir/from-ast: imported source call target ${plan.target.name} is not backed by an exact unit`);
  }
}

export interface IrTopLevelFunctionValueLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  /** Exact source-unit function whose value is being materialized. */
  readonly target: IrFuncRef;
  readonly signature: IrClosureSignature;
  /** Exact compiler-owned trampoline used by `closure.new`. */
  readonly trampoline: IrFuncRef;
  /** Exact compiler-owned singleton storage. */
  readonly cacheGlobal: IrGlobalRef;
  /** Compatibility label for the legacy singleton allocator/preflight. */
  readonly cacheGlobalName: string;
}

/** Exact direct-call plan for one certified AST call site. */
export interface IrDirectCallLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  /** Exact closed-union callable target. `name` is adapter metadata only. */
  readonly target: IrFuncRef;
  readonly signature: IrClosureSignature;
}

/** Already-validated callable target supplied by integration planning. */
export interface IrDirectCallTarget {
  readonly target: IrFuncRef;
  readonly signature: IrClosureSignature;
}

/**
 * Build exact-node direct-call plans without deriving identity from a label.
 * The target map is authoritative and must already contain a structural
 * source-unit or provider reference; this helper never manufactures one from
 * the legacy lookup label.
 */
export function collectIrDirectCallLoweringPlans(
  root: ts.Node,
  ownerUnitId: IrUnitId,
  targetsByLegacyName: ReadonlyMap<string, IrDirectCallTarget>,
): ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan> {
  const plans = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const certified = targetsByLegacyName.get(node.expression.text);
      if (certified) {
        plans.set(node, {
          ownerUnitId,
          target: certified.target,
          signature: certified.signature,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return plans;
}

export interface IrHostVoidCallbackLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  readonly signature: IrClosureSignature;
  readonly captureNames: ReadonlySet<string>;
  /** Exact source-order lift ordinal collision-proved before integration. */
  readonly liftedOrdinal: number;
  /** This exact plan is owned by the dedicated standalone DOM dispatcher. */
  readonly standaloneDomReusable?: true;
}

export type IrHostDateSnapshotGetter = "getDate" | "getMonth" | "getFullYear";

/** Exact checker-certified zero-argument ambient Date snapshot construction. */
export interface IrHostDateSnapshotLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  /** Target-selected clock callable; host stays ambient, standalone carries exact embedder provenance. */
  readonly target: IrFuncRef;
}

/** Exact getter use tied to one certified snapshot carrier. */
export interface IrHostDateGetterLoweringPlan extends IrHostDateSnapshotLoweringPlan {
  readonly snapshot: ts.NewExpression;
  readonly getter: IrHostDateSnapshotGetter;
}

/** One module binding's legacy storage, optionally tied to an exact terminal owner. */
export interface ModuleBindingGlobal {
  readonly ownerUnitId?: IrUnitId;
  /** Exact source-owned value storage. */
  readonly globalRef: IrGlobalRef;
  /** Exact source-owned TDZ state, when legacy storage tracks it. */
  readonly tdzGlobalRef: IrGlobalRef | null;
  /** Compatibility labels retained only for preflight and diagnostics. */
  readonly globalName: string;
  readonly tdzGlobalName: string | null;
  readonly type: IrType;
  /** Explicit provider provenance for an externref that is not generic host authority. */
  readonly capability?: "dom";
  /** Exact owner-qualified proof that this use executes only after Wasm start. */
  readonly omitTdzReadCheck?: true;
}

export interface IrIntegrationLoweringPlans {
  readonly identityContext: IrPlanningIdentityContext;
  /** Exact projected classes used by class-member body integration. */
  readonly classShapesById?: ReadonlyMap<IrClassId, IrClassShape>;
  /** Exact active terminal owners behind the remaining name-keyed integration API. */
  readonly ownerProjection: IrLegacyUnitProjection;
  readonly ownerUnitIdByLegacyName: ReadonlyMap<string, IrUnitId>;
  readonly signaturesByUnitId: ReadonlyMap<IrUnitId, IrClosureSignature>;
  readonly directCalls: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>;
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly hostVoidCallbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly hostDateSnapshots: ReadonlyMap<ts.NewExpression, IrHostDateSnapshotLoweringPlan>;
  readonly hostDateGetters: ReadonlyMap<ts.CallExpression, IrHostDateGetterLoweringPlan>;
  readonly promiseDelays: IrPromiseDelayLoweringPlans;
  /** Exact engine-activated source owners admitted by the async-plan producer. */
  readonly suspendingAsyncUnitIds: ReadonlySet<IrUnitId>;
  /**
   * Exact post-Wasm-start proof: these owners cannot execute until their
   * source-owned lexical globals have completed module initialization.
   */
  readonly postWasmStartTdzSafeBindingsByOwnerUnitId?: ReadonlyMap<IrUnitId, ReadonlySet<IrBindingId>>;
}

export function requireMatchingLoweringPlanOwner(
  planKind:
    | "direct call"
    | "imported call"
    | "top-level function value"
    | "host void callback"
    | "host Date snapshot"
    | "host Date getter"
    | "module binding",
  planOwnerUnitId: IrUnitId,
  activeOwnerUnitId: IrUnitId | undefined,
  funcName: string,
): void {
  const ownerKind = planKind === "module binding" ? "structural module binding" : `${planKind} plan`;
  if (activeOwnerUnitId === undefined) {
    throw new Error(`ir/from-ast: ${ownerKind} cannot be consumed without an authoritative ownerUnitId (${funcName})`);
  }
  if (planOwnerUnitId !== activeOwnerUnitId) {
    const staleOwnerKind = planKind === "module binding" ? "module-binding" : `${planKind} plan`;
    throw new Error(
      `ir/from-ast: stale ${staleOwnerKind} owner ${planOwnerUnitId} does not match ${activeOwnerUnitId} (${funcName})`,
    );
  }
}

export function requireMatchingModuleBindingOwner(
  binding: ModuleBindingGlobal,
  activeOwnerUnitId: IrUnitId | undefined,
  funcName: string,
): void {
  if (binding.ownerUnitId !== undefined) {
    requireMatchingLoweringPlanOwner("module binding", binding.ownerUnitId, activeOwnerUnitId, funcName);
  }
}
