// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4470 — IR adoption of DESTRUCTURING for-of heads (`for (const [p, q] of …)`).
//
// ADOPTED 2026-08-29 by #5166. This file used to pin the OPPOSITE: the reject
// arm named by the `ForOfStatement` row (`nontail-forof`, #3583) was never the
// constraint — a destructuring head's source is the for-of ELEMENT, so the
// element has to be an indexable vec, and the IR could not represent a vec
// whose element is a vec at two independent layers:
//
//   1. `resolvePositionType` (src/codegen/index.ts) threw on a `number[]`
//      element (it resolves to `irVec`, which matched no elemVal arm).
//   2. `prepared-vector-support.ts` accepted element ValTypes f64 / i32 /
//      externref only, so a `vec<vec<externref>>` (`string[][]`) was refused
//      there — as an untyped `invariant`, i.e. a HARD compile error, until
//      #4486 typed it as a soft withdrawal.
//
// #5166 fixed BOTH by mirroring legacy's own carrier: a vec-typed element is
// registered as a concrete `ref null $__vec_<inner>` and travels the existing
// `ref_<idx>` element path (no anyref, no cast-on-get). With that in place the
// head lift is what #4470 predicted — leaf reads emitted inside the body
// collector, one per iteration, off the element slot.
//
// What this file pins now:
//
//   A. the selector contract: simple array-pattern heads CLAIM; defaults,
//      rest, nesting and OBJECT patterns still reject, on their own arms;
//   B. the runtime SEMANTICS of destructuring for-of heads, checked against
//      Node — these were the contract the adoption had to preserve, and did;
//   C. the CARRIER itself: `number[][]` and `string[][]` now emit IR bodies.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/** Is `f` claimed by the IR selector, and if not, under which reason bucket? */
function selectorVerdict(source: string): { claimed: boolean; reason: string | undefined } {
  const ast = analyzeSource(source);
  const sel = planIrCompilation(ast.sourceFile, { experimentalIR: true, trackFallbacks: true });
  return {
    claimed: sel.funcs.has("f"),
    reason: (sel.fallbacks ?? []).find((fb) => fb.name === "f")?.reason,
  };
}

/** The IR preparation outcome recorded for `f`, if any. */
async function outcomeForF(source: string) {
  const r = await compile(source, { fileName: "issue-4470.ts", experimentalIR: true, trackIrOutcomes: true });
  const outcome = r.irOutcomes?.find((o) => o.displayName === "f");
  return { result: r, outcome };
}

/** Compile, instantiate, call `main`. */
async function runMain(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "issue-4470.ts", experimentalIR: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).main!();
}

// ---------------------------------------------------------------------------
// A. Selector contract — which for-of heads the IR claims today.
// ---------------------------------------------------------------------------

describe("#4470 A — for-of head shapes the IR selector claims", () => {
  const body = `let s = 0;`;

  it("claims the IDENTIFIER head (the contrast case)", () => {
    const v = selectorVerdict(`
      export function f(rows: number[][]): number {
        ${body}
        for (const r of rows) { s += r[0]; }
        return s;
      }
    `);
    expect(v.claimed).toBe(true);
  });

  // (#5166) The simple array-pattern heads CLAIM now — the same set the #4470
  // prototype claimed, except that the carrier underneath them exists, so the
  // claim also lowers instead of turning working programs into compile errors.
  // `isPhase1BindingPattern` is the gate, exactly as for the VariableStatement
  // destructuring row: identifier leaves, sparse holes allowed.
  const CLAIMING_HEADS: Array<{ name: string; head: string; use: string }> = [
    { name: "array pattern [a, b]", head: "const [a, b]", use: "s += a + b;" },
    { name: "array pattern [a] (single leaf)", head: "const [a]", use: "s += a;" },
    { name: "array pattern [, b] (sparse hole)", head: "const [, b]", use: "s += b;" },
    { name: "let-bound array pattern", head: "let [a, b]", use: "s += a + b;" },
  ];

  for (const c of CLAIMING_HEADS) {
    it(`claims the ${c.name} head`, () => {
      const v = selectorVerdict(`
        export function f(rows: number[][]): number {
          ${body}
          for (${c.head} of rows) { ${c.use} }
          return s;
        }
      `);
      expect(v.claimed).toBe(true);
    });
  }

  // Wider array patterns stay rejected — the residuals #4470 listed. They
  // reject at the selector, so the function keeps its legacy body.
  const REJECTING_HEADS: Array<{ name: string; head: string; use: string }> = [
    { name: "array pattern with default [a = 1]", head: "const [a = 1]", use: "s += a;" },
    { name: "array pattern with rest [a, ...r]", head: "const [a, ...r]", use: "s += a + r.length;" },
  ];

  for (const c of REJECTING_HEADS) {
    it(`rejects the ${c.name} head`, () => {
      const v = selectorVerdict(`
        export function f(rows: number[][]): number {
          ${body}
          for (${c.head} of rows) { ${c.use} }
          return s;
        }
      `);
      expect(v.claimed).toBe(false);
      expect(v.reason).toBe("body-shape-rejected");
    });
  }

  it("rejects a NESTED array pattern head", () => {
    const v = selectorVerdict(`
      export function f(rows: number[][][]): number {
        let s = 0;
        for (const [[a]] of rows) { s += a; }
        return s;
      }
    `);
    expect(v.claimed).toBe(false);
    expect(v.reason).toBe("body-shape-rejected");
  });

  // Object patterns are a SEPARATE residual from the array ones and stay
  // rejected after the #5166 adoption: the for-of element slot carries a `val`
  // ValType, never `IrType.object`, so `lowerObjectPattern` has no field
  // carrier to read against.
  it("rejects an OBJECT pattern head (separate residual — no object carrier)", () => {
    const v = selectorVerdict(`
      export function f(pts: { x: number; y: number }[]): number {
        let s = 0;
        for (const { x } of pts) { s += x; }
        return s;
      }
    `);
    expect(v.claimed).toBe(false);
    expect(v.reason).toBe("body-shape-rejected");
  });
});

