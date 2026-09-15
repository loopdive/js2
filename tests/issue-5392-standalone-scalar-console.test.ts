// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function stdout(source: string, experimentalIR: boolean): Promise<string> {
  const result = await compile(source, {
    target: "standalone",
    hostBridge: "always",
    experimentalIR,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const prepare = instance.exports.__stdout_prepare as () => number;
  const char = instance.exports.__stdout_char as (index: number) => number;
  const length = prepare();
  return Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join("");
}

describe("#5392: standalone scalar console arguments", () => {
  it.each([false, true])("preserves numeric any and array controls (IR %s)", async (experimentalIR) => {
    expect(
      await stdout(
        `
      function add(x: number) { return x + 1; }
      const value: any = 2;
      console.log(add(value));
      const xs = [1, 2, 3];
      console.log(xs[1] + 1);
    `,
        experimentalIR,
      ),
    ).toBe("3\n3\n");
  });

  it("renders numbers and branded booleans through the legacy body", async () => {
    expect(
      await stdout(
        `
      console.log(3);
      console.log(-2.5);
      console.log(NaN);
      console.log(Infinity);
      console.log(-Infinity);
      console.log(-0);
      console.log(true);
      console.log(false);
      console.log(3 > 2);
      console.log(3 | 0);
      console.log("ok");
      console.log("value", 7, false);
    `,
        false,
      ),
    ).toBe("3\n-2.5\nNaN\nInfinity\n-Infinity\n-0\ntrue\nfalse\ntrue\n3\nok\nvalue 7 false\n");
  });
});
