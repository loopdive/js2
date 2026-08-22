// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helpers — $AnyString, $FlatString, $ConsString types
 * and ensureNativeStringHelpers which emits the full string runtime.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { ensureAnyValueType } from "./any-helpers.js";
import { ensureDateAnyToStringHelper } from "./date-any-to-string.js"; // (#4491 T4-B)
import { emitNativeHtmlWrapperHelpers } from "./html-wrapper-native.js";
import { emitStrSearchHelpers } from "./native-strings-search.js";
import { emitStrCaseHelpers } from "./native-strings-transform.js";
import { emitSelfHostedStringHelpers } from "./native-strings-selfhost.js";
import { emitStrReplaceHelpers, emitStrConstructHelpers, emitStrRegexEscapeHelper } from "./native-strings-rewrite.js";
// (#3901) `__str_split` lives in its own module — see native-strings-split.ts.
import { emitStrSplitHelper } from "./native-strings-split.js";
import { makeNativeStrShared } from "./native-strings-shared.js";
import { emitStrFlattenHelpers, emitStrToUtf8Helper } from "./native-strings-core.js";
import { emitStrConcatHelpers, emitStrCompareHelpers, emitStrSliceCharHelpers } from "./native-strings-basics.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { addImport, addUnionImports } from "./registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterErrorStructType,
  getOrRegisterVecType,
  withSuppressedVecUsage,
} from "./registry/types.js";

export {
  nativeStringLiteralHash,
  nativeStringLiteralInstrs,
  nativeStringLiteralMaterialization,
  type NativeStringLiteralMaterialization,
  type StringEncoding,
} from "./native-string-literals.js";

export function nativeStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Build inline instructions that push a string constant onto the stack as an
 * externref (the type expected by the throw tag and by host imports). In
 * nativeStrings mode, materializes the FlatString struct inline and converts
 * to externref. In legacy mode, emits a plain `global.get` of the
 * `string_constants` import. Both branches require the value to be present
 * in `ctx.stringGlobalMap` — call `addStringConstantGlobal(ctx, value)` first.
 */
export function stringConstantExternrefInstrs(ctx: CodegenContext, value: string): Instr[] {
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const instrs = nativeStringLiteralInstrs(ctx, value);
    // ref $NativeString -> externref
    instrs.push({ op: "extern.convert_any" });
    return instrs;
  }
  const strIdx = ctx.stringGlobalMap.get(value);
  if (strIdx === undefined || strIdx < 0) {
    // Defensive: caller forgot to register, or sentinel. Push undefined.
    return [{ op: "ref.null.extern" }];
  }
  return [{ op: "global.get", index: strIdx }];
}

/**
 * Get the nullable ValType for a string reference (ref null $AnyString).
 */
export function nativeStringTypeNullable(ctx: CodegenContext): ValType {
  return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Get the ValType for a flat string reference (ref $NativeString).
 */
export function flatStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.nativeStrTypeIdx };
}

/**
 * Emit native string helper functions into the module.
 * Called lazily when string operations are first encountered in fast mode.
 *
 * IMPORTANT: All imports must be registered BEFORE any module functions,
 * because wasm function indices are: imports first, then module functions.
 */
export function ensureNativeStringHelpers(ctx: CodegenContext): void {
  if (ctx.nativeStrHelpersEmitted) return;
  ctx.nativeStrHelpersEmitted = true;
  // #2039: settle any deferred ensureLateImport batch before baking funcIdx
  // values. Registering these helpers mid-batch would bake post-batch indices
  // that the deferred flush then over-shifts by its delta. Same guard as
  // ensureObjectRuntime / addUnionImports.
  flushLateImportShifts(ctx, null);
  // #1677: snapshot the import-function count at the instant the helpers are
  // emitted. Imports added later during the same finalize phase shift these
  // helpers' true indices but NOT their baked-in sibling-call targets;
  // `reconcileNativeStrFinalizeShift` applies that delta at finalize end.
  if (ctx.nativeStrHelperImportBase < 0) {
    ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
  }

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx; // NativeString (FlatString) struct type index
  const anyStrTypeIdx = ctx.anyStrTypeIdx; // AnyString base type index
  const consStrTypeIdx = ctx.consStrTypeIdx; // ConsString type index

  // ── Step 2: emit the native-string helper builders ──────────────────
  // The full String runtime is built by cohesive sibling-module builders
  // (#3182 Wave B, slices 1–2), invoked in the original registration order.
  // Each shares the per-call NativeStrShared bag and looks up earlier helpers
  // by name in ctx.nativeStrHelpers, so this fixed order preserves every
  // baked-in sibling funcIdx and mintDefinedFunc/addFuncType side-effect.
  const methodShared = makeNativeStrShared(ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx);
  // (#4034) This is a PRELUDE, not a usage site: `emitStrSplitHelper` registers a
  // vec type for split's result array, which flipped `usesVecValue` and made every
  // arith-only module look like an array user — cascading into ~21 kB of
  // unstrippable standalone exports (#2083's fix, one level down). Types are still
  // registered (only the flag is pinned), so no type index moves. Full chain +
  // measurements in plan/issues/4034-*.md; guarded by
  // tests/issue-4034-standalone-prelude-size.test.ts.
  withSuppressedVecUsage(ctx, () => {
    emitStrFlattenHelpers(methodShared);
    emitStrToUtf8Helper(methodShared);
    emitStrConcatHelpers(methodShared);
    emitStrCompareHelpers(methodShared);
    emitStrSliceCharHelpers(methodShared);
    emitStrSearchHelpers(methodShared);
    emitSelfHostedStringHelpers(methodShared); // #3256 — trim/affix/pad/repeat from TS source (stdlib/strings.ts)
    emitStrCaseHelpers(methodShared);
    emitStrReplaceHelpers(methodShared);
    emitStrSplitHelper(methodShared);
    emitStrConstructHelpers(methodShared);
    emitStrRegexEscapeHelper(methodShared);

    // (#3069) Annex B §B.2.2 HTML string-wrapper methods — the `__str_html_escape_quot`
    // helper (CreateHTML step-4.b `"`→`&quot;` escaping). Emitted here, AFTER
    // __str_flatten/__str_concat are registered. The tag/attribute concatenation
    // is built inline at each call site in string-ops.ts via __str_concat.
    emitNativeHtmlWrapperHelpers(ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx);
  });
}

/**
 * #1470 — Emit `$__any_to_string(v: anyref) -> ref $AnyString`, the standalone
 * (no-JS-host) replacement for the `__extern_toString` host import. Dispatches
 * on the concrete WasmGC type of `v`:
 *   - ref $AnyString    → returned as-is (already a native string)
 *   - ref $AnyValue     → switch on the boxed tag:
 *       0 null      → "null"
 *       1 undefined → "undefined"
 *       2 i32 num   → number_toString(f64.convert_i32_s(i32val))
 *       3 f64 num   → number_toString(f64val)
 *       4 bool      → "true" / "false"
 *       5 string    → externval → any.convert_extern → ref.cast $AnyString
 *       6 ref / else→ "[object Object]"
 *   - anything else     → "[object Object]"
 *
 * Spec-correct dispatch for ordinary objects (walking @@toPrimitive / toString
 * via the object's vtable) lands with #1472; the Phase-1 fallback here is the
 * canonical `"[object Object]"` so a standalone module never traps on a string
 * coercion of an arbitrary value.
 *
 * Idempotent — caches the function index under `nativeStrHelpers["__any_to_string"]`.
 */
/**
 * (#2962) §20.5.3.4 `Error.prototype.toString` for the native `$Error_struct` —
 * `__error_to_string(v: anyref) -> ref $AnyString`, where `v` MUST already be
 * a `$Error_struct` (callers guard with `ref.test`; the entry `ref.cast` is
 * defensive).
 *
 *   1. name = $name field when it is a native string, else the literal
 *      "Error" (our constructors always materialize a non-empty name, so the
 *      spec's empty-name arm is unreachable — see emitErrorStructConstructor).
 *   2. msg  = $message field; `null` (constructed argument-less), a NON-string
 *      (documented residual: §20.5.1.1 stores ToString(message) at
 *      construction, our ctor stores the raw arg), or the empty string all
 *      yield `name` alone per §20.5.3.4 steps 4–6.
 *   3. else `name + ": " + msg`.
 *
 * Standalone/WASI only: in JS-host mode the `__new_<Kind>` imports resolve to
 * the real JS constructors, so thrown errors are host objects and never
 * `$Error_struct`s — the helper would be dead weight. Registering the error
 * struct type here (idempotent) makes the arm order-independent: a module
 * whose first string coercion happens BEFORE its first error construction
 * still gets the arm.
 *
 * Index-shift safety (#1448 pattern): the only baked dependency is
 * `__str_concat` (already emitted by ensureNativeStringHelpers); the body is
 * built and pushed with no intervening helper emission. Registered in
 * `funcMap` so deferred late-import flushes keep the index authoritative.
 *
 * Idempotent — cached under `nativeStrHelpers["__error_to_string"]`.
 */
