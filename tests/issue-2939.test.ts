// (#2939) Dynamic dispatch of an any-typed closure param: a callback function
// expression defined in an INNER scope (the test262 runner's `export function
// test()` wrap shape) must be a dispatch candidate so `fn(...)` invokes it.
// Before the fix the callback's wrapper type was registered only lazily at its
// (later-compiled) value site, so the higher-order body saw zero candidates and
// silently dropped the call — the ~814 vacuous testWith*Constructors passes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const envImports = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(envImports, "must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

async function runStandaloneExpectTrap(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  try {
    (instance.exports as { test?: () => unknown }).test?.();
    return false;
  } catch {
    return true;
  }
}

describe("#2939 nested-scope any-param callback dispatch", () => {
  it("nested 1-param callback is invoked (was dropped)", async () => {
    const src = `
function tw(fn: any): void { const c: any = [1, 2]; for (let i = 0; i < c.length; i++) fn(c[i]); }
export function test(): number {
  let hit = 0;
  tw(function (TA: any) { hit = hit + 1; });
  return hit;
}`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("nested 2-arg call / 2-param callback (the harness shape)", async () => {
    const src = `
function pass(x: any): any { return x; }
function tw(fn: any): void { const c: any = [1, 2]; for (let i = 0; i < c.length; i++) fn(c[i], pass); }
export function test(): number {
  let hit = 0;
  tw(function (TA: any, mk: any) { hit = hit + 1; });
  return hit;
}`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("arity tolerance: 2 args → 1-param callback (extra arg dropped)", async () => {
    const src = `
function pass(x: any): any { return x; }
function tw(fn: any): void { const c: any = [1, 2]; for (let i = 0; i < c.length; i++) fn(c[i], pass); }
export function test(): number {
  let hit = 0;
  tw(function (TA: any) { hit = hit + 1; });
  return hit;
}`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("nested callback capturing an outer local also dispatches", async () => {
    const src = `
function make(): number {
  let hit = 0;
  function tw(fn: any): void { const c: any = [1, 2]; for (let i = 0; i < c.length; i++) fn(c[i]); }
  tw(function (TA: any) { hit = hit + 1; });
  return hit;
}
export function test(): number { return make(); }`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("callback stored in a variable then passed also dispatches", async () => {
    const src = `
function tw(fn: any): void { const c: any = [1, 2]; for (let i = 0; i < c.length; i++) fn(c[i]); }
export function test(): number {
  let hit = 0;
  const cb = function (TA: any) { hit = hit + 1; };
  tw(cb);
  return hit;
}`;
    expect(await runStandalone(src)).toBe(2);
  });

  it("inject-throw proof: the callback body genuinely executes (traps)", async () => {
    const src = `
function tw(fn: any): void { const c: any = [1, 2]; for (let i = 0; i < c.length; i++) fn(c[i]); }
export function test(): number {
  let hit = 0;
  tw(function (TA: any) { throw new Error("RAN"); });
  return hit;
}`;
    expect(await runStandaloneExpectTrap(src)).toBe(true);
  });

  it("gc/host lane: nested any-param callback now dispatches too (#3074 de-gated the fix)", async () => {
    // HISTORY: the #2939 fix was originally STANDALONE-GATED, and this test
    // asserted the gc/host lane's drop-gap persisted (`hit === 0`). #3074 then
    // de-gated the nested-callback pre-registration to BOTH lanes, so the gc
    // lane dispatches as well — the old `toBe(0)` expectation was stale from
    // the moment #3074 merged (it was one of the suite's known pre-existing
    // fails on main; re-verified failing on pristine main 2026-07-09 under
    // #3087). Assert the FIXED behavior: the callback runs once per element.
    const r = await compile(
      `
function tw(fn: any): void { const c: any = [1, 2]; for (let i = 0; i < c.length; i++) fn(c[i]); }
export function test(): number {
  let hit = 0;
  tw(function (TA: any) { hit = hit + 1; });
  return hit;
}`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary!, (r as any).importObject ?? {});
    // #3074-fixed gc-lane behavior: callback dispatches for both elements.
    expect((instance.exports as any).test?.()).toBe(2);
  });
});
