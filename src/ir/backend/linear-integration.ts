// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2956 slice L1 — the LINEAR backend consumes the IR front-end.
//
// `--target linear` historically branched ABOVE the IR (compiler.ts hands the
// AST straight to `generateLinearModule`), so the selector / from-ast / lower
// pipeline never ran for linear compiles. This module is the linear driver
// for IR-claimed functions: for each top-level FunctionDeclaration the
// selector claims, it builds IR ONCE via the SAME shared front-end the WasmGC
// path uses (`planIrCompilation` → `lowerFunctionAstToIr` → `verifyIrFunction`
// → `verifyIrBackendLegality("linear")`) and lowers it through the
// `LinearEmitter` (#1714/#2954) into a ready-to-insert `WasmFunction`.
// Everything that does not fit demotes — with a bucketed reason — to the
// linear DIRECT path, which remains the module driver and fallback.
//
// GATING: L4 made the proven L1-L3 families default-on. Set
// `JS2WASM_LINEAR_IR=0` for the byte-identical direct-backend escape hatch;
// `=1` remains accepted for explicit CI/probe runs.
//
// DESIGN NOTE — relation to the ratified L0 (adapter extraction): the #2956
// spec's L0 splits `src/ir/integration.ts` into a backend-neutral core + an
// `IrBackendIntegration` adapter. This driver deliberately does NOT touch
// integration.ts: every primitive it calls (`planIrCompilation`,
// `lowerFunctionAstToIr`, `verifyIrFunction`, `verifyIrBackendLegality`,
// `lowerIrFunctionBody`) is ALREADY backend-neutral and imported from its own
// module — nothing here duplicates integration.ts's selection/typeMap/report
// logic (the drift-clone the spec forbids). When L0/#3029-S3 lands, this
// driver becomes the `LinearIntegration` adapter implementation nearly
// verbatim; extracting the interface with TWO live consumers in view (this
// one and the WasmGC one) yields a better cut than a one-consumer refactor.
// Recorded in plan/issues/2956 §"Execution status".
//
// RESOLVER SCOPE: L1 supplies the four required name/table methods. L2 adds
// fixed-number vecs plus numeric object/ref-cell layouts; L3 maps strings to
// the direct backend's i32 arena pointer and UTF-8 runtime. from-ast keeps the
// representation abstract in each case. Union, dynamic boxing, closure/class,
// string iteration, and residual prototype methods stay absent and therefore
// demote through the same legality/build channel.

import { ts } from "../../ts-api.js";
import type { LinearContext } from "../../codegen-linear/context.js";
import { LINEAR_GENERIC_OBJECT_TAG } from "../../codegen-linear/layout.js";
import { FMOD_EARLY_MAGNITUDE_FN, FMOD_FN } from "../../codegen/fmod.js";
import {
  LINEAR_IR_STRING_CHAR_AT_FN,
  LINEAR_IR_STRING_CHAR_CODE_AT_FN,
  LINEAR_IR_STRING_APPEND_ASCII_FN,
  LINEAR_IR_VEC_INIT_F64_FN,
} from "../../codegen-linear/runtime.js";
import { linearStringLiteralInstrs } from "../../codegen-linear/string-literals.js";
import { IR_STRING_COMPARE_FN, lowerFunctionAstToIr, type IrFromAstResolver, typeNodeToIr } from "../from-ast.js";
import { collectIrDirectCallLoweringPlans, type IrDirectCallTarget } from "../ast-lowering-plans.js";
import { irUnitFuncRef } from "../callable-bindings.js";
import { lowerIrFunctionBody, type IrLowerResolver } from "../lower.js";
import { AllocSiteRegistry } from "../alloc-registry.js";
import {
  defaultOperationsForLayout,
  DEFAULT_ARENA_POLICY,
  linearRuntimeOperationKey,
  planLinearMemory,
  planLinearStringLayout,
  planLinearVectorLayout,
  type LinearAllocationSitePlan,
  type LinearAllocatorPolicy,
  type LinearMemoryPlan,
  type LinearRecordLayoutPlan,
  type LinearRuntimeOperation,
  type LinearStorageKind,
} from "../analysis/linear-memory-plan.js";
import { bindLinearStringRuntime } from "../analysis/linear-string-runtime.js";
import type { IrStringConcatMode, IrStringEncoding } from "../string-runtime.js";
import { IR_VEC_ELEM_SET_PREFIX } from "../vector-runtime.js";
import {
  asVal,
  irVal,
  type AllocSiteId,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrModule,
  type IrObjectShape,
  type IrType,
  type IrTypeRef,
} from "../nodes.js";
import {
  buildIrUnitInventory,
  indexIrTerminalDeclarations,
  type BuildIrUnitInventoryOptions,
  type IrTerminalUnitRecord,
  type IrUnitId,
} from "../identity.js";
import {
  buildIrPlanningIdentityContext,
  IrPlanningIdentityInvariantError,
  requireIrPlanningSourceId,
  type IrPlanningIdentityContext,
  type IrPlanningIdentityInvariantCode,
} from "../planning-identity.js";
import { buildIrUnitTypeMap, projectIrUnitTypeMapToLegacy, type LatticeType } from "../propagate.js";
import {
  makeIrArrayExpressionPredicate,
  makeIrAmbientBindingPredicate,
  makeIrDeclaredPrimitiveExpressionClassifier,
  makeIrPrimitiveExpressionClassifier,
  makeIrRegExpExpressionPredicate,
} from "../module-bindings.js";
import {
  effectiveIrParamTypeNode,
  effectiveIrReturnTypeNode,
  irClosureSignatureFromFunctionTypeNode,
} from "../select.js";
import { planIrCompilationByIdentity, projectIrSelectionToLegacy } from "../select-identity.js";
import { buildIrRecursiveTypeEvidence } from "../type-evidence.js";
import type { FuncTypeDef, Instr, ValType, WasmFunction } from "../types.js";
import { verifyIrFunction } from "../verify.js";
import { prepareIrRuntimeManifest } from "../intrinsic-support.js";
import type { TypeConverter } from "./contract.js";
import { verifyIrBackendLegality } from "./legality.js";
import { LinearEmitter } from "./linear-emitter.js";
import type {
  IrRefCellLowering,
  IrVecLowering,
  LinearMemoryFieldLowering,
  LinearObjectLowering,
  LinearRefCellLowering,
  LinearVecLowering,
} from "./handles.js";

/** One function routed to the direct path, and its stable bucketed reason. */
export interface LinearIrRejection {
  readonly func: string;
  /** Stable bucket key for the ratchet (scripts/check-linear-ir.mjs). */
  readonly reason: string;
  /** First error message — diagnostic detail, NOT part of the bucket key. */
  readonly detail?: string;
}

export type LinearIrOwnerEvidence =
  | {
      readonly outcome: "compiled";
      readonly ownerUnitId: IrUnitId;
      readonly legacyName: string;
    }
  | {
      readonly outcome: "rejected";
      readonly ownerUnitId: IrUnitId;
      readonly legacyName: string;
      readonly rejection: LinearIrRejection;
    };

export interface LinearIrCompiledArtifact {
  readonly ownerUnitId: IrUnitId;
  readonly func: WasmFunction;
  readonly legacySlot: LinearIrLegacySlotAdapter;
}

export interface LinearIrResult {
  /** Structural owner → IR-lowered function, ready for its exact legacy slot. */
  readonly funcs: ReadonlyMap<IrUnitId, WasmFunction>;
  readonly compiled: readonly string[];
  /** Selector rejections plus post-claim IR demotions, in direct-path order. */
  readonly rejected: readonly LinearIrRejection[];
  /** Exact owners for every public compiled/rejected legacy-name outcome. */
  readonly ownerEvidence: readonly LinearIrOwnerEvidence[];
  /**
   * Temporary direct-backend slot adapters. ProgramAbiSession removes this
   * compatibility boundary; until then every entry retains and validates the
   * structural owner, legacy label, physical slot label, and concrete index.
   */
  readonly legacySlots: readonly LinearIrLegacySlotAdapter[];
  /** Resolve an exact source declaration and its paired compatibility slot. */
  compiledArtifactFor(declaration: ts.FunctionDeclaration): LinearIrCompiledArtifact | undefined;
  /** Deferred helpers appended only after every pre-assigned user slot. */
  readonly helpers: readonly LinearIrHelper[];
  /** Exact verified source-derived module consumed by the memory planner. */
  readonly irModule: IrModule;
  /** Canonical middle-end allocation/layout decisions for this IR module. */
  readonly memoryPlan: LinearMemoryPlan;
}

