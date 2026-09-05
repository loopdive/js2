// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 §13.2.2_A18: a sloppy arguments object's non-enumerable `callee` own
// property must participate in `with` HasBinding before the outer environment.
// Keep the upstream pair here verbatim through the authoritative Test262
// runner, then pin the declaration/expression identity controls that establish
// the property is still the actual function object.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const ES5_FUNCTION_CALLEE_WITH_FILES = [
  "language/statements/function/S13.2.2_A18_T1.js",
  "language/statements/function/S13.2.2_A18_T2.js",
] as const;

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "es5-function-callee-with.ts",
    target: "standalone",
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("ES5 §13.2.2_A18 arguments.callee in with", () => {
  it.each(ES5_FUNCTION_CALLEE_WITH_FILES)("passes the exact Test262 row %s", async (file) => {
    const result = await runTest262File(
      join("test262/test", file),
      "language/statements/function",
      30_000,
      "standalone",
    );
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it("keeps arguments.callee identity for a function declaration", async () => {
    expect(
      await runStandalone(`
        function declared(): any { return arguments.callee === declared ? arguments : null; }
        export function test(): number {
          var args: any = declared();
          return args !== null && args.callee === declared ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps arguments.callee identity for a function expression", async () => {
    expect(
      await runStandalone(`
        var expression: any = function (): any { return arguments.callee; };
        export function test(): number { return expression() === expression ? 1 : 0; }
      `),
    ).toBe(1);
  });
});
