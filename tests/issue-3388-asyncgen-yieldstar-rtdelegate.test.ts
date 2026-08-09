// #3388 — async-generator `yield*` RUNTIME DELEGATION over an arbitrary
// iterable operand (identifier / member / string / non-drivable call), the
// nested/method-producer cohort of the standalone `__gen_yield_star` leak.
//
// `analyzeAsyncGen` previously rejected any `yield*` whose operand was not a
// driven-async-gen CALL (#2570) or an ARRAY LITERAL (#3132 S1), demoting the
// whole body to the legacy #680 host-buffer path. #3388 adds an `rtDelegate`
// segment: `planAsyncGenCfg` lowers `yield* <expr>` as a 3-state runtime loop
// (init GetAsyncIterator → pump `__iterator_next` sync-step → settleYield
// back-edge), the producer-side dual of `planForAwaitCfg`. One element per
// outer `next()` kick, host-free.
//
// GetIterator §7.4.1 error path: a non-iterable operand now throws a CATCHABLE
// TypeError (the outer driven `next()` promise REJECTS) instead of trapping —
// the `__iterator` non-iterable tail was changed from a `ref.cast $Vec` hard
// trap to a native TypeError throw (spec-correct for all GetIterator consumers).
//
// Slice 1 (correct-or-legacy): forwards `next()` only; `.return()`/`.throw()`
// forwarding into the delegate is #3389. gc/host keeps the legacy path.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface GenExports {
  [k: string]: (...args: unknown[]) => unknown;
}

async function instantiate(src: string, target: "wasi" | "standalone" = "wasi"): Promise<GenExports> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // Host-free: the rtDelegate lane requests no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as unknown as GenExports;
}

/** Drive one outer next(), drain microtasks, read the settled IteratorResult. */
// (#3178) The DONE result's `value` field now carries the canonical undefined
// singleton (spec: a completed IteratorResult's value IS undefined), so the
// f64 reader probe reports ToNumber(undefined) = NaN — the same convention the
// #2979 sentinel producer established for exhausted sync-gen reads. The old
// `0` came from the pre-#3178 null-externref rep.
function step(ex: GenExports, stem: string, frame: unknown): { done: number; value: number } {
  const p = ex[`__async_gen_next_${stem}`](frame);
  ex.__drain_microtasks(frame);
  return { done: ex.__async_gen_result_done(p) as number, value: ex.__async_gen_result_value(p) as number };
}

/** True when the outer next() promise settled REJECTED (state 2). */
function stepRejected(ex: GenExports, stem: string, frame: unknown): boolean {
  const p = ex[`__async_gen_next_${stem}`](frame);
  ex.__drain_microtasks(frame);
  return (ex.__async_gen_p_state(p) as number) === 2;
}

describe("#3388 — async-gen yield* runtime delegation (standalone, host-free)", () => {
  it("yield* over an identifier bound to an array forwards each element in order", async () => {
    const ex = await instantiate(`
      export async function* g(): AsyncGenerator<number> {
        const arr = [11, 22, 33];
        yield* arr;
      }
    `);
    const f = ex.g();
    expect([step(ex, "g", f), step(ex, "g", f), step(ex, "g", f), step(ex, "g", f)]).toEqual([
      { done: 0, value: 11 },
      { done: 0, value: 22 },
      { done: 0, value: 33 },
      { done: 1, value: NaN },
    ]);
  });

  it("plain yields interleave correctly around a yield* delegation", async () => {
    const ex = await instantiate(`
      export async function* g(): AsyncGenerator<number> {
        yield 1;
        const arr = [2, 3];
        yield* arr;
        yield 4;
      }
    `);
    const f = ex.g();
    const rs = [0, 1, 2, 3, 4].map(() => step(ex, "g", f));
    expect(rs).toEqual([
      { done: 0, value: 1 },
      { done: 0, value: 2 },
      { done: 0, value: 3 },
      { done: 0, value: 4 },
      { done: 1, value: NaN },
    ]);
  });

  it("yield* over an array built from scalar params (identifier operand)", async () => {
    const ex = await instantiate(`
      export async function* g(a: number, b: number): AsyncGenerator<number> {
        const arr = [a, b];
        yield* arr;
      }
    `);
    const f = ex.g(7, 8);
    expect([step(ex, "g", f), step(ex, "g", f), step(ex, "g", f)]).toEqual([
      { done: 0, value: 7 },
      { done: 0, value: 8 },
      { done: 1, value: NaN },
    ]);
  });

  it("GetIterator §7.4.1: yield* over a non-iterable REJECTS with a TypeError (was a trap)", async () => {
    const ex = await instantiate(`
      export async function* g(n: number): AsyncGenerator<number> {
        yield* (n as any);
      }
    `);
    const f = ex.g(42);
    // The outer next() promise must settle REJECTED — not trap ('illegal cast').
    expect(stepRejected(ex, "g", f)).toBe(true);
  });

  it("empty array yield* completes immediately (done on first next)", async () => {
    const ex = await instantiate(`
      export async function* g(): AsyncGenerator<number> {
        const arr: number[] = [];
        yield* arr;
      }
    `);
    const f = ex.g();
    expect(step(ex, "g", f)).toEqual({ done: 1, value: NaN });
  });
});

describe("#3388 — non-generator regression: for-of over a non-iterable throws TypeError", () => {
  // The GetIterator throw-not-trap fix is spec-correct (§7.4.1) for EVERY
  // consumer of the native `__iterator`, including sync for-of. A non-iterable
  // must throw a catchable TypeError, not trap.
  it("for (const x of nonIterable) throws a catchable TypeError instead of trapping", async () => {
    const r = await compile(
      `export function test(n: number): number {
         try { for (const x of (n as any)) { return x; } return 0; }
         catch (e) { return e instanceof TypeError ? 99 : -1; }
       }`,
      { fileName: "test.ts", target: "standalone" },
    );
    expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test: (n: number) => number }).test(42)).toBe(99);
  });
});
