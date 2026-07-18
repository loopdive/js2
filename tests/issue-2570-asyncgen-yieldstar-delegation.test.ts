// #2570 — lazy/suspending async-generator runtime: `yield*` DELEGATION.
//
// The issue's repro: an eager generator runtime drains `yield* inner()` to
// completion BEFORE the consumer's first `.next()`, so side effects of the
// delegated iterator run at construction time — violating the spec's lazy,
// one-step-per-`next()` semantics (`log.length === 0` must hold right after
// `outer()`).
//
// This suite pins the DRIVEN lane fix: `yield* inner(...)` over an
// earlier-declared, itself-drivable top-level async generator now compiles to
// a lazy 4-state pump loop on the #2906 CFG resume machine (init → pump →
// chk → yield-out with a BACK-EDGE to pump), so ONE outer `next()` pumps the
// inner exactly ONE step. The inner's `next()`-promise is a native `$Promise`
// minted by its own `__async_gen_next_<stem>` driver, so a sync-settling inner
// yield advances in the same dispatch while a genuinely-pending one (inner
// `yield await P`) suspends the OUTER frame and resumes via the microtask
// drain — genuine two-level suspension, host-free.
//
// Out of scope (v1, correct-or-legacy): delegation over arbitrary iterables /
// hand-built async iterables (the observable GetIterator protocol), nested or
// forward-referenced inner producers, `.throw()`/`.return()`/sent-value
// forwarding into the delegate (driven gens do not support them yet — #2906
// 3d-iii). gc/host keeps the legacy path byte-identically.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface GenExports {
  outer: (...args: number[]) => unknown;
  __async_gen_next_outer: (frame: unknown) => unknown;
  __async_gen_p_state: (p: unknown) => number;
  __async_gen_result_done: (p: unknown) => number;
  __async_gen_result_value: (p: unknown) => number;
  __drain_microtasks: () => void;
  logLen?: () => number;
}

async function instantiate(src: string, target: "wasi" | "standalone" = "wasi"): Promise<GenExports> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // Host-free: the module must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as unknown as GenExports;
}

/** Drive one outer `next()`, drain, read the settled IteratorResult. */
function step(ex: GenExports, frame: unknown): { pendingBeforeDrain: boolean; done: number; value: number } {
  const p = ex.__async_gen_next_outer(frame);
  const pendingBeforeDrain = ex.__async_gen_p_state(p) === 0;
  ex.__drain_microtasks();
  expect(ex.__async_gen_p_state(p)).toBe(1); // FULFILLED
  return { pendingBeforeDrain, done: ex.__async_gen_result_done(p), value: ex.__async_gen_result_value(p) };
}

const LAZY_REPRO = `
let log: number[] = [];
export async function* inner(): AsyncGenerator<number> {
  log.push(1);
  yield 10;
  log.push(2);
  yield 20;
  log.push(3);
}
export async function* outer(): AsyncGenerator<number> {
  yield* inner();
}
export function logLen(): number { return log.length; }
`;

describe("#2570 — async-generator yield* delegation (lazy, suspending)", () => {
  it("THE issue repro: nothing runs before the first next(); side effects interleave one step per next()", async () => {
    const ex = await instantiate(LAZY_REPRO);
    const frame = ex.outer();
    // The eager-buffer bug: log.length was already 3 here. Lazy: still 0 —
    // inner() has not even been CALLED yet (the init state runs on the first
    // kick that reaches the yield*).
    expect(ex.logLen!()).toBe(0);
    const s1 = step(ex, frame);
    expect([s1.done, s1.value]).toEqual([0, 10]);
    expect(ex.logLen!()).toBe(1); // exactly ONE inner step ran
    const s2 = step(ex, frame);
    expect([s2.done, s2.value]).toEqual([0, 20]);
    expect(ex.logLen!()).toBe(2);
    const s3 = step(ex, frame);
    expect(s3.done).toBe(1); // final pump runs the inner tail, then outer completes
    expect(ex.logLen!()).toBe(3);
  });

  it("same repro drives host-free under --target standalone (carrier ON — all gens drivable)", async () => {
    const ex = await instantiate(LAZY_REPRO, "standalone");
    const frame = ex.outer();
    expect(ex.logLen!()).toBe(0);
    const s1 = step(ex, frame);
    expect([s1.done, s1.value]).toEqual([0, 10]);
    expect(ex.logLen!()).toBe(1);
    expect(step(ex, frame).value).toBe(20);
    expect(step(ex, frame).done).toBe(1);
  });

  it("GENUINE two-level suspension: a pending inner awaited yield suspends the OUTER frame; the drain resumes both", async () => {
    const ex = await instantiate(`
      export async function* inner(): AsyncGenerator<number> {
        yield await Promise.resolve(1).then((v: number) => v + 10);
        yield await Promise.resolve(2).then((v: number) => v + 10);
      }
      export async function* outer(): AsyncGenerator<number> {
        yield* inner();
      }
    `);
    const frame = ex.outer();
    const s1 = step(ex, frame);
    expect(s1.pendingBeforeDrain).toBe(true); // outer next()-promise pending until the microtask drain
    expect([s1.done, s1.value]).toEqual([0, 11]);
    const s2 = step(ex, frame);
    expect(s2.pendingBeforeDrain).toBe(true);
    expect([s2.done, s2.value]).toEqual([0, 12]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("composes: plain yields around TWO delegate segments, inner params/args", async () => {
    const ex = await instantiate(`
      export async function* inner(base: number): AsyncGenerator<number> {
        yield base;
        yield base + 1;
      }
      export async function* outer(): AsyncGenerator<number> {
        yield 1;
        yield* inner(100);
        yield 2;
        yield* inner(200);
        yield 3;
      }
    `);
    const frame = ex.outer();
    const got: number[] = [];
    for (let i = 0; i < 10; i++) {
      const s = step(ex, frame);
      if (s.done) break;
      got.push(s.value);
    }
    expect(got).toEqual([1, 100, 101, 2, 200, 201, 3]);
  });

  it("rejection propagates: a rejected inner next() REJECTS the outer's current next()-promise", async () => {
    const src = `
      export async function* inner(): AsyncGenerator<number> {
        yield await Promise.reject(99);
      }
      export async function* outer(): AsyncGenerator<number> {
        yield* inner();
      }
    `;
    const r = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as unknown as GenExports;
    const frame = ex.outer();
    const p = ex.__async_gen_next_outer(frame);
    ex.__drain_microtasks();
    expect(ex.__async_gen_p_state(p)).toBe(2); // REJECTED — §27.6.4.2.5.g, not vacuously fulfilled
  });

  it("guardrails: gc/host lane unchanged (legacy imports); forward-referenced inner stays legacy (#680 CE) — v1 bound", async () => {
    const src = `
      export async function* inner(): AsyncGenerator<number> { yield 1; }
      export async function* outer(): AsyncGenerator<number> { yield* inner(); }
    `;
    // gc: legacy __create_async_generator path with host imports — UNCHANGED.
    const gc = await compile(src, { fileName: "test.ts" });
    expect(gc.success).toBe(true);
    expect((gc.imports ?? []).length).toBeGreaterThan(0);
    // A forward-referenced inner (declared AFTER the outer) is not admitted —
    // its driver would not be registered when the outer's machine emits. The
    // outer keeps today's behavior (the #680 CE on host-free targets).
    const fwd = await compile(
      `
      export async function* outer(): AsyncGenerator<number> { yield* inner(); }
      export async function* inner(): AsyncGenerator<number> { yield 1; }
      `,
      { fileName: "test.ts", target: "wasi" },
    );
    expect(fwd.success).toBe(false);
  });
});
