// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolveIrDynamicCarrierType } from "../codegen/any-helpers.js";
import type { CodegenContext, FunctionContext } from "../codegen/context/types.js";
import { definedFuncAt, funcSignatureOf, isImportFuncIdx } from "../codegen/func-space.js";
import { prepareStandaloneExternrefToNumberProviders } from "../codegen/tonumber-fast-paths.js";
import { irCallableBindingKey, irImportFuncRef, irRuntimeFuncRef, irUnitFuncRef } from "./callable-bindings.js";
import type { IrUnitId, IrUnitInventory } from "./identity.js";
import {
  asVal,
  forEachInstrDeep,
  irDynamic,
  type IrFuncRef,
  type IrFunction,
  type IrInstr,
  type IrTypeRef,
} from "./nodes.js";
import { IrInvariantError, IrUnsupportedError } from "./outcomes.js";
import {
  derivePreparedComponentDependencies,
  type PreparedClassAccessorWritebackEvidence,
  type PreparedComponentClosureSupportEvidence,
  type PreparedDynamicInstructionSupportEvidence,
} from "./prepared-component-dependencies.js";
import {
  sealDependencyCompletePreparedComponents,
  type PreparedComponentArtifactEntry,
} from "./prepared-component-sealing.js";
import type { FuncHandle, Import, ValType } from "./types.js";

interface CompilerTimerShimEntry extends PreparedComponentArtifactEntry {
  readonly fn: IrFunction;
}

interface PreparedCompilerTimerShimDynamicShape {
  readonly terminalUnitId: IrUnitId;
  readonly box: Extract<IrInstr, { readonly kind: "box" }>;
  readonly conversion: Extract<IrInstr, { readonly kind: "dyn.to_number" }>;
  readonly dynamicCarrierRef: IrTypeRef;
}

type PreparedTimerDynamicHelperName = "__box_number" | "__unbox_number" | "__to_primitive" | "__to_number";

export interface CompilerTimerShimLateSealTransaction {
  readonly componentIds: ReadonlyMap<IrUnitId, string>;
  sealDeferred(): void;
}

export interface CompilerTimerShimLoweringBoundary<Entry extends { readonly terminalOwnerUnitId: IrUnitId }> {
  order(entries: readonly Entry[]): readonly Entry[];
  prepare(entry: Entry): boolean;
}

export function compilerTimerShimTerminalUnitIds(inventory: IrUnitInventory): ReadonlySet<IrUnitId> {
  return new Set(
    inventory.terminalUnits
      .filter(
        (terminal) =>
          terminal.kind === "synthetic-support" &&
          terminal.syntheticRole === "compiler-unit:timer-shim:set-timeout" &&
          terminal.terminalOwnerId === terminal.id &&
          terminal.lexicalOwnerId === null,
      )
      .map((terminal) => terminal.id),
  );
}

function isCompilerTimerShimTerminalEntry(
  entry: CompilerTimerShimEntry,
  terminalUnitIds: ReadonlySet<IrUnitId>,
): boolean {
  return (
    entry.artifactUnitId === entry.terminalOwnerUnitId &&
    entry.derivedUnit === undefined &&
    terminalUnitIds.has(entry.terminalOwnerUnitId)
  );
}

function isDynamicInstruction(instr: IrInstr): boolean {
  if (instr.kind === "box") return instr.toType.kind === "dynamic";
  if (instr.kind === "unbox" || instr.kind === "tag.test") return instr.tagId !== undefined;
  return (
    instr.kind === "dyn.truthy" ||
    instr.kind === "dyn.to_number" ||
    instr.kind === "dyn.eq" ||
    instr.kind === "dyn.member_get" ||
    instr.kind === "dyn.member_set"
  );
}

function exactPreparedDynamicHelperRef(
  ctx: CodegenContext,
  callableImports: ReadonlyMap<string, Import>,
  name: PreparedTimerDynamicHelperName,
  funcIdx: FuncHandle | undefined,
  params: readonly ValType[],
  results: readonly ValType[],
): IrFuncRef | undefined {
  if (funcIdx === undefined) return undefined;
  const type = funcSignatureOf(ctx, funcIdx);
  if (
    !type ||
    type.params.length !== params.length ||
    type.results.length !== results.length ||
    type.params.some((actual, index) => actual.kind !== params[index]?.kind) ||
    type.results.some((actual, index) => actual.kind !== results[index]?.kind)
  ) {
    return undefined;
  }
  if (isImportFuncIdx(ctx, funcIdx)) {
    let importFuncIdx = 0;
    for (const imported of ctx.mod.imports) {
      if (imported.desc.kind !== "func") continue;
      if (importFuncIdx++ !== funcIdx) continue;
      if (imported.module !== "env" || imported.name !== name) return undefined;
      const ref = irImportFuncRef("env", name);
      return callableImports.get(irCallableBindingKey(ref.binding)) === imported ? ref : undefined;
    }
    return undefined;
  }
  const func = definedFuncAt(ctx, funcIdx);
  if (func?.name !== name) return undefined;
  const ref = irRuntimeFuncRef(name);
  const providers = ctx.programAbiCallableProviders;
  if (!providers) return undefined;
  providers.observe(ref, funcIdx);
  return ref;
}

