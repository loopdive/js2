// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ModuleLayout } from "../../../emit/resolve-layout.js";
import { irGlobalBindingKey } from "../../abi-bindings.js";
import {
  LINEAR_ARRAY_FORWARDING,
  LINEAR_STACK_ARENA_BYTES,
  type LinearAllocationClass,
  type LinearAllocationSitePlan,
  type LinearMemoryPlan,
  type LinearRuntimeOperation,
  type LinearStorageKind,
} from "../../analysis/linear-memory-plan.js";
import {
  bindLinearStringRuntime as bindSharedLinearStringRuntime,
  type LinearStringRuntimeBinding,
  type LinearStringRuntimeRequest,
} from "../../analysis/linear-string-runtime.js";
import {
  irVal,
  type AllocSiteId,
  type IrFunction,
  type IrFuncRef,
  type IrGlobalBinding,
  type IrGlobalRef,
  type IrObjectShape,
  type IrTypeRef,
} from "../../nodes.js";
import type { IrLoweredBody, IrLowerResolver } from "../../lower.js";
import { compareIrIdentity, type IrUnitId } from "../../identity.js";
import { IR_VEC_ELEM_SET_PREFIX, parseIrVectorRuntimeElement } from "../../vector-runtime.js";
import type { FuncHandle, FuncTypeDef, GlobalHandle, TypeHandle, ValType } from "../../types.js";
import type { ModuleAssembler } from "../contract.js";
import type { IrVecLowering, LinearMemoryFieldLowering, LinearVecLowering, PlannedObjectLowering } from "../handles.js";
import {
  PORFFOR_EFFECT_ENTRIES,
  PORFFOR_KIND_NAMES,
  PORFFOR_TYPE_ENTRIES,
  type PorfforFunctionRecord,
  type PorfforGlobalRecord,
  type PorfforNode,
  type PorfforRendererInput,
} from "./compat.js";
import {
  PORFFOR_FX,
  type PorfforExpr,
  type PorfforFunctionSymbol,
  type PorfforGlobalSymbol,
  type PorfforLocalRef,
  type PorfforSink,
  type PorfforStatement,
  type PorfforSymbolResolver,
  type PorfforTarget,
  type PorfforTypeRef,
} from "./sink.js";
import { PorfforTypeConverter, type PorfforValueSlot } from "./type-converter.js";

export interface PorfforFunctionDefinition {
  readonly lowered: IrLoweredBody<PorfforSink, PorfforValueSlot>;
}

export interface PorfforGlobalDefinition {
  readonly type: PorfforValueSlot;
}

export interface PorfforTypeDefinition {
  readonly key: string;
}

interface FunctionEntry {
  readonly handle: FuncHandle;
  /** Diagnostic/public label only. */
  readonly name: string;
  /** Structural identity for source/synthetic IR units. Runtime providers omit it. */
  readonly unitId?: IrUnitId;
  /** Collision-free renderer symbol, assigned deterministically at finalize. */
  physicalName?: string;
  signature?: PorfforFunctionSymbol;
  definition?: PorfforFunctionDefinition;
  stackRuntime?: "mark" | "allocate" | "restore";
  linearArrayRuntime?: "resolve" | "grow" | "set" | "get" | "len";
}

interface GlobalEntry {
  readonly handle: GlobalHandle;
  readonly name: string;
  readonly binding?: IrGlobalBinding;
  definition?: PorfforGlobalDefinition;
}

interface TypeEntry {
  readonly handle: TypeHandle;
  readonly key: string;
  readonly name?: string;
}

interface LocalBinding {
  readonly name: string;
  readonly type: PorfforValueSlot;
}

type ControlFrame = { readonly kind: "block" | "loop" | "if"; readonly label: string };

const TYPE_ORDINAL = new Map<string, number>(PORFFOR_TYPE_ENTRIES);
const EFFECT_ORDINAL = new Map<string, number>(PORFFOR_EFFECT_ENTRIES);
/** Linear lowering deliberately exposes its sole supported f64 vec as type 0. */
const PORFFOR_LINEAR_F64_VEC_TYPE_INDEX = 0;

/**
 * Porffor module/index authority. Handles are registration-order identities;
 * final Porffor function/global array positions are assigned once. IR
 * functions use canonical unit order; provider functions and globals use
 * their stable physical labels.
 */
