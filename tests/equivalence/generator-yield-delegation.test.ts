import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("generator yield* delegation", () => {
  it("yield* delegates to another generator and main yields surround it", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* inner() { yield 1; yield 2; }
        function* outer() { yield 0; yield* inner(); yield 3; }
        let s = 0;
        for (const v of outer()) s += v;
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("yield* delegates multiple times in a single outer generator", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* a() { yield 1; yield 2; }
        function* b() { yield* a(); yield 3; yield* a(); }
        let s = 0;
        for (const v of b()) s += v;
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("yield* delegates to an inline array literal", async () => {
    await assertEquivalent(
      `export function test(): number {
        function* g() { yield* [4, 5, 6]; }
        let s = 0;
        for (const v of g()) s += v;
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("yield* preserves order across delegation boundary", async () => {
    await assertEquivalent(
      `export function test(): string {
        function* a() { yield 1; yield 2; }
        function* b() { yield 0; yield* a(); yield 3; }
        let s = "";
        for (const v of b()) s += String(v);
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
