// #1493: console.error / console.warn route to fd=2 (stderr) in WASI mode,
// console.log stays on fd=1 (stdout). Compiled binaries must respect Unix
// shell conventions: `command > out.txt 2> err.txt` and `2>&1` redirection
// rely on the correct fd routing.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

describe("#1493 — WASI console.error/warn route to stderr (fd=2)", () => {
  it("emits __wasi_write_string_stderr helper when console.error is used", async () => {
    const result = await compile(`console.error("oops");`, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__wasi_write_string_stderr");
  });

  it("emits __wasi_write_string_stderr helper when console.warn is used", async () => {
    const result = await compile(`console.warn("careful");`, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__wasi_write_string_stderr");
  });

  it("does NOT emit stderr helper when only console.log is used (size optimisation)", async () => {
    const result = await compile(`console.log("normal");`, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("__wasi_write_string_stderr");
    // Stdout helper still present
    expect(result.wat).toContain("__wasi_write_string");
  });

  it("emits both stdout and stderr helpers when log + error are mixed", async () => {
    const source = `
      console.log("stdout-msg");
      console.error("stderr-msg");
    `;
    const result = await compile(source, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__wasi_write_string");
    expect(result.wat).toContain("__wasi_write_string_stderr");
  });

  it("routes runtime output to stdout vs stderr via buildWasiPolyfill", async () => {
    const source = `
      console.log("stdout-msg");
      console.error("stderr-msg");
      console.warn("stderr-warn");
      console.log("done");
    `;
    const result = await compile(source, { target: "wasi" });
    expect(result.success).toBe(true);

    // Spy on console.log and console.error to capture stdout/stderr separately.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (msg?: unknown) => {
      stdoutChunks.push(String(msg ?? ""));
    };
    console.error = (msg?: unknown) => {
      stderrChunks.push(String(msg ?? ""));
    };

    try {
      const wasi = buildWasiPolyfill();
      const module = await WebAssembly.compile(result.binary);
      const instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: wasi,
      });
      wasi.setMemory((instance.exports as Record<string, unknown>).memory as WebAssembly.Memory);
      const start = (instance.exports as Record<string, unknown>)._start as () => void;
      start();
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    // Stdout must contain "stdout-msg" and "done", but NOT the warn/error lines.
    expect(stdout).toContain("stdout-msg");
    expect(stdout).toContain("done");
    expect(stdout).not.toContain("stderr-msg");
    expect(stdout).not.toContain("stderr-warn");

    // Stderr must contain both warn and error lines.
    expect(stderr).toContain("stderr-msg");
    expect(stderr).toContain("stderr-warn");
    expect(stderr).not.toContain("stdout-msg");
  });

  it("routes f64 / number args through the stderr helper for console.error", async () => {
    const result = await compile(`console.error(42);`, { target: "wasi" });
    expect(result.success).toBe(true);
    // Number formatter for stderr lane
    expect(result.wat).toContain("__wasi_write_f64_stderr");
    expect(result.wat).toContain("__wasi_write_string_stderr");
  });
});
