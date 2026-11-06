// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7012) Wasm-native Temporal formatters and the Duration sign, replacing the
 * `env::__temporal_*_to_string` / `month_code` / `duration_sign` host imports on
 * native-string builds. Same ABI as the host functions (f64 fields in), except
 * that a string result is the module's own `$NativeString`.
 *
 * Spec references (tc39/proposal-temporal):
 *   - TemporalDateToString / PadISOYear: 4-digit year for 0..9999, otherwise a
 *     sign and at least 6 digits.
 *   - TemporalTimeToString with precision "auto": `HH:MM:SS` plus the
 *     nanosecond fraction with trailing zeros removed.
 *   - TemporalDurationToString with precision "auto": seconds and sub-seconds
 *     are balanced into one `S` component (`balance-subseconds.js`); a duration
 *     with nothing above seconds prints at least `PT0S`.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import {
  F64,
  I32,
  I64,
  OutBuf,
  absI64,
  anyStringType,
  call,
  choose,
  defineHelper,
  ensureTruncHelper,
  f64c,
  get,
  i32c,
  i64c,
  set,
  when,
  type HelperFrame,
} from "./wasm-kit.js";

const fields = (n: number) => Array.from({ length: n }, () => F64);

/** Truncate params 0..n-1 into fresh i64 locals (optionally as magnitudes). */
function truncParams(
  ctx: CodegenContext,
  f: HelperFrame,
  n: number,
  abs: boolean,
): { locals: number[]; code: Instr[] } {
  const trunc = ensureTruncHelper(ctx);
  const scratch = f.local("scratch", I64);
  const locals: number[] = [];
  const code: Instr[] = [];
  for (let k = 0; k < n; k++) {
    const l = f.local(`v${k}`, I64);
    locals.push(l);
    code.push(get(k), call(trunc));
    if (abs) code.push(...absI64(scratch));
    code.push(set(l));
  }
  return { locals, code };
}

export function ensurePlainDateToString(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_plain_date_to_string", fields(3), [anyStringType(ctx)], (f) => {
    const { locals, code } = truncParams(ctx, f, 3, false);
    const [y, m, d] = locals as [number, number, number];
    const out = new OutBuf(ctx, f);
    const scratch = f.local("abs", I64);
    return [
      ...code,
      ...out.alloc(24),
      ...when(
        [get(y), i64c(0n), { op: "i64.ge_s" }, get(y), i64c(9999n), { op: "i64.le_s" }, { op: "i32.and" }],
        out.uint([get(y)], 4),
        [
          ...out.charOf(choose([get(y), i64c(0n), { op: "i64.lt_s" }], I32, [i32c(45)], [i32c(43)])),
          ...out.uint([get(y), ...absI64(scratch)], 6),
        ],
      ),
      ...out.char(45),
      ...out.uint([get(m), ...absI64(scratch)], 2),
      ...out.char(45),
      ...out.uint([get(d), ...absI64(scratch)], 2),
      ...out.finish(),
    ];
  });
}

export function ensurePlainDateMonthCode(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_plain_date_month_code", fields(1), [anyStringType(ctx)], (f) => {
    const { locals, code } = truncParams(ctx, f, 1, true);
    const out = new OutBuf(ctx, f);
    return [...code, ...out.alloc(24), ...out.char(77), ...out.uint([get(locals[0]!)], 2), ...out.finish()];
  });
}

export function ensurePlainTimeToString(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_plain_time_to_string", fields(6), [anyStringType(ctx)], (f) => {
    const { locals, code } = truncParams(ctx, f, 6, true);
    const out = new OutBuf(ctx, f);
    const floor = f.local("fracFloor", I32);
    return [
      ...code,
      ...out.alloc(128),
      ...out.uint([get(locals[0]!)], 2),
      ...out.char(58),
      ...out.uint([get(locals[1]!)], 2),
      ...out.char(58),
      ...out.uint([get(locals[2]!)], 2),
      ...out.char(46),
      get(out.pos),
      set(floor),
      ...out.uint([get(locals[3]!)], 3),
      ...out.uint([get(locals[4]!)], 3),
      ...out.uint([get(locals[5]!)], 3),
      ...out.trimZeros(floor),
      // Nothing left after the '.': drop it too.
      ...when([get(out.pos), get(floor), { op: "i32.eq" }], [get(floor), i32c(1), { op: "i32.sub" }, set(out.pos)]),
      ...out.finish(),
    ];
  });
}

