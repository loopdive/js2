// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

const EXACT_ROW = "built-ins/StringIteratorPrototype/Symbol.toStringTag.js";

async function run(source: string, standalone: boolean): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-4747-string-iterator.ts",
    ...(standalone ? { target: "standalone" as const, nativeStrings: true } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

const CONTROL_SOURCE = `
  export function test(): number {
    const first: any = Object.getPrototypeOf("ab"[Symbol.iterator]());
    const second: any = Object.getPrototypeOf("xy"[Symbol.iterator]());
    const arrayProto: any = Object.getPrototypeOf([][Symbol.iterator]());
    const desc: any = Object.getOwnPropertyDescriptor(first, Symbol.toStringTag);
    if (first !== second || first === arrayProto) return 1;
    if (first[Symbol.toStringTag] !== "String Iterator") return 2;
    if (
      desc === undefined ||
      desc.value !== "String Iterator" ||
      desc.writable !== false ||
      desc.enumerable !== false ||
      desc.configurable !== true
    ) return 3;
    if (Object.prototype.toString.call("z"[Symbol.iterator]()) !== "[object String Iterator]") return 4;
    return 0;
  }
`;

describe("#4747 StringIteratorPrototype Symbol.toStringTag", () => {
  it("passes the exact Test262 row in the host lane", { timeout: 180_000 }, async () => {
    const result = await runTest262File(resolve("test262/test", EXACT_ROW), "issue-4747-host", 120_000);
    expect(result.status, result.error ?? result.reason).toBe("pass");

    // The exact row's configurable-property probe must not leak into the
    // strict rerun or subsequent in-process tests.
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(""[Symbol.iterator]()), Symbol.toStringTag);
    expect(desc).toEqual({
      value: "String Iterator",
      writable: false,
      enumerable: false,
      configurable: true,
    });
  });

  it("passes the exact Test262 row in standalone", { timeout: 180_000 }, async () => {
    const result = await runTest262File(
      resolve("test262/test", EXACT_ROW),
      "issue-4747-standalone",
      120_000,
      "standalone",
    );
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  it("keeps StringIteratorPrototype identity, descriptor, and tag distinct from arrays", async () => {
    await expect(run(CONTROL_SOURCE, true)).resolves.toBe(0);
  });

  it("preserves the host's native StringIteratorPrototype control", async () => {
    await expect(run(CONTROL_SOURCE, false)).resolves.toBe(0);
  });
});
