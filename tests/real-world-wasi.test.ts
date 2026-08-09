import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Real-world WASI command-line programs (`--target wasi`).
 *
 * test262 targets a JS engine; it never covers compiling to a standalone WASI
 * module that talks to the host via `wasi_snapshot_preview1` (fd_write,
 * proc_exit, args, …). These pin down that ordinary "CLI tool" source lowers
 * to the WASI ABI and produces a valid, instantiable module.
 */
describe("real-world: WASI command-line programs", () => {
  it("lowers console.log to fd_write and produces a valid module", async () => {
    const result = await compile(
      `
        export function main(): void {
          let sum = 0;
          for (let i = 1; i <= 10; i++) sum += i;
          console.log("sum:", sum);
        }
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("wasi_snapshot_preview1");
    expect(result.wat).toContain("fd_write");
    expect(result.wat).not.toContain("console_log");
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("exports memory and _start for the WASI runtime", async () => {
    const result = await compile(`console.log("hello, wasi");`, { target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.wat).toContain('(export "memory"');
    expect(result.wat).toContain('(export "_start"');
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  // (#3340) Formerly an `it.fails` documenting a native-string codegen defect
  // that made a `process.argv.length` WASI program emit an INVALID binary
  // (instantiation failed in `__str_flatten`). That codegen defect is FIXED on
  // current main — the binary now compiles AND validates — so the `it.fails`
  // was a stale inverted sentinel: the improvement made the test "unexpectedly
  // pass", which the root issue-tests baseline absorbed as accepted rot. This is
  // now a positive validity guard. NOTE: only the binary VALIDITY is asserted
  // here; the actual `process.argv` RUNTIME semantics (reading real command-line
  // args) is still missing and is tracked separately under #3337 — do NOT assert
  // runtime argv behavior here.
  it("compiles process.argv under --target wasi to a valid module (validity only; runtime argv → #3337)", async () => {
    const result = await compile(
      `
        declare const process: { argv: string[] };
        export function argc(): number {
          return process.argv.length;
        }
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("lowers process.exit to proc_exit", async () => {
    const result = await compile(
      `
        declare const process: { exit(code: number): void };
        console.log("bye");
        process.exit(0);
      `,
      { target: "wasi" },
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("proc_exit");
  });

  // #1801 (was #2177): process.exit(N) under --target wasi used to emit an
  // invalid module — the exit-code argument was compiled as an i32 but then an
  // `i32.trunc_sat_f64_s` (which expects f64) was pushed on top of it, so the
  // module failed `WebAssembly.validate()`. The redundant truncation was
  // dropped (src/codegen/expressions/calls.ts). This regression guard asserts
  // binary validity for several exit codes and a non-literal argument — a
  // WAT-only check (as in wasi-target.test.ts) can't mask a regression here.
  it("process.exit(code) emits a valid binary that imports proc_exit", async () => {
    for (const code of [0, 1, 42]) {
      const result = await compile(`declare const process: { exit(code: number): void }; process.exit(${code});`, {
        target: "wasi",
      });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary), `process.exit(${code}) invalid binary`).toBe(true);
      const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
      expect(imports.some((i) => i.module === "wasi_snapshot_preview1" && i.name === "proc_exit")).toBe(true);
    }
  });

  it("process.exit with a non-literal numeric argument emits a valid binary", async () => {
    const result = await compile(
      `declare const process: { exit(code: number): void }; const c: number = 7; process.exit(c);`,
      { target: "wasi" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("does not emit WASI imports under the default gc target", async () => {
    const result = await compile(`console.log("hello");`);
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("wasi_snapshot_preview1");
    expect(result.wat).not.toContain("fd_write");
  });
});