/** `local += local2 / 1000; local2 %= 1000` on magnitudes. */
function carryThousands(high: number, low: number): Instr[] {
  return [
    get(high),
    get(low),
    i64c(1000n),
    { op: "i64.div_u" },
    { op: "i64.add" },
    set(high),
    get(low),
    i64c(1000n),
    { op: "i64.rem_u" },
    set(low),
  ];
}

/** OR of the given i64 locals, compared against zero (i32 on the stack). */
function anyNonZero(locals: readonly number[]): Instr[] {
  const code: Instr[] = [get(locals[0]!)];
  for (const l of locals.slice(1)) code.push(get(l), { op: "i64.or" });
  code.push(i64c(0n), { op: "i64.ne" });
  return code;
}

export function ensureDurationToString(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_duration_to_string", fields(10), [anyStringType(ctx)], (f) => {
    const { locals: v, code } = truncParams(ctx, f, 10, false);
    const out = new OutBuf(ctx, f);
    const negative = f.local("negative", I32);
    const scratch = f.local("absScratch", I64);
    const frac = f.local("frac", I64);
    const floor = f.local("fracFloor", I32);
    const body: Instr[] = [...code, i32c(0), set(negative)];
    // Sign of the first non-zero field (fields never mix signs once validated).
    for (let k = 9; k >= 0; k--) {
      body.push(
        ...when([get(v[k]!), i64c(0n), { op: "i64.ne" }], [get(v[k]!), i64c(0n), { op: "i64.lt_s" }, set(negative)]),
      );
    }
    for (const l of v) body.push(get(l), ...absI64(scratch), set(l));
    // BalanceTimeDuration of seconds..nanoseconds into whole seconds + fraction.
    body.push(...carryThousands(v[8]!, v[9]!), ...carryThousands(v[7]!, v[8]!), ...carryThousands(v[6]!, v[7]!));
    body.push(...out.alloc(224), ...when([get(negative)], out.char(45)), ...out.char(80));
    const dateUnits: [number, number][] = [
      [0, 89],
      [1, 77],
      [2, 87],
      [3, 68],
    ];
    for (const [k, letter] of dateUnits) {
      body.push(...when([get(v[k]!), i64c(0n), { op: "i64.ne" }], [...out.uint([get(v[k]!)], 1), ...out.char(letter)]));
    }
    const secondsNonZero = anyNonZero([v[6]!, v[7]!, v[8]!, v[9]!]);
    const zeroMinutesAndHigher = [...anyNonZero(v.slice(0, 6)), { op: "i32.eqz" } as const];
    const secondsPart: Instr[] = [
      ...out.uint([get(v[6]!)], 1),
      get(v[7]!),
      i64c(1000000n),
      { op: "i64.mul" },
      get(v[8]!),
      i64c(1000n),
      { op: "i64.mul" },
      { op: "i64.add" },
      get(v[9]!),
      { op: "i64.add" },
      set(frac),
      ...when(
        [get(frac), i64c(0n), { op: "i64.ne" }],
        [...out.char(46), get(out.pos), set(floor), ...out.uint([get(frac)], 9), ...out.trimZeros(floor)],
      ),
      ...out.char(83),
    ];
    body.push(
      ...when(
        [...anyNonZero([v[4]!, v[5]!]), ...secondsNonZero, { op: "i32.or" }, ...zeroMinutesAndHigher, { op: "i32.or" }],
        [
          ...out.char(84),
          ...when([get(v[4]!), i64c(0n), { op: "i64.ne" }], [...out.uint([get(v[4]!)], 1), ...out.char(72)]),
          ...when([get(v[5]!), i64c(0n), { op: "i64.ne" }], [...out.uint([get(v[5]!)], 1), ...out.char(77)]),
          ...when([...secondsNonZero, ...zeroMinutesAndHigher, { op: "i32.or" }], secondsPart),
        ],
      ),
      ...out.finish(),
    );
    return body;
  });
}

export function ensureDurationSign(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_duration_sign", fields(10), [F64], (f) => {
    const result = f.local("sign", F64);
    const body: Instr[] = [f64c(0), set(result)];
    for (let k = 9; k >= 0; k--) {
      body.push(
        ...when([get(k), f64c(0), { op: "f64.gt" }], [f64c(1), set(result)]),
        ...when([get(k), f64c(0), { op: "f64.lt" }], [f64c(-1), set(result)]),
      );
    }
    body.push(get(result));
    return body;
  });
}
