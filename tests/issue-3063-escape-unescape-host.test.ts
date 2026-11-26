import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// #3063 — legacy global escape() / unescape() (§B.2.1 / §B.2.2) had no codegen
// lowering and silently returned undefined. JS-host mode now registers an
// env.escape / env.unescape host import that delegates to the native JS globals,
// mirroring the encodeURI / encodeURIComponent machinery.
async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#3063 host-mode escape / unescape", () => {
  it("escape encodes a space to %20", async () => {
    expect(await run(`export function test(): string { return escape("a b"); }`)).toBe("a%20b");
  });

  it("escape leaves the unescaped set unchanged", async () => {
    expect(await run(`export function test(): string { return escape("@*_+-./"); }`)).toBe("@*_+-./");
  });

  it("escape emits %uXXXX for code units >= 256", async () => {
    expect(await run(`export function test(): string { return escape("\\u0100"); }`)).toBe("%u0100");
  });

  it("escape emits %XX for a code unit < 256", async () => {
    expect(await run(`export function test(): string { return escape("~"); }`)).toBe("%7E");
  });

  it("unescape decodes %41 to A", async () => {
    expect(await run(`export function test(): string { return unescape("%41"); }`)).toBe("A");
  });

  it("unescape decodes %u0041 to A", async () => {
    expect(await run(`export function test(): string { return unescape("%u0041"); }`)).toBe("A");
  });

  it("unescape leaves a non-hex escape literal", async () => {
    expect(await run(`export function test(): string { return unescape("%zz"); }`)).toBe("%zz");
  });

  it("unescape(escape(s)) round-trips", async () => {
    expect(await run(`export function test(): string { return unescape(escape("Hello, World! \\u00e9")); }`)).toBe(
      "Hello, World! é",
    );
  });

  it("does not shadow a user-declared escape function", async () => {
    expect(
      await run(
        `function escape(x: number): number { return x + 1; } export function test(): number { return escape(41); }`,
      ),
    ).toBe(42);
  });
});
