// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5148 cluster 3a) §20.1.3.6 steps 14-15 — the `Symbol.toStringTag` override
 * of `Object.prototype.toString`, under `--target standalone`.
 *
 * ## What was missing
 *
 * The tag was resolved entirely from the receiver's SHAPE: the #2501
 * compile-time classifier (`resolveObjectToStringTag`) for a statically known
 * receiver, the #4119/#4491 runtime classifier (`__opts_classify`) for one that
 * only lowers to an externref. Both answer the spec's `builtinTag` — steps 4-13
 * — and the module header of `object-proto-tostring.ts` records steps 14/15 as
 * a "deferred phase-2, needs dynamic @@toStringTag property lookup".
 *
 * So a receiver carrying its own `@@toStringTag` was answered by its shape:
 *
 * ```js
 * var custom = {};
 * custom[Symbol.toStringTag] = 'test262';
 * Object.prototype.toString.call(custom);   // was "[object Object]"
 * ```
 *
 * ## Why a separate native rather than another arm in the classifier
 *
 * Steps 14/15 sit ABOVE the whole builtinTag ladder: a `@@toStringTag` string
 * on a Date, a RegExp, an Error or a boxed Number overrides a tag the
 * compile-time fold resolved from a name it PROVED (`Date`, `RegExp`, …) and
 * therefore never routes through the runtime classifier at all. Folding the
 * lookup into `__opts_classify` would only reach the receivers the fold could
 * not classify — exactly the wrong half. This native is consulted FIRST by both
 * consumers instead, and declines (`ref.null extern`) whenever the property is
 * absent or is not a String, which is precisely step 15's condition.
 *
 * ## The lookup is a real `[[Get]]`
 *
 * `__extern_get` walks the prototype chain, runs an accessor and lets its
 * abrupt completion escape — all required by step 14 (`Get(O, @@toStringTag)`
 * is `?`-prefixed). The key is the interned well-known carrier
 * `__box_symbol(4)`; 4 is `Symbol.toStringTag`'s fixed id in the
 * `WELL_KNOWN_SYMBOLS` table (literals.ts), and `__box_symbol` interns by id, so
 * the carrier this native builds is the same one a
 * `custom[Symbol.toStringTag] = …` write stored.
 *
 * DECLINES to mint (returns `undefined`, leaving the module untouched) without
 * native strings, without the native Symbol provider, or when any dependency is
 * missing — the callers then keep their existing shape-only answer.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureSymbolCarrier, usesNativeSymbolProvider } from "./symbol-native.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import {
  OBJECT_PROTO_TOSTRING_CLASSIFY_FN,
  emitClassifierSelect,
  ensureObjectProtoToStringClassifierFn,
} from "./object-proto-tostring-native.js";
import type { ObjectToStringTagProof } from "./object-proto-tostring.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };

/** `ctx.funcMap` key for the minted step-14/15 helper. */
export const OBJECT_PROTO_SYMBOL_TAG_FN = "__opts_symbol_tag";

/** `Symbol.toStringTag`'s fixed well-known id (literals.ts `WELL_KNOWN_SYMBOLS`). */
const SYMBOL_TO_STRING_TAG_ID = 4;

/**
 * Mint (once per module) `__opts_symbol_tag(receiver externref) -> externref`:
 * `"[object " + tag + "]"` when `Get(receiver, @@toStringTag)` is a String, else
 * `ref.null extern` (declined — the caller keeps its builtinTag answer).
 */
