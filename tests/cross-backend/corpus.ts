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
 *
 * `expectLinearDivergence` (per call) marks a call that compiles and runs on
 * linear but returns a known-wrong value (#6793: `undefined` is f64 0 on
 * linear). The harness asserts the call STILL diverges rather than skipping it,
 * so the gap is measured; when linear is fixed the flag must be removed.
 */

export interface CrossBackendCall {
  /** Exported function name to invoke. */
  readonly fn: string;
  /** Argument tuple (numbers/booleans cross the JS↔Wasm boundary natively). */
  readonly args: readonly (number | boolean)[];
  /**
   * #6793 — a KNOWN linear miscompile: the program compiles and runs on linear
   * but this call returns a different value than WasmGC. The value names the
   * tracking issue. The harness asserts the divergence STILL exists, so the gap
   * is measured on main without turning the advisory check red, and the moment
   * linear agrees the assertion flips and prompts removing the flag (ratchet
   * direction, same as `expectLinearUnsupported`).
   */
  readonly expectLinearDivergence?: string;
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
    // #2715 — bitwise ToInt32 (§7.1.6): NaN/±Infinity → 0, large magnitudes wrap
    // mod 2^32 (never trap). The linear backend used to lower these with the
    // trapping i32.trunc_f64_s, so `(0/0)|0` trapped instead of returning 0.
    name: "numeric/bitwise-toint32-nan-wrap",
    category: "numeric",
    source: `
      export function nanOr(): number { return (0 / 0) | 0; }
      export function infOr(): number { return (1 / 0) | 0; }
      export function negInfOr(): number { return (-1 / 0) | 0; }
      export function bigWrap(): number { return 1e20 | 0; }
      export function plus2to32(): number { return 4294967297 | 0; }
      export function notNan(): number { return ~(0 / 0); }
      export function ushrNeg(): number { return (-1 >>> 0) === 4294967295 ? 1 : 0; }
      export function compoundNan(): number { let x = 5; x |= 0 / 0; return x; }
    `,
    calls: [
      { fn: "nanOr", args: [] },
      { fn: "infOr", args: [] },
      { fn: "negInfOr", args: [] },
      { fn: "bigWrap", args: [] },
      { fn: "plus2to32", args: [] },
      { fn: "notNan", args: [] },
      { fn: "ushrNeg", args: [] },
      { fn: "compoundNan", args: [] },
    ],
  },
  {
    // #2729 — Uint8Array element store ToUint8 (§7.1.10): the assigned value is
    // wrapped to a byte (truncate toward zero, modulo 256; NaN/±Infinity → 0)
    // before storage. The linear backend was fixed in #2715; the WasmGC backend
    // (#2729) used to store the raw f64 (`u[0]=257`→257, `u[0]=NaN`→NaN). This
    // entry — removed in #2715 because of that divergence — is restored now both
    // backends agree.
    name: "numeric/uint8-store-touint8",
    category: "numeric",
    source: `
      export function wrapOver(): number { const u = new Uint8Array(1); u[0] = 257; return u[0]; }
      export function wrap256(): number { const u = new Uint8Array(1); u[0] = 256; return u[0]; }
      export function wrapNeg(): number { const u = new Uint8Array(1); u[0] = -1; return u[0]; }
      export function wrapNeg257(): number { const u = new Uint8Array(1); u[0] = -257; return u[0]; }
      export function truncFrac(): number { const u = new Uint8Array(1); u[0] = 3.7; return u[0]; }
      export function truncBig(): number { const u = new Uint8Array(1); u[0] = 511.5; return u[0]; }
      export function nanZero(): number { const u = new Uint8Array(1); u[0] = 0 / 0; return u[0]; }
      export function infZero(): number { const u = new Uint8Array(1); u[0] = 1 / 0; return u[0]; }
      export function negInfZero(): number { const u = new Uint8Array(1); u[0] = -1 / 0; return u[0]; }
      export function bigWrap(): number { const u = new Uint8Array(1); u[0] = 1e20; return u[0]; }
      export function inRange(): number { const u = new Uint8Array(1); u[0] = 200; return u[0]; }
    `,
    calls: [
      { fn: "wrapOver", args: [] },
      { fn: "wrap256", args: [] },
      { fn: "wrapNeg", args: [] },
      { fn: "wrapNeg257", args: [] },
      { fn: "truncFrac", args: [] },
      { fn: "truncBig", args: [] },
      { fn: "nanZero", args: [] },
      { fn: "infZero", args: [] },
      { fn: "negInfZero", args: [] },
      { fn: "bigWrap", args: [] },
      { fn: "inRange", args: [] },
    ],
  },
  {
    // #2956 L4: Math.trunc is selector-claimed and lowered by LinearEmitter;
    // keep it in the executed differential corpus.
    name: "numeric/math-trunc",
    category: "numeric",
    source: `
      export function intdiv(a: number, b: number): number { return Math.trunc(a / b); }
    `,
    calls: [{ fn: "intdiv", args: [17, 5] }],
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
  {
    // #2716 — try/finally must run the finally on early exit. Each function
    // exposes a finally side effect that is observable AFTER the early return /
    // break / continue, so a skipped finally would diverge from the WasmGC/host
    // oracle (the linear backend used to inline past the finally and trap-free
    // drop it).
    name: "control/try-finally-early-exit",
    category: "control",
    source: `
      let earlyReturnFlag = 0;
      function earlyReturn(): number { try { return 1; } finally { earlyReturnFlag = 9; } }
      export function returnRunsFinally(): number { const r = earlyReturn(); return r * 100 + earlyReturnFlag; }

      export function breakRunsFinally(): number {
        let fin = 0;
        for (let i = 0; i < 3; i++) { try { if (i === 0) break; } finally { fin = fin + 1; } }
        return fin;
      }

      export function continueRunsFinally(): number {
        let fin = 0;
        for (let i = 0; i < 3; i++) { try { continue; } finally { fin = fin + 1; } }
        return fin;
      }

      let nestedLog = 0;
      function nested(): number { try { try { return 1; } finally { nestedLog = nestedLog * 10 + 2; } } finally { nestedLog = nestedLog * 10 + 3; } }
      export function nestedFinallyOrder(): number { const r = nested(); return r * 1000 + nestedLog; }
    `,
    calls: [
      { fn: "returnRunsFinally", args: [] },
      { fn: "breakRunsFinally", args: [] },
      { fn: "continueRunsFinally", args: [] },
      { fn: "nestedFinallyOrder", args: [] },
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
    // #2956 L4: charCodeAt uses the linear IR UTF-16 decoder and is now an
    // executed cross-backend parity row.
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

  // ── builtin surface (#2711) ────────────────────────────────────────────────
  // Programs below broaden the differential over the builtin-method surface,
  // which the original seed corpus did not cover. Entries that compile on BOTH
  // backends are diffed (and currently AGREE); entries the linear/standalone
  // backend cannot yet lower are flagged expectLinearUnsupported so the gate
  // ratchets when the gap closes (see child issues #2715-#2721). Known
  // host↔standalone DIVERGENCES that compile-but-trap/miscompile on linear
  // (e.g. trapping `i32.trunc_f64_s` on `NaN|0`, #2715) are intentionally NOT
  // added here yet — they would make the advisory gate red on main; they are
  // tracked as child issues and become corpus entries once fixed.

  {
    // % modulo lowers natively on both backends and agrees with host.
    name: "numeric/modulo",
    category: "numeric",
    source: `
      export function md(a: number, b: number): number { return a % b; }
      export function negmod(a: number, b: number): number { return a % b; }
    `,
    calls: [
      { fn: "md", args: [17, 5] },
      { fn: "negmod", args: [-7, 3] },
    ],
  },
  {
    // String concat + indexOf lower on both backends and agree with host.
    name: "string/concat-indexof",
    category: "string",
    source: `
      export function cc(): number { const s = "ab" + "cd"; return s.length; }
      export function io(): number { const s = "hello"; return s.indexOf("l"); }
      export function miss(): number { const s = "hello"; return s.indexOf("z"); }
    `,
    calls: [
      { fn: "cc", args: [] },
      { fn: "io", args: [] },
      { fn: "miss", args: [] },
    ],
  },
  {
    // #6778: `+` with ONE string operand concatenates (ToString the other side);
    // linear used to emit numeric f64.add on the i32 string pointer.
    name: "string/mixed-plus",
    category: "string",
    source: `
      export function strNum(): number { const s = "1" + 2; return s.length; }
      export function numStr(n: number): number { const s = n + "px"; return s === "12.5px" ? 1 : 0; }
      export function strBool(): number { const s = "a" + true; return s.length; }
      export function plusEq(): number { let s = ""; for (let i = 0; i < 3; i++) s += i; return s === "012" ? 1 : 0; }
    `,
    calls: [
      { fn: "strNum", args: [] },
      { fn: "numStr", args: [12.5] },
      { fn: "strBool", args: [] },
      { fn: "plusEq", args: [] },
    ],
  },
  {
    // `**` (exponent) is not yet lowered by the linear backend
    // (Unsupported binary operator: AsteriskAsteriskToken). Ratchet entry.
    name: "numeric/exponent",
    category: "numeric",
    source: `
      export function pw(a: number, b: number): number { return a ** b; }
    `,
    calls: [{ fn: "pw", args: [2, 10] }],
    expectLinearUnsupported: true,
  },
  {
    // Math.* static methods are not yet lowered by the linear backend
    // (Unsupported method call: .max()/.floor()/…). Ratchet entry.
    name: "math/builtins",
    category: "numeric",
    source: `
      export function mx(): number { return Math.max(3, 7, 2); }
      export function ab(x: number): number { return Math.abs(x); }
      export function fl(x: number): number { return Math.floor(x); }
    `,
    calls: [
      { fn: "mx", args: [] },
      { fn: "ab", args: [-5] },
      { fn: "fl", args: [3.7] },
    ],
    expectLinearUnsupported: true,
  },
  {
    // Array search methods (indexOf/includes/lastIndexOf) are not lowered by
    // the linear backend; in standalone the externref-element arm emits an
    // unsatisfiable host import (#2719). Ratchet entry.
    name: "array/search-methods",
    category: "array",
    source: `
      export function idx(): number { const a = [10, 20, 30, 40]; return a.indexOf(30); }
      export function inc(): number { const a = [1, 2, 3]; return a.includes(2) ? 1 : 0; }
      export function last(): number { const a = [5, 6, 5, 7]; return a.lastIndexOf(5); }
    `,
    calls: [
      { fn: "idx", args: [] },
      { fn: "inc", args: [] },
      { fn: "last", args: [] },
    ],
    expectLinearUnsupported: true,
  },
  {
    // Array.prototype.flat / flatMap are host-import-only with no standalone
    // native arm (#2717); the linear backend has no lowering at all. Ratchet.
    name: "array/flat-flatMap",
    category: "array",
    source: `
      export function fl(): number { const a = [[1, 2], [3, 4]]; const b = a.flat(); let t = 0; for (const x of b) t += x; return t; }
    `,
    calls: [{ fn: "fl", args: [] }],
    expectLinearUnsupported: true,
  },
  {
    // Higher-order array methods (map/filter/reduce with a closure callback)
    // are not yet lowered by the linear backend. Ratchet entry.
    name: "array/higher-order",
    category: "array",
    source: `
      export function r(): number { const a = [1, 2, 3, 4]; return a.reduce((s, x) => s + x, 0); }
    `,
    calls: [{ fn: "r", args: [] }],
    expectLinearUnsupported: true,
  },

  // ── dynamic residue (#1852-G5, via #2954) ──────────────────────────────────
  // The `any`/boxed-dynamic surface — typeof, dynamic truthiness, `===` on
  // boxed values, box→unbox round-trips. WasmGC lowers all of these (the JSValue
  // externref rep); the linear backend has no dynamic value representation yet,
  // so each fails to compile OR to instantiate on linear. They are kept
  // `expectLinearUnsupported` so the parity gap is MEASURED, not silent — the
  // flag drops when #1852-G4/#2956 give linear a dynamic value rep. (For an
  // expectLinearUnsupported row the harness only asserts WasmGC compiles+runs and
  // linear does NOT; the calls are diffed once the flag is removed.)
  {
    name: "dynamic/typeof-residue",
    category: "dynamic",
    source: `
      export function isNum(): number { const x: any = 42; return typeof x === "number" ? 1 : 0; }
      export function isStr(): number { const x: any = "hi"; return typeof x === "string" ? 1 : 0; }
    `,
    calls: [
      { fn: "isNum", args: [] },
      { fn: "isStr", args: [] },
    ],
    expectLinearUnsupported: true,
  },
  {
    name: "dynamic/truthiness",
    category: "dynamic",
    source: `
      export function truthy(v: number): number { const x: any = v; return x ? 1 : 0; }
    `,
    calls: [
      { fn: "truthy", args: [0] },
      { fn: "truthy", args: [5] },
    ],
    expectLinearUnsupported: true,
  },
  {
    name: "dynamic/strict-eq-boxed",
    category: "dynamic",
    source: `
      export function eqNum(): number { const a: any = 5; const b: any = 5; return a === b ? 1 : 0; }
      export function neNum(): number { const a: any = 5; const b: any = 6; return a === b ? 1 : 0; }
    `,
    calls: [
      { fn: "eqNum", args: [] },
      { fn: "neNum", args: [] },
    ],
    expectLinearUnsupported: true,
  },
  {
    name: "dynamic/box-roundtrip",
    category: "dynamic",
    source: `
      export function roundtrip(n: number): number { const x: any = n; const y = x as number; return y + 1; }
    `,
    calls: [{ fn: "roundtrip", args: [6] }],
    expectLinearUnsupported: true,
  },

  // ── `undefined` vs `0` (#6793) ─────────────────────────────────────────────
  // The linear backend represents `undefined` as f64 0 (`__arr_get` returns
  // 0.0 out of bounds; `f64.const 0` is the undefined sentinel), so every
  // `undefined`-vs-`0` distinction is wrong by construction. Calls linear gets
  // right are diffed normally; calls it miscompiles carry
  // `expectLinearDivergence` so the gap is MEASURED instead of silent. WasmGC
  // returns the JS value on every call below (checked against Node 2026-10-02).
  {
    name: "undefined/vs-zero",
    category: "undefined",
    source: `
      function isUndef(x?: number): number { return x === undefined ? 1 : 0; }
      export function uninitIsUndef(): number { let x: number | undefined; return x === undefined ? 1 : 0; }
      export function untypedUninitIsUndef(): number { let x; return x === undefined ? 1 : 0; }
      export function omittedArgIsUndef(): number { return isUndef(); }
      export function oobReadIsZero(): number { const a = [1, 2]; const v = a[5]; return v === 0 ? 100 : 1; }
      export function zeroIsUndef(): number { const x: number | undefined = 0; return x === undefined ? 1 : 0; }
      export function uninitIsZero(): number { let x: number | undefined; return x === 0 ? 1 : 0; }
      export function zeroArgIsUndef(): number { return isUndef(0); }
      export function zeroIsNullish(): number { const x: number | undefined = 0; return x == null ? 1 : 0; }
    `,
    calls: [
      { fn: "uninitIsUndef", args: [] },
      { fn: "untypedUninitIsUndef", args: [] },
      { fn: "omittedArgIsUndef", args: [] },
      { fn: "oobReadIsZero", args: [], expectLinearDivergence: "#6793" },
      { fn: "zeroIsUndef", args: [], expectLinearDivergence: "#6793" },
      { fn: "uninitIsZero", args: [], expectLinearDivergence: "#6793" },
      { fn: "zeroArgIsUndef", args: [], expectLinearDivergence: "#6793" },
      { fn: "zeroIsNullish", args: [], expectLinearDivergence: "#6793" },
    ],
  },
  {
    // `typeof` is not lowered by the linear backend (Unsupported expression:
    // TypeOfExpression). Ratchet entry; once it compiles, the call is diffed.
    name: "undefined/typeof",
    category: "undefined",
    source: `
      export function typeofUninit(): number { let x; return typeof x === "undefined" ? 1 : 0; }
    `,
    calls: [{ fn: "typeofUninit", args: [] }],
    expectLinearUnsupported: true,
  },
  {
    // `??` is not lowered by the linear backend (Unsupported binary operator:
    // QuestionQuestionToken). Ratchet entry; `0 ?? 7` must stay 0 once it does.
    name: "undefined/nullish-default",
    category: "undefined",
    source: `
      export function uninitDefault(): number { let x: number | undefined; return x ?? 7; }
      export function zeroKept(): number { const x: number | undefined = 0; return x ?? 7; }
    `,
    calls: [
      { fn: "uninitDefault", args: [] },
      { fn: "zeroKept", args: [] },
    ],
    expectLinearUnsupported: true,
  },
];
