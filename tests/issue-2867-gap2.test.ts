// #2867 Gap 2 — async-fn throw → reject routing in the native `$Promise` carrier,
// plus the call-site prerequisite that makes a drive-lowered async result
// (a real `$Promise`) observable via `.then` at all.
//
// Three coupled fixes, ALL gated on the native-`$Promise` carrier
// (`isStandalonePromiseActive`), so the gc/host lane is byte-unchanged.
// (#2867 S2 correction, 2026-08-15: this said "wasi-only today → widens to
// standalone in lockstep at #2895 slice 1d" and called standalone
// "still-host-backed" — STALE. The widen landed with the #2980 flip on
// 2026-07-10; standalone is on the carrier, and only gc/host is unchanged.)
//
//  1. async-frame.ts — a `throw` in an async body, OR a rejected await, settles the
//     frame's result `$Promise` REJECTED (was: uncaught Wasm throw → trap / promise
//     stranded pending). Wrapped the resume dispatch in `try/catch $exn → __promise_reject`;
//     the continuation re-throws a microtask-delivered rejection (MODE_THROW+ERROR),
//     and the rejected-now entry arm arms MODE_THROW instead of delivering the reason
//     as a value.
//  2. async-scheduler.ts — a `.then`/`.catch` HANDLER that throws now rejects the
//     chained promise (spec PerformPromiseThen reject step) instead of letting the
//     exception escape the microtask wrapper uncaught (which trapped the whole drain).
//  3. expressions.ts — a drive-lowered async call (`f()` for a genuinely-suspending
//     async fn) already returns a real `$Promise`; the legacy call-site contract
//     (#1313/#1727) double-wrapped it in a second `Promise.resolve`, so `.then`/
//     assignment read NaN / illegal-cast. Skip the wrap for drive-lowered callees.
//
// Host-free: instantiate with no imports, drive settlement with the module's own
// `__drain_microtasks` export. This is exactly the test262 `asyncTest(fn)` shape
// (`fn().then(verifyFulfill, $DONE)` — inline `.then` on the async call).
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
  // The carrier is host-free under wasi: the module must request no imports.
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

describe("#2867 Gap 2 — async throw→reject routing (wasi carrier)", () => {
  it("a drive-lowered async result is observable via inline .then (call-site no double-wrap)", async () => {
    // The dominant prerequisite: `f().then(onF)` must thread f()'s settled value,
    // not a Promise-of-Promise (was NaN). A genuinely-pending await drives f().
    const r = await runWasi(
      `
      async function f(): Promise<number> { await Promise.resolve(1).then((w: number) => w + 40); return 42; }
      export function run(): void { f().then((v: number) => { val = v; }); }
      `,
      ["getVal"],
    );
    expect(r.getVal).toBe(42);
  });

  it("a throw after a genuinely-pending await rejects the result promise", async () => {
    const r = await runWasi(
      `
      async function f(): Promise<number> {
        const x = await Promise.resolve(1).then((v: number) => v + 40);
        throw x; // 41
      }
      export function run(): void { f().then((v: number) => { ff = 1; }, (e: number) => { rj = e; }); }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 41 });
  });

  it("a rejected genuinely-pending await propagates as a rejection", async () => {
    const r = await runWasi(
      `
      async function f(): Promise<number> {
        const x = await Promise.resolve(1).then((v: number) => { throw v + 40; });
        return x;
      }
      export function run(): void { f().then((v: number) => { ff = 1; }, (e: number) => { rj = e; }); }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 41 });
  });

  it("a throwing .then handler rejects the chained promise (not a trap)", async () => {
    const r = await runWasi(
      `
      export function run(): void {
        Promise.resolve(1)
          .then((v: number) => { throw v + 8; })
          .then((v: number) => { ff = 1; }, (e: number) => { rj = e; });
      }
      `,
      ["getFf", "getRj"],
    );
    expect(r).toEqual({ getFf: 0, getRj: 9 });
  });

  it("a normal (non-throwing) async fulfilment still routes to the fulfil handler", async () => {
    const r = await runWasi(
      `
      async function f(): Promise<number> {
        const x = await Promise.resolve(1).then((v: number) => v + 40);
        return x + 1; // 42
      }
      export function run(): void { f().then((v: number) => { val = v; }, (e: number) => { rj = -1; }); }
      `,
      ["getVal", "getRj"],
    );
    expect(r).toEqual({ getVal: 42, getRj: 0 });
  });
});
