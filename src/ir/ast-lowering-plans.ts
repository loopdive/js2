// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrClassId, IrSourceId, IrUnitId } from "./identity.js";
import {
  closureSignatureEquals,
  type IrClassShape,
  type IrClosureSignature,
  type IrFuncRef,
  type IrGlobalRef,
  type IrType,
} from "./nodes.js";
import type { IrCountedStringAppendPlan } from "./analysis/counted-string-append.js";
import type { IrCountedStringAppendSiteId } from "./counted-string-append-provenance.js";
import {
  requireIrPlanningOwnerUnitId,
  requireIrPlanningSourceId,
  type IrLegacyUnitProjection,
  type IrPlanningIdentityContext,
} from "./planning-identity.js";
import type { IrPromiseDelayLoweringPlans } from "./promise-delay-lowering.js";
import type { IrFnctorArgumentProjection } from "./fnctor-argument-projection.js";
import type { IrFnctorShape } from "./fnctor-abi.js";
import type { FuncHandle, FuncTypeDef, ValType, WasmFunction } from "./types.js";
import { sameIrCallableBinding } from "./callable-bindings.js";
import type { IrIdentityImportedFunctionResolver } from "./imported-functions.js";
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

/** Exact source callable record retained by a prepared fnctor projection. */
export interface IrFnctorSourceCallablePlan {
  readonly handle: FuncHandle;
  readonly func: WasmFunction;
  readonly typeIdx: number;
  readonly type: FuncTypeDef;
}

/** One authenticated native-string argument crossing into a runtime builtin. */
export interface IrFnctorNativeStringBoundaryPlan {
  readonly kind: "fnctor-native-string-boundary";
  readonly ownerUnitId: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly sourceFile: ts.SourceFile;
  readonly call: ts.CallExpression;
  readonly builtin: "parseInt" | "parseFloat";
  readonly argumentIndex: 0;
  readonly argument: ts.Expression;
  readonly target: IrFuncRef;
  readonly signature: IrClosureSignature;
}

export interface IrFnctorFieldReadPlan {
  readonly access: ts.PropertyAccessExpression;
  readonly fieldName: "input";
}

/**
 * Exact late #3521 preparation joining retained syntax, the observed fnctor
 * ABI, and the current source-callable slots. The optional consumer side is
 * deliberately absent for the compatibility harness, which only provides
 * the earlier readNumber-side records.
 */
