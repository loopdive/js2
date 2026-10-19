// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7012) Wasm-native `Temporal.PlainDate.from(string)` /
 * `Temporal.PlainTime.from(string)` field parsers, replacing
 * `env::__temporal_plain_date_from_string_field` and
 * `env::__temporal_plain_time_from_string_field` on native-string builds.
 *
 * ABI (unchanged from the host functions): `(item: externref, field: f64) ->
 * f64` — parse `item` and return field `field`. Errors follow
 * `_temporalParsePlainDate` / `_temporalParsePlainTime` in `runtime.ts`:
 * TypeError for a non-String argument, RangeError for anything the grammar,
 * the annotation rules, IsValidISODate or ISODateWithinLimits rejects.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import {
  ch,
  ensureAnnotationChecker,
  fieldSelector,
  findBracket,
  isoFieldLocals,
  resetTime,
  scanDate,
  scanOffsetOrZ,
  scanTime,
  scanYear,
  selectFieldF64,
  stringPrologue,
  Scanner,
  type IsoFields,
} from "./native-parse-kit.js";
import {
  EXTERNREF,
  F64,
  I32,
  I64,
  call,
  defineHelper,
  ensureTruncHelper,
  get,
  i32c,
  i64c,
  isLeapYear,
  nativeStringTypes,
  set,
  throwInstrs,
  when,
} from "./wasm-kit.js";

/** IsValidDate early errors on the parsed year / month / day (RangeError). */
function dateValidity(ctx: CodegenContext, v: IsoFields): Instr[] {
  const invalid = throwInstrs(ctx, "RangeError", "invalid day of month in Temporal string");
  const monthIs = (m: number): Instr[] => [get(v.month), i64c(BigInt(m)), { op: "i64.eq" }];
  const dayIs = (d: number): Instr[] => [get(v.day), i64c(BigInt(d)), { op: "i64.eq" }];
  return [
    ...when([get(v.negativeZeroYear)], throwInstrs(ctx, "RangeError", "Temporal year -000000 is not allowed")),
    ...when(
      [
        ...dayIs(31),
        ...monthIs(2),
        ...monthIs(4),
        { op: "i32.or" },
        ...monthIs(6),
        { op: "i32.or" },
        ...monthIs(9),
        { op: "i32.or" },
        ...monthIs(11),
        { op: "i32.or" },
        { op: "i32.and" },
      ],
      invalid,
    ),
    ...when([...monthIs(2), ...dayIs(30), { op: "i32.and" }], invalid),
    ...when(
      [...monthIs(2), ...dayIs(29), { op: "i32.and" }, ...isLeapYear(v.year), { op: "i32.eqz" }, { op: "i32.and" }],
      invalid,
    ),
  ];
}

/** ISODateWithinLimits: -271821-04-19 .. +275760-09-13. */
function dateLimits(ctx: CodegenContext, v: IsoFields): Instr[] {
  const y = (cmp: "i64.lt_s" | "i64.gt_s" | "i64.eq", n: bigint): Instr[] => [get(v.year), i64c(n), { op: cmp }];
  const m = (cmp: "i64.lt_s" | "i64.gt_s" | "i64.eq", n: bigint): Instr[] => [get(v.month), i64c(n), { op: cmp }];
  const d = (cmp: "i64.lt_s" | "i64.gt_s", n: bigint): Instr[] => [get(v.day), i64c(n), { op: cmp }];
  return when(
    [
      ...y("i64.lt_s", -271821n),
      ...y("i64.gt_s", 275760n),
      { op: "i32.or" },
      ...y("i64.eq", -271821n),
      ...m("i64.lt_s", 4n),
      ...m("i64.eq", 4n),
      ...d("i64.lt_s", 19n),
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "i32.and" },
      { op: "i32.or" },
      ...y("i64.eq", 275760n),
      ...m("i64.gt_s", 9n),
      ...m("i64.eq", 9n),
      ...d("i64.gt_s", 13n),
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "i32.and" },
      { op: "i32.or" },
    ],
    throwInstrs(ctx, "RangeError", "Temporal.PlainDate is outside the representable range"),
  );
}

