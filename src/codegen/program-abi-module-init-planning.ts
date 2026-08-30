// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irSupportFuncRef, irUnitCallableBindingId, irUnitFuncRef } from "../ir/callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrSourceId, type IrUnitId } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncHandle, FuncTypeDef, Instr, WasmExport, WasmFunction } from "../ir/types.js";
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
const MODULE_INIT_EXPORT_NAME = "__module_init";
/** Mirrors `ProgramAbiExportCallableRegistry`'s export-alias binding role. */
const MODULE_VALUE_EXPORT_ROLE = "module-value-export";

type ModuleInitInvocationPolicy = "deferred-export" | "wasm-start" | "wasi-start-export";

function moduleInitInvocationPolicy(ctx: CodegenContext): ModuleInitInvocationPolicy {
  if (ctx.wasi) return "wasi-start-export";
  return ctx.deferTopLevelInit ? "deferred-export" : "wasm-start";
}

/** Find the first statically emitted direct call in an adapter/body. */
function firstCallTarget(body: readonly Instr[]): FuncHandle | undefined {
  for (const instruction of body) {
    if (instruction.op === "call" || instruction.op === "return_call") return instruction.funcIdx;
    if (instruction.op === "block" || instruction.op === "loop") {
      const target = firstCallTarget(instruction.body);
      if (target !== undefined) return target;
    } else if (instruction.op === "if") {
      const target = firstCallTarget(instruction.then);
      if (target !== undefined) return target;
      const elseTarget = instruction.else === undefined ? undefined : firstCallTarget(instruction.else);
      if (elseTarget !== undefined) return elseTarget;
    } else if (instruction.op === "try") {
      const target = firstCallTarget(instruction.body);
      if (target !== undefined) return target;
      for (const clause of instruction.catches) {
        const catchTarget = firstCallTarget(clause.body);
        if (catchTarget !== undefined) return catchTarget;
      }
      const catchAllTarget = instruction.catchAll === undefined ? undefined : firstCallTarget(instruction.catchAll);
      if (catchAllTarget !== undefined) return catchAllTarget;
    } else if (instruction.op === "try_table") {
      const target = firstCallTarget(instruction.body);
      if (target !== undefined) return target;
    }
  }
  return undefined;
}

/** Count only direct calls to one exact allocator-owned function object. */
function countCallsTo(ctx: CodegenContext, body: readonly Instr[], target: WasmFunction): number {
  let count = 0;
  const visit = (instructions: readonly Instr[]): void => {
    for (const instruction of instructions) {
      if (
        (instruction.op === "call" || instruction.op === "return_call") &&
        definedFuncAt(ctx, instruction.funcIdx) === target
      ) {
        count++;
      }
      if (instruction.op === "block" || instruction.op === "loop") visit(instruction.body);
      else if (instruction.op === "if") {
        visit(instruction.then);
        if (instruction.else !== undefined) visit(instruction.else);
      } else if (instruction.op === "try") {
        visit(instruction.body);
        for (const clause of instruction.catches) visit(clause.body);
        if (instruction.catchAll !== undefined) visit(instruction.catchAll);
      } else if (instruction.op === "try_table") {
        visit(instruction.body);
      }
    }
  };
  visit(body);
  return count;
}

interface ModuleInitCallableObservation {
  readonly ordinal: number;
  readonly unitId?: IrUnitId;
  readonly funcIdx: FuncHandle;
  /** Allocator object observed at the handle before any later slot mutation. */
  readonly func: WasmFunction;
}

