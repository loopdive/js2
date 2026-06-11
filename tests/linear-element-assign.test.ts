// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1938 (part 1) — an element assignment used as an expression evaluated the
// RHS twice: once to store, once to leave the value on the stack as the
// expression result. So `arr[i] = f()` called `f()` twice, observable with any
// side-effecting RHS. The fix compiles the RHS into a scratch local, stores
// from the local, and leaves the local as the expression value (one eval).
//
// (Part 2 — `number[]` storing i32 elements so `[1.5][0]` → 1 — is a separate
// representation change tracked in the issue; not covered here.)
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileLinear(source: string) {
  const result = await compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, (...args: number[]) => number>;
}

describe("linear element-assignment evaluates RHS once (#1938)", () => {
  it("number[] element assignment calls a side-effecting RHS exactly once", async () => {
    const e = await compileLinear(`
      let calls: number = 0;
      function side(): number {
        calls += 1;
        return calls;
      }
      export function f(): number {
        let arr: number[] = [0, 0, 0];
        arr[0] = side();
        return calls;
      }
    `);
    expect(e.f()).toBe(1);
  });

  it("number[] element assignment stores the value once and returns it", async () => {
    const e = await compileLinear(`
      let calls: number = 0;
      function side(): number {
        calls += 1;
        return 99;
      }
      export function f(): number {
        let arr: number[] = [0, 0, 0];
        // assignment-as-expression: value flows into x, RHS must run once
        let x: number = (arr[1] = side());
        // x (99) + calls (1) = 100
        return x + calls;
      }
    `);
    expect(e.f()).toBe(100);
  });

  it("number[] element assignment used purely as a statement runs RHS once", async () => {
    const e = await compileLinear(`
      let calls: number = 0;
      function side(): number {
        calls += 1;
        return 5;
      }
      export function f(): number {
        let arr: number[] = [0, 0];
        arr[0] = side();
        arr[1] = side();
        return calls;
      }
    `);
    expect(e.f()).toBe(2);
  });

  it("Uint8Array element assignment calls a side-effecting RHS exactly once", async () => {
    const e = await compileLinear(`
      let calls: number = 0;
      function side(): number {
        calls += 1;
        return 7;
      }
      export function f(): number {
        let u: Uint8Array = new Uint8Array(3);
        u[0] = side();
        return calls;
      }
    `);
    expect(e.f()).toBe(1);
  });

  it("Uint8Array element assignment returns the assigned (untruncated) value", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let u: Uint8Array = new Uint8Array(3);
        // The store truncates to a byte (300 & 0xff = 44) but the assignment
        // expression yields the original 300 — verify the expression value.
        let v: number = (u[0] = 300);
        return v;
      }
    `);
    expect(e.f()).toBe(300);
  });

  it("the stored Uint8Array byte is the truncated value (read-back)", async () => {
    const e = await compileLinear(`
      export function f(): number {
        let u: Uint8Array = new Uint8Array(3);
        u[0] = 300;
        return u[0];
      }
    `);
    // 300 & 0xff = 44
    expect(e.f()).toBe(44);
  });
});
