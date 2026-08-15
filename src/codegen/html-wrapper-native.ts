// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm Annex B §B.2.2 HTML string-wrapper methods for standalone / WASI
 * (no-JS-host) targets (#3069). `String.prototype.{anchor, big, blink, bold,
 * fixed, fontcolor, fontsize, italics, link, small, strike, sub, sup}` are the
 * legacy `CreateHTML` (§B.2.2.2.1) transforms — each wraps the receiver in an
 * HTML tag, e.g. `"x".bold()` → `"<b>x</b>"`, `"x".anchor(n)` →
 * `'<a name="…">x</a>'`. In JS-host mode these dispatch through
 * `__extern_method_call`; under `--target standalone`/`wasi` there is no JS
 * host, so the call site fell through and returned wrong strings / null-derefed.
 *
 * These are pure UTF-16 string-concatenation transforms — no Unicode substrate.
 * The only non-trivial part is `CreateHTML` step 4.b: when a tag carries an
 * attribute VALUE, each `"` (U+0022) in the value is replaced with `&quot;`.
 * This module emits a single WasmGC-native helper for that quote-escaping
 * (`__str_html_escape_quot`); the tag/attribute concatenation itself is built
 * inline at each call site in `string-ops.ts` via `__str_concat` + string
 * literals. Mirrors the #679/#682 dual-backend pattern (`escape-native.ts`,
 * `case-convert-native.ts`).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting

const i32: ValType = { kind: "i32" };

/**
 * (#3069) Annex B §B.2.3 legacy HTML string-wrapper method → HTML tag +
 * optional attribute name (ECMA-262 §B.2.3.2..§B.2.3.14). `String.prototype`
 * `bold`→`<b>`, `italics`→`<i>`, `anchor(name)`→`<a name="…">`,
 * `link(url)`→`<a href="…">`, `fontcolor(c)`/`fontsize(s)`→`<font color/size="…">`,
 * etc. Methods with an `attribute` take one argument (the attribute VALUE,
 * `"`→`&quot;` escaped); the rest take none — which is also their spec
 * `fn.length` (§B.2.3.2.1 CreateHTML's `attribute` operand).
 *
 * Two consumers, one table (#4445): the DIRECT call-site arm in
 * `compileNativeStringMethodCall` (string-ops.ts) and the REFLECTIVE closure
 * body in `string-proto-html.ts`.
 */
const HTML_WRAPPER_TAGS: Readonly<Record<string, { tag: string; attribute?: string }>> = {
  anchor: { tag: "a", attribute: "name" },
  big: { tag: "big" },
  blink: { tag: "blink" },
  bold: { tag: "b" },
  fixed: { tag: "tt" },
  fontcolor: { tag: "font", attribute: "color" },
  fontsize: { tag: "font", attribute: "size" },
  italics: { tag: "i" },
  link: { tag: "a", attribute: "href" },
  small: { tag: "small" },
  strike: { tag: "strike" },
  sub: { tag: "sub" },
  sup: { tag: "sup" },
};

/**
 * The §B.2.3 descriptor for `method`, or `undefined` when it is not one of the
 * 13. The OWN-property check is load-bearing, not defensive style: both callers
 * dispatch on arbitrary `String.prototype` member names, and a bare
 * `HTML_WRAPPER_TAGS[member]` answers `Object.prototype.toString` (a truthy
 * function) for `member === "toString"` — which would destructure to
 * `tag === undefined` and emit a silently wrong `<undefined>x</undefined>`.
 */
export function htmlWrapperFor(method: string): { tag: string; attribute?: string } | undefined {
  return Object.prototype.hasOwnProperty.call(HTML_WRAPPER_TAGS, method) ? HTML_WRAPPER_TAGS[method] : undefined;
}

/**
 * Ensure `__str_html_escape_quot(s: ref $AnyString) -> ref $NativeString` is
 * emitted (idempotent). It returns a copy of `s` with every `"` (U+0022) code
 * unit replaced by the six code units `&quot;` — the exact CreateHTML step-4.b
 * escaping (§B.2.2.2.1). Two passes over the flattened source: pass 1 counts
 * the `"` occurrences to size the output (`len + 5·nq`), pass 2 fills it,
 * expanding each `"` to `&quot;` and copying every other unit verbatim.
 *
 * Called from `ensureNativeStringHelpers`, AFTER `__str_flatten` is registered
 * (so a cons-string input can be flattened). `strTypeIdx`/`strDataTypeIdx` are
 * the NativeString struct + its i16 backing-array type indices; `anyStrTypeIdx`
 * is the `$AnyString` supertype.
 */
