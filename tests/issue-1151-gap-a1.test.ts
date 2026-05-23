import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// Issue #1151 Gap A1: isAsyncCallExpression previously only recognised async
// callees via an `async` modifier on a resolvable declaration. Calls reached
// indirectly — through a variable holding an async function, or through a
// callback typed `() => Promise<T>` — carried no such modifier, so the
// call-site try/catch wrap (#1150) was never emitted. A synchronous throw from
// the indirectly-called async body then propagated as an uncaught wasm trap
// instead of a rejected Promise.
//
// Fix: broaden the detector to also treat a call as async when any call
// signature of the callee's TS type returns Promise<T> (excluding async
// generators, which return AsyncGenerator, and NewExpression callees).
//
// Spec: ECMA-262 §27.7.5.2 AsyncFunctionStart — an async function always
// returns a Promise; an abrupt completion in its body becomes a rejected
// Promise, never a synchronous throw to the caller.
//
// The equivalence harness can't await, so we assert the observable shape: the
// indirect call returns a thenable and does not trap synchronously.

describe("issue #1151 Gap A1 — broaden isAsyncCallExpression", () => {
  it("indirect async call through a variable returns a Promise (no trap)", async () => {
    await assertEquivalent(
      `
      async function ax(): Promise<number> { return 1; }
      export function callShape(): number {
        const f = ax;
        const p: any = f();
        return p && typeof p.then === "function" ? 1 : 0;
      }
      `,
      [{ fn: "callShape", args: [] }],
    );
  });

  it("indirect async call whose body throws does not trap synchronously", async () => {
    await assertEquivalent(
      `
      async function ax(): Promise<number> { throw new TypeError("boom"); }
      export function callShape(): number {
        const f = ax;
        // Without the wrap this would trap; with it the call returns a
        // rejected Promise (a thenable) and the synchronous path survives.
        const p: any = f();
        // Swallow the rejection so neither the JS reference run nor the wasm
        // run leaves an unhandled rejection — we only assert the shape here.
        if (p && typeof p.then === "function") { p.then(function () {}, function () {}); return 1; }
        return 0;
      }
      `,
      [{ fn: "callShape", args: [] }],
    );
  });

  it("callback typed () => Promise<T> is treated as async", async () => {
    await assertEquivalent(
      `
      async function ax(): Promise<number> { return 5; }
      function run(cb: () => Promise<number>): number {
        const p: any = cb();
        return p && typeof p.then === "function" ? 1 : 0;
      }
      export function callShape(): number {
        return run(ax);
      }
      `,
      [{ fn: "callShape", args: [] }],
    );
  });

  it("non-async indirect call is NOT wrapped (returns raw value)", async () => {
    await assertEquivalent(
      `
      function sync(): number { return 42; }
      export function callShape(): number {
        const f = sync;
        return f();
      }
      `,
      [{ fn: "callShape", args: [] }],
    );
  });
});
