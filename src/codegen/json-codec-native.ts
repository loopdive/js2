// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm dynamic JSON codec for standalone / WASI targets — #1599 Phase 2
 * (issue #2166, PR-A).
 *
 * `json-standalone.ts` folds *statically known* JSON literal graphs at compile
 * time, and `json-runtime.ts` adds the lone-runtime-primitive serialisers
 * (`__json_quote_string`, `__json_parse_primitive`). What was still missing —
 * and the bulk of the standalone JSON conformance residual — is
 * `JSON.stringify` of a **dynamic object graph**: a runtime-built object/array
 * whose contents are not known at compile time (`const o = {}; o.x = f();
 * JSON.stringify(o)`). Before this module that case either refused (#1599
 * Phase-1) or, worse, silently folded the *empty* declaration literal and
 * dropped the runtime mutations (returning `"{}"`).
 *
 * This module emits a recursive pure-Wasm `SerializeJSONProperty`
 * (`__json_stringify_value`) over the value representation the standalone
 * object runtime already uses — it is a traversal + formatter, NOT new
 * representation work:
 *
 *   - `$Object`  (object-runtime.ts) — own enumerable string-keyed props in
 *     insertion order via the existing `__obj_ordered` helper.
 *   - `$ObjVec`  — the externref vector backing array enumeration results.
 *   - `$AnyString` (native string) — quoted with the existing
 *     `__json_quote_string`.
 *   - `$__box_number_struct` / `$__box_boolean_struct` — the standalone boxed
 *     primitives, plus the `$AnyValue` tagged union (from the parse path).
 *
 * Spec: ECMA-262 §25.5.2 SerializeJSONProperty / SerializeJSONObject /
 * SerializeJSONArray (ECMA-404 grammar). PR-A is compact output only;
 * indentation (`space`) is PR-B, and `JSON.parse` of graphs is PR-C.
 *
 * Edge cases handled here (§25.5.2):
 *   - a `null` reference / `$AnyValue` tag 0 → the JSON `null` literal.
 *   - `NaN` / `±Infinity` → `null`; `-0` → `0`; otherwise Number::toString.
 *   - a value whose serialisation is *undefined* (function / symbol / an
 *     unsupported ref) returns a null `$AnyString` from the recursion — the
 *     array arm emits `null` for it, the object arm omits the property.
 *   - circular references: bounded by a recursion-depth cap (returns the
 *     empty serialisation on overflow rather than trapping). A proper
 *     TypeError-throwing seen-set is a follow-up (noted in the issue file).
 */
import type { Instr, ValType } from "../ir/types.js";
import { ensureAnyValueType, undefinedSingletonActive } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import {
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  nativeStringType,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { ensureObjectRuntime, OBJ_FLAG_RAWJSON } from "./object-runtime.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { addFuncType, getOrRegisterVecBaseType } from "./registry/types.js";
import { emitJsonQuoteString } from "./json-runtime.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { reserveReplacerDriver, reserveReviverDriver, reserveToJsonDriver } from "./accessor-driver.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import { buildRawJsonSymbolToStringGuard, prepareRawJsonSymbolToString } from "./json-rawjson-symbol.js";
const EQ_HEAP_TYPE = -19; // signed LEB128 → 0x6d → TYPE.eq (for ref.null any/eq)

/**
 * (#2166 PR-D2) Structure-preserving deep clone of an `Instr[]` tree. Unlike a
 * JSON round-trip it preserves non-finite `f64.const` values (`Infinity`/`NaN`),
 * and unlike `structuredClone` it does NOT preserve internal aliasing — every
 * shared sub-object becomes an independent copy so `shiftLateImportIndices`
 * remaps each `funcIdx`/operand occurrence exactly once (the #1302 hazard).
 */
export function deepCloneInstrs<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => deepCloneInstrs(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object)) {
      out[k] = deepCloneInstrs((value as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return value;
}

/** Maximum nesting depth before the codec bails (circular-ref guard). */
const MAX_JSON_DEPTH = 512;

function buildRawJsonStringifyArm(
  ctx: CodegenContext,
  anyLocal: number,
  objectTypeIdx: number,
  anyStrTypeIdx: number,
  externGetIdx: number,
): Instr[] {
  return [
    // ES2025 §25.5.2.2: a branded raw-JSON carrier contributes its source text
    // verbatim, after toJSON/replacer processing and before object walking.
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: OBJ_FLAG_RAWJSON },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: anyLocal },
            { op: "extern.convert_any" },
            ...nativeStringLiteralInstrs(ctx, "rawJSON"),
            { op: "extern.convert_any" },
            { op: "call", funcIdx: externGetIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: anyStrTypeIdx },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/**
 * Emit `__json_stringify_value(v: anyref, depth: i32) -> ref null $AnyString`
 * and register it in `ctx.funcMap`. Idempotent. Standalone / WASI only.
 *
 * A null result encodes "value serialises to JS `undefined`" (function /
 * symbol / unsupported ref) — the caller's array/object arms apply the §25.5.2
 * omit-vs-`null` rule.
 *
 * Returns the funcIdx.
 */
export function emitJsonStringifyValue(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_stringify_value");
  if (existing !== undefined) return existing;

  // Dependencies. All idempotent.
  ensureNativeStringHelpers(ctx);
  ensureAnyValueType(ctx);
  const objTypes = ensureObjectRuntime(ctx);
  emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  const quoteIdx = emitJsonQuoteString(ctx);

  const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
  const orderedIdx = ctx.funcMap.get("__obj_ordered")!;
  const numToStrIdx = ctx.funcMap.get("number_toString");

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const anyValueTypeIdx = ctx.anyValueTypeIdx;
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolTypeIdx = ctx.nativeBoxBooleanTypeIdx;
  const objectTypeIdx = objTypes.objectTypeIdx;
  const propMapTypeIdx = objTypes.propMapTypeIdx;
  const propEntryTypeIdx = objTypes.propEntryTypeIdx;
  const objVecTypeIdx = objTypes.objVecTypeIdx;
  const objVecArrTypeIdx = objTypes.objVecArrTypeIdx;

  // (#4085) A real standalone JS array is a `__vec_<elemKind>` struct subtyping
  // `$__vec_base` (#2186). `$ObjVec` is the enumeration-RESULT vector — a
  // DIFFERENT type — so the value dispatch below matched NO arm for an ordinary
  // array and fell through to "unsupported ref", rendering the JSON literal
  // `null` for `JSON.stringify([10,20,30])`. These four let the ladder normalise
  // a vec receiver into a `$ObjVec` and then reuse the existing array arm
  // verbatim, rather than duplicating ~120 instructions of element / replacer /
  // indent logic that would then have to be kept in sync.
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");

  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const anyref: ValType = { kind: "anyref" };
  const strRefNull: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const strRef = nativeStringType(ctx); // ref $AnyString

  const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!; // (#2166 PR-B) indent builder

  // (#2166 PR-D2) toJSON support — number_toString for array-index keys + the
  // reserve/fill __call_to_json driver wrapping __call_fn_method_1.
  const numToStrIdxTJ = ctx.funcMap.get("number_toString");
  const externGetIdxTJ = ctx.funcMap.get("__extern_get")!;
  const toJsonDriverIdx = reserveToJsonDriver(ctx);

  // (#2166 PR-D3) replacer support — the reserve/fill __call_replacer driver
  // wrapping __call_fn_method_2 (holder bound as `this`). The array-form
  // (allowlist) replacer is represented at the routing site as a plain $Object
  // whose own keys are the allowed property names; membership is the existing
  // __extern_has (proto-safe, battle-tested), no bespoke string-compare loop.
  const replacerDriverIdx = reserveReplacerDriver(ctx);
  const externHasIdx = ctx.funcMap.get("__extern_has");

  // Pre-register the self funcIdx so the recursive calls in the body resolve.
  // (#2166 PR-B) `gap` (param 2, `ref null $AnyString`) is the per-level indent
  // unit (e.g. "  "). A null gap selects the compact form (PR-A behaviour, zero
  // overhead); a non-null gap drives §25.5.2 pretty-printing.
  // (#2166 PR-D2) `key` (param 3, externref) is the property key passed to a
  // `toJSON` method per §25.5.2 SerializeJSONProperty step 2.b.
  // (#2166 PR-D3) `holder` (param 4, externref) is the object/array containing
  // this value — the `this` for a function replacer; `replacer` (param 5,
  // externref) is the replacer closure (or null); `allowList` (param 6,
  // externref) is an $ObjVec of allowed string keys for the array-form replacer
  // (or null). replacer and allowList are mutually exclusive per §25.5.2.
  const typeIdx = addFuncType(
    ctx,
    [
      anyref,
      i32,
      strRefNull,
      { kind: "externref" },
      { kind: "externref" },
      { kind: "externref" },
      { kind: "externref" },
    ],
    [strRefNull],
  );
  const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("__json_stringify_value", funcIdx);

  // ── Local plan ──────────────────────────────────────────────────────────
  // params: 0 v:anyref  1 depth:i32  2 gap:ref null $AnyString  3 key:externref
  //         4 holder:externref  5 replacer:externref  6 allowList:externref
  const P_V = 0;
  const P_DEPTH = 1;
  const P_GAP = 2;
  const P_KEY = 3;
  const P_HOLDER = 4;
  const P_REPLACER = 5;
  const P_ALLOW = 6;
  const L_ANY = 7; // anyref scratch (re-tested value)
  const L_OBJ = 8; // ref null $Object
  const L_ARR = 9; // ref null $PropMap (ordered) / loop reuse
  const L_VEC = 10; // ref null $ObjVec
  const L_CAP = 11; // i32 loop bound
  const L_I = 12; // i32 loop index
  const L_E = 13; // ref null $PropEntry
  const L_OUT = 14; // ref $AnyString accumulator
  const L_PIECE = 15; // ref null $AnyString per-element/prop serialisation
  const L_FIRST = 16; // i32 — first-emitted flag (comma control)
  const L_NUM = 17; // f64 number scratch
  const L_DATA = 18; // ref $ObjVecArr (vec backing)
  // (#2166 PR-B) Precomputed separator strings (empty when gap is null):
  const L_NL_IN = 19; // ref $AnyString — "\n" + indent at the *inner* (depth+1) level
  const L_NL_OUT = 20; // ref $AnyString — "\n" + indent at *this* depth (before close)
  const L_COLON = 21; // ref $AnyString — ": " when indented, ":" when compact
  const L_TJKEY = 22; // externref — child key passed down (toJSON + recursion)
  const L_TJM = 23; // externref — the toJSON method looked up on the value
  const L_CHILDV = 24; // anyref — child value after replacer transform (recursion arg)
  const L_CKEY = 25; // externref — current child key (object/array arms)
  // (#4085) `$__vec_base` → `$ObjVec` normalisation scratch. Dedicated locals
  // rather than reusing L_CAP/L_I: normalisation runs BEFORE the array arm,
  // which re-initialises those, but keeping them separate makes the two loops
  // independently readable and immune to a future reordering of the ladder.
  const L_VB = 26; // externref — the normalised $ObjVec built from a vec receiver
  const L_VBLEN = 27; // i32 — vec length
  const L_VBI = 28; // i32 — normalisation loop index

  const litStr = (s: string): Instr[] => nativeStringLiteralInstrs(ctx, s);

  // out = __str_concat(out, <piece in L_PIECE, non-null>)
  const appendPiece: Instr[] = [
    { op: "local.get", index: L_OUT },
    { op: "ref.as_non_null" },
    { op: "local.get", index: L_PIECE },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: L_OUT },
  ];

  // out = __str_concat(out, <literal>)
  const appendLit = (s: string): Instr[] => [
    { op: "local.get", index: L_OUT },
    { op: "ref.as_non_null" },
    ...litStr(s),
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: L_OUT },
  ];

  // (#2166 PR-B) out = __str_concat(out, <separator local — always non-null>)
  // Used for the precomputed newline/indent separators (L_NL_IN/L_NL_OUT/
  // L_COLON). They are the empty string when gap is null, so concatenating
  // them in the compact form is a no-op (and `__str_concat` short-circuits an
  // empty argument).
  const appendSep = (sepLocal: number): Instr[] => [
    { op: "local.get", index: L_OUT },
    { op: "ref.as_non_null" },
    { op: "local.get", index: sepLocal },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: concatIdx },
    { op: "local.set", index: L_OUT },
  ];

  // (#2166 PR-B) Compute the per-call separator strings into L_NL_IN /
  // L_NL_OUT / L_COLON. With a null gap every separator is "" (and the colon is
  // ":"), so the loop bodies below emit byte-identical compact output. With a
  // non-null gap: L_NL_IN = "\n" + repeat(gap, depth+1); L_NL_OUT = "\n" +
  // repeat(gap, depth); L_COLON = ": ". `__str_repeat` returns "" for count 0,
  // so the top-level (depth 0) close indent is just "\n" as §25.5.2 requires.
  const setupSeparators: Instr[] = [
    { op: "local.get", index: P_GAP },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...litStr(""),
        { op: "local.set", index: L_NL_IN },
        ...litStr(""),
        { op: "local.set", index: L_NL_OUT },
        ...litStr(":"),
        { op: "local.set", index: L_COLON },
      ],
      else: [
        // L_NL_IN = "\n" + repeat(gap, depth + 1)
        ...litStr("\n"),
        { op: "local.get", index: P_GAP },
        { op: "ref.as_non_null" },
        { op: "local.get", index: P_DEPTH },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "call", funcIdx: repeatIdx },
        { op: "call", funcIdx: concatIdx },
        { op: "local.set", index: L_NL_IN },
        // L_NL_OUT = "\n" + repeat(gap, depth)
        ...litStr("\n"),
        { op: "local.get", index: P_GAP },
        { op: "ref.as_non_null" },
        { op: "local.get", index: P_DEPTH },
        { op: "call", funcIdx: repeatIdx },
        { op: "call", funcIdx: concatIdx },
        { op: "local.set", index: L_NL_OUT },
        // L_COLON = ": "
        ...litStr(": "),
        { op: "local.set", index: L_COLON },
      ],
    },
  ];

  // ── number arm: format f64 (in L_NUM) per JSON rules → push ref $AnyString ─
  // NaN / +-Inf → "null"; everything else via number_toString (which already
  // renders -0 as "0" and integers without a trailing ".0").
  const formatNumber: Instr[] =
    numToStrIdx === undefined
      ? [...litStr("null")] // no formatter available → degrade to null
      : [
          // if (n != n) → "null"   (NaN)
          { op: "local.get", index: L_NUM },
          { op: "local.get", index: L_NUM },
          { op: "f64.ne" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [...litStr("null")],
            else: [
              // if (abs(n) == +Inf) → "null"
              { op: "local.get", index: L_NUM },
              { op: "f64.abs" },
              { op: "f64.const", value: Infinity },
              { op: "f64.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: [...litStr("null")],
                else: [
                  { op: "local.get", index: L_NUM },
                  { op: "call", funcIdx: numToStrIdx },
                  // number_toString returns externref ($NativeString widened) →
                  // bring back to a ref $AnyString for concat.
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx: anyStrTypeIdx },
                ],
              },
            ],
          },
        ];

  // ── $AnyValue arm: discriminate by tag, leave a ref $AnyString on stack ────
  // tag 0/1 → "null" (undefined-as-value at this depth already became null);
  // tag 2 i32 number; tag 3 f64 number; tag 4 bool; tag 5 string; else "null".
  const anyValueArm: Instr[] = [
    // tag = av.tag
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: anyValueTypeIdx },
    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
    // switch on tag using a chain of if/else (small, fixed set)
    { op: "local.set", index: L_I }, // reuse L_I as tag holder
    // tag == 4 (bool)?
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 4 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        // av.i32val ? "true" : "false"
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: anyValueTypeIdx },
        { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [...litStr("true")],
          else: [...litStr("false")],
        },
      ],
      else: [
        // tag == 5 (string)?
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 5 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [
            // __json_quote_string(av.externval)
            { op: "local.get", index: L_ANY },
            { op: "ref.cast", typeIdx: anyValueTypeIdx },
            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 4 },
            { op: "call", funcIdx: quoteIdx },
          ],
          else: [
            // tag 2 (i32) or 3 (f64) → number
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 2 },
            { op: "i32.eq" },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 3 },
            { op: "i32.eq" },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: [
                // n = (tag==2) ? f64(i32val) : f64val
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 2 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "val", type: f64 },
                  then: [
                    { op: "local.get", index: L_ANY },
                    { op: "ref.cast", typeIdx: anyValueTypeIdx },
                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
                    { op: "f64.convert_i32_s" },
                  ],
                  else: [
                    { op: "local.get", index: L_ANY },
                    { op: "ref.cast", typeIdx: anyValueTypeIdx },
                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 2 },
                  ],
                },
                { op: "local.set", index: L_NUM },
                ...formatNumber,
              ],
              else: [...litStr("null")], // tag 0/1/6 → null
            },
          ],
        },
      ],
    },
  ];

  // ── array arm ($ObjVec): "[" elem0 "," elem1 ... "]" ─────────────────────
  // A null/undefined/function element serialises as "null" inside an array.
  const arrayArm: Instr[] = [
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "local.set", index: L_VEC },
    { op: "local.get", index: L_VEC },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 }, // data
    { op: "local.set", index: L_DATA },
    { op: "local.get", index: L_VEC },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 }, // len
    { op: "local.set", index: L_CAP },
    // out = "["
    ...litStr("["),
    { op: "local.set", index: L_OUT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_CAP },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // comma before every element after the first; then (#2166 PR-B) the
            // newline+indent separator (L_NL_IN, "" when compact) before each.
            { op: "local.get", index: L_I },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...appendLit(",")],
            },
            ...appendSep(L_NL_IN),
            // (#2166 PR-D3) the element index as a string key (also the toJSON key
            // per PR-D2). Computed once into L_CKEY: reused for the replacer call
            // and the recursion key.
            ...(numToStrIdxTJ === undefined
              ? ([{ op: "ref.null.extern" }] satisfies Instr[])
              : ([
                  { op: "local.get", index: L_I },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: numToStrIdxTJ },
                ] satisfies Instr[])),
            { op: "local.set", index: L_CKEY },
            // childV = data[i] (anyref). (#2166 PR-D3) If a function replacer is
            // present, transform it first: childV =
            //   replacer.call(/*this*/ array, idxKey, data[i]). §25.5.2 applies
            // the replacer to array elements too (SerializeJSONArray step 5 →
            // SerializeJSONProperty step 3). holder = this array as externref.
            { op: "local.get", index: L_DATA },
            { op: "local.get", index: L_I },
            { op: "array.get", typeIdx: objVecArrTypeIdx },
            { op: "any.convert_extern" },
            { op: "local.set", index: L_CHILDV },
            { op: "local.get", index: P_REPLACER },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_ANY },
                { op: "extern.convert_any" }, // holder = this array
                { op: "local.get", index: P_REPLACER },
                { op: "local.get", index: L_CKEY },
                { op: "local.get", index: L_CHILDV },
                { op: "extern.convert_any" },
                { op: "call", funcIdx: replacerDriverIdx },
                { op: "any.convert_extern" },
                { op: "local.set", index: L_CHILDV },
              ],
            },
            // piece = __json_stringify_value(childV, depth+1, gap, key=idxKey,
            //   holder=this array, replacer, allowList) — allowList threads
            // through unchanged (it only filters object keys, never array idx).
            { op: "local.get", index: L_CHILDV },
            { op: "local.get", index: P_DEPTH },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: P_GAP },
            { op: "local.get", index: L_CKEY },
            { op: "local.get", index: L_ANY },
            { op: "extern.convert_any" }, // holder = this array
            { op: "local.get", index: P_REPLACER },
            { op: "local.get", index: P_ALLOW },
            { op: "call", funcIdx },
            { op: "local.set", index: L_PIECE },
            // null piece (undefined element) → "null"
            { op: "local.get", index: L_PIECE },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...appendLit("null")],
              else: [...appendPiece],
            },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // (#2166 PR-B) closing-indent newline only for a non-empty array (§25.5.2:
    // an empty array stays "[]"). L_NL_OUT is "" when compact, so this is a
    // no-op there.
    { op: "local.get", index: L_CAP },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...appendSep(L_NL_OUT)],
    },
    ...appendLit("]"),
    { op: "local.get", index: L_OUT },
    { op: "return" },
  ];

  // ── object arm ($Object): "{" key0 ":" val0 "," ... "}" ──────────────────
  // Own enumerable string keys in insertion order via __obj_ordered. A property
  // whose value serialises to undefined (null piece) is omitted (§25.5.2).
  const objectArm: Instr[] = [
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: L_OBJ },
    { op: "local.get", index: L_OBJ },
    { op: "call", funcIdx: orderedIdx },
    { op: "local.set", index: L_ARR },
    { op: "local.get", index: L_ARR },
    { op: "array.len" },
    { op: "local.set", index: L_CAP },
    ...litStr("{"),
    { op: "local.set", index: L_OUT },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L_FIRST }, // 1 = no element emitted yet
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_CAP },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // e = arr[i]; ordered array is compacted — stop at first null
            { op: "local.get", index: L_ARR },
            { op: "local.get", index: L_I },
            { op: "array.get", typeIdx: propMapTypeIdx },
            { op: "local.tee", index: L_E },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            // (#2166 PR-D3) the property key as externref into L_CKEY, reused for
            // the allowlist test, the replacer call, the toJSON key, and quoting.
            { op: "local.get", index: L_E },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 }, // key: ref $AnyString
            { op: "extern.convert_any" },
            { op: "local.set", index: L_CKEY },
            // (#2166 PR-D3) array-form replacer (allowlist): if P_ALLOW is non-null
            // and this key is NOT in the allowlist, skip the property entirely
            // (§25.5.2 SerializeJSONObject step 5/6 — PropertyList membership).
            // The allowlist is a plain $Object of allowed keys; __extern_has is
            // the membership test.
            ...(externHasIdx === undefined
              ? []
              : ([
                  { op: "local.get", index: P_ALLOW },
                  { op: "ref.is_null" },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "local.get", index: P_ALLOW },
                      { op: "local.get", index: L_CKEY },
                      { op: "call", funcIdx: externHasIdx },
                      { op: "i32.eqz" }, // not a member?
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          // advance index and continue the loop without emitting
                          { op: "local.get", index: L_I },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          { op: "local.set", index: L_I },
                          { op: "br", depth: 2 }, // back to loop top
                        ],
                      },
                    ],
                  },
                ] satisfies Instr[])),
            // childV = e.value (anyref). (#2166 PR-D3) function replacer:
            //   childV = replacer.call(/*this*/ this object, key, e.value).
            { op: "local.get", index: L_E },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value:anyref
            { op: "local.set", index: L_CHILDV },
            { op: "local.get", index: P_REPLACER },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_ANY },
                { op: "extern.convert_any" }, // holder = this object
                { op: "local.get", index: P_REPLACER },
                { op: "local.get", index: L_CKEY },
                { op: "local.get", index: L_CHILDV },
                { op: "extern.convert_any" },
                { op: "call", funcIdx: replacerDriverIdx },
                { op: "any.convert_extern" },
                { op: "local.set", index: L_CHILDV },
              ],
            },
            // (#2166 PR-D3) §25.5.2: a function replacer that returns `undefined`
            // omits the property. The replacer's result arrives as a null anyref
            // (undefined ⇒ null externref ⇒ null anyref), so when a replacer was
            // applied AND childV is null, set piece=null (omit) WITHOUT recursing
            // — recursing would serialise null → the "null" literal. (A replacer
            // legitimately returning the JS value `null` is the same null carrier
            // and is also omitted here; a documented edge — the dominant use is
            // `return undefined` to drop a key.)
            { op: "local.get", index: P_REPLACER },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            { op: "local.get", index: L_CHILDV },
            { op: "ref.is_null" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: strRefNull },
              then: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
              else: [
                // piece = __json_stringify_value(childV, depth+1, gap, key,
                //   holder=this object, replacer, allowList)
                { op: "local.get", index: L_CHILDV },
                { op: "local.get", index: P_DEPTH },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.get", index: P_GAP },
                { op: "local.get", index: L_CKEY },
                { op: "local.get", index: L_ANY },
                { op: "extern.convert_any" }, // holder = this object
                { op: "local.get", index: P_REPLACER },
                { op: "local.get", index: P_ALLOW },
                { op: "call", funcIdx },
              ],
            },
            { op: "local.set", index: L_PIECE },
            // omit the property entirely if its value serialised to undefined
            { op: "local.get", index: L_PIECE },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // comma if not the first emitted property
                { op: "local.get", index: L_FIRST },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [...appendLit(",")],
                },
                { op: "i32.const", value: 0 },
                { op: "local.set", index: L_FIRST },
                // (#2166 PR-B) newline+indent before every property ("" compact)
                ...appendSep(L_NL_IN),
                // quote(key) <colon> piece — colon is ": " indented, ":" compact
                { op: "local.get", index: L_OUT },
                { op: "ref.as_non_null" },
                { op: "local.get", index: L_E },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 }, // key:ref $AnyString
                { op: "extern.convert_any" },
                { op: "call", funcIdx: quoteIdx },
                { op: "call", funcIdx: concatIdx },
                { op: "local.set", index: L_OUT },
                ...appendSep(L_COLON),
                ...appendPiece,
              ],
            },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // (#2166 PR-B) closing-indent newline only when at least one property was
    // emitted (L_FIRST == 0). An empty object stays "{}" (§25.5.2). L_NL_OUT is
    // "" when compact.
    { op: "local.get", index: L_FIRST },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...appendSep(L_NL_OUT)],
    },
    ...appendLit("}"),
    { op: "local.get", index: L_OUT },
    { op: "return" },
  ];

  // ── dispatch ──────────────────────────────────────────────────────────────
  const body: Instr[] = [
    // depth guard (circular-ref bound): return null on overflow.
    { op: "local.get", index: P_DEPTH },
    { op: "i32.const", value: MAX_JSON_DEPTH },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null", typeIdx: anyStrTypeIdx }, { op: "return" }],
    },
    // null ref → JSON "null"
    { op: "local.get", index: P_V },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...litStr("null"), { op: "return" }],
    },
    // (#2166 PR-B) compute the indent separators for the object/array arms.
    // Only those arms read them; primitive arms below return before use.
    ...setupSeparators,
    // any = v
    { op: "local.get", index: P_V },
    { op: "local.set", index: L_ANY },
    // ── (#2166 PR-D2) toJSON (§25.5.2 SerializeJSONProperty step 2.b) ──────────
    // If the value is an $Object with a callable own `toJSON`, replace it with
    // value.toJSON(key) before serialising. Look the method up via __extern_get
    // (a closure widened to externref) and ref-test it as a closure; the driver
    // (__call_to_json → __call_fn_method_1) binds the value as `this`. The
    // result re-enters the dispatch below (so toJSON may return any shape).
    ...(numToStrIdxTJ === undefined
      ? []
      : ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // m = __extern_get(extern.convert_any(any), "toJSON")
              { op: "local.get", index: L_ANY },
              { op: "extern.convert_any" },
              ...litStr("toJSON"),
              { op: "extern.convert_any" },
              { op: "call", funcIdx: externGetIdxTJ },
              { op: "local.set", index: L_TJM },
              // if m is a closure (non-null ref that any.convert_extern tests as
              // a $Closure-family struct) → call it. We approximate IsCallable by
              // a non-null check: __extern_get returns the stored method closure
              // (externref) or null. A non-closure own "toJSON" data value would
              // also be non-null, but JSON only meaningfully supports a function
              // here; the driver ref.casts to the closure wrapper and would trap
              // on a non-closure — so gate on ref.test against the closure base.
              //
              // (#3334, formerly #3328 — renumbered, id collision) Under the
              // #2106 `$undefined`-singleton regime the
              // MISS value of `__extern_get` is the tag-1 `$AnyValue` box —
              // NON-NULL — so a plain null check read every missing `toJSON`
              // as callable; the driver's closure ref.test then failed and
              // returned null, so `JSON.stringify({...})` through the reified
              // value / any-closure path serialised "null" for EVERY object.
              // A `$AnyValue` box is never a callable closure, so exclude the
              // whole carrier (tag-agnostic). Regime-gated: legacy modules
              // stay byte-identical (miss value there is genuine null).
              { op: "local.get", index: L_TJM },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              ...((undefinedSingletonActive(ctx) && anyValueTypeIdx >= 0
                ? [
                    { op: "local.get", index: L_TJM },
                    { op: "any.convert_extern" },
                    { op: "ref.test", typeIdx: anyValueTypeIdx },
                    { op: "i32.eqz" },
                    { op: "i32.and" },
                  ]
                : []) satisfies Instr[]),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // any = any.convert_extern(__call_to_json(value, m, key))
                  { op: "local.get", index: L_ANY },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_TJM },
                  { op: "local.get", index: P_KEY },
                  { op: "call", funcIdx: toJsonDriverIdx },
                  { op: "any.convert_extern" },
                  { op: "local.set", index: L_ANY },
                  // a toJSON returning null/undefined → JSON "null"
                  { op: "local.get", index: L_ANY },
                  { op: "ref.is_null" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...litStr("null"), { op: "return" }],
                  },
                ],
              },
            ],
          },
        ] satisfies Instr[])),
    ...buildRawJsonStringifyArm(ctx, L_ANY, objectTypeIdx, anyStrTypeIdx, externGetIdxTJ),
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: objectArm,
    },
    // (#4085) $__vec_base (a REAL JS array) → normalise to $ObjVec, then fall
    // into the $ObjVec arm below. Elements are read through `__extern_get_idx`,
    // which is already `$__vec_base`-aware (#2190) and handles every element
    // kind (f64 / i32 / externref / …), so this needs no per-elemKind cases.
    //
    // Ordering: this sits AFTER the `$Object` test and BEFORE the `$ObjVec`
    // test. A `__vec_<k>` struct is not a `$Object`, so the earlier arm cannot
    // claim it; re-pointing L_ANY here is what lets the untouched `$ObjVec` arm
    // do the actual serialisation.
    //
    // Known deviation: inside the arm, `holder` for a function `replacer` is the
    // normalised $ObjVec rather than the original array object. Only observable
    // via `this` in a replacer over an array; today the entire value serialises
    // as `null`, so this is strictly an improvement. Noted in #4085.
    ...(objVecNewIdx !== undefined && objVecPushIdx !== undefined && externGetIdxIdx !== undefined
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: vecBaseIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "call", funcIdx: objVecNewIdx },
              { op: "local.set", index: L_VB },
              { op: "local.get", index: L_ANY },
              { op: "ref.cast", typeIdx: vecBaseIdx },
              { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 }, // len
              { op: "local.set", index: L_VBLEN },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_VBI },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: L_VBI },
                      { op: "local.get", index: L_VBLEN },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      // __objvec_push(out, __extern_get_idx(vec, f64(i)))
                      { op: "local.get", index: L_VB },
                      { op: "local.get", index: L_ANY },
                      { op: "extern.convert_any" },
                      { op: "local.get", index: L_VBI },
                      { op: "f64.convert_i32_s" },
                      { op: "call", funcIdx: externGetIdxIdx },
                      { op: "call", funcIdx: objVecPushIdx },
                      { op: "local.get", index: L_VBI },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: L_VBI },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // Re-point the tested value at the $ObjVec so the arm below runs.
              { op: "local.get", index: L_VB },
              { op: "any.convert_extern" },
              { op: "local.set", index: L_ANY },
            ],
          },
        ] satisfies Instr[])
      : []),
    // $ObjVec?
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: arrayArm,
    },
    // $AnyString (native string)?
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: quoteIdx },
        { op: "return" },
      ],
    },
    // $__box_number_struct?
    ...(boxNumTypeIdx >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: boxNumTypeIdx },
          // (#3673) …or an i31-boxed small int.
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: -20 },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_ANY },
              { op: "ref.test", typeIdx: -20 },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "f64" } },
                then: [
                  { op: "local.get", index: L_ANY },
                  { op: "ref.cast", typeIdx: -20 },
                  { op: "i31.get_s" },
                  { op: "f64.convert_i32_s" },
                ],
                else: [
                  { op: "local.get", index: L_ANY },
                  { op: "ref.cast", typeIdx: boxNumTypeIdx },
                  { op: "struct.get", typeIdx: boxNumTypeIdx, fieldIdx: 0 },
                ],
              },
              { op: "local.set", index: L_NUM },
              ...formatNumber,
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    // $__box_boolean_struct?
    ...(boxBoolTypeIdx >= 0
      ? ([
          { op: "local.get", index: L_ANY },
          { op: "ref.test", typeIdx: boxBoolTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_ANY },
              { op: "ref.cast", typeIdx: boxBoolTypeIdx },
              { op: "struct.get", typeIdx: boxBoolTypeIdx, fieldIdx: 0 },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: [...litStr("true")],
                else: [...litStr("false")],
              },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    // $AnyValue (the parse-path tagged union)?
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: anyValueTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...anyValueArm, { op: "return" }],
    },
    // unsupported ref → serialises to undefined → null result (omit/null at caller)
    { op: "ref.null", typeIdx: anyStrTypeIdx },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__json_stringify_value",
    typeIdx,
    locals: [
      { count: 1, type: anyref }, // L_ANY
      { count: 1, type: { kind: "ref_null", typeIdx: objectTypeIdx } }, // L_OBJ
      { count: 1, type: { kind: "ref_null", typeIdx: propMapTypeIdx } }, // L_ARR
      { count: 1, type: { kind: "ref_null", typeIdx: objVecTypeIdx } }, // L_VEC
      { count: 1, type: i32 }, // L_CAP
      { count: 1, type: i32 }, // L_I
      { count: 1, type: { kind: "ref_null", typeIdx: propEntryTypeIdx } }, // L_E
      { count: 1, type: strRefNull }, // L_OUT (nullable; set before every read)
      { count: 1, type: strRefNull }, // L_PIECE
      { count: 1, type: i32 }, // L_FIRST
      { count: 1, type: f64 }, // L_NUM
      { count: 1, type: { kind: "ref", typeIdx: objVecArrTypeIdx } }, // L_DATA
      { count: 1, type: strRef }, // L_NL_IN  (#2166 PR-B — always set in prologue)
      { count: 1, type: strRef }, // L_NL_OUT
      { count: 1, type: strRef }, // L_COLON
      { count: 1, type: { kind: "externref" } }, // L_TJKEY (#2166 PR-D2)
      { count: 1, type: { kind: "externref" } }, // L_TJM   (#2166 PR-D2)
      { count: 1, type: anyref }, // L_CHILDV (#2166 PR-D3)
      { count: 1, type: { kind: "externref" } }, // L_CKEY (#2166 PR-D3)
      { count: 1, type: { kind: "externref" } }, // L_VB (#4085)
      { count: 1, type: i32 }, // L_VBLEN (#4085)
      { count: 1, type: i32 }, // L_VBI (#4085)
    ],
    // (#2166 PR-D2) Deep-clone so every `call`/operand occurrence is an
    // INDEPENDENT object. The body spreads shared helper `Instr[]` arrays
    // (appendPiece/appendSep/appendLit results) at multiple sites; without the
    // clone, `shiftLateImportIndices`'s de-dupe `shifted` Set visits a shared
    // object once and skips its other occurrences, leaving the lazily-reserved
    // `__call_to_json` driver call (and other late-shifted funcIdx) stale when a
    // later union import shifts indices — which surfaced as a "need 3, got 1"
    // validation failure on __json_stringify_value whenever a method-shorthand
    // closure forced a shift. NOTE: a JSON round-trip clone is WRONG here — the
    // number arm holds `f64.const Infinity`, and JSON.stringify(Infinity)→null
    // would corrupt it to 0. Use a structure-preserving deep clone instead.
    body: deepCloneInstrs(body),
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  // ── __json_stringify_root(v: anyref) -> ref $AnyString ────────────────────
  // The call-site entry: serialise at depth 0 and coalesce a null result (a
  // top-level value that serialises to JS `undefined` — function/symbol/an
  // unsupported ref) to the literal "null". Top-level `undefined` strictly
  // returns JS `undefined`, not "null"; object/array arguments (the routed
  // case) never serialise to undefined, so this only affects the rare
  // top-level-undefined edge — documented PR-A limitation. Returns a non-null
  // ref $AnyString so the call site sees the same type the primitive
  // string-stringify path returns.
  const rootTypeIdx = addFuncType(ctx, [anyref], [strRef]);
  const rootFuncIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("__json_stringify_root", rootFuncIdx);
  pushDefinedFunc(ctx, rootFuncIdx, {
    name: "__json_stringify_root",
    typeIdx: rootTypeIdx,
    locals: [{ count: 1, type: strRefNull }],
    body: [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      // (#2166 PR-B) compact form: null gap.
      { op: "ref.null", typeIdx: anyStrTypeIdx },
      // (#2166 PR-D2) root key is "" (§25.5.2 SerializeJSONProperty root call).
      ...litStr(""),
      { op: "extern.convert_any" },
      // (#2166 PR-D3) no replacer/allowlist on the plain compact root: holder,
      // replacer, allowList are all null.
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "call", funcIdx },
      { op: "local.tee", index: 1 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [...litStr("null")],
        else: [{ op: "local.get", index: 1 }, { op: "ref.as_non_null" }],
      },
    ],
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  // ── __json_stringify_root_indent(v: anyref, gap: ref null $AnyString) ──────
  // (#2166 PR-B) The pretty-print entry: serialise at depth 0 with the caller's
  // indent unit (`gap`). A null/empty gap behaves like the compact root
  // (the worker's separators collapse to ""). Same null→"null" coalescing as
  // the compact root.
  const rootIndentTypeIdx = addFuncType(ctx, [anyref, strRefNull], [strRef]);
  const rootIndentFuncIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("__json_stringify_root_indent", rootIndentFuncIdx);
  pushDefinedFunc(ctx, rootIndentFuncIdx, {
    name: "__json_stringify_root_indent",
    typeIdx: rootIndentTypeIdx,
    locals: [{ count: 1, type: strRefNull }],
    body: [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 }, // gap
      // (#2166 PR-D2) root key is "".
      ...litStr(""),
      { op: "extern.convert_any" },
      // (#2166 PR-D3) no replacer/allowlist on the plain indented root.
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "call", funcIdx },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [...litStr("null")],
        else: [{ op: "local.get", index: 2 }, { op: "ref.as_non_null" }],
      },
    ],
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  // ── __json_stringify_root_replacer(v: anyref, gap: ref null $AnyString,
  //     replacer: externref, allowList: externref) -> ref $AnyString ──────────
  // (#2166 PR-D3) The replacer/allowlist entry. Per §25.5.2: build the synthetic
  // root holder `{"": v}`, apply a function replacer to the root value itself
  // (`replacer.call(root, "", v)`), then serialise the (possibly transformed)
  // value with the holder/replacer/allowList threaded into the walk. A null gap
  // selects compact output; the worker's separators collapse to "".
  const newObjIdx = ctx.funcMap.get("__new_plain_object")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const rootRepTypeIdx = addFuncType(ctx, [anyref, strRefNull, { kind: "externref" }, { kind: "externref" }], [strRef]);
  const rootRepFuncIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("__json_stringify_root_replacer", rootRepFuncIdx);
  // locals: 4 RR_ROOT externref  5 RR_VAL anyref  6 RR_RES strRefNull
  const RR_ROOT = 4;
  const RR_VAL = 5;
  const RR_RES = 6;
  pushDefinedFunc(ctx, rootRepFuncIdx, {
    name: "__json_stringify_root_replacer",
    typeIdx: rootRepTypeIdx,
    locals: [
      { count: 1, type: { kind: "externref" } }, // RR_ROOT
      { count: 1, type: anyref }, // RR_VAL
      { count: 1, type: strRefNull }, // RR_RES
    ],
    body: [
      // val = v
      { op: "local.get", index: 0 },
      { op: "local.set", index: RR_VAL },
      // root = __new_plain_object(); root[""] = v
      { op: "call", funcIdx: newObjIdx },
      { op: "local.set", index: RR_ROOT },
      { op: "local.get", index: RR_ROOT },
      ...litStr(""),
      { op: "extern.convert_any" },
      { op: "local.get", index: RR_VAL },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: externSetIdx },
      // §25.5.2 step 3 — a function replacer transforms the root value too:
      //   val = replacer.call(root, "", val). A null replacer (array-form) skips.
      { op: "local.get", index: 2 }, // replacer
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: RR_ROOT }, // holder = root
          { op: "local.get", index: 2 }, // replacer
          ...litStr(""),
          { op: "extern.convert_any" }, // key = ""
          { op: "local.get", index: RR_VAL },
          { op: "extern.convert_any" }, // value
          { op: "call", funcIdx: replacerDriverIdx },
          { op: "any.convert_extern" },
          { op: "local.set", index: RR_VAL },
        ],
      },
      // res = __json_stringify_value(val, 0, gap, key="", holder=root,
      //   replacer, allowList)
      { op: "local.get", index: RR_VAL },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 }, // gap
      ...litStr(""),
      { op: "extern.convert_any" }, // root key ""
      { op: "local.get", index: RR_ROOT }, // holder = root
      { op: "local.get", index: 2 }, // replacer
      { op: "local.get", index: 3 }, // allowList
      { op: "call", funcIdx },
      { op: "local.tee", index: RR_RES },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [...litStr("null")],
        else: [{ op: "local.get", index: RR_RES }, { op: "ref.as_non_null" }],
      },
    ],
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return funcIdx;
}

