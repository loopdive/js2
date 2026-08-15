// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4445) Native body for a reflective `String.prototype.<html-wrapper>` closure
 * — the 13 Annex B §B.2.3 methods (`anchor`, `big`, `blink`, `bold`, `fixed`,
 * `fontcolor`, `fontsize`, `italics`, `link`, `small`, `strike`, `sub`, `sup`).
 *
 * The DIRECT `"x".anchor(n)` call never reaches here: #3069 already lowers it in
 * `string-ops.ts` from the same {@link htmlWrapperFor} table. What was missing
 * is the VALUE-ERASED shape — `String.prototype.anchor.call(thisArg, v)` and
 * `obj.anchor = String.prototype.anchor; obj.anchor(v)` — which resolves through
 * the reflective proto-closure path and hit `emitProtoMemberBodyRefusal`, so
 * every `B.2.3.N.js` (whose last assertions are `.call` forms) and every
 * `this-val-tostring-err.js` failed while the direct assertions in the same file
 * passed.
 *
 * Closure ABI: `this` = param 1 (externref); the attribute VALUE = param 2, and
 * ONLY for the four methods that carry an attribute (the other nine are arity 0,
 * so their closure has no param-2 slot — reading it would emit invalid Wasm).
 *
 * §B.2.3.2.1 CreateHTML, in order:
 *   1. `? RequireObjectCoercible(string)`
 *   2. `S = ? ToString(str)`                       ← before the value coercion
 *   4.b `V = ? ToString(value)`, `"` → `&quot;`    ← `__str_html_escape_quot`
 *   5-9 `"<" tag [" " attr '="' V '"'] ">" S "</" tag ">"`
 * The step-2-before-step-4.b order is observable and is what
 * `this-val-tostring-err.js` (abrupt receiver `toString`) pins down.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { htmlWrapperFor } from "./html-wrapper-native.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { ensureAnyToStringHelper, ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
import { emitStringProtoToStringFlat } from "./string-proto-tostring.js";

export function emitStringHtmlWrapperMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
  emitRequireObjectCoercible: () => void,
): ValType | null {
  const wrapper = htmlWrapperFor(member);
  if (wrapper === undefined) return null;

  // This body adds NO late imports of its own (no numeric box/unbox — every
  // operand and the result are strings), so there is nothing to over-shift; the
  // helper funcIdxs are fetched by NAME after `ensureNativeStringHelpers`, which
  // flushes any pending import batch on entry. Same discipline as the trim body.
  ensureNativeStringHelpers(ctx);
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const escapeIdx = ctx.nativeStrHelpers.get("__str_html_escape_quot");
  if (concatIdx === undefined || flattenIdx === undefined || escapeIdx === undefined || ctx.anyStrTypeIdx < 0) {
    return null; // host/gc lowering — the caller falls back to its refusal
  }

  const { tag, attribute } = wrapper;
  // The glue sizes the four attribute methods to arity 1, so param 2 exists for
  // exactly those (`fctx.params` is `[self, this, …args]`). The tag SHAPE is
  // decided by `attribute` alone, never by the slot count — a missing slot means
  // "the value is undefined", not "drop the attribute".
  const hasAttrSlot = fctx.params.length > 2;

  // (1) ? RequireObjectCoercible(this).
  emitRequireObjectCoercible();

  // (2) S = ? ToString(this) — emitted BEFORE the value coercion below so an
  // abrupt receiver `toString` wins over an abrupt attribute `toString`.
  const strTy = nativeStringType(ctx);
  emitStringProtoToStringFlat(ctx, fctx, 1, anyToStrIdx, flattenIdx);
  const sLocal = allocLocal(fctx, `__str_html_s_${fctx.locals.length}`, strTy);
  fctx.body.push({ op: "local.set", index: sLocal });

  // (3) prefix = `<tag>` or `<tag attribute="` + escapeQuot(? ToString(value)) + `">`.
  if (attribute === undefined) {
    fctx.body.push(...nativeStringLiteralInstrs(ctx, `<${tag}>`));
  } else {
    const vLocal = allocLocal(fctx, `__str_html_v_${fctx.locals.length}`, strTy);
    if (hasAttrSlot) {
      // An ABSENT arg arrives as a null pad. Unlike `concat`'s step-3 skip,
      // CreateHTML step 4.b coerces the (undefined) value regardless, so the pad
      // must stringify to "undefined" rather than reach `$__any_to_string`.
      const coerced: Instr[] = [];
      const saved = fctx.body;
      fctx.body = coerced;
      emitStringProtoToStringFlat(ctx, fctx, 2, anyToStrIdx, flattenIdx);
      fctx.body = saved;
      coerced.push({ op: "local.set", index: vLocal });
      fctx.body.push(
        { op: "local.get", index: 2 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...nativeStringLiteralInstrs(ctx, "undefined"), { op: "local.set", index: vLocal }],
          else: coerced,
        },
      );
    } else {
      fctx.body.push(...nativeStringLiteralInstrs(ctx, "undefined"), { op: "local.set", index: vLocal });
    }
    fctx.body.push(...nativeStringLiteralInstrs(ctx, `<${tag} ${attribute}="`));
    fctx.body.push({ op: "local.get", index: vLocal });
    fctx.body.push({ op: "call", funcIdx: escapeIdx });
    fctx.body.push({ op: "call", funcIdx: concatIdx });
    fctx.body.push(...nativeStringLiteralInstrs(ctx, `">`));
    fctx.body.push({ op: "call", funcIdx: concatIdx });
  }

  // (4) prefix + S + `</tag>` → externref (the uniform closure result type).
  fctx.body.push({ op: "local.get", index: sLocal });
  fctx.body.push({ op: "call", funcIdx: concatIdx });
  fctx.body.push(...nativeStringLiteralInstrs(ctx, `</${tag}>`));
  fctx.body.push({ op: "call", funcIdx: concatIdx });
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}