function prepareCompilerTimerShimDynamicShapes(
  ctx: CodegenContext,
  entries: readonly CompilerTimerShimEntry[],
  inventory: IrUnitInventory,
): ReadonlyMap<IrUnitId, PreparedCompilerTimerShimDynamicShape> {
  const shapes = new Map<IrUnitId, PreparedCompilerTimerShimDynamicShape>();
  const terminals = new Map(inventory.terminalUnits.map((terminal) => [terminal.id, terminal]));
  for (const entry of entries) {
    const terminal = terminals.get(entry.terminalOwnerUnitId);
    if (
      entry.artifactUnitId !== entry.terminalOwnerUnitId ||
      entry.derivedUnit !== undefined ||
      terminal?.kind !== "synthetic-support" ||
      terminal.syntheticRole !== "compiler-unit:timer-shim:set-timeout" ||
      terminal.terminalOwnerId !== terminal.id ||
      terminal.lexicalOwnerId !== null
    ) {
      continue;
    }
    const fn = entry.fn;
    const block = fn.blocks.length === 1 ? fn.blocks[0] : undefined;
    const callback = fn.params[0];
    const delay = fn.params[1];
    const boxes: Extract<IrInstr, { readonly kind: "box" }>[] = [];
    const conversions: Extract<IrInstr, { readonly kind: "dyn.to_number" }>[] = [];
    const capabilityCalls: Extract<IrInstr, { readonly kind: "call" }>[] = [];
    const dynamicInstructions: IrInstr[] = [];
    for (const root of block?.instrs ?? []) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "box" && instr.toType.kind === "dynamic") boxes.push(instr);
        if (instr.kind === "dyn.to_number") conversions.push(instr);
        if (
          instr.kind === "call" &&
          instr.target.binding.kind === "import" &&
          instr.target.binding.module === "env" &&
          instr.target.binding.field === "__timer_set_timeout"
        ) {
          capabilityCalls.push(instr);
        }
        if (isDynamicInstruction(instr)) dynamicInstructions.push(instr);
      });
    }
    const box = boxes[0];
    const conversion = conversions[0];
    const capability = capabilityCalls[0];
    if (
      !block ||
      fn.params.length !== 2 ||
      callback?.type.kind !== "callable" ||
      callback.type.signature.params.length !== 0 ||
      callback.type.signature.returnType !== null ||
      asVal(delay?.type ?? irDynamic())?.kind !== "f64" ||
      fn.resultTypes.length !== 1 ||
      asVal(fn.resultTypes[0]!)?.kind !== "f64" ||
      boxes.length !== 1 ||
      conversions.length !== 1 ||
      capabilityCalls.length !== 1 ||
      dynamicInstructions.length !== 2 ||
      !box ||
      box.value !== delay.value ||
      box.result === null ||
      box.resultType?.kind !== "dynamic" ||
      !capability ||
      capability.args.length !== 2 ||
      capability.args[0] !== callback.value ||
      capability.args[1] !== box.result ||
      capability.result === null ||
      capability.resultType?.kind !== "dynamic" ||
      !conversion ||
      conversion.value !== capability.result ||
      conversion.result === null ||
      asVal(conversion.resultType ?? irDynamic())?.kind !== "f64" ||
      block.terminator.kind !== "return" ||
      block.terminator.values.length !== 1 ||
      block.terminator.values[0] !== conversion.result
    ) {
      continue;
    }
    const typeRegistry = ctx.programAbiTypes;
    if (!typeRegistry) continue;
    const carrier = typeRegistry.prepareDynamicCarrier(resolveIrDynamicCarrierType(ctx));
    shapes.set(terminal.id, {
      terminalUnitId: terminal.id,
      box,
      conversion,
      dynamicCarrierRef: carrier.carrierRef,
    });
  }
  return shapes;
}

