import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// #2109 — BigInt mixed loose-equality against a string must use ToNumber
// (§7.1.4 StringToNumber via `Number()`), NOT `parseFloat`. `parseFloat`
// accepts trailing garbage and rejects the 0x/0o/0b and empty-string forms:
//   parseFloat("10abc") === 10   → `10n == "10abc"` wrongly true
//   parseFloat("0x10")  === 0    → `16n == "0x10"`  wrongly false
// The bug only surfaced when the module ALSO used `parseFloat` elsewhere,
// which registered it in `funcMap` so the BigInt⇄String path grabbed it.
// The `forcePF` export below forces that registration to reproduce it.
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as any)[fn](...args);
}

const SRC = `
  // Forces parseFloat into funcMap — the pre-fix trigger for the bug.
  export function forcePF(t: string): number { return parseFloat(t); }
  export function eq(s: string): boolean { const x: bigint = 10n; return x == s; }
  export function eq16(s: string): boolean { const x: bigint = 16n; return x == s; }
  export function ne(s: string): boolean { const x: bigint = 10n; return x != s; }
`;

describe("#2109 BigInt ⇄ String loose equality uses ToNumber, not parseFloat", () => {
  it('rejects trailing garbage: 10n == "10abc" is false', async () => {
    // A boolean export marshals across the raw wasm ABI as an i32 0/1.
    expect(await run(SRC, "eq", ["10abc"])).toBe(0);
  });

  it('accepts hex forms: 16n == "0x10" is true', async () => {
    expect(await run(SRC, "eq16", ["0x10"])).toBe(1);
  });

  it('plain integer string: 10n == "10" is true', async () => {
    expect(await run(SRC, "eq", ["10"])).toBe(1);
  });

  it('empty string coerces to 0: 10n == "" is false', async () => {
    // Number("") === 0, so 10n == "" is false (parseFloat("") === NaN would
    // also give false here, but Number is the spec-correct path).
    expect(await run(SRC, "eq", [""])).toBe(0);
  });

  it('decimal string never numerically equals a different integer: 10n == "10.5" is false', async () => {
    expect(await run(SRC, "eq", ["10.5"])).toBe(0);
  });

  it('!= mirrors ==: 10n != "10abc" is true', async () => {
    expect(await run(SRC, "ne", ["10abc"])).toBe(1);
  });

  it('does not break parseFloat itself: parseFloat("3.5x") === 3.5', async () => {
    expect(await run(SRC, "forcePF", ["3.5x"])).toBe(3.5);
  });
});