export class PorfforModuleAssembler
  implements
    ModuleAssembler<PorfforFunctionDefinition, PorfforGlobalDefinition, PorfforTypeDefinition>,
    IrLowerResolver,
    PorfforSymbolResolver
{
  readonly backend = "porffor" as const;
  private readonly typeConverter = new PorfforTypeConverter();
  private readonly funcsByHandle = new Map<FuncHandle, FunctionEntry>();
  /** Runtime/provider compatibility namespace; IR display labels never enter it. */
  private readonly funcsByName = new Map<string, FunctionEntry>();
  private readonly funcsByUnitId = new Map<IrUnitId, FunctionEntry>();
  private readonly irFuncsByDisplayName = new Map<string, FunctionEntry[]>();
  private readonly globalsByHandle = new Map<GlobalHandle, GlobalEntry>();
  private readonly globalsByName = new Map<string, GlobalEntry>();
  private readonly globalsByBindingKey = new Map<string, GlobalEntry>();
  private readonly typesByHandle = new Map<TypeHandle, TypeEntry>();
  private readonly typesByKey = new Map<string, TypeEntry>();
  private readonly typesByName = new Map<string, TypeEntry>();
  private readonly functionExports = new Map<string, FuncHandle>();
  private readonly globalExports = new Map<string, GlobalHandle>();
  private nextFuncHandle = 0;
  private nextGlobalHandle = 0;
  private nextTypeHandle = 0;
  private start: FuncHandle | null = null;
  private frozen = false;
  private finalInput: PorfforRendererInput | null = null;
  private preferences: Readonly<Record<string, unknown>> = { gc: false };
  private memoryPlan: LinearMemoryPlan | undefined;
  private readonly objects = new Map<string, PlannedObjectLowering>();
  private stackGlobals: { readonly base: GlobalHandle; readonly pointer: GlobalHandle } | undefined;

  bindMemoryPlan(plan: LinearMemoryPlan): void {
    this.assertMutable("bind memory plan");
    if (this.memoryPlan) throw new Error("porffor assembler: memory plan already bound");
    this.memoryPlan = plan;
    for (const allocation of plan.allocations) this.plannedAllocationClass(allocation);
    if (plan.allocations.some((allocation) => this.hasStackFrameOperations(allocation))) {
      this.ensureStackRuntime();
    }
  }

  bindLinearStringRuntime(request: LinearStringRuntimeRequest): LinearStringRuntimeBinding {
    if (!this.memoryPlan) throw new Error("porffor assembler: string lowering requires a shared LinearMemoryPlan");
    return bindSharedLinearStringRuntime(this.memoryPlan, request);
  }

  private plannedAllocationClass(allocation: LinearAllocationSitePlan): LinearAllocationClass {
    const allocationOperations = allocation.operations.filter(isAllocationBindingOperation);
    const encodedClasses = allocationOperations.flatMap((operation) =>
      "allocationClass" in operation ? [operation.allocationClass] : [],
    );
    if (allocation.allocationClass !== "managed" && encodedClasses.length === 0) {
      throw new Error(
        `porffor assembler: allocation site ${allocation.id as number} has no symbolic allocation operation`,
      );
    }
    if (encodedClasses.some((allocationClass) => allocationClass !== allocation.allocationClass)) {
      throw new Error(
        `porffor assembler: allocation site ${allocation.id as number} disagrees with its symbolic allocation operation`,
      );
    }

    const marks = allocation.operations.filter(
      (operation) => operation.family === "stack" && operation.operation === "mark",
    ).length;
    const restores = allocation.operations.filter(
      (operation) => operation.family === "stack" && operation.operation === "restore",
    ).length;
    if (allocation.allocationClass === "stack" ? marks !== 1 || restores !== 1 : marks !== 0 || restores !== 0) {
      throw new Error(
        `porffor assembler: allocation site ${allocation.id as number} has inconsistent symbolic stack operations`,
      );
    }
    return encodedClasses[0] ?? allocation.allocationClass;
  }

  private hasStackFrameOperations(allocation: LinearAllocationSitePlan): boolean {
    return allocation.operations.some((operation) => operation.family === "stack" && operation.operation === "mark");
  }

  setPreferences(preferences: Readonly<Record<string, unknown>>): void {
    this.assertMutable("set preferences");
    this.preferences = { gc: false, ...preferences };
  }

  /** Declare an IR function and freeze its scalar signature before bodies lower. */
  declareIrFunction(func: IrFunction): FuncHandle {
    this.assertMutable("declare IR function");
    if (this.funcsByUnitId.has(func.unitId)) {
      throw new Error(`porffor assembler: duplicate IR function unit '${func.unitId}'`);
    }
    const entry: FunctionEntry = {
      handle: this.nextFuncHandle++,
      name: func.name,
      unitId: func.unitId,
    };
    this.funcsByHandle.set(entry.handle, entry);
    this.funcsByUnitId.set(func.unitId, entry);
    const sameLabel = this.irFuncsByDisplayName.get(func.name);
    if (sameLabel) sameLabel.push(entry);
    else this.irFuncsByDisplayName.set(func.name, [entry]);
    entry.signature = {
      name: func.name,
      params: func.params.map((param) => this.oneSlot(param.type, `param ${param.name} of ${func.name}`)),
      results: func.resultTypes.map((type, index) => this.oneSlot(type, `result ${index} of ${func.name}`)),
    };
    if (entry.signature.results.length > 1) {
      throw new Error(`porffor backend does not support multi-value function '${func.name}'`);
    }
    return entry.handle;
  }

  declareIrGlobal(ref: IrGlobalRef, type: PorfforValueSlot): GlobalHandle {
    this.assertMutable("declare structural global");
    const key = irGlobalBindingKey(ref.binding);
    if (this.globalsByBindingKey.has(key)) {
      throw new Error(`porffor assembler: duplicate global binding '${ref.binding.bindingId}'`);
    }
    const handle = this.nextGlobalHandle++;
    const entry: GlobalEntry = { handle, name: ref.name, binding: ref.binding };
    this.globalsByHandle.set(handle, entry);
    this.globalsByBindingKey.set(key, entry);
    this.defineGlobal(handle, { type });
    return handle;
  }

  declarePorfforGlobal(name: string, type: PorfforValueSlot): GlobalHandle {
    const handle = this.declareGlobal(name);
    this.defineGlobal(handle, { type });
    return handle;
  }

  declareFunc(name: string): FuncHandle {
    this.assertMutable("declare function");
    if (this.funcsByName.has(name)) throw new Error(`porffor assembler: duplicate function '${name}'`);
    const entry: FunctionEntry = { handle: this.nextFuncHandle++, name };
    this.funcsByHandle.set(entry.handle, entry);
    this.funcsByName.set(name, entry);
    return entry.handle;
  }

  defineFunc(handle: FuncHandle, definition: PorfforFunctionDefinition): void {
    this.assertMutable("define function");
    const entry = this.requireFunc(handle);
    if (entry.definition) throw new Error(`porffor assembler: function '${entry.name}' is already defined`);
    if (definition.lowered.name !== entry.name) {
      throw new Error(
        `porffor assembler: definition name '${definition.lowered.name}' does not match declaration '${entry.name}'`,
      );
    }
    entry.definition = definition;
  }

  importFunc(_module: string, _field: string, _typeHandle: TypeHandle, name: string): FuncHandle {
    throw new Error(`porffor backend does not support imported function '${name}' in the scalar/control-flow slice`);
  }

  lookupFunc(name: string): FuncHandle | undefined {
    return this.funcsByName.get(name)?.handle;
  }

  lookupIrFunction(unitId: IrUnitId): FuncHandle | undefined {
    return this.funcsByUnitId.get(unitId)?.handle;
  }

  /**
   * Public-label compatibility lookup for renderer entry selection.
   * Ambiguity is rejected; semantic call resolution always uses unit IDs.
   */
  lookupUniqueIrFunctionByDisplayName(name: string): FuncHandle | undefined {
    const entries = this.irFuncsByDisplayName.get(name) ?? [];
    if (entries.length > 1) {
      throw new Error(`porffor assembler: entry label '${name}' matches ${entries.length} IR function units`);
    }
    return entries[0]?.handle;
  }

  declareGlobal(name: string): GlobalHandle {
    this.assertMutable("declare global");
    if (this.globalsByName.has(name)) throw new Error(`porffor assembler: duplicate global '${name}'`);
    const entry: GlobalEntry = { handle: this.nextGlobalHandle++, name };
    this.globalsByHandle.set(entry.handle, entry);
    this.globalsByName.set(name, entry);
    return entry.handle;
  }

  defineGlobal(handle: GlobalHandle, definition: PorfforGlobalDefinition): void {
    this.assertMutable("define global");
    const entry = this.requireGlobal(handle);
    if (entry.definition) throw new Error(`porffor assembler: global '${entry.name}' is already defined`);
    entry.definition = definition;
  }

  importGlobal(_module: string, _field: string, _type: ValType, _mutable: boolean, name: string): GlobalHandle {
    throw new Error(`porffor backend does not support imported global '${name}' in the scalar/control-flow slice`);
  }

  lookupGlobal(name: string): GlobalHandle | undefined {
    return this.globalsByName.get(name)?.handle;
  }

  internType(definition: PorfforTypeDefinition, name?: string): TypeHandle {
    this.assertMutable("intern type");
    const existing = this.typesByKey.get(definition.key);
    if (existing) {
      if (name) this.bindTypeName(name, existing);
      return existing.handle;
    }
    const entry: TypeEntry = { handle: this.nextTypeHandle++, key: definition.key, name };
    this.typesByHandle.set(entry.handle, entry);
    this.typesByKey.set(entry.key, entry);
    if (name) this.bindTypeName(name, entry);
    return entry.handle;
  }

  lookupType(name: string): TypeHandle | undefined {
    return this.typesByName.get(name)?.handle;
  }

  exportFunc(exportName: string, handle: FuncHandle): void {
    this.assertMutable("export function");
    this.requireFunc(handle);
    if (this.functionExports.has(exportName)) throw new Error(`porffor assembler: duplicate export '${exportName}'`);
    this.functionExports.set(exportName, handle);
  }

  exportGlobal(exportName: string, handle: GlobalHandle): void {
    this.assertMutable("export global");
    this.requireGlobal(handle);
    if (this.globalExports.has(exportName)) throw new Error(`porffor assembler: duplicate export '${exportName}'`);
    this.globalExports.set(exportName, handle);
  }

  setStart(handle: FuncHandle): void {
    this.assertMutable("set start");
    this.requireFunc(handle);
    if (this.start !== null) throw new Error("porffor assembler: start function is already set");
    this.start = handle;
  }

  private ensureStackRuntime(): void {
    if (this.stackGlobals) return;
    const base = this.declarePorfforGlobal("#js2_stack_base", "ptr");
    const pointer = this.declarePorfforGlobal("#js2_stack_pointer", "ptr");
    this.stackGlobals = { base, pointer };

    const declare = (
      name: string,
      params: readonly PorfforValueSlot[],
      results: readonly PorfforValueSlot[],
      stackRuntime: NonNullable<FunctionEntry["stackRuntime"]>,
    ): void => {
      const handle = this.declareFunc(name);
      const entry = this.requireFunc(handle);
      entry.signature = { name, params, results };
      entry.stackRuntime = stackRuntime;
    };
    declare("#js2_stack_mark", [], ["ptr"], "mark");
    declare("#js2_stack_allocate", ["u32"], ["ptr"], "allocate");
    declare("#js2_stack_restore", ["ptr"], [], "restore");
  }

  finalize(): ModuleLayout {
    this.assertMutable("finalize");
    this.frozen = true;

    this.assignPhysicalFunctionNames();
    const functions = [...this.funcsByHandle.values()].sort(compareFunctionEntry);
    const globals = [...this.globalsByHandle.values()].sort(byName);
    const types = [...this.typesByHandle.values()].sort((left, right) => compareText(left.key, right.key));
    for (const entry of functions) {
      if (!entry.signature) throw new Error(`porffor assembler: function '${entry.name}' has no registered signature`);
      if (!entry.definition && !entry.stackRuntime && !entry.linearArrayRuntime)
        throw new Error(`porffor assembler: function '${entry.name}' was declared but never defined`);
    }
    for (const entry of globals) {
      if (!entry.definition)
        throw new Error(`porffor assembler: global '${entry.name}' was declared but never defined`);
    }

    const funcPositions = new Map(functions.map((entry, index) => [entry.handle, index]));
    const globalPositions = new Map(globals.map((entry, index) => [entry.handle, index]));
    const typePositions = new Map(types.map((entry, index) => [entry.handle, index]));

    const functionRecords = functions.map((entry, index) => this.assembleFunction(entry, index));
    const globalRecords: PorfforGlobalRecord[] = globals.map((entry) => ({
      name: entry.name,
      type: typeOrdinal(entry.definition!.type),
    }));
    this.finalInput = {
      funcs: functionRecords,
      data: [],
      globals: globalRecords,
      entry: this.start === null ? null : this.functionPhysicalName(this.requireFunc(this.start)),
      prefs: this.preferences,
      usedTypes: new Set<number>(),
    };

    return {
      func: (handle) => requirePosition(funcPositions, handle, "function"),
      global: (handle) => requirePosition(globalPositions, handle, "global"),
      type: (handle) => requirePosition(typePositions, handle, "type"),
    };
  }

  rendererInput(): PorfforRendererInput {
    if (!this.finalInput) throw new Error("porffor assembler: renderer input requested before finalize");
    return this.finalInput;
  }

  resolveFunc(ref: IrFuncRef): number {
    switch (ref.binding.kind) {
      case "unit": {
        const entry = this.funcsByUnitId.get(ref.binding.unitId);
        if (!entry) {
          throw new Error(`porffor assembler: unresolved function unit '${ref.binding.unitId}' (${ref.name})`);
        }
        return entry.handle;
      }
      case "runtime":
      case "intrinsic": {
        const symbol = ref.binding.symbol;
        const arrayRuntime = linearArrayRuntimeKind(symbol);
        if (arrayRuntime) return this.ensureLinearArrayRuntime(symbol, arrayRuntime);
        const entry = this.funcsByName.get(symbol);
        if (!entry?.stackRuntime && !entry?.linearArrayRuntime) {
          throw new Error(`porffor assembler: unresolved ${ref.binding.kind} '${symbol}'`);
        }
        return entry.handle;
      }
      case "import":
        throw new Error(
          `porffor assembler: imported function '${ref.binding.module}.${ref.binding.field}' is unsupported`,
        );
      case "support":
        throw new Error(`porffor assembler: unresolved support binding '${ref.binding.bindingId}'`);
    }
  }

  resolveGlobal(ref: IrGlobalRef): number {
    const entry = this.globalsByBindingKey.get(irGlobalBindingKey(ref.binding));
    if (!entry) {
      throw new Error(`porffor assembler: unresolved global binding '${ref.binding.bindingId}' (${ref.name})`);
    }
    return entry.handle;
  }

  resolveType(ref: IrTypeRef): number {
    throw new Error(`porffor assembler: symbolic type binding '${ref.binding.bindingId}' is unsupported`);
  }

  resolveString(): ValType {
    return { kind: "i32" };
  }

  internFuncType(_type: FuncTypeDef): number {
    throw new Error("porffor backend does not intern Wasm function types");
  }

  resolveObject(shape: IrObjectShape, alloc?: AllocSiteId): PlannedObjectLowering | null {
    const plan = this.requireMemoryPlan();
    const layout = plan.layoutForObjectShape(shape);
    if (!layout) throw new Error("porffor assembler: object layout is absent from the shared memory plan");
    const allocation = this.allocationFor(layout.id, alloc);
    const allocate = plannedOperation(
      allocation.operations,
      (operation) => operation.family === "memory" && operation.operation === "allocate",
      `record allocation for '${layout.id}'`,
    );
    const cacheKey = `${layout.id}:${allocation.id as number}`;
    const cached = this.objects.get(cacheKey);
    if (cached) return cached;

    const fields = shape.fields.map((field, fieldIdx) => {
      const planned = layout.fields.find((candidate) => candidate.name === field.name);
      if (!planned) throw new Error(`porffor assembler: object layout has no field '${field.name}'`);
      const type = memoryValType(planned.storage);
      if (!type) {
        throw new Error(`porffor assembler: object field '${field.name}' has unsupported '${planned.storage}' storage`);
      }
      return { name: field.name, fieldIdx, offset: planned.offset, type };
    });
    const fieldsByName = new Map(fields.map((field) => [field.name, field]));
    const lowering: PlannedObjectLowering = {
      typeIdx: 0,
      fieldIdx(name: string): number {
        const field = fieldsByName.get(name);
        if (!field) throw new Error(`porffor assembler: object shape has no field '${name}'`);
        return field.fieldIdx;
      },
      linearMemory: {
        allocation,
        layout,
        allocate,
        fieldCount: fields.length,
        field(name: string): LinearMemoryFieldLowering {
          const field = fieldsByName.get(name);
          if (!field) throw new Error(`porffor assembler: object shape has no field '${name}'`);
          return field;
        },
      },
    };
    this.objects.set(cacheKey, lowering);
    return lowering;
  }

  resolveVec(valType: ValType): IrVecLowering | null {
    return valType.kind === "i32" ? this.f64VecHandle() : null;
  }

  resolveVecForElement(elementValType: ValType, alloc?: AllocSiteId): IrVecLowering | null {
    return elementValType.kind === "f64" ? this.f64VecHandle(alloc) : null;
  }

  functionSymbol(handle: number): PorfforFunctionSymbol {
    const entry = this.requireFunc(handle);
    if (!entry.signature) throw new Error(`porffor assembler: function '${entry.name}' has no registered signature`);
    return { ...entry.signature, name: entry.physicalName ?? entry.signature.name };
  }

  globalSymbol(handle: number): PorfforGlobalSymbol {
    const entry = this.requireGlobal(handle);
    if (!entry.definition) throw new Error(`porffor assembler: global '${entry.name}' has no definition`);
    return { name: entry.name, type: entry.definition.type };
  }

  private assembleFunction(entry: FunctionEntry, index: number): PorfforFunctionRecord {
    if (entry.stackRuntime) return this.assembleStackRuntimeFunction(entry, index, entry.stackRuntime);
    if (entry.linearArrayRuntime) {
      return this.assembleLinearArrayRuntimeFunction(entry, index, entry.linearArrayRuntime);
    }
    const lowered = entry.definition!.lowered;
    const params: LocalBinding[] = lowered.params.map((value, paramIndex) => ({
      name: `#js2_param_${paramIndex}_${value.name}`,
      type: oneLoweredSlot(value.slots, `param ${value.name} of ${entry.name}`),
    }));
    const loweredLocals: LocalBinding[] = lowered.locals.map((value, localIndex) => ({
      name: `#js2_local_${localIndex}_${value.name}`,
      type: oneLoweredSlot(value.slots, `local ${value.name} of ${entry.name}`),
    }));
    const indexedLocals = [...params, ...loweredLocals];
    const scratchLocals: LocalBinding[] = lowered.body.scratchLocals().map((local) => ({
      name: local.name,
      type: this.resolveTypeRef(local.type, indexedLocals),
    }));
    const locals: Record<string, { type: number }> = {};
    for (const local of [...loweredLocals, ...scratchLocals]) {
      if (locals[local.name]) throw new Error(`porffor assembler: duplicate local '${local.name}' in ${entry.name}`);
      locals[local.name] = { type: typeOrdinal(local.type) };
    }

    const usesStack = this.memoryPlan?.allocations.some(
      (allocation) => allocation.ownerFunction === entry.name && this.hasStackFrameOperations(allocation),
    );
    const stackMarkName = "#js2_stack_frame_mark";
    const stackResultName = "#js2_stack_frame_result";
    const resultType =
      lowered.results.length === 0 ? null : oneLoweredSlot(lowered.results[0]!, `stack-frame result of ${entry.name}`);
    if (usesStack) {
      locals[stackMarkName] = { type: typeOrdinal("ptr") };
      if (resultType) locals[stackResultName] = { type: typeOrdinal(resultType) };
    }

    lowered.body.assertEmpty(`function ${entry.name}`);
    let body = this.assembleStatements(lowered.body.statements, indexedLocals, entry.name, []);
    if (usesStack) {
      body = this.instrumentPorfforStackFrame(body, stackMarkName, resultType ? stackResultName : null, resultType);
    }
    return {
      name: this.functionPhysicalName(entry),
      index,
      params: params.map((param) => ({ name: param.name, type: typeOrdinal(param.type) })),
      retType:
        lowered.results.length === 0
          ? typeOrdinal("none")
          : typeOrdinal(oneLoweredSlot(lowered.results[0]!, `result of ${entry.name}`)),
      locals,
      body,
    };
  }

  private assembleStackRuntimeFunction(
    entry: FunctionEntry,
    index: number,
    operation: NonNullable<FunctionEntry["stackRuntime"]>,
  ): PorfforFunctionRecord {
    const globals = this.stackGlobals;
    if (!globals) throw new Error("porffor assembler: stack runtime has no globals");
    const global = (handle: GlobalHandle): PorfforNode => {
      const symbol = this.globalSymbol(handle);
      return node("Global", symbol.type, PORFFOR_FX.readGlobal, symbol.name, 0, 0);
    };
    const local = (name: string, type: PorfforValueSlot): PorfforNode =>
      node("Local", type, PORFFOR_FX.none, name, 0, 0);
    const constant = (value: number, type: PorfforValueSlot = "u32"): PorfforNode =>
      node("Const", type, PORFFOR_FX.none, value, 0, 0);
    const assign = (target: PorfforNode, value: PorfforNode): PorfforNode =>
      node("Assign", "none", PORFFOR_FX.writeLocal | target[2] | value[2], target, value, 0);
    const binary = (
      op: string,
      type: PorfforValueSlot,
      left: PorfforNode,
      right: PorfforNode,
      comparison = false,
    ): PorfforNode => node("Bin", comparison ? "i32" : type, left[2] | right[2], op, left, right);

    let params: PorfforFunctionRecord["params"] = [];
    let retType: PorfforValueSlot | "none" = "none";
    const locals: Record<string, { type: number }> = {};
    let body: PorfforNode[];
    if (operation === "mark") {
      retType = "ptr";
      const initialize = [
        assign(global(globals.base), allocNode(constant(LINEAR_STACK_ARENA_BYTES))),
        assign(global(globals.pointer), global(globals.base)),
      ];
      const condition = binary("==", "i32", global(globals.pointer), constant(0, "ptr"), true);
      body = [
        node("If", "none", condition[2], condition, initialize, null),
        node("Return", "none", PORFFOR_FX.readGlobal, global(globals.pointer), 0, 0),
      ];
    } else if (operation === "allocate") {
      const bytesName = "#js2_stack_bytes";
      const retName = "#js2_stack_ret";
      const nextName = "#js2_stack_next";
      params = [{ name: bytesName, type: typeOrdinal("u32") }];
      retType = "ptr";
      locals[retName] = { type: typeOrdinal("ptr") };
      locals[nextName] = { type: typeOrdinal("ptr") };
      const aligned = binary(
        "&",
        "ptr",
        binary("+", "ptr", binary("+", "ptr", local(retName, "ptr"), local(bytesName, "u32")), constant(7)),
        constant(-8),
      );
      const limit = binary("+", "ptr", global(globals.base), constant(LINEAR_STACK_ARENA_BYTES));
      const overflow = binary(">", "i32", local(nextName, "ptr"), limit, true);
      const fallback = allocNode(local(bytesName, "u32"));
      body = [
        assign(local(retName, "ptr"), global(globals.pointer)),
        assign(local(nextName, "ptr"), aligned),
        node("If", "none", overflow[2], overflow, [node("Return", "none", PORFFOR_FX.call, fallback, 0, 0)], null),
        assign(global(globals.pointer), local(nextName, "ptr")),
        node("Return", "none", PORFFOR_FX.none, local(retName, "ptr"), 0, 0),
      ];
    } else {
      const markName = "#js2_stack_mark";
      params = [{ name: markName, type: typeOrdinal("ptr") }];
      body = [
        assign(global(globals.pointer), local(markName, "ptr")),
        node("Return", "none", PORFFOR_FX.none, null, 0, 0),
      ];
    }
    return {
      name: this.functionPhysicalName(entry),
      index,
      params,
      retType: typeOrdinal(retType),
      locals,
      body,
    };
  }

  private ensureLinearArrayRuntime(
    name: string,
    operation: NonNullable<FunctionEntry["linearArrayRuntime"]>,
  ): FuncHandle {
    const existing = this.funcsByName.get(name);
    if (existing) {
      if (existing.linearArrayRuntime !== operation) {
        throw new Error(`porffor assembler: function '${name}' conflicts with the linear-array runtime`);
      }
      return existing.handle;
    }

    const handle = this.declareFunc(name);
    const entry = this.requireFunc(handle);
    const signatures = {
      resolve: { params: ["ptr"], results: ["ptr"] },
      grow: { params: ["ptr", "i32"], results: ["ptr"] },
      set: { params: ["ptr", "i32", "f64"], results: [] },
      get: { params: ["ptr", "i32"], results: ["f64"] },
      len: { params: ["ptr"], results: ["i32"] },
    } as const;
    entry.signature = { name, ...signatures[operation] };
    entry.linearArrayRuntime = operation;

    if (operation === "set") {
      this.ensureLinearArrayRuntime("#js2_vec_resolve", "resolve");
      this.ensureLinearArrayRuntime("#js2_vec_grow", "grow");
    } else if (operation === "get" || operation === "len") {
      this.ensureLinearArrayRuntime("#js2_vec_resolve", "resolve");
    }
    return handle;
  }

  private assembleLinearArrayRuntimeFunction(
    entry: FunctionEntry,
    index: number,
    operation: NonNullable<FunctionEntry["linearArrayRuntime"]>,
  ): PorfforFunctionRecord {
    const { allocation, layout } = this.requireLinearArrayRuntimeContract();

    const ptrName = "#js2_arr_ptr";
    const indexName = "#js2_arr_index";
    const valueName = "#js2_arr_value";
    const minCapacityName = "#js2_arr_min_capacity";
    const lenName = "#js2_arr_len";
    const capacityName = "#js2_arr_capacity";
    const nextName = "#js2_arr_next";
    const cursorName = "#js2_arr_cursor";
    const params: { name: string; type: number }[] = [];
    const locals: Record<string, { type: number }> = {};
    const addParam = (name: string, type: PorfforValueSlot): void => {
      params.push({ name, type: typeOrdinal(type) });
    };
    const addLocal = (name: string, type: PorfforValueSlot): void => {
      locals[name] = { type: typeOrdinal(type) };
    };
    const local = (name: string, type: PorfforValueSlot): PorfforNode =>
      node("Local", type, PORFFOR_FX.none, name, 0, 0);
    const constant = (value: number, type: PorfforValueSlot = "i32"): PorfforNode =>
      node("Const", type, PORFFOR_FX.none, value, 0, 0);
    const binary = (
      op: string,
      type: PorfforValueSlot,
      left: PorfforNode,
      right: PorfforNode,
      comparison = false,
    ): PorfforNode => node("Bin", comparison ? "i32" : type, left[2] | right[2], op, left, right);
    const assign = (target: PorfforNode, value: PorfforNode): PorfforNode =>
      node("Assign", "none", PORFFOR_FX.writeLocal | value[2], target, value, 0);
    const load = (ctype: string, type: PorfforValueSlot, pointer: PorfforNode, offset: number): PorfforNode =>
      node("Load", type, pointer[2] | PORFFOR_FX.readMem, ctype, pointer, [offset, false]);
    const store = (ctype: string, pointer: PorfforNode, offset: number, value: PorfforNode): PorfforNode =>
      node("Store", "none", pointer[2] | value[2] | PORFFOR_FX.writeMem, ctype, pointer, [offset, false, value]);
    const call = (name: string, type: PorfforValueSlot | "none", args: PorfforNode[]): PorfforNode =>
      node(
        "Call",
        type,
        args.reduce<number>((effects, argument) => effects | argument[2], PORFFOR_FX.call),
        name,
        args,
        0,
      );
    const returnNode = (value: PorfforNode | null = null): PorfforNode =>
      node("Return", "none", value?.[2] ?? PORFFOR_FX.none, value, 0, 0);
    const ifNode = (condition: PorfforNode, then: PorfforNode[], otherwise: PorfforNode[] | null = null): PorfforNode =>
      node("If", "none", condition[2], condition, then, otherwise);
    const loop = (label: string, body: PorfforNode[]): PorfforNode =>
      node("Loop", "none", PORFFOR_FX.none, null, null, [body, label]);
    const breakNode = (label: string): PorfforNode => node("Break", "none", PORFFOR_FX.none, label, 0, 0);

    addParam(ptrName, "ptr");
    let retType: PorfforValueSlot | "none" = "none";
    let body: PorfforNode[];

    if (operation === "resolve") {
      retType = "ptr";
      const label = "#js2_arr_resolve_loop";
      const forwarded = binary(
        "==",
        "i32",
        load("u8", "u32", local(ptrName, "ptr"), LINEAR_ARRAY_FORWARDING.tagOffset),
        constant(LINEAR_ARRAY_FORWARDING.tag, "u32"),
        true,
      );
      body = [
        loop(label, [
          ifNode(binary("==", "i32", forwarded, constant(0), true), [breakNode(label)]),
          assign(
            local(ptrName, "ptr"),
            load("u32", "ptr", local(ptrName, "ptr"), LINEAR_ARRAY_FORWARDING.pointerOffset),
          ),
        ]),
        returnNode(local(ptrName, "ptr")),
      ];
    } else if (operation === "grow") {
      addParam(minCapacityName, "i32");
      addLocal(lenName, "u32");
      addLocal(capacityName, "u32");
      addLocal(nextName, "ptr");
      addLocal(cursorName, "u32");
      retType = "ptr";
      const copyLabel = "#js2_arr_copy_loop";
      const bytes = binary(
        "+",
        "u32",
        constant(layout.elementsOffset, "u32"),
        binary("*", "u32", local(capacityName, "u32"), constant(layout.elementStride, "u32")),
      );
      const allocationNode = allocNode(bytes);
      body = [
        assign(local(lenName, "u32"), load("u32", "u32", local(ptrName, "ptr"), layout.lengthOffset)),
        assign(
          local(capacityName, "u32"),
          binary("*", "u32", load("u32", "u32", local(ptrName, "ptr"), layout.capacityOffset), constant(2, "u32")),
        ),
        ifNode(binary("<", "i32", local(capacityName, "u32"), local(minCapacityName, "i32"), true), [
          assign(local(capacityName, "u32"), local(minCapacityName, "i32")),
        ]),
        ifNode(binary("<", "i32", local(capacityName, "u32"), constant(layout.minimumCapacity, "u32"), true), [
          assign(local(capacityName, "u32"), constant(layout.minimumCapacity, "u32")),
        ]),
        assign(local(nextName, "ptr"), allocationNode),
        store("u32", local(nextName, "ptr"), layout.lengthOffset, local(lenName, "u32")),
        store("u32", local(nextName, "ptr"), layout.capacityOffset, local(capacityName, "u32")),
        assign(local(cursorName, "u32"), constant(0, "u32")),
        loop(copyLabel, [
          ifNode(binary(">=", "i32", local(cursorName, "u32"), local(lenName, "u32"), true), [breakNode(copyLabel)]),
          store(
            "f64",
            binary(
              "+",
              "ptr",
              local(nextName, "ptr"),
              binary("*", "u32", local(cursorName, "u32"), constant(layout.elementStride, "u32")),
            ),
            layout.elementsOffset,
            load(
              "f64",
              "f64",
              binary(
                "+",
                "ptr",
                local(ptrName, "ptr"),
                binary("*", "u32", local(cursorName, "u32"), constant(layout.elementStride, "u32")),
              ),
              layout.elementsOffset,
            ),
          ),
          assign(local(cursorName, "u32"), binary("+", "u32", local(cursorName, "u32"), constant(1, "u32"))),
        ]),
        store(
          "u8",
          local(ptrName, "ptr"),
          LINEAR_ARRAY_FORWARDING.tagOffset,
          constant(LINEAR_ARRAY_FORWARDING.tag, "u32"),
        ),
        store("u32", local(ptrName, "ptr"), LINEAR_ARRAY_FORWARDING.pointerOffset, local(nextName, "ptr")),
        returnNode(local(nextName, "ptr")),
      ];
    } else if (operation === "set") {
      addParam(indexName, "i32");
      addParam(valueName, "f64");
      addLocal(cursorName, "u32");
      const fillLabel = "#js2_arr_fill_loop";
      body = [
        ifNode(binary("<", "i32", local(indexName, "i32"), constant(0), true), [returnNode()]),
        assign(local(ptrName, "ptr"), call("#js2_vec_resolve", "ptr", [local(ptrName, "ptr")])),
        ifNode(
          binary(
            ">=",
            "i32",
            local(indexName, "i32"),
            load("u32", "u32", local(ptrName, "ptr"), layout.capacityOffset),
            true,
          ),
          [
            assign(
              local(ptrName, "ptr"),
              call("#js2_vec_grow", "ptr", [
                local(ptrName, "ptr"),
                binary("+", "i32", local(indexName, "i32"), constant(1)),
              ]),
            ),
          ],
        ),
        assign(local(cursorName, "u32"), load("u32", "u32", local(ptrName, "ptr"), layout.lengthOffset)),
        loop(fillLabel, [
          ifNode(binary(">=", "i32", local(cursorName, "u32"), local(indexName, "i32"), true), [breakNode(fillLabel)]),
          store(
            "f64",
            binary(
              "+",
              "ptr",
              local(ptrName, "ptr"),
              binary("*", "u32", local(cursorName, "u32"), constant(layout.elementStride, "u32")),
            ),
            layout.elementsOffset,
            constant(0, "f64"),
          ),
          assign(local(cursorName, "u32"), binary("+", "u32", local(cursorName, "u32"), constant(1, "u32"))),
        ]),
        ifNode(
          binary(
            ">=",
            "i32",
            local(indexName, "i32"),
            load("u32", "u32", local(ptrName, "ptr"), layout.lengthOffset),
            true,
          ),
          [
            store(
              "u32",
              local(ptrName, "ptr"),
              layout.lengthOffset,
              binary("+", "i32", local(indexName, "i32"), constant(1)),
            ),
          ],
        ),
        store(
          "f64",
          binary(
            "+",
            "ptr",
            local(ptrName, "ptr"),
            binary("*", "u32", local(indexName, "i32"), constant(layout.elementStride, "u32")),
          ),
          layout.elementsOffset,
          local(valueName, "f64"),
        ),
        returnNode(),
      ];
    } else if (operation === "get") {
      addParam(indexName, "i32");
      retType = "f64";
      body = [
        assign(local(ptrName, "ptr"), call("#js2_vec_resolve", "ptr", [local(ptrName, "ptr")])),
        ifNode(binary("<", "i32", local(indexName, "i32"), constant(0), true), [
          returnNode(constant(Number.NaN, "f64")),
        ]),
        ifNode(
          binary(
            ">=",
            "i32",
            local(indexName, "i32"),
            load("u32", "u32", local(ptrName, "ptr"), layout.lengthOffset),
            true,
          ),
          [returnNode(constant(Number.NaN, "f64"))],
        ),
        returnNode(
          load(
            "f64",
            "f64",
            binary(
              "+",
              "ptr",
              local(ptrName, "ptr"),
              binary("*", "u32", local(indexName, "i32"), constant(layout.elementStride, "u32")),
            ),
            layout.elementsOffset,
          ),
        ),
      ];
    } else {
      retType = "i32";
      body = [
        assign(local(ptrName, "ptr"), call("#js2_vec_resolve", "ptr", [local(ptrName, "ptr")])),
        returnNode(load("i32", "i32", local(ptrName, "ptr"), layout.lengthOffset)),
      ];
    }

    return { name: this.functionPhysicalName(entry), index, params, retType: typeOrdinal(retType), locals, body };
  }

  /**
   * Runtime calls do not carry an allocation-site operand. Until shared IR
   * does, a Porffor growth helper can bind safely only when the plan has one
   * exact f64 vector site. Reject ambiguity instead of choosing the first site
   * with the same layout and silently attributing growth to the wrong owner.
   */
  private requireLinearArrayRuntimeContract() {
    const plan = this.requireMemoryPlan();
    const layout = plan.layoutForVector(irVal({ kind: "f64" }));
    if (!layout || layout.elementStorage !== "f64") {
      throw new Error("porffor assembler: f64 vector layout is absent for the array runtime");
    }
    const allocations = plan.allocationsForLayout(layout.id);
    if (allocations.length !== 1) {
      throw new Error(
        `porffor assembler: array runtime requires one exact allocation for '${layout.id}', found ${allocations.length}`,
      );
    }
    const allocation = allocations[0]!;
    if (allocation.allocationClass !== "arena" || allocation.allocationKind !== "array") {
      throw new Error(`porffor assembler: array runtime requires one arena array allocation for '${layout.id}'`);
    }
    plannedOperation(
      allocation.operations,
      (candidate) =>
        candidate.family === "vector" &&
        candidate.operation === "grow" &&
        candidate.allocationClass === allocation.allocationClass &&
        candidate.elementStorage === layout.elementStorage,
      `exact vector grow operation for allocation ${allocation.id as number}`,
    );
    const forwarding = LINEAR_ARRAY_FORWARDING;
    if (
      forwarding.tagOffset < 0 ||
      forwarding.pointerOffset < 0 ||
      forwarding.pointerBytes <= 0 ||
      forwarding.pointerOffset % forwarding.pointerBytes !== 0 ||
      forwarding.tagOffset >= layout.lengthOffset ||
      forwarding.pointerOffset + forwarding.pointerBytes > layout.lengthOffset
    ) {
      throw new Error(`porffor assembler: array forwarding contract overlaps '${layout.id}' vector fields`);
    }
    return { allocation, layout };
  }

  private instrumentPorfforStackFrame(
    body: readonly PorfforNode[],
    markName: string,
    resultName: string | null,
    resultType: PorfforValueSlot | null,
  ): PorfforNode[] {
    const markLocal = node("Local", "ptr", PORFFOR_FX.none, markName, 0, 0);
    const markCall = node("Call", "ptr", PORFFOR_FX.call, "#js2_stack_mark", [], 0);
    const enter = node("Assign", "none", PORFFOR_FX.writeLocal | PORFFOR_FX.call, markLocal, markCall, 0);
    const restore = (): PorfforNode => node("Call", "none", PORFFOR_FX.call, "#js2_stack_restore", [markLocal], 0);

    const rewrite = (statements: readonly PorfforNode[]): PorfforNode[] =>
      statements.flatMap((statement) => {
        const kind = PORFFOR_KIND_NAMES[statement[0]];
        if (kind === "Return") {
          const value = statement[3] as PorfforNode | null;
          if (!value || !resultName || !resultType) return [restore(), statement];
          const resultLocal = node("Local", resultType, PORFFOR_FX.none, resultName, 0, 0);
          return [
            node("Assign", "none", PORFFOR_FX.writeLocal | value[2], resultLocal, value, 0),
            restore(),
            node("Return", "none", PORFFOR_FX.none, resultLocal, 0, 0),
          ];
        }
        if (kind === "Block") {
          return [
            [
              statement[0],
              statement[1],
              statement[2],
              rewrite(statement[3] as readonly PorfforNode[]),
              statement[4],
              statement[5],
            ],
          ];
        }
        if (kind === "If") {
          const otherwise = statement[5] as readonly PorfforNode[] | null;
          return [
            [
              statement[0],
              statement[1],
              statement[2],
              statement[3],
              rewrite(statement[4] as readonly PorfforNode[]),
              otherwise ? rewrite(otherwise) : null,
            ],
          ];
        }
        if (kind === "Loop") {
          const [loopBody, label] = statement[5] as readonly [readonly PorfforNode[], string];
          return [[statement[0], statement[1], statement[2], statement[3], statement[4], [rewrite(loopBody), label]]];
        }
        return [statement];
      });
    return [enter, ...rewrite(body)];
  }

  private assembleStatements(
    statements: readonly PorfforStatement[],
    locals: readonly LocalBinding[],
    funcName: string,
    frames: readonly ControlFrame[],
  ): PorfforNode[] {
    const out: PorfforNode[] = [];
    for (const statement of statements) {
      switch (statement.kind) {
        case "assign": {
          const target = this.assembleTarget(statement.target, locals);
          const value = this.assembleExpr(statement.value, locals);
          const globalWrite = statement.target.kind === "global" ? PORFFOR_FX.readGlobal : PORFFOR_FX.none;
          out.push(
            node("Assign", "none", PORFFOR_FX.writeLocal | target[2] | value[2] | globalWrite, target, value, 0),
          );
          break;
        }
        case "expr":
          out.push(this.assembleExpr(statement.value, locals));
          break;
        case "if": {
          const label = controlLabel(funcName, statement.controlId);
          const nextFrames = [...frames, { kind: "if" as const, label }];
          const condition = this.assembleExpr(statement.condition, locals);
          const thenBody = this.assembleStatements(statement.then, locals, funcName, nextFrames);
          const elseBody = this.assembleStatements(statement.else, locals, funcName, nextFrames);
          const ifNode = node("If", "none", condition[2], condition, thenBody, elseBody.length === 0 ? null : elseBody);
          out.push(node("Block", "none", PORFFOR_FX.none, [ifNode], label, 0));
          break;
        }
        case "block": {
          const label = controlLabel(funcName, statement.controlId);
          const body = this.assembleStatements(statement.body, locals, funcName, [...frames, { kind: "block", label }]);
          out.push(node("Block", "none", PORFFOR_FX.none, body, label, 0));
          break;
        }
        case "loop": {
          const label = controlLabel(funcName, statement.controlId);
          const body = this.assembleStatements(statement.body, locals, funcName, [...frames, { kind: "loop", label }]);
          out.push(node("Loop", "none", PORFFOR_FX.none, null, null, [body, label]));
          break;
        }
        case "branch": {
          const branch = assembleBranch(statement.depth, frames);
          if (statement.condition) {
            const condition = this.assembleExpr(statement.condition, locals);
            out.push(node("If", "none", condition[2], condition, [branch], null));
          } else {
            out.push(branch);
          }
          break;
        }
        case "store": {
          const pointer = this.assembleExpr(statement.pointer, locals);
          const value = this.assembleExpr(statement.value, locals);
          out.push(
            node("Store", "none", pointer[2] | value[2] | PORFFOR_FX.writeMem, statement.ctype, pointer, [
              statement.offset,
              false,
              value,
            ]),
          );
          break;
        }
        case "mem-copy": {
          const destination = this.assembleExpr(statement.destination, locals);
          const source = this.assembleExpr(statement.source, locals);
          const bytes = this.assembleExpr(statement.bytes, locals);
          out.push(
            node(
              "MemCopy",
              "none",
              destination[2] | source[2] | bytes[2] | PORFFOR_FX.readMem | PORFFOR_FX.writeMem,
              destination,
              source,
              [bytes, statement.mayOverlap],
            ),
          );
          break;
        }
        case "gc-barrier": {
          const pointer = this.assembleExpr(statement.pointer, locals);
          const typeId = this.assembleExpr(statement.typeId, locals);
          out.push(node("GcBarrier", "none", pointer[2] | typeId[2] | PORFFOR_FX.writeMem, pointer, typeId, 0));
          break;
        }
        case "return": {
          const value = statement.value ? this.assembleExpr(statement.value, locals) : null;
          out.push(node("Return", "none", value?.[2] ?? PORFFOR_FX.none, value, 0, 0));
          break;
        }
        case "unreachable":
          out.push(node("Unreachable", "none", PORFFOR_FX.none, null, 0, 0));
          break;
      }
    }
    return out;
  }

  private assembleTarget(target: PorfforTarget, locals: readonly LocalBinding[]): PorfforNode {
    if (target.kind === "local") {
      const binding = this.resolveLocal(target.local, locals);
      return node("Local", binding.type, PORFFOR_FX.none, binding.name, 0, 0);
    }
    const global = this.globalSymbol(target.handle);
    return node("Global", global.type, PORFFOR_FX.readGlobal, global.name, 0, 0);
  }

  private assembleExpr(expression: PorfforExpr, locals: readonly LocalBinding[]): PorfforNode {
    const type = this.resolveTypeRef(expression.type, locals);
    switch (expression.kind) {
      case "const":
        return node(
          "Const",
          type,
          PORFFOR_FX.none,
          type === "i64" || type === "u64" ? String(expression.value) : Number(expression.value),
          0,
          0,
        );
      case "local": {
        const binding = this.resolveLocal(expression.local, locals);
        return node("Local", binding.type, PORFFOR_FX.none, binding.name, 0, 0);
      }
      case "global": {
        const global = this.globalSymbol(expression.handle);
        return node("Global", global.type, PORFFOR_FX.readGlobal, global.name, 0, 0);
      }
      case "binary": {
        const left = this.assembleExpr(expression.left, locals);
        const right = this.assembleExpr(expression.right, locals);
        return node("Bin", expression.comparison ? "i32" : type, left[2] | right[2], expression.op, left, right);
      }
      case "unary": {
        const value = this.assembleExpr(expression.value, locals);
        return node("Un", type, value[2], expression.op, value, 0);
      }
      case "select": {
        const condition = this.assembleExpr(expression.condition, locals);
        const whenTrue = this.assembleExpr(expression.whenTrue, locals);
        const whenFalse = this.assembleExpr(expression.whenFalse, locals);
        return node("Select", type, condition[2] | whenTrue[2] | whenFalse[2], condition, whenTrue, whenFalse);
      }
      case "convert": {
        const value = this.assembleExpr(expression.value, locals);
        return node("Convert", type, value[2], value[1], value, expression.flags);
      }
      case "alloc": {
        const bytes = this.assembleExpr(expression.bytes, locals);
        const allocation = this.memoryPlan?.allocations.find(
          (candidate) => (candidate.id as number) === expression.siteId,
        );
        if (!allocation) throw new Error(`porffor assembler: allocation site ${expression.siteId} is not planned`);
        if (this.plannedAllocationClass(allocation) === "stack") {
          if (!this.stackGlobals) throw new Error("porffor assembler: stack allocation has no runtime");
          return node("Call", "ptr", bytes[2] | PORFFOR_FX.call, "#js2_stack_allocate", [bytes], 0);
        }
        return allocNode(bytes, expression.typeId);
      }
      case "load": {
        const pointer = this.assembleExpr(expression.pointer, locals);
        return node("Load", type, pointer[2] | PORFFOR_FX.readMem, expression.ctype, pointer, [
          expression.offset,
          false,
        ]);
      }
      case "call": {
        const symbol = this.functionSymbol(expression.target);
        const args = expression.args.map((arg) => this.assembleExpr(arg, locals));
        const effects = args.reduce<number>((combined, arg) => combined | arg[2], PORFFOR_FX.call);
        return node("Call", type, effects, symbol.name, args, 0);
      }
    }
  }

  private resolveTypeRef(type: PorfforTypeRef, locals: readonly LocalBinding[]): PorfforValueSlot {
    if (typeof type === "string") return type;
    if (type.kind === "local") return this.resolveLocal(type.local, locals).type;
    return this.globalSymbol(type.handle).type;
  }

  private resolveLocal(local: PorfforLocalRef, locals: readonly LocalBinding[]): LocalBinding {
    if (local.kind === "scratch") return { name: local.name, type: this.resolveTypeRef(local.type, locals) };
    const binding = locals[local.index];
    if (!binding) throw new Error(`porffor assembler: unresolved lowered local index ${local.index}`);
    return binding;
  }

  private oneSlot(type: Parameters<PorfforTypeConverter["convertType"]>[0], where: string): PorfforValueSlot {
    return oneLoweredSlot(this.typeConverter.convertType(type), where);
  }

  private requireMemoryPlan(): LinearMemoryPlan {
    if (!this.memoryPlan) throw new Error("porffor assembler: heap lowering requires a shared LinearMemoryPlan");
    return this.memoryPlan;
  }

  private allocationFor(layoutId: string, alloc?: AllocSiteId) {
    const plan = this.requireMemoryPlan();
    if (alloc === undefined) {
      const allocation = plan.allocationsForLayout(layoutId)[0];
      if (!allocation) throw new Error(`porffor assembler: plan has no allocation for '${layoutId}'`);
      return allocation;
    }
    const allocation = plan.allocation(alloc);
    if (!allocation) throw new Error(`porffor assembler: allocation site ${alloc as number} is absent from the plan`);
    if (allocation.layoutId !== layoutId) {
      throw new Error(
        `porffor assembler: allocation site ${alloc as number} planned '${allocation.layoutId}', expected '${layoutId}'`,
      );
    }
    return allocation;
  }

  private f64VecHandle(alloc?: AllocSiteId): IrVecLowering & LinearVecLowering {
    const plan = this.requireMemoryPlan();
    const layout = plan.layoutForVector(irVal({ kind: "f64" }));
    if (!layout) throw new Error("porffor assembler: f64 vector layout is absent from the shared memory plan");
    const allocation = this.allocationFor(layout.id, alloc);
    const allocate = plannedOperation(
      allocation.operations,
      (operation) => operation.family === "vector" && operation.operation === "allocate",
      `vector allocation for '${layout.id}'`,
    );
    const initializeElement = plannedOperation(
      allocation.operations,
      (operation) => operation.family === "vector" && operation.operation === "initialize-element",
      `vector element initialization for '${layout.id}'`,
    );
    return {
      valueType: { kind: "i32" },
      vecStructTypeIdx: PORFFOR_LINEAR_F64_VEC_TYPE_INDEX,
      lengthFieldIdx: 0,
      dataFieldIdx: 0,
      arrayTypeIdx: 0,
      elementValType: { kind: "f64" },
      linearMemory: { allocation, layout, allocate, initializeElement },
    };
  }

  private assignPhysicalFunctionNames(): void {
    const entries = [...this.funcsByHandle.values()];
    const reserved = new Set(entries.map((entry) => entry.name));
    const used = new Set<string>();
    const byDisplayName = new Map<string, FunctionEntry[]>();
    for (const entry of entries) {
      const sameLabel = byDisplayName.get(entry.name);
      if (sameLabel) sameLabel.push(entry);
      else byDisplayName.set(entry.name, [entry]);
    }

    for (const displayName of [...byDisplayName.keys()].sort(compareText)) {
      const sameLabel = byDisplayName.get(displayName)!.sort(compareFunctionEntry);
      if (sameLabel.length === 1) {
        sameLabel[0]!.physicalName = displayName;
        used.add(displayName);
        continue;
      }

      const provider = sameLabel.find((entry) => entry.unitId === undefined);
      if (provider) {
        provider.physicalName = displayName;
        used.add(displayName);
      }
      for (const entry of sameLabel) {
        if (entry === provider) continue;
        const unitId = entry.unitId;
        if (unitId === undefined) {
          throw new Error(`porffor assembler: duplicate provider function label '${displayName}'`);
        }
        const encoded = encodeURIComponent(unitId);
        let candidate = `${displayName}__ir_${encoded}`;
        let discriminator = 0;
        while (reserved.has(candidate) || used.has(candidate)) {
          candidate = `__ir_identity_${encoded}_${discriminator++}`;
        }
        entry.physicalName = candidate;
        used.add(candidate);
      }
    }
  }

  private functionPhysicalName(entry: FunctionEntry): string {
    if (!entry.physicalName) {
      throw new Error(`porffor assembler: function '${entry.name}' has no finalized physical name`);
    }
    return entry.physicalName;
  }

  private bindTypeName(name: string, entry: TypeEntry): void {
    const existing = this.typesByName.get(name);
    if (existing && existing !== entry) throw new Error(`porffor assembler: duplicate type name '${name}'`);
    this.typesByName.set(name, entry);
  }

  private requireFunc(handle: FuncHandle): FunctionEntry {
    const entry = this.funcsByHandle.get(handle);
    if (!entry) throw new Error(`porffor assembler: unknown function handle ${handle}`);
    return entry;
  }

  private requireGlobal(handle: GlobalHandle): GlobalEntry {
    const entry = this.globalsByHandle.get(handle);
    if (!entry) throw new Error(`porffor assembler: unknown global handle ${handle}`);
    return entry;
  }

  private assertMutable(action: string): void {
    if (this.frozen) throw new Error(`porffor assembler: cannot ${action} after finalize`);
  }
}

