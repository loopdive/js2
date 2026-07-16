// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// LinearEmitter (#1714) — the SECOND BackendEmitter, proving the #1713 seam
// abstracts a structurally different backend.
//
// #1714 opened with a deliberately narrow surface — ONLY the vec (array)
// length + element-read primitives, lowered to LINEAR MEMORY instead of
// WasmGC structs/arrays — to prove the seam. #2954 extends that to the
// CORE-OP families: const / binary / unary / locals / globals / drop /
// select / return / unreachable / if / br / br_if / block / loop / direct
// call. These emit CORE Wasm and both backends share the `Instr` encoding,
// so the emitted stream is BYTE-IDENTICAL to `WasmGcEmitter` for them (the
// divergence is only in the representation-specific families). Those core
// methods are literal 1:1 copies of `WasmGcEmitter`'s (kept in sync
// deliberately — a divergence there would be a bug, not a feature).
//
// What REMAINS `notImplemented` on LinearEmitter is only the genuinely
// representation-divergent families, each annotated with the covering issue:
//   - aggregates (emitAggregateNew/emitFieldGet/emitFieldSet) — WasmGC
//     `struct.*`; linear lowers objects to a memory layout (#2956)
//   - ref-cells (emitRefCellNew/Get/Set) — 1-field mutable struct (#2953)
//   - exceptions (emitThrow/emitRethrow/emitTry) — WasmGC EH; linear has no
//     exception lowering yet (#2956)
//   - typed-funcref call (emitCallRef) — `call_ref` over a reference-typed
//     funcref; the linear backend dispatches through a table, not a GC
//     funcref (#2956, closures)
//   - Promise aggregates — WasmGC `$Promise` structs become linear records
//     once #2956 defines their handle and field representation
//   - boxing / strings / closures — routed through the resolver in lower.ts,
//     not this emitter (strings: #679 dual backend; boxing/closures: #2956)
//
// Linear array layout (mirrors src/codegen-linear/runtime.ts:339
// `addArrayRuntime`):
//
//     [ header 8B ][ len:u32 @+8 ][ cap:u32 @+12 ][ elements @+16 … ]
//
// A vec value in the linear backend is therefore an `i32` base pointer.
//   - emitVecLen      : base on stack → `i32.load offset=8`  (the len field)
//   - emitVecDataPtr  : base on stack → `i32.const 16; i32.add` (data-region
//                       base ptr, still an i32 — this is the "data-region
//                       handle" the trait abstracts: WasmGC leaves a (ref $arr),
//                       linear leaves an i32. lower.ts never inspects which.)
//   - emitElemGet     : dataBase + i32 index on stack → element. Address =
//                       dataBase + index*stride; load with the element's type.
//   - emitVecNewFixed : number elements on stack → canonical `__arr_new`
//                       allocation + indexed f64-slot initialization (#2956 L2).
//
// Contrast with WasmGcEmitter: there length is `struct.get $vec $length`,
// data is `struct.get $vec $data` (a typed array ref), element is `array.get`.
// SAME IR `vec.len`/`vec.get` node → two completely different op sequences,
// selected by which emitter `lower.ts` was handed. That is the proof.

import { emitConstInstr } from "../lower.js";
import type { IrBinop, IrInstr, IrUnop } from "../nodes.js";
import type { BlockType, Instr, ValType } from "../types.js";
import type { BackendEmitter } from "./emitter.js";
import type { LinearVecLowering } from "./handles.js";

/** Byte offset of the `len:u32` field in the linear array header. */
const LINEAR_ARRAY_LEN_OFFSET = 8;
/** Byte offset where the element data region begins (after the 16B header). */
const LINEAR_ARRAY_DATA_OFFSET = 16;
/** Direct linear array literals reserve this minimum capacity. */
const LINEAR_ARRAY_MIN_CAPACITY = 16;

