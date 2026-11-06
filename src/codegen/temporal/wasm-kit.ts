// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7012) Small instruction kit shared by the Wasm-native Temporal helpers.
 *
 * The #661 lowering (`../temporal-native.ts`) keeps PlainDate / PlainTime /
 * Duration as f64 field structs and used to call ten `env::__temporal_*` host
 * functions for everything that touches a string or a calendar carry. Under the
 * native regime (native-first, standalone, WASI — every build whose strings are
 * the WasmGC `$NativeString`) those helpers are now defined IN the module. This
 * file holds the pieces they share: local allocation, a cursor scanner over a
 * flattened `$NativeString`, decimal output, and proleptic-Gregorian day math.
 *
 * Every helper is defined at most once per module and registered in
 * `ctx.funcMap` under its name, so `ensureLateImport` resolves the in-module
 * function instead of minting a host import (the same contract the in-module
 * `__new_<Kind>` error constructors rely on).
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import type { buildThrowJsErrorInstrs, JsErrorKind } from "../js-errors.js";
import type { ensureNativeStringHelpers } from "../native-strings.js";
import { addFuncType } from "../registry/types.js";

export const I32: ValType = { kind: "i32" };
export const I64: ValType = { kind: "i64" };
export const F64: ValType = { kind: "f64" };
export const EXTERNREF: ValType = { kind: "externref" };

export const get = (index: number): Instr => ({ op: "local.get", index });
export const set = (index: number): Instr => ({ op: "local.set", index });
export const i32c = (value: number): Instr => ({ op: "i32.const", value });
export const i64c = (value: bigint): Instr => ({ op: "i64.const", value });
export const f64c = (value: number): Instr => ({ op: "f64.const", value });
export const call = (funcIdx: number): Instr => ({ op: "call", funcIdx });

/** `if (<cond>) { then } [else { els }]`, no result. */
export function when(cond: readonly Instr[], then: Instr[], els?: Instr[]): Instr[] {
  return [
    ...cond,
    els
      ? { op: "if", blockType: { kind: "empty" }, then, else: els }
      : { op: "if", blockType: { kind: "empty" }, then },
  ];
}

/** `<cond> ? a : b` producing one value of `type`. */
export function choose(cond: readonly Instr[], type: ValType, a: Instr[], b: Instr[]): Instr[] {
  return [...cond, { op: "if", blockType: { kind: "val", type }, then: a, else: b }];
}

/** Locals of one helper under construction (indices continue after the params). */
export class HelperFrame {
  readonly locals: { name: string; type: ValType }[] = [];
  constructor(readonly params: readonly ValType[]) {}
  local(name: string, type: ValType): number {
    this.locals.push({ name, type });
    return this.params.length + this.locals.length - 1;
  }
}

/**
 * Define the helper `name` once. `build` runs BEFORE this helper's own handle is
 * minted, so every dependency it pulls in (sub-helpers, error constructors,
 * message constants) is fully registered first.
 */
export function defineHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  build: (frame: HelperFrame) => Instr[],
): number {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const frame = new HelperFrame(params);
  const body = build(frame);
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    typeIdx,
    name,
    locals: frame.locals,
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * The two codegen services the helpers need from the main codegen graph. They
 * are INJECTED by the caller (`temporal-native.ts`) rather than imported, so
 * this directory stays outside the codegen import cycle (`check-import-cycles`).
 */
export interface TemporalHelperServices {
  readonly throwJsError: typeof buildThrowJsErrorInstrs;
  readonly ensureNativeStringHelpers: typeof ensureNativeStringHelpers;
}

const servicesByContext = new WeakMap<CodegenContext, TemporalHelperServices>();

/** Bind the services for one module's codegen context. */
export function bindTemporalHelperServices(ctx: CodegenContext, services: TemporalHelperServices): void {
  servicesByContext.set(ctx, services);
}

function servicesOf(ctx: CodegenContext): TemporalHelperServices {
  const services = servicesByContext.get(ctx);
  if (!services) throw new Error("#7012: Temporal helper services were not bound for this codegen context");
  return services;
}

/** Terminal throw of a real `<kind>` instance (in-module constructor on host-free builds). */
export function throwInstrs(ctx: CodegenContext, kind: JsErrorKind, message: string): Instr[] {
  return servicesOf(ctx).throwJsError(ctx, kind, message);
}

/** The `$NativeString` type indices, after making sure the string runtime exists. */
export function nativeStringTypes(ctx: CodegenContext): {
  str: number;
  data: number;
  anyStr: number;
  flatten: number;
} {
  servicesOf(ctx).ensureNativeStringHelpers(ctx);
  return {
    str: ctx.nativeStrTypeIdx,
    data: ctx.nativeStrDataTypeIdx,
    anyStr: ctx.anyStrTypeIdx,
    flatten: ctx.nativeStrHelpers.get("__str_flatten")!,
  };
}

/** The value type a native string helper returns. */
export function anyStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: nativeStringTypes(ctx).anyStr };
}

