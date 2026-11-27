// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3266 (subtask of #3182): smoke test for the operator-assignment subsystem after
// its verbatim extraction out of assignment.ts into operator-assignment.ts. This
// exercises the moved entry points — compileCompoundAssignment (+= -= *= &= >>= and
// the string += fast path), compileLogicalAssignment (&&= ||= ??=), and the property/
// element compound paths — through their external callers (binary-ops / expressions /
// unary-updates), which the split repointed to the new module. The primary acceptance
// proof is byte-identity (scripts/prove-emit-identity.mjs, IDENTICAL 39/39); this file
// is the required permanent probe reference (#2093 gate) and a behaviour sanity net.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, Function>)[fn]!(...args);
}

describe("#3266 operator-assignment split — compound assignment", () => {
  it("numeric compound ops on a local (+= -= *= &= >>=)", async () => {
    const src = `
      export function test(): number {
        let x = 10;
        x += 5;    // 15
        x -= 3;    // 12
        x *= 4;    // 48
        x &= 60;   // 48 & 60 = 48
        x >>= 2;   // 12
        return x;
      }
    `;
    expect(await run(src, "test")).toBe(12);
  });

  it("string compound += fast path", async () => {
    const src = `
      export function test(): string {
        let s = "ab";
        s += "cd";
        s += "e";
        return s;
      }
    `;
    expect(await run(src, "test")).toBe("abcde");
  });

  it("property compound assignment", async () => {
    const src = `
      export function test(): number {
        const o = { n: 7 };
        o.n += 3;   // 10
        o.n *= 2;   // 20
        return o.n;
      }
    `;
    expect(await run(src, "test")).toBe(20);
  });

  it("element compound assignment on an array", async () => {
    const src = `
      export function test(): number {
        const a = [1, 2, 3];
        a[1] += 10;   // 12
        a[2] *= 5;    // 15
        return a[1] + a[2];
      }
    `;
    expect(await run(src, "test")).toBe(27);
  });
});

describe("#3266 operator-assignment split — logical assignment", () => {
  it("||= assigns only when falsy", async () => {
    const src = `
      export function test(): number {
        let x = 0;
        x ||= 5;   // 5 (0 is falsy)
        x ||= 9;   // 5 (5 is truthy — no assign)
        return x;
      }
    `;
    expect(await run(src, "test")).toBe(5);
  });

  it("&&= assigns only when truthy", async () => {
    const src = `
      export function test(): number {
        let x = 3;
        x &&= 8;   // 8 (3 is truthy)
        return x;
      }
    `;
    expect(await run(src, "test")).toBe(8);
  });

  it("??= assigns only when null/undefined", async () => {
    const src = `
      export function test(): number {
        let x: number | undefined = undefined;
        x ??= 42;  // 42
        x ??= 7;   // 42 (already defined)
        return x;
      }
    `;
    expect(await run(src, "test")).toBe(42);
  });
});
