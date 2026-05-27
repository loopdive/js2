import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// #1658 — function-parameter default not applied (returns wrong value).
// An inlinable callee has its callee-side default guard elided (#869), so the
// caller must materialize the parameter default at the (inlined) call site.
// Before the fix, a missing arg got a plain f64 0 instead of the declared
// default, so `process(5)` returned 5 (not 15) and the suite returned 30 not 40.
describe("#1658 function-parameter defaults", () => {
  it("scalar default fires when the trailing arg is omitted", async () => {
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

  it("scalar default fires for explicit undefined", async () => {
    await assertEquivalent(
      `
      function f(x: number, y: number = 42): number {
        return x + y;
      }
      export function omitted(): number { return f(1); }
      export function explicitUndef(): number { return f(1, undefined); }
      export function provided(): number { return f(1, 0); }
      `,
      [
        { fn: "omitted", args: [] },
        { fn: "explicitUndef", args: [] },
        { fn: "provided", args: [] },
      ],
    );
  });

  it("default of 0 is still applied (not skipped) when arg omitted", async () => {
    await assertEquivalent(
      `
      function g(x: number, y: number = 0): number {
        return x * 10 + y;
      }
      export function test(): number {
        return g(3) + g(3, 7);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple trailing defaults", async () => {
    await assertEquivalent(
      `
      function h(a: number, b: number = 2, c: number = 3): number {
        return a + b + c;
      }
      export function test(): number {
        return h(1) + h(1, 20) + h(1, 20, 30);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
