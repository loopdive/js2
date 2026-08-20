// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compile } from "../src/index.ts";

const wasmtime = process.env.WASMTIME ?? "wasmtime";
const hasWasmtime = spawnSync(wasmtime, ["--version"], { stdio: "ignore" }).status === 0;

async function runStandalone(source: string): Promise<{ value: number; wat: string; binary: Uint8Array }> {
  const result = await compile(source, { fileName: "issue-2997.ts", target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const output = process.env.JS2WASM_TRY_TABLE_WASM_OUTPUT;
  if (output) writeFileSync(output, result.binary);
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-wasm-exnref",
      "--input-type=module",
      "-e",
      "const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); " +
        "const {instance}=await WebAssembly.instantiate(Buffer.concat(chunks),{}); " +
        "process.stdout.write(String(instance.exports.run()));",
    ],
    { input: result.binary, encoding: "utf8" },
  );
  expect(child.status, child.stderr).toBe(0);
  return { value: Number(child.stdout), wat: result.wat ?? "", binary: result.binary };
}

describe("#2997 — standardized try_table exception handling", () => {
  test("catches the module exception tag without legacy try/catch opcodes", async () => {
    const result = await runStandalone(`
      export function run(): number {
        try {
          throw 42;
        } catch (error) {
          return error as number;
        }
      }
    `);

    expect(result.value).toBe(42);
    expect(result.wat).toContain("(try_table");
    expect(result.wat).not.toMatch(/\(try(?:\s|$)/);
  });

  test("runs finally on normal, caught, and rethrown completion", async () => {
    const result = await runStandalone(`
      export function run(): number {
        let total = 0;
        try {
          try {
            total += 1;
            throw 4;
          } catch (error) {
            total += error as number;
            throw error;
          } finally {
            total += 10;
          }
        } catch (error) {
          total += error as number;
        } finally {
          total += 100;
        }
        return total;
      }
    `);

    expect(result.value).toBe(119);
    expect(result.wat).not.toContain("rethrow");
  });

  test("retargets break and continue from both try and catch handlers", async () => {
    const result = await runStandalone(`
      export function run(): number {
        let total = 0;
        outer: for (let i = 0; i < 5; i += 1) {
          try {
            if (i === 1) continue outer;
            if (i === 3) break outer;
            total += i;
          } finally {
            total += 10;
          }
        }
        outer: for (let i = 0; i < 5; i += 1) {
          try {
            throw i;
          } catch (error) {
            if ((error as number) === 1) continue outer;
            if ((error as number) === 3) break outer;
            total += error as number;
          } finally {
            total += 10;
          }
        }
        return total;
      }
    `);

    expect(result.value).toBe(84);
  });

  test("preserves return values while nested finally blocks execute", async () => {
    const result = await runStandalone(`
      function inner(shouldReturn: boolean): number {
        let total = 1;
        try {
          try {
            if (shouldReturn) return 7;
            throw 3;
          } finally {
            total += 10;
          }
        } catch (error) {
          return total + (error as number);
        }
      }
      export function run(): number {
        return inner(true) * 100 + inner(false);
      }
    `);

    expect(result.value).toBe(714);
  });

  test.runIf(hasWasmtime)("executes a WASI try/catch module in Wasmtime", async () => {
    const result = await compile(
      `
        try {
          throw 40;
        } catch (error) {
          console.log((error as number) + 2);
        }
      `,
      { fileName: "issue-2997-wasi.ts", target: "wasi" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat).toContain("(try_table");
    expect(result.wat).not.toMatch(/\(try(?:\s|$)/);

    const workDir = mkdtempSync(join(tmpdir(), "js2wasm-2997-"));
    const wasmPath = join(workDir, "try-table.wasm");
    try {
      writeFileSync(wasmPath, result.binary);
      const run = spawnSync(wasmtime, ["run", "-W", "gc=y,function-references=y,tail-call=y,exceptions=y", wasmPath], {
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe("42");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
