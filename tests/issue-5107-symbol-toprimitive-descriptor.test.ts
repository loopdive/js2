// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5107 — standalone Symbol.prototype[Symbol.toPrimitive] own descriptor.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const EXACT_ROW = "built-ins/Symbol/prototype/Symbol.toPrimitive/prop-desc.js";
const hasTest262Corpus = existsSync(join(process.cwd(), "test262/harness/assert.js"));
const corpusIt = hasTest262Corpus ? it : it.skip;

const CONTROL_SOURCE = `
  export function test(): number {
    const proto: any = Symbol.prototype;
    const key: any = Symbol.toPrimitive;
    const first: any = proto[key];
    const second: any = proto[key];
    const descriptor: any = Object.getOwnPropertyDescriptor(proto, key);
    const hasOwn = Object.prototype.hasOwnProperty.call(proto, key);
    const enumerable = Object.prototype.propertyIsEnumerable.call(proto, key);
    return typeof first === "function" &&
      first === second &&
      descriptor !== undefined &&
      descriptor.value === first &&
      first.name === "[Symbol.toPrimitive]" &&
      first.length === 1 &&
      descriptor.writable === false &&
      descriptor.enumerable === false &&
      descriptor.configurable === true &&
      hasOwn &&
      !enumerable ? 1 : 0;
  }
`;

const MUTATION_SOURCE = `
  export function test(): number {
    const proto: any = Symbol.prototype;
    const key: any = Symbol.toPrimitive;
    const original: any = proto[key];
    const replacement: any = function replacement() { return 1; };
    let writeBlocked = false;
    try {
      proto[key] = replacement;
      writeBlocked = proto[key] === original;
    } catch {
      writeBlocked = proto[key] === original;
    }
    const descriptorBeforeDelete: any = Object.getOwnPropertyDescriptor(proto, key);
    const deleted = delete proto[key];
    const descriptorAfterDelete: any = Object.getOwnPropertyDescriptor(proto, key);
    const absent = !Object.prototype.hasOwnProperty.call(proto, key) &&
      descriptorAfterDelete === undefined &&
      proto[key] === undefined;
    return writeBlocked &&
      descriptorBeforeDelete !== undefined &&
      descriptorBeforeDelete.value === original &&
      deleted &&
      absent ? 1 : 0;
  }
`;

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5107-symbol-toprimitive-descriptor.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  expect(
    WebAssembly.Module.imports(await WebAssembly.compile(result.binary)),
    "standalone must stay host-free",
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#5107 standalone Symbol.prototype[Symbol.toPrimitive] descriptor", () => {
  corpusIt("passes the exact Test262 host row", async () => {
    const result = await runTest262File(join("test262/test", EXACT_ROW), "issue-5107", 120_000);
    expect(result.status, `${result.file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  corpusIt("passes the exact Test262 standalone row", async () => {
    const result = await runTest262File(join("test262/test", EXACT_ROW), "issue-5107", 120_000, "standalone");
    expect(result.status, `${result.file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it("exposes the identity-stable function and exact own descriptor", async () => {
    await expect(runStandalone(CONTROL_SOURCE)).resolves.toBe(1);
  });

  it("blocks replacement but observes configurable deletion through all own views", async () => {
    await expect(runStandalone(MUTATION_SOURCE)).resolves.toBe(1);
  });
});
