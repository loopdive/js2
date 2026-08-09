// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irSupportGlobalRef } from "../ir/abi-bindings.js";
import { irSupportFuncRef, irUnitCallableBindingId, irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrBindingId, IrUnitId } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncHandle, FuncTypeDef, GlobalDef, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, pushDefinedFunc } from "./func-space.js";
import {
  planProgramAbiFunctionValue,
  planProgramAbiSupportCallable,
  planProgramAbiUnitCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
} from "./program-abi-planning.js";
import type { ProgramAbiSession } from "./program-abi-session.js";
import { localGlobalIdx } from "./registry/imports.js";

interface SourceCallableObservation {
  readonly unitId: IrUnitId;
  readonly displayName: string;
  readonly funcIdx: FuncHandle;
  readonly func: WasmFunction;
}

interface SourceSupportCallableObservation {
  readonly bindingId: IrBindingId;
  readonly unitId: IrUnitId;
  readonly displayName: string;
  readonly func: WasmFunction;
}

interface SourceFunctionValueObservation {
  readonly unitId: IrUnitId;
  readonly trampoline: WasmFunction;
  readonly cacheGlobal?: GlobalDef;
}

const TYPED_THIS_TWIN_ROLE = "typed-this-twin";
const FUNCTION_VALUE_TRAMPOLINE_ROLE = "function-value-trampoline";
const FUNCTION_VALUE_CACHE_ROLE = "function-value-cache";

type SourceCallableDeclaration =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** Push and structurally observe one top-level source function atomically. */
export function pushProgramAbiTopLevelCallable(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  funcIdx: FuncHandle,
  func: WasmFunction,
): void {
  pushDefinedFunc(ctx, funcIdx, func);
  const registry = ctx.programAbiSourceCallables;
  if (!registry) {
    throw new ProgramAbiInvariantError(
      "context-session-mismatch",
      "top-level source callable was allocated without its structural registry",
    );
  }
  registry.observe(declaration, funcIdx);
}

/** Push and structurally observe one nested source callable atomically. */
export function pushProgramAbiNestedCallable(
  ctx: CodegenContext,
  declaration: SourceCallableDeclaration,
  funcIdx: FuncHandle,
  func: WasmFunction,
): void {
  pushDefinedFunc(ctx, funcIdx, func);
  const registry = ctx.programAbiSourceCallables;
  if (!registry) {
    throw new ProgramAbiInvariantError(
      "context-session-mismatch",
      "nested source callable was allocated without its structural registry",
    );
  }
  // Some legacy compatibility paths feed a top-level function declaration
  // through the closure/callback compiler to build a separate adapter body.
  // The declaration's original direct body already owns its source-unit ABI
  // slot; observing the adapter as the same unit would make last-observation
  // planning steal that slot from the direct body.
  //
  // Literal-eval and other compiler support paths can likewise create callable
  // AST nodes after the whole-program inventory was frozen. Those are support
  // bodies, not retained source-unit allocators. Keep them on generic callable
  // planning until their own synthetic identities are introduced.
  if (ts.isFunctionDeclaration(declaration) || !registry.identityContext?.unitIdByDeclaration.has(declaration)) {
    return;
  }
  registry.observe(declaration, funcIdx);
}

/** Push and structurally observe one admitted typed-`this` support twin atomically. */
export function pushProgramAbiTypedThisTwin(
  ctx: CodegenContext,
  declaration: ts.FunctionExpression | ts.ArrowFunction,
  funcIdx: FuncHandle,
  func: WasmFunction,
): void {
  pushDefinedFunc(ctx, funcIdx, func);
  if (!ts.isFunctionExpression(declaration)) {
    throw new ProgramAbiInvariantError(
      "missing-source-unit",
      `typed-this twin ${func.name} does not have a function-expression source owner`,
    );
  }
  const registry = ctx.programAbiSourceCallables;
  if (!registry?.identityContext?.unitIdByDeclaration.has(declaration)) return;
  registry.observeTypedThisTwin(declaration, funcIdx);
}

/** Push and structurally observe one nested function declaration atomically. */
export function pushProgramAbiNestedFunctionDeclaration(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  funcIdx: FuncHandle,
  func: WasmFunction,
): void {
  pushDefinedFunc(ctx, funcIdx, func);
  const registry = ctx.programAbiSourceCallables;
  if (!registry) {
    throw new ProgramAbiInvariantError(
      "context-session-mismatch",
      "nested function declaration was allocated without its structural registry",
    );
  }
  // Literal-eval and other compiler support paths can create function
  // declarations after the whole-program inventory was frozen. They remain
  // generic support callables until synthetic identities are introduced.
  if (!registry.identityContext?.unitIdByDeclaration.has(declaration)) {
    return;
  }
  registry.observeNestedFunctionDeclaration(declaration, funcIdx);
}

