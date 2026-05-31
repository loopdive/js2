import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

/**
 * Issue #1480 — Under `--target wasi`, console.error and console.warn must
 * route to fd=2 (stderr) instead of fd=1 (stdout). The WASI polyfill in
 * `src/runtime.ts` routes fd=1 → console.log and fd=2 → console.error; this
 * test confirms the codegen side emits the right fd for each console method.
 */
describe("issue #1480 — WASI console.error/warn → fd=2", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  async function runWasi(source: string): Promise<void> {
    const result = await compile(source, { target: "wasi" });
    expect(result.success).toBe(true);
    const wasi = buildWasiPolyfill();
    const { instance } = await WebAssembly.instantiate(result.binary, {
      wasi_snapshot_preview1: wasi as unknown as WebAssembly.ModuleImports,
    });
    wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
    (instance.exports._start as () => void)();
  }

  it("emits __wasi_write_string_fd helper and references fd=2 for console.error", async () => {
    const result = await compile(`console.error("boom");`, { target: "wasi" });
    expect(result.success).toBe(true);
    // The fd-parameterized helper must be present.
    expect(result.wat).toContain("__wasi_write_string_fd");
  });

  it("routes console.log to stdout (fd=1)", async () => {
    await runWasi(`console.log("stdout-line");`);
    expect(logSpy).toHaveBeenCalledWith("stdout-line");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("routes console.error to stderr (fd=2)", async () => {
    await runWasi(`console.error("stderr-line");`);
    expect(errSpy).toHaveBeenCalledWith("stderr-line");
    // console.error must NOT appear on stdout.
    expect(logSpy).not.toHaveBeenCalledWith("stderr-line");
  });

  it("routes console.warn to stderr (fd=2)", async () => {
    await runWasi(`console.warn("warn-line");`);
    expect(errSpy).toHaveBeenCalledWith("warn-line");
    expect(logSpy).not.toHaveBeenCalledWith("warn-line");
  });

  it("interleaves stdout and stderr correctly in a single module", async () => {
    await runWasi(`
      console.log("out-1");
      console.error("err-1");
      console.log("out-2");
      console.warn("err-2");
    `);
    expect(logSpy.mock.calls.flat()).toEqual(["out-1", "out-2"]);
    expect(errSpy.mock.calls.flat()).toEqual(["err-1", "err-2"]);
  });

  it("handles numeric arguments on stderr", async () => {
    await runWasi(`console.error(42);`);
    // Numeric → "42" via __wasi_write_f64 / __wasi_write_i32.
    const allErr = errSpy.mock.calls.flat().join("");
    expect(allErr).toContain("42");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