export function ensureObjectProtoSymbolTagFn(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(OBJECT_PROTO_SYMBOL_TAG_FN);
  if (existing !== undefined) return existing;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return undefined;
  if (!usesNativeSymbolProvider(ctx)) return undefined;

  ensureObjectRuntime(ctx);
  ensureSymbolCarrier(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, null);

  const externGetIdx = ctx.funcMap.get("__extern_get");
  const boxSymbolIdx = ctx.funcMap.get("__box_symbol");
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (externGetIdx === undefined || boxSymbolIdx === undefined || concatIdx === undefined) return undefined;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  // param 0 = receiver ; local 1 = the @@toStringTag value
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "i32.const", value: SYMBOL_TO_STRING_TAG_ID },
    { op: "call", funcIdx: boxSymbolIdx },
    { op: "call", funcIdx: externGetIdx },
    { op: "local.tee", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      // step 19: "[object " + tag + "]".
      then: [
        ...nativeStringLiteralInstrs(ctx, "[object "),
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: concatIdx },
        ...nativeStringLiteralInstrs(ctx, "]"),
        { op: "call", funcIdx: concatIdx },
        { op: "extern.convert_any" },
      ],
      // step 18: a non-String tag leaves builtinTag in place — decline.
      else: [{ op: "ref.null.extern" }],
    },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF], "$__opts_symbol_tag_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(OBJECT_PROTO_SYMBOL_TAG_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: OBJECT_PROTO_SYMBOL_TAG_FN,
    typeIdx,
    locals: [{ name: "tag", type: EXTERNREF }],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * The `Object.prototype.toString.call(v)` fold's steps-14/15 arm.
 *
 * The override has to WRAP the whole builtinTag computation, not just its
 * unproven terminal: a `@@toStringTag` string beats a tag the #2501 fold PROVED
 * from a resolved name (`Date`, `RegExp`, `Error`, a boxed wrapper), and those
 * receivers never reach the runtime classifier at all. So this emits the
 * override first, banks the builtinTag answer (classifier-or-constant — the
 * composition `object-proto-tostring-native.ts` describes) into a local, and
 * selects between them.
 *
 * Returns `undefined` to DECLINE — non-standalone lanes, no receiver operand, or
 * an unavailable native — leaving the caller's existing arms untouched and
 * nothing in `fctx.body`. Returns `null` when the receiver expression itself
 * reported a compile error (operands are already emitted, so the caller must
 * propagate rather than fall through to a constant).
 */
export function emitObjectProtoToStringWithSymbolTag(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression | undefined,
  tag: string,
  proof: ObjectToStringTagProof,
): ValType | null | undefined {
  if (!ctx.standalone || !ctx.nativeStrings || receiverExpr === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);
  const symbolTagIdx = ensureObjectProtoSymbolTagFn(ctx);
  if (symbolTagIdx === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);

  const recvLocal = allocLocal(fctx, `__opts_recv_${fctx.locals.length}`, EXTERNREF);
  const recvResult = compileExpression(ctx, fctx, receiverExpr, EXTERNREF);
  if (recvResult === null) return null;
  if (recvResult.kind !== "externref") coerceType(ctx, fctx, recvResult, EXTERNREF);
  fctx.body.push({ op: "local.set", index: recvLocal });

  const symTagLocal = allocLocal(fctx, `__opts_symtag_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(OBJECT_PROTO_SYMBOL_TAG_FN) ?? symbolTagIdx });
  fctx.body.push({ op: "local.set", index: symTagLocal });

  const builtinLocal = allocLocal(fctx, `__opts_builtin_${fctx.locals.length}`, EXTERNREF);
  let banked = false;
  if (proof.unprovenDefault) {
    const classifyIdx = ensureObjectProtoToStringClassifierFn(ctx);
    if (classifyIdx !== undefined) {
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "local.get", index: recvLocal });
      emitClassifierSelect(ctx, fctx, ctx.funcMap.get(OBJECT_PROTO_TOSTRING_CLASSIFY_FN) ?? classifyIdx, tag);
      fctx.body.push({ op: "local.set", index: builtinLocal });
      banked = true;
    }
  }
  if (!banked) {
    const builtinStr = `[object ${tag}]`;
    addStringConstantGlobal(ctx, builtinStr);
    for (const instr of stringConstantExternrefInstrs(ctx, builtinStr)) fctx.body.push(instr);
    fctx.body.push({ op: "local.set", index: builtinLocal });
  }

  fctx.body.push({ op: "local.get", index: symTagLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: [{ op: "local.get", index: builtinLocal }],
    else: [{ op: "local.get", index: symTagLocal }],
  });
  return EXTERNREF;
}
