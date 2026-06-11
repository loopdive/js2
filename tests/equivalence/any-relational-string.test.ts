import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs } from "./helpers.js";

// §7.2.13 IsLessThan: relational operators on two `any` operands must compare
// strings lexicographically, not coerce both to f64 (→ NaN → always false). (#2059)
describe("relational operators on any/any operands (#2059)", () => {
  const src = `
    export function lt(a: any, b: any): boolean { return a < b; }
    export function le(a: any, b: any): boolean { return a <= b; }
    export function gt(a: any, b: any): boolean { return a > b; }
    export function ge(a: any, b: any): boolean { return a >= b; }
  `;

  const cases: { fn: string; a: unknown; b: unknown }[] = [
    // string lexicographic
    { fn: "lt", a: "a", b: "b" },
    { fn: "lt", a: "b", b: "a" },
    { fn: "lt", a: "10", b: "9" }, // lexicographic: "1" < "9" → true (NOT numeric 10<9)
    { fn: "lt", a: "abc", b: "abd" },
    { fn: "lt", a: "abc", b: "ab" },
    { fn: "gt", a: "b", b: "a" },
    { fn: "le", a: "a", b: "a" },
    { fn: "ge", a: "b", b: "a" },
    // mixed string/number → numeric per §7.2.13
    { fn: "lt", a: "10", b: 9 },
    { fn: "lt", a: 5, b: "9" },
    // pure numeric
    { fn: "lt", a: 5, b: 3 },
    { fn: "gt", a: 7, b: 2 },
    // NaN operand → all relationals false
    { fn: "lt", a: NaN, b: 1 },
    { fn: "gt", a: NaN, b: 1 },
    // null / undefined coercion
    { fn: "lt", a: null, b: 1 },
    { fn: "le", a: null, b: 0 },
  ];

  it("matches Node for any/any relational comparisons", async () => {
    const wasm = await compileToWasm(src);
    const js = evaluateAsJs(src);
    for (const { fn, a, b } of cases) {
      const w = wasm[fn]!(a, b);
      const j = js[fn]!(a, b);
      // wasm returns i32 (0/1); js returns boolean — normalize.
      expect(!!w, `${fn}(${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBe(!!j);
    }
  });
});
