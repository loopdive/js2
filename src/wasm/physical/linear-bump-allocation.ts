// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../model/instructions.js";
import type { GlobalDef, FuncTypeDef } from "../model/module-records.js";

const WASM_PAGE_SIZE = 65536;

/** Canonical default bump arena resources, before any physical indices exist. */
export function describeLinearBumpArena(heapStart: number = 1024): {
  memory: { min: number; max: number };
  heapPointer: GlobalDef;
  allocatorType: FuncTypeDef;
  allocatorBaseLocals: LocalDef[];
  allocatorLocals: LocalDef[];
} {
  const allocatorBaseLocals: LocalDef[] = [
    { name: "__malloc_ret", type: { kind: "i32" } },
    { name: "__malloc_next", type: { kind: "i32" } },
  ];
  return {
    memory: { min: 1, max: 256 },
    heapPointer: {
      name: "__heap_ptr",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: heapStart }],
    },
    allocatorType: { kind: "func", name: "$type___malloc", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
    allocatorBaseLocals,
    allocatorLocals: [
      ...allocatorBaseLocals,
      { name: "__malloc_required_pages", type: { kind: "i32" } },
      { name: "__malloc_current_pages", type: { kind: "i32" } },
    ],
  };
}

/** Fresh checked default allocator body, using the reserved heap-pointer index. */
export function buildLinearBumpAllocationBody(heapPointerGlobalIndex: number): Instr[] {
  return [
    ...buildLinearBumpAllocationPrologue(heapPointerGlobalIndex),
    ...buildLinearBumpAllocationCommitBody(heapPointerGlobalIndex),
  ];
}

function buildLinearBumpAllocationPrologue(heapPointerGlobalIndex: number): Instr[] {
  return [
    { op: "global.get", index: heapPointerGlobalIndex },
    { op: "local.set", index: 1 },
    ...checkedLinearBumpEndpointBody(),
    ...growLinearBumpMemoryBody(),
  ];
}

/** Prove both unsigned additions before aligning the endpoint in local 2. */
function checkedLinearBumpEndpointBody(): Instr[] {
  return [
    // size <= UINT32_MAX - ret, before the first addition loses a carry.
    { op: "local.get", index: 0 },
    { op: "i32.const", value: -1 },
    { op: "local.get", index: 1 },
    { op: "i32.sub" },
    { op: "i32.gt_u" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 },
    { op: "i32.add" },
    { op: "local.set", index: 2 },
    // next <= UINT32_MAX - 7, before padding loses the second carry.
    { op: "local.get", index: 2 },
    { op: "i32.const", value: -8 },
    { op: "i32.gt_u" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 7 },
    { op: "i32.add" },
    { op: "i32.const", value: -8 },
    { op: "i32.and" },
    { op: "local.set", index: 2 },
  ];
}

/** Check the actual grow result in page units before publishing any heap state. */
function growLinearBumpMemoryBody(): Instr[] {
  return [
    // requiredPages = (next >>> 16) + ((next & 65535) != 0).
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 16 },
    { op: "i32.shr_u" },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: WASM_PAGE_SIZE - 1 },
    { op: "i32.and" },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    { op: "i32.add" },
    { op: "local.set", index: 3 },
    { op: "memory.size" },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 3 },
    { op: "local.get", index: 4 },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "local.get", index: 4 },
        { op: "i32.sub" },
        { op: "memory.grow" },
        { op: "i32.const", value: -1 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }], else: [] },
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
