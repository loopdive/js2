// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Standalone ES5 primitive-wrapper tail pins.
 *
 * These are the narrow source shapes behind the conformance rows fixed in the
 * primitive/error/number/boolean/date census: deleting or replacing the
 * Number prototype method, recovering Number.prototype through
 * Object.getPrototypeOf, and applying Boolean ToBoolean to an object value.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runString(body: string): Promise<string> {
  const source = `
export function length(): number { return result().length; }
export function codeUnit(index: number): number { return result().charCodeAt(index); }
function result(): string {
${body}
}
`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "es5-standalone-primitive-tail.test.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.success ? "" : result.errors?.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as unknown as {
    length(): number;
    codeUnit(index: number): number;
  };
  let value = "";
  for (let i = 0; i < exports.length(); i++) value += String.fromCharCode(exports.codeUnit(i));
  return value;
}

describe("ES5 standalone primitive-wrapper tail", () => {
  it("inherits Object.prototype.toString after deleting Number.prototype.toString", async () => {
    await expect(runString("delete Number.prototype.toString; return Number.prototype.toString();")).resolves.toBe(
      "[object Number]",
    );
    await expect(runString("delete Number.prototype.toString; return (new Number(42)).toString();")).resolves.toBe(
      "[object Number]",
    );
  });

  it("preserves an exact Number.prototype.toString override", async () => {
    await expect(
      runString("Number.prototype.toString = Object.prototype.toString; return Number.prototype.toString();"),
    ).resolves.toBe("[object Number]");
  });

  it("tags an Object.getPrototypeOf(new Number(...)) alias as Number", async () => {
    await expect(
      runString(
        "var numberProto = Object.getPrototypeOf(new Number(42)); return Object.prototype.toString.call(numberProto);",
      ),
    ).resolves.toBe("[object Number]");
  });

  it("keeps object and Symbol arguments truthy for new Boolean", async () => {
    await expect(runString("return new Boolean(new Object()).toString();")).resolves.toBe("true");
    await expect(runString("return new Boolean(Symbol()).toString();")).resolves.toBe("true");
  });
});
