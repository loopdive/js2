// #3120 — async-generator implicit AsyncGeneratorYield await of the operand.
//
// §27.6.3.8 AsyncGeneratorYield(value) performs `Await(value)` on the yield
// OPERAND before suspending. The 3d-i drive machine implemented that await only
// for the explicit `yield await P` shape; a plain `yield <promise>` settled the
// RAW operand — the promise object f64-coerced to NaN, and a REJECTING operand
// fulfilled-NaN instead of rejecting the current next()-promise.
//
// Fix: `analyzeAsyncGen` classifies a plain `yield E` whose operand is
// statically Promise-typed as an AWAITED segment, riding the proven
// suspend+settleYield(fromSent) lane — but ONLY on the native-`$Promise`
// CARRIER lane (`isStandalonePromiseActive`, wasi today), where the suspend arm
// can assimilate the operand. The carrier-off standalone drive lane keeps the
// pre-#3120 plain classification byte-identically (its value gap is the #2980
// carrier widen's to close — demoting those bodies to the legacy #680 CE would
// break whole-module compiles). gc/host stays on the legacy path (drive off).
//
// Direct-drive proof harness mirrors tests/issue-2906-3di-asyncgen-producer.test.ts.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface GenExports {
  g: () => unknown;
  __async_gen_next_g: (frame: unknown) => unknown;
  __async_gen_p_state: (p: unknown) => number;
  __async_gen_result_done: (p: unknown) => number;
  __async_gen_result_value: (p: unknown) => number;
  __drain_microtasks: () => void;
}

async function instantiateAsyncGen(src: string): Promise<GenExports> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // Host-free: the module must request no imports.
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return instance.exports as unknown as GenExports;
}

/** Drive one `next()`, drain microtasks, read the settled IteratorResult. */
function step(ex: GenExports, frame: unknown): { pendingBeforeDrain: boolean; done: number; value: number } {
  const p = ex.__async_gen_next_g(frame);
  const pendingBeforeDrain = ex.__async_gen_p_state(p) === 0;
  ex.__drain_microtasks();
  expect(ex.__async_gen_p_state(p)).toBe(1); // FULFILLED
  return { pendingBeforeDrain, done: ex.__async_gen_result_done(p), value: ex.__async_gen_result_value(p) };
}

describe("#3120 — implicit §27.6.3.8 await of a plain promise yield operand (wasi carrier lane)", () => {
  it("THE fix: `yield Promise.reject(99)` REJECTS the next()-promise (was: fulfilled NaN)", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield Promise.reject(99);
      }
    `);
    const frame = ex.g();
    const p1 = ex.__async_gen_next_g(frame);
    ex.__drain_microtasks();
    expect(ex.__async_gen_p_state(p1)).toBe(2); // REJECTED — not vacuously fulfilled
  });

  it("`yield Promise.resolve(7)` yields the AWAITED value 7 (was: NaN)", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield Promise.resolve(7);
      }
    `);
    const frame = ex.g();
    const s1 = step(ex, frame);
    expect([s1.done, s1.value]).toEqual([0, 7]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("a Promise-typed LOCAL rides the awaited lane too: `const p = ...; yield p`", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        const p = Promise.resolve(7);
        yield p;
      }
    `);
    const frame = ex.g();
    expect(step(ex, frame).value).toBe(7);
    expect(step(ex, frame).done).toBe(1);
  });

  it("GENUINE suspension: a pending `.then`-chained operand suspends at kick=0 and resumes on drain", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield Promise.resolve(7).then((v: number) => v + 1);
      }
    `);
    const frame = ex.g();
    const s1 = step(ex, frame);
    expect(s1.pendingBeforeDrain).toBe(true); // suspended — value only after the drain
    expect([s1.done, s1.value]).toEqual([0, 8]);
    expect(step(ex, frame).done).toBe(1);
  });

  it("mixed body: promise yield then plain yield, in order", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield Promise.resolve(1);
        yield 2;
      }
    `);
    const frame = ex.g();
    expect(step(ex, frame).value).toBe(1);
    expect(step(ex, frame).value).toBe(2);
    expect(step(ex, frame).done).toBe(1);
  });

  it("FAST PATH preserved: a non-promise `yield 5` settles synchronously (no suspend state)", async () => {
    const ex = await instantiateAsyncGen(`
      export async function* g(): AsyncGenerator<number> {
        yield 5;
      }
    `);
    const frame = ex.g();
    const s1 = step(ex, frame);
    expect(s1.pendingBeforeDrain).toBe(false); // plain settleYield — no await round-trip
    expect([s1.done, s1.value]).toEqual([0, 5]);
  });

  it("parity: plain `yield Promise.reject` behaves exactly like `yield await Promise.reject`", async () => {
    const drive = async (src: string): Promise<number[]> => {
      const ex = await instantiateAsyncGen(src);
      const frame = ex.g();
      const states: number[] = [];
      for (let i = 0; i < 2; i++) {
        const p = ex.__async_gen_next_g(frame);
        ex.__drain_microtasks();
        states.push(ex.__async_gen_p_state(p));
      }
      return states;
    };
    const implicit = await drive(`
      export async function* g(): AsyncGenerator<number> { yield Promise.reject(99); yield 2; }
    `);
    const explicit = await drive(`
      export async function* g(): AsyncGenerator<number> { yield await Promise.reject(99); yield 2; }
    `);
    expect(implicit).toEqual(explicit);
  });

  it("byte-inert lanes: gc stays legacy (host imports); carrier-off standalone still COMPILES the promise-yield body (driven, pre-#3120 classification — no #680 demotion)", async () => {
    const src = `export async function* g(): AsyncGenerator<number> { yield Promise.resolve(7); }`;
    // gc/host: legacy __create_async_generator path — host-backed.
    const gc = await compile(src, { fileName: "test.ts" });
    expect(gc.success).toBe(true);
    expect((gc.imports ?? []).length).toBeGreaterThan(0);
    // standalone (carrier OFF): the await-free gate must still classify the
    // promise-typed plain yield as PLAIN — the body stays drivable and the
    // module keeps compiling (demoting it to the legacy path would be a #680
    // CE, breaking whole-module compiles — the first-cut regression the
    // #2980 fallback test caught).
    const standalone = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(standalone.success, standalone.success ? "" : `CE: ${standalone.errors?.[0]?.message}`).toBe(true);
  });
});