interface NamedExportObservation {
  readonly entry: WasmExport;
  readonly ordinal: number;
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
 * With an identity inventory, every source retains its semantic module-init
 * unit. The legacy multi-source scheduler nevertheless emits one physical,
 * graph-global initializer on the final scheduled source. Until R5 gives that
 * whole-program body its own prepared unit, the physical function is retained
 * as the single unitless `legacy-module-init-pass` compatibility callable.
 */
export class ProgramAbiModuleInitCallableRegistry {
  private readonly observations: ModuleInitCallableObservation[] = [];
  private planned = false;
  private preparedExactUnitId?: IrUnitId;
  private preparedExactFunction?: WasmFunction;
  private preparedExactHandle?: FuncHandle;
  private graphGlobalPass?: {
    readonly bindingId: IrBindingId;
    readonly handle: FuncHandle;
    readonly func: WasmFunction;
    readonly entrySourceId: IrSourceId;
    readonly invocation: ModuleInitInvocationPolicy;
  };
  private wasiStartAdapter?: {
    readonly func: WasmFunction;
    readonly target: WasmFunction;
  };

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
        func,
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
    const observation = this.uniqueObservationForUnit(unitId);
    return observation ? definedFuncAt(this.ctx, observation.funcIdx) : undefined;
  }

  handleForUnit(unitId: IrUnitId): FuncHandle | undefined {
    const observation = this.uniqueObservationForUnit(unitId);
    return observation && definedFuncAt(this.ctx, observation.funcIdx) ? observation.funcIdx : undefined;
  }