function ensureErrorToStringHelper(ctx: CodegenContext): number | undefined {
  const cached = ctx.nativeStrHelpers.get("__error_to_string");
  if (cached !== undefined) return cached;
  if (!(ctx.standalone || ctx.wasi)) return undefined; // noJsHost only (see doc above)
  ensureNativeStringHelpers(ctx);
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return undefined;

  const errStructIdx = getOrRegisterErrorStructType(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);

  // params: v(0) anyref · locals: e(1) ref null $Error_struct, tmp(2) anyref,
  // name(3) ref null $AnyString, msg(4) ref null $AnyString
  const L_V = 0;
  const L_E = 1;
  const L_TMP = 2;
  const L_NAME = 3;
  const L_MSG = 4;

  const returnName: Instr[] = [{ op: "local.get", index: L_NAME }, { op: "ref.as_non_null" }, { op: "return" }];
  const returnMsg: Instr[] = [{ op: "local.get", index: L_MSG }, { op: "ref.as_non_null" }, { op: "return" }];

  const body: Instr[] = [
    { op: "local.get", index: L_V },
    { op: "ref.cast", typeIdx: errStructIdx },
    { op: "local.set", index: L_E },
    // name = ($name is a native string) ? it : "Error"   (steps 3-4)
    { op: "local.get", index: L_E },
    { op: "struct.get", typeIdx: errStructIdx, fieldIdx: 2 }, // $name (externref)
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_TMP },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        { op: "local.get", index: L_TMP },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
      else: litStr("Error"),
    },
    { op: "local.set", index: L_NAME },
    // msg = ($message is a native string) ? it : ""      (steps 5-6)
    // (#4485) An absent / non-string message is the EMPTY STRING, not "return
    // name now". The old early-return conflated steps 5-6 with steps 7-9 and so
    // could never reach step 7 (`name is "" → return msg`): `new Error()` with
    // `e.name = ""` answered "Error" instead of "" (test262
    // .../toString/15.11.4.4-8-2.js). Materialising the empty string here keeps
    // the two decisions separate and makes the step order the spec's.
    // A non-string message remains the documented construction-time-ToString
    // residual — §20.5.1.1 stores ToString(message), our ctor stores the raw arg.
    { op: "local.get", index: L_E },
    { op: "struct.get", typeIdx: errStructIdx, fieldIdx: 1 }, // $message (externref)
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_TMP },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        { op: "local.get", index: L_TMP },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
      else: litStr(""),
    },
    { op: "local.set", index: L_MSG },
    // (#4485) step 7 — empty NAME → the message alone. `new Error("m")` with
    // `e.name = ""` is `"m"`, not `": m"` (.../toString/15.11.4.4-8-1.js).
    { op: "local.get", index: L_NAME },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 }, // len
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnMsg },
    // step 8 — empty message → name alone
    { op: "local.get", index: L_MSG },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 }, // len
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnName.map((i) => ({ ...i })) },
    // step 9 — name + ": " + msg
    { op: "local.get", index: L_NAME },
    { op: "ref.as_non_null" },
    ...litStr(": "),
    { op: "call", funcIdx: strConcatIdx },
    { op: "local.get", index: L_MSG },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: strConcatIdx },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "anyref" }], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__error_to_string", funcIdx);
  ctx.funcMap.set("__error_to_string", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__error_to_string",
    typeIdx,
    locals: [
      { name: "e", type: { kind: "ref_null", typeIdx: errStructIdx } },
      { name: "tmp", type: { kind: "anyref" } },
      { name: "name", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      { name: "msg", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#3548) `__str_truthy(ref null $AnyString) -> i32` — §7.1.2 ToBoolean for a
 * NULLABLE native string: `null` (an under-applied param's `undefined`, or a
 * genuinely-null binding) is falsy; otherwise empty-string falsy via the rope
 * `len` field (field 0 — maintained on concat, no flatten needed). The
 * non-null ToBoolean arm in coercion-engine.ts keeps its historical
 * flatten+len path byte-identical; only `ref_null` strings route here (they
 * previously called `__str_flatten(null)` → an unconditional trap — the
 * residual half of the #3548 zero-arg-call fix). Registration is append-only
 * (a defined func mints at the end of the index space — no shifts).
 */
export function ensureStrTruthyHelper(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("__str_truthy");
  if (existing !== undefined) return existing;
  if (ctx.anyStrTypeIdx < 0) return undefined;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: 0 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 }, // rope len
        { op: "i32.const", value: 0 },
        { op: "i32.gt_s" },
      ],
    },
  ];
  const typeIdx = addFuncType(ctx, [{ kind: "ref_null", typeIdx: anyStrTypeIdx }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__str_truthy", funcIdx);
  ctx.funcMap.set("__str_truthy", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__str_truthy",
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
  return funcIdx;
}

export function ensureAnyToStringHelper(ctx: CodegenContext): number {
  ensureNativeStringHelpers(ctx);
  const existing = ctx.nativeStrHelpers.get("__any_to_string");
  if (existing !== undefined) return existing;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const anyref: ValType = { kind: "anyref" };

  // The $AnyValue box must exist for the tag-dispatch arm. It is registered
  // lazily; ensure it here so the struct.get / ref.cast below resolve.
  ensureAnyValueType(ctx);
  const anyValueTypeIdx = ctx.anyValueTypeIdx;

  // (#3216) Register the native `number_toString` BEFORE any funcIdx below is
  // captured, so `__any_to_string`'s number arms (the tag-2/tag-3 dispatch arms
  // AND the residual boxed-`$__box_number_struct` arm) bake the REAL conversion
  // rather than the "[object Object]" fallback. Root cause: when
  // `ensureAnyToStringHelper` is the FIRST consumer of number stringification in
  // a module — e.g. a reflective `String.prototype.<m>.call(<number|boolean>)`
  // body's `ToString(this)` is the first `__any_to_string` caller — the lazily-
  // registered `number_toString` did not yet exist, so `numToStrIdx` below was
  // `undefined` and every `numberArm(...)` captured the literal "[object Object]".
  // The helper is cached, so the WHOLE module then stringified boxed primitives
  // wrong (`String.prototype.charAt.call(12345, 2)` read `"[object Object]"[2]`
  // instead of `"12345"[2]`). Other consumers (array `join`, `String(x)`,
  // template literals) pulled `number_toString` in first, which is why they
  // worked and masked this ordering hazard. Idempotent + append-only DEFINED
  // function (no import → the #1448 late-import shift risk it can trigger via
  // string constants happens HERE, before the `errToStrIdx`/`numToStrIdx`
  // captures below, so those stay consistent). Native-strings-gated so host/gc
  // lanes stay byte-identical (there `number_toString` is host-provided/absent
  // and the numberArm keeps its prior fallback).
  if (ctx.nativeStrings && !ctx.funcMap.has("number_toString")) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  }

  // (#2875) Ensure the boxed-primitive struct types (`$__box_number_struct` /
  // `$__box_boolean_struct`) are REGISTERED before `stringifyBoxedExtern`
  // (below) captures `ctx.nativeBoxNumberTypeIdx`/`nativeBoxBooleanTypeIdx`.
  // SAME ordering hazard #3216 fixed for `number_toString`: when
  // `ensureAnyToStringHelper` is the FIRST any-coercion consumer in a module —
  // e.g. a 0-arg reflective `String.prototype.trim.call(<boolean|number>)`
  // body's `ToString(this)`, which (unlike the char/search bodies) never calls
  // `unboxArgToI32` and so never pulls in the union native funcs — both idxs
  // were still `-1`, and `stringifyBoxedExtern` baked the "[object Object]"
  // fallback for EVERY boxed primitive. So `trim.call(false)` rendered
  // "[object Object]" instead of "false" (and the whole cached helper was
  // wrong module-wide). `addUnionImports` is idempotent (`hasUnionImports`
  // guard) and, under standalone/wasi, appends the box struct types + native
  // box/unbox funcs; a module that already registered them earlier is a no-op
  // (byte-identical). Native-strings-gated so host/gc lanes stay byte-identical
  // (there `__any_to_string`'s boxed arms keep their prior fallback and the box
  // types are host concepts).
  if (ctx.nativeStrings) {
    addUnionImports(ctx);
  }

  // (#2962) Emit the §20.5.3.4 `__error_to_string` helper BEFORE this
  // function's own index is baked (it appends a function — no import, so no
  // index shift for anything already emitted). `undefined` in JS-host mode
  // (errors are host objects there) — every arm below then degrades to the
  // prior "[object Object]" literal, keeping host lanes byte-identical.
  const errToStrIdx = ensureErrorToStringHelper(ctx);
  const errStructTypeIdx = errToStrIdx !== undefined ? ctx.errorStructTypeIdx : -1;

  // (#4491 T4-B) …and the §21.4.4.41 Date arm, on the same discipline and for
  // the same reason: a `__Date` is a nominal struct, so it reaches this
  // terminal's generic "[object Object]" while the statically-resolved
  // `d.toString()` renders correctly. `undefined` when the module never built a
  // Date (or has no native strings), which leaves the terminal byte-identical.
  const dateToStrIdx = ensureDateAnyToStringHelper(ctx);
  const dateStructTypeIdx = dateToStrIdx !== undefined ? (ctx.structMap.get("__Date") ?? -1) : -1;

  // number_toString returns an externref that is really a `ref $AnyString` in
  // native-strings mode; convert it back with any.convert_extern + ref.cast.
  const numToStrIdx = ctx.funcMap.get("number_toString");

  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);

  // `box` (the $AnyValue ref) lives in local 1; the original anyref param in 0.
  const L_V = 0;
  const L_BOX = 1;
  // #1910/#1472 S2 — scratch anyref for the tag-5 string-vs-wrapper recovery.
  const L_RECOVER = 2;
  // (ES5 standalone lane) scratch anyref for the OrdinaryToPrimitive terminal.
  const L_TOPRIM = 3;

  const numberArm = (loadNumeric: Instr[]): Instr[] =>
    numToStrIdx !== undefined
      ? [
          ...loadNumeric,
          { op: "call", funcIdx: numToStrIdx },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
        ]
      : litStr("[object Object]");

  // (ES5 standalone lane) §7.1.17 step 5 — ToString of an OBJECT is
  // `ToString(? ToPrimitive(argument, string))`, and it is `ToPrimitive` that
  // runs a user `toString`/`valueOf`. Every arm above this terminal handles a
  // value that is ALREADY primitive, so reaching here means "an object we could
  // not render" — precisely where the OrdinaryToPrimitive step belongs.
  //
  // Root cause this closes: a plain-function-constructor ("fnctor") instance —
  // `function F(){ this.toString = function(){…} }; new F()` — is a NOMINAL
  // WasmGC struct, so it is neither `$Object` nor `$Vec`. `__to_primitive`'s
  // `$Object` arm (the only ToPrimitive step `__any_to_string` had, in
  // `recoverNonStringExtern`) misses it, and the value fell straight through to
  // the "[object Object]" literal. Measured standalone before this change:
  // `"" + new F()`, `String(new F())`, and every borrowed
  // `String.prototype.<m>.call(new F(), …)` answered "[object Object]" for a
  // receiver whose own OR inherited `toString` returns "OWN".
  //
  // The driver is `__class_to_primitive(obj, stringHint)` (class-to-primitive.ts)
  // rather than `__to_primitive`, deliberately: it dispatches ONLY on the
  // per-struct `__call_valueOf`/`__call_toString` arms, so a `$Object`, a `$Vec`
  // or a bare closure struct gets `ref.null.extern` from the dispatchers and the
  // driver's string-hint tail answers the same "[object Object]" as before. The
  // blast radius is therefore exactly "nominal struct carrying a user
  // valueOf/toString", leaving the `$Object` and array renderings byte-identical.
  //
  // Only a PRIMITIVE result is accepted (`$AnyString`, boxed number / i31 small
  // int, boxed boolean); anything else falls back to "[object Object]". That is
  // what makes the terminal non-recursive: it never re-enters `__any_to_string`,
  // so a driver that answers with another object cannot loop.
  const classToPrimIdx = ctx.funcMap.get("__class_to_primitive");
  const boxNumTerminalIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolTerminalIdx = ctx.nativeBoxBooleanTypeIdx;
  const objectTag = (loadRef: () => Instr[]): Instr[] => {
    if (classToPrimIdx === undefined) return litStr("[object Object]");
    const boxArms: Instr[] =
      boxNumTerminalIdx >= 0 && boxBoolTerminalIdx >= 0
        ? [
            { op: "local.get", index: L_TOPRIM },
            { op: "ref.test", typeIdx: boxNumTerminalIdx },
            { op: "local.get", index: L_TOPRIM },
            { op: "ref.test", typeIdx: -20 }, // abstract i31 (#3673 small int)
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: numberArm([
                { op: "local.get", index: L_TOPRIM },
                { op: "ref.test", typeIdx: -20 },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } },
                  then: [
                    { op: "local.get", index: L_TOPRIM },
                    { op: "ref.cast", typeIdx: -20 },
                    { op: "i31.get_s" },
                    { op: "f64.convert_i32_s" },
                  ],
                  else: [
                    { op: "local.get", index: L_TOPRIM },
                    { op: "ref.cast", typeIdx: boxNumTerminalIdx },
                    { op: "struct.get", typeIdx: boxNumTerminalIdx, fieldIdx: 0 },
                  ],
                },
              ]),
              else: [
                { op: "local.get", index: L_TOPRIM },
                { op: "ref.test", typeIdx: boxBoolTerminalIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: strRef },
                  then: [
                    { op: "local.get", index: L_TOPRIM },
                    { op: "ref.cast", typeIdx: boxBoolTerminalIdx },
                    { op: "struct.get", typeIdx: boxBoolTerminalIdx, fieldIdx: 0 },
                    {
                      op: "if",
                      blockType: { kind: "val", type: strRef },
                      then: litStr("true"),
                      else: litStr("false"),
                    },
                  ],
                  else: litStr("[object Object]"),
                },
              ],
            },
          ]
        : litStr("[object Object]");
    return [
      ...loadRef(),
      { op: "extern.convert_any" },
      { op: "i32.const", value: 1 }, // string hint (§7.1.17 → ToPrimitive(_, string))
      { op: "call", funcIdx: classToPrimIdx },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_TOPRIM },
      { op: "ref.test", typeIdx: anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          { op: "local.get", index: L_TOPRIM },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
        ],
        else: boxArms,
      },
    ];
  };

  // (#2962) Shared terminal for an unrecognized object ref: `$Error_struct` →
  // `__error_to_string` (a real "TypeError: boom"), anything else → the
  // OrdinaryToPrimitive terminal above, which ends at the canonical
  // "[object Object]". `loadRef` is a FACTORY (fresh instruction
  // objects per use) because the ref is loaded twice (test + call) — aliasing
  // one instr array into two tree positions double-shifts funcIdx fields when
  // post-codegen passes walk the tree (the #1448 corruption class).
  const objectOrErrorTagInner = (loadRef: () => Instr[]): Instr[] =>
    errToStrIdx !== undefined && errStructTypeIdx >= 0
      ? [
          ...loadRef(),
          { op: "ref.test", typeIdx: errStructTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [...loadRef(), { op: "call", funcIdx: errToStrIdx }],
            else: objectTag(loadRef),
          },
        ]
      : objectTag(loadRef);

  // (#4491 T4-B) The Date arm sits OUTSIDE the error arm, same factory
  // discipline. `d.toString()` is folded statically to `__date_format_string`;
  // every DYNAMIC spelling (`String(d)`, `"" + d`, `d + d`, a template
  // substitution) arrived here and answered "[object Object]" — one value, two
  // renderings, and the spelling one reaches for when checking is the correct
  // one. `__date_any_to_string` calls that same formatter, so the two cannot
  // drift.
  const objectOrErrorTag = (loadRef: () => Instr[]): Instr[] =>
    dateToStrIdx !== undefined && dateStructTypeIdx >= 0
      ? [
          ...loadRef(),
          { op: "ref.test", typeIdx: dateStructTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [...loadRef(), { op: "call", funcIdx: dateToStrIdx }],
            else: objectOrErrorTagInner(loadRef),
          },
        ]
      : objectOrErrorTagInner(loadRef);

  // #1910/#1472 S2 — recover the string for an externref that is tagged as a
  // string (tag 5) but is NOT actually a `$AnyString`. The generic
  // externref→AnyValue boxing tags EVERY externref as tag-5 (see
  // value-tags.ts:185), so a boxed-primitive WRAPPER (`new String`/`new Number`/
  // `new Boolean` → a `$Object` carrying the internal [[PrimitiveValue]] slot)
  // reaches the tag-5 arm; the raw `ref.cast $AnyString` would trap ("illegal
  // cast"). When the value is a `$Object`, reduce it with `__to_primitive`
  // (registered by ensureObjectRuntime BEFORE this helper bakes, so its funcIdx
  // is known here — same no-intervening-shift invariant the rest of this helper
  // relies on), which reads the wrapper's internal slot and returns its boxed
  // primitive. That primitive is then a `$AnyString` (string wrapper) or a
  // `$__box_number_struct`/`$__box_boolean_struct` (number/boolean wrapper), all
  // of which the existing $AnyString test + residual box-recovery format
  // correctly — so we route the reduced value back through that recovery
  // (`stringifyExtern`). Non-`$Object` tag-5 externrefs (boxed primitive carriers
  // crossing the open-any boundary) skip straight to that recovery unchanged.
  const toPrimitiveIdx = ctx.funcMap.get("__to_primitive");
  const objectRtTypes = ctx.objectRuntimeTypes;
  const boxNumIdxEarly = ctx.nativeBoxNumberTypeIdx;
  const boxBoolIdxEarly = ctx.nativeBoxBooleanTypeIdx;
  // Format an externref already known NOT to be a $AnyString: recover a
  // $__box_number_struct / $__box_boolean_struct, else "[object Object]".
  const stringifyBoxedExtern = (loadExtern: Instr[]): Instr[] =>
    boxNumIdxEarly >= 0 && boxBoolIdxEarly >= 0
      ? [
          ...loadExtern,
          { op: "any.convert_extern" },
          { op: "local.tee", index: L_RECOVER },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [
              { op: "local.get", index: L_RECOVER },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
            ],
            else: [
              { op: "local.get", index: L_RECOVER },
              { op: "ref.test", typeIdx: boxNumIdxEarly },
              // (#3673) …or an i31-boxed small int.
              { op: "local.get", index: L_RECOVER },
              { op: "ref.test", typeIdx: -20 },
              { op: "i32.or" },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: numberArm([
                  { op: "local.get", index: L_RECOVER },
                  { op: "ref.test", typeIdx: -20 },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "f64" } },
                    then: [
                      { op: "local.get", index: L_RECOVER },
                      { op: "ref.cast", typeIdx: -20 },
                      { op: "i31.get_s" },
                      { op: "f64.convert_i32_s" },
                    ],
                    else: [
                      { op: "local.get", index: L_RECOVER },
                      { op: "ref.cast", typeIdx: boxNumIdxEarly },
                      { op: "struct.get", typeIdx: boxNumIdxEarly, fieldIdx: 0 },
                    ],
                  },
                ]),
                else: [
                  { op: "local.get", index: L_RECOVER },
                  { op: "ref.test", typeIdx: boxBoolIdxEarly },
                  {
                    op: "if",
                    blockType: { kind: "val", type: strRef },
                    then: [
                      { op: "local.get", index: L_RECOVER },
                      { op: "ref.cast", typeIdx: boxBoolIdxEarly },
                      { op: "struct.get", typeIdx: boxBoolIdxEarly, fieldIdx: 0 },
                      {
                        op: "if",
                        blockType: { kind: "val", type: strRef },
                        then: litStr("true"),
                        else: litStr("false"),
                      },
                    ],
                    // (#2962) a `$Error_struct` reaching the tag-5 boxed-extern
                    // recovery (a caught error re-boxed as `any`) renders
                    // "Name: message" instead of "[object Object]".
                    else: objectOrErrorTag(() => [{ op: "local.get", index: L_RECOVER }]),
                  },
                ],
              },
            ],
          },
        ]
      : litStr("[object Object]");
  const recoverNonStringExtern = (loadExtern: Instr[]): Instr[] =>
    toPrimitiveIdx !== undefined && objectRtTypes !== undefined
      ? [
          // if (value is a $Object wrapper) value = __to_primitive(value, default)
          ...loadExtern,
          { op: "any.convert_extern" },
          { op: "local.tee", index: L_RECOVER },
          { op: "ref.test", typeIdx: objectRtTypes.objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: stringifyBoxedExtern([
              { op: "local.get", index: L_RECOVER },
              { op: "extern.convert_any" },
              { op: "ref.null.extern" }, // default hint
              { op: "call", funcIdx: toPrimitiveIdx },
            ]),
            else: stringifyBoxedExtern([{ op: "local.get", index: L_RECOVER }, { op: "extern.convert_any" }]),
          },
        ]
      : stringifyBoxedExtern(loadExtern);

  const tagEq = (tag: number): Instr[] => [
    { op: "local.get", index: L_BOX },
    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
  ];

  // tag dispatch as a nested if/else chain producing `ref $AnyString`.
  const boxDispatch: Instr[] = [
    ...tagEq(0),
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: litStr("null"),
      else: [
        ...tagEq(1),
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: litStr("undefined"),
          else: [
            ...tagEq(2),
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: numberArm([
                { op: "local.get", index: L_BOX },
                { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
                { op: "f64.convert_i32_s" },
              ]),
              else: [
                ...tagEq(3),
                {
                  op: "if",
                  blockType: { kind: "val", type: strRef },
                  then: numberArm([
                    { op: "local.get", index: L_BOX },
                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 2 },
                  ]),
                  else: [
                    ...tagEq(4),
                    {
                      op: "if",
                      blockType: { kind: "val", type: strRef },
                      then: [
                        { op: "local.get", index: L_BOX },
                        {
                          op: "struct.get",
                          typeIdx: anyValueTypeIdx,
                          fieldIdx: 1,
                        },
                        {
                          op: "if",
                          blockType: { kind: "val", type: strRef },
                          then: litStr("true"),
                          else: litStr("false"),
                        },
                      ],
                      else: [
                        ...tagEq(5),
                        {
                          op: "if",
                          blockType: { kind: "val", type: strRef },
                          // tag 5 (string): the externval is USUALLY a real
                          // `$AnyString`, but the generic externref boxing also
                          // tags boxed-primitive WRAPPER objects (new String /
                          // Number / Boolean → $Object) and other open externrefs
                          // as tag-5 (#1910/#1472 S2). Test $AnyString first; only
                          // cast when it really is a string, otherwise recover via
                          // __extern_toString (reads the wrapper's internal slot
                          // through ToPrimitive). Without this guard the raw cast
                          // traps with "illegal cast" for `new String("1") + x`.
                          then: [
                            { op: "local.get", index: L_BOX },
                            {
                              op: "struct.get",
                              typeIdx: anyValueTypeIdx,
                              fieldIdx: 4,
                            },
                            { op: "any.convert_extern" },
                            { op: "local.tee", index: L_RECOVER },
                            { op: "ref.test", typeIdx: anyStrTypeIdx },
                            {
                              op: "if",
                              blockType: { kind: "val", type: strRef },
                              then: [
                                { op: "local.get", index: L_RECOVER },
                                { op: "ref.cast", typeIdx: anyStrTypeIdx },
                              ],
                              else: recoverNonStringExtern([
                                { op: "local.get", index: L_RECOVER },
                                { op: "extern.convert_any" },
                              ]),
                            },
                          ],
                          // tag 6 / unknown → $Error_struct renders
                          // "Name: message" (#2962), else "[object Object]"
                          else: objectOrErrorTag(() => [
                            { op: "local.get", index: L_BOX },
                            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 3 },
                          ]),
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

  // (#2072) Standalone primitive-box recovery — subsumes the #1988 number-only
  // arm (which lived at this exact residual location and recovered ONLY
  // `$__box_number_struct` → number_toString, e.g. the `1` in `1 + {}` after
  // ToPrimitive). An `any`-held primitive is NOT stored as a $AnyValue box on
  // the WasmGC/standalone path — `coerceType` boxes f64 via `__box_number`
  // ($__box_number_struct), bool via `__box_boolean` ($__box_boolean_struct),
  // then `extern.convert_any` makes it externref (the #1888 externref ABI the
  // test262 comparator relies on, which is why we recover the shape here rather
  // than changing the box). So when the value is neither $AnyString nor
  // $AnyValue, before yielding "[object Object]" we ref.test the boxed-primitive
  // structs and format them, matching what the $AnyValue tag-2/tag-4 arms above
  // already do. Without this, String(v) for `const v: any = 42 / true` returned
  // "[object Object]". The number sub-arm uses `numberArm(...)`, which appends
  // exactly `call number_toString; any.convert_extern; ref.cast $AnyString` —
  // byte-identical to #1988's explicit emit (and falls back to "[object Object]"
  // when `number_toString` is absent), so #1988's `1 + {}` case still holds.
  // Type indices (not func indices) are read here, so no late-import shift
  // hazard; the only func index baked in is `numToStrIdx`, which this helper
  // already bakes for tag 2/3.
  const boxNumIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolIdx = ctx.nativeBoxBooleanTypeIdx;
  const residualArm: Instr[] =
    boxNumIdx >= 0 && boxBoolIdx >= 0
      ? [
          // $__box_number_struct (or #3673 i31 small int)? → number_toString(value)
          { op: "local.get", index: L_V },
          { op: "ref.test", typeIdx: boxNumIdx },
          { op: "local.get", index: L_V },
          { op: "ref.test", typeIdx: -20 },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: numberArm([
              { op: "local.get", index: L_V },
              { op: "ref.test", typeIdx: -20 },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "f64" } },
                then: [
                  { op: "local.get", index: L_V },
                  { op: "ref.cast", typeIdx: -20 },
                  { op: "i31.get_s" },
                  { op: "f64.convert_i32_s" },
                ],
                else: [
                  { op: "local.get", index: L_V },
                  { op: "ref.cast", typeIdx: boxNumIdx },
                  { op: "struct.get", typeIdx: boxNumIdx, fieldIdx: 0 },
                ],
              },
            ]),
            else: [
              // $__box_boolean_struct? → "true" / "false"
              { op: "local.get", index: L_V },
              { op: "ref.test", typeIdx: boxBoolIdx },
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: [
                  { op: "local.get", index: L_V },
                  { op: "ref.cast", typeIdx: boxBoolIdx },
                  { op: "struct.get", typeIdx: boxBoolIdx, fieldIdx: 0 },
                  {
                    op: "if",
                    blockType: { kind: "val", type: strRef },
                    then: litStr("true"),
                    else: litStr("false"),
                  },
                ],
                // unknown ref → $Error_struct renders "Name: message"
                // (#2962), else "[object Object]"
                else: objectOrErrorTag(() => [{ op: "local.get", index: L_V }]),
              },
            ],
          },
        ]
      : // No box types registered — still recognize a raw `$Error_struct`
        // (#2962) before the "[object Object]" terminal.
        objectOrErrorTag(() => [{ op: "local.get", index: L_V }]);

  const body: Instr[] = [
    // if (v is a $AnyString) return it directly
    { op: "local.get", index: L_V },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [
        { op: "local.get", index: L_V },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
      else: [
        // else if (v is a $AnyValue) dispatch on its tag
        { op: "local.get", index: L_V },
        { op: "ref.test", typeIdx: anyValueTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [
            { op: "local.get", index: L_V },
            { op: "ref.cast", typeIdx: anyValueTypeIdx },
            { op: "local.set", index: L_BOX },
            ...boxDispatch,
          ],
          // else (boxed primitive externref shape, null ref, plain object, vec,
          // …) → recover number/boolean boxes, then "[object Object]"
          else: residualArm,
        },
      ],
    },
  ];

  const typeIdx = addFuncType(ctx, [anyref], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__any_to_string", funcIdx);
  ctx.funcMap.set("__any_to_string", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__any_to_string",
    typeIdx,
    locals: [
      { name: "box", type: { kind: "ref_null", typeIdx: anyValueTypeIdx } },
      { name: "recover", type: { kind: "anyref" } },
      { name: "toprim", type: { kind: "anyref" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #2007 — emit a per-vec-type native array-join helper
 * `__vec_join_<elemKind>(v: ref null $__vec_<elemKind>) -> ref $AnyString`.
 *
 * Joins the vec's elements with `","` using native string concat:
 *   - numeric element (f64/i32/i8/i16) → `number_toString` (native string boxed
 *     as externref → convert back to `ref $AnyString`);
 *   - native-string element (`ref $AnyString` / `$NativeString`) → passthrough
 *     (a subtype of `$AnyString`);
 *   - nested-vec element (`ref` to another registered `__vec_*`) → recurse into
 *     THAT vec's own `__vec_join_*` helper, so `[[1,2],[3]]` yields `"1,2,3"`;
 *   - any other ref / externref element → `"[object Object]"` (the same residual
 *     `$__any_to_string` would give — kept simple to avoid a cross-helper call
 *     index that the addUnionImports late shift can desync, #1839).
 *
 * **Index-shift safety (the #1448 regression fix):** every dependency
 * (`number_toString`, a nested `__vec_join_*`) is emitted *first*, so any late
 * import shift it triggers happens BEFORE this body is built; their final
 * indices are read after, then the body is built and pushed with NO intervening
 * helper emission. Otherwise a shift between baking a `call funcIdx` and pushing
 * the body leaves the not-yet-attached body un-walked by `shiftFuncIndices` →
 * stale index → "call expected (ref null 5), found anyref" (the #1448 break).
 *
 * Empty vec → `""`; single element → that element's string. Idempotent: cached
 * under `nativeStrHelpers["__vec_join_<elemKind>"]`.
 */
function ensureNativeVecJoinHelper(
  ctx: CodegenContext,
  elemKind: string,
  vecTypeIdx: number,
  arrTypeIdx: number,
): number | undefined {
  const cacheKey = `__vec_join_${elemKind}`;
  const cached = ctx.nativeStrHelpers.get(cacheKey);
  if (cached !== undefined) return cached;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return undefined;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };

  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemType: ValType = arrDef && arrDef.kind === "array" ? (arrDef.element as ValType) : { kind: "f64" };
  const isNumeric =
    elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "i8" || elemType.kind === "i16";
  const isNativeStrElem =
    (elemType.kind === "ref" || elemType.kind === "ref_null") &&
    (elemType as { typeIdx: number }).typeIdx === anyStrTypeIdx;
  // A non-string ref element whose target is itself a registered vec → nested
  // array; recurse into that vec's join helper.
  let nestedElemKind: string | undefined;
  if ((elemType.kind === "ref" || elemType.kind === "ref_null") && !isNativeStrElem) {
    const elemTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    for (const [k, idx] of ctx.vecTypeMap.entries()) {
      if (idx === elemTypeIdx) {
        nestedElemKind = k;
        break;
      }
    }
  }

  // ── Run EVERY side-effecting emission FIRST, then read ALL indices last ──
  // (#1448) `emitNativeNumberFormat`, a nested `ensureNativeVecJoinHelper`, and
  // `nativeStringLiteralInstrs` (string-constant global / late import
  // registration) can each trigger an `addUnionImports` function-index shift.
  // If we read a funcIdx and THEN one of these shifts, the read index goes
  // stale and the baked `call` targets the wrong function (the #1448
  // catastrophe: number_toString resolved to a (i32)→… and codegen even
  // inserted an `i32.trunc_sat_f64_s` to match it, plus a stray stack value).
  // So perform ALL emissions up front, materialize the literal-string
  // instruction arrays here too, and only THEN snapshot every funcIdx.
  if (isNumeric && ctx.funcMap.get("number_toString") === undefined) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  }
  let nestedJoinIdx: number | undefined;
  if (nestedElemKind !== undefined) {
    const nestedVecTypeIdx = ctx.vecTypeMap.get(nestedElemKind)!;
    const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
    if (nestedArrTypeIdx >= 0) {
      nestedJoinIdx = ensureNativeVecJoinHelper(ctx, nestedElemKind, nestedVecTypeIdx, nestedArrTypeIdx);
    }
  }
  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);
  // Materialize the constant strings now (last possible shift source) so their
  // string-constant globals register before we snapshot any function index.
  const objObjInstrs = litStr("[object Object]");
  const sepInstrs = litStr(",");
  const emptyInstrs = litStr("");

  // Now snapshot every cross-function index — all shift sources are behind us.
  const numToStrIdx = isNumeric ? ctx.funcMap.get("number_toString") : undefined;
  if (isNumeric && numToStrIdx === undefined) return undefined;
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return undefined;

  // param v(0); locals: data(1), len(2), i(3), result(4)
  const V = 0;
  const DATA = 1;
  const LEN = 2;
  const I = 3;
  const RESULT = 4;

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // element i → ref $AnyString
  const elemToStr: Instr[] = [
    { op: "local.get", index: DATA },
    { op: "local.get", index: I },
    { op: getOp, typeIdx: arrTypeIdx },
  ];
  if (isNumeric && numToStrIdx !== undefined) {
    if (elemType.kind !== "f64") elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: numToStrIdx });
    elemToStr.push({ op: "any.convert_extern" });
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
  } else if (isNativeStrElem) {
    // native-string element — already a (ref null $AnyString) subtype; non-null.
    elemToStr.push({ op: "ref.as_non_null" });
  } else if (nestedJoinIdx !== undefined) {
    // nested array element → recurse into its own join helper.
    elemToStr.push({ op: "call", funcIdx: nestedJoinIdx });
  } else {
    // any other ref / externref element → residual "[object Object]".
    elemToStr.length = 0;
    elemToStr.push(...objObjInstrs);
  }

  const loopBody: Instr[] = [
    { op: "local.get", index: I },
    { op: "local.get", index: LEN },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // result = (i == 0) ? elem : __str_concat(__str_concat(result, ","), elem)
    { op: "local.get", index: I },
    { op: "i32.const", value: 0 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...elemToStr, { op: "local.set", index: RESULT }],
      else: [
        { op: "local.get", index: RESULT },
        ...sepInstrs,
        { op: "call", funcIdx: strConcatIdx },
        ...elemToStr,
        { op: "call", funcIdx: strConcatIdx },
        { op: "local.set", index: RESULT },
      ],
    },

    { op: "local.get", index: I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: I },
    { op: "br", depth: 0 },
  ];

  const body: Instr[] = [
    // null receiver → "" (defensive; concat callers never pass null vecs)
    { op: "local.get", index: V },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: emptyInstrs,
      else: [
        // len = v.length (field 0); data = v.data (field 1)
        { op: "local.get", index: V },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: LEN },
        { op: "local.get", index: V },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.set", index: DATA },
        // result = ""
        ...litStr(""),
        { op: "local.set", index: RESULT },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
        },
        { op: "local.get", index: RESULT },
      ],
    },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "ref_null", typeIdx: vecTypeIdx }], [strRef]);
  const joinFuncIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set(cacheKey, joinFuncIdx);
  ctx.funcMap.set(cacheKey, joinFuncIdx);
  pushDefinedFunc(ctx, joinFuncIdx, {
    name: cacheKey,
    typeIdx,
    locals: [
      { name: "data", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "result", type: strRef },
    ],
    body,
    exported: false,
  });
  return joinFuncIdx;
}

