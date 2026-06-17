// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// WasmGcEmitter (#1713) -- the behaviour-identical first BackendEmitter.
//
// Each method is the LITERAL `out.push(...)` from the audited `lower.ts`
// emission site, moved 1:1. The emitted `Instr` stream for every routed
// node kind is byte-identical to the pre-refactor inline emission -- this
// is guaranteed by construction (mechanical move of the exact object
// literal) and validated by the equivalence suite + the golden-Instr
// snapshot test.
//
// Phase 1 routes the pass-through group (locals / globals / const /
// arithmetic / control flow) and the vec group. The remaining
// (aggregate / union / closure / ref-coercion) primitives stay inline in
// lower.ts for now (issue Scope permits a partial-but-clean seam); they
// are added here as their group gets wired.

import { emitConstInstr } from "../lower.js";
import type { IrBinop, IrInstr, IrUnop } from "../nodes.js";
import type { BlockType, Instr } from "../types.js";
import type { BackendEmitter } from "./emitter.js";
import type { IrClassLowering, IrObjectStructLowering, IrVecLowering } from "./handles.js";

export class WasmGcEmitter implements BackendEmitter<Instr[]> {
  readonly backend = "wasmgc" as const;

  // #1584: sink = Instr[]. The factory returns a plain array and the raw escape
  // hatch is a direct `push` — so the emitted `Instr` stream is byte-identical
  // to the pre-#1584 inline emission (the WasmGC path is unchanged).
  newSink(): Instr[] {
    return [];
  }
  pushRaw(out: Instr[], instr: Instr): void {
    out.push(instr);
  }

  // ---- vec (array) ----------------------------------------------------

  emitVecLen(layout: IrVecLowering, out: Instr[]): void {
    out.push({
      op: "struct.get",
      typeIdx: layout.vecStructTypeIdx,
      fieldIdx: layout.lengthFieldIdx,
    });
  }

  emitVecDataPtr(layout: IrVecLowering, out: Instr[]): void {
    out.push({
      op: "struct.get",
      typeIdx: layout.vecStructTypeIdx,
      fieldIdx: layout.dataFieldIdx,
    });
  }

  emitElemGet(layout: IrVecLowering, out: Instr[]): void {
    out.push({ op: "array.get", typeIdx: layout.arrayTypeIdx });
  }

  // #1804 — build a fixed-length vec from N element values already on the
  // stack (e0 deepest … eN top). Mirrors the legacy `compileArrayLiteral` fast
  // path (src/codegen/literals.ts): the vec struct is { length:i32,
  // data:(ref $arr) }, so the length (field 0) must sit BELOW the data ref
  // (field 1) for `struct.new`. `array.new_fixed` leaves the data ref on top,
  // so stash it in `dataScratchLocal`, push the length, re-load the data ref,
  // then `struct.new`.
  emitVecNewFixed(layout: IrVecLowering, count: number, dataScratchLocal: number, out: Instr[]): void {
    out.push({ op: "array.new_fixed", typeIdx: layout.arrayTypeIdx, length: count });
    out.push({ op: "local.set", index: dataScratchLocal });
    out.push({ op: "i32.const", value: count });
    out.push({ op: "local.get", index: dataScratchLocal });
    out.push({ op: "struct.new", typeIdx: layout.vecStructTypeIdx });
  }

  // ---- scalars / locals / globals / control flow ----------------------

  emitConst(instr: Extract<IrInstr, { kind: "const" }>, funcName: string, out: Instr[]): void {
    // Delegate to the shared free function (unchanged) so the const-lowering
    // logic stays in one place. The arg order is the free fn's
    // `(instr, out, funcName)` -- the trait method's order is
    // `(instr, funcName, out)` to keep `out` last like every other method.
    emitConstInstr(instr, out, funcName);
  }

