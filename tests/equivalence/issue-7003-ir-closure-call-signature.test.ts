// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7003 — IR `closure.call` casts the closure's funcref to the EXACT Wasm func
// type of the parameter's annotation. TypeScript lets a caller fill
// `f: (x: number) => number` with a function of another Wasm signature
// (`function h(x: number, y: number = 5)`, `(x, y?) => …`, a one-parameter
// function in a two-parameter slot, a value-returning function in a `void`
// slot), so an IR-claimed `apply` trapped `illegal cast` where legacy (its
// `ref.test` arity cascade) returned the right value. The selector now refuses
// such a unit (`closure-signature-mismatch`) and it keeps its legacy body; an
// exactly-fed callable parameter stays IR.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc (default)", options: {} },
];

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7003.ts", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance = options.target
    ? (await WebAssembly.instantiate(result.binary, {})).instance
    : await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return { result, value: exports.test!() };
}

function outcomeOf(result: Awaited<ReturnType<typeof compile>>, name: string) {
  return result.irOutcomes?.find((o) => o.displayName === name);
}

const APPLY = `function apply(f: (x: number) => number): number { return f(1); }\n`;

/** Each case: the source, and the IR units that must refuse the claim. */
const CASES: Record<string, { source: string; refused: string[] }> = {
  "default-parameter function declaration (the audit repro)": {
    source: `${APPLY}function h(x: number, y: number = 5): number { return x + y; }
export function test(): number { return apply(h); }`,
    refused: ["apply"],
  },
  "optional-parameter function declaration": {
    source: `${APPLY}function h2(x: number, y?: number): number { return x + (y === undefined ? 5 : y); }
export function test(): number { return apply(h2); }`,
    refused: ["apply"],
  },
  "inline arrow with an optional parameter": {
    source: `${APPLY}export function test(): number { return apply((x, y?) => x + (y === undefined ? 5 : y)); }`,
    refused: ["apply"],
  },
  "one-parameter function in a two-parameter slot": {
    source: `function apply2(f: (x: number, y: number) => number): number { return f(1, 2); }
function one(x: number): number { return x * 10; }
export function test(): number { return apply2(one); }`,
    refused: ["apply2"],
  },
  "value-returning function in a void slot": {
    source: `let c = 0;
function run(f: (x: number) => void): number { f(1); return c; }
function g(x: number): number { c = x + 1; return 7; }
export function test(): number { return run(g); }`,
    refused: ["run"],
  },
  "mismatch forwarded through a same-signature callable parameter": {
    source: `function inner(f: (x: number) => number): number { return f(1); }
function outer(f: (x: number) => number): number { return inner(f); }
function h(x: number, y: number = 5): number { return x + y; }
export function test(): number { return outer(h); }`,
    refused: ["inner", "outer"],
  },
};

// Legacy-path gaps, not IR ones: these units are legacy on every lane after
// the refusal (and were before it on standalone, where `apply` was never
// claimed). The standalone legacy closure call has no host fallback for a
// closure whose arity exceeds the call's, so it throws. Frozen direct-AST
// path — recorded in plan/issues/7003-*.md, not fixed here.
const LEGACY_GAPS = new Set([
  "default-parameter function declaration (the audit repro) — standalone",
  "inline arrow with an optional parameter — standalone",
  "mismatch forwarded through a same-signature callable parameter — standalone",
]);

describe("#7003 IR closure calls never trust the annotation as the callee's exact func type", () => {
  for (const [label, { source }] of Object.entries(CASES)) {
    for (const lane of LANES) {
      const name = `${label} — ${lane.name}`;
      (LEGACY_GAPS.has(name) ? it.fails : it)(
        name,
        async () => {
          const expected = evaluateAsJs(source).test!();
          const { value } = await compileAndRun(source, lane.options);
          expect(value).toBe(expected);
        },
        120_000,
      );
    }
  }

  for (const [label, { source, refused }] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} — the callable-parameter unit is refused (${lane.name})`, async () => {
        const result = await compile(source, { fileName: "issue-7003.ts", trackIrOutcomes: true, ...lane.options });
        expect(result.success).toBe(true);
        for (const unit of refused) {
          expect(outcomeOf(result, unit)).toMatchObject({ kind: "unsupported", code: "closure-signature-mismatch" });
        }
      }, 120_000);
    }
  }

  it("negative control: an exactly-fed callable parameter keeps the IR claim (gc)", async () => {
    const source = `${APPLY}function h(x: number): number { return x + 5; }
const g = (x: number): number => x * 2;
export function test(): number { return apply(h) * 100 + apply(g) + apply((x) => x + 1); }`;
    const { result, value } = await compileAndRun(source, {});
    expect(value).toBe(evaluateAsJs(source).test!());
    expect(outcomeOf(result, "apply")?.kind).toBe("emitted");
  }, 120_000);

  it("a value reference to the callable-parameter function makes its slot untraceable", async () => {
    const source = `${APPLY}function h(x: number): number { return x + 5; }
const alias = apply;
export function test(): number { return alias(h); }`;
    const { result, value } = await compileAndRun(source, {});
    expect(value).toBe(evaluateAsJs(source).test!());
    expect(outcomeOf(result, "apply")).toMatchObject({ kind: "unsupported", code: "closure-signature-mismatch" });
  }, 120_000);
});
