// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irSupportFuncRef } from "../ir/callable-bindings.js";
import type { IrBindingId, IrSourceId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncHandle, FuncTypeDef, Import, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, definedFuncHandleOf } from "./func-space.js";
import { planProgramAbiSupportCallable, PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-planning.js";
import type { ProgramAbiSession } from "./program-abi-session.js";

const RETAINED_MODULE_FUNCTION_ROLE = "retained-module-function";

export interface ProgramAbiEntrySourceSupportObservation {
  readonly role: string;
  readonly roleOrdinal: number;
  readonly derivedOrdinal: number;
  readonly displayName: string;
  readonly funcIdx: FuncHandle;
}

interface ObservedEntrySourceSupport {
  readonly bindingId: IrBindingId;
  readonly sourceId: IrSourceId;
  readonly role: string;
  readonly roleOrdinal: number;
  readonly derivedOrdinal: number;
  readonly displayName: string;
  readonly func: WasmFunction;
}

export function canonicalProgramAbiEntrySource(session: ProgramAbiSession): IrSourceId {
  const entrySources = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entrySources.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `callable ABI planning requires exactly one canonical entry source, found ${entrySources.length}`,
    );
  }
  return entrySources[0]!.id;
}

function functionSignature(ctx: CodegenContext, func: WasmFunction): FuncTypeDef {
  const signature = ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `retained function ${func.name} references non-function or missing type ${func.typeIdx}`,
    );
  }
  return signature;
}

/**
 * Final function-space population owner.
 *
 * Source bodies, imported callables, class adapters, and runtime providers keep
 * their semantic owners. Every remaining defined function receives one
 * entry-source support identity after DCE, making the final function index
 * space total without consulting funcMap or a function name.
 */
export class ProgramAbiCallableRegistry {
  private readonly entrySourceSupports = new Map<IrBindingId, ObservedEntrySourceSupport>();
  private planned = false;

  constructor(
    readonly session: ProgramAbiSession,
    readonly ctx: CodegenContext,
  ) {
    session.assertModule(ctx.mod);
  }

