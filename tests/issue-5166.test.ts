// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5166 — the nested-vec ELEMENT CARRIER. A vec whose element is a vec.
//
// Before this, `number[][]` could not claim anywhere in the IR: the outer
// array's element resolved to a LOGICAL `irVec`, which matched no element
// ValType arm in `resolvePositionType`, so the claim was withdrawn at
// `resolve`. `string[][]` got one gate further (its inner `string[]` is
// already a physical `ref_null $vec_externref`) and then died in the prepared-
// vector element allowlist — as a hard `invariant` until #4486 typed it.
//
// The fix mirrors LEGACY's own carrier rather than inventing one: legacy
// `resolveWasmType` recurses, so a `number[][]` is a vec of CONCRETE refs —
// outer `__vec_ref_<inner>` whose Wasm array element is `(ref null $__vec_f64)`
// — with no anyref and no cast-on-get. `resolvePositionType` now registers the
// inner physical vec and hands its `ref_null` to the `ref_<idx>` element path
// that `string[][]` already used, and `prepared-vector-support.ts` accepts a
// nested element the way it accepts a native-string one.
//
// Two smaller gaps had to move with it, both of which were untyped `Error`s,
// i.e. HARD compile errors on an otherwise fully lowerable claim:
//
//   * `vectorLogicalOrdinal` had a four-entry switch, so `vec<vec<f64>?>` had
//     "no stable Program ABI order". The ordinal is now a pure structural
//     function of the key (depth-major, leaf-minor), which keeps the depth-1
//     ordinals — and therefore every existing module's bytes — unchanged.
//   * `emitNull` answers on ValTypes, but preparation maps a physical vec ref
//     BACK to a logical `IrType.vec`, so the out-of-bounds arm of a nested-vec
//     read arrived as `vec`. `const null` now resolves a `vec` result type to
//     its physical carrier before it reaches the backend.
//
// The bar throughout is OBSERVATIONAL EQUIVALENCE WITH LEGACY, not with Node:
// where the two already disagree (an out-of-range row is `null` rather than
// `undefined`) the IR must reproduce LEGACY, because the claim replaces a
// legacy body in a program whose other functions still use it.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function outcomeFor(source: string, name = "f") {
  const r = await compile(source, { fileName: "issue-5166.ts", experimentalIR: true, trackIrOutcomes: true });
  return { result: r, outcome: r.irOutcomes?.find((o) => o.displayName === name) };
}

/** Compile, instantiate, call `main` — `experimentalIR: false` forces legacy. */
async function runMain(source: string, ir: boolean): Promise<unknown> {
  const r = await compile(source, { fileName: "issue-5166.ts", experimentalIR: ir });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).main!();
}

// ---------------------------------------------------------------------------
// A. The carrier claims and emits.
// ---------------------------------------------------------------------------

