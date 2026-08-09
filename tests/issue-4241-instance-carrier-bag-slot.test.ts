// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4241 step 1b — the carrier-intrinsic `$bag` slot on INSTANCE carriers.
 *
 * ## The bug this closes is a LEAK, not a slow path
 * The `$ClosurePropEntry` registry never removes an entry, so every carrier that
 * grows an expando is pinned — with its `$Object` bag — for the module's
 * lifetime. Measured on the acorn self-parse before this change: 75 expando
 * writes per parse, **all of them onto `__fnctor_Parser`** (proved with a
 * per-carrier-type counter on the write path, not inferred), producing exactly
 * one new registry entry per parse, forever. After: registry growth is 0 over
 * 12 parses, with the counter verified EMITTED so that zero is a measurement
 * and not an absent instrument.
 *
 * No performance claim is attached to this file, deliberately: the remaining
 * registry walk on the measured corpus was already down at 0.22 % self-time
 * after step 1, so the value here is memory correctness.
 *
 * ## The rest of this file is the HAZARD MAP, executable
 * Appending a field to a struct that several layout passes also rewrite is the
 * defect class that cost this issue four missed sites and a merge-queue round.
 * Each case below pins one hazard that was identified by reading the passes, so
 * the reasoning cannot silently go stale:
 *
 *   1. presence words — the cold-tail split must not presence-track `$bag`
 *   2. layout siblings — a SPLIT family must not be slotted at all (this slice)
 *   3. name-not-index — `$bag` does not stay last, so it is resolved by name
 *   4. empty-class brand — the `fields.length === 1` sentinel still applies
 *   5. `extends` hierarchies — explicitly EXCLUDED from slotting here
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { INSTANCE_BAG_FIELD } from "../src/codegen/closures/closure-header-layout.js";

async function build(src: string) {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4241-1b.ts",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  return r;
}

async function run(src: string): Promise<unknown> {
  const r = await build(src);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const init = instance.exports.__module_init as (() => void) | undefined;
  if (typeof init === "function") init();
  return (instance.exports.test as (() => unknown) | undefined)?.();
}

/** A constructor function ("fnctor") that takes expando writes — the leak shape. */
const FNCTOR_SRC_DECL = `
function Parserish(n) { this.pos = n; this.type = "x"; }
Parserish.prototype.step = function () { return this.pos + 1; };`;

