// #2867 Gap 4 — native, host-free `Promise.all` / `Promise.race` combinators on
// the native-`$Promise` carrier (`isStandalonePromiseActive`). These lower to the
// existing `$Promise` + reaction + microtask substrate — composing the same
// primitives the native `.then` machinery uses — instead of leaking the
// unsatisfiable `Promise_all`/`Promise_race` host imports.
//
// Host-free: instantiate with no imports and drive settlement with the module's
// own `__drain_microtasks` export — the test262 `asyncTest(fn)` shape.
//
// (#2867 S2 correction, 2026-08-15) This header said the gate was "wasi-only
// today → widens to standalone at #2895 slice 1d" and that standalone was
// "still-host-backed". Both are STALE: the widen landed with the #2980 flip on
// 2026-07-10, so this path is LIVE on `--target standalone` too, and the
// combinators do NOT leak host imports there (measured across all 729
// built-ins/Promise standalone files: zero host-import CEs). Only gc/host is
// inert.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runWasi(body: string, reads: string[]): Promise<Record<string, number>> {
  const src = `
let ff = 0;
let rj = 0;
let val = 0;
${body}
export function getFf(): number { return ff; }
export function getRj(): number { return rj; }
export function getVal(): number { return val; }
`;
  const r = await compile(src, { fileName: "t.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  // The carrier is host-free under wasi: the native combinators must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, CallableFunction>;
  ex.run!();
  ex.__drain_microtasks?.();
  const out: Record<string, number> = {};
  for (const n of reads) out[n] = ex[n]!() as number;
  return out;
}

describe("#2867 Gap 4 — native Promise.all/race (wasi carrier)", () => {
  it("Promise.all over already-fulfilled promises fulfils with the values array", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all([Promise.resolve(1), Promise.resolve(2)])
          .then((arr: any[]) => { val = arr[0] + arr[1]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 3, getRj: 0 });
  });

  it("Promise.all rejects as soon as one input rejects", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all([Promise.resolve(1), Promise.reject(9)])
          .then((arr: any[]) => { ff = 1; }, (e: number) => { rj = e; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 9 });
  });

  it("Promise.all([]) fulfils immediately", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all([]).then((arr: any[]) => { ff = 1; }, (e: number) => { rj = -1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 1, getRj: 0 });
  });

  it("Promise.all waits for genuinely-pending inputs before fulfilling", async () => {
    // Both inputs settle only on a later microtask (via .then), so the aggregate
    // must suspend and resume across the drain — the case the host import cannot
    // serve host-free.
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all([
          Promise.resolve(1).then((v: number) => v + 10),
          Promise.resolve(2).then((v: number) => v + 20),
        ]).then((arr: any[]) => { val = arr[0] + arr[1]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 33, getRj: 0 });
  });

  it("Promise.race fulfils with the first settled value", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.race([Promise.resolve(5), Promise.resolve(6)])
          .then((v: number) => { val = v; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 5, getRj: 0 });
  });

  it("Promise.race rejects when the first settled input rejects", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.race([Promise.reject(7), Promise.resolve(6)])
          .then((v: number) => { ff = 1; }, (e: number) => { rj = e; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 7 });
  });
});

// #2919 arm 1 — native `Promise.all`/`race` over an ARRAY-TYPED (non-literal)
// argument. The receiver was previously routed to the host `Promise_all`/`race`
// import, which is suppressed host-free under wasi → left `ref.null.extern` on
// the stack → the subsequent `.then`'s `ref.cast $Promise` trapped ("illegal
// cast"). These loop over the argument vec at runtime feeding the shared
// `__combinator_subscribe`, keeping the chain host-free and valid.
describe("#2919 arm 1 — native Promise.all/race over array-typed args (wasi carrier)", () => {
  it("Promise.all(arrVar) fulfils with the values array", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(1), Promise.resolve(2)];
        Promise.all(a).then((arr: any[]) => { val = arr[0] + arr[1]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 3, getRj: 0 });
  });

  it("Promise.all(arrVar) preserves element order", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)];
        Promise.all(a).then((arr: any[]) => { val = arr[0]*100 + arr[1]*10 + arr[2]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 123, getRj: 0 });
  });

  it("Promise.all(arrVar) rejects as soon as one input rejects", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(1), Promise.reject(7)];
        Promise.all(a).then((arr: any[]) => { ff = 1; }, (e: number) => { rj = e; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 7 });
  });

  it("Promise.all(emptyArrVar) fulfils immediately", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a: Promise<number>[] = [];
        Promise.all(a).then((arr: any[]) => { ff = 42; }, (e: number) => { rj = -1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 42, getRj: 0 });
  });

  it("Promise.all([...spread]) lowers natively", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(4), Promise.resolve(5)];
        Promise.all([...a]).then((arr: any[]) => { val = arr[0] + arr[1]; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 9, getRj: 0 });
  });

  it("Promise.race(arrVar) fulfils with the first settled value", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const a = [Promise.resolve(5), Promise.resolve(9)];
        Promise.race(a).then((v: number) => { val = v; }, (e: number) => { rj = -1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 5, getRj: 0 });
  });
});

