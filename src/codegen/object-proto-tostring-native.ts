// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-7) Make the §20.1.3.6 RUNTIME classifier reachable from the
 * SYNTACTIC `Object.prototype.toString.call(v)` form in standalone.
 *
 * ## What was broken — measured, standalone, on the campaign base
 *
 * The class tag has two lowerings and only one of them can see a runtime value:
 *
 * | spelling                                   | owner                                   |
 * | ------------------------------------------ | --------------------------------------- |
 * | `Object.prototype.toString.call(v)`        | the #2501 compile-time fold             |
 * | `x.getClass = Object.prototype.toString; x.getClass()` | the #4119 runtime classifier |
 *
 * The fold ends its ladder with a standalone-only `deferOrStandalone("Object")`
 * for any receiver whose static type merely lowers to a ref/externref. Under
 * `allowJs` that is **every `any`** — a parameter, a `this` inside a JS
 * callback, an `Object.getPrototypeOf(...)` result — so the module baked the
 * constant `"[object Object]"` and no runtime check ever ran:
 *
 * ```js
 * var t = function (v) { return Object.prototype.toString.call(v); };
 * t({});  t([1,2]);  t(function(){});  t(new Date(0));  t(new String("a"));
 * t(null); t(undefined); t(1); t("s"); t(true); t(Math); t(JSON);
 * //  → "[object Object]" for ALL TWELVE
 * ```
 *
 * while the SAME question asked with a syntactically-visible operand answered
 * correctly. One module, one value, two answers — and the wrong one is silent,
 * which this campaign prices as worse than a refusal.
 *
 * ## The fix, and why it is not "route everything to the classifier"
 *
 * The classifier is deliberately partial: its fallthrough is a loud
 * `TypeError` refusal, and #4119's own record shows what happens when a
 * refusing body wins a form the fold used to own — 27 passing rows became
 * refusals. So the arms compose the other way round:
 *
 *   runtime answer if the classifier can PROVE one, else the fold's constant.
 *
 * `__opts_classify(externref) -> externref` is the same emitter the reflective
 * closure uses ({@link emitObjectProtoToStringClassifier}, reading its receiver
 * from param 0 instead of the closure's param 1) with a **`ref.null extern`
 * decline tail** instead of the refusal. Null is unambiguous as "declined":
 * every real answer is a non-null `$NativeString`, and the `[object Null]`
 * receiver returns the STRING `"[object Null]"`, not null.
 *
 * That makes the change monotone. Every receiver the classifier proves gets a
 * right answer where it previously got a constant; every receiver it cannot
 * prove keeps the exact byte-for-byte answer it has today. Nothing that passes
 * can start refusing, because this path never reaches the refusal.
 *
 * ## Scope
 *
 * Standalone/native-strings only, and only for the fold's UNPROVEN terminal
 * (`ObjectToStringTagProof.unprovenDefault`). A tag the fold derived from a
 * resolved symbol name — `Date`, `RegExp`, `Error`, `IArguments`, a typed
 * array, `Math`, `JSON` — is *more* precise than the classifier can be from a
 * bare externref (those carriers are nominal structs it refuses), so those keep
 * the constant. This is the same precedence #4119's interception note in
 * `expressions/calls.ts` describes, applied one level finer: the fold wins where
 * it KNOWS, the runtime wins where the fold was guessing.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitObjectProtoToStringClassifier } from "./object-proto-tostring.js";
import {
  ITER_FAMILY_ARRAY,
  ITER_FAMILY_MAP,
  ITER_FAMILY_SET,
  ITER_FAMILY_STRING,
  ITER_REC_FAMILY_FIELD,
} from "./iterator-native.js";

/** `ctx.funcMap` key for the minted classifier. */
export const OBJECT_PROTO_TOSTRING_CLASSIFY_FN = "__opts_classify";

/**
 * Finalize the function-constructor-instance arms of the shared Object tag
 * classifier.  Fnctor structs are reserved before the body pass, but native
 * prototype closures (and the classifier helper itself) can be probed during
 * the earlier pass, before the dynamic-object carrier gate has published all
 * `$__fnctor_<Name>` indices.  Re-emitting the classifier there would shift
 * no function indices and would still leave the already-minted closures stale,
 * so splice the late nominal tests into both existing consumers in place.
 */