/**
 * #2007 — call-site entry point for the standalone `+`/template concat path.
 * When a concat operand is a statically-known WasmGC vec (array) ref, emit the
 * Array.prototype.join lowering **inline into `fctx.body`** and leave a
 * `ref $AnyString` on the stack. Returns true if it handled the operand.
 *
 * The operand value is assumed already on the stack with the given
 * `vecValType` (a `ref`/`ref_null` to a registered vec struct).
 *
 * **Why inline, not a cached helper (#1448).** Emitting into the current
 * function body is the proven-safe pattern (cf. `compileArrayJoinNative`):
 * `number_toString` / `__str_concat` indices are read here and the resulting
 * `call`s live in `fctx.body`, which the late-import `shiftFuncIndices` pass
 * always walks — so a closure-method operand (`[...].map(fn)`, whose late
 * import registration desyncs a *separate cached helper's* baked indices) can
 * no longer produce an invalid module. Nested-array elements (a ref to another
 * registered vec, common in `[[1,2],[3]]` literals which are closure-free)
 * recurse into the cached per-vec join helper, which is consistent there.
 */
export function tryCompileNativeVecConcatOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecValType: ValType,
): boolean {
  if (vecValType.kind !== "ref" && vecValType.kind !== "ref_null") return false;
  const vecTypeIdx = (vecValType as { typeIdx: number }).typeIdx;
  if (vecTypeIdx === undefined) return false;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return false;
  // Confirm this typeIdx is actually a registered vec (not some other struct
  // that happens to have an array in field 1).
  let isVec = false;
  for (const idx of ctx.vecTypeMap.values()) {
    if (idx === vecTypeIdx) {
      isVec = true;
      break;
    }
  }
  if (!isVec) return false;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return false;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return false;

  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemType: ValType = arrDef && arrDef.kind === "array" ? (arrDef.element as ValType) : { kind: "f64" };
  const isNumeric =
    elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "i8" || elemType.kind === "i16";
  const isNativeStrElem =
    (elemType.kind === "ref" || elemType.kind === "ref_null") &&
    (elemType as { typeIdx: number }).typeIdx === anyStrTypeIdx;
  // nested array element → recurse into the cached join helper for the inner vec.
  let nestedElemKind: string | undefined;
  if ((elemType.kind === "ref" || elemType.kind === "ref_null") && !isNativeStrElem) {
    const elemTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    for (const [k, idx] of ctx.vecTypeMap.entries()) {
      if (idx === elemTypeIdx) {
        nestedElemKind = k;
        break;
      }
    }
  }

  // Only element kinds we can stringify by value qualify for the join fast-path:
  // numeric, native-string, or a nested vec. An `externref`-element vec is what a
  // closure array method (`[...].map(fn)`) produces — its elements are opaque
  // boxed `any`s, and such operands stringified as "[object Object]" on baseline.
  // Routing them here would (a) need a host/ToString bridge the standalone lane
  // lacks and (b) re-introduce the closure index-desync, so fall back to
  // `$__any_to_string` (the existing "[object Object]" behaviour — no regression).
  if (!isNumeric && !isNativeStrElem && nestedElemKind === undefined) return false;

  // (#1448) If a closure-allocating array method (`map`/`filter`/…) was already
  // lowered in this function, the native array-join lowering corrupts the
  // closure's emitted code (a pre-existing hazard `a.join(",")` exhibits too —
  // see the issue analysis). Fall back to `$__any_to_string` ("[object Object]",
  // the baseline behaviour) in that case rather than emit an invalid module —
  // no regression. The headline `"" + [1,2]` / template cases compile in plain
  // functions that never set this flag, so they keep the join fast-path.
  if (fctx.emittedClosureArrayMethod) return false;

  // Ensure dependencies (these may shift indices — fine, fctx.body is walked).
  let numToStrIdx: number | undefined;
  if (isNumeric) {
    if (ctx.funcMap.get("number_toString") === undefined) {
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    }
    numToStrIdx = ctx.funcMap.get("number_toString");
    if (numToStrIdx === undefined) return false;
  }
  let nestedJoinIdx: number | undefined;
  if (nestedElemKind !== undefined) {
    const nestedVecTypeIdx = ctx.vecTypeMap.get(nestedElemKind)!;
    const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
    if (nestedArrTypeIdx >= 0) {
      nestedJoinIdx = ensureNativeVecJoinHelper(ctx, nestedElemKind, nestedVecTypeIdx, nestedArrTypeIdx);
    }
  }

  // Locals: the vec ref (tee'd from the stack), data array, length, index, result.
  const vecTmp = allocLocal(fctx, `__vcat_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__vcat_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__vcat_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__vcat_i_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__vcat_res_${fctx.locals.length}`, strRef);

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const elemToStr: Instr[] = [
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
  ];
  if (isNumeric && numToStrIdx !== undefined) {
    if (elemType.kind !== "f64") elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: numToStrIdx });
    elemToStr.push({ op: "any.convert_extern" });
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
  } else if (isNativeStrElem) {
    elemToStr.push({ op: "ref.as_non_null" });
  } else if (nestedJoinIdx !== undefined) {
    elemToStr.push({ op: "call", funcIdx: nestedJoinIdx });
  } else {
    // any other ref / externref element → residual "[object Object]".
    elemToStr.length = 0;
    elemToStr.push(...nativeStringLiteralInstrs(ctx, "[object Object]"));
  }

  // The vec ref is on the stack — tee into vecTmp, guard null → "".
  fctx.body.push({ op: "local.tee", index: vecTmp });
  // (a null vec stringifies as "" here — concat callers never pass null vecs)
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: strRef },
    then: nativeStringLiteralInstrs(ctx, ""),
    else: [
      { op: "local.get", index: vecTmp },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: lenTmp },
      { op: "local.get", index: vecTmp },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: dataTmp },
      ...nativeStringLiteralInstrs(ctx, ""),
      { op: "local.set", index: resultTmp },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iTmp },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: iTmp },
              { op: "local.get", index: lenTmp },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: iTmp },
              { op: "i32.const", value: 0 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...elemToStr, { op: "local.set", index: resultTmp }],
                else: [
                  { op: "local.get", index: resultTmp },
                  ...nativeStringLiteralInstrs(ctx, ","),
                  { op: "call", funcIdx: strConcatIdx },
                  ...elemToStr,
                  { op: "call", funcIdx: strConcatIdx },
                  { op: "local.set", index: resultTmp },
                ],
              },
              { op: "local.get", index: iTmp },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iTmp },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: resultTmp },
    ],
  });
  return true;
}

