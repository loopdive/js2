// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";

async function consoleOutput(source: string): Promise<unknown[][]> {
  const result = await compile(source);
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const output: unknown[][] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => output.push(args));
  try {
    // Exercise the default start-section path, before host exports are wired.
    await WebAssembly.instantiate(result.binary, result.importObject!);
    return output;
  } finally {
    log.mockRestore();
  }
}

describe("#5386: console preserves values from conditional object aliases", () => {
  it("prints x1 for the exact top-level reproduction", async () => {
    expect(
      await consoleOutput(`
      const a = { x: 1 };
      const b = true ? a : { x: "" };
      b.x = "x";
      console.log(a.x + 1);
    `),
    ).toEqual([["x1"]]);
  });

  it("preserves an intermediate module variable", async () => {
    expect(
      await consoleOutput(`
      const a = { x: 1 };
      const b = true ? a : { x: "" };
      b.x = "x";
      const result = a.x + 1;
      console.log(result);
    `),
    ).toEqual([["x1"]]);
  });

  it("keeps an unselected numeric object and ordinary console arguments intact", async () => {
    expect(
      await consoleOutput(`
      const a = { x: 1 };
      const b = false ? a : { x: "" };
      b.x = "x";
      console.log(a.x + 1);
      console.log(true);
      console.log("ok");
    `),
    ).toEqual([[2], [true], ["ok"]]);
  });

  it("prints x1 through the host-free standalone output sink", async () => {
    const result = await compile(
      `
      const a = { x: 1 };
      const b = true ? a : { x: "" };
      b.x = "x";
      console.log(a.x + 1);
    `,
      { target: "standalone", hostBridge: "always" },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const prepare = instance.exports.__stdout_prepare as () => number;
    const char = instance.exports.__stdout_char as (index: number) => number;
    expect(typeof prepare).toBe("function");
    expect(typeof char).toBe("function");
    const length = prepare();
    let output = "";
    for (let i = 0; i < length; i++) output += String.fromCharCode(char(i));
    expect(output).toBe("x1\n");
  });
});
