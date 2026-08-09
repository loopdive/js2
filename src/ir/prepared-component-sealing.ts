// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CodegenContext } from "../codegen/context/types.js";
import { definedFuncAt } from "../codegen/func-space.js";
import { planProgramAbiUnitCallable } from "../codegen/program-abi-planning.js";
import { irUnitCallableBindingId, irUnitFuncRef } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId, IrUnitInventory } from "./identity.js";
import type { IrFunction } from "./nodes.js";
import { IrInvariantError, IrUnsupportedError } from "./outcomes.js";
import {
  derivePreparedComponentDependencies,
  type PreparedClassAccessorWritebackEvidence,
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
  const providers = ctx.programAbiCallableProviders;
  for (const component of report.components) {
    const unresolvedImports = new Map(
      component.externalCallables.flatMap((dependency) => {
        if (dependency.programAbiBindingId !== null) return [];
        const imported = catalog.get(dependency.structuralReferenceKey);
        return imported ? ([[dependency.structuralReferenceKey, imported]] as const) : [];
      }),
    );
    const allFailuresArePlannableCallables =
      component.failures.length > 0 &&
      component.failures.every((failure) => {
        const key = failure.structuralReferenceKey;
        return (
          failure.code === "unplanned-abi-binding" &&
          key !== undefined &&
          (unresolvedImports.has(key) || providers?.importsForPreparedProviders(new Set([key])) !== undefined)
        );
      });
    if (!allFailuresArePlannableCallables) {
      continue;
    }
    for (const imported of unresolvedImports.values()) selected.add(imported);
    for (const failure of component.failures) {
      const key = failure.structuralReferenceKey;
      if (!key) continue;
      for (const imported of providers?.importsForPreparedProviders(new Set([key])) ?? []) selected.add(imported);
    }
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
  readonly classAccessorWritebacks?: ReadonlyMap<IrUnitId, PreparedClassAccessorWritebackEvidence>;
  readonly callableImports: ReadonlyMap<string, Import>;
  readonly onSealFailure: (terminalUnitId: IrUnitId, error: IrUnsupportedError) => void;
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
      ...(input.classAccessorWritebacks ? { classAccessorWritebacks: input.classAccessorWritebacks } : {}),
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
    if (component.status !== "complete") {
      const detail =
        component.failures.length === 0
          ? "dependency discovery returned no failure evidence"
          : component.failures.map((failure) => `${failure.code}: ${failure.detail}`).join("; ");
      const failure = new IrUnsupportedError(
        "late-preparation-unsupported",
        "resolve",
        `prepared component ${component.id} has incomplete dependencies: ${detail}`,
        component.failures,
      );
      for (const terminalUnitId of component.terminalUnitIds) input.onSealFailure(terminalUnitId, failure);
      continue;
    }
    try {
      const scope = session.beginPreparedComponentScope(component.id, component.terminalUnitIds);
      let sealStarted = false;
      try {
        const requestedDependencies = new Map<IrBindingId, typeof component.abiDependencies>();
        for (const dependency of component.abiDependencies) {
          if (
            dependency.borrowing === undefined &&
            !["external-callable", "external-global", "class-layout", "support"].includes(dependency.kind)
          ) {
            continue;
          }
          requestedDependencies.set(dependency.bindingId, [
            ...(requestedDependencies.get(dependency.bindingId) ?? []),
            dependency,
          ]);
        }
        for (const [bindingId, dependencies] of requestedDependencies) {
          const borrowed = dependencies.filter((dependency) => dependency.borrowing !== undefined);
          if (borrowed.length === 0) {
            scope.includeBinding(bindingId);
            continue;
          }
          if (borrowed.length !== dependencies.length) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "resolve",
              `prepared component ${component.id} mixes borrowed and owned evidence for ${bindingId}`,
            );
          }
          const consumerUnitIds = [...new Set(borrowed.map(({ ownerUnitId }) => ownerUnitId))];
          const first = borrowed[0]!.borrowing!;
          if (borrowed.some(({ borrowing }) => borrowing?.kind !== first.kind)) {
            throw new IrInvariantError(
              "selection-preparation-mismatch",
              "resolve",
              `prepared component ${component.id} has incompatible borrow proofs for ${bindingId}`,
            );
          }
          if (first.kind === "nested-accessor-class-layout") {
            scope.includeBorrowedBinding(bindingId, { kind: first.kind, consumerUnitIds });
          } else if (first.kind === "class-setter-writeback-global") {
            if (
              borrowed.some(
                ({ borrowing }) =>
                  borrowing?.kind !== first.kind || borrowing.dynamicCarrierBindingId !== first.dynamicCarrierBindingId,
              )
            ) {
              throw new IrInvariantError(
                "selection-preparation-mismatch",
                "resolve",
                `prepared component ${component.id} has incompatible dynamic-carrier proofs for ${bindingId}`,
              );
            }
            scope.includeBorrowedBinding(bindingId, {
              kind: first.kind,
              consumerUnitIds,
              dynamicCarrierBindingId: first.dynamicCarrierBindingId,
            });
          } else {
            if (
              borrowed.some(
                ({ borrowing }) =>
                  borrowing?.kind !== first.kind || borrowing.valueGlobalBindingId !== first.valueGlobalBindingId,
              )
            ) {
              throw new IrInvariantError(
                "selection-preparation-mismatch",
                "resolve",
                `prepared component ${component.id} has incompatible TDZ proofs for ${bindingId}`,
              );
            }
            scope.includeBorrowedBinding(bindingId, {
              kind: first.kind,
              consumerUnitIds,
              valueGlobalBindingId: first.valueGlobalBindingId,
            });
          }
        }
        if (process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE === "1") {
          throw new Error(`injected prepared ABI seal failure for ${component.id}`);
        }
        sealStarted = true;
        scope.seal();
      } catch (error) {
        if (!sealStarted) scope.abort();
        throw error;
      }
      for (const terminalUnitId of component.terminalUnitIds) {
        componentIdByTerminalUnitId.set(terminalUnitId, component.id);
      }
    } catch (error) {
      const failure = new IrUnsupportedError(
        "late-preparation-unsupported",
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
