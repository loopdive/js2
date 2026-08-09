// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2660 S3b — fnctor-typed BINDINGS (`src/codegen/fnctor-typed-bindings.ts`):
// a function-local binding that provably holds only one approved fnctor's
// instances gets a `(ref null $__fnctor_F)` slot instead of externref, behind
// `JS2WASM_FNCTOR_TYPED_BINDINGS` (default OFF). The #4155 Phase 2 read/write
// hooks (`JS2WASM_FNCTOR_TYPED_READS`) are the consumer that makes the retype
// pay, so most fixtures here run with BOTH flags on vs BOTH off.
//
// Everything is behavior-equal by construction: the flags may only change HOW
// a slot is read/written, never WHAT it answers. Fixtures assert results equal
// across flag states, plus representation pins (the local's WAT type) that are
// mutation-checked against the flag-off compile.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { fnctorTypedReadStats } from "../src/codegen/fnctor-typed-reads.js";

const BINDINGS = "JS2WASM_FNCTOR_TYPED_BINDINGS";
const READS = "JS2WASM_FNCTOR_TYPED_READS";

async function compileStandaloneJs(src: string, flagsOn: boolean): Promise<{ wat: string; binary: Uint8Array }> {
  const saved = { b: process.env[BINDINGS], r: process.env[READS] };
  // (#743 defaults flip, 2026-08-08) OFF must be SPELLED, not left unset —
  // unset is now ON, so `delete` here would compile both arms identically and
  // every representation pin below would pass vacuously.
  process.env[BINDINGS] = flagsOn ? "1" : "0";
  process.env[READS] = flagsOn ? "1" : "0";
  try {
    const r = await compile(src, {
      fileName: "t.mjs",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      emitWat: true,
    });
    expect(r.success, r.errors.map((e) => String(e.message ?? e)).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
    return { wat: r.wat ?? "", binary: r.binary };
  } finally {
    for (const [k, v] of [
      [BINDINGS, saved.b],
      [READS, saved.r],
    ] as const) {
      if (v === undefined) {
        // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

async function run(binary: Uint8Array, name = "test"): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as Record<string, () => unknown>)[name]!();
}

/**
 * `test()`'s outcome — value, or the thrown error's class+message (a trap and
 * a Wasm exception are outcomes too; several Phase 0 shapes trap identically
 * in both flag states and must still compare equal).
 */
async function runOutcome(binary: Uint8Array): Promise<{ value?: unknown; error?: string }> {
  try {
    const value = await run(binary);
    // A WasmGC struct escaping to JS is an opaque host object vitest cannot
    // structurally compare (it throws "WebAssembly objects are opaque") —
    // normalize non-primitives to a tag; both flag states must yield the same
    // tag either way.
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      return { value: `[opaque ${typeof value}]` };
    }
    return { value };
  } catch (e) {
    return { error: `${(e as Error).constructor.name}: ${(e as Error).message}` };
  }
}

/** Compile flag-on and flag-off; assert identical `test()` outcomes. */
async function runBothWays(src: string): Promise<{ result: unknown; watOn: string; watOff: string }> {
  const off = await compileStandaloneJs(src, false);
  const on = await compileStandaloneJs(src, true);
  const outcomeOff = await runOutcome(off.binary);
  const outcomeOn = await runOutcome(on.binary);
  expect(outcomeOn, "flags-on outcome must equal flags-off outcome").toEqual(outcomeOff);
  return { result: outcomeOn.value, watOn: on.wat, watOff: off.wat };
}

// The acorn shape: `var node = this.startNode()` — a write-once prototype
// method single-returning `new Node(...)`, then field reads/writes on the
// binding. `Node`'s ctor slot in P makes its allocation dynamically consumed,
// so the escape gate approves Node.
const ACORN_SHAPE = `
function Node(pos) { this.kind = 0; this.start = pos; this.end = 0; }
function P() { this.pos = 10; this.cur = new Node(1); }
var pp = P.prototype;
pp.startNode = function () { return new Node(this.pos); };
pp.build = function () { var node = this.startNode(); node.end = node.start + 5; return node.end; };
export function test() { var p = new P(); return p.build(); }
`;

describe("#2660 S3b — fnctor-typed bindings (flag-gated)", () => {
  it("retypes the acorn-shape binding: (ref null $F) local, same result (mutation-checked)", async () => {
    const { result, watOn, watOff } = await runBothWays(ACORN_SHAPE);
    expect(result).toBe(15);
    // Mutation check: flag-off the binding IS an externref slot — if this
    // stops matching, the fixture no longer covers the retype and the flag-on
    // assertion below is vacuous.
    expect(watOff).toContain("(local $node externref)");
    expect(watOn).not.toContain("(local $node externref)");
    expect(watOn).toMatch(/\(local \$node \(ref null \d+\)\)/);
  });

  it("read via the fast path: hook fire-count increases only with the bindings flag", async () => {
    // The Phase 2 hook counters are live module state; deltas prove the fast
    // path actually fired (WAT text alone can't — dispatcher calls are
    // rendered as bare indices).
    const g0 = fnctorTypedReadStats.gets + fnctorTypedReadStats.sets;
    await compileStandaloneJs(ACORN_SHAPE, false);
    const g1 = fnctorTypedReadStats.gets + fnctorTypedReadStats.sets;
    expect(g1, "flags-off must not fire the typed read/write hooks").toBe(g0);
    await compileStandaloneJs(ACORN_SHAPE, true);
    const g2 = fnctorTypedReadStats.gets + fnctorTypedReadStats.sets;
    expect(g2, "flags-on must fire the typed read/write hooks for the retyped binding").toBeGreaterThan(g1);
  });

  it("member CALL through the retyped binding stays dynamic and keeps working", async () => {
    const { result } = await runBothWays(`
function Node(pos) { this.start = pos; }
Node.prototype.twice = function () { return this.start * 2; };
function P() { this.pos = 21; this.cur = new Node(1); }
var pp = P.prototype;
pp.startNode = function () { return new Node(this.pos); };
pp.callTwice = function () { var node = this.startNode(); return node.twice(); };
export function test() { var p = new P(); return p.callTwice(); }
`);
    expect(result).toBe(42);
  });

  it("null reassignment REFUSES the retype (binding keeps its externref slot, semantics untouched)", async () => {
    const { result, watOn, watOff } = await runBothWays(`
function Node(pos) { this.start = pos; }
function P() { this.pos = 5; this.cur = new Node(1); }
var pp = P.prototype;
pp.startNode = function () { return new Node(this.pos); };
pp.maybe = function (c) {
  var node = this.startNode();
  if (c) { node = null; }
  return node === null ? -1 : node.start;
};
export function test() { var p = new P(); return p.maybe(1) * 100 + p.maybe(0); }
`);
    expect(result).toBe(-95); // -1 * 100 + 5
    // The incompatible write refused admission: the slot stays externref in
    // BOTH flag states.
    expect(watOff).toContain("(local $node externref)");
    expect(watOn).toContain("(local $node externref)");
  });

  it("foreign-value reassignment refuses the retype and keeps working", async () => {
    const { result, watOn } = await runBothWays(`
function Node(pos) { this.start = pos; }
function P() { this.pos = 7; this.cur = new Node(1); }
var pp = P.prototype;
pp.startNode = function () { return new Node(this.pos); };
pp.swap = function () { var node = this.startNode(); node = 42; return node; };
export function test() { var p = new P(); return p.swap(); }
`);
    expect(result).toBe(42);
    expect(watOn).toContain("(local $node externref)");
  });

  it("binding flows into externref positions (argument, array element, field store, return) and boxes", async () => {
    const { result } = await runBothWays(`
function Node(pos) { this.start = pos; }
function P() { this.pos = 4; this.cur = new Node(1); }
var pp = P.prototype;
pp.startNode = function () { return new Node(this.pos); };
function readStart(n) { return n.start; }
pp.flow = function () {
  var node = this.startNode();
  var viaArg = readStart(node);          // argument position
  var arr = [node];                       // array element
  var viaArr = arr[0].start;              // round-trip
  this.cur = node;                        // field store
  var viaField = this.cur.start;
  return viaArg * 100 + viaArr * 10 + viaField;
};
pp.give = function () { var node = this.startNode(); return node; }; // return position
export function test() {
  var p = new P();
  var direct = p.flow();
  var returned = p.give();
  return direct * 10 + (returned === null ? 0 : 1);
};
`);
    expect(result).toBe(4441); // (400 + 40 + 4) * 10 + 1
  });

  it("use in a sibling branch (not dominated by the decl) refuses the retype", async () => {
    const { result, watOn } = await runBothWays(`
function Node(pos) { this.start = pos; }
function P() { this.pos = 3; this.cur = new Node(1); }
var pp = P.prototype;
pp.cond = function (c) {
  if (c) { var node = this.startNode(); }
  return typeof node;                    // c=false ⇒ undefined, must stay undefined
};
pp.startNode = function () { return new Node(this.pos); };
export function test() {
  var p = new P();
  return (p.cond(0) === "undefined" ? 1 : 0) * 10 + (p.cond(1) === "object" ? 1 : 0);
};
`);
    expect(result).toBe(11);
    expect(watOn).toContain("(local $node externref)");
  });

  it("presence-tracked externref slot through the retyped binding: write sets the bit, unset read answers undefined", async () => {
    const { result } = await runBothWays(`
function Node(pos) { this.start = pos; if (pos > 100) { this.opt = pos; } }
function P() { this.pos = 4; this.cur = new Node(1); }
var pp = P.prototype;
pp.startNode = function () { return new Node(this.pos); };
pp.roundTrip = function () {
  var node = this.startNode();
  var before = node.opt === undefined ? 1 : 0;   // unset ⇒ undefined
  node.opt = 9;                                   // typed write must set the presence bit
  var after = node.opt === 9 ? 1 : 0;
  return before * 10 + after;
};
export function test() { var p = new P(); return p.roundTrip(); }
`);
    expect(result).toBe(11);
  });

  // The three #4155 Phase 0 `it.fails` shapes, under BOTH flags: the S3b
  // retype must not change their (still broken, pre-existing) behavior — the
  // fnctors involved are NOT gate-approved, so admission declines. If one of
  // these starts DIFFERING across flag states, the retype leaked into a shape
  // whose instances are not dynamically consumable. (Promotion of the
  // underlying bugs is tracked by tests/issue-4155-fnctor-shape-regression.ts,
  // not here.)
  it("Phase 0 shape: instance returned from a plain function — flag changes nothing", async () => {
    await runBothWays(`
function F(n) { this.v = n; }
F.prototype.m = function () { return this.v; };
function make(n) { return new F(n); }
export function test() { var x = make(42); return x.m(); }
`);
  });

  it("Phase 0 shape: instance round-tripped through an array element — flag changes nothing", async () => {
    await runBothWays(`
function F(n) { this.v = n; }
F.prototype.m = function () { return this.v; };
export function test() { var arr = [new F(42)]; var x = arr[0]; return x.m(); }
`);
  });

  it("Phase 0 shape: field added by a method, never seeded in the ctor — flag changes nothing", async () => {
    await runBothWays(`
function F(n) { this.v = n; }
F.prototype.stash = function () { this.extra = this.v + 1; };
F.prototype.read = function () { return this.extra; };
export function test() { var x = new F(41); x.stash(); return x.read(); }
`);
  });
});
