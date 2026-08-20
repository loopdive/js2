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
// arithmetic / control flow) and the vec group. The remaining primitives
// are added here as their groups get wired.

import { emitConstInstr, type IrLowerResolver } from "../lower.js";
import {
  asVal,
  type AllocSiteId,
  type IrBinop,
  type IrFuncRef,
  type IrGlobalRef,
  type IrInstr,
  type IrStringLengthProvider,
  type IrType,
  type IrUnop,
} from "../nodes.js";
import type { IrStringConcatMode, IrStringEncoding } from "../string-runtime.js";
import type { BlockType, Instr, ValType } from "../types.js";
import { buildStandardTryTable } from "../try-table.js";
import type {
  BackendEmitter,
  BackendI32BitwiseOp,
  BackendNumericConversionOp,
  BackendScalarConstType,
} from "./emitter.js";
import type {
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
} from "./handles.js";

export class WasmGcEmitter implements BackendEmitter<Instr[]> {
  readonly backend = "wasmgc" as const;

  constructor(private readonly stringRuntime?: IrLowerResolver) {}

  // #1584: sink = Instr[]. The factory returns a plain array and the raw escape
  // hatch is a direct `push` — so the emitted `Instr` stream is byte-identical
  // to the pre-#1584 inline emission (the WasmGC path is unchanged).
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
    const ops = this.stringRuntime?.emitStringConst?.(value, alloc, storage, materializer);
    if (!ops) throw new Error("WasmGcEmitter: string.const runtime is unavailable");
    out.push(...ops);
  }

  emitStringConcat(alloc: AllocSiteId | undefined, mode: IrStringConcatMode, out: Instr[], provider?: IrFuncRef): void {
    const ops = this.stringRuntime?.emitStringConcat?.(alloc, mode, provider);
    if (!ops) throw new Error("WasmGcEmitter: string.concat runtime is unavailable");
    out.push(...ops);
  }

  emitStringEquals(negate: boolean, out: Instr[], provider?: IrFuncRef): void {
    const ops = this.stringRuntime?.emitStringEquals?.(provider);
    if (!ops) throw new Error("WasmGcEmitter: string.eq runtime is unavailable");
    out.push(...ops);
    if (negate) out.push({ op: "i32.eqz" });
  }

  emitStringLength(
    _inputEncoding: IrStringEncoding | undefined,
    out: Instr[],
    provider?: IrStringLengthProvider,
  ): void {
    const ops = this.stringRuntime?.emitStringLen?.(_inputEncoding, provider);
    if (!ops) throw new Error("WasmGcEmitter: string.len runtime is unavailable");
    out.push(...ops, { op: "f64.convert_i32_s" });
  }

  emitStringCharAt(
    _alloc: AllocSiteId | undefined,
    _inputEncoding: IrStringEncoding,
    out: Instr[],
    provider?: IrFuncRef,
  ): void {
    const ops = this.stringRuntime?.emitStringCharAt?.(_alloc, _inputEncoding, provider);
    if (!ops) throw new Error("WasmGcEmitter: string.char_at runtime is unavailable");
    out.push(...ops);
  }

  emitStringCharCodeAt(_inputEncoding: IrStringEncoding, out: Instr[], provider?: IrFuncRef): void {
    const ops = this.stringRuntime?.emitStringCharCodeAt?.(_inputEncoding, provider);
    if (!ops) throw new Error("WasmGcEmitter: string.char_code_at runtime is unavailable");
    out.push(...ops);
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

  emitElemSet(layout: IrVecLowering, _valueScratchLocal: number, out: Instr[]): void {
    out.push({ op: "array.set", typeIdx: layout.arrayTypeIdx });
  }

  emitVecSetLength(layout: IrVecLowering, out: Instr[]): void {
    out.push({ op: "struct.set", typeIdx: layout.vecStructTypeIdx, fieldIdx: layout.lengthFieldIdx });
  }

  // #1804 — build a fixed-length vec from N element values already on the
  // stack (e0 deepest … eN top). Mirrors the legacy `compileArrayLiteral` fast
  // path (src/codegen/literals.ts): the vec struct is { length:i32,
  // data:(ref $arr) }, so the length (field 0) must sit BELOW the data ref
  // (field 1) for `struct.new`. `array.new_fixed` leaves the data ref on top,
  // so stash it in `dataScratchLocal`, push the length, re-load the data ref,
  // then `struct.new`.
  emitVecNewFixed(
    layout: IrVecLowering,
    count: number,
    capacity: number,
    dataScratchLocal: number,
    out: Instr[],
  ): void {
    if (capacity === count) {
      out.push({ op: "array.new_fixed", typeIdx: layout.arrayTypeIdx, length: count });
    } else if (count === 0 && capacity > 0) {
      out.push({ op: "i32.const", value: capacity });
      out.push({ op: "array.new_default", typeIdx: layout.arrayTypeIdx });
    } else {
      throw new Error(`WasmGcEmitter: vec capacity ${capacity} unsupported for logical length ${count}`);
    }
    out.push({ op: "local.set", index: dataScratchLocal });
    out.push({ op: "i32.const", value: count });
    out.push({ op: "local.get", index: dataScratchLocal });
    out.push({ op: "struct.new", typeIdx: layout.vecStructTypeIdx });
  }

  // ---- scalars / locals / globals / control flow ----------------------

  emitConst(instr: Extract<IrInstr, { kind: "const" }>, funcName: string, out: Instr[]): void {
    if (instr.value.kind === "null") {
      if (!instr.resultType) {
        throw new Error(`WasmGcEmitter: const null requires a result type (${funcName})`);
      }
      this.emitNull(instr.resultType, out);
      return;
    }
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

  // ---- (a6) union/boxing family (#2953) — byte-identical to the prior
  // inline field-order orchestration and struct.get pushes in lower.ts.
  emitBox(layout: IrUnionLowering, member: ValType, value: Instr[], out: Instr[]): void {
    const fields: Array<() => void> = [];
    fields[layout.tagFieldIdx] = () => out.push({ op: "i32.const", value: layout.tagFor(member) });
    fields[layout.valFieldIdx] = () => out.push(...value);
    for (const emitField of fields) emitField();
    out.push({ op: "struct.new", typeIdx: layout.typeIdx });
  }

  emitUnbox(layout: IrUnionLowering, out: Instr[]): void {
    out.push({ op: "struct.get", typeIdx: layout.typeIdx, fieldIdx: layout.valFieldIdx });
  }

  emitTagLoad(layout: IrUnionLowering, out: Instr[]): void {
    out.push({ op: "struct.get", typeIdx: layout.typeIdx, fieldIdx: layout.tagFieldIdx });
  }

  // ---- ref-coercion / null family (#2953) — byte-identical to the prior
  // ref.null.*, extern.convert_any, any.convert_extern, and ref.cast pushes in
  // lower.ts. Operand evaluation remains with the caller.
  emitNull(irType: IrType, out: Instr[]): void {
    const valType = asVal(irType);
    switch (valType?.kind) {
      case "ref":
      case "ref_null":
        out.push({ op: "ref.null", typeIdx: valType.typeIdx });
        return;
      case "externref":
      case "ref_extern":
        out.push({ op: "ref.null.extern" });
        return;
      case "eqref":
        out.push({ op: "ref.null.eq" });
        return;
      case "funcref":
        out.push({ op: "ref.null.func" });
        return;
      default:
        throw new Error(`WasmGcEmitter: cannot materialize null for IrType '${irType.kind}'`);
    }
  }

  emitToExternref(out: Instr[]): void {
    out.push({ op: "extern.convert_any" });
  }

  emitDowncast(target: { typeIdx: number } | IrType, out: Instr[]): void {
    out.push({ op: "ref.cast", typeIdx: refTargetTypeIdx(target) });
  }

  emitFromExternref(target: { typeIdx: number } | IrType, out: Instr[]): void {
    out.push({ op: "any.convert_extern" });
    this.emitDowncast(target, out);
  }

  // ---- function-reference family (#2953) — byte-identical to the prior
  // inline ref.func push in lower.ts. Name/handle resolution and operand order
  // remain with the caller.
  emitFuncRef(funcIdx: number, out: Instr[]): void {
    out.push({ op: "ref.func", funcIdx });
  }

  // ---- Promise aggregate family (#2953) — byte-identical to the prior
  // inline struct.new/get pushes in lower.ts. The canonical WasmGC Promise
  // layout is { state: i32, value: externref, callbacks: externref }.
  emitPromiseNew(promiseTypeIdx: number, out: Instr[]): void {
    out.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  }

  emitPromiseStateGet(promiseTypeIdx: number, out: Instr[]): void {
    out.push({ op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 });
  }

  emitPromiseValueGet(promiseTypeIdx: number, out: Instr[]): void {
    out.push({ op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 });
  }

  // ---- closure family (#2953) — byte-identical to the prior inline
  // struct.new/get pushes in lower.ts. The caller has already emitted the
  // lifted function reference through emitFuncRef, captures, and any required
  // ref.cast.
  emitClosureNew(layout: IrClosureLowering, _captureCount: number, out: Instr[]): void {
    const authorityGlobalIdx = layout.domCallbackAuthorityGlobalIdx?.();
    if (authorityGlobalIdx !== undefined) out.push({ op: "global.get", index: authorityGlobalIdx });
    out.push({ op: "struct.new", typeIdx: layout.structTypeIdx });
  }

  // (#3673) $arity operand — sits between the lifted funcref and the captures
  // in every root-wrapper-hierarchy closure allocation. (#4241) The `$bag`
  // expando slot follows it, so the two header operands are pushed together:
  // the trait has ONE hook for "the header operands between the funcref and
  // the captures", and splitting them would let a backend emit half a header.
  emitClosureArityOperand(arity: number, out: Instr[]): void {
    out.push({ op: "i32.const", value: arity });
    out.push({ op: "ref.null.extern" }); // (#4241) $bag — no expandos at birth
  }

  emitClosureFuncGet(layout: IrClosureLowering, out: Instr[]): void {
    out.push({ op: "struct.get", typeIdx: layout.structTypeIdx, fieldIdx: layout.funcFieldIdx });
  }

  emitCaptureGet(layout: IrClosureLowering, index: number, out: Instr[]): void {
    out.push({ op: "struct.get", typeIdx: layout.structTypeIdx, fieldIdx: layout.capFieldIdx(index) });
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
    if (this.stringRuntime?.standardizedExceptions?.()) {
      if (catches.length > 0) {
        out.push(
          buildStandardTryTable(
            blockType,
            body,
            catches.map((clause) => ({
              kind: "catch",
              tagIdx: clause.tagIdx,
              payloadType: { kind: "externref" },
              body: clause.body,
            })),
          ),
        );
        return;
      }

      if (!catchAll) {
        throw new Error("WasmGcEmitter: standardized try requires a handler");
      }
      const tagIdx = this.stringRuntime.ensureExnTag?.();
      if (tagIdx === undefined) {
        throw new Error("WasmGcEmitter: standardized try requires the shared exception tag");
      }
      const handler = [...catchAll];
      const terminal = handler[handler.length - 1];
      if (!terminal || terminal.op !== "rethrow" || terminal.depth !== 0) {
        throw new Error("WasmGcEmitter: standardized finally handler must end in rethrow 0");
      }
      // The handler block result leaves the caught externref on the operand
      // stack beneath the balanced finally body. Replace legacy rethrow with
      // a throw of that same payload through the module's shared tag.
      handler[handler.length - 1] = { op: "throw", tagIdx };
      out.push(
        buildStandardTryTable(blockType, body, [
          { kind: "catch", tagIdx, payloadType: { kind: "externref" }, body: handler },
        ]),
      );
      return;
    }
    out.push({
      op: "try",
      blockType,
      body,
      catches,
      ...(catchAll ? { catchAll } : {}),
    });
  }

  // ---- (a5) ref-cell family (#2953) — byte-identical to the prior inline
  // `out.push({op:"struct.new"/"struct.get"/"struct.set"...})` in the
  // refcell.new/get/set arms of lower.ts. The WasmGC stream is unchanged; this
  // moves the push behind the trait so a second backend can realize the same
  // intent (a 1-field mutable struct) as STRUCT_NEW / STRUCT_GET / STRUCT_SET.
  emitRefCellNew(layout: IrRefCellLowering, out: Instr[]): void {
    out.push({ op: "struct.new", typeIdx: layout.typeIdx });
  }

  emitRefCellGet(layout: IrRefCellLowering, out: Instr[]): void {
    out.push({ op: "struct.get", typeIdx: layout.typeIdx, fieldIdx: layout.fieldIdx });
  }

  emitRefCellSet(layout: IrRefCellLowering, out: Instr[]): void {
    out.push({ op: "struct.set", typeIdx: layout.typeIdx, fieldIdx: layout.fieldIdx });
  }
}

/** The WasmGC struct typeIdx for an object (`typeIdx`) or class (`structTypeIdx`). */
function structTypeIdxOf(layout: IrObjectStructLowering | IrClassLowering): number {
  return "typeIdx" in layout ? layout.typeIdx : layout.structTypeIdx;
}

function refTargetTypeIdx(target: { typeIdx: number } | IrType): number {
  if ("typeIdx" in target) return target.typeIdx;
  const valType = asVal(target);
  if (valType?.kind === "ref" || valType?.kind === "ref_null") return valType.typeIdx;
  throw new Error(`WasmGcEmitter: ref cast target must be a ref IrType, got '${target.kind}'`);
}
