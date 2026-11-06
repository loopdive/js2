// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7012) Wasm-native `Temporal.Duration.from(string)` field parser, replacing
 * `env::__temporal_duration_from_string_field` on native-string builds.
 *
 * ABI (unchanged): `(item: externref, field: f64) -> f64`. Mirrors
 * `_temporalParseDuration` in `runtime.ts` (ParseTemporalDurationString):
 *   `[+-]? [Pp] (\d+[Yy])? (\d+[Mm])? (\d+[Ww])? (\d+[Dd])?
 *    ([Tt] (\d+([.,]\d{1,9})?[Hh])? (\d+(…)?[Mm])? (\d+(…)?[Ss])?)?`
 * — at least one unit, a time unit after `T`, a fraction only on the last time
 * unit present. The fraction balances into the smaller units with exact integer
 * arithmetic (nine digits of nanoseconds times the unit's length), magnitudes
 * then take the sign, and the result must pass IsValidDuration. A negative sign
 * yields +0 (not -0) for absent fields, like the spec's mathematical values.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { ch, fieldSelector, stringPrologue, Scanner } from "./native-parse-kit.js";
import {
  EXTERNREF,
  F64,
  I32,
  I64,
  choose,
  defineHelper,
  ensureTruncHelper,
  f64c,
  get,
  i32c,
  i64c,
  nativeStringTypes,
  set,
  throwInstrs,
  when,
  type HelperFrame,
} from "./wasm-kit.js";

/** Unit letters in order; index = rank within its part. */
const DATE_UNITS = ["Yy", "Mm", "Ww", "Dd"] as const;
const TIME_UNITS = ["Hh", "Mm", "Ss"] as const;

interface DurationLocals {
  number: number; // f64 digits of the current unit
  rank: number; // i32
  lastRank: number; // i32
  values: number[]; // f64 × 10
  frac: number; // i64 nanosecond-scaled fraction of the current unit
  fracSeen: number; // i32, current unit had a fraction
  fracCount: number; // i32
  fracRank: number; // i32 rank (0 H, 1 M, 2 S) of the fractional unit, -1 none
  fracValue: number; // i64
  hasDate: number;
  hasTime: number;
  timeSeen: number;
  negative: number;
}

function durationLocals(f: HelperFrame): DurationLocals {
  return {
    number: f.local("number", F64),
    rank: f.local("rank", I32),
    lastRank: f.local("lastRank", I32),
    values: Array.from({ length: 10 }, (_, k) => f.local(`f${k}`, F64)),
    frac: f.local("frac", I64),
    fracSeen: f.local("fracSeen", I32),
    fracCount: f.local("fracCount", I32),
    fracRank: f.local("fracRank", I32),
    fracValue: f.local("fracValue", I64),
    hasDate: f.local("hasDate", I32),
    hasTime: f.local("hasTime", I32),
    timeSeen: f.local("timeSeen", I32),
    negative: f.local("negative", I32),
  };
}

/** `\d+` into the f64 local `dest` (the caller has seen a digit). */
function scanNumber(s: Scanner, dest: number): Instr[] {
  return [
    f64c(0),
    set(dest),
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        ...s.load(),
        ...when(s.cIsDigit(), [
          get(dest),
          f64c(10),
          { op: "f64.mul" },
          get(s.c),
          i32c(48),
          { op: "i32.sub" },
          { op: "f64.convert_i32_u" },
          { op: "f64.add" },
          set(dest),
          ...s.advance(),
          { op: "br", depth: 1 },
        ]),
      ],
    },
  ];
}

/** rank := index of the unit letter in `c` among `units`, -1 when none. */
function unitRank(s: Scanner, units: readonly string[], rank: number): Instr[] {
  let code: Instr[] = [i32c(-1)];
  for (let k = units.length - 1; k >= 0; k--) {
    const [upper, lower] = [ch(units[k]![0]!), ch(units[k]![1]!)];
    code = choose(s.cIs(upper, lower), I32, [i32c(k)], code);
  }
  return [...code, set(rank)];
}

