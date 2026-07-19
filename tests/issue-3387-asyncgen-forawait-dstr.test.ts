// #3387 — NESTED async generators with DESTRUCTURING for-await heads drive
// host-free (#3178 child). Root-cause finding: the nested-vs-module-scope
// "drivability seam" of the umbrella decomposition was NOT a missing planner
// arm — identifier-head `for await` inside a driven async gen already rides
// the bounded body as a suspend-free LEAD (the sync for-await lowering in
// loops.ts runs the whole loop inside one dispatch of the #2906 resume fn).
// The sole rejector of the test262 `async-gen-dstr-*` cohort (~577 rows) was
// `asyncGenBodyHasPatternLocals`, which bailed ANY non-identifier
// VariableDeclaration — including the for-await HEAD pattern, which is not a
// frame-spilled own local at all (its names bind fresh per element, entirely
// within one dispatch — no suspend crosses them).
//
// The fix exempts admissible for-await HEAD patterns from that gate.
// Correct-or-legacy bound (probe-verified against the real corpus): a NESTED
// sub-pattern with an initializer stays legacy, because the sync for-await
// destructure deliberately skips nested defaults under `awaitModifier`
// (the #2692 capture-box / #2566 iterator-over-consume guard) — admitting it
// would run with the default unapplied (wrong values) instead of refusing.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Ex {
  test: () => number;
  probe: () => number;
  __drain_microtasks?: () => void;
}

/** Compile standalone, assert host-free, instantiate, kick test(), drain, read probe(). */
async function driveStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as unknown as Ex;
  ex.test();
  ex.__drain_microtasks?.();
  return ex.probe();
}

/** Compile standalone and assert the module KEEPS the legacy host imports (stays bailed). */
async function expectLegacy(src: string): Promise<void> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success).toBe(true);
  expect((r.imports ?? []).length).toBeGreaterThan(0);
}

