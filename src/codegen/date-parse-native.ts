// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `Date.parse(str)` / `new Date(str)` for all targets (#2164).
 *
 * `Date.parse` was a NaN stub and `new Date("…")` coerced the string to f64
 * (→ NaN), so neither parsed a date string in any mode — fatal for standalone
 * (no JS host to fall back to). This module emits a WasmGC-native parser for
 * the ECMAScript Date Time String Format (ECMA-262 §21.4.1.32), registered
 * under `ctx.funcMap` as `__date_parse` with signature `(externref) -> f64`
 * (the time value in milliseconds since the epoch, or NaN on a parse failure).
 *
 * Supported grammar (§21.4.1.32):
 *   Date:        YYYY | YYYY-MM | YYYY-MM-DD          (also ±YYYYYY expanded year)
 *   Time:        THH:mm | THH:mm:ss | THH:mm:ss.sss
 *   TimeZone:    Z | ±HH:mm
 *   A date-time string may be `<Date>` or `<Date>T<Time><TimeZone?>`.
 * Per spec, a date-only form is UTC; a date-time form with no timezone is
 * local time — but a standalone/WASI module has no timezone database, so local
 * == UTC (offset 0), matching the deterministic-clock decision in slice 1.
 *
 * The string is read via the same flatten preamble as parse-number-native.ts:
 * `$NativeString` = { field0 len:i32, field1 off:i32, field2 data:i16-array }.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { ensureDateDaysFromCivilHelper } from "./expressions/builtins.js";
import { addFuncType } from "./registry/types.js";

const C_PLUS = 43;
const C_MINUS = 45;
const C_DOT = 46;
const C_COLON = 58;
const C_DASH = 45;
const C_T = 84; // 'T'
const C_t = 116; // 't' (lenient; spec is 'T' but some impls accept ' ' / 't')
const C_Z = 90; // 'Z'
const C_ZERO = 48;
const C_NINE = 57;

/**
 * Emit the native `__date_parse` helper if it is not already present.
 *
 * Locals (after param 0 = s:externref):
 *   1 flat:ref$NativeString  2 data:ref$i16arr  3 len:i32  4 i:i32  5 c:i32
 *   6 sign:i64 (year sign)   7 year:i64  8 month:i64  9 day:i64
 *  10 hour:i64 11 min:i64   12 sec:i64  13 ms:i64
 *  14 tzSign:i64 15 tzH:i64 16 tzM:i64
 *  17 fail:i32  18 acc:i64 (digit accumulator)  19 ndig:i32 (digits read)
 *  20 days:i64 (days-from-civil)  21 hasTime:i32  22 expanded:i32
 */