export interface LinearEmitterOptions {
  /** Existing `__arr_new(cap) -> ptr` runtime function. */
  readonly vecNewFuncIdx?: number;
  /** Flag-gated `(value:f64, ptr:i32, index:i32) -> void` initializer. */
  readonly vecInitF64FuncIdx?: number;
  /** (#2956 L2 aggregates) `__linear_ir_obj_new(payloadBytes) -> ptr`. */
  readonly objNewFuncIdx?: number;
  /** (#2956 L2 aggregates) `__linear_ir_obj_init_f64(value, ptr, offset) -> ptr`. */
  readonly objInitF64FuncIdx?: number;
}

/**
 * (#2956 L2 aggregates) The linear object layout the resolver hands the
 * emitter: fixed-shape anonymous object, header 8B (tag u8 @0 + payload
 * size u32 @4), uniform 8-byte f64 field slots at 8 + 8*fieldIdx in the IR
 * shape's canonical (name-sorted) order. This layout is IR-INTERNAL — it
 * deliberately differs from the direct path's checker-order layout, which
 * is why object values are illegal at function boundaries (legality.ts).
 */
export interface LinearObjectLayout {
  readonly typeIdx: number;
  fieldIdx(name: string): number;
  readonly valueType: ValType;
  /** Number of fields (payload = 8 * fieldCount bytes). */
  readonly fieldCount: number;
}

const LINEAR_OBJECT_HEADER_SIZE = 8;
const LINEAR_OBJECT_FIELD_SIZE = 8;

function isLinearObjectLayout(l: unknown): l is LinearObjectLayout {
  return typeof l === "object" && l !== null && typeof (l as LinearObjectLayout).fieldCount === "number";
}

/** Element byte size (stride) for a linear-memory element ValType. */
function linearStride(elem: ValType): number {
  switch (elem.kind) {
    case "i32":
    case "f32":
      return 4;
    case "i64":
    case "f64":
      return 8;
    default:
      // ref/externref/etc. are stored as i32 handles in the linear backend.
      return 4;
  }
}

/** The `<t>.load` op matching a linear element ValType. */
function linearLoadOp(elem: ValType): Instr["op"] {
  switch (elem.kind) {
    case "f32":
      return "f32.load";
    case "f64":
      return "f64.load";
    default:
      // i32, and ref/externref handles stored as i32. (i64 vec elements do not
      // occur for the #1714 number-array proof; widen here when a backend needs it.)
      return "i32.load";
  }
}

function notImplemented(method: string): never {
  throw new Error(
    `LinearEmitter: ${method} not implemented — #1714 scope is the vec ` +
      `(array) length+element-read primitives only. Other primitives are a ` +
      `multi-sprint follow-up (see plan/issues/1714).`,
  );
}

/**
 * #1714: a BackendEmitter that lowers the vec primitives to LINEAR memory.
 * Only the three vec methods are implemented; the rest fail loudly.
 */
export class LinearEmitter implements BackendEmitter<Instr[]> {
  readonly backend = "linear" as const;
  private readonly vecScratchLocals = new Set<number>();

  constructor(private readonly options: LinearEmitterOptions = {}) {}

  /** Absolute local indices whose GC-shaped scratch must become an i32 pointer. */
  getVecScratchLocalIndices(): readonly number[] {
    return [...this.vecScratchLocals];
  }

  // #1584: sink = Instr[], same as WasmGc (the linear backend also lowers to
  // the shared `Instr` union). Factory + raw escape hatch are array ops.
  newSink(): Instr[] {
    return [];
  }
  pushRaw(out: Instr[], instr: Instr): void {
    out.push(instr);
  }

  // ---- vec (array) — the #1714 proof surface ------------------------------

  emitVecLen(layout: LinearVecLowering, out: Instr[]): void {
    // base ptr on stack → load the u32 len field.
    out.push({
      op: "i32.load",
      align: 2,
      offset: LINEAR_ARRAY_LEN_OFFSET,
    });
  }

