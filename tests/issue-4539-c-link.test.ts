// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4539 — link the linear backend against a REAL C-compiled wasm module.
//
// tests/issue-4539.test.ts links against JS stubs, which proves the import
// section decodes and indices survive. It does NOT prove we can link against C
// output, which is the entire point of the topology (ADR-0020's engine
// artifact is a C library). This test closes that gap with a freestanding
// wasm32 module built by clang — no libc, no WASI sysroot — so it runs
// anywhere, unlike the full engine-artifact build.
//
// The bytes below are `tests/fixtures/linear-link/peer.c` compiled with the
// exact command in that directory's README. Source + command are committed;
// see the README to regenerate.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PEER_WASM_B64 =
  "AGFzbQEAAAABDwNgAABgAX8Bf2ACf38BfwMEAwABAgQFAXABAQEFAwEAAgY/Cn8BQYCIBAt/AEGACAt/AEGACAt/AEGACAt/AEGAiAQLfwBBgAgLfwBBgIgEC38AQYCACAt/AEEAC38AQQELB9EBDgZtZW1vcnkCABFfX3dhc21fY2FsbF9jdG9ycwAACGNfZG91YmxlAAEGY19wb2tlAAIZX19pbmRpcmVjdF9mdW5jdGlvbl90YWJsZQEADF9fZHNvX2hhbmRsZQMBCl9fZGF0YV9lbmQDAgtfX3N0YWNrX2xvdwMDDF9fc3RhY2tfaGlnaAMEDV9fZ2xvYmFsX2Jhc2UDBQtfX2hlYXBfYmFzZQMGCl9faGVhcF9lbmQDBw1fX21lbW9yeV9iYXNlAwgMX190YWJsZV9iYXNlAwkKGAMCAAsHACAAQQF0CwsAIAAgATYCACABCwBNBG5hbWUACglwZWVyLndhc20BJgMAEV9fd2FzbV9jYWxsX2N0b3JzAQhjX2RvdWJsZQIGY19wb2tlBxIBAA9fX3N0YWNrX3BvaW50ZXIAOAlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQEMVWJ1bnR1IGNsYW5nETE4LjEuMyAoMXVidW50dTEpACwPdGFyZ2V0X2ZlYXR1cmVzAisPbXV0YWJsZS1nbG9iYWxzKwhzaWduLWV4dA==";

const SRC = `export function add(a: number, b: number): number { return a + b; }`;

function peerBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(PEER_WASM_B64, "base64"));
}

/**
 * #4540 — a module that imports its memory must also say where its heap comes
 * from. The fixture peer is freestanding C with no allocator, so the tests
 * supply one from the host; the arena only needs a function with the right
 * signature, not one that came from the peer module.
 */
const MALLOC_SPEC = {
  module: "cpeer",
  name: "malloc",
  params: [{ kind: "i32" }],
  results: [{ kind: "i32" }],
} as const;
const LINKED_HEAP = { mallocImport: "malloc" } as const;

function hostMalloc(memory: WebAssembly.Memory): (n: number) => number {
  // Above the peer's `__heap_base` (0x8000 per its exported globals), so the
  // stand-in allocator does not itself land in the peer's data or stack.
  let cursor = 0x8000;
  return (n: number) => {
    const need = (n + 15) & ~15;
    while (cursor + need > memory.buffer.byteLength) memory.grow(1);
    const ptr = cursor;
    cursor += need;
    return ptr;
  };
}

