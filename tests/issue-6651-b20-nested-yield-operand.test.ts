// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 lane B20 — a `yield` nested inside ANOTHER yield's operand
 * (`yield [...yield]`, `yield yield`, `yield [...yield yield]`).
 *
 * Before this slice the native generator planner's `yield expr;` arm accepted
 * such a statement without looking at whether `expr` itself suspends: `emitYield`
 * made `expr` the state's yield-terminator expression, and the nested yield
 * inside it reached `compileYieldExpression` in the RESUME function, where
 * `fctx.isGenerator` is unset — so it reported into a non-fatal channel and
 * emitted nothing. The nested suspension was silently DROPPED: the generator had
 * one `.next()` too few and the operand saw `undefined` where the resumed value
 * belonged. test262 reported that as `value is not iterable` (standalone) /
 * `null is not iterable` (host) on the 16-row `yield-spread-arr-*` family.
 *
 * The cases pin the properties that made it wrong:
 *   - the nested yield SUSPENDS (the first `.next()` must not already carry the
 *     outer yield's value) — this is the one a count-blind fix would miss;
 *   - the resumed value keeps its JS identity across the suspension (an array
 *     that is then spread, a number that is then re-yielded);
 *   - a CHAIN of nested yields suspends inner-to-outer, in that order.
 * The last case is a NEGATIVE CONTROL: a yield sitting BEHIND observable work in
 * the operand (a later array element) is deliberately NOT admitted — it must
 * produce the honest #680 refusal rather than a silently reordered answer.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_GEN_RE = /^(__gen_|__create_generator|__create_async_generator)/;

async function run(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod);
  const leaks = imports.filter((i) => HOST_GEN_RE.test(i.name)).map((i) => `${i.module}::${i.name}`);
  expect(leaks, "no __gen_* host import").toEqual([]);
  const wasi: Record<string, () => number> = {};
  for (const i of imports) if (i.module === "wasi_snapshot_preview1") wasi[i.name] = () => 0;
  const instance = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi });
  return (instance.exports as { test(): number }).test();
}

describe("#6651 B20 — a yield nested in a yield's operand (native generator)", () => {
  it("spreads the resumed value: `yield [...yield]`", async () => {
    // language/statements/generators/yield-spread-arr-single.js
    const src = `function* g(): any { yield [...(yield)]; }
export function test(): number {
  const it: any = g();
  const a: any = it.next(false);
  const b: any = it.next([1, 2, 3]);
  let code = 0;
  if (a.value === undefined) code += 100000;   // the nested yield SUSPENDED first
  if (a.done === false) code += 10000;
  if (Array.isArray(b.value) && b.value.length === 3) code += 1000;
  if (b.value !== undefined && b.value[0] === 1 && b.value[2] === 3) code += 100;
  if (b.done === false) code += 10;
  if (it.next(0).done === true) code += 1;
  return code;
}`;
    expect(await run(src)).toBe(111111);
  });

  it("the resumed value is a plain element: `yield [yield]`", async () => {
    const src = `function* g(): any { yield [yield]; }
export function test(): number {
  const it: any = g();
  const a: any = it.next(false);
  const b: any = it.next(7);
  let code = 0;
  if (a.value === undefined) code += 10000; // NOT already the array — two suspensions
  if (Array.isArray(b.value) && b.value.length === 1) code += 1000;
  if (b.value !== undefined && b.value[0] === 7) code += 100;
  if (b.done === false) code += 10;
  if (it.next(0).done === true) code += 1;
  return code;
}`;
    expect(await run(src)).toBe(11111);
  });

  it("a chain suspends inner-to-outer: `yield [...yield yield]`", async () => {
    // language/statements/generators/yield-spread-arr-multiple.js
    const src = `function* g(): any { yield [...(yield (yield))]; }
export function test(): number {
  const it: any = g();
  const a: any = it.next(false);
  const b: any = it.next([4, 5, 6]);
  const c: any = it.next(b.value);
  let code = 0;
  if (a.value === undefined) code += 100000;
  if (Array.isArray(b.value) && b.value.length === 3) code += 10000; // middle yield re-yields the sent array
  if (Array.isArray(c.value) && c.value.length === 3) code += 1000;
  if (c.value !== undefined && c.value[0] === 4 && c.value[2] === 6) code += 100;
  if (c.done === false) code += 10;
  if (it.next(0).done === true) code += 1;
  return code;
}`;
    expect(await run(src)).toBe(111111);
  });

  it("a bare chain with no wrapper: `yield yield`", async () => {
    // language/statements/generators/yield-as-yield-operand.js
    const src = `function* g(): any { yield (yield); }
export function test(): number {
  const it: any = g();
  const a: any = it.next(false);
  const b: any = it.next(9);
  let code = 0;
  if (a.value === undefined) code += 1000;
  if (b.value === 9) code += 100;
  if (b.done === false) code += 10;
  if (it.next(0).done === true) code += 1;
  return code;
}`;
    expect(await run(src)).toBe(1111);
  });

  it("NEGATIVE CONTROL: a yield behind observable work refuses instead of reordering", async () => {
    // `[h(), yield]` owes `h()` BEFORE the suspension; this model cannot express
    // that, so standalone/WASI must answer with the #680 refusal — never with a
    // silently dropped suspension.
    const src = `let hits: number = 0;
function h(): number { hits += 1; return 1; }
function* g(): any { yield [h(), yield]; }
export function test(): number { const it: any = g(); it.next(); return hits; }`;
    const r = await compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(false);
    expect(r.errors?.map((e) => e.message).join(" ")).toContain("native generator lowering");
  });
});
