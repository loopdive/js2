// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4194) Computed-WRITE routing to closed structs —
 * `fillClosedStructExternSetArms` (src/codegen/closed-struct-extern-set.ts).
 *
 * Before the fill, `n[k] = v` through a dynamic key silently DROPPED on every
 * closed-struct receiver in standalone — even for a name with a physical slot
 * (measured: `n["type"] = "T2"` read back unchanged while native and js-host
 * both applied it). That measured zero-effect is what kept acorn's `copyNode`
 * (`for (p in node) newNode[p] = node[p]`) blank after the #3920 enumeration
 * fixes, and blocks the #3927 per-type-layout default-ON flip.
 *
 * Everything here is asserted against NATIVE Node answers, not against a
 * previous build — and the copyNode composition carries its own positive
 * control (a direct write that MUST land) so an all-drop regression cannot
 * read as agreement.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const FIXTURE = `
class K { constructor(t) { this.type = t; } }
function Node(t, s) { this.type = t; this.start = s; }
function Parser() { this.pos = 0; }
var pp = Parser.prototype;
pp.startNode = function () { return new Node("", 0); };
pp.mk = function (t, s, x) {
  var node = this.startNode();
  node.type = t; node.start = s;
  node.extra = x;                    // flow-grown conditional field
  return node;
};
function launder(x) { return x ? x : null; }

export function computedWriteCtorField() {
  var n = launder(new Node("Id", 3));
  var k = launder("x") ? "type" : "zz";
  n[k] = "T2";
  return (n.type === "T2" ? 1 : 0) + (n[k] === "T2" ? 10 : 0);
}
export function computedWriteFlowGrown() {
  var p = new Parser();
  var n = launder(p.startNode());
  var k = launder("x") ? "extra" : "zz";
  n[k] = "X";
  var val = (n.extra === "X" ? 1 : 0) + (n[k] === "X" ? 10 : 0);
  var own = n.hasOwnProperty("extra") ? 100 : 0;
  var viaIn = "extra" in n ? 1000 : 0;
  return val + own + viaIn;
}
export function copyNodeComposition() {
  var p = new Parser();
  var src = launder(p.mk("Id", 3, "X"));
  var dst = launder(p.startNode());
  // positive control FIRST: a write that must land, or nothing below counts
  dst["start"] = 99;
  if (dst.start !== 99) { return -1; }
  for (var k in src) { dst[k] = src[k]; }
  var copied = 0;
  if (dst.type === "Id") copied += 1;
  if (dst.start === 3) copied += 10;
  if (dst.extra === "X") copied += 100;
  var enumd = 0;
  for (var k2 in src) enumd++;
  return copied * 10 + (enumd > 0 ? 1 : 0);
}
export function deleteThenComputedRewrite() {
  var n = launder(new K("a"));
  var d = delete n.type ? 1 : 0;
  var gone = n.hasOwnProperty("type") ? 0 : 10;
  var k = launder("x") ? "type" : "zz";
  n[k] = "c";
  var back = n.type === "c" ? 100 : 0;
  var own = n.hasOwnProperty("type") ? 1000 : 0;
  return d + gone + back + own;
}
export function frozenComputedWrite() {
  var n = launder(new K("a"));
  Object.freeze(n);
  var k = launder("x") ? "type" : "zz";
  var threw = 0;
  try { n[k] = "b"; } catch (e) { threw = 10; }
  return threw + (n.type === "a" ? 1 : 0);
}
export function expandoResidual() {
  // A name with NO physical storage anywhere — the #4010/#4098 substrate
  // greenfield. NOT fixed by this issue's write routing; pinned so the day it
  // changes is noticed.
  var n = launder(new Node("Id", 3));
  var k = launder("x") ? "nowhere" : "zz";
  n[k] = "e";
  return (n[k] === "e" ? 1 : 0) + (n.nowhere === "e" ? 10 : 0);
}
`;

type Exports = Record<string, (() => number) | undefined>;