// #2922 arms 2+3 — native `Promise.all`/`race` over NON-array-vec arguments.
// Arm 2: statically- or dynamically-non-iterable arguments settle the result
// promise REJECTED with a native TypeError (§27.2.4.1 step 3 /
// IfAbruptRejectPromise) instead of trapping in the suppressed host path.
// Arm 3a: Set/Map arguments materialize the #2162 collection projection
// (Set → values, Map → [k, v] entries) at compile time and drive the arm-1
// runtime loop. Arm 3b: custom `[Symbol.iterator]` iterables (and `any`-typed
// values, dispatched at runtime by `__combinator_to_vec`) drain through the
// closed-struct dispatchers into a canonical vec.
//
// NOT asserted here (pre-existing substrate gaps, verified via non-combinator
// controls on the same base): `e.message` string reads on an any-typed native
// error (#2962, in flight) and `pair[0]` index reads on an any-typed $ObjVec
// entries pair — both behave identically outside the combinator path.
describe("#2922 arms 2+3 — not-iterable→reject + Set + generic iterable (wasi carrier)", () => {
  it("Promise.all(nonIterableAny) rejects with a TypeError", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const x: any = 1;
        Promise.all(x).then((a: any[]) => { ff = 1; }, (e: any) => {
          rj = e instanceof TypeError ? 2 : 1;
        });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 2 });
  });

  it("Promise.all(null) rejects", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const x: any = null;
        Promise.all(x).then((a: any[]) => { ff = 1; }, (e: any) => { rj = 1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 1 });
  });

  it("Promise.race(undefined) rejects (race must not stay pending)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const x: any = undefined;
        Promise.race(x).then((v: any) => { ff = 1; }, (e: any) => { rj = 1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 1 });
  });

  it("Promise.all(numberLiteral) rejects (statically non-iterable)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.all(1 as any).then((a: any[]) => { ff = 1; }, (e: any) => { rj = 1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 1 });
  });

  it("Promise.all(plainObject) rejects (no @@iterator)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const x: any = { a: 1 };
        Promise.all(x).then((a: any[]) => { ff = 1; }, (e: any) => { rj = 1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 1 });
  });

  it("Promise.all(set) fulfils with the element values (arm 3a)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const s = new Set<number>();
        s.add(1); s.add(2);
        Promise.all(s).then((a: any[]) => { val = a[0] + a[1]; }, (e: any) => { rj = 1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 3, getRj: 0 });
  });

  it("Promise.race(set) fulfils with the first value (arm 3a)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const s = new Set<number>();
        s.add(5); s.add(6);
        Promise.race(s).then((v: any) => { val = v; }, (e: any) => { rj = 1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 5, getRj: 0 });
  });

  it("Promise.all(map) fulfils with one entry pair per element (arm 3a)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const m = new Map<number, number>();
        m.set(1, 10); m.set(2, 20);
        Promise.all(m).then((a: any[]) => { ff = 1; val = a.length; }, (e: any) => { rj = 1; });
      }
      `,
      ["getFf", "getVal", "getRj"],
    );
    expect(r).toEqual({ getFf: 1, getVal: 2, getRj: 0 });
  });

  it("Promise.all(anyTypedArray) fulfils via the runtime vec passthrough (arm 3b)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const x: any = [Promise.resolve(4), Promise.resolve(5)];
        Promise.all(x).then((a: any[]) => { val = a[0] + a[1]; }, (e: any) => { rj = 1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 9, getRj: 0 });
  });

  it("Promise.all(customIterable) drains and fulfils in order (arm 3b)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        let i = 0;
        const it = {
          [Symbol.iterator]() {
            return {
              next() {
                i = i + 1;
                if (i <= 2) return { value: i * 10, done: false };
                return { value: 0, done: true };
              },
            };
          },
        };
        Promise.all(it).then((a: any[]) => { val = a[0] * 10 + a[1]; }, (e: any) => { rj = 1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 120, getRj: 0 });
  });

  it("Promise.all(customIterable of pending promises) settles across microtasks (arm 3b)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        let i = 0;
        const it = {
          [Symbol.iterator]() {
            return {
              next() {
                i = i + 1;
                if (i === 1) return { value: Promise.resolve(1).then((v: number) => v + 10), done: false };
                if (i === 2) return { value: Promise.resolve(2).then((v: number) => v + 20), done: false };
                return { value: 0, done: true };
              },
            };
          },
        };
        Promise.all(it).then((a: any[]) => { val = a[0] + a[1]; }, (e: any) => { rj = 1; });
      }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 33, getRj: 0 });
  });

  it("Promise.all(emptyCustomIterable) fulfils with [] (arm 3b)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const it = {
          [Symbol.iterator]() {
            return { next() { return { value: 0, done: true }; } };
          },
        };
        Promise.all(it).then((a: any[]) => { ff = 1; val = a.length; }, (e: any) => { rj = 1; });
      }
      `,
      ["getFf", "getVal", "getRj"],
    );
    expect(r).toEqual({ getFf: 1, getVal: 0, getRj: 0 });
  });

  it("Promise.all($Promise argument) rejects (a promise is not iterable)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        const p: any = Promise.resolve(1);
        Promise.all(p).then((a: any[]) => { ff = 1; }, (e: any) => { rj = 1; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 1 });
  });
});
