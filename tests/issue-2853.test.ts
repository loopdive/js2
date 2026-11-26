// #2853 Bug A — dynamic property reads must resolve by KEY, not struct OFFSET.
//
// WasmGC type identity is structural: without shape branding, the engine
// canonicalizes `{startsExpr: boolean}` and `{beforeExpr: boolean}` (same
// layout, different keys) to ONE runtime type, so the `ref.test`-keyed
// `__sget_<key>` dispatch matched the wrong shape and read the sibling field
// at the same offset: `({startsExpr: true}).beforeExpr === true`.
// In acorn this made `num.beforeExpr` read `startsExpr`'s `true`, so the
// tokenizer scanned `1 / 2` as a regex literal and trapped.
//
// The fix (src/codegen/shape-brand.ts) appends a trailing brand-ref field to
// structurally-colliding `__anon_*` / `__fnctor_*` shapes, making them
// nominally distinct.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(src: string): Promise<Record<string, any>> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any);
  expect(r.success, `Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(true);
  const instance = await instantiateWithRuntime(r);
  return instance.exports as any;
}

describe("#2853 bug A — absent-key reads must not alias same-offset sibling fields", () => {
  it("reading an absent key off a single-key object literal is falsy, not the sibling's value", async () => {
    const ex = await run(`
      function TT(conf) { this.beforeExpr = !!conf.beforeExpr; }
      export function readAbsent() { var c = { startsExpr: true }; return c.beforeExpr; }
      export function fromStartsExpr() { return new TT({ startsExpr: true }).beforeExpr ? 1 : 0; }
      export function fromBeforeExpr() { return new TT({ beforeExpr: true }).beforeExpr ? 1 : 0; }
      export function readPresent() { var c = { beforeExpr: true }; return c.beforeExpr ? 1 : 0; }
    `);
    // The exact absent-read flavor (undefined vs null) rides on the host
    // __extern_get miss path; the load-bearing assertion is that it is NOT
    // the aliased sibling value `true`.
    expect(ex.readAbsent()).toBeFalsy();
    // acorn's exact TokenType pattern: !!conf.beforeExpr with a conf shape
    // that has no beforeExpr key MUST be false…
    expect(ex.fromStartsExpr()).toBe(0);
    // …and with the key present MUST be true (positive control).
    expect(ex.fromBeforeExpr()).toBe(1);
    expect(ex.readPresent()).toBe(1);
  });

  it("three same-layout single-key shapes stay pairwise distinct", async () => {
    const ex = await run(`
      export function t(): number {
        var a: any = { alpha: 111 };
        var b: any = { beta: 222 };
        var c: any = { gamma: 333 };
        // Absent-key cross-shape reads must NOT alias the sibling field at the
        // same offset. (The exact miss flavor — undefined/null/coerced 0 — is
        // a separate pre-existing typed-read residual; the load-bearing
        // property is that no read returns another shape's live value.)
        var aliasedReads = 0;
        if (a.beta === 222 || a.beta === 111) aliasedReads++;
        if (a.gamma === 333 || a.gamma === 111) aliasedReads++;
        if (b.alpha === 111 || b.alpha === 222) aliasedReads++;
        if (c.alpha === 111 || c.alpha === 333) aliasedReads++;
        return aliasedReads * 10000 + a.alpha + b.beta + c.gamma;
      }
    `);
    // No cross-shape reads may alias; own reads stay correct (111+222+333).
    expect(ex.t()).toBe(666);
  });

  it("division after a numeric literal parses in the acorn tokenizer pattern (truthiness dispatch)", async () => {
    // Distills acorn's updateContext else-branch: exprAllowed must become
    // FALSE after a `num` token (beforeExpr absent on its conf shape).
    const ex = await run(`
      function TokenType(label, conf) {
        this.label = label;
        this.beforeExpr = !!conf.beforeExpr;
        this.startsExpr = !!conf.startsExpr;
      }
      export function exprAllowedAfterNum(): number {
        var startsExpr = { startsExpr: true };
        var beforeExpr = { beforeExpr: true };
        var num = new TokenType("num", startsExpr);
        var comma = new TokenType(",", beforeExpr);
        // tokenizer: exprAllowed = type.beforeExpr
        var afterNum = num.beforeExpr ? 1 : 0;
        var afterComma = comma.beforeExpr ? 1 : 0;
        return afterNum * 10 + afterComma;
      }
    `);
    // after `num` → 0 (division), after `,` → 1 (regex allowed)
    expect(ex.exprAllowedAfterNum()).toBe(1);
  });

  // Park-regression guard (#2853 merge_group re-park): the shape-brand finalize
  // pass separates previously-canonically-equal same-layout shapes. A `var`
  // reassigned across DIFFERENT-KEY same-layout object literals is typed to the
  // FIRST shape by the front-end, which then emits a guarded downcast
  // (`ref.test T … else ref.null T ; ref.as_non_null`) for each later
  // assignment. Pre-brand those passed by canonical-merge coincidence; post-brand
  // they must trap (`dereferencing a null pointer`) UNLESS the coercion registers
  // both sibling shapes as no-brand. This reproduces the exact test262 regression
  // cluster (S11.1.5_A4.3, S11.4.9, S13.2.2, Temporal *singular-properties*).
  it("a var reassigned across same-layout different-key object literals does not trap", async () => {
    // NB: 'o' is deliberately UNANNOTATED so the object-widening pre-pass types
    // the local as a bare '__anon' struct (the trap needs a concrete struct
    // local + guarded downcast; an ': any' local stays externref and dispatches
    // dynamically, sidestepping the bug). Multiple same-layout literals in the
    // module give the collision (keyCount >= 2) that drives branding.
    const ex = await run(`
      export function t(): number {
        var o = { undefined: true }; // shape A  {k:i32,$shape}
        if (o.undefined !== true) return 1;
        o = { true: true } as any;   // shape B — same layout, different key
        if ((o as any).true !== true) return 2;
        o = { null: true } as any;   // shape C
        if ((o as any).null !== true) return 3;
        return 0;
      }
    `);
    // Must complete without a null-deref trap and read each own key correctly.
    expect(ex.t()).toBe(0);
  });
});