/**
 * #1470 — Emit `$__str_to_char_vec(s: ref $AnyString) -> ref $vec_nstr`: the
 * pure-Wasm String-iterator materializer. Splits the string into single
 * **code point** strings per §22.1.5.1 (the String Iteration protocol that
 * `[...s]`, `Array.from(s)` and for-of observe): a well-formed surrogate
 * pair yields one 2-code-unit string; everything else (BMP scalars and lone
 * surrogates) yields a 1-code-unit string.
 *
 * The result reuses the `ref_<anyStr>` vec registration that `__str_split`
 * established, so callers get the exact vec shape `string[]` lowers to
 * (`.length`, indexing, spreads compose without conversion). The backing
 * array is sized `len` (the code-unit count — an upper bound on the code
 * point count); the vec's `len` field carries the actual element count, so
 * trailing unused slots are never observed.
 *
 * Returns both the helper funcIdx (current at call time — late-import shifts
 * keep `nativeStrHelpers` patched, #1839) and the nstr vec type index.
 */
export function ensureStrToCharVecHelper(ctx: CodegenContext): { funcIdx: number; vecTypeIdx: number } {
  ensureNativeStringHelpers(ctx);

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;

  // Same registration key/type as `__str_split` so the vec matches string[].
  const nstrElemKey = `ref_${anyStrTypeIdx}`;
  const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
  const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);

  const existing = ctx.nativeStrHelpers.get("__str_to_char_vec");
  if (existing !== undefined) return { funcIdx: existing, vecTypeIdx: nstrVecTypeIdx };

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten")!;
  const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

  // param: s(0); locals: flat(1), len(2), off(3), data(4), out(5), n(6),
  // i(7), cu(8), take(9)
  const S = 0;
  const FLAT = 1;
  const LEN = 2;
  const OFF = 3;
  const DATA = 4;
  const OUT = 5;
  const N = 6;
  const I = 7;
  const CU = 8;
  const TAKE = 9;

  const body: Instr[] = [
    // flat = __str_flatten(s); cache len/off/data
    { op: "local.get", index: S },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: FLAT },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: LEN },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: OFF },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: DATA },

    // out = new (ref null $AnyString)[len] — len is an upper bound on the
    // code-point count; the vec's len field below carries the real count.
    { op: "local.get", index: LEN },
    { op: "array.new_default", typeIdx: nstrArrTypeIdx },
    { op: "local.set", index: OUT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: N },
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
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // cu = data[off + i]; take = 1
            { op: "local.get", index: DATA },
            { op: "local.get", index: OFF },
            { op: "local.get", index: I },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: CU },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: TAKE },

            // High surrogate with a following low surrogate → take = 2
            // (cu & 0xFC00) == 0xD800 && i + 1 < len
            { op: "local.get", index: CU },
            { op: "i32.const", value: 0xfc00 },
            { op: "i32.and" },
            { op: "i32.const", value: 0xd800 },
            { op: "i32.eq" },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: LEN },
            { op: "i32.lt_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // (data[off + i + 1] & 0xFC00) == 0xDC00 → take = 2
                { op: "local.get", index: DATA },
                { op: "local.get", index: OFF },
                { op: "local.get", index: I },
                { op: "i32.add" },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "array.get_u", typeIdx: strDataTypeIdx },
                { op: "i32.const", value: 0xfc00 },
                { op: "i32.and" },
                { op: "i32.const", value: 0xdc00 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 2 },
                    { op: "local.set", index: TAKE },
                  ],
                },
              ],
            },

            // out[n] = __str_substring(flat, i, i + take); n++; i += take
            { op: "local.get", index: OUT },
            { op: "local.get", index: N },
            { op: "local.get", index: FLAT },
            { op: "ref.as_non_null" },
            { op: "local.get", index: I },
            { op: "local.get", index: I },
            { op: "local.get", index: TAKE },
            { op: "i32.add" },
            { op: "call", funcIdx: substringIdx },
            { op: "array.set", typeIdx: nstrArrTypeIdx },
            { op: "local.get", index: N },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: N },
            { op: "local.get", index: I },
            { op: "local.get", index: TAKE },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return { len: n, data: out }
    { op: "local.get", index: N },
    { op: "local.get", index: OUT },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: nstrVecTypeIdx },
  ];

  const typeIdx = addFuncType(ctx, [strRef], [{ kind: "ref", typeIdx: nstrVecTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__str_to_char_vec", funcIdx);
  ctx.funcMap.set("__str_to_char_vec", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__str_to_char_vec",
    typeIdx,
    locals: [
      { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "off", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      { name: "out", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "n", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "cu", type: { kind: "i32" } },
      { name: "take", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return { funcIdx, vecTypeIdx: nstrVecTypeIdx };
}

/**
 * (#3912) Can the `__str_to_extern` / `__str_from_extern` bridge be emitted in
 * this module at all?
 *
 * ## Why this is NOT `ctx.nativeStrings`
 *
 * The bridge is the only way to convert between a WasmGC `$AnyString` and a
 * REAL JS string, and it does that by copying UTF-16 code units through linear
 * memory using three **JS-host imports** — `__str_from_mem`, `__str_to_mem`,
 * `__str_extern_len` (see `ensureNativeStringExternBridge` below). There is no
 * pure-Wasm way to manufacture a JS string, so the bridge is *inherently*
 * host-dependent even though it is part of the NATIVE string subsystem.
 *
 * That makes "strings are native here" (`ctx.nativeStrings`) exactly the wrong
 * question — it is true in six lanes, three of which have no usable host:
 *
 *     nativeStrings = fast || wasi || standalone || strictNoHostImports || utf8Storage
 *
 * `wasi` / `standalone` have no JS runtime at all, and `strictNoHostImports`
 * has one but **forbids** host imports — the strict gate DROPS them, and
 * because `ensureNativeStringExternBridge` bakes the three funcidxs into
 * compiled helper bodies before the drop, the result is not a clean refusal but
 * a hard `absoluteFuncIndex: unresolved call target` codegen error.
 *
 * So the real question is "is there a JS host AND are host imports allowed?".
 * Callers that can degrade (hand the host an externref some other way, or skip
 * the marshal) MUST consult this first.
 *
 * ## Known pre-existing violation, deliberately not fixed here
 *
 * `console.log(<string>)` reaches the bridge unguarded, so it already fails to
 * compile under `strictNoHostImports` on `main` today with this exact error
 * (verified directly). Fixing that needs a decision about what `console.log`
 * should *do* with no host — it cannot both refuse to marshal and still call
 * the host console — so it is left alone rather than guessed at. This predicate
 * exists so that decision has a name to hang on.
 */
export function hostStringBridgeUsable(ctx: CodegenContext): boolean {
  return !ctx.wasi && !ctx.standalone && !ctx.strictNoHostImports;
}

export function ensureNativeStringExternBridge(ctx: CodegenContext): void {
  ensureNativeStringHelpers(ctx);
  if (ctx.nativeStrExternBridgeEmitted) return;
  ctx.nativeStrExternBridgeEmitted = true;

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // (#4238) With `importMemory` the module already has a memory at index 0 (an
  // IMPORTED one — `mod.memories` only holds DEFINED memories). Defining a
  // second one here would land at index 1 while every emitted load/store still
  // targets index 0, so skip: the bridge shares the peer's memory.
  if (ctx.mod.memories.length === 0 && ctx.importMemory === undefined) {
    ctx.mod.memories.push({ min: 1 });
    ctx.mod.exports.push({
      name: "__str_mem",
      desc: { kind: "memory", index: 0 },
    });
  }

  const importsBeforeBridge = ctx.numImportFuncs;
  const fromMemIdx = ensureLateImport(
    ctx,
    "__str_from_mem",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "externref" }],
  )!;
  const toMemIdx = ensureLateImport(ctx, "__str_to_mem", [{ kind: "externref" }, { kind: "i32" }], [])!;
  const externLenIdx = ensureLateImport(ctx, "__str_extern_len", [{ kind: "externref" }], [{ kind: "i32" }])!;
  // (#2934 slice 3) Close the deferred late-import batch BEFORE baking
  // `fromMemIdx`/`toMemIdx`/`externLenIdx` into the helper bodies below. The
  // deferred flush repairs STALE refs by bumping every `funcIdx >=
  // importsBefore` — it cannot distinguish a freshly-baked, already-final
  // import index (these three) from a stale defined-function ref, so leaving
  // the batch open until some later flush bumps the baked import refs onto
  // whatever defined function lands at that offset (`__str_to_extern`'s
  // `call __str_from_mem` resolved to `__str_copy_tree`, arity 3 — "not
  // enough arguments on the stack" for every object-with-own-toString string
  // coercion, S15.5.4.6_A4_T2). Flushing here settles all pre-batch stale
  // refs and makes the subsequent flush a no-op for this batch. Gated on
  // actually having REGISTERED imports (a funcMap-hit lookup is pure and must
  // not force-flush an outer batch), so already-registered paths are
  // byte-identical.
  if (ctx.numImportFuncs > importsBeforeBridge) {
    flushLateImportShifts(ctx, null);
  }

  {
    const typeIdx = addFuncType(ctx, [strRef], [{ kind: "externref" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_to_extern", funcIdx);
    ctx.funcMap.set("__str_to_extern", funcIdx);

    // The param is typed as the AnyString supertype, but the body reads
    // NativeString (FlatString) fields. We must flatten first: a ConsString /
    // Utf8String / template-literal result is NOT a NativeString, so reading
    // its fields via `struct.get NativeString` on the raw param produces an
    // invalid module (struct.get expected NativeString, found AnyString). For
    // an already-flat input __str_flatten is a cheap identity. (#1618 family —
    // surfaced by `process.stdout.write`/`console.log` of a template literal
    // under --target wasi, which emits this bridge.)
    //
    // __str_flatten via funcMap (NOT nativeStrHelpers): this body emits a `call
    // __str_flatten` after the three fd-bridge late imports above have been
    // queued, so the nativeStrHelpers index is stale-low (it's never rewritten by
    // the deferred shift). funcMap IS shift-maintained — __str_flatten is now
    // registered there too — so this resolves and shifts correctly. (#1618)
    const flattenIdx = ctx.funcMap.get("__str_flatten")!;
    const FLAT_LOCAL = 5;

    const body: Instr[] = [
      // flat = __str_flatten(s)  (locals[5])
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT_LOCAL },

      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.store16", align: 1, offset: 0 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: fromMemIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_to_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
        { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_from_extern", funcIdx);
    ctx.funcMap.set("__str_from_extern", funcIdx);

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: externLenIdx },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: toMemIdx },
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "i32.load16_u", align: 1, offset: 0 },
              { op: "array.set", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_from_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "arr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }
}

/**
 * Expose the existing native-string extern bridge only when a user export has
 * a source-level string at the JS boundary. Internal string semantics keep the
 * helpers private; the JS adapter calls these exports to preserve primitive
 * string values while object and array results remain live views.
 */
export function ensureNativeStringBoundaryBridge(ctx: CodegenContext): void {
  if (!hostStringBridgeUsable(ctx) || ctx.targetProfile.hostValueInterop === "off") return;
  ensureNativeStringExternBridge(ctx);
  if (!ctx.funcMap.has("__str_is_native")) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set("__str_is_native", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_is_native",
      typeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
      ],
      exported: true,
    });
  }
  for (const name of ["__str_to_extern", "__str_from_extern", "__str_is_native"] as const) {
    const funcIdx = ctx.funcMap.get(name);
    if (funcIdx === undefined) continue;
    const func = definedFuncAt(ctx, funcIdx);
    if (func) func.exported = true;
    if (!ctx.mod.exports.some((entry) => entry.name === name)) {
      ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
    }
  }
}

/**
 * Emit `__test_str_from_externref` and `__test_str_to_externref` exported
 * helpers (#1187). These are the test-runtime bridge that lets vitest tests
 * pass JS strings into Wasm exports whose native-string params have type
 * `(ref $AnyString)`, and read native-string results back as JS strings.
 *
 * Gated on `ctx.testRuntime && ctx.nativeStrings`. Production builds (with
 * `testRuntime` unset) never reach this code, so the helpers are absent
 * from the module entirely — zero runtime overhead.
 *
 * Preconditions (set up by the pre-pass in `generateModule`):
 *   - `addStringImports` has been called → `length`, `charCodeAt`, `concat`,
 *     `substring` are registered as `wasm:js-string` imports.
 *   - `String_fromCharCode` is registered as an `env` host import.
 *   - `ensureNativeStringHelpers` has been called → `__str_flatten` exists.
 */
export function emitTestRuntimeStringHelpers(ctx: CodegenContext): void {
  if (!ctx.testRuntime || !ctx.nativeStrings) return;
  if (ctx.testRuntimeStringHelpersEmitted) return;
  ctx.testRuntimeStringHelpersEmitted = true;

  // Make sure $__str_flatten exists. Called HERE rather than in the pre-pass
  // because emitting native-string helpers early causes a downstream
  // miscompile (the body references function indices that drift before
  // dead-elim runs). At this call site (after user code, before dead-elim)
  // index drift is impossible.
  ensureNativeStringHelpers(ctx);

  const mod = ctx.mod;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString (FlatString)
  const anyStrTypeIdx = ctx.anyStrTypeIdx; // $AnyString

  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const anyStrRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const externref: ValType = { kind: "externref" };

  // Resolve helper / import indices set up by the pre-pass.
  const lengthIdx = ctx.jsStringImports.get("length");
  const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
  const concatIdx = ctx.jsStringImports.get("concat");
  const substringIdx = ctx.jsStringImports.get("substring");
  const fromCharCodeIdx = ctx.funcMap.get("String_fromCharCode");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (
    lengthIdx === undefined ||
    charCodeAtIdx === undefined ||
    concatIdx === undefined ||
    substringIdx === undefined ||
    fromCharCodeIdx === undefined ||
    flattenIdx === undefined
  ) {
    // Pre-pass should have ensured these. Bail silently rather than emit a
    // module that won't validate — the test will fail noisily on missing
    // exports.
    return;
  }

  // ── __test_str_from_externref(externref s) -> (ref $AnyString) ──
  // Walks `s` char-by-char with `wasm:js-string.length` / `charCodeAt` and
  // builds a fresh `$NativeString` (subtype of `$AnyString`).
  //
  // params: s(0)
  // locals: len(1), data(2), i(3)
  {
    const typeIdx = addFuncType(ctx, [externref], [anyStrRef]);
    const funcIdx = mintDefinedFunc(ctx);

    const body: Instr[] = [
      // len = wasm:js-string.length(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lengthIdx },
      { op: "local.set", index: 1 },

      // data = array.new_default $__str_data(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 2 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      // Outer block (target for the loop's break)
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break out of the surrounding block (depth 1)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },

              // data[i] = wasm:js-string.charCodeAt(s, i)
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 3 },
              { op: "call", funcIdx: charCodeAtIdx },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i = i + 1
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },

              // continue loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // struct.new $NativeString(len, 0, data) — subtype-flows into ref $AnyString
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__test_str_from_externref",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({
      name: "__test_str_from_externref",
      desc: { kind: "func", index: funcIdx },
    });
  }

  // ── __test_str_to_externref((ref $AnyString) s) -> externref ──
  // Flattens to a `$NativeString`, then walks the data array and accumulates
  // a JS string via `wasm:js-string.concat` + `String_fromCharCode`. O(n²) by
  // string concatenation, but fine for the small strings used in tests.
  //
  // The result is seeded with an empty JS string via
  // `wasm:js-string.substring(<any>, 0, 0)` so the first concat has a string
  // operand even when len == 0.
  //
  // params: s(0)
  // locals: flat(1), len(2), off(3), result(4), i(5)
  {
    const typeIdx = addFuncType(ctx, [anyStrRef], [externref]);
    const funcIdx = mintDefinedFunc(ctx);

    const body: Instr[] = [
      // flat = __str_flatten(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: 1 },

      // len = flat.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // off = flat.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 },

      // result = substring(String_fromCharCode(0.0), 0, 0) — gives "" as externref
      { op: "f64.const", value: 0 },
      { op: "call", funcIdx: fromCharCodeIdx },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: substringIdx },
      { op: "local.set", index: 4 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },

      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break (depth 1 = outer block)
              { op: "local.get", index: 5 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },

              // result = concat(result, String_fromCharCode(data[off + i]))
              { op: "local.get", index: 4 }, // result

              { op: "local.get", index: 1 }, // flat
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
              { op: "local.get", index: 3 }, // off
              { op: "local.get", index: 5 }, // i
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: fromCharCodeIdx },

              { op: "call", funcIdx: concatIdx },
              { op: "local.set", index: 4 },

              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },

              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return result
      { op: "local.get", index: 4 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__test_str_to_externref",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "len", type: { kind: "i32" } },
        { name: "off", type: { kind: "i32" } },
        { name: "result", type: externref },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({
      name: "__test_str_to_externref",
      desc: { kind: "func", index: funcIdx },
    });
  }
}

