import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2040/#1888 — tag-5 field-4 equality (RESHAPED: string arm landed, the
// both-tags-5 numeric/object classifier DEFERRED).
//
// The tag-5 (string) box's `externval` (field 4 of $AnyValue) is overloaded: it
// holds genuine strings, `$BoxedNumber`s (the #1888 −794 "box-the-externref"
// contract for numbers that pass through externref), and non-string GC objects.
// The tag-5 arm of both __any_eq and __any_strict_eq now routes to the GUARDED
// native string-content compare (`ref.test $AnyString`-gated), which banks #2579
// boxed-string `===` + #2583 `Array.prototype.{indexOf,…}.call(arrayLike)` and is
// `0` for non-string tag-5 pairs (main's legacy answer).
//
// A broader CLASSIFIER (a #2040 numeric `f64.eq` arm for two boxed-NUMBERS, and a
// #2585 `ref.eq` proto-identity arm for two boxed OBJECTS) was tried in #1888 but
// EJECTED from the merge_group on the standalone-highwater floor (−162): changing
// tag-5 boxed-VALUE equality for numbers/objects flips a comparison the
// destructuring / generator-iterator lowering implicitly relied on (it counted on
// the legacy always-false tag-5 non-string eq), regressing the class/dstr cluster.
// Those two arms are DEFERRED to the value-rep substrate (#2580 M2 / #35); the
// cases they would fix are `it.skip`ped below with that reference. The cross-tag
// String⇄Number coercion (`tag5ToNumber`) is a separate, dstr-safe #2040 fix and
// stays — `23===23.0`, NaN, ±0 below still pass via that path.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { main(): unknown }).main();
}

describe("#2040/#2585 unified tag-5 field-4 equality classifier (standalone)", () => {
  // ── #2040 numeric branch ──────────────────────────────────────────────
  it("23 === 23.0 across any boxes is true", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=23; const b:any=23.0; return (a===b)?1:0; }`),
    ).toBe(1);
  });

  // DEFERRED to #2580 M2 / #35: the both-tags-5 numeric `f64.eq` classifier arm
  // regresses the class/dstr cluster (−162, ejected #1888). Re-enable when the
  // value-rep substrate owns the dstr-iterator interaction.
  it.skip("a !== a after a numeric op is false (a is a number, ===itself) — DEFERRED #2580 M2", async () => {
    // 1/a forces `a` through the boxed-number tag-5 path; a!==a must be false.
    expect(
      await runStandalone(
        `function f(a:any){const _=1/a;return a!==a;} export function main(): number { return f(5)?1:0; }`,
      ),
    ).toBe(0);
  });

  it.skip("boxed-number === boxed-number (post-op) is true — DEFERRED #2580 M2", async () => {
    expect(
      await runStandalone(
        `function f(a:any,b:any){const x=a+0;const y=b+0;return x===y;} export function main(): number { return f(7,7)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("(1/a) === (1/b) for equal a,b is true", async () => {
    expect(
      await runStandalone(
        `function f(a:any,b:any){return (1/a)===(1/b);} export function main(): number { return f(2,2)?1:0; }`,
      ),
    ).toBe(1);
  });

  // ── NaN contract (−788 preserved): NaN === NaN stays false ────────────
  it("NaN === NaN via any boxes is false (f64.eq self-false)", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=NaN; const b:any=NaN; return (a===b)?1:0; }`),
    ).toBe(0);
  });

  it("NaN !== NaN is true", async () => {
    expect(await runStandalone(`export function main(): number { const a:any=NaN; return (a!==a)?1:0; }`)).toBe(1);
  });

  it("+0 === -0 is true", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=0; const b:any=-0; return (a===b)?1:0; }`),
    ).toBe(1);
  });

  it("1 === 2 via any boxes is false", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=1; const b:any=2; return (a===b)?1:0; }`),
    ).toBe(0);
  });

  // ── #2585 object proto-identity (ref.eq branch) — DEFERRED to #2580 M2 / #35 ──
  // The both-tags-5 object `ref.eq` arm makes tag-5 boxed-object `===` reference-
  // correct, but that flips a comparison the dstr/generator-iterator lowering
  // relied on (it counted on the legacy always-false tag-5 object eq), regressing
  // the class/dstr cluster (part of the −162 #1888 eject). Re-enable with the
  // value-rep substrate.
  it.skip("getPrototypeOf(Object.create(p)) === p is true — DEFERRED #2580 M2", async () => {
    expect(
      await runStandalone(
        `export function main(): number { const p:any={x:1}; const o=Object.create(p); return (Object.getPrototypeOf(o)===p)?1:0; }`,
      ),
    ).toBe(1);
  });

  it.skip("same object via two reads === is true — DEFERRED #2580 M2", async () => {
    expect(
      await runStandalone(`export function main(): number { const o:any={x:1}; const p:any=o; return (o===p)?1:0; }`),
    ).toBe(1);
  });

  it("two distinct objects === is false", async () => {
    expect(
      await runStandalone(
        `export function main(): number { const o:any={x:1}; const p:any={x:1}; return (o===p)?1:0; }`,
      ),
    ).toBe(0);
  });

  // ── loose-eq numeric (cross-tag arm tolerates boxed-number field-4) ───
  it("23 == 23.0 via any boxes is true (loose)", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=23; const b:any=23.0; return (a==b)?1:0; }`),
    ).toBe(1);
  });
});
