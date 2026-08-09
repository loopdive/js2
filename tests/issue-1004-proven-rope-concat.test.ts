// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1004 follow-up — when a concat RHS has a compile-time length at least the
 * native 64-code-unit rope threshold, emit the ConsString construction
 * directly. The general helper would re-read both lengths and branch on a
 * threshold whose outcome is already proven.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const FLAG = "JS2WASM_NATIVE_PROVEN_ROPE_CONCAT";

async function compileNative(source: string, enabled = true) {
  const previous = process.env[FLAG];
  try {
    if (enabled) delete process.env[FLAG];
    else process.env[FLAG] = "0";
    const result = await compile(source, {
      fileName: "proven-rope.ts",
      fast: true,
      target: "gc",
      optimize: 0,
      emitWat: true,
    });
    expect(result.success, result.errors?.map((error) => error.message).join("\n")).toBe(true);
    return result;
  } finally {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  }
}

async function instantiate(binary: Uint8Array): Promise<WebAssembly.Exports> {
  const module = await WebAssembly.compile(binary);
  return (await WebAssembly.instantiate(module, {})).exports;
}

function hasDirectRopeLocals(wat: string | undefined): boolean {
  return wat?.includes("$__rope_rhs_") === true && wat.includes("$__rope_lhs_");
}

describe("#1004 proven native rope concat", () => {
  it("specializes a const alias initialized by repeat and matches the generic helper", async () => {
    const source = `
      export function run(): number {
        const chunk = "x".repeat(1024);
        let value = "";
        for (let i = 0; i < 1000; i = i + 1) value = value + chunk;
        return value.length + value.charCodeAt(1023);
      }
    `;
    const specialized = await compileNative(source);
    const generic = await compileNative(source, false);
    expect(hasDirectRopeLocals(specialized.wat)).toBe(true);
    expect(hasDirectRopeLocals(generic.wat)).toBe(false);

    const specializedExports = await instantiate(specialized.binary);
    const genericExports = await instantiate(generic.binary);
    expect((specializedExports.run as () => number)()).toBe(1_024_000 + 120);
    expect((genericExports.run as () => number)()).toBe(1_024_000 + 120);
  });

  it("uses UTF-16 code-unit length and honors the exact 64-unit boundary", async () => {
    const atThreshold = await compileNative(`
      export function run(): number {
        const chunk = "😀".repeat(32);
        return ("prefix" + chunk).length;
      }
    `);
    const belowThreshold = await compileNative(`
      export function run(): number {
        const chunk = "x".repeat(63);
        return ("prefix" + chunk).length;
      }
    `);
    expect(hasDirectRopeLocals(atThreshold.wat)).toBe(true);
    expect(hasDirectRopeLocals(belowThreshold.wat)).toBe(false);
    expect(((await instantiate(atThreshold.binary)).run as () => number)()).toBe(70);
    expect(((await instantiate(belowThreshold.binary)).run as () => number)()).toBe(69);
  });

  it("does not specialize a mutable alias or an invalid repeat count", async () => {
    const mutable = await compileNative(`
      export function run(): number {
        let chunk = "x".repeat(64);
        chunk = "y";
        return ("prefix" + chunk).length;
      }
    `);
    const invalid = await compileNative(`
      export function run(): number {
        const chunk = "x".repeat(-1);
        return ("prefix" + chunk).length;
      }
    `);
    const dynamicReceiver = await compileNative(`
      export function run(): number {
        const chunk = ("x" as any).repeat(64);
        return ("prefix" + chunk).length;
      }
    `);
    expect(hasDirectRopeLocals(mutable.wat)).toBe(false);
    expect(hasDirectRopeLocals(invalid.wat)).toBe(false);
    expect(hasDirectRopeLocals(dynamicReceiver.wat)).toBe(false);
    expect(((await instantiate(mutable.binary)).run as () => number)()).toBe(7);
  });
});
