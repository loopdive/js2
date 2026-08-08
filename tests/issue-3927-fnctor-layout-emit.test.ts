// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3927) Per-type fnctor layout EMISSION (`JS2WASM_FNCTOR_LAYOUT_EMIT`).
 *
 * What is pinned here, and why exactly this:
 *
 *  - **OFF is byte-identical and ON is not** — a parity-only assertion would
 *    pass while measuring nothing (the #4157 const-box-hoist test learned
 *    that the hard way), so the mechanism proof is that ON *differs*.
 *  - **ON answers exactly what OFF answers** on every surface a dynamic
 *    receiver can reach — named reads, absent reads, hasOwnProperty, `in`,
 *    Object.keys — including the two shapes that are CANONICAL TWINS
 *    (`{alpha}` vs `{beta}`: both base ++ 1×externref share ONE wasm type),
 *    which is the case a bare `ref.test` dispatch silently mis-reads and the
 *    `$shape` stamp exists for.
 *  - **The residual carrier catches an analysis miss** — a write routed
 *    through an object property (a flow the may-flow analysis does not
 *    track) onto an instance whose layout has no slot for the name. Without
 *    the resid arms this write is silently DROPPED, the worst failure class.
 *  - **The narrowing vote de-narrows** — the #4217 `generator` defect analog:
 *    a flow-grown boxed value whose only *visible* carrier is another
 *    constructor's scalar slot must not be dragged through a number-unboxer.
 *  - **Host builds never change**, whatever the flag says.
 *
 * The acorn-scale payoff (bytes/parse) is measured on the standalone lane and
 * recorded in `plan/issues/3927-fnctor-shape-splitting.md`, not here.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { compile } from "../src/index.js";
import { fnctorLayoutEmitEnabled, isFnctorLayoutStructName } from "../src/codegen/fnctor-layout-emit.js";

/**
 * The acorn shape in miniature: one fnctor, one allocation-transparent
 * factory, per-call-site shapes. `alpha`/`beta` layouts are canonical twins.
 * `viaBox` launders an alpha-labelled node through an object property, so the
 * `beta` write on it is invisible to the analysis — the resid path.
 * `Tok.flag` is a scalar carrier of the same name as Node's flow-grown
 * `flag` — the vote-seam fixture.
 */
const FIXTURE = `
function Node() { this.type = "?"; this.start = 0; }
function Tok(g) { this.flag = g ? 1 : 0; }
function Parser() { this.pos = 0; }
var pp = Parser.prototype;
pp.startNode = function () { return new Node(); };
pp.alpha = function () { var node = this.startNode(); node.alpha = 11; return node; };
pp.beta = function () { var node = this.startNode(); node.beta = 22; return node; };
pp.withFlag = function () { var node = this.startNode(); node.flag = true; return node; };
// Laundering identity the may-flow analysis cannot summarise (the
// arguments[0] read defeats both the identity summary and the return join).
pp.launder = function (x) { return x ? arguments[0] : null; };
// A direct dynamically-used site is what APPROVES Node for the up-front
// escape-gate reservation (acorn's copyNode plays this role there); layouts
// only apply to reserved fnctors, and a keep-static/keep-typed-only fnctor
// stays on the union struct. Note: no typed own-field read (n.type) here —
// one would flip this site to keep-typed and un-reserve Node.
export function mkDyn() {
  var n = new Node();
  n["k"] = 1;
  return n["k"] | 0;
}
export function sum() {
  var p = new Parser();
  var t = new Tok(1);
  return (p.alpha().alpha | 0) + (p.beta().beta | 0) + (t.flag | 0);
}
export function absentReads() {
  var p = new Parser();
  var a = p.alpha();
  var b = p.beta();
  // alpha's layout has no beta slot and vice versa — both must answer undefined.
  return (a.beta === undefined ? 1 : 0) + (b.alpha === undefined ? 1 : 0);
}
export function residRoundTrip() {
  var p = new Parser();
  var box = { n: null };
  box.n = p.alpha();
  // The analysis cannot see either flow (property round-trip / laundering
  // call), so the beta writes land in the residual carrier of an
  // {alpha}-layout instance — the layout has no beta slot, and the only two
  // arms whose ref.test matches are the canonical-twin {beta} layout (stamp
  // mismatch, falls through) and the family's resid arm.
  box.n.beta = 7;
  var m = p.launder(box.n);
  var got = box.n.beta === 7 ? 1 : 0;
  var hasOwn = m.hasOwnProperty("beta") ? 1 : 0;
  var viaIn = "beta" in m ? 1 : 0;
  var alphaStill = m.alpha === 11 ? 1 : 0;
  return got + hasOwn + viaIn + alphaStill;
}
export function reflectiveSurface() {
  var p = new Parser();
  var a = p.alpha();
  var own = a.hasOwnProperty("alpha") ? 1 : 0;
  var notOwn = a.hasOwnProperty("beta") ? 0 : 1;
  var viaIn = "alpha" in a ? 1 : 0;
  var keys = Object.keys(a);
  var sawAlpha = 0;
  var sawBeta = 0;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === "alpha") sawAlpha = 1;
    if (keys[i] === "beta") sawBeta = 1;
  }
  return own + notOwn + viaIn + sawAlpha + (sawBeta ? 0 : 1);
}
export function structTypedFold() {
  // The default-ON gate blocker (2026-08-08): static in/hasOwnProperty on a
  // STRUCT-TYPED receiver fold from the base field list, which the split
  // empties of flow-grown names — without the closed-struct-presence
  // side-table arm both answered a constant false for a property the
  // instance carries (probe: native 111, flag-ON 1). The dynamic-receiver
  // reflectiveSurface() above can NEVER catch this — the fold only fires on
  // this spelling (the #3920 receiver-spelling confound, third occurrence).
  var p = new Parser();
  var n = new Node();               // struct-typed binding — the fold path
  var a = p.launder(n);
  a.beta = 7;                        // dynamic write into split-family storage
  var viaIn = "beta" in n ? 1 : 0;
  var hasOwn = n.hasOwnProperty("beta") ? 10 : 0;
  var neverIn = "alpha" in n ? 0 : 100; // never-written union name stays absent
  return viaIn + hasOwn + neverIn;
}
export function voteSeam() {
  var p = new Parser();
  var n = p.withFlag();
  var t = new Tok(1);
  // n.flag is a BOXED true whose only findAlternateStructsForField-visible
  // carrier of "flag" is Tok's scalar slot. If the Phase-3 vote narrows on
  // the visible candidates alone, the boxed true is dragged through
  // __unbox_number and answers a constant false (#4217's generator defect).
  return (n.flag === true ? 1 : 0) + (t.flag === 1 ? 1 : 0);
}
`;

