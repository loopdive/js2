// #6492 round 18 — the test262 sandbox must SHARE the host `%Promise%`.
//
// Round 17 fixed where the keyed combinators are installed and left the rows
// red, because the receiver was still wrong. The producer turned out to be
// `__get_builtin("Promise")` (`src/runtime.ts`), which answers the HOST realm —
// while the compiled `Promise` identifier resolves through the sandbox
// (`declared_global`). Two lowerings of one identifier, two realms; the test's
// `Promise.resolve = fn` landed on a `Promise` nothing downstream read.
//
// The direction of the fix was decided by MEASUREMENT, not by symmetry.
// Everything Promise-shaped that the runtime MINTS is host-realm
// (`Promise_new_pending`, `Promise_resolve`, `_wrapThenable`), and §27.2.4.7's
// `nextPromise.constructor === C` fast path plus every
// `Object.getPrototypeOf(p) === Promise.prototype` assertion require minting,
// the capability `C` and the value read to sit in ONE realm. Moving minting
// into the sandbox was measured at 536 → 336 on `built-ins/Promise/` (two
// independent variants, r18 C and E). So the sandbox shares the host
// constructor instead — a fixture change, not a product-runtime one.
//
// These cases pin the two properties that makes load-bearing: the sandbox's
// `Promise` IS the host intrinsic, and the keyed statics are covered by the
// worker's restore list (without that, a row that patches one of them leaks
// into every later row — `Promise/property-order.js` and
// `allKeyed/result-property-descriptors.js` failed in a full-slice run and
// passed in a single-row run before the list was extended).
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  installAmbientCompatibility,
  resolvePromiseCompatibilityTarget,
  resolvePromiseRealm,
} from "../src/runtime/compatibility-adapter.js";
import { _makeLegacyRegExpState } from "../src/runtime/legacy-regexp.js";
import { SANDBOX_GLOBAL_NAMES } from "../scripts/test262-sandbox-globals.mjs";

/** Mirror of both sandbox builders, including the r18 `Promise` sharing. */
function buildSandbox(): Record<string, any> {
  const sandbox: Record<string, any> = Object.create(null);
  const context = createContext(sandbox);
  for (const name of SANDBOX_GLOBAL_NAMES) {
    try {
      sandbox[name] = runInContext(name, context);
    } catch {
      /* engine lacks this global — tolerated */
    }
  }
  sandbox.Promise = Promise;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function ambientOptions(extra: Record<string, unknown>) {
  return { enabled: true, legacyRegExpState: _makeLegacyRegExpState(), ...extra } as any;
}

describe("#6492 r18 — the sandbox shares the host %Promise%", () => {
  it("a vm realm really does hand out a DIFFERENT Promise — which is the bug being closed", () => {
    // Guards the premise: if this ever became false the sharing line would be
    // a no-op and this whole round would be unnecessary.
    const probe: Record<string, any> = Object.create(null);
    const context = createContext(probe);
    expect(runInContext("Promise", context)).not.toBe(Promise);
  });

  it("the built sandbox's Promise IS the host intrinsic", () => {
    const sandbox = buildSandbox();
    expect(sandbox.Promise).toBe(Promise);
    // The identity the corpus actually asserts on a minted promise.
    expect(Object.getPrototypeOf(Promise.resolve(1))).toBe(sandbox.Promise.prototype);
  });

  it("both sandbox builders share the host Promise", () => {
    for (const path of ["../scripts/test262-worker.mjs", "./test262-runner.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source, `${path} must share the host Promise`).toContain("sandbox.Promise = Promise;");
    }
  });

  it("the worker's restore list covers the keyed statics", () => {
    const worker = readFileSync(new URL("../scripts/test262-worker.mjs", import.meta.url), "utf8");
    const entry = worker.match(/\["Promise", Promise, \[([^\]]*)\]\]/);
    expect(entry, "the Promise snapshot entry must exist").not.toBeNull();
    for (const key of ["allKeyed", "allSettledKeyed", "resolve", "reject"]) {
      expect(entry?.[1], `restore list must cover Promise.${key}`).toContain(`"${key}"`);
    }
  });

  it("the combinators install onto that shared object, and read `resolve` off it", async () => {
    const sandbox = buildSandbox();
    installAmbientCompatibility(ambientOptions({ globalSandbox: sandbox }));
    expect(resolvePromiseCompatibilityTarget(ambientOptions({ globalSandbox: sandbox }))).toBe(Promise);
    expect(typeof (Promise as any).allKeyed).toBe("function");

    // A `Promise.resolve` override written through the SANDBOX is what the
    // combinator's `Get(C, "resolve")` must observe — the whole point.
    const original = Promise.resolve;
    let getCount = 0;
    let callCount = 0;
    try {
      Object.defineProperty(sandbox.Promise, "resolve", {
        configurable: true,
        get() {
          getCount += 1;
          return (v: any) => {
            callCount += 1;
            return original.call(Promise, v);
          };
        },
      });
      const result = await (sandbox.Promise as any).allKeyed({ first: 1, second: 2 });
      expect(result).toEqual({ first: 1, second: 2 });
      expect(getCount, "GetPromiseResolve(C) reads it once").toBe(1);
      expect(callCount, "called once per enumerable key").toBe(2);
    } finally {
      Object.defineProperty(Promise, "resolve", {
        value: original,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  });

  it("resolvePromiseRealm still prefers an injected dependency, then the sandbox", () => {
    const injected: any = () => {};
    expect(resolvePromiseRealm({ Promise: Promise }, injected)).toBe(injected);
    expect(resolvePromiseRealm(undefined, undefined)).toBe(Promise);
  });
});
