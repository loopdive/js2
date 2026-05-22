import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("iterator protocol — custom and generator-as-iterator", () => {
  it("generator returned from [Symbol.iterator]() is itself", async () => {
    await assertEquivalent(
      `export function test(): string {
        function* g() { yield 1; yield 2; yield 3; }
        const it = g();
        const same = (it as any)[Symbol.iterator]() === it;
        return same ? "yes" : "no";
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of consumes a generator via its [Symbol.iterator]() result", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* g() { yield 1; yield 2; yield 3; }
        const it = g();
        let s = 0;
        for (const v of (it as any)[Symbol.iterator]()) s += v;
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("custom iterable: object with [Symbol.iterator]() returning next-based iterator", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = {
          [Symbol.iterator]() {
            let n = 0;
            return {
              next() {
                if (n < 3) return { value: ++n, done: false };
                return { value: undefined, done: true };
              },
            };
          },
        };
        let s = 0;
        for (const v of obj as any) s += v as number;
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of over generator from named function consumes all values", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* count(n: number) { for (let i = 0; i < n; i++) yield i + 1; }
        let total = 0;
        for (const v of count(5)) total += v;
        return total;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
