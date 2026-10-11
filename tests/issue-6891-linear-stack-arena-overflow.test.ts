// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { addRuntime } from "../src/codegen-linear/runtime.js";
import { addLinearStackArenaRuntime } from "../src/codegen-linear/runtime-stack-arena.js";
import { emitBinary } from "../src/emit/binary.js";
import { LINEAR_STACK_ARENA_BYTES } from "../src/ir/analysis/linear-memory-plan.js";
import { createEmptyModule, type WasmModule } from "../src/ir/types.js";

const BASE = 1024;
const END = BASE + LINEAR_STACK_ARENA_BYTES;
const FALLBACK = 0x12345678;

type StackExports = {
  mark: () => number;
  alloc: (size: number) => number;
  restore: (mark: number) => void;
  base: WebAssembly.Global;
  pointer: WebAssembly.Global;
};

/** Export by name in the appropriate Wasm index space, including imports. */
async function instantiateStack(mod: WasmModule, imports: WebAssembly.Imports = {}) {
  addLinearStackArenaRuntime(mod);
  for (const [name, runtimeName] of [
    ["mark", "__linear_stack_mark"],
    ["alloc", "__linear_stack_alloc"],
    ["restore", "__linear_stack_restore"],
  ]) {
    const localIndex = mod.functions.findIndex((func) => func.name === runtimeName);
    expect(localIndex).toBeGreaterThanOrEqual(0);
    const importCount = mod.imports.filter((item) => item.desc.kind === "func").length;
    mod.exports.push({ name, desc: { kind: "func", index: importCount + localIndex } });
  }
  for (const [name, runtimeName] of [
    ["base", "__linear_stack_base"],
    ["pointer", "__linear_stack_ptr"],
  ]) {
    const localIndex = mod.globals.findIndex((global) => global.name === runtimeName);
    expect(localIndex).toBeGreaterThanOrEqual(0);
    const importCount = mod.imports.filter((item) => item.desc.kind === "global").length;
    mod.exports.push({ name, desc: { kind: "global", index: importCount + localIndex } });
  }
  const binary = emitBinary(mod);
  expect(WebAssembly.validate(binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(binary, imports);
  return instance.exports as unknown as StackExports;
}

async function buildRealRuntime() {
  const mod = createEmptyModule();
  addRuntime(mod);
  return (await instantiateStack(mod)) as StackExports & { memory: WebAssembly.Memory };
}

/**
 * Controlled allocator boundary, not an end-to-end heap safety proof. The
 * production stack adapter executes in Wasm; only __malloc's result is supplied
 * by the host. High addresses are arithmetic probes with no memory accesses.
 */
async function buildControlledAllocator(options: { base?: number; fallback?: number; failure?: Error } = {}) {
  const mod = createEmptyModule();
  const mallocTypeIdx = mod.types.length;
  mod.types.push({ kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
  mod.imports.push({ module: "allocator", name: "record", desc: { kind: "func", typeIdx: mallocTypeIdx } });
  const recordIdx = mod.imports.filter((item) => item.desc.kind === "func").length - 1;
  mod.functions.push({
    name: "__malloc",
    typeIdx: mallocTypeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: recordIdx },
    ],
    exported: false,
  });
  const calls: number[] = [];
  const stack = await instantiateStack(mod, {
    allocator: {
      record(size: number) {
        // Record exact unsigned i32 bits, including negative host arguments.
        calls.push(size >>> 0);
        if (calls.length === 1) return options.base ?? BASE;
        if (options.failure) throw options.failure;
        return options.fallback ?? FALLBACK;
      },
    },
  });
  return { stack, calls };
}

function state(stack: StackExports) {
  // Do not observe via mark(): a corrupted zero pointer would reinitialize.
  return { base: Number(stack.base.value) >>> 0, pointer: Number(stack.pointer.value) >>> 0 };
}

describe("issue 6891: real Linear stack runtime", () => {
  it("retains zero-size and 8-byte alignment controls", async () => {
    const stack = await buildRealRuntime();
    expect(state(stack)).toEqual({ base: 0, pointer: 0 });
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(0)).toBe(BASE);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE });
    let pointer = BASE;
    for (const [size, advance] of [
      [1, 8],
      [7, 8],
      [8, 8],
      [9, 16],
    ]) {
      expect(stack.alloc(size)).toBe(pointer);
      pointer += advance;
      expect(state(stack)).toEqual({ base: BASE, pointer });
    }
  });

  it.each([65535, 65536])("admits size %i aligned exactly to the capacity endpoint", async (size) => {
    const stack = await buildRealRuntime();
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(size)).toBe(BASE);
    expect(state(stack)).toEqual({ base: BASE, pointer: END });
  });

  it("delegates size 65537 to the real allocator and retains stack state", async () => {
    const stack = await buildRealRuntime();
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(65537)).toBe(END);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE });
    expect(stack.alloc(8)).toBe(BASE);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE + 8 });
  });

  it("admits exact remaining capacity, then zero, and delegates one byte", async () => {
    const stack = await buildRealRuntime();
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(8)).toBe(BASE);
    expect(stack.alloc(LINEAR_STACK_ARENA_BYTES - 8)).toBe(BASE + 8);
    expect(state(stack)).toEqual({ base: BASE, pointer: END });
    expect(stack.alloc(0)).toBe(END);
    expect(state(stack)).toEqual({ base: BASE, pointer: END });
    expect(stack.alloc(1)).toBe(END);
    expect(state(stack)).toEqual({ base: BASE, pointer: END });
  });

  it("delegates first-add overflow without rewinding into live stack storage", async () => {
    const stack = await buildRealRuntime();
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(8)).toBe(BASE);
    expect(state(stack)).toEqual({ base: BASE, pointer: 1032 });
    // The ordinary heap allocator has separate unchecked arithmetic. Never
    // dereference this huge result or reuse this instance for another huge case.
    expect.soft(stack.alloc(-16)).toBe(END);
    expect.soft(state(stack)).toEqual({ base: BASE, pointer: 1032 });
    expect.soft(stack.alloc(8)).toBe(1032);
    expect.soft(state(stack)).toEqual({ base: BASE, pointer: 1040 });
  });

  it("delegates padding-only overflow without installing pointer zero", async () => {
    const stack = await buildRealRuntime();
    expect(stack.mark()).toBe(BASE);
    // BASE + size is 0xffffffff: only the alignment padding overflows.
    expect.soft(stack.alloc(0xfffffbff)).toBe(END);
    expect.soft(state(stack)).toEqual({ base: BASE, pointer: BASE });
  });

  it("restores an inner frame after fallback while preserving outer bytes", async () => {
    const stack = await buildRealRuntime();
    const outerMark = stack.mark();
    const outer = stack.alloc(16);
    expect(outer).toBe(BASE);
    const innerMark = stack.mark();
    expect(innerMark).toBe(BASE + 16);
    const inner = stack.alloc(24);
    expect(inner).toBe(BASE + 16);
    const bytes = new Uint8Array(stack.memory.buffer);
    bytes.set([11, 22, 33, 44], outer);
    bytes.set([55, 66, 77, 88], inner);
    expect(stack.alloc(LINEAR_STACK_ARENA_BYTES)).toBe(END);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE + 40 });
    stack.restore(innerMark);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE + 16 });
    // Fallback may grow memory, so obtain a fresh view after the call.
    const restoredBytes = new Uint8Array(stack.memory.buffer);
    expect(Array.from(restoredBytes.slice(outer, outer + 4))).toEqual([11, 22, 33, 44]);
    expect(stack.alloc(24)).toBe(inner);
    expect(Array.from(restoredBytes.slice(inner, inner + 4))).toEqual([55, 66, 77, 88]);
    restoredBytes.set([91, 92, 93, 94], inner);
    expect(Array.from(restoredBytes.slice(inner, inner + 4))).toEqual([91, 92, 93, 94]);
    expect(Array.from(restoredBytes.slice(outer, outer + 4))).toEqual([11, 22, 33, 44]);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE + 40 });
    stack.restore(outerMark);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE });
    // Restore reuses stack storage; it does not free delegated heap storage.
  });
});

