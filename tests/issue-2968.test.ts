import { test, expect, describe } from "vitest";
import { compile } from "../src/index.ts";
import { spawnSync } from "node:child_process";

// #2968 — WASI `_start` uncaught-exception printer.
//
// When an uncaught exception reaches `_start` in a `--target wasi` binary, the
// `_start` wrapper renders it to stderr (fd 2) via the #2962 native
// `__error_to_string` / `__any_to_string` path and `proc_exit(1)`s, instead of
// the pre-fix silent exit 0. The compiler now emits standardized `try_table`
// EH for host-free targets. These assertions use node:wasi in an isolated
// child with exnref enabled; #2997 separately executes the output in Wasmtime.

/** Compile `src` for wasi, run `_start` under node:wasi, return {code, stderr}. */
async function runWasi(src: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success).toBe(true);

  const runner = `
    import { WASI } from "node:wasi";
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const wasi = new WASI({ version: "preview1", args: ["prog"], returnOnExit: true });
    const { instance } = await WebAssembly.instantiate(Buffer.concat(chunks), wasi.getImportObject());
    const code = wasi.start(instance);
    process.exitCode = typeof code === "number" ? code : 0;
  `;
  const child = spawnSync(process.execPath, ["--experimental-wasm-exnref", "--input-type=module", "-e", runner], {
    input: r.binary,
    encoding: "utf8",
  });
  return { code: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
}

describe("#2968 — WASI _start uncaught-exception printer", () => {
  test("bare top-level `throw new TypeError` renders to stderr and exits nonzero", async () => {
    const { code, stderr } = await runWasi(`throw new TypeError("x");`);
    expect(stderr).toContain("TypeError: x");
    expect(code).not.toBe(0);
  });

  test("uncaught Error / RangeError render their name + message", async () => {
    {
      const { code, stderr } = await runWasi(`throw new Error("boom");`);
      expect(stderr).toContain("Error: boom");
      expect(code).not.toBe(0);
    }
    {
      const { code, stderr } = await runWasi(`throw new RangeError("out");`);
      expect(stderr).toContain("RangeError: out");
      expect(code).not.toBe(0);
    }
  });

  test("side effects before the throw still run, then the exception surfaces", async () => {
    const { code, stdout, stderr } = await runWasi(`console.log("before"); throw new TypeError("late");`);
    expect(stdout).toContain("before");
    expect(stderr).toContain("TypeError: late");
    expect(code).not.toBe(0);
  });

  test("throw from a function reached via top-level call surfaces at _start", async () => {
    const { code, stderr } = await runWasi(`function main(): void { throw new Error("in main"); } main();`);
    expect(stderr).toContain("Error: in main");
    expect(code).not.toBe(0);
  });

  test("throw null exits nonzero without trapping (null payload has no render)", async () => {
    const { code } = await runWasi(`throw null;`);
    expect(code).not.toBe(0);
  });

  test("a throwing wasi module gains the exception-tag + proc_exit + fd_write it needs", async () => {
    const r = await compile(`throw new TypeError("x");`, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);
    expect(r.wat).toContain('(import "wasi_snapshot_preview1" "fd_write"');
    expect(r.wat).toContain('(import "wasi_snapshot_preview1" "proc_exit"');
    expect(r.wat).toContain('(export "_start"');
  });

  test("a NON-throwing wasi module is unaffected: no proc_exit import, still runs", async () => {
    const r = await compile(`console.log("hi");`, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);
    const mod = new WebAssembly.Module(r.binary);
    const importNames = WebAssembly.Module.imports(mod).map((i) => i.name);
    // The uncaught-exception printer is what pulls in proc_exit; a module with no
    // `throw` must not gain it (keeps non-throwing wasi output unchanged).
    expect(importNames).not.toContain("proc_exit");
    const { code, stdout } = await runWasi(`console.log("hi");`);
    expect(stdout).toContain("hi");
    expect(code).toBe(0);
  });
});
