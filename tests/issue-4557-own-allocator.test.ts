// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4557 — the ownership inversion: QuickJS allocates through OUR allocator.
//
// #4540 shipped the mirror image (our bump arena carved from the ENGINE's
// `malloc`) and kept it as the documented fallback, because a bump arena has no
// honest `free`, `realloc` or `usable_size` and `JS_NewRuntime2` needs all
// three. This file covers the allocator that makes the inversion possible and
// the wiring that installs it.
//
// The structural and standalone tests run everywhere. The artifact tests need
// a libquickjs.wasm built from the CURRENT `qjs_shim.c` — one that predates
// this issue has no `qjs_set_allocator`, and is skipped with a message rather
// than failing as a bare `undefined is not a function`.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ARTIFACT_CANDIDATES = [
  process.env.JS2WASM_QUICKJS_ARTIFACT,
  new URL("../.tmp/quickjs-artifact/libquickjs.wasm", import.meta.url).pathname,
  "/home/user/js2wasm/.tmp/quickjs-artifact/libquickjs.wasm",
].filter((p): p is string => typeof p === "string" && p.length > 0);
const ARTIFACT = ARTIFACT_CANDIDATES.find((p) => existsSync(p));

/** Present only in an artifact built from the current shim. */
const ARTIFACT_HAS_ALLOCATOR_HOOK =
  ARTIFACT !== undefined &&
  WebAssembly.Module.exports(new WebAssembly.Module(new Uint8Array(readFileSync(ARTIFACT)))).some(
    (e) => e.name === "qjs_set_allocator",
  );

const MALLOC_SPEC = {
  module: "qjs",
  name: "malloc",
  params: [{ kind: "i32" }],
  results: [{ kind: "i32" }],
} as const;

/** `__heap_stats` selectors — see `heap-allocator.ts`. */
const STAT_REGION_BYTES = 0;
const STAT_REGION_COUNT = 1;
const STAT_FREE_BYTES = 2;
const STAT_N_ALLOC = 4;
const STAT_N_FREE = 5;

interface HeapExports {
  memory: WebAssembly.Memory;
  js2wasm_malloc: (n: number) => number;
  js2wasm_calloc: (count: number, size: number) => number;
  js2wasm_free: (p: number) => void;
  js2wasm_realloc: (p: number, n: number) => number;
  js2wasm_usable_size: (p: number) => number;
  __heap_stats: (which: number) => number;
}

