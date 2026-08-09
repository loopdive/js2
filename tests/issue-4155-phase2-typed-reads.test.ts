// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4155 Phase 2 — direct `struct.get`/`struct.set` for a data field accessed
// through a receiver whose COMPILED ValType is already a `$__fnctor_<Name>`
// struct reference (`src/codegen/fnctor-typed-reads.ts`).
//
// The coverage (measured on standalone acorn 8.16.0, census 2026-08-06) is
// SECOND-HOP reads off Phase-1-typed slots: `this.type.keyword` where the
// `type` slot is `(ref null $__fnctor_TokenType)`. The checker cannot bind
// `this` in acorn's `pp = Parser.prototype; pp.m = function () {…}` idiom, so
// the read reaches the DYNAMIC member path — but codegen's typed-this twin
// compiles the receiver to a struct-typed ValType, which is exactly what the
// fast path consumes. The fixtures below reproduce that shape: a JS file
// (checker types `new T()` by ctor-shape inference), a prototype ALIAS (breaks
// static `this` binding), and a fnctor slot seeded with another fnctor's
// instance in the constructor.
//
// Everything here is behavior-equal by construction: the flag may only change
// HOW a field is read (one `struct.get` vs the `__get_member_<name>` ladder),
// never WHAT it answers. The WAT assertions pin the representation change and
// are mutation-checked against the flag-off compile of the same source.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const FLAG = "JS2WASM_FNCTOR_TYPED_READS";

async function compileStandaloneJs(src: string, flagOn: boolean): Promise<{ wat: string; binary: Uint8Array }> {
  const saved = process.env[FLAG];
  // (#743 defaults flip, 2026-08-08) OFF must be SPELLED, not left unset —
  // unset is now ON, so `delete` here would silently make both arms of every
  // A/B compile the same way and the WAT mutation-checks would pass vacuously.
  process.env[FLAG] = flagOn ? "1" : "0";
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
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = saved;
    }
  }
}

async function run(binary: Uint8Array): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

/** Compile the same source flag-on and flag-off; assert identical results. */
async function runBothWays(src: string): Promise<{ result: unknown; watOn: string; watOff: string }> {
  const off = await compileStandaloneJs(src, false);
  const on = await compileStandaloneJs(src, true);
  const resultOff = await run(off.binary);
  const resultOn = await run(on.binary);
  expect(resultOn, "flag-on result must equal flag-off result").toEqual(resultOff);
  return { result: resultOn, watOn: on.wat, watOff: off.wat };
}

// The acorn shape: prototype-ALIAS methods (static `this` unresolvable) doing
// second-hop reads through a ctor-seeded fnctor-instance slot.
const SECOND_HOP_READ_SRC = `
function T(k) { this.keyword = k; this.beforeExpr = true; }
function P() { this.type = new T(41); this.pos = 0; }
var pp = P.prototype;
pp.readKeyword = function () { return this.type.keyword; };
pp.readFlag = function () { return this.type.beforeExpr ? 1 : 0; };
export function test() {
  const p = new P();
  return p.readKeyword() + p.readFlag();
}
`;

