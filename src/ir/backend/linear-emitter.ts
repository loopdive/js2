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

import { emitConstInstr, type IrLowerResolver } from "../lower.js";
import type {
  AllocSiteId,
  IrBinop,
  IrFuncRef,
  IrGlobalRef,
  IrInstr,
  IrStringLengthProvider,
  IrUnop,
} from "../nodes.js";
import type { IrStringConcatMode, IrStringEncoding } from "../string-runtime.js";
import type { BlockType, Instr, ValType } from "../types.js";
import type { LinearRuntimeOperation } from "../analysis/linear-memory-plan.js";
import type {
  BackendEmitter,
  BackendI32BitwiseOp,
  BackendNumericConversionOp,
  BackendScalarConstType,
} from "./emitter.js";
import type {
  IrClassLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  LinearMemoryFieldLowering,
  LinearObjectLowering,
  LinearRefCellLowering,
  LinearVecLowering,
} from "./handles.js";

export interface LinearEmitterOptions {
  /** Bind a semantic plan operation only after module functions are registered. */
  readonly resolveRuntimeOperation?: (operation: LinearRuntimeOperation) => number;
  readonly stringRuntime?: IrLowerResolver;
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

function linearStoreOp(field: LinearMemoryFieldLowering): "i32.store" | "f64.store" {
  switch (field.type.kind) {
    case "i32":
      return "i32.store";
    case "f64":
      return "f64.store";
    default:
      throw new Error(`LinearEmitter: unsupported linear-memory field type '${field.type.kind}'`);
  }
}

function emitLinearFieldGet(field: LinearMemoryFieldLowering, out: Instr[]): void {
  const op = field.type.kind === "i32" ? "i32.load" : field.type.kind === "f64" ? "f64.load" : undefined;
  if (!op) throw new Error(`LinearEmitter: unsupported linear-memory field type '${field.type.kind}'`);
  out.push({ op, align: field.type.kind === "f64" ? 3 : 2, offset: field.offset });
}

function emitLinearFieldSet(field: LinearMemoryFieldLowering, out: Instr[]): void {
  out.push({
    op: linearStoreOp(field),
    align: field.type.kind === "f64" ? 3 : 2,
    offset: field.offset,
  });
}

function asLinearObject(layout: IrObjectStructLowering | IrClassLowering): LinearObjectLowering {
  if (!("linearMemory" in layout)) {
    throw new Error("LinearEmitter: aggregate layout is not a linear-memory object handle");
  }
  return layout as LinearObjectLowering;
}

function asLinearRefCell(layout: IrRefCellLowering): LinearRefCellLowering {
  if (!("linearMemory" in layout)) {
    throw new Error("LinearEmitter: ref-cell layout is not a linear-memory handle");
  }
  return layout as LinearRefCellLowering;
}

function asLinearVec(layout: LinearVecLowering): LinearVecLowering {
  if (!("linearMemory" in layout)) {
    throw new Error("LinearEmitter: vec layout is not a linear-memory plan handle");
  }
  return layout;
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

  emitStringConst(
    value: string,
    alloc: AllocSiteId | undefined,
    out: Instr[],
    storage?: IrGlobalRef,
    materializer?: IrFuncRef,
  ): void {
    const ops = this.options.stringRuntime?.emitStringConst?.(value, alloc, storage, materializer);
    if (!ops) throw new Error("LinearEmitter: string.const runtime is unavailable");
    out.push(...ops);
  }

  emitStringConcat(alloc: AllocSiteId | undefined, mode: IrStringConcatMode, out: Instr[], provider?: IrFuncRef): void {
    const ops = this.options.stringRuntime?.emitStringConcat?.(alloc, mode, provider);
    if (!ops) throw new Error("LinearEmitter: string.concat runtime is unavailable");
    out.push(...ops);
  }

  emitStringEquals(negate: boolean, out: Instr[], provider?: IrFuncRef): void {
    const ops = this.options.stringRuntime?.emitStringEquals?.(provider);
    if (!ops) throw new Error("LinearEmitter: string.eq runtime is unavailable");
    out.push(...ops);
    if (negate) out.push({ op: "i32.eqz" });
  }

  emitStringLength(
    _inputEncoding: IrStringEncoding | undefined,
    out: Instr[],
    provider?: IrStringLengthProvider,
  ): void {
    const ops = this.options.stringRuntime?.emitStringLen?.(_inputEncoding, provider);
    if (!ops) throw new Error("LinearEmitter: string.len runtime is unavailable");
    out.push(...ops, { op: "f64.convert_i32_s" });
  }

  emitStringCharAt(
    _alloc: AllocSiteId | undefined,
    _inputEncoding: IrStringEncoding,
    out: Instr[],
    provider?: IrFuncRef,
  ): void {
    const ops = this.options.stringRuntime?.emitStringCharAt?.(_alloc, _inputEncoding, provider);
    if (!ops) throw new Error("LinearEmitter: string.char_at runtime is unavailable");
    out.push(...ops);
  }

  emitStringCharCodeAt(_inputEncoding: IrStringEncoding, out: Instr[], provider?: IrFuncRef): void {
    const ops = this.options.stringRuntime?.emitStringCharCodeAt?.(_inputEncoding, provider);
    if (!ops) throw new Error("LinearEmitter: string.char_code_at runtime is unavailable");
    out.push(...ops);
  }

  // ---- vec (array) — the #1714 proof surface ------------------------------

  emitVecLen(layout: LinearVecLowering, out: Instr[]): void {
    const linear = asLinearVec(layout);
    // base ptr on stack → load the u32 len field.
    out.push({
      op: "i32.load",
      align: 2,
      offset: linear.linearMemory.layout.lengthOffset,
    });
  }

  emitVecDataPtr(layout: LinearVecLowering, out: Instr[]): void {
    const linear = asLinearVec(layout);
    // base ptr on stack → base + 16 = element data-region base (still i32).
    out.push({ op: "i32.const", value: linear.linearMemory.layout.elementsOffset });
    out.push({ op: "i32.add" });
  }

  emitElemGet(layout: LinearVecLowering, out: Instr[]): void {
    // Stack: [dataBase(i32), index(i32)] → element.
    // addr = dataBase + index * stride
    const linear = asLinearVec(layout);
    const stride = linear.linearMemory.layout.elementStride;
    out.push({ op: "i32.const", value: stride });
    out.push({ op: "i32.mul" });
    out.push({ op: "i32.add" });
    out.push({
      op: linearLoadOp(layout.elementValType),
      align: stride === 8 ? 3 : 2,
      offset: 0,
    } as Instr); // computed-op
  }

  emitElemSet(layout: LinearVecLowering, valueScratchLocal: number, out: Instr[]): void {
    const linear = asLinearVec(layout);
    const stride = linear.linearMemory.layout.elementStride;
    if (layout.elementValType.kind !== "f64" && layout.elementValType.kind !== "i32") {
      throw new Error(`LinearEmitter: unsupported vec.set element type '${layout.elementValType.kind}'`);
    }
    out.push({ op: "local.set", index: valueScratchLocal });
    out.push({ op: "i32.const", value: stride });
    out.push({ op: "i32.mul" });
    out.push({ op: "i32.add" });
    out.push({ op: "local.get", index: valueScratchLocal });
    out.push({
      op: layout.elementValType.kind === "f64" ? "f64.store" : "i32.store",
      align: stride === 8 ? 3 : 2,
      offset: 0,
    });
  }

  emitVecSetLength(layout: LinearVecLowering, out: Instr[]): void {
    const linear = asLinearVec(layout);
    out.push({
      op: "i32.store",
      align: 2,
      offset: linear.linearMemory.layout.lengthOffset,
    });
  }

  // #1804 / #2956 L2 — fixed number-array construction. `lower.ts` has already
  // pushed e0...eN. Allocate the canonical linear array, then consume values
  // from the top of the stack and store each at its original index through the
  // value-first helper. This preserves source order without changing the shared
  // BackendEmitter contract or requiring one scratch local per element.
  emitVecNewFixed(
    layout: LinearVecLowering,
    count: number,
    capacity: number,
    dataScratchLocal: number,
    out: Instr[],
  ): void {
    if (!layout) {
      throw new Error("LinearEmitter: emitVecNewFixed requires a linear vec layout");
    }
    if (layout.elementValType.kind !== "f64") {
      throw new Error(`LinearEmitter: emitVecNewFixed supports f64 elements only; got ${layout.elementValType.kind}`);
    }
    const linear = asLinearVec(layout);
    const resolveRuntimeOperation = this.options.resolveRuntimeOperation;
    if (!resolveRuntimeOperation) {
      throw new Error("LinearEmitter: emitVecNewFixed requires the linear vec runtime");
    }
    const vecNewFuncIdx = resolveRuntimeOperation(linear.linearMemory.allocate);
    const vecInitF64FuncIdx = resolveRuntimeOperation(linear.linearMemory.initializeElement);

    this.vecScratchLocals.add(dataScratchLocal);

    // Stack before: e0 ... eN. Stack after local.set: e0 ... eN, with ptr saved.
    out.push({ op: "i32.const", value: Math.max(capacity, linear.linearMemory.layout.minimumCapacity) });
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
    out.push({ op: "i32.store", align: 2, offset: linear.linearMemory.layout.lengthOffset });
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

  emitScalarConst(type: BackendScalarConstType, value: number, out: Instr[]): void {
    out.push(type === "f64" ? { op: "f64.const", value } : { op: "i32.const", value });
  }

  emitNumericConversion(op: BackendNumericConversionOp, out: Instr[]): void {
    out.push({ op });
  }

  emitI32Bitwise(op: BackendI32BitwiseOp, out: Instr[]): void {
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

  // struct/object family — the resolver computes offsets through the direct
  // backend's layout.ts and supplies a deferred allocation helper. The helper
  // consumes fields in canonical order and leaves the arena pointer (i32).
  emitAggregateNew(layout: IrObjectStructLowering, fieldCount: number, out: Instr[]): void {
    const linear = asLinearObject(layout).linearMemory;
    if (fieldCount !== linear.fieldCount) {
      throw new Error(`LinearEmitter: aggregate arity mismatch (expected ${linear.fieldCount}, got ${fieldCount})`);
    }
    out.push({ op: "call", funcIdx: linear.newFuncIdx });
  }
  emitFieldGet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: Instr[]): void {
    emitLinearFieldGet(asLinearObject(layout).linearMemory.field(name), out);
  }
  emitFieldSet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: Instr[]): void {
    emitLinearFieldSet(asLinearObject(layout).linearMemory.field(name), out);
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

  // ref-cell family — the same header + 8-byte field layout as a one-field
  // aggregate, with an i32 arena pointer as its value representation.
  emitRefCellNew(layout: IrRefCellLowering, out: Instr[]): void {
    out.push({ op: "call", funcIdx: asLinearRefCell(layout).linearMemory.newFuncIdx });
  }
  emitRefCellGet(layout: IrRefCellLowering, out: Instr[]): void {
    emitLinearFieldGet(asLinearRefCell(layout).linearMemory.value, out);
  }
  emitRefCellSet(layout: IrRefCellLowering, out: Instr[]): void {
    emitLinearFieldSet(asLinearRefCell(layout).linearMemory.value, out);
  }
}
