// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ---------------------------------------------------------------------------
// Backend-contract conformance skeleton (#3029-S1).
//
// Two jobs, both COMPILE-TIME enforced (this file lives under src/** so the
// `quality` gate's `pnpm run typecheck` checks it; vitest does not typecheck):
//
//   1. Prove the three existing emitters satisfy `BackendEmitter<Sink>` with
//      their own sink types (the S1 acceptance criterion). They already
//      declare `implements`, but the checks here go through the CONTRACT
//      module's re-export, so a drift between contract.ts and emitter.ts is
//      a compile error in this file.
//   2. Provide a STUB BACKEND implementing all five contract parts against a
//      sink that is neither `Instr[]` nor `BytecodeSink` (`string[]`) —
//      proving the interfaces are implementable from scratch with no
//      knowledge of another backend's internals. The stub's ModuleAssembler
//      is a real (minimal) implementation of the mint/define/finalize
//      protocol so tests/backend-contract.test.ts can exercise the
//      index-identity invariants (A1–A5) at runtime.
//
// The stub is NOT a compilation path. Nothing in the compiler imports it.
// ---------------------------------------------------------------------------

import { irGlobalBindingKey, irTypeBindingKey } from "../abi-bindings.js";
import { irCallableBindingKey } from "../callable-bindings.js";
import type { AllocSiteId, IrFuncRef, IrFunction, IrGlobalRef, IrInstr, IrType, IrTypeRef } from "../nodes.js";
import type { IrStringConcatMode, IrStringEncoding } from "../string-runtime.js";
import type { BlockType, FuncHandle, FuncTypeDef, GlobalHandle, Instr, TypeHandle, ValType } from "../types.js";
import type { ModuleLayout } from "../../emit/resolve-layout.js";
import {
  type BackendContract,
  type BackendEmitter,
  type BackendLegality,
  type IrBackendKind,
  type IrLowerResolver,
  type ModuleAssembler,
  type TypeConverter,
  legalityFor,
} from "./contract.js";
import type { IrBinop, IrUnop } from "../nodes.js";
import type { BackendI32BitwiseOp, BackendNumericConversionOp, BackendScalarConstType } from "./emitter.js";
import type {
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrVecLowering,
  LinearVecLowering,
} from "./handles.js";
import type { WasmGcEmitter } from "./wasmgc-emitter.js";
import type { LinearEmitter } from "./linear-emitter.js";
import type { BytecodeEmitter, BytecodeSink } from "./bytecode-emitter.js";
import type { PorfforEmitter, PorfforSink } from "./porffor/sink.js";

// ---------------------------------------------------------------------------
// 1 — the three in-tree emitters conform (type-level; no runtime cost)
// ---------------------------------------------------------------------------

type Conforms<Impl, Contract> = Impl extends Contract ? true : never;

// Each of these lines FAILS TO COMPILE if the emitter stops satisfying the
// contract surface (assigning `true` to `never` is a type error).
const wasmGcEmitterConforms: Conforms<WasmGcEmitter, BackendEmitter<Instr[]>> = true;
const linearEmitterConforms: Conforms<LinearEmitter, BackendEmitter<Instr[]>> = true;
const bytecodeEmitterConforms: Conforms<BytecodeEmitter, BackendEmitter<BytecodeSink>> = true;
const porfforEmitterConforms: Conforms<PorfforEmitter, BackendEmitter<PorfforSink>> = true;
export const emittersConform: boolean =
  wasmGcEmitterConforms && linearEmitterConforms && bytecodeEmitterConforms && porfforEmitterConforms;

// ---------------------------------------------------------------------------
// 2 — the stub backend
// ---------------------------------------------------------------------------

/** The stub's sink: a flat trace of op names (proves Sink generality). */
export type StubSink = string[];

/**
 * The stub reuses an in-tree kind tag: `IrBackendKind` is itself append-only
 * (a real fourth backend ADDS a union member — additive, per the freeze
 * rules), but a conformance stub must not widen the enum for production
 * legality checks.
 */
