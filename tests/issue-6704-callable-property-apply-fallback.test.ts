// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6704 — a field typed as the builtin `Function` (lodash's
// `createCompounder` products carry `@returns {Function}`) has no call
// signature, so `ns.kebabCase(x)` fell to the graceful tail and answered
// `undefined` without running (`--target standalone`). It now goes through the
// generic `__apply_closure` bridge with the receiver as `this`. The
// non-wrapper-value half is issue-6704-callable-property-non-wrapper-value.test.ts.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

async function runStandalone(lib: string, main: string): Promise<number> {
  const result = await compileMulti({ "./lib.js": lib, "./main.js": main }, "./main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

const COMPOUNDER = `
/**
 * @param {Function} callback The combiner.
 * @returns {Function} Returns the new compounder function.
 */
function createCompounder(callback) {
  return function(string) {
    return callback(this && this.prefix ? this.prefix : '', string + '');
  };
}
var kebabCase = createCompounder(function(result, word) {
  return result + word + '-k';
});
export default kebabCase;
`;

describe("#6704 — callable property values the funcref ladder cannot dispatch (standalone)", () => {
  it("a Function-typed field runs, with its receiver as this", async () => {
    const main = `
import kebabCase from "./lib.js";
const ns = { kebabCase };
const withPrefix = { prefix: "p:", kebabCase };
export function run() {
  try {
    return ns.kebabCase("ab").length * 10000 + withPrefix.kebabCase("ab").length * 100 + kebabCase("abc").length;
  } catch (e) { return -1; }
}`;
    // "ab-k" (4), "p:ab-k" (6), direct "abc-k" (5).
    expect(await runStandalone(COMPOUNDER, main)).toBe(40605);
  });
});
