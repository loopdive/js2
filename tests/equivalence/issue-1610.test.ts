import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("#1610 for-of over non-array iterables", () => {
  it("array fast path still works", async () => {
    await assertEquivalent(
      `export function test(): number {
        let sum = 0;
        for (const x of [1, 2, 3]) sum += x;
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of over Set", async () => {
    await assertEquivalent(
      `export function test(): number {
        const s = new Set<number>();
        s.add(1); s.add(2); s.add(3);
        let sum = 0;
        for (const x of s) sum += x;
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of over a custom Symbol.iterator object", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = {
          [Symbol.iterator]() {
            let i = 0;
            return {
              next() {
                return i < 3
                  ? { value: i++, done: false }
                  : { value: undefined, done: true };
              },
            };
          },
        };
        let sum = 0;
        for (const x of obj) sum += x as number;
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("for-of over a generator result", async () => {
    await assertEquivalent(
      `function* gen(): Generator<number> { yield 5; yield 7; }
      export function test(): number {
        let sum = 0;
        for (const x of gen()) sum += x;
        return sum;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
