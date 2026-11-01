// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7066 — the IR lowers a string `+` beside a number or a boolean as the
// concatenation of each side's ToString, instead of refusing it. One `+` rule
// (`additiveOperandsProvable`) decides for the builder, the selector, planned
// closures and the IR-first gate; one ToString (`lowerPrimitiveToString`)
// serves `+`, template literals and `String(v)`. Every answer is checked
// against node's.
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { irFirstBodyIsProvenLowerable } from "../src/codegen/ir-first-gate.js";
import { compile } from "../src/index.js";
import { additiveOperandsProvable } from "../src/ir/analysis/operand-admissibility.js";

type Value = number | boolean | string;

/** A JS value spelled as a source expression (`NaN`, `-0` and the infinities need one). */
function spell(value: Value): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (Number.isNaN(value)) return "(0 / 0)";
  if (Object.is(value, -0)) return "(-0)";
  if (!Number.isFinite(value)) return value > 0 ? "(1 / 0)" : "(-1 / 0)";
  return value < 0 ? `(${value})` : String(value);
}

interface Case {
  readonly name: string;
  readonly source: string;
  /** The same function in JS, for node's answer. */
  readonly node: (...args: never[]) => string;
  readonly calls: readonly (readonly Value[])[];
}

const NUMBERS: readonly Value[] = [1, -2.5, -0, NaN, Infinity, -Infinity, 1e21, 0.1, 123456789, 5e-7];

const CASES: readonly Case[] = [
  {
    name: "string + number",
    source: 'export function f(n: number): string { return "v" + n; }',
    node: (n: number) => "v" + n,
    calls: NUMBERS.map((n) => [n]),
  },
  {
    name: "number + string",
    source: 'export function f(n: number): string { return n + "v"; }',
    node: (n: number) => n + "v",
    calls: NUMBERS.map((n) => [n]),
  },
  {
    name: "a chain that adds first",
    source: 'export function f(n: number, m: number): string { return n + m + "s" + n + m; }',
    node: (n: number, m: number) => n + m + "s" + n + m,
    calls: [
      [1, 2],
      [-0.5, 0.25],
    ],
  },
  {
    name: "booleans, branded and proven",
    source: 'export function f(b: boolean, n: number): string { return "v" + b + (n > 0) + (true + "x"); }',
    node: (b: boolean, n: number) => "v" + b + (n > 0) + (true + "x"),
    calls: [
      [false, 1],
      [true, -1],
    ],
  },
  {
    name: "a shift operand (the S11.7.*_A4 shape)",
    source: "export function f(n: number): string { return '#1: -1 << n === -1. Actual: ' + (-1 << n); }",
    node: (n: number) => "#1: -1 << n === -1. Actual: " + (-1 << n),
    calls: [[0], [16], [31]],
  },
  {
    name: "templates and String(v), on the same ToString",
    source: "export function f(n: number, b: boolean): string { return `t${n}${b}` + String(n) + String(b); }",
    node: (n: number, b: boolean) => `t${n}${b}` + String(n) + String(b),
    calls: [
      [-0, true],
      [1e21, false],
    ],
  },
];

function checkSource(c: Case): string {
  const checks = c.calls.map((args) => {
    const expected = (c.node as (...a: Value[]) => string)(...args);
    return `(f(${args.map(spell).join(", ")}) === ${JSON.stringify(expected)} ? 1 : 0)`;
  });
  return `${c.source}\nexport function c(): number { return ${checks.join(" + ")}; }`;
}

async function compileOn(source: string, target: "gc" | "standalone" | "wasi" | "linear") {
  return compile(source, {
    fileName: "issue-7066.ts",
    trackIrOutcomes: true,
    ...(target === "gc" ? {} : { target }),
  } as Parameters<typeof compile>[1]);
}

