// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1740 — String.prototype.padStart / padEnd with an OMITTED fillString
 * must default to a single space " " (§22.1.3.17 StringPad: if fillString is
 * undefined, set it to " ").
 *
 * In JS-host mode the string-method dispatch padded the missing `fillString`
 * externref arg with `ref.null.extern`, so the host saw JS `null`, which
 * ToString-coerces to "null" — `"abc".padStart(6)` returned "nulabc" instead
 * of "   abc". The fix passes JS `undefined` (via `__get_undefined`) for the
 * omitted pad arg, the same null-vs-undefined distinction already applied to
 * `endsWith` / `lastIndexOf`, so the host applies the spec default " ".
 *
 * test262 cases driving the fix:
 *   built-ins/String/prototype/padStart/fill-string-omitted.js
 *   built-ins/String/prototype/padStart/normal-operation.js
 *   built-ins/String/prototype/padEnd/fill-string-omitted.js
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { getTestSandbox } from "./test262-runner.js";

async function runWasm(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: getTestSandbox() });
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports.test as () => unknown)();
}

describe("#1740 — padStart/padEnd default fillString is a space", () => {
  it("padStart with omitted fill pads with spaces", async () => {
    expect(await runWasm(`export function test(): string { return "abc".padStart(6); }`)).toBe("   abc");
  });

  it("padEnd with omitted fill pads with spaces", async () => {
    expect(await runWasm(`export function test(): string { return "abc".padEnd(6); }`)).toBe("abc   ");
  });

  it("padStart with explicit fill is unchanged", async () => {
    expect(await runWasm(`export function test(): string { return "x".padStart(4, "12"); }`)).toBe("121x");
  });

  it("padEnd with explicit fill is unchanged", async () => {
    expect(await runWasm(`export function test(): string { return "x".padEnd(4, "12"); }`)).toBe("x121");
  });

  it("padStart with target <= length returns the string unchanged", async () => {
    expect(await runWasm(`export function test(): string { return "hello".padStart(3); }`)).toBe("hello");
  });

  it("padStart multi-char fill truncates to fit (omitted-fill sibling case)", async () => {
    expect(await runWasm(`export function test(): string { return "abc".padStart(7, "def"); }`)).toBe("defdabc");
  });
});