function isAllocationBindingOperation(operation: LinearRuntimeOperation): boolean {
  return (
    (operation.family === "memory" && operation.operation === "allocate") ||
    (operation.family === "vector" && operation.operation === "allocate") ||
    (operation.family === "string" && operation.operation === "materialize-data") ||
    (operation.family === "managed" && operation.operation === "allocate")
  );
}

function linearArrayRuntimeKind(name: string): FunctionEntry["linearArrayRuntime"] {
  if (name.startsWith(IR_VEC_ELEM_SET_PREFIX)) {
    const element = parseIrVectorRuntimeElement(name, IR_VEC_ELEM_SET_PREFIX);
    if (element?.kind !== "f64") {
      throw new Error(`porffor assembler: unsupported logical vector helper '${name}'`);
    }
    return "set";
  }
  const set = /^__vec_elem_set_(\d+)$/.exec(name);
  if (set) {
    const vectorTypeIndex = Number(set[1]);
    if (vectorTypeIndex !== PORFFOR_LINEAR_F64_VEC_TYPE_INDEX) {
      throw new Error(
        `porffor assembler: unsupported non-f64 vector helper '${name}' (expected type index ${PORFFOR_LINEAR_F64_VEC_TYPE_INDEX})`,
      );
    }
    return "set";
  }
  if (name === "__arr_get") return "get";
  if (name === "__arr_len") return "len";
  return undefined;
}

