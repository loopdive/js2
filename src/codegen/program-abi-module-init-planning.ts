// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irSupportFuncRef, irUnitCallableBindingId, irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrSourceId, IrUnitId } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncHandle, FuncTypeDef, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, pushDefinedFunc } from "./func-space.js";
import {
  planProgramAbiSupportCallable,
  planProgramAbiUnitCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
} from "./program-abi-planning.js";
import type { ProgramAbiSession } from "./program-abi-session.js";

const LEGACY_MODULE_INIT_PASS_ROLE = "legacy-module-init-pass";

interface ModuleInitCallableObservation {
  readonly ordinal: number;
  readonly unitId?: IrUnitId;
  readonly funcIdx: FuncHandle;
}

/** Push and structurally observe one compiler-created module initializer. */
export function pushProgramAbiModuleInitCallable(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  funcIdx: FuncHandle,
  func: WasmFunction,
): void {
  pushDefinedFunc(ctx, funcIdx, func);
  const registry = ctx.programAbiModuleInitCallables;
  if (!registry) {
    throw new ProgramAbiInvariantError(
      "context-session-mismatch",
      "module initializer was allocated without its structural registry",
    );
  }
  registry.observe(sourceFile, funcIdx);
}

function canonicalEntrySource(session: ProgramAbiSession): IrSourceId {
  const entries = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entries.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `module-init ABI planning requires exactly one canonical entry source, found ${entries.length}`,
    );
  }
  return entries[0]!.id;
}

function functionSignature(ctx: CodegenContext, func: WasmFunction): FuncTypeDef {
  const signature = ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `module initializer ${func.name} references non-function or missing type ${func.typeIdx}`,
    );
  }
  return signature;
}

/**
 * Exact allocator sidecar for compiler-created module initializers.
 *
 * The sidecar exists even without a Program ABI session so startup wiring and
 * the compatibility overlay never rediscover an initializer by display name.
 * With an identity inventory, a single semantic module-init unit owns the final
 * allocator object. The legacy multi-source pipeline emits progressively
 * cumulative initializer functions; those temporary physical passes receive
 * explicit source support identities until R5 replaces them with one prepared
 * whole-program unit.
 */
export class ProgramAbiModuleInitCallableRegistry {
  private readonly observations: ModuleInitCallableObservation[] = [];
  private planned = false;