type Exports = Record<string, (() => number) | undefined>;

interface Built {
  sha: string;
  exports: Exports;
}

async function build(flag: string | undefined, target: "standalone" | "js-host" = "standalone"): Promise<Built> {
  const saved = process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
  // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
  if (flag === undefined) delete process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
  else process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = flag;
  try {
    const result = await compile(FIXTURE, {
      fileName: "t.mjs",
      skipSemanticDiagnostics: true,
      target,
      optimize: 0,
    });
    if (!result.success) throw new Error(result.errors.map((e) => String(e.message ?? e)).join("; "));
    const sha = createHash("sha256").update(result.binary).digest("hex");
    if (target === "js-host") return { sha, exports: {} };
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports as Record<string, () => void>).__module_init?.();
    return { sha, exports: instance.exports as Exports };
  } finally {
    // biome-ignore lint/performance/noDelete: see above — env vars need delete
    if (saved === undefined) delete process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
    else process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = saved;
  }
}

describe("#3927 — per-type fnctor layout emission", () => {
  it("flag reader: default ON since the 2026-08-08 flip; 0/off/empty disable; predicate exact", () => {
    const saved = process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
    try {
      // biome-ignore lint/performance/noDelete: env vars need delete to unset
      delete process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
      expect(fnctorLayoutEmitEnabled()).toBe(true);
      process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = "";
      expect(fnctorLayoutEmitEnabled()).toBe(false);
      process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = "0";
      expect(fnctorLayoutEmitEnabled()).toBe(false);
      process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = "off";
      expect(fnctorLayoutEmitEnabled()).toBe(false);
      process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = "OFF";
      expect(fnctorLayoutEmitEnabled()).toBe(false);
      process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = "1";
      expect(fnctorLayoutEmitEnabled()).toBe(true);
    } finally {
      // biome-ignore lint/performance/noDelete: see above — env vars need delete
      if (saved === undefined) delete process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
      else process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = saved;
    }
    expect(isFnctorLayoutStructName("__fnctor_Node__lay0")).toBe(true);
    expect(isFnctorLayoutStructName("__fnctor_Node__lay41")).toBe(true);
    expect(isFnctorLayoutStructName("__fnctor_Node__layout")).toBe(false);
    expect(isFnctorLayoutStructName("__fnctor_Node")).toBe(false);
    expect(isFnctorLayoutStructName("__fnctor_Node__resid")).toBe(false);
  });

  it("disable spellings are byte-identical to each other; the DEFAULT equals explicit ON and differs from OFF", async () => {
    const off = await build("0");
    expect((await build("")).sha).toBe(off.sha);
    expect((await build("off")).sha).toBe(off.sha);
    const byDefault = await build(undefined);
    expect(byDefault.sha).toBe((await build("1")).sha);
    // Mechanism proof — a parity-only test would pass while measuring nothing.
    expect(byDefault.sha).not.toBe(off.sha);
  });

  it("ON answers exactly what OFF answers on every surface (incl. canonical-twin layouts)", async () => {
    const off = await build("0");
    const on = await build("1");
    for (const fn of [
      "sum",
      "absentReads",
      "residRoundTrip",
      "reflectiveSurface",
      "voteSeam",
      "structTypedFold",
    ] as const) {
      const expected = off.exports[fn]!();
      expect(
        on.exports[fn]!(),
        `${fn}: ON diverged from OFF (${String(on.exports[fn]!())} vs ${String(expected)})`,
      ).toBe(expected);
    }
  });

  it("the absolute answers are the spec answers, not merely OFF-consistent", async () => {
    const on = await build("1");
    expect(on.exports.sum!()).toBe(11 + 22 + 1);
    expect(on.exports.absentReads!()).toBe(2);
    // resid write lands, reads back, and is visible to hasOwnProperty + `in`,
    // while the inline alpha slot is untouched.
    expect(on.exports.residRoundTrip!()).toBe(4);
    expect(on.exports.reflectiveSurface!()).toBe(5);
    // The vote-seam read answers the BOXED true, not a scalar-narrowed false.
    expect(on.exports.voteSeam!()).toBe(2);
    // The struct-typed fold reads the base presence word, not a constant.
    expect(on.exports.structTypedFold!()).toBe(111);
  });

  it("never changes a JS-host build, whatever the flag says", async () => {
    const hostOff = await build(undefined, "js-host");
    for (const flag of ["0", "1", ""]) {
      expect((await build(flag, "js-host")).sha).toBe(hostOff.sha);
    }
  });
});