export function emitNativeHtmlWrapperHelpers(
  ctx: CodegenContext,
  strTypeIdx: number,
  strDataTypeIdx: number,
  anyStrTypeIdx: number,
): void {
  if (ctx.nativeStrHelpers.has("__str_html_escape_quot")) return;

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;

  // params: s(0)
  // locals: flat(1), data(2), off(3), len(4), i(5), nq(6), outLen(7),
  //         outArr(8), j(9), cu(10)
  const S = 0,
    FLAT = 1,
    DATA = 2,
    OFF = 3,
    LEN = 4,
    I = 5,
    NQ = 6,
    OUTLEN = 7,
    OUTARR = 8,
    J = 9,
    CU = 10;

  // '&quot;' code units.
  const QUOT: number[] = [0x26 /* & */, 0x71 /* q */, 0x75 /* u */, 0x6f /* o */, 0x74 /* t */, 0x3b /* ; */];

  // load data[off + i] (zero-extended i16 → i32)
  const loadUnit = (idxLocal: number): Instr[] => [
    { op: "local.get", index: DATA },
    { op: "local.get", index: OFF },
    { op: "local.get", index: idxLocal },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
  ];

  // Pass-2 store of one QUOT unit at outArr[J + k]. J is advanced by 6 after
  // the run.
  const storeQuotUnit = (k: number): Instr[] => [
    { op: "local.get", index: OUTARR },
    { op: "local.get", index: J },
    { op: "i32.const", value: k },
    { op: "i32.add" },
    { op: "i32.const", value: QUOT[k]! },
    { op: "array.set", typeIdx: strDataTypeIdx },
  ];

  const body: Instr[] = [
    // flat = flatten(s)
    { op: "local.get", index: S },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: FLAT },
    // data = flat.data (field 2), off = flat.off (field 1), len = flat.len (field 0)
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: DATA },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: OFF },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: LEN },

    // --- pass 1: nq = count of '"' units ---
    { op: "i32.const", value: 0 },
    { op: "local.set", index: NQ },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            // if (data[off+i] == 0x22) nq++
            ...loadUnit(I),
            { op: "i32.const", value: 0x22 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: NQ },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: NQ },
              ],
            },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // outLen = len + nq*5 ; outArr = array.new_default(outLen)
    { op: "local.get", index: LEN },
    { op: "local.get", index: NQ },
    { op: "i32.const", value: 5 },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.set", index: OUTLEN },
    { op: "local.get", index: OUTLEN },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: OUTARR },

    // --- pass 2: fill ---
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: J },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            // cu = data[off+i]
            ...loadUnit(I),
            { op: "local.set", index: CU },
            { op: "local.get", index: CU },
            { op: "i32.const", value: 0x22 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // write '&quot;' at outArr[J..J+5], J += 6
                ...storeQuotUnit(0),
                ...storeQuotUnit(1),
                ...storeQuotUnit(2),
                ...storeQuotUnit(3),
                ...storeQuotUnit(4),
                ...storeQuotUnit(5),
                { op: "local.get", index: J },
                { op: "i32.const", value: 6 },
                { op: "i32.add" },
                { op: "local.set", index: J },
              ],
              else: [
                // outArr[J] = cu ; J += 1
                { op: "local.get", index: OUTARR },
                { op: "local.get", index: J },
                { op: "local.get", index: CU },
                { op: "array.set", typeIdx: strDataTypeIdx },
                { op: "local.get", index: J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: J },
              ],
            },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return struct.new $NativeString(outLen, 0, outArr)
    { op: "local.get", index: OUTLEN },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: OUTARR },
    { op: "struct.new", typeIdx: strTypeIdx },
  ];

  const typeIdx = addFuncType(ctx, [strRef], [flatStrRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__str_html_escape_quot", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__str_html_escape_quot",
    typeIdx,
    locals: [
      { name: "flat", type: flatStrRef },
      { name: "data", type: strDataRef },
      { name: "off", type: i32 },
      { name: "len", type: i32 },
      { name: "i", type: i32 },
      { name: "nq", type: i32 },
      { name: "outLen", type: i32 },
      { name: "outArr", type: strDataRef },
      { name: "j", type: i32 },
      { name: "cu", type: i32 },
    ],
    body,
    exported: false,
  });
}
