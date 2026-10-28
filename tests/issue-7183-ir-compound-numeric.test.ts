// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7183 — `%=`, `**=` and the bitwise compound assignments on number slots.
// `x op= v` lowers as `x = x op v` through the same `emitNumberBinary` the
// binary operator uses, so each operator must be IR-claimed in every compound
// position (top-level statement, loop body, `for` update, member target) with
// zero post-claim errors, and agree with node on the ToInt32 / remainder /
// exponentiation edges.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";

const LANES = ["standalone", "gc"] as const;
type Lane = (typeof LANES)[number];

const OPERATORS = ["%", "**", "&", "|", "^", "<<", ">>", ">>>"] as const;
type Operator = (typeof OPERATORS)[number];

// ToInt32 wraps (2**32 + 5, 2**31), negative and >= 32 shift counts, a negative
// `>>>` operand, fractions, NaN / Infinity (ToInt32 → 0).
const INT32_EDGES: readonly (readonly [number, number])[] = [
  [2 ** 32 + 5, 0],
  [2 ** 31, 1],
  [-1, 31],
  [5, -1],
  [-5, 1],
  [-5, 0],
  [1, 32],
  [1, 33],
  [7.9, 1.5],
  [-7.9, 2],
  [NaN, 3],
  [Infinity, 1],
  [3, NaN],
  [-(2 ** 53), 4],
];
// Signs, fractions, a zero divisor, -0, NaN, Infinity, and operands outside the
// i64 fast path's range (the exact `__fmod` fallback).
const REMAINDER_EDGES: readonly (readonly [number, number])[] = [
  [17, 5],
  [-17, 5],
  [17, -5],
  [5.5, 2],
  [-5.5, 2],
  [7, 0],
  [0, 7],
  [-0, 7],
  [NaN, 3],
  [3, NaN],
  [Infinity, 3],
  [7, Infinity],
  [-7, -Infinity],
  [2 ** 53, 3],
  [-(2 ** 63), -1],
  [1e300, 7],
];
// The special values Number::exponentiate defines exactly, plus exactly
// representable normal results. Other results are implementation-approximated,
// and the shared `math.pow` provider rounds them exactly as the binary `**` and
// `Math.pow` do (`10 ** 308`, the subnormal `2 ** -1074`).
const POW_EDGES: readonly (readonly [number, number])[] = [
  [2, 10],
  [10, 22],
  [-3, 3],
  [2, -1],
  [NaN, 0],
  [1, NaN],
  [NaN, NaN],
  [Infinity, -1],
  [-Infinity, 3],
  [-Infinity, 2],
  [-0, -1],
  [0, -1],
  [-8, 1 / 3],
  [2, -1022],
  [-1, Infinity],
  [1, Infinity],
];

function edges(op: Operator): readonly (readonly [number, number])[] {
  if (op === "%") return REMAINDER_EDGES;
  if (op === "**") return POW_EDGES;
  return INT32_EDGES;
}

/** One function per compound position the selector admits. */
const POSITIONS = {
  statement: (op: Operator) => `let x = a; x ${op}= b; return x;`,
  loopBody: (op: Operator) => `let x = a; for (let i = 0; i < 2; i++) { x ${op}= b; } return x;`,
  forUpdate: (op: Operator) => `let x = a; for (let i = 0; i < 2; i++, x ${op}= b) {} return x;`,
  property: (op: Operator) => `const o = { v: a }; o.v ${op}= b; return o.v;`,
  element: (op: Operator) => `const xs = [a, 0]; xs[0] ${op}= b; return xs[0];`,
} as const;
type Position = keyof typeof POSITIONS;

function sourceFor(op: Operator): string {
  return Object.entries(POSITIONS)
    .map(([name, body]) => `export function ${name}(a: number, b: number): number { ${body(op)} }`)
    .join("\n");
}

function nodeResult(position: Position, op: Operator, a: number, b: number): number {
  return new Function("a", "b", POSITIONS[position](op))(a, b) as number;
}

