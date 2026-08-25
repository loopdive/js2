// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 Function.prototype.call/apply constructor-expression pins.
//
// The A8_T6/A7_T6 rows evaluate `.apply()` / `.call()` first and then use the
// returned function as the `new` target. The adjacent A8_T3..T5/A7_T3..T5 rows
// are receiver controls: they construct the reflective `.apply` / `.call`
// method itself and must keep throwing TypeError. Running the upstream files
// through the authoritative runner keeps these pins tied to their real harness
// and assertions instead of duplicating a weakened approximation here.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
import { runTest262File } from "./test262-runner.js";

const ROWS = [
  // Positive constructor-expression rows owned by this fix.
  "built-ins/Function/prototype/apply/S15.3.4.3_A8_T6.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A7_T6.js",
  // Neighboring receiver controls: constructing the reflective method itself
  // remains a TypeError and must not be captured by the dynamic-call arm.
  "built-ins/Function/prototype/apply/S15.3.4.3_A8_T3.js",
  "built-ins/Function/prototype/apply/S15.3.4.3_A8_T4.js",
  "built-ins/Function/prototype/apply/S15.3.4.3_A8_T5.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A7_T3.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A7_T4.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A7_T5.js",
] as const;

async function runStandaloneControl(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "es5-function-call-apply-null.ts",
    inferModuleStrictArguments: false,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "standalone control failed WebAssembly.validate").toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    {
      target: "standalone",
      providerLabel: "es5-function-call-apply-null-controls",
    },
  );
  return (instance.exports as { test(): number }).test();
}

describe("ES5 Function.call/apply constructor-expression semantics", () => {
  it.each(ROWS)("passes the exact Test262 row %s", async (relativePath) => {
    const result = await runTest262File(resolve("test262/test", relativePath), "es5-function-call-apply-null");
    expect(result.status, result.error ?? result.reason ?? "Test262 row did not pass").toBe("pass");
  });

  it("admits the provider callback returned by Function.apply as a native constructor", async () => {
    const result = await compile(
      `export function test(): number {
        var obj = new(Function("function f(){this.p1=1;};return f").apply());
        return obj.p1;
      }`,
      {
        allowJs: true,
        emitText: true,
        fileName: "es5-function-call-apply-null-regression.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
      },
    );
    expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
    expect(result.wat).toContain("(func $__native_construct_0");
  });

  it("normalizes null for sloppy call but preserves it for strict call", async () => {
    expect(
      await runStandaloneControl(`
        function sloppy(this: any) { return this === null ? 0 : 1; }
        function strict(this: any) { "use strict"; return this === null ? 1 : 0; }
        return sloppy.call(null) * 10 + strict.call(null);
      `),
    ).toBe(11);
  });

  it("normalizes undefined for sloppy apply but preserves it for strict apply", async () => {
    expect(
      await runStandaloneControl(`
        function sloppy(this: any) { return this === undefined ? 0 : 1; }
        function strict(this: any) { "use strict"; return this === undefined ? 1 : 0; }
        return sloppy.apply(undefined, []) * 10 + strict.apply(undefined, []);
      `),
    ).toBe(11);
  });
});
