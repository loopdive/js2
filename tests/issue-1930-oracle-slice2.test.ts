// (#1930 Slice 2) TypeOracle mechanical fold — guards that the codegen call
// sites migrated from `isSymbolType(ctx.checker.getTypeAtLocation(x))` onto
// `ctx.oracle.staticJsTypeOf(x) === "symbol"` still fire the Symbol → number
// throw (§7.1.4 ToNumber(Symbol) throws TypeError) through the boundary.
//
// The migration is proven byte-diff-neutral on the broad corpus (see the PR
// body); these are the scoped behavioural guards for the specific sites:
//   - binary-ops.ts        symbol operand of a to-numeric binary op
//   - expressions/new-super.ts   `new Number(Symbol())`
//   - expressions/calls.ts       `Number(Symbol())`
//   - expressions/builtins.ts    `Math.abs(Symbol())` (Math.* numeric arg)
//   - expressions/unary-updates.ts  `sym++` / prefix update on a symbol

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function runTest(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "t.ts" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

/** Wraps `body` in a try/catch harness returning "threw:<msg>" or "ok:<v>". */
function harness(body: string): string {
  return `// @ts-nocheck
export function test() {
  var s = Symbol("k");
  try {
${body}
  } catch (e) {
    return "threw:" + (e && e.message ? e.message : e);
  }
}
`;
}

describe("#1930 TypeOracle Slice 2 — symbol-fold call sites", () => {
  it("Number(Symbol()) throws through the oracle (calls.ts)", async () => {
    const v = await runTest(harness(`    var n = Number(s); return "ok:" + n;`));
    expect(v).toBe("threw:Cannot convert a Symbol value to a number");
  });

  it("new Number(Symbol()) throws through the oracle (new-super.ts)", async () => {
    const v = await runTest(harness(`    var n = new Number(s); return "ok:" + n;`));
    expect(v).toBe("threw:Cannot convert a Symbol value to a number");
  });

  it("Math.abs(Symbol()) throws through the oracle (builtins.ts)", async () => {
    const v = await runTest(harness(`    var n = Math.abs(s); return "ok:" + n;`));
    expect(String(v)).toMatch(/^threw:/);
    expect(String(v)).toContain("Symbol");
  });

  it("a to-numeric binary op on a symbol throws through the oracle (binary-ops.ts)", async () => {
    const v = await runTest(harness(`    var n = s - 1; return "ok:" + n;`));
    expect(String(v)).toMatch(/^threw:/);
  });

  it("a prefix update on a symbol throws through the oracle (unary-updates.ts)", async () => {
    const v = await runTest(harness(`    var n = --s; return "ok:" + n;`));
    expect(String(v)).toMatch(/^threw:/);
  });
});
