// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { preparedIrProgramCallableResults } from "./program-callable-contract.js";
import type { TypedIrProgramInput } from "./program/input-contracts.js";
import type { TypeOracle } from "../checker/oracle.js";
import { AllocSiteRegistry } from "./analysis/alloc-registry.js";
import { irSourceGlobalRef } from "./abi-bindings.js";
import { irUnitFuncRef, irUnitCallableBindingId } from "./callable-bindings.js";
import { lowerFunctionAstToIr, typeNodeToIr, type IrFromAstResolver } from "./from-ast.js";
import { buildIrUnitInventory, type BuildIrUnitInventoryOptions } from "./identity.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../shared/contracts/ir-unit-inventory.js";
import { buildIrPlanningIdentityContext, requireIrPlanningOwnerUnitId } from "./planning-identity.js";
import { buildIrProgramCallableBindingGraph } from "./program-callable-bindings.js";
import type { IrProgramCallableBindingRecord } from "./program/callable-bindings.js";
import { buildIrUnitTypeMap, lowerTypeToIrType } from "./propagate.js";
import { buildIrModuleInitPlan } from "./module-init-plan.js";
import type { IrModuleInitPlan } from "./program/startup.js";
import { makeModuleInitSynthetic } from "./module-init.js";
import { makeIrIdentityModuleBindingResolver, type IrModuleBindingIdentity } from "./module-bindings.js";
import type { IrDirectCallLoweringPlan, ModuleBindingGlobal } from "./ast-lowering-plans.js";
import type { PreparedIrFunction as IrFunction, PreparedIrModule as IrModule } from "./runtime/contracts/prepared.js";
import type { IrType } from "./core/types.js";
import { classifyIrFailure, IrUnsupportedError } from "./outcomes.js";
import type { ProgramAbiDerivedUnitRecord } from "./program/abi.js";
import { preparedIrProgramOwner } from "./program.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import type { PreparedIrProgramFailure } from "./program/prepared-contracts.js";
import type { RuntimeManifestPolicy } from "../runtime/contracts/provider-policy.js";
import { unwrapPromiseTypeNode } from "./async-static.js";
import { postStartupCallableUnits } from "./program-startup-proof.js";
import { makeIrIdentityImportedFunctionResolver } from "./imported-functions.js";
import { makeIrPromiseDelayResolver } from "./promise-delay.js";
import { prepareNativeAsyncSourceFamilies, type NativeAsyncSourceFamilies } from "./program-native-async-source.js";
import {
  collectIrPromiseDelayOwners,
  buildIrPromiseDelayLoweringPlans,
  validateNativePromiseDelaySupportByIdentity,
  type IrPromiseDelayLoweringPlan,
  type IrPromiseDelayLoweringPlans,
} from "./promise-delay-lowering.js";

export interface IrProgramSourceInput {
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly entrySource: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly oracle?: TypeOracle;
  readonly inventoryOptions?: BuildIrUnitInventoryOptions;
  readonly policy: RuntimeManifestPolicy;
  readonly deferTopLevelInit: boolean;
  /**
   * Explicit frontend lowering selection; not provider availability or
   * permission to emit. Omission preserves historical source lowering.
   */
  readonly promiseDelayProjection?: "disabled" | "standalone-native";
  /** Explicit full-family logical lowering; never inferred from target or fast/default settings. */
  readonly asyncFamilyProjection?: "disabled" | "standalone-native";
}

/** Frontend-only carrier; declarations never cross into PreparedIrProgram. */
export interface IrProgramSourcePreparation {
  readonly kind: "prepared";
  readonly inventory: IrUnitInventory;
  readonly ir: IrModule;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly startup: readonly IrModuleInitPlan[];
  readonly callables: readonly IrProgramCallableBindingRecord[];
  readonly globals: readonly { readonly binding: ModuleBindingGlobal; readonly identity: IrModuleBindingIdentity }[];
  readonly allocations: AllocSiteRegistry;
}

