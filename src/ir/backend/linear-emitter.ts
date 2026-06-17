// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// LinearEmitter (#1714) — the SECOND BackendEmitter, proving the #1713 seam
// abstracts a structurally different backend.
//
// Scope is deliberately narrow (issue #1714 "Notes / scope"): ONLY the vec
// (array) length + element-read primitives, lowered to LINEAR MEMORY instead
// of WasmGC structs/arrays. Every other BackendEmitter method throws a clear
// not-implemented marker — covering the rest is a multi-sprint follow-up; the
// value here is proving the seam, not coverage.
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
//
// Contrast with WasmGcEmitter: there length is `struct.get $vec $length`,
// data is `struct.get $vec $data` (a typed array ref), element is `array.get`.
// SAME IR `vec.len`/`vec.get` node → two completely different op sequences,
// selected by which emitter `lower.ts` was handed. That is the proof.

import type { Instr, ValType } from "../types.js";
import type { BackendEmitter } from "./emitter.js";
import type { LinearVecLowering } from "./handles.js";

/** Byte offset of the `len:u32` field in the linear array header. */
const LINEAR_ARRAY_LEN_OFFSET = 8;
/** Byte offset where the element data region begins (after the 16B header). */
const LINEAR_ARRAY_DATA_OFFSET = 16;

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
    } as Instr);
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
    } as Instr);
  }

  // #1804 — vec construction is not yet implemented for the linear backend.
  // The read side (len/elem-get) is #1714 scope; the bump-allocated
  // `[header][len][cap][elements…]` store sequence is a follow-up. WasmGC is
  // the gate-tested default target, so a loud stub is acceptable here (matches
  // the other out-of-scope linear stubs).
  emitVecNewFixed(): void {
    notImplemented("emitVecNewFixed");
  }

  // ---- everything else: out of #1714 scope, fail loudly -------------------

  emitConst(): void {
    notImplemented("emitConst");
  }
  emitBinary(): void {
    notImplemented("emitBinary");
  }
  emitUnary(): void {
    notImplemented("emitUnary");
  }
  emitLocalGet(): void {
    notImplemented("emitLocalGet");
  }
  emitLocalSet(): void {
    notImplemented("emitLocalSet");
  }
  emitLocalTee(): void {
    notImplemented("emitLocalTee");
  }
  emitGlobalGet(): void {
    notImplemented("emitGlobalGet");
  }
  emitGlobalSet(): void {
    notImplemented("emitGlobalSet");
  }
  emitDrop(): void {
    notImplemented("emitDrop");
  }
  emitSelect(): void {
    notImplemented("emitSelect");
  }
  emitReturn(): void {
    notImplemented("emitReturn");
  }
  emitUnreachable(): void {
    notImplemented("emitUnreachable");
  }
  emitIf(): void {
    notImplemented("emitIf");
  }
  emitBr(): void {
    notImplemented("emitBr");
  }
  emitBrIf(): void {
    notImplemented("emitBrIf");
  }
  // (a3) control-flow family (#1584 §2a) — out of the #1714 vec-proof scope.
  emitBlock(): void {
    notImplemented("emitBlock");
  }
  emitLoop(): void {
    notImplemented("emitLoop");
  }
  // (a4) try-throw family (#1584 §2a) — out of the #1714 vec-proof scope.
  emitThrow(): void {
    notImplemented("emitThrow");
  }
  emitRethrow(): void {
    notImplemented("emitRethrow");
  }
  emitTry(): void {
    notImplemented("emitTry");
  }
  // (a2) struct/object family (#1584 §2a) — out of the #1714 vec-proof scope.
  emitAggregateNew(): void {
    notImplemented("emitAggregateNew");
  }
  emitFieldGet(): void {
    notImplemented("emitFieldGet");
  }
  emitFieldSet(): void {
    notImplemented("emitFieldSet");
  }
  // (a1) call family (#1584 §2a) — out of the #1714 linear vec-proof scope;
  // fail loudly until the linear backend wires its call lowering.
  emitCall(): void {
    notImplemented("emitCall");
  }
  emitCallRef(): void {
    notImplemented("emitCallRef");
  }
}
