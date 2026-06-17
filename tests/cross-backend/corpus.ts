// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1854 — Cross-backend differential corpus.
 *
 * Each entry is a self-contained TS program that exports one or more functions,
 * plus the argument tuples to invoke them with. The cross-backend harness
 * (`tests/cross-backend-diff.test.ts`) compiles every program to BOTH the
 * WasmGC and the linear-memory backend, invokes each `call`, and asserts the
 * two backends return identical observable values.
 *
 * Why return values, not stdout: the linear backend (`target: "linear"`,
 * non-WASI) has no `console.log` host import — it silently drops console
 * output (verified: a linear-compiled program prints nothing). Its observable
 * surface is the exported function's return value, which is exactly what
 * tests/linear-*.test.ts already assert. So the differential is over return
 * values: a divergence here is a genuine backend-lowering bug (numeric layout,
 * boxing, control-flow) that the single-oracle equivalence suite can miss
 * because it only runs one backend per test.
 *
 * Categories mirror the equivalence corpus seed requested by the issue:
 * numeric kernels, strings, arrays, control flow, objects, closures.
 *
 * `expectLinearUnsupported: true` marks a program that the linear backend does
 * not yet compile (e.g. closures, some object shapes). The harness records it
 * as a skip (NOT a divergence) so the gate "baselines the gap" the way the
 * issue's sprint-62 amendment intended — only programs that compile on BOTH
 * backends are diffed. If such a program later starts compiling on linear, the
 * harness reports it so the flag can be removed (ratchet direction).
 */

export interface CrossBackendCall {
  /** Exported function name to invoke. */
  readonly fn: string;
  /** Argument tuple (numbers/booleans cross the JS↔Wasm boundary natively). */
  readonly args: readonly (number | boolean)[];
}

export interface CrossBackendProgram {
  /** Stable id, used in test names and divergence reports. */
  readonly name: string;
  /** Category bucket (numeric/string/array/control/object/closure). */
  readonly category: string;
  /** Self-contained TS source. */
  readonly source: string;
  /** Functions + args to invoke and diff across backends. */
  readonly calls: readonly CrossBackendCall[];
  /**
   * Set when the linear backend does not yet compile this program. The harness
   * skips it (not a divergence) but asserts it STILL fails to compile on linear
   * — if linear gains support, the assertion flips and prompts removing the
   * flag (so the gap baseline ratchets down rather than silently rotting).
   */
  readonly expectLinearUnsupported?: boolean;
}

