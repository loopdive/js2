// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { addRuntime } from "../src/codegen-linear/runtime.js";
import { emitBinary } from "../src/emit/binary.js";
import { createEmptyModule } from "../src/ir/types.js";

const PAGE = 65536;
const BASE = 1024;

async function runtime() {
  const module = createEmptyModule();
  addRuntime(module);
  const fn = module.functions.findIndex((f) => f.name === "__malloc");
  const global = module.globals.findIndex((g) => g.name === "__heap_ptr");
  expect(fn).toBeGreaterThanOrEqual(0);
  expect(global).toBeGreaterThanOrEqual(0);
  module.exports.push(
    { name: "malloc", desc: { kind: "func", index: fn } },
    { name: "heap", desc: { kind: "global", index: global } },
  );
  const binary = new Uint8Array(emitBinary(module));
  expect(WebAssembly.validate(binary)).toBe(true);
  const wasm = await WebAssembly.compile(binary);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  const instance = await WebAssembly.instantiate(wasm, {});
  return instance.exports as unknown as {
    malloc(size: number): number;
    heap: WebAssembly.Global;
    memory: WebAssembly.Memory;
  };
}

function seed(memory: WebAssembly.Memory) {
  new Uint8Array(memory.buffer).set([11, 22, 33, 44, 55, 66, 77, 88], BASE);
}

function observed(exports: Awaited<ReturnType<typeof runtime>>) {
  return {
    heap: Number(exports.heap.value) >>> 0,
    bytes: exports.memory.buffer.byteLength,
    sentinel: Array.from(new Uint8Array(exports.memory.buffer, BASE, 8)),
  };
}

describe("6917 real default Linear arena failure atomicity", () => {
  for (const size of [0xfffffc00, 0xffffffff, -16, 0xfffffbff]) {
    it(`traps unsigned endpoint or alignment overflow for size ${size >>> 0} before publication`, async () => {
      const exports = await runtime();
      seed(exports.memory);
      const before = observed(exports);
      expect.soft(() => exports.malloc(size)).toThrow(WebAssembly.RuntimeError);
      const after = observed(exports);
      console.log("arena-failure-state", JSON.stringify({ size: size >>> 0, before, after }));
      expect.soft(after).toEqual(before);
      expect.soft(exports.malloc(8)).toBe(BASE);
      expect.soft(Number(exports.heap.value)).toBe(BASE + 8);
    });
  }

  it("traps failed growth before changing the heap or clearing a resident header", async () => {
    const exports = await runtime();
    seed(exports.memory);
    const before = observed(exports);
    // The actual default maximum is 256 pages; 257 is a deterministic refusal.
    expect.soft(() => exports.malloc(257 * PAGE - BASE)).toThrow(WebAssembly.RuntimeError);
    const after = observed(exports);
    console.log("arena-failure-state", JSON.stringify({ size: 257 * PAGE - BASE, before, after }));
    expect.soft(after).toEqual(before);
    expect.soft(exports.malloc(8)).toBe(BASE);
    expect.soft(observed(exports)).toEqual({ heap: BASE + 8, bytes: PAGE, sentinel: [0, 0, 0, 0, 55, 66, 77, 88] });
  });

  it("refuses alignment carry from a defensively injected high heap state", async () => {
    const exports = await runtime();
    // This state is not reachable through successful allocations under max256.
    exports.heap.value = -8;
    seed(exports.memory);
    const before = observed(exports);
    expect.soft(() => exports.malloc(1)).toThrow(WebAssembly.RuntimeError);
    const after = observed(exports);
    console.log("arena-defensive-state", JSON.stringify({ size: 1, before, after }));
    expect.soft(after).toEqual(before);
  });

  for (const size of [0, 1, 2, 3, 4, 7, 8, 9]) {
    it(`preserves return, alignment and conditional header clearing for size ${size}`, async () => {
      const exports = await runtime();
      seed(exports.memory);
      expect(exports.malloc(size)).toBe(BASE);
      const state = observed(exports);
      expect(state.heap).toBe(BASE + Math.ceil(size / 8) * 8);
      expect(state.bytes).toBe(PAGE);
      expect(state.sentinel).toEqual(size >= 4 ? [0, 0, 0, 0, 55, 66, 77, 88] : [11, 22, 33, 44, 55, 66, 77, 88]);
    });
  }

  it("crosses a page boundary with exactly the required successful growth", async () => {
    const exports = await runtime();
    expect(exports.malloc(PAGE - BASE - 8)).toBe(BASE);
    expect(Number(exports.heap.value)).toBe(PAGE - 8);
    expect(exports.malloc(16)).toBe(PAGE - 8);
    expect(Number(exports.heap.value)).toBe(PAGE + 8);
    expect(exports.memory.buffer.byteLength).toBe(2 * PAGE);
    expect(new DataView(exports.memory.buffer).getUint32(PAGE - 8, true)).toBe(0);
  });

  it("does not grow for an exact endpoint and admits a zero-size request there", async () => {
    const exports = await runtime();
    expect(exports.malloc(PAGE - BASE)).toBe(BASE);
    expect(Number(exports.heap.value)).toBe(PAGE);
    expect(exports.malloc(0)).toBe(PAGE);
    expect(Number(exports.heap.value)).toBe(PAGE);
    expect(exports.memory.buffer.byteLength).toBe(PAGE);
  });
});
