// #1532 — WASI syscall unit test suite.
//
// End-to-end coverage for the WASI runtime path: compile TypeScript with
// `--target wasi`, instantiate the resulting module against
// `buildWasiPolyfill()`, and exercise the WASI syscall surface the
// compiler currently emits (fd_write, fd_read, proc_exit) plus general
// codegen sanity (arithmetic, control flow) under WASI mode. test262
// doesn't drive WASI imports, so this file is the regression net for the
// WASI lane.
//
// Scope:
//   - fd_write fd=1 (console.log) and fd=2 (console.error / console.warn)
//   - fd_read fd=0 (readStdin) — polyfill-level; e2e roundtripping through
//     console.log currently boxes the string and is tracked separately.
//   - proc_exit (process.exit) — import-presence only; running
//     process.exit(N) trips an i32/f64 mismatch in the current codegen,
//     so e2e is covered once that's fixed.
//   - General codegen sanity in WASI mode (arithmetic, control flow, fns)
//   - Module-structure invariants (exports, import lane purity)
//
// Out of scope (compiler does not yet emit these WASI syscalls):
//   - environ_get / environ_sizes_get  (no process.env support)
//   - args_get    / args_sizes_get     (no process.argv support)
//   - clock_time_get                   (Date.now / performance.now use
//                                       JS host imports, not WASI clocks)
//   Add tests when those land.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

interface CapturedOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  threw: unknown;
}

/**
 * Compile `source` with `--target wasi`, instantiate against the polyfill,
 * and capture everything sent to stdout / stderr plus any proc_exit code.
 */
async function runWasi(source: string): Promise<CapturedOutput> {
  const result = compile(source, {
    fileName: "test.ts",
    target: "wasi",
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }

  const wasi = buildWasiPolyfill();
  const module = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi,
  });
  const exports = instance.exports as Record<string, unknown>;
  wasi.setMemory(exports.memory as WebAssembly.Memory);

  // Intercept console.log/error so the polyfill's fd_write routing is
  // observable as plain strings. Each push is one logical line — the
  // polyfill flushes newline-delimited chunks.
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

  // The polyfill's proc_exit calls process.exit(); replace with a thrower
  // so the vitest runner survives, and so we can read the code.
  const origProcessExit = process.exit;
  let exitCode: number | null = null;
  (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
    exitCode = code;
    throw new Error(`__test_proc_exit:${code}`);
  }) as unknown as typeof process.exit;

  let threw: unknown = undefined;
  try {
    const start = exports._start as undefined | (() => void);
    if (start) start();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__test_proc_exit:")) {
      threw = e;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origProcessExit;
  }

  return {
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
    exitCode,
    threw,
  };
}

