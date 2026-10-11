// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V12 — a `.js` collection's key/value type is never inferred from
// its constructor arguments (test262 `built-ins/Map/prototype/set/append-new-values`).
//
// TypeScript infers `Map<string | number | symbol, number>` from
// `new Map([[4, 4], ['foo3', 3], [s, 2]])`. JavaScript does not honour that:
// after `map.set(1, 'valid')` every consumer that trusted the inferred value
// type (a `var` slot, a `forEach` callback parameter) read the string back as
// `NaN`. In a `.js` entry the checker now sees no-inference overloads for the
// keyed-collection constructors, so the value lane stays dynamic. `.ts`
// sources are untouched (checked by the TS control below).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fileName: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as { __module_init?: () => void; main: () => number };
  exports.__module_init?.();
  return exports.main();
}

describe("#6651 V12 — inferred collection types in JavaScript (standalone)", () => {
  it("Map: a value of another JS type survives var, forEach and size reads", async () => {
    const bits = await run(
      `var bits = 0;
       function check(c, b) { if (c) bits = bits | b; }
       var s = Symbol(2);
       var map = new Map([[4, 4], ['foo3', 3], [s, 2]]);
       map.set(null, 42);
       map.set(1, 'valid');
       check(map.size === 5, 1);
       var got = map.get(1);
       check(got === 'valid', 2);
       var results = [];
       map.forEach(function (value, key) { results.push({ value: value, key: key }); });
       var last = results.pop();
       check(last.value === 'valid', 4);
       check(last.key === 1, 8);
       last = results.pop();
       check(last.value === 42, 16);
       check(last.key === null, 32);
       export function main() { return bits; }`,
      "v12-map.js",
    );
    expect(bits).toBe(63);
  });

  it("Set and WeakMap: members of another JS type read back intact", async () => {
    const bits = await run(
      `var bits = 0;
       function check(c, b) { if (c) bits = bits | b; }
       var set = new Set([1, 2]);
       set.add('x');
       var seen = [];
       set.forEach(function (v) { seen.push(v); });
       check(seen[2] === 'x', 1);
       check(set.has('x'), 2);
       var k1 = {}; var k2 = {};
       var wm = new WeakMap([[k1, 1]]);
       wm.set(k2, 'two');
       var two = wm.get(k2);
       check(two === 'two', 4);
       var one = wm.get(k1);
       check(one === 1, 8);
       export function main() { return bits; }`,
      "v12-set.js",
    );
    expect(bits).toBe(15);
  });

  it("TypeScript control: an inferred numeric Map keeps its numeric value lane", async () => {
    const value = await run(
      `const m = new Map([[1, 2.5], [2, 4]]);
       export function main(): number { return (m.get(1) ?? 0) + (m.get(2) ?? 0); }`,
      "v12-control.ts",
    );
    expect(value).toBe(6.5);
  });
});