/** Read only an explicitly selected own data field; never evaluate a getter. */
function sourceDataField<T extends object, K extends keyof T>(object: T, key: K): T[K] {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor))
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `source capture requires own data field ${String(key)}`,
    );
  return descriptor.value;
}

/** Explicit frontend projection; capture all semantic fields jointly with allocations. */
export function captureTypedIrProgramInput(source: IrProgramSourcePreparation): TypedIrProgramInput {
  const allocations = sourceDataField(source, "allocations");
  const inventory = sourceDataField(source, "inventory");
  const ir = sourceDataField(source, "ir");
  const derivedUnits = sourceDataField(source, "derivedUnits");
  const startup = sourceDataField(source, "startup");
  const callables = sourceDataField(source, "callables");
  const sourceGlobals = sourceDataField(source, "globals");
  if (!Array.isArray(sourceGlobals) || Object.getPrototypeOf(sourceGlobals) !== Array.prototype)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "source capture requires an ordinary globals array",
    );
  const length = sourceDataField(sourceGlobals, "length");
  for (const key of Reflect.ownKeys(sourceGlobals)) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "source capture cannot omit extra globals array properties",
      );
  }
  const globals: TypedIrProgramInput["globals"][number][] = [];
  for (let index = 0; index < length; index++) {
    const entry = sourceDataField(sourceGlobals, index);
    const binding = sourceDataField(entry, "binding");
    const identity = sourceDataField(entry, "identity");
    globals.push({
      binding: {
        globalRef: sourceDataField(binding, "globalRef"),
        tdzGlobalRef: sourceDataField(binding, "tdzGlobalRef"),
        type: sourceDataField(binding, "type"),
      },
      identity: {
        sourceId: sourceDataField(identity, "sourceId"),
        storageOwnerUnitId: sourceDataField(identity, "storageOwnerUnitId"),
      },
    });
  }
  const captured = allocations.capturePreparationData({ inventory, ir, derivedUnits, startup, callables, globals });
  return {
    inventory: captured.data.inventory,
    ir: captured.data.ir,
    derivedUnits: captured.data.derivedUnits,
    startup: captured.data.startup,
    callables: captured.data.callables,
    globals: captured.data.globals,
    allocations: captured.allocations,
  };
}

function unsupported(detail: string): never {
  throw new IrUnsupportedError("type-resolution-unsupported", "build", detail);
}

function checkerScalar(checker: ts.TypeChecker, node: ts.Node): IrType | undefined {
  const type = checker.getTypeAtLocation(node);
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return { kind: "val", val: { kind: "f64" } };
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { kind: "val", val: { kind: "i32", boolean: true } };
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { kind: "string" };
  return undefined;
}

function storageType(identity: IrModuleBindingIdentity): IrType {
  const value = identity.valueKind;
  switch (value.kind) {
    case "f64":
      return { kind: "val", val: { kind: "f64" } };
    case "i32":
      return { kind: "val", val: { kind: "i32", boolean: true } };
    case "string":
      return { kind: "string" };
    case "dynamic":
      return { kind: "dynamic" };
    default:
      return unsupported(`whole-program source storage has no typed carrier for ${value.kind}`);
  }
}

/** Validate the explicit source request before inventory construction or source planning. */
function selectNativePromiseDelaySourceProjection(
  input: Pick<IrProgramSourceInput, "promiseDelayProjection" | "policy">,
): boolean {
  const projection = input.promiseDelayProjection;
  const nativeDelay = projection === "standalone-native";
  if (
    (projection !== undefined && projection !== "disabled" && !nativeDelay) ||
    (nativeDelay && (input.policy.backend !== "wasmgc" || input.policy.target !== "standalone"))
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "Promise-delay source projection requires an explicit standalone-native request with wasmgc:standalone policy",
    );
  return nativeDelay;
}

/** Validate full-family selection independently from delay selection and runtime availability. */
function selectNativeAsyncFamilyProjection(input: IrProgramSourceInput): boolean {
  const projection = input.asyncFamilyProjection;
  if (projection === undefined || projection === "disabled") return false;
  if (
    projection !== "standalone-native" ||
    input.promiseDelayProjection !== "standalone-native" ||
    input.policy.backend !== "wasmgc" ||
    input.policy.target !== "standalone"
  )
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native async family source projection requires explicit native delay and wasmgc:standalone policy",
    );
  return true;
}

