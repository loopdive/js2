// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4540 — heap coexistence in ONE shared linear memory.
//
// The hazard is measured, not theoretical. Against the pinned quickjs-ng
// v0.16.1 artifact (`954dc53`, wasm32-wasip1, `--stack-first`):
//
//   __stack_pointer init 65536   -> shadow stack occupies [0, 65536)
//   static data                  -> [65536, 170392), 2 active segments
//   first malloc(1)              -> 172176 on this container
//   memory                       -> 256 pages initial, 16384 max
//
// Our linear arena used to start bump-allocating at a hard-coded 1024, i.e.
// INSIDE the engine's shadow stack, and its string-literal data segment was
// ACTIVE at offset 64 — written at instantiation, before a single instruction
// of ours runs. Both are fixed here by making placement dynamic: the arena is
// carved from the engine's own `malloc`, and literal data is copied into an
// allocated block from a PASSIVE segment.
//
// The structural assertions below run everywhere. The behavioural ones need the
// real artifact and skip without it — see `scripts/quickjs-artifact/build.sh`.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ARTIFACT_CANDIDATES = [
  process.env.JS2WASM_QUICKJS_ARTIFACT,
  "/home/user/js2wasm/.tmp/quickjs-artifact/libquickjs.wasm",
  new URL("../.tmp/quickjs-artifact/libquickjs.wasm", import.meta.url).pathname,
].filter((p): p is string => typeof p === "string" && p.length > 0);
const ARTIFACT = ARTIFACT_CANDIDATES.find((p) => existsSync(p));

/** Measured layout of the pinned artifact — see the header comment. */
const ENGINE_SHADOW_STACK_END = 65536;
const ENGINE_STATIC_DATA_END = 170392;

const MALLOC_SPEC = {
  module: "qjs",
  name: "malloc",
  params: [{ kind: "i32" }],
  results: [{ kind: "i32" }],
} as const;

async function compileLinked(src: string): Promise<{ binary: Uint8Array; wat: string }> {
  const result = await compile(src, {
    target: "linear",
    // `min` matches the artifact's own initial size; it is a lower bound the
    // host must satisfy, and the artifact owns the real limits.
    linearImportMemory: { module: "qjs", name: "memory", min: 256, max: 16384 },
    linearExternImports: [MALLOC_SPEC],
    linearLinkedHeap: { mallocImport: "malloc" },
  } as never);
  expect(result.errors ?? []).toEqual([]);
  return { binary: result.binary, wat: result.wat };
}

async function buildLinked(src: string): Promise<Uint8Array> {
  return (await compileLinked(src)).binary;
}

// ── Minimal binary reader: assert on the BYTES, not on our own model of them ──