const STUB_KIND: IrBackendKind = "bytecode";

type StubVecLayout = IrVecLowering | LinearVecLowering;

export class StubEmitter implements BackendEmitter<StubSink> {
  constructor(readonly backend: IrBackendKind = STUB_KIND) {}
  newSink(): StubSink {
    return [];
  }
  pushRaw(out: StubSink, instr: Instr): void {
    out.push(`raw:${instr.op}`);
  }
  emitStringConst(value: string, _alloc: AllocSiteId | undefined, out: StubSink): void {
    out.push(`string.const:${value}`);
  }
  emitStringConcat(_alloc: AllocSiteId | undefined, mode: IrStringConcatMode, out: StubSink): void {
    out.push(`string.concat:${mode}`);
  }
  emitStringEquals(negate: boolean, out: StubSink): void {
    out.push(`string.eq:${negate}`);
  }
  emitStringLength(_inputEncoding: IrStringEncoding | undefined, out: StubSink): void {
    out.push("string.length");
  }
  emitStringCharAt(_alloc: AllocSiteId | undefined, inputEncoding: IrStringEncoding, out: StubSink): void {
    out.push(`string.char_at:${inputEncoding}`);
  }
  emitStringCharCodeAt(inputEncoding: IrStringEncoding, out: StubSink): void {
    out.push(`string.char_code_at:${inputEncoding}`);
  }
  emitVecLen(_layout: StubVecLayout, out: StubSink): void {
    out.push("vec.len");
  }
  emitVecDataPtr(_layout: StubVecLayout, out: StubSink): void {
    out.push("vec.dataptr");
  }
  emitElemGet(_layout: StubVecLayout, out: StubSink): void {
    out.push("elem.get");
  }
  emitElemSet(_layout: StubVecLayout, _scratch: number, out: StubSink): void {
    out.push("elem.set");
  }
  emitVecSetLength(_layout: StubVecLayout, out: StubSink): void {
    out.push("vec.set_length");
  }
  emitVecNewFixed(_layout: StubVecLayout, count: number, capacity: number, _scratch: number, out: StubSink): void {
    out.push(`vec.new_fixed:${count}:${capacity}`);
  }
  emitConst(instr: Extract<IrInstr, { kind: "const" }>, _funcName: string, out: StubSink): void {
    out.push(`const:${instr.value.kind}`);
  }
  emitBinary(op: IrBinop, out: StubSink): void {
    out.push(`binary:${op}`);
  }
  emitUnary(op: IrUnop, out: StubSink): void {
    out.push(`unary:${op}`);
  }
  emitScalarConst(type: BackendScalarConstType, value: number, out: StubSink): void {
    out.push(`scalar.const:${type}:${value}`);
  }
  emitNumericConversion(op: BackendNumericConversionOp, out: StubSink): void {
    out.push(`numeric.convert:${op}`);
  }
  emitI32Bitwise(op: BackendI32BitwiseOp, out: StubSink): void {
    out.push(`i32.bitwise:${op}`);
  }
  emitLocalGet(index: number, out: StubSink): void {
    out.push(`local.get:${index}`);
  }
  emitLocalSet(index: number, out: StubSink): void {
    out.push(`local.set:${index}`);
  }
  emitLocalTee(index: number, out: StubSink): void {
    out.push(`local.tee:${index}`);
  }
  emitGlobalGet(index: number, out: StubSink): void {
    out.push(`global.get:${index}`);
  }
  emitGlobalSet(index: number, out: StubSink): void {
    out.push(`global.set:${index}`);
  }
  emitDrop(out: StubSink): void {
    out.push("drop");
  }
  emitSelect(out: StubSink): void {
    out.push("select");
  }
  emitReturn(out: StubSink): void {
    out.push("return");
  }
  emitUnreachable(out: StubSink): void {
    out.push("unreachable");
  }
  emitIf(_blockType: BlockType, then: StubSink, els: StubSink, out: StubSink): void {
    out.push("if", ...then, "else", ...els, "end");
  }
  emitBr(depth: number, out: StubSink): void {
    out.push(`br:${depth}`);
  }
  emitBrIf(depth: number, out: StubSink): void {
    out.push(`br_if:${depth}`);
  }
  emitBlock(_blockType: BlockType, body: StubSink, out: StubSink): void {
    out.push("block", ...body, "end");
  }
  emitLoop(_blockType: BlockType, body: StubSink, out: StubSink): void {
    out.push("loop", ...body, "end");
  }
  emitNull(irType: IrType, out: StubSink): void {
    out.push(`null:${irType.kind}`);
  }
  emitToExternref(out: StubSink): void {
    out.push("to.externref");
  }
  emitDowncast(_target: { typeIdx: number } | IrType, out: StubSink): void {
    out.push("downcast");
  }
  emitFromExternref(_target: { typeIdx: number } | IrType, out: StubSink): void {
    out.push("from.externref");
  }
  emitFuncRef(funcIdx: FuncHandle, out: StubSink): void {
    out.push(`func.ref:${funcIdx}`);
  }
  emitPromiseNew(promiseTypeIdx: TypeHandle, out: StubSink): void {
    out.push(`promise.new:${promiseTypeIdx}`);
  }
  emitPromiseStateGet(promiseTypeIdx: TypeHandle, out: StubSink): void {
    out.push(`promise.state.get:${promiseTypeIdx}`);
  }
  emitPromiseValueGet(promiseTypeIdx: TypeHandle, out: StubSink): void {
    out.push(`promise.value.get:${promiseTypeIdx}`);
  }
  emitCall(funcIdx: FuncHandle, out: StubSink): void {
    out.push(`call:${funcIdx}`);
  }
  emitCallRef(funcTypeIdx: TypeHandle, out: StubSink): void {
    out.push(`call_ref:${funcTypeIdx}`);
  }
  emitAggregateNew(_layout: IrObjectStructLowering, fieldCount: number, out: StubSink): void {
    out.push(`aggregate.new:${fieldCount}`);
  }
  emitFieldGet(_layout: IrObjectStructLowering | IrClassLowering, name: string, out: StubSink): void {
    out.push(`field.get:${name}`);
  }
  emitFieldSet(_layout: IrObjectStructLowering | IrClassLowering, name: string, out: StubSink): void {
    out.push(`field.set:${name}`);
  }
  emitThrow(tagIdx: number, out: StubSink): void {
    out.push(`throw:${tagIdx}`);
  }
  emitRethrow(depth: number, out: StubSink): void {
    out.push(`rethrow:${depth}`);
  }
  emitTry(
    _blockType: BlockType,
    body: StubSink,
    catches: { tagIdx: number; body: StubSink }[],
    catchAll: StubSink | undefined,
    out: StubSink,
  ): void {
    out.push("try", ...body);
    for (const c of catches) out.push(`catch:${c.tagIdx}`, ...c.body);
    if (catchAll) out.push("catch_all", ...catchAll);
    out.push("end");
  }
  emitClosureNew(_layout: IrClosureLowering, captureCount: number, out: StubSink): void {
    out.push(`closure.new:${captureCount}`);
  }
  emitClosureFuncGet(_layout: IrClosureLowering, out: StubSink): void {
    out.push("closure.func.get");
  }
  emitCaptureGet(_layout: IrClosureLowering, index: number, out: StubSink): void {
    out.push(`closure.capture.get:${index}`);
  }
  emitRefCellNew(_layout: IrRefCellLowering, out: StubSink): void {
    out.push("refcell.new");
  }
  emitRefCellGet(_layout: IrRefCellLowering, out: StubSink): void {
    out.push("refcell.get");
  }
  emitRefCellSet(_layout: IrRefCellLowering, out: StubSink): void {
    out.push("refcell.set");
  }
}

