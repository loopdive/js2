// #6492 round 17 — the keyed Promise combinators must be installed on the
// realm the COMPILED code reads `Promise` from.
//
// `allKeyed` already resolves `C` and `promiseResolve` off its receiver
// (§7.3.x GetPromiseResolve, `C = this`) — that was never the defect. The
// defect was that the receiver could not be the object the test had written
// to, because the method only existed on ANOTHER realm's `Promise`:
//
//   [DBG dpa] prop=resolve  isNativePromise=false name=Promise   ← test's defineProperty target (the SANDBOX's Promise)
//   [DBG gpr] typeofC=function isNativePromise=true resolveIsNative=true   ← C inside the combinator (the WORKER's)
//
// measured in the real runner on
// `built-ins/Promise/allKeyed/invoke-resolve-get-once.js`. Every
// `invoke-resolve-*` / `resolve-*` / `invoke-then-*` row in the family turns
// on that write being visible.
//
// These cases pin the SELECTION rule, not the combinator's semantics (those are
// tests/issue-6492-r5-promise-keyed-combinators.test.ts).
import { describe, expect, it } from "vitest";
import {
  installAmbientCompatibility,
  resolvePromiseCompatibilityTarget,
} from "../src/runtime/compatibility-adapter.js";
import { _makeLegacyRegExpState } from "../src/runtime/legacy-regexp.js";

/** A second `Promise` in the same process, standing in for the sandbox realm's. */
function makeForeignPromise(): any {
  const Foreign: any = function (this: any, executor: any) {
    return new Promise(executor);
  };
  Foreign.prototype = Promise.prototype;
  Object.defineProperty(Foreign, "name", { value: "Promise", configurable: true });
  Foreign.resolve = (v: any) => Promise.resolve(v);
  return Foreign;
}

function ambientOptions(extra: Record<string, unknown>) {
  return {
    enabled: true,
    legacyRegExpState: _makeLegacyRegExpState(),
    ...extra,
  } as any;
}

describe("#6492 r17 — which realm's Promise carries the keyed combinators", () => {
  it("prefers the sandbox's Promise over the ambient intrinsic", () => {
    const sandboxPromise = makeForeignPromise();
    const target = resolvePromiseCompatibilityTarget(ambientOptions({ globalSandbox: { Promise: sandboxPromise } }));
    expect(target).toBe(sandboxPromise);
    expect(target).not.toBe(Promise);
  });

  it("falls back to the ambient intrinsic when there is no sandbox (product embedding)", () => {
    expect(resolvePromiseCompatibilityTarget(ambientOptions({}))).toBe(Promise);
    expect(resolvePromiseCompatibilityTarget(ambientOptions({ globalSandbox: {} }))).toBe(Promise);
  });

  it("an explicitly injected deps.Promise still wins", () => {
    const injected = makeForeignPromise();
    const sandboxPromise = makeForeignPromise();
    const target = resolvePromiseCompatibilityTarget(
      ambientOptions({ deps: { Promise: injected }, globalSandbox: { Promise: sandboxPromise } }),
    );
    expect(target).toBe(injected);
  });

  it("installs on the sandbox's Promise and leaves the intrinsic untouched", () => {
    const hadAllKeyed = typeof (Promise as any).allKeyed === "function";
    const sandboxPromise = makeForeignPromise();
    installAmbientCompatibility(ambientOptions({ globalSandbox: { Promise: sandboxPromise } }));
    expect(typeof sandboxPromise.allKeyed).toBe("function");
    expect(typeof sandboxPromise.allSettledKeyed).toBe("function");
    // The realm-canary consequence: this call must not ADD the statics to the
    // worker's own `Promise`. (It may already carry them — the worker primes
    // the install before its baseline snapshot — so assert "unchanged", not
    // "absent".)
    expect(typeof (Promise as any).allKeyed === "function").toBe(hadAllKeyed);
  });

  it("a sandbox-side `Promise.resolve` override IS observed by allKeyed", async () => {
    // The row this round exists for, reduced: the combinator must read
    // `resolve` off the receiver the compiled code called it on.
    const sandboxPromise = makeForeignPromise();
    installAmbientCompatibility(ambientOptions({ globalSandbox: { Promise: sandboxPromise } }));

    let getCount = 0;
    let callCount = 0;
    const originalResolve = sandboxPromise.resolve;
    Object.defineProperty(sandboxPromise, "resolve", {
      configurable: true,
      get() {
        getCount += 1;
        return function (this: any, ...args: any[]) {
          callCount += 1;
          return originalResolve.apply(sandboxPromise, args);
        };
      },
    });

    const result = await sandboxPromise.allKeyed({ first: 1, second: 2 });
    expect(result).toEqual({ first: 1, second: 2 });
    expect(getCount, "GetPromiseResolve(C) reads it once").toBe(1);
    expect(callCount, "called once per enumerable key").toBe(2);
  });
});
