// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { TypeOracle } from "../checker/oracle.js";
import { AllocSiteRegistry } from "./alloc-registry.js";
import { irSourceGlobalRef } from "./abi-bindings.js";
import { irUnitFuncRef, irUnitCallableBindingId } from "./callable-bindings.js";
import { lowerFunctionAstToIr, typeNodeToIr, type IrFromAstResolver } from "./from-ast.js";
import {
  buildIrUnitInventory,
  type BuildIrUnitInventoryOptions,
  type IrUnitId,
  type IrUnitInventory,
} from "./identity.js";
import { buildIrPlanningIdentityContext, requireIrPlanningOwnerUnitId } from "./planning-identity.js";
import {
  buildIrProgramCallableBindingGraph,
  type IrProgramCallableBindingRecord,
} from "./program-callable-bindings.js";
import { buildIrUnitTypeMap, lowerTypeToIrType } from "./propagate.js";
import { buildIrModuleInitPlan, type IrModuleInitPlan } from "./module-init-plan.js";
import { makeModuleInitSynthetic } from "./module-init.js";
import { makeIrIdentityModuleBindingResolver, type IrModuleBindingIdentity } from "./module-bindings.js";
import type { IrDirectCallLoweringPlan, ModuleBindingGlobal } from "./ast-lowering-plans.js";
import type { IrFunction, IrModule, IrType } from "./nodes.js";
import { classifyIrFailure, IrUnsupportedError } from "./outcomes.js";
import type { ProgramAbiDerivedUnitRecord } from "./program-abi.js";
import { preparedIrProgramOwner, PreparedIrProgramInvariantError, type PreparedIrProgramFailure } from "./program.js";
import type { RuntimeManifestPolicy } from "./runtime-manifest.js";
import { unwrapPromiseTypeNode } from "./async-static.js";
import { postStartupCallableUnits } from "./program-startup-proof.js";
import { makeIrIdentityImportedFunctionResolver } from "./imported-functions.js";

export interface IrProgramSourceInput {
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly entrySource: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly oracle?: TypeOracle;
  readonly inventoryOptions?: BuildIrUnitInventoryOptions;
  readonly policy: RuntimeManifestPolicy;
  readonly deferTopLevelInit: boolean;
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

/** Build each original source body once, before any backend context or allocator exists. */
export function prepareIrProgramSources(
  input: IrProgramSourceInput,
): IrProgramSourcePreparation | PreparedIrProgramFailure {
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
  let active: IrUnitId | undefined;
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
      active = identity.moduleInitUnitIdBySourceFile.get(sourceFile);
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
    active = undefined;
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
    for (const unit of inventory.terminalUnits) {
      active = unit.id;
      if (unit.kind === "module-init") continue;
      const declaration = identity.declarationByUnitId.get(unit.id);
      if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body)
        unsupported(`whole-program source producer has no body producer for ${unit.kind}`);
      const propagated = types.get(unit.id);
      const params = declaration.parameters.map((param, index) =>
        param.type
          ? typeNodeToIr(param.type, unit.displayName)
          : propagated?.params[index]
            ? lowerTypeToIrType(propagated.params[index]!)
            : checkerScalar(input.checker, param),
      );
      if (params.some((type) => !type))
        unsupported(`function ${unit.displayName} has an unresolved parameter contract`);
      const returnNode = declaration.type ? unwrapPromiseTypeNode(declaration.type) : undefined;
      const result =
        returnNode?.kind === ts.SyntaxKind.VoidKeyword
          ? null
          : returnNode
            ? typeNodeToIr(returnNode, unit.displayName)
            : propagated
              ? lowerTypeToIrType(propagated.returnType)
              : null;
      signatures.set(unit.id, { params: params as IrType[], returnType: result });
    }
    for (const source of sourceFiles) {
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          active = requireIrPlanningOwnerUnitId(identity, declaration);
          if (!ts.isIdentifier(declaration.name))
            unsupported("whole-program binding pattern requires the existing destructuring producer");
          const inspected = moduleResolver.inspectDirectBinding(declaration.name);
          if (inspected.kind !== "supported")
            unsupported(`module binding ${declaration.name.text} has no exact typed storage: ${inspected.kind}`);
          const global = inspected.identity;
          active = global.storageOwnerUnitId;
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
      active = use.ownerUnitId;
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
      active = plan.unitId;
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
      active = unit.id;
      if (functions.some((fn) => fn.unitId === unit.id)) continue;
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
          : { paramTypeOverrides: signature!.params, returnTypeOverride: signature!.returnType }),
        numericLocalScalarForDecl: (declaration) =>
          checkerScalar(input.checker, declaration)?.kind === "val" &&
          (input.checker.getTypeAtLocation(declaration).flags & ts.TypeFlags.NumberLike) !== 0
            ? "number"
            : undefined,
      });
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
    const owner = active ? preparedIrProgramOwner({ inventory, derivedUnits }, active) : undefined;
    if (!owner)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `source preparation failed without an original owner: ${String(error)}`,
      );
    const { cause: _cause, ...diagnostic } = classifyIrFailure(error, "build");
    return { ...diagnostic, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile };
  }
}
