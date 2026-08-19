// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4539 — linear lane link topology: the module can declare external C imports
// and import its memory instead of defining one.
//
// The point of these tests is that the emitted binary genuinely LINKS in a real
// engine, not merely that a declaration table type-checks. Every case
// instantiates the module against a host-provided memory and imported
// functions; a wrong function index or a module that both defines and imports
// memory fails instantiation rather than passing quietly.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SRC = `export function add(a: number, b: number): number { return a + b; }`;

async function build(opts: Record<string, unknown>) {
  const result = await compile(SRC, { target: "linear", ...opts } as never);
  expect(result.errors ?? []).toEqual([]);
  expect(result.binary).toBeInstanceOf(Uint8Array);
  return result.binary;
}

/**
 * #4540 — importing a memory now REQUIRES saying where the heap comes from.
 * These tests originally imported a memory and kept the standalone arena, which
 * would bump-allocate from address 1024 inside the memory owner's shadow stack.
 * Every case below therefore also imports a `malloc` and points the arena at it;
 * that is the supported shape, not extra ceremony.
 */
const MALLOC_IMPORT = {
  module: "qjs",
  name: "malloc",
  params: [{ kind: "i32" }],
  results: [{ kind: "i32" }],
} as const;

/** A host-side bump allocator standing in for the owner's `malloc`. */
function hostMalloc(memory: WebAssembly.Memory, start = 4096): (n: number) => number {
  let cursor = start;
  return (n: number) => {
    const need = (n + 15) & ~15;
    while (cursor + need > memory.buffer.byteLength) memory.grow(1);
    const ptr = cursor;
    cursor += need;
    return ptr;
  };
}

/** Decode the import section names/kinds straight from the binary. */
function importsOf(bytes: Uint8Array): { module: string; name: string; kind: number }[] {
  const mod = new WebAssembly.Module(bytes);
  return WebAssembly.Module.imports(mod).map((i) => ({
    module: i.module,
    name: i.name,
    kind: i.kind === "function" ? 0 : i.kind === "memory" ? 2 : -1,
  }));
}

describe("#4539 — linear link topology", () => {
  it("emits no imports and defines its own memory by default (unchanged behaviour)", async () => {
    const bytes = await build({});
    expect(importsOf(bytes)).toEqual([]);
    const mod = new WebAssembly.Module(bytes);
    // Memory is defined AND exported by the module itself.
    expect(WebAssembly.Module.exports(mod).some((e) => e.kind === "memory")).toBe(true);
  });

  it("declares external C imports, and the module instantiates against them", async () => {
    const bytes = await build({
      linearExternImports: [
        {
          module: "qjs",
          name: "qjs_tag",
          params: [{ kind: "i32" }],
          results: [{ kind: "i32" }],
          ownership: "borrows",
        },
        {
          module: "qjs",
          name: "qjs_malloc_raw",
          params: [{ kind: "i32" }],
          results: [{ kind: "i32" }],
        },
      ],
    });
    const imports = importsOf(bytes);
    expect(imports.map((i) => `${i.module}.${i.name}`)).toEqual(["qjs.qjs_tag", "qjs.qjs_malloc_raw"]);

    // The real proof: it links and its own exports still work, which they
    // cannot if the import shift corrupted function indices.
    const instance = await WebAssembly.instantiate(bytes, {
      qjs: { qjs_tag: () => 0, qjs_malloc_raw: () => 0 },
    });
    const add = (instance.instance.exports as { add?: (a: number, b: number) => number }).add;
    expect(typeof add).toBe("function");
    expect(add?.(2, 3)).toBe(5);
  });

  it("imports memory instead of defining one, and shares the host's memory", async () => {
    const bytes = await build({
      linearImportMemory: { module: "qjs", name: "memory", min: 2, max: 16384 },
      linearExternImports: [MALLOC_IMPORT],
      linearLinkedHeap: { mallocImport: "malloc" },
    });
    const imports = importsOf(bytes);
    expect(imports).toEqual([
      { module: "qjs", name: "memory", kind: 2 },
      { module: "qjs", name: "malloc", kind: 0 },
    ]);

    const mod = new WebAssembly.Module(bytes);
    // It must NOT also define/export its own memory — one memory, one owner.
    expect(WebAssembly.Module.exports(mod).some((e) => e.kind === "memory")).toBe(false);

    const memory = new WebAssembly.Memory({ initial: 2, maximum: 16384 });
    const instance = await WebAssembly.instantiate(bytes, {
      qjs: { memory, malloc: hostMalloc(memory) },
    });
    const add = (instance.instance.exports as { add?: (a: number, b: number) => number }).add;
    expect(add?.(40, 2)).toBe(42);
  });

  it("combines an imported memory with imported functions, indices intact", async () => {
    const bytes = await build({
      linearImportMemory: { module: "qjs", name: "memory", min: 2 },
      linearExternImports: [
        {
          module: "qjs",
          name: "qjs_tag",
          params: [{ kind: "i32" }],
          results: [{ kind: "i32" }],
        },
        MALLOC_IMPORT,
      ],
      linearLinkedHeap: { mallocImport: "malloc" },
    });
    const memory = new WebAssembly.Memory({ initial: 2 });
    const instance = await WebAssembly.instantiate(bytes, {
      qjs: { memory, qjs_tag: () => 7, malloc: hostMalloc(memory) },
    });
    const add = (instance.instance.exports as { add?: (a: number, b: number) => number }).add;
    expect(add?.(1, 1)).toBe(2);
  });

  // #4540 — the combination that was silently catastrophic is now refused.
  it("refuses an imported memory without a linked heap", async () => {
    const result = await compile(SRC, {
      target: "linear",
      linearImportMemory: { module: "qjs", name: "memory", min: 2 },
    } as never);
    expect(result.errors?.[0]?.message).toMatch(/importMemory was set without linkedHeap/);
  });

  it("dedupes a repeated import rather than emitting it twice", async () => {
    const spec = {
      module: "qjs",
      name: "qjs_tag",
      params: [{ kind: "i32" }],
      results: [{ kind: "i32" }],
    };
    const bytes = await build({ linearExternImports: [spec, spec] });
    expect(importsOf(bytes)).toHaveLength(1);
  });
});