describe("#7066 mixed string `+` lowers through the IR", () => {
  for (const c of CASES) {
    for (const target of ["gc", "standalone", "wasi"] as const) {
      it(`${c.name}: claimed with no post-claim demote on ${target}`, async () => {
        const result = await compileOn(checkSource(c), target);
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect(result.irOutcomes?.find((outcome) => outcome.displayName === "f")?.irBodyEmitted).toBe(true);
      });
    }

    it(`${c.name}: answers as node does`, async () => {
      const result = await compileOn(checkSource(c), "standalone");
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      expect((instance.exports.c as () => number)()).toBe(c.calls.length);
    });
  }

  it("evaluates the operands left to right, once each", async () => {
    const source = [
      "let calls = 0;",
      "function g(): number { calls = calls * 10 + 1; return 1; }",
      'function h(): string { calls = calls * 10 + 2; return "x"; }',
      "export function f(): string { return g() + h() + calls; }",
      'export function c(): number { return f() === "1x12" ? 1 : 0; }',
    ].join("\n");
    const result = await compileOn(source, "standalone");
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    // node: g() then h(), so `calls` reads 12 when it is concatenated.
    expect((instance.exports.c as () => number)()).toBe(1);
  });

  it("compiles on the linear lane, which has no number formatter, with no post-claim demote", async () => {
    const result = await compileOn('export function f(n: number): string { return "v" + n; }', "linear");
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});

// Review round 2: beside a proven string, a mixed-primitive conditional is converted
// arm by arm, so the `+` result is a string a string slot, `.length` and a loop accept.
const MIXED: readonly (readonly [string, string, string])[] = [
  [
    "a string slot",
    'export function f(n: number): string { let s: string = "x"; s = "v" + (n > 0 ? "a" : 1); return s; }',
    // node: f(1) === "va", f(-1) === "v1".
    '(f(1) === "va" ? 1 : 0) + (f(-1) === "v1" ? 1 : 0)',
  ],
  [
    "its length",
    'export function f(n: number): number { const s = "v" + (n > 0 ? "abc" : 1); return s.length; }',
    // node: f(1) === 4, f(-1) === 2.
    "(f(1) === 4 ? 1 : 0) + (f(-1) === 2 ? 1 : 0)",
  ],
  [
    "a loop sum of lengths",
    'export function f(k: number): number { let c = 0; for (let i = 0; i < k; i++) { const s = "v" + (i > 1 ? "ab" : i); c = c + s.length; } return c; }',
    // node: f(4) === 10, f(0) === 0.
    "(f(4) === 10 ? 1 : 0) + (f(0) === 0 ? 1 : 0)",
  ],
  [
    "the conditional on the left",
    'export function f(n: number): string { return (n > 0 ? true : 7) + "w"; }',
    // node: f(1) === "truew", f(-1) === "7w".
    '(f(1) === "truew" ? 1 : 0) + (f(-1) === "7w" ? 1 : 0)',
  ],
];

describe("#7066 a mixed-primitive conditional beside a string stays a string", () => {
  for (const [name, fn, check] of MIXED) {
    for (const target of ["gc", "standalone", "wasi"] as const) {
      it(`${name}: lowers without a caller on ${target}`, async () => {
        const result = await compileOn(fn, target);
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect(result.irOutcomes?.find((outcome) => outcome.displayName === "f")?.irBodyEmitted).toBe(true);
      });
    }

    it(`${name}: answers as node does`, async () => {
      const result = await compileOn(`${fn}\nexport function c(): number { return ${check}; }`, "standalone");
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      expect((instance.exports.c as () => number)()).toBe(2);
    });
  }
});

describe("#7066 the one `+` rule", () => {
  it("concatenates a string with a string, a boolean, or a number where the lane formats numbers", () => {
    expect(additiveOperandsProvable("string", "number", true)).toBe(true);
    expect(additiveOperandsProvable("number", "string", false)).toBe(false);
    expect(additiveOperandsProvable("boolean", "string", false)).toBe(true);
    expect(additiveOperandsProvable("string", "unprovable", true)).toBe(false);
    expect(additiveOperandsProvable("number", "number", false)).toBe(true);
    expect(additiveOperandsProvable("boolean", "boolean", true)).toBe(false);
    expect(additiveOperandsProvable("boolean", "number", true)).toBe(false);
    expect(additiveOperandsProvable("dynamic", "unprovable", false)).toBe(true);
  });

  it("is the IR-first gate's `+` row", () => {
    const fn = (source: string) =>
      ts.createSourceFile("gate.ts", source, ts.ScriptTarget.ES2022, true).statements.find(ts.isFunctionDeclaration)!;
    const gate = (source: string, params: ("number" | "bool" | "string")[]) =>
      irFirstBodyIsProvenLowerable(fn(source), new Map(), params, "string");
    expect(gate('function f(n: number): string { return "v" + n; }', ["number"])).toBe(true);
    expect(gate('function f(b: boolean): string { return "v" + b; }', ["bool"])).toBe(true);
    expect(
      gate('function f(n: number, s: string): string { return "v" + (n > 0 ? s : 0); }', ["number", "string"]),
    ).toBe(true);
    expect(gate("function f(n: number, b: boolean): string { return n + b; }", ["number", "bool"])).toBe(false);
  });
});
