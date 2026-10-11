// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6669 — a module-level VARIABLE must not resolve to another module's
// same-named top-level function. styled-components declares
// `const oe = Object.getPrototypeOf` while stylis declares `function oe(...)`;
// the variable got no module cell (the registration treated the foreign
// function as its binding) and `oe(t)` compiled as a direct `call $oe` into
// stylis's string-typed body — "call param types must match" under wasm-opt.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

const LIB = `
export function oe(e, r, a, n) {
  return e.length + r.length + a.length + n.length;
}
export function useLib(x) {
  return oe(x, "b", "cc", "ddd");
}
`;

// `oe` here is a closure produced by a call — not a function declaration, not
// an alias of the library's `oe` — so every call must reach the closure.
const MAIN = `
import { useLib } from "./lib.js";
function makeDoubler() {
  return function (x) { return x * 2; };
}
const oe = makeDoubler();
export function run() {
  return oe(21) * 1000 + useLib("a");
}
`;

// The styled-components shape: the argument is an object, the foreign callee
// wants native strings, so the direct call is a validation error.
const MAIN_OBJECT_ARG = `
import { useLib } from "./lib.js";
function makeCounter() {
  return function (o) { return o && o.k ? 7 : 3; };
}
const oe = makeCounter();
export function run() {
  const t = { k: 1 };
  return oe(t) * 1000 + useLib("a");
}
`;

async function runProgram(main: string, target: "standalone" | "gc"): Promise<number> {
  const result = await compileMulti({ "./lib.js": LIB, "./main.js": main }, "./main.js", {
    target,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    target === "standalone" ? {} : (result.importObject as WebAssembly.Imports),
  );
  return (instance.exports.run as () => number)();
}

describe("#6669 — cross-module variable shadowing a foreign function name", () => {
  for (const target of ["standalone", "gc"] as const) {
    it(`${target}: calls the module's own closure, not the other module's function`, async () => {
      expect(await runProgram(MAIN, target)).toBe(42_007);
    });

    it(`${target}: an object argument does not reach the foreign string-typed body`, async () => {
      expect(await runProgram(MAIN_OBJECT_ARG, target)).toBe(7_007);
    });
  }
});