export function fillStandaloneObjectProtoToStringFnctorArms(ctx: CodegenContext): void {
  if (!ctx.nativeStrings) return;

  const fnctors = [
    ...new Set([
      ...ctx.fnctorReservedTypeIdx.values(),
      ...[...ctx.structMap.entries()]
        .filter(([name]) => name.startsWith("__fnctor_") && !name.endsWith("__cold"))
        .map(([, typeIdx]) => typeIdx),
    ]),
  ];
  if (fnctors.length === 0) return;
  const objectTag = (): Instr[] => {
    addStringConstantGlobal(ctx, "[object Object]");
    return [...stringConstantExternrefInstrs(ctx, "[object Object]"), { op: "return" }];
  };
  const fnByName = (name: string): WasmFunction | undefined =>
    ctx.mod.functions.find((f) => (f as { name?: string }).name === name) as WasmFunction | undefined;

  const appendMissingArms = (fn: WasmFunction | undefined, receiverIndex: number, insertAt: number): void => {
    if (!fn || insertAt < 0 || insertAt > fn.body.length) return;
    const existing = new Set(
      fn.body
        .filter((instr): instr is Extract<Instr, { op: "ref.test" }> => instr.op === "ref.test")
        .map((instr) => instr.typeIdx),
    );
    const arms: Instr[] = [];
    for (const typeIdx of fnctors) {
      if (existing.has(typeIdx)) continue;
      arms.push(
        { op: "local.get", index: receiverIndex },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: objectTag() },
      );
    }
    if (arms.length > 0) fn.body.splice(insertAt, 0, ...arms);
  };

  // The decline form ends in `ref.null extern`.
  const classifier = fnByName(OBJECT_PROTO_TOSTRING_CLASSIFY_FN);
  if (classifier?.body.at(-1)?.op === "ref.null.extern") {
    appendMissingArms(classifier, 0, classifier.body.length - 1);
  }

  // The reflective native closure ends in the catchable TypeError sequence
  // emitted by `emitObjectProtoOrRefusal`: global.get / extern.convert_any /
  // call / throw.  Keep the new arms ahead of that sequence so an ordinary
  // fnctor instance returns its tag instead of reaching the refusal.
  const objectToString = fnByName(`__proto_method_${BUILTIN_BRAND_TABLE.Object}_toString`);
  if (objectToString) {
    const b = objectToString.body;
    const n = b.length;
    const refusalStart =
      n >= 4 &&
      b[n - 1]?.op === "throw" &&
      b[n - 2]?.op === "call" &&
      b[n - 3]?.op === "extern.convert_any" &&
      b[n - 4]?.op === "global.get"
        ? n - 4
        : -1;
    appendMissingArms(objectToString, 1, refusalStart);
  }
}

