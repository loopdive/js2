// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Exact IEEE-754 remainder recipe shared by legacy allocation and prepared support.
// This builder owns fresh physical instructions and locals; it allocates no module resources.
import type { Instr } from "../model/instructions.js";
import type { WasmFunction } from "../model/module-records.js";

export function buildNumberRemainderBody(earlyMagnitude: boolean): Pick<WasmFunction, "locals" | "body"> {
  // Locals (after the two f64 params at indices 0=a, 1=b):
  //   2 = x (|a|, running remainder), 3 = y (|b|), 4 = t (aligned divisor)
  const A = 0;
  const B = 1;
  const X = 2;
  const Y = 3;
  const T = 4;
  const AI = 5; // (#4150) i32 view of a, for the integral fast path
  const BI = 6; // (#4150) i32 view of b

  const INF = Infinity;

  // For |a| < |b| every ECMAScript remainder edge collapses to `a` itself:
  // zero divisors and NaN/Infinity dividends fail the ordered comparison,
  // while an infinite divisor with finite `a` correctly returns `a`. Put this
  // exact fast path before the integral guards; rolling-modulo accumulators
  // commonly stay below their modulus for almost every iteration.
  const earlyMagnitudeFastPath: Instr[] = earlyMagnitude
    ? [
        { op: "local.get", index: A },
        { op: "f64.abs" },
        { op: "local.get", index: B },
        { op: "f64.abs" },
        { op: "f64.lt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: A }, { op: "return" }],
        },
      ]
    : [];
  const lateMagnitudeCheck: Instr[] = earlyMagnitude
    ? []
    : [
        { op: "local.get", index: X },
        { op: "local.get", index: Y },
        { op: "f64.lt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: X },
            { op: "local.get", index: A },
            { op: "f64.copysign" },
            { op: "return" },
          ],
        },
      ];

  // `a` remains the sign carrier throughout. The specialized variant can
  // return it directly before any conversion; the standard variant reaches
  // the equivalent late `copysign(|a|, a)` check after the exceptional cases.
  const body: Instr[] = [
    ...earlyMagnitudeFastPath,
    // ── (#4150) Integral fast path — the overwhelmingly common shape ───────
    // `x % 3`, `i % n`, hash folds: both operands are whole numbers in i32
    // range, where the exact remainder is just `i32.rem_s`. Without this every
    // such `%` ran the binary long-division below — ~2× the binary-exponent
    // difference of the operands in f64 loop iterations (≈26 for `19998 % 3`)
    // where V8 issues a handful of instructions. That single helper is what
    // made `array/map-filter` (whose predicate is `x % 3 === 0`) the worst
    // gc-native parity gap.
    //
    // The guard is exact, not a heuristic: `f64.convert_i32_s(trunc_sat(v)) ==
    // v` is true ONLY for a whole number in i32 range. NaN and ±Inf saturate to
    // a finite i32 and fail the compare; a fractional value fails it; a value
    // beyond i32 range saturates and fails it. So everything the slow path
    // handles specially still reaches it.
    //
    // Sign: `i32.rem_s` already gives the dividend's sign for a nonzero
    // remainder, and the trailing `copysign` supplies the two cases i32 cannot
    // represent — `-6 % 3` and `-0 % 3` are both `-0` in JS (§6.1.6.1.6), not
    // `+0`. `-0` as the DIVIDEND takes this path (it converts equal to +0) and
    // copysign restores it; `-0` as the DIVISOR is excluded by `bi != 0` and
    // falls through to the `b == 0 → NaN` case below, which is correct.
    // `INT_MIN % -1` would trap `i32.rem_s`, so it is excluded and handled by
    // the exact path (which answers -0, matching JS).
    { op: "local.get", index: A },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: AI },
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: A },
    { op: "f64.eq" },
    { op: "local.get", index: B },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: BI },
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: B },
    { op: "f64.eq" },
    { op: "i32.and" },
    // bi != 0
    { op: "local.get", index: BI },
    { op: "i32.eqz" },
    { op: "i32.eqz" },
    { op: "i32.and" },
    // !(ai == INT_MIN && bi == -1)
    { op: "local.get", index: AI },
    { op: "i32.const", value: -2147483648 },
    { op: "i32.eq" },
    { op: "local.get", index: BI },
    { op: "i32.const", value: -1 },
    { op: "i32.eq" },
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: AI },
        { op: "local.get", index: BI },
        { op: "i32.rem_s" },
        { op: "f64.convert_i32_s" },
        { op: "local.get", index: A },
        { op: "f64.copysign" },
        { op: "return" },
      ],
    },

    // ── Non-finite / zero-divisor fast cases ───────────────────────────────
    // if (b == 0) return NaN
    { op: "local.get", index: B },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (|a| == Inf) return NaN   (Inf % x, and NaN propagates below too)
    { op: "local.get", index: A },
    { op: "f64.abs" },
    { op: "f64.const", value: INF },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (a != a) return NaN  (NaN dividend)
    { op: "local.get", index: A },
    { op: "local.get", index: A },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (b != b) return NaN  (NaN divisor)
    { op: "local.get", index: B },
    { op: "local.get", index: B },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (|b| == Inf) return a  (a is finite here → remainder is a itself)
    { op: "local.get", index: B },
    { op: "f64.abs" },
    { op: "f64.const", value: INF },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: A }, { op: "return" }],
    },

    // ── x = |a|; y = |b| ───────────────────────────────────────────────────
    { op: "local.get", index: A },
    { op: "f64.abs" },
    { op: "local.set", index: X },
    { op: "local.get", index: B },
    { op: "f64.abs" },
    { op: "local.set", index: Y },

    ...lateMagnitudeCheck,

    // ── t = y; while (t * 2 <= x) t *= 2 ───────────────────────────────────
    { op: "local.get", index: Y },
    { op: "local.set", index: T },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if !(t * 2 <= x) break
            { op: "local.get", index: T },
            { op: "f64.const", value: 2 },
            { op: "f64.mul" },
            { op: "local.get", index: X },
            { op: "f64.le" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // t = t * 2
            { op: "local.get", index: T },
            { op: "f64.const", value: 2 },
            { op: "f64.mul" },
            { op: "local.set", index: T },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // ── while (t >= y) { if (x >= t) x -= t; t *= 0.5 } ─────────────────────
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if !(t >= y) break
            { op: "local.get", index: T },
            { op: "local.get", index: Y },
            { op: "f64.ge" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // if (x >= t) x = x - t
            { op: "local.get", index: X },
            { op: "local.get", index: T },
            { op: "f64.ge" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: X },
                { op: "local.get", index: T },
                { op: "f64.sub" },
                { op: "local.set", index: X },
              ],
            },
            // t = t * 0.5
            { op: "local.get", index: T },
            { op: "f64.const", value: 0.5 },
            { op: "f64.mul" },
            { op: "local.set", index: T },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return copysign(x, a)  — sign of the dividend, incl. -0 case
    { op: "local.get", index: X },
    { op: "local.get", index: A },
    { op: "f64.copysign" },
  ];

  return {
    locals: [
      { name: "$x", type: { kind: "f64" } }, // X
      { name: "$y", type: { kind: "f64" } }, // Y
      { name: "$t", type: { kind: "f64" } }, // T
      { name: "$ai", type: { kind: "i32" } }, // AI
      { name: "$bi", type: { kind: "i32" } }, // BI
    ],
    body,
  };
}
