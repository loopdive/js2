// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7104 — plain-JS functions without a value-returning body, and dynamic-return
// functions whose paths fall through to `undefined`, are IR-emitted with
// legacy's ABI and legacy's values.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
function throwsOnly() { throw "boom"; }
function empty() { }
function bareReturn() { return; }
function guardReturn(a) { if (a) { return 1; } }
function fallsThrough(a) { if (a) { a = 1; } }
export function run(a) {
  var r = guardReturn(a);
  if (r === undefined) { return -1; }
  return r;
}
export function isUndefinedEmpty() { return empty() === undefined; }
export function isUndefinedBare() { return bareReturn() === undefined; }
export function isUndefinedFall() { return fallsThrough(1) === undefined; }
export function mayThrow(a) { if (a) { throwsOnly(); } return 7; }
export function inf() { return Infinity; }
export function nanIsNotSelf() { return NaN !== NaN; }
`;

async function build() {
  const result = await compile(SOURCE, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName: "issue-7104.mjs",
    target: "standalone",
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("#7104 dynamic undefined return on the IR path", () => {
  it("IR-emits the no-value-return and fall-through shapes without a parity withdrawal", async () => {
    const result = await build();
    const outcomes = result.irOutcomes ?? [];
    for (const name of ["throwsOnly", "empty", "bareReturn", "guardReturn", "fallsThrough", "inf", "nanIsNotSelf"]) {
      const outcome = outcomes.find((o) => o.displayName === name);
      expect(outcome, JSON.stringify(outcomes, null, 2)).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    }
    expect(outcomes.filter((o) => o.code === "abi-signature-parity")).toEqual([]);
  });

  it("returns legacy's values at runtime", async () => {
    const result = await build();
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const init = instance.exports.__module_init as (() => void) | undefined;
    if (typeof init === "function") init();
    const exports = instance.exports as Record<string, (...args: unknown[]) => unknown>;
    expect(exports.run!(1)).toBe(1);
    expect(exports.run!(0)).toBe(-1);
    expect(exports.isUndefinedEmpty!()).toBe(1);
    expect(exports.isUndefinedBare!()).toBe(1);
    expect(exports.isUndefinedFall!()).toBe(1);
    expect(exports.mayThrow!(0)).toBe(7);
    expect(() => exports.mayThrow!(1)).toThrow();
    expect(exports.inf!()).toBe(Infinity);
    expect(exports.nanIsNotSelf!()).toBe(1);
  });
});