function prepareCompilerTimerShimDynamicInstructionSupport(
  ctx: CodegenContext,
  shapes: ReadonlyMap<IrUnitId, PreparedCompilerTimerShimDynamicShape>,
  callableImports: ReadonlyMap<string, Import>,
): ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence> {
  const support = new Map<IrUnitId, PreparedDynamicInstructionSupportEvidence>();
  for (const shape of shapes.values()) {
    let conversionCallables: readonly IrFuncRef[] | undefined;
    if (ctx.standalone) {
      const shim = { body: [], savedBodies: [] } as unknown as FunctionContext;
      const selected = prepareStandaloneExternrefToNumberProviders(ctx, shim);
      if (!selected) continue;
      const toPrimitive = exactPreparedDynamicHelperRef(
        ctx,
        callableImports,
        "__to_primitive",
        selected.toPrimitive,
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      const unboxNumber = exactPreparedDynamicHelperRef(
        ctx,
        callableImports,
        "__unbox_number",
        selected.unboxNumber,
        [{ kind: "externref" }],
        [{ kind: "f64" }],
      );
      const fusedToNumber =
        selected.fusedToNumber === undefined
          ? undefined
          : exactPreparedDynamicHelperRef(
              ctx,
              callableImports,
              "__to_number",
              selected.fusedToNumber,
              [{ kind: "externref" }],
              [{ kind: "f64" }],
            );
      if (!toPrimitive || !unboxNumber || (selected.fusedToNumber !== undefined && !fusedToNumber)) continue;
      conversionCallables = fusedToNumber ? [fusedToNumber, toPrimitive, unboxNumber] : [toPrimitive, unboxNumber];
    } else {
      const unboxNumber = exactPreparedDynamicHelperRef(
        ctx,
        callableImports,
        "__unbox_number",
        ctx.funcMap.get("__unbox_number"),
        [{ kind: "externref" }],
        [{ kind: "f64" }],
      );
      if (!unboxNumber) continue;
      conversionCallables = [unboxNumber];
    }
    const boxNumber = exactPreparedDynamicHelperRef(
      ctx,
      callableImports,
      "__box_number",
      ctx.funcMap.get("__box_number"),
      [{ kind: "f64" }],
      [{ kind: "externref" }],
    );
    if (!boxNumber || !conversionCallables) continue;
    support.set(shape.terminalUnitId, {
      dynamicCarrierRef: shape.dynamicCarrierRef,
      instructionCallables: new Map<IrInstr, readonly IrFuncRef[]>([
        [shape.box, [boxNumber]],
        [shape.conversion, conversionCallables],
      ]),
    });
  }
  return support;
}

export function prepareCompilerTimerShimLateSealTransaction<Entry extends CompilerTimerShimEntry>(input: {
  readonly ctx: CodegenContext;
  readonly entries: readonly Entry[];
  readonly inventory: IrUnitInventory;
  readonly closureSupport: PreparedComponentClosureSupportEvidence;
  readonly classAccessorWritebacks: ReadonlyMap<IrUnitId, PreparedClassAccessorWritebackEvidence>;
  readonly callableImports: ReadonlyMap<string, Import>;
  readonly onSealFailure: (terminalUnitId: IrUnitId, error: IrUnsupportedError) => void;
}): CompilerTimerShimLateSealTransaction {
  const timerTerminalUnitIds = compilerTimerShimTerminalUnitIds(input.inventory);
  const timerEntries = input.entries.filter((entry) => isCompilerTimerShimTerminalEntry(entry, timerTerminalUnitIds));
  const timerDynamicShapes = prepareCompilerTimerShimDynamicShapes(input.ctx, timerEntries, input.inventory);
  const allTerminalUnitIds = new Set(input.entries.map((entry) => entry.terminalOwnerUnitId));
  const derivedUnits = [
    ...new Map(
      input.entries.flatMap((entry) =>
        entry.derivedUnit ? ([[entry.derivedUnit.id, entry.derivedUnit]] as const) : [],
      ),
    ).values(),
  ];
  const session = input.ctx.programAbiSession;
  if (!session) {
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "resolve",
      "compiler timer-shim component isolation requires one production ProgramAbiSession",
    );
  }
  let topologyFunctions = input.entries.map((entry) => entry.fn);
  if (process.env.JS2WASM_TEST_INJECT_IR_TIMER_SHIM_UNIT_EDGE === "1") {
    const timer = timerEntries[0];
    const caller = input.entries.find(
      (entry) =>
        entry.terminalOwnerUnitId !== timer?.terminalOwnerUnitId &&
        entry.artifactUnitId === entry.terminalOwnerUnitId &&
        entry.derivedUnit === undefined &&
        entry.fn.asyncPlan === undefined &&
        entry.fn.blocks.length > 0,
    );
    const block = caller?.fn.blocks[0];
    if (timer && caller && block) {
      const injectedCaller: IrFunction = {
        ...caller.fn,
        blocks: [
          {
            ...block,
            instrs: [
              ...block.instrs,
              { kind: "call", target: irUnitFuncRef(timer.fn), args: [], result: null, resultType: null },
            ],
          },
          ...caller.fn.blocks.slice(1),
        ],
      };
      topologyFunctions = topologyFunctions.map((fn) => (fn === caller.fn ? injectedCaller : fn));
    }
  }
  const topology = derivePreparedComponentDependencies({
    module: { functions: topologyFunctions },
    terminalUnitIds: allTerminalUnitIds,
    inventory: input.inventory,
    derivedUnits,
    closureSupport: input.closureSupport,
    exceptionSupportPrepared: input.ctx.exnTagIdx >= 0,
    classAccessorWritebacks: input.classAccessorWritebacks,
    abi: {
      get: (id) => session.getDraft(id),
      bindingIdsForStructuralReference: (key) => session.bindingIdsForStructuralReference(key),
    },
  });
  const deferredTimerTerminalUnitIds = new Set<IrUnitId>();
  const rejectedConnectedTerminalUnitIds = new Set<IrUnitId>();
  for (const entry of timerEntries) {
    const component = topology.componentByTerminalUnitId.get(entry.terminalOwnerUnitId);
    if (component?.terminalUnitIds.length === 1 && component.terminalUnitIds[0] === entry.terminalOwnerUnitId) {
      deferredTimerTerminalUnitIds.add(entry.terminalOwnerUnitId);
      continue;
    }
    for (const terminalUnitId of component?.terminalUnitIds ?? [entry.terminalOwnerUnitId]) {
      rejectedConnectedTerminalUnitIds.add(terminalUnitId);
    }
  }
  for (const terminalUnitId of rejectedConnectedTerminalUnitIds) {
    input.onSealFailure(
      terminalUnitId,
      new IrUnsupportedError(
        "timer-component-not-isolated",
        "resolve",
        "compiler timer-shim terminal belongs to a non-isolated final-IR component; preserving its complete legacy component",
      ),
    );
  }
  const deferredTimerEntries = input.entries.filter((entry) =>
    deferredTimerTerminalUnitIds.has(entry.terminalOwnerUnitId),
  );
  const immediateEntries = input.entries.filter(
    (entry) =>
      !deferredTimerTerminalUnitIds.has(entry.terminalOwnerUnitId) &&
      !rejectedConnectedTerminalUnitIds.has(entry.terminalOwnerUnitId),
  );
  const componentIds = new Map<IrUnitId, string>();
  if (immediateEntries.length > 0) {
    for (const [unitId, componentId] of sealDependencyCompletePreparedComponents({
      ...input,
      entries: immediateEntries,
    })) {
      componentIds.set(unitId, componentId);
    }
  }
  let timerSealAttempted = false;
  return {
    componentIds,
    sealDeferred: () => {
      if (timerSealAttempted || deferredTimerEntries.length === 0) return;
      timerSealAttempted = true;
      if (process.env.JS2WASM_TEST_INJECT_IR_PREPARED_TIMER_SHIM_FAILURE === "seal") {
        for (const terminalOwnerUnitId of new Set(deferredTimerEntries.map((entry) => entry.terminalOwnerUnitId))) {
          input.onSealFailure(
            terminalOwnerUnitId,
            new IrUnsupportedError(
              "late-preparation-unsupported",
              "resolve",
              "injected compiler timer-shim late-seal failure",
            ),
          );
        }
        return;
      }
      const dynamicInstructionSupport = prepareCompilerTimerShimDynamicInstructionSupport(
        input.ctx,
        new Map([...timerDynamicShapes].filter(([unitId]) => deferredTimerTerminalUnitIds.has(unitId))),
        input.callableImports,
      );
      for (const [unitId, componentId] of sealDependencyCompletePreparedComponents({
        ...input,
        entries: deferredTimerEntries,
        ...(dynamicInstructionSupport.size > 0 ? { dynamicInstructionSupport } : {}),
      })) {
        componentIds.set(unitId, componentId);
      }
    },
  };
}

export function createCompilerTimerShimLoweringBoundary<
  Entry extends { readonly terminalOwnerUnitId: IrUnitId },
>(input: {
  readonly inventory: IrUnitInventory;
  readonly sealDeferred: () => void;
  readonly ownerFailed: (unitId: IrUnitId) => boolean;
}): CompilerTimerShimLoweringBoundary<Entry> {
  const terminalUnitIds = compilerTimerShimTerminalUnitIds(input.inventory);
  const owns = (entry: Entry): boolean => terminalUnitIds.has(entry.terminalOwnerUnitId);
  return {
    order: (entries) => [...entries.filter((entry) => !owns(entry)), ...entries.filter(owns)],
    prepare: (entry) => {
      if (!owns(entry)) return true;
      input.sealDeferred();
      if (input.ownerFailed(entry.terminalOwnerUnitId)) return false;
      if (process.env.JS2WASM_TEST_INJECT_IR_PREPARED_TIMER_SHIM_FAILURE === "lower") {
        throw new IrUnsupportedError(
          "late-preparation-unsupported",
          "resolve",
          "injected compiler timer-shim post-seal lowering failure",
        );
      }
      return true;
    },
  };
}
