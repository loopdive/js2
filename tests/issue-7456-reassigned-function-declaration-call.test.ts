// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7456 — a call of a function declaration that the program reassigns (`({ h } = o)`, `[h] = a`, `h = k`) must
// invoke the binding's current value. The write already reached the live global (#2931); the call took the
// declaration's direct body unless the new value was a function literal. The script-var rows pass on main and guard
// the shapes the issue was filed with.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const H = "function h() { return 1; }";
const HK = `${H} function k() { return 2; }`;
const FN2 = "function () { return 2; }";

// [shape, file extension, declarations, body of `g()`]. Each body returns a number or a Boolean; node answers.
const FUNCTION_DECLARATION_ROWS: readonly (readonly [string, "js" | "ts", string, string])[] = [
  ["shorthand", "js", H, `({ h } = { h: ${FN2} }); return h();`],
  ["shorthand in another function", "js", `${H} function w() { ({ h } = { h: ${FN2} }); }`, "w(); return h();"],
  ["shorthand at top level", "js", `${HK} ({ h } = { h: k });`, "return h();"],
  ["nested shorthand", "js", H, `({ x: { h } } = { x: { h: ${FN2} } }); return h();`],
  ["shorthand inside an array pattern", "js", HK, "[{ h }] = [{ h: k }]; return h();"],
  ["shorthand default taken", "js", H, "({ h = function () { return 3; } } = {}); return h();"],
  ["shorthand default not taken", "js", HK, "({ h = function () { return 3; } } = { h: k }); return h();"],
  ["long-form property", "js", HK, "({ p: h } = { p: k }); return h();"],
  ["array element", "js", HK, "[h] = [k]; return h();"],
  ["from a var holding an object", "js", `${H} var o = { h: ${FN2} };`, "({ h } = o); return h();"],
  ["plain assignment of another declaration", "js", HK, "h = k; return h();"],
  ["plain assignment of a call result", "js", `${H} function mk() { return ${FN2}; }`, "h = mk(); return h();"],
  ["read before and after", "js", HK, "var a = h(); ({ h } = { h: k }); return a * 10 + h();"],
  [
    "arguments",
    "js",
    "function h(x, y) { return x + y; } function k(x, y) { return x * y; }",
    "var a = h(3, 4); [h] = [k]; return a * 100 + h(3, 4);",
  ],
  [
    "recursion",
    "js",
    "function h(n) { return n <= 0 ? 0 : 1 + h(n - 1); } function k() { return 100; }",
    "var a = h(3); ({ h } = { h: k }); return a * 1000 + h(3);",
  ],
  [
    "typed caller and writer",
    "ts",
    "function h(x: number): number { return x + 1; } function k(x: number): number { return x * 10; }" +
      " function w(): void { ({ h } = { h: k }); } function r(): number { return h(5); }",
    "var a = r(); w(); return a * 100 + r();",
  ],
];

// Unchanged: a write that never runs, and a function-literal write (closure path), keep their answer.
const UNCHANGED_ROWS: readonly (readonly [string, "js" | "ts", string, string])[] = [
  ["write never runs", "js", `${HK} function w() { ({ h } = { h: k }); }`, "return h();"],
  ["function-literal write", "js", H, `h = ${FN2}; return h();`],
];

// The issue's script-var shapes; correct on main, pinned here so a write-analysis change cannot lose them.
const SCRIPT_VAR_ROWS: readonly (readonly [string, "js" | "ts", string, string])[] = [
  [
    "string in a nested pattern",
    "js",
    'var s = "a"; function r() { return s; }',
    '({ x: { s } } = { x: { s: "b" } }); return r() === "b";',
  ],
  [
    "typed string read in a function",
    "ts",
    'var s: string = "a"; function r(): number { return s.length; }',
    'var a = r(); ({ s } = { s: "bcd" }); return a * 10 + r();',
  ],
  ["number array", "js", "var a = [1]; function r() { return a.length; }", "({ a } = { a: [2, 3] }); return r();"],
  [
    "class instance",
    "js",
    "class C { constructor(v) { this.v = v; } } var c = new C(1);",
    "({ c } = { c: new C(2) }); return c.v;",
  ],
  ["function-expression var", "js", "var f = function () { return 1; };", `({ f } = { f: ${FN2} }); return f();`],
  ["nested shorthand in an array", "js", 'var s = "a";', '[{ s }] = [{ s: "b" }]; return s === "b";'],
  ["array element", "js", 'var s = "a";', '[s] = ["b"]; return s === "b";'],
  ["top-level `var` pattern", "js", 'var { s } = { s: "b" }; function r() { return s; }', 'return r() === "b";'],
  ["`var` pattern in a function", "js", "var s = 1;", "var { s } = { s: 2 }; return s;"],
];

const nodeAnswer = (declarations: string, body: string): unknown =>
  new Function(ts.transpile(`${declarations}\nfunction g() { ${body} }\nreturn g();`))();

async function runOrdinary(ext: "js" | "ts", declarations: string, body: string, target: "gc" | "standalone") {
  const result = await compile(`${declarations}\nexport function g() { ${body} }`, {
    fileName: `test.${ext}`,
    allowJs: true,
    ...(target === "standalone" ? { target } : {}),
  });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : built;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  built.setInstance?.(instance);
  return (instance.exports.g as () => unknown)();
}

describe.each(["gc", "standalone"] as const)(
  "#7456 — reassigned function declarations and script vars (%s)",
  (target) => {
    it.each([...FUNCTION_DECLARATION_ROWS, ...UNCHANGED_ROWS, ...SCRIPT_VAR_ROWS])(
      "%s",
      async (_, ext, declarations, body) => {
        const expected = nodeAnswer(declarations, body);
        const actual = await runOrdinary(ext, declarations, body, target);
        expect(typeof expected === "boolean" ? actual === 1 || actual === true : actual).toBe(expected);
      },
    );
  },
);