async function compileLane(source: string, lane: Lane, fileName: string): Promise<CompileResult> {
  const result = await compile(source, { fileName, target: lane, experimentalIR: true, trackIrOutcomes: true });
  expect(result.success, `${lane}: ${result.errors.map((error) => error.message).join("\n")}`).toBe(true);
  return result;
}

async function exportsOf(result: CompileResult, lane: Lane): Promise<Record<string, Function>> {
  const imports = lane === "standalone" ? {} : buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, Function>;
  if (lane !== "standalone") (imports as ReturnType<typeof buildImports>).setExports?.(exports);
  return exports;
}

function expectIrClaimed(result: CompileResult, names: readonly string[], label: string): void {
  expect(result.irPostClaimErrors ?? [], label).toEqual([]);
  for (const name of names) {
    const row = result.irOutcomes?.find((entry) => entry.unitKind === "function" && entry.displayName === name);
    expect(row, `${label}: ${name}`).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
  }
}

describe("#7183 — numeric compound assignment through emitNumberBinary", () => {
  for (const op of OPERATORS) {
    it(`'${op}=' is IR-claimed in every compound position and matches node`, async () => {
      for (const lane of LANES) {
        const result = await compileLane(sourceFor(op), lane, `issue-7183-${lane}.ts`);
        expectIrClaimed(result, Object.keys(POSITIONS), `${lane} ${op}=`);
        const exports = await exportsOf(result, lane);
        for (const position of Object.keys(POSITIONS) as Position[]) {
          for (const [a, b] of edges(op)) {
            expect(exports[position]!(a, b), `${lane} ${position}: ${a} ${op}= ${b}`).toBe(
              nodeResult(position, op, a, b),
            );
          }
        }
      }
    }, 120_000);
  }

  it("refuses `**=` before claim on a lane without the `math.pow` provider", () => {
    const { sourceFile } = analyzeSource(`
      export function pow(a: number, b: number): number { let x = a; x **= b; return x; }
      export function rem(a: number, b: number): number { let x = a; x %= b; return x; }
    `);
    const selected = (supportsSymbolicMathHelpers: boolean) => [
      ...planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true, supportsSymbolicMathHelpers })
        .funcs,
    ];
    expect(selected(true).sort()).toEqual(["pow", "rem"]);
    expect(selected(false)).toEqual(["rem"]);
  });

  it("claims the i32-promoted bitwise compounds (#3741's arm) and keeps their wrap", async () => {
    const source = `export function promoted(b: number): number {
      let x = 7;
      x <<= b;
      x |= 1;
      x ^= 0x5a5a;
      x &= 0x7fffffff;
      x >>= 1;
      return x;
    }`;
    const js = new Function("b", "let x = 7; x <<= b; x |= 1; x ^= 0x5a5a; x &= 0x7fffffff; x >>= 1; return x;");
    for (const lane of LANES) {
      const result = await compileLane(source, lane, `issue-7183-promoted-${lane}.ts`);
      expectIrClaimed(result, ["promoted"], `${lane} promoted`);
      const exports = await exportsOf(result, lane);
      for (const b of [0, 1, 3, 28, 31, 32, 33, -1, NaN, 2 ** 32 + 2]) {
        expect(exports.promoted!(b), `${lane} promoted(${b})`).toBe(js(b));
      }
    }
  });

  it("claims compound-assignment-coercion.test.ts's `%=` `|=` `&=` `<<=` `>>=` cases", async () => {
    const cases = [
      ["17", "%=", "5", 2],
      ["5", "|=", "3", 7],
      ["15", "&=", "9", 9],
      ["1", "<<=", "3", 8],
      ["16", ">>=", "2", 4],
    ] as const;
    for (const [init, op, rhs, expected] of cases) {
      const source = `export function test(): number { let x = ${init}; x ${op} ${rhs}; return x; }`;
      for (const lane of LANES) {
        const result = await compileLane(source, lane, `issue-7183-coercion-${lane}.ts`);
        expectIrClaimed(result, ["test"], `${lane} x ${op} ${rhs}`);
        expect((await exportsOf(result, lane)).test!(), `${lane} x ${op} ${rhs}`).toBe(expected);
      }
    }
  });
});
