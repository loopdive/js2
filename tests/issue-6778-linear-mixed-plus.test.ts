// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6778 — linear backend: `+` with ONE string operand is concatenation
 * (§13.15.3 step 3), not numeric addition. The direct lowering required BOTH
 * operands to be strings, so `"1" + 2` fell through to `f64.add` on the i32
 * string pointer — an engine-invalid module reported as `success: true`.
 *
 * The other operand is now converted with ToString (numbers via the host-free
 * Ryū formatter, booleans/null/undefined via literals) before `__str_concat`;
 * string `s += v` takes the same path. An operand the linear representation
 * cannot stringify (an object) is a hard compile error, never a fall-through.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ORIGINAL_LINEAR_IR = process.env.JS2WASM_LINEAR_IR;

afterEach(() => {
  if (ORIGINAL_LINEAR_IR === undefined) Reflect.deleteProperty(process.env, "JS2WASM_LINEAR_IR");
  else process.env.JS2WASM_LINEAR_IR = ORIGINAL_LINEAR_IR;
});

async function runLinear(body: string, overlay: boolean): Promise<number> {
  process.env.JS2WASM_LINEAR_IR = overlay ? "1" : "0";
  const r = await compile(`export function f(): number { ${body} }`, { fileName: "test.ts", target: "linear" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { f(): number }).f();
}

const t = (value: string, expected: string): number => (value === expected ? 1 : 0);
const flag = true;
const num = 12.5;

// [label, linear function body, value Node computes for the same expression]
const ROWS: ReadonlyArray<readonly [string, string, number]> = [
  ['issue repro: ("1" + 2).length', `const s = "1" + 2; return s.length;`, ("1" + 2).length],
  ['(2 + "1").length', `const s = 2 + "1"; return s.length;`, (2 + "1").length],
  ['(`${1}` + "x").length', 'const s = `${1}` + "x"; return s.length;', (`${1}` + "x").length],
  ['("a" + true).length', `const s = "a" + true; return s.length;`, ("a" + true).length],
  ['("a" + null).length', `const s = "a" + null; return s.length;`, ("a" + null).length],
  ['("a" + undefined).length', `const s = "a" + undefined; return s.length;`, ("a" + undefined).length],
  ['"x" + 1.5 === "x1.5"', `return "x" + 1.5 === "x1.5" ? 1 : 0;`, t("x" + 1.5, "x1.5")],
  ['"a" + false === "afalse"', `return "a" + false === "afalse" ? 1 : 0;`, t("a" + false, "afalse")],
  ['"a" + null === "anull"', `return "a" + null === "anull" ? 1 : 0;`, t("a" + null, "anull")],
  [
    '"a" + undefined === "aundefined"',
    `return "a" + undefined === "aundefined" ? 1 : 0;`,
    t("a" + undefined, "aundefined"),
  ],
  ['"a" + 1 + 2 === "a12"', `return "a" + 1 + 2 === "a12" ? 1 : 0;`, t("a" + 1 + 2, "a12")],
  ['1 + 2 + "a" === "3a"', `return 1 + 2 + "a" === "3a" ? 1 : 0;`, t(1 + 2 + "a", "3a")],
  ['number local + "px"', `const n: number = 12.5; return n + "px" === "12.5px" ? 1 : 0;`, t(num + "px", "12.5px")],
  ['"v" + boolean local', `const b: boolean = true; return "v" + b === "vtrue" ? 1 : 0;`, t("v" + flag, "vtrue")],
  [
    '"a" + NaN / -0 / 1e21 / Infinity',
    `return "a" + 0 / 0 + (-0) + 1e21 + 1 / 0 === "aNaN01e+21Infinity" ? 1 : 0;`,
    t("a" + 0 / 0 + -0 + 1e21 + 1 / 0, "aNaN01e+21Infinity"),
  ],
  ["s += 1", `let s = "a"; s += 1; return s === "a1" ? 1 : 0;`, 1],
  ["s += true", `let s = "a"; s += true; return s === "atrue" ? 1 : 0;`, 1],
  ["loop s += i", `let s = ""; for (let i = 0; i < 3; i++) s += i; return s === "012" ? 1 : 0;`, 1],
];

describe("#6778 linear mixed string `+`", () => {
  for (const overlay of [false, true]) {
    describe(`JS2WASM_LINEAR_IR=${overlay ? 1 : 0}`, () => {
      for (const [label, body, expected] of ROWS) {
        it(`${label} -> ${expected}`, async () => {
          expect(await runLinear(body, overlay)).toBe(expected);
        });
      }
    });
  }

  it("refuses an object operand with a codegen error instead of an invalid binary", async () => {
    const r = await compile(`export function f(): number { const o = { a: 1 }; const s = "x" + o; return s.length; }`, {
      fileName: "test.ts",
      target: "linear",
    });
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/cannot convert an operand of type .* to a string/);
  });
});
