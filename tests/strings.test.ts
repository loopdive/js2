import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

describe("string support", () => {
  it("string parameter passes as externref", async () => {
    const result = await compile(`
      export function greet(name: string): string {
        return name;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    // Function should take and return externref
    expect(result.wat).toContain("externref");
  });

  it("string literal compiles and returns its value through the runtime", async () => {
    const result = await compile(`
      export function hello(): string {
        return "world";
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    // Strings are native by default since #6708 S6 (612cea9864: semanticProviders
    // defaults to native-first), so the host-only string_constants import and
    // stringPool shape no longer exist; assert the observable string instead.
    const exports = (await instantiateWithRuntime(result)).exports as any;
    expect(exports.hello()).toBe("world");
  });

  it("string concatenation compiles and concatenates through the runtime", async () => {
    const result = await compile(`
      export function greet(name: string): string {
        return "Hello, " + name;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    // Native strings by default since #6708 S6 (612cea9864); the literal no longer
    // lands in the host stringPool, so assert the concatenated result instead.
    const exports = (await instantiateWithRuntime(result)).exports as any;
    expect(exports.greet("there")).toBe("Hello, there");
  });

  it("string equality uses wasm:js-string equals", async () => {
    const result = await compile(`
      export function isHello(s: string): boolean {
        return s === "hello";
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    expect(result.wat).toContain("equals");
  });

  it("console.log with string uses console_log_string", async () => {
    const result = await compile(`
      export function test(): void {
        console.log("hello");
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    expect(result.wat).toContain("console_log_string");
  });

  it("string literal runs end-to-end with polyfill", async () => {
    const result = await compile(`
      export function hello(): string {
        return "world";
      }
    `);
    expect(result.success).toBe(true);

    const exports = (await instantiateWithRuntime(result)).exports as any;
    expect(exports.hello()).toBe("world");
  });

  it("string concat runs end-to-end with polyfill", async () => {
    const result = await compile(`
      export function greet(name: string): string {
        return "Hello, " + name;
      }
    `);
    expect(result.success).toBe(true);

    const exports = (await instantiateWithRuntime(result)).exports as any;
    expect(exports.greet("World")).toBe("Hello, World");
  });
});