function oneLoweredSlot(slots: readonly PorfforValueSlot[], where: string): PorfforValueSlot {
  if (slots.length !== 1) throw new Error(`porffor backend requires exactly one scalar slot for ${where}`);
  return slots[0]!;
}

function memoryValType(storage: LinearStorageKind): ValType | null {
  if (storage === "f64") return { kind: "f64" };
  if (storage === "i32" || storage === "pointer") return { kind: "i32" };
  return null;
}

function plannedOperation(
  operations: readonly LinearRuntimeOperation[],
  predicate: (operation: LinearRuntimeOperation) => boolean,
  label: string,
): LinearRuntimeOperation {
  const operation = operations.find(predicate);
  if (!operation) throw new Error(`porffor assembler: shared plan has no ${label}`);
  return operation;
}

function assembleBranch(depth: number, frames: readonly ControlFrame[]): PorfforNode {
  const frame = frames[frames.length - 1 - depth];
  if (!frame) throw new Error(`porffor assembler: branch depth ${depth} has no enclosing control frame`);
  return frame.kind === "loop"
    ? node("Continue", "none", PORFFOR_FX.none, frame.label, 0, 0)
    : node("Break", "none", PORFFOR_FX.none, frame.label, 0, 0);
}

function controlLabel(funcName: string, id: number): string {
  return `#js2_${funcName}_cf_${id}`;
}