async function buildStandalone(): Promise<Exports> {
  const result = await compile(FIXTURE, {
    fileName: "t.mjs",
    skipSemanticDiagnostics: true,
    target: "standalone",
    optimize: 0,
  });
  if (!result.success) throw new Error(result.errors.map((e) => String(e.message ?? e)).join("; "));
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as Record<string, () => void>).__module_init?.();
  return instance.exports as Exports;
}

async function nativeModule(): Promise<Record<string, () => number>> {
  return (await import(`data:text/javascript,${encodeURIComponent(FIXTURE)}`)) as Record<string, () => number>;
}

describe("#4194 — computed writes route to closed-struct storage (standalone)", () => {
  it("matches native on every routed surface, and the copyNode composition moves", async () => {
    const wasm = await buildStandalone();
    const native = await nativeModule();
    for (const fn of [
      "computedWriteCtorField",
      "computedWriteFlowGrown",
      "copyNodeComposition",
      "deleteThenComputedRewrite",
      "frozenComputedWrite",
    ] as const) {
      const expected = native[fn]!();
      expect(wasm[fn]!(), `${fn}: standalone diverged from native`).toBe(expected);
    }
    // The copyNode number is the acceptance demonstration — make its meaning
    // explicit rather than only native-equal: all 3 fields copied (incl. the
    // flow-grown conditional), enumeration non-vacuous, control landed.
    expect(native.copyNodeComposition!()).toBe(1111);
  });

  it("routes a computed write to the RESID carrier under per-type layouts (#3927 flag ON)", async () => {
    // An {alpha}-layout instance computed-written with "beta": the inline
    // layout arms stamp-mismatch (canonical twins included) and the family's
    // resid arm must take it — then named read, hasOwnProperty and `in` see
    // it through the base presence bit.
    const LAYOUT_FIXTURE = `
function Node() { this.type = "?"; }
function Parser() { this.pos = 0; }
var pp = Parser.prototype;
pp.startNode = function () { return new Node(); };
pp.alpha = function () { var n = this.startNode(); n.alpha = 11; return n; };
pp.beta = function () { var n = this.startNode(); n.beta = 22; return n; };
function launder(x) { return x ? x : null; }
function launderKey(x) { return x ? x : null; }
export function mkDyn() { var n = new Node(); n["k"] = 1; return 0; } // approval site
export function residComputedWrite() {
  var p = new Parser();
  var a = launder(p.alpha());          // {alpha}-layout instance, any-typed
  var key = launderKey("x") ? "beta" : "zz"; // dynamic key
  a[key] = 7;
  return (a.beta === 7 ? 1 : 0) + (a[key] === 7 ? 10 : 0) +
         (a.hasOwnProperty("beta") ? 100 : 0) + ("beta" in a ? 1000 : 0) +
         (a.alpha === 11 ? 10000 : 0);
}
`;
    const saved = process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
    process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = "1";
    try {
      const result = await compile(LAYOUT_FIXTURE, {
        fileName: "t.mjs",
        skipSemanticDiagnostics: true,
        target: "standalone",
        optimize: 0,
      });
      if (!result.success) throw new Error(result.errors.map((e) => String(e.message ?? e)).join("; "));
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      (instance.exports as Record<string, () => void>).__module_init?.();
      expect((instance.exports as Exports).residComputedWrite!()).toBe(11111);
    } finally {
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      if (saved === undefined) delete process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
      else process.env.JS2WASM_FNCTOR_LAYOUT_EMIT = saved;
    }
  });

  it("expando writes on a closed struct are retained (the instance-props bag substrate)", async () => {
    const wasm = await buildStandalone();
    const native = await nativeModule();
    expect(native.expandoResidual!()).toBe(11);
    // This was the pinned residual ("no storage anywhere → still dropped");
    // the pin's own comment said it should FLIP to 11 when the substrate
    // lands. The instance-props expando bag (the #4194 bag half, reconciled
    // with #4232's declared-field arms) is that substrate: a write that
    // misses every declared ladder deposits into the identity-keyed bag and
    // reads back. See tests/issue-4194-instance-expando.test.ts for the full
    // surface matrix.
    expect(wasm.expandoResidual!()).toBe(11);
  });
});
