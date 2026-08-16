// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4470 — IR adoption of DESTRUCTURING for-of heads (`for (const [p, q] of …)`).
//
// The `ForOfStatement` row of plan/log/ir-adoption.md named the reject arm
// (`nontail-forof`, #3583) correctly, but the arm is not the constraint.
// Lifting it is a ~20-line selector change that works; what does NOT work is
// the LOWERING's precondition: a destructuring head's source is the for-of
// ELEMENT, so the element must itself be an indexable vec — and the IR cannot
// represent a vec whose element is a vec, at two independent layers:
//
//   1. `resolvePositionType` (src/codegen/index.ts ~L989) throws on a
//      `number[]` element (it resolves to `irVec`, which matches no arm).
//   2. `prepared-vector-support.ts` L70 accepts element ValTypes f64 / i32 /
//      externref only, so a `vec<vec<externref>>` (`string[][]`) is refused
//      there. That refusal was an untyped `invariant` — a HARD compile error —
//      until #4486 typed it as the same `type-resolution-unsupported`@resolve
//      withdrawal the `number[][]` sibling takes. The CARRIER is still
//      unrepresentable at both layers; only the blast radius changed.
//
// Measured with the arm lifted: two of five working `string[][]` programs
// became compile errors. So this file does NOT test an adoption. It pins the
// three things the next attempt needs so it starts from evidence:
//
//   A. the selector contract as it stands (which heads reject, and that the
//      identifier head with an otherwise identical body claims);
//   B. the runtime SEMANTICS of destructuring for-of heads on the current
//      (legacy) path — the contract any future adoption must preserve;
//   C. the CARRIER boundary itself. These are the assertions that flip when
//      someone fixes the nested-vec representation; when they do, they should
//      land the head change described in plan/issues/4470-*.md.

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

  // Every destructuring head rejects, and they all reject at the SAME arm
  // (`nontail-forof`, surfaced as the `body-shape-rejected` bucket). The point
  // of enumerating them is that lifting one arm would claim all of the simple
  // ones at once — see the carrier assertions in section C for why that is a
  // net negative today.
  const REJECTING_HEADS: Array<{ name: string; head: string; use: string }> = [
    { name: "array pattern [a, b]", head: "const [a, b]", use: "s += a + b;" },
    { name: "array pattern [a] (single leaf)", head: "const [a]", use: "s += a;" },
    { name: "array pattern [, b] (sparse hole)", head: "const [, b]", use: "s += b;" },
    { name: "array pattern with default [a = 1]", head: "const [a = 1]", use: "s += a;" },
    { name: "array pattern with rest [a, ...r]", head: "const [a, ...r]", use: "s += a + r.length;" },
    { name: "let-bound array pattern", head: "let [a, b]", use: "s += a + b;" },
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
  // rejected even under the prototype: the for-of element slot carries a `val`
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
      name: "missing element yields undefined, not a trap",
      src: `export function main(): number {
        const rows: number[][] = [[1], [2, 3]];
        let s = 0;
        for (const [a, b] of rows) { s += b === undefined ? 100 : b; }
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
});

// ---------------------------------------------------------------------------
// C. The CARRIER boundary — the actual blocker.
//
// A destructuring head needs the for-of ELEMENT to be an indexable vec. These
// assertions record that no such carrier exists. WHEN THEY FAIL, the carrier
// has been fixed and the head adoption becomes possible: see the "What would
// unblock this" section of plan/issues/4470-ir-forof-destructuring-head.md.
// ---------------------------------------------------------------------------

describe("#4470 C — a vec whose element is a vec has no IR representation", () => {
  it("number[][] is withdrawn at RESOLVE, not claimed as a vec-of-vec", async () => {
    // Layer 1: resolvePositionType's `T[]` arm accepts an element resolving to
    // f64/i32 (-> irVec) or string/dynamic (-> externref). A `number[]` element
    // resolves to `irVec(f64)` — kind "vec" — which matches neither, so the
    // claim is withdrawn during preparation. This is a SOFT demote: the legacy
    // body still ships, so the program compiles and runs.
    const { result, outcome } = await outcomeForF(`
      function f(rows: number[][]): number {
        let s = 0;
        for (const r of rows) { s += r[0]; }
        return s;
      }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome?.kind).toBe("unsupported");
    expect(outcome).toMatchObject({
      stage: "resolve",
      code: "type-resolution-unsupported",
      irBodyEmitted: false,
      legacyBodyEmitted: true,
    });
    expect(String((outcome as { detail?: string }).detail)).toContain("array element TypeNode ArrayType");
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

  it("a plain for-of over a string[][] param DEMOTES cleanly (#4486 — was a hard error)", async () => {
    // Layer 2, and this one is NOT caused by #4470 — it reproduces with a
    // plain IDENTIFIER head and no selector change at all. `string[][]` gets
    // past layer 1 (its inner `string[]` resolves to a `ref_null
    // $vec_externref`, a `val`), so the function IS claimed; the logical type
    // is then `vec<vec<externref>>`, which prepared-vector-support.ts refuses.
    //
    // Until #4486 that refusal was an untyped `invariant`, which HARD-FAILED
    // the build instead of demoting to the working legacy body. It is now the
    // same typed `unsupported` / `type-resolution-unsupported`@resolve
    // withdrawal the `number[][]` sibling above already took — the carrier is
    // still unrepresentable (`irBodyEmitted: false`), it just no longer takes
    // the program down with it.
    //
    // The assertion that flips NEXT is `irBodyEmitted`: when someone adopts
    // nested-vec carriers, this unit stops demoting and emits. See #4470's
    // unblock section — that is the same fix that makes the destructuring
    // head adoptable.
    const { result, outcome } = await outcomeForF(`
      function f(rows: string[][]): number {
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
    expect(String((outcome as { detail?: string }).detail)).toContain("prepared vec element");
  });
});
