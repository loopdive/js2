// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 5 — `Promise.allKeyed` / `Promise.allSettledKeyed` (await-dictionary).
//
// These four rows arrived as an honest-pass/linked-fail "parity" cluster, which
// is the wrong frame: the honest passes were ACCIDENTAL. `allKeyed` routes to
// the host `Promise` object, the container's Node does not have it, so
// `Promise.allKeyed({…})` threw `TypeError: allKeyed is not a function`
// synchronously in BOTH lanes — and the honest lane's whole-assembly lowering
// wrapped the test callback in try→`Promise_resolve`/catch→`Promise_reject`,
// which converted that unrelated TypeError into the rejection
// `assert.throwsAsync(TypeError, …)` was looking for. Measured over the family
// before this landed: linked 2/89, honest 6/89.
//
// So the fix is to implement the proposal rather than to make the lanes agree.
// Measured after, with the real runner: linked 2 → 52, honest 6 → 56, and over
// the whole `built-ins/Promise/` tree linked 439 → 489 — +50 with ZERO rows
// lost in either lane.
//
// The tests below exercise the polyfill directly, because the behaviour that
// matters (reject-vs-throw, the null-prototype result, the skip-before-Get
// order) is host-side and independent of which oracle lane compiles the body.

import { describe, expect, it } from "vitest";

import { _installPromiseKeyedCombinators } from "../src/runtime/promise-keyed-combinators.js";

/** A fresh Promise-like constructor so tests never mutate the real one. */
function freshCtor(): any {
  const C: any = function (this: any, executor: (res: any, rej: any) => void) {
    return new Promise(executor);
  } as any;
  C.prototype = Promise.prototype;
  C.resolve = (v: any) => Promise.resolve(v);
  _installPromiseKeyedCombinators(C);
  return C;
}

/** Settle a combinator call into a readable verdict, never throwing. */
async function verdict(run: () => any): Promise<string> {
  let p: any;
  try {
    p = run();
  } catch (error) {
    return `threw ${(error as Error)?.constructor?.name ?? "?"}`;
  }
  return p.then(
    (v: any) => `resolved ${JSON.stringify(v)}`,
    (e: any) => `rejected ${(e as Error)?.constructor?.name ?? "?"}`,
  );
}