/**
 * (#6484 S3 round 2, re-implemented on the S1+S2 merge) Give a `$__IterRec`
 * receiver its §20.1.3.6 class tag instead of letting it reach the refusal tail.
 *
 * ## The regression this closes
 *
 * S1+S2's carrier migration made EVERY array-typed `@@iterator` receiver answer
 * a live `$__IterRec` instead of a snapshot `$Vec`. The classifier recognises a
 * snapshot vec (`ref.test $__vec_base` → `[object Array]`) but had no arm for the
 * record, so control fell through to the refusal tail and a value turned into a
 * throw. Measured standalone, `Object.prototype.toString.call(<any-typed it>)`:
 *
 * | receiver                  | base `66405a1244` | before this fn | here                      |
 * | ------------------------- | ----------------- | -------------- | ------------------------- |
 * | `new Int8Array([1,2])[@@iterator]()` | `[object Array]` | **THREW** | `[object Array Iterator]` |
 * | `[1,2,3][@@iterator]()`   | `[object Array]`  | **THREW**      | `[object Array Iterator]` |
 * | `"ab"[@@iterator]()`      | THREW             | THREW          | `[object String Iterator]`|
 * | `m.keys()`                | THREW             | THREW          | `[object Map Iterator]`   |
 *
 * The first two rows are the regression (value → throw); the last two were
 * already refusing on base and are closed here for free by the same field.
 *
 * ## Why `family`, not `kind`
 *
 * The tag is read off the record's [[Prototype]] intrinsic, and `ITER_KIND_*`
 * names the CARRIER, not the family: an array iterator and a string iterator are
 * both `ITER_KIND_VEC`. S1's `family` field is exactly the missing distinction,
 * so this arm reports `String Iterator` for a string iterator rather than
 * inheriting the documented kind-VEC residual. `ITER_FAMILY_UNKNOWN` emits no
 * arm and DECLINES — a record whose family no site stamped (a generator frame, a
 * user iterator) keeps the answer it has today, so nothing that passes can start
 * refusing.
 *
 * ## Why a FINALIZE splice and not an inline arm
 *
 * `$__IterRec` is registered lazily at the first iteration site, which may be
 * compiled AFTER the classifier body is baked — measured: in a module whose
 * `Object.prototype.toString` site precedes its iteration,
 * `ctx.structMap.get("__IterRec")` is `undefined` at classifier-emit time and an
 * inline arm silently emits nothing. This is the same hazard the
 * `reserveArgumentsLengthBrand` note above records. Splicing at finalize sees the
 * final type space.
 *
 * ## THREE consumers carry the classifier chain, not two
 *
 * The one that actually answers `Object.prototype.toString.call(v)` for an `any`
 * `v` — the whole test262 surface — is `__object_proto_to_string_runtime`, and in
 * a module that only uses that spelling the other two are ABSENT. Patching only
 * the pair {@link fillStandaloneObjectProtoToStringFnctorArms} knows about would
 * change nothing observable.
 *
 * Idempotent per consumer (a body already carrying a `ref.test` on the record's
 * type is skipped) and fresh `Instr` objects per consumer (#2169b).
 */
export function fillIterRecObjectProtoToStringArms(ctx: CodegenContext): void {
  if (!ctx.nativeStrings) return;
  // No registration here: a module that never built an iterator record cannot
  // receive one, and minting the struct purely to emit dead arms would churn the
  // type index space (the `$__vec_base` discipline in the classifier).
  const iterRecTypeIdx = ctx.structMap.get("__IterRec");
  if (iterRecTypeIdx === undefined) return;

  // §20.1.3.6 step 15 reads @@toStringTag off the iterator's prototype
  // intrinsic; these are those four values. UNKNOWN is deliberately absent.
  const familyTags: ReadonlyArray<readonly [number, string]> = [
    [ITER_FAMILY_ARRAY, "[object Array Iterator]"],
    [ITER_FAMILY_MAP, "[object Map Iterator]"],
    [ITER_FAMILY_SET, "[object Set Iterator]"],
    [ITER_FAMILY_STRING, "[object String Iterator]"],
  ];
  for (const [, tag] of familyTags) addStringConstantGlobal(ctx, tag);

  // Re-read the field per family rather than allocating a scratch local: these
  // bodies are already minted, so appending a local would mean recomputing every
  // index against each consumer's own param count. The classifier's own
  // `typedArrayKindArms` ladder re-reads the same way.
  const buildArms = (receiverIndex: number): Instr[] => {
    const ladder: Instr[] = [];
    for (const [family, tag] of familyTags) {
      ladder.push(
        { op: "local.get", index: receiverIndex },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: iterRecTypeIdx },
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: ITER_REC_FAMILY_FIELD },
        { op: "i32.const", value: family },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, tag), { op: "return" }],
        },
      );
    }
    return [
      { op: "local.get", index: receiverIndex },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: iterRecTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: ladder },
    ];
  };

  const fnByName = (name: string): WasmFunction | undefined =>
    ctx.mod.functions.find((f) => (f as { name?: string }).name === name) as WasmFunction | undefined;

  /** Index of the terminal refusal/decline, or -1 when the tail is unrecognised. */
  const tailStart = (fn: WasmFunction): number => {
    const b = fn.body;
    const n = b.length;
    // `__opts_classify` declines with a bare `ref.null extern`.
    if (b[n - 1]?.op === "ref.null.extern") return n - 1;
    // The refusing consumers end in `buildThrowJsErrorInstrs`' terminal sequence.
    if (
      n >= 4 &&
      b[n - 1]?.op === "throw" &&
      b[n - 2]?.op === "call" &&
      b[n - 3]?.op === "extern.convert_any" &&
      b[n - 4]?.op === "global.get"
    ) {
      return n - 4;
    }
    return -1;
  };

  const splice = (fn: WasmFunction | undefined, receiverIndex: number): void => {
    if (!fn) return;
    const already = fn.body.some((instr) => instr.op === "ref.test" && instr.typeIdx === iterRecTypeIdx);
    if (already) return;
    const at = tailStart(fn);
    if (at < 0) return;
    fn.body.splice(at, 0, ...buildArms(receiverIndex));
  };

  // Receiver locals differ per ABI: the minted helper's only param IS the
  // receiver (0); the reflective closure and the direct runtime helper both
  // carry a leading self/unused param and read local 1.
  splice(fnByName(OBJECT_PROTO_TOSTRING_CLASSIFY_FN), 0);
  splice(fnByName("__object_proto_to_string_runtime"), 1);
  splice(fnByName(`__proto_method_${BUILTIN_BRAND_TABLE.Object}_toString`), 1);
}