// ───────────────────────────────────────────────────────────────────────────
// PR-C: `JSON.parse` of a dynamic graph — `__json_parse_text`
// ───────────────────────────────────────────────────────────────────────────

/**
 * Emit the pure-Wasm recursive-descent `JSON.parse` codec (#2166 PR-C) and
 * register `__json_parse_text(s: externref) -> anyref` in `ctx.funcMap`.
 * Idempotent. Standalone / WASI only.
 *
 * The grammar is ECMA-404 / ECMA-262 §25.5.1 (strict JSON — no comments, no
 * trailing commas, no single quotes). The output uses the SAME value
 * representation the standalone object runtime and the `__json_stringify_value`
 * codec consume, so a round-trip `JSON.parse(JSON.stringify(o))` and downstream
 * property reads (`__extern_get`) work without conversion:
 *
 *   - object → a fresh `$Object` (built via `__new_plain_object` +
 *     `__extern_set`), widened to `anyref`. Members preserve insertion order.
 *   - array  → a fresh `$ObjVec` (built via `__objvec_new` + `__objvec_push`),
 *     widened to `anyref`.
 *   - string → a native `$AnyString` (the unescaped code units), widened to
 *     `anyref` — the same carrier object/array element reads already see.
 *   - number → boxed into the `$AnyValue` tagged union (tag 3, f64).
 *   - true / false → `$AnyValue` tag 4; null → `$AnyValue` tag 0.
 *
 * A grammar violation (or trailing non-whitespace) throws a runtime
 * `SyntaxError` via the standalone `__new_SyntaxError` constructor — matching
 * §25.5.1 step 3 — instead of trapping. The result `anyref` flows through the
 * existing `$AnyValue`/object coercion paths in type-coercion.ts.
 *
 * Implementation note: the mutually-recursive value/string parsers share a
 * cursor through a `$JsonP` parser-state struct (`{ data, pos(mut), end }`).
 * That struct is passed as a bare **`anyref`** parameter (and `ref.cast` back
 * inside each helper) rather than as `ref $JsonP`. A fresh GC struct type that
 * appears in a *function-signature* parameter has tripped the dead-type-
 * elimination remap in this codebase (the func-type param and the in-body
 * `struct.get` operand can diverge after compaction); keeping the fresh
 * `$JsonP` index off every signature and confined to `struct.new`/`struct.get`/
 * `struct.set`/`ref.cast` instruction operands — which `remapTypeIdxInBody`
 * rewrites uniformly — sidesteps that hazard.
 *
 * Returns the `__json_parse_text` funcIdx.
 */
