// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4373 — overflow arguments must survive both a JavaScript callable-property
// dispatch and the JS-host dynamic method bridge. React.createElement declares
// three formals but consumes every trailing child through `arguments`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

async function run(
  source: string,
  options: { fileName: string; experimentalIR: boolean },
): Promise<Record<string, any>> {
  const result = await compile(source, {
    ...options,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

describe("#4373 — JavaScript property-call arguments", () => {
  for (const experimentalIR of [false, true]) {
    it(`preserves checker-synthetic overflow arguments (IR=${experimentalIR})`, async () => {
      const exports = await run(
        `
          var api = {};
          api.capture = function (first, second, third) {
            return arguments.length * 100 + arguments[4] * 10 + arguments[6];
          };
          export function probe() {
            return api.capture(1, 2, 3, 4, 5, 6, 7);
          }
        `,
        { fileName: "issue-4373.js", experimentalIR },
      );

      expect(exports.probe()).toBe(757);
    });

    it(`sizes the JS-host method dispatcher from the call site (IR=${experimentalIR})`, async () => {
      const exports = await run(
        `
          const api: any = {};
          api.capture = function (first: any, second: any, third: any): number {
            return arguments.length * 100 + arguments[4] * 10 + arguments[6];
          };
          function invoke(receiver: any): number {
            return receiver.capture(1, 2, 3, 4, 5, 6, 7);
          }
          export function probe(): number { return invoke(api); }
        `,
        { fileName: "issue-4373.ts", experimentalIR },
      );

      expect(exports.probe()).toBe(757);
    });
  }
});