describe("#6492 r5 — Promise.allKeyed / allSettledKeyed", () => {
  it("installs both with the spec's own-property shape", () => {
    const C = freshCtor();
    for (const name of ["allKeyed", "allSettledKeyed"] as const) {
      expect(typeof C[name]).toBe("function");
      expect(C[name].length).toBe(1);
      expect(C[name].name).toBe(name);
      const desc = Object.getOwnPropertyDescriptor(C, name)!;
      expect(desc.writable).toBe(true);
      expect(desc.enumerable).toBe(false);
      expect(desc.configurable).toBe(true);
    }
  });

  it("never overwrites a host implementation", () => {
    const C: any = (() => {}) as any;
    const sentinel = (): void => {};
    C.allKeyed = sentinel;
    _installPromiseKeyedCombinators(C);
    expect(C.allKeyed).toBe(sentinel);
  });

  it("resolves an empty object to an EMPTY NULL-PROTOTYPE object", async () => {
    const result = await freshCtor().allKeyed({});
    expect(Object.getPrototypeOf(result)).toBe(null);
    expect(result.hasOwnProperty).toBe(undefined);
    expect(Reflect.ownKeys(result)).toEqual([]);
  });

  it("creates each result property writable/enumerable/configurable, in key order", async () => {
    const result = await freshCtor().allKeyed({
      first: Promise.resolve(1),
      second: Promise.resolve(2),
    });
    expect(Reflect.ownKeys(result)).toEqual(["first", "second"]);
    expect(Object.getOwnPropertyDescriptor(result, "first")).toEqual({
      value: 1,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  it("REJECTS rather than throws for a non-object argument", async () => {
    // The spec's step 1 is `promises.[[OwnPropertyKeys]]()`, inside the
    // IfAbruptRejectPromise window — so `allKeyed(1)` must hand back a
    // rejected promise, not throw at the call site.
    expect(await verdict(() => freshCtor().allKeyed(1))).toBe("rejected TypeError");
    expect(await verdict(() => freshCtor().allKeyed(undefined))).toBe("rejected TypeError");
  });

  it("REJECTS when `resolve` is missing or not callable", async () => {
    const C = freshCtor();
    C.resolve = undefined;
    expect(await verdict(() => C.allKeyed({ a: 1 }))).toBe("rejected TypeError");
    C.resolve = 1;
    expect(await verdict(() => C.allKeyed({ a: 1 }))).toBe("rejected TypeError");
  });

  it("REJECTS when the resolved value has no callable `then`", async () => {
    const C = freshCtor();
    C.resolve = () => ({});
    expect(await verdict(() => C.allKeyed({ key: 1 }))).toBe("rejected TypeError");
  });

  it("skips a non-enumerable key WITHOUT performing the Get", async () => {
    const seen: string[] = [];
    const input: any = {};
    Object.defineProperty(input, "hidden", {
      get: () => {
        seen.push("hidden");
        return 1;
      },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(input, "shown", {
      get: () => {
        seen.push("shown");
        return 2;
      },
      enumerable: true,
      configurable: true,
    });
    const result = await freshCtor().allKeyed(input);
    expect(seen).toEqual(["shown"]);
    expect(Reflect.ownKeys(result)).toEqual(["shown"]);
  });

  it("ignores inherited keys", async () => {
    const proto = { inherited: 1 };
    const input = Object.create(proto);
    input.own = 2;
    const result = await freshCtor().allKeyed(input);
    expect(Reflect.ownKeys(result)).toEqual(["own"]);
  });

  it("keeps symbol keys", async () => {
    const key = Symbol("k");
    const result = await freshCtor().allKeyed({ [key]: Promise.resolve(7) });
    expect(Reflect.ownKeys(result)).toEqual([key]);
    expect(result[key]).toBe(7);
  });

  it("allKeyed rejects on the first element rejection; allSettledKeyed does not", async () => {
    const C = freshCtor();
    const input = {
      good: Promise.resolve(1),
      bad: Promise.reject(new RangeError("x")),
    };
    expect(await verdict(() => C.allKeyed(input))).toBe("rejected RangeError");

    const settled = await C.allSettledKeyed({
      good: Promise.resolve(1),
      bad: Promise.reject(new RangeError("x")),
    });
    expect(settled.good).toEqual({ status: "fulfilled", value: 1 });
    expect(settled.bad.status).toBe("rejected");
    expect(settled.bad.reason).toBeInstanceOf(RangeError);
  });

  it("gives each element function length 1 and name '' with spec descriptors", () => {
    // `resolve-element-function-properties.js` reads these off the function the
    // combinator hands to `then`, so capture it through a custom thenable.
    let captured: any;
    const C = freshCtor();
    C.resolve = (v: any) => v;
    C.allKeyed({
      only: {
        then(onFulfilled: any) {
          captured = onFulfilled;
        },
      },
    });
    expect(typeof captured).toBe("function");
    expect(Object.getOwnPropertyDescriptor(captured, "length")).toEqual({
      value: 1,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(captured, "name")).toEqual({
      value: "",
      writable: false,
      enumerable: false,
      configurable: true,
    });
  });

  it("settles an element only once", async () => {
    let onFulfilled: any;
    const C = freshCtor();
    C.resolve = (v: any) => v;
    const promise = C.allKeyed({
      only: {
        then(f: any) {
          onFulfilled = f;
        },
      },
    });
    onFulfilled(1);
    onFulfilled(2);
    expect((await promise).only).toBe(1);
  });
});