function sections(buf: Uint8Array): { id: number; start: number; size: number }[] {
  let o = 8;
  const out: { id: number; start: number; size: number }[] = [];
  while (o < buf.length) {
    const id = buf[o++]!;
    let size = 0;
    let shift = 0;
    let b: number;
    do {
      b = buf[o++]!;
      size |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    out.push({ id, start: o, size });
    o += size;
  }
  return out;
}

/** Data-segment flag bytes, in order. 0 = active, 1 = passive. */
function dataSegmentFlags(buf: Uint8Array): number[] {
  const sec = sections(buf).find((s) => s.id === 11);
  if (!sec) return [];
  let o = sec.start;
  const readU32 = (): number => {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = buf[o++]!;
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return v >>> 0;
  };
  const n = readU32();
  const flags: number[] = [];
  for (let i = 0; i < n; i++) {
    const flag = readU32();
    flags.push(flag);
    if (flag === 0) {
      o++; // 0x41 i32.const
      while (buf[o++]! & 0x80) {
        /* skip sleb */
      }
      o++; // 0x0b end
    }
    const len = readU32();
    o += len;
  }
  return flags;
}

const GROWS_SRC = `export function f(n: number): number {
      const a: number[] = [];
      for (let i = 0; i < n; i = i + 1) { a.push(i); }
      return a.length;
    }`;

describe("#4540 — linked-mode heap placement is dynamic (structural)", () => {
  it("emits no memory.grow at all — the memory's owner is the only grower", async () => {
    // Asserted on the WAT rather than by scanning code bytes: `0x40` is also an
    // ordinary immediate byte, so a byte scan reports growth that is not there.
    // The text form is a per-instruction rendering of the same module, so the
    // absence is exact.
    const { wat } = await compileLinked(GROWS_SRC);
    expect(wat).not.toContain("memory.grow");
  });

  it("the standalone module DOES grow — proving the check above discriminates", async () => {
    // Without this, "no memory.grow" could be an artefact of how the check is
    // written rather than of the mode, and the assertion above would be vacuous.
    const standalone = await compile(GROWS_SRC, { target: "linear" } as never);
    expect(standalone.wat).toContain("memory.grow");
  });

  it("literal data is a PASSIVE segment — an active one would write through the engine", async () => {
    const linked = await buildLinked(`export function s(): number { const x = "hello, world"; return x.length; }`);
    const flags = dataSegmentFlags(linked);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f === 1)).toBe(true);
    // …and a data-count section (id 12) must precede the code section, or a
    // validator rejects `memory.init` outright.
    const ids = sections(linked).map((s) => s.id);
    expect(ids).toContain(12);
    expect(ids.indexOf(12)).toBeLessThan(ids.indexOf(10));
    // A start section (id 8) runs the image copy before any user code.
    expect(ids).toContain(8);
  });

  it("standalone keeps its ACTIVE segment — the change is scoped to linked mode", async () => {
    const standalone = await compile(`export function s(): number { const x = "hello, world"; return x.length; }`, {
      target: "linear",
    } as never);
    expect(dataSegmentFlags(standalone.binary)).toEqual([0]);
    expect(sections(standalone.binary).map((s) => s.id)).not.toContain(12);
  });

  it("refuses number.toString() in linked mode rather than reading engine memory", async () => {
    // The Ryū tables are addressed by link-time constants spread across a large
    // generated body. Rebasing them is follow-up work; until then a refusal
    // beats a formatter that silently reads the engine's static data.
    const result = await compile(`export function f(n: number): number { return n.toString().length; }`, {
      target: "linear",
      linearImportMemory: { module: "qjs", name: "memory", min: 256 },
      linearExternImports: [MALLOC_SPEC],
      linearLinkedHeap: { mallocImport: "malloc" },
    } as never);
    expect((result.errors ?? []).map((e) => e.message).join(" | ")).toMatch(/not yet supported in linked mode/);
  });

  it("refuses exposeArenaReset in linked mode instead of leaking every chunk but one", async () => {
    const result = await compile(`export function f(): number { return 1; }`, {
      target: "linear",
      allocator: "arena-reset",
      linearImportMemory: { module: "qjs", name: "memory", min: 256 },
      linearExternImports: [MALLOC_SPEC],
      linearLinkedHeap: { mallocImport: "malloc" },
    } as never);
    expect((result.errors ?? []).map((e) => e.message).join(" | ")).toMatch(/exposeArenaReset is not supported/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(ARTIFACT === undefined)("#4540 — against the real pinned artifact", () => {
  const bytes = (): Uint8Array => new Uint8Array(readFileSync(ARTIFACT!));

  type Engine = {
    memory: WebAssembly.Memory;
    malloc: (n: number) => number;
    free: (p: number) => void;
    _initialize?: () => void;
    qjs_new_runtime: () => number;
    qjs_new_context: (rt: number) => number;
    qjs_eval: (ctx: number, src: number, len: number) => number;
    qjs_to_f64: (ctx: number, h: number) => number;
  };

  async function newEngine(): Promise<Engine> {
    // Held in an object because the WASI stub closes over the instance that
    // instantiating it produces — a plain binding would be read before assign.
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

  it("reproduces the layout this slice is built against", async () => {
    const engine = await newEngine();
    expect(engine.memory.buffer.byteLength).toBe(256 * 65536);
    const first = engine.malloc(1);
    // The exact constant is environment-dependent (ADR-0020 and #4540 both
    // recorded 171696; this container measures 172176 — same pinned refs, +480
    // from shifted static data). What must hold is the ORDERING that makes the
    // old fixed HEAP_START catastrophic, so assert that and not the number.
    expect(first).toBeGreaterThan(ENGINE_STATIC_DATA_END);
    expect(1024).toBeLessThan(ENGINE_SHADOW_STACK_END); // the old HEAP_START
  });

  it("our arena allocates only inside blocks the engine handed it", async () => {
    const src = `export function work(n: number): number {
      const a: number[] = [];
      for (let i = 0; i < n; i = i + 1) { a.push(i * 2); }
      let s = 0;
      for (let i = 0; i < n; i = i + 1) { s = s + a[i]; }
      return s;
    }`;
    const linked = await buildLinked(src);

    // Phase 1 — run the workload and record the exact malloc call sequence.
    const engine1 = await newEngine();
    const sizes: number[] = [];
    const ours = await WebAssembly.instantiate(linked, {
      qjs: {
        memory: engine1.memory,
        malloc: (n: number) => {
          sizes.push(n);
          return engine1.malloc(n);
        },
      },
    });
    const work = (ours.instance.exports as { work: (n: number) => number }).work;
    expect(work(1000)).toBe(999 * 1000); // sum of 2i for i<1000

    // Phase 2 — replay the SAME malloc sequence on a fresh engine, with no
    // module of ours present. dlmalloc's internal state and shadow-stack
    // residue therefore end up identical, so any byte that differs between the
    // two runs is a write by OUR module and nothing else.
    const engine2 = await newEngine();
    for (const n of sizes) engine2.malloc(n);
    const expected = new Uint8Array(engine2.memory.buffer.slice(0, ENGINE_STATIC_DATA_END));

    const engine3 = await newEngine();
    const ours3 = await WebAssembly.instantiate(linked, {
      qjs: { memory: engine3.memory, malloc: (n: number) => engine3.malloc(n) },
    });
    (ours3.instance.exports as { work: (n: number) => number }).work(1000);
    const actual = new Uint8Array(engine3.memory.buffer.slice(0, ENGINE_STATIC_DATA_END));

    let firstDiff = -1;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== actual[i]) {
        firstDiff = i;
        break;
      }
    }
    // Not vacuous: with the pre-#4540 placement restored (heapStart 1024, no
    // chunk carving) this assertion fails with `firstDiff === 1024` — the exact
    // old `HEAP_START`, deep inside the engine's shadow stack. Measured
    // 2026-08-19 by temporarily reverting those two lines in
    // `src/codegen-linear/runtime.ts`.
    expect(firstDiff, `our module wrote into the engine's region at ${firstDiff}`).toBe(-1);
  });

  it("literal data lands in an allocated block, not at its link-time offset", async () => {
    const linked = await buildLinked(`export function litLen(): number { const x = "hello, world"; return x.length; }`);
    const engine = await newEngine();
    const handed: { ptr: number; size: number }[] = [];
    const ours = await WebAssembly.instantiate(linked, {
      qjs: {
        memory: engine.memory,
        malloc: (n: number) => {
          const p = engine.malloc(n);
          handed.push({ ptr: p, size: n });
          return p;
        },
      },
    });
    // The start function already ran at instantiation and copied the image.
    expect(handed.length).toBeGreaterThan(0);
    expect(handed[0]!.ptr).toBeGreaterThan(ENGINE_STATIC_DATA_END);

    const litLen = (ours.instance.exports as { litLen: () => number }).litLen;
    expect(litLen()).toBe("hello, world".length);

    // The literal bytes are at the ALLOCATED address, and 64 (the link-time
    // base) still holds whatever the engine has there — we never wrote it.
    const mem = new Uint8Array(engine.memory.buffer);
    const imageBase = handed[0]!.ptr;
    expect(new TextDecoder().decode(mem.subarray(imageBase, imageBase + 12))).toBe("hello, world");
    expect(new TextDecoder().decode(mem.subarray(64, 76))).not.toBe("hello, world");
  });

  it("both workloads grow past their initial pages and neither corrupts the other", async () => {
    const src = `export function work(n: number): number {
      const a: number[] = [];
      for (let i = 0; i < n; i = i + 1) { a.push(i * 2); }
      return a.length;
    }`;
    const linked = await buildLinked(src);
    const engine = await newEngine();
    const ours = await WebAssembly.instantiate(linked, {
      qjs: { memory: engine.memory, malloc: (n: number) => engine.malloc(n) },
    });
    const work = (ours.instance.exports as { work: (n: number) => number }).work;

    const startPages = engine.memory.buffer.byteLength / 65536;
    expect(startPages).toBe(256); // 16 MiB — the artifact's initial size

    // Engine side: a live JS runtime plus a heap allocation, held across ours.
    const rt = engine.qjs_new_runtime();
    const ctx = engine.qjs_new_context(rt);
    const engineBlock = engine.malloc(1 << 20);
    new Uint8Array(engine.memory.buffer).fill(0x5a, engineBlock, engineBlock + (1 << 20));

    // Our side: enough array growth to run the memory past 16 MiB. Array
    // capacity doubles, so this allocates well over its final footprint.
    expect(work(1_500_000)).toBe(1_500_000);

    const endPages = engine.memory.buffer.byteLength / 65536;
    expect(endPages).toBeGreaterThan(startPages);

    // The engine's held block is untouched…
    const mem = new Uint8Array(engine.memory.buffer);
    let clobbered = 0;
    for (let a = engineBlock; a < engineBlock + (1 << 20); a++) if (mem[a] !== 0x5a) clobbered++;
    expect(clobbered).toBe(0);

    // …and the engine still works after all that growth.
    const js = "40 + 2";
    const p = engine.malloc(js.length + 1);
    new Uint8Array(engine.memory.buffer).set(new TextEncoder().encode(js), p);
    const h = engine.qjs_eval(ctx, p, js.length);
    expect(engine.qjs_to_f64(ctx, h)).toBe(42);

    // And our data survived the engine's growth: run the workload again on the
    // now-larger memory and get the same answer.
    expect(work(1000)).toBe(1000);
  });
});