/**
 * Structurally observe one retained direct function-value trampoline and its
 * optional singleton cache.
 *
 * Capturing nested declarations memoize the closure instance in an activation
 * local and therefore have no module-global cache. Capture-free direct values
 * keep the existing lazy module-global singleton pair.
 */
export function observeProgramAbiFunctionValue(
  ctx: CodegenContext,
  targetFuncIdx: FuncHandle,
  trampolineFuncIdx: FuncHandle,
  cacheGlobalIdx?: number,
): void {
  const registry = ctx.programAbiSourceCallables;
  if (!registry) {
    throw new ProgramAbiInvariantError(
      "context-session-mismatch",
      "function-value trampoline was allocated without its structural registry",
    );
  }
  const cacheGlobal = cacheGlobalIdx === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, cacheGlobalIdx)];
  if (cacheGlobalIdx !== undefined && !cacheGlobal) {
    throw new ProgramAbiInvariantError(
      "missing-required-locator",
      `function-value cache has no exact defined global for index ${cacheGlobalIdx}`,
    );
  }
  registry.observeFunctionValue(targetFuncIdx, trampolineFuncIdx, cacheGlobal);
}

function functionSignature(ctx: CodegenContext, func: WasmFunction): FuncTypeDef {
  const signature = ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `source callable ${func.name} references non-function or missing type ${func.typeIdx}`,
    );
  }
  return signature;
}

function expectedSourceCallableUnitKind(declaration: SourceCallableDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(declaration)) return undefined;
  if (ts.isFunctionExpression(declaration)) return "function-expression";
  if (ts.isArrowFunction(declaration)) return "arrow-function";
  if (ts.isMethodDeclaration(declaration)) return "object-method";
  if (ts.isGetAccessorDeclaration(declaration)) return "object-getter";
  if (ts.isSetAccessorDeclaration(declaration)) return "object-setter";
  return undefined;
}

/**
 * Exact allocator sidecar for source function declarations and expressions.
 *
 * The sidecar exists without a Program ABI session so IR integration never
 * needs to recover a source slot from funcMap. With an identity inventory,
 * every retained direct or IR-replaced allocator receives its exact source
 * unit owner before generic final function-space population.
 */
