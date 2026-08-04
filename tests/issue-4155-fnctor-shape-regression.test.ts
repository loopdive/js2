// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4155 Phase 0 — the #1712 regression, committed as a test BEFORE any behavior
// moves.
//
// `src/codegen/index.ts:7654` records that resolving a function-style
// constructor's instance type to the ctor struct "was tried and regressed
// (.tmp/dbg15.mts G4/G5)" — but the fixtures lived in a scratch file that no
// longer exists, so the only record of what broke is a sentence. Phase 1 of the
// #4155 plan changes exactly that resolution, which makes reconstructing the
// break the first thing to do.
//
// These assert EXECUTION RESULTS, never representation: they must pass before
// Phase 1, after Phase 1, and after Phase 2. A failure here means a fnctor
// instance guard-cast to null somewhere and a `struct.get` / `ref.as_non_null`
// read garbage — the exact #1712 failure mode.
//
// The named shape (`F.prototype.m = function () { return new F(...) }`) is the
// one #1712 cites. The rest cover the other ways an instance reaches a use site
// — field, parameter, return, array element — because a shape-resolution change
// is a whole-program change and the cited shape is unlikely to have been the
// only casualty.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function runHost(src: string): Promise<number> {
  const r = await compile(src, { fileName: "t.js", allowJs: true, skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "invalid wasm").toBe(true);
  return r.binary.length > 0 ? 1 : 0;
}

describe("#4155 Phase 0 — the #1712 shape must keep working", () => {
  // THE cited shape: a prototype method that returns a FRESH instance of its
  // own fnctor, then a field read on the returned value at the call site.
  it("prototype method returning a new instance — field read at the call site", async () => {
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        P.prototype.spawn = function () { return new P(this.pos + 1); };
        export function test(): number {
          const p: any = new P(41);
          return p.spawn().pos;
        }
      `),
    ).toBe(42);
  });

  it("prototype method returning a new instance — METHOD call at the call site", async () => {
    // The method-call path is where #1712 says it died: "the member-call
    // static/dynamic split keys off this type".
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        P.prototype.spawn = function () { return new P(this.pos + 1); };
        P.prototype.get = function () { return this.pos; };
        export function test(): number {
          const p: any = new P(41);
          return p.spawn().get();
        }
      `),
    ).toBe(42);
  });

  it("chained spawn — two hops through the same shape", async () => {
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        P.prototype.spawn = function () { return new P(this.pos + 1); };
        export function test(): number {
          const p: any = new P(40);
          return p.spawn().spawn().pos;
        }
      `),
    ).toBe(42);
  });

  // An instance stored in ANOTHER fnctor's field — the cross-fnctor ref case
  // `linear-type-reservations.ts:130` describes.
  it("instance stored in another fnctor's field, read back through a method", async () => {
    expect(
      await runStandalone(`
        function Inner(n: number) { this.v = n; }
        Inner.prototype.get = function () { return this.v; };
        function Outer() { this.inner = new Inner(42); }
        Outer.prototype.read = function () { return this.inner.get(); };
        export function test(): number {
          const o: any = new Outer();
          return o.read();
        }
      `),
    ).toBe(42);
  });

  it("instance passed as a parameter to a plain function", async () => {
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        P.prototype.get = function () { return this.pos; };
        function readIt(p: any) { return p.get(); }
        export function test(): number {
          const p: any = new P(42);
          return readIt(p);
        }
      `),
    ).toBe(42);
  });

  it("instanceof and prototype identity survive", async () => {
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        export function test(): number {
          const p: any = new P(1);
          return (p instanceof P) ? 42 : 0;
        }
      `),
    ).toBe(42);
  });

  // The prototype-ALIAS form is acorn's actual shape (#2681) — 257 of its 270
  // methods are defined this way, so a resolution change that only handles the
  // direct form would miss essentially all of the real corpus.
  it("prototype-ALIAS method definition (acorn's real shape)", async () => {
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        const pp: any = P.prototype;
        pp.spawn = function () { return new P(this.pos + 1); };
        pp.get = function () { return this.pos; };
        export function test(): number {
          const p: any = new P(41);
          return p.spawn().get();
        }
      `),
    ).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// PRE-EXISTING FAILURES, found by writing the block above against current main.
//
// These are NOT caused by any #4155 change — they fail on plain `main` today.
// Each is valid JavaScript that a standalone build gets wrong, and they share
// one mechanism, the #2660 S3 one: an instance whose `new F()` site the escape
// gate does not classify `reconstruct` keeps its bespoke `$__fnctor_F` struct,
// which has NO `$proto` field, so every dynamic read on it misses the prototype
// walk and yields 0 / undefined instead of trapping. The gate's classifier only
// sees the *syntactic* uses of the `new` expression, so an instance that leaves
// through a return, an array slot, or a late-added field escapes its analysis.
//
// `it.fails` is deliberate: it asserts these still fail, so whoever fixes one is
// told by a RED test to promote it into the block above. Recorded here rather
// than filed-and-forgotten because they bound Phase 1 — resolving instance types
// to the struct cannot be called done while these three positions are broken,
// and two of them (return-position and collection round-trip) are shapes acorn
// uses constantly.
//
// Verified on main @ 61ff9cc7a: returns 0, 0, and NaN respectively.
// ---------------------------------------------------------------------------
describe("#4155 Phase 0 — known-broken instance flow positions (pre-existing)", () => {
  it.fails("instance returned from a plain function, then member-called → 0", async () => {
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        P.prototype.get = function () { return this.pos; };
        function make(n: number) { return new P(n); }
        export function test(): number {
          const p: any = make(42);
          return p.get();
        }
      `),
    ).toBe(42);
  });

  it.fails("instance round-tripped through an array element → 0", async () => {
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        P.prototype.get = function () { return this.pos; };
        export function test(): number {
          const xs: any[] = [new P(42)];
          return xs[0].get();
        }
      `),
    ).toBe(42);
  });

  it.fails("field added by a method, never seeded in the ctor → NaN", async () => {
    expect(
      await runStandalone(`
        function P(n: number) { this.pos = n; }
        P.prototype.stash = function () { this.extra = this.pos + 1; };
        export function test(): number {
          const p: any = new P(41);
          p.stash();
          return p.extra;
        }
      `),
    ).toBe(42);
  });
});

describe("#4155 Phase 0 — JS-host lane compiles the same shapes", () => {
  // The host lane keeps externref resolution under the Phase 1 plan, so this is
  // a guard against a change leaking across lanes rather than a behavioral
  // assertion. Compile-and-validate only: the host lane needs an import object
  // this test deliberately does not build.
  it("the cited shape compiles and validates in the host lane", async () => {
    expect(
      await runHost(`
        function P(n) { this.pos = n; }
        P.prototype.spawn = function () { return new P(this.pos + 1); };
        export function test() { var p = new P(41); return p.spawn().pos; }
      `),
    ).toBe(1);
  });
});
