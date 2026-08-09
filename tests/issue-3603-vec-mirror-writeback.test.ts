import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3603 S1 (root cause B) — `verifyProperty` is vacuous on the JS-HOST lane
// because test262 `propertyHelper.js`'s uncurried
// `__push = Function.prototype.call.bind(Array.prototype.push)` is a SILENT
// NO-OP: a WasmGC vec crosses into a host call as the `__make_iterable` mirror,
// which `convertToJS` refreshes FROM the vec on every crossing, so the mutation
// never reaches the vec. `failures.length` stays 0 and the terminal
// `assert(false, __join(failures, '; '))` never fires.
//
// EVERY assertion below is a regression guard measured against the pre-fix
// tree: the `.call` / uncurried mutator rows all FAIL without
// src/runtime/vec-mirror-writeback.ts (`.length` → 0, `[0]` → undefined,
// `__join` → ""), while the native-`push`, `__join`-literal, `__hasOwn` and
// non-mutating `slice.call` rows pass in both — they are controls, not
// coverage padding.
//
// Lane note: these are HOST-lane tests by construction (`buildImports` +
// `WebAssembly.instantiate` with the real import object). Standalone has its
// own, DIFFERENT root cause (A: object literals carry no `$Object`
// own-property table) which is deliberately not touched here — fixing
// standalone first would turn every honest flip into an invalid-Wasm trap.

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test();
}

// The exact uncurryThis preamble test262's propertyHelper.js uses.
const UNCURRY = `
  const __push: any = Function.prototype.call.bind(Array.prototype.push);
  const __join: any = Function.prototype.call.bind(Array.prototype.join);
`;

describe("#3603 S1 — host-side vec-mirror mutations reach the WasmGC vec", () => {
  describe("root-cause-B table: the three independent __push observations", () => {
    it("__push(a, x) then a.length === 1", async () => {
      expect(
        await run(
          `export function test(): number { ${UNCURRY} const a: any[] = []; __push(a, "x"); return a.length; }`,
        ),
      ).toBe(1);
    });

    it("__push(a, x) then a[0] === 'x'", async () => {
      expect(
        await run(
          `export function test(): string { ${UNCURRY} const a: any[] = []; __push(a, "x"); return String(a[0]); }`,
        ),
      ).toBe("x");
    });

    it("__push(a, x) then __join(a, ';') === 'x'", async () => {
      expect(
        await run(
          `export function test(): string { ${UNCURRY} const a: any[] = []; __push(a, "x"); return String(__join(a, ";")); }`,
        ),
      ).toBe("x");
    });

    it("the propertyHelper accumulate-and-report shape reports its failure", async () => {
      // This is the literal `verifyProperty` epilogue: push a message into a
      // failures array through the uncurried helper, then branch on
      // `failures.length`. Before the fix this returned "" — the branch was
      // never taken, which is exactly how a wrong expectation passed silently.
      expect(
        await run(`export function test(): string {
          ${UNCURRY}
          const failures: any[] = [];
          __push(failures, "expected value 1 but got 42");
          if (failures.length) return String(__join(failures, "; "));
          return "";
        }`),
      ).toBe("expected value 1 but got 42");
    });
  });

  describe("controls (pass before AND after — they isolate the defect)", () => {
    it("native a.push(x) was never broken", async () => {
      expect(await run(`export function test(): number { const a: any[] = []; a.push("x"); return a.length; }`)).toBe(
        1,
      );
    });

    it("__join on a literal was never broken", async () => {
      expect(await run(`export function test(): string { ${UNCURRY} return String(__join(["a", "b"], ";")); }`)).toBe(
        "a;b",
      );
    });

    it("the uncurried hasOwnProperty (a READ) was never broken", async () => {
      expect(
        await run(`export function test(): number {
          const __hasOwn: any = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
          return __hasOwn({ value: 1, writable: true }, "value") ? 1 : 0;
        }`),
      ).toBe(1);
    });

    it("a NON-mutating .call leaves the receiver's length alone", async () => {
      expect(
        await run(`export function test(): string {
          const a: any[] = ["a", "b"];
          const s: any = (Array.prototype.slice as any).call(a, 0, 1);
          return String(a.length) + "/" + String(s.length);
        }`),
      ).toBe("2/1");
    });
  });

  describe("generality — every length-CHANGING Array mutator via .call", () => {
    it("push.call appends", async () => {
      expect(
        await run(
          `export function test(): number { const a: any[] = []; (Array.prototype.push as any).call(a, "x"); return a.length; }`,
        ),
      ).toBe(1);
    });

    it("pop.call returns the last element and shrinks", async () => {
      expect(
        await run(`export function test(): string {
          const a: any[] = ["p", "q"];
          const v: any = (Array.prototype.pop as any).call(a);
          return String(v) + "/" + String(a.length);
        }`),
      ).toBe("q/1");
    });

    it("unshift.call prepends (a change with an EMPTY common prefix)", async () => {
      expect(
        await run(`export function test(): string {
          const a: any[] = ["b"];
          (Array.prototype.unshift as any).call(a, "a");
          return String(a[0]) + String(a[1]) + "/" + String(a.length);
        }`),
      ).toBe("ab/2");
    });

    it("shift.call removes from the front", async () => {
      expect(
        await run(`export function test(): string {
          const a: any[] = ["a", "b"];
          const v: any = (Array.prototype.shift as any).call(a);
          return String(v) + "/" + String(a[0]) + "/" + String(a.length);
        }`),
      ).toBe("a/b/1");
    });

    it("splice.call removes from the middle", async () => {
      expect(
        await run(`export function test(): string {
          const a: any[] = ["a", "b", "c"];
          (Array.prototype.splice as any).call(a, 1, 1);
          return String(a[0]) + String(a[1]) + "/" + String(a.length);
        }`),
      ).toBe("ac/2");
    });

    it("repeated uncurried pushes accumulate in order", async () => {
      expect(
        await run(`export function test(): string {
          ${UNCURRY}
          const a: any[] = [];
          __push(a, "x");
          __push(a, "y");
          __push(a, "z");
          return String(__join(a, ";")) + "/" + String(a.length);
        }`),
      ).toBe("x;y;z/3");
    });

    it("a NUMERIC vec (f64 elements, not externref) round-trips through the box/unbox path", async () => {
      expect(
        await run(`export function test(): number {
          ${UNCURRY}
          const a: number[] = [1, 2];
          __push(a, 3);
          return a[0] + a[1] + a[2] + a.length;
        }`),
      ).toBe(9);
    });
  });
});