describe("#4155 Phase 2 — typed fnctor field reads (flag-gated)", () => {
  it("second-hop read off a typed slot: same result, and the flag-on WAT drops __get_member_", async () => {
    const { result, watOn, watOff } = await runBothWays(SECOND_HOP_READ_SRC);
    expect(result).toBe(42);
    // Mutation check: the dynamic dispatcher IS the flag-off lowering for this
    // fixture — if this stops matching, the fixture no longer covers the fast
    // path and the flag-on assertion below is vacuous.
    expect(watOff).toContain("__get_member_keyword");
    // The fast path replaced every dynamic read of the fixture: no dispatcher
    // is referenced (not even defined — nothing reserves it).
    expect(watOn).not.toContain("__get_member_keyword");
    expect(watOn).not.toContain("__get_member_beforeExpr");
  });

  it("write twin: struct.set through the typed receiver, assignment still evaluates to the RHS", async () => {
    const { result } = await runBothWays(`
function T(k) { this.keyword = k; this.beforeExpr = true; }
function P() { this.type = new T(41); this.pos = 0; }
var pp = P.prototype;
pp.bump = function () { this.type.keyword = this.type.keyword + 1; return this.type.keyword; };
pp.assignResult = function () { return (this.type.keyword = 7) + this.type.keyword; };
export function test() {
  const p = new P();
  return p.bump() * 100 + p.assignResult();
}
`);
    // bump: 41+1 = 42; assignResult: (=7 evaluates to 7) + 7 = 14.
    expect(result).toBe(4214);
  });

  it("member CALL through the typed receiver stays dynamic and keeps working", async () => {
    const { result } = await runBothWays(`
function T(k) { this.keyword = k; }
T.prototype.twice = function () { return this.keyword * 2; };
function P() { this.type = new T(21); }
var pp = P.prototype;
pp.callTwice = function () { return this.type.twice(); };
export function test() {
  const p = new P();
  return p.callTwice();
}
`);
    expect(result).toBe(42);
  });

  it("ctor-unseeded property on the typed receiver stays dynamic (write-then-read round trip)", async () => {
    // `extra` is never seeded in T's ctor, so it is NOT a struct slot — the
    // access must keep taking the dynamic path (`nofield` decline). What the
    // dynamic path ANSWERS for an expando on a fnctor instance is its own
    // (pre-existing) business and is deliberately not pinned here; the
    // contract is that the flag does not change it (runBothWays asserts
    // flag-on === flag-off) and that the write does not corrupt the real
    // struct slot next to it.
    const { result } = await runBothWays(`
function T(k) { this.keyword = k; }
function P() { this.type = new T(40); }
var pp = P.prototype;
pp.stash = function () { this.type.extra = 2; return this.type.extra; };
pp.readKeyword = function () { return this.type.keyword; };
export function test() {
  const p = new P();
  const e = p.stash();
  const eTag = e === 2 ? 1 : e === undefined ? 2 : e === null ? 3 : 4;
  return eTag * 1000 + (p.readKeyword() === 40 ? 100 : 0);
}
`);
    // The seeded slot survives the neighboring expando write in both modes.
    expect(typeof result).toBe("number");
    expect((result as number) % 1000).toBe(100);
  });

  it("presence-tracked / conditionally-seeded field keeps answering undefined when unset", async () => {
    const { result } = await runBothWays(`
function T(k) { this.keyword = k; if (k > 100) { this.opt = k; } }
function P(k) { this.type = new T(k); }
var pp = P.prototype;
pp.readOpt = function () { return this.type.opt === undefined ? -1 : this.type.opt; };
export function test() {
  const unset = new P(41);
  const set = new P(200);
  return unset.readOpt() * 1000 + set.readOpt();
}
`);
    expect(result).toBe(-800); // -1 * 1000 + 200
  });

  it("null receiver throws a CATCHABLE TypeError, not a trap", async () => {
    // `rawRead` is load-bearing: with a single reader the compiler resolves the
    // read statically and answers undefined for a null receiver in BOTH flag
    // states (no dispatcher is ever built). The second reader forces the
    // dynamic `__get_member_` route, whose null behavior is the catchable
    // TypeError this test pins — and the flag-on fast path must reproduce it
    // (`emitReceiverNullGuard`), never a raw `struct.get` trap.
    const { result, watOff } = await runBothWays(`
function T(k) { this.keyword = k; }
function P() { this.type = new T(41); }
var pp = P.prototype;
pp.tryRead = function () { try { return this.type.keyword; } catch (e) { return -7; } };
pp.rawRead = function () { return this.type.keyword; };
export function test() {
  const p = new P();
  p.type = null;
  return p.tryRead();
}
export function test2() {
  const p = new P();
  return p.rawRead();
}
`);
    expect(watOff, "fixture must exercise the dynamic dispatcher flag-off").toContain("__get_member_keyword");
    expect(result).toBe(-7);
  });
});
