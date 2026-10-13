// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef, ValType } from "../model/instructions.js";

/** Canonical constructor signature and scratch, independent of physical reservations. */
export function describeLinearArrayConstructor(): { params: ValType[]; results: ValType[]; locals: LocalDef[] } {
  return { params: [{ kind: "i32" }], results: [{ kind: "i32" }], locals: [{ name: "$l0", type: { kind: "i32" } }] };
}

/** Fresh unchanged tag/length/capacity constructor, bound to this attempt's allocator. */
export function buildLinearArrayConstructorBody(mallocFunctionIndex: number, pointerLocalIndex: number = 1): Instr[] {
  return [
    // Allocate: 16 + cap*8
    { op: "i32.const", value: 16 },
    { op: "local.get", index: 0 }, // cap
    { op: "i32.const", value: 8 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "call", funcIdx: mallocFunctionIndex },
    { op: "local.set", index: pointerLocalIndex },
    // Store tag byte 0x01 (Array) at ptr+0
    { op: "local.get", index: pointerLocalIndex },
    { op: "i32.const", value: 0x01 },
    { op: "i32.store8", align: 0, offset: 0 },
    // Store len=0 at ptr+8
    { op: "local.get", index: pointerLocalIndex },
    { op: "i32.const", value: 0 },
    { op: "i32.store", align: 2, offset: 8 },
    // Store cap at ptr+12
    { op: "local.get", index: pointerLocalIndex },
    { op: "local.get", index: 0 }, // cap
    { op: "i32.store", align: 2, offset: 12 },
    // Return ptr
    { op: "local.get", index: pointerLocalIndex },
  ];
}
