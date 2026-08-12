// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #4385 — `%Function.prototype%` is itself callable in ES5. */

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRun(source: string, experimentalIR: boolean): Promise<{ value: unknown; ir: string[] }> {
  const result = await compile(source, {
    target: "standalone",
    experimentalIR,
    trackIrOutcomes: true,
    fileName: "issue-4385.ts",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports ?? [], "standalone call must remain host-free").toEqual([]);
  expect(WebAssembly.validate(result.binary!), "compiler must emit valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  const value = (instance.exports as { main: () => unknown }).main();
  return { value, ir: result.irCompiledFuncs ?? [] };
}

describe("#4385 Function.prototype callable intrinsic", () => {
  it("returns undefined after evaluating and ignoring its arguments on the legacy path", async () => {
    const { value } = await compileAndRun(
      `
        export function main() {
          var side = 0;
          var result = Function.prototype(side++, null, void 0);
          return (result === undefined ? 10 : 0) + side;
        }
      `,
      false,
    );
    expect(value).toBe(11);
  });

  it("is selected and emitted through the IR path", async () => {
    const { value, ir } = await compileAndRun(
      `
        export function main(): number {
          Function.prototype(null, void 0);
          return 1;
        }
      `,
      true,
    );
    expect(ir).toContain("main");
    expect(value).toBe(1);
  });

  it("does not intercept a shadowing local named Function", async () => {
    const { value } = await compileAndRun(
      `
        export function main() {
          var Function = { prototype: function () { return 7; } };
          return Function.prototype();
        }
      `,
      false,
    );
    expect(value).toBe(7);
  });
});
