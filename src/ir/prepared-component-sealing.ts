// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import { definedFuncAt } from "../codegen/func-space.js";
import { planProgramAbiUnitCallable } from "../codegen/program-abi-planning.js";
import { irUnitCallableBindingId, irUnitFuncRef } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId, IrUnitInventory } from "./identity.js";
import type { IrFunction } from "./nodes.js";
import { IrInvariantError } from "./outcomes.js";
import {
  derivePreparedComponentDependencies,
  type PreparedComponentClosureSupportEvidence,
  type PreparedComponentDependencyReport,
} from "./prepared-component-dependencies.js";
import type { ProgramAbiDerivedUnitRecord } from "./program-abi.js";
import type { Import } from "./types.js";

export interface PreparedComponentArtifactEntry {
  readonly artifactUnitId: IrUnitId;
  readonly terminalOwnerUnitId: IrUnitId;
  readonly fn: IrFunction;
  readonly derivedUnit?: ProgramAbiDerivedUnitRecord;
  readonly classMember?: boolean;
  readonly moduleInit?: boolean;
}

function planBlockingCallableProviders(ctx: CodegenContext, report: PreparedComponentDependencyReport): boolean {
  const registry = ctx.programAbiCallableProviders;
  if (!registry) return false;
  const selectedKeys = new Set<string>();
  const selectedImports = new Set<Import>();
  for (const component of report.components) {
    const unresolvedKeys = new Set(
      component.externalCallables
        .filter((dependency) => dependency.programAbiBindingId === null)
        .map((dependency) => dependency.structuralReferenceKey),
    );
    const providerImports = registry.importsForPreparedProviders(unresolvedKeys);
    if (
      unresolvedKeys.size === 0 ||
      component.failures.length === 0 ||
      !component.failures.every(
        (failure) =>
          failure.code === "unplanned-abi-binding" &&
          failure.structuralReferenceKey !== undefined &&
          unresolvedKeys.has(failure.structuralReferenceKey),
      ) ||
      providerImports === undefined
    ) {
      continue;
    }
    for (const key of unresolvedKeys) selectedKeys.add(key);
    for (const imported of providerImports) selectedImports.add(imported);
  }
  if (selectedKeys.size === 0) return false;
  if (selectedImports.size > 0) {
    const importRegistry = ctx.programAbiCallableImports;
    if (!importRegistry) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        "prepared callable providers require one canonical callable-import registry",
      );
    }
    importRegistry.planPrepared(selectedImports);
  }
  if (!registry.canPlanPrepared(selectedKeys)) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared callable provider imports did not acquire canonical Program ABI owners",
    );
  }
  registry.planPrepared(selectedKeys);
  return true;
}

function planBlockingCallableImports(
  ctx: CodegenContext,
  report: PreparedComponentDependencyReport,
  catalog: ReadonlyMap<string, Import>,
): boolean {
  const selected = new Set<Import>();
  for (const component of report.components) {
    const unresolvedImports = new Map(
      component.externalCallables.flatMap((dependency) => {
        if (dependency.programAbiBindingId !== null) return [];
        const imported = catalog.get(dependency.structuralReferenceKey);
        return imported ? ([[dependency.structuralReferenceKey, imported]] as const) : [];
      }),
    );
    if (
      unresolvedImports.size === 0 ||
      component.failures.length === 0 ||
      !component.failures.every(
        (failure) =>
          failure.code === "unplanned-abi-binding" &&
          failure.structuralReferenceKey !== undefined &&
          unresolvedImports.has(failure.structuralReferenceKey),
      )
    ) {
      continue;
    }
    for (const imported of unresolvedImports.values()) selected.add(imported);
  }
  if (selected.size === 0) return false;
  const registry = ctx.programAbiCallableImports;
  if (!registry) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared callable dependencies require one canonical callable-import registry",
    );
  }
  registry.planPrepared(selected);
  return true;
}

