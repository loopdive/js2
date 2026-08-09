// #3441 — TypedArray-ctor tests trapped "Cannot convert null to object" at
// __module_init in the sharded-CI worker lane.
//
// Root cause: the oracle-v8 harness sandbox globals were maintained as two
// hand-kept twins — tests/test262-runner.ts had the #3419 TypedArray cluster,
// scripts/test262-worker.mjs (the sharded-CI/baseline lane) did NOT. The
// harness file testTypedArray.js reads TypedArray constructors as bare VALUES
// at module-init top level (`var TypedArray = Object.getPrototypeOf(Int8Array)`);
// when `Int8Array` was absent from the worker sandbox the read resolved to
// null/undefined and `Object.getPrototypeOf` threw during __module_init,
// stranding ~2,069 default-lane tests (+90 built-ins/Atomics that were on
// NEITHER list).
//
// Fix: one shared list in scripts/test262-sandbox-globals.mjs imported by both
// lanes, so drift is structurally impossible; Atomics added for both.
//
// These assertions guard the regression: if the TypedArray cluster or Atomics
// is dropped from the shared list, or if the sandbox stops exposing them, they
// fail.
import { describe, it, expect } from "vitest";
import { createContext, runInContext } from "node:vm";
import { SANDBOX_GLOBAL_NAMES } from "../scripts/test262-sandbox-globals.mjs";

// The #3419 TypedArray cluster + binary-data builtins + Atomics that the
// TypedArray/Atomics harness corpus reads at module init.
const REQUIRED_TYPEDARRAY_CLUSTER = [
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "BigInt",
  "Atomics",
];

// Mirror of the worker/runner sandbox-build (buildOriginalHarnessSandbox /
// _buildFreshSandbox) — the single behavior under test.
function buildSandbox(names: readonly string[]): Record<string, unknown> {
  const sandbox: Record<string, unknown> = Object.create(null);
  const context = createContext(sandbox);
  for (const name of names) {
    try {
      sandbox[name] = runInContext(name, context);
    } catch {
      /* engine lacks this global — tolerated */
    }
  }
  sandbox.globalThis = sandbox;
  return sandbox;
}

describe("#3441 shared test262 sandbox globals", () => {
  it("shared list includes the full TypedArray cluster + Atomics", () => {
    for (const name of REQUIRED_TYPEDARRAY_CLUSTER) {
      expect(SANDBOX_GLOBAL_NAMES, `missing sandbox global: ${name}`).toContain(name);
    }
  });

  it("sandbox exposes Int8Array so `Object.getPrototypeOf(Int8Array)` does not trap", () => {
    // This is the exact operation testTypedArray.js:64 performs during
    // __module_init. Before the fix, Int8Array was absent → null/undefined →
    // "Cannot convert null to object".
    const sandbox = buildSandbox(SANDBOX_GLOBAL_NAMES);
    expect(typeof sandbox.Int8Array).toBe("function");
    const proto = Object.getPrototypeOf(sandbox.Int8Array);
    expect(typeof proto).toBe("function"); // %TypedArray% intrinsic
    // Intra-sandbox identity the harness relies on.
    expect(Object.getPrototypeOf(sandbox.Uint8Array)).toBe(proto);
  });

  it("sandbox exposes Atomics as an object", () => {
    const sandbox = buildSandbox(SANDBOX_GLOBAL_NAMES);
    expect(typeof sandbox.Atomics).toBe("object");
    expect(sandbox.Atomics).not.toBeNull();
  });
});
