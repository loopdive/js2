// #2895 PATH B slice-1d scaffolding — the `__drain_microtasks()` compiler
// intrinsic + the test262 runner hook. The intrinsic lets the test262
// `flags:[async]` harness (and standalone entrypoints) pump the native
// microtask ring so a genuinely-pending async-frame continuation runs before a
// settled value is observed — the prerequisite for the eventual slice-1d carrier
// widen measurement (without it even a correct drive layer scores 0 — the AG0 trap).
//
// Gated on the native-`$Promise` carrier (`isStandalonePromiseActive`): on the
// host-free targets it lowers to the real native drain; on the gc/host lane it
// is a void no-op (no native microtask ring), keeping that lane byte-identical.
//
// (#2867 S2, 2026-08-15) The carrier gate is NO LONGER wasi-only. The slice-1d
// widen landed with the **#2980 flip on 2026-07-10** — both
// `isStandalonePromiseActive` and `isStandaloneThenChainNativeActive` now read
// `ctx.standalone === true && !widenAsyncGenFallback(ctx)`
// (`async-scheduler.ts:4686` / `:4743`). This file previously asserted that
// `--target standalone` was "a host-free void no-op (inert until slice 1d)";
// that assertion had been FAILING ever since the flip, and it was failing for a
// reason unrelated to inertness (see the skipped case below). Measured on the
// current tree: the identical drive source returns **41 on standalone and 41 on
// wasi** — standalone is on the real drive, so the second case now pins that
// equality instead of the retired inertness claim.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("#2895 __drain_microtasks intrinsic (native-$Promise carrier)", () => {
  it("an in-source __drain_microtasks() drives a genuinely-pending continuation", async () => {
    const src = `
let val = 0;
async function f(): Promise<number> {
  const x = await Promise.resolve(1).then((v: number) => v + 40);
  return x; // 41
}
export function run(): number {
  f().then((v: number) => { val = v; }); // suspends; continuation carries the value
  __drain_microtasks();                  // pump the ring → f resumes → .then runs → val = 41
  return val;
}
`;
    const r = await compile(src, { fileName: "t.ts", target: "wasi" });
    expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
    // Host-free: the intrinsic + carrier request no imports.
    expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(41);
  });

  it("drives identically under --target standalone (the #2980 slice-1d widen)", async () => {
    // Post-widen truth, replacing the retired "inert / void no-op" assertion:
    // standalone runs the SAME native drive as wasi, host-free, same value.
    const src = `
let val = 0;
async function f(): Promise<number> {
  const x = await Promise.resolve(1).then((v: number) => v + 40);
  return x; // 41
}
export function run(): number {
  f().then((v: number) => { val = v; });
  __drain_microtasks();
  return val;
}
`;
    const r = await compile(src, { fileName: "t.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
    expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(41);
  });

  // KNOWN PRE-EXISTING DEFECT, deliberately left visible rather than deleted
  // (#2867 S2 investigation, 2026-08-15). `__drain_microtasks()` in an
  // otherwise-EMPTY module emits an INVALID binary on BOTH carrier lanes:
  //
  //   Compiling function #17:"__str_ws_start" failed:
  //   array.get_u[0] expected type (ref null 3), found local.get of type (ref null 2)
  //
  // Isolated: `export function run(): void { }` alone is valid on both lanes;
  // adding ONLY the drain call makes it invalid. So requesting the drain runtime
  // in a module with no other native-string usage emits a mistyped
  // native-string helper. A/B'd by file copy against the #2867 S2/S2b changes —
  // byte-identical failure on base and branch, so it is NOT caused by them, and
  // it is not about the drain being inert. This is the real reason the old
  // "inert until slice 1d" case was red. Needs its own issue.
  it.skip("minimal module with only __drain_microtasks() emits valid wasm (known defect: __str_ws_start)", async () => {
    for (const target of ["standalone", "wasi"] as const) {
      const r = await compile(`export function run(): void { __drain_microtasks(); }`, {
        fileName: "t.ts",
        target,
      });
      expect(r.success).toBe(true);
      expect(WebAssembly.validate(r.binary), `${target} binary should validate`).toBe(true);
    }
  });
});
