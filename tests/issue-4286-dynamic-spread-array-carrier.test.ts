// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4286 — A dynamic spread is an array element too. In published JavaScript,
// `[boolean, ...anyValue]` must use the universal element carrier; selecting an
// i32 vec from the leading boolean loses the spread values and makes a closure
// that promises `any[]` return an unrelated concrete vec type.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports;
}

describe("#4286 dynamic array-literal spread carrier", () => {
  it("preserves mixed values returned by a JavaScript map callback", async () => {
    const result = await compile(
      `
export function runCase() {
  const routes = [["/static", 40], ["/:id", 2]];
  const flagged = flagRoutes(routes);
  if (flagged.length !== 2) return -1;
  if (flagged[0][0] !== true || flagged[0][1] !== "/static") return -2;
  if (flagged[1][0] !== false || flagged[1][1] !== "/:id") return -3;
  return flagged[0][2] + flagged[1][2];
}

function flagRoutes(routes) {
  return routes.map((route) => [!/\\*|\\/:/.test(route[0]), ...route]);
}
`,
      {
        allowJs: true,
        fileName: "dynamic-spread-map.js",
        platform: "node",
        skipSemanticDiagnostics: true,
        target: "gc",
      },
    );
    const exports = await instantiate(result);

    expect((exports.runCase as () => number)()).toBe(42);
  });
});
