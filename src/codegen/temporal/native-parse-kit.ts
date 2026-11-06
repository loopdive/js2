// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7012) Cursor scanner and the shared RFC 9557 / ISO 8601 grammar pieces for
 * the Wasm-native Temporal string parsers (`native-parse-iso.ts`,
 * `native-parse-duration.ts`).
 *
 * Style: one `fail` flag per parse. Every generator here is self-guarding — it
 * does nothing once `fail` is set — so grammar steps compose as a flat
 * sequence and a mismatch anywhere short-circuits the rest. The grammar is the
 * one the host parser in `runtime.ts` encodes as regular expressions (see the
 * `_t*Src` fragments there), applied as a FULL match of the text before the
 * first `[`.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import {
  I32,
  I64,
  call,
  choose,
  defineHelper,
  get,
  i32c,
  i64c,
  nativeStringTypes,
  set,
  throwInstrs,
  when,
  type HelperFrame,
} from "./wasm-kit.js";

const C_DIGIT0 = 48;
const C_MINUS = 45;
const C_PLUS = 43;
const C_COLON = 58;
const C_DOT = 46;
const C_COMMA = 44;
const C_LBRACKET = 91;
const C_RBRACKET = 93;
const C_BANG = 33;

/** The code unit of an ASCII character, for readable call sites. */
export const ch = (s: string): number => s.charCodeAt(0);

/** Locals of one scan: the flattened data array, cursor, limit, current char, fail flag. */
export class Scanner {
  readonly data: number;
  readonly i: number;
  readonly end: number;
  readonly c: number;
  readonly fail: number;
  readonly acc: number;
  constructor(
    f: HelperFrame,
    readonly dataType: number,
    reuse?: { data: number; i: number; end: number },
  ) {
    this.data = reuse?.data ?? f.local("data", { kind: "ref", typeIdx: dataType });
    this.i = reuse?.i ?? f.local("i", I32);
    this.end = reuse?.end ?? f.local("end", I32);
    this.c = f.local("c", I32);
    this.fail = f.local("fail", I32);
    this.acc = f.local("acc", I64);
  }