export function emitNativeDateParse(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__date_parse")) return;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

  const i32: ValType = { kind: "i32" };
  const i64: ValType = { kind: "i64" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };

  const typeIdx = addFuncType(ctx, [extern], [f64]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__date_parse", funcIdx);

  const L_FLAT = 1;
  const L_DATA = 2;
  const L_LEN = 3;
  const L_I = 4;
  const L_C = 5;
  const L_SIGN = 6;
  const L_YEAR = 7;
  const L_MONTH = 8;
  const L_DAY = 9;
  const L_HOUR = 10;
  const L_MIN = 11;
  const L_SEC = 12;
  const L_MS = 13;
  const L_TZSIGN = 14;
  const L_TZH = 15;
  const L_TZM = 16;
  const L_FAIL = 17;
  const L_ACC = 18;
  const L_NDIG = 19;
  const L_DAYS = 20;
  const L_HASTIME = 21;

  const getI = (l: number): Instr => ({ op: "local.get", index: l }) as Instr;
  const setI = (l: number): Instr => ({ op: "local.set", index: l }) as Instr;
  const i32c = (v: number): Instr => ({ op: "i32.const", value: v }) as Instr;
  const i64c = (v: bigint): Instr => ({ op: "i64.const", value: v }) as Instr;

  // c = data[i]  (no bounds check; callers guard i<len first via guarded blocks)
  const loadC: Instr[] = [getI(L_DATA), getI(L_I), { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr, setI(L_C)];

  /**
   * readDigits(n, dest): read exactly `n` decimal digits starting at `i` into
   * local `dest` (as i64), advancing `i`. If fewer than `n` digits are present
   * (end-of-string or a non-digit), set `fail`. Implemented as an unrolled loop
   * of `n` single-digit reads (n is small: 2, 3, 4 or 6).
   */
  const readDigits = (n: number, dest: number): Instr[] => {
    const out: Instr[] = [i64c(0n), setI(L_ACC)];
    for (let k = 0; k < n; k++) {
      // i >= len -> fail; else read one digit and advance
      out.push(
        getI(L_I),
        getI(L_LEN),
        { op: "i32.ge_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [i32c(1), setI(L_FAIL)],
          else: [
            ...loadC,
            // if c < '0' || c > '9' -> fail; else acc = acc*10 + (c-'0'); i++
            getI(L_C),
            i32c(C_ZERO),
            { op: "i32.lt_s" } as Instr,
            getI(L_C),
            i32c(C_NINE),
            { op: "i32.gt_s" } as Instr,
            { op: "i32.or" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [i32c(1), setI(L_FAIL)],
              else: [
                getI(L_ACC),
                i64c(10n),
                { op: "i64.mul" } as Instr,
                getI(L_C),
                i32c(C_ZERO),
                { op: "i32.sub" } as Instr,
                { op: "i64.extend_i32_s" } as Instr,
                { op: "i64.add" } as Instr,
                setI(L_ACC),
                getI(L_I),
                i32c(1),
                { op: "i32.add" } as Instr,
                setI(L_I),
              ],
            } as Instr,
          ],
        } as Instr,
      );
    }
    out.push(getI(L_ACC), setI(dest));
    return out;
  };

  // expectChar(code): if (i<len && data[i]==code) i++; else fail.
  const expectChar = (code: number): Instr[] => [
    getI(L_I),
    getI(L_LEN),
    { op: "i32.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...loadC,
        getI(L_C),
        i32c(code),
        { op: "i32.eq" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I)],
          else: [i32c(1), setI(L_FAIL)],
        } as Instr,
      ],
      else: [i32c(1), setI(L_FAIL)],
    } as Instr,
  ];

  // peekIs(code) leaves i32 bool on stack: (i<len) && data[i]==code
  const peekIs = (code: number): Instr[] => [
    getI(L_I),
    getI(L_LEN),
    { op: "i32.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [...loadC, getI(L_C), i32c(code), { op: "i32.eq" } as Instr],
      else: [i32c(0)],
    } as Instr,
  ];

  // guard(body): run `body` only while no parse error has been recorded, so a
  // failure short-circuits the remaining stages and leaves the accumulators
  // well-defined. Emits `if (!fail) { … }`.
  const guard = (inner: Instr[]): Instr =>
    ({
      op: "if",
      blockType: { kind: "empty" },
      then: inner,
    }) as Instr;
  // guard prelude: push `!fail` before the if.
  const guarded = (inner: Instr[]): Instr[] => [getI(L_FAIL), { op: "i32.eqz" } as Instr, guard(inner)];

  // ── RFC2822 / toString-form helpers (#2164 Date.parse extension) ──────────
  // skipSpaces(): advance `i` over any run of ASCII spaces (0x20). A `loop`
  // that re-checks `i<len && data[i]==' '` each iteration.
  const C_SPACE = 32;
  const C_COMMA = 44;
  const skipSpaces: Instr[] = [
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        // if next char is a space: advance and re-loop (br depth 0 = loop top);
        // otherwise fall through and exit the loop.
        ...peekIs(C_SPACE),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I), { op: "br", depth: 0 } as Instr],
        } as Instr,
      ],
    } as Instr,
  ];
  // monthFromName(): read 3 letters at `i` (case-insensitive), set L_MONTH to
  // 1–12, advance `i` by 3. On no-match set fail. Implemented as a chain of
  // 3-letter comparisons against the lowercased first letters. We lowercase
  // each of the 3 chars into m0/m1/m2 (reusing acc/ndig/days scratch as i32 is
  // awkward; use dedicated reads).
  const lc = (reg: number): Instr[] => [
    // L_C already holds the char; produce lowercased char and store into `reg`.
    // Uses `select(c+32, c, isUpper)` — branch-free, so no stack-frame issue
    // with carrying the pre-`if` operand into an arm.
    //   a = c + 32        (used when isUpper)
    getI(L_C),
    i32c(32),
    { op: "i32.add" } as Instr,
    //   b = c             (used otherwise)
    getI(L_C),
    //   cond = (c >= 'A') && (c <= 'Z')
    getI(L_C),
    i32c(65),
    { op: "i32.ge_s" } as Instr,
    getI(L_C),
    i32c(90),
    { op: "i32.le_s" } as Instr,
    { op: "i32.and" } as Instr,
    { op: "select" } as Instr,
    setI(reg),
  ];
  // Read the char at i+k into L_C (no advance). Guarded by caller ensuring
  // i+3<=len.
  const loadAt = (k: number): Instr[] => [
    getI(L_DATA),
    getI(L_I),
    i32c(k),
    { op: "i32.add" } as Instr,
    { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
    setI(L_C),
  ];
  // m0/m1/m2 lowercased month-name letters reuse L_TZH/L_TZM/L_DAYS-adjacent
  // i32 scratch? They are i64. Use three fresh i32 locals.
  const L_M0 = 22;
  const L_M1 = 23;
  const L_M2 = 24;
  // monthMatch(a,b,c, monthNo): if (m0==a && m1==b && m2==c) L_MONTH=monthNo.
  // `a,b,c` are lowercase char codes.
  const monthMatch = (a: number, b: number, c: number, monthNo: number, elseArm: Instr[]): Instr[] => [
    getI(L_M0),
    i32c(a),
    { op: "i32.eq" } as Instr,
    getI(L_M1),
    i32c(b),
    { op: "i32.eq" } as Instr,
    { op: "i32.and" } as Instr,
    getI(L_M2),
    i32c(c),
    { op: "i32.eq" } as Instr,
    { op: "i32.and" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [i64c(BigInt(monthNo)), setI(L_MONTH)],
      else: elseArm,
    } as Instr,
  ];
  // matchMonthName(): requires i+3<=len; lowercases the 3 chars; matches one of
  // the 12 names; advances i by 3 on success, sets fail on no match.
  const matchMonthName: Instr[] = [
    ...guarded([
      // bounds: i+3 <= len
      getI(L_I),
      i32c(3),
      { op: "i32.add" } as Instr,
      getI(L_LEN),
      { op: "i32.gt_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [i32c(1), setI(L_FAIL)],
        else: [
          ...loadAt(0),
          ...lc(L_M0),
          ...loadAt(1),
          ...lc(L_M1),
          ...loadAt(2),
          ...lc(L_M2),
          // chain: jan feb mar apr may jun jul aug sep oct nov dec, else fail
          ...monthMatch(
            106,
            97,
            110,
            1, // jan
            monthMatch(
              102,
              101,
              98,
              2, // feb
              monthMatch(
                109,
                97,
                114,
                3, // mar
                monthMatch(
                  97,
                  112,
                  114,
                  4, // apr
                  monthMatch(
                    109,
                    97,
                    121,
                    5, // may
                    monthMatch(
                      106,
                      117,
                      110,
                      6, // jun
                      monthMatch(
                        106,
                        117,
                        108,
                        7, // jul
                        monthMatch(
                          97,
                          117,
                          103,
                          8, // aug
                          monthMatch(
                            115,
                            101,
                            112,
                            9, // sep
                            monthMatch(
                              111,
                              99,
                              116,
                              10, // oct
                              monthMatch(
                                110,
                                111,
                                118,
                                11, // nov
                                monthMatch(100, 101, 99, 12, [i32c(1), setI(L_FAIL)]), // dec | fail
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
          // advance i by 3 only if matched (fail stays 0)
          ...guarded([getI(L_I), i32c(3), { op: "i32.add" } as Instr, setI(L_I)]),
        ],
      } as Instr,
    ]),
  ];
  // peekLetter(): (i<len) && isAlpha(data[i]) — leaves i32 bool on stack.
  const peekLetter: Instr[] = [
    getI(L_I),
    getI(L_LEN),
    { op: "i32.lt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        ...loadC,
        getI(L_C),
        i32c(65),
        { op: "i32.ge_s" } as Instr,
        getI(L_C),
        i32c(90),
        { op: "i32.le_s" } as Instr,
        { op: "i32.and" } as Instr,
        getI(L_C),
        i32c(97),
        { op: "i32.ge_s" } as Instr,
        getI(L_C),
        i32c(122),
        { op: "i32.le_s" } as Instr,
        { op: "i32.and" } as Instr,
        { op: "i32.or" } as Instr,
      ],
      else: [i32c(0)],
    } as Instr,
  ];
  // readDigits1or2(dest): read one or two digits into `dest` (day-of-month).
  const readDigits1or2 = (dest: number): Instr[] => [
    // first digit (required)
    ...readDigits(1, dest),
    // optional second digit: if next is a digit, dest = dest*10 + d
    ...guarded([
      getI(L_I),
      getI(L_LEN),
      { op: "i32.lt_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...loadC,
          getI(L_C),
          i32c(C_ZERO),
          { op: "i32.ge_s" } as Instr,
          getI(L_C),
          i32c(C_NINE),
          { op: "i32.le_s" } as Instr,
          { op: "i32.and" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              getI(dest),
              i64c(10n),
              { op: "i64.mul" } as Instr,
              getI(L_C),
              i32c(C_ZERO),
              { op: "i32.sub" } as Instr,
              { op: "i64.extend_i32_s" } as Instr,
              { op: "i64.add" } as Instr,
              setI(dest),
              getI(L_I),
              i32c(1),
              { op: "i32.add" } as Instr,
              setI(L_I),
            ],
          } as Instr,
        ],
      } as Instr,
    ]),
  ];

  const body: Instr[] = [
    // flatten
    getI(0),
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
    { op: "call", funcIdx: flattenIdx } as Instr,
    setI(L_FLAT),
    getI(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 } as Instr,
    setI(L_DATA),
    getI(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr,
    setI(L_I), // i = off
    getI(L_FLAT),
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
    getI(L_I),
    { op: "i32.add" } as Instr,
    setI(L_LEN), // len = off + len
    // field defaults: month=1 day=1 rest=0, sign=+1, tz offset 0
    i64c(1n),
    setI(L_SIGN),
    i64c(1n),
    setI(L_MONTH),
    i64c(1n),
    setI(L_DAY),
    i64c(0n),
    setI(L_HOUR),
    i64c(0n),
    setI(L_MIN),
    i64c(0n),
    setI(L_SEC),
    i64c(0n),
    setI(L_MS),
    i64c(0n),
    setI(L_TZSIGN), // 0 = no explicit TZ (treated as UTC standalone)
    i64c(0n),
    setI(L_TZH),
    i64c(0n),
    setI(L_TZM),
    i32c(0),
    setI(L_FAIL),
    i32c(0),
    setI(L_HASTIME),
  ];

  // (#2164) The original ECMAScript Date-Time-String scanner below fills the
  // field locals for the ISO grammar. It is captured into `isoArm` and wrapped
  // in a dispatch that routes a leading-letter string (RFC2822 / `toString` /
  // `toDateString` form, e.g. "Tue, 14 Nov 2023 22:13:20 GMT") to `rfcArm`
  // instead. Both arms fill the SAME field locals, so the shared
  // `i==len` + range-validate + compose tail handles either.
  const isoStart = body.length;

  // --- Year: optional sign + 6 digits (expanded) OR 4 digits ---
  body.push(
    // expanded year: leading '+' or '-'
    ...peekIs(C_PLUS),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        getI(L_I),
        i32c(1),
        { op: "i32.add" } as Instr,
        setI(L_I),
        ...readDigits(6, L_YEAR),
        getI(L_YEAR),
        getI(L_SIGN),
        { op: "i64.mul" } as Instr,
        setI(L_YEAR),
      ],
      else: [
        ...peekIs(C_MINUS),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            getI(L_I),
            i32c(1),
            { op: "i32.add" } as Instr,
            setI(L_I),
            i64c(-1n),
            setI(L_SIGN),
            ...readDigits(6, L_YEAR),
            getI(L_YEAR),
            getI(L_SIGN),
            { op: "i64.mul" } as Instr,
            setI(L_YEAR),
          ],
          // plain 4-digit year
          else: [...readDigits(4, L_YEAR)],
        } as Instr,
      ],
    } as Instr,
  );

  // --- optional -MM ---
  body.push(
    ...guarded([
      ...peekIs(C_DASH),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          getI(L_I),
          i32c(1),
          { op: "i32.add" } as Instr,
          setI(L_I),
          ...readDigits(2, L_MONTH),
          // optional -DD
          ...peekIs(C_DASH),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I), ...readDigits(2, L_DAY)],
          } as Instr,
        ],
      } as Instr,
    ]),
  );

  // --- optional time: T HH:mm[:ss[.sss]] ---
  body.push(
    ...guarded([
      ...peekIs(C_T),
      ...peekIs(C_t),
      { op: "i32.or" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          i32c(1),
          setI(L_HASTIME),
          getI(L_I),
          i32c(1),
          { op: "i32.add" } as Instr,
          setI(L_I),
          ...readDigits(2, L_HOUR),
          ...expectChar(C_COLON),
          ...readDigits(2, L_MIN),
          // optional :ss
          ...peekIs(C_COLON),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              getI(L_I),
              i32c(1),
              { op: "i32.add" } as Instr,
              setI(L_I),
              ...readDigits(2, L_SEC),
              // optional .sss (read exactly 3 digits)
              ...peekIs(C_DOT),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I), ...readDigits(3, L_MS)],
              } as Instr,
            ],
          } as Instr,
          // optional timezone: Z | ±HH:mm
          ...peekIs(C_Z),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I)],
            else: [
              ...peekIs(C_PLUS),
              ...peekIs(C_MINUS),
              { op: "i32.or" } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // sign
                  ...peekIs(C_MINUS),
                  {
                    op: "if",
                    blockType: { kind: "val", type: i64 },
                    then: [i64c(-1n)],
                    else: [i64c(1n)],
                  } as Instr,
                  setI(L_TZSIGN),
                  getI(L_I),
                  i32c(1),
                  { op: "i32.add" } as Instr,
                  setI(L_I),
                  ...readDigits(2, L_TZH),
                  ...expectChar(C_COLON),
                  ...readDigits(2, L_TZM),
                ],
              } as Instr,
            ],
          } as Instr,
        ],
      } as Instr,
    ]),
  );

  // Capture the ISO field-parse instructions emitted above into `isoArm`.
  const isoArm: Instr[] = body.splice(isoStart);

  // ── RFC2822 / `toString` / `toDateString` arm ────────────────────────────
  // Grammars (all rendered UTC by our formatters, #1682):
  //   toUTCString : "Www, DD Mon YYYY HH:mm:ss GMT"
  //   toString    : "Www Mon DD YYYY HH:mm:ss GMT±HHMM (…)"
  //   toDateString: "Www Mon DD YYYY"
  // Shared shape: an optional weekday (3 letters, optional trailing comma),
  // then EITHER `DD Mon YYYY` (toUTCString) OR `Mon DD YYYY` (toString/
  // toDateString), then an optional `HH:mm:ss`, then an optional timezone
  // (`GMT`, `UTC`, `Z`, or `±HHMM` / `GMT±HHMM`). Trailing `(…)` text is
  // tolerated. All times are UTC (standalone has no TZ DB), matching the
  // formatter/clock decisions of the earlier #2164 slices.
  const parseHMSOptional: Instr[] = [
    ...guarded([
      ...skipSpaces,
      // require a digit to start a time field
      getI(L_I),
      getI(L_LEN),
      { op: "i32.lt_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...loadC,
          getI(L_C),
          i32c(C_ZERO),
          { op: "i32.ge_s" } as Instr,
          getI(L_C),
          i32c(C_NINE),
          { op: "i32.le_s" } as Instr,
          { op: "i32.and" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...readDigits(2, L_HOUR),
              ...expectChar(C_COLON),
              ...readDigits(2, L_MIN),
              // optional :ss
              ...guarded([
                ...peekIs(C_COLON),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I), ...readDigits(2, L_SEC)],
                } as Instr,
              ]),
            ],
          } as Instr,
        ],
      } as Instr,
    ]),
  ];
  // Optional explicit ±HHMM offset (after GMT/UTC or standalone). Sets tzSign /
  // tzH / tzM. `GMT`/`UTC`/`Z` literals are skipped by the trailing-tolerance
  // loop, so here we only handle a leading sign.
  const parseTZOptional: Instr[] = [
    ...guarded([
      ...skipSpaces,
      // skip a leading "GMT"/"UTC" (3 letters) if present, so a following
      // ±HHMM is still read.
      ...guarded([
        ...peekLetter,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // advance over a run of letters (G M T / U T C / Z); tolerant loop:
            // if next is a letter, advance + re-loop (br depth 0), else exit.
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                ...peekLetter,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I), { op: "br", depth: 0 } as Instr],
                } as Instr,
              ],
            } as Instr,
          ],
        } as Instr,
      ]),
      // optional ±HHMM
      ...guarded([
        ...peekIs(C_PLUS),
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [i32c(1)],
          else: [...peekIs(C_MINUS)],
        } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // tzSign = (data[i]=='-') ? -1 : +1 ; i++
            ...peekIs(C_MINUS),
            {
              op: "if",
              blockType: { kind: "val", type: i64 },
              then: [i64c(-1n)],
              else: [i64c(1n)],
            } as Instr,
            setI(L_TZSIGN),
            getI(L_I),
            i32c(1),
            { op: "i32.add" } as Instr,
            setI(L_I),
            ...readDigits(2, L_TZH),
            // optional ':' then mm
            ...guarded([
              ...peekIs(C_COLON),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I)],
              } as Instr,
            ]),
            ...readDigits(2, L_TZM),
          ],
        } as Instr,
      ]),
    ]),
  ];
  // Tolerate any trailing characters (a `(Coordinated Universal Time)` suffix,
  // stray spaces, or a `GMT`/`Z` we didn't consume) so the final `i==len`
  // check passes: advance `i` to `len`.
  const consumeRest: Instr[] = [...guarded([getI(L_LEN), setI(L_I)])];

  const rfcArm: Instr[] = [
    // optional weekday: 3 letters then optional ',' then spaces
    ...guarded([
      ...peekLetter,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Disambiguate a weekday prefix from a leading MONTH (the toString /
          // toDateString form starts with a 3-letter month, not a weekday).
          // A weekday is present iff the 3-letter token is followed by:
          //   ','                       (toUTCString: "Www, DD Mon …")
          //   ' ' then a LETTER         (toString:    "Www Mon DD …")
          // A leading month is followed by ' ' then a DIGIT ("Mon DD YYYY"),
          // so that case is NOT treated as a weekday. Requires i+4 < len for the
          // space-then-letter test; a too-short token defaults to "not weekday".
          getI(L_I),
          i32c(4),
          { op: "i32.add" } as Instr,
          getI(L_LEN),
          { op: "i32.le_s" } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: i32 },
            then: [
              // c3 = data[i+3]
              getI(L_DATA),
              getI(L_I),
              i32c(3),
              { op: "i32.add" } as Instr,
              { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
              setI(L_C),
              // isComma = c3 == ','
              getI(L_C),
              i32c(C_COMMA),
              { op: "i32.eq" } as Instr,
              // spaceThenLetter = (c3 == ' ') && isAlpha(data[i+4])
              getI(L_C),
              i32c(C_SPACE),
              { op: "i32.eq" } as Instr,
              // load c4 into L_C and test alpha
              getI(L_DATA),
              getI(L_I),
              i32c(4),
              { op: "i32.add" } as Instr,
              { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
              setI(L_C),
              getI(L_C),
              i32c(65),
              { op: "i32.ge_s" } as Instr,
              getI(L_C),
              i32c(90),
              { op: "i32.le_s" } as Instr,
              { op: "i32.and" } as Instr,
              getI(L_C),
              i32c(97),
              { op: "i32.ge_s" } as Instr,
              getI(L_C),
              i32c(122),
              { op: "i32.le_s" } as Instr,
              { op: "i32.and" } as Instr,
              { op: "i32.or" } as Instr, // isAlpha(c4)
              { op: "i32.and" } as Instr, // (c3==' ') && isAlpha(c4)
              { op: "i32.or" } as Instr, // isComma || spaceThenLetter
            ],
            else: [i32c(0)],
          } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // skip the 3 weekday letters
              getI(L_I),
              i32c(3),
              { op: "i32.add" } as Instr,
              setI(L_I),
              // optional comma
              ...guarded([
                ...peekIs(C_COMMA),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [getI(L_I), i32c(1), { op: "i32.add" } as Instr, setI(L_I)],
                } as Instr,
              ]),
              ...skipSpaces,
            ],
          } as Instr,
        ],
      } as Instr,
    ]),
    // Now at either `DD Mon YYYY` (digit-first, toUTCString) or `Mon DD YYYY`
    // (letter-first, toString/toDateString).
    ...guarded([
      ...peekLetter,
      {
        op: "if",
        blockType: { kind: "empty" },
        // letter-first: Mon DD YYYY
        then: [...matchMonthName, ...skipSpaces, ...readDigits1or2(L_DAY), ...skipSpaces, ...readDigits(4, L_YEAR)],
        // digit-first: DD Mon YYYY
        else: [...readDigits1or2(L_DAY), ...skipSpaces, ...matchMonthName, ...skipSpaces, ...readDigits(4, L_YEAR)],
      } as Instr,
    ]),
    ...parseHMSOptional,
    ...parseTZOptional,
    ...consumeRest,
  ];

  // Dispatch: a string whose first char (before any whitespace) is a letter is
  // the RFC2822 / toString family; otherwise run the ISO scanner. (Leading
  // spaces are uncommon for these forms; the ISO scanner already handles the
  // numeric/sign-led ISO grammar.)
  body.push(...peekLetter, {
    op: "if",
    blockType: { kind: "empty" },
    then: rfcArm,
    else: isoArm,
  } as Instr);

  // --- require we consumed the whole string (i == len) ---
  body.push(
    ...guarded([
      getI(L_I),
      getI(L_LEN),
      { op: "i32.ne" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [i32c(1), setI(L_FAIL)],
      } as Instr,
    ]),
  );

  // --- range validation (month 1-12, day 1-31, hour 0-24, min/sec 0-59, ms 0-999) ---
  const rangeFail = (l: number, lo: bigint, hi: bigint): Instr[] => [
    getI(l),
    i64c(lo),
    { op: "i64.lt_s" } as Instr,
    getI(l),
    i64c(hi),
    { op: "i64.gt_s" } as Instr,
    { op: "i32.or" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [i32c(1), setI(L_FAIL)] } as Instr,
  ];
  body.push(
    ...guarded([
      ...rangeFail(L_MONTH, 1n, 12n),
      ...rangeFail(L_DAY, 1n, 31n),
      ...rangeFail(L_HOUR, 0n, 24n),
      ...rangeFail(L_MIN, 0n, 59n),
      ...rangeFail(L_SEC, 0n, 59n),
      ...rangeFail(L_TZH, 0n, 23n),
      ...rangeFail(L_TZM, 0n, 59n),
    ]),
  );

  // --- compose: ms = (daysFromCivil(y,m,d)*86400000) + h*3600000 + m*60000 +
  //                    s*1000 + ms  - tzOffsetMs ; return NaN if fail ---
  body.push(getI(L_FAIL), {
    op: "if",
    blockType: { kind: "val", type: f64 },
    then: [{ op: "f64.const", value: NaN } as Instr],
    else: [
      getI(L_YEAR),
      getI(L_MONTH),
      getI(L_DAY),
      { op: "call", funcIdx: daysFromCivilIdx } as Instr,
      setI(L_DAYS),
      getI(L_DAYS),
      i64c(86400000n),
      { op: "i64.mul" } as Instr,
      getI(L_HOUR),
      i64c(3600000n),
      { op: "i64.mul" } as Instr,
      { op: "i64.add" } as Instr,
      getI(L_MIN),
      i64c(60000n),
      { op: "i64.mul" } as Instr,
      { op: "i64.add" } as Instr,
      getI(L_SEC),
      i64c(1000n),
      { op: "i64.mul" } as Instr,
      { op: "i64.add" } as Instr,
      getI(L_MS),
      { op: "i64.add" } as Instr,
      // subtract timezone offset: tzSign * (tzH*3600000 + tzM*60000)
      getI(L_TZSIGN),
      getI(L_TZH),
      i64c(3600000n),
      { op: "i64.mul" } as Instr,
      getI(L_TZM),
      i64c(60000n),
      { op: "i64.mul" } as Instr,
      { op: "i64.add" } as Instr,
      { op: "i64.mul" } as Instr,
      { op: "i64.sub" } as Instr,
      { op: "f64.convert_i64_s" } as Instr,
    ],
  } as Instr);

  ctx.mod.functions.push({
    typeIdx,
    name: "__date_parse",
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
      { name: "len", type: i32 },
      { name: "i", type: i32 },
      { name: "c", type: i32 },
      { name: "sign", type: i64 },
      { name: "year", type: i64 },
      { name: "month", type: i64 },
      { name: "day", type: i64 },
      { name: "hour", type: i64 },
      { name: "min", type: i64 },
      { name: "sec", type: i64 },
      { name: "ms", type: i64 },
      { name: "tzSign", type: i64 },
      { name: "tzH", type: i64 },
      { name: "tzM", type: i64 },
      { name: "fail", type: i32 },
      { name: "acc", type: i64 },
      { name: "ndig", type: i32 },
      { name: "days", type: i64 },
      { name: "hasTime", type: i32 },
      { name: "m0", type: i32 }, // (#2164) lowercased month-name letters
      { name: "m1", type: i32 },
      { name: "m2", type: i32 },
    ],
    body,
    exported: false,
  });
}