/**
 * (#2962) Harness-readable exception rendering for standalone/WASI binaries —
 * the export pair that de-opaques the "uncaught Wasm-GC exception
 * (non-stringifiable payload)" bucket (~5.9k standalone baseline entries).
 *
 * A natively-thrown payload (an `$Error_struct`, a native string, a boxed
 * number, …) is a WasmGC value the HOST cannot stringify — `String(payload)`
 * throws `Cannot convert object to primitive value`, so the test262 harness
 * (`extractWasmExceptionMessage`) could only record the #2870 opaque label.
 * These exports let the harness render the payload with ZERO host imports,
 * following the same harness-support-export pattern as `__sget_*` / `__vec_*`:
 *
 *   - `__exn_render_prepare(payload: externref) -> i32` — runs the payload
 *     through the same `__any_to_string` chain the in-module `String(x)`
 *     coercion uses (so an `$Error_struct` renders `"TypeError: boom"` via
 *     `__error_to_string`, §20.5.3.4), flattens the result, stashes it in a
 *     module global, and returns its code-unit length (`-1` for a null
 *     payload — the harness keeps its legacy label).
 *   - `__exn_render_char(i: i32) -> i32` — code-unit readback from the
 *     prepared buffer (`0` when unprepared / out of range).
 *
 * Emitted at finalize (see the `emitExceptionRenderExports` call in
 * codegen/index.ts) and gated on `(standalone || wasi) && nativeStrings &&
 * exnTagIdx >= 0` — a module that cannot throw through the `$exc` tag gets
 * neither export nor the string-runtime pull-in, keeping non-throwing modules
 * byte-identical. JS-host binaries are untouched (payloads there are real JS
 * values the host formats directly).
 *
 * Index-shift safety: both dependencies (`__any_to_string`, `__str_flatten`)
 * are ensured/read from the authoritative `funcMap`/`nativeStrHelpers` BEFORE
 * either body is built, and both functions are pushed with no intervening
 * helper emission or import registration.
 */
