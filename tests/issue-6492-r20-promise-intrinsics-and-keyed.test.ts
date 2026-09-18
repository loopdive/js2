// #6492 round 20 — the remaining late property reads, the keyed-combinator
// residue, and the last two realm-canary lines.
//
// Round 19 froze `Promise_resolve` to the intrinsic. The same shape existed in
// `Promise_reject` and in the four combinator adapters, and the same test262
// idiom re-enters them:
//
//     let bound = Promise.reject.bind(Promise);
//     Promise.reject = function (...a) { return bound(...a); };
//
// What is deliberately NOT frozen is what those methods READ. §27.2.4.1.1
// step 5's `GetPromiseResolve(C)` is spec-visible and half the family asserts
// it, so the combinators are invoked as `PROMISE_INTRINSICS.all.call(C, …)`
// and the engine still performs `Get(C, "resolve")` on the receiver the
// compiled program chose. Freezing the method CALLED and freezing what it
// READS are different things; only the first one is done.
import { describe, expect, it } from "vitest";
import { PROMISE_INTRINSICS } from "../src/runtime/promise-intrinsics.js";
import { _installPromiseKeyedCombinators } from "../src/runtime/promise-keyed-combinators.js";
// @ts-expect-error — untyped .mjs helper shared with scripts/test262-worker.mjs
import { restoreSymbolAndAccessorMeta, snapshotSymbolAndAccessorMeta } from "../scripts/test262-own-key-order.mjs";

describe("#6492 r20 — the intrinsics do not re-enter an override of themselves", () => {
  it("`reject` ignores a later `Promise.reject` override (the r19 recursion shape)", async () => {
    const original = Promise.reject;
    let overrideCalls = 0;
    try {
      const bound = original.bind(Promise);
      (Promise as any).reject = (...args: any[]) => {
        overrideCalls += 1;
        const p = bound(...args);
        p.catch(() => {});
        return p;
      };
      const rejected = PROMISE_INTRINSICS.reject("boom");
      rejected.catch(() => {});
      await expect(rejected).rejects.toBe("boom");
    } finally {
      (Promise as any).reject = original;
    }
    expect(overrideCalls).toBe(0);
  });

  it("`all` ignores an override of `Promise.all` itself", async () => {
    const original = Promise.all;
    let overrideCalls = 0;
    try {
      const bound = original.bind(Promise);
      (Promise as any).all = (...args: any[]) => {
        overrideCalls += 1;
        return bound(...args);
      };
      await expect(PROMISE_INTRINSICS.all?.call(Promise, [1, 2])).resolves.toEqual([1, 2]);
    } finally {
      (Promise as any).all = original;
    }
    expect(overrideCalls).toBe(0);
  });

  it('…but STILL performs the observable Get(C, "resolve") on the receiver', async () => {
    class MyPromise extends Promise<any> {}
    let reads = 0;
    Object.defineProperty(MyPromise, "resolve", {
      get() {
        reads += 1;
        return Promise.resolve.bind(Promise);
      },
      configurable: true,
    });
    await PROMISE_INTRINSICS.all?.call(MyPromise, [1]);
    // One read per `Promise.all` call — the §27.2.4.1.1 step-5 GetPromiseResolve.
    expect(reads).toBeGreaterThanOrEqual(1);
  });
});

describe("#6492 r20 — the keyed combinators are methods, not constructors", () => {
  function freshTarget(): any {
    const target: any = function PromiseLike() {};
    return target;
  }

  it("installs a NON-constructible `allKeyed` (what not-a-constructor.js probes)", () => {
    const target = freshTarget();
    _installPromiseKeyedCombinators(target);
    expect(typeof target.allKeyed).toBe("function");
    expect(() => Reflect.construct(target.allKeyed, [])).toThrow(TypeError);
    expect(() => Reflect.construct(target.allSettledKeyed, [])).toThrow(TypeError);
  });

  it("keeps the prop-desc contract: name, length and the attributes", () => {
    const target = freshTarget();
    _installPromiseKeyedCombinators(target);
    for (const name of ["allKeyed", "allSettledKeyed"]) {
      expect(target[name].name).toBe(name);
      expect(target[name].length).toBe(1);
      expect(Object.getOwnPropertyDescriptor(target, name)).toMatchObject({
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  });

  it("routes `nextPromise` through the injected mirror before Invoking `then`", async () => {
    const target: any = function Ctor(executor: any) {
      executor(
        () => {},
        () => {},
      );
    };
    // An "opaque" value standing in for a compiled WasmGC thenable: no host
    // `then`, exactly the shape that threw `nextPromise.then is not a function`.
    const opaque = Object.create(null);
    let mirrored = 0;
    let thenCalls = 0;
    target.resolve = () => opaque;
    _installPromiseKeyedCombinators(target, (value: any) => {
      if (value !== opaque) return value;
      mirrored += 1;
      return {
        then(onFulfilled: (v: any) => void) {
          thenCalls += 1;
          onFulfilled(1);
        },
      };
    });
    target.allKeyed.call(target, { key: 1 });
    expect(mirrored).toBe(1);
    expect(thenCalls).toBe(1);
  });
});

describe("#6492 r20 — symbol keys and function metadata are restored", () => {
  it("puts back a deleted symbol-keyed own property", () => {
    const target: any = {};
    Object.defineProperty(target, Symbol.toStringTag, { value: "Thing", configurable: true });
    const snap = snapshotSymbolAndAccessorMeta(target);
    // biome-ignore lint/performance/noDelete: reproducing test262's verifyProperty probe verbatim
    delete target[Symbol.toStringTag];
    expect(Object.getOwnPropertySymbols(target)).toHaveLength(0);
    restoreSymbolAndAccessorMeta(target, snap);
    expect(target[Symbol.toStringTag]).toBe("Thing");
  });

  it("puts back a getter's deleted `length` (the Promise[Symbol.species]<get> line)", () => {
    const target: any = {};
    Object.defineProperty(target, Symbol.species, {
      get: function species() {
        return target;
      },
      configurable: true,
    });
    const getter = Object.getOwnPropertyDescriptor(target, Symbol.species)!.get!;
    const snap = snapshotSymbolAndAccessorMeta(target);
    // biome-ignore lint/performance/noDelete: reproducing test262's verifyProperty probe verbatim
    delete (getter as any).length;
    expect(Object.prototype.hasOwnProperty.call(getter, "length")).toBe(false);
    restoreSymbolAndAccessorMeta(target, snap);
    expect(Object.prototype.hasOwnProperty.call(getter, "length")).toBe(true);
    expect(getter.length).toBe(0);
  });

  it("does not disturb a property it has no snapshot for", () => {
    const target: any = { plain: 1 };
    const snap = snapshotSymbolAndAccessorMeta(target);
    target.plain = 2;
    restoreSymbolAndAccessorMeta(target, snap);
    expect(target.plain).toBe(2);
  });
});
