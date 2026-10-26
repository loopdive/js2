// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7152 — an evolving `const keys = []` filled by `for…in` and then pushed
// numbers is stored as an externref-element vec, while the checker types its
// element `string | number` (`$AnyValue`). The array-HOF callback parameter
// took the checker's type, so the loop's externref→`$AnyValue` cast handed the
// predicate null and `typeof k === "number"` / `k !== "a"` trapped
// ("dereferencing a null pointer"). Each row is diffed against native JS on
// the gc (native-first), standalone and wasi lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const FILL = `const keys = [];\nfor (const k in { c: 1, a: 2 }) keys.push(k);\nkeys.push(3); keys.push(1);\n`;

const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;

async function expectSameOnAllLanes(src: string): Promise<void> {
  const expected = evaluateAsJs(src).test!();
  for (const { lane, options } of LANES) {
    const result = await compile(src, { fileName: "probe.js", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

const EXPRS = [
  // The four issue lines.
  `keys.filter(k => typeof k === "number").length`,
  `keys.filter(k => k !== "a").length`,
  `keys.filter(k => true).length`,
  `keys.map(k => k).length`,
  // Same callback path, other predicate-family methods.
  `keys.filter(k => typeof k === "string").length`,
  `keys.find(k => typeof k === "number")`,
  `keys.find(k => k !== "c") === "a" ? 1 : 0`,
  `keys.some(k => typeof k === "number") ? 1 : 0`,
  `keys.some(k => k === "zz") ? 1 : 0`,
  `keys.every(k => typeof k === "number") ? 1 : 0`,
  `keys.every(k => k !== "b") ? 1 : 0`,
  `(() => { let n = 0; keys.forEach(k => { if (typeof k === "number") n += k; }); return n; })()`,
  `(() => { let n = 0; keys.forEach(k => { if (k !== "a") n++; }); return n; })()`,
  // Round 2: a nested closure writes the parameter (ref cell holds the raw externref).
  `keys.filter(k => { const f = () => { k = 5; }; f(); return typeof k === "number"; }).length`,
  `keys.filter(k => { const f = () => { k = 5; }; f(); return typeof k === "string"; }).length`,
  `keys.filter(k => { const g = () => { if (k === "never") k = 0; }; g(); return typeof k === "number"; }).length`,
  `keys.some(k => { const f = () => { k = k; }; f(); return typeof k === "number"; }) ? 1 : 0`,
  `(() => { let n = 0; keys.forEach(k => { const f = () => { k = k; }; f(); if (typeof k === "number") n++; }); return n; })()`,
  // Round 2: parenthesized callback.
  `keys.filter((k => typeof k === "number")).length`,
  // Round 3: `typeof k` outside a `=== "literal"` comparison (the `__any_typeof` arm),
  // plain and with a nested closure writing `k`.
  `keys.filter(k => { const t = typeof k; return t === "number"; }).length`,
  `keys.filter(k => { switch (typeof k) { case "number": return true; default: return false; } }).length`,
  `keys.filter(k => (typeof k + "") === "number").length`,
  `(() => { let s = ""; keys.forEach(k => { s += typeof k; }); return s.length; })()`,
  `keys.filter(k => { const f = () => { k = 7; }; f(); const t = typeof k; return t === "number"; }).length`,
  `keys.filter(k => { const f = () => { k = 7; }; f(); const g = () => typeof k; return g() === "number"; }).length`,
  `keys.filter(k => { const f = () => { k = 7; }; f(); switch (typeof k) { case "number": return true; default: return false; } }).length`,
  `keys.filter(k => { const f = () => { k = 7; }; f(); return (typeof k + "") === "number"; }).length`,
  // Round 3: reduce / reduceRight whose callback passes the accumulator through. The
  // accumulator is deliberately NOT re-typed (the call's result stays `$AnyValue`);
  // these read the value directly.
  `keys.reduce((acc, k) => acc, 5) * 1`,
  `keys.reduce((acc, k) => acc, "q") === "q" ? 1 : 0`,
  `keys.reduceRight((acc, k) => acc, 5) * 1`,
  `keys.reduceRight((acc, k) => acc, "q") === "q" ? 1 : 0`,
  `keys.reduce((best, k) => (typeof k === "number" && k > best ? k : best), 0) * 1`,
  `keys.reduce((acc, k) => (k === "zz" ? 9 : acc), 5) * 1`,
];

describe("#7152 HOF callback over an externref-storage vec takes the element live", () => {
  for (const expr of EXPRS) {
    it(`module-level keys: ${expr}`, () => expectSameOnAllLanes(`${FILL}export function test() { return ${expr}; }`));
    it(`function-local keys: ${expr}`, () =>
      expectSameOnAllLanes(`export function test() {\n${FILL}return ${expr};\n}`));
  }
  it("top-level result", () =>
    expectSameOnAllLanes(
      `${FILL}const n1 = keys.filter(k => typeof k === "number").length;\nconst n2 = keys.filter(k => k !== "a").length;\nexport function test() { return n1 * 10 + n2; }`,
    ));
});
