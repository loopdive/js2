import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

declare const readStdin: () => string;

describe("WASI stdin via fd_read (#1481)", () => {
  it("registers fd_read import when readStdin() is used", () => {
    const result = compile(
      `
      declare function readStdin(): string;
      export function main(): void {
        const s = readStdin();
        console.log(s);
      }
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).toContain("fd_read");
    // helper function should be present
    expect(result.wat).toContain("__wasi_read_stdin_all");
    expect(result.binary.length).toBeGreaterThan(0);
  });

  it("does NOT register fd_read when readStdin() is not used", () => {
    const result = compile(`console.log("no stdin here");`, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("fd_read");
    expect(result.wat).not.toContain("__wasi_read_stdin_all");
  });

  it("does not add WASI imports in default mode even with readStdin reference", () => {
    // In non-wasi mode, `readStdin` is just an unknown identifier — and our
    // codegen path is gated by ctx.wasi. The compile may fail (undefined
    // function), but the important guarantee is no WASI imports leak in.
    const result = compile(
      `
      declare function readStdin(): string;
      export function main(): string { return readStdin(); }
      `,
    );
    // We don't care if it compiles; we only assert WASI imports are not added.
    if (result.success) {
      expect(result.wat).not.toContain("wasi_snapshot_preview1");
      expect(result.wat).not.toContain("fd_read");
    }
  });

  it("buildWasiPolyfill exposes fd_read and setStdin", () => {
    const wasi = buildWasiPolyfill();
    expect(typeof wasi.fd_read).toBe("function");
    expect(typeof wasi.setStdin).toBe("function");

    // fd_read with no memory set returns -1 (error)
    expect(wasi.fd_read(0, 0, 1, 8)).toBe(-1);

    // Stdin can be preloaded as string or bytes (no throw)
    wasi.setStdin("hello\n");
    wasi.setStdin(new Uint8Array([1, 2, 3]));
  });

  it("fd_read polyfill drains preloaded stdin into linear memory", () => {
    const wasi = buildWasiPolyfill();
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.setMemory(memory);
    wasi.setStdin("ab");

    const view = new DataView(memory.buffer);
    // iovec @ 0: buf=64, len=8 ; nread @ 16
    view.setUint32(0, 64, true);
    view.setUint32(4, 8, true);

    const errno = wasi.fd_read(0, 0, 1, 16);
    expect(errno).toBe(0);
    expect(view.getUint32(16, true)).toBe(2);
    expect(view.getUint8(64)).toBe(97); // 'a'
    expect(view.getUint8(65)).toBe(98); // 'b'

    // Subsequent read returns EOF (nread = 0)
    view.setUint32(0, 64, true);
    view.setUint32(4, 8, true);
    expect(wasi.fd_read(0, 0, 1, 16)).toBe(0);
    expect(view.getUint32(16, true)).toBe(0);
  });
});