  emitVecDataPtr(layout: LinearVecLowering, out: Instr[]): void {
    // base ptr on stack → base + 16 = element data-region base (still i32).
    out.push({ op: "i32.const", value: LINEAR_ARRAY_DATA_OFFSET });
    out.push({ op: "i32.add" });
  }

  emitElemGet(layout: LinearVecLowering, out: Instr[]): void {
    // Stack: [dataBase(i32), index(i32)] → element.
    // addr = dataBase + index * stride
    const stride = linearStride(layout.elementValType);
    out.push({ op: "i32.const", value: stride });
    out.push({ op: "i32.mul" });
    out.push({ op: "i32.add" });
    out.push({
      op: linearLoadOp(layout.elementValType),
      align: stride === 8 ? 3 : 2,
      offset: 0,
    } as Instr); // computed-op
  }

  // #1804 / #2956 L2 — fixed number-array construction. `lower.ts` has already
  // pushed e0...eN. Allocate the canonical linear array, then consume values
  // from the top of the stack and store each at its original index through the
  // value-first helper. This preserves source order without changing the shared
  // BackendEmitter contract or requiring one scratch local per element.
  emitVecNewFixed(layout: LinearVecLowering, count: number, dataScratchLocal: number, out: Instr[]): void {
    if (!layout) {
      throw new Error("LinearEmitter: emitVecNewFixed requires a linear vec layout");
    }
    if (layout.elementValType.kind !== "f64") {
      throw new Error(`LinearEmitter: emitVecNewFixed supports f64 elements only; got ${layout.elementValType.kind}`);
    }
    const { vecNewFuncIdx, vecInitF64FuncIdx } = this.options;
    if (vecNewFuncIdx === undefined || vecInitF64FuncIdx === undefined) {
      throw new Error("LinearEmitter: emitVecNewFixed requires the linear vec runtime");
    }

    this.vecScratchLocals.add(dataScratchLocal);

    // Stack before: e0 ... eN. Stack after local.set: e0 ... eN, with ptr saved.
    out.push({ op: "i32.const", value: Math.max(count, LINEAR_ARRAY_MIN_CAPACITY) });
    out.push({ op: "call", funcIdx: vecNewFuncIdx });
    out.push({ op: "local.set", index: dataScratchLocal });

    // Consume eN first but write it to slot N, preserving literal order.
    for (let index = count - 1; index >= 0; index--) {
      out.push({ op: "local.get", index: dataScratchLocal });
      out.push({ op: "i32.const", value: index });
      out.push({ op: "call", funcIdx: vecInitF64FuncIdx });
    }

    // __arr_new initialized len=0. Publish the completed length atomically
    // after all slots are initialized, then leave the base pointer as result.
    out.push({ op: "local.get", index: dataScratchLocal });
    out.push({ op: "i32.const", value: count });
    out.push({ op: "i32.store", align: 2, offset: LINEAR_ARRAY_LEN_OFFSET });
    out.push({ op: "local.get", index: dataScratchLocal });
  }

  // ---- core-op families (#2954) — CORE Wasm, byte-identical to WasmGc ------
  //
  // Every method below is a literal 1:1 copy of the corresponding
  // `WasmGcEmitter` method. Both backends lower these node kinds to the same
  // shared `Instr` variant (const / arithmetic / locals / globals / structured
  // control flow / direct call are backend-agnostic core Wasm), so the emitted
  // stream is byte-identical by construction. The divergence between the two
  // emitters lives ONLY in the representation-specific families (vec/struct
  // layout, boxing, strings, closures) — see the `notImplemented` block below.

  emitConst(instr: Extract<IrInstr, { kind: "const" }>, funcName: string, out: Instr[]): void {
    // Delegate to the shared free function (same as WasmGcEmitter): the numeric
    // / bool literal path is core Wasm (`f64.const` / `i32.const`). Argument
    // order mirrors WasmGcEmitter — the trait's `(instr, funcName, out)` maps to
    // the free fn's `(instr, out, funcName)`.
    emitConstInstr(instr, out, funcName);
  }

