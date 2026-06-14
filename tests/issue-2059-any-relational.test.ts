// #2059 — relational operators (`<`,`<=`,`>`,`>=`) on two `any`/externref
// operands must follow §7.2.13 IsLessThan: two strings compare lexicographically,
// a string-vs-number compares numerically. The numeric paths ToNumber-coerce both
// sides (`Number("a")` → NaN) so `("a" as any) < ("b" as any)` wrongly yielded
// `false`.
//
// JS-host delegates to `__host_compare` (JS `<`/`>`, returns -1/0/1/2 with 2 =
// NaN/undefined-incomparable). Standalone builds §7.2.13 in-module: both-string →
// native `__str_compare`, else ToNumber + f64 (no JS host import leak).
import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

const src = `
  export function lt(a: any, b: any): boolean { return a < b; }
  export function le(a: any, b: any): boolean { return a <= b; }
  export function gt(a: any, b: any): boolean { return a > b; }
  export function ge(a: any, b: any): boolean { return a >= b; }
`;

describe("#2059 any/any relational comparisons (JS-host / default mode)", () => {
  it("matches Node for string, mixed, numeric, NaN and null operands", async () => {
    const wasm = await compileToWasm(src);
    const js = evaluateAsJs(src);
    const cases: [string, unknown, unknown][] = [
      // string lexicographic
      ["lt", "a", "b"],
      ["lt", "b", "a"],
      ["lt", "10", "9"], // "1" < "9" → true (NOT numeric 10<9)
      ["lt", "abc", "abd"],
      ["lt", "abc", "ab"],
      ["gt", "b", "a"],
      ["le", "a", "a"],
      ["ge", "b", "a"],
      ["ge", "abc", "abd"],
      // mixed string/number → numeric per §7.2.13
      ["lt", "10", 9], // 10 < 9 → false
      ["lt", 5, "9"], // 5 < 9 → true
      // pure numeric
      ["lt", 5, 3],
      ["gt", 7, 2],
      ["le", 4, 4],
      // NaN operand → all relationals false
      ["lt", NaN, 1],
      ["gt", NaN, 1],
      ["ge", NaN, 1],
      // null / undefined coercion (ToNumber)
      ["lt", null, 1],
      ["le", null, 0],
    ];
    for (const [fn, a, b] of cases) {
      const w = (wasm[fn] as Function)(a, b);
      const j = (js[fn] as Function)(a, b);
      // wasm returns i32 (0/1); js returns boolean — normalize.
      expect(!!w, `${fn}(${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBe(!!j);
    }
  });

  it("provably-numeric and provably-string relationals are unchanged", async () => {
    const typed = `
      export function ltn(a: number, b: number): boolean { return a < b; }
      export function lts(a: string, b: string): boolean { return a < b; }
    `;
    const wasm = await compileToWasm(typed);
    const js = evaluateAsJs(typed);
    for (const [fn, a, b] of [
      ["ltn", 3, 4],
      ["ltn", 9, 2],
      ["lts", "ab", "cd"],
      ["lts", "z", "a"],
    ] as [string, unknown, unknown][]) {
      expect(!!(wasm[fn] as Function)(a, b), `${fn}`).toBe(!!(js[fn] as Function)(a, b));
    }
  });
});

// Standalone (pure-WasmGC): the per-site compare builds §7.2.13 in-module with no
// JS host and no unsatisfiable `env::__host_compare` import.
describe("#2059 any/any relational comparisons (standalone / pure WasmGC)", () => {
  async function compileStandalone(s: string) {
    const r = await compile(s, { target: "standalone" });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    return r;
  }

  it("any numeric < validates and runs", async () => {
    const r = await compileStandalone(
      `export function f(): number { const a: any = 3; const b: any = 5; return (a < b) ? 1 : 0; }`,
    );
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.f as () => number)()).toBe(1);
  });

  it("any numeric > validates and runs", async () => {
    const r = await compileStandalone(
      `export function f(): number { const a: any = 9; const b: any = 2; return (a > b) ? 1 : 0; }`,
    );
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports.f as () => number)()).toBe(1);
  });

  it("any string < validates (no host import leak)", async () => {
    await compileStandalone(`export function f(a: any, b: any): number { return (a < b) ? 1 : 0; }`);
  });
});
