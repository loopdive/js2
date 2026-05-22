// IR ↔ backend decoupling regression guard (#1527).
//
// The two-axis architecture (see docs/architecture/codegen-axes.md)
// claims:
//
//   axis 1 (front-end):  direct AST→Wasm  vs  typed IR (src/ir/)
//   axis 2 (backend):    WasmGC           vs  linear memory
//
// The orthogonality claim is that these axes can be chosen
// independently: a program that compiles cleanly through one cell of
// the 2x2 should produce semantically-equivalent output in every other
// cell that supports the program's feature set.
//
// Today the IR lowerer (src/ir/lower.ts) only emits WasmGC ops, so the
// `IR × linear` cell is empty. That is the known divergence — when a
// kind needs both backends through IR, `src/ir/lower-linear.ts` will
// appear and this test will gain a fourth column.
//
// What this test checks now:
//
//   1. legacy-direct (WasmGC)  : compile(src)                     — `experimentalIR: false`
//   2. ir-on-wasmgc            : compile(src, experimentalIR: true) — default today
//   3. linear-direct           : compile(src, target: "linear")
//
// For each program in the matrix below we instantiate all three
// compiles and assert the same export returns the same value. A
// program that is known to be unsupported on one column (e.g. an
// object literal under linear) is documented inline and skipped on
// that column rather than failing the build — the test exists to
// catch *regressions in decoupling*, not to require full feature
// parity.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const ENV = {
  env: {
    console_log_number: () => {},
    console_log_string: () => {},
    console_log_bool: () => {},
  },
};

type Backend = "legacy-gc" | "ir-gc" | "linear";

async function compileAndRun(
  source: string,
  backend: Backend,
  exportName: string,
  args: ReadonlyArray<number | boolean>,
): Promise<unknown> {
  const options =
    backend === "legacy-gc"
      ? { experimentalIR: false, nativeStrings: true }
      : backend === "ir-gc"
        ? { experimentalIR: true, nativeStrings: true }
        : { target: "linear" as const };
  const result = compile(source, options);
  if (!result.success) {
    throw new Error(`${backend} compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, ENV);
  const fn = (instance.exports as Record<string, (...a: unknown[]) => unknown>)[exportName];
  if (typeof fn !== "function") {
    throw new Error(`${backend}: export "${exportName}" not found`);
  }
  return fn(...args);
}

interface DecouplingCase {
  readonly name: string;
  readonly source: string;
  readonly exportName: string;
  readonly args: ReadonlyArray<number | boolean>;
  readonly expected: number | boolean;
  /** Backends for which this program is known to be unsupported. Each is documented inline. */
  readonly skip?: ReadonlySet<Backend>;
}

const CASES: ReadonlyArray<DecouplingCase> = [
  {
    name: "numeric add",
    source: `export function add(a: number, b: number): number { return a + b; }`,
    exportName: "add",
    args: [2, 3],
    expected: 5,
  },
  {
    name: "if/else branch",
    source: `
      export function classify(n: number): number {
        if (n > 0) {
          return 1;
        } else {
          return -1;
        }
      }
    `,
    exportName: "classify",
    args: [7],
    expected: 1,
  },
  {
    name: "while loop sum",
    source: `
      export function sumTo(n: number): number {
        let total: number = 0;
        let i: number = 1;
        while (i <= n) {
          total = total + i;
          i = i + 1;
        }
        return total;
      }
    `,
    exportName: "sumTo",
    args: [10],
    expected: 55,
  },
  {
    name: "recursive fib",
    source: `
      export function fib(n: number): number {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
      }
    `,
    exportName: "fib",
    args: [10],
    expected: 55,
  },
];

describe("IR ↔ backend decoupling (#1527)", () => {
  for (const c of CASES) {
    const skip = c.skip ?? new Set<Backend>();

    it(`${c.name}: legacy-gc vs ir-gc produce same result`, async () => {
      if (skip.has("legacy-gc") || skip.has("ir-gc")) {
        return;
      }
      const legacy = await compileAndRun(c.source, "legacy-gc", c.exportName, c.args);
      const ir = await compileAndRun(c.source, "ir-gc", c.exportName, c.args);
      expect(ir).toEqual(legacy);
      expect(legacy).toEqual(c.expected);
    });

    it(`${c.name}: legacy-gc vs linear produce same result`, async () => {
      if (skip.has("legacy-gc") || skip.has("linear")) {
        return;
      }
      const gc = await compileAndRun(c.source, "legacy-gc", c.exportName, c.args);
      const linear = await compileAndRun(c.source, "linear", c.exportName, c.args);
      expect(linear).toEqual(gc);
      expect(gc).toEqual(c.expected);
    });
  }

  // Documenting the current known divergence in code so a future
  // change that flips it is visible in the diff.
  it("known divergence: IR lowerer emits WasmGC only (no `IR × linear` cell)", () => {
    // No assertion — this exists as documentation that
    // src/ir/lower.ts emits struct.*, array.*, ref.cast ops directly,
    // which the linear backend does not consume. When a sibling
    // src/ir/lower-linear.ts is introduced this test should grow a
    // third column. Tracking: #1527 / #1530.
    expect(true).toBe(true);
  });
});