  // The `as Instr` cast mirrors WasmGcEmitter/lower.ts: `IrBinop`/`IrUnop` are a
  // superset of the bare-op `Instr` variants; composite `js.*` bitwise ops are
  // lowered to a multi-op sequence in lower.ts and never reach here.
  emitBinary(op: IrBinop, out: Instr[]): void {
    out.push({ op } as Instr); // computed-op
  }

  emitUnary(op: IrUnop, out: Instr[]): void {
    out.push({ op });
  }

  emitLocalGet(index: number, out: Instr[]): void {
    out.push({ op: "local.get", index });
  }

  emitLocalSet(index: number, out: Instr[]): void {
    out.push({ op: "local.set", index });
  }

  emitLocalTee(index: number, out: Instr[]): void {
    out.push({ op: "local.tee", index });
  }

  emitGlobalGet(index: number, out: Instr[]): void {
    out.push({ op: "global.get", index });
  }

  emitGlobalSet(index: number, out: Instr[]): void {
    out.push({ op: "global.set", index });
  }

  emitDrop(out: Instr[]): void {
    out.push({ op: "drop" });
  }

  emitSelect(out: Instr[]): void {
    out.push({ op: "select" });
  }

  emitReturn(out: Instr[]): void {
    out.push({ op: "return" });
  }

  emitUnreachable(out: Instr[]): void {
    out.push({ op: "unreachable" });
  }

  emitIf(blockType: BlockType, then: Instr[], els: Instr[], out: Instr[]): void {
    out.push({ op: "if", blockType, then, else: els });
  }

  emitBr(depth: number, out: Instr[]): void {
    out.push({ op: "br", depth });
  }

  emitBrIf(depth: number, out: Instr[]): void {
    out.push({ op: "br_if", depth });
  }

  emitBlock(blockType: BlockType, body: Instr[], out: Instr[]): void {
    out.push({ op: "block", blockType, body });
  }

  emitLoop(blockType: BlockType, body: Instr[], out: Instr[]): void {
    out.push({ op: "loop", blockType, body });
  }

  // Direct call — `{op:"call",funcIdx}` is core Wasm, identical on both backends
  // (the linear backend calls the same defined function index). `emitCallRef`
  // (typed funcref / `call_ref`) stays divergent — see the notImplemented block.
  emitCall(funcIdx: number, out: Instr[]): void {
    out.push({ op: "call", funcIdx });
  }

  // ---- representation-divergent families: still fail loudly (#2954) --------
  // These lower to WasmGC-specific ops (struct.*, array construction, GC
  // funcref, EH) that the linear backend realizes differently (memory layout,
  // call_indirect, no EH yet). Each is annotated with the issue that will wire
  // the linear analogue.

  // emitVecNewFixed already declared above (the read side is #1714 scope; the
  // bump-allocated store sequence is #1804).

  // ref-coercion / null family — nullable references and externref tagging need
  // the linear value representation planned by #2956. Never leak WasmGC casts.
  emitNull(): void {
    notImplemented("emitNull");
  }
  emitToExternref(): void {
    notImplemented("emitToExternref");
  }
  emitDowncast(): void {
    notImplemented("emitDowncast");
  }
  emitFromExternref(): void {
    notImplemented("emitFromExternref");
  }

  // function materialization — a linear closure carries a table index or
  // equivalent handle, not a WasmGC funcref (#2956, closures).
  emitFuncRef(): void {
    notImplemented("emitFuncRef");
  }

  // Promise aggregate family — the linear Promise record layout and handle
  // representation land with the remaining #2956 aggregate work.
  emitPromiseNew(): void {
    notImplemented("emitPromiseNew");
  }
  emitPromiseStateGet(): void {
    notImplemented("emitPromiseStateGet");
  }
  emitPromiseValueGet(): void {
    notImplemented("emitPromiseValueGet");
  }

  // typed-funcref call — `call_ref` over a GC funcref (#2956, closures). The
  // linear backend dispatches indirect calls through a table (`call_indirect`),
  // not a reference-typed funcref, so this needs distinct lowering.
  emitCallRef(): void {
    notImplemented("emitCallRef");
  }