describe("#3387 — dstr for-await heads in driven async gens (standalone, host-free)", () => {
  it("THE corpus shape: array pattern with leaf default, capture visible", async () => {
    // test262 async-gen-dstr template: for await (const [x = 23] of [[undefined]])
    const v = await driveStandalone(`
      var callCount = 0;
      var seen = -1;
      export function test(): number {
        async function* fn() {
          for await (const [x = 23] of [[undefined]]) {
            seen = (x as number);
            callCount = callCount + 1;
          }
        }
        fn().next();
        return 0;
      }
      export function probe(): number { return callCount * 100 + seen; }
    `);
    expect(v).toBe(123);
  });

  it("object pattern head", async () => {
    const v = await driveStandalone(`
      var got = -1;
      export function test(): number {
        async function* fn() {
          for await (const { x } of [{ x: 11 }]) { got = (x as number); }
        }
        fn().next();
        return 0;
      }
      export function probe(): number { return got; }
    `);
    expect(v).toBe(11);
  });

  it("multi-element iterations + trailing yield: .then ordering and done flags", async () => {
    const v = await driveStandalone(`
      var v1 = -1; var d1 = -1; var v2 = -1; var d2 = -1; var sum = 0;
      export function test(): number {
        async function* fn() {
          for await (const [a, b] of [[1, 2], [3, 4]]) {
            sum = sum + (a as number) + (b as number);
          }
          yield sum;
        }
        const it = fn();
        it.next().then((r1: any) => {
          v1 = r1.value as number;
          d1 = r1.done ? 1 : 0;
          it.next().then((r2: any) => {
            v2 = r2.value === undefined ? 0 : (r2.value as number);
            d2 = r2.done ? 1 : 0;
          });
        });
        return 0;
      }
      export function probe(): number { return d1 * 1000 + v1 * 100 + d2 * 10 + v2; }
    `);
    // r1: {value: 10, done: false} → 0·1000 + 10·100; r2: {value: undefined, done: true} → 10.
    expect(v).toBe(1010);
  });

  it("callCount visible at next()-promise resolution; result.done true after loop", async () => {
    const v = await driveStandalone(`
      var callCount = 0; var doneFlag = -1; var afterCount = -1;
      export function test(): number {
        async function* fn() {
          for await (const [x = 23] of [[undefined]]) { callCount = callCount + 1; }
        }
        fn().next().then((result: any) => {
          afterCount = callCount;
          doneFlag = result.done ? 1 : 0;
        });
        return 0;
      }
      export function probe(): number { return doneFlag * 100 + afterCount; }
    `);
    expect(v).toBe(101);
  });

  it("loop-body throw rejects the current next()-promise", async () => {
    const v = await driveStandalone(`
      var caught = 0;
      export function test(): number {
        async function* fn() {
          for await (const [x] of [[1]]) { throw new Error("boom"); }
        }
        fn().next().then(
          (r: any) => { caught = 1; },
          (e: any) => { caught = 2; },
        );
        return 0;
      }
      export function probe(): number { return caught; }
    `);
    expect(v).toBe(2);
  });

  it("elision, rest, nested-no-init, renamed and defaulted obj props all deliver", async () => {
    const v = await driveStandalone(`
      var acc = 0;
      export function test(): number {
        async function* fn() {
          for await (const [, x] of [[1, 2]]) { acc = acc + (x as number); }           // 2
          for await (const [h, ...rest] of [[1, 2, 3]]) { acc = acc + rest.length; }   // +2
          for await (const [[y]] of [[[5]]]) { acc = acc + (y as number); }            // +5
          for await (const { p: q = 7 } of [{}]) { acc = acc + (q as number); }        // +7
        }
        fn().next();
        return 0;
      }
      export function probe(): number { return acc; }
    `);
    expect(v).toBe(16);
  });

  it("empty source: zero iterations, done immediately", async () => {
    const v = await driveStandalone(`
      var callCount = 0; var doneFlag = -1;
      export function test(): number {
        async function* fn() {
          for await (const [x] of []) { callCount = callCount + 1; }
        }
        fn().next().then((r: any) => { doneFlag = r.done ? 1 : 0; });
        return 0;
      }
      export function probe(): number { return doneFlag * 100 + callCount; }
    `);
    expect(v).toBe(100);
  });

  it("class async-gen METHOD lane with dstr for-await head", async () => {
    const v = await driveStandalone(`
      var got = -1;
      class C {
        async *m() {
          for await (const [x = 5] of [[undefined]]) { got = (x as number); }
        }
      }
      export function test(): number { new C().m().next(); return 0; }
      export function probe(): number { return got; }
    `);
    expect(v).toBe(5);
  });

  it("correct-or-legacy: NESTED pattern with initializer stays on the legacy path", async () => {
    // The sync for-await destructure skips nested defaults under awaitModifier
    // (#2692/#2566 guard) — driving this shape would bind nothing. Must bail.
    await expectLegacy(`
      var got = -1;
      export function test(): number {
        async function* fn() {
          for await (const [[x] = [7]] of [[]]) { got = (x as number); }
        }
        fn().next();
        return got;
      }
    `);
  });

  it("correct-or-legacy: obj nested pattern with initializer stays legacy", async () => {
    await expectLegacy(`
      var got = -1;
      export function test(): number {
        async function* fn() {
          for await (const { w: { x } = { x: 4 } } of [{ w: undefined }]) { got = (x as number); }
        }
        fn().next();
        return got;
      }
    `);
  });

  it("correct-or-legacy: yield inside a dstr initializer stays legacy", async () => {
    await expectLegacy(`
      export function test(): number {
        var callCount = 0;
        async function* fn() {
          for await (const [x = yield 9] of [[undefined]]) { callCount = callCount + 1; }
        }
        fn().next();
        return callCount;
      }
    `);
  });

  it("correct-or-legacy: return inside the loop body stays legacy", async () => {
    await expectLegacy(`
      export function test(): number {
        async function* fn() {
          for await (const [x] of [[1]]) { return; }
        }
        fn().next();
        return 0;
      }
    `);
  });

  it("body pattern locals (NOT the head) still reject the whole body", async () => {
    await expectLegacy(`
      export function test(): number {
        var got = -1;
        async function* fn() {
          const { a } = { a: 1 };
          yield a;
        }
        fn().next();
        return got;
      }
    `);
  });
});