export interface LinearIrSourceOwner {
  readonly ownerUnitId: IrUnitId;
  readonly legacyName: string;
  readonly declaration: ts.Node;
}

export interface LinearIrSourceOwnerIndex {
  readonly owners: readonly LinearIrSourceOwner[];
}

/** Direct-backend registration before the ProgramAbiSession cutover. */
export interface LinearIrLegacySlotInput {
  readonly declaration: ts.Node;
  readonly legacyName: string;
  readonly funcIdx: number;
}

/** Exact structural/name pair at the one remaining concrete legacy-slot seam. */
export interface LinearIrLegacySlotAdapter {
  readonly ownerUnitId: IrUnitId;
  readonly legacyName: string;
  readonly slotName: string;
  readonly funcIdx: number;
}

function linearOwnerInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

function rethrowLinearOwnerInvariant(error: unknown): void {
  if (error instanceof IrPlanningIdentityInvariantError) {
    throw error;
  }
}

function requireLinearOwnerPair(owner: LinearIrSourceOwner, legacyName: string): void {
  if (owner.legacyName !== legacyName) {
    linearOwnerInvariant(
      "unit-record-mismatch",
      `linear IR owner ${owner.ownerUnitId} expected label ${JSON.stringify(owner.legacyName)}, received ${JSON.stringify(legacyName)}`,
    );
  }
}

function requireUniqueLinearOwner(
  ownersByLegacyName: ReadonlyMap<string, readonly LinearIrSourceOwner[]>,
  legacyName: string,
  role: string,
): LinearIrSourceOwner {
  const owners = ownersByLegacyName.get(legacyName) ?? [];
  if (owners.length !== 1) {
    return linearOwnerInvariant(
      "unit-record-mismatch",
      `linear IR ${role} ${JSON.stringify(legacyName)} resolves to ${owners.length} structural source owners`,
    );
  }
  return owners[0]!;
}

function isLinearIrAttemptRoot(terminal: IrTerminalUnitRecord): boolean {
  return !(
    terminal.kind === "synthetic-support" &&
    terminal.syntheticRole === "compiler-unit:timer-shim:set-timeout" &&
    terminal.terminalOwnerId === terminal.id &&
    terminal.lexicalOwnerId === null
  );
}

/**
 * Validate the complete structural population received by the linear source
 * seam. Every direction is checked against the same authoritative planning
 * context. Display-label collisions remain distinct here; only the explicit
 * legacy-slot adapter below is permitted to cross into concrete slot names.
 */