  /** `if (!fail) { body }` */
  guard(body: Instr[]): Instr[] {
    return when([get(this.fail), { op: "i32.eqz" }], body);
  }
  setFail(): Instr[] {
    return [i32c(1), set(this.fail)];
  }
  /** c := i < end ? data[i] : -1 */
  load(): Instr[] {
    return [
      ...choose(
        [get(this.i), get(this.end), { op: "i32.lt_s" }],
        I32,
        [get(this.data), get(this.i), { op: "array.get_u", typeIdx: this.dataType }],
        [i32c(-1)],
      ),
      set(this.c),
    ];
  }
  advance(): Instr[] {
    return [get(this.i), i32c(1), { op: "i32.add" }, set(this.i)];
  }
  /** i32: does `c` equal one of `codes`? */
  cIs(...codes: number[]): Instr[] {
    const code: Instr[] = [];
    codes.forEach((value, k) => {
      code.push(get(this.c), i32c(value), { op: "i32.eq" });
      if (k > 0) code.push({ op: "i32.or" });
    });
    return code;
  }
  /** i32: is `c` an ASCII digit? */
  cIsDigit(): Instr[] {
    return [get(this.c), i32c(C_DIGIT0), { op: "i32.sub" }, i32c(10), { op: "i32.lt_u" }];
  }
  /** Load `c`; if it is one of `codes`, consume it and run `then`, else run `els`. */
  ifChar(codes: number[], then: Instr[], els: Instr[] = []): Instr[] {
    return this.guard([...this.load(), ...when(this.cIs(...codes), [...this.advance(), ...then], els)]);
  }
  /** Load `c`; run `then` if it is a digit (nothing consumed), else `els`. */
  ifDigit(then: Instr[], els: Instr[] = []): Instr[] {
    return this.guard([...this.load(), ...when(this.cIsDigit(), then, els)]);
  }
  /** Consume one of `codes` or fail. */
  expect(...codes: number[]): Instr[] {
    return this.ifChar(codes, [], this.setFail());
  }
  /** Fail unless the cursor sits exactly at `end`. */
  atEnd(): Instr[] {
    return this.guard(when([get(this.i), get(this.end), { op: "i32.ne" }], this.setFail()));
  }
  /** Read exactly `n` digits into the i64 local `dest`, or fail. */
  digits(n: number, dest: number): Instr[] {
    const code: Instr[] = [i64c(0n), set(this.acc)];
    for (let k = 0; k < n; k++) {
      code.push(
        ...this.guard([
          ...this.load(),
          ...when(
            this.cIsDigit(),
            [
              get(this.acc),
              i64c(10n),
              { op: "i64.mul" },
              get(this.c),
              i32c(C_DIGIT0),
              { op: "i32.sub" },
              { op: "i64.extend_i32_u" },
              { op: "i64.add" },
              set(this.acc),
              ...this.advance(),
            ],
            this.setFail(),
          ),
        ]),
      );
    }
    code.push(get(this.acc), set(dest));
    return code;
  }
  /** Two digits into `dest`, failing unless `lo <= value <= hi`. */
  field2(dest: number, lo: number, hi: number): Instr[] {
    return [
      ...this.digits(2, dest),
      ...this.guard(
        when(
          [
            get(dest),
            i64c(BigInt(lo)),
            { op: "i64.lt_s" },
            get(dest),
            i64c(BigInt(hi)),
            { op: "i64.gt_s" },
            { op: "i32.or" },
          ],
          this.setFail(),
        ),
      ),
    ];
  }
  /**
   * Optional fraction `[.,]\d{1,9}`: when present, `dest` (i64) receives the
   * digits scaled to nine places (nanoseconds) and `seen` (i32) is set. A tenth
   * digit is left unconsumed, so the caller's end check rejects it.
   */
  fraction(dest: number, seen: number, count: number): Instr[] {
    return this.ifChar(
      [C_DOT, C_COMMA],
      [
        i64c(0n),
        set(dest),
        i32c(0),
        set(count),
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            ...this.load(),
            ...when(
              [...this.cIsDigit(), get(count), i32c(9), { op: "i32.lt_s" }, { op: "i32.and" }],
              [
                get(dest),
                i64c(10n),
                { op: "i64.mul" },
                get(this.c),
                i32c(C_DIGIT0),
                { op: "i32.sub" },
                { op: "i64.extend_i32_u" },
                { op: "i64.add" },
                set(dest),
                get(count),
                i32c(1),
                { op: "i32.add" },
                set(count),
                ...this.advance(),
                { op: "br", depth: 1 },
              ],
            ),
          ],
        },
        ...when([get(count), { op: "i32.eqz" }], this.setFail(), [
          i32c(1),
          set(seen),
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: when(
              [get(count), i32c(9), { op: "i32.lt_s" }],
              [
                get(dest),
                i64c(10n),
                { op: "i64.mul" },
                set(dest),
                get(count),
                i32c(1),
                { op: "i32.add" },
                set(count),
                { op: "br", depth: 1 },
              ],
            ),
          },
        ]),
      ],
    );
  }
}

/** Result locals of the date / time grammar pieces. */
export interface IsoFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction: number;
  /** i32: the year was written as `-000000` (an early error). */
  negativeZeroYear: number;
  /** i32: the UTC designator `Z` was present. */
  utc: number;
  /** scratch */
  sign: number;
  sixDigits: number;
  fracSeen: number;
  fracCount: number;
  tmp: number;
}

export function isoFieldLocals(f: HelperFrame): IsoFields {
  return {
    year: f.local("year", I64),
    month: f.local("month", I64),
    day: f.local("day", I64),
    hour: f.local("hour", I64),
    minute: f.local("minute", I64),
    second: f.local("second", I64),
    fraction: f.local("fraction", I64),
    negativeZeroYear: f.local("negZeroYear", I32),
    utc: f.local("utc", I32),
    sign: f.local("sign", I32),
    sixDigits: f.local("sixDigits", I32),
    fracSeen: f.local("fracSeen", I32),
    fracCount: f.local("fracCount", I32),
    tmp: f.local("tmp", I64),
  };
}

