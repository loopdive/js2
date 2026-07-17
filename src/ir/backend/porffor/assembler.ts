// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ModuleLayout } from "../../../emit/resolve-layout.js";
import type { IrFunction, IrFuncRef, IrGlobalRef, IrTypeRef } from "../../nodes.js";
import type { IrLoweredBody, IrLowerResolver } from "../../lower.js";
import type { FuncHandle, FuncTypeDef, GlobalHandle, TypeHandle, ValType } from "../../types.js";
import type { ModuleAssembler } from "../contract.js";
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
  readonly name: string;
  signature?: PorfforFunctionSymbol;
  definition?: PorfforFunctionDefinition;
}

interface GlobalEntry {
  readonly handle: GlobalHandle;
  readonly name: string;
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

/**
 * Porffor module/index authority. Handles are registration-order identities;
 * final Porffor function/global array positions are assigned once, by stable
 * symbolic name order, in `finalize()`.
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
  private readonly funcsByName = new Map<string, FunctionEntry>();
  private readonly globalsByHandle = new Map<GlobalHandle, GlobalEntry>();
  private readonly globalsByName = new Map<string, GlobalEntry>();
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

  setPreferences(preferences: Readonly<Record<string, unknown>>): void {
    this.assertMutable("set preferences");
    this.preferences = { gc: false, ...preferences };
  }

  /** Declare an IR function and freeze its scalar signature before bodies lower. */
  declareIrFunction(func: IrFunction): FuncHandle {
    const handle = this.declareFunc(func.name);
    const entry = this.requireFunc(handle);
    entry.signature = {
      name: func.name,
      params: func.params.map((param) => this.oneSlot(param.type, `param ${param.name} of ${func.name}`)),
      results: func.resultTypes.map((type, index) => this.oneSlot(type, `result ${index} of ${func.name}`)),
    };
    if (entry.signature.results.length > 1) {
      throw new Error(`porffor backend does not support multi-value function '${func.name}'`);
    }
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

  finalize(): ModuleLayout {
    this.assertMutable("finalize");
    this.frozen = true;

    const functions = [...this.funcsByHandle.values()].sort(byName);
    const globals = [...this.globalsByHandle.values()].sort(byName);
    const types = [...this.typesByHandle.values()].sort((left, right) => compareText(left.key, right.key));
    for (const entry of functions) {
      if (!entry.signature) throw new Error(`porffor assembler: function '${entry.name}' has no registered signature`);
      if (!entry.definition)
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
      entry: this.start === null ? null : this.requireFunc(this.start).name,
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
    const handle = this.lookupFunc(ref.name);
    if (handle === undefined) throw new Error(`porffor assembler: unresolved function '${ref.name}'`);
    return handle;
  }

  resolveGlobal(ref: IrGlobalRef): number {
    const handle = this.lookupGlobal(ref.name);
    if (handle === undefined) throw new Error(`porffor assembler: unresolved global '${ref.name}'`);
    return handle;
  }

  resolveType(ref: IrTypeRef): number {
    const handle = this.lookupType(ref.name);
    if (handle === undefined) throw new Error(`porffor assembler: unresolved type '${ref.name}'`);
    return handle;
  }

  internFuncType(_type: FuncTypeDef): number {
    throw new Error("porffor backend does not intern Wasm function types");
  }

  functionSymbol(handle: number): PorfforFunctionSymbol {
    const entry = this.requireFunc(handle);
    if (!entry.signature) throw new Error(`porffor assembler: function '${entry.name}' has no registered signature`);
    return entry.signature;
  }

  globalSymbol(handle: number): PorfforGlobalSymbol {
    const entry = this.requireGlobal(handle);
    if (!entry.definition) throw new Error(`porffor assembler: global '${entry.name}' has no definition`);
    return { name: entry.name, type: entry.definition.type };
  }

  private assembleFunction(entry: FunctionEntry, index: number): PorfforFunctionRecord {
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

    lowered.body.assertEmpty(`function ${entry.name}`);
    const body = this.assembleStatements(lowered.body.statements, indexedLocals, entry.name, []);
    return {
      name: entry.name,
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

function oneLoweredSlot(slots: readonly PorfforValueSlot[], where: string): PorfforValueSlot {
  if (slots.length !== 1) throw new Error(`porffor backend requires exactly one scalar slot for ${where}`);
  return slots[0]!;
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Guard the copied symbolic effect table against compatibility-fingerprint drift.
if (EFFECT_ORDINAL.get("call") !== PORFFOR_FX.call || EFFECT_ORDINAL.get("writeLocal") !== PORFFOR_FX.writeLocal) {
  throw new Error("porffor compatibility effect ordinals drifted from the symbolic sink");
}