export function indexLinearIrSourceOwners(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
): LinearIrSourceOwnerIndex {
  const sourceId = requireIrPlanningSourceId(identityContext, sourceFile);
  if (identityContext.sourceFileBySourceId.get(sourceId) !== sourceFile) {
    return linearOwnerInvariant(
      "source-record-mismatch",
      `linear IR source ${sourceId} does not resolve back to the exact planning SourceFile`,
    );
  }

  const expected = identityContext.inventory.terminalUnits.filter(
    (terminal) =>
      terminal.sourceId === sourceId &&
      (terminal.observedKind === "function" || terminal.observedKind === "class-member") &&
      isLinearIrAttemptRoot(terminal),
  );
  const liveNodes = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    liveNodes.add(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const owners = expected.map((terminal): LinearIrSourceOwner => {
    const declaration = identityContext.declarationByUnitId.get(terminal.id);
    if (
      identityContext.unitByUnitId.get(terminal.id) !== terminal ||
      identityContext.terminalByUnitId.get(terminal.id) !== terminal ||
      terminal.terminalOwnerId !== terminal.id ||
      !declaration ||
      !liveNodes.has(declaration) ||
      declaration.getSourceFile() !== sourceFile ||
      identityContext.unitIdByDeclaration.get(declaration) !== terminal.id
    ) {
      return linearOwnerInvariant(
        "terminal-record-mismatch",
        `linear IR source owner ${terminal.id} does not round-trip through the authoritative population`,
      );
    }
    return Object.freeze({
      ownerUnitId: terminal.id,
      legacyName: terminal.legacyMatchName,
      declaration,
    });
  });
  return Object.freeze({ owners: Object.freeze(owners) });
}

/**
 * Pair structural source owners with exact direct-backend registrations.
 *
 * This is the sole temporary source-unit → concrete-label adapter in the
 * linear IR path. It rejects duplicate declarations, unit IDs, and concrete
 * function indices instead of accepting a last-write-wins `funcMap` result.
 */
export function buildLinearIrLegacySlotAdapters(
  ownerIndex: LinearIrSourceOwnerIndex,
  inputs: readonly LinearIrLegacySlotInput[],
): readonly LinearIrLegacySlotAdapter[] {
  const inputByDeclaration = new Map<ts.Node, LinearIrLegacySlotInput>();
  for (const input of inputs) {
    if (
      typeof input.legacyName !== "string" ||
      input.legacyName.length === 0 ||
      !Number.isSafeInteger(input.funcIdx) ||
      input.funcIdx < 0
    ) {
      return linearOwnerInvariant(
        "unit-record-mismatch",
        `linear IR legacy slot registration has an invalid label or function index`,
      );
    }
    if (inputByDeclaration.has(input.declaration)) {
      return linearOwnerInvariant(
        "duplicate-unit-declaration",
        `linear IR declaration was registered for more than one concrete function slot`,
      );
    }
    inputByDeclaration.set(input.declaration, input);
  }

  const unitIds = new Set<IrUnitId>();
  const ownersByFuncIdx = new Map<number, IrUnitId>();
  const consumedInputs = new Set<LinearIrLegacySlotInput>();
  const adapters: LinearIrLegacySlotAdapter[] = [];
  for (const owner of ownerIndex.owners) {
    const input = inputByDeclaration.get(owner.declaration);
    if (!input) continue;
    consumedInputs.add(input);
    if (unitIds.has(owner.ownerUnitId)) {
      return linearOwnerInvariant(
        "duplicate-unit-id",
        `linear IR source unit ${owner.ownerUnitId} was registered more than once`,
      );
    }
    const previousOwner = ownersByFuncIdx.get(input.funcIdx);
    if (previousOwner !== undefined && previousOwner !== owner.ownerUnitId) {
      return linearOwnerInvariant(
        "unit-record-mismatch",
        `linear IR units ${previousOwner} and ${owner.ownerUnitId} share concrete function slot ${input.funcIdx}`,
      );
    }
    unitIds.add(owner.ownerUnitId);
    ownersByFuncIdx.set(input.funcIdx, owner.ownerUnitId);
    adapters.push(
      Object.freeze({
        ownerUnitId: owner.ownerUnitId,
        legacyName: owner.legacyName,
        slotName: input.legacyName,
        funcIdx: input.funcIdx,
      }),
    );
  }
  for (const input of inputs) {
    if (!consumedInputs.has(input)) {
      return linearOwnerInvariant(
        "unit-record-mismatch",
        `linear IR legacy slot ${JSON.stringify(input.legacyName)} has no exact structural source owner`,
      );
    }
  }
  return Object.freeze(adapters);
}

export interface LinearIrHelper {
  readonly funcIdx: number;
  readonly name: string;
  readonly typeIdx: number;
  readonly fields: readonly { readonly name: string; readonly type: ValType; readonly offset: number }[];
  readonly layout: LinearRecordLayoutPlan;
  /** Symbolic until the module adapter assembles the deferred helper. */
  readonly allocate: LinearRuntimeOperation;
}

/** L4 gate: default-on, with an explicit `=0` direct-backend escape hatch. */
export function linearIrEnabled(): boolean {
  return typeof process === "undefined" || process.env?.JS2WASM_LINEAR_IR !== "0";
}

export function terminalPredicate(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  inventoryOptions: BuildIrUnitInventoryOptions = {},
): (node: ts.Node) => boolean {
  if (!linearIrEnabled()) return () => false;
  const inventory = buildIrUnitInventory([sourceFile], {
    ...inventoryOptions,
    entrySource: sourceFile,
    checker,
  });
  const terminals = indexIrTerminalDeclarations(sourceFile, inventory);
  const attemptRootIds = new Set(inventory.terminalUnits.filter(isLinearIrAttemptRoot).map((terminal) => terminal.id));
  return (node) => {
    const unitId = terminals.get(node);
    return unitId !== undefined && attemptRootIds.has(unitId);
  };
}

function planLinearIrOverlay(
  ctx: LinearContext,
  sourceFile: ts.SourceFile,
  inventoryOptions: BuildIrUnitInventoryOptions,
) {
  const sourceFiles = [sourceFile];
  const inventory = buildIrUnitInventory(sourceFiles, {
    ...inventoryOptions,
    entrySource: sourceFile,
    checker: ctx.checker,
  });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const propagated = buildIrUnitTypeMap(sourceFiles, ctx.checker, identityContext);
  const recursiveTypeEvidence = buildIrRecursiveTypeEvidence(sourceFiles, ctx.checker, propagated, identityContext);
  const evidenceChecker = overlayCertifiedCheckerTypes(ctx.checker, recursiveTypeEvidence.checkerTypeOverrides);
  const projectedSelection = projectIrSelectionToLegacy(
    planIrCompilationByIdentity(
      sourceFile,
      identityContext,
      {
        experimentalIR: true,
        trackFallbacks: true,
        recursiveTypeEvidence,
        classifyPrimitiveExpression: makeIrPrimitiveExpressionClassifier(ctx.checker),
        classifyDeclaredPrimitiveExpression: makeIrDeclaredPrimitiveExpressionClassifier(ctx.checker),
        isArrayExpression: makeIrArrayExpressionPredicate(ctx.checker),
        isRegExpExpression: makeIrRegExpExpressionPredicate(ctx.checker),
        isAmbientBinding: makeIrAmbientBindingPredicate(ctx.checker),
        supportsSymbolicMathHelpers: false,
        supportsNumberToString: ctx.mod.functions.some((func) => func.name === "number_toString"),
        supportsLiteralStringReplace: false,
      },
      propagated,
    ),
  ).selection;
  const excludedCompilerSupportNames = new Set(
    inventory.terminalUnits
      .filter((terminal) => !isLinearIrAttemptRoot(terminal))
      .map((terminal) => terminal.legacyMatchName),
  );
  const selection = {
    ...projectedSelection,
    funcs: new Set([...projectedSelection.funcs].filter((name) => !excludedCompilerSupportNames.has(name))),
    fallbacks: projectedSelection.fallbacks?.filter((fallback) => !excludedCompilerSupportNames.has(fallback.name)),
  };
  return {
    identityContext,
    recursiveTypeEvidence,
    evidenceChecker,
    selection,
    recursiveTypeMap: projectIrUnitTypeMapToLegacy(sourceFiles, recursiveTypeEvidence.typeMap, identityContext),
    ownerIndex: indexLinearIrSourceOwners(sourceFile, identityContext),
  };
}

// Report side-channel for the ratchet harness (scripts/check-linear-ir.mjs):
// compiles are single-threaded within one process, so the harness reads the
// last module's report right after `compile()` returns. Deliberately NOT on
// the public CompileResult surface for slice 1.
let lastReport: LinearIrResult | undefined;
export function getLastLinearIrReport(): LinearIrResult | undefined {
  return lastReport;
}

function prepareLinearIntrinsicFunctions(functions: readonly IrFunction[], sourceFile: string): readonly IrFunction[] {
  return (
    prepareIrRuntimeManifest({
      functions,
      sourceFile,
      policy: { target: "host", backend: "linear" },
    })?.functions ?? functions
  );
}

/**
 * Build + lower every selector-claimed top-level FunctionDeclaration for the
 * LINEAR backend. Precompute mutates only append-only/deduped func types and
 * the direct backend's string-literal data registry; the caller inserts the
 * returned functions at their pre-assigned `ctx.funcMap` slots.
 */
export function compileLinearIrFunctions(
  ctx: LinearContext,
  sourceFile: ts.SourceFile,
  allocationPolicy: LinearAllocatorPolicy = DEFAULT_ARENA_POLICY,
  legacySlotInputs: readonly LinearIrLegacySlotInput[] = [],
  inventoryOptions: BuildIrUnitInventoryOptions = {},
): LinearIrResult {
  const funcs = new Map<IrUnitId, WasmFunction>();
  const compiled: string[] = [];
  const rejected: LinearIrRejection[] = [];
  const ownerEvidence: LinearIrOwnerEvidence[] = [];
  const legacySlots: LinearIrLegacySlotAdapter[] = [];
  const unitIdByDeclaration = new Map<ts.Node, IrUnitId>();
  const slotByDeclaration = new Map<ts.Node, LinearIrLegacySlotAdapter>();
  const allocRegistry = new AllocSiteRegistry();
  let irModule: IrModule = { functions: [] };
  let memoryPlan = planLinearMemory(irModule, allocRegistry, allocationPolicy);
  let helperStartFuncIdx = 0;
  for (const funcIdx of ctx.funcMap.values()) helperStartFuncIdx = Math.max(helperStartFuncIdx, funcIdx + 1);
  for (const slot of legacySlotInputs) helperStartFuncIdx = Math.max(helperStartFuncIdx, slot.funcIdx + 1);
  const { resolver, helpers, bindMemoryPlan, bindUnitFunc } = makeLinearIrResolver(ctx, helperStartFuncIdx);
  const result: LinearIrResult = {
    funcs,
    compiled,
    rejected,
    ownerEvidence,
    legacySlots,
    compiledArtifactFor(declaration) {
      const unitId = unitIdByDeclaration.get(declaration);
      if (unitId === undefined) return undefined;
      const func = funcs.get(unitId);
      if (!func) return undefined;
      const legacySlot = slotByDeclaration.get(declaration);
      if (!legacySlot || legacySlot.ownerUnitId !== unitId) {
        return linearOwnerInvariant(
          "unit-record-mismatch",
          `linear IR compiled artifact ${unitId} has no exact legacy slot adapter`,
        );
      }
      return { ownerUnitId: unitId, func, legacySlot };
    },
    helpers,
    get irModule() {
      return irModule;
    },
    get memoryPlan() {
      return memoryPlan;
    },
  };
  lastReport = result;

  // L4 folds the selector's per-function direct-path list into the same
  // ratchet as post-claim build/verify/legality demotions. Prefix the stable
  // selector reason so pre-claim and post-claim buckets cannot collide.
  // The general propagation pass deliberately starts optimistically so it
  // can discover recursive arithmetic. For linear, expose only the recursive
  // SCC entries that the checker-backed certifier has independently proved;
  // this avoids widening unrelated unannotated selection while giving the
  // selector and from-ast one shared, concrete recursive ABI.
  const { identityContext, recursiveTypeEvidence, evidenceChecker, selection, recursiveTypeMap, ownerIndex } =
    planLinearIrOverlay(ctx, sourceFile, inventoryOptions);
  for (const owner of ownerIndex.owners) unitIdByDeclaration.set(owner.declaration, owner.ownerUnitId);
  for (const slot of buildLinearIrLegacySlotAdapters(ownerIndex, legacySlotInputs)) {
    const owner = identityContext.declarationByUnitId.get(slot.ownerUnitId);
    if (!owner) {
      return linearOwnerInvariant(
        "missing-unit-declaration",
        `linear IR legacy slot ${slot.ownerUnitId} has no exact source declaration`,
      );
    }
    legacySlots.push(slot);
    slotByDeclaration.set(owner, slot);
    bindUnitFunc(slot);
  }
  const ownerByUnitId = new Map(ownerIndex.owners.map((owner) => [owner.ownerUnitId, owner] as const));
  const ownersByLegacyName = new Map<string, LinearIrSourceOwner[]>();
  for (const owner of ownerIndex.owners) {
    const sameName = ownersByLegacyName.get(owner.legacyName);
    if (sameName) sameName.push(owner);
    else ownersByLegacyName.set(owner.legacyName, [owner]);
  }
  const recordRejection = (owner: LinearIrSourceOwner, rejection: LinearIrRejection): void => {
    requireLinearOwnerPair(owner, rejection.func);
    rejected.push(rejection);
    ownerEvidence.push({
      outcome: "rejected",
      ownerUnitId: owner.ownerUnitId,
      legacyName: owner.legacyName,
      rejection,
    });
  };
  for (const fallback of selection.fallbacks ?? []) {
    const owner = requireUniqueLinearOwner(ownersByLegacyName, fallback.name, "fallback");
    recordRejection(owner, {
      func: fallback.name,
      reason: `select:${fallback.reason}`,
      detail: fallback.detail,
    });
  }
  if (selection.funcs.size === 0) return result;

  const claimedDecls: {
    ownerUnitId: IrUnitId;
    legacyName: string;
    declaration: ts.FunctionDeclaration;
    exported: boolean;
  }[] = [];
  for (const name of selection.funcs) {
    const owner = requireUniqueLinearOwner(ownersByLegacyName, name, "function claim");
    const ownerUnitId = owner.ownerUnitId;
    const declaration = owner?.declaration;
    if (
      !owner ||
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      !declaration.body ||
      !declaration.name ||
      declaration.name.text !== name
    ) {
      return linearOwnerInvariant(
        "unit-record-mismatch",
        `linear IR function claim ${ownerUnitId} does not resolve to its exact named declaration`,
      );
    }
    requireLinearOwnerPair(owner, name);
    const exported = declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    claimedDecls.push({ ownerUnitId, legacyName: name, declaration, exported });
  }
  if (claimedDecls.length === 0) return result;

  // Cross-function calls: from-ast resolves a top-level callee through
  // `calleeTypes`. The WasmGC integration seeds it from the Phase-2 TypeMap;
  // slice L1 seeds it by FIXPOINT instead — a successful build contributes
  // its own signature (`main.params[].type` / `main.resultTypes[0]`), and
  // functions that failed ONLY on a not-yet-known callee are retried with
  // the enriched map. Bounded by the claim count (each round must compile
  // at least one new function to continue).
  type LinearIrSignature = { params: readonly IrType[]; returnType: IrType | null };
  const declaredSignaturesByUnitId = new Map<IrUnitId, LinearIrSignature>();
  const signaturesByUnitId = new Map<IrUnitId, LinearIrSignature>();
  const built = new Map<IrUnitId, IrFunction>();
  const lastFailure = new Map<IrUnitId, LinearIrRejection>();
  let pending = claimedDecls;
  // Pre-seed `calleeTypes` from effective TS/JSDoc annotations and, only for
  // certified recursive SCC members, the evidence TypeMap. The same entries
  // are passed as from-ast overrides so declaration lowering and recursive
  // call lowering cannot derive different signatures.
  for (const { ownerUnitId, legacyName: name, declaration: decl } of claimedDecls) {
    try {
      const evidence = recursiveTypeMap.get(name);
      const params = decl.parameters.map((param, index) => {
        const annotated = effectiveIrParamTypeNode(param);
        if (annotated) {
          if (ts.isFunctionTypeNode(annotated)) {
            const signature = irClosureSignatureFromFunctionTypeNode(annotated);
            if (!signature) throw new Error(`linear-ir: unsupported callable parameter of ${name}`);
            return { kind: "callable", signature } as IrType;
          }
          return typeNodeToIr(annotated, `pre-seed param of ${name}`);
        }
        return latticeEvidenceToIr(evidence?.params[index], `pre-seed param of ${name}`);
      });
      const returnNode = effectiveIrReturnTypeNode(decl);
      const returnType =
        returnNode?.kind === ts.SyntaxKind.VoidKeyword
          ? null
          : returnNode
            ? typeNodeToIr(returnNode, `pre-seed return of ${name}`)
            : latticeEvidenceToIr(evidence?.returnType, `pre-seed return of ${name}`);
      const signature = { params, returnType };
      declaredSignaturesByUnitId.set(ownerUnitId, signature);
      signaturesByUnitId.set(ownerUnitId, signature);
    } catch {
      // Non-primitive or unresolved signatures stay on the existing
      // build-fixpoint/demotion path.
    }
  }

  for (let round = 0; round <= claimedDecls.length && pending.length > 0; round++) {
    const next: typeof pending = [];
    let progressed = false;

    for (const owner of pending) {
      const { ownerUnitId, legacyName: name, declaration: decl, exported } = owner;
      try {
        const { calleeTypes, directCallTargets } = projectLinearCalleeSignaturesToLegacy(
          signaturesByUnitId,
          ownerByUnitId,
        );
        // Build through the SAME shared from-ast as WasmGC. The narrowed
        // linear resolver exposes the landed L2 vec/aggregate and L3 string
        // shapes; every other representation-dependent family still throws
        // and demotes.
        const { main, lifted } = lowerFunctionAstToIr(decl, {
          checker: evidenceChecker,
          exported,
          funcName: name,
          ownerUnitId,
          calleeTypes,
          directCalls: collectIrDirectCallLoweringPlans(decl, ownerUnitId, directCallTargets),
          paramTypeOverrides: declaredSignaturesByUnitId.get(ownerUnitId)?.params,
          returnTypeOverride: declaredSignaturesByUnitId.get(ownerUnitId)?.returnType,
          resolver,
          allocRegistry,
        });
        requireLinearOwnerPair(owner, main.name);

        // Slice 1 lowers into PRE-ASSIGNED slots only; a build that
        // synthesizes lifted closures needs fresh slots (the WasmGC
        // integration's synthesized-func path) — demote until closures are
        // in linear scope.
        if (lifted.length > 0) {
          lastFailure.set(ownerUnitId, { func: name, reason: "lifted-closures" });
          progressed = true; // terminal — do not retry
          continue;
        }

        const verifyErrors = verifyIrFunction(main);
        if (verifyErrors.length > 0) {
          lastFailure.set(ownerUnitId, { func: name, reason: "verify", detail: verifyErrors[0]?.message });
          progressed = true; // terminal
          continue;
        }

        // The linear legality gate (#2954) — the capability predicate the
        // spec prescribes. Reject BEFORE lowering so an unsupported surface
        // is a bucketed demotion, not a lowering throw.
        const legality = verifyIrBackendLegality(main, "linear");
        if (legality.length > 0) {
          lastFailure.set(ownerUnitId, {
            func: name,
            reason: `illegal:${bucketFromLegalityMessage(legality[0]!.message)}`,
            detail: legality[0]?.message,
          });
          progressed = true; // terminal
          continue;
        }

        built.set(ownerUnitId, main);
        signaturesByUnitId.set(ownerUnitId, {
          params: main.params.map((p) => p.type),
          returnType: main.resultTypes.length > 0 ? main.resultTypes[0]! : null,
        });
        lastFailure.delete(ownerUnitId);
        progressed = true;
      } catch (e) {
        rethrowLinearOwnerInvariant(e);
        // Fail-safe demote: the linear DIRECT path compiles this function
        // exactly as it does today (the overlay only ever ADDS capability).
        // A "call to unknown function" may resolve in a later round once
        // the callee's signature lands in `signaturesByUnitId` — keep it pending.
        lastFailure.set(ownerUnitId, {
          func: name,
          reason: "build",
          detail: e instanceof Error ? e.message : String(e),
        });
        next.push(owner);
      }
    }

    pending = next;
    if (!progressed) break; // fixpoint: nothing new compiled or terminally rejected
  }

  const plannedFunctions = claimedDecls.flatMap(({ ownerUnitId }) => {
    const fn = built.get(ownerUnitId);
    return fn ? [fn] : [];
  });
  const preparedFunctions = prepareLinearIntrinsicFunctions(plannedFunctions, sourceFile.fileName);
  for (const fn of preparedFunctions) built.set(fn.unitId, fn);
  irModule = { functions: preparedFunctions };
  memoryPlan = planLinearMemory(irModule, allocRegistry, allocationPolicy);
  bindMemoryPlan(memoryPlan);

  // Lower only after the module-wide plan is complete. Every allocation-site
  // handle below is therefore a view of the same canonical decision.
  for (const owner of claimedDecls) {
    const { ownerUnitId, legacyName: name } = owner;
    const main = built.get(ownerUnitId);
    if (!main) {
      const failure = lastFailure.get(ownerUnitId);
      if (failure) recordRejection(owner, failure);
      continue;
    }
    try {
      const emitter = new LinearEmitter({
        resolveRuntimeOperation: (operation) => resolveLinearRuntimeOperation(ctx, operation),
        stringRuntime: resolver,
      });
      const body = lowerIrFunctionBody(main, resolver, emitter, linearValueTypeConverter(resolver, main.name));
      requireLinearOwnerPair(owner, body.name);
      const vecScratchLocals = new Set(emitter.getVecScratchLocalIndices());
      const wasmLocals = body.locals.flatMap((local) =>
        local.slots.map((type, slot) => ({
          name: slot === 0 ? local.name : `${local.name}$${slot}`,
          type,
        })),
      );
      const locals = wasmLocals.map((local, index) => {
        const absoluteIndex = main.params.length + index;
        if (!vecScratchLocals.has(absoluteIndex)) return local;
        return { name: `$linear_vec_ptr_${index}`, type: { kind: "i32" as const } };
      });
      const stackOperations = stackFrameOperations(memoryPlan, name);
      if (stackOperations) {
        const markLocal = body.params.flatMap((param) => param.slots).length + locals.length;
        locals.push({ name: "$linear_stack_mark", type: { kind: "i32" } });
        instrumentLinearStackFrame(
          body.body,
          markLocal,
          resolveLinearRuntimeOperation(ctx, stackOperations.mark),
          resolveLinearRuntimeOperation(ctx, stackOperations.restore),
        );
      }
      funcs.set(ownerUnitId, {
        name: body.name,
        typeIdx: resolver.internFuncType({
          kind: "func",
          params: body.params.flatMap((param) => [...param.slots]),
          results: body.results.flatMap((result) => [...result]),
        }),
        locals,
        body: body.body,
        exported: body.exported,
      });
      compiled.push(name);
      ownerEvidence.push({ outcome: "compiled", ownerUnitId, legacyName: name });
    } catch (e) {
      rethrowLinearOwnerInvariant(e);
      recordRejection(owner, {
        func: name,
        reason: "build",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (typeof process !== "undefined" && process.env?.JS2WASM_LINEAR_IR_DEBUG === "1") {
    console.error("[linear-ir] compiled:", JSON.stringify(compiled));
    console.error("[linear-ir] rejected:", JSON.stringify(result.rejected, null, 1));
  }
  return result;
}

export const compileLinearIr = compileLinearIrFunctions;

/**
 * Narrow compatibility projection for the still-name-keyed `from-ast`
 * signature option. Canonical signature/fixpoint state remains keyed by unit
 * ID; colliding labels are omitted rather than selecting either source unit.
 */
function projectLinearCalleeSignaturesToLegacy(
  signaturesByUnitId: ReadonlyMap<IrUnitId, { params: readonly IrType[]; returnType: IrType | null }>,
  ownerByUnitId: ReadonlyMap<IrUnitId, LinearIrSourceOwner>,
): {
  calleeTypes: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
  directCallTargets: ReadonlyMap<string, IrDirectCallTarget>;
} {
  const candidates = new Map<
    string,
    { owner: LinearIrSourceOwner; signature: { params: readonly IrType[]; returnType: IrType | null } }[]
  >();
  for (const [unitId, signature] of signaturesByUnitId) {
    const owner = ownerByUnitId.get(unitId);
    if (!owner) {
      return linearOwnerInvariant(
        "missing-planning-owner",
        `linear IR signature ${unitId} has no validated source owner`,
      );
    }
    const existing = candidates.get(owner.legacyName);
    const candidate = { owner, signature };
    if (existing) existing.push(candidate);
    else candidates.set(owner.legacyName, [candidate]);
  }

  const calleeTypes = new Map<string, { params: readonly IrType[]; returnType: IrType | null }>();
  const directCallTargets = new Map<string, IrDirectCallTarget>();
  for (const [legacyName, matches] of candidates) {
    if (matches.length !== 1) continue;
    const { owner, signature } = matches[0]!;
    calleeTypes.set(legacyName, signature);
    directCallTargets.set(legacyName, {
      target: irUnitFuncRef({ unitId: owner.ownerUnitId, name: legacyName }),
      signature,
    });
  }
  return { calleeTypes, directCallTargets };
}

function latticeEvidenceToIr(type: LatticeType | undefined, context: string): IrType {
  if (type?.kind === "f64") return irVal({ kind: "f64" });
  if (type?.kind === "bool") return irVal({ kind: "i32", boolean: true });
  if (type?.kind === "string") return { kind: "string" };
  throw new Error(`linear-ir: ${context} has no certified scalar type`);
}

function overlayCertifiedCheckerTypes(
  checker: ts.TypeChecker,
  overrides: ReadonlyMap<ts.Node, ts.Type>,
): ts.TypeChecker {
  if (overrides.size === 0) return checker;
  return new Proxy(checker, {
    get(target, property) {
      if (property === "getTypeAtLocation") {
        return (node: ts.Node): ts.Type => overrides.get(node) ?? target.getTypeAtLocation(node);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Stable ratchet bucket from a legality error message. The message shapes
 * come from `legality.ts` (`linearInstrError` / `linearValTypeError`):
 *   "linear backend does not support IR instruction 'X' …" → `instr-X`
 *   "linear backend does not support ValType 'K'"          → `valtype-K`
 *   "linear backend does not support const 'K'"            → `const-K`
 */
function bucketFromLegalityMessage(message: string): string {
  const instr = /IR instruction '([^']+)'/.exec(message);
  if (instr) return `instr-${instr[1]}`;
  const valtype = /ValType '([^']+)'/.exec(message);
  if (valtype) return `valtype-${valtype[1]}`;
  const constKind = /const '([^']+)'/.exec(message);
  if (constKind) return `const-${constKind[1]}`;
  return "other";
}

function resolveLinearImportFunc(
  ctx: LinearContext,
  module: string,
  field: string,
  resolveRuntimeFunc: (name: string) => number,
): number {
  if (module === "env" && field === "number_toString") return resolveRuntimeFunc("number_toString");
  let funcIdx = 0;
  for (const imported of ctx.mod.imports) {
    if (imported.desc.kind !== "func") continue;
    if (imported.module === module && imported.name === field) return funcIdx;
    funcIdx++;
  }
  throw new Error(`linear-ir: imported function '${module}.${field}' missing`);
}

/**
 * The linear resolver: required name/table methods plus the L2 fixed-f64-vec,
 * aggregate/refcell subsets and the L3 i32-pointer string representation.
 * Other optional shape hooks remain absent — see the module header.
 */
function makeLinearIrResolver(
  ctx: LinearContext,
  helperStartFuncIdx: number,
): {
  resolver: IrLowerResolver & IrFromAstResolver;
  helpers: LinearIrHelper[];
  bindMemoryPlan(plan: LinearMemoryPlan): void;
  bindUnitFunc(slot: LinearIrLegacySlotAdapter): void;
} {
  const helpers: LinearIrHelper[] = [];
  const helperByShape = new Map<string, number>();
  const objects = new Map<string, LinearObjectLowering>();
  const refCells = new Map<string, LinearRefCellLowering>();
  const f64IrType = irVal({ kind: "f64" });
  const provisionalF64VectorLayout = planLinearVectorLayout(f64IrType);
  const unitFuncSlotById = new Map<IrUnitId, LinearIrLegacySlotAdapter>();
  let memoryPlan: LinearMemoryPlan | undefined;

  const resolveRuntimeFunc = (name: string): number => {
    // Runtime functions were appended before user-slot pre-assignment. Scan
    // the actual defined-function table so a source function with a reserved
    // helper-like name cannot shadow the runtime entry in funcMap.
    const localIdx = ctx.mod.functions.findIndex((func) => func.name === name);
    if (localIdx < 0) throw new Error(`linear-ir: runtime helper '${name}' missing`);
    return ctx.numImportFuncs + localIdx;
  };

  const resolveImportFunc = (module: string, field: string): number =>
    resolveLinearImportFunc(ctx, module, field, resolveRuntimeFunc);

  const bindUnitFunc = (slot: LinearIrLegacySlotAdapter): void => {
    const previous = unitFuncSlotById.get(slot.ownerUnitId);
    if (
      previous !== undefined &&
      (previous.funcIdx !== slot.funcIdx ||
        previous.legacyName !== slot.legacyName ||
        previous.slotName !== slot.slotName)
    ) {
      throw new Error(`linear-ir: source unit '${slot.ownerUnitId}' was bound to multiple function slots`);
    }
    unitFuncSlotById.set(slot.ownerUnitId, slot);
  };

  const ensureAggregateHelper = (
    layout: LinearRecordLayoutPlan,
    allocate: LinearRuntimeOperation,
    fields: readonly { readonly name: string; readonly type: ValType; readonly offset: number }[],
  ): number => {
    const key = `${layout.id}:${linearRuntimeOperationKey(allocate)}`;
    const cached = helperByShape.get(key);
    if (cached !== undefined) return cached;

    const funcIdx = helperStartFuncIdx + helpers.length;
    const name = `__linear_ir_aggregate_new_${helpers.length}`;
    const typeIdx = internLinearFuncType(ctx, {
      kind: "func",
      params: fields.map((field) => field.type),
      results: [{ kind: "i32" }],
    });
    helpers.push({ funcIdx, name, typeIdx, fields, layout, allocate });
    helperByShape.set(key, funcIdx);
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };

  const allocationFor = (layoutId: string, alloc?: AllocSiteId): LinearAllocationSitePlan | undefined => {
    const plan = memoryPlan;
    if (!plan) return undefined;
    if (alloc !== undefined) {
      const allocation = plan.allocation(alloc);
      if (!allocation) throw new Error(`linear-ir: allocation site ${alloc as number} is absent from the plan`);
      if (allocation.layoutId !== layoutId) {
        throw new Error(
          `linear-ir: allocation site ${alloc as number} planned '${allocation.layoutId}', expected '${layoutId}'`,
        );
      }
      return allocation;
    }
    return plan.allocationsForLayout(layoutId)[0];
  };

  const plannedOperation = (
    layout: Parameters<typeof defaultOperationsForLayout>[0],
    allocation: LinearAllocationSitePlan | undefined,
    predicate: (operation: LinearRuntimeOperation) => boolean,
    label: string,
  ): LinearRuntimeOperation => {
    const operation = (allocation?.operations ?? defaultOperationsForLayout(layout)).find(predicate);
    if (!operation) throw new Error(`linear-ir: plan has no ${label} operation for '${layout.id}'`);
    return operation;
  };

  const linearFieldType = (storage: LinearStorageKind): ValType | null => {
    if (storage === "f64") return { kind: "f64" };
    if (storage === "i32" || storage === "pointer") return { kind: "i32" };
    return null;
  };

  const f64VecHandle = (alloc?: AllocSiteId): IrVecLowering & LinearVecLowering => {
    const layout = memoryPlan?.layoutForVector(f64IrType) ?? provisionalF64VectorLayout;
    const allocation = allocationFor(layout.id, alloc);
    const allocate = plannedOperation(
      layout,
      allocation,
      (operation) => operation.family === "vector" && operation.operation === "allocate",
      "vector allocation",
    );
    const initializeElement = plannedOperation(
      layout,
      allocation,
      (operation) => operation.family === "vector" && operation.operation === "initialize-element",
      "vector element initialization",
    );
    return {
      valueType: { kind: "i32" },
      vecStructTypeIdx: 0,
      lengthFieldIdx: 0,
      dataFieldIdx: 0,
      arrayTypeIdx: 0,
      elementValType: { kind: "f64" },
      linearMemory: { allocation, layout, allocate, initializeElement },
    };
  };

  const resolver: IrLowerResolver & IrFromAstResolver = {
    resolveFunc(ref: IrFuncRef): number {
      switch (ref.binding.kind) {
        case "unit": {
          const slot = unitFuncSlotById.get(ref.binding.unitId);
          if (slot === undefined) {
            throw new Error(`linear-ir: no function slot for source unit '${ref.binding.unitId}' (${ref.name})`);
          }
          return slot.funcIdx;
        }
        case "import":
          return resolveImportFunc(ref.binding.module, ref.binding.field);
        case "runtime":
          return resolveRuntimeFunc(ref.binding.symbol);
        case "intrinsic": {
          const symbol = ref.binding.symbol;
          // #2956 L3: resolve from-ast's abstract choices onto canonical linear runtimes.
          if (symbol === IR_STRING_COMPARE_FN) return resolveRuntimeFunc("__str_cmp");
          if (
            symbol === LINEAR_IR_STRING_CHAR_AT_FN ||
            symbol === LINEAR_IR_STRING_CHAR_CODE_AT_FN ||
            symbol === LINEAR_IR_STRING_APPEND_ASCII_FN ||
            symbol === "__str_slice" ||
            symbol === "__arr_get" ||
            symbol === "__arr_len" ||
            symbol === FMOD_EARLY_MAGNITUDE_FN ||
            symbol === FMOD_FN
          ) {
            return resolveRuntimeFunc(symbol === FMOD_EARLY_MAGNITUDE_FN ? FMOD_FN : symbol);
          }
          // (#2956 L2) Vec mutation is an abstract element-store request. On
          // linear it maps to the canonical grow-on-OOB array runtime.
          if (symbol.startsWith(IR_VEC_ELEM_SET_PREFIX) || symbol.startsWith("__vec_elem_set_")) {
            return resolveRuntimeFunc("__arr_set");
          }
          throw new Error(`linear-ir: unsupported intrinsic '${symbol}' (${ref.name})`);
        }
        case "support":
          throw new Error(`linear-ir: support binding '${ref.binding.bindingId}' is outside the claimed scope`);
      }
    },
    resolveGlobal(ref: IrGlobalRef): number {
      throw new Error(
        `linear-ir: symbolic global binding '${ref.binding.bindingId}' is outside the claimed scope (${ref.name})`,
      );
    },
    resolveType(ref: IrTypeRef): number {
      // Landed linear shapes resolve through their dedicated handles; symbolic
      // module type refs remain outside the claimed surface.
      throw new Error(
        `linear-ir: symbolic type binding '${ref.binding.bindingId}' is outside the claimed scope (${ref.name})`,
      );
    },
    internFuncType(def: FuncTypeDef): number {
      return internLinearFuncType(ctx, def);
    },
    // #2956 L3: every linear string is the direct backend's canonical i32
    // arena pointer. The four string.* ops route through the same runtime
    // helpers/data-segment registry as direct AST codegen.
    resolveString(): ValType {
      return { kind: "i32" };
    },
    stringIsExternref(): boolean {
      return false;
    },
    hasHostNumberBox(): boolean {
      return false;
    },
    hasHostBooleanBox(): boolean {
      return false;
    },
    hasHostNumberToString(): boolean {
      return ctx.mod.functions.some((func) => func.name === "number_toString");
    },
    stringMethodPlan(method: string) {
      if (method === "charCodeAt") {
        return {
          funcName: LINEAR_IR_STRING_CHAR_CODE_AT_FN,
          indexArgRep: "i32" as const,
          padOmitted: "charcode-zero" as const,
        };
      }
      if (method === "slice") {
        return {
          funcName: "__str_slice",
          indexArgRep: "i32" as const,
          padOmitted: "native-slice-len" as const,
        };
      }
      return null;
    },
    emitStringConst(value: string, alloc?: AllocSiteId): readonly Instr[] {
      const plan = memoryPlan;
      const layout = plan?.layouts.find((candidate) => candidate.kind === "string") ?? planLinearStringLayout();
      if (layout.kind !== "string") throw new Error("linear-ir: invalid string layout");
      const allocation = allocationFor(layout.id, alloc);
      const operation = plannedOperation(
        layout,
        allocation,
        (candidate) => candidate.family === "string" && candidate.operation === "materialize-data",
        "string materialization",
      );
      if (!plan || !allocation?.dataSegmentId) {
        throw new Error("linear-ir: string literal is absent from the completed memory plan");
      }
      bindLinearStringRuntime(plan, { intrinsic: "constant", alloc });
      const segment = plan.requireDataSegment(allocation.dataSegmentId);
      return linearStringLiteralInstrs(ctx, value, resolveLinearRuntimeOperation(ctx, operation), segment.bytes);
    },
    emitStringConcat(alloc?: AllocSiteId, mode: IrStringConcatMode = "immutable"): readonly Instr[] {
      const layout = memoryPlan?.layouts.find((candidate) => candidate.kind === "string") ?? planLinearStringLayout();
      if (layout.kind !== "string") throw new Error("linear-ir: invalid string layout");
      const allocation = allocationFor(layout.id, alloc);
      const operation = plannedOperation(
        layout,
        allocation,
        (candidate) => candidate.family === "string" && candidate.operation === "concatenate",
        "string concatenation",
      );
      if (!memoryPlan) throw new Error("linear-ir: string concatenation has no completed memory plan");
      bindLinearStringRuntime(memoryPlan, { intrinsic: "concat", alloc });
      if (mode === "owned-append") {
        return [{ op: "call", funcIdx: resolveRuntimeFunc(LINEAR_IR_STRING_APPEND_ASCII_FN) }];
      }
      return [{ op: "call", funcIdx: resolveLinearRuntimeOperation(ctx, operation) }];
    },
    emitStringEquals(): readonly Instr[] {
      return [{ op: "call", funcIdx: resolveRuntimeFunc("__str_eq") }];
    },
    emitStringLen(inputEncoding?: IrStringEncoding): readonly Instr[] {
      if (!memoryPlan) throw new Error("linear-ir: string length has no completed memory plan");
      bindLinearStringRuntime(memoryPlan, { intrinsic: "length", inputEncoding });
      return [{ op: "call", funcIdx: resolveRuntimeFunc("__str_length_utf16") }];
    },
    emitStringCharAt(alloc?: AllocSiteId, inputEncoding?: IrStringEncoding): readonly Instr[] {
      if (!memoryPlan) throw new Error("linear-ir: string charAt has no completed memory plan");
      bindLinearStringRuntime(memoryPlan, { intrinsic: "char-at", alloc, inputEncoding });
      return [{ op: "call", funcIdx: resolveRuntimeFunc(LINEAR_IR_STRING_CHAR_AT_FN) }];
    },
    emitStringCharCodeAt(inputEncoding?: IrStringEncoding): readonly Instr[] {
      if (!memoryPlan) throw new Error("linear-ir: string charCodeAt has no completed memory plan");
      bindLinearStringRuntime(memoryPlan, { intrinsic: "char-code-at", inputEncoding });
      return [{ op: "call", funcIdx: resolveRuntimeFunc(LINEAR_IR_STRING_CHAR_CODE_AT_FN) }];
    },
    resolveObject(shape: IrObjectShape, alloc?: AllocSiteId): LinearObjectLowering | null {
      const layout = memoryPlan?.layoutForObjectShape(shape);
      if (!layout) throw new Error("linear-ir: object layout is absent from the completed memory plan");
      const allocation = allocationFor(layout.id, alloc);
      const allocate = plannedOperation(
        layout,
        allocation,
        (operation) => operation.family === "memory" && operation.operation === "allocate",
        "record allocation",
      );
      const key = `${layout.id}:${linearRuntimeOperationKey(allocate)}`;
      const cached = objects.get(key);
      if (cached) return cached;

      const fields = shape.fields.map((field, fieldIdx) => {
        const memory = layout.fields.find((candidate) => candidate.name === field.name);
        if (!memory) throw new Error(`linear-ir: object layout has no field '${field.name}'`);
        const type = linearFieldType(memory.storage);
        if (!type)
          throw new Error(`linear-ir: object field '${field.name}' has unsupported '${memory.storage}' storage`);
        return {
          name: field.name,
          fieldIdx,
          offset: memory.offset,
          type,
        };
      });
      const newFuncIdx = ensureAggregateHelper(layout, allocate, fields);
      const byName = new Map(fields.map((field) => [field.name, field]));
      const lowering: LinearObjectLowering = {
        typeIdx: 0,
        fieldIdx(name: string): number {
          const field = byName.get(name);
          if (!field) throw new Error(`linear-ir: object shape has no field '${name}'`);
          return field.fieldIdx;
        },
        linearMemory: {
          allocation,
          layout,
          allocate,
          newFuncIdx,
          fieldCount: fields.length,
          field(name: string): LinearMemoryFieldLowering {
            const field = byName.get(name);
            if (!field) throw new Error(`linear-ir: object shape has no field '${name}'`);
            return field;
          },
        },
      };
      objects.set(key, lowering);
      return lowering;
    },
    resolveRefCell(inner: ValType, alloc?: AllocSiteId): IrRefCellLowering | null {
      if (inner.kind !== "i32" && inner.kind !== "f64") return null;
      const layout = memoryPlan?.layoutForRefCell(irVal(inner));
      if (!layout) throw new Error("linear-ir: ref-cell layout is absent from the completed memory plan");
      const allocation = allocationFor(layout.id, alloc);
      const allocate = plannedOperation(
        layout,
        allocation,
        (operation) => operation.family === "memory" && operation.operation === "allocate",
        "ref-cell allocation",
      );
      const key = `${layout.id}:${linearRuntimeOperationKey(allocate)}`;
      const cached = refCells.get(key);
      if (cached) return cached;
      const value = layout.fields.find((field) => field.name === "value");
      if (!value) throw new Error("linear-ir: ref-cell layout has no value field");
      const memoryValue: LinearMemoryFieldLowering = { offset: value.offset, type: inner };
      const newFuncIdx = ensureAggregateHelper(layout, allocate, [
        { name: "value", type: inner, offset: value.offset },
      ]);
      const lowering: LinearRefCellLowering = {
        typeIdx: 0,
        fieldIdx: 0,
        linearMemory: { layout, allocate, newFuncIdx, value: memoryValue },
      };
      refCells.set(key, lowering);
      return lowering;
    },
    resolveVec(valType: ValType): IrVecLowering | null {
      return valType.kind === "i32" ? f64VecHandle() : null;
    },
    resolveVecForElement(elementValType: ValType, alloc?: AllocSiteId): IrVecLowering | null {
      return elementValType.kind === "f64" ? f64VecHandle(alloc) : null;
    },
    resolveVecValueTypeForElement(elementValType: ValType): ValType | null {
      return elementValType.kind === "f64" ? { kind: "i32" } : null;
    },
    resolveVecOutOfBoundsConst(elementValType: ValType) {
      return elementValType.kind === "f64" ? { kind: "f64" as const, value: 0 } : null;
    },
    isVecValueExpression(expr: ts.Expression): boolean {
      try {
        const type = ctx.checker.getNonNullableType(ctx.checker.getTypeAtLocation(expr));
        if (!ctx.checker.isArrayType(type)) return false;
        const [element] = ctx.checker.getTypeArguments(type as ts.TypeReference);
        return element !== undefined && (element.flags & ts.TypeFlags.NumberLike) !== 0;
      } catch {
        return false;
      }
    },
  };

  return {
    resolver,
    helpers,
    bindUnitFunc,
    bindMemoryPlan(plan: LinearMemoryPlan): void {
      if (memoryPlan) throw new Error("linear-ir: memory plan already bound");
      memoryPlan = plan;
    },
  };
}

/** Bind a symbolic plan operation to the existing linear runtime adapter. */
function resolveLinearRuntimeOperation(ctx: LinearContext, operation: LinearRuntimeOperation): number {
  let name: string | undefined;
  if (operation.family === "memory" && operation.operation === "allocate" && operation.allocationClass === "arena") {
    name = "__malloc";
  } else if (
    operation.family === "memory" &&
    operation.operation === "allocate" &&
    operation.allocationClass === "stack"
  ) {
    name = "__linear_stack_alloc";
  } else if (
    operation.family === "vector" &&
    operation.operation === "allocate" &&
    operation.allocationClass === "arena" &&
    operation.elementStorage === "f64"
  ) {
    name = "__arr_new";
  } else if (
    operation.family === "vector" &&
    operation.operation === "initialize-element" &&
    operation.allocationClass === "arena" &&
    operation.elementStorage === "f64"
  ) {
    name = LINEAR_IR_VEC_INIT_F64_FN;
  } else if (
    operation.family === "string" &&
    operation.operation === "materialize-data" &&
    operation.allocationClass === "arena" &&
    operation.elementStorage === "i8"
  ) {
    name = "__str_from_data";
  } else if (
    operation.family === "string" &&
    operation.operation === "concatenate" &&
    operation.allocationClass === "arena" &&
    operation.elementStorage === "i8"
  ) {
    name = "__str_concat";
  } else if (operation.family === "stack" && operation.operation === "mark") {
    name = "__linear_stack_mark";
  } else if (operation.family === "stack" && operation.operation === "restore") {
    name = "__linear_stack_restore";
  }
  if (!name) throw new Error(`linear-ir: no runtime binding for '${linearRuntimeOperationKey(operation)}'`);
  const localIdx = ctx.mod.functions.findIndex((func) => func.name === name);
  if (localIdx < 0) throw new Error(`linear-ir: runtime helper '${name}' missing`);
  return ctx.numImportFuncs + localIdx;
}

function stackFrameOperations(
  plan: LinearMemoryPlan,
  ownerFunction: string,
): { readonly mark: LinearRuntimeOperation; readonly restore: LinearRuntimeOperation } | null {
  const allocation = plan.allocations.find(
    (candidate) => candidate.ownerFunction === ownerFunction && candidate.allocationClass === "stack",
  );
  if (!allocation) return null;
  const mark = allocation.operations.find(
    (operation) => operation.family === "stack" && operation.operation === "mark",
  );
  const restore = allocation.operations.find(
    (operation) => operation.family === "stack" && operation.operation === "restore",
  );
  if (!mark || !restore) throw new Error(`linear-ir: stack allocation in '${ownerFunction}' lacks frame operations`);
  return { mark, restore };
}

function instrumentLinearStackFrame(
  body: Instr[],
  markLocal: number,
  markFuncIdx: number,
  restoreFuncIdx: number,
): void {
  const restore: Instr[] = [
    { op: "local.get", index: markLocal },
    { op: "call", funcIdx: restoreFuncIdx },
  ];
  const visit = (instrs: Instr[]): void => {
    for (let index = instrs.length - 1; index >= 0; index--) {
      const instr = instrs[index]!;
      if (instr.op === "return") {
        instrs.splice(index, 0, ...restore.map((item) => ({ ...item })));
      } else if (instr.op === "block" || instr.op === "loop") {
        visit(instr.body);
      } else if (instr.op === "if") {
        visit(instr.then);
        if (instr.else) visit(instr.else);
      } else if (instr.op === "try") {
        visit(instr.body);
        for (const clause of instr.catches) visit(clause.body);
        if (instr.catchAll) visit(instr.catchAll);
      }
    }
  };
  visit(body);
  body.unshift({ op: "call", funcIdx: markFuncIdx }, { op: "local.set", index: markLocal });
}

/** Materialize a deferred constructor after every user function slot exists. */
export function materializeLinearIrHelper(ctx: LinearContext, helper: LinearIrHelper): WasmFunction {
  if (helper.layout.size.kind !== "constant") {
    throw new Error(`linear-ir: aggregate helper '${helper.name}' requires a constant-size record`);
  }
  const totalSize = helper.layout.size.bytes;
  const pointerLocal = helper.fields.length;
  const body: Instr[] = [
    { op: "i32.const", value: totalSize },
    { op: "call", funcIdx: resolveLinearRuntimeOperation(ctx, helper.allocate) },
    { op: "local.tee", index: pointerLocal },
    { op: "i32.const", value: LINEAR_GENERIC_OBJECT_TAG },
    { op: "i32.store8", align: 0, offset: helper.layout.typeTagOffset },
    { op: "local.get", index: pointerLocal },
    { op: "i32.const", value: totalSize - helper.layout.headerBytes },
    { op: "i32.store", align: 2, offset: helper.layout.payloadSizeOffset },
  ];
  helper.fields.forEach((field, paramIndex) => {
    body.push({ op: "local.get", index: pointerLocal }, { op: "local.get", index: paramIndex });
    if (field.type.kind === "i32") {
      body.push({ op: "i32.store", align: 2, offset: field.offset });
    } else if (field.type.kind === "f64") {
      body.push({ op: "f64.store", align: 3, offset: field.offset });
    } else {
      throw new Error(`linear-ir: aggregate helper cannot store '${field.type.kind}' field '${field.name}'`);
    }
  });
  body.push({ op: "local.get", index: pointerLocal });
  return {
    name: helper.name,
    typeIdx: helper.typeIdx,
    locals: [{ name: "$aggregate_ptr", type: { kind: "i32" } }],
    body,
    exported: false,
  };
}

function internLinearFuncType(ctx: LinearContext, def: FuncTypeDef): number {
  const sameValType = (a: ValType, b: ValType): boolean =>
    a.kind === b.kind && (a as { typeIdx?: number }).typeIdx === (b as { typeIdx?: number }).typeIdx;
  for (let i = 0; i < ctx.mod.types.length; i++) {
    const type = ctx.mod.types[i]!;
    if (type.kind !== "func") continue;
    if (type.params.length !== def.params.length || type.results.length !== def.results.length) continue;
    if (
      type.params.every((param, index) => sameValType(param, def.params[index]!)) &&
      type.results.every((result, index) => sameValType(result, def.results[index]!))
    ) {
      return i;
    }
  }
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push(def);
  return typeIdx;
}

function linearValueTypeConverter(resolver: IrLowerResolver, funcName: string): TypeConverter<ValType> {
  return {
    backend: "linear",
    convertType(type: IrType): readonly ValType[] {
      if (type.kind === "val") return [type.val];
      if (type.kind === "string" || type.kind === "vec") return [{ kind: "i32" }];
      if (type.kind === "object" && resolver.resolveObject?.(type.shape)) return [{ kind: "i32" }];
      if (type.kind === "boxed") {
        const inner = asVal(type.inner);
        if (inner && resolver.resolveRefCell?.(inner)) return [{ kind: "i32" }];
      }
      throw new Error(`linear-ir: cannot carry IR type '${type.kind}' in ${funcName}`);
    },
  };
}