// ---------------------------------------------------------------------------
// B. Runtime semantics of destructuring for-of heads (currently legacy).
//
// These must keep passing through any future adoption — they are the contract,
// not an implementation detail. Each is checked against Node running the same
// source with the type annotations stripped.
// ---------------------------------------------------------------------------

describe("#4470 B — destructuring for-of head semantics match Node", () => {
  const PROGRAMS: Array<{ name: string; src: string }> = [
    {
      name: "[a, b] binds both leaves per iteration",
      src: `export function main(): number {
        const rows: number[][] = [[1, 2], [3, 4], [5, 6]];
        let s = 0;
        for (const [a, b] of rows) { s += a * 10 + b; }
        return s;
      }`,
    },
    {
      name: "[a] ignores the tail of a longer element",
      src: `export function main(): number {
        const rows: number[][] = [[7, 99], [8, 99]];
        let s = 0;
        for (const [a] of rows) { s += a; }
        return s;
      }`,
    },
    {
      name: "[, b] skips index 0",
      src: `export function main(): number {
        const rows: number[][] = [[1, 2], [3, 4]];
        let s = 0;
        for (const [, b] of rows) { s += b; }
        return s;
      }`,
    },
    {
      name: "let head — the leaf is re-bound fresh each iteration",
      src: `export function main(): number {
        const rows: number[][] = [[1, 2], [3, 4]];
        let s = 0;
        for (let [a, b] of rows) { a = a + 1; s += a * 10 + b; }
        return s;
      }`,
    },
    {
      name: "break and continue in a destructuring-head body",
      src: `export function main(): number {
        const rows: number[][] = [[0, 5], [2, 3], [9, 0], [4, 4]];
        let s = 0;
        for (const [a, b] of rows) {
          if (a === 0) continue;
          if (b === 0) break;
          s += a * 10 + b;
        }
        return s;
      }`,
    },
    {
      name: "empty iterable binds nothing and runs the body zero times",
      src: `export function main(): number {
        const rows: number[][] = [];
        let s = 7;
        for (const [a, b] of rows) { s += a + b; }
        return s;
      }`,
    },
    {
      name: "nested for-of: identifier head outside, pattern head inside",
      src: `export function main(): number {
        const grid: number[][][] = [[[1, 2], [3, 4]], [[5, 6]]];
        let s = 0;
        for (const rows of grid) { for (const [a, b] of rows) { s += a * 10 + b; } }
        return s;
      }`,
    },
    {
      name: "a default in the head fills a missing element",
      src: `export function main(): number {
        const rows: number[][] = [[1], [2, 3]];
        let s = 0;
        for (const [a, b = 50] of rows) { s += a + b; }
        return s;
      }`,
    },
  ];

  for (const p of PROGRAMS) {
    it(p.name, async () => {
      // Node reference: same source, annotations stripped, `export` dropped.
      const js = p.src.replace("export function main(): number", "function main()").replace(/:\s*number(\[\])*/g, "");
      const expected = new Function(`${js}; return main();`)() as number;
      await expect(runMain(p.src)).resolves.toBe(expected);
    });
  }

  // KNOWN DIVERGENCE, pre-existing on the LEGACY path and deliberately
  // preserved by the #5166 adoption.
  //
  // A missing leaf (`[a, b]` over the row `[1]`) is `undefined` in JS. Both
  // front-ends bind the element type's ZERO instead — measured on unmodified
  // main before the adoption and identical after it, so this is not something
  // the IR claim introduced. It is pinned as the MEASURED value rather than
  // the Node value on purpose: the adoption's contract is that a claimed unit
  // is observationally identical to the legacy body it replaces, and asserting
  // Node here would hide a real IR-vs-legacy difference behind a red that has
  // always been red. Fixing the `undefined` binding is a separate change to
  // BOTH front-ends.
  it("a missing leaf binds the element ZERO on both front-ends (Node says undefined)", async () => {
    const src = `export function main(): number {
      const rows: number[][] = [[1], [2, 3]];
      let s = 0;
      for (const [a, b] of rows) { s += b === undefined ? 100 : b; }
      return s;
    }`;
    const js = src.replace("export function main(): number", "function main()").replace(/:\s*number(\[\])*/g, "");
    expect(new Function(`${js}; return main();`)()).toBe(103); // Node
    await expect(runMain(src)).resolves.toBe(3); // js2wasm, both front-ends
  });
});