export const CROSS_BACKEND_CORPUS: readonly CrossBackendProgram[] = [
  // ── numeric kernels ──────────────────────────────────────────────────────
  {
    name: "numeric/arithmetic",
    category: "numeric",
    source: `
      export function arith(): number { return 1 + 2 * 3 - 4 / 2; }
      export function precedence(): number { return (1 + 2) * (3 - 1) / 2; }
      export function negate(x: number): number { return -x; }
    `,
    calls: [
      { fn: "arith", args: [] },
      { fn: "precedence", args: [] },
      { fn: "negate", args: [7] },
      { fn: "negate", args: [-3] },
    ],
  },
  {
    name: "numeric/integer-ops",
    category: "numeric",
    source: `
      export function mod(a: number, b: number): number { return a % b; }
      export function bitwise(): number { return (0xff & 0x0f) | (1 << 4); }
      export function shifts(x: number): number { return (x << 2) >> 1; }
    `,
    calls: [
      { fn: "mod", args: [17, 5] },
      { fn: "mod", args: [-17, 5] },
      { fn: "bitwise", args: [] },
      { fn: "shifts", args: [9] },
    ],
  },
  {
    // Math.trunc is not yet lowered by the linear backend (Unsupported method
    // call: .trunc()). Tracked here so the gap is visible and the flag drops
    // the moment linear gains Math.* support.
    name: "numeric/math-trunc",
    category: "numeric",
    source: `
      export function intdiv(a: number, b: number): number { return Math.trunc(a / b); }
    `,
    calls: [{ fn: "intdiv", args: [17, 5] }],
    expectLinearUnsupported: true,
  },
  {
    name: "numeric/recursion-fib",
    category: "numeric",
    source: `
      export function fib(n: number): number { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
      export function fact(n: number): number { if (n <= 1) return 1; return n * fact(n - 1); }
    `,
    calls: [
      { fn: "fib", args: [10] },
      { fn: "fib", args: [20] },
      { fn: "fact", args: [6] },
    ],
  },
  {
    name: "numeric/float-precision",
    category: "numeric",
    source: `
      export function half(): number { return 1 / 2; }
      export function third(): number { return 1 / 3; }
      export function compound(): number { return 0.1 + 0.2; }
    `,
    calls: [
      { fn: "half", args: [] },
      { fn: "third", args: [] },
      { fn: "compound", args: [] },
    ],
  },

  // ── control flow ─────────────────────────────────────────────────────────
  {
    name: "control/branches",
    category: "control",
    source: `
      export function classify(x: number): number {
        if (x > 0) { return 1; } else if (x < 0) { return -1; } else { return 0; }
      }
      export function ternary(x: number): number { return x > 0 ? x : -x; }
      export function clampLoop(x: number): number {
        let n = x;
        while (n > 10) { n = n - 10; }
        return n;
      }
    `,
    calls: [
      { fn: "classify", args: [5] },
      { fn: "classify", args: [-3] },
      { fn: "classify", args: [0] },
      { fn: "ternary", args: [-8] },
      { fn: "clampLoop", args: [37] },
    ],
  },
  {
    name: "control/loops-accumulate",
    category: "control",
    source: `
      export function sumTo(n: number): number { let t = 0; for (let i = 1; i <= n; i++) { t += i; } return t; }
      export function countdown(n: number): number { let c = 0; do { c++; n--; } while (n > 0); return c; }
      export function nestedLoop(n: number): number {
        let t = 0;
        for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { t++; } }
        return t;
      }
    `,
    calls: [
      { fn: "sumTo", args: [100] },
      { fn: "countdown", args: [7] },
      { fn: "nestedLoop", args: [5] },
    ],
  },
  {
    name: "control/comparison-bool",
    category: "control",
    source: `
      export function gt(a: number, b: number): boolean { return a > b; }
      export function eq(a: number, b: number): boolean { return a === b; }
      export function logic(a: number, b: number): boolean { return a > 0 && b > 0; }
    `,
    calls: [
      { fn: "gt", args: [3, 2] },
      { fn: "gt", args: [2, 3] },
      { fn: "eq", args: [5, 5] },
      { fn: "logic", args: [1, 1] },
      { fn: "logic", args: [1, -1] },
    ],
  },

  // ── strings ──────────────────────────────────────────────────────────────
  {
    name: "string/length",
    category: "string",
    source: `
      export function len(): number { const s = "hello world"; return s.length; }
      export function emptyLen(): number { const s = ""; return s.length; }
    `,
    calls: [
      { fn: "len", args: [] },
      { fn: "emptyLen", args: [] },
    ],
  },
  {
    // String.prototype.charCodeAt is not yet lowered by the linear backend
    // (Unsupported method call: .charCodeAt()). Flagged so the gap is visible.
    name: "string/charcode",
    category: "string",
    source: `
      export function code(): number { const s = "ABC"; return s.charCodeAt(0); }
      export function codeAt(i: number): number { const s = "abcdef"; return s.charCodeAt(i); }
    `,
    calls: [
      { fn: "code", args: [] },
      { fn: "codeAt", args: [3] },
    ],
    expectLinearUnsupported: true,
  },

  // ── arrays ───────────────────────────────────────────────────────────────
  {
    name: "array/sum-iterate",
    category: "array",
    source: `
      export function sum(): number { const a = [1, 2, 3, 4, 5]; let t = 0; for (const x of a) { t += x; } return t; }
      export function indexed(): number { const a = [10, 20, 30]; let t = 0; for (let i = 0; i < a.length; i++) { t += a[i]; } return t; }
      export function len(): number { const a = [1, 2, 3, 4]; return a.length; }
    `,
    calls: [
      { fn: "sum", args: [] },
      { fn: "indexed", args: [] },
      { fn: "len", args: [] },
    ],
  },
  {
    name: "array/mutate",
    category: "array",
    source: `
      export function pushSum(): number { const a: number[] = []; a.push(1); a.push(2); a.push(3); let t = 0; for (const x of a) { t += x; } return t; }
      export function writeRead(): number { const a = [0, 0, 0]; a[1] = 42; return a[1]; }
    `,
    calls: [
      { fn: "pushSum", args: [] },
      { fn: "writeRead", args: [] },
    ],
  },

  // ── objects ──────────────────────────────────────────────────────────────
  {
    name: "object/fields",
    category: "object",
    source: `
      class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
      export function manhattan(): number { const p = new Point(3, 4); return p.x + p.y; }
      export function mutate(): number { const p = new Point(1, 1); p.x = 10; return p.x + p.y; }
    `,
    calls: [
      { fn: "manhattan", args: [] },
      { fn: "mutate", args: [] },
    ],
  },

  // ── closures (linear backend does not yet support arrow closures) ──────────
  {
    name: "closure/counter",
    category: "closure",
    source: `
      export function counter(): number {
        let c = 0;
        const inc = () => { c += 1; return c; };
        inc();
        inc();
        return inc();
      }
    `,
    calls: [{ fn: "counter", args: [] }],
    expectLinearUnsupported: true,
  },
];