export function ensurePlainDateFromStringField(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_plain_date_from_string_field", [EXTERNREF, F64], [F64], (f) => {
    const types = nativeStringTypes(ctx);
    const trunc = ensureTruncHelper(ctx);
    const annotations = ensureAnnotationChecker(ctx);
    const s = new Scanner(f, types.data);
    const v = isoFieldLocals(f);
    const fullEnd = f.local("fullEnd", I32);
    const which = f.local("which", I32);
    return [
      ...stringPrologue(ctx, f, s, "Temporal.PlainDate argument"),
      get(s.end),
      set(fullEnd),
      ...findBracket(s, s.end, fullEnd),
      i32c(0),
      set(s.fail),
      ...resetTime(v),
      ...scanDate(s, v),
      ...s.ifChar([ch("T"), ch("t"), ch(" ")], [...scanTime(s, v), ...scanOffsetOrZ(s, v)]),
      ...s.atEnd(),
      ...when([get(s.fail)], throwInstrs(ctx, "RangeError", "invalid Temporal.PlainDate string")),
      ...when([get(v.utc)], throwInstrs(ctx, "RangeError", "UTC designator Z is not valid for Temporal.PlainDate")),
      get(s.data),
      get(s.end),
      get(fullEnd),
      call(annotations),
      ...dateValidity(ctx, v),
      ...dateLimits(ctx, v),
      ...fieldSelector(trunc, 1),
      set(which),
      ...selectFieldF64(which, [v.year, v.month, v.day]),
    ];
  });
}

/**
 * The AnnotatedTime early errors: a time written without `T` must not also
 * read as DateSpecMonthDay (`--?MM-?DD`) or DateSpecYearMonth (`YYYY-?MM`).
 */
function timeAmbiguity(ctx: CodegenContext, s: Scanner, v: IsoFields, start: number): Instr[] {
  const ambiguous = throwInstrs(ctx, "RangeError", "ambiguous Temporal.PlainTime string");
  const trial = (steps: Instr[]): Instr[] => [
    get(start),
    set(s.i),
    i32c(0),
    set(s.fail),
    ...steps,
    ...s.atEnd(),
    ...when([get(s.fail), { op: "i32.eqz" }], ambiguous),
  ];
  return [
    ...trial([
      ...s.ifChar([ch("-")], s.expect(ch("-"))),
      ...s.field2(v.tmp, 1, 12),
      ...s.ifChar([ch("-")], []),
      ...s.field2(v.tmp, 1, 31),
    ]),
    ...trial([...scanYear(s, v, v.tmp), ...s.ifChar([ch("-")], []), ...s.field2(v.tmp, 1, 12)]),
  ];
}

export function ensurePlainTimeFromStringField(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_plain_time_from_string_field", [EXTERNREF, F64], [F64], (f) => {
    const types = nativeStringTypes(ctx);
    const trunc = ensureTruncHelper(ctx);
    const annotations = ensureAnnotationChecker(ctx);
    const s = new Scanner(f, types.data);
    const v = isoFieldLocals(f);
    const fullEnd = f.local("fullEnd", I32);
    const start = f.local("start", I32);
    const designator = f.local("designator", I32);
    const which = f.local("which", I32);
    const ms = f.local("ms", I64);
    const us = f.local("us", I64);
    const ns = f.local("ns", I64);
    const timeOnly: Instr[] = [
      get(start),
      set(s.i),
      i32c(0),
      set(s.fail),
      i32c(0),
      set(designator),
      ...resetTime(v),
      ...s.ifChar([ch("T"), ch("t")], [i32c(1), set(designator)]),
      ...scanTime(s, v),
      ...scanOffsetOrZ(s, v),
      ...s.atEnd(),
      ...when([get(s.fail)], throwInstrs(ctx, "RangeError", "invalid Temporal.PlainTime string")),
      ...when([get(designator), { op: "i32.eqz" }], timeAmbiguity(ctx, s, v, start)),
    ];
    return [
      ...stringPrologue(ctx, f, s, "Temporal.PlainTime argument"),
      get(s.end),
      set(fullEnd),
      ...findBracket(s, s.end, fullEnd),
      get(s.data),
      get(s.end),
      get(fullEnd),
      call(annotations),
      get(s.i),
      set(start),
      // AnnotatedDateTime[~Zoned, +TimeRequired] first, then AnnotatedTime.
      i32c(0),
      set(s.fail),
      ...resetTime(v),
      ...scanDate(s, v),
      ...s.expect(ch("T"), ch("t"), ch(" ")),
      ...scanTime(s, v),
      ...scanOffsetOrZ(s, v),
      ...s.atEnd(),
      ...when([get(s.fail)], timeOnly, dateValidity(ctx, v)),
      ...when([get(v.utc)], throwInstrs(ctx, "RangeError", "UTC designator Z is not valid for Temporal.PlainTime")),
      // TimeSecond 60 is clamped to 59 (ParseISODateTime).
      ...when([get(v.second), i64c(60n), { op: "i64.eq" }], [i64c(59n), set(v.second)]),
      get(v.fraction),
      i64c(1000000n),
      { op: "i64.div_s" },
      set(ms),
      get(v.fraction),
      i64c(1000n),
      { op: "i64.div_s" },
      i64c(1000n),
      { op: "i64.rem_s" },
      set(us),
      get(v.fraction),
      i64c(1000n),
      { op: "i64.rem_s" },
      set(ns),
      ...fieldSelector(trunc, 1),
      set(which),
      ...selectFieldF64(which, [v.hour, v.minute, v.second, ms, us, ns]),
    ];
  });
}
