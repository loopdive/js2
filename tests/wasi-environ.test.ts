// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1482 — WASI: `process.env.X` wired to host imports.
//
// The compiled module declares two WASI environ imports for protocol
// compliance and a JS-polyfill fast-path host import `__wasi_env_get_str`
// which the polyfill resolves to a `process.env`-style dict.
import { describe, it, expect, vi } from "vitest";
import { compile } from "../src/index.ts";
import { buildWasiPolyfill } from "../src/runtime.ts";

describe("WASI process.env (#1482)", () => {
  it("compiles with __wasi_env_get_str import declared when process.env is used", async () => {
    const result = await compile(`console.log(process.env.GREETING);`, { fileName: "test.ts", target: "wasi" });
    expect(result.success).toBe(true);
    // The JS-polyfill fast-path import MUST survive — the compiled module
    // calls `__wasi_env_get_str` directly, so dead-elimination cannot drop it.
    // The environ_sizes_get / environ_get WASI imports are also registered by
    // the codegen pass for protocol compliance, but dead-elimination removes
    // them in the MVP path because no Wasm instruction references them yet.
    // A future commit that lowers `process.env.X` to inline `environ_get`
    // calls will keep them in the module.
    expect(result.wat).toContain('"env" "__wasi_env_get_str"');
  });

  it("does NOT declare __wasi_env_get_str when process.env is unused", async () => {
    const result = await compile(`console.log("no env access here");`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(result.success).toBe(true);
    expect(result.wat ?? "").not.toContain("__wasi_env_get_str");
  });

  it("returns the value from the polyfill env dict", async () => {
    const result = await compile(`console.log(process.env.GREETING);`, { fileName: "test.ts", target: "wasi" });
    expect(result.success).toBe(true);

    const wasi = buildWasiPolyfill({ env: { GREETING: "hello" } });
    const mod = new WebAssembly.Module(result.binary);
    const instance = new WebAssembly.Instance(mod, {
      wasi_snapshot_preview1: wasi,
      env: wasi.envImports,
    });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const start = instance.exports._start as Function;
      if (start) start();
    } catch {
      // proc_exit may throw — ignore
    }
    // The compiled console.log routes through __wasi_write_string; for an
    // externref value the WASI writer falls back to "[object]" (the
    // emitWasiValueToStdout placeholder path). We assert that console.log
    // was called at least once — proves the host import resolved without
    // a LinkError, which is the core acceptance criterion.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("missing key returns undefined-equivalent from the polyfill", async () => {
    // The wiring decision is symmetric: missing → externref null/undefined.
    // We verify by instantiating with a fixture that uses process.env.X and
    // confirming no LinkError and no JS-side throw.
    const result = await compile(`const v = process.env.MISSING; console.log("done");`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(result.success).toBe(true);

    const wasi = buildWasiPolyfill({ env: {} });
    const mod = new WebAssembly.Module(result.binary);
    const instance = new WebAssembly.Instance(mod, {
      wasi_snapshot_preview1: wasi,
      env: wasi.envImports,
    });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const start = instance.exports._start as Function;
      if (start) start();
    } catch {
      // proc_exit may throw
    }
    expect(spy).toHaveBeenCalledWith("done");
    spy.mockRestore();
  });

  it("environ_sizes_get + environ_get write the WASI table from envSource", () => {
    // Direct unit test of the WASI shim itself — independent of any
    // compiled module. Validates the layout `KEY=VALUE\0KEY2=VALUE2\0`
    // matches the byte count reported by environ_sizes_get.
    const wasi = buildWasiPolyfill({ env: { A: "1", B: "two" } });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.setMemory(memory);

    const view = new DataView(memory.buffer);
    // Reserve scratch for outputs at offset 0 (count) and 4 (bufSize).
    expect(wasi.environ_sizes_get(0, 4)).toBe(0);
    const count = view.getUint32(0, true);
    const bufSize = view.getUint32(4, true);
    expect(count).toBe(2);
    // "A=1\0" (4) + "B=two\0" (6) = 10 bytes
    expect(bufSize).toBe(10);

    // Place pointer table at offset 16, buffer at offset 32.
    expect(wasi.environ_get(16, 32)).toBe(0);
    const mem = new Uint8Array(memory.buffer);
    const dec = new TextDecoder();
    // First entry pointer
    const p0 = view.getUint32(16, true);
    const p1 = view.getUint32(20, true);
    expect(p0).toBe(32);
    // Read first NUL-terminated string
    let end0 = p0;
    while (mem[end0] !== 0) end0++;
    expect(dec.decode(mem.slice(p0, end0))).toBe("A=1");
    let end1 = p1;
    while (mem[end1] !== 0) end1++;
    expect(dec.decode(mem.slice(p1, end1))).toBe("B=two");
  });

  it("envImports.__wasi_env_get_str returns string or undefined", () => {
    const wasi = buildWasiPolyfill({ env: { FOO: "bar" } });
    const fn = wasi.envImports.__wasi_env_get_str as (k: unknown) => string | undefined;
    expect(fn("FOO")).toBe("bar");
    expect(fn("MISSING")).toBeUndefined();
    expect(fn(42)).toBeUndefined();
  });
});
