// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../model/instructions.js";
import type { GlobalDef, FuncTypeDef } from "../model/module-records.js";

const WASM_PAGE_SIZE = 65536;

/** Canonical default bump arena resources, before any physical indices exist. */
export function describeLinearBumpArena(heapStart: number = 1024): {
  memory: { min: number; max: number };
  heapPointer: GlobalDef;
  allocatorType: FuncTypeDef;
  allocatorLocals: LocalDef[];
} {
  return {
    memory: { min: 1, max: 256 },
    heapPointer: {
      name: "__heap_ptr",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: heapStart }],
    },
    allocatorType: { kind: "func", name: "$type___malloc", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
    allocatorLocals: [
      { name: "__malloc_ret", type: { kind: "i32" } },
      { name: "__malloc_next", type: { kind: "i32" } },
    ],
  };
}

/** Fresh unchanged default allocator body, using the reserved heap-pointer index. */
export function buildLinearBumpAllocationBody(heapPointerGlobalIndex: number): Instr[] {
  return [
    ...buildLinearBumpAllocationPrologue(heapPointerGlobalIndex),
    ...buildLinearBumpAllocationCommitBody(heapPointerGlobalIndex),
  ];
}

function buildLinearBumpAllocationPrologue(heapPointerGlobalIndex: number): Instr[] {
  return [
    // ret = __heap_ptr
    { op: "global.get", index: heapPointerGlobalIndex },
    { op: "local.set", index: 1 },
    // next = align8(ret + size) = (ret + size + 7) & ~7
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 }, // size
    { op: "i32.add" },
    { op: "i32.const", value: 7 },
    { op: "i32.add" },
    { op: "i32.const", value: -8 }, // ~7 = 0xFFFFFFF8
    { op: "i32.and" },
    { op: "local.set", index: 2 },
    // if (next > memory.size * PAGE_SIZE) grow
    { op: "local.get", index: 2 },
    { op: "memory.size" },
    { op: "i32.const", value: WASM_PAGE_SIZE },
    { op: "i32.mul" },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // pages_needed = ceil((next - cur_bytes) / PAGE_SIZE)
        //              = (next - cur_bytes + PAGE_SIZE - 1) / PAGE_SIZE
        { op: "local.get", index: 2 },
        { op: "memory.size" },
        { op: "i32.const", value: WASM_PAGE_SIZE },
        { op: "i32.mul" },
        { op: "i32.sub" },
        { op: "i32.const", value: WASM_PAGE_SIZE - 1 },
        { op: "i32.add" },
        { op: "i32.const", value: WASM_PAGE_SIZE },
        { op: "i32.div_u" },
        { op: "memory.grow" },
        // discard memory.grow's result (prev page count, or -1 on failure)
        { op: "drop" },
      ],
      else: [],
    },
  ];
}

/** Shared original commit/header-zeroing tail; linked allocation keeps its own prologue. */
export function buildLinearBumpAllocationCommitBody(heapPointerGlobalIndex: number): Instr[] {
  return [
    // __heap_ptr = next
    { op: "local.get", index: 2 },
    { op: "global.set", index: heapPointerGlobalIndex },
    // Zero the record header word so every hand-out starts in a known state.
    // The string runtime memoises its ASCII verdict in byte 1 of this word
    // (see STRING_ASCII_CACHE_OFFSET); without this, an embedder that recycles
    // the arena through `__arena_reset` could serve a *stale* verdict from the
    // previous tenant of the address. Guarded on `size >= 4` purely so a
    // zero-size request at the very end of memory cannot store out of bounds —
    // every real record is header-bearing and takes the store.
    { op: "local.get", index: 0 }, // size
    { op: "i32.const", value: 4 },
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 0 },
        { op: "i32.store", align: 2, offset: 0 },
      ],
      else: [],
    },
    // return ret
    { op: "local.get", index: 1 },
  ];
}