export function emitJsonParseText(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_parse_text");
  if (existing !== undefined) return existing;

  // Dependencies (all idempotent).
  ensureNativeStringHelpers(ctx);
  ensureAnyValueType(ctx);
  ensureObjectRuntime(ctx);
  // The standalone SyntaxError constructor + the exception tag for the throw.
  emitWasiErrorConstructor(ctx, "SyntaxError", 1);

  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const newObjIdx = ctx.funcMap.get("__new_plain_object")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;
  const missingDependencies = [
    ["__str_flatten", flattenIdx],
    ["__new_plain_object", newObjIdx],
    ["__extern_set", externSetIdx],
    ["__objvec_new", objVecNewIdx],
    ["__objvec_push", objVecPushIdx],
  ].flatMap(([name, idx]) => (idx === undefined ? [name] : []));
  if (missingDependencies.length > 0) {
    throw new Error(`native JSON.parse provider is missing dependencies: ${missingDependencies.join(", ")}`);
  }

  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const anyref: ValType = { kind: "anyref" };
  const externref: ValType = { kind: "externref" };

  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString { len, off, data }
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx; // (array (mut i16))
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  // Box parsed primitives into the SAME standalone boxed structs the object
  // runtime + `__unbox_number` understand (`$__box_number_struct {value:f64}`,
  // `$__box_boolean_struct {value:i32}`), NOT `$AnyValue`. A value stored into a
  // `$Object` via `__extern_set` is read back via the property path, whose
  // externref→number/boolean coercion only unboxes the `$__box_*` structs — an
  // `$AnyValue` would read back as NaN/undefined. (Top-level primitive parse
  // results unbox fine either way, but object/array members must use these.)
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolTypeIdx = ctx.nativeBoxBooleanTypeIdx;
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const strRefNative: ValType = { kind: "ref", typeIdx: strTypeIdx };

  // ── $JsonP parser-state struct: { data: ref $strData, pos: (mut i32), end: i32 } ──
  // Confined to instruction operands only (never a function signature) — see the
  // doc-comment above for why.
  const jsonPTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$JsonP",
    // `$`-prefixed field names so `resolveSameShapeFieldNameCollisions` (which
    // skips `$`-prefixed fields) leaves this internal struct alone: a plain
    // `data`/`pos`/`end` triple collides with other structs' field names and
    // gets shape-canonicalised, which split the struct across two type indices
    // and desynced the in-body `struct.get` operand from the local's declared
    // type (`expected (ref 54), found (ref 72)`).
    fields: [
      { name: "$data", type: strDataRef, mutable: false },
      { name: "$pos", type: i32, mutable: true },
      { name: "$end", type: i32, mutable: false },
    ],
  } as unknown as (typeof ctx.mod.types)[number]);

  // ── throwSyntaxError(msg): build & throw a standalone SyntaxError ──────────
  // Mirrors emitThrowRegExpSyntaxError but as a body-level Instr[] (no fctx):
  // intern the message global, construct via __new_SyntaxError, throw via the
  // shared exception tag. A trailing `unreachable` makes the post-throw stack
  // polymorphic so the enclosing block's declared result type still validates.
  const tagIdx = ensureExnTag(ctx);
  const ctorIdx = ctx.funcMap.get("__new_SyntaxError")!;
  if (ctorIdx === undefined) {
    throw new Error("native JSON.parse provider is missing dependency: __new_SyntaxError");
  }
  const throwSyntaxError = (msg: string): Instr[] => {
    addStringConstantGlobal(ctx, msg);
    return [
      ...stringConstantExternrefInstrs(ctx, msg),
      { op: "call", funcIdx: ctorIdx },
      { op: "throw", tagIdx },
      { op: "unreachable" },
    ];
  };

  // ════════════════════════════════════════════════════════════════════════
  // Pre-register the three recursive funcIdx values so the bodies can call
  // each other / themselves. All signatures use only primitive/anyref/externref
  // types — the fresh $JsonP index never reaches a func type.
  // ════════════════════════════════════════════════════════════════════════
  const valueTypeIdx = addFuncType(ctx, [anyref], [anyref]); // (p:anyref) -> value:anyref
  // (#1916 S3b) stable-regime handles — the old `valueFuncIdx + 1/+ 2` sibling
  // derivation (which assumed the three functions land consecutively) is
  // replaced by three explicit mints; pushes record the real positions.
  const valueFuncIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__json_parse_value", valueFuncIdx);

  const strParseTypeIdx = addFuncType(ctx, [anyref], [strRefNative]); // (p:anyref) -> ref $NativeString
  const strParseFuncIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__json_parse_str", strParseFuncIdx);

  const textTypeIdx = addFuncType(ctx, [externref], [anyref]);
  const textFuncIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__json_parse_text", textFuncIdx);

  // ════════════════════════════════════════════════════════════════════════
  // __json_parse_value(p: anyref) -> anyref
  // ════════════════════════════════════════════════════════════════════════
  // params: 0 p:anyref
  const V_P = 0; // anyref (the $JsonP, re-cast on entry)
  const V_PS = 1; // ref $JsonP (cast result)
  const V_DATA = 2; // ref $strData
  const V_POS = 3; // i32 cursor
  const V_END = 4; // i32
  const V_C = 5; // i32 current code unit
  const V_OBJ = 6; // externref (object/array under construction)
  const V_KEY = 7; // ref $NativeString (object key)
  const V_VAL = 8; // anyref (recursive child)
  const V_NUM = 9; // f64
  const V_MANT = 10; // f64
  const V_SIGN = 11; // f64
  const V_EXP = 12; // i32
  const V_EXPSIGN = 13; // i32
  const V_EXPMAG = 14; // i32

  // p (anyref) → ref $JsonP in V_PS, done once at entry.
  const castP: Instr[] = [
    { op: "local.get", index: V_P },
    { op: "ref.cast", typeIdx: jsonPTypeIdx },
    { op: "local.set", index: V_PS },
  ];
  const loadPos: Instr[] = [
    { op: "local.get", index: V_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: V_POS },
  ];
  const storePos: Instr[] = [
    { op: "local.get", index: V_PS },
    { op: "local.get", index: V_POS },
    { op: "struct.set", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
  ];
  const loadC: Instr[] = [
    { op: "local.get", index: V_DATA },
    { op: "local.get", index: V_POS },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: V_C },
  ];
  const cEqV = (code: number): Instr[] => [
    { op: "local.get", index: V_C },
    { op: "i32.const", value: code },
    { op: "i32.eq" },
  ];

  const skipWsV: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: V_POS },
            { op: "local.get", index: V_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...loadC,
            ...cEqV(32),
            ...cEqV(9),
            { op: "i32.or" },
            ...cEqV(10),
            { op: "i32.or" },
            ...cEqV(13),
            { op: "i32.or" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  // Expect data[pos]==code then advance; mismatch/EOF → SyntaxError(msg).
  const expectChar = (code: number, msg: string): Instr[] => [
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError(msg) },
    ...loadC,
    ...cEqV(code),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError(msg) },
    { op: "local.get", index: V_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: V_POS },
  ];

  // Match a literal keyword (true/false/null) at pos; advance, else SyntaxError.
  const matchKeyword = (word: string): Instr[] => {
    const out: Instr[] = [];
    for (let k = 0; k < word.length; k++) {
      out.push(
        { op: "local.get", index: V_POS },
        { op: "local.get", index: V_END },
        { op: "i32.ge_s" },
        { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
        { op: "local.get", index: V_DATA },
        { op: "local.get", index: V_POS },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.const", value: word.charCodeAt(k) },
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected token in JSON") },
        { op: "local.get", index: V_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: V_POS },
      );
    }
    return out;
  };

  // Primitive box helpers (leave an `anyref` on the stack). Numbers/booleans use
  // the standalone boxed structs so object/array member reads unbox them; JSON
  // `null` becomes a null eqref (reads back as `null`, distinct from a missing
  // property which reads `undefined`).
  const boxNullAny: Instr[] = [{ op: "ref.null", typeIdx: EQ_HEAP_TYPE }];
  // JSON booleans box as a `$__box_number_struct` holding 1.0/0.0 — the SAME
  // representation `o.t = true` produces in a standalone object (TS `true` is an
  // i32 and the i32→externref store path boxes it as a number, #2166 PR-A note).
  // Matching it keeps member reads/round-trips consistent (`o.t ? …` works); a
  // distinct boolean identity (`o.t === true`) is the broader standalone
  // boolean-boxing gap (overlaps #1917), out of PR-C scope.
  void boxBoolTypeIdx;
  const boxBoolAny = (v: number): Instr[] => [
    { op: "f64.const", value: v },
    { op: "struct.new", typeIdx: boxNumTypeIdx },
  ];
  const boxF64AnyFromLocal = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "struct.new", typeIdx: boxNumTypeIdx },
  ];

  // (#2721) JSON number-grammar guards (§25.5.1 / JSON.org `number`). Host
  // `JSON.parse` rejects a leading zero followed by another digit ("01") and a
  // decimal point with no following digit ("1."); the hand-written parser below
  // was too permissive and silently accepted both. These reusable Instr[]
  // blocks throw a standalone `SyntaxError` (via `throwSyntaxError`) to match.
  //
  // integerStartGuard: cursor is at the first integer digit (after the optional
  // '-'). The JSON grammar requires `int = "0" / (digit1-9 *DIGIT)`, so:
  //   (1) EOF here is invalid (a lone "-") → SyntaxError. This ALSO keeps the
  //       guard bounds-safe — `loadC` below reads `data[V_POS]`, which would
  //       trap out-of-bounds for a lone "-" where V_POS has reached V_END.
  //   (2) a non-digit here is invalid → SyntaxError.
  //   (3) a leading '0' (48) followed by another digit ("01") is invalid.
  // Leaves V_C clobbered (the integer loop re-loads it); touches no other state.
  const integerStartGuard: Instr[] = [
    // (1) EOF → SyntaxError (also makes the loadC below in-bounds).
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
    // (2) first integer char must be a digit.
    ...loadC, // V_C = data[V_POS]
    { op: "local.get", index: V_C },
    { op: "i32.const", value: 48 },
    { op: "i32.lt_s" },
    { op: "local.get", index: V_C },
    { op: "i32.const", value: 57 },
    { op: "i32.gt_s" },
    { op: "i32.or" }, // not a digit
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected token in JSON") },
    // (3) leading zero followed by another digit → SyntaxError. V_C still holds
    //     data[V_POS] from the loadC above.
    { op: "local.get", index: V_C },
    { op: "i32.const", value: 48 },
    { op: "i32.eq" }, // data[V_POS] == '0'
    { op: "local.get", index: V_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: V_END },
    { op: "i32.lt_s" }, // V_POS+1 < V_END (a next char exists)
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: V_DATA },
        { op: "local.get", index: V_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "local.set", index: V_C }, // V_C = data[V_POS+1]
        { op: "local.get", index: V_C },
        { op: "i32.const", value: 48 },
        { op: "i32.ge_s" },
        { op: "local.get", index: V_C },
        { op: "i32.const", value: 57 },
        { op: "i32.le_s" },
        { op: "i32.and" }, // next char is a digit
        { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected number in JSON") },
      ],
    },
  ];

  // digitRequiredGuard: at least one DIGIT is required at the cursor, else
  // SyntaxError. Used after the '.' (`frac = "." 1*DIGIT` — rejects "1.",
  // "1.e5") and after the exponent 'e'/'E' + optional sign (`exp = e [sign]
  // 1*DIGIT` — rejects "1e", "1e+"). EOF here is also invalid. Leaves V_C
  // clobbered (the following digit loop re-loads it).
  const digitRequiredGuard: Instr[] = [
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
    ...loadC, // V_C = data[V_POS]
    { op: "local.get", index: V_C },
    { op: "i32.const", value: 48 },
    { op: "i32.lt_s" },
    { op: "local.get", index: V_C },
    { op: "i32.const", value: 57 },
    { op: "i32.gt_s" },
    { op: "i32.or" }, // not a digit
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected token in JSON") },
  ];

  // number parser (cursor at '-'/digit) → f64 in V_NUM; advances V_POS.
  const parseNumberV: Instr[] = [
    { op: "f64.const", value: 1 },
    { op: "local.set", index: V_SIGN },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: V_MANT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: V_EXP },
    ...loadC,
    ...cEqV(45),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: -1 },
        { op: "local.set", index: V_SIGN },
        { op: "local.get", index: V_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: V_POS },
      ],
    },
    // (#2721) Require an integer digit (reject lone "-"); reject a leading zero
    // followed by another digit ("01").
    ...integerStartGuard,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: V_POS },
            { op: "local.get", index: V_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...loadC,
            { op: "local.get", index: V_C },
            { op: "i32.const", value: 48 },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: V_C },
            { op: "i32.const", value: 57 },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: V_MANT },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.get", index: V_C },
            { op: "i32.const", value: 48 },
            { op: "i32.sub" },
            { op: "f64.convert_i32_s" },
            { op: "f64.add" },
            { op: "local.set", index: V_MANT },
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // fraction
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...loadC,
        ...cEqV(46),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            // (#2721) Require ≥1 digit after the decimal point ("1." is invalid).
            ...digitRequiredGuard,
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: V_POS },
                    { op: "local.get", index: V_END },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    ...loadC,
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.lt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 57 },
                    { op: "i32.gt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: V_MANT },
                    { op: "f64.const", value: 10 },
                    { op: "f64.mul" },
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.sub" },
                    { op: "f64.convert_i32_s" },
                    { op: "f64.add" },
                    { op: "local.set", index: V_MANT },
                    { op: "local.get", index: V_EXP },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.set", index: V_EXP },
                    { op: "local.get", index: V_POS },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: V_POS },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    // exponent
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...loadC,
        ...cEqV(101),
        ...cEqV(69),
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: V_EXPSIGN },
            { op: "local.get", index: V_POS },
            { op: "local.get", index: V_END },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...loadC,
                ...cEqV(45),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: -1 },
                    { op: "local.set", index: V_EXPSIGN },
                    { op: "local.get", index: V_POS },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: V_POS },
                  ],
                  else: [
                    ...cEqV(43),
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: V_POS },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: V_POS },
                      ],
                    },
                  ],
                },
              ],
            },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: V_EXPMAG },
            // (#2721) Require ≥1 exponent digit ("1e", "1e+" are invalid).
            ...digitRequiredGuard,
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: V_POS },
                    { op: "local.get", index: V_END },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    ...loadC,
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.lt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 57 },
                    { op: "i32.gt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: V_EXPMAG },
                    { op: "i32.const", value: 10 },
                    { op: "i32.mul" },
                    { op: "local.get", index: V_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.sub" },
                    { op: "i32.add" },
                    { op: "local.set", index: V_EXPMAG },
                    { op: "local.get", index: V_POS },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: V_POS },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            { op: "local.get", index: V_EXP },
            { op: "local.get", index: V_EXPSIGN },
            { op: "local.get", index: V_EXPMAG },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "local.set", index: V_EXP },
          ],
        },
      ],
    },
    // result = sign*mant*10^exp → V_NUM (reuse V_NUM as running pow)
    { op: "f64.const", value: 1 },
    { op: "local.set", index: V_NUM },
    { op: "local.get", index: V_EXP },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: V_EXP },
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: V_NUM },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: V_NUM },
                { op: "local.get", index: V_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: V_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
      else: [
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: V_EXP },
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: V_NUM },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "local.set", index: V_NUM },
                { op: "local.get", index: V_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: V_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    { op: "local.get", index: V_SIGN },
    { op: "local.get", index: V_MANT },
    { op: "f64.mul" },
    { op: "local.get", index: V_NUM },
    { op: "f64.mul" },
    { op: "local.set", index: V_NUM },
  ];

  const valueBody: Instr[] = [
    ...castP,
    { op: "local.get", index: V_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: V_DATA },
    ...loadPos,
    { op: "local.get", index: V_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: V_END },
    ...skipWsV,
    { op: "local.get", index: V_POS },
    { op: "local.get", index: V_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
    ...loadC,
    ...storePos,
    // '{' → object
    ...cEqV(123),
    {
      op: "if",
      blockType: { kind: "val", type: anyref },
      then: [
        { op: "local.get", index: V_POS },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: V_POS },
        ...storePos,
        { op: "call", funcIdx: newObjIdx },
        { op: "local.set", index: V_OBJ },
        ...skipWsV,
        ...storePos,
        { op: "local.get", index: V_POS },
        { op: "local.get", index: V_END },
        { op: "i32.ge_s" },
        { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
        ...loadC,
        ...cEqV(125), // '}'
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            ...storePos,
          ],
          else: [
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    ...skipWsV,
                    ...storePos,
                    // key = __json_parse_str(p)
                    { op: "local.get", index: V_P },
                    { op: "call", funcIdx: strParseFuncIdx },
                    { op: "local.set", index: V_KEY },
                    ...loadPos,
                    ...skipWsV,
                    ...storePos,
                    ...expectChar(58, "Expected ':' after property name in JSON"),
                    ...storePos,
                    // val = __json_parse_value(p)
                    { op: "local.get", index: V_P },
                    { op: "call", funcIdx: valueFuncIdx },
                    { op: "local.set", index: V_VAL },
                    ...loadPos,
                    // __extern_set(obj, key(externref), val(externref))
                    { op: "local.get", index: V_OBJ },
                    { op: "local.get", index: V_KEY },
                    { op: "extern.convert_any" },
                    { op: "local.get", index: V_VAL },
                    { op: "extern.convert_any" },
                    { op: "call", funcIdx: externSetIdx },
                    ...skipWsV,
                    ...storePos,
                    { op: "local.get", index: V_POS },
                    { op: "local.get", index: V_END },
                    { op: "i32.ge_s" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: throwSyntaxError("Unexpected end of JSON input"),
                    },
                    ...loadC,
                    ...cEqV(44), // ','
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: V_POS },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: V_POS },
                        ...storePos,
                        { op: "br", depth: 1 }, // continue member loop
                      ],
                    },
                    ...cEqV(125), // '}'
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: V_POS },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: V_POS },
                        ...storePos,
                        { op: "br", depth: 2 }, // break member loop
                      ],
                    },
                    ...throwSyntaxError("Expected ',' or '}' after property value in JSON"),
                  ],
                },
              ],
            },
          ],
        },
        { op: "local.get", index: V_OBJ },
        { op: "any.convert_extern" },
      ],
      else: [
        // '[' → array
        ...cEqV(91),
        {
          op: "if",
          blockType: { kind: "val", type: anyref },
          then: [
            { op: "local.get", index: V_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: V_POS },
            ...storePos,
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.set", index: V_OBJ },
            ...skipWsV,
            ...storePos,
            { op: "local.get", index: V_POS },
            { op: "local.get", index: V_END },
            { op: "i32.ge_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: throwSyntaxError("Unexpected end of JSON input"),
            },
            ...loadC,
            ...cEqV(93), // ']'
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: V_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: V_POS },
                ...storePos,
              ],
              else: [
                {
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        ...storePos,
                        { op: "local.get", index: V_P },
                        { op: "call", funcIdx: valueFuncIdx },
                        { op: "local.set", index: V_VAL },
                        ...loadPos,
                        { op: "local.get", index: V_OBJ },
                        { op: "local.get", index: V_VAL },
                        { op: "extern.convert_any" },
                        { op: "call", funcIdx: objVecPushIdx },
                        ...skipWsV,
                        ...storePos,
                        { op: "local.get", index: V_POS },
                        { op: "local.get", index: V_END },
                        { op: "i32.ge_s" },
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: throwSyntaxError("Unexpected end of JSON input"),
                        },
                        ...loadC,
                        ...cEqV(44), // ','
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: V_POS },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: V_POS },
                            ...storePos,
                            { op: "br", depth: 1 }, // continue element loop
                          ],
                        },
                        ...cEqV(93), // ']'
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: [
                            { op: "local.get", index: V_POS },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: V_POS },
                            ...storePos,
                            { op: "br", depth: 2 }, // break element loop
                          ],
                        },
                        ...throwSyntaxError("Expected ',' or ']' after array element in JSON"),
                      ],
                    },
                  ],
                },
              ],
            },
            { op: "local.get", index: V_OBJ },
            { op: "any.convert_extern" },
          ],
          else: [
            // '"' → string value
            ...cEqV(34),
            {
              op: "if",
              blockType: { kind: "val", type: anyref },
              then: [
                { op: "local.get", index: V_P },
                { op: "call", funcIdx: strParseFuncIdx },
              ],
              else: [
                // 't' → true
                ...cEqV(116),
                {
                  op: "if",
                  blockType: { kind: "val", type: anyref },
                  then: [...matchKeyword("true"), ...storePos, ...boxBoolAny(1)],
                  else: [
                    // 'f' → false
                    ...cEqV(102),
                    {
                      op: "if",
                      blockType: { kind: "val", type: anyref },
                      then: [...matchKeyword("false"), ...storePos, ...boxBoolAny(0)],
                      else: [
                        // 'n' → null
                        ...cEqV(110),
                        {
                          op: "if",
                          blockType: { kind: "val", type: anyref },
                          then: [...matchKeyword("null"), ...storePos, ...boxNullAny],
                          else: [
                            // number: '-' or digit, else SyntaxError
                            ...cEqV(45),
                            { op: "local.get", index: V_C },
                            { op: "i32.const", value: 48 },
                            { op: "i32.ge_s" },
                            { op: "local.get", index: V_C },
                            { op: "i32.const", value: 57 },
                            { op: "i32.le_s" },
                            { op: "i32.and" },
                            { op: "i32.or" },
                            {
                              op: "if",
                              blockType: { kind: "val", type: anyref },
                              then: [...parseNumberV, ...storePos, ...boxF64AnyFromLocal(V_NUM)],
                              else: throwSyntaxError("Unexpected token in JSON"),
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  // ════════════════════════════════════════════════════════════════════════
  // __json_parse_str(p: anyref) -> ref $NativeString
  //   Cursor at opening '"'. Allocate a backing array sized to the raw span (an
  //   upper bound — escapes only shrink), fill the unescaped code units, then
  //   struct.new $NativeString(count, 0, data) with the real count (<= cap).
  // ════════════════════════════════════════════════════════════════════════
  const S_P = 0; // anyref
  const S_PS = 1; // ref $JsonP
  const S_DATA = 2; // ref $strData (input)
  const S_POS = 3; // i32
  const S_END = 4; // i32
  const S_START = 5; // i32 span start (after '"')
  const S_RAWEND = 6; // i32 closing '"' index
  const S_OUT = 7; // ref $strData (output buffer)
  const S_N = 8; // i32 output count
  const S_C = 9; // i32
  const S_HEX = 10; // i32 \uXXXX
  const S_K = 11; // i32 hex loop counter
  const S_SCAN = 12; // i32 first-pass scan cursor

  const sLoadC: Instr[] = [
    { op: "local.get", index: S_DATA },
    { op: "local.get", index: S_POS },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: S_C },
  ];
  const sAdvance: Instr[] = [
    { op: "local.get", index: S_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: S_POS },
  ];
  const sEmit = (valueInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: S_OUT },
    { op: "local.get", index: S_N },
    ...valueInstrs,
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: S_N },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: S_N },
  ];
  const sHexDigit: Instr[] = [
    { op: "local.get", index: S_POS },
    { op: "local.get", index: S_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
    ...sLoadC,
    // §25.5.1 HexDigit strictness: c must be 0-9 (48-57), A-F (65-70) or a-f
    // (97-102). A non-hex byte (e.g. the `"` in a short `\u005"` escape, or the
    // `X` in `\u0X50`) is a SyntaxError — the old code silently treated ANY
    // byte as a digit, accepting invalid escapes (15.12.1.1-g5-2 / g5-3).
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 48 },
    { op: "i32.ge_s" },
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 57 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 65 },
    { op: "i32.ge_s" },
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 70 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 97 },
    { op: "i32.ge_s" },
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 102 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Bad Unicode escape in JSON") },
    { op: "local.get", index: S_HEX },
    { op: "i32.const", value: 4 },
    { op: "i32.shl" },
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 58 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [{ op: "local.get", index: S_C }, { op: "i32.const", value: 48 }, { op: "i32.sub" }],
      else: [
        { op: "local.get", index: S_C },
        { op: "i32.const", value: 97 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [{ op: "local.get", index: S_C }, { op: "i32.const", value: 87 }, { op: "i32.sub" }],
          else: [{ op: "local.get", index: S_C }, { op: "i32.const", value: 55 }, { op: "i32.sub" }],
        },
      ],
    },
    { op: "i32.add" },
    { op: "local.set", index: S_HEX },
    ...sAdvance,
  ];

  const strParseBody: Instr[] = [
    { op: "local.get", index: S_P },
    { op: "ref.cast", typeIdx: jsonPTypeIdx },
    { op: "local.set", index: S_PS },
    { op: "local.get", index: S_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: S_DATA },
    { op: "local.get", index: S_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: S_POS },
    { op: "local.get", index: S_PS },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: S_END },
    // opening '"'
    { op: "local.get", index: S_POS },
    { op: "local.get", index: S_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input") },
    ...sLoadC,
    { op: "local.get", index: S_C },
    { op: "i32.const", value: 34 },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected token in JSON") },
    ...sAdvance,
    { op: "local.get", index: S_POS },
    { op: "local.set", index: S_START },
    // first pass: scan to closing quote
    { op: "local.get", index: S_POS },
    { op: "local.set", index: S_SCAN },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: S_SCAN },
            { op: "local.get", index: S_END },
            { op: "i32.ge_s" },
            { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unterminated string in JSON") },
            { op: "local.get", index: S_DATA },
            { op: "local.get", index: S_SCAN },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: S_C },
            { op: "local.get", index: S_C },
            { op: "i32.const", value: 34 },
            { op: "i32.eq" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: S_C },
            { op: "i32.const", value: 92 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: S_SCAN },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: S_SCAN },
              ],
            },
            { op: "local.get", index: S_SCAN },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: S_SCAN },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: S_SCAN },
    { op: "local.set", index: S_RAWEND },
    // buffer capacity = rawEnd - start
    { op: "local.get", index: S_RAWEND },
    { op: "local.get", index: S_START },
    { op: "i32.sub" },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: S_OUT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: S_N },
    // second pass: copy/unescape until rawEnd
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: S_POS },
            { op: "local.get", index: S_RAWEND },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...sLoadC,
            { op: "local.get", index: S_C },
            { op: "i32.const", value: 92 }, // '\'
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...sAdvance,
                { op: "local.get", index: S_POS },
                { op: "local.get", index: S_RAWEND },
                { op: "i32.ge_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: throwSyntaxError("Unterminated string in JSON"),
                },
                ...sLoadC,
                { op: "local.get", index: S_C },
                { op: "i32.const", value: 117 }, // 'u'
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    ...sAdvance,
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: S_HEX },
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: S_K },
                    {
                      op: "block",
                      blockType: { kind: "empty" },
                      body: [
                        {
                          op: "loop",
                          blockType: { kind: "empty" },
                          body: [
                            { op: "local.get", index: S_K },
                            { op: "i32.const", value: 4 },
                            { op: "i32.ge_s" },
                            { op: "br_if", depth: 1 },
                            ...sHexDigit,
                            { op: "local.get", index: S_K },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: S_K },
                            { op: "br", depth: 0 },
                          ],
                        },
                      ],
                    },
                    ...sEmit([{ op: "local.get", index: S_HEX }]),
                  ],
                  else: [
                    ...sEmit([
                      { op: "local.get", index: S_C },
                      { op: "i32.const", value: 98 }, // 'b'
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: i32 },
                        then: [{ op: "i32.const", value: 8 }],
                        else: [
                          { op: "local.get", index: S_C },
                          { op: "i32.const", value: 102 }, // 'f'
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: i32 },
                            then: [{ op: "i32.const", value: 12 }],
                            else: [
                              { op: "local.get", index: S_C },
                              { op: "i32.const", value: 110 }, // 'n'
                              { op: "i32.eq" },
                              {
                                op: "if",
                                blockType: { kind: "val", type: i32 },
                                then: [{ op: "i32.const", value: 10 }],
                                else: [
                                  { op: "local.get", index: S_C },
                                  { op: "i32.const", value: 114 }, // 'r'
                                  { op: "i32.eq" },
                                  {
                                    op: "if",
                                    blockType: { kind: "val", type: i32 },
                                    then: [{ op: "i32.const", value: 13 }],
                                    else: [
                                      { op: "local.get", index: S_C },
                                      { op: "i32.const", value: 116 }, // 't'
                                      { op: "i32.eq" },
                                      {
                                        op: "if",
                                        blockType: { kind: "val", type: i32 },
                                        then: [{ op: "i32.const", value: 9 }],
                                        else: [{ op: "local.get", index: S_C }],
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ]),
                    ...sAdvance,
                  ],
                },
              ],
              else: [
                // §25.5.1 JSONString grammar: unescaped code units U+0000..U+001F
                // are NOT permitted in a JSON string — they must be escaped. An
                // unescaped control byte is a SyntaxError (15.12.1.1-g4-*). The
                // old copy loop passed them through verbatim.
                { op: "local.get", index: S_C },
                { op: "i32.const", value: 0x20 },
                { op: "i32.lt_u" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: throwSyntaxError("Bad control character in string literal in JSON"),
                },
                ...sEmit([{ op: "local.get", index: S_C }]),
                ...sAdvance,
              ],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // advance past closing quote, write cursor back into p.pos
    { op: "local.get", index: S_RAWEND },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: S_POS },
    { op: "local.get", index: S_PS },
    { op: "local.get", index: S_POS },
    { op: "struct.set", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
    // struct.new $NativeString(len=S_N, off=0, data=S_OUT)
    { op: "local.get", index: S_N },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: S_OUT },
    { op: "struct.new", typeIdx: strTypeIdx },
  ];

  // ════════════════════════════════════════════════════════════════════════
  // __json_parse_text(s: externref) -> anyref  (entry)
  // ════════════════════════════════════════════════════════════════════════
  const T_S = 0;
  const T_FLAT = 1; // ref $NativeString
  const T_P = 2; // ref $JsonP
  const T_RESULT = 3; // anyref
  const T_POS = 4; // i32
  const T_END = 5; // i32
  const T_DATA = 6; // ref $strData
  const T_C = 7; // i32

  const textBody: Instr[] = [
    { op: "local.get", index: T_S },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "local.set", index: T_FLAT },
    // p = struct.new $JsonP(flat.data, flat.off, flat.off+flat.len)
    { op: "local.get", index: T_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
    { op: "local.get", index: T_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
    { op: "local.get", index: T_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
    { op: "local.get", index: T_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
    { op: "i32.add" },
    { op: "struct.new", typeIdx: jsonPTypeIdx },
    { op: "local.set", index: T_P },
    // result = __json_parse_value(p)  — pass as anyref
    { op: "local.get", index: T_P },
    { op: "call", funcIdx: valueFuncIdx },
    { op: "local.set", index: T_RESULT },
    // trailing ws + EOF
    { op: "local.get", index: T_P },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: T_DATA },
    { op: "local.get", index: T_P },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: T_POS },
    { op: "local.get", index: T_P },
    { op: "struct.get", typeIdx: jsonPTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: T_END },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: T_POS },
            { op: "local.get", index: T_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: T_DATA },
            { op: "local.get", index: T_POS },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: T_C },
            { op: "local.get", index: T_C },
            { op: "i32.const", value: 32 },
            { op: "i32.eq" },
            { op: "local.get", index: T_C },
            { op: "i32.const", value: 9 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "local.get", index: T_C },
            { op: "i32.const", value: 10 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "local.get", index: T_C },
            { op: "i32.const", value: 13 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: T_POS },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: T_POS },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: T_POS },
    { op: "local.get", index: T_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: throwSyntaxError("Unexpected non-whitespace character after JSON"),
    },
    { op: "local.get", index: T_RESULT },
  ];

  // ── push the three functions in the pre-registered order ──────────────────
  // Deep-clone each body so no `Instr` object is shared between (or within) the
  // bodies. The helper consts above (`loadPos`, `storePos`, `cEqV(...)`, …) are
  // shared `Instr[]` arrays spread into many positions, so the SAME object
  // appears at multiple slots in one body. The finalize remap
  // (`remapTypeIdxInBody` in dead-elimination.ts) mutates `typeIdx` IN PLACE and
  // re-visits a shared object once per occurrence, re-mapping an already-mapped
  // index a second (third, …) time — the documented #1302 shared-array
  // double-shift hazard. It desynced the `$JsonP` `$pos` `struct.get`/`struct.set`
  // operands (spread the most) from the cursor local's declared type
  // (`expected (ref 54 $ProxyTraps), found (ref 72 $JsonP)`).
  //
  // NOTE: `structuredClone` is NOT sufficient — it *preserves* internal
  // aliasing, so a shared object stays shared (just freshly) and is still
  // re-visited N times. `deepCloneInstrs` expands every shared reference into
  // an independent copy, so each `typeIdx` operand is remapped exactly once.
  // It preserves BigInt i64 operands and non-finite f64 constants.
  const cloneBody = (b: Instr[]): Instr[] => deepCloneInstrs(b);

  pushDefinedFunc(ctx, valueFuncIdx, {
    name: "__json_parse_value",
    typeIdx: valueTypeIdx,
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: jsonPTypeIdx } }, // V_PS
      { count: 1, type: strDataRef }, // V_DATA
      { count: 1, type: i32 }, // V_POS
      { count: 1, type: i32 }, // V_END
      { count: 1, type: i32 }, // V_C
      { count: 1, type: externref }, // V_OBJ
      { count: 1, type: strRefNative }, // V_KEY
      { count: 1, type: anyref }, // V_VAL
      { count: 1, type: f64 }, // V_NUM
      { count: 1, type: f64 }, // V_MANT
      { count: 1, type: f64 }, // V_SIGN
      { count: 1, type: i32 }, // V_EXP
      { count: 1, type: i32 }, // V_EXPSIGN
      { count: 1, type: i32 }, // V_EXPMAG
    ],
    body: cloneBody(valueBody),
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  pushDefinedFunc(ctx, strParseFuncIdx, {
    name: "__json_parse_str",
    typeIdx: strParseTypeIdx,
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: jsonPTypeIdx } }, // S_PS
      { count: 1, type: strDataRef }, // S_DATA
      { count: 1, type: i32 }, // S_POS
      { count: 1, type: i32 }, // S_END
      { count: 1, type: i32 }, // S_START
      { count: 1, type: i32 }, // S_RAWEND
      { count: 1, type: strDataRef }, // S_OUT
      { count: 1, type: i32 }, // S_N
      { count: 1, type: i32 }, // S_C
      { count: 1, type: i32 }, // S_HEX
      { count: 1, type: i32 }, // S_K
      { count: 1, type: i32 }, // S_SCAN
    ],
    body: cloneBody(strParseBody),
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  pushDefinedFunc(ctx, textFuncIdx, {
    name: "__json_parse_text",
    typeIdx: textTypeIdx,
    locals: [
      { count: 1, type: strRefNative }, // T_FLAT
      { count: 1, type: { kind: "ref", typeIdx: jsonPTypeIdx } }, // T_P
      { count: 1, type: anyref }, // T_RESULT
      { count: 1, type: i32 }, // T_POS
      { count: 1, type: i32 }, // T_END
      { count: 1, type: strDataRef }, // T_DATA
      { count: 1, type: i32 }, // T_C
    ],
    body: cloneBody(textBody),
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return textFuncIdx;
}

// ───────────────────────────────────────────────────────────────────────────
// (#3176) ES2025 `JSON.rawJSON` / `JSON.isRawJSON` — standalone / WASI.
// ───────────────────────────────────────────────────────────────────────────

interface RawJsonValidationPlan {
  rawStringLocal: number;
  flatLocal: number;
  lengthLocal: number;
  dataLocal: number;
  offsetLocal: number;
  resultLocal: number;
  objectLocal: number;
  objectRefLocal: number;
  strTypeIdx: number;
  strDataTypeIdx: number;
  anyStrTypeIdx: number;
  objectTypeIdx: number;
  objVecTypeIdx: number;
  flattenIdx: number;
  parseTextIdx: number;
  newObjectIdx: number;
  externSetIdx: number;
}

function buildRawJsonValidationAndCarrier(ctx: CodegenContext, plan: RawJsonValidationPlan): Instr[] {
  const {
    rawStringLocal,
    flatLocal,
    lengthLocal,
    dataLocal,
    offsetLocal,
    resultLocal,
    objectLocal,
    objectRefLocal,
    strTypeIdx,
    strDataTypeIdx,
    anyStrTypeIdx,
    objectTypeIdx,
    objVecTypeIdx,
    flattenIdx,
    parseTextIdx,
    newObjectIdx,
    externSetIdx,
  } = plan;
  const tagIdx = ensureExnTag(ctx);
  const ctorIdx = ctx.funcMap.get("__new_SyntaxError")!;
  const throwSyntaxError = (message: string): Instr[] => {
    addStringConstantGlobal(ctx, message);
    return [
      ...stringConstantExternrefInstrs(ctx, message),
      { op: "call", funcIdx: ctorIdx },
      { op: "throw", tagIdx },
      { op: "unreachable" },
    ];
  };
  const isWhitespace = (loadCodeUnit: Instr[]): Instr[] => [
    ...loadCodeUnit,
    { op: "i32.const", value: 0x20 },
    { op: "i32.eq" },
    ...loadCodeUnit,
    { op: "i32.const", value: 0x09 },
    { op: "i32.eq" },
    { op: "i32.or" },
    ...loadCodeUnit,
    { op: "i32.const", value: 0x0a },
    { op: "i32.eq" },
    { op: "i32.or" },
    ...loadCodeUnit,
    { op: "i32.const", value: 0x0d },
    { op: "i32.eq" },
    { op: "i32.or" },
  ];
  const loadFirst: Instr[] = [
    { op: "local.get", index: dataLocal },
    { op: "local.get", index: offsetLocal },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
  ];
  const loadLast: Instr[] = [
    { op: "local.get", index: dataLocal },
    { op: "local.get", index: offsetLocal },
    { op: "local.get", index: lengthLocal },
    { op: "i32.add" },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
  ];
  addStringConstantGlobal(ctx, "rawJSON");

  return [
    { op: "local.get", index: rawStringLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "local.set", index: flatLocal },
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: lengthLocal },
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: dataLocal },
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: offsetLocal },
    { op: "local.get", index: lengthLocal },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected end of JSON input in rawJSON") },
    ...isWhitespace(loadFirst),
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected whitespace in rawJSON") },
    ...isWhitespace(loadLast),
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("Unexpected whitespace in rawJSON") },
    { op: "local.get", index: rawStringLocal },
    { op: "call", funcIdx: parseTextIdx },
    { op: "local.set", index: resultLocal },
    { op: "local.get", index: resultLocal },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("rawJSON does not accept an object") },
    { op: "local.get", index: resultLocal },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: throwSyntaxError("rawJSON does not accept an array") },
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objectLocal },
    { op: "local.get", index: objectLocal },
    ...stringConstantExternrefInstrs(ctx, "rawJSON"),
    { op: "local.get", index: rawStringLocal },
    { op: "call", funcIdx: externSetIdx },
    { op: "local.get", index: objectLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: objectRefLocal },
    { op: "local.get", index: objectRefLocal },
    { op: "local.get", index: objectRefLocal },
    { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: OBJ_FLAG_RAWJSON },
    { op: "i32.or" },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 4 },
    { op: "local.get", index: objectLocal },
  ];
}