/** Zero every time-of-day result and the Z flag. */
export function resetTime(v: IsoFields): Instr[] {
  return [
    i64c(0n),
    set(v.hour),
    i64c(0n),
    set(v.minute),
    i64c(0n),
    set(v.second),
    i64c(0n),
    set(v.fraction),
    i32c(0),
    set(v.utc),
  ];
}

/** DateYear: `\d{4}` or `[+-]\d{6}` into `dest`, recording sign / width. */
export function scanYear(s: Scanner, v: IsoFields, dest: number): Instr[] {
  return [
    i32c(0),
    set(v.sign),
    i32c(0),
    set(v.sixDigits),
    ...s.guard([
      ...s.load(),
      ...when(
        s.cIs(C_PLUS, C_MINUS),
        [...s.cIs(C_MINUS), set(v.sign), i32c(1), set(v.sixDigits), ...s.advance(), ...s.digits(6, dest)],
        s.digits(4, dest),
      ),
    ]),
  ];
}

/** `DateExt | DateBasic` → year / month / day (+ the `-000000` flag). */
export function scanDate(s: Scanner, v: IsoFields): Instr[] {
  return [
    ...scanYear(s, v, v.year),
    ...s.guard([
      get(v.sign),
      get(v.year),
      { op: "i64.eqz" },
      { op: "i32.and" },
      set(v.negativeZeroYear),
      ...when([get(v.sign)], [i64c(0n), get(v.year), { op: "i64.sub" }, set(v.year)]),
    ]),
    ...s.ifChar(
      [C_MINUS],
      [...s.field2(v.month, 1, 12), ...s.expect(C_MINUS), ...s.field2(v.day, 1, 31)],
      [...s.field2(v.month, 1, 12), ...s.field2(v.day, 1, 31)],
    ),
  ];
}

/** `TimeExt | TimeBasic` → hour / minute / second / fraction. */
export function scanTime(s: Scanner, v: IsoFields): Instr[] {
  const seconds = (): Instr[] => [...s.field2(v.second, 0, 60), ...s.fraction(v.fraction, v.fracSeen, v.fracCount)];
  return [
    ...s.field2(v.hour, 0, 23),
    ...s.ifChar(
      [C_COLON],
      [...s.field2(v.minute, 0, 59), ...s.ifChar([C_COLON], seconds())],
      s.guard(when(s.cIsDigit(), [...s.field2(v.minute, 0, 59), ...s.ifDigit(seconds())])),
    ),
  ];
}

/** Optional `UTCOffset[+SubMinutePrecision] | [Zz]`; the offset value is ignored. */
export function scanOffsetOrZ(s: Scanner, v: IsoFields): Instr[] {
  const subMinute = (): Instr[] => [...s.field2(v.tmp, 0, 59), ...s.fraction(v.tmp, v.fracSeen, v.fracCount)];
  return s.ifChar(
    [ch("Z"), ch("z")],
    [i32c(1), set(v.utc)],
    s.guard(
      when(s.cIs(C_PLUS, C_MINUS), [
        ...s.advance(),
        ...s.field2(v.tmp, 0, 23),
        ...s.ifChar(
          [C_COLON],
          [...s.field2(v.tmp, 0, 59), ...s.ifChar([C_COLON], subMinute())],
          s.guard(when(s.cIsDigit(), [...s.field2(v.tmp, 0, 59), ...s.ifDigit(subMinute())])),
        ),
      ]),
    ),
  );
}

/**
 * Prologue shared by every parser: the argument must be a String (ToTemporal*
 * accepts only Objects — lowered at compile time — or Strings), then it is
 * flattened; `data` / `i` / `end` cover its code units. Returns the code and
 * the local holding the full length's end index.
 */