class StubTypeConverter implements TypeConverter<string> {
  readonly backend: IrBackendKind = STUB_KIND;
  convertType(t: IrType): readonly string[] {
    // One symbolic slot per value; a real backend returns its slot shapes
    // (the linear dynamic residue would return TWO slots — value + tag).
    return [`slot:${t.kind}`];
  }
}

class StubLayoutResolver implements IrLowerResolver {
  private nextFunc = 0;
  private nextGlobal = 0;
  private nextType = 0;
  private readonly funcs = new Map<string, number>();
  private readonly globals = new Map<string, number>();
  private readonly types = new Map<string, number>();
  resolveFunc(ref: IrFuncRef): number {
    const key = irCallableBindingKey(ref.binding);
    let idx = this.funcs.get(key);
    if (idx === undefined) {
      idx = this.nextFunc++;
      this.funcs.set(key, idx);
    }
    return idx;
  }
  resolveGlobal(ref: IrGlobalRef): number {
    const key = irGlobalBindingKey(ref.binding);
    let idx = this.globals.get(key);
    if (idx === undefined) {
      idx = this.nextGlobal++;
      this.globals.set(key, idx);
    }
    return idx;
  }
  resolveType(ref: IrTypeRef): number {
    const key = irTypeBindingKey(ref.binding);
    let idx = this.types.get(key);
    if (idx === undefined) {
      idx = this.nextType++;
      this.types.set(key, idx);
    }
    return idx;
  }
  internFuncType(_type: FuncTypeDef): number {
    return this.nextType++;
  }
}

