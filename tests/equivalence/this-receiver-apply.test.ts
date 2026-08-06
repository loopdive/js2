import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

/**
 * (#3983) `fn.apply(thisArg[, argsArray])` on a stable named FunctionDeclaration
 * whose body reads `this` used to evaluate `thisArg` and DROP it, so `this`
 * inside the callee was the ambient receiver rather than the requested one —
 * a silent wrong answer, not a refusal.
 *
 * `.call(...)` already installed the receiver via the #3796 trampoline; the
 * `.apply(...)` forms with a statically flattenable argv now reshape onto that
 * same path. The `.call` and null-receiver cases are covered here as guards so
 * the previously-correct lowerings cannot regress.
 */
describe("#3983 — .apply() installs the receiver as `this`", () => {
  it("apply(obj) — receiver identity", async () => {
    await assertEquivalent(
      `
      var o = {};
      function f() { return this; }
      export function test() { return f.apply(o) === o ? 1 : 0; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("apply(obj) — strict callee", async () => {
    await assertEquivalent(
      `
      var o = {};
      function f() { "use strict"; return this; }
      export function test() { return f.apply(o) === o ? 1 : 0; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("apply(obj, []) — empty argv array", async () => {
    await assertEquivalent(
      `
      var o = {};
      function f() { return this; }
      export function test() { return f.apply(o, []) === o ? 1 : 0; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("apply(obj, [arg]) — receiver AND positional arg both land", async () => {
    await assertEquivalent(
      `
      var o = {};
      function f(a: number) { return this === o && a === 7; }
      export function test() { return f.apply(o, [7]) ? 1 : 0; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("apply(obj, [a, b]) — multiple args preserve order", async () => {
    await assertEquivalent(
      `
      var o = {};
      function f(a: number, b: number) { return this === o && a === 1 && b === 2; }
      export function test() { return f.apply(o, [1, 2]) ? 1 : 0; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Guard: the .call path was already correct (#3796) — keep it that way.
  it("call(obj) — unchanged", async () => {
    await assertEquivalent(
      `
      var o = {};
      function f() { return this; }
      export function test() { return f.call(o) === o ? 1 : 0; }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // Guard: a nullish receiver must keep the legacy unbound call, not enter the
  // receiver-install arm.
  it("apply() with no receiver — strict `this` stays undefined", async () => {
    await assertEquivalent(
      `
      function f() { "use strict"; return this === undefined; }
      export function test() { return f.apply() ? 1 : 0; }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