  constructor(
    readonly ctx: CodegenContext,
    readonly session?: ProgramAbiSession,
    readonly identityContext?: IrPlanningIdentityContext,
  ) {
    session?.assertModule(ctx.mod);
    if (!session && identityContext) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "module-init ABI registry cannot accept a planning identity context without a Program ABI session",
      );
    }
    if (session && identityContext && identityContext.inventory !== session.inventory) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "module-init ABI registry and planning context do not share one inventory",
      );
    }
  }

  observe(sourceFile: ts.SourceFile, funcIdx: FuncHandle): void {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot observe a module initializer after retained module-init planning",
      );
    }
    const func = definedFuncAt(this.ctx, funcIdx);
    if (!func) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `module initializer has no exact defined function for handle ${funcIdx}`,
      );
    }
    if (this.identityContext && !this.identityContext.sourceIdBySourceFile.has(sourceFile)) {
      throw new ProgramAbiInvariantError(
        "unknown-order-anchor",
        `module initializer source ${sourceFile.fileName} is absent from the planning inventory`,
      );
    }
    const unitId = this.identityContext?.moduleInitUnitIdBySourceFile.get(sourceFile);
    this.observations.push(
      Object.freeze({
        ordinal: this.observations.length,
        ...(unitId === undefined ? {} : { unitId }),
        funcIdx,
      }),
    );
  }

  /** First compiler-created initializer, preserving the legacy multi-source startup choice. */
  firstFunction(): WasmFunction | undefined {
    const observation = this.observations[0];
    return observation ? definedFuncAt(this.ctx, observation.funcIdx) : undefined;
  }

  firstHandle(): FuncHandle | undefined {
    const observation = this.observations[0];
    return observation && definedFuncAt(this.ctx, observation.funcIdx) ? observation.funcIdx : undefined;
  }

  /** Exact preallocated function object for one selected source module-init unit. */
  functionForUnit(unitId: IrUnitId): WasmFunction | undefined {
    const observation = this.observations.filter((candidate) => candidate.unitId === unitId).at(-1);
    return observation ? definedFuncAt(this.ctx, observation.funcIdx) : undefined;
  }

  handleForUnit(unitId: IrUnitId): FuncHandle | undefined {
    const observation = this.observations.filter((candidate) => candidate.unitId === unitId).at(-1);
    return observation && definedFuncAt(this.ctx, observation.funcIdx) ? observation.funcIdx : undefined;
  }

  /** Exact preallocated function object for one source before unit planning seals. */
  functionForSource(sourceFile: ts.SourceFile): WasmFunction | undefined {
    const unitId = this.identityContext?.moduleInitUnitIdBySourceFile.get(sourceFile);
    return unitId === undefined ? undefined : this.functionForUnit(unitId);
  }

  handleForSource(sourceFile: ts.SourceFile): FuncHandle | undefined {
    const unitId = this.identityContext?.moduleInitUnitIdBySourceFile.get(sourceFile);
    return unitId === undefined ? undefined : this.handleForUnit(unitId);
  }

  /** Assign semantic owners before generic retained-callable population. */
  planRetained(): void {
    if (this.planned) return;
    this.planned = true;
    const { session, identityContext } = this;
    if (!session || !identityContext) return;

    const liveObservations = this.observations.flatMap((observation) => {
      const func = definedFuncAt(this.ctx, observation.funcIdx);
      return func ? [{ observation, func }] : [];
    });
    const moduleInitUnitIds = [...identityContext.moduleInitUnitIdBySourceId.values()];
    const exactUnitId = moduleInitUnitIds.length === 1 ? moduleInitUnitIds[0] : undefined;
    const exactObservation = exactUnitId ? liveObservations.at(-1)?.observation : undefined;
    const entrySourceId = canonicalEntrySource(session);

    for (const { observation, func } of liveObservations) {
      if (exactUnitId && observation === exactObservation) {
        this.planExactUnit(exactUnitId, func);
        continue;
      }
      const ref = irSupportFuncRef(entrySourceId, LEGACY_MODULE_INIT_PASS_ROLE, func.name, observation.ordinal);
      const bindingId =
        ref.binding.kind === "support"
          ? planProgramAbiSupportCallable(this.ctx, {
              ref,
              anchor: { kind: "source", sourceId: entrySourceId },
              role: LEGACY_MODULE_INIT_PASS_ROLE,
              roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.moduleInit,
              derivedOrdinal: observation.ordinal,
              signature: functionSignature(this.ctx, func),
              func,
            })
          : undefined;
      if (ref.binding.kind !== "support" || bindingId !== ref.binding.bindingId) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `legacy module-init pass ${observation.ordinal} was not accepted by Program ABI planning`,
        );
      }
    }
  }

  private planExactUnit(unitId: IrUnitId, func: WasmFunction): void {
    const session = this.session!;
    const bindingId = irUnitCallableBindingId(unitId);
    if (session.hasPlan(bindingId)) {
      if (!session.hasLocator(bindingId, func)) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `module-init unit ${unitId} is not attached to its exact allocator object`,
        );
      }
      return;
    }
    const planned = planProgramAbiUnitCallable(this.ctx, {
      ref: irUnitFuncRef({ unitId, name: func.name }),
      signature: functionSignature(this.ctx, func),
      func,
    });
    if (planned !== bindingId) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `retained module initializer was not accepted for exact unit ${unitId}`,
      );
    }
  }
}