  // The cast mirrors lower.ts's documented `as Instr` pattern: `IrBinop`/`IrUnop`
  // are a superset of the bare-op `Instr` variants (they also name the
  // composite `js.*` bitwise ops). Those `js.*` ops are lowered to a multi-op
  // sequence in lower.ts and NEVER reach emitBinary, so the runtime value is
  // always a valid `Instr` -- the cast just states what the call site proves.
  emitBinary(op: IrBinop, out: Instr[]): void {
    out.push({ op } as Instr);
  }

  emitUnary(op: IrUnop, out: Instr[]): void {
    out.push({ op } as Instr);
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

  // ---- (a3) control-flow family (#1584 §2a) — byte-identical to the prior
  // inline `out.push({op:"block"...})` / `{op:"loop"...}` in lower.ts's fenced
  // loop arms. The WasmGC stream is unchanged; this only moves the push behind
  // the trait so the bytecode backend can realize the same intent as
  // JZ/JNZ/JMP + backpatch labels.
  emitBlock(blockType: BlockType, body: Instr[], out: Instr[]): void {
    out.push({ op: "block", blockType, body });
  }

  emitLoop(blockType: BlockType, body: Instr[], out: Instr[]): void {
    out.push({ op: "loop", blockType, body });
  }

  // ---- (a1) call family (#1584 §2a) — byte-identical to the prior inline
  // `out.push({op:"call"...})` / `{op:"call_ref"...}` in lower.ts. The WasmGC
  // stream is unchanged; this only moves the push behind the trait so the
  // bytecode backend can realize the same intent as OP.CALL / OP.CALL_REF.
  emitCall(funcIdx: number, out: Instr[]): void {
    out.push({ op: "call", funcIdx });
  }

  emitCallRef(funcTypeIdx: number, out: Instr[]): void {
    out.push({ op: "call_ref", typeIdx: funcTypeIdx });
  }

  // ---- (a2) struct/object family (#1584 §2a) — byte-identical to the prior
  // inline `out.push({op:"struct.new"/"struct.get"/"struct.set"...})` in the
  // object.new/get/set arms of lower.ts. The WasmGC stream is unchanged; this
  // moves the push behind the trait so the bytecode backend realizes the same
  // intent as OP.STRUCT_NEW / STRUCT_GET / STRUCT_SET over a VM heap.
  emitAggregateNew(layout: IrObjectStructLowering, _fieldCount: number, out: Instr[]): void {
    out.push({ op: "struct.new", typeIdx: layout.typeIdx });
  }

  emitFieldGet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: Instr[]): void {
    out.push({
      op: "struct.get",
      typeIdx: structTypeIdxOf(layout),
      fieldIdx: layout.fieldIdx(name),
    });
  }

  emitFieldSet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: Instr[]): void {
    out.push({
      op: "struct.set",
      typeIdx: structTypeIdxOf(layout),
      fieldIdx: layout.fieldIdx(name),
    });
  }

  // ---- (a4) try-throw family (#1584 §2a) — byte-identical to the prior inline
  // `out.push({op:"throw"...})` / `{op:"try"...}` / `{op:"rethrow"...}` in the
  // exception arms of lower.ts. The WasmGC stream is unchanged; this only moves
  // the push behind the trait so the bytecode backend realizes the same intent
  // as OP.THROW / OP.TRY_START+TRY_END + the exceptionTable.
  emitThrow(tagIdx: number, out: Instr[]): void {
    out.push({ op: "throw", tagIdx });
  }

  emitRethrow(depth: number, out: Instr[]): void {
    out.push({ op: "rethrow", depth });
  }

  emitTry(
    blockType: BlockType,
    body: Instr[],
    catches: { tagIdx: number; body: Instr[] }[],
    catchAll: Instr[] | undefined,
    out: Instr[],
  ): void {
    out.push({
      op: "try",
      blockType,
      body,
      catches,
      ...(catchAll ? { catchAll } : {}),
    });
  }
}

/** The WasmGC struct typeIdx for an object (`typeIdx`) or class (`structTypeIdx`). */
function structTypeIdxOf(layout: IrObjectStructLowering | IrClassLowering): number {
  return "typeIdx" in layout ? layout.typeIdx : layout.structTypeIdx;
}
