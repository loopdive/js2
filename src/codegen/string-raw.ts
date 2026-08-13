// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3147) Wasm-native `String.raw(template, ...substitutions)` — the ORDINARY
 * FUNCTION-CALL form (ES2024 §22.1.2.4) for `--target standalone`.
 *
 * The tagged-template lowering `String.raw\`...\`` is a separate, already-native
 * path (#2008/#2510 in string-ops.ts) — a TaggedTemplateExpression never
 * reaches this helper. The test262 `built-ins/String/raw/*` suite calls
 * `String.raw` as a plain function with hand-built template objects
 * (`{ raw: {...} }`), which the standalone and native-first profiles previously
 * refused or delegated through the
 * `__get_builtin` dynamic-shape path (#1472 Phase B) — 22 hard CEs.
 *
 * §22.1.2.4 algorithm over the open-object runtime (#1472 Phase B):
 *   - step 3: cooked = ToObject(template)        — nullish template → TypeError.
 *   - step 5: raw = ToObject(Get(cooked, "raw")) — via `__extern_get` (getters
 *     run; abrupt completions propagate through the shared `$exc` tag);
 *     nullish raw → TypeError. A non-object template degrades to a `raw` miss
 *     (Get on a non-`$Object` answers undefined) — the same TypeError the spec
 *     reaches via the wrapper object's absent `raw`.
 *   - step 7: literalCount = ToLength(Get(raw, "length")) — exactly
 *     `__extern_length`'s array-like arm (#2036): `__extern_get` (a throwing
 *     `length` getter propagates) + NaN→0 / trunc / clamp.
 *   - steps 9-12 loop: R += ToString(Get(raw, ToString(nextIndex))) —
 *     `__extern_get_idx` (its non-vec arm is the canonical-decimal-key
 *     `__extern_get`, so index getters run) + `__extern_toString` (§7.1.17:
 *     `$Object` values reduce via `__to_primitive(v, "string")`, so a user
 *     `toString` runs and its abrupt completion propagates; null → "null", the
 *     tag-1 `$undefined` singleton → "undefined"). Between literal segments,
 *     R += ToString(substitutions[nextIndex]) while nextIndex <
 *     substitutionCount — substitutions past `literalCount - 1` are never
 *     touched (their `toString` must NOT run).
 *
 * Profile split: compatibility host-assisted mode is untouched (the
 * `__get_builtin` route stays). Standalone and native-first use pure Wasm with
 * no new host import. Registered lazily from the call site (append-only
 * — no funcidx shift of the in-flight function; same discipline as
 * `ensureObjectGroupBy`).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import {
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureSymbolCarrier } from "./symbol-native.js";

/**
 * Emit (once) and return the funcIdx of
 * `__string_raw(template: externref, subs: externref) -> ref $AnyString`.
 *
 * `subs` is an `$ObjVec` of the already-evaluated substitution values (built
 * by the call site with `__objvec_new`/`__objvec_push`).
 */
export function ensureStringRawHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__string_raw");
  if (existing !== undefined) return existing;

  // Callee helpers first — all appended DEFINED funcs, resolved via funcMap so
  // the late-import shifter keeps every baked `call` in sync (#329/#1899).
  ensureObjectRuntime(ctx); // __extern_get(_idx) / __extern_length / __extern_toString
  ensureNativeStringHelpers(ctx); // $AnyString + __str_concat

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const externGetIdx = ctx.funcMap.get("__extern_get")!;
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx")!;
  const externLengthIdx = ctx.funcMap.get("__extern_length")!;
  const externToStringIdx = ctx.funcMap.get("__extern_toString")!;
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
  // (#2106 S1) normalize the extern-wrapped `$undefined` singleton to a null
  // externref so one `ref.is_null` covers both nullish carriers. Flag-gated
  // registration — absent means misses already read back as null.
  const nullishIdx = ctx.funcMap.get("__nullish_to_null");

  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);
  const externStr = (value: string): Instr[] => {
    addStringConstantGlobal(ctx, value);
    return stringConstantExternrefInstrs(ctx, value);
  };

  // Catchable TypeError instance thrown through the shared `$exc` tag — the
  // same lowering `__to_primitive` uses (see object-runtime.ts).
  const typeErrorMessage = "Cannot convert undefined or null to object";
  const symbolMessage = "Cannot convert a Symbol value to a string";
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
  const exnTagIdx = ensureExnTag(ctx);
  // (§7.1.17) a Symbol segment/substitution value must throw TypeError, not
  // stringify. The `$Symbol` carrier type is idempotently registered — the
  // same accessor object-runtime uses.
  const symbolTypeIdx = ensureSymbolCarrier(ctx);
  const throwTypeError = (message: string): Instr[] => [
    ...externStr(message),
    { op: "call", funcIdx: typeErrorCtorIdx },
    { op: "throw", tagIdx: exnTagIdx },
  ];
  const nullishNorm = (): Instr[] => (nullishIdx !== undefined ? [{ op: "call", funcIdx: nullishIdx }] : []);

  // params: 0=template(externref) 1=subs(externref)
  const P_TEMPLATE = 0;
  const P_SUBS = 1;
  // locals
  const L_RAW = 2; // externref
  const L_LEN = 3; // f64 — literalCount (already ToLength'd)
  const L_SUBCOUNT = 4; // f64
  const L_I = 5; // f64 — nextIndex
  const L_R = 6; // ref null $AnyString — accumulated result
  const L_SEG = 7; // externref — __extern_toString scratch

  // ToString(<externref on stack>) -> ref $AnyString. A null externref is
  // pre-guarded to "null" HERE: under the #2106 S1 singleton regime a null
  // extern is genuine JS null (§7.1.17 → "null"; the $undefined singleton is a
  // tag-1 box `__extern_toString`/`__any_to_string` renders "undefined"), and
  // under the legacy flag-off regime (null ≡ undefined ≡ ref.null.extern)
  // `__extern_toString` passes null through to `__any_to_string`'s residual
  // "[object Object]" arm — "null" is strictly closer for both collapsed
  // carriers. A second guard covers a null RESULT so the cast can never trap.
  // FACTORY — fresh Instr objects per use (shared arrays double-remap in
  // finalize walks; see `reference_shared_instr_object_dce_double_remap`).
  const toStr = (): Instr[] => [
    { op: "local.set", index: L_SEG },
    { op: "local.get", index: L_SEG },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: litStr("null"),
      else: [
        // §7.1.17 — ToString(Symbol) throws TypeError (nextkey-is-symbol /
        // substitution-symbol test262 forms).
        { op: "local.get", index: L_SEG },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: symbolTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: throwTypeError(symbolMessage),
        },
        { op: "local.get", index: L_SEG },
        { op: "call", funcIdx: externToStringIdx },
        { op: "local.set", index: L_SEG },
        { op: "local.get", index: L_SEG },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: litStr("null"),
          else: [
            { op: "local.get", index: L_SEG },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: anyStrTypeIdx },
          ],
        },
      ],
    },
  ];

  // R = concat(R, <segment producer>). FACTORY (used for both literal and
  // substitution appends).
  const appendToR = (producer: () => Instr[]): Instr[] => [
    { op: "local.get", index: L_R },
    { op: "ref.as_non_null" },
    ...producer(),
    { op: "call", funcIdx: strConcatIdx },
    { op: "local.set", index: L_R },
  ];

  const body: Instr[] = [
    // step 3 — ToObject(template): nullish → TypeError.
    { op: "local.get", index: P_TEMPLATE },
    ...nullishNorm(),
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: throwTypeError(typeErrorMessage) },
    // step 5 — raw = Get(template, "raw"); nullish → TypeError.
    { op: "local.get", index: P_TEMPLATE },
    ...externStr("raw"),
    { op: "call", funcIdx: externGetIdx },
    ...nullishNorm(),
    { op: "local.set", index: L_RAW },
    { op: "local.get", index: L_RAW },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: throwTypeError(typeErrorMessage) },
    // step 7 — literalCount = ToLength(Get(raw, "length")).
    { op: "local.get", index: L_RAW },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: L_LEN },
    // step 8 — literalCount ≤ 0 → "" (covers NaN/undefined/negative: all → 0).
    { op: "local.get", index: L_LEN },
    { op: "f64.const", value: 1 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...litStr(""), { op: "return" }],
    },
    // step 2 — substitutionCount (the subs $ObjVec's length).
    { op: "local.get", index: P_SUBS },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: L_SUBCOUNT },
    // steps 9-10 — R = ""; nextIndex = 0.
    ...litStr(""),
    { op: "local.set", index: L_R },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // R += ToString(Get(raw, ToString(nextIndex)))
            ...appendToR(() => [
              { op: "local.get", index: L_RAW },
              { op: "local.get", index: L_I },
              { op: "call", funcIdx: externGetIdxIdx },
              ...toStr(),
            ]),
            // if nextIndex + 1 == literalCount → done (R is the result)
            { op: "local.get", index: L_I },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.get", index: L_LEN },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            // if nextIndex < substitutionCount → R += ToString(subs[nextIndex])
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_SUBCOUNT },
            { op: "f64.lt" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: appendToR(() => [
                { op: "local.get", index: P_SUBS },
                { op: "local.get", index: L_I },
                { op: "call", funcIdx: externGetIdxIdx },
                ...toStr(),
              ]),
            },
            // nextIndex += 1
            { op: "local.get", index: L_I },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: L_R },
    { op: "ref.as_non_null" },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__string_raw", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__string_raw",
    typeIdx,
    locals: [
      { name: "raw", type: { kind: "externref" } },
      { name: "len", type: { kind: "f64" } },
      { name: "subCount", type: { kind: "f64" } },
      { name: "i", type: { kind: "f64" } },
      { name: "R", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      { name: "seg", type: { kind: "externref" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
