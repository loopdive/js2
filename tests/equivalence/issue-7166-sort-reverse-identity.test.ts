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
import { aliasSweepCases } from "./issue-7166-alias-sweep.js";
import { SWEEP_SAME_AS_MAIN } from "./issue-7166-alias-sweep-known.js";

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
  // `typeof` and other static-type-driven reads of an element: the checker
  // types it `string | number`, the slot holds externrefs (B1, PR #6947 round 2).
  const KIND = `function kind(t) { return t.length * 1000 + t.charCodeAt(0) * 10 + t.charCodeAt(1) % 10; }\n`;
  const elementOps: [string, string][] = [
    ["typeof [0]", `kind(typeof R[0])`],
    ["typeof [1]", `kind(typeof R[1])`],
    [
      "typeof === literal",
      `(typeof R[0] === "string" ? 1 : 0) + (typeof R[1] === "number" ? 2 : 0) + (typeof R[1] !== "string" ? 4 : 0)`,
    ],
    [
      "switch (typeof [i])",
      `(() => { let n = 0; for (let i = 0; i < R.length; i++) switch (typeof R[i]) { case "number": n += 1; break; case "string": n += 10; break; default: n += 100; } return n; })()`,
    ],
    [
      "typeof in a loop",
      `(() => { let n = 0; for (let i = 0; i < R.length; i++) n = n * 7 + kind(typeof R[i]); return n; })()`,
    ],
    ["[0] + 1", `String(R[0] + 1).length`],
    ["[0].length", `R[0].length`],
    ["[0] === literal", `(R[0] === "b" ? 1 : 0) + (R[1] === 1 ? 2 : 0)`],
  ];
  const ELEMENTS: [string, string][] = [
    ["mixed", `a.push("b"); a.push(1);`],
    ["string", `a.push("b"); a.push("c");`],
    ["number", `a.push(2); a.push(1);`],
  ];
  for (const [ename, fill] of ELEMENTS) {
    for (const [alias, init] of [
      ["a", ""],
      ["r = a", "const r = a;\n"],
      ["r = a.reverse()", "const r = a.reverse();\n"],
    ]) {
      for (const [oname, op] of elementOps) {
        if (ename !== "string" && oname === "[0].length") continue; // `(2).length` is a separate gap
        // wasi reads `a[0].length` through the source binding as undefined on main too.
        if (alias === "a" && oname === "[0].length") continue;
        const R = alias === "a" ? "a" : "r";
        const expr = op.replaceAll("R", R);
        const decl = `const a = [];\n${fill}\n${init}`;
        it(`module-level ${ename} ${alias}: ${oname}`, () =>
          expectSameOnAllLanes(`${KIND}${decl}export function test() { return ${expr}; }`, "probe.js"));
        it(`function-local ${ename} ${alias}: ${oname}`, () =>
          expectSameOnAllLanes(`${KIND}export function test() {\n${decl}return ${expr};\n}`, "probe.js"));
      }
    }
  }
  // A module `let` / `var` alias that is later reassigned keeps the checker's
  // slot (B2): the reassigned array must stay the same array.
  const REASSIGNED: [string, string][] = [
    [
      "let = other",
      `let r = keys;\nconst other = ["m"];\nfunction run() { r = other; r.push("o"); return (other.length * 10) + (r === other ? 1 : 0); }\n`,
    ],
    [
      "var = other",
      `var r = keys;\nconst other = ["m"];\nfunction run() { r = other; r.push("o"); return (other.length * 10) + (r === other ? 1 : 0); }\n`,
    ],
    [
      "let = mk()",
      `let r = keys;\nfunction mk() { const g = ["g"]; return g; }\nfunction run() { const m = mk(); r = m; r.push("o"); return (m.length * 10) + (r === m ? 1 : 0); }\n`,
    ],
    [
      "let .sort(), not reassigned",
      `let r = keys.sort();\nfunction run() { r.push("o"); return (keys.length * 10) + (r === keys ? 1 : 0); }\n`,
    ],
  ];
  for (const [name, body] of REASSIGNED) {
    it(`module-level reassigned alias: ${name}`, () =>
      expectSameOnAllLanes(
        `const keys = [];\nkeys.push("a");\n${body}export function test() { return run(); }`,
        "probe.js",
      ));
    it(`function-local reassigned alias: ${name}`, () =>
      expectSameOnAllLanes(
        `export function test() {\nconst keys = [];\nkeys.push("a");\n${body}return run();\n}`,
        "probe.js",
      ));
  }
  for (const [name, expr] of reads) {
    it(`module-level sorted alias: ${name}`, () =>
      expectSameOnAllLanes(
        `${FILL}const r = keys.sort();\nvar rv = keys;\nexport function test() { return ${expr}; }`,
        "probe.js",
      ));
  }
});