function node(
  kind: (typeof PORFFOR_KIND_NAMES)[number],
  type: PorfforValueSlot | "none",
  effects: number,
  a: unknown,
  b: unknown,
  c: unknown,
): PorfforNode {
  const kindOrdinal = PORFFOR_KIND_NAMES.indexOf(kind);
  if (kindOrdinal < 0) throw new Error(`porffor assembler: unknown node kind '${kind}'`);
  return [kindOrdinal, typeOrdinal(type), effects, a, b, c];
}

/**
 * Assemble the exact upstream Alloc node shape.
 *
 * Allocation-site provenance and class selection remain in LinearMemoryPlan
 * and are consumed before this boundary; pre-alpha 9 no longer carries JS2's
 * former [siteId, raw] adapter metadata in slot C.
 */
function allocNode(bytes: PorfforNode, typeId = 0): PorfforNode {
  return node("Alloc", "ptr", bytes[2] | PORFFOR_FX.call, bytes, typeId, 0);
}

function typeOrdinal(type: PorfforValueSlot | "none"): number {
  const ordinal = TYPE_ORDINAL.get(type);
  if (ordinal === undefined) throw new Error(`porffor assembler: unknown value type '${type}'`);
  return ordinal;
}

function requirePosition<Handle extends number>(
  positions: ReadonlyMap<Handle, number>,
  handle: Handle,
  kind: string,
): number {
  const position = positions.get(handle);
  if (position === undefined) throw new Error(`porffor assembler: unknown ${kind} handle ${handle}`);
  return position;
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return compareText(left.name, right.name);
}

function compareFunctionEntry(left: FunctionEntry, right: FunctionEntry): number {
  const nameOrder = compareText(left.name, right.name);
  if (nameOrder !== 0) return nameOrder;
  if (left.unitId !== undefined && right.unitId !== undefined) {
    return compareIrIdentity(left.unitId, right.unitId);
  }
  if (left.unitId !== undefined) return 1;
  if (right.unitId !== undefined) return -1;
  return compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Guard the copied symbolic effect table against compatibility-fingerprint drift.
if (EFFECT_ORDINAL.get("call") !== PORFFOR_FX.call || EFFECT_ORDINAL.get("writeLocal") !== PORFFOR_FX.writeLocal) {
  throw new Error("porffor compatibility effect ordinals drifted from the symbolic sink");
}