describe("issue 6891: controlled allocator boundary (production emitted stack helper)", () => {
  it("reserves once lazily across nested marks with an imported-function offset", async () => {
    const { stack, calls } = await buildControlledAllocator();
    expect(calls).toEqual([]);
    expect(state(stack)).toEqual({ base: 0, pointer: 0 });
    const outerMark = stack.mark();
    expect(outerMark).toBe(BASE);
    expect(stack.alloc(0)).toBe(BASE);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE });
    expect(stack.alloc(8)).toBe(BASE);
    const innerMark = stack.mark();
    expect(innerMark).toBe(BASE + 8);
    expect(stack.alloc(9)).toBe(BASE + 8);
    expect(stack.mark()).toBe(BASE + 24);
    stack.restore(innerMark);
    expect(state(stack)).toEqual({ base: BASE, pointer: BASE + 8 });
    stack.restore(outerMark);
    expect(stack.mark()).toBe(BASE);
    expect(calls).toEqual([LINEAR_STACK_ARENA_BYTES]);
  });

  it.each([65535, 65536])("admits size %i without a fallback call", async (size) => {
    const { stack, calls } = await buildControlledAllocator();
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(size)).toBe(BASE);
    expect(state(stack)).toEqual({ base: BASE, pointer: END });
    expect(calls).toEqual([LINEAR_STACK_ARENA_BYTES]);
  });

  it("keeps zero at exhaustion in the stack and delegates one byte exactly once", async () => {
    const { stack, calls } = await buildControlledAllocator();
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(8)).toBe(BASE);
    expect(stack.alloc(LINEAR_STACK_ARENA_BYTES - 8)).toBe(BASE + 8);
    expect(stack.alloc(0)).toBe(END);
    expect(state(stack)).toEqual({ base: BASE, pointer: END });
    expect(calls).toEqual([LINEAR_STACK_ARENA_BYTES]);
    expect(stack.alloc(1)).toBe(FALLBACK);
    expect(calls).toEqual([LINEAR_STACK_ARENA_BYTES, 1]);
    expect(state(stack)).toEqual({ base: BASE, pointer: END });
  });

  it.each([65537, 0x7fffffff, 0x80000000, 0xfffffff0, 0xffffffff])(
    "passes request %i unchanged once and propagates the allocator result",
    async (size) => {
      const { stack, calls } = await buildControlledAllocator();
      expect(stack.mark()).toBe(BASE);
      expect.soft(stack.alloc(size)).toBe(FALLBACK);
      expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES, size >>> 0]);
      expect.soft(state(stack)).toEqual({ base: BASE, pointer: BASE });
      expect.soft(stack.alloc(8)).toBe(BASE);
      expect.soft(state(stack)).toEqual({ base: BASE, pointer: BASE + 8 });
      expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES, size >>> 0]);
    },
  );

  it("routes first-add overflow from pointer 1032 and retains the original frame", async () => {
    const { stack, calls } = await buildControlledAllocator();
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(8)).toBe(BASE);
    expect.soft(stack.alloc(-16)).toBe(FALLBACK);
    expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES, 0xfffffff0]);
    expect.soft(state(stack)).toEqual({ base: BASE, pointer: 1032 });
    expect.soft(stack.alloc(8)).toBe(1032);
    expect.soft(state(stack)).toEqual({ base: BASE, pointer: 1040 });
    expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES, 0xfffffff0]);
  });

  it("routes padding-only overflow without zeroing the pointer", async () => {
    const { stack, calls } = await buildControlledAllocator();
    expect(stack.mark()).toBe(BASE);
    expect.soft(stack.alloc(0xfffffbff)).toBe(FALLBACK);
    expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES, 0xfffffbff]);
    expect.soft(state(stack)).toEqual({ base: BASE, pointer: BASE });
  });

  it("admits small high-address allocations with capacity ending at 4 GiB", async () => {
    const base = 0xffff0000;
    const { stack, calls } = await buildControlledAllocator({ base });
    expect(stack.mark() >>> 0).toBe(base);
    expect.soft(stack.alloc(8) >>> 0).toBe(base);
    expect.soft(state(stack)).toEqual({ base, pointer: base + 8 });
    expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES]);
  });

  it("delegates an in-capacity high endpoint that cannot be represented as i32", async () => {
    const base = 0xffff0000;
    const { stack, calls } = await buildControlledAllocator({ base });
    expect(stack.mark() >>> 0).toBe(base);
    expect.soft(stack.alloc(LINEAR_STACK_ARENA_BYTES)).toBe(FALLBACK);
    expect.soft(state(stack)).toEqual({ base, pointer: base });
    expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES, LINEAR_STACK_ARENA_BYTES]);
  });

  it.each([65537, 0xfffffff0])("propagates the allocator exception for %i with state intact", async (size) => {
    const failure = new Error("controlled allocator failure");
    const { stack, calls } = await buildControlledAllocator({ failure });
    expect(stack.mark()).toBe(BASE);
    expect(stack.alloc(8)).toBe(BASE);
    expect.soft(() => stack.alloc(size)).toThrow(failure);
    expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES, size >>> 0]);
    expect.soft(state(stack)).toEqual({ base: BASE, pointer: BASE + 8 });
    expect.soft(stack.alloc(8)).toBe(BASE + 8);
    expect.soft(state(stack)).toEqual({ base: BASE, pointer: BASE + 16 });
    expect.soft(calls).toEqual([LINEAR_STACK_ARENA_BYTES, size >>> 0]);
  });
});