// Review repros (PR #6947 round 2): an alias that escapes into a typed place,
// a closure write to a local `let` alias, a destructuring `var` redeclaration.
// The alias rule must decline for all of them and keep main's behaviour.
const ENC = `function enc(s) { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;
const REPROS: [string, string][] = [
  [
    "module alias escapes (const t, [r], return)",
    `const keys = []; keys.push("a");\nconst r = keys.sort();\nfunction g() { return r; }\nexport function test() { const t = r; const box = [r]; return enc(String(t === r) + (box[0] === r) + (g() === r)); }`,
  ],
  [
    "module alias escapes (?:, { v }, f(r))",
    `const keys = []; keys.push("a");\nconst r = keys.sort();\nconst flag = keys.length > 0;\nfunction f(x) { return x; }\nexport function test() { const t = flag ? r : []; const o = { v: r }; return enc(String(t === r) + (o.v === r) + (f(r) === r)); }`,
  ],
  [
    "module alias copied then pushed",
    `const keys = []; keys.push("a"); keys.push("b");\nconst r = keys;\nexport function test() { const t = r; t.push("z"); return r.length; }`,
  ],
  [
    "local let alias written in a closure",
    `export function test() {\n  const a = []; a.push("b"); a.push(1);\n  let r = a.sort();\n  const f = () => { r = ["q"]; };\n  f();\n  return enc(r.join());\n}`,
  ],
  [
    "module var redeclared by an array pattern",
    `const keys = []; keys.push("a");\nconst other = ["m"];\nvar r = keys;\nvar [r] = [other];\nexport function test() { r.push("o"); return enc(other.join() + (r === other)); }`,
  ],
  [
    "module var redeclared by an object pattern",
    `const keys = []; keys.push("a");\nconst other = ["m"];\nvar r = keys;\nvar { r } = { r: other };\nexport function test() { r.push("o"); return enc(other.join() + (r === other)); }`,
  ],
  [
    "module var redeclared by a pattern in a block",
    `const keys = []; keys.push("a");\nconst other = ["m"];\nvar r = keys;\n{ var [r] = [other]; }\nexport function test() { r.push("o"); return enc(other.join() + (r === other)); }`,
  ],
];

describe("#7166 an alias that escapes or is rewritten keeps main's behaviour", () => {
  for (const [name, src] of REPROS) it(name, () => expectSameOnAllLanes(`${ENC}${src}`, "probe.js"));
  // Main answers this one wrongly too (the closure's store copies `b`); the
  // alias rule must only not turn it into an `illegal cast` trap.
  it("local let alias written in a closure from an evolving array does not trap", async () => {
    const src = `${ENC}export function test() {\n  const a = []; a.push("b"); a.push(1);\n  const b = []; b.push("q");\n  let r = a;\n  const f = () => { r = b; };\n  f();\n  r.push("z");\n  return enc(b.join() + (r === b));\n}`;
    for (const { lane, options } of LANES) {
      const result = await compile(src, { fileName: "probe.js", ...options });
      expect(result.success, lane).toBe(true);
      const instance = await instantiateWithRuntime(result);
      expect(typeof (instance.exports.test as () => unknown)(), lane).toBe("number");
    }
  });
});

// Review repros (PR #6947 round 3): uses the allow-list must not admit on an
// externref vec. Rows main answers correctly must match node; rows main also
// gets wrong (or traps on) must at least compile to valid wasm and run.
const R3_MATCH: [string, string][] = [
  [
    "module spread into a rest parameter",
    `const keys = []; keys.push("a"); keys.push(1); keys.push("b");\nconst r = keys.sort();\nexport function test() { function f(...xs) { xs.push("z"); return xs.length; } return enc(String(f(...r)) + r.length + keys.length); }`,
  ],
  [
    "local spread into a rest parameter",
    `export function test() { const a = []; a.push("b"); a.push("a"); const r = a; function f(...xs) { xs.push("z"); return xs.length; } return enc(String(f(...r)) + a.length); }`,
  ],
  [
    "module map identity on a mixed alias",
    `const keys = []; keys.push("b"); keys.push(1);\nconst r = keys;\nexport function test() { return enc(r.map((x) => x).join()); }`,
  ],
  [
    "module map identity on a sorted mixed alias",
    `const keys = []; keys.push("b"); keys.push(1);\nconst r = keys.sort();\nexport function test() { const m = r.map((x) => x); return enc(String(m[0]) + String(m[1]) + m.length); }`,
  ],
  [
    "module comparator sort on a mixed alias",
    `const keys = []; keys.push("a"); keys.push(1); keys.push("b");\nconst r = keys.sort();\nexport function test() { r.sort((p, q) => (String(p) < String(q) ? -1 : 1)); return enc(keys.join()); }`,
  ],
];
const R3_VALID: [string, string][] = [
  [
    "destructuring swap of alias elements",
    `const keys = []; keys.push("a"); keys.push(1); keys.push("b");\nconst r = keys.sort();\nexport function test() { [r[0], r[2]] = [r[2], r[0]]; return enc(keys.join()); }`,
  ],
  [
    "numeric comparator sort on a mixed alias",
    `const keys = []; keys.push(3); keys.push(1); keys.push("2");\nconst r = keys;\nexport function test() { r.sort((p, q) => Number(p) - Number(q)); return enc(keys.join()); }`,
  ],
  [
    "TDZ read of a sorted local alias",
    `export function test() { const a = []; a.push("a"); a.push(1); a.push("b"); let t; try { t = r.length; } catch (e) { t = "tdz"; } const r = a.sort(); return enc(String(t) + r.length); }`,
  ],
  [
    "TDZ read of a local alias",
    `export function test() { const a = []; a.push("a"); a.push(1); a.push("b"); let t; try { t = r.length; } catch (e) { t = "tdz"; } const r = a; return enc(String(t) + r.length); }`,
  ],
  [
    "closure declared before a local alias",
    `export function test() { const a = []; a.push("a"); a.push(1); a.push("b"); const f = () => r.length; const r = a.sort(); return enc(String(f())); }`,
  ],
];
describe("#7166 uses the alias rule must decline (round 3)", () => {
  for (const [name, src] of R3_MATCH) it(name, () => expectSameOnAllLanes(`${ENC}${src}`, "probe.js"));
  for (const [name, src] of R3_VALID) {
    it(`${name} compiles to valid wasm`, async () => {
      for (const { lane, options } of LANES) {
        const result = await compile(`${ENC}${src}`, { fileName: "probe.js", ...options });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
        expect(WebAssembly.validate(result.binary), lane).toBe(true);
      }
    });
  }
});

// Generated use-form sweep (issue-7166-alias-sweep.ts). The default run is a
// thinned slice (the mixed source, `a.sort()`); JS2WASM_FULL_SWEEP=1 runs all
// 2,328 programs. Rows in SWEEP_SAME_AS_MAIN fail identically on main
// (measured head vs base, see issue-7166-alias-sweep-known.ts) and are skipped.
describe("#7166 alias use-form sweep", () => {
  for (const [name, src] of aliasSweepCases(process.env.JS2WASM_FULL_SWEEP === "1")) {
    (SWEEP_SAME_AS_MAIN.has(name) ? it.skip : it)(name, () => expectSameOnAllLanes(src, "probe.js"));
  }
});
