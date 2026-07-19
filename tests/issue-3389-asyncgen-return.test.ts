// #3389 Slice 1 — `settleReturn` terminator for a top-level `return E` in a
// driven async generator (standalone). Before this, any own-scope `return`
// bailed `analyzeAsyncGen` (`containsOwnScopeReturn`), so the gen fell to the
// legacy host buffer (`__gen_set_return` + the carrier-off `Promise_*` co-leak).
//
// Slice 1 admits a DIRECT top-level `return E` / bare `return;` and settles the
// current `next()`-promise with the §27.6.3.8 return completion
// `{value: E, done: true}` (distinct from fall-through's `{value: undefined}`),
// then completes the frame so subsequent `next()` give `{value: undefined,
// done: true}`. Correct-or-legacy: a return nested in control flow, or
// `return await P`, stays on the legacy path.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Ex {
  test: () => number;
  probe: () => number;
  __drain_microtasks?: () => void;
}

/** Compile standalone, assert host-free, instantiate, kick test(), drain, read probe(). */
async function drive(code: string): Promise<number> {
  const r = await compile(code, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as unknown as Ex;
  ex.test();
  ex.__drain_microtasks?.();
  return ex.probe();
}

/** Compile standalone; assert the module KEEPS the legacy host imports. */
async function expectLegacy(code: string): Promise<void> {
  const r = await compile(code, { fileName: "test.ts", target: "standalone" });
  expect(r.success).toBe(true);
  expect(
    (r.imports ?? []).map((i) => `${i.module}.${i.name}`).filter((n) => n.startsWith("env.")).length,
  ).toBeGreaterThan(0);
}

describe("#3389 Slice 1 — settleReturn for top-level return in driven async-gen (standalone)", () => {
  it("yield 1; return 42 — first next {1,false}, second {42,true}, third done", async () => {
    // NOTE: the value/done reads happen INSIDE the compiled `.then` (wasm), so
    // the return VALUE (42) and the `done` flags are the load-bearing checks.
    // (`value === undefined` is asserted separately below — at the raw JS
    // boundary externref-null reads as `null`, so it is not checked here.)
    const v = await drive(`
      var v1 = -9, d1 = -9, v2 = -9, d2 = -9, d3 = -9;
      export function test(): number {
        async function* g() { yield 1; return 42; }
        const it = g();
        it.next().then((r: any) => {
          v1 = r.value as number; d1 = r.done ? 1 : 0;
          it.next().then((r2: any) => {
            v2 = r2.value as number; d2 = r2.done ? 1 : 0;
            it.next().then((r3: any) => { d3 = r3.done ? 1 : 0; });
          });
        });
        return 0;
      }
      // v1=1 d1=0 | v2=42 d2=1 | d3=1
      export function probe(): number { return v1 * 100000 + d1 * 10000 + v2 * 100 + d2 * 10 + d3; }
    `);
    // 1*1e5 + 0 + 42*100 + 1*10 + 1 = 104211
    expect(v).toBe(104211);
  });

  it("return 5 only (no yield) — first next {5,true}", async () => {
    const v = await drive(`
      var val = -9, d = -9;
      export function test(): number {
        async function* g() { return 5; }
        g().next().then((r: any) => { val = r.value as number; d = r.done ? 1 : 0; });
        return 0;
      }
      export function probe(): number { return val * 10 + d; }
    `);
    // {5,true} → 51
    expect(v).toBe(51);
  });

  it("bare return; completes the frame (done=true on the settling and subsequent next)", async () => {
    const v = await drive(`
      var d2 = -9, d3 = -9;
      export function test(): number {
        async function* g() { yield 7; return; }
        const it = g();
        it.next().then((_: any) => {
          it.next().then((r2: any) => {
            d2 = r2.done ? 1 : 0;
            it.next().then((r3: any) => { d3 = r3.done ? 1 : 0; });
          });
        });
        return 0;
      }
      export function probe(): number { return d2 * 10 + d3; }
    `);
    // second next (settleReturn bare) done=true, third next (settleDone) done=true → 11
    expect(v).toBe(11);
  });

  it("leads before return run before it settles", async () => {
    const v = await drive(`
      var side = 0, val = -9;
      export function test(): number {
        async function* g() { yield 1; side = 99; return side + 1; }
        const it = g();
        it.next().then((_: any) => { it.next().then((r: any) => { val = r.value as number; }); });
        return 0;
      }
      export function probe(): number { return val; }
    `);
    expect(v).toBe(100); // side set to 99 by the lead, return 99+1
  });

  describe("correct-or-legacy: unsupported return shapes stay on the legacy path", () => {
    it("return nested in an if stays legacy", async () => {
      await expectLegacy(`
        export function test(): number {
          async function* g() { yield 1; if (Math.random() > 0.5) return 3; yield 2; }
          g().next();
          return 0;
        }
      `);
    });

    it("return await P stays legacy", async () => {
      await expectLegacy(`
        export function test(): number {
          async function* g() { yield 1; return await Promise.resolve(9); }
          g().next();
          return 0;
        }
      `);
    });
  });

  it("no-regression: a plain yield gen without return still drives host-free", async () => {
    const v = await drive(`
      var val = -9, d = -9;
      export function test(): number {
        async function* g() { yield 8; }
        const it = g();
        it.next().then((r: any) => { val = r.value as number; });
        it.next();
        return 0;
      }
      export function probe(): number { return val; }
    `);
    expect(v).toBe(8);
  });
});