export function stringPrologue(ctx: CodegenContext, f: HelperFrame, s: Scanner, what: string): Instr[] {
  const types = nativeStringTypes(ctx);
  const any = f.local("item", { kind: "anyref" });
  const flat = f.local("flat", { kind: "ref", typeIdx: types.str });
  const typeError = throwInstrs(ctx, "TypeError", `${what} must be a string or property bag`);
  return [
    get(0),
    { op: "any.convert_extern" },
    set(any),
    ...when([get(any), { op: "ref.test", typeIdx: types.anyStr }, { op: "i32.eqz" }], typeError),
    get(any),
    { op: "ref.cast", typeIdx: types.anyStr },
    call(types.flatten),
    set(flat),
    get(flat),
    { op: "struct.get", typeIdx: types.str, fieldIdx: 2 },
    set(s.data),
    get(flat),
    { op: "struct.get", typeIdx: types.str, fieldIdx: 1 },
    set(s.i),
    get(flat),
    { op: "struct.get", typeIdx: types.str, fieldIdx: 0 },
    get(s.i),
    { op: "i32.add" },
    set(s.end),
  ];
}

/** Set `dest` to the index of the first `[` in data[i .. limit) (or `limit`). */
export function findBracket(s: Scanner, dest: number, limit: number): Instr[] {
  return [
    get(s.i),
    set(dest),
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            get(dest),
            get(limit),
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            get(s.data),
            get(dest),
            { op: "array.get_u", typeIdx: s.dataType },
            i32c(C_LBRACKET),
            { op: "i32.eq" },
            { op: "br_if", depth: 1 },
            get(dest),
            i32c(1),
            { op: "i32.add" },
            set(dest),
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/** i32 on the stack: the field selector param (f64) truncated like the host does. */
export function fieldSelector(truncIdx: number, param: number): Instr[] {
  return [get(param), call(truncIdx), { op: "i32.wrap_i64" }];
}

/** Pick `values[which]` (i64 locals) as f64, 0 when out of range. */
export function selectFieldF64(which: number, values: readonly number[]): Instr[] {
  let pick: Instr[] = [{ op: "f64.const", value: 0 }];
  for (let k = values.length - 1; k >= 0; k--) {
    pick = choose(
      [get(which), i32c(k), { op: "i32.eq" }],
      { kind: "f64" },
      [get(values[k]!), { op: "f64.convert_i64_s" }],
      pick,
    );
  }
  return pick;
}

// ---------------------------------------------------------------------------
// Bracketed suffix: `TimeZoneAnnotation? Annotation*`
// ---------------------------------------------------------------------------

/** The CLDR / BCP 47 calendar types the host parser accepts (ASCII case-insensitive). */
const KNOWN_CALENDARS = [
  "iso8601",
  "buddhist",
  "chinese",
  "coptic",
  "dangi",
  "ethioaa",
  "ethiopic",
  "ethiopic-amete-alem",
  "gregory",
  "hebrew",
  "indian",
  "islamic",
  "islamic-civil",
  "islamic-rgsa",
  "islamic-tbla",
  "islamic-umalqura",
  "islamicc",
  "japanese",
  "persian",
  "roc",
] as const;

/** i32: is `c` in one of the inclusive code ranges? */
function cInRanges(s: Scanner, ranges: readonly (readonly [string, string])[], extra: readonly string[]): Instr[] {
  const code: Instr[] = [];
  let first = true;
  for (const [lo, hi] of ranges) {
    code.push(get(s.c), i32c(ch(lo)), { op: "i32.sub" }, i32c(ch(hi) - ch(lo) + 1), { op: "i32.lt_u" });
    if (!first) code.push({ op: "i32.or" });
    first = false;
  }
  for (const e of extra) {
    code.push(get(s.c), i32c(ch(e)), { op: "i32.eq" });
    if (!first) code.push({ op: "i32.or" });
    first = false;
  }
  return code;
}

const ALNUM: readonly (readonly [string, string])[] = [
  ["a", "z"],
  ["A", "Z"],
  ["0", "9"],
];

/** Consume a run of chars matching the class (possibly empty). */
function scanRun(s: Scanner, cls: () => Instr[]): Instr[] {
  return s.guard([
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [...s.load(), ...when(cls(), [...s.advance(), { op: "br", depth: 1 }])],
    },
  ]);
}

/** Consume one char of the class or fail. */
function scanOne(s: Scanner, cls: () => Instr[]): Instr[] {
  return s.guard([...s.load(), ...when(cls(), s.advance(), s.setFail())]);
}

/**
 * Annotation ::: `!`? AnnotationKey `=` AnnotationValue, scanned from `i` to
 * `end`; `crit` / `keyStart` / `valStart` record where the pieces were.
 */
function scanAnnotation(s: Scanner, crit: number, keyStart: number, valStart: number): Instr[] {
  const valueComponent = (): Instr[] => [
    ...scanOne(s, () => cInRanges(s, ALNUM, [])),
    ...scanRun(s, () => cInRanges(s, ALNUM, [])),
  ];
  return [
    i32c(0),
    set(crit),
    ...s.ifChar([C_BANG], [i32c(1), set(crit)]),
    get(s.i),
    set(keyStart),
    ...scanOne(s, () => cInRanges(s, [["a", "z"]], ["_"])),
    ...scanRun(s, () =>
      cInRanges(
        s,
        [
          ["a", "z"],
          ["0", "9"],
        ],
        ["_", "-"],
      ),
    ),
    ...s.expect(ch("=")),
    get(s.i),
    set(valStart),
    ...valueComponent(),
    ...s.guard([
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: s.ifChar([C_MINUS], [...valueComponent(), { op: "br", depth: 2 }]),
      },
    ]),
    ...s.atEnd(),
  ];
}