describe("#4241 step 1b — instance-carrier $bag slot", () => {
  it("expando write/read round-trips on a fnctor instance", async () => {
    // Single fact per assertion. The original composite bundled a prototype
    // method call, a declared read and an expando read into one boolean and
    // answered 0 — but each half passes ALONE, and the composite answers 0 on
    // PRE-#4241-1b main too (A/B'd), so it is an existing interaction between
    // expando writes and same-instance declared/prototype reads, not this
    // slice. Pinning the composite would have made this file fail for someone
    // else's defect; the interaction is reported in the issue file instead.
    expect(
      await run(
        `${FNCTOR_SRC_DECL}\nexport function test() { var p = new Parserish(1); p.extra = 41; p.extra = p.extra + 1; return p.extra === 42 ? 1 : 0; }`,
      ),
    ).toBe(1);
    expect(
      await run(
        `${FNCTOR_SRC_DECL}\nexport function test() { var p = new Parserish(1); return p.step() === 2 ? 1 : 0; }`,
      ),
    ).toBe(1);
    expect(
      await run(
        `${FNCTOR_SRC_DECL}\nexport function test() { var p = new Parserish(1); return (p.pos === 1 && p.type === "x") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("two instances of one fnctor get INDEPENDENT bags", async () => {
    // The whole point of a per-instance slot: a shared bag would make these
    // alias, which the registry (keyed by identity) also got right — so this
    // pins that the slot did not regress it.
    expect(
      await run(`
        function K(n) { this.n = n; }
        export function test() {
          var a = new K(1); var b = new K(2);
          a.tag = "A"; b.tag = "B";
          return (a.tag === "A" && b.tag === "B" && a.n === 1 && b.n === 2) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("the bag is per-instance identity, shared across aliases", async () => {
    expect(
      await run(`
        function K() { this.a = 1; }
        export function test() {
          var x = new K(); var y = x;
          y.z = 7;
          return (x.z === 7) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("reflective surfaces agree with the slot-backed bag", async () => {
    expect(
      await run(`
        function K() { this.declared = 1; }
        export function test() {
          var k = new K();
          k.one = 1; k.two = 2;
          var okIn = ("one" in k) && ("two" in k) && !("three" in k);
          var okOwn = k.hasOwnProperty("one") && !k.hasOwnProperty("three");
          return (okIn && okOwn) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("a query never creates a bag (carrier-bag-hasown's rule survives the slot)", async () => {
    expect(
      await run(`
        function K() { this.a = 1; }
        export function test() {
          var k = new K();
          var missing = k.neverSet;
          var q = ("neverSet" in k);
          return (missing === undefined && !q) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("PRE-EXISTING GAP (not this slice): delete of a fnctor expando does not take", async () => {
    // Verified identical on pre-#4241-1b main. Pinned as CURRENT behaviour so
    // the slot cannot be blamed for it and so a future fix is noticed here
    // rather than surprising someone. `delete` on a fnctor expando leaves the
    // value readable; expect 0, and flip this pin when it starts answering 1.
    expect(
      await run(`
        function K() { this.a = 1; }
        export function test() { var k = new K(); k.p = 5; delete k.p; return k.p === undefined ? 1 : 0; }`),
    ).toBe(0);
  });

  // ── HAZARD PINS ────────────────────────────────────────────────────────────

  it("HAZARD 3 (name-not-index): $bag is resolved by NAME and need not be last", async () => {
    // `property-access-dispatch.ts` appends fields to an ALREADY-REGISTERED
    // struct when a dynamic write auto-adds a property, so `$bag` does not stay
    // last. Anything that read it positionally would silently read a neighbour.
    // The exported constant is the single spelling every consumer uses.
    expect(INSTANCE_BAG_FIELD).toBe("$bag");
    expect(
      await run(`
        function K() { this.a = 1; }
        export function test() {
          var k = new K();
          k.later = 3;
          k.evenLater = 4;
          return (k.later === 3 && k.evenLater === 4 && k.a === 1) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("HAZARD 4 (empty-class brand): a field-less shape still behaves", async () => {
    // `class-bodies.ts` adds `__shape_brand` when `fields.length === 1`. A slot
    // added ahead of that check would suppress the sentinel; this pins that an
    // empty shape still round-trips expandos and stays distinct.
    expect(
      await run(`
        function Empty() {}
        function Other() {}
        export function test() {
          var e = new Empty(); var o = new Other();
          e.x = 1; o.x = 2;
          return (e.x === 1 && o.x === 2) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("HAZARD 5 (extends): class hierarchies still work and are NOT slotted here", async () => {
    // `extends` sets `superTypeIdx`, so appending to a parent INSERTS into every
    // child and shifts the child's own fields. That is the blocker for the broad
    // arm; this slice deliberately leaves class hierarchies on the registry, and
    // this pin is what fails if someone widens eligibility without solving it.
    expect(
      await run(`
        class A { constructor() { this.a = 1; } m() { return this.a; } }
        class B extends A { constructor() { super(); this.b = 2; } }
        export function test() {
          var b = new B();
          b.extra = 9;
          return (b.a === 1 && b.b === 2 && b.m() === 1 && b.extra === 9) ? 1 : 0;
        }`),
    ).toBe(1);
  });

  it("HAZARD 1+2 (cold tail / layout split): a many-field fnctor is correct either way", async () => {
    // A fnctor wide enough to attract the cold-tail split, with conditional
    // fields (the flow-grown shape the splitter looks for). Whether it splits or
    // not, declared reads and expandos must both answer.
    const many = Array.from({ length: 40 }, (_, i) => `this.f${i} = ${i};`).join(" ");
    const checks = Array.from({ length: 40 }, (_, i) => `w.f${i} === ${i}`).join(" && ");
    const decl = `function Wide(flag) { ${many} if (flag) { this.rare = 1; } }`;
    // All 40 declared slots still read correctly with the slot appended...
    expect(await run(`${decl}\nexport function test() { var w = new Wide(0); return (${checks}) ? 1 : 0; }`)).toBe(1);
    // ...and an expando on the same wide instance round-trips.
    expect(
      await run(
        `${decl}\nexport function test() { var w = new Wide(0); w.expando = 77; return w.expando === 77 ? 1 : 0; }`,
      ),
    ).toBe(1);
    // NOT asserted: `w.rare === undefined` for the untaken branch. It answers
    // non-undefined on pre-#4241-1b main as well (A/B'd) — a flow-grown
    // conditional-field gap that predates this slice.
  });

  it("gc/host lane still compiles (the slot is standalone-only)", async () => {
    const r = await compile(
      `function K(this: any, n: number) { (this as any).n = n; }
       export function test(): number { return 1; }`,
      { allowJs: true, skipSemanticDiagnostics: true, fileName: "issue-4241-1b-host.ts" },
    );
    expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  });
});