/** One `digits [fraction] letter` component of a part; `loop` repeats while digits follow. */
function scanPart(s: Scanner, d: DurationLocals, units: readonly string[], base: number, time: boolean): Instr[] {
  const store: Instr[] = [];
  units.forEach((_, k) => {
    store.push(...when([get(d.rank), i32c(k), { op: "i32.eq" }], [get(d.number), set(d.values[base + k]!)]));
  });
  const component: Instr[] = [
    // A unit after a fractional unit violates "fraction only on the smallest unit".
    ...(time ? when([get(d.fracRank), i32c(0), { op: "i32.ge_s" }], s.setFail()) : []),
    ...scanNumber(s, d.number),
    ...(time ? [i32c(0), set(d.fracSeen), ...s.fraction(d.frac, d.fracSeen, d.fracCount)] : []),
    ...s.guard([
      ...s.load(),
      ...unitRank(s, units, d.rank),
      ...when([get(d.rank), get(d.lastRank), { op: "i32.le_s" }], s.setFail(), [
        ...s.advance(),
        ...store,
        get(d.rank),
        set(d.lastRank),
        i32c(1),
        set(time ? d.hasTime : d.hasDate),
        ...(time ? when([get(d.fracSeen)], [get(d.rank), set(d.fracRank), get(d.frac), set(d.fracValue)]) : []),
      ]),
    ]),
  ];
  return [
    i32c(-1),
    set(d.lastRank),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(s.fail),
            { op: "br_if", depth: 1 },
            ...s.load(),
            ...s.cIsDigit(),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            ...component,
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/** Balance the fractional unit into minutes / seconds / sub-seconds (all magnitudes). */
function distributeFraction(d: DurationLocals, rem: number): Instr[] {
  const [minutes, seconds, ms, us, ns] = [d.values[5]!, d.values[6]!, d.values[7]!, d.values[8]!, d.values[9]!];
  const toF64 = (code: Instr[]): Instr[] => [...code, { op: "f64.convert_i64_s" }];
  return [
    i64c(0n),
    set(rem),
    ...when(
      [get(d.fracRank), i32c(0), { op: "i32.eq" }],
      [
        // hours: fracNs = frac × 3600 (exact: nine digits × seconds per hour)
        get(d.fracValue),
        i64c(3600n),
        { op: "i64.mul" },
        set(rem),
        ...toF64([get(rem), i64c(60_000_000_000n), { op: "i64.div_s" }]),
        set(minutes),
        get(rem),
        i64c(60_000_000_000n),
        { op: "i64.rem_s" },
        set(rem),
      ],
    ),
    ...when([get(d.fracRank), i32c(1), { op: "i32.eq" }], [get(d.fracValue), i64c(60n), { op: "i64.mul" }, set(rem)]),
    ...when(
      [get(d.fracRank), i32c(0), { op: "i32.eq" }, get(d.fracRank), i32c(1), { op: "i32.eq" }, { op: "i32.or" }],
      [
        ...toF64([get(rem), i64c(1_000_000_000n), { op: "i64.div_s" }]),
        set(seconds),
        get(rem),
        i64c(1_000_000_000n),
        { op: "i64.rem_s" },
        set(rem),
      ],
    ),
    ...when([get(d.fracRank), i32c(2), { op: "i32.eq" }], [get(d.fracValue), set(rem)]),
    ...toF64([get(rem), i64c(1_000_000n), { op: "i64.div_s" }]),
    set(ms),
    ...toF64([get(rem), i64c(1_000_000n), { op: "i64.rem_s" }, i64c(1000n), { op: "i64.div_s" }]),
    set(us),
    ...toF64([get(rem), i64c(1000n), { op: "i64.rem_s" }]),
    set(ns),
  ];
}

/** IsValidDuration on the (non-negative) magnitudes; mixed signs cannot occur. */
function validity(ctx: CodegenContext, d: DurationLocals): Instr[] {
  const v = d.values;
  const big = (k: number): Instr[] => [get(v[k]!), f64c(4294967296), { op: "f64.ge" }];
  const scaled = (k: number, by: number): Instr[] => [get(v[k]!), f64c(by), { op: "f64.mul" }];
  return when(
    [
      ...big(0),
      ...big(1),
      { op: "i32.or" },
      ...big(2),
      { op: "i32.or" },
      // (|S| - 2^53) × 1e9 + |F| >= 0, S whole seconds, F sub-second nanoseconds
      ...scaled(3, 86400),
      ...scaled(4, 3600),
      { op: "f64.add" },
      ...scaled(5, 60),
      { op: "f64.add" },
      get(v[6]!),
      { op: "f64.add" },
      f64c(9007199254740992),
      { op: "f64.sub" },
      f64c(1e9),
      { op: "f64.mul" },
      ...scaled(7, 1e6),
      ...scaled(8, 1e3),
      { op: "f64.add" },
      get(v[9]!),
      { op: "f64.add" },
      { op: "f64.add" },
      f64c(0),
      { op: "f64.ge" },
      { op: "i32.or" },
    ],
    throwInstrs(ctx, "RangeError", "Temporal.Duration out of range"),
  );
}

export function ensureDurationFromStringField(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_duration_from_string_field", [EXTERNREF, F64], [F64], (f) => {
    const types = nativeStringTypes(ctx);
    const trunc = ensureTruncHelper(ctx);
    const s = new Scanner(f, types.data);
    const d = durationLocals(f);
    const rem = f.local("rem", I64);
    const which = f.local("which", I32);
    const invalid = throwInstrs(ctx, "RangeError", "invalid Temporal.Duration string");
    const reset: Instr[] = [i32c(0), set(s.fail), i32c(0), set(d.negative), i32c(-1), set(d.fracRank)];
    for (const flag of [d.hasDate, d.hasTime, d.timeSeen]) reset.push(i32c(0), set(flag));
    for (const value of d.values) reset.push(f64c(0), set(value));
    const signed: Instr[] = [];
    for (const value of d.values) {
      // -x for a negative duration, then + 0 so an absent field is +0, never -0.
      signed.push(
        ...when([get(d.negative)], [get(value), { op: "f64.neg" }, set(value)]),
        get(value),
        f64c(0),
        { op: "f64.add" },
        set(value),
      );
    }
    // The field locals already hold f64.
    let pick: Instr[] = [f64c(0)];
    for (let k = 9; k >= 0; k--) {
      pick = choose([get(which), i32c(k), { op: "i32.eq" }], F64, [get(d.values[k]!)], pick);
    }
    return [
      ...stringPrologue(ctx, f, s, "Temporal.Duration argument"),
      ...reset,
      ...s.ifChar([ch("+"), ch("-")], [get(s.c), i32c(ch("-")), { op: "i32.eq" }, set(d.negative)]),
      ...s.expect(ch("P"), ch("p")),
      ...scanPart(s, d, DATE_UNITS, 0, false),
      ...s.ifChar([ch("T"), ch("t")], [i32c(1), set(d.timeSeen), ...scanPart(s, d, TIME_UNITS, 4, true)]),
      ...s.atEnd(),
      ...when([get(d.hasDate), get(d.hasTime), { op: "i32.or" }, { op: "i32.eqz" }], s.setFail()),
      ...when([get(d.timeSeen), get(d.hasTime), { op: "i32.eqz" }, { op: "i32.and" }], s.setFail()),
      ...when([get(s.fail)], invalid),
      ...distributeFraction(d, rem),
      ...validity(ctx, d),
      ...signed,
      ...fieldSelector(trunc, 1),
      set(which),
      ...pick,
    ];
  });
}
