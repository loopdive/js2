// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7165 — a `(string | undefined)[]` lowers to a nullable `$AnyString`-ref vec
// that stores `undefined` as null. Its comparator-less `sort()` and its
// `join()` `ref.as_non_null`'d every element, so `["c", undefined, "a"].sort()`
// trapped with a null dereference. undefined now sorts last (§23.1.3.30.2) and
// joins as "" (§23.1.3.18). Each row is diffed against native JS on the gc
// (native-first), standalone and wasi lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

// Standalone returns a native string struct, so every row returns a numeric
// digest of its string and all lanes compare numbers.
const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;
const SHOW = `function show(x: string | undefined): string { return x === undefined ? "U" : x; }\n`;

const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;

async function expectSameOnAllLanes(prelude: string, body: string): Promise<void> {
  const src = `${ENC}${SHOW}${prelude}export function test(): number { return enc((() => { ${body} })()); }`;
  const expected = evaluateAsJs(src).test!();
  for (const { lane, options } of LANES) {
    const result = await compile(src, { fileName: "probe.ts", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

const U = `const a: (string | undefined)[] = `;

const ROWS: [string, string, string][] = [
  ["issue program: sort then join", "", `${U}["c", undefined, "a"]; a.sort(); return a.join("|");`],
  [
    "several undefined, read back",
    "",
    `${U}[undefined, "c", undefined, "a", "b"]; a.sort(); return a.map(show).join(",");`,
  ],
  [
    "for-of after sort",
    "",
    `${U}["z", undefined, "m", "a"]; a.sort(); let s = ""; for (const x of a) s += show(x) + ";"; return s;`,
  ],
  ["all undefined", "", `${U}[undefined, undefined]; a.sort(); return a.map(show).join(",") + a.length;`],
  ["no undefined", "", `${U}["c", "b", "a"]; a.sort(); return a.join();`],
  ["sort returns receiver", "", `${U}["c", undefined, "a"]; return a.sort().join("-");`],
  ["sort().toString()", "", `${U}["c", undefined, "a"]; return a.sort().toString();`],
  ["String(a) after sort", "", `${U}["c", undefined, "a"]; a.sort(); return String(a) + "/" + a.join();`],
  ["undefined pushed later", "", `${U}["c"]; a.push(undefined); a.push("a"); a.sort(); return a.map(show).join(",");`],
  ["code-unit order kept", "", `${U}["b", "B", undefined, "a", "10", "9"]; a.sort(); return a.map(show).join(",");`],
  ["join without sort", "", `${U}["c", undefined, "a"]; return a.join("|");`],
  ["explicit undefined comparator", "", `${U}["c", undefined, "a"]; a.sort(undefined); return a.map(show).join(",");`],
  // Holes: a null slot is a hole or undefined alike, and both sort to the end.
  [
    "length grown past the literal",
    "",
    `${U}["c", undefined, "a"]; a.length = 5; a.sort(); return a.length + ":" + a.join("|");`,
  ],
  [
    "sparse write leaves holes",
    "",
    `${U}["c", "a"]; a[4] = undefined; a.push("b"); a.sort(); return a.length + ":" + a.join("|");`,
  ],
  ["sparse string write", "", `${U}["c", "a"]; a[4] = "b"; a.sort(); return a.length + ":" + a.join("|");`],
  [
    "module-level vec",
    `const G: (string | undefined)[] = ["q", undefined, "b", undefined, "k"];\n`,
    `return G.sort().join("|");`,
  ],
  // `(string | null)[]` lowers to an externref vec: null sorts as the text "null".
  [
    "(string | null)[] sorts null as text",
    "",
    `const a: (string | null)[] = ["o", null, "a", "z"]; a.sort(); return a.map((x) => String(x)).join("|");`,
  ],
  [
    "(string | null | undefined)[]",
    "",
    `const a: (string | null | undefined)[] = ["o", undefined, null, "a"]; a.sort(); return a.map((x) => String(x)).join("|");`,
  ],
  // Non-nullable `string[]` keeps its lowering (control).
  ["string[] control", "", `const a: string[] = ["c", "b", "a"]; a.sort(); return a.join("|");`],
];

describe("#7165 default sort/join of a nullable string vec", () => {
  for (const [name, prelude, body] of ROWS) {
    it(name, () => expectSameOnAllLanes(prelude, body));
  }
});
