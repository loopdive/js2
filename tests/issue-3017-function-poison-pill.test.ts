// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3017 gap 1 — ES5 Function `caller` / `arguments` poison semantics.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

async function run(source: string, target?: "standalone"): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-3017.ts",
    inferModuleStrictArguments: false,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

  if (target === "standalone") {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test(): number }).test();
  }

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports?.(instance.exports);
  return (instance.exports as { test(): number }).test();
}

const STRICT_FUNCTION_POISON = `
  export function test(): number {
    var caught = 0;
    var effects = 0;
    function strictFn(): void { "use strict"; }
    function rhs(): number { effects += 1; return effects; }

    try { (strictFn as any).caller; } catch (error) { caught += 1; }
    try { (strictFn as any)["arguments"]; } catch (error) { caught += 1; }
    try { (strictFn as any).caller = rhs(); } catch (error) { caught += 1; }
    try { (strictFn as any)["arguments"] = rhs(); } catch (error) { caught += 1; }

    return caught * 10 + effects;
  }
`;

const IMMEDIATE_CALLER_STRICTNESS = `
  export function test(): number {
    function touch(): number { return 0; }
    function probe(): number {
      touch();
      try {
        (probe as any).caller;
        return 0;
      } catch (error) {
        return 1;
      }
    }
    function strictCaller(): number { "use strict"; return probe(); }
    function sloppyMiddle(): number { return probe(); }
    function strictOuter(): number { "use strict"; return sloppyMiddle(); }

    return strictCaller() * 10 + strictOuter();
  }
`;

describe("#3017 — Function poison-pill semantics", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";

    it(`${lane}: strict caller/arguments reads and writes throw after RHS effects`, async () => {
      expect(await run(STRICT_FUNCTION_POISON, target)).toBe(42);
    });

    it(`${lane}: only the immediate strict caller poisons a sloppy self-read`, async () => {
      expect(await run(IMMEDIATE_CALLER_STRICTNESS, target)).toBe(10);
    });
  }

  it("passes the canonical strict-immediate-caller row in both lanes", async () => {
    const file = resolve("test262/test/built-ins/Function/15.3.5.4_2-1gs.js");
    expect((await runTest262File(file, "built-ins")).status).toBe("pass");
    expect((await runTest262File(file, "built-ins", 30_000, "standalone")).status).toBe("pass");
  });

  it("keeps the strict-grandparent/non-strict-immediate-caller control green", async () => {
    const file = resolve("test262/test/built-ins/Function/15.3.5.4_2-75gs.js");
    expect((await runTest262File(file, "built-ins")).status).toBe("pass");
    expect((await runTest262File(file, "built-ins", 30_000, "standalone")).status).toBe("pass");
  });
});