export function emitExceptionRenderExports(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  if (!ctx.nativeStrings) return;
  if (ctx.exnTagIdx < 0) return;
  if (ctx.funcMap.has("__exn_render_prepare")) return;

  // (#2969) Force `number_toString` before `__any_to_string` bakes so its number
  // arm renders a raw thrown number ("42") instead of degrading to
  // "[object Object]" — a throwing module that never itself stringifies a number
  // otherwise leaves the arm unresolved. `emitExceptionRenderExports` is the
  // first (and here, only) consumer of `__any_to_string` for such a module, so
  // ensuring the format helper ahead of the `ensureAnyToStringHelper` call below
  // makes the number arm real. Size cost falls only on throwing standalone/WASI
  // modules. Must precede the ensure call (which snapshots the number_toString
  // funcIdx into the baked arm).
  if (ctx.funcMap.get("number_toString") === undefined) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  }

  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
  const flatTypeIdx = ctx.nativeStrTypeIdx;
  const dataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (anyToStrIdx === undefined || flattenIdx === undefined || flatTypeIdx < 0 || dataTypeIdx < 0) return;

  // (#4394) Arms for DECLINED harness error fnctors (new-builtin-globals.ts):
  // `new Test262Error(msg)` in a module that DECLARES `function Test262Error`
  // now constructs an ordinary user-fnctor instance for correct identity, so a
  // thrown one matches no `$Error_struct` arm in `__any_to_string` and rendered
  // "[object Object]" — the merged standalone report lost every
  // "Test262Error: …" signature (213 unclassified rows, the #4484 park). Each
  // arm mirrors the harness's own prototype toString: `"Name: " + message`,
  // with the message field rendered through the same `__any_to_string` chain
  // the in-module `String(x)` coercion uses (an undefined message renders
  // "Name: undefined", exactly what the harness's `+` produces). Every helper
  // index and literal global is resolved HERE, before either body is built —
  // the index-shift-safety contract of this emitter (see doc above); literal
  // instrs are interned global reads, so building them early adds no funcs and
  // no imports.
  const fnctorArms: { typeIdx: number; fieldIdx: number; fieldIsExtern: boolean; prefixInstrs: Instr[] }[] = [];
  for (const name of ctx.exnRenderFnctorErrorNames ?? []) {
    const structTypeIdx = ctx.fnctorReservedTypeIdx.get(name);
    const fields = ctx.structFields.get(`__fnctor_${name}`);
    const fieldIdx = fields === undefined ? -1 : fields.findIndex((f) => f.name === "message");
    if (structTypeIdx === undefined || fields === undefined || fieldIdx < 0) continue;
    const ft = fields[fieldIdx].type;
    if (ft.kind !== "externref" && ft.kind !== "anyref" && ft.kind !== "ref" && ft.kind !== "ref_null") continue;
    fnctorArms.push({
      typeIdx: structTypeIdx,
      fieldIdx,
      fieldIsExtern: ft.kind === "externref",
      prefixInstrs: nativeStringLiteralInstrs(ctx, `${name}: `),
    });
  }
  // (#4097) Same arm shape for a thrown USER-CLASS error instance. Legacy
  // throws such a struct only for a class the builtin-error interception does
  // NOT claim; the IR throws it for `class Test262Error` too (measured: both
  // paths register the IDENTICAL struct — same typeIdx, name and fields — so
  // the divergence is which VALUE the `new` site allocates, not struct
  // identity, and #4035 declined the throw over the resulting
  // "[object Object]"). Arms key on the struct's own registered name and are
  // PATH-INDEPENDENT, so IR and legacy render alike. Gated on `ctx.classSet`
  // (local class declarations only) plus a `message` field, so a plain data
  // class keeps the canonical "[object Object]"; `$Error_struct` is skipped —
  // `__any_to_string` already routes it through §20.5.3.4.
  for (const [structTypeIdx, structName] of ctx.typeIdxToStructName) {
    if (structTypeIdx === ctx.errorStructTypeIdx) continue;
    if (!ctx.classSet.has(structName)) continue;
    const fields = ctx.structFields.get(structName);
    const fieldIdx = fields === undefined ? -1 : fields.findIndex((f) => f.name === "message");
    if (fields === undefined || fieldIdx < 0) continue;
    const ft = fields[fieldIdx].type;
    if (ft.kind !== "externref" && ft.kind !== "anyref" && ft.kind !== "ref" && ft.kind !== "ref_null") continue;
    fnctorArms.push({
      typeIdx: structTypeIdx,
      fieldIdx,
      fieldIsExtern: ft.kind === "externref",
      prefixInstrs: nativeStringLiteralInstrs(ctx, `${structName}: `),
    });
  }
  const fnctorConcatIdx = fnctorArms.length === 0 ? undefined : ctx.nativeStrHelpers.get("__str_concat");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  const mod = ctx.mod;

  // (mut ref null $NativeString) — the prepared render buffer.
  const bufGlobalIdx = ctx.numImportGlobals + mod.globals.length;
  mod.globals.push({
    name: "__exn_render_buf",
    type: { kind: "ref_null", typeIdx: flatTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: flatTypeIdx }],
  });

  // __exn_render_prepare(payload: externref) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$exn_render_prepare_type");
    const funcIdx = mintDefinedFunc(ctx);
    // (#4394) The declined-fnctor arms run ahead of the generic chain; each is
    // self-contained and RETURNS, so a non-matching payload falls through to
    // the original tail unchanged. Local 1 holds the rendered message string.
    const fnctorArmInstrs: Instr[] = [];
    if (fnctorConcatIdx !== undefined && anyStrTypeIdx >= 0) {
      for (const arm of fnctorArms) {
        fnctorArmInstrs.push(
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: arm.typeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: arm.typeIdx },
              { op: "struct.get", typeIdx: arm.typeIdx, fieldIdx: arm.fieldIdx },
              ...(arm.fieldIsExtern ? ([{ op: "any.convert_extern" }] satisfies Instr[]) : []),
              { op: "call", funcIdx: anyToStrIdx },
              { op: "local.set", index: 1 },
              ...arm.prefixInstrs,
              { op: "local.get", index: 1 },
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: fnctorConcatIdx },
              { op: "call", funcIdx: flattenIdx },
              { op: "global.set", index: bufGlobalIdx },
              { op: "global.get", index: bufGlobalIdx },
              { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
              { op: "return" },
            ],
          },
        );
      }
    }
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },
      ...fnctorArmInstrs,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "call", funcIdx: anyToStrIdx },
      { op: "call", funcIdx: flattenIdx },
      { op: "global.set", index: bufGlobalIdx },
      { op: "global.get", index: bufGlobalIdx },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
    ];
    ctx.funcMap.set("__exn_render_prepare", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__exn_render_prepare",
      typeIdx,
      locals:
        fnctorArmInstrs.length > 0 && anyStrTypeIdx >= 0
          ? [{ name: "msg", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } }]
          : [],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({ name: "__exn_render_prepare", desc: { kind: "func", index: funcIdx } });
  }

  // __exn_render_char(i: i32) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }], "$exn_render_char_type");
    const funcIdx = mintDefinedFunc(ctx);
    const L_I = 0;
    const L_BUF = 1;
    const body: Instr[] = [
      { op: "global.get", index: bufGlobalIdx },
      { op: "local.tee", index: L_BUF },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // i < 0 || i >= len → 0
      { op: "local.get", index: L_I },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: L_I },
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // data[off + i]
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 2 }, // data
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 1 }, // off
      { op: "local.get", index: L_I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: dataTypeIdx },
    ];
    ctx.funcMap.set("__exn_render_char", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__exn_render_char",
      typeIdx,
      locals: [{ name: "buf", type: { kind: "ref_null", typeIdx: flatTypeIdx } }],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({ name: "__exn_render_char", desc: { kind: "func", index: funcIdx } });
  }
}

