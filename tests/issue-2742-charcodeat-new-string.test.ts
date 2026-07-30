// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2742 new String(value) standalone ToString coercion", () => {
  it("charCodeAt reads the decimal text of a numeric wrapper", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          return new String(42).charCodeAt(function () {}());
        }
      `),
    ).toBe(52);
  });

  it("stores string data for boolean and null inputs", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a = new String(true);
          const b = new String(null);
          return a.charCodeAt(0) * 1000 + b.charCodeAt(0);
        }
      `),
    ).toBe(116110);
  });

  it("runs object ToString before storing the wrapper data", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const value: any = {
            toString() {
              return "xy";
            }
          };
          return new String(value).charCodeAt(0);
        }
      `),
    ).toBe(120);
  });

  it("preserves already-string and omitted values", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a = new String("A");
          const b = new String();
          return a.charCodeAt(0) + b.length;
        }
      `),
    ).toBe(65);
  });

  it("throws TypeError for a Symbol input", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          try {
            new String(Symbol("x"));
            return 0;
          } catch (error) {
            return error instanceof TypeError ? 1 : 2;
          }
        }
      `),
    ).toBe(1);
  });
});
