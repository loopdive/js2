// #4742 — Array.prototype exposes the intrinsic @@iterator method.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

const EXACT = resolve("test262/test/built-ins/Array/prototype/Symbol.iterator.js");
const NOT_CONSTRUCTOR = resolve("test262/test/built-ins/Array/prototype/Symbol.iterator/not-a-constructor.js");

describe("#4742 Array.prototype Symbol.iterator", () => {
  it("passes the exact Test262 row in standalone mode", async () => {
    const result = await runTest262File(EXACT, "issue-4742-standalone", 60_000, "standalone");
    expect(result.status, result.error ?? result.reason).toBe("pass");
  }, 120_000);

  it("preserves the host intrinsic identity and descriptor", async () => {
    const result = await compile(`export function test(): number {
      const d = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
      return Array.prototype[Symbol.iterator] === Array.prototype.values &&
        d.value === Array.prototype.values && d.writable && !d.enumerable && d.configurable ? 1 : 0;
    }`);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });

  it("keeps the intrinsic iterator method non-constructible", async () => {
    const result = await runTest262File(NOT_CONSTRUCTOR, "issue-4742-not-constructor", 60_000, "standalone");
    expect(result.status, result.error ?? result.reason).toBe("pass");
  }, 120_000);
});
