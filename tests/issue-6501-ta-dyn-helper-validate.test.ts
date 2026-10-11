import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/**
 * #6501 — `set`, `fill`, `copyWithin` and `reverse` are routed at the call site
 * to dedicated `ensureTaDyn*Helper` natives, so they never reached the
 * §23.2.4.4 ValidateTypedArray prologue #5961 put on the generic
 * `__call_m_*` dispatcher. On a DETACHED view they mutated nothing and
 * returned normally instead of throwing.
 *
 * Every program here builds the view through a `TA` PARAMETER, which is what
 * makes the receiver a `$__ta_dyn_view`. Written as `new Float64Array(8)` the
 * receiver takes the STATIC path, the helper is never reached, and the test
 * goes vacuously green — that is exactly how this survived #5961, so the shape
 * is load-bearing, not stylistic.
 */

const CTORS = ["Uint8Array", "Int16Array", "Float64Array", "Uint8ClampedArray"] as const;

async function run(src: string): Promise<number> {
  const res = (await compile(src, { target: "standalone" } as never)) as unknown as {
    success: boolean;
    binary: Uint8Array;
    imports: unknown[];
    errors?: { message: string }[];
  };
  expect(res.success, res.errors?.[0]?.message ?? "compile failed").toBe(true);
  expect(res.imports, "standalone must emit zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(res.binary, {} as never);
  const ex = instance.exports as Record<string, CallableFunction>;
  if (typeof ex._start === "function") ex._start();
  return ex.probe() as number;
}

/** A detached dyn view: 1 if the method threw a TypeError, 0 if it returned. */
function detachedProgram(ctor: string, call: string): string {
  return `
function make(TA: any, n: any): any { return new TA(n); }
export function probe(): number {
  const buf = new ArrayBuffer(64);
  const t: any = make(${ctor}, buf);
  (buf as any).__detached__ = true;
  try { ${call}; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }
}`;
}

/** A LIVE dyn view: the guard must be completely inert. */
function liveProgram(ctor: string): string {
  return `
function make(TA: any, n: any): any { return new TA(n); }
export function probe(): number {
  const t: any = make(${ctor}, 4);
  let score = 0;
  t[0] = 1; t[1] = 2; t[2] = 3; t[3] = 4;
  const r: any = t.reverse();
  if (t[0] === 4 && t[3] === 1) { score += 1; }
  if (r === t) { score += 2; }            // returns the same object, not a copy
  const f: any = t.fill(7, 1, 3);
  if (t[1] === 7 && t[2] === 7 && t[0] === 4) { score += 4; }
  if (f === t) { score += 8; }
  const c: any = t.copyWithin(0, 2);
  if (c === t) { score += 16; }
  t.set([5, 6] as any, 1);
  if (t[1] === 5 && t[2] === 6) { score += 32; }
  return score;
}`;
}

describe("#6501 — helper-routed TypedArray mutators validate a detached view", () => {
  for (const ctor of CTORS) {
    it(`throws on a detached ${ctor} for reverse / fill / copyWithin`, async () => {
      expect(await run(detachedProgram(ctor, "t.reverse()")), "reverse").toBe(1);
      expect(await run(detachedProgram(ctor, "t.fill(7)")), "fill").toBe(1);
      expect(await run(detachedProgram(ctor, "t.copyWithin(0, 2)")), "copyWithin").toBe(1);
    });
  }

  for (const ctor of CTORS) {
    it(`leaves a LIVE ${ctor} untouched — the guard must be inert`, async () => {
      // 1|2|4|8|16|32 — every mutation lands AND every mutator returns `this`.
      expect(await run(liveProgram(ctor))).toBe(63);
    });
  }

  it("keeps the generic-dispatcher methods working (they never took this path)", async () => {
    // sort/slice already passed via #5961's prologue; this is the control that
    // the call-site splice did not disturb them.
    const src = `
function make(TA: any, n: any): any { return new TA(n); }
export function probe(): number {
  const t: any = make(Float64Array, 4);
  t[0] = 3; t[1] = 1; t[2] = 4; t[3] = 2;
  t.sort();
  const s: any = t.slice(1);
  return (t[0] === 1 ? 1 : 0) + (s.length === 3 ? 10 : 0);
}`;
    expect(await run(src)).toBe(11);
  });
});
