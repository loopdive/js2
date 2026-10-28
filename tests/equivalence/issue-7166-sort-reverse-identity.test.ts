// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7166 — `sort` / `reverse` / `fill` / `copyWithin` return their receiver, so
// the result is the same array: `a.sort() === a`, and a push through the
// result is seen through `a`. A module-level evolving `const keys = []` holds
// the dynamic (externref-element) vec while the checker typed `const r =
// keys.sort()` (and plain `const r = keys`) from the evolved `string[]`, so
// `r` got a typed vec slot and the store COPIED: `r === keys` was false and
// `r.push(x)` never reached `keys`. Each row is diffed against native JS on the
// gc (native-first), standalone and wasi lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;

async function expectSameOnAllLanes(src: string, fileName: string): Promise<void> {
  const expected = evaluateAsJs(src).test!();
  for (const { lane, options } of LANES) {
    const result = await compile(src, { fileName, ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

// Receivers: [name, declaration, value to push / fill with, file name].
const RECEIVERS: [string, string, string, string][] = [
  ["evolving for…in []", `const a = [];\nfor (const k in { b: 1, a: 2 }) a.push(k);\n`, `"c"`, "probe.js"],
  ["evolving push []", `const a = [];\na.push("b"); a.push("a");\n`, `"c"`, "probe.js"],
  ["evolving mixed []", `const a = [];\na.push("b"); a.push(1);\n`, `2`, "probe.js"],
  ["any[] literal", `const a: any[] = ["b", "a"];\n`, `"c"`, "probe.ts"],
  ["any[] empty", `const a: any[] = [];\na.push("b"); a.push("a");\n`, `"c"`, "probe.ts"],
  ["number[]", `const a: number[] = [2, 1];\n`, `3`, "probe.ts"],
  ["string[]", `const a: string[] = ["b", "a"];\n`, `"c"`, "probe.ts"],
];

const CALLS = (v: string): [string, string][] => [
  ["sort", `a.sort()`],
  ["sort(cmp)", `a.sort((x, y) => (String(x) < String(y) ? 1 : -1))`],
  ["reverse", `a.reverse()`],
  ["fill", `a.fill(${v})`],
  ["copyWithin", `a.copyWithin(0, 1)`],
  ["plain alias", `a`],
  ["chain sort().reverse()", `a.sort().reverse()`],
];

// Identity, then aliasing through the returned reference, then a read back.
const body = (call: string, v: string): string =>
  `const r = ${call};\nconst same = r === a ? 1 : 0;\nr.push(${v});\nconst out = same * 100 + a.length * 10 + (a[a.length - 1] === ${v} ? 1 : 0);\n`;

describe("#7166 receiver-returning array methods keep the receiver's identity", () => {
  for (const [rname, decl, v, fileName] of RECEIVERS) {
    for (const [cname, call] of CALLS(v)) {
      it(`module-level ${rname}: ${cname}`, () =>
        expectSameOnAllLanes(`${decl}${body(call, v)}export function test() { return out; }`, fileName));
      it(`function-local ${rname}: ${cname}`, () =>
        expectSameOnAllLanes(`export function test() {\n${decl}${body(call, v)}return out;\n}`, fileName));
    }
    it(`module-level ${rname}: identity inside a function`, () =>
      expectSameOnAllLanes(
        `${decl}export function test() { return (a.sort() === a ? 1 : 0) + (a.reverse() === a ? 2 : 0) + (a.fill(${v}) === a ? 4 : 0) + (a.copyWithin(0, 1) === a ? 8 : 0) + (a.sort().reverse() === a ? 16 : 0); }`,
        fileName,
      ));
  }
  // The aliased global is read back as a typed array: element reads, methods and iteration.
  const FILL = `const keys = [];\nfor (const k in { b: 1, a: 2 }) keys.push(k);\n`;
  const reads: [string, string][] = [
    ["element read", `r[0] === "a" ? 1 : 0`],
    ["element string method", `r[1].length + r[0].charCodeAt(0)`],
    ["join", `r.join("-") === "a-b" ? 1 : 0`],
    ["indexOf", `r.indexOf("b")`],
    ["map", `r.map((x) => x + "!").join() === "a!,b!" ? 1 : 0`],
    ["for…of", `(() => { let s = ""; for (const x of r) s += x; return s === "ab" ? 1 : 0; })()`],
    ["var alias", `(rv === keys ? 1 : 0) + rv.length * 10`],
  ];
  for (const [name, expr] of reads) {
    it(`module-level sorted alias: ${name}`, () =>
      expectSameOnAllLanes(
        `${FILL}const r = keys.sort();\nvar rv = keys;\nexport function test() { return ${expr}; }`,
        "probe.js",
      ));
  }
});
