// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4774 — `compile()` reported `success: true` while emitting a module no engine
// accepts.
//
// Root cause (`src/codegen/binary-ops.ts`, the #745 S3 `unionRepEqInvolved`
// gate): a `+` whose other operand's static type is a heterogeneous primitive
// union (`number | boolean`) was routed to the `__any_add` helper, which returns
// the tagged `$AnyValue` carrier. But §13.15.3 step 7 concatenates whenever
// EITHER ToPrimitive result is a String, so a `+` with a statically-string
// operand is unconditionally a string concatenation — and every consumer lowers
// from that static `string` type. `.length` emits a bare
// `struct.get $AnyString 0`, which validates against the `$AnyValue` operand as
//   `struct.get[0] expected (ref null $AnyString), found (ref null $AnyValue)`.
// `charCodeAt` takes a checked cast instead and traps at runtime with
// "illegal cast" — the same disagreement, a different symptom, which is why the
// fix is on the PRODUCER (the `+`) and not on any one consumer.
//
// The gate now declines a statically-string `+`, handing it to the string-concat
// route. A both-`any` `+` still needs the runtime dispatch and is untouched (an
// `any` is not a string type, so it cannot reach the new guard).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile standalone, require a module the engine ACCEPTS, and call `test()`. */
async function runStandalone(src: string, opts: { unionAnyRep?: boolean } = {}): Promise<unknown> {
  const r = await compile(src, { fileName: "issue-4774.js", target: "standalone", ...opts });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // The #4774 defect is invisible to `success` — only an engine decode catches
  // it. `WebAssembly.compile` (not `.validate`) so a rejection carries detail.
  await expect(WebAssembly.compile(r.binary), "emitted binary must be a valid module").resolves.toBeDefined();
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

// The issue's three-ingredient shape. The `eq`/`pred` pair and the DIRECT
// `P.prototype.m = …` install form are what give `p.pred(x)` the mixed
// `number | boolean` static type that arms the gate.
const DIRECT_PROTO = `
function P(n) { this.n = n; }
P.prototype.eq   = function (x) { return this.n === x; };
P.prototype.pred = function (x) { if (x > 100) { return 7; } return this.eq(x) && this.eq(x); };
`;

// Near-miss (a): the ALIAS install form. The checker types `p.pred(x)` as `any`
// here, not as a union, so the gate never fired and this variant was already
// valid — it must STAY on its existing lowering.
const ALIAS_PROTO = `
function P(n) { this.n = n; }
var pp = P.prototype;
pp.eq   = function (x) { return this.n === x; };
pp.pred = function (x) { if (x > 100) { return 7; } return this.eq(x) && this.eq(x); };
`;

// Near-miss (b): a SINGLE-type (pure boolean) return set — not a union, so the
// gate never fired.
const PURE_BOOLEAN_PROTO = `
function P(n) { this.n = n; }
P.prototype.eq   = function (x) { return this.n === x; };
P.prototype.pred = function (x) { if (x > 100) { return false; } return this.eq(x) && this.eq(x); };
`;

describe("#4774 statically-string `+` must not return the $AnyValue carrier", () => {
  describe("the reported shape now emits a module the engine accepts", () => {
    it("mixed-return prototype method under one string concat", async () => {
      const src = `${DIRECT_PROTO}
export function test() { var p = new P(5); return ("" + p.pred(5)).length; }`;
      // node: ("" + true).length === 4
      expect(await runStandalone(src)).toBe(4);
    });

    it("mixed-return prototype method under two string concats", async () => {
      const src = `${DIRECT_PROTO}
export function test() { var p = new P(5); return ("" + p.pred(5)).length + ("" + p.pred(200)).length; }`;
      // node: "true".length + "7".length === 5
      expect(await runStandalone(src)).toBe(5);
    });
  });

  // The `.length` consumer is the one that failed VALIDATION; `charCodeAt` is
  // the one that compiled and then TRAPPED. Both are pinned so a future
  // consumer-side patch cannot look like a fix while the producer still
  // disagrees.
  describe("both consumers of the concat result agree with the producer", () => {
    const MIXED_FN = `function f(x) { if (x > 100) { return 7; } return x === 5; }`;

    it("`.length` — the site that failed WebAssembly.compile", async () => {
      const src = `${MIXED_FN}
export function test() { return ("" + f(5)).length; }`;
      expect(await runStandalone(src)).toBe(4);
    });

    it("`.charCodeAt` — the site that trapped with `illegal cast`", async () => {
      const src = `${MIXED_FN}
export function test() { return ("" + f(5)).charCodeAt(0); }`;
      // node: "true".charCodeAt(0) === 116
      expect(await runStandalone(src)).toBe(116);
    });

    it("the numeric arm of the same union still stringifies as a number", async () => {
      const src = `${MIXED_FN}
export function test() { return ("" + f(200)).length; }`;
      // node: "7".length === 1
      expect(await runStandalone(src)).toBe(1);
    });
  });

  // The invariant the fix restores, stated without reference to any one
  // lowering: which carrier `unionAnyRep` picks for a heterogeneous primitive
  // union is a REPRESENTATION choice and must not be observable. On unmodified
  // HEAD the two lanes disagreed as hard as they can — `unionAnyRep: false`
  // answered 4, `unionAnyRep: true` produced a module that would not decode.
  it("the union carrier representation is unobservable at a string `+`", async () => {
    const src = `function f(x) { if (x > 100) { return 7; } return x === 5; }
export function test() { return ("" + f(5)).length; }`;
    const carried = await runStandalone(src, { unionAnyRep: true });
    const legacy = await runStandalone(src, { unionAnyRep: false });
    expect(carried).toBe(legacy);
    expect(carried).toBe(4);
  });

  // The issue's acceptance criterion: "the bisect table still discriminates. A
  // 'fix' that makes both install forms decline would hide the defect rather
  // than close it." These three rows never routed through the gate, so they must
  // keep their existing lowering AND their existing answers — including the one
  // that is still WRONG.
  describe("near-miss variants keep their existing lowering", () => {
    it("alias install form still shows #4414's residual — NOT the correct answer", async () => {
      const src = `${ALIAS_PROTO}
export function test() { var p = new P(5); return ("" + p.pred(5)).length; }`;
      const observed = await runStandalone(src);
      // PINNED AS-IS, NOT AS CORRECT. node answers 4 ("true"); this lane answers
      // 1 because it stringifies the boolean as "1" — the residual described in
      // #4414 ("boolean returns minted as f64 numeric twins") and restated in
      // #4774's "Why it matters". It is a VALUE defect on an otherwise VALID
      // module and is deliberately out of scope here. When #4414's residual is
      // closed this expectation should become 4; until then, changing it to 4
      // without a compiler change is what would be wrong.
      expect(observed, "#4414 residual: alias form stringifies `true` as “1”").toBe(1);
      expect(observed, "sanity: node answers 4 — this row is knowingly wrong").not.toBe(4);
    });

    it("single-type (pure boolean) return set is unaffected and correct", async () => {
      const src = `${PURE_BOOLEAN_PROTO}
export function test() { var p = new P(5); return ("" + p.pred(5)).length; }`;
      // node: ("" + true).length === 4
      expect(await runStandalone(src)).toBe(4);
    });

    it("non-concat (condition) consumer of the same mixed method is unaffected", async () => {
      const src = `${DIRECT_PROTO}
export function test() { var p = new P(5); return p.pred(5) ? 1 : 0; }`;
      // node: p.pred(5) is truthy → 1
      expect(await runStandalone(src)).toBe(1);
    });
  });

  // The other limb of the same gate. Both operands `any` means neither is a
  // string type, so the new guard cannot fire and `+` keeps its runtime
  // string-vs-number dispatch.
  it("a both-`any` `+` keeps its runtime dispatch", async () => {
    const src = `function pick(n) { return n > 100 ? "s" : 7; }
export function test() {
  var a = pick(1);
  var b = pick(200);
  return ("" + (b + a)).length + ("" + (a + a)).length;
}`;
    // node: ("" + ("s" + 7)).length + ("" + (7 + 7)).length === 2 + 2 === 4
    expect(await runStandalone(src)).toBe(4);
  });
});
