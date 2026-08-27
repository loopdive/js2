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