/** TimeZoneAnnotation body: `!`? (`[+-]HH(:?MM)?` | IANA name), from `i` to `end`. */
function scanTimeZoneAnnotation(s: Scanner, tmp: number): Instr[] {
  const nameComponent = (): Instr[] => [
    ...scanOne(s, () =>
      cInRanges(
        s,
        [
          ["a", "z"],
          ["A", "Z"],
        ],
        [".", "_"],
      ),
    ),
    ...scanRun(s, () => cInRanges(s, ALNUM, [".", "_", "+", "-"])),
  ];
  return [
    ...s.ifChar([C_BANG], []),
    ...s.ifChar(
      [C_PLUS, C_MINUS],
      [
        ...s.field2(tmp, 0, 23),
        ...s.guard(
          when([get(s.i), get(s.end), { op: "i32.lt_s" }], [...s.ifChar([C_COLON], []), ...s.field2(tmp, 0, 59)]),
        ),
      ],
      [
        ...nameComponent(),
        ...s.guard([
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: s.ifChar([ch("/")], [...nameComponent(), { op: "br", depth: 2 }]),
          },
        ]),
      ],
    ),
    ...s.atEnd(),
  ];
}

/** i32: does data[start .. start+len) equal `name`, ASCII case-insensitively? */
function matchesInsensitive(s: Scanner, start: number, len: number, name: string): Instr[] {
  const chars: Instr[] = [];
  for (let k = 0; k < name.length; k++) {
    const code = ch(name[k]!);
    const letter = code >= ch("a") && code <= ch("z");
    chars.push(get(s.data), get(start), i32c(k), { op: "i32.add" }, { op: "array.get_u", typeIdx: s.dataType });
    if (letter) chars.push(i32c(32), { op: "i32.or" });
    chars.push(i32c(code), { op: "i32.eq" });
    if (k > 0) chars.push({ op: "i32.and" });
  }
  return choose([get(len), i32c(name.length), { op: "i32.eq" }], I32, chars, [i32c(0)]);
}

/**
 * `__temporal_native_check_annotations(data, start, end)`: validate the
 * bracketed suffix data[start..end) the way `_temporalValidateBrackets` does —
 * every bracket well formed, a time-zone annotation only first, a second
 * `u-ca` throws when either is critical, an unknown critical key throws, and
 * the calendar must be a known one. Throws RangeError; returns nothing.
 */
