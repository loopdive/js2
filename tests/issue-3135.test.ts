// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3135 — standalone `__any_add` nullish-operand honesty (tag-5 string-lie
// family; task-82 de-vacuification follow-through).
//
// The generic externref→AnyValue boxing (`boxToAny`'s deliberate #1888 tag-5
// default, value-tags.ts) wraps a NULL externref — the standalone carrier of
// `undefined` crossing the open-any closure-dispatch boundary — as a tag-5
// "string" box whose externval is null. `__any_add`'s stringy-operand test
// (#2966) treated that box as a string, so `o.two(undefined, 5)` dispatched
// down the CONCAT arm and answered the string "[object Object]5":
//   - typeof result → NOT number,
//   - result !== result → false (string self-equality),
//   - Number(result) → NaN only by accident (unrecognized-box fallback).
// Pre-#3055 the broken any-equality masked this as a fake "NaN propagates"
// pass in tests/issue-1888-any-extern-roundtrip.test.ts (r !== r answered
// true for EVERY boxed operand pair, even r === r was false).
//
// Fix (consumer-side, same style as #2966's $BoxedNumber/$BoxedBoolean
// carve-out):
//   1. `stringyOperand`: a tag-5 box with a NULL externval is a boxed nullish
//      carrier, NOT a string (§13.15.3 — ToPrimitive(undefined/null) is not a
//      String) → numeric arm.
//   2. `__any_to_f64`: the tag-5-null-externval read is NaN (§7.1.4
//      ToNumber(undefined) = NaN), matching the plane-wide undefined bias
//      already chosen for the null externref (`__any_from_extern`'s nullAny is
//      {tag:1, f64val:NaN}; standalone `typeof` answers "undefined").
//
// The null-vs-undefined COLLAPSE itself (one `ref.null extern` carrier for
// both) is #2106 S1 and NOT fixed here — see the `it.fails` pins at the
// bottom for the two remaining seams that still read the bare null externref
// as 0 (`__to_primitive`/`__unbox_number` — the direct-closure-call path).

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

const dispatchWrap = (body: string): string => `
  export function run(): number {
    const o: any = {};
    o["two"] = (a: any, b: any) => a + b;
    ${body}
  }`;

describe("#3135 open-any dispatch `undefined + number` is NaN, not '[object Object]…'", () => {
  it("undefined + 5 through dispatch propagates NaN (self-inequality)", async () => {
    expect(
      await runStandalone(
        dispatchWrap(`
          const r: any = o.two(undefined, 5);
          return (r !== r) ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  it("undefined + 5 through dispatch is typeof number", async () => {
    expect(
      await runStandalone(
        dispatchWrap(`
          const r: any = o.two(undefined, 5);
          return (typeof r === "number") ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  it("regression guard: the result does NOT stringify as '[object Object]5'", async () => {
    expect(
      await runStandalone(
        dispatchWrap(`
          const r: any = o.two(undefined, 5);
          return String(r) === "[object Object]5" ? 0 : 1;`),
      ),
    ).toBe(1);
  });

  it("undefined + 5 through dispatch in a number context is NaN", async () => {
    expect(
      await runStandalone(
        dispatchWrap(`
          const n: number = o.two(undefined, 5);
          return (n !== n) ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  // ── §13.15.3 no-regression controls: every other operand pairing keeps its
  //    pre-fix answer (numbers/floats/bools numeric, strings concat) ──
  it("number + number stays numeric through dispatch", async () => {
    expect(await runStandalone(dispatchWrap(`return (o.two(2, 3) === 5) ? 1 : 0;`))).toBe(1);
  });

  it("float + float stays numeric through dispatch", async () => {
    expect(await runStandalone(dispatchWrap(`return (o.two(2.5, 3.25) === 5.75) ? 1 : 0;`))).toBe(1);
  });

  it("boolean + number stays numeric through dispatch (#2966 carve-out intact)", async () => {
    expect(await runStandalone(dispatchWrap(`return (o.two(true, 5) === 6) ? 1 : 0;`))).toBe(1);
  });

  it("string + string still concatenates through dispatch", async () => {
    expect(await runStandalone(dispatchWrap(`return String(o.two("a", "b")) === "ab" ? 1 : 0;`))).toBe(1);
  });

  it("string + number still concatenates through dispatch", async () => {
    expect(await runStandalone(dispatchWrap(`return String(o.two("a", 5)) === "a5" ? 1 : 0;`))).toBe(1);
  });

  // ── Remaining #2106 S1 gaps, pinned honestly (`it.fails` flips loudly when
  //    the $undefined singleton sweep lands — remove the pin then). These
  //    seams coerce the BARE null externref (not the tag-5 box) via
  //    `__to_primitive`/`__unbox_number`, whose null arm reads 0 — the
  //    null-vs-undefined collapse means they cannot answer NaN without the
  //    #2106 S1 producer+consumer sweep. Both fail identically on main. ──
  it("direct closure call: undefined + 5 is NaN", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const two = (a: any, b: any) => a + b;
          const r: any = two(undefined, 5);
          return (r !== r) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("any-closure undefined RESULT + 1 is NaN (#2966's twin)", async () => {
    expect(
      await runStandalone(`
        export function run(): number {
          const u: any = function () { return undefined; };
          const r = u() + 1;
          return (r !== r) ? 1 : 0;
        }`),
    ).toBe(1);
  });
});