export class ProgramAbiSourceCallableRegistry {
  private readonly observations = new Map<IrUnitId, SourceCallableObservation[]>();
  private readonly supports = new Map<IrBindingId, SourceSupportCallableObservation[]>();
  private readonly functionValues = new Map<IrUnitId, SourceFunctionValueObservation[]>();
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
        "source-callable registry cannot accept a planning identity context without a Program ABI session",
      );
    }
    if (session && identityContext && identityContext.inventory !== session.inventory) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "source-callable registry and planning context do not share one inventory",
      );
    }
  }

  observe(declaration: SourceCallableDeclaration, funcIdx: FuncHandle): IrUnitId | undefined {
    return this.observeWithExpectedKind(declaration, funcIdx, expectedSourceCallableUnitKind(declaration));
  }

  observeNestedFunctionDeclaration(declaration: ts.FunctionDeclaration, funcIdx: FuncHandle): IrUnitId | undefined {
    return this.observeWithExpectedKind(declaration, funcIdx, "nested-function");
  }

  observeTypedThisTwin(declaration: ts.FunctionExpression, funcIdx: FuncHandle): IrBindingId | undefined {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot observe a typed-this twin after retained source-callable planning",
      );
    }
    const func = definedFuncAt(this.ctx, funcIdx);
    if (!func) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `typed-this twin has no exact defined function for handle ${funcIdx}`,
      );
    }
    const identityContext = this.identityContext;
    if (!identityContext) return undefined;
    const unitId = identityContext.unitIdByDeclaration.get(declaration);
    const unit = unitId === undefined ? undefined : identityContext.unitByUnitId.get(unitId);
    if (
      unitId === undefined ||
      !unit ||
      unit.kind !== "function-expression" ||
      identityContext.declarationByUnitId.get(unitId) !== declaration
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `typed-this twin ${func.name} has no consistent exact function-expression inventory owner`,
      );
    }
    const ref = irSupportFuncRef(unitId, TYPED_THIS_TWIN_ROLE, func.name);
    if (ref.binding.kind !== "support") {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `typed-this twin ${func.name} did not produce a support binding`,
      );
    }
    const bindingId = ref.binding.bindingId;
    const observations = this.supports.get(bindingId) ?? [];
    const previous = observations.at(-1);
    if (previous?.func !== func || previous.displayName !== func.name) {
      observations.push(Object.freeze({ bindingId, unitId, displayName: func.name, func }));
      this.supports.set(bindingId, observations);
    }
    return bindingId;
  }

  observeFunctionValue(
    targetFuncIdx: FuncHandle,
    trampolineFuncIdx: FuncHandle,
    cacheGlobal?: GlobalDef,
  ): IrUnitId | undefined {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot observe a function-value trampoline after retained source-callable planning",
      );
    }
    const target = definedFuncAt(this.ctx, targetFuncIdx);
    const trampoline = definedFuncAt(this.ctx, trampolineFuncIdx);
    if (!target || !trampoline) return undefined;

    const unitId = this.unitForFunction(target);
    if (unitId === undefined) return undefined;
    if (cacheGlobal === undefined && !trampoline.name.startsWith("__fn_tramp_")) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `function-value trampoline ${trampoline.name} has no recognized direct-wrapper identity`,
      );
    }

    const observations = this.functionValues.get(unitId) ?? [];
    const previous = observations.at(-1);
    if (previous?.trampoline !== trampoline || previous.cacheGlobal !== cacheGlobal) {
      observations.push(
        Object.freeze(cacheGlobal === undefined ? { unitId, trampoline } : { unitId, trampoline, cacheGlobal }),
      );
      this.functionValues.set(unitId, observations);
    }
    return unitId;
  }

  private observeWithExpectedKind(
    declaration: SourceCallableDeclaration,
    funcIdx: FuncHandle,
    expectedKind: string | undefined,
  ): IrUnitId | undefined {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot observe a source callable after retained source-callable planning",
      );
    }
    const func = definedFuncAt(this.ctx, funcIdx);
    if (!func) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `source callable has no exact defined function for handle ${funcIdx}`,
      );
    }
    const identityContext = this.identityContext;
    if (!identityContext) return undefined;

    const unitId = identityContext.unitIdByDeclaration.get(declaration);
    const unit = unitId === undefined ? undefined : identityContext.unitByUnitId.get(unitId);
    const supportedUnit = expectedKind
      ? unit?.kind === expectedKind
      : unit?.kind === "top-level-function" || (unit?.kind === "synthetic-support" && unit.syntheticRole !== undefined);
    if (
      unitId === undefined ||
      !unit ||
      !supportedUnit ||
      identityContext.declarationByUnitId.get(unitId) !== declaration
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        expectedKind === "nested-function"
          ? `source callable ${func.name} has no consistent exact nested-function inventory owner`
          : ts.isFunctionDeclaration(declaration)
            ? `source callable ${func.name} has no consistent exact top-level or compiler-support inventory owner`
            : `source callable ${func.name} has no consistent exact nested callable inventory owner`,
      );
    }

    const observations = this.observations.get(unitId) ?? [];
    const previous = observations.at(-1);
    if (previous?.funcIdx !== funcIdx || previous.displayName !== func.name) {
      observations.push(Object.freeze({ unitId, displayName: func.name, funcIdx, func }));
      this.observations.set(unitId, observations);
    }
    return unitId;
  }

  functionForUnit(unitId: IrUnitId): WasmFunction | undefined {
    const observation = this.observations.get(unitId)?.at(-1);
    return observation ? definedFuncAt(this.ctx, observation.funcIdx) : undefined;
  }

  handleForUnit(unitId: IrUnitId): FuncHandle | undefined {
    const observation = this.observations.get(unitId)?.at(-1);
    return observation && definedFuncAt(this.ctx, observation.funcIdx) ? observation.funcIdx : undefined;
  }

  private unitForFunction(func: WasmFunction): IrUnitId | undefined {
    let match: IrUnitId | undefined;
    for (const [unitId, observations] of this.observations) {
      if (
        !observations.some(
          (observation) => observation.func === func || definedFuncAt(this.ctx, observation.funcIdx) === func,
        )
      ) {
        continue;
      }
      if (match !== undefined && match !== unitId) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `source function ${func.name} was observed beneath multiple exact source units`,
        );
      }
      match = unitId;
    }
    return match;
  }

  /** Assign exact source-unit owners before generic retained callable planning. */
  planRetained(): void {
    if (this.planned) return;
    this.planned = true;
    const { session, identityContext } = this;
    if (!session || !identityContext) return;

    const live = new Set(this.ctx.mod.functions);
    for (const [unitId, observations] of this.observations) {
      const canonical = observations
        .map((observation) => ({ observation, func: definedFuncAt(this.ctx, observation.funcIdx) }))
        .filter((entry): entry is { observation: SourceCallableObservation; func: WasmFunction } => !!entry.func)
        .at(-1);
      if (!canonical) continue;

      const expectedBindingId = irUnitCallableBindingId(unitId);
      if (session.hasPlan(expectedBindingId)) {
        if (!session.hasLocator(expectedBindingId, canonical.func)) {
          throw new ProgramAbiInvariantError(
            "duplicate-slot-locator",
            `retained source callable ${canonical.observation.displayName} is not the exact allocator owned by ${expectedBindingId}`,
          );
        }
        continue;
      }
      const bindingId = planProgramAbiUnitCallable(this.ctx, {
        ref: irUnitFuncRef({ unitId, name: canonical.observation.displayName }),
        signature: functionSignature(this.ctx, canonical.func),
        func: canonical.func,
      });
      if (bindingId !== expectedBindingId) {
        throw new ProgramAbiInvariantError(
          "missing-source-unit",
          `retained source callable ${canonical.observation.displayName} was not accepted for exact unit ${unitId}`,
        );
      }
    }

    const liveGlobals = new Set(this.ctx.mod.globals);
    for (const [unitId, observations] of this.functionValues) {
      const canonical = observations
        .filter(
          (observation) =>
            live.has(observation.trampoline) &&
            (observation.cacheGlobal === undefined || liveGlobals.has(observation.cacheGlobal)),
        )
        .at(-1);
      if (!canonical) continue;

      const trampoline = irSupportFuncRef(unitId, FUNCTION_VALUE_TRAMPOLINE_ROLE, canonical.trampoline.name);
      if (trampoline.binding.kind !== "support") {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `function-value trampoline ${canonical.trampoline.name} did not produce a support binding`,
        );
      }
      const cacheGlobal = canonical.cacheGlobal
        ? irSupportGlobalRef(unitId, FUNCTION_VALUE_CACHE_ROLE, canonical.cacheGlobal.name)
        : undefined;
      if (session.hasPlan(trampoline.binding.bindingId)) {
        if (!session.hasLocator(trampoline.binding.bindingId, canonical.trampoline)) {
          throw new ProgramAbiInvariantError(
            "duplicate-slot-locator",
            `retained function-value trampoline ${canonical.trampoline.name} is not the exact allocator owned by ${trampoline.binding.bindingId}`,
          );
        }
        if (
          cacheGlobal &&
          (!session.hasPlan(cacheGlobal.binding.bindingId) ||
            !session.hasLocator(cacheGlobal.binding.bindingId, canonical.cacheGlobal!))
        ) {
          throw new ProgramAbiInvariantError(
            "duplicate-slot-locator",
            `retained function-value cache ${canonical.cacheGlobal!.name} is not the exact allocator owned by ${cacheGlobal.binding.bindingId}`,
          );
        }
        continue;
      }
      if (cacheGlobal) {
        const planned = planProgramAbiFunctionValue(
          this.ctx,
          {
            target: irUnitFuncRef({ unitId, name: this.observations.get(unitId)?.at(-1)?.displayName ?? "source" }),
            trampoline,
            cacheGlobal,
          },
          canonical.trampoline,
          canonical.cacheGlobal!,
        );
        if (!planned) {
          throw new ProgramAbiInvariantError(
            "invalid-binding-reference",
            `retained function-value singleton ${canonical.trampoline.name} was not accepted for exact unit ${unitId}`,
          );
        }
      } else {
        planProgramAbiSupportCallable(this.ctx, {
          ref: trampoline,
          anchor: { kind: "unit", unitId },
          role: FUNCTION_VALUE_TRAMPOLINE_ROLE,
          roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.functionValueTrampoline,
          signature: functionSignature(this.ctx, canonical.trampoline),
          func: canonical.trampoline,
        });
      }
    }

    for (const [bindingId, observations] of this.supports) {
      const canonical = observations.filter((observation) => live.has(observation.func)).at(-1);
      if (!canonical) continue;
      if (session.hasPlan(bindingId)) {
        if (!session.hasLocator(bindingId, canonical.func)) {
          throw new ProgramAbiInvariantError(
            "duplicate-slot-locator",
            `retained typed-this twin ${canonical.displayName} is not the exact allocator owned by ${bindingId}`,
          );
        }
        continue;
      }
      const ref = irSupportFuncRef(canonical.unitId, TYPED_THIS_TWIN_ROLE, canonical.displayName);
      const plannedBindingId = planProgramAbiSupportCallable(this.ctx, {
        ref,
        anchor: { kind: "unit", unitId: canonical.unitId },
        role: TYPED_THIS_TWIN_ROLE,
        roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.typedThisTwin,
        signature: functionSignature(this.ctx, canonical.func),
        func: canonical.func,
      });
      if (plannedBindingId !== bindingId) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `retained typed-this twin ${canonical.displayName} was not accepted for ${bindingId}`,
        );
      }
    }
  }
}
