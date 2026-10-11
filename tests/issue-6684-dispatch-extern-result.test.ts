// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6684 — a LIVE closure-dispatch arm must keep its externref result when the
// call site expects a typed reference (`--target standalone`). lodash-es's
// `toString` carries `@returns {string}`; imported through a runtime-eval
// carrier (the graph contains `Function(...)`), its runtime funcref returns
// externref, and the dispatch ladder's dead-arm placeholder dropped the value
// and answered null — `toString("abcd")` read back as `undefined` in the
// importer. The guarded downcast keeps a real string and still answers null
// for anything else.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

const LIB = `
var root = Function("return this")();
/**
 * @param {*} value
 * @returns {string}
 */
function baseToString(value) {
  if (typeof value == "string") {
    return value;
  }
  return "x";
}
export default baseToString;
`;

const MAIN = `
import baseToString from "./lib.js";
export function run() {
  var v = baseToString("abcd");
  return v === undefined ? -6 : v.length;
}
`;

describe("#6684 — dispatch keeps a live externref result for a typed call site", () => {
  it("standalone: an imported @returns {string} function answers its string", async () => {
    const result = await compileMulti({ "./lib.js": LIB, "./main.js": MAIN }, "./main.js", {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      runtimeEvalProvider: false,
    });
    expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as (() => void) | undefined)?.();
    expect((instance.exports.run as () => number)()).toBe(4);
  });
});
