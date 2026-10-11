// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6684 — a function's `prototype` read DYNAMICALLY under `--target standalone`
// in a module that also contains `Function(...)` (a runtime-eval consumer, as
// lodash-es is through `template`). Every top-level function binding becomes a
// #2931 live binding there, and the #2660 M3 function-value → prototype edge
// rejected every live binding, so `F.prototype` read through a value answered
// `undefined`. lodash-es: `hasOwnProperty.call(lodash.prototype, name)` threw
// "Object.prototype.hasOwnProperty called on null or undefined" at module init.

import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";

const OPTS = {
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
  runtimeEvalProvider: false,
} as const;

// 7 = an object, 6 = null, 5 = undefined.
const SINGLE = `
function Base() {}
function F(value) { return value; }
F.prototype = Base.prototype;
var K = [F][0];
var p = K.prototype;
export var r = p === undefined ? 5 : p === null ? 6 : 7;
export function tpl(s) { return Function("a", s); }
export function run() { return r; }
`;

const LIB = `
function baseLodash() {}
function lodash(value) { return value; }
lodash.prototype = baseLodash.prototype;
lodash.prototype.constructor = lodash;
export default lodash;
`;

const MAIN = `
import lodash from "./lib.js";
var hasOwnProperty = Object.prototype.hasOwnProperty;
var p = lodash.prototype;
var r = (p === undefined ? 5 : p === null ? 6 : 7) * 10 + (hasOwnProperty.call(lodash.prototype, "constructor") ? 1 : 0);
export function tpl(s) { return Function("a", s); }
export function run() { return r; }
`;

async function runBinary(binary: Uint8Array): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports.run as () => number)();
}

describe("#6684 — dynamic F.prototype under a runtime-eval consumer (standalone)", () => {
  it("single module: a function value's prototype is its prototype object", async () => {
    const result = await compile(SINGLE, { ...OPTS, fileName: "test.js" });
    expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
    expect(await runBinary(result.binary)).toBe(7);
  });

  it("imported function: prototype reads through the runtime-eval carrier", async () => {
    const result = await compileMulti({ "./lib.js": LIB, "./main.js": MAIN }, "./main.js", OPTS);
    expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
    expect(await runBinary(result.binary)).toBe(71);
  });
});
