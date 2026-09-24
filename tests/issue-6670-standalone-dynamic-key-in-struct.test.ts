// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6670 — standalone `key in obj` with a runtime key and a closed-struct
// receiver. The field-name comparison arm needs a host string-equality helper
// that standalone does not have; it compiled the key, bailed, and left it on
// the stack for the generic arm, which folded `false`. Every present key read
// as absent, and inside `a || k in o` the stray value made the function
// invalid (styled-components' unitless-property helper `De`).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "main.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join(" | ")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.run as () => unknown)();
}

describe("#6670 — standalone dynamic-key `in` on a closed struct", () => {
  it("answers present and absent keys from the struct's fields", async () => {
    const source = `
const Te = { animationIterationCount: 1, strokeWidth: 1 };
function has(e) { return (e in Te) ? 1 : 0; }
export function run() {
  return has("strokeWidth") * 100 + has("animationIterationCount") * 10 + has("width");
}
`;
    expect(await runStandalone(source)).toBe(110);
  });

  it("stays valid inside a logical-or with a string-typed key", async () => {
    const source = `
const Te = { strokeWidth: 1 };
function De(e) { return e.startsWith("--") || e in Te; }
export function run() {
  return (De("strokeWidth") ? 100 : 0) + (De("--x") ? 10 : 0) + (De("width") ? 1 : 0);
}
`;
    expect(await runStandalone(source)).toBe(110);
  });
});