/** Mutable diagnostic cursor shared by source planning and its validation helpers. */
interface SourceDiagnosticOwner {
  active: IrUnitId | undefined;
}

/** Frontend-only certificates and independent pre-lowering identity receipts. */
interface NativePromiseDelaySourcePlans {
  readonly promiseDelaysBySource: Map<ts.SourceFile, IrPromiseDelayLoweringPlans>;
  readonly promiseDelayPopulations: Map<
    ts.SourceFile,
    {
      readonly maps: IrPromiseDelayLoweringPlans;
      readonly constructions: readonly (readonly [ts.NewExpression, IrPromiseDelayLoweringPlan])[];
      readonly timers: readonly (readonly [ts.CallExpression, IrPromiseDelayLoweringPlan])[];
      readonly resolves: readonly (readonly [ts.CallExpression, IrPromiseDelayLoweringPlan])[];
      readonly support: ReturnType<typeof validateNativePromiseDelaySupportByIdentity>;
    }
  >;
  readonly certifiedDelays: Map<IrUnitId, IrPromiseDelayLoweringPlan>;
  readonly supportReceipts: Map<IrUnitId, readonly (readonly [string, unknown])[]>;
}

/** Certify exact native-delay owners and retain their original maps and support population. */
function prepareNativePromiseDelaySourcePlans(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  inventory: IrUnitInventory,
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  delayPlans: NativePromiseDelaySourcePlans,
  diagnostic: SourceDiagnosticOwner,
): void {
  const { promiseDelaysBySource, promiseDelayPopulations, certifiedDelays, supportReceipts } = delayPlans;
  const delayResolver = makeIrPromiseDelayResolver(checker);
  for (const sourceFile of sourceFiles) {
    const sourceId = identity.sourceIdBySourceFile.get(sourceFile)!;
    const selected = new Set(
      inventory.terminalUnits
        .filter((unit) => {
          const declaration = identity.declarationByUnitId.get(unit.id);
          return (
            unit.sourceId === sourceId &&
            unit.kind !== "module-init" &&
            declaration !== undefined &&
            ts.isFunctionDeclaration(declaration) &&
            declaration.parent === sourceFile &&
            declaration.body !== undefined
          );
        })
        .map((unit) => unit.id),
    );
    diagnostic.active = selected.values().next().value ?? identity.moduleInitUnitIdBySourceFile.get(sourceFile);
    const owners = collectIrPromiseDelayOwners(sourceFile, selected, delayResolver, identity);
    const plans = buildIrPromiseDelayLoweringPlans(owners, selected, identity, "standalone-native");
    const support = validateNativePromiseDelaySupportByIdentity(sourceFile, identity, plans);
    promiseDelaysBySource.set(sourceFile, plans);
    // Snapshot the admitted population independently of the mutable maps
    // passed to lowering. Revalidating emptied maps alone proves nothing.
    promiseDelayPopulations.set(sourceFile, {
      maps: { constructions: plans.constructions, timers: plans.timers, resolves: plans.resolves },
      constructions: [...plans.constructions],
      timers: [...plans.timers],
      resolves: [...plans.resolves],
      support: [...support],
    });
    for (const plan of plans.constructions.values()) certifiedDelays.set(plan.ownerUnitId, plan);
    for (const unit of support) supportReceipts.set(unit.id, Object.entries(unit));
  }
}

