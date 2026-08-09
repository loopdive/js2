// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helper builders — whitespace boundary scans (#3899).
 *
 * ## Why these are hand `Instr[]` kernels
 *
 * The trim family is self-hosted (#3256) and its `while (i < len &&
 * __sh_str_isWs(s.charCodeAt(i)))` loops read beautifully, but they lower to
 * roughly 25 Wasm ops per code unit: an f64 induction variable, the guarded
 * `charCodeAt` helper's NaN bounds test, an `f64.convert_i32_u`, and then a
 * REAL (non-inlined — the table is ~11 branches, well past Binaryen's inline
 * budget) call into `__sh_str_isWs`, whose body compares in f64. That is the
 * same per-code-unit tax measured on `startsWith`/`endsWith` in #3899, and on
 * `string/trim` it is the whole benchmark: the receiver is 17 chars, so ~8 code
 * units are scanned and the scaffolding dwarfs both the scan and the single
 * `substring` view allocation.
 *
 * These kernels keep the loop in i32 — `array.get_u` + an inline ASCII
 * whitespace test — and hand back the boundary as an f64 index the self-hosted
 * TS can keep doing ordinary `number` arithmetic with.
 *
 * ## The whitespace table is NOT duplicated here
 *
 * §22.1.3.32's class (#1963) has 11 disjoint members and only two of them
 * matter for throughput: `0x20` and `0x09`-`0x0D`. Those are tested inline.
 * ANY other code unit `<= 0x7F` is definitively not whitespace, so the inline
 * test is EXACT for ASCII; only `> 0x7F` falls through to the self-hosted
 * `__sh_str_isWs`, which remains the single source of truth for the exotic
 * members (0xA0, 0x1680, 0x2000-0x200A, 0x2028/9, 0x202F, 0x205F, 0x3000,
 * 0xFEFF). Keeping the table in TS is deliberate — the fast path must never
 * become a second copy of a spec table that can drift.
 *
 * ORDERING: these kernels bake `__sh_str_isWs`'s funcIdx, so they are emitted
 * from `emitSelfHostedStringHelpers` immediately AFTER that leaf unit, not
 * from `emitStrSearchHelpers` (which runs earlier).
 */
import type { Instr } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { NativeStrShared } from "./native-strings-shared.js";

/** First index in `[from, to)` whose code unit is not whitespace (else `to`). */
export const STR_WS_START_FN = "__str_ws_start";
/** One past the last index in `[from, to)` that is not whitespace (else `from`). */
export const STR_WS_END_FN = "__str_ws_end";
/** Runtime trim length without allocating the substring view. */
export const STR_TRIM_LENGTH_FN = "__str_trim_length";

/**
 * `ws = (c == 0x20) | (c - 0x09 <=u 4)`, then — only for `c > 0x7F` — the
 * self-hosted table. `c` is in local `C`, the answer lands in local `WS`.
 */
function inlineWsTest(cLocal: number, wsLocal: number, isWsIdx: number): Instr[] {
  return [
    { op: "local.get", index: cLocal },
    { op: "i32.const", value: 0x20 },
    { op: "i32.eq" },
    // 0x09..0x0D as one unsigned range test
    { op: "local.get", index: cLocal },
    { op: "i32.const", value: 0x09 },
    { op: "i32.sub" },
    { op: "i32.const", value: 4 },
    { op: "i32.le_u" },
    { op: "i32.or" },
    { op: "local.tee", index: wsLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Every non-matching code unit <= 0x7F is definitively not whitespace,
        // so the slow table is consulted for the exotic members only.
        { op: "local.get", index: cLocal },
        { op: "i32.const", value: 0x7f },
        { op: "i32.gt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: cLocal },
            { op: "f64.convert_i32_u" },
            { op: "call", funcIdx: isWsIdx },
            { op: "local.set", index: wsLocal },
          ],
        },
      ],
    },
  ];
}

/**
 * Emit `__str_ws_start` / `__str_ws_end`.
 *
 * Both take `(s: ref $AnyString, from: f64, to: f64) -> f64` — the numeric
 * params are f64 per the caller-side dialect rule in `stdlib-selfhost.ts`
 * (there is no implicit f64→i32 argument coercion), and the kernels truncate
 * once at entry. Indices are clamped by the CALLER (`0 <= from <= to <= len`,
 * which the trim sources establish from `.length`); out-of-range input is a
 * WasmGC `array.get` trap, not memory unsafety.
 */
export function emitStrWsSpanHelpers(shared: NativeStrShared): void {
  const { ctx, strTypeIdx, strDataTypeIdx, strRef, strDataRef, wrapBodyWithFlatten } = shared;

  const isWsIdx = ctx.funcMap.get("__sh_str_isWs");
  if (isWsIdx === undefined) {
    throw new Error(
      "native-strings-ws: __sh_str_isWs must be emitted before the whitespace span kernels " +
        "(see emitSelfHostedStringHelpers' leaf-first ordering)",
    );
  }

  // params: s(0), from(1), to(2)
  // locals: i(3), n(4), data(5), off(6), c(7), ws(8)
  const I = 3;
  const N = 4;
  const DATA = 5;
  const OFF = 6;
  const C = 7;
  const WS = 8;

  const locals = [
    { name: "i", type: { kind: "i32" as const } },
    { name: "n", type: { kind: "i32" as const } },
    { name: "data", type: strDataRef },
    { name: "off", type: { kind: "i32" as const } },
    { name: "c", type: { kind: "i32" as const } },
    { name: "ws", type: { kind: "i32" as const } },
  ];

  /**
   * `i = trunc(from); n = trunc(to); data = s.data; off = s.off`
   *
   * A FACTORY, not a shared array (#4034). Both kernels below need this
   * prologue, and spreading one array into both bodies copies the array but
   * ALIASES the `Instr` objects — including the two `struct.get`s that carry a
   * `typeIdx`. Dead-elimination's `remapTypeIdxInBody` mutates instructions in
   * place and guards against double-remap with a WeakSet scoped to ONE body
   * (#1302/#2564), so an object reachable from two bodies is remapped once per
   * body: under a compaction map `$NativeString` 7→6→5 lands on `$AnyString`,
   * and emit fails with "struct field index out of range — 2 (valid: [0, 1))".
   * Latent until something makes a type actually die; #4034's export-gating did.
   * Fresh objects per body keep each instruction remapped exactly once.
   */
  const makePrologue = (): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: I },
    { op: "local.get", index: 2 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: N },
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: DATA },
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: OFF },
  ];

  // --- __str_ws_start: forward scan, returns the first non-whitespace index ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "f64" }, { kind: "f64" }], [{ kind: "f64" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set(STR_WS_START_FN, funcIdx);

    const body: Instr[] = [
      ...makePrologue(),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if (i >= n) break
              { op: "local.get", index: I },
              { op: "local.get", index: N },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // c = data[off + i]
              { op: "local.get", index: DATA },
              { op: "local.get", index: OFF },
              { op: "local.get", index: I },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: C },
              ...inlineWsTest(C, WS, isWsIdx),
              // if (!ws) break
              { op: "local.get", index: WS },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              // i++
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: I },
      { op: "f64.convert_i32_s" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: STR_WS_START_FN,
      typeIdx,
      locals,
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- __str_ws_end: backward scan, returns one past the last non-whitespace ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "f64" }, { kind: "f64" }], [{ kind: "f64" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set(STR_WS_END_FN, funcIdx);

    // Here `i` is the lower bound and `n` the moving end.
    const body: Instr[] = [
      ...makePrologue(),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if (n <= i) break
              { op: "local.get", index: N },
              { op: "local.get", index: I },
              { op: "i32.le_s" },
              { op: "br_if", depth: 1 },
              // c = data[off + n - 1]
              { op: "local.get", index: DATA },
              { op: "local.get", index: OFF },
              { op: "local.get", index: N },
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: C },
              ...inlineWsTest(C, WS, isWsIdx),
              // if (!ws) break
              { op: "local.get", index: WS },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              // n--
              { op: "local.get", index: N },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: N },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: N },
      { op: "f64.convert_i32_s" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: STR_WS_END_FN,
      typeIdx,
      locals,
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- __str_trim_length: fused two-sided scan, no substring allocation ---
  {
    // This helper has one parameter (the span helpers above have three), so
    // its six locals begin at index 1 rather than index 3.
    const LI = 1;
    const LN = 2;
    const LDATA = 3;
    const LOFF = 4;
    const LC = 5;
    const LWS = 6;
    const typeIdx = addFuncType(ctx, [strRef], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set(STR_TRIM_LENGTH_FN, funcIdx);

    const body: Instr[] = [
      { op: "i32.const", value: 0 },
      { op: "local.set", index: LI },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LN },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: LDATA },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: LOFF },
      // Advance the lower boundary.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: LI },
              { op: "local.get", index: LN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: LDATA },
              { op: "local.get", index: LOFF },
              { op: "local.get", index: LI },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: LC },
              ...inlineWsTest(LC, LWS, isWsIdx),
              { op: "local.get", index: LWS },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: LI },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: LI },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Retreat the upper boundary, never crossing the lower one.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: LN },
              { op: "local.get", index: LI },
              { op: "i32.le_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: LDATA },
              { op: "local.get", index: LOFF },
              { op: "local.get", index: LN },
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: LC },
              ...inlineWsTest(LC, LWS, isWsIdx),
              { op: "local.get", index: LWS },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: LN },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: LN },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: LN },
      { op: "local.get", index: LI },
      { op: "i32.sub" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: STR_TRIM_LENGTH_FN,
      typeIdx,
      locals,
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }
}
