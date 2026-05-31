// (#1483) Date.now() / performance.now() / new Date() under --target wasi
// route to wasi_snapshot_preview1::clock_time_get instead of env::__date_now.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.ts";
import { buildWasiPolyfill } from "../src/runtime.ts";

describe("WASI clock_time_get (#1483)", () => {
  it("compiles Date.now() to clock_time_get under --target wasi", async () => {
    const result = await compile(`console.log(Date.now());`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("clock_time_get");
    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).not.toContain("__date_now");
  });

  it("compiles performance.now() to clock_time_get under --target wasi", async () => {
    const result = await compile(`console.log(performance.now());`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("clock_time_get");
    expect(result.wat).not.toContain("__date_now");
  });

  it("compiles new Date() to clock_time_get under --target wasi", async () => {
    const result = await compile(
      `
      const d = new Date();
      console.log(d.getTime());
    `,
      { fileName: "test.ts", target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("clock_time_get");
    expect(result.wat).not.toContain("__date_now");
  });

  it("Date.now() under WASI returns a positive ms timestamp via direct export", async () => {
    // Use a direct f64 export rather than `console.log`, because the existing
    // `__wasi_write_f64` helper truncates large numbers to i32 — fine for the
    // print path but not for asserting the underlying value.
    const result = await compile(
      `
      export function now(): number {
        return Date.now();
      }
    `,
      { fileName: "test.ts", target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("clock_time_get");
    expect(result.wat).not.toContain("__date_now");

    const wasi = buildWasiPolyfill();
    const mod = new WebAssembly.Module(result.binary);
    const instance = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);

    const before = Date.now();
    const value = (instance.exports.now as () => number)();
    const after = Date.now();
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(1_000_000_000_000); // > Sep 2001.
    expect(value).toBeGreaterThanOrEqual(before - 1000);
    expect(value).toBeLessThanOrEqual(after + 1000);
  });

  it("performance.now() under WASI returns a finite ms timestamp via direct export", async () => {
    const result = await compile(
      `
      export function tick(): number {
        return performance.now();
      }
    `,
      { fileName: "test.ts", target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("clock_time_get");
    expect(result.wat).not.toContain("__date_now");

    const wasi = buildWasiPolyfill();
    const mod = new WebAssembly.Module(result.binary);
    const instance = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);

    const value = (instance.exports.tick as () => number)();
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it("console.log(Date.now()) under WASI instantiates and runs", async () => {
    // Existing __wasi_write_f64 truncates to i32, so we only assert the module
    // links + runs end-to-end. The compile-time test above verifies WASI imports.
    const result = await compile(`console.log(Date.now());`, { fileName: "test.ts", target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("clock_time_get");
    expect(result.wat).not.toContain("__date_now");

    const wasi = buildWasiPolyfill();
    const mod = new WebAssembly.Module(result.binary);
    const instance = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const start = instance.exports._start as Function | undefined;
      if (start) start();
    } catch {
      // proc_exit may throw — ignore
    }
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("module without time API does not import clock_time_get", async () => {
    const result = await compile(`console.log("hi");`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("clock_time_get");
  });
});