export function sealDependencyCompletePreparedComponents(input: {
  readonly ctx: CodegenContext;
  readonly entries: readonly PreparedComponentArtifactEntry[];
  readonly inventory: IrUnitInventory;
  readonly closureSupport?: PreparedComponentClosureSupportEvidence;
  readonly callableImports: ReadonlyMap<string, Import>;
  readonly onSealFailure: (terminalUnitId: IrUnitId, error: IrInvariantError) => void;
}): ReadonlyMap<IrUnitId, string> {
  const { ctx, entries, inventory } = input;
  const session = ctx.programAbiSession;
  if (!session) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "prepared-component sealing requires one production ProgramAbiSession",
    );
  }
  const terminalUnitIds = new Set(entries.map((entry) => entry.terminalOwnerUnitId));
  const terminalCallableBindingIds = new Set<IrBindingId>();
  for (const entry of entries) {
    const terminalUnitId = entry.terminalOwnerUnitId;
    const isTerminal = entry.artifactUnitId === terminalUnitId && !entry.derivedUnit;
    const func = isTerminal
      ? (() => {
          const funcIdx = entry.moduleInit
            ? ctx.programAbiModuleInitCallables?.handleForUnit(terminalUnitId)
            : entry.classMember
              ? ctx.programAbiClassCallables?.handleForUnit(terminalUnitId)
              : ctx.programAbiSourceCallables?.handleForUnit(terminalUnitId);
          return funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
        })()
      : ctx.irUnitFuncMap.get(entry.artifactUnitId);
    const signature = func === undefined ? undefined : ctx.mod.types[func.typeIdx];
    if (!func || !signature || signature.kind !== "func") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `dependency preparation has no exact allocated callable for artifact ${entry.artifactUnitId}`,
      );
    }
    const bindingId = planProgramAbiUnitCallable(ctx, { ref: irUnitFuncRef(entry.fn), signature, func });
    if (bindingId !== irUnitCallableBindingId(entry.artifactUnitId)) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `dependency preparation could not plan the exact callable for artifact ${entry.artifactUnitId}`,
      );
    }
    if (isTerminal) terminalCallableBindingIds.add(bindingId);
  }
  ctx.programAbiExports?.planAliasesForTargets(terminalCallableBindingIds);

  const derivedUnits = [
    ...new Map(
      entries.flatMap((entry) => (entry.derivedUnit ? ([[entry.derivedUnit.id, entry.derivedUnit]] as const) : [])),
    ).values(),
  ];
  const derive = (): PreparedComponentDependencyReport =>
    derivePreparedComponentDependencies({
      module: { functions: entries.map((entry) => entry.fn) },
      terminalUnitIds,
      inventory,
      derivedUnits,
      ...(input.closureSupport ? { closureSupport: input.closureSupport } : {}),
      abi: {
        get: (id) => session.getDraft(id),
        bindingIdsForStructuralReference: (key) => session.bindingIdsForStructuralReference(key),
      },
    });
  let report = derive();
  if (planBlockingCallableImports(ctx, report, input.callableImports)) report = derive();
  if (planBlockingCallableProviders(ctx, report)) report = derive();

  const componentIdByTerminalUnitId = new Map<IrUnitId, string>();
  for (const component of report.components) {
    if (component.status !== "complete") continue;
    try {
      const scope = session.beginPreparedComponentScope(component.id, component.terminalUnitIds);
      const requestedBindingIds = new Set(
        component.abiDependencies
          .filter(({ kind }) => ["external-callable", "external-global", "class-layout", "support"].includes(kind))
          .map((dependency) => dependency.bindingId),
      );
      for (const bindingId of requestedBindingIds) scope.includeBinding(bindingId);
      scope.seal();
      for (const terminalUnitId of component.terminalUnitIds) {
        componentIdByTerminalUnitId.set(terminalUnitId, component.id);
      }
    } catch (error) {
      const failure = new IrInvariantError(
        "selection-preparation-mismatch",
        "resolve",
        `dependency-complete component ${component.id} failed ABI sealing: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
      for (const terminalUnitId of component.terminalUnitIds) input.onSealFailure(terminalUnitId, failure);
    }
  }
  return componentIdByTerminalUnitId;
}
