// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7108 — `Array.prototype.indexOf` / `includes` / `join` on a number or
// string vec lower through the IR instead of rejecting the unit with
// `select:array-method-unsupported`. Every case runs the same source under
// node and compares, on the host-free standalone lane and the WasmGC host lane.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Target = "standalone" | "gc";
const TARGETS: readonly Target[] = ["standalone", "gc"];

async function compileFor(source: string, target: Target, js = false) {
  const result = await compile(source, {
    target,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    fileName: js ? "issue-7108.js" : "issue-7108.ts",
    ...(js ? { allowJs: true } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

/** Evaluate every exported zero-argument function under node. */
function nodeExports(source: string): Record<string, () => unknown> {
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exportsObject: Record<string, () => unknown> = {};
  new Function("exports", js)(exportsObject);
  return exportsObject;
}

async function expectMatchesNode(source: string, target: Target, irUnits: readonly string[], js = false) {
  const result = await compileFor(source, target, js);
  for (const unit of irUnits) {
    expect(result.irCompiledFuncs ?? [], `${unit} should be IR-emitted on ${target}`).toContain(unit);
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    target === "standalone" ? {} : (result.importObject as WebAssembly.Imports),
  );
  const expected = nodeExports(source);
  for (const [name, fn] of Object.entries(expected)) {
    const exported = instance.exports[name] as () => unknown;
    expect(exported(), `${name} on ${target}`).toBe(fn());
  }
}

function unitOutcome(result: Awaited<ReturnType<typeof compile>>, name: string) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === name);
}

const NUMBER_SEARCH = `
function idx(xs: number[], v: number): number { return xs.indexOf(v); }
function has(xs: number[], v: number): boolean { return xs.includes(v); }
export function searchNumbers(): number {
  const xs = [3, 1.5, -0, NaN, 7, 1.5];
  let r = 0;
  if (idx(xs, 1.5) === 1) r += 1;    // first match wins
  if (idx(xs, 0) === 2) r += 2;      // -0 === +0
  if (idx(xs, NaN) === -1) r += 4;   // IsStrictlyEqual: NaN never found
  if (idx(xs, 9) === -1) r += 8;
  if (has(xs, NaN)) r += 16;         // SameValueZero: NaN found
  if (has(xs, 0)) r += 32;
  if (!has(xs, 2)) r += 64;
  if (idx([], 1) === -1) r += 128;
  return r;
}
`;

const STRING_SEARCH_JOIN = `
export function strings(): number {
  const xs = ["a", "bc", "", "bc"];
  let r = 0;
  if (xs.indexOf("bc") === 1) r += 1;
  if (xs.indexOf("") === 2) r += 2;
  if (xs.indexOf("z") === -1) r += 4;
  if (xs.includes("a")) r += 8;
  if (!xs.includes("A")) r += 16;
  if (xs.join() === "a,bc,,bc") r += 32;
  if (["p", "q"].join("") === "pq") r += 64;
  if (["only"].join(", ") === "only") r += 128;
  return r;
}
`;

const NUMBER_JOIN = `
function jn(xs: number[], sep: string): string { return xs.join(sep); }
export function joinNumbers(): number {
  let r = 0;
  if (jn([1, 2.5, -0, NaN, 1e21, -3], "-") === "1-2.5-0-NaN-1e+21--3") r += 1;
  if (jn([], ",") === "") r += 2;
  if (jn([4], "::") === "4") r += 4;
  const ys = [10, 20];
  if (ys.join() === "10,20") r += 8;
  return r;
}
`;

// The caller is legacy-owned (array-literal elisions), so the IR scan sees
// legacy's f64 \`undefined\` / absence markers.
const LEGACY_HOLES = `
function has(xs: number[], v: number): boolean { return xs.includes(v); }
function idx(xs: number[], v: number): number { return xs.indexOf(v); }
function jn(xs: number[]): string { return xs.join("-"); }
export function holes(): number {
  const h = [1, , NaN, 3] as number[];
  let r = 0;
  if (has(h, NaN)) r += 1;
  if (idx(h, 3) === 3) r += 2;
  if (jn(h) === "1--NaN-3") r += 4;
  const u = [1, undefined, 2] as number[];
  if (jn(u) === "1--2") r += 8;
  if (!has([undefined as unknown as number], NaN)) r += 16;
  return r;
}
`;

// An empty literal whose element type is closed by pushes: the read-only
// methods must not count as an escape of the inferred vector.
const INFERRED_EMPTY = `
export function counted() {
  const xs = [];
  for (let i = 0; i < 5; i++) xs.push(i * 2);
  let r = 0;
  if (xs.indexOf(6) === 3) r += 1;
  if (xs.join("") === "02468") r += 2;
  if (xs.includes(8)) r += 4;
  return r;
}
`;

// An int32-narrowed vector (#3734) is searched in the f64 domain, so a
// fractional or out-of-range needle never matches a truncated element.
const NARROWED = `
export function narrowed(): number {
  const values: number[] = [];
  for (let i = 0; i < 10; i++) values.push(i & 7);
  let r = 0;
  if (values.indexOf(1.5) === -1) r += 1;
  if (values.indexOf(2147483648) === -1) r += 2;
  if (values.indexOf(7) === 7) r += 4;
  if (!values.includes(NaN)) r += 8;
  if (values.join("") === "0123456701") r += 16;
  return r;
}
`;

describe("#7108 — IR indexOf / includes / join on number and string vecs", () => {
  for (const target of TARGETS) {
    it(`an int32-narrowed vec is searched in the f64 domain (${target})`, async () => {
      await expectMatchesNode(NARROWED, target, ["narrowed"]);
    });

    it(`number indexOf / includes match node (${target})`, async () => {
      await expectMatchesNode(NUMBER_SEARCH, target, ["idx", "has", "searchNumbers"]);
    });

    it(`string-literal search and join match node (${target})`, async () => {
      await expectMatchesNode(STRING_SEARCH_JOIN, target, ["strings"]);
    });

    it(`number join renders -0, NaN, exponents and empty arrays like node (${target})`, async () => {
      await expectMatchesNode(NUMBER_JOIN, target, ["jn", "joinNumbers"]);
    });

    it(`legacy undefined / hole markers keep node semantics (${target})`, async () => {
      await expectMatchesNode(LEGACY_HOLES, target, ["has", "idx", "jn"]);
    });

    it(`an inferred empty number array stays claimable (${target})`, async () => {
      await expectMatchesNode(INFERRED_EMPTY, target, ["counted"], true);
    });
  }

  it("refuses shapes outside the lowering before claiming them", async () => {
    const result = await compileFor(
      `
      function sparam(xs: string[], v: string): number { return xs.indexOf(v); }
      function from(xs: number[]): number { return xs.indexOf(1, 1); }
      function anyArr(xs: any[]): string { return xs.join(); }
      export function run(): number {
        return sparam(["a"], "a") + from([1, 1]) + anyArr([1]).length;
      }
      `,
      "standalone",
    );
    for (const name of ["sparam", "from", "anyArr"]) {
      const outcome = unitOutcome(result, name);
      expect(outcome?.kind, name).toBe("unsupported");
      expect(outcome && "stage" in outcome ? outcome.stage : undefined, name).toBe("select");
      expect(outcome && "code" in outcome ? outcome.code : undefined, name).toBe("array-method-unsupported");
    }
  });
});