export function ensureAnnotationChecker(ctx: CodegenContext): number {
  const types = nativeStringTypes(ctx);
  const params = [{ kind: "ref" as const, typeIdx: types.data }, I32, I32];
  return defineHelper(ctx, "__temporal_native_check_annotations", params, [], (f) => {
    const [DATA, START, END] = [0, 1, 2];
    const bracketEnd = f.local("bracketEnd", I32);
    const s = new Scanner(f, types.data, {
      data: DATA,
      i: f.local("i", I32),
      end: bracketEnd,
    });
    const pos = f.local("pos", I32);
    const crit = f.local("crit", I32);
    const keyStart = f.local("keyStart", I32);
    const valStart = f.local("valStart", I32);
    const first = f.local("first", I32);
    const calStart = f.local("calStart", I32);
    const calLen = f.local("calLen", I32);
    const calCrit = f.local("calCrit", I32);
    const tmp = f.local("tmp", I64);
    const syntax = throwInstrs(ctx, "RangeError", "invalid annotation in Temporal string");
    const duplicate = throwInstrs(ctx, "RangeError", "duplicate critical calendar annotation in Temporal string");
    const unknownKey = throwInstrs(ctx, "RangeError", "unknown critical annotation key in Temporal string");
    const unknownCal = throwInstrs(ctx, "RangeError", "unknown calendar in Temporal string");
    const keyLen = f.local("keyLen", I32);
    const isUca = matchesInsensitive(s, keyStart, keyLen, "u-ca");
    const known: Instr[] = [];
    KNOWN_CALENDARS.forEach((name, k) => {
      known.push(...matchesInsensitive(s, calStart, calLen, name));
      if (k > 0) known.push({ op: "i32.or" });
    });
    const perBracket: Instr[] = [
      // '[' ... first ']' after it
      get(DATA),
      get(pos),
      { op: "array.get_u", typeIdx: types.data },
      i32c(C_LBRACKET),
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: syntax },
      get(pos),
      i32c(1),
      { op: "i32.add" },
      set(bracketEnd),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...when([get(bracketEnd), get(END), { op: "i32.ge_s" }], syntax),
              get(DATA),
              get(bracketEnd),
              { op: "array.get_u", typeIdx: types.data },
              i32c(C_RBRACKET),
              { op: "i32.eq" },
              { op: "br_if", depth: 1 },
              get(bracketEnd),
              i32c(1),
              { op: "i32.add" },
              set(bracketEnd),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Annotation?
      get(pos),
      i32c(1),
      { op: "i32.add" },
      set(s.i),
      i32c(0),
      set(s.fail),
      ...scanAnnotation(s, crit, keyStart, valStart),
      ...when(
        [get(s.fail), { op: "i32.eqz" }],
        [
          get(valStart),
          get(keyStart),
          { op: "i32.sub" },
          i32c(1),
          { op: "i32.sub" },
          set(keyLen),
          ...when(
            isUca,
            when(
              [get(calStart), i32c(0), { op: "i32.lt_s" }],
              [
                get(valStart),
                set(calStart),
                get(bracketEnd),
                get(valStart),
                { op: "i32.sub" },
                set(calLen),
                get(crit),
                set(calCrit),
              ],
              when([get(crit), get(calCrit), { op: "i32.or" }], duplicate),
            ),
            when([get(crit)], unknownKey),
          ),
        ],
        [
          // Not an annotation: only the FIRST bracket may be a time-zone annotation.
          ...when([get(first), { op: "i32.eqz" }], syntax),
          get(pos),
          i32c(1),
          { op: "i32.add" },
          set(s.i),
          i32c(0),
          set(s.fail),
          ...scanTimeZoneAnnotation(s, tmp),
          ...when([get(s.fail)], syntax),
        ],
      ),
      i32c(0),
      set(first),
      get(bracketEnd),
      i32c(1),
      { op: "i32.add" },
      set(pos),
    ];
    return [
      get(START),
      set(pos),
      i32c(1),
      set(first),
      i32c(-1),
      set(calStart),
      i32c(0),
      set(calLen),
      i32c(0),
      set(calCrit),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              get(pos),
              get(END),
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...perBracket,
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      ...when([get(calStart), i32c(0), { op: "i32.ge_s" }], when([...known, { op: "i32.eqz" }], unknownCal)),
    ];
  });
}