interface RawJsonFunctionPlan {
  body: Instr[];
  strRefNative: ValType;
  i32: ValType;
  strDataRef: ValType;
  anyref: ValType;
  externref: ValType;
  objectRef: ValType;
}

function registerRawJsonFunction(ctx: CodegenContext, plan: RawJsonFunctionPlan): number {
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__json_rawjson", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__json_rawjson",
    typeIdx: addFuncType(ctx, [plan.externref], [plan.externref]),
    locals: [
      { count: 1, type: plan.strRefNative },
      { count: 1, type: plan.i32 },
      { count: 1, type: plan.strDataRef },
      { count: 1, type: plan.i32 },
      { count: 1, type: plan.i32 },
      { count: 1, type: plan.anyref },
      { count: 1, type: plan.externref },
      { count: 1, type: plan.objectRef },
      { count: 1, type: plan.externref },
      { count: 1, type: plan.anyref },
      { count: 1, type: plan.i32 },
      { count: 1, type: plan.externref },
    ],
    body: plan.body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);
  return funcIdx;
}

/**
 * Emit `__json_rawjson(s: externref) -> externref` (§25.5.3 JSON.rawJSON).
 * `s` is the ALREADY-ToString'd JSON text (the call site coerces via
 * `__any_to_string`). Builds a branded raw-JSON carrier object:
 *
 *   1. flatten `s`; SyntaxError if empty or if the first/last code unit is
 *      JSON whitespace (space/tab/LF/CR) — §25.5.3 step 4/5.
 *   2. parse via the EXISTING `__json_parse_text` (throws on invalid grammar
 *      or trailing garbage — no second parser).
 *   3. SyntaxError if the parsed value is an Object or Array — rawJSON wraps
 *      only primitive JSON values (§25.5.3 step 6).
 *   4. build a `$Object` with an own enumerable `"rawJSON"` = `s` property AND
 *      the `[[IsRawJSON]]` internal-slot bit set on `$Object.flags`
 *      (OBJ_FLAG_RAWJSON) — the bit is what `isRawJSON` recognises, so a plain
 *      user `{ rawJSON: '…' }` is NOT a raw-JSON object.
 *
 * Reuses the parser + object runtime; no new parser, no new host import.
 * Returns the funcIdx. Idempotent. Standalone / WASI only.
 */