/** Revalidate certificates after lowering, then reject semantic references to elided support. */
function validateNativePromiseDelaySourceLowering(
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  delayPlans: NativePromiseDelaySourcePlans,
  lowered: Omit<IrProgramSourcePreparation, "kind" | "inventory" | "ir"> & {
    readonly functions: readonly IrFunction[];
  },
  diagnostic: SourceDiagnosticOwner,
): void {
  const { promiseDelaysBySource, promiseDelayPopulations, certifiedDelays, supportReceipts } = delayPlans;
  const { functions, derivedUnits, callables, startup, globals, allocations } = lowered;
  for (const [source, plans] of promiseDelaysBySource) {
    const saved = promiseDelayPopulations.get(source)!;
    const requireRetainedPlans = <TNode extends ts.Node>(
      current: ReadonlyMap<TNode, IrPromiseDelayLoweringPlan>,
      original: ReadonlyMap<TNode, IrPromiseDelayLoweringPlan>,
      entries: readonly (readonly [TNode, IrPromiseDelayLoweringPlan])[],
    ): void => {
      diagnostic.active = entries[0]?.[1].ownerUnitId ?? identity.moduleInitUnitIdBySourceFile.get(source);
      if (current !== original || current.size !== entries.length)
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          "certified Promise-delay plan population changed during lowering",
        );
      for (const [key, plan] of entries) {
        diagnostic.active = plan.ownerUnitId;
        if (current.get(key) !== plan)
          throw new PreparedIrProgramInvariantError(
            "invalid-prepared-data",
            "certified Promise-delay plan identity changed during lowering",
          );
      }
    };
    requireRetainedPlans(plans.constructions, saved.maps.constructions, saved.constructions);
    requireRetainedPlans(plans.timers, saved.maps.timers, saved.timers);
    requireRetainedPlans(plans.resolves, saved.maps.resolves, saved.resolves);
    const retainedSupport = validateNativePromiseDelaySupportByIdentity(source, identity, plans);
    if (
      retainedSupport.length !== saved.support.length ||
      retainedSupport.some((unit, index) => unit !== saved.support[index])
    )
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "certified Promise-delay support population changed during lowering",
      );
    for (const unit of retainedSupport) {
      diagnostic.active = unit.terminalOwnerId;
      const before = supportReceipts.get(unit.id);
      const after = Object.entries(unit);
      if (
        !before ||
        before.length !== after.length ||
        before.some(([key, value], index) => after[index]?.[0] !== key || after[index]?.[1] !== value)
      )
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          `native Promise-delay support ${unit.id} changed during lowering`,
        );
    }
  }
  const forbidden = new Set<string>(supportReceipts.keys());
  for (const plan of certifiedDelays.values()) {
    for (const target of [plan.executorTarget, plan.timerTarget]) {
      if (target.binding.kind === "unit") forbidden.add(target.binding.unitId);
    }
  }
  // Walk the complete graph (including nested/provider references), but only
  // interpret structural unit bindings and explicit ownership/provenance
  // positions as references. String constants and diagnostic names are data.
  const seen = new Set<object>();
  const reference = (value: unknown): void => {
    if (typeof value === "string" && forbidden.has(value))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `native Promise-delay retains a reference to elided support ${value}`,
      );
  };
  const inspect = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const fields = Object.getOwnPropertyDescriptors(value);
    const children: unknown[] = [];
    for (const key of Reflect.ownKeys(fields)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor))
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          "native Promise-delay semantic graph contains an accessor",
        );
      children.push(descriptor.value);
    }
    if (fields.kind?.value === "unit") reference(fields.unitId?.value);
    if (fields.kind?.value === "async-function") reference(fields.ownerUnitId?.value);
    if (fields.kind?.value === "fnctor-shape") {
      reference(fields.constructorUnitId?.value);
      const constructorIdentity = fields.constructorIdentity?.value;
      if (constructorIdentity !== null && typeof constructorIdentity === "object")
        reference(Object.getOwnPropertyDescriptor(constructorIdentity, "unitId")?.value);
    }
    // IrClassMethodDescriptor.placement and IrDomCallbackAuthority are
    // typed ownership records, unlike the surrounding compatibility names.
    for (const [key, ownerKey] of [
      ["placement", "unitId"],
      ["domCallbackAuthority", "ownerUnitId"],
    ] as const) {
      const record = fields[key]?.value;
      if (record !== null && typeof record === "object")
        reference(Object.getOwnPropertyDescriptor(record, ownerKey)?.value);
    }
    if (value instanceof Map)
      for (const [key, item] of value) {
        inspect(key);
        inspect(item);
      }
    if (value instanceof Set) for (const item of value) inspect(item);
    for (const child of children) inspect(child);
  };
  for (const fn of functions) {
    diagnostic.active = fn.unitId;
    reference(fn.unitId);
    inspect(fn);
  }
  for (const unit of derivedUnits) {
    diagnostic.active = unit.terminalOwnerId ?? undefined;
    reference(unit.id);
    reference(unit.parentId);
    reference(unit.terminalOwnerId);
    if (certifiedDelays.has(unit.parentId))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `certified native Promise-delay ${unit.parentId} fabricated support provenance`,
      );
    inspect(unit);
  }
  for (const binding of callables) {
    diagnostic.active = binding.targetUnitId;
    reference(binding.targetUnitId);
  }
  for (const plan of startup) {
    diagnostic.active = plan.unitId ?? undefined;
    reference(plan.unitId);
    for (const seed of plan.liveSeeds) reference(seed.unitId);
  }
  for (const global of globals) {
    diagnostic.active = global.identity.storageOwnerUnitId;
    reference(global.identity.ownerUnitId);
    reference(global.identity.storageOwnerUnitId);
    reference(global.binding.ownerUnitId);
    inspect(global.binding);
  }
  diagnostic.active ??= certifiedDelays.keys().next().value;
  inspect(allocations.snapshot());
}