/**
 * Mint (once per module) `__opts_classify(receiver externref) -> externref`.
 *
 * Returns the funcIdx, or `undefined` when the module lacks the substrate the
 * classifier needs (no native strings — the same condition
 * {@link emitObjectProtoToStringClassifier} reports by returning `false`). An
 * `undefined` return must leave the caller's body and the module untouched, so
 * the reserved handle is only published on the success path.
 */
export function ensureObjectProtoToStringClassifierFn(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(OBJECT_PROTO_TOSTRING_CLASSIFY_FN);
  if (existing !== undefined) return existing;
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return undefined;

  // A synthetic FunctionContext whose ONLY parameter is the receiver. The
  // classifier allocates its own scratch locals through `allocLocal`, which
  // needs nothing beyond `params`/`locals`/`localMap`; the rest of the shape is
  // the standard native-body context (see `makeNativeClosureFctx`).
  const fctx: FunctionContext = {
    name: OBJECT_PROTO_TOSTRING_CLASSIFY_FN,
    params: [{ name: "__recv", type: { kind: "externref" } }],
    locals: [],
    localMap: new Map([["__recv", 0]]),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  if (!emitObjectProtoToStringClassifier(ctx, fctx, 0)) return undefined;

  // The decline tail. Every arm above `return`s a tag string, so control only
  // reaches here for a receiver the classifier could not prove.
  fctx.body.push({ op: "ref.null.extern" });

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$__opts_classify_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(OBJECT_PROTO_TOSTRING_CLASSIFY_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: OBJECT_PROTO_TOSTRING_CLASSIFY_FN,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Emit `classify(<receiver already on the stack>) ?? "[object <fallbackTag>]"`.
 *
 * Stack contract: the caller has pushed the receiver as an `externref`; on
 * return exactly one `externref` (the tag string) is on the stack.
 */
export function emitClassifierSelect(
  ctx: CodegenContext,
  fctx: FunctionContext,
  classifyFuncIdx: number,
  fallbackTag: string,
): ValType {
  const resultLocal = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name: `__opts_tag_${resultLocal}`, type: { kind: "externref" } });

  const fallback = `[object ${fallbackTag}]`;
  addStringConstantGlobal(ctx, fallback);

  fctx.body.push(
    { op: "call", funcIdx: classifyFuncIdx },
    { op: "local.tee", index: resultLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [...stringConstantExternrefInstrs(ctx, fallback)],
      else: [{ op: "local.get", index: resultLocal }],
    },
  );
  return { kind: "externref" };
}