  /**
   * Select one exact source-owned module-init slot for Prepared lowering.
   *
   * This is intentionally separate from `planRetained()`: a multi-source
   * inventory has several module-init units, so the generic retained sweep
   * cannot infer the Prepared owner from source count or observation order.
   */
  reservePreparedExactUnit(unitId: IrUnitId): void {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        `cannot reserve Prepared module-init unit ${unitId} after retained planning`,
      );
    }
    if (!this.session || !this.identityContext) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        `Prepared module-init unit ${unitId} requires an identity-bound Program ABI session`,
      );
    }
    if (this.preparedExactUnitId !== undefined) {
      if (this.preparedExactUnitId !== unitId) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `Prepared module-init selected both ${this.preparedExactUnitId} and ${unitId}`,
        );
      }
      return;
    }
    const terminal = this.identityContext.terminalByUnitId.get(unitId);
    const sourceFile = terminal ? this.identityContext.sourceFileBySourceId.get(terminal.sourceId) : undefined;
    if (
      !terminal ||
      terminal.kind !== "module-init" ||
      terminal.observedKind !== "module-init" ||
      terminal.terminalOwnerId !== unitId ||
      sourceFile === undefined ||
      this.identityContext.moduleInitUnitIdBySourceFile.get(sourceFile) !== unitId
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `Prepared module-init unit ${unitId} is not an exact source-owned terminal`,
      );
    }
    const observation = this.uniqueObservationForUnit(unitId);
    const func = observation ? definedFuncAt(this.ctx, observation.funcIdx) : undefined;
    if (!observation || !func) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `Prepared module-init unit ${unitId} has no unique preallocated callable`,
      );
    }
    const signature = functionSignature(this.ctx, func);
    if (signature.params.length !== 0 || signature.results.length !== 0) {
      throw new ProgramAbiInvariantError(
        "alias-signature-mismatch",
        `Prepared module-init unit ${unitId} must use the exact [] -> [] ABI`,
      );
    }
    this.preparedExactUnitId = unitId;
    this.preparedExactFunction = func;
    this.preparedExactHandle = observation.funcIdx;
  }

  get preparedExactUnit(): IrUnitId | undefined {
    return this.preparedExactUnitId;
  }

  get preparedExactFunctionObject(): WasmFunction | undefined {
    return this.preparedExactFunction;
  }

  get preparedExactHandleValue(): FuncHandle | undefined {
    return this.preparedExactHandle;
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

  /**
   * Record the exact WASI adapter and target selected by the emitter.
   *
   * `_start` is built late and its target can be either the graph initializer
   * or an exported, guard-prefixed entry function. Recording the allocator
   * objects at construction time lets finalization authenticate that exact
   * path after late function-index shifts, without treating a display name or
   * the last function position as ownership evidence.
   */
  observeWasiStartAdapter(func: WasmFunction, targetHandle: FuncHandle): void {
    if (this.wasiStartAdapter) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        "WASI module-init startup adapter was observed more than once",
      );
    }
    const target = definedFuncAt(this.ctx, targetHandle);
    if (!target) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `WASI module-init startup adapter target ${targetHandle} is not an exact defined callable`,
      );
    }
    this.wasiStartAdapter = Object.freeze({ func, target });
  }

  /** Assign semantic owners before generic retained-callable population. */
  planRetained(): void {
    if (this.planned) return;
    this.planned = true;
    const { session, identityContext } = this;
    if (!session || !identityContext) return;

    const liveObservations = this.observations.flatMap((observation) => {
      const func = definedFuncAt(this.ctx, observation.funcIdx);
      if (!func) {
        throw new ProgramAbiInvariantError(
          "missing-required-locator",
          `module-init observation ${observation.ordinal} has no defined function for exact handle ${observation.funcIdx}`,
        );
      }
      // Source-owned/prepared units may legitimately receive a later IR body
      // replacement; that path updates the Program-ABI locator transactionally
      // in integration. The unitless graph-global pass has no such source
      // replacement owner, so its observation must remain the exact allocator
      // object captured at push time. This is the identity that prevents a
      // handle-retarget mutation from becoming a new pass by coincidence.
      const sourceUnitReplacementIsReconciled =
        observation.unitId !== undefined &&
        this.session !== undefined &&
        this.session.hasLocator(irUnitCallableBindingId(observation.unitId), func);
      if (func !== observation.func && !sourceUnitReplacementIsReconciled) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `module-init observation ${observation.ordinal} handle ${observation.funcIdx} was retargeted away from its exact observed allocator object`,
        );
      }
      return [{ observation, func }];
    });
    const moduleInitUnitIds = [...identityContext.moduleInitUnitIdBySourceId.values()];
    // M2 explicitly reserves its chosen unit before this generic sweep. The
    // single-unit compatibility path remains exact, but never guesses from
    // the last physical observation in a multi-source graph.
    const exactUnitId = this.preparedExactUnitId ?? (moduleInitUnitIds.length === 1 ? moduleInitUnitIds[0] : undefined);
    const exactObservation = exactUnitId
      ? liveObservations.find(({ observation }) => observation.unitId === exactUnitId)?.observation
      : undefined;
    if (this.preparedExactUnitId !== undefined) {
      const exactMatches = liveObservations.filter(
        ({ observation }) => observation.unitId === this.preparedExactUnitId,
      );
      if (
        exactMatches.length !== 1 ||
        exactObservation === undefined ||
        exactMatches[0]!.func !== this.preparedExactFunction ||
        exactMatches[0]!.observation.funcIdx !== this.preparedExactHandle
      ) {
        throw new ProgramAbiInvariantError(
          "duplicate-slot-locator",
          `Prepared module-init unit ${this.preparedExactUnitId} lost its exact retained callable`,
        );
      }
    }
    const entrySourceId = canonicalEntrySource(session);

    const isExact = (observation: ModuleInitCallableObservation): boolean =>
      exactUnitId !== undefined && exactObservation !== undefined && observation === exactObservation;
    for (const { observation, func } of liveObservations) {
      if (isExact(observation)) this.planExactUnit(exactUnitId!, func);
    }

    // The graph-global (legacy multi-source) pass is ONE physical initializer
    // emitted on the final scheduled source, reached by exactly one selected
    // startup policy. The loop this replaced planned one support callable per
    // surviving observation at that observation's ordinal, so it silently
    // accepted a graph with no live pass at all, with several passes, and with
    // a pass published at ordinal 1+ — none of which a startup adapter can
    // describe. Bound the population exactly instead: one raw observation, one
    // live observation, the same observation, ordinal zero.
    const graphGlobalRaw = this.observations.filter((observation) => !isExact(observation));
    const graphGlobalLive = liveObservations.filter(({ observation }) => !isExact(observation));
    // `mod.hasTopLevelStatements` is set by the declaration emitter from the
    // actual accumulated initializer body. It is deliberately independent of
    // this observation list: otherwise clearing the list would make the check
    // see its own empty input and pass. A one-source module has its exact
    // source-owned unit; a reserved Prepared unit has the same exemption. All
    // other executable multi-source graphs have the unitless graph-global pass
    // regardless of whether initialization is deferred, a Wasm start, or WASI.
    const hasActualInitializer = this.ctx.mod.hasTopLevelStatements === true;
    const hasExactSourceUnit = exactUnitId !== undefined;
    const requiresGraphGlobalPass =
      hasActualInitializer && !hasExactSourceUnit && this.preparedExactUnitId === undefined;
    if (!hasActualInitializer) {
      if (graphGlobalRaw.length !== 0 || graphGlobalLive.length !== 0) {
        throw new ProgramAbiInvariantError(
          "invalid-binding-reference",
          `module-init observations exist without an emitted initializer (${graphGlobalRaw.length} raw, ${graphGlobalLive.length} live)`,
        );
      }
      return;
    }
    if (!requiresGraphGlobalPass && graphGlobalRaw.length === 0 && graphGlobalLive.length === 0) return;
    if (!requiresGraphGlobalPass && this.preparedExactUnitId !== undefined) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `Prepared module-init ${this.preparedExactUnitId} has an unexpected graph-global callable population`,
      );
    }
    const raw = graphGlobalRaw[0];
    const live = graphGlobalLive[0];
    if (
      graphGlobalRaw.length !== 1 ||
      graphGlobalLive.length !== 1 ||
      raw === undefined ||
      live === undefined ||
      live.observation !== raw ||
      raw.ordinal !== 0
    ) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `graph-global module-init requires exactly one live pass at ordinal 0, found ${graphGlobalRaw.length} raw and ${graphGlobalLive.length} live at ordinals [${graphGlobalRaw.map((observation) => observation.ordinal).join(",")}]`,
      );
    }
    const func = live.func;
    const ref = irSupportFuncRef(entrySourceId, LEGACY_MODULE_INIT_PASS_ROLE, func.name, raw.ordinal);
    const bindingId =
      ref.binding.kind === "support"
        ? planProgramAbiSupportCallable(this.ctx, {
            ref,
            anchor: { kind: "source", sourceId: entrySourceId },
            role: LEGACY_MODULE_INIT_PASS_ROLE,
            roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.moduleInit,
            derivedOrdinal: raw.ordinal,
            signature: functionSignature(this.ctx, func),
            func,
          })
        : undefined;
    if (ref.binding.kind !== "support" || bindingId !== ref.binding.bindingId) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `legacy module-init pass ${raw.ordinal} was not accepted by Program ABI planning`,
      );
    }
    if (!session.hasPlan(bindingId) || !session.hasLocator(bindingId, func)) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `graph-global module-init pass ${raw.ordinal} is not retained on its exact allocator object`,
      );
    }
    this.graphGlobalPass = Object.freeze({
      bindingId,
      handle: raw.funcIdx,
      func,
      entrySourceId,
      invocation: moduleInitInvocationPolicy(this.ctx),
    });
  }

  /**
   * Authenticate the one startup policy selected for the graph-global pass.
   *
   * Export aliases are raised by `ProgramAbiExportRegistry.planRetained`, which
   * runs after this registry. This final check therefore proves both halves of
   * the invariant: the pass is retained on its allocator object and the one
   * actual invocation adapter reaches that same object. All function handles
   * are resolved through `func-space`; names and function-array positions are
   * diagnostic labels only, never ownership evidence.
   */
  assertGraphGlobalInvocationPolicy(): void {
    const pass = this.graphGlobalPass;
    const session = this.session;
    if (!pass || !session) return;
    if (definedFuncAt(this.ctx, pass.handle) !== pass.func) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `graph-global module-init pass zero ${pass.bindingId} lost its exact allocator handle ${pass.handle}`,
      );
    }

    const initExports: NamedExportObservation[] = this.ctx.mod.exports.flatMap((entry, ordinal) =>
      entry.name === MODULE_INIT_EXPORT_NAME ? [{ entry, ordinal }] : [],
    );
    const exactExportTarget = (entry: NamedExportObservation): WasmFunction | undefined =>
      entry.entry.desc.kind === "func" ? definedFuncAt(this.ctx, entry.entry.desc.index) : undefined;

    // A source program may legitimately export a user function named
    // `__module_init`. Under the non-deferred policies that source export is
    // not the compiler's graph-global startup alias and must remain visible.
    // Authenticate it through the exact allocator locator and the export draft
    // raised for this ordinal; a display name alone cannot distinguish it from
    // the compiler pass. Any unplanned row or row targeting the graph pass is
    // rejected before the policy-specific startup check can pass.
    const assertNoCompilerGraphAlias = (): void => {
      if (initExports.length === 0) return;
      if (initExports.length !== 1) {
        throw new ProgramAbiInvariantError(
          "invalid-export-target",
          `non-deferred graph-global module-init allows at most one source-owned ${MODULE_INIT_EXPORT_NAME} export, found ${initExports.length}`,
        );
      }
      const row = initExports[0]!;
      const physicalTarget = exactExportTarget(row);
      const targetBindingId = physicalTarget === undefined ? undefined : session.locatorBindingId(physicalTarget);
      const exportBindingId = createIrBindingId({
        ownerId: pass.entrySourceId,
        domain: "export",
        role: MODULE_VALUE_EXPORT_ROLE,
        ordinal: row.ordinal,
      });
      const draft = session.getDraft(exportBindingId);
      const targetDraft = targetBindingId === undefined ? undefined : session.getDraft(targetBindingId);
      const aliasesGraphPass =
        physicalTarget === pass.func ||
        targetBindingId === pass.bindingId ||
        draft?.aliasOf === pass.bindingId ||
        (draft?.intent.kind === "export" && draft.intent.targetId === pass.bindingId);
      if (aliasesGraphPass) {
        throw new ProgramAbiInvariantError(
          "invalid-export-target",
          `non-deferred graph-global module-init must not publish a compiler ${MODULE_INIT_EXPORT_NAME} alias to pass zero ${pass.bindingId}`,
        );
      }
      const sourceOwned =
        physicalTarget !== undefined &&
        targetBindingId !== undefined &&
        targetDraft !== undefined &&
        targetDraft.slotPolicy === "required" &&
        targetDraft.intent.kind === "callable" &&
        targetDraft.intent.origin === "source" &&
        targetDraft.intent.unitId !== undefined &&
        draft !== undefined &&
        draft.slotPolicy === "alias" &&
        draft.aliasOf === targetBindingId &&
        draft.intent.kind === "export" &&
        draft.intent.externalName === MODULE_INIT_EXPORT_NAME &&
        draft.intent.targetId === targetBindingId;
      if (!sourceOwned) {
        throw new ProgramAbiInvariantError(
          "invalid-export-target",
          `non-deferred graph-global ${MODULE_INIT_EXPORT_NAME} export is not a legitimate source-owned Program-ABI alias`,
        );
      }
    };

    switch (pass.invocation) {
      case "deferred-export": {
        if (this.ctx.mod.startFuncIdx !== undefined) {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            `deferred graph-global module-init must not install a Wasm start adapter (found ${this.ctx.mod.startFuncIdx})`,
          );
        }
        if (initExports.length !== 1 || initExports[0]!.entry.desc.kind !== "func") {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            `graph-global module-init expects exactly one public ${MODULE_INIT_EXPORT_NAME} export, found ${initExports.length}`,
          );
        }
        const exportRow = initExports[0]!;
        const physicalTarget = exactExportTarget(exportRow);
        const exportBindingId = createIrBindingId({
          ownerId: pass.entrySourceId,
          domain: "export",
          role: MODULE_VALUE_EXPORT_ROLE,
          ordinal: exportRow.ordinal,
        });
        const draft = session.getDraft(exportBindingId);
        if (
          physicalTarget !== pass.func ||
          !draft ||
          draft.slotPolicy !== "alias" ||
          draft.aliasOf !== pass.bindingId ||
          draft.intent.kind !== "export" ||
          draft.intent.externalName !== MODULE_INIT_EXPORT_NAME ||
          draft.intent.targetId !== pass.bindingId
        ) {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            `public ${MODULE_INIT_EXPORT_NAME} is not the exact alias of graph-global pass zero ${pass.bindingId}`,
          );
        }
        return;
      }

      case "wasm-start": {
        assertNoCompilerGraphAlias();
        const startHandle = this.ctx.mod.startFuncIdx;
        const startTarget = startHandle === undefined ? undefined : definedFuncAt(this.ctx, startHandle);
        if (startHandle === undefined || startTarget !== pass.func) {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            `Wasm-start graph-global module-init must target pass zero ${pass.bindingId} through its exact handle`,
          );
        }
        return;
      }

      case "wasi-start-export": {
        if (this.ctx.mod.startFuncIdx !== undefined) {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            `WASI graph-global module-init must not install a Wasm start adapter (found ${this.ctx.mod.startFuncIdx})`,
          );
        }
        assertNoCompilerGraphAlias();
        const startExports = this.ctx.mod.exports.flatMap((entry, ordinal) =>
          entry.name === "_start" ? [{ entry, ordinal }] : [],
        );
        const adapter = this.wasiStartAdapter;
        if (startExports.length !== 1 || startExports[0]!.entry.desc.kind !== "func" || !adapter) {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            `WASI graph-global module-init expects exactly one observed _start adapter, found ${startExports.length}`,
          );
        }
        const startExport = startExports[0]!;
        const startFunction = definedFuncAt(this.ctx, startExport.entry.desc.index);
        if (startFunction !== adapter.func) {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            "WASI _start export does not resolve to its exact allocator-owned adapter",
          );
        }
        const adapterTargetHandle = firstCallTarget(adapter.func.body);
        const adapterTarget =
          adapterTargetHandle === undefined ? undefined : definedFuncAt(this.ctx, adapterTargetHandle);
        if (adapterTarget !== adapter.target || countCallsTo(this.ctx, adapter.func.body, adapter.target) !== 1) {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            "WASI _start adapter does not retain its exact selected entry call path",
          );
        }
        if (adapter.target === pass.func) return;

        // `addWasiStartExport` selects an exported no-arg `main` when present;
        // `applyModuleInitGuard` makes its first call the exact graph pass. Do
        // not identify it by the display name: the observed target object and
        // the public export are the authoritative relation.
        const targetIsExported = this.ctx.mod.exports.some(
          (entry) =>
            entry.desc.kind === "func" &&
            entry.name !== "_start" &&
            entry.name !== MODULE_INIT_EXPORT_NAME &&
            definedFuncAt(this.ctx, entry.desc.index) === adapter.target,
        );
        const firstTargetCall = firstCallTarget(adapter.target.body);
        const firstTarget = firstTargetCall === undefined ? undefined : definedFuncAt(this.ctx, firstTargetCall);
        if (
          !targetIsExported ||
          adapter.target === adapter.func ||
          firstTarget !== pass.func ||
          countCallsTo(this.ctx, adapter.target.body, pass.func) !== 1
        ) {
          throw new ProgramAbiInvariantError(
            "invalid-export-target",
            "WASI _start adapter must reach graph-global pass zero through its exact guarded exported entry",
          );
        }
        return;
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

  private uniqueObservationForUnit(unitId: IrUnitId): ModuleInitCallableObservation | undefined {
    const matches = this.observations.filter((candidate) => candidate.unitId === unitId);
    return matches.length === 1 ? matches[0] : undefined;
  }
}