/** Keep callable carriers separate from semantic fulfillment signatures. */
function prepareSourceFunctionSignatures(
  checker: ts.TypeChecker,
  inventory: IrUnitInventory,
  identity: ReturnType<typeof buildIrPlanningIdentityContext>,
  types: ReturnType<typeof buildIrUnitTypeMap>,
  certifiedDelays: NativePromiseDelaySourcePlans["certifiedDelays"],
  nativeFamily: NativeAsyncSourceFamilies | undefined,
  signatures: Map<IrUnitId, { params: readonly IrType[]; returnType: IrType | null }>,
  bodyResults: Map<IrUnitId, IrType | null>,
  diagnostic: SourceDiagnosticOwner,
): void {
  for (const unit of inventory.terminalUnits) {
    diagnostic.active = unit.id;
    if (unit.kind === "module-init") continue;
    const declaration = identity.declarationByUnitId.get(unit.id);
    if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body)
      unsupported(`whole-program source producer has no body producer for ${unit.kind}`);
    const propagated = types.get(unit.id);
    const family = nativeFamily?.functions.get(unit.id);
    const params =
      family?.params ??
      declaration.parameters.map((param, index) =>
        param.type
          ? typeNodeToIr(param.type, unit.displayName)
          : propagated?.params[index]
            ? lowerTypeToIrType(propagated.params[index]!)
            : checkerScalar(checker, param),
      );
    if (params.some((type) => !type)) unsupported(`function ${unit.displayName} has an unresolved parameter contract`);
    const isAsync = declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    const returnNode = isAsync ? unwrapPromiseTypeNode(declaration.type) : declaration.type;
    const result: IrType | null = certifiedDelays.has(unit.id)
      ? { kind: "extern", className: "Promise" }
      : family
        ? family.result
        : returnNode?.kind === ts.SyntaxKind.VoidKeyword
          ? null
          : !isAsync &&
              returnNode &&
              ts.isTypeReferenceNode(returnNode) &&
              ts.isIdentifier(returnNode.typeName) &&
              returnNode.typeName.text === "Promise"
            ? { kind: "val", val: { kind: "externref" } }
            : returnNode
              ? typeNodeToIr(returnNode, unit.displayName)
              : propagated
                ? lowerTypeToIrType(propagated.returnType)
                : null;
    bodyResults.set(unit.id, result);
    const callableResults = preparedIrProgramCallableResults({
      funcKind: isAsync ? "async" : "regular",
      resultTypes: result ? [result] : [],
    });
    signatures.set(unit.id, { params: params as IrType[], returnType: callableResults[0] ?? null });
  }
}

