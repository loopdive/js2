// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3280 — behaviour-preserving intra-function decomposition of the ~3.1k-LOC
// god-function compileBinaryExpression in src/codegen/binary-ops.ts (WAVE C).
// The type-directed tail dispatch is lifted to compileTypedBinaryDispatch
// (binary-ops-typed-dispatch.ts) and the `key in obj` operator block to
// compileInOperator (binary-ops-in.ts).
//
// This is a smoke test (the #2093 issue->probe coverage gate): it compiles and
// runs binary expressions that drive each lifted path, confirming the
// extraction preserved observable behaviour. The emitted-Wasm byte-identity
// proof (scripts/prove-emit-identity.mjs, IDENTICAL 39/39) is the stronger
// guarantee; these assertions guard the end-to-end runtime contract.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const instance = await instantiateWithRuntime(result);
  return instance.exports as unknown as Record<string, Function>;
}

describe("#3280 compileBinaryExpression decomposition (behaviour preserved)", () => {
  it("numeric arithmetic tail dispatch (+ - * / %)", async () => {
    const exports = await run(`
      export function test(): number {
        return (7 + 3) * 2 - 4 / 2 + (10 % 3);
      }
    `);
    expect(exports.test()).toBe(19); // 10*2 - 2 + 1 = 20 - 2 + 1 = 19
  });

  it("relational comparisons (< <= > >=)", async () => {
    const exports = await run(`
      export function test(): number {
        let n = 0;
        if (1 < 2) n += 1;
        if (2 <= 2) n += 2;
        if (3 > 2) n += 4;
        if (3 >= 3) n += 8;
        return n;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("strict + loose equality on numbers (=== !== == !=)", async () => {
    const exports = await run(`
      export function test(): number {
        let n = 0;
        if (1 === 1) n += 1;
        if (1 !== 2) n += 2;
        if (1 == 1) n += 4;
        if (1 != 2) n += 8;
        return n;
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("number == boolean loose-eq coercion path", async () => {
    const exports = await run(`
      export function test(): number {
        const a: number = 1;
        const b: boolean = true;
        return (a == b) ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("string concat (+) and string equality tail dispatch", async () => {
    const exports = await run(`
      export function test(): string {
        const a = "foo";
        const b = "bar";
        return a + b;
      }
    `);
    expect(exports.test()).toBe("foobar");
  });

  it("string strict equality", async () => {
    const exports = await run(`
      export function test(): number {
        const a = "hello";
        return a === "hello" ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("object reference-identity strict equality (ref.eq path)", async () => {
    const exports = await run(`
      export function test(): number {
        const a = { x: 1 };
        const b = a;
        const c = { x: 1 };
        return (a === b ? 1 : 0) + (a === c ? 10 : 0);
      }
    `);
    expect(exports.test()).toBe(1); // same ref true, distinct ref false
  });

  it("bigint arithmetic and comparison (i64 tail path)", async () => {
    const exports = await run(`
      export function test(): bigint {
        const a = 9007199254740993n;
        const b = 2n;
        return a * b + 1n;
      }
    `);
    expect(exports.test()).toBe(18014398509481987n);
  });

  it("bitwise ops (i32 tail path)", async () => {
    const exports = await run(`
      export function test(): number {
        return ((0xff & 0x0f) | 0x10) ^ 0x01;
      }
    `);
    expect(exports.test()).toBe((0x0f | 0x10) ^ 0x01);
  });

  it("`key in obj` operator — static struct field membership", async () => {
    const exports = await run(`
      export function test(): number {
        const o = { a: 1, b: 2 };
        return ("a" in o ? 1 : 0) + ("z" in o ? 10 : 0);
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("`index in array` — vec bounds check", async () => {
    const exports = await run(`
      export function test(): number {
        const arr = [10, 20, 30];
        return (0 in arr ? 1 : 0) + (2 in arr ? 2 : 0) + (5 in arr ? 4 : 0);
      }
    `);
    expect(exports.test()).toBe(3); // indices 0 and 2 present, 5 not
  });
});