// ---------------------------------------------------------------------------
// C. The CARRIER — the thing that was the blocker.
//
// A destructuring head needs the for-of ELEMENT to be an indexable vec. These
// assertions used to record that no such carrier existed; #5166 built it, so
// they now record the positive: a vec whose element is a vec resolves, and the
// unit emits an IR body.
// ---------------------------------------------------------------------------

describe("#4470 C — a vec whose element is a vec is representable (#5166)", () => {
  it("number[][] resolves through the concrete-ref element carrier and EMITS", async () => {
    // Layer 1 was `resolvePositionType`'s `T[]` arm: it accepted an element
    // resolving to f64/i32 (-> irVec) or string/dynamic (-> externref), and a
    // `number[]` element resolves to `irVec(f64)` — kind "vec" — which matched
    // neither, so the claim was withdrawn during preparation. It now registers
    // the inner physical vec and feeds `{ ref_null, typeIdx }` into the same
    // `ref_<idx>` element path `string[][]` already used, which is exactly the
    // carrier legacy `resolveWasmType` produces.
    const { result, outcome } = await outcomeForF(`
      function f(rows: number[][]): number {
        let s = 0;
        for (const r of rows) { s += r[0]; }
        return s;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
  });

  it("the array-pattern head over a number[][] claims AND emits", async () => {
    const { result, outcome } = await outcomeForF(`
      function f(rows: number[][]): number {
        let s = 0;
        for (const [a, b] of rows) { s += a * 10 + b; }
        return s;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
  });

  it("depth-3 number[][][] resolves too (the carrier recurses)", async () => {
    const { result, outcome } = await outcomeForF(`
      function f(cube: number[][][]): number { return cube[0][1][0]; }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
  });

  it("an OBJECT element type still withdraws softly (out of #5166 scope)", async () => {
    const { result, outcome } = await outcomeForF(`
      function f(rows: { v: number }[][]): number {
        let n = 0;
        for (const r of rows) { n = n + 1; }
        return n;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
      stage: "resolve",
      irBodyEmitted: false,
      legacyBodyEmitted: true,
    });
  });

  it("a flat number[] for-of DOES claim and emit an IR body (the control)", async () => {
    const { result, outcome } = await outcomeForF(`
      function f(xs: number[]): number {
        let s = 0;
        for (const x of xs) { s += x; }
        return s;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
  });

  it("the var-decl array pattern over a flat number[] claims (the lowering #4470 would reuse)", async () => {
    // `lowerArrayPattern` is exactly the lowering a for-of destructuring head
    // would reuse — one `vec.get` per leaf. It works; it just needs a vec to
    // read from, which the for-of element is not.
    const { result, outcome } = await outcomeForF(`
      function f(xs: number[]): number { const [a, b] = xs; return a + b; }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true, legacyBodyEmitted: false });
  });

  it("a plain for-of over a string[][] param EMITS (#4486 -> #5166: invariant -> demote -> emit)", async () => {
    // Layer 2, and this one was never caused by #4470 — it reproduced with a
    // plain IDENTIFIER head and no selector change at all. `string[][]` got
    // past layer 1 (its inner `string[]` resolves to a `ref_null
    // $vec_externref`, a `val`), so the function WAS claimed; the logical type
    // is then `vec<vec<externref>>`, which prepared-vector-support.ts refused.
    //
    // Three states, in order: untyped `invariant` (a HARD compile error, even
    // though a working legacy body had been emitted) -> typed
    // `type-resolution-unsupported`@resolve demote (#4486) -> emitted, once
    // #5166 taught the element allowlist about a nested vec.
    //
    // The `string[][]` STRUCTURE is what emits — iterating rows, reading
    // `.length`, indexing to a leaf. Pattern HEADS over a string row are still
    // excluded (the externref string leaf's own ops are a separate gap), and
    // they demote softly, never invariant.
    const { result, outcome } = await outcomeForF(`
      function f(rows: string[][]): number {
        let n = 0;
        for (const r of rows) { n = n + 1; }
        return n;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
  });

  it("a pattern head over a string[][] row demotes SOFTLY, never invariant", async () => {
    const { result, outcome } = await outcomeForF(`
      function f(rows: string[][]): string {
        let t = "";
        for (const [a, b] of rows) { t = t + a; }
        return t;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({
      kind: "unsupported",
      code: "array-representation-unsupported",
      irBodyEmitted: false,
      legacyBodyEmitted: true,
    });
  });
});
