import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2590 — standalone `RegExp.escape(s)` static method (ES2025 §22.2.5 /
// EncodeForRegExpEscape). Pure Wasm native string transform — no regex engine,
// no `env::__get_builtin` host import. Routed through the native `__regex_escape`
// helper in src/codegen/native-strings.ts, dispatched in
// src/codegen/expressions/calls.ts next to Number.isNaN / Object.is.
//
// We assert via the SAME `isSameValue(a: any, b: any)` shape the test262 harness
// uses (`assert.sameValue` lowers to it): both args are `any` → compared by the
// §7.2.15 SameValue value-equality helper, the path the conformance suite hits.

// The harness `isSameValue` compares native strings by value, not reference.
const HARNESS = `
function isSameValue(a: any, b: any): number {
  if (a === b) { return 1; }
  if (a !== a && b !== b) { return 1; }
  return 0;
}
`;

async function escEquals(inputSrc: string, expectedSrc: string): Promise<{ eq: number; leaked: boolean }> {
  const src = `${HARNESS}\nexport function test(): number { return isSameValue(RegExp.escape(${inputSrc}), ${expectedSrc}); }`;
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const leaked = r.imports.some((i) => i.name.includes("__get_builtin"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const eq = (instance.exports as { test(): number }).test();
  return { eq, leaked };
}

// Compile a `RegExp.escape(<non-string-literal>)` call inside a try/catch and
// return whether it threw at runtime (matches non-string-inputs.js).
async function escThrows(argSrc: string): Promise<{ threw: number; leaked: boolean }> {
  const src = `export function test(): number { try { RegExp.escape(${argSrc}); return 0; } catch (e) { return 1; } }`;
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const leaked = r.imports.some((i) => i.name.includes("__get_builtin"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const threw = (instance.exports as { test(): number }).test();
  return { threw, leaked };
}

describe("#2590 standalone RegExp.escape", () => {
  // [name, input source, expected escaped source] — input/expected are TS string
  // literal source, doubly-escaped for the embedded compiler source.
  const cases: Array<[string, string, string]> = [
    ["leading alnum + syntax dot", '"a.b"', '"\\\\x61\\\\.b"'],
    ["parens", '"(x)"', '"\\\\(x\\\\)"'],
    ["empty string", '""', '""'],
    [
      "all syntax characters",
      '"^$\\\\.*+?()[]{}|"',
      '"\\\\^\\\\$\\\\\\\\\\\\.\\\\*\\\\+\\\\?\\\\(\\\\)\\\\[\\\\]\\\\{\\\\}\\\\|"',
    ],
    ["solidus", '"/"', '"\\\\/"'],
    ["control escapes", '"\\t\\n\\v\\f\\r"', '"\\\\t\\\\n\\\\v\\\\f\\\\r"'],
    [
      "other punctuators",
      '",-=<>#&!%:;@~\\u0027\\u0060\\""',
      '"\\\\x2c\\\\x2d\\\\x3d\\\\x3c\\\\x3e\\\\x23\\\\x26\\\\x21\\\\x25\\\\x3a\\\\x3b\\\\x40\\\\x7e\\\\x27\\\\x60\\\\x22"',
    ],
    ["initial digit", '"1111"', '"\\\\x31111"'],
    ["initial ascii letter a", '"aaa"', '"\\\\x61aa"'],
    ["initial letter j (hex 6a)", '"jjj"', '"\\\\x6ajj"'],
    ["initial Z + special", '"Z*Z"', '"\\\\x5a\\\\*Z"'],
    ["mid-string alnum not escaped", '".a1b2c3D4E5F6"', '"\\\\.a1b2c3D4E5F6"'],
    ["whitespace space", '"\\u0020"', '"\\\\x20"'],
    ["whitespace nbsp", '"\\u00A0"', '"\\\\xa0"'],
    ["whitespace ZWNBSP", '"\\uFEFF"', '"\\\\ufeff"'],
    ["whitespace narrow nbsp", '"\\u202F"', '"\\\\u202f"'],
    ["whitespace combined", '"\\uFEFF\\u0020\\u00A0\\u202F"', '"\\\\ufeff\\\\x20\\\\xa0\\\\u202f"'],
    ["line terminator LS", '"\\u2028"', '"\\\\u2028"'],
    ["line terminator PS", '"\\u2029"', '"\\\\u2029"'],
    ["lone high surrogate", '"\\uD800"', '"\\\\ud800"'],
    ["lone low surrogate", '"\\uDFFF"', '"\\\\udfff"'],
    ["valid astral pair passthrough", '"\\uD83D\\uDE00"', '"\\uD83D\\uDE00"'],
    ["valid pair D800DC00 passthrough", '"\\uD800\\uDC00"', '"\\uD800\\uDC00"'],
    ["non-ascii passthrough", '"你好"', '"你好"'],
    ["greek with space", '"Γειά σου"', '"Γειά\\\\x20σου"'],
    ["korean with bang", '"안녕!"', '"안녕\\\\x21"'],
    ["mixed ascii + U+D7FF (non-surrogate)", '".hello\\uD7FFworld"', '"\\\\.hello\\uD7FFworld"'],
  ];

  for (const [name, inputSrc, expectedSrc] of cases) {
    it(name, async () => {
      const { eq, leaked } = await escEquals(inputSrc, expectedSrc);
      expect(leaked, "must not leak env::__get_builtin").toBe(false);
      expect(eq).toBe(1);
    });
  }

  it("non-string literal argument throws (TypeError, §22.2.5 step 1)", async () => {
    for (const arg of ["123", "true", "null", "undefined"]) {
      const { threw, leaked } = await escThrows(arg);
      expect(leaked, `must not leak env::__get_builtin for ${arg}`).toBe(false);
      expect(threw, `RegExp.escape(${arg}) must throw`).toBe(1);
    }
  });
});