// (#3603 S1 follow-up) The write-back registry must survive test262 DELETING
// host intrinsics. `propertyHelper.js`'s `verifyProperty` is destructive by
// design — its `isConfigurable` probe does `delete obj[name]` — so
// `test/built-ins/WeakMap/prototype/get/get.js` deletes `WeakMap.prototype.get`
// for the whole realm. This module's registry is itself a `WeakMap` and is
// probed by `snapshotVecMirrors` on EVERY host-call bridge (far more often than
// `__make_iterable` runs), so it was the first thing to break:
// `TypeError: _vecMirrorSource.get is not a function`. Measured as a real
// regression caused by this module on merge_group 30179758665 (1 file).
//
// SCOPE — this is a UNIT test of the module, deliberately not end-to-end.
// `src/runtime.ts` has the same exposure in several PRE-EXISTING WeakMaps
// (`_hostProxyCache`, `__make_iterable`'s `convertedArrays`, …), so a compiled
// end-to-end program cannot survive the deletion regardless of this fix, and a
// test written that way would fail for defects this change does not own. That
// broader exposure is a separate finding. What IS this module's contract is
// asserted directly below.
describe("#3603 S1 — vec-mirror registry survives deletion of WeakMap intrinsics", () => {
  it("registerVecMirror / vecForMirror still work after `delete WeakMap.prototype.{get,set}`", async () => {
    const { registerVecMirror, vecForMirror } = await import("../src/runtime/vec-mirror-writeback.js");

    const savedGet = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get");
    const savedSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, "set");
    const mirror: unknown[] = [];
    const vec = { __fakeVec: true };

    let roundTripped: unknown;
    let thrown: unknown;
    let deletionTookEffect = false;
    try {
      // biome-ignore lint/performance/noDelete: the test must reproduce verifyProperty deleting the intrinsic.
      delete (WeakMap.prototype as any).get;
      // biome-ignore lint/performance/noDelete: assigning undefined would not exercise the destructive probe.
      delete (WeakMap.prototype as any).set;
      deletionTookEffect =
        typeof (WeakMap.prototype as any).get === "undefined" && typeof (WeakMap.prototype as any).set === "undefined";
      registerVecMirror(mirror, vec);
      roundTripped = vecForMirror(mirror);
    } catch (e) {
      thrown = e;
    } finally {
      // Restore BEFORE asserting — vitest's own matcher registry is a Map, so
      // `expect()` throws `globalThis[MATCHERS_OBJECT].get is not a function`
      // while the intrinsic is missing. The assertion library has the same
      // exposure as the code under test.
      if (savedGet) Object.defineProperty(WeakMap.prototype, "get", savedGet);
      if (savedSet) Object.defineProperty(WeakMap.prototype, "set", savedSet);
    }

    expect(deletionTookEffect).toBe(true); // the deletion really happened
    expect(thrown).toBeUndefined(); // no `_vecMirrorSource.get is not a function`
    expect(roundTripped).toBe(vec); // and the registry still round-trips
  });

  it("vecForMirror returns undefined for a non-mirror, intrinsics intact", async () => {
    const { vecForMirror } = await import("../src/runtime/vec-mirror-writeback.js");
    expect(vecForMirror([])).toBeUndefined();
    expect(vecForMirror(null)).toBeUndefined();
    expect(vecForMirror(42)).toBeUndefined();
  });
});