/**
 * `__temporal_native_trunc(f64) -> i64`: the host helpers' `_temporalTrunc` —
 * a non-finite value reads as 0, anything else truncates toward zero.
 */
export function ensureTruncHelper(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_native_trunc", [F64], [I64], () => [
    get(0),
    get(0),
    { op: "f64.sub" },
    f64c(0),
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: I64 },
      then: [get(0), { op: "i64.trunc_sat_f64_s" }],
      else: [i64c(0n)],
    },
  ]);
}

/** `|v|` of the i64 on the stack top, via a scratch local. */
export function absI64(scratch: number): Instr[] {
  return [
    set(scratch),
    i64c(0n),
    get(scratch),
    { op: "i64.sub" },
    get(scratch),
    get(scratch),
    i64c(0n),
    { op: "i64.lt_s" },
    { op: "select" },
  ];
}

/**
 * `__temporal_native_put_uint(buf, pos, v: i64, minWidth) -> pos'`: write the
 * unsigned decimal digits of `v`, zero-padded to at least `minWidth`, at `pos`.
 */
export function ensurePutUintHelper(ctx: CodegenContext): number {
  const { data } = nativeStringTypes(ctx);
  const BUF = 0;
  const POS = 1;
  const V = 2;
  const WIDTH = 3;
  return defineHelper(
    ctx,
    "__temporal_native_put_uint",
    [{ kind: "ref", typeIdx: data }, I32, I64, I32],
    [I32],
    (f) => {
      const n = f.local("n", I32);
      const t = f.local("t", I64);
      const k = f.local("k", I32);
      return [
        i32c(1),
        set(n),
        get(V),
        set(t),
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: when(
            [get(t), i64c(10n), { op: "i64.ge_u" }],
            [
              get(t),
              i64c(10n),
              { op: "i64.div_u" },
              set(t),
              get(n),
              i32c(1),
              { op: "i32.add" },
              set(n),
              { op: "br", depth: 1 },
            ],
          ),
        },
        ...when([get(n), get(WIDTH), { op: "i32.lt_s" }], [get(WIDTH), set(n)]),
        get(V),
        set(t),
        get(POS),
        get(n),
        { op: "i32.add" },
        set(k),
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(k),
            i32c(1),
            { op: "i32.sub" },
            set(k),
            get(BUF),
            get(k),
            get(t),
            i64c(10n),
            { op: "i64.rem_u" },
            { op: "i32.wrap_i64" },
            i32c(48),
            { op: "i32.add" },
            { op: "array.set", typeIdx: data },
            get(t),
            i64c(10n),
            { op: "i64.div_u" },
            set(t),
            get(k),
            get(POS),
            { op: "i32.gt_s" },
            { op: "br_if", depth: 0 },
          ],
        },
        get(POS),
        get(n),
        { op: "i32.add" },
      ];
    },
  );
}

