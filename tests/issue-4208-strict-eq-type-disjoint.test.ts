// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4208 S1 — §7.2.16 IsStrictlyEqual step 1 for Number ⊥ Boolean.
 *
 * Every case here is RED on the pre-fix compiler (`1 === true` answered `true`)
 * except the ones named `keeps …`, which are the two-sided control: pairs that
 * must NOT fold, proving the guard is not simply "return false for `===`".
 *
 * The controls are load-bearing. `false` is the answer the fold produces, so a
 * suite of only-disjoint cases would also pass a broken implementation that
 * folded every strict comparison. `keeps-number-number-equal` and
 * `keeps-length-vs-number` are the ones that would catch it: the second is the
 * exact shape (`string.length:i32` vs `8:f64`) the i32↔f64 promotion this fold
 * runs in front of was originally written for, so it also pins the ORDER.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Returns the comparison's truthiness as `1`/`0`. A boolean is read back as a
 * number deliberately: standalone `nativeStrings` hands a `String(...)` result
 * back as a Wasm struct, so a string-returning probe reads `{}` for every case
 * and would go green-on-nothing exactly the way a vacuous fixture does.
 */
async function evalStandalone(body: string): Promise<number> {
  const source = `${body}\nexport function probe(): number { return __r ? 1 : 0; }\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4208.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "always",
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, result.importObject ?? {});
  const exports = instance.exports as Record<string, Function>;
  return exports.probe!() as number;
}

const TRUE = 1;
const FALSE = 0;

describe("#4208 S1 — === decides Type() before the f64 slot merges Number and Boolean", () => {
  const disjoint: [string, string][] = [
    ["number literal vs boolean literal", "var __r = (1 === true);"],
    ["boolean literal vs number literal", "var __r = (true === 1);"],
    ["zero vs false", "var __r = (0 === false);"],
    ["false vs zero", "var __r = (false === 0);"],
    ["number local vs boolean local", "var a = 1; var b = true; var __r = (a === b);"],
    ["boolean local vs number local", "var a = true; var b = 1; var __r = (a === b);"],
    ["computed number vs boolean", "var a = 0; a = a + 1; var b = true; var __r = (a === b);"],
  ];
  for (const [name, body] of disjoint) {
    it(`${name} is false`, async () => {
      expect(await evalStandalone(body)).toBe(FALSE);
    });
  }

  const disjointNeq: [string, string][] = [
    ["number vs boolean", "var __r = (1 !== true);"],
    ["boolean vs number", "var __r = (true !== 1);"],
    ["locals", "var a = 0; var b = false; var __r = (a !== b);"],
  ];
  for (const [name, body] of disjointNeq) {
    it(`!== on ${name} is true`, async () => {
      expect(await evalStandalone(body)).toBe(TRUE);
    });
  }

  // ── Two-sided control: these must NOT fold ────────────────────────────────
  it("keeps-number-number-equal — same-Type() operands still compare by value", async () => {
    expect(await evalStandalone("var a = 1; var b = 1; var __r = (a === b);")).toBe(TRUE);
    expect(await evalStandalone("var a = 1; var b = 2; var __r = (a === b);")).toBe(FALSE);
  });

  it("keeps-boolean-boolean-equal — same-Type() operands still compare by value", async () => {
    expect(await evalStandalone("var a = true; var b = true; var __r = (a === b);")).toBe(TRUE);
    expect(await evalStandalone("var a = true; var b = false; var __r = (a === b);")).toBe(FALSE);
  });

  it("keeps-length-vs-number — the i32↔f64 promotion this fold precedes still runs", async () => {
    // `"abcdefgh".length` is an i32 with a *number* static type. Reading i32 as
    // "Boolean" would fold this to false; the promotion must still fire.
    expect(await evalStandalone('var __r = ("abcdefgh".length === 8);')).toBe(TRUE);
    expect(await evalStandalone('var __r = ("abcdefgh".length === 7);')).toBe(FALSE);
  });

  it("keeps-loose-equality — 1 == true is genuinely true (§7.2.13 applies ToNumber)", async () => {
    expect(await evalStandalone("var __r = (1 == true);")).toBe(TRUE);
    expect(await evalStandalone("var __r = (0 != false);")).toBe(FALSE);
  });

  it("stores a Number when `++`/`--` updates a Boolean-initialized binding", async () => {
    // §13.4: `x--` is `x = ToNumeric(x) - 1`, so `x` holds a Number afterwards
    // however TypeScript typed the initializer. #4208 S2 therefore gives the
    // binding dynamic storage; strict equality now observes the real Number
    // rather than relying on a Boolean-only fold suppression.
    expect(await evalStandalone("var x = true; x--; var __r = (x !== 0);")).toBe(FALSE);
    expect(await evalStandalone("var x = true; --x; var __r = (x === 1 - 1);")).toBe(TRUE);
    // An unrelated Boolean in the same scope still folds against Number.
    expect(await evalStandalone("var x = true; x--; var b = false; var n = 0; var __r = (b === n);")).toBe(FALSE);
  });

  it("keeps-any-typed-operand — a boxed operand is compared at runtime, not folded", async () => {
    // `a` is `any`, so it is boxed and carries a tag; the fold must decline and
    // let the tag-aware comparison answer. Boxed 1 === 1 is still true.
    expect(await evalStandalone("var a: any = 1; var b = 1; var __r = (a === b);")).toBe(TRUE);
  });
});