/** Minimal but REAL implementation of the mint/define/finalize protocol. */
export class StubModuleAssembler implements ModuleAssembler<string, string, string> {
  readonly backend: IrBackendKind = STUB_KIND;
  private finalized = false;
  private readonly funcNames = new Map<string, FuncHandle>();
  private readonly globalNames = new Map<string, GlobalHandle>();
  private readonly typeNames = new Map<string, TypeHandle>();
  private readonly funcDefs = new Map<FuncHandle, string | null>(); // null = declared, not defined (A2)
  private readonly funcImports: FuncHandle[] = [];
  private readonly globalDefs = new Map<GlobalHandle, string | null>();
  private readonly globalImports: GlobalHandle[] = [];
  private readonly typeDefs: string[] = [];
  readonly exports: { name: string; kind: "func" | "global"; handle: number }[] = [];
  startHandle: FuncHandle | undefined;
  private nextHandle = 1000; // arbitrary base — handles are opaque ids, not positions (A1)

  private mutate(): void {
    if (this.finalized) throw new Error("stub assembler: mutation after finalize (A4)");
  }
  declareFunc(name: string): FuncHandle {
    this.mutate();
    const h = this.nextHandle++ as FuncHandle;
    this.funcNames.set(name, h);
    this.funcDefs.set(h, null);
    return h;
  }
  defineFunc(handle: FuncHandle, def: string): void {
    this.mutate();
    const existing = this.funcDefs.get(handle);
    if (existing === undefined) throw new Error(`stub assembler: defineFunc on undeclared handle ${handle}`);
    if (existing !== null) throw new Error(`stub assembler: double define for handle ${handle} (A2)`);
    this.funcDefs.set(handle, def);
  }
  importFunc(_module: string, _field: string, _typeHandle: TypeHandle, name: string): FuncHandle {
    this.mutate(); // legal at ANY pre-finalize time (A3) — no shift pass exists
    const h = this.nextHandle++ as FuncHandle;
    this.funcNames.set(name, h);
    this.funcImports.push(h);
    return h;
  }
  lookupFunc(name: string): FuncHandle | undefined {
    return this.funcNames.get(name);
  }
  declareGlobal(name: string): GlobalHandle {
    this.mutate();
    const h = this.nextHandle++ as GlobalHandle;
    this.globalNames.set(name, h);
    this.globalDefs.set(h, null);
    return h;
  }
  defineGlobal(handle: GlobalHandle, def: string): void {
    this.mutate();
    const existing = this.globalDefs.get(handle);
    if (existing === undefined) throw new Error(`stub assembler: defineGlobal on undeclared handle ${handle}`);
    if (existing !== null) throw new Error(`stub assembler: double define for global handle ${handle} (A2)`);
    this.globalDefs.set(handle, def);
  }
  importGlobal(_module: string, _field: string, _type: ValType, _mutable: boolean, name: string): GlobalHandle {
    this.mutate();
    const h = this.nextHandle++ as GlobalHandle;
    this.globalNames.set(name, h);
    this.globalImports.push(h);
    return h;
  }
  lookupGlobal(name: string): GlobalHandle | undefined {
    return this.globalNames.get(name);
  }
  internType(def: string, name?: string): TypeHandle {
    this.mutate();
    let pos = this.typeDefs.indexOf(def); // structural dedup
    if (pos < 0) {
      pos = this.typeDefs.length;
      this.typeDefs.push(def);
    }
    const h = pos as TypeHandle; // stub: type handles are intern positions (stable — never removed)
    if (name !== undefined) this.typeNames.set(name, h);
    return h;
  }
  lookupType(name: string): TypeHandle | undefined {
    return this.typeNames.get(name);
  }
  exportFunc(exportName: string, handle: FuncHandle): void {
    this.mutate();
    this.exports.push({ name: exportName, kind: "func", handle });
  }
  exportGlobal(exportName: string, handle: GlobalHandle): void {
    this.mutate();
    this.exports.push({ name: exportName, kind: "global", handle });
  }
  setStart(handle: FuncHandle): void {
    this.mutate();
    this.startHandle = handle;
  }
  finalize(): ModuleLayout {
    if (this.finalized) throw new Error("stub assembler: finalize called twice (A4)");
    this.finalized = true;
    // Canonical ordering: imports in registration order first, then defined
    // entries in DEFINE order. Indices exist only from this point on.
    const funcIndex = new Map<number, number>();
    let fi = 0;
    for (const h of this.funcImports) funcIndex.set(h, fi++);
    for (const [h, def] of this.funcDefs) {
      if (def === null) throw new Error(`stub assembler: handle ${h} declared but never defined (A2)`);
      funcIndex.set(h, fi++);
    }
    const globalIndex = new Map<number, number>();
    let gi = 0;
    for (const h of this.globalImports) globalIndex.set(h, gi++);
    for (const [h, def] of this.globalDefs) {
      if (def === null) throw new Error(`stub assembler: global handle ${h} declared but never defined (A2)`);
      globalIndex.set(h, gi++);
    }
    const lookup = (map: Map<number, number>, h: number, what: string): number => {
      const idx = map.get(h);
      if (idx === undefined) throw new Error(`stub assembler: unknown ${what} handle ${h}`);
      return idx;
    };
    return {
      func: (h: FuncHandle): number => lookup(funcIndex, h, "func"),
      global: (h: GlobalHandle): number => lookup(globalIndex, h, "global"),
      type: (h: TypeHandle): number => h, // intern position IS the final index in the stub
    };
  }
}

/**
 * Assemble the full five-part stub. `tests/backend-contract.test.ts`
 * exercises the assembler protocol + emitter sink behavior at runtime; the
 * declaration below is itself the compile-time proof that the five parts
 * fit the `BackendContract` bundle.
 */
export function makeStubBackend(): BackendContract<StubSink, string, string, string, string> {
  const legality: BackendLegality = {
    backend: STUB_KIND,
    // The stub accepts everything — legality POLICY belongs to real
    // backends; the conformance skeleton only freezes the shape.
    checkFunction: (_func: IrFunction) => [],
  };
  return {
    backend: STUB_KIND,
    types: new StubTypeConverter(),
    legality,
    emitter: new StubEmitter(),
    layouts: new StubLayoutResolver(),
    assembler: new StubModuleAssembler(),
  };
}