  /**
   * Atomically capture a complete entry-source support family by exact
   * allocator objects.
   *
   * Every observation is validated before the sidecar changes, so a partially
   * allocated family can never leak into final ABI planning. Labels are
   * diagnostic only; role plus fixed derived ordinal supply identity.
   */
  observeEntrySourceSupports(observations: readonly ProgramAbiEntrySourceSupportObservation[]): void {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot observe entry-source support callables after retained callable planning",
      );
    }
    const sourceId = canonicalProgramAbiEntrySource(this.session);
    const prepared: ObservedEntrySourceSupport[] = [];
    const batchIds = new Set<IrBindingId>();
    for (const observation of observations) {
      if (!Number.isSafeInteger(observation.derivedOrdinal) || observation.derivedOrdinal < 0) {
        throw new ProgramAbiInvariantError(
          "unknown-order-anchor",
          `entry-source support ${observation.displayName} has invalid derived ordinal ${observation.derivedOrdinal}`,
        );
      }
      const func = definedFuncAt(this.ctx, observation.funcIdx);
      if (!func) {
        throw new ProgramAbiInvariantError(
          "missing-required-locator",
          `entry-source support ${observation.displayName} has no exact defined function for handle ${observation.funcIdx}`,
        );
      }
      const ref = irSupportFuncRef(sourceId, observation.role, observation.displayName, observation.derivedOrdinal);
      if (ref.binding.kind !== "support") {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `entry-source support ${observation.displayName} did not produce a support binding`,
        );
      }
      const bindingId = ref.binding.bindingId;
      if (batchIds.has(bindingId)) {
        throw new ProgramAbiInvariantError("duplicate-slot-locator", `entry-source support batch repeats ${bindingId}`);
      }
      batchIds.add(bindingId);
      const existing = this.entrySourceSupports.get(bindingId);
      if (
        existing &&
        (existing.func !== func ||
          existing.roleOrdinal !== observation.roleOrdinal ||
          existing.displayName !== observation.displayName)
      ) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `entry-source support ${bindingId} was observed with contradictory allocator ownership`,
        );
      }
      prepared.push(
        Object.freeze({
          bindingId,
          sourceId,
          role: observation.role,
          roleOrdinal: observation.roleOrdinal,
          derivedOrdinal: observation.derivedOrdinal,
          displayName: observation.displayName,
          func,
        }),
      );
    }
    for (const observation of prepared) {
      if (!this.entrySourceSupports.has(observation.bindingId)) {
        this.entrySourceSupports.set(observation.bindingId, observation);
      }
    }
  }

  /**
   * Resolve one observed entry-source support binding to its current handle.
   *
   * Exact object lookup follows late-import shifts and DCE without consulting
   * `funcMap` or scanning generated function labels.
   */
  handleForEntrySourceSupport(role: string, derivedOrdinal: number): FuncHandle | undefined {
    const sourceId = canonicalProgramAbiEntrySource(this.session);
    const ref = irSupportFuncRef(sourceId, role, "diagnostic-only", derivedOrdinal);
    if (ref.binding.kind !== "support") return undefined;
    const observation = this.entrySourceSupports.get(ref.binding.bindingId);
    return observation ? definedFuncHandleOf(this.ctx, observation.func) : undefined;
  }

  planRetained(): void {
    if (this.planned) return;
    this.planned = true;

    const entrySourceId = canonicalProgramAbiEntrySource(this.session);
    const live = new Set(this.ctx.mod.functions);
    const supportObservations = [...this.entrySourceSupports.values()]
      .filter((observation) => live.has(observation.func))
      .sort(
        (left, right) =>
          left.roleOrdinal - right.roleOrdinal ||
          left.derivedOrdinal - right.derivedOrdinal ||
          (left.bindingId < right.bindingId ? -1 : left.bindingId > right.bindingId ? 1 : 0),
      );
    for (const observation of supportObservations) {
      const ref = irSupportFuncRef(
        observation.sourceId,
        observation.role,
        observation.displayName,
        observation.derivedOrdinal,
      );
      const plannedBindingId = planProgramAbiSupportCallable(this.ctx, {
        ref,
        anchor: { kind: "source", sourceId: observation.sourceId },
        role: observation.role,
        roleOrdinal: observation.roleOrdinal,
        derivedOrdinal: observation.derivedOrdinal,
        signature: functionSignature(this.ctx, observation.func),
        func: observation.func,
      });
      if (plannedBindingId !== observation.bindingId) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `entry-source support ${observation.displayName} was not accepted for ${observation.bindingId}`,
        );
      }
    }

    const seen = new Set<object>();
    let finalIndex = 0;

    for (const value of this.ctx.mod.imports) {
      if (value.desc.kind !== "func") continue;
      this.assertUniqueAllocatorObject(seen, value, finalIndex);
      if (!this.session.locatorBindingId(value)) {
        throw new ProgramAbiInvariantError(
          "missing-required-locator",
          `retained function import ${value.module}.${value.name} has no Program ABI owner`,
        );
      }
      finalIndex++;
    }
    for (const func of this.ctx.mod.functions) {
      this.assertUniqueAllocatorObject(seen, func, finalIndex);
      if (!this.session.locatorBindingId(func)) {
        const name = func.name.length > 0 ? func.name : `function#${finalIndex}`;
        const ref = irSupportFuncRef(entrySourceId, RETAINED_MODULE_FUNCTION_ROLE, name, finalIndex);
        planProgramAbiSupportCallable(this.ctx, {
          ref,
          anchor: { kind: "source", sourceId: entrySourceId },
          role: RETAINED_MODULE_FUNCTION_ROLE,
          roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.retainedModuleFunction,
          derivedOrdinal: finalIndex,
          signature: functionSignature(this.ctx, func),
          func,
        });
      }
      finalIndex++;
    }
  }

  private assertUniqueAllocatorObject(seen: Set<object>, value: Import | WasmFunction, finalIndex: number): void {
    if (seen.has(value)) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `function allocator object appears more than once in final function space at index ${finalIndex}`,
      );
    }
    seen.add(value);
  }
}