describe("WASI: fd_write — stdout (fd=1)", () => {
  it("console.log routes a literal string to stdout", async () => {
    const { stdout, stderr } = await runWasi(`console.log("hello wasi");`);
    expect(stdout).toContain("hello wasi");
    expect(stderr).not.toContain("hello wasi");
  });

  it("console.log emits multiple lines in order", async () => {
    const { stdout } = await runWasi(`
      console.log("first");
      console.log("second");
      console.log("third");
    `);
    const firstIdx = stdout.indexOf("first");
    const secondIdx = stdout.indexOf("second");
    const thirdIdx = stdout.indexOf("third");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  it("console.log on a number formats via __wasi_write_f64", async () => {
    const { stdout } = await runWasi(`console.log(42);`);
    expect(stdout).toContain("42");
  });

  it("console.log with multiple args inserts spaces", async () => {
    const { stdout } = await runWasi(`console.log("a", "b", "c");`);
    expect(stdout).toContain("a b c");
  });

  it("console.log on a negative number formats with sign", async () => {
    const { stdout } = await runWasi(`console.log(-17);`);
    expect(stdout).toContain("-17");
  });
});

describe("WASI: fd_write — stderr (fd=2)", () => {
  it("console.error routes to stderr, not stdout", async () => {
    const { stdout, stderr } = await runWasi(`console.error("err msg");`);
    expect(stderr).toContain("err msg");
    expect(stdout).not.toContain("err msg");
  });

  it("console.warn routes to stderr (Node convention)", async () => {
    const { stdout, stderr } = await runWasi(`console.warn("warn msg");`);
    expect(stderr).toContain("warn msg");
    expect(stdout).not.toContain("warn msg");
  });

  it("mixed log/error keeps streams separated", async () => {
    const { stdout, stderr } = await runWasi(`
      console.log("out-1");
      console.error("err-1");
      console.log("out-2");
      console.error("err-2");
    `);
    expect(stdout).toContain("out-1");
    expect(stdout).toContain("out-2");
    expect(stdout).not.toContain("err-1");
    expect(stdout).not.toContain("err-2");
    expect(stderr).toContain("err-1");
    expect(stderr).toContain("err-2");
    expect(stderr).not.toContain("out-1");
    expect(stderr).not.toContain("out-2");
  });
});

describe("WASI: proc_exit (compile-time / ABI level)", () => {
  // process.exit() runtime is gated on a codegen fix: in WASI mode the
  // argument is requested as i32 then trunc_sat'd again, which fails wasm
  // validation (`i32.trunc_sat_f64_s expected type f64, found i32`).
  // Once that's fixed we can switch these to e2e exit-code assertions.

  it("emits proc_exit import when process.exit is referenced", async () => {
    const result = compile(
      `
        declare const process: { exit(code: number): void };
        process.exit(42);
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("proc_exit");
    expect(result.wat).toContain("wasi_snapshot_preview1");
  });

  it("does NOT emit proc_exit import when process.exit is unused", async () => {
    const result = compile(`console.log("noop");`, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("proc_exit");
  });

  it("polyfill proc_exit forwards the integer code to process.exit", () => {
    // Direct polyfill check — independent of the codegen quirk above.
    const wasi = buildWasiPolyfill();
    let seen: number | null = null;
    const orig = process.exit;
    (process as unknown as { exit: (c: number) => never }).exit = ((c: number) => {
      seen = c;
      throw new Error(`__exit:${c}`);
    }) as unknown as typeof process.exit;
    try {
      try {
        wasi.proc_exit(7);
      } catch {
        // expected via our stub
      }
    } finally {
      process.exit = orig;
    }
    expect(seen).toBe(7);
  });
});

describe("WASI: fd_read — stdin polyfill", () => {
  // E2E readStdin() → console.log roundtrip currently surfaces a boxed
  // string ("[object]") because the WASI string return path through
  // console.log goes via the externref boxing helper; tracked separately.
  // We validate the polyfill itself + the import registration here.

  it("emits fd_read import only when readStdin() is used", () => {
    const used = compile(
      `
        declare function readStdin(): string;
        const s = readStdin();
        console.log("ignored");
      `,
      { target: "wasi" },
    );
    expect(used.success).toBe(true);
    expect(used.wat).toContain("fd_read");

    const unused = compile(`console.log("nope");`, { target: "wasi" });
    expect(unused.success).toBe(true);
    expect(unused.wat).not.toContain("fd_read");
  });

  it("polyfill setStdin / fd_read drains preloaded bytes into memory", () => {
    const wasi = buildWasiPolyfill();
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.setMemory(memory);
    wasi.setStdin("hello");

    // iovec at addr 0 → buf=64, len=8 ; nread at addr 16
    const view = new DataView(memory.buffer);
    view.setUint32(0, 64, true);
    view.setUint32(4, 8, true);

    const errno = wasi.fd_read(0, 0, 1, 16);
    expect(errno).toBe(0);
    expect(view.getUint32(16, true)).toBe(5); // "hello"
    expect(view.getUint8(64)).toBe(0x68); // 'h'
    expect(view.getUint8(68)).toBe(0x6f); // 'o'
  });

  it("polyfill fd_read returns EOF (nread=0) after stdin is drained", () => {
    const wasi = buildWasiPolyfill();
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.setMemory(memory);
    wasi.setStdin("ab");

    const view = new DataView(memory.buffer);
    view.setUint32(0, 64, true);
    view.setUint32(4, 8, true);
    wasi.fd_read(0, 0, 1, 16); // drains

    view.setUint32(0, 64, true);
    view.setUint32(4, 8, true);
    expect(wasi.fd_read(0, 0, 1, 16)).toBe(0);
    expect(view.getUint32(16, true)).toBe(0); // EOF
  });
});

describe("WASI: codegen sanity (WASI mode must not break compilation)", () => {
  it("integer arithmetic via console.log(number expression)", async () => {
    const { stdout } = await runWasi(`console.log(2 + 3 * 4);`);
    expect(stdout).toContain("14");
  });

  it("control flow: if/else picks the right branch", async () => {
    const source = `
      const n = 7;
      if (n > 5) {
        console.log("big");
      } else {
        console.log("small");
      }
    `;
    const { stdout } = await runWasi(source);
    expect(stdout).toContain("big");
    expect(stdout).not.toContain("small");
  });

  it("for-loop accumulates as expected", async () => {
    const source = `
      let sum = 0;
      for (let i = 1; i <= 10; i++) sum += i;
      console.log(sum);
    `;
    const { stdout } = await runWasi(source);
    expect(stdout).toContain("55");
  });

  it("user-defined function returns through console.log", async () => {
    const source = `
      function add(a: number, b: number): number { return a + b; }
      console.log(add(40, 2));
    `;
    const { stdout } = await runWasi(source);
    expect(stdout).toContain("42");
  });

  it("nested function calls and recursion (factorial of 5)", async () => {
    const source = `
      function fact(n: number): number {
        if (n <= 1) return 1;
        return n * fact(n - 1);
      }
      console.log(fact(5));
    `;
    const { stdout } = await runWasi(source);
    expect(stdout).toContain("120");
  });

  it("while-loop with break works in WASI mode", async () => {
    const source = `
      let i = 0;
      while (true) {
        i++;
        if (i >= 3) break;
      }
      console.log(i);
    `;
    const { stdout } = await runWasi(source);
    expect(stdout).toContain("3");
  });
});

describe("WASI: module structure invariants", () => {
  it("WASI binary exports memory and _start", async () => {
    const result = compile(`console.log("x");`, { target: "wasi" });
    expect(result.success).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    const exportNames = WebAssembly.Module.exports(module).map((e) => e.name);
    expect(exportNames).toContain("memory");
    expect(exportNames).toContain("_start");
  });

  it("only wasi_snapshot_preview1 imports are emitted in WASI mode", async () => {
    const result = compile(
      `
        console.log("out");
        console.error("err");
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    const imports = WebAssembly.Module.imports(module);
    // Every host import in WASI mode must come from wasi_snapshot_preview1.
    // Any js-host leakage would be a regression — WASI binaries must be
    // self-contained against the WASI ABI.
    for (const imp of imports) {
      expect(imp.module).toBe("wasi_snapshot_preview1");
    }
    const importNames = imports.map((i) => i.name).sort();
    expect(importNames).toContain("fd_write");
  });

  it("WASI mode emits no wasm:js-string or env imports", async () => {
    const result = compile(
      `
        console.log("hello");
        console.error("err");
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    const importModules = new Set(WebAssembly.Module.imports(module).map((i) => i.module));
    expect(importModules.has("wasm:js-string")).toBe(false);
    expect(importModules.has("env")).toBe(false);
    expect(importModules.has("string_constants")).toBe(false);
  });

  it("WASI binary is a valid module (compiles via WebAssembly.compile)", async () => {
    const result = compile(
      `
        function add(a: number, b: number): number { return a + b; }
        console.log(add(2, 3));
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(module).toBeInstanceOf(WebAssembly.Module);
  });
});
