import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// Nested (no-capture) function declarations must resolve self-recursion and
// forward-sibling / mutual references to a direct call, not the
// unknown-identifier `ref.null.extern` fallback (→ 0). (#2068)
describe("nested function self-recursion and forward references (#2068)", () => {
  it("self-recursion: fact(5) = 120", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
        return fact(5);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("forward sibling reference: a() calls b() declared later", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        function a(n: number): number { return b(n) + 1; }
        function b(n: number): number { return n * 2; }
        return a(10);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("mutual recursion: isEven / isOdd", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        function isEven(n: number): boolean { return n === 0 ? true : isOdd(n - 1); }
        function isOdd(n: number): boolean { return n === 0 ? false : isEven(n - 1); }
        return isEven(4) + "," + isOdd(4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("three mutually-recursive nested siblings", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        function a(n: number): number { return n <= 0 ? 0 : b(n - 1) + 1; }
        function b(n: number): number { return n <= 0 ? 0 : c(n - 1) + 1; }
        function c(n: number): number { return n <= 0 ? 0 : a(n - 1) + 1; }
        return a(9);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("recursion still works alongside a capturing nested function", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const base = 2;
        function pow(n: number): number { return n <= 0 ? 1 : base * pow(n - 1); }
        function fact(n: number): number { return n <= 1 ? 1 : n * fact(n - 1); }
        return pow(5) + fact(4);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