/**
 * (#3469) Mint the standalone host-free `console.log`/`print` output sink — the
 * in-module accumulator global (`__stdout_acc`, a `$AnyString` rope) plus the
 * `__stdout_append(s)` helper that concatenates onto it. Called in the pre-body
 * emission window (`src/codegen/index.ts`, alongside `emitDeferredWasiHelpers`)
 * so the append funcidx is stable for every `console.*` call site that bakes it,
 * and gated on `ctx.usesStandaloneConsoleSink` (set by `finalizeUnifiedCollector`
 * when the source uses `console.*` in standalone mode).
 *
 * Why this exists: on `--target standalone` there is no host `console_*` import
 * (deliberately, so #2961's import-leak gate stays green) and no `fd_write` sink
 * (unlike WASI). Before this, `console.log` lowered to a pure no-op (#3436), so
 * the test262 async completion marker (`$DONE → print → console.log(
 * "Test262:AsyncTestComplete")`) went nowhere and every host-free async test
 * timed out with `async completion marker not observed`. The sink records printed
 * output into a GC string the runner reads back via `__stdout_prepare`/
 * `__stdout_char` — 100% host-free (no import), mirroring `__exn_render_*`.
 *
 * Idempotent (guarded by `ctx.stdoutAccGlobalIdx >= 0`). No-op unless
 * standalone + native strings + `__str_concat` available.
 */