  // closure family — WasmGC wrapper structs become arena records + table
  // indices in the linear backend (#2956), so no raw struct fallback is valid.
  emitClosureNew(): void {
    notImplemented("emitClosureNew");
  }
  emitClosureFuncGet(): void {
    notImplemented("emitClosureFuncGet");
  }
  emitCaptureGet(): void {
    notImplemented("emitCaptureGet");
  }

  // struct/object family — WasmGC `struct.new`/`struct.get`/`struct.set`; the
  // linear backend lowers objects to a bump-allocated memory layout (#2956).
  // ---- aggregates (#2956 L2) — fixed-shape anonymous objects -------------
  //
  // Stack discipline mirrors the WasmGC struct ops with zero scratch locals:
  //   object.new — lower.ts stacked f0..fN-1; `__linear_ir_obj_new` pushes
  //     the fresh pointer ON TOP, and the value-first init helper
  //     `(value, ptr, offset) -> ptr` consumes (fI, ptr) pairs from the top
  //     while RETURNING the pointer, so the loop folds naturally and the
  //     final stack is exactly [ptr].
  //   field get — [ptr] -> f64.load at the immediate offset.
  //   field set — [ptr, value] -> f64.store at the immediate offset.
  emitAggregateNew(layout: unknown, fieldCount: number, out: Instr[]): void {
    if (!isLinearObjectLayout(layout)) {
      notImplemented("emitAggregateNew (non-linear object layout)");
    }
    const { objNewFuncIdx, objInitF64FuncIdx } = this.options;
    if (objNewFuncIdx === undefined || objInitF64FuncIdx === undefined) {
      throw new Error("LinearEmitter: emitAggregateNew requires the linear object runtime");
    }
    out.push({ op: "i32.const", value: LINEAR_OBJECT_FIELD_SIZE * fieldCount });
    out.push({ op: "call", funcIdx: objNewFuncIdx });
    for (let index = fieldCount - 1; index >= 0; index--) {
      out.push({ op: "i32.const", value: LINEAR_OBJECT_HEADER_SIZE + LINEAR_OBJECT_FIELD_SIZE * index });
      out.push({ op: "call", funcIdx: objInitF64FuncIdx });
    }
  }
  emitFieldGet(layout: unknown, name: string, out: Instr[]): void {
    if (!isLinearObjectLayout(layout)) {
      notImplemented("emitFieldGet (non-linear object layout)");
    }
    out.push({
      op: "f64.load",
      align: 3,
      offset: LINEAR_OBJECT_HEADER_SIZE + LINEAR_OBJECT_FIELD_SIZE * layout.fieldIdx(name),
    });
  }
  emitFieldSet(layout: unknown, name: string, out: Instr[]): void {
    if (!isLinearObjectLayout(layout)) {
      notImplemented("emitFieldSet (non-linear object layout)");
    }
    out.push({
      op: "f64.store",
      align: 3,
      offset: LINEAR_OBJECT_HEADER_SIZE + LINEAR_OBJECT_FIELD_SIZE * layout.fieldIdx(name),
    });
  }

  // try-throw family — WasmGC exception handling (`throw`/`try`/`rethrow`); the
  // linear backend has no exception lowering yet (#2956).
  emitThrow(): void {
    notImplemented("emitThrow");
  }
  emitRethrow(): void {
    notImplemented("emitRethrow");
  }
  emitTry(): void {
    notImplemented("emitTry");
  }

  // ref-cell family — a 1-field mutable struct (`struct.new`/`get`/`set`),
  // structurally the same as the object family; wires with it (#2953/#2956).
  emitRefCellNew(): void {
    notImplemented("emitRefCellNew");
  }
  emitRefCellGet(): void {
    notImplemented("emitRefCellGet");
  }
  emitRefCellSet(): void {
    notImplemented("emitRefCellSet");
  }
}
