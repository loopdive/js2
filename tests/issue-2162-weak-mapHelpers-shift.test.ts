// #2162 — regression: `mapHelpers` must shift in lockstep with late imports.
//
// The function-index shift machinery (shiftLateImportIndices in
// expressions/late-imports.ts + the two addUnionImports shift sites in
// index.ts) kept ctx.funcMap / ctx.nativeStrHelpers / ctx.nativeRegexHelpers in
// lockstep with the defined-function shift but NEVER shifted ctx.mapHelpers.
// So when a late import (e.g. `__box_number`, pulled in to coerce a numeric
// Map/WeakMap key or value) was added BETWEEN a map-helper's registration and
// its `call` site, every defined function moved up by `added` but the
// mapHelpers entries did not — so `wm.has(k)` emitted a `call` to `__map_get`
// (the function one slot lower), which returns `anyref` where an `i32` boolean
// was expected, and the module FAILED Wasm validation.
//
// The defect is observable as INVALID Wasm: `WebAssembly.validate(binary)` is
// `false` without the fix and `true` with it (verified by reverting the three
// shift-site edits). That is the precise, deterministic regression signal — far
// more robust than a runtime value, and it is exactly the failure mode (a
// `call` to the wrong-signature helper) the fix addresses.
//
// Reproducing condition: `standalone: true, nativeStrings: true` — this routes
// the WasmGC-native Map/Set/Weak runtime AND defers `__box_number` to a late
// import, so the numeric key/value coercion opens the stale-`mapHelpers` window
// mid-method-call. (Under `--target wasi` the box helpers import eagerly, so the
// window never opens — which is why the existing issue-2162-standalone-weak
// suite, compiled for wasi, passed before this fix.)
//
// Mirrors the #1677 (nativeStrHelpers) / #1913 (nativeRegexHelpers) precedent:
// add a mapHelpers lockstep shift at all three shift sites.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `source` standalone + nativeStrings; assert the binary is VALID Wasm. */
async function expectValidStandalone(source: string): Promise<void> {
  const r = await compile(source, { fileName: "test.ts", standalone: true, nativeStrings: true });
  expect(r.success).toBe(true);
  // A stale mapHelpers index emits a `call` to the wrong-signature helper, which
  // fails validation. This assertion is `false` without the three-site fix.
  expect(WebAssembly.validate(r.binary)).toBe(true);
}

describe("#2162 mapHelpers lockstep shift — stale-index produces invalid Wasm", () => {
  it("WeakMap set/get of a numeric value (boxing forces a late import)", async () => {
    await expectValidStandalone(
      `const wm = new WeakMap<object, number>();
       const k = {};
       wm.set(k, 42);
       export function test(): number { return wm.get(k) as number; }`,
    );
  });

  it("WeakMap has — the call must land on __map_has (i32), not __map_get (anyref)", async () => {
    await expectValidStandalone(
      `const wm = new WeakMap<object, number>();
       const k = {}; const k2 = {};
       wm.set(k, 7);
       export function test(): number { return (wm.has(k) ? 10 : 0) + (wm.has(k2) ? 1 : 0); }`,
    );
  });

  it("WeakMap delete after a numeric set", async () => {
    await expectValidStandalone(
      `const wm = new WeakMap<object, number>();
       const k = {};
       wm.set(k, 1);
       const d = wm.delete(k) ? 1 : 0;
       const gone = wm.has(k) ? 1 : 0;
       export function test(): number { return d * 10 + gone; }`,
    );
  });

  it("WeakSet add/has round-trip", async () => {
    await expectValidStandalone(
      `const ws = new WeakSet<object>();
       const a = {}; const b = {};
       ws.add(a);
       export function test(): number { return (ws.has(a) ? 10 : 0) + (ws.has(b) ? 1 : 0); }`,
    );
  });

  it("plain Map in the same boxing window also stays valid (not weak-specific)", async () => {
    await expectValidStandalone(
      `const m = new Map<object, number>();
       const k = {};
       m.set(k, 99);
       export function test(): number { return (m.get(k) as number) + (m.has(k) ? 1 : 0); }`,
    );
  });
});