export function emitJsonRawJson(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_rawjson");
  if (existing !== undefined) return existing;

  ensureNativeStringHelpers(ctx);
  const rt = ensureObjectRuntime(ctx);
  emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  prepareRawJsonSymbolToString(ctx);
  const parseTextIdx = emitJsonParseText(ctx);

  const i32: ValType = { kind: "i32" };
  const anyref: ValType = { kind: "anyref" };
  const externref: ValType = { kind: "externref" };
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolTypeIdx = ctx.nativeBoxBooleanTypeIdx;
  const anyValueTypeIdx = ctx.anyValueTypeIdx;
  const f64: ValType = { kind: "f64" };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const strRefNative: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const objRef: ValType = { kind: "ref", typeIdx: rt.objectTypeIdx };

  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const newObjIdx = ctx.funcMap.get("__new_plain_object")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const numToStrIdx = ctx.funcMap.get("number_toString")!;
  const strConst = (s: string): Instr[] => {
    addStringConstantGlobal(ctx, s);
    return stringConstantExternrefInstrs(ctx, s);
  };

  const R_V = 0;
  const R_FLAT = 1; // ref $NativeString
  const R_LEN = 2; // i32
  const R_DATA = 3; // ref $strData
  const R_OFF = 4; // i32
  const R_C = 5; // i32
  const R_RES = 6; // anyref (parsed value)
  const R_OBJ = 7; // externref (carrier)
  const R_O = 8; // ref $Object (carrier cast once for the brand-bit write)
  const R_STR = 9; // externref — ToString(v), the JSON source text
  const R_ANY = 10; // anyref — v widened for the ToString tag-dispatch
  const R_TAG = 11; // i32 — $AnyValue tag
  const R_PAYLOAD = 12; // externref — overloaded tag-5 payload

  const body: Instr[] = [
    // does NOT depend on `__any_to_string` (whose boxed-number/boolean arms go
    // dead when the helper is baked before the union-import box structs are
    // registered — the exact ordering that a harness `assert_compareArray`
    // triggers, #3176). Dispatch on the boxed value:
    //   null                → "null"      (a valid rawJSON primitive)
    //   $AnyString           → the string itself
    //   $__box_number_struct → number_toString(value)
    //   $__box_boolean_struct→ "true" / "false"
    //   $AnyValue             → tag-dispatch its primitive payload
    //   $Symbol → TypeError; other unsupported refs → "[object Object]", which
    //   the parser below rejects → SyntaxError (matching §25.5.3).
    { op: "local.get", index: R_V },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: strConst("null"),
      else: [
        { op: "local.get", index: R_V },
        { op: "any.convert_extern" },
        ...buildRawJsonSymbolToStringGuard(ctx, R_ANY),
        { op: "ref.test", typeIdx: anyStrTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: externref },
          then: [{ op: "local.get", index: R_V }],
          else: [
            { op: "local.get", index: R_ANY },
            { op: "ref.test", typeIdx: boxNumTypeIdx },
            // (#3673) …or an i31-boxed small int.
            { op: "local.get", index: R_ANY },
            { op: "ref.test", typeIdx: -20 },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "val", type: externref },
              then: [
                { op: "local.get", index: R_ANY },
                { op: "ref.test", typeIdx: -20 },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } },
                  then: [
                    { op: "local.get", index: R_ANY },
                    { op: "ref.cast", typeIdx: -20 },
                    { op: "i31.get_s" },
                    { op: "f64.convert_i32_s" },
                  ],
                  else: [
                    { op: "local.get", index: R_ANY },
                    { op: "ref.cast", typeIdx: boxNumTypeIdx },
                    { op: "struct.get", typeIdx: boxNumTypeIdx, fieldIdx: 0 },
                  ],
                },
                { op: "call", funcIdx: numToStrIdx }, // -> externref string
              ],
              else: [
                { op: "local.get", index: R_ANY },
                { op: "ref.test", typeIdx: boxBoolTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: externref },
                  then: [
                    { op: "local.get", index: R_ANY },
                    { op: "ref.cast", typeIdx: boxBoolTypeIdx },
                    { op: "struct.get", typeIdx: boxBoolTypeIdx, fieldIdx: 0 }, // i32 value
                    {
                      op: "if",
                      blockType: { kind: "val", type: externref },
                      then: strConst("true"),
                      else: strConst("false"),
                    },
                  ],
                  else: [
                    // Generic array/union lanes carry their values in
                    // `$AnyValue`, not in the native box structs above. Apply
                    // the same primitive ToString conversion to that carrier
                    // so JSON.rawJSON(value) remains representation-neutral.
                    { op: "local.get", index: R_ANY },
                    { op: "ref.test", typeIdx: anyValueTypeIdx },
                    {
                      op: "if",
                      blockType: { kind: "val", type: externref },
                      then: [
                        { op: "local.get", index: R_ANY },
                        { op: "ref.cast", typeIdx: anyValueTypeIdx },
                        { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
                        { op: "local.set", index: R_TAG },
                        // tag 2/3 = integer/f64 number
                        { op: "local.get", index: R_TAG },
                        { op: "i32.const", value: 2 },
                        { op: "i32.eq" },
                        { op: "local.get", index: R_TAG },
                        { op: "i32.const", value: 3 },
                        { op: "i32.eq" },
                        { op: "i32.or" },
                        {
                          op: "if",
                          blockType: { kind: "val", type: externref },
                          then: [
                            { op: "local.get", index: R_TAG },
                            { op: "i32.const", value: 2 },
                            { op: "i32.eq" },
                            {
                              op: "if",
                              blockType: { kind: "val", type: f64 },
                              then: [
                                { op: "local.get", index: R_ANY },
                                { op: "ref.cast", typeIdx: anyValueTypeIdx },
                                { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
                                { op: "f64.convert_i32_s" },
                              ],
                              else: [
                                { op: "local.get", index: R_ANY },
                                { op: "ref.cast", typeIdx: anyValueTypeIdx },
                                { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 2 },
                              ],
                            },
                            { op: "call", funcIdx: numToStrIdx },
                          ],
                          else: [
                            // tag 4 = boolean
                            { op: "local.get", index: R_TAG },
                            { op: "i32.const", value: 4 },
                            { op: "i32.eq" },
                            {
                              op: "if",
                              blockType: { kind: "val", type: externref },
                              then: [
                                { op: "local.get", index: R_ANY },
                                { op: "ref.cast", typeIdx: anyValueTypeIdx },
                                { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
                                {
                                  op: "if",
                                  blockType: { kind: "val", type: externref },
                                  then: strConst("true"),
                                  else: strConst("false"),
                                },
                              ],
                              else: [
                                // tag 5 = string; tag 0 = null; tag 1 =
                                // undefined (invalid JSON, rejected below).
                                { op: "local.get", index: R_TAG },
                                { op: "i32.const", value: 5 },
                                { op: "i32.eq" },
                                {
                                  op: "if",
                                  blockType: { kind: "val", type: externref },
                                  then: [
                                    // Generic externref boxing also uses tag 5
                                    // for native number/boolean boxes. Peel
                                    // those before treating the payload as a
                                    // string; this mirrors the established
                                    // AnyValue ToString ABI without depending
                                    // on helper-emission order.
                                    { op: "local.get", index: R_ANY },
                                    { op: "ref.cast", typeIdx: anyValueTypeIdx },
                                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 4 },
                                    { op: "local.tee", index: R_PAYLOAD },
                                    { op: "any.convert_extern" },
                                    { op: "local.tee", index: R_ANY },
                                    { op: "ref.test", typeIdx: anyStrTypeIdx },
                                    {
                                      op: "if",
                                      blockType: { kind: "val", type: externref },
                                      then: [{ op: "local.get", index: R_PAYLOAD }],
                                      else: [
                                        { op: "local.get", index: R_ANY },
                                        { op: "ref.test", typeIdx: boxNumTypeIdx },
                                        // (#3673) …or an i31-boxed small int.
                                        { op: "local.get", index: R_ANY },
                                        { op: "ref.test", typeIdx: -20 },
                                        { op: "i32.or" },
                                        {
                                          op: "if",
                                          blockType: { kind: "val", type: externref },
                                          then: [
                                            { op: "local.get", index: R_ANY },
                                            { op: "ref.test", typeIdx: -20 },
                                            {
                                              op: "if",
                                              blockType: { kind: "val", type: { kind: "f64" } },
                                              then: [
                                                { op: "local.get", index: R_ANY },
                                                { op: "ref.cast", typeIdx: -20 },
                                                { op: "i31.get_s" },
                                                { op: "f64.convert_i32_s" },
                                              ],
                                              else: [
                                                { op: "local.get", index: R_ANY },
                                                { op: "ref.cast", typeIdx: boxNumTypeIdx },
                                                { op: "struct.get", typeIdx: boxNumTypeIdx, fieldIdx: 0 },
                                              ],
                                            },
                                            { op: "call", funcIdx: numToStrIdx },
                                          ],
                                          else: [
                                            { op: "local.get", index: R_ANY },
                                            { op: "ref.test", typeIdx: boxBoolTypeIdx },
                                            {
                                              op: "if",
                                              blockType: { kind: "val", type: externref },
                                              then: [
                                                { op: "local.get", index: R_ANY },
                                                { op: "ref.cast", typeIdx: boxBoolTypeIdx },
                                                { op: "struct.get", typeIdx: boxBoolTypeIdx, fieldIdx: 0 },
                                                {
                                                  op: "if",
                                                  blockType: { kind: "val", type: externref },
                                                  then: strConst("true"),
                                                  else: strConst("false"),
                                                },
                                              ],
                                              else: strConst("[object Object]"),
                                            },
                                          ],
                                        },
                                      ],
                                    },
                                  ],
                                  else: [
                                    { op: "local.get", index: R_TAG },
                                    { op: "i32.eqz" },
                                    {
                                      op: "if",
                                      blockType: { kind: "val", type: externref },
                                      then: strConst("null"),
                                      else: [
                                        { op: "local.get", index: R_TAG },
                                        { op: "i32.const", value: 1 },
                                        { op: "i32.eq" },
                                        {
                                          op: "if",
                                          blockType: { kind: "val", type: externref },
                                          then: strConst("undefined"),
                                          else: strConst("[object Object]"),
                                        },
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                      else: strConst("[object Object]"),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    { op: "local.set", index: R_STR },
    ...buildRawJsonValidationAndCarrier(ctx, {
      rawStringLocal: R_STR,
      flatLocal: R_FLAT,
      lengthLocal: R_LEN,
      dataLocal: R_DATA,
      offsetLocal: R_OFF,
      resultLocal: R_RES,
      objectLocal: R_OBJ,
      objectRefLocal: R_O,
      strTypeIdx,
      strDataTypeIdx,
      anyStrTypeIdx,
      objectTypeIdx: rt.objectTypeIdx,
      objVecTypeIdx: rt.objVecTypeIdx,
      flattenIdx,
      parseTextIdx,
      newObjectIdx: newObjIdx,
      externSetIdx,
    }),
  ];

  return registerRawJsonFunction(ctx, {
    body,
    strRefNative,
    i32,
    strDataRef,
    anyref,
    externref,
    objectRef: objRef,
  });
}

/**
 * Emit `__json_is_rawjson(v: externref) -> i32` (§25.5.4 JSON.isRawJSON).
 * Returns 1 iff `v` is a `$Object` carrying the `[[IsRawJSON]]` internal-slot
 * bit (OBJ_FLAG_RAWJSON) minted by `__json_rawjson`; 0 for every other value
 * (primitives, arrays, plain objects — including a user `{ rawJSON: '…' }`).
 * Idempotent. Standalone / WASI only.
 */
export function emitJsonIsRawJson(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_is_rawjson");
  if (existing !== undefined) return existing;

  const rt = ensureObjectRuntime(ctx);
  const i32: ValType = { kind: "i32" };
  const anyref: ValType = { kind: "anyref" };
  const externref: ValType = { kind: "externref" };

  const IR_V = 0;
  const IR_ANY = 1; // anyref

  const body: Instr[] = [
    { op: "local.get", index: IR_V },
    { op: "any.convert_extern" },
    { op: "local.tee", index: IR_ANY },
    { op: "ref.test", typeIdx: rt.objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        { op: "local.get", index: IR_ANY },
        { op: "ref.cast", typeIdx: rt.objectTypeIdx },
        { op: "struct.get", typeIdx: rt.objectTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: OBJ_FLAG_RAWJSON },
        { op: "i32.and" },
        { op: "i32.const", value: 0 },
        { op: "i32.ne" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];

  const typeIdx = addFuncType(ctx, [externref], [i32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__json_is_rawjson", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__json_is_rawjson",
    typeIdx,
    locals: [{ count: 1, type: anyref }], // IR_ANY
    body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);
  void anyref;
  return funcIdx;
}

/**
 * (#2166 PR-D1) Emit the standalone `JSON.parse(text, reviver)` codec —
 * `__json_parse_text_reviver(text: externref, reviver: externref) -> anyref` —
 * and the recursive §25.5.1 InternalizeJSONProperty walk
 * `__internalize_json_property(holder: externref, key: externref,
 * reviver: externref) -> externref`. Idempotent. Standalone / WASI only.
 *
 * The reviver itself is a USER closure (externref). It is invoked via the
 * reserve/fill `__call_reviver` driver (accessor-driver.ts) which wraps
 * `__call_fn_method_2(holder, reviver, key, value)` — binding `holder` as `this`
 * and passing `key`/`value` as the two reviver args (§25.5.1 step 2.c). The fill
 * runs in finalize after `__call_fn_method_2` is registered; when no arity-2
 * closure exists the driver degrades to an identity (returns the value), so a
 * module with no reviver closure still verifies.
 *
 * Walk (§25.5.1 InternalizeJSONProperty(holder, key, reviver)):
 *   val = holder[key]
 *   if val is an Object: for each own key k (snapshot taken BEFORE recursion,
 *     §25.5.1 step 2.a.i — a reviver that adds keys doesn't see them):
 *       elem = InternalizeJSONProperty(val, k, reviver)
 *       if elem is undefined → delete val[k]   else → val[k] = elem
 *   if val is an Array ($ObjVec): same over numeric indices with string keys.
 *   return reviver.call(holder, key, val)
 *
 * Returns the funcIdx of `__json_parse_text_reviver`.
 */
export function emitJsonParseTextReviver(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_parse_text_reviver");
  if (existing !== undefined) return existing;

  // Dependencies (all idempotent). The base parser + object runtime + the
  // number formatter (for array index → string keys) + the reviver driver.
  const parseTextIdx = emitJsonParseText(ctx);
  ensureNativeStringHelpers(ctx);
  const objTypes = ensureObjectRuntime(ctx);
  emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  const reviverDriverIdx = reserveReviverDriver(ctx);

  const newObjIdx = ctx.funcMap.get("__new_plain_object")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const externGetIdx = ctx.funcMap.get("__extern_get")!;
  const deleteIdx = ctx.funcMap.get("__delete_property")!;
  const orderedIdx = ctx.funcMap.get("__obj_ordered")!;
  const numToStrIdx = ctx.funcMap.get("number_toString")!;

  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const anyref: ValType = { kind: "anyref" };
  const externref: ValType = { kind: "externref" };

  const objectTypeIdx = objTypes.objectTypeIdx;
  const propMapTypeIdx = objTypes.propMapTypeIdx;
  const propEntryTypeIdx = objTypes.propEntryTypeIdx;
  const objVecTypeIdx = objTypes.objVecTypeIdx;
  const objVecArrTypeIdx = objTypes.objVecArrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  // Pre-register the recursive internalize funcIdx so the body can call itself.
  // (#2166 PR-D1) Signature takes the VALUE directly (already fetched by the
  // caller) plus the holder+key for the reviver's `this`/key args. This is
  // load-bearing: an `$ObjVec` array element CANNOT be re-read via
  // `__extern_get(holder, "i")` (the vec has no string-keyed property), so each
  // arm fetches its child with the right primitive (`__extern_get` for object
  // props, `array.get` for array elements) and passes the value in.
  //
  // __internalize_json_value(val, holder, key, reviver) -> externref
  const internTypeIdx = addFuncType(ctx, [externref, externref, externref, externref], [externref]);
  const internFuncIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("__internalize_json_value", internFuncIdx);

  // params: 0=val 1=holder 2=key 3=reviver
  const P_VAL = 0;
  const P_HOLDER = 1;
  const P_KEY = 2;
  const P_REVIVER = 3;
  const L_ANY = 4; // anyref — val widened for ref.test
  const L_ARR = 5; // ref null $PropMap — ordered key snapshot
  const L_CAP = 6; // i32 — loop bound
  const L_I = 7; // i32 — loop index
  const L_E = 8; // ref null $PropEntry
  const L_K = 9; // externref — current child key
  const L_CHILD = 10; // externref — child value (pre-reviver)
  const L_ELEM = 11; // externref — internalized child value
  const L_VEC = 12; // ref null $ObjVec
  const L_DATA = 13; // ref $ObjVecArr
  const L_OBJREF = 14; // externref — the $Object/$ObjVec value re-as-externref

  const internBody: Instr[] = [
    // any = any.convert_extern(val)
    { op: "local.get", index: P_VAL },
    { op: "any.convert_extern" },
    { op: "local.set", index: L_ANY },
    // ── $Object arm ───────────────────────────────────────────────────────
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // objref = val (the object, as externref holder for its children)
        { op: "local.get", index: P_VAL },
        { op: "local.set", index: L_OBJREF },
        // arr = __obj_ordered(cast<$Object>(any))  — snapshot BEFORE recursion
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "call", funcIdx: orderedIdx },
        { op: "local.set", index: L_ARR },
        { op: "local.get", index: L_ARR },
        { op: "array.len" },
        { op: "local.set", index: L_CAP },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_I },
                { op: "local.get", index: L_CAP },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // e = arr[i]; ordered array is compacted — stop at first null
                { op: "local.get", index: L_ARR },
                { op: "local.get", index: L_I },
                { op: "array.get", typeIdx: propMapTypeIdx },
                { op: "local.tee", index: L_E },
                { op: "ref.is_null" },
                { op: "br_if", depth: 1 },
                // k = extern.convert_any(e.key)
                { op: "local.get", index: L_E },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 }, // key: ref $AnyString
                { op: "extern.convert_any" },
                { op: "local.set", index: L_K },
                // child = __extern_get(objref, k)
                { op: "local.get", index: L_OBJREF },
                { op: "local.get", index: L_K },
                { op: "call", funcIdx: externGetIdx },
                { op: "local.set", index: L_CHILD },
                // elem = __internalize_json_value(child, objref, k, reviver)
                { op: "local.get", index: L_CHILD },
                { op: "local.get", index: L_OBJREF },
                { op: "local.get", index: L_K },
                { op: "local.get", index: P_REVIVER },
                { op: "call", funcIdx: internFuncIdx },
                { op: "local.set", index: L_ELEM },
                // if elem is undefined (null externref) → delete; else set
                { op: "local.get", index: L_ELEM },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: L_OBJREF },
                    { op: "local.get", index: L_K },
                    { op: "call", funcIdx: deleteIdx },
                    { op: "drop" },
                  ],
                  else: [
                    { op: "local.get", index: L_OBJREF },
                    { op: "local.get", index: L_K },
                    { op: "local.get", index: L_ELEM },
                    { op: "call", funcIdx: externSetIdx },
                  ],
                },
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // ── $ObjVec (array) arm ───────────────────────────────────────────────
    { op: "local.get", index: L_ANY },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_ANY },
        { op: "ref.cast", typeIdx: objVecTypeIdx },
        { op: "local.tee", index: L_VEC },
        { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 }, // data
        { op: "local.set", index: L_DATA },
        { op: "local.get", index: L_VEC },
        { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 }, // len
        { op: "local.set", index: L_CAP },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_I },
                { op: "local.get", index: L_CAP },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // k = number_toString(f64(i))  — array index → string key
                { op: "local.get", index: L_I },
                { op: "f64.convert_i32_s" },
                { op: "call", funcIdx: numToStrIdx },
                { op: "local.set", index: L_K },
                // child = data[i]  (read the element directly — NOT via __extern_get)
                { op: "local.get", index: L_DATA },
                { op: "local.get", index: L_I },
                { op: "array.get", typeIdx: objVecArrTypeIdx },
                { op: "local.set", index: L_CHILD },
                // elem = __internalize_json_value(child, val, k, reviver)
                { op: "local.get", index: L_CHILD },
                { op: "local.get", index: P_VAL },
                { op: "local.get", index: L_K },
                { op: "local.get", index: P_REVIVER },
                { op: "call", funcIdx: internFuncIdx },
                { op: "local.set", index: L_ELEM },
                // §25.5.1 step 2.b.ii: a non-undefined result replaces the
                // element in place; undefined → CreateDataProperty(undefined)
                // (store the null externref / a JSON `null` hole).
                { op: "local.get", index: L_DATA },
                { op: "local.get", index: L_I },
                { op: "local.get", index: L_ELEM },
                { op: "array.set", typeIdx: objVecArrTypeIdx },
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // ── return reviver.call(holder, key, val) via the driver ──────────────
    { op: "local.get", index: P_HOLDER }, // holder (this)
    { op: "local.get", index: P_REVIVER }, // reviver closure
    { op: "local.get", index: P_KEY }, // key
    { op: "local.get", index: P_VAL }, // value
    { op: "call", funcIdx: reviverDriverIdx },
  ];

  pushDefinedFunc(ctx, internFuncIdx, {
    name: "__internalize_json_value",
    typeIdx: internTypeIdx,
    locals: [
      { count: 1, type: anyref }, // L_ANY
      { count: 1, type: { kind: "ref_null", typeIdx: propMapTypeIdx } }, // L_ARR
      { count: 1, type: i32 }, // L_CAP
      { count: 1, type: i32 }, // L_I
      { count: 1, type: { kind: "ref_null", typeIdx: propEntryTypeIdx } }, // L_E
      { count: 1, type: externref }, // L_K
      { count: 1, type: externref }, // L_CHILD
      { count: 1, type: externref }, // L_ELEM
      { count: 1, type: { kind: "ref_null", typeIdx: objVecTypeIdx } }, // L_VEC
      { count: 1, type: { kind: "ref", typeIdx: objVecArrTypeIdx } }, // L_DATA
      { count: 1, type: externref }, // L_OBJREF
    ],
    body: internBody,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  // ── __json_parse_text_reviver(text, reviver) -> anyref ────────────────────
  // val = __json_parse_text(text); root = { "": val };
  // return any.convert_extern(
  //          __internalize_json_value(val, root, "", reviver)).
  const rootTypeIdx = addFuncType(ctx, [externref, externref], [anyref]);
  const rootFuncIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("__json_parse_text_reviver", rootFuncIdx);

  void anyStrTypeIdx;
  const emptyKey = (): Instr[] => nativeStringLiteralInstrs(ctx, "");
  const R_ROOT = 2; // externref
  const R_VAL = 3; // externref — the parsed root value

  const rootBody: Instr[] = [
    // val = any.convert_extern(__json_parse_text(text))
    { op: "local.get", index: 0 }, // text
    { op: "call", funcIdx: parseTextIdx }, // -> anyref value graph
    { op: "extern.convert_any" },
    { op: "local.set", index: R_VAL },
    // root = __new_plain_object(); root[""] = val
    { op: "call", funcIdx: newObjIdx },
    { op: "local.set", index: R_ROOT },
    { op: "local.get", index: R_ROOT },
    ...emptyKey(),
    { op: "extern.convert_any" },
    { op: "local.get", index: R_VAL },
    { op: "call", funcIdx: externSetIdx },
    // return any.convert_extern(__internalize_json_value(val, root, "", reviver))
    { op: "local.get", index: R_VAL },
    { op: "local.get", index: R_ROOT },
    ...emptyKey(),
    { op: "extern.convert_any" },
    { op: "local.get", index: 1 }, // reviver
    { op: "call", funcIdx: internFuncIdx },
    { op: "any.convert_extern" }, // back to anyref (the parse codec's result type)
  ];

  pushDefinedFunc(ctx, rootFuncIdx, {
    name: "__json_parse_text_reviver",
    typeIdx: rootTypeIdx,
    locals: [
      { count: 1, type: externref }, // R_ROOT (index 2)
      { count: 1, type: externref }, // R_VAL (index 3)
    ],
    body: rootBody,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return rootFuncIdx;
}