/** Build each original source body once, before any backend context or allocator exists. */
export function prepareIrProgramSources(
  input: IrProgramSourceInput,
): IrProgramSourcePreparation | PreparedIrProgramFailure {
  const nativeDelay = selectNativePromiseDelaySourceProjection(input);
  const nativeAsyncFamily = selectNativeAsyncFamilyProjection(input);
  const inventory = buildIrUnitInventory(input.sourceFiles, {
    ...input.inventoryOptions,
    entrySource: input.entrySource,
    checker: input.checker,
  });
  const identity = buildIrPlanningIdentityContext(inventory);
  const sourceFiles = inventory.sources.map((source) => identity.sourceFileBySourceId.get(source.id)!);
  const startup: IrModuleInitPlan[] = [];
  const allocations = new AllocSiteRegistry();
  const functions: IrFunction[] = [];
  const derivedUnits: ProgramAbiDerivedUnitRecord[] = [];
  const globals: IrProgramSourcePreparation["globals"][number][] = [];
  const globalByDeclaration = new Map<ts.Declaration, IrProgramSourcePreparation["globals"][number]>();
  const signatures = new Map<IrUnitId, { params: readonly IrType[]; returnType: IrType | null }>();
  const bodyResults = new Map<IrUnitId, IrType | null>();
  const delayPlans: NativePromiseDelaySourcePlans = {
    promiseDelaysBySource: new Map(),
    promiseDelayPopulations: new Map(),
    certifiedDelays: new Map(),
    supportReceipts: new Map(),
  };
  const { promiseDelaysBySource, certifiedDelays } = delayPlans;
  const diagnostic: SourceDiagnosticOwner = { active: undefined };
  try {
    const types = buildIrUnitTypeMap(sourceFiles, input.checker, identity);
    const callGraph = buildIrProgramCallableBindingGraph({
      checker: input.checker,
      sourceFiles,
      identityContext: identity,
    });
    const moduleResolver = makeIrIdentityModuleBindingResolver(
      input.checker,
      {
        numberStorage: "f64",
        allowHostExterns: input.policy.target === "host",
        allowBuiltinMapExtern: input.policy.target === "host" && input.policy.stringConst?.storage !== "native",
        allowNativeMapStorage: input.policy.stringConst?.storage === "native",
        oracle: input.oracle,
      },
      identity,
    );
    for (const sourceFile of sourceFiles) {
      diagnostic.active = identity.moduleInitUnitIdBySourceFile.get(sourceFile);
      startup.push(
        buildIrModuleInitPlan({
          sourceFile,
          checker: input.checker,
          identityContext: identity,
          target: input.policy.target === "strict-no-host" ? "standalone" : input.policy.target,
          deferTopLevelInit: input.deferTopLevelInit,
        }),
      );
    }
    const entryId = identity.sourceIdBySourceFile.get(input.entrySource)!;
    diagnostic.active = undefined;
    const postStartupUnits = postStartupCallableUnits(input.checker, identity, startup);
    const exportedBindings = new Set(
      startup
        .find((plan) => plan.sourceId === entryId)!
        .exports.flatMap((entry) => (entry.targetBindingId ? [entry.targetBindingId] : [])),
    );
    const exportedUnits = new Set(
      callGraph.records
        .filter((record) => record.sourceId === entryId && record.kind === "export-alias")
        .map((record) => record.targetUnitId),
    );
    for (const unit of inventory.terminalUnits)
      if (exportedBindings.has(irUnitCallableBindingId(unit.id))) exportedUnits.add(unit.id);
    if (nativeDelay)
      prepareNativePromiseDelaySourcePlans(input.checker, sourceFiles, inventory, identity, delayPlans, diagnostic);
    const nativeFamily = nativeAsyncFamily
      ? prepareNativeAsyncSourceFamilies({ checker: input.checker, identity, callGraph, certifiedDelays, diagnostic })
      : undefined;
    prepareSourceFunctionSignatures(
      input.checker,
      inventory,
      identity,
      types,
      certifiedDelays,
      nativeFamily,
      signatures,
      bodyResults,
      diagnostic,
    );
    for (const source of sourceFiles) {
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          diagnostic.active = requireIrPlanningOwnerUnitId(identity, declaration);
          if (!ts.isIdentifier(declaration.name))
            unsupported("whole-program binding pattern requires the existing destructuring producer");
          const inspected = moduleResolver.inspectDirectBinding(declaration.name);
          if (inspected.kind !== "supported")
            unsupported(`module binding ${declaration.name.text} has no exact typed storage: ${inspected.kind}`);
          const global = inspected.identity;
          diagnostic.active = global.storageOwnerUnitId;
          const lexical = (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
          const binding: ModuleBindingGlobal = {
            ownerUnitId: global.ownerUnitId,
            globalRef: irSourceGlobalRef(global.globalBindingId, declaration.name.text),
            tdzGlobalRef: lexical ? irSourceGlobalRef(global.tdzBindingId, `${declaration.name.text}$tdz`) : null,
            globalName: declaration.name.text,
            tdzGlobalName: lexical ? `${declaration.name.text}$tdz` : null,
            type: storageType(global),
          };
          const entry = { binding, identity: global };
          globals.push(entry);
          globalByDeclaration.set(declaration, entry);
        }
      }
    }
    const directCalls = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
    for (const use of callGraph.uses) {
      diagnostic.active = use.ownerUnitId;
      const signature = signatures.get(use.targetUnitId);
      const target = identity.terminalByUnitId.get(use.targetUnitId);
      if (!signature || !target) unsupported(`direct call ${use.bindingId} has no complete target contract`);
      directCalls.set(use.node, {
        ownerUnitId: use.ownerUnitId,
        target: irUnitFuncRef({ unitId: use.targetUnitId, name: target.displayName }),
        signature,
      });
    }
    const callableResolver = makeIrIdentityImportedFunctionResolver(input.checker, sourceFiles, identity);
    for (const plan of startup) {
      if (!plan.unitId) continue;
      diagnostic.active = plan.unitId;
      const ownerUnitId = plan.unitId;
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const target =
            callableResolver.resolveImportedFunctionTarget(node.expression) ??
            callableResolver.resolveTopLevelFunctionValueTarget(node.expression);
          if (target) {
            const signature = signatures.get(target.targetUnitId);
            if (!signature) unsupported(`startup call ${target.targetUnitId} has no complete declared contract`);
            directCalls.set(node, {
              ownerUnitId,
              target: irUnitFuncRef({ unitId: target.targetUnitId, name: target.targetName }),
              signature,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      for (const statement of identity.moduleInitPopulationBySourceFile.get(
        identity.sourceFileBySourceId.get(plan.sourceId)!,
      ) ?? [])
        visit(statement);
    }
    for (const unit of inventory.terminalUnits) {
      diagnostic.active = unit.id;
      if (functions.some((fn) => fn.unitId === unit.id)) continue;
      const family = nativeFamily?.functions.get(unit.id);
      if (family) nativeFamily!.assertCurrent(unit.id);
      const resolveBinding = (node: ts.Identifier, writeValue?: ts.Expression): ModuleBindingGlobal | undefined => {
        let symbol = input.checker.getSymbolAtLocation(node);
        if (!symbol) return undefined;
        const imported = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
        if (imported) symbol = input.checker.getAliasedSymbol(symbol);
        const declaration = symbol.valueDeclaration;
        const global = declaration ? globalByDeclaration.get(declaration) : undefined;
        if (!global) return undefined;
        if (writeValue && (imported || !global.identity.mutable))
          unsupported(`write to immutable module binding ${node.text}`);
        return {
          ...global.binding,
          ownerUnitId: unit.id,
          ...(postStartupUnits.has(unit.id) ? { omitTdzReadCheck: true as const } : {}),
        };
      };
      const resolver: IrFromAstResolver = {
        resolveModuleBinding: resolveBinding,
        preparedAsyncAwaitSite: (awaitExpression) => {
          const resultType = checkerScalar(input.checker, awaitExpression);
          const operandType = checkerScalar(input.checker, awaitExpression.expression) ?? {
            kind: "val" as const,
            val: { kind: "externref" as const },
          };
          return resultType ? { resultType, operandType } : null;
        },
        ...family?.resolver,
      };
      const source = identity.sourceFileBySourceId.get(unit.sourceId)!;
      const moduleInit = unit.kind === "module-init";
      const declaration = moduleInit
        ? makeModuleInitSynthetic(identity.moduleInitPopulationBySourceFile.get(source) ?? [])
        : identity.declarationByUnitId.get(unit.id)!;
      if (!ts.isFunctionDeclaration(declaration)) unsupported(`missing declaration producer for ${unit.kind}`);
      const signature = signatures.get(unit.id);
      const lowered = lowerFunctionAstToIr(declaration, {
        ownerUnitId: unit.id,
        funcName: unit.displayName,
        exported: exportedUnits.has(unit.id),
        identityContext: identity,
        checker: input.checker,
        oracle: input.oracle,
        allocRegistry: allocations,
        directCalls,
        resolver,
        ...(nativeDelay ? { promiseDelays: promiseDelaysBySource.get(source) } : {}),
        ...(family ? { logicalVectorTypes: family.logicalVectorTypes } : {}),
        ...(moduleInit
          ? {
              moduleInitUnit: true,
              returnTypeOverride: null,
              moduleBindings: new Map(
                globals
                  .filter((global) => global.identity.sourceId === unit.sourceId)
                  .map((global) => [global.binding.globalName, { ...global.binding, ownerUnitId: unit.id }]),
              ),
            }
          : { paramTypeOverrides: signature!.params, returnTypeOverride: bodyResults.get(unit.id)! }),
        numericLocalScalarForDecl: (declaration) =>
          checkerScalar(input.checker, declaration)?.kind === "val" &&
          (input.checker.getTypeAtLocation(declaration).flags & ts.TypeFlags.NumberLike) !== 0
            ? "number"
            : undefined,
      });
      if (certifiedDelays.has(unit.id) && (lowered.lifted.length !== 0 || lowered.liftedUnitProvenance.length !== 0))
        throw new PreparedIrProgramInvariantError(
          "invalid-prepared-data",
          `certified native Promise-delay ${unit.id} fabricated support bodies or provenance`,
        );
      functions.push(lowered.main, ...lowered.lifted);
      for (const provenance of lowered.liftedUnitProvenance) {
        if ("sourceUnit" in provenance) {
          const sourceUnit = inventory.allUnits.find((record) => record.id === provenance.id);
          if (
            !sourceUnit ||
            sourceUnit.sourceId !== unit.sourceId ||
            sourceUnit.lexicalOwnerId !== provenance.parentId ||
            sourceUnit.ordinal !== provenance.ordinal
          )
            throw new PreparedIrProgramInvariantError(
              "invalid-prepared-data",
              `lifted source ${provenance.id} contradicts the original inventory`,
            );
        } else derivedUnits.push({ ...provenance, sourceId: unit.sourceId, terminalOwnerId: unit.id });
      }
    }
    nativeFamily?.assertCurrent();
    if (nativeDelay)
      validateNativePromiseDelaySourceLowering(
        identity,
        delayPlans,
        { functions, derivedUnits, callables: callGraph.records, startup, globals, allocations },
        diagnostic,
      );
    return {
      kind: "prepared",
      inventory,
      ir: { functions },
      derivedUnits,
      startup,
      callables: callGraph.records,
      globals,
      allocations,
    };
  } catch (error) {
    const owner = diagnostic.active
      ? preparedIrProgramOwner({ inventory, derivedUnits }, diagnostic.active)
      : undefined;
    if (!owner)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `source preparation failed without an original owner: ${String(error)}`,
      );
    const { cause: _cause, ...failureDiagnostic } = classifyIrFailure(error, "build");
    return { ...failureDiagnostic, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile };
  }
}
