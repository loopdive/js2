import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// #1658: a missing optional function-parameter default was dropped when the
// call was inlined — the inliner padded the missing slot with 0/ref.null
// instead of the parameter's constant/expression default.
describe("issue-1658: inlined-call optional-parameter defaults", () => {
  it("scalar constant default fires when arg omitted", async () => {
    await assertEquivalent(
      `
      function process(x: number, y: number = 10): number {
        return x + y;
      }
      export function test(): number {
        return process(5) + process(5, 20);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("scalar constant default not applied when arg provided", async () => {
    await assertEquivalent(
      `
      function f(x: number, y: number = 10): number {
        return x + y;
      }
      export function test(): number {
        return f(1, 99);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("expression default fires through inline path", async () => {
    await assertEquivalent(
      `
      function g(x: number, y: number = x * 2): number {
        return x + y;
      }
      export function test(): number {
        return g(3) + g(3, 1);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple omitted defaults", async () => {
    await assertEquivalent(
      `
      function h(a: number, b: number = 2, c: number = 3): number {
        return a * 100 + b * 10 + c;
      }
      export function test(): number {
        return h(1) + h(1, 5) + h(1, 5, 7);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