/**
 * (#3469) Name of the standalone stdout sink's append helper, as registered in
 * `ctx.funcMap`. Exported so the IR (#4462) resolves the SAME symbol the legacy
 * call site bakes, instead of re-spelling the string in a second place.
 */
export const STANDALONE_STDOUT_APPEND_FN = "__stdout_append";

/**
 * (#4462) Is the host-free console sink available in this lane? True only when
 * standalone native strings actually minted `__stdout_append`, which the pre-body
 * window does exactly when the source uses `console.*` (see
 * `ctx.usesStandaloneConsoleSink`). Read by BOTH the IR selector (may this unit
 * claim a `console.*` call?) and the IR builder (which lowering to emit), so the
 * claim and the lowering read one fact — the #2135 one-table rule applied to the
 * console surface.
 */
export function standaloneConsoleSinkAvailable(ctx: CodegenContext): boolean {
  return ctx.standalone && ctx.nativeStrings && ctx.funcMap.get(STANDALONE_STDOUT_APPEND_FN) !== undefined;
}

export function ensureStandaloneStdoutSink(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  if (!ctx.nativeStrings) return;
  if (ctx.stdoutAccGlobalIdx >= 0) return; // already minted

  // `__str_concat`(a: ref $AnyString, b: ref $AnyString) -> ref $AnyString is
  // emitted by ensureNativeStringHelpers (already run in the import-collection
  // finalize, long before the pre-body window). Ensure defensively — idempotent.
  ensureNativeStringHelpers(ctx);
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (concatIdx === undefined || anyStrTypeIdx < 0) return;

  const mod = ctx.mod;

  // (mut ref null $AnyString) — the accumulated output rope, null until first log.
  const accGlobalIdx = ctx.numImportGlobals + mod.globals.length;
  mod.globals.push({
    name: "__stdout_acc",
    type: { kind: "ref_null", typeIdx: anyStrTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: anyStrTypeIdx }],
  });
  ctx.stdoutAccGlobalIdx = accGlobalIdx;

  // __stdout_append(s: ref null $AnyString) -> void
  //   if (s == null) return;
  //   if (acc == null) { acc = s; return; }
  //   acc = __str_concat(acc, s);   // rope append, O(1) for long strings
  const typeIdx = addFuncType(ctx, [{ kind: "ref_null", typeIdx: anyStrTypeIdx }], [], "$stdout_append_type");
  const funcIdx = mintDefinedFunc(ctx);
  const body: Instr[] = [
    // if s is null → nothing to append
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    // if acc is null → acc = s (first line), done
    { op: "global.get", index: accGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "global.set", index: accGlobalIdx }, { op: "return" }],
    },
    // acc = __str_concat(acc, s) — both non-null here
    { op: "global.get", index: accGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: concatIdx },
    { op: "global.set", index: accGlobalIdx },
  ];
  ctx.funcMap.set("__stdout_append", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__stdout_append",
    typeIdx,
    locals: [],
    body,
    exported: false,
  } as WasmFunction);
}

/**
 * (#3469) Render a `console.log`/`print` argument (already compiled to the top of
 * the value stack with ValType `valType`) to a native `$AnyString` HOST-FREE and
 * append it to the standalone stdout sink. Dispatch is on the COMPILED ValType (a
 * wasm-lowering question — NOT the TS static type, which would trip the
 * oracle-ratchet gate AND be wrong here: the test262 marker reaches `console.log`
 * through `any`-typed harness params `$DONE → __consolePrintHandle__(msg) →
 * print(value) → console.log(value)`, so the arg is `any` → externref, not
 * string). Everything routes through `__any_to_string` (the native, IMPORT-FREE
 * stringifier the exn-render path uses) — NEVER emitToString's externref arm,
 * which would register the `__extern_toString` host import and trip #2961.
 *
 * Lives in native-strings.ts (the coercion-engine-sanctioned owner of
 * `__any_to_string`) so the #2108 coercion-drift gate does not count this as a
 * new hand-rolled coercion site outside the engine. Bare scalars (f64/i32/i64 — a
 * number/boolean passed directly, never a marker) are dropped best-effort.
 */
export function emitStandaloneStdoutAppendValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  valType: ValType | null,
): void {
  if (ctx.funcMap.get("__stdout_append") === undefined) {
    // Sink not minted — drop any pushed value to keep the stack balanced.
    if (valType !== null) fctx.body.push({ op: "drop" });
    return;
  }
  if (valType === null) return; // void arg — nothing was pushed
  if (valType.kind === "externref") {
    // externref is a separate hierarchy from anyref — convert first.
    fctx.body.push({ op: "any.convert_extern" });
  } else if (valType.kind !== "ref" && valType.kind !== "ref_null") {
    fctx.body.push({ op: "drop" }); // scalar — best-effort, never a marker
    return;
  }
  // Native `$AnyString` (literal/concat/template) or struct ref — both `anyref`
  // subtypes, rendered directly (strings pass through; objects → "[object Object]").
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  flushLateImportShifts(ctx, fctx);
  const toStrIdx = ctx.funcMap.get("__any_to_string") ?? anyToStrIdx;
  fctx.body.push({ op: "call", funcIdx: toStrIdx });
  // Re-read `__stdout_append` by name — `ensureAnyToStringHelper` above may have
  // inserted a late import that shifted every function index (#2642).
  const appendIdx = ctx.funcMap.get("__stdout_append");
  if (appendIdx !== undefined) fctx.body.push({ op: "call", funcIdx: appendIdx });
}

/**
 * (#3469) Emit the standalone stdout-sink readout exports —
 * `__stdout_prepare() -> i32` (flatten the accumulator, return code-unit length)
 * and `__stdout_char(i) -> i32` (code-unit readback) — mirroring the
 * `__exn_render_prepare`/`__exn_render_char` pattern. Called at finalize (see
 * `emitStdoutSinkExports` call in codegen/index.ts, right after
 * `emitExceptionRenderExports`). No-op unless the sink was minted
 * (`ctx.stdoutAccGlobalIdx >= 0`). Lets the runner read printed output with ZERO
 * host imports, so the test262 async completion marker is observable host-free.
 */
export function emitStdoutSinkExports(ctx: CodegenContext): void {
  if (ctx.stdoutAccGlobalIdx < 0) return; // sink never minted
  if (!ctx.nativeStrings) return;
  if (ctx.funcMap.has("__stdout_prepare")) return;

  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
  const flatTypeIdx = ctx.nativeStrTypeIdx;
  const dataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (flattenIdx === undefined || flatTypeIdx < 0 || dataTypeIdx < 0) return;

  const mod = ctx.mod;
  const accGlobalIdx = ctx.stdoutAccGlobalIdx;

  // (mut ref null $FlatString) — the flattened readout buffer (set by prepare).
  const flatGlobalIdx = ctx.numImportGlobals + mod.globals.length;
  mod.globals.push({
    name: "__stdout_flat",
    type: { kind: "ref_null", typeIdx: flatTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: flatTypeIdx }],
  });

  // __stdout_prepare() -> i32 : flatten acc → __stdout_flat, return len (0 if empty).
  {
    const typeIdx = addFuncType(ctx, [], [{ kind: "i32" }], "$stdout_prepare_type");
    const funcIdx = mintDefinedFunc(ctx);
    const body: Instr[] = [
      { op: "global.get", index: accGlobalIdx },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "global.get", index: accGlobalIdx },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: flattenIdx },
      { op: "global.set", index: flatGlobalIdx },
      { op: "global.get", index: flatGlobalIdx },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
    ];
    ctx.funcMap.set("__stdout_prepare", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__stdout_prepare",
      typeIdx,
      locals: [],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({ name: "__stdout_prepare", desc: { kind: "func", index: funcIdx } });
  }

  // __stdout_char(i: i32) -> i32 : code-unit readback from the prepared buffer.
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }], "$stdout_char_type");
    const funcIdx = mintDefinedFunc(ctx);
    const L_I = 0;
    const L_BUF = 1;
    const body: Instr[] = [
      { op: "global.get", index: flatGlobalIdx },
      { op: "local.tee", index: L_BUF },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // i < 0 || i >= len → 0
      { op: "local.get", index: L_I },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: L_I },
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // data[off + i]
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 2 }, // data
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 1 }, // off
      { op: "local.get", index: L_I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: dataTypeIdx },
    ];
    ctx.funcMap.set("__stdout_char", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__stdout_char",
      typeIdx,
      locals: [{ name: "buf", type: { kind: "ref_null", typeIdx: flatTypeIdx } }],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({ name: "__stdout_char", desc: { kind: "func", index: funcIdx } });
  }
}