/** A fixed-capacity i16 output buffer with a write cursor, for the formatters. */
export class OutBuf {
  readonly buf: number;
  readonly pos: number;
  private readonly putUint: number;
  private readonly dataType: number;
  private readonly strType: number;
  constructor(ctx: CodegenContext, frame: HelperFrame) {
    const types = nativeStringTypes(ctx);
    this.dataType = types.data;
    this.strType = types.str;
    this.putUint = ensurePutUintHelper(ctx);
    this.buf = frame.local("buf", { kind: "ref", typeIdx: types.data });
    this.pos = frame.local("pos", I32);
  }
  alloc(capacity: number): Instr[] {
    return [i32c(capacity), { op: "array.new_default", typeIdx: this.dataType }, set(this.buf), i32c(0), set(this.pos)];
  }
  char(code: number): Instr[] {
    return [
      get(this.buf),
      get(this.pos),
      i32c(code),
      { op: "array.set", typeIdx: this.dataType },
      get(this.pos),
      i32c(1),
      { op: "i32.add" },
      set(this.pos),
    ];
  }
  /** Write the code unit produced by `code` (an i32). */
  charOf(code: Instr[]): Instr[] {
    return [
      get(this.buf),
      get(this.pos),
      ...code,
      { op: "array.set", typeIdx: this.dataType },
      get(this.pos),
      i32c(1),
      { op: "i32.add" },
      set(this.pos),
    ];
  }
  /** Write the unsigned i64 produced by `value`, padded to `width` digits. */
  uint(value: Instr[], width: number): Instr[] {
    return [get(this.buf), get(this.pos), ...value, i32c(width), call(this.putUint), set(this.pos)];
  }
  /** Drop trailing `'0'` code units while the cursor is past `floor`. */
  trimZeros(floor: number): Instr[] {
    return [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: when(
          choose(
            [get(this.pos), get(floor), { op: "i32.gt_s" }],
            I32,
            [
              get(this.buf),
              get(this.pos),
              i32c(1),
              { op: "i32.sub" },
              { op: "array.get_u", typeIdx: this.dataType },
              i32c(48),
              { op: "i32.eq" },
            ],
            [i32c(0)],
          ),
          [get(this.pos), i32c(1), { op: "i32.sub" }, set(this.pos), { op: "br", depth: 1 }],
        ),
      },
    ];
  }
  /** Leave the finished `$NativeString` on the stack. */
  finish(): Instr[] {
    return [get(this.pos), i32c(0), get(this.buf), { op: "struct.new", typeIdx: this.strType }];
  }
}

/**
 * `__temporal_native_days_from_civil(y, m, d) -> i64`: days since 1970-01-01 of
 * a proleptic-Gregorian date (H. Hinnant's `days_from_civil`). `d` may overflow
 * the month; the arithmetic carries it like `Date.UTC` does.
 */
export function ensureDaysFromCivilHelper(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_native_days_from_civil", [I64, I64, I64], [I64], (f) => {
    const [Y, M, D] = [0, 1, 2];
    const era = f.local("era", I64);
    const yoe = f.local("yoe", I64);
    const doy = f.local("doy", I64);
    return [
      // y -= m <= 2
      get(Y),
      get(M),
      i64c(2n),
      { op: "i64.le_s" },
      { op: "i64.extend_i32_u" },
      { op: "i64.sub" },
      set(Y),
      // era = (y >= 0 ? y : y - 399) / 400
      ...choose([get(Y), i64c(0n), { op: "i64.ge_s" }], I64, [get(Y)], [get(Y), i64c(399n), { op: "i64.sub" }]),
      i64c(400n),
      { op: "i64.div_s" },
      set(era),
      // yoe = y - era * 400
      get(Y),
      get(era),
      i64c(400n),
      { op: "i64.mul" },
      { op: "i64.sub" },
      set(yoe),
      // doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1
      i64c(153n),
      ...choose(
        [get(M), i64c(2n), { op: "i64.gt_s" }],
        I64,
        [get(M), i64c(3n), { op: "i64.sub" }],
        [get(M), i64c(9n), { op: "i64.add" }],
      ),
      { op: "i64.mul" },
      i64c(2n),
      { op: "i64.add" },
      i64c(5n),
      { op: "i64.div_s" },
      get(D),
      { op: "i64.add" },
      i64c(1n),
      { op: "i64.sub" },
      set(doy),
      // era * 146097 + (yoe * 365 + yoe / 4 - yoe / 100 + doy) - 719468
      get(era),
      i64c(146097n),
      { op: "i64.mul" },
      get(yoe),
      i64c(365n),
      { op: "i64.mul" },
      get(yoe),
      i64c(4n),
      { op: "i64.div_s" },
      { op: "i64.add" },
      get(yoe),
      i64c(100n),
      { op: "i64.div_s" },
      { op: "i64.sub" },
      get(doy),
      { op: "i64.add" },
      { op: "i64.add" },
      i64c(719468n),
      { op: "i64.sub" },
    ];
  });
}

/**
 * `__temporal_native_civil_field(z, which) -> i64`: field `which` (0 year,
 * 1 month, 2 day) of the proleptic-Gregorian date `z` days after 1970-01-01.
 */