/** A STANDALONE module with the real allocator — regions come from memory.grow. */
async function standaloneHeap(): Promise<HeapExports> {
  const result = await compile(`export function ping(n: number): number { return n + 1; }`, {
    target: "linear",
    linearHeapAllocator: "malloc-v1",
  } as never);
  expect(result.errors ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as unknown as HeapExports;
}

describe("#4557 — the linear-lane allocator, standalone", () => {
  it("exports the five entry points JSMallocFunctions needs", async () => {
    const heap = await standaloneHeap();
    for (const name of [
      "js2wasm_malloc",
      "js2wasm_calloc",
      "js2wasm_free",
      "js2wasm_realloc",
      "js2wasm_usable_size",
    ] as const) {
      expect(typeof heap[name], name).toBe("function");
    }
  });

  it("reports the TRUE reserved size, which is not the request", async () => {
    // The acceptance criterion is specifically that this is asserted across a
    // spread rather than assumed to equal the request: QuickJS drives
    // JS_SetMemoryLimit / JS_SetGCThreshold off it, so a size that merely
    // echoes the argument under-counts the heap and delays collection.
    const heap = await standaloneHeap();
    const seenLarger: number[] = [];
    for (const n of [0, 1, 4, 8, 12, 13, 16, 17, 24, 31, 32, 100, 1000, 4096, 65536]) {
      const p = heap.js2wasm_malloc(n);
      expect(p, `malloc(${n})`).toBeGreaterThan(0);
      const usable = heap.js2wasm_usable_size(p);
      expect(usable, `usable(${n})`).toBeGreaterThanOrEqual(n);
      // The whole reservation must be writable, or the number is a lie in the
      // direction that corrupts rather than the direction that over-reports.
      new Uint8Array(heap.memory.buffer).fill(0xa5, p, p + usable);
      if (usable > n) seenLarger.push(n);
      heap.js2wasm_free(p);
    }
    expect(seenLarger.length, "usable_size never exceeded the request — suspiciously echo-like").toBeGreaterThan(0);
    expect(heap.js2wasm_usable_size(0)).toBe(0);
  });

  it("hands out non-overlapping blocks and keeps their contents", async () => {
    const heap = await standaloneHeap();
    const live: [number, number, number][] = [];
    for (let i = 0; i < 500; i++) {
      const n = 1 + ((i * 37) % 300);
      const p = heap.js2wasm_malloc(n);
      expect(p).toBeGreaterThan(0);
      new Uint8Array(heap.memory.buffer).fill((i % 251) + 1, p, p + n);
      live.push([p, n, (i % 251) + 1]);
    }
    const mem = new Uint8Array(heap.memory.buffer);
    for (const [p, n, v] of live) {
      for (let a = p; a < p + n; a++) {
        if (mem[a] !== v) throw new Error(`block at ${p} clobbered at ${a}: ${mem[a]} != ${v}`);
      }
    }
  });

  it("keeps the heap BOUNDED under alloc/free churn — the property the bump arena cannot have", async () => {
    const heap = await standaloneHeap();
    const live = new Int32Array(64);
    for (let i = 0; i < 2000; i++) {
      const slot = i % 64;
      if (live[slot]) heap.js2wasm_free(live[slot]!);
      live[slot] = heap.js2wasm_malloc(1 + ((i * 13) % 200));
    }
    const settled = heap.__heap_stats(STAT_REGION_BYTES);
    for (let i = 0; i < 200_000; i++) {
      const slot = i % 64;
      if (live[slot]) heap.js2wasm_free(live[slot]!);
      live[slot] = heap.js2wasm_malloc(1 + ((i * 13) % 200));
    }
    // 200k more allocations after the working set settled must not grow it.
    expect(heap.__heap_stats(STAT_REGION_BYTES)).toBe(settled);
    expect(heap.__heap_stats(STAT_N_ALLOC)).toBeGreaterThan(200_000);
    expect(heap.__heap_stats(STAT_N_FREE)).toBeGreaterThan(200_000);
  });

  it("coalesces: many freed neighbours become one block bigger than any of them", async () => {
    // Without coalescing this fails — the free lists would hold 64 separate
    // 1 KiB blocks and a 60 KiB request would have to take a fresh region.
    const heap = await standaloneHeap();
    const ptrs: number[] = [];
    for (let i = 0; i < 64; i++) ptrs.push(heap.js2wasm_malloc(1024));
    const regionsBefore = heap.__heap_stats(STAT_REGION_COUNT);
    for (const p of ptrs) heap.js2wasm_free(p);
    const big = heap.js2wasm_malloc(60 * 1024);
    expect(big).toBeGreaterThan(0);
    expect(heap.__heap_stats(STAT_REGION_COUNT)).toBe(regionsBefore);
  });

  it("reallocs in place when it can, and preserves contents when it cannot", async () => {
    const heap = await standaloneHeap();
    let p = heap.js2wasm_malloc(16);
    new Uint8Array(heap.memory.buffer).fill(0xab, p, p + 16);
    for (let n = 32; n <= 8192; n *= 2) {
      const q = heap.js2wasm_realloc(p, n);
      expect(q, `realloc to ${n}`).toBeGreaterThan(0);
      expect(heap.js2wasm_usable_size(q)).toBeGreaterThanOrEqual(n);
      const mem = new Uint8Array(heap.memory.buffer);
      for (let a = q; a < q + 16; a++) expect(mem[a], `byte ${a - q} after realloc to ${n}`).toBe(0xab);
      p = q;
    }
    // Shrinking releases the tail rather than sitting on it.
    const freeBefore = heap.__heap_stats(STAT_FREE_BYTES);
    p = heap.js2wasm_realloc(p, 32);
    expect(heap.__heap_stats(STAT_FREE_BYTES)).toBeGreaterThan(freeBefore);
    // realloc(p, 0) frees and yields the null pointer, per js_realloc's contract.
    expect(heap.js2wasm_realloc(p, 0)).toBe(0);
  });

  it("calloc zeroes recycled memory and refuses an overflowing product", async () => {
    const heap = await standaloneHeap();
    const dirty = heap.js2wasm_malloc(256);
    new Uint8Array(heap.memory.buffer).fill(0xff, dirty, dirty + 256);
    heap.js2wasm_free(dirty);
    const p = heap.js2wasm_calloc(16, 16);
    const mem = new Uint8Array(heap.memory.buffer);
    for (let a = p; a < p + 256; a++) expect(mem[a], `calloc byte ${a - p}`).toBe(0);
    // 0x10000 * 0x10000 wraps to 0 in i32; a wrapped product would hand back a
    // tiny block for a huge request, which is a heap overflow waiting to happen.
    expect(heap.js2wasm_calloc(0x10000, 0x10000)).toBe(0);
  });

  it("standalone emission is untouched unless the allocator is asked for", async () => {
    const src = `export function f(n: number): number { const a: number[] = []; for (let i = 0; i < n; i = i + 1) { a.push(i); } return a.length; }`;
    const plain = await compile(src, { target: "linear" } as never);
    const own = await compile(src, { target: "linear", linearHeapAllocator: "malloc-v1" } as never);
    expect(plain.wat).not.toContain("__heap_ctl");
    expect(own.wat).toContain("__heap_ctl");
    // The bump arena is the default, and it still owns the address space.
    expect(plain.wat).toContain("memory.grow");
  });
});

describe("#4557 — linked mode keeps #4540's one-grower property", () => {
  it("emits no memory.grow: with the allocator installed the ENGINE still owns growth", async () => {
    // The inversion moves WHO ALLOCATES, not who grows. Our allocator takes
    // whole regions from the engine's `malloc`; it never grows the memory
    // itself, so the #4540 construction proof survives unchanged.
    const result = await compile(`export function f(n: number): number { return n + 1; }`, {
      target: "linear",
      linearImportMemory: { module: "qjs", name: "memory", min: 256, max: 16384 },
      linearExternImports: [MALLOC_SPEC],
      linearLinkedHeap: { mallocImport: "malloc" },
      linearHeapAllocator: "malloc-v1",
    } as never);
    expect(result.errors ?? []).toEqual([]);
    expect(result.wat).not.toContain("memory.grow");
    expect(result.wat).toContain("__heap_ctl");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ARTIFACT_HAS_ALLOCATOR_HOOK)("#4557 — against the real pinned artifact", () => {
  const bytes = (): Uint8Array => new Uint8Array(readFileSync(ARTIFACT!));

  type Engine = {
    memory: WebAssembly.Memory;
    malloc: (n: number) => number;
    free: (p: number) => void;
    __indirect_function_table: WebAssembly.Table;
    _initialize?: () => void;
    qjs_set_allocator: (m: number, c: number, f: number, r: number, u: number) => number;
    qjs_new_runtime: () => number;
    qjs_new_runtime2: () => number;
    qjs_new_context: (rt: number) => number;
    qjs_eval: (ctx: number, src: number, len: number) => number;
    qjs_to_f64: (ctx: number, h: number) => number;
    qjs_free_value: (ctx: number, h: number) => void;
    qjs_libc_alloc_count: () => number;
    qjs_malloc_size: (rt: number) => number;
  };

  /** Order IS the ABI — `qjs_set_allocator` takes the slots positionally. */
  const PEER_ALLOC_ORDER = [
    "js2wasm_malloc",
    "js2wasm_calloc",
    "js2wasm_free",
    "js2wasm_realloc",
    "js2wasm_usable_size",
  ] as const;

  async function newEngine(): Promise<Engine> {
    const held: { instance?: WebAssembly.Instance } = {};
    const mem = (): WebAssembly.Memory => held.instance!.exports.memory as WebAssembly.Memory;
    const dv = (): DataView => new DataView(mem().buffer);
    const wasi_snapshot_preview1 = {
      clock_time_get: (_a: number, _b: bigint, out: number) => {
        dv().setBigUint64(out, 0n, true);
        return 0;
      },
      fd_write: (_fd: number, iovs: number, len: number, nwritten: number) => {
        const view = dv();
        let total = 0;
        for (let i = 0; i < len; i++) total += view.getUint32(iovs + i * 8 + 4, true);
        view.setUint32(nwritten, total, true);
        return 0;
      },
      fd_close: () => 0,
      fd_seek: (_fd: number, _o: bigint, _w: number, out: number) => {
        dv().setBigUint64(out, 0n, true);
        return 0;
      },
      fd_fdstat_get: (_fd: number, stat: number) => {
        new Uint8Array(mem().buffer).fill(0, stat, stat + 24);
        return 0;
      },
    };
    const result = await WebAssembly.instantiate(bytes(), { wasi_snapshot_preview1 });
    held.instance = result.instance;
    (held.instance.exports as { _initialize?: () => void })._initialize?.();
    return held.instance.exports as unknown as Engine;
  }

  async function linkedPair(install: boolean): Promise<{ engine: Engine; peer: HeapExports; rt: number; ctx: number }> {
    const engine = await newEngine();
    const built = await compile(`export function ping(n: number): number { return n + 1; }`, {
      target: "linear",
      linearImportMemory: { module: "qjs", name: "memory", min: 256, max: 16384 },
      linearExternImports: [MALLOC_SPEC],
      linearLinkedHeap: { mallocImport: "malloc", chunkBytes: 65536 },
      linearHeapAllocator: "malloc-v1",
    } as never);
    expect(built.errors ?? []).toEqual([]);
    const peer = (
      await WebAssembly.instantiate(built.binary, { qjs: { memory: engine.memory, malloc: engine.malloc } })
    ).instance.exports as unknown as HeapExports;
    if (install) {
      const table = engine.__indirect_function_table;
      const base = table.grow(PEER_ALLOC_ORDER.length);
      PEER_ALLOC_ORDER.forEach((name, i) => table.set(base + i, (peer as unknown as Record<string, unknown>)[name]));
      expect(engine.qjs_set_allocator(base, base + 1, base + 2, base + 3, base + 4)).toBe(1);
    }
    const rt = install ? engine.qjs_new_runtime2() : engine.qjs_new_runtime();
    return { engine, peer, rt, ctx: engine.qjs_new_context(rt) };
  }

  function evalJs(engine: Engine, ctx: number, src: string): number {
    const p = engine.malloc(src.length + 1);
    new Uint8Array(engine.memory.buffer).set(new TextEncoder().encode(src), p);
    const h = engine.qjs_eval(ctx, p, src.length);
    engine.free(p);
    return h;
  }

  // The IIFE is load-bearing: JS_EVAL_TYPE_GLOBAL shares one lexical scope, so a
  // top-level `let` makes every eval after the first throw a redeclaration
  // SyntaxError — which looks exactly like an extremely fast allocator.
  const WORKLOAD = `(function () {
    let acc = 0;
    for (let i = 0; i < 20000; i++) {
      const o = { a: i, b: i + 1, s: "k" + (i & 255) };
      acc += o.a + o.b + o.s.length;
    }
    return acc;
  })()`;
  // Cross-checked against Node evaluating the same source, not taken from the
  // engine under test — a self-reported constant would make the assertion vacuous.
  const WORKLOAD_EXPECT = 400_071_378;

  it("still imports ONLY wasi_snapshot_preview1 — the allocator arrives via the table, not as imports", () => {
    // Five unconditional wasm imports would make the artifact un-instantiable
    // without a peer that supplies an allocator, which `extract-abi.mjs` and the
    // runtime-eval tier both do. See the peer-allocator note in qjs_shim.c.
    const modules = new Set(WebAssembly.Module.imports(new WebAssembly.Module(bytes())).map((i) => i.module));
    expect([...modules]).toEqual(["wasi_snapshot_preview1"]);
  });

  it("refuses to build a runtime when no allocator was installed", async () => {
    const engine = await newEngine();
    expect(engine.qjs_new_runtime2()).toBe(0);
    // …and the legacy constructor still works, so the fallback stays reachable.
    expect(engine.qjs_new_runtime()).toBeGreaterThan(0);
  });

  it("the ENGINE reaches our allocator — proven by counting calls, not by the wiring", async () => {
    const { engine, peer, rt, ctx } = await linkedPair(true);
    expect(rt).toBeGreaterThan(0);
    const before = peer.__heap_stats(STAT_N_ALLOC);
    // Creating the runtime and context alone must already have gone through us.
    expect(before).toBeGreaterThan(0);
    const handle = evalJs(engine, ctx, WORKLOAD);
    expect(engine.qjs_to_f64(ctx, handle)).toBe(WORKLOAD_EXPECT);
    expect(peer.__heap_stats(STAT_N_ALLOC)).toBeGreaterThan(before);
    // Every byte QuickJS thinks it owns came from a block we handed out, so its
    // accounting cannot exceed the memory we actually reserved.
    expect(engine.qjs_malloc_size(rt)).toBeGreaterThan(0);
    expect(engine.qjs_malloc_size(rt)).toBeLessThanOrEqual(peer.__heap_stats(STAT_REGION_BYTES));
    // Nothing in the shim fell back to dlmalloc behind our back.
    expect(engine.qjs_libc_alloc_count()).toBe(0);
  });

  it("eval in a loop leaves the heap bounded", async () => {
    const { engine, peer, rt, ctx } = await linkedPair(true);
    let settled = 0;
    for (let round = 0; round < 12; round++) {
      const handle = evalJs(engine, ctx, WORKLOAD);
      expect(engine.qjs_to_f64(ctx, handle), `round ${round}`).toBe(WORKLOAD_EXPECT);
      engine.qjs_free_value(ctx, handle);
      if (round === 2) settled = peer.__heap_stats(STAT_REGION_BYTES);
    }
    expect(settled).toBeGreaterThan(0);
    // Nine more evals after the working set settled reserve nothing further,
    // and QuickJS's own accounting agrees the heap is not creeping.
    expect(peer.__heap_stats(STAT_REGION_BYTES)).toBe(settled);
    expect(engine.qjs_malloc_size(rt)).toBeLessThan(settled);
  });

  it("the memory does NOT grow while the engine allocates through us", async () => {
    // Who grows: still the engine. Our regions come from its `malloc`, and our
    // module contains no `memory.grow` instruction at all.
    const { engine, ctx } = await linkedPair(true);
    const pagesBefore = engine.memory.buffer.byteLength / 65536;
    for (let i = 0; i < 6; i++) engine.qjs_free_value(ctx, evalJs(engine, ctx, WORKLOAD));
    expect(engine.memory.buffer.byteLength / 65536).toBe(pagesBefore);
  });
});
