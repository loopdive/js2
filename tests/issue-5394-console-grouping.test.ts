// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { formatWithOptions } from "node:util";
import { compile, type CompileOptions } from "../src/index.js";

type Write = { method: string; args: unknown[] };
const METHODS = ["log", "warn", "error", "info", "debug"] as const;

function reference(source: string): Write[] {
  const writes: Write[] = [];
  const console = Object.fromEntries(
    METHODS.map((method) => [
      method,
      (...args: unknown[]) => {
        writes.push({ method, args });
      },
    ]),
  );
  vm.runInNewContext(source, { console });
  return writes;
}

async function hostWrites(source: string, options: CompileOptions = {}): Promise<Write[]> {
  const result = await compile(source, { fileName: "console.js", deferTopLevelInit: true, ...options });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const writes: Write[] = [];
  const spies = METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args) => {
      writes.push({ method, args });
    }),
  );
  try {
    const imports = result.importObject!;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as any).__setInstance?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return writes;
}

describe("#5394: host console preserves argument grouping", () => {
  it.each([false, true, "optimized"] as const)("preserves zero, one, and several arguments (%s)", async (route) => {
    const source = `console.log(); console.log(3); console.log("value",3,false); console.warn("warning",2); console.error("error",false); console.info("info",4); console.debug("debug",5);`;
    const options = route === "optimized" ? { optimize: 2 as const } : { experimentalIR: route };
    expect(await hostWrites(source, options)).toEqual(reference(source));
  });

  it("keeps nested console calls separate and evaluates each argument once", async () => {
    const source = `
      let count=0;
      function mark(n) { count++; console.log("eval",n); return n; }
      console.log("outer",mark(1),console.log("inner",mark(2)),mark(3));
      console.log("count",count);
    `;
    expect(await hostWrites(source)).toEqual(reference(source));
  });

  it("does not invoke the outer console when argument evaluation throws", async () => {
    const source = `
      function mark(n) { console.log("eval",n); return n; }
      function boom() { console.log("throwing"); throw new Error("stop"); }
      try { console.log("outer",mark(1),boom(),mark(3)); }
      catch(error) { console.log("caught"); }
    `;
    expect(await hostWrites(source)).toEqual(reference(source));
  });

  it("passes printf substitutions to the real host console formatter", async () => {
    const source = `console.log("%d %s %%",3,"ok"); console.log("%s:%d",false,4);`;
    const actual = await hostWrites(source);
    const expected = reference(source);
    const output = (writes: Write[]) =>
      writes.map((write) => formatWithOptions({ colors: false }, ...write.args) + "\n").join("");
    expect(output(actual)).toBe(output(expected));
    expect(actual).toEqual(expected);
  });

  it("preserves nullish values and primitive brands in a grouped call", async () => {
    const source = `console.log("values",undefined,null,-0,NaN,1n);`;
    expect(await hostWrites(source)).toEqual(reference(source));
  });

  it("keeps standalone grouping host-free", async () => {
    const result = await compile('console.log("value",3,false);', { target: "standalone", hostBridge: "always" });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const length = (instance.exports.__stdout_prepare as () => number)();
    const char = instance.exports.__stdout_char as (index: number) => number;
    expect(Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join("")).toBe("value 3 false\n");
  });

  it("refuses unexpanded spread arguments instead of grouping the array itself", async () => {
    const result = await compile("const args=[1,2]; console.log(...args);");
    expect(result.success).toBe(false);
    expect(
      result.errors.some((error) => error.severity === "error" && error.message.includes("Console spread arguments")),
    ).toBe(true);
  });
});
