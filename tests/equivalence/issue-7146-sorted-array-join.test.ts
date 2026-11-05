// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7146 — `keys.sort().join(",")` on a module-level `const keys = []` filled by
// `for…in` emitted invalid wasm under native strings: the storage vec holds
// externref elements, but the native join skips its receiver probe for a
// `.sort()` receiver and took the checker's `string[]` vec type instead. Each
// row is diffed against native JS on the gc (native-first) and standalone lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

// Keys are enumerated already in order: the comparator-less `sort()` of an
// externref-element vec is still a no-op on these lanes (#2502 fallback), a
// separate gap this file does not pin. The comparator row uses real reordering.
const FILL = `const keys = [];\nfor (const k in { a: 1, b: 2, c: 3 }) keys.push(k);\n`;

// Standalone returns a native string struct, so every row returns a numeric
// digest of the joined string and both lanes compare numbers.
const ENC = `function enc(s) { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

async function expectSameOnBothLanes(prelude: string, expr: string): Promise<void> {
  const src = `${ENC}${prelude}export function test() { return enc(String(${expr})); }`;
  const expected = evaluateAsJs(src).test!();
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.js", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

describe("#7146 native join of a sorted array reads the storage vec", () => {
  const rows: [string, string, string][] = [
    ["for…in keys, sort().join(sep)", FILL, `keys.sort().join(",")`],
    ["for…in keys, sort().join()", FILL, `keys.sort().join()`],
    ["for…in keys, sort().toString()", FILL, `keys.sort().toString()`],
    ["for…in keys, sort(cmp).join(sep)", FILL, `keys.sort((x, y) => (x < y ? 1 : -1)).join("-")`],
    ["top-level for…in + sort().join", `${FILL}const s = keys.sort().join(",");\n`, `s`],
    ["top-level sort(cmp).join", `${FILL}const s = keys.sort((x, y) => (x < y ? 1 : -1)).join("-");\n`, `s`],
    ["top-level push-grown", `const t = [];\nt.push("y");\nt.push("z");\nconst s = t.sort().join();\n`, `s`],
    ["top-level literal", `const t = ["c", "a", "b"];\nconst s = t.sort().join("|");\n`, `s`],
    ["push-grown", `const a = [];\na.push("y");\na.push("z");\n`, `a.sort().join()`],
    ["literal", `const l = ["c", "a", "b"];\n`, `l.sort().join("|")`],
    ["unsorted join (control)", FILL, `keys.join("+")`],
    ["reverse().join", FILL, `keys.reverse().join()`],
    ["slice().join", FILL, `keys.slice(1).join()`],
    ["concat().join", FILL, `keys.concat(["q"]).join()`],
    ["sort().indexOf", FILL, `keys.sort().indexOf("b")`],
    ["sort().includes", FILL, `keys.sort().includes("a")`],
    // Chains whose `.sort()` receiver is not an identifier (#7146 review). The
    // reverse row sorts with a comparator: comparator-less sort is #7151.
    ...[
      `keys.slice().sort().join(",")`,
      `keys.sort().sort().join()`,
      `keys.reverse().sort((x, y) => (x < y ? -1 : 1)).join()`,
      `keys.concat([]).sort().join()`,
      `keys.sort((x, y) => (x < y ? -1 : 1)).sort().join()`,
      `keys.filter((x) => x !== "b").sort().join(",")`,
      `keys.filter((x) => x !== "b").join(",")`,
    ].map((e): [string, string, string] => [`top-level ${e}`, `${FILL}const s = ${e};\n`, `s`]),
  ];
  for (const [name, prelude, expr] of rows) it(name, () => expectSameOnBothLanes(prelude, expr));
});
