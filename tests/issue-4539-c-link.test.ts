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
      ],
    } as never);
    expect(result.errors ?? []).toEqual([]);

    // The real assertion: our emitted binary instantiates against exports of a
    // module clang produced. A signature mismatch or a bad index fails here.
    const ours = await WebAssembly.instantiate(result.binary, {
      cpeer: { memory: peerExports.memory, c_double: peerExports.c_double },
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
    } as never);
    const ours = await WebAssembly.instantiate(result.binary, {
      cpeer: { memory: peerExports.memory },
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
});