describe("#5166 A — nested-vec positions resolve and emit", () => {
  const SHAPES: Array<{ name: string; src: string }> = [
    {
      name: "identifier-head for-of over a number[][] param",
      src: `function f(m: number[][]): number { let n = 0; for (const row of m) { n = n + row.length; } return n; }`,
    },
    { name: "a leaf read m[0][1]", src: `function f(m: number[][]): number { return m[0][1]; }` },
    { name: "row.length", src: `function f(m: number[][]): number { const r = m[1]; return r.length; }` },
    { name: "number[][] in RETURN position", src: `function f(m: number[][]): number[][] { return m; }` },
    { name: "depth-3 number[][][]", src: `function f(m: number[][][]): number { return m[0][1][0]; }` },
    {
      name: "Array<Array<number>> (the Array<T> twin arm)",
      src: `function f(m: Array<Array<number>>): number { return m[1][0]; }`,
    },
    { name: "boolean[][] (i32 leaf)", src: `function f(m: boolean[][]): boolean { return m[0][1]; }` },
    {
      name: "a pass-through T[][] function (param -> return, no vec ops)",
      src: `function f(m: number[][]): number[][] { return m; }`,
    },
  ];

  for (const c of SHAPES) {
    it(`${c.name} emits an IR body`, async () => {
      const { result, outcome } = await outcomeFor(`${c.src}\nexport function main(): number { return 0; }`);
      expect(result.success).toBe(true);
      expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    });
  }

  // Acceptance criterion 2. `string[][]` structure-only was the #4486 repro; it
  // must never be an invariant again, whatever else changes. It emits today.
  it("string[][] structure-only stays SOFT — and in fact emits", async () => {
    const { result, outcome } = await outcomeFor(`
      function f(rows: string[][]): number { let n = 0; for (const r of rows) { n = n + 1; } return n; }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome?.kind).not.toBe("invariant");
    expect(outcome).toMatchObject({ kind: "emitted", irBodyEmitted: true });
  });

  // Out of scope, documented as follow-ups in plan/issues/5166-*.md. Each must
  // be a SOFT withdrawal — a capability gap, never a producer-promise
  // violation — so the legacy body keeps the program compiling.
  const SOFT_RESIDUALS: Array<{ name: string; src: string; subject: string }> = [
    {
      name: "an OBJECT element type ({ v: number }[][])",
      src: `function f(m: { v: number }[][]): number { let n = 0; for (const r of m) { n = n + 1; } return n; }`,
      subject: "f",
    },
    {
      name: "a TUPLE element type ([number, number][])",
      src: `function f(m: [number, number][]): number { let n = 0; for (const r of m) { n = n + 1; } return n; }`,
      subject: "f",
    },
    {
      name: "the LOCAL number[][] annotation arm (vardecl-typenode)",
      src: `function f(): number { const m: number[][] = [[1, 2], [3, 4]]; return m[1][0]; }`,
      subject: "f",
    },
  ];

  for (const c of SOFT_RESIDUALS) {
    it(`${c.name} withdraws SOFTLY (never an invariant)`, async () => {
      const { result, outcome } = await outcomeFor(`${c.src}\nexport function main(): number { return 0; }`, c.subject);
      expect(result.success).toBe(true);
      expect(outcome).toMatchObject({ kind: "unsupported", irBodyEmitted: false, legacyBodyEmitted: true });
    });
  }
});

// ---------------------------------------------------------------------------
// B/C. Differential: the IR body computes what the legacy body computed.
//
// Every program is compiled twice from the SAME source — once with the IR
// overlay on, once forced to legacy — instantiated, and run in-process. The
// `node` column is recorded where it agrees; where it does not, the divergence
// is pre-existing on the legacy path and the row says so.
// ---------------------------------------------------------------------------

const DIFFERENTIAL: Array<{ name: string; src: string; expected: unknown; nodeDiffers?: string }> = [
  {
    name: "for-of rows, summing inner lengths",
    src: `function f(m: number[][]): number { let n = 0; for (const row of m) { n = n + row.length; } return n; }
          export function main(): number { return f([[1, 2], [3, 4, 5]]); }`,
    expected: 5,
  },
  {
    name: "m[0][1]",
    src: `function f(m: number[][]): number { return m[0][1]; }
          export function main(): number { return f([[1, 2], [3, 4]]); }`,
    expected: 2,
  },
  {
    name: "nested for-of over both levels",
    src: `function f(m: number[][]): number { let s = 0; for (const r of m) { for (const v of r) { s = s + v; } } return s; }
          export function main(): number { return f([[1, 2], [3], [4, 5, 6]]); }`,
    expected: 21,
  },
  {
    name: "depth-3 m[0][1][0]",
    src: `function f(m: number[][][]): number { return m[0][1][0]; }
          export function main(): number { return f([[[1], [9]]]); }`,
    expected: 9,
  },
  {
    name: "return position, then index the result",
    src: `function f(m: number[][]): number[][] { return m; }
          export function main(): number { return f([[7, 8]])[0][1]; }`,
    expected: 8,
  },
  {
    name: "pass-through claim + caller (ABI parity with the legacy caller)",
    src: `function f(m: number[][]): number[][] { return m; }
          export function g(m: number[][]): number { return f(m)[0][0]; }
          export function main(): number { return g([[5]]); }`,
    expected: 5,
  },
  {
    name: "index loop over both levels",
    src: `function f(m: number[][]): number {
            let s = 0;
            for (let i = 0; i < m.length; i = i + 1) { for (let j = 0; j < m[i].length; j = j + 1) { s = s + m[i][j]; } }
            return s;
          }
          export function main(): number { return f([[1, 2], [3, 4, 5]]); }`,
    expected: 15,
  },
  {
    name: "string[][] two-level concat",
    src: `function f(m: string[][]): string { let s = ""; for (const r of m) { for (const c of r) { s = s + c; } } return s; }
          export function main(): string { return f([["a", "b"], ["c"], ["d", "e"]]); }`,
    expected: "abcde",
  },
  {
    name: "string[][] indexed leaf",
    src: `function f(m: string[][]): string { return m[1][0]; }
          export function main(): string { return f([["a"], ["c", "d"]]); }`,
    expected: "c",
  },
  {
    name: "Uint8Array[] inner length",
    src: `function f(m: Uint8Array[]): number { let n = 0; for (const r of m) { n = n + r.length; } return n; }
          export function main(): number { const a = new Uint8Array(2); const b = new Uint8Array(3); return f([a, b]); }`,
    expected: 5,
  },
  // --- out-of-bounds (S2) ---------------------------------------------------
  {
    name: "OOB leaf read m[0][9] is NaN on both front-ends",
    src: `function f(m: number[][]): number { return m[0][9]; }
          export function main(): number { return f([[1, 2]]); }`,
    expected: Number.NaN,
    nodeDiffers: "node binds undefined; in a `number` return both front-ends coerce it to NaN",
  },
  {
    name: "…and the NaN is observable inside the function too",
    src: `function f(m: number[][]): boolean { const v = m[0][9]; return v !== v; }
          export function main(): boolean { return f([[1, 2]]); }`,
    expected: 1,
    nodeDiffers: "node: `undefined !== undefined` is false; 0/1 is the boolean export ABI",
  },
  {
    name: "OOB ROW read m[5] compared loosely",
    src: `function f(m: number[][]): boolean { return m[5] == null; }
          export function main(): boolean { return f([[1]]); }`,
    expected: 1,
  },
  {
    name: "an empty inner row contributes nothing",
    src: `function f(m: number[][]): number { let n = 0; for (const r of m) { n = n + r.length; } return n; }
          export function main(): number { return f([[1, 2], [], [3]]); }`,
    expected: 3,
  },
];

describe("#5166 B/C — IR bodies are observationally identical to the legacy bodies", () => {
  for (const c of DIFFERENTIAL) {
    it(c.name, async () => {
      const legacy = await runMain(c.src, false);
      const withIr = await runMain(c.src, true);
      expect(withIr).toStrictEqual(legacy);
      expect(withIr).toStrictEqual(c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// D. Destructuring for-of heads (#4470), unblocked by the carrier.
// ---------------------------------------------------------------------------

describe("#5166 D — array-pattern for-of heads (#4470)", () => {
  const HEADS: Array<{ name: string; src: string; expected: number; emits: boolean }> = [
    {
      name: "[a, b] binds both leaves per iteration",
      src: `function f(m: number[][]): number { let s = 0; for (const [a, b] of m) { s = s + a * 10 + b; } return s; }
            export function main(): number { return f([[1, 2], [3, 4], [5, 6]]); }`,
      expected: 102,
      emits: true,
    },
    {
      name: "[, b] skips index 0",
      src: `function f(m: number[][]): number { let s = 0; for (const [, b] of m) { s = s + b; } return s; }
            export function main(): number { return f([[1, 2], [3, 4]]); }`,
      expected: 6,
      emits: true,
    },
    {
      name: "a let head is assignable inside the body (leaves are SLOTS)",
      src: `function f(m: number[][]): number { let s = 0; for (let [a, b] of m) { a = a + 1; s = s + a * 10 + b; } return s; }
            export function main(): number { return f([[1, 2], [3, 4]]); }`,
      expected: 66,
      emits: true,
    },
    {
      name: "break and continue in a pattern-head body",
      src: `function f(m: number[][]): number {
              let s = 0;
              for (const [a, b] of m) { if (a === 9) { break; } if (a === 0) { continue; } s = s + a * b; }
              return s;
            }
            export function main(): number { return f([[0, 5], [2, 3], [9, 0], [4, 4]]); }`,
      expected: 6,
      emits: true,
    },
    {
      name: "boolean[][] leaves",
      src: `function f(m: boolean[][]): number { let n = 0; for (const [a, b] of m) { if (a) { n = n + 1; } if (b) { n = n + 10; } } return n; }
            export function main(): number { return f([[true, false], [true, true]]); }`,
      expected: 12,
      emits: true,
    },
    {
      name: "an empty iterable runs the body zero times",
      src: `function f(m: number[][]): number { let s = 0; for (const [a, b] of m) { s = s + a + b; } return s; }
            export function main(): number { return f([]); }`,
      expected: 0,
      emits: true,
    },
    {
      name: "a SHORT row: the missing leaf is the element zero, exactly as legacy",
      src: `function f(m: number[][]): number { let s = 0; for (const [a, b] of m) { s = s + b; } return s; }
            export function main(): number { return f([[1], [2, 3]]); }`,
      expected: 3,
      emits: true,
    },
    // Residuals — each demotes, so the legacy body keeps answering.
    {
      name: "a default in the head ([a = 1]) still rejects at select",
      src: `function f(m: number[][]): number { let s = 0; for (const [a = 1] of m) { s = s + a; } return s; }
            export function main(): number { return f([[5], [6]]); }`,
      expected: 11,
      emits: false,
    },
    {
      name: "a rest element ([a, ...r]) still rejects at select",
      src: `function f(m: number[][]): number { let s = 0; for (const [a, ...r] of m) { s = s + a + r.length; } return s; }
            export function main(): number { return f([[1, 2, 3]]); }`,
      expected: 3,
      emits: false,
    },
    {
      name: "a string row leaf is excluded from the head lift (soft demote)",
      src: `function f(m: string[][]): number { let n = 0; for (const [a, b] of m) { n = n + 1; } return n; }
            export function main(): number { return f([["x", "y"], ["z", "w"]]); }`,
      expected: 2,
      emits: false,
    },
  ];

  for (const c of HEADS) {
    it(c.name, async () => {
      const { result, outcome } = await outcomeFor(c.src);
      expect(result.success).toBe(true);
      expect(outcome?.irBodyEmitted === true).toBe(c.emits);
      // The value is the point: claimed or demoted, both front-ends agree.
      expect(await runMain(c.src, true)).toStrictEqual(await runMain(c.src, false));
      expect(await runMain(c.src, true)).toStrictEqual(c.expected);
    });
  }

  // A pattern head is only lowerable on the vec arm — a `(ref $AnyString)` char
  // and an opaque iter-host externref are not indexable.
  it("a pattern head over a flat number[] (non-indexable leaf) demotes softly", async () => {
    const { result, outcome } = await outcomeFor(`
      function f(xs: number[]): number { let s = 0; for (const [a] of xs) { s = s + a; } return s; }
      export function main(): number { return 0; }
    `);
    expect(result.success).toBe(true);
    expect(outcome).toMatchObject({ kind: "unsupported", irBodyEmitted: false, legacyBodyEmitted: true });
  });
});

// ---------------------------------------------------------------------------
// E. Layout identity (the constraint the plan flagged as VERIFY, don't trust).
//
// `vec-layout.ts` throws "IR vec type already carries a different prepared
// layout" if one logical vec type is ever observed with two physical layouts.
// `ProgramAbiTypeRegistry.prepareVectorLayout` canonicalizes by LOGICAL KEY and
// raises `logical vector … was observed with two physical layouts` otherwise,
// so multiple independent producers of the same nesting must converge on one
// carrier. Compiling several of them in one module is the check.
// ---------------------------------------------------------------------------

describe("#5166 E — one logical nesting, one physical layout", () => {
  it("many independent number[][] producers/consumers share one carrier", async () => {
    const src = `
      function a(m: number[][]): number { return m[0][0]; }
      function b(m: number[][]): number[][] { return m; }
      function c(m: Array<Array<number>>): number { return m[0][1]; }
      function d(m: number[][]): number { let s = 0; for (const r of m) { s = s + r.length; } return s; }
      function e(m: number[][][]): number { return m[0][0][0]; }
      export function main(): number {
        const m: number[][] = [[1, 2], [3, 4]];
        return a(m) + b(m)[1][0] + c(m) + d(m) + e([[[10]]]);
      }
    `;
    expect(await runMain(src, true)).toStrictEqual(await runMain(src, false));
    expect(await runMain(src, true)).toBe(1 + 3 + 2 + 4 + 10);
  });
});

// ---------------------------------------------------------------------------
// F. #3577's repro — closed done-by-other-means, pinned so it cannot rot.
//
// `[1, 2, 3].flatMap(e => [[e * 2]])` produced a host externref whose elements
// are plain JS sub-arrays; the naked `ref.cast_null` in `buildElemCoerce`
// trapped ("illegal cast"). The mechanism that actually landed is
// `buildElemCoerce` RECURSING through `buildVecFromExternref` behind a cycle
// guard — not the element-materializer reserve pass #3577 sketched.
// ---------------------------------------------------------------------------

describe("#5166 F — #3577's flatMap depth-always-one repro (closed by other means)", () => {
  it("nested flatMap results materialize instead of trapping", async () => {
    const src = `export function main(): string {
      const r = [1, 2, 3].flatMap(e => [[e * 2]]);
      return "" + r[0][0] + r[1][0] + r[2][0];
    }`;
    expect(await runMain(src, false)).toBe("246");
    expect(await runMain(src, true)).toBe("246");
  });
});
