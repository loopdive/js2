/**
 * #6966 — `numericFunctions` must be settled against the POST-groundedness
 * property set.
 *
 * `analyzeNumericPropertyNames` runs a greatest fixpoint over three sets
 * (numeric functions, slots, property names). A property written only through
 * an opaque parameter (`this.v2 = var2`) survives that loop, so a method whose
 * only return is `this.v2` stays in `numericFunctions`. The groundedness filter
 * used to run once AFTER the loop and drop `v2` without re-settling the
 * functions, so `typed-this.ts` minted an `(result f64)` twin for `input` that
 * unboxed the stored object to NaN — Octane deltablue's
 * `BinaryConstraint.prototype.input`, which crashed in `Strength.weaker`.
 *
 * Standalone only: the JS-host lane is being sunset and never miscompiled this.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function run(source: string): Promise<{ result: unknown; twinDecls: string[] }> {
  const r = await compile(source, {
    fileName: "t.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success).toBe(true);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const instance = await WebAssembly.instantiate(module, {});
  const result = (instance.exports as Record<string, () => unknown>).main?.();
  const twinDecls = (r.wat ?? "").split("\n").filter((line) => /^\s*\(func \$\S*__typed_this\b/.test(line));
  return { result, twinDecls };
}

/** Each fixture returns a NUMBER so the probe needs no string marshalling:
 *  `typeof ihn === "object"` is the bit the bug flipped. */
const OPAQUE_ONLY = `
function Variable(name) { this.name = name; this.w = 7; }
function BC(var2) { this.v2 = var2; }
BC.prototype.input = function () { return this.v2; };
export function main() {
  var e = new BC(new Variable("b"));
  var ihn = e.input();
  return typeof ihn === "object" ? ihn.w : -1;
}`;

// The deltablue shape: the conditional is irrelevant, both arms are opaque-param fields.
const DELTABLUE_SHAPE = `
function Variable(name, w) { this.name = name; this.walkStrength = w; }
function BinaryConstraint(var1, var2, strength) {
  this.strength = strength;
  this.v1 = var1; this.v2 = var2; this.direction = 0;
  this.recalculate();
}
BinaryConstraint.prototype.input = function () { return (this.direction == 1) ? this.v1 : this.v2; };
BinaryConstraint.prototype.output = function () { return (this.direction == 1) ? this.v2 : this.v1; };
BinaryConstraint.prototype.recalculate = function () {
  var ihn = this.input(), out = this.output();
  this.res = typeof ihn === "object" && typeof out === "object" ? ihn.walkStrength * 10 + out.walkStrength : -1;
};
export function main() {
  var e = new BinaryConstraint(new Variable("a", 1), new Variable("b", 2), 3);
  var first = e.res;
  e.direction = 1;
  e.recalculate();
  return first * 100 + e.res;
}`;

// A slot assigned from the withdrawn method must not be an f64 local either.
const VIA_LOCAL = `
function Box(v) { this.v = v; }
Box.prototype.get = function () { return this.v; };
export function main() {
  var b = new Box({ k: 41 });
  var x = b.get();
  var y = x;
  return typeof y === "object" ? y.k + 1 : -1;
}`;

// Positive control: `v2` has a provably numeric write elsewhere, so it is grounded
// and `input` keeps its f64 twin.
const GROUNDED = `
function BC(var2) { this.v2 = var2; }
BC.prototype.input = function () { return this.v2; };
BC.prototype.reset = function () { this.v2 = 3; };
export function main() {
  var e = new BC(5);
  var a = e.input();
  e.reset();
  return a * 10 + e.input() + 1;
}`;

describe("#6966 — numericFunctions re-settled after groundedness (standalone)", () => {
  it("a method returning an opaque-param-only field returns the object, not NaN", async () => {
    const { result, twinDecls } = await run(OPAQUE_ONLY);
    expect(result).toBe(7);
    expect(twinDecls.length).toBeGreaterThan(0);
    expect(twinDecls.filter((d) => /\(result f64\)/.test(d))).toEqual([]);
  });

  it("deltablue BinaryConstraint.input/output keep their objects through both directions", async () => {
    const { result } = await run(DELTABLUE_SHAPE);
    expect(result).toBe(21 * 100 + 12);
  });

  it("a local copied from the withdrawn method's result is not an f64 carrier", async () => {
    const { result } = await run(VIA_LOCAL);
    expect(result).toBe(42);
  });

  it("control: a grounded field still gets an f64 twin and the right number", async () => {
    const { result, twinDecls } = await run(GROUNDED);
    expect(result).toBe(54);
    expect(twinDecls.some((d) => /\(result f64\)/.test(d))).toBe(true);
  });
});