export interface IrFnctorParameterPreselectionPlan {
  readonly kind: "fnctor-parameter-preselection";
  readonly projection: IrFnctorArgumentProjection;
  readonly shape: IrFnctorShape;
  readonly selectorKind: "object";
  readonly overrideType: IrType;
  readonly ownerUnitId: IrUnitId;
  readonly parameterDeclaration: ts.ParameterDeclaration;
  readonly parameterIndex: 0;
  readonly fieldReads: readonly IrFnctorFieldReadPlan[];
  readonly stringSliceCall: ts.CallExpression;
  readonly valueConsumerCall: ts.CallExpression;
  /** Exact `/\_/g` replacement inside the linked numeric parser. */
  readonly nativeStringReplaceCall?: ts.CallExpression;
  readonly physical: {
    readonly instanceCarrier: ValType;
    readonly fieldCarrier: ValType;
    readonly fieldIndex: number;
    readonly fieldRefinement: "nullable-native-string";
  };
  readonly preselection: IrFnctorSourceCallablePlan;
  readonly valueConsumer?: {
    readonly unitId: IrUnitId;
    readonly declaration: ts.FunctionDeclaration;
    readonly parameterDeclaration: ts.ParameterDeclaration;
    readonly parameterIndex: 0;
    readonly parameterPhysicalType: ValType;
    readonly signature: IrClosureSignature;
    readonly preselection: IrFnctorSourceCallablePlan;
  };
  readonly nativeStringBoundaries?: readonly IrFnctorNativeStringBoundaryPlan[];
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

export interface IrIdentityDirectCallCollectionOptions {
  readonly identityContext: IrPlanningIdentityContext;
  readonly resolver: IrIdentityImportedFunctionResolver;
  readonly activeOwnerUnitIds: ReadonlySet<IrUnitId>;
  readonly signaturesByUnitId: ReadonlyMap<IrUnitId, IrClosureSignature>;
  readonly targetsByLegacyName: ReadonlyMap<string, IrDirectCallTarget>;
}

function directCallIdentityMismatch(detail: string): never {
  throw new Error(`ir/direct-call identity: ${detail}`);
}

function requireExactDirectCallAst(node: ts.Node, sourceFile: ts.SourceFile, label: string): void {
  if (node.getSourceFile() !== sourceFile) {
    directCallIdentityMismatch(`${label} is detached from exact source ${sourceFile.fileName}`);
  }
  for (let current = node; current !== sourceFile; ) {
    const parent = current.parent;
    let retainedByParent = false;
    if (parent) ts.forEachChild(parent, (child) => void (retainedByParent ||= child === current));
    if (!parent || !retainedByParent) {
      directCallIdentityMismatch(`${label} is a copied or stale AST node in ${sourceFile.fileName}`);
    }
    current = parent;
  }
}

function requireActiveDirectCallTerminal(
  identityContext: IrPlanningIdentityContext,
  activeOwnerUnitIds: ReadonlySet<IrUnitId>,
  unitId: IrUnitId,
  role: "owner" | "target",
) {
  const terminal = identityContext.terminalByUnitId.get(unitId);
  if (
    !activeOwnerUnitIds.has(unitId) ||
    terminal === undefined ||
    identityContext.unitByUnitId.get(unitId) !== terminal ||
    terminal.terminal !== true ||
    terminal.terminalOwnerId !== unitId
  ) {
    directCallIdentityMismatch(`${role} ${unitId} is not an exact active self-owned terminal`);
  }
  return terminal;
}

/** Structural equality for duplicate producers of one exact direct-call AST site. */
export function irDirectCallLoweringPlanEquals(
  left: IrDirectCallLoweringPlan,
  right: IrDirectCallLoweringPlan,
): boolean {
  return (
    left.ownerUnitId === right.ownerUnitId &&
    left.target.name === right.target.name &&
    sameIrCallableBinding(left.target.binding, right.target.binding) &&
    closureSignatureEquals(left.signature, right.signature)
  );
}

/**
 * Collect source-unit calls through exact AST, owner, checker, and inventory
 * identity. The legacy-name map is only a projection after the checker has
 * authenticated the target; it never selects a target by identifier text.
 */
export function collectIrDirectCallLoweringPlansByIdentity(
  root: ts.Node,
  ownerUnitId: IrUnitId,
  options: IrIdentityDirectCallCollectionOptions,
): ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan> {
  const { identityContext, resolver, activeOwnerUnitIds, signaturesByUnitId, targetsByLegacyName } = options;
  const owner = requireActiveDirectCallTerminal(identityContext, activeOwnerUnitIds, ownerUnitId, "owner");
  const sourceFile = identityContext.sourceFileBySourceId.get(owner.sourceId);
  if (!sourceFile || identityContext.sourceIdBySourceFile.get(sourceFile) !== owner.sourceId) {
    directCallIdentityMismatch(`owner ${ownerUnitId} has no exact source object for ${owner.sourceId}`);
  }
  if (requireIrPlanningSourceId(identityContext, sourceFile) !== owner.sourceId) {
    directCallIdentityMismatch(`root for ${ownerUnitId} is detached from its exact source ${owner.sourceId}`);
  }
  requireExactDirectCallAst(root, sourceFile, `root for ${ownerUnitId}`);

  const plans = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      requireExactDirectCallAst(node, sourceFile, `call at ${node.pos}`);
      const actualOwnerUnitId = requireIrPlanningOwnerUnitId(identityContext, node);
      if (actualOwnerUnitId === ownerUnitId) {
        const resolved = resolver.resolveTopLevelFunctionValueTarget(node.expression);
        if (resolved) {
          const retained = targetsByLegacyName.get(resolved.targetName);
          if (retained) {
            const target = requireActiveDirectCallTerminal(
              identityContext,
              activeOwnerUnitIds,
              resolved.targetUnitId,
              "target",
            );
            const targetSourceFile = identityContext.sourceFileBySourceId.get(target.sourceId);
            const expectedSignature = signaturesByUnitId.get(resolved.targetUnitId);
            if (
              target.sourceId !== owner.sourceId ||
              targetSourceFile !== sourceFile ||
              resolved.declaration.getSourceFile() !== sourceFile ||
              identityContext.declarationByUnitId.get(resolved.targetUnitId) !== resolved.declaration ||
              identityContext.unitIdByDeclaration.get(resolved.declaration) !== resolved.targetUnitId ||
              retained.target.binding.kind !== "unit" ||
              retained.target.binding.unitId !== resolved.targetUnitId ||
              retained.target.name !== resolved.targetName ||
              expectedSignature === undefined ||
              !closureSignatureEquals(retained.signature, expectedSignature)
            ) {
              directCallIdentityMismatch(
                `target ${resolved.targetName} at ${sourceFile.fileName}:${node.pos} disagrees with its retained source identity`,
              );
            }
            plans.set(node, {
              ownerUnitId,
              target: retained.target,
              signature: retained.signature,
            });
          }
        }
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

/** Source/unit/provider authority for one exact counted-string loop. */
export interface IrCountedStringAppendLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly sourceId: IrSourceId;
  readonly siteId: IrCountedStringAppendSiteId;
  readonly sourceFile: ts.SourceFile;
  readonly syntaxPlan: IrCountedStringAppendPlan;
  readonly provider: IrFuncRef;
}

/** Final preparation receipt; its digest includes provider-bound IR. */
export interface PreparedCountedStringAppendReceipt {
  readonly siteId: IrCountedStringAppendSiteId;
  readonly plan: IrCountedStringAppendLoweringPlan;
  readonly finalInstructionDigest: string;
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
  /** Checker authority retained for exact source-unit direct-call reconciliation. */
  readonly directCallResolver?: IrIdentityImportedFunctionResolver;
  /** Exact late #3521 fnctor parameter projection, when fully prepared. */
  readonly fnctorParameterPreselection?: IrFnctorParameterPreselectionPlan;
  /** Exact native-string runtime boundaries owned by that projection. */
  readonly fnctorNativeStringBoundaries?: ReadonlyMap<ts.CallExpression, IrFnctorNativeStringBoundaryPlan>;
  /** Build-time callback that revalidates the mutable fnctor join. */
  readonly fnctorParameterPreselectionIsCurrent?: () => boolean;
  /** Exact projected classes used by class-member body integration. */
  readonly classShapesById?: ReadonlyMap<IrClassId, IrClassShape>;
  /** Exact active terminal owners behind the remaining name-keyed integration API. */
  readonly ownerProjection: IrLegacyUnitProjection;
  readonly ownerUnitIdByLegacyName: ReadonlyMap<string, IrUnitId>;
  readonly signaturesByUnitId: ReadonlyMap<IrUnitId, IrClosureSignature>;
  /** Exact callable signatures used to authenticate source direct-call sites. */
  readonly directCallSignaturesByUnitId?: ReadonlyMap<IrUnitId, IrClosureSignature>;
  readonly directCalls: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>;
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly hostVoidCallbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly hostDateSnapshots: ReadonlyMap<ts.NewExpression, IrHostDateSnapshotLoweringPlan>;
  readonly hostDateGetters: ReadonlyMap<ts.CallExpression, IrHostDateGetterLoweringPlan>;
  readonly countedStringAppends?: ReadonlyMap<ts.ForStatement, IrCountedStringAppendLoweringPlan>;
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
    | "counted string append"
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
