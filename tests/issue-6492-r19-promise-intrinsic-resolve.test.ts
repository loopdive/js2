// #6492 round 19 — the two residual losses round 18 shipped with.
//
// Round 18 made the harness sandbox share the host `%Promise%`, which is the
// right design, and paid for it with two rows (five on the honest lane). Both
// are fixed here, and both were mis-labelled before being measured:
//
//  1. `built-ins/Promise/any/invoke-resolve.js` was NOT a harness-residue row.
//     The `Promise_resolve` IMPORT re-read `Promise.resolve` off the global at
//     call time, so the classic test262 idiom
//
//         let bound = Promise.resolve.bind(Promise);
//         Promise.resolve = function (...a) { return bound(...a); };
//
//     recursed: the compiled body's `bound(...)` folds back onto the import
//     (the const-alias fold), the import re-read the PATCHED property, and
//     called the override again. Honest lane: `Maximum call stack size
//     exceeded`. Linked lane: the unwind surfaced as `$DONE is not defined`,
//     which is why it read as a harness bug. The import is the compiler's
//     intrinsic `PromiseResolve(%Promise%, x)` — §27.7.5.3 Await reads nothing
//     off the `Promise` object — so it now uses a value captured at module
//     load.
//
//  2. `built-ins/Promise/property-order.js` genuinely was residue, but of a
//     kind value-restore cannot repair: a preceding row `delete`s a static
//     (test262's `verifyProperty` deletes `length`/`name` to probe
//     configurability and does not put them back), and re-defining it appends
//     the key at the END of the own-key order. That row asserts `name` comes
//     directly after `length`. `restoreBuiltins()` now restores ORDER as well
//     as value.
import { describe, expect, it } from "vitest";
import { createHostPromiseBuiltinImport } from "../src/runtime/host-async-imports.js";
// @ts-expect-error — untyped .mjs helper shared with scripts/test262-worker.mjs
import { restoreOwnKeyOrder, snapshotOwnKeyOrder } from "../scripts/test262-own-key-order.mjs";

const identity = (v: any) => v;

describe("#6492 r19 — Promise_resolve is the intrinsic, not a late property read", () => {
  it("ignores a later `Promise.resolve` override instead of recursing into it", async () => {
    const promiseResolve = createHostPromiseBuiltinImport("Promise_resolve", identity, identity) as (v: any) => any;
    const original = Promise.resolve;
    let overrideCalls = 0;
    try {
      // The exact test262 idiom from `any/invoke-resolve.js`. Before r19 this
      // re-entered the import through the bound alias and blew the stack.
      const bound = original.bind(Promise);
      (Promise as any).resolve = (...args: any[]) => {
        overrideCalls += 1;
        return bound(...args);
      };
      await expect(promiseResolve(7)).resolves.toBe(7);
    } finally {
      (Promise as any).resolve = original;
    }
    expect(overrideCalls).toBe(0);
  });

  it("still assimilates a thenable through the wrap hook", async () => {
    const wrapped = { then: (f: (v: any) => void) => f(42) };
    const promiseResolve = createHostPromiseBuiltinImport("Promise_resolve", () => wrapped, identity) as (
      v: any,
    ) => any;
    await expect(promiseResolve("ignored")).resolves.toBe(42);
  });

  it("returns a real host promise (identity pass-through for an already-native one)", async () => {
    const promiseResolve = createHostPromiseBuiltinImport("Promise_resolve", identity, identity) as (v: any) => any;
    const p = Promise.resolve(1);
    expect(promiseResolve(p)).toBe(p);
  });
});

/**
 * The worker's order restore. It lives in its own module because the worker
 * `process.send`s at load and cannot be imported from a unit test; the cases
 * below pin it the way the worker uses it: snapshot → mutate → restore.
 */
describe("#6492 r19 — restoreBuiltins repairs own-key ORDER, not just values", () => {
  function makeIntrinsicLikeObject() {
    const target: any = function resolveHost() {};
    Object.defineProperty(target, "extra", { value: 1, writable: true, enumerable: false, configurable: true });
    return target;
  }

  it("a delete+redefine moves the key to the END — the defect being repaired", () => {
    const target = makeIntrinsicLikeObject();
    const before = Object.getOwnPropertyNames(target);
    // biome-ignore lint/performance/noDelete: reproducing test262's verifyProperty probe verbatim
    delete target.length;
    Object.defineProperty(target, "length", { value: 0, writable: false, enumerable: false, configurable: true });
    expect(Object.getOwnPropertyNames(target)).not.toEqual(before);
    expect(Object.getOwnPropertyNames(target).indexOf("length")).toBeGreaterThan(before.indexOf("length"));
  });

  it("the suffix rebuild restores the snapshot order", () => {
    const target = makeIntrinsicLikeObject();
    const { order, descriptors } = snapshotOwnKeyOrder(target);

    // biome-ignore lint/performance/noDelete: reproducing test262's verifyProperty probe verbatim
    delete target.length;
    Object.defineProperty(target, "length", { value: 0, writable: false, enumerable: false, configurable: true });
    expect(Reflect.ownKeys(target)).not.toEqual(order);

    restoreOwnKeyOrder(target, order, descriptors);
    // The guarantee is over the CONFIGURABLE keys: a function's `prototype` is
    // non-configurable, cannot be deleted, and therefore acts as a fixed point.
    const configurable = (keys: (string | symbol)[]) => keys.filter((k) => k !== "prototype");
    expect(configurable(Reflect.ownKeys(target))).toEqual(configurable(order));
    // …and the relation `property-order.js` actually measures:
    const names = Object.getOwnPropertyNames(target);
    expect(names.indexOf("name")).toBe(names.indexOf("length") + 1);
  });

  it("leaves an already-pristine object untouched (no gratuitous redefine)", () => {
    const target = makeIntrinsicLikeObject();
    const { order, descriptors } = snapshotOwnKeyOrder(target);
    const nameDescBefore = Object.getOwnPropertyDescriptor(target, "name");
    restoreOwnKeyOrder(target, order, descriptors);
    expect(Reflect.ownKeys(target)).toEqual(order);
    expect(Object.getOwnPropertyDescriptor(target, "name")).toEqual(nameDescBefore);
  });
});
