import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { runTest262File } from "./test262-runner.ts";

async function runGc(source: string): Promise<unknown> {
  // The Test262 harness shape exercises the legacy receiver-method lowering
  // fixed by #3763. Pin it here so small probe functions are not claimed by
  // the separate experimental-IR string-call path.
  const result = await compile(source, { experimentalIR: false, skipSemanticDiagnostics: true } as never);
  if (!result.success) throw new Error(result.errors?.[0]?.message ?? "compile failed");
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#3763 String.prototype.indexOf undefined search coercion", () => {
  it("passes an uninitialised hoisted var as actual undefined", async () => {
    expect(
      await runGc(`
        export function test(): number {
          return "undefined".indexOf(search);
          var search;
        }
      `),
    ).toBe(0);
  });

  it("does not fold an uninitialised var after a preceding write", async () => {
    expect(
      await runGc(`
        export function test(): number {
          search = null;
          return "null".indexOf(search);
          var search;
        }
      `),
    ).toBe(0);
  });

  it("passes the exact ES5 hoisted-var Test262 case", async () => {
    const result = await runTest262File(
      resolve("test262/test/built-ins/String/prototype/indexOf/S15.5.4.7_A1_T6.js"),
      "issue-3763",
      45_000,
    );
    expect(result.status, result.error).toBe("pass");
  });
});
