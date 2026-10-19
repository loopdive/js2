// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7012) Wasm-native PlainDate / PlainTime `add` / `subtract` field carry,
 * replacing `env::__temporal_plain_date_add_field` and
 * `env::__temporal_plain_time_add_field` on native-string builds.
 *
 * Same ABI and the same arithmetic as the host functions in `runtime.ts`
 * (`_temporalPlainDateAddField` / `_temporalPlainTimeAddField`): years and
 * months move first with the day constrained to the target month (AddISODate,
 * overflow "constrain"), then weeks and days carry through the calendar; a
 * time wraps modulo one day. The host versions go through a JS `Date` and f64
 * nanoseconds; these use exact i64 day numbers and per-unit reduction, which
 * agree with them wherever the host result is exact.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import {
  F64,
  I32,
  I64,
  call,
  choose,
  daysInMonth,
  defineHelper,
  ensureCivilFieldHelper,
  ensureDaysFromCivilHelper,
  ensureTruncHelper,
  get,
  i32c,
  i64c,
  set,
  type HelperFrame,
} from "./wasm-kit.js";

function truncAll(ctx: CodegenContext, f: HelperFrame, n: number): { locals: number[]; code: Instr[] } {
  const trunc = ensureTruncHelper(ctx);
  const locals: number[] = [];
  const code: Instr[] = [];
  for (let k = 0; k < n; k++) {
    const l = f.local(`t${k}`, I64);
    locals.push(l);
    code.push(get(k), call(trunc), set(l));
  }
  return { locals, code };
}

/** `field` param (f64) → i32 selector, `_temporalTrunc` semantics. */
function selector(ctx: CodegenContext, param: number): Instr[] {
  return [get(param), call(ensureTruncHelper(ctx)), { op: "i32.wrap_i64" }];
}

export function ensurePlainDateAddField(ctx: CodegenContext): number {
  const params = Array.from({ length: 9 }, () => F64);
  return defineHelper(ctx, "__temporal_plain_date_add_field", params, [F64], (f) => {
    const daysFromCivil = ensureDaysFromCivilHelper(ctx);
    const civilField = ensureCivilFieldHelper(ctx);
    const { locals: t, code } = truncAll(ctx, f, 8);
    const [day, years, months, weeks, days, sign] = [t[2]!, t[3]!, t[4]!, t[5]!, t[6]!, t[7]!];
    const s = f.local("s", I64);
    const year = f.local("year", I64);
    const month = f.local("month", I64);
    const a = f.local("a", I64);
    const carry = f.local("carry", I64);
    const cday = f.local("cday", I64);
    const which = f.local("which", I32);
    return [
      ...code,
      ...choose([get(sign), i64c(0n), { op: "i64.lt_s" }], I64, [i64c(-1n)], [i64c(1n)]),
      set(s),
      get(t[0]!),
      get(s),
      get(years),
      { op: "i64.mul" },
      { op: "i64.add" },
      set(year),
      get(t[1]!),
      get(s),
      get(months),
      { op: "i64.mul" },
      { op: "i64.add" },
      i64c(1n),
      { op: "i64.sub" },
      set(a),
      // carry = floor(a / 12)
      ...choose(
        [get(a), i64c(0n), { op: "i64.ge_s" }],
        I64,
        [get(a), i64c(12n), { op: "i64.div_s" }],
        [i64c(0n), i64c(11n), get(a), { op: "i64.sub" }, i64c(12n), { op: "i64.div_s" }, { op: "i64.sub" }],
      ),
      set(carry),
      get(year),
      get(carry),
      { op: "i64.add" },
      set(year),
      get(a),
      get(carry),
      i64c(12n),
      { op: "i64.mul" },
      { op: "i64.sub" },
      i64c(1n),
      { op: "i64.add" },
      set(month),
      // cday = min(day, ISODaysInMonth(year, month))
      get(day),
      ...daysInMonth(year, month),
      get(day),
      ...daysInMonth(year, month),
      { op: "i64.lt_s" },
      { op: "select" },
      set(cday),
      ...selector(ctx, 8),
      set(which),
      get(year),
      get(month),
      i64c(1n),
      call(daysFromCivil),
      get(cday),
      i64c(1n),
      { op: "i64.sub" },
      { op: "i64.add" },
      get(s),
      get(days),
      get(weeks),
      i64c(7n),
      { op: "i64.mul" },
      { op: "i64.add" },
      { op: "i64.mul" },
      { op: "i64.add" },
      ...choose(
        [get(which), i32c(0), { op: "i32.eq" }],
        I32,
        [i32c(0)],
        choose([get(which), i32c(1), { op: "i32.eq" }], I32, [i32c(1)], [i32c(2)]),
      ),
      call(civilField),
      { op: "f64.convert_i64_s" },
    ];
  });
}

const DAY_NS = 86_400_000_000_000n;
/** [unit nanoseconds, units per day] for hour .. nanosecond. */
const TIME_UNITS: readonly [bigint, bigint][] = [
  [3_600_000_000_000n, 24n],
  [60_000_000_000n, 1_440n],
  [1_000_000_000n, 86_400n],
  [1_000_000n, 86_400_000n],
  [1_000n, 86_400_000_000n],
  [1n, DAY_NS],
];

/** Sum of `(local[k] % perDay) * unit` over the six time fields (i64 on the stack). */
function reducedNanoseconds(locals: readonly number[]): Instr[] {
  const code: Instr[] = [];
  TIME_UNITS.forEach(([unit, perDay], k) => {
    code.push(get(locals[k]!), i64c(perDay), { op: "i64.rem_s" }, i64c(unit), {
      op: "i64.mul",
    });
    if (k > 0) code.push({ op: "i64.add" });
  });
  return code;
}

export function ensurePlainTimeAddField(ctx: CodegenContext): number {
  const params = Array.from({ length: 14 }, () => F64);
  return defineHelper(ctx, "__temporal_plain_time_add_field", params, [F64], (f) => {
    const { locals: t, code } = truncAll(ctx, f, 13);
    const total = f.local("total", I64);
    const which = f.local("which", I32);
    // Field k of the wrapped total: (total % unitAbove) / unit.
    let pick: Instr[] = [get(total), i64c(1000n), { op: "i64.rem_s" }];
    for (let k = 4; k >= 0; k--) {
      const unit = TIME_UNITS[k]![0];
      const above = k === 0 ? DAY_NS : TIME_UNITS[k - 1]![0];
      pick = choose(
        [get(which), i32c(k), { op: "i32.eq" }],
        I64,
        [get(total), i64c(above), { op: "i64.rem_s" }, i64c(unit), { op: "i64.div_s" }],
        pick,
      );
    }
    return [
      ...code,
      ...reducedNanoseconds(t.slice(0, 6)),
      ...choose([get(t[12]!), i64c(0n), { op: "i64.lt_s" }], I64, [i64c(-1n)], [i64c(1n)]),
      ...reducedNanoseconds(t.slice(6, 12)),
      { op: "i64.mul" },
      { op: "i64.add" },
      i64c(DAY_NS),
      { op: "i64.rem_s" },
      i64c(DAY_NS),
      { op: "i64.add" },
      i64c(DAY_NS),
      { op: "i64.rem_s" },
      set(total),
      ...selector(ctx, 13),
      set(which),
      ...pick,
      { op: "f64.convert_i64_s" },
    ];
  });
}
