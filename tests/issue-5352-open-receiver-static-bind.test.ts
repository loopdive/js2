// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5352 — an OPEN-RECEIVER `this.m(…)` whose overrides do not agree on a Wasm
// RESULT type bound STATICALLY to `candidates[0]`.
//
// #5249 gave every descendant an arm in the `__tag` cascade. But the cascade is
// only emitted if `emitVirtualMethodDispatchByTag` accepts the shape; when it
// declines it returns `undefined` and the caller keeps the `funcIdx =
// candidates[0].funcIdx` it had already set — a DIRECT call to the first
// declarer, for every receiver, whatever its runtime type. Wrong answers, not a
// trap, so nothing in the pipeline notices.
//
// Measured on `@js-temporal/polyfill@0.5.1` (probe over the whole provider
// build, all nine bail-outs instrumented): the ONLY bail-out that fires is the
// result-type unification (`unifyCascadeResultType`), nine times over four
// methods — `maximumMonthLength`, `minimumMonthLength`, `monthDaySearchStartYear`
// and `maxLengthOfMonthCodeInAnyYear`. Each has ~25 candidates that split into
// an `f64` majority and 1–3 `externref` arms (a body whose expression the
// checker types `any`). Mixed numeric/ref had no representation every arm could
// produce, so the emitter declined and every calendar was routed into
// `HebrewHelper` — `candidates[0]`.
//
// The fix boxes the `f64` arms with `__box_number` so the cascade unifies on
// `externref`, the compiler's own universal value representation.
//
// NOT FIXED HERE, stated rather than hidden:
//   * a cascade mixing VOID and value arms still declines (and still static-
//     binds). No such shape appears in the polyfill.
//   * an `i32` arm is not boxed: `i32` is also this compiler's boolean
//     representation, so `__box_number` would be the wrong boxer for half of
//     the cases and there is no arm-local way to tell them apart here.

import { describe, expect, it } from "vitest";

import { compileToWasm } from "./equivalence/helpers.js";

async function run(source: string): Promise<unknown> {
  const exports = await compileToWasm(source);
  return exports.test!();
}

// `Base` declares no `n`; the four descendants disagree on the Wasm result
// type — three return a number (`f64`), one returns an `any`-typed field
// (`externref`). That is the polyfill's `maximumMonthLength` shape, minimised.
const MIXED = `
abstract class Base {
  abstract n(x: number): any;
  run(x: number) { return this.n(x); }
}
class Num1 extends Base { n(x: number) { return x + 1; } }
class Num2 extends Base { n(x: number) { return x + 2; } }
class Obj extends Base { data: any = 99; n(x: number) { return this.data; } }
class Num3 extends Num1 { n(x: number) { return x + 3; } }
`;

describe("#5352 open-receiver dispatch never static-binds to candidates[0]", () => {
  it("dispatches by runtime tag when the overrides disagree on result type", async () => {
    // Base: every receiver answered with `Num1`'s body (11) — the first
    // declarer — because the cascade declined on the mixed f64/externref arms.
    const source = `${MIXED}
export function test() {
  const all: Base[] = [new Num1(), new Num2(), new Obj(), new Num3()];
  let acc = "";
  for (const h of all) acc += h.run(10) + ";";
  return acc;
}
`;
    expect(await run(source)).toBe("11;12;99;13;");
  });

  it("dispatches each subclass to its own body through a direct receiver", async () => {
    const source = `${MIXED}
export function test() {
  return new Num1().run(10) + "|" + new Num2().run(10) + "|" + new Obj().run(10) + "|" + new Num3().run(10);
}
`;
    expect(await run(source)).toBe("11|12|99|13");
  });

  it("keeps the boxed result usable as a number by the caller", async () => {
    // The cascade's unified type is `externref`; a numeric consumer has to
    // unbox it again. If that round trip were lossy the sum would be NaN.
    const source = `${MIXED}
export function test() {
  const all: Base[] = [new Num1(), new Num2(), new Num3()];
  let total = 0;
  for (const h of all) total += h.run(10) as number;
  return total;
}
`;
    expect(await run(source)).toBe(36);
  });

  it("leaves an all-numeric hierarchy on its unwidened cascade (control)", async () => {
    // Arms that already agree must keep their own result type — the widening
    // is for divergence only.
    const source = `
abstract class B2 {
  abstract n(x: number): number;
  run(x: number) { return this.n(x) * 2; }
}
class P extends B2 { n(x: number) { return x + 1; } }
class Q extends B2 { n(x: number) { return x + 2; } }
export function test() { return new P().run(10) + "," + new Q().run(10); }
`;
    expect(await run(source)).toBe("22,24");
  });
});
