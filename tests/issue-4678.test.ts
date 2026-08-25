// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4678) Standalone NamedEvaluation for anonymous function/arrow class-field
// initializers. The direct `.name` read through a class method is intentional:
// it exercises the runtime metadata path instead of only the checker fold.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<number> {
  const source = `export function test(): number { ${body} }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4678.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4678 — class-field NamedEvaluation", () => {
  it("names private and public static field initializers in declarations", async () => {
    await expect(
      runStandalone(`
        class C {
          static #privateField = () => 1;
          static publicField = function () { return 2; };
          static readPrivate() { return this.#privateField; }
        }
        return C.readPrivate().name === "#privateField" && C.publicField.name === "publicField" ? 1 : 0;
      `),
    ).resolves.toBe(1);
  });

  it("preserves the same names for class-expression static fields", async () => {
    await expect(
      runStandalone(`
        var C = class {
          static #privateField = () => 1;
          static publicField = function () { return 2; };
          static readPrivate() { return this.#privateField; }
        };
        return C.readPrivate().name === "#privateField" && C.publicField.name === "publicField" ? 1 : 0;
      `),
    ).resolves.toBe(1);
  });

  it("names private and public instance field initializers", async () => {
    await expect(
      runStandalone(`
        class C {
          #privateField = () => 1;
          publicField = function () { return 2; };
          read() {
            return this.#privateField.name === "#privateField" && this.publicField.name === "publicField" ? 1 : 0;
          }
        }
        return new C().read();
      `),
    ).resolves.toBe(1);
  });
});
