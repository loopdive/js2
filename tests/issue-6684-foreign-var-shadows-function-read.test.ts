// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6684 — a function read as a VALUE must not resolve to ANOTHER module's
// same-named top-level variable. lodash-es: mixin.js declares
// `function mixin(...)` + `export default mixin`, lodash.default.js declares
// `var mixin = (function (func) { ... }(_mixin))`. The graph-wide `__mod_mixin`
// cell belonged to lodash.default.js, but mixin.js's `export default mixin`
// read it (still null) — `_mixin` was null and `mixin(lodash, lodash)` threw
// "Cannot access property on null or undefined" at module init.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

const MIXIN = `
function mixin(a, b) { return a + b; }
export function self() { return mixin; }
export default mixin;
`;

const WRAPPER = `
import _mixin from "./mixin.js";
var mixin = (function (func) {
  return function (a, b) { return func(a, b) * 10; };
}(_mixin));
export default mixin;
`;

// Module-init read (the lodash shape): the default export must be the function.
const MAIN_INIT = `
import w from "./wrapper.js";
export function run() { return w(1, 2); }
`;

// Deferred read after both modules initialised: must still be mixin.js's own
// function, not the wrapper held in the foreign cell.
const MAIN_DEFERRED = `
import w from "./wrapper.js";
import { self } from "./mixin.js";
export function run() { return self()(1, 2) * 1000 + w(1, 2); }
`;

async function runProgram(main: string, target: "standalone" | "gc"): Promise<number> {
  const result = await compileMulti({ "./mixin.js": MIXIN, "./wrapper.js": WRAPPER, "./main.js": main }, "./main.js", {
    target,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    target === "standalone" ? {} : (result.importObject as WebAssembly.Imports),
  );
  (result.importObject as { __setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.__setInstance?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

describe("#6684 — cross-module variable must not shadow a function read", () => {
  for (const target of ["standalone", "gc"] as const) {
    it(`${target}: default-exported function is not the foreign null cell at module init`, async () => {
      expect(await runProgram(MAIN_INIT, target)).toBe(30);
    });

    it(`${target}: a later function-value read keeps the module's own function`, async () => {
      expect(await runProgram(MAIN_DEFERRED, target)).toBe(3_030);
    });
  }
});