describe("#4539 — linking against a real C-compiled module", () => {
  it("the fixture really is a C module that owns a memory and imports nothing", async () => {
    const mod = new WebAssembly.Module(peerBytes());
    // If this ever starts importing something, it stopped being a standalone
    // C peer and the test below would be proving something weaker.
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.some((e) => e.kind === "memory" && e.name === "memory")).toBe(true);
    expect(exports.some((e) => e.kind === "function" && e.name === "c_double")).toBe(true);
  });

  it("a linear module imports the C module's memory and functions, and runs", async () => {
    const peer = await WebAssembly.instantiate(peerBytes(), {});
    const peerExports = peer.instance.exports as {
      memory: WebAssembly.Memory;
      c_double: (x: number) => number;
      c_poke: (addr: number, value: number) => number;
    };

    const result = await compile(SRC, {
      target: "linear",
      linearImportMemory: { module: "cpeer", name: "memory", min: 2 },
      linearExternImports: [
        { module: "cpeer", name: "c_double", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
        MALLOC_SPEC,
      ],
      linearLinkedHeap: LINKED_HEAP,
    } as never);
    expect(result.errors ?? []).toEqual([]);

    // The real assertion: our emitted binary instantiates against exports of a
    // module clang produced. A signature mismatch or a bad index fails here.
    const ours = await WebAssembly.instantiate(result.binary, {
      cpeer: {
        memory: peerExports.memory,
        c_double: peerExports.c_double,
        malloc: hostMalloc(peerExports.memory),
      },
    });
    const add = (ours.instance.exports as { add?: (a: number, b: number) => number }).add;
    expect(add?.(2, 3)).toBe(5);
  });

  it("both modules address the same linear memory", async () => {
    const peer = await WebAssembly.instantiate(peerBytes(), {});
    const peerExports = peer.instance.exports as {
      memory: WebAssembly.Memory;
      c_poke: (addr: number, value: number) => number;
    };

    const result = await compile(SRC, {
      target: "linear",
      linearImportMemory: { module: "cpeer", name: "memory", min: 2 },
      linearExternImports: [MALLOC_SPEC],
      linearLinkedHeap: LINKED_HEAP,
    } as never);
    const ours = await WebAssembly.instantiate(result.binary, {
      cpeer: { memory: peerExports.memory, malloc: hostMalloc(peerExports.memory) },
    });

    // Write through the C module, observe through the memory object our module
    // was instantiated with — same object, therefore same bytes.
    //
    // The address is picked from the live buffer's end rather than hard-coded:
    // the peer owns this memory and its size is its business, and a hard-coded
    // offset either traps (too high) or lands in its data/stack (too low).
    // Needing to reason about that at all is exactly the hazard #4540 exists
    // to remove.
    const addr = peerExports.memory.buffer.byteLength - 8;
    peerExports.c_poke(addr, 0xabcd);
    const view = new DataView(peerExports.memory.buffer);
    expect(view.getInt32(addr, true)).toBe(0xabcd);
    expect((ours.instance.exports as { add?: unknown }).add).toBeTypeOf("function");
  });

  it("compiled TypeScript CALLS a C function and gets its result", async () => {
    const peer = await WebAssembly.instantiate(peerBytes(), {});
    const px = peer.instance.exports as {
      memory: WebAssembly.Memory;
      c_double: (x: number) => number;
    };

    // Nested calls on purpose: the result of one extern call feeds the next,
    // so the outbound and inbound boundary conversions must compose.
    const result = await compile(
      `declare function c_double(x: number): number;
export function quadruple(n: number): number { return c_double(c_double(n)); }`,
      {
        target: "linear",
        linearImportMemory: { module: "cpeer", name: "memory", min: 2 },
        linearExternImports: [
          { module: "cpeer", name: "c_double", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
          MALLOC_SPEC,
        ],
        linearLinkedHeap: LINKED_HEAP,
      } as never,
    );
    expect(result.errors ?? []).toEqual([]);

    const ours = await WebAssembly.instantiate(result.binary, {
      cpeer: { memory: px.memory, c_double: px.c_double, malloc: hostMalloc(px.memory) },
    });
    const quadruple = (ours.instance.exports as { quadruple?: (n: number) => number }).quadruple;
    expect(quadruple?.(5)).toBe(20);
    expect(quadruple?.(0)).toBe(0);
    expect(quadruple?.(-3)).toBe(-12);
  });

  it("a two-argument C call from compiled code writes into the shared memory", async () => {
    const peer = await WebAssembly.instantiate(peerBytes(), {});
    const px = peer.instance.exports as {
      memory: WebAssembly.Memory;
      c_poke: (addr: number, value: number) => number;
    };

    const result = await compile(
      `declare function c_poke(addr: number, value: number): number;
export function poke(addr: number, value: number): number { return c_poke(addr, value); }`,
      {
        target: "linear",
        linearImportMemory: { module: "cpeer", name: "memory", min: 2 },
        linearExternImports: [
          {
            module: "cpeer",
            name: "c_poke",
            params: [{ kind: "i32" }, { kind: "i32" }],
            results: [{ kind: "i32" }],
          },
          MALLOC_SPEC,
        ],
        linearLinkedHeap: LINKED_HEAP,
      } as never,
    );
    expect(result.errors ?? []).toEqual([]);

    const ours = await WebAssembly.instantiate(result.binary, {
      cpeer: { memory: px.memory, c_poke: px.c_poke, malloc: hostMalloc(px.memory) },
    });
    const poke = (ours.instance.exports as { poke?: (a: number, v: number) => number }).poke;

    // Compiled code -> C -> linear memory, observed from the host. Argument
    // order surviving is the point: a reversed marshal would write the value
    // as an address and trap or corrupt.
    const addr = px.memory.buffer.byteLength - 16;
    expect(poke?.(addr, 0x1234)).toBe(0x1234);
    expect(new DataView(px.memory.buffer).getInt32(addr, true)).toBe(0x1234);
  });

  it("an arity mismatch is a compile error that names the function", async () => {
    const result = await compile(
      `declare function c_double(x: number): number;
export function bad(n: number): number { return c_double(n, n); }`,
      {
        target: "linear",
        linearExternImports: [
          { module: "cpeer", name: "c_double", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
        ],
      } as never,
    );
    const messages = (result.errors ?? []).map((e) => e.message).join(" | ");
    expect(messages).toContain("c_double");
    expect(messages).toContain("fixed-arity");
  });

  it("an address KIND resolves to the target width and links (#4554)", async () => {
    const peer = await WebAssembly.instantiate(peerBytes(), {});
    const px = peer.instance.exports as {
      memory: WebAssembly.Memory;
      c_double: (x: number) => number;
    };

    // Declared by ROLE, not width. On wasm32 `handle` is i32, so this must
    // produce the byte-identical import a literal i32 would — the point being
    // that a memory64 target changes one model, not every call site.
    const result = await compile(
      `declare function c_double(x: number): number;
export function twice(n: number): number { return c_double(n); }`,
      {
        target: "linear",
        linearImportMemory: { module: "cpeer", name: "memory", min: 2 },
        linearExternImports: [
          {
            module: "cpeer",
            name: "c_double",
            params: [{ address: "handle" }],
            results: [{ address: "handle" }],
          },
          MALLOC_SPEC,
        ],
        linearLinkedHeap: LINKED_HEAP,
      } as never,
    );
    expect(result.errors ?? []).toEqual([]);

    const ours = await WebAssembly.instantiate(result.binary, {
      cpeer: { memory: px.memory, c_double: px.c_double, malloc: hostMalloc(px.memory) },
    });
    const twice = (ours.instance.exports as { twice?: (n: number) => number }).twice;
    expect(twice?.(21)).toBe(42);
  });

  it("an address kind emits the same bytes as the literal it resolves to", async () => {
    const opts = (params: unknown) =>
      ({
        target: "linear",
        linearExternImports: [{ module: "cpeer", name: "c_double", params, results: params }],
      }) as never;
    const viaLiteral = await compile(SRC, opts([{ kind: "i32" }]));
    const viaRole = await compile(SRC, opts([{ address: "handle" }]));
    expect(Buffer.from(viaRole.binary).equals(Buffer.from(viaLiteral.binary))).toBe(true);
  });

  it("refuses a memory64 index type instead of emitting 32-bit limits (#4554)", async () => {
    // Accepting `i64` and ignoring it would produce a module that instantiates
    // and then addresses the wrong memory — the failure this refusal exists to
    // prevent. Loud beats silently-wrong.
    //
    // It surfaces as a compile DIAGNOSTIC rather than a thrown exception, which
    // is the better shape: the caller gets `success: false` and a message
    // naming the limitation, in the same channel as every other codegen error.
    const result = await compile(SRC, {
      target: "linear",
      linearImportMemory: { module: "cpeer", name: "memory", min: 2, indexType: "i64" },
    } as never);
    expect(result.success).toBe(false);
    const messages = (result.errors ?? []).map((e) => e.message).join(" | ");
    expect(messages).toMatch(/memory64/i);
    expect(messages).toContain("#4554");
  });
});