export function ensureCivilFieldHelper(ctx: CodegenContext): number {
  return defineHelper(ctx, "__temporal_native_civil_field", [I64, I32], [I64], (f) => {
    const [Z, WHICH] = [0, 1];
    const era = f.local("era", I64);
    const doe = f.local("doe", I64);
    const yoe = f.local("yoe", I64);
    const doy = f.local("doy", I64);
    const mp = f.local("mp", I64);
    const m = f.local("m", I64);
    return [
      get(Z),
      i64c(719468n),
      { op: "i64.add" },
      set(Z),
      ...choose([get(Z), i64c(0n), { op: "i64.ge_s" }], I64, [get(Z)], [get(Z), i64c(146096n), { op: "i64.sub" }]),
      i64c(146097n),
      { op: "i64.div_s" },
      set(era),
      get(Z),
      get(era),
      i64c(146097n),
      { op: "i64.mul" },
      { op: "i64.sub" },
      set(doe),
      // yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365
      get(doe),
      get(doe),
      i64c(1460n),
      { op: "i64.div_s" },
      { op: "i64.sub" },
      get(doe),
      i64c(36524n),
      { op: "i64.div_s" },
      { op: "i64.add" },
      get(doe),
      i64c(146096n),
      { op: "i64.div_s" },
      { op: "i64.sub" },
      i64c(365n),
      { op: "i64.div_s" },
      set(yoe),
      // doy = doe - (365*yoe + yoe/4 - yoe/100)
      get(doe),
      get(yoe),
      i64c(365n),
      { op: "i64.mul" },
      get(yoe),
      i64c(4n),
      { op: "i64.div_s" },
      { op: "i64.add" },
      get(yoe),
      i64c(100n),
      { op: "i64.div_s" },
      { op: "i64.sub" },
      { op: "i64.sub" },
      set(doy),
      // mp = (5*doy + 2) / 153
      get(doy),
      i64c(5n),
      { op: "i64.mul" },
      i64c(2n),
      { op: "i64.add" },
      i64c(153n),
      { op: "i64.div_s" },
      set(mp),
      // m = mp < 10 ? mp + 3 : mp - 9
      ...choose(
        [get(mp), i64c(10n), { op: "i64.lt_s" }],
        I64,
        [get(mp), i64c(3n), { op: "i64.add" }],
        [get(mp), i64c(9n), { op: "i64.sub" }],
      ),
      set(m),
      ...choose(
        [get(WHICH), i32c(1), { op: "i32.eq" }],
        I64,
        [get(m)],
        choose(
          [get(WHICH), i32c(2), { op: "i32.eq" }],
          I64,
          // d = doy - (153*mp + 2)/5 + 1
          [
            get(doy),
            get(mp),
            i64c(153n),
            { op: "i64.mul" },
            i64c(2n),
            { op: "i64.add" },
            i64c(5n),
            { op: "i64.div_s" },
            { op: "i64.sub" },
            i64c(1n),
            { op: "i64.add" },
          ],
          // y = yoe + era*400 + (m <= 2)
          [
            get(yoe),
            get(era),
            i64c(400n),
            { op: "i64.mul" },
            { op: "i64.add" },
            get(m),
            i64c(2n),
            { op: "i64.le_s" },
            { op: "i64.extend_i32_u" },
            { op: "i64.add" },
          ],
        ),
      ),
    ];
  });
}

/** i32 on the stack: is `year` (i64 local) a proleptic-Gregorian leap year? */
export function isLeapYear(year: number): Instr[] {
  return [
    get(year),
    i64c(4n),
    { op: "i64.rem_s" },
    { op: "i64.eqz" },
    get(year),
    i64c(100n),
    { op: "i64.rem_s" },
    i64c(0n),
    { op: "i64.ne" },
    get(year),
    i64c(400n),
    { op: "i64.rem_s" },
    { op: "i64.eqz" },
    { op: "i32.or" },
    { op: "i32.and" },
  ];
}

/** i64 on the stack: ISODaysInMonth(year, month) for i64 locals (month 1..12). */
export function daysInMonth(year: number, month: number): Instr[] {
  return choose(
    [get(month), i64c(2n), { op: "i64.eq" }],
    I64,
    choose(isLeapYear(year), I64, [i64c(29n)], [i64c(28n)]),
    choose(
      [
        get(month),
        i64c(4n),
        { op: "i64.eq" },
        get(month),
        i64c(6n),
        { op: "i64.eq" },
        { op: "i32.or" },
        get(month),
        i64c(9n),
        { op: "i64.eq" },
        { op: "i32.or" },
        get(month),
        i64c(11n),
        { op: "i64.eq" },
        { op: "i32.or" },
      ],
      I64,
      [i64c(30n)],
      [i64c(31n)],
    ),
  );
}
