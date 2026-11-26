// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7396 — in a JS function, `var g; g = 3; g()` narrows `g` to `number`, so the inline dynamic call compiled the
// callee to f64 and bailed; the call fell to the graceful fallback and answered `null`. §13.3.6.1 step 4: calling a
// non-callable throws TypeError. The callee is now boxed and reaches the dispatch's IsCallable check.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone", "wasi"] as const;

async function run(source: string, target: (typeof TARGETS)[number]): Promise<unknown> {
  const result = await compile(source, { target, fileName: "t.js", allowJs: true });
  expect(result.errors.filter((error) => error.severity === "error").map((error) => error.message)).toEqual([]);
  const imports =
    target === "gc"
      ? buildImports(result.imports, undefined, result.stringPool)
      : target === "wasi"
        ? { wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) }
        : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.main as () => unknown)();
}

const node = (source: string): unknown => new Function(`${source.replace(/export /g, "")}; return main();`)();

// 1 = TypeError thrown, 0 = no throw, 2 = some other throw; a callable answers its own value.
const THROWS = "try { g(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }";

describe("#7396 calling a function-local var that holds a non-callable", () => {
  it.each([
    [
      "a number, the issue's repro",
      `function f() { var g; g = 3; ${THROWS} } export function main() { return f(); }`,
      1,
    ],
    ["a number initialiser", `function f() { var g = 3; ${THROWS} } export function main() { return f(); }`, 1],
    ["a boolean", `function f() { var g; g = true; ${THROWS} } export function main() { return f(); }`, 1],
    [
      "with arguments",
      "function f() { var g; g = 3; try { g(1, 2); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } } export function main() { return f(); }",
      1,
    ],
    ["the module-scope form", `var g; g = 3; function f() { ${THROWS} } export function main() { return f(); }`, 1],
    [
      "a closure (still called)",
      "function f() { var g; g = function () { return 5; }; return g(); } export function main() { return f(); }",
      5,
    ],
  ])("%s", async (_, source, expected) => {
    expect(node(source)).toBe(expected);
    for (const target of TARGETS) expect(await run(source, target), target).toBe(expected);
  });
});
