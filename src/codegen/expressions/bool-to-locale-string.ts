// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771 S6) `toLocaleString`'s ELEMENT step on a BOOLEAN — §23.1.3.32 step
 * 6.c.i `ToString(? Invoke(element, "toLocaleString"))` — `--target standalone`.
 *
 * The Boolean twin of #6651 TA1's `__num_to_locale_string`
 * (to-locale-string-element.ts, whose header records the design). The native
 * join fold's #2105 boolean arm renders `"true"`/`"false"` directly, so a
 * module that REPLACES `Boolean.prototype.toString` — data or accessor —
 * never saw its override (`toLocaleString/primitive_this_value{,_getter}.js`,
 * strict: the override must see the PRIMITIVE `this`, `typeof this ===
 * "boolean"`).
 *
 * `__bool_to_locale_string(i32) -> externref`, filled at finalize:
 *
 *   box = __box_boolean(b)
 *   if BooleanCompanion has "toLocaleString":            // Boolean.prototype's own
 *     m = [[Get]](box, "toLocaleString"); if m: return ToString(Call(m, box))
 *   if BooleanCompanion has "toString":                  // §20.1.3.5 Invoke(O, "toString")
 *     m = [[Get]](box, "toString");       if m: return ToString(Call(m, box))
 *   return b ? "true" : "false"
 *
 * The `[[Get]]` is the receiver-aware companion read, so an ACCESSOR's getter
 * runs with the boxed primitive as `this` (the `_getter` row). Absent-not-wrong:
 * a miss renders natively. Reserved only when the source overrides
 * `Boolean.prototype.toString` / `.toLocaleString` (a pre-scan fact), so every
 * other module keeps its bytes.
 */
import { ts } from "../../ts-api.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import type { Instr, ValType } from "../../ir/types.js";
import { protoIndexBrandCompanionHasInstrs, sourceOverridesBuiltinPrototypeMember } from "../helpers/core-delegates.js"; // (#6797) late-bound core
import { builtinBrandOffsetOf } from "../builtin-brands.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";
import { nativeStringLiteralInstrs } from "../native-string-literals.js";
import { protoIndexRecvGetMissInstrs } from "../proto-index-read-bindings.js";
import { makeHelperFctx, reservePlaceholder, reservedFunc, TO_STRING } from "../helpers/reserved-helper-funcs.js";

export const BOOL_TO_LOCALE_STRING = "__bool_to_locale_string";
/** The `bool.toString()` twin: consults only `"toString"`. */
const BOOL_TO_STRING_INVOKE = "__bool_to_string_invoke";
const EXTERNREF: ValType = { kind: "externref" };

/** Helper name → the Boolean-companion keys it consults, in order. */
const HELPER_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  [BOOL_TO_LOCALE_STRING, ["toLocaleString", "toString"]],
  [BOOL_TO_STRING_INVOKE, ["toString"]],
]);

const reserved = new WeakMap<CodegenContext, Set<string>>();

/**
 * Reserve the helper for a boolean receiver's `toString()` / `toLocaleString()`
 * call (`call-receiver-method.ts`), or `undefined` to keep the native fold.
 */
export function reserveBoolMethodString(
  ctx: CodegenContext,
  callerFctx: FunctionContext,
  anchor: ts.Node,
  method: string,
): number | undefined {
  if (method === "toLocaleString") return reserveBoolToLocaleString(ctx, callerFctx, anchor);
  return method === "toString" ? reserveHelper(ctx, callerFctx, anchor, BOOL_TO_STRING_INVOKE) : undefined;
}

/** Reserve the helper for the join fold's boolean arm, or `undefined` to keep the native literals. */
export function reserveBoolToLocaleString(
  ctx: CodegenContext,
  callerFctx: FunctionContext,
  anchor: ts.Node,
): number | undefined {
  return reserveHelper(ctx, callerFctx, anchor, BOOL_TO_LOCALE_STRING);
}

function reserveHelper(
  ctx: CodegenContext,
  callerFctx: FunctionContext,
  anchor: ts.Node,
  helper: string,
): number | undefined {
  if (!ctx.standalone || ctx.protoNamedDirty !== true || builtinBrandOffsetOf("Boolean") === undefined) {
    return undefined;
  }
  if (
    !sourceOverridesBuiltinPrototypeMember(anchor, "Boolean", "toString") &&
    !sourceOverridesBuiltinPrototypeMember(anchor, "Boolean", "toLocaleString")
  ) {
    return undefined;
  }
  const existing = ctx.funcMap.get(helper);
  if (existing !== undefined) return existing;
  ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [EXTERNREF]);
  ensureLateImport(ctx, "__apply_closure", [EXTERNREF, EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, TO_STRING, [EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, callerFctx);
  if (ctx.funcMap.get("__box_boolean") === undefined) return undefined;
  const funcIdx = reservePlaceholder(ctx, helper, [{ kind: "i32" }], `$${helper}_type`);
  const set = reserved.get(ctx) ?? new Set<string>();
  set.add(helper);
  reserved.set(ctx, set);
  return funcIdx;
}

/** One companion consult: `if (Boolean companion has key) { m = Get(box, key); if m return ToString(Call(m, box)) }`. */
function consultArm(ctx: CodegenContext, fctx: FunctionContext, brandOff: number, key: string, box: number): Instr[] {
  const applyIdx = ctx.funcMap.get("__apply_closure");
  const toStrIdx = ctx.funcMap.get(TO_STRING);
  if (applyIdx === undefined || toStrIdx === undefined) return [];
  const companion = allocLocal(fctx, `__btl_comp_${key}`, EXTERNREF);
  const has = protoIndexBrandCompanionHasInstrs(ctx, brandOff, key, companion);
  const keyLocal = allocLocal(fctx, `__btl_key_${key}`, EXTERNREF);
  const method = allocLocal(fctx, `__btl_m_${key}`, EXTERNREF);
  const get = protoIndexRecvGetMissInstrs(ctx, box, keyLocal);
  if (has === undefined || get === undefined) return [];
  const nullishToNull = ctx.funcMap.get("__nullish_to_null");
  return [
    ...has,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...nativeStringLiteralInstrs(ctx, key),
        { op: "extern.convert_any" },
        { op: "local.set", index: keyLocal },
        ...get,
        ...(nullishToNull !== undefined ? ([{ op: "call", funcIdx: nullishToNull }] satisfies Instr[]) : []),
        { op: "local.tee", index: method },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [
            { op: "local.get", index: method },
            { op: "local.get", index: box },
            { op: "ref.null.extern" }, // zero arguments
            { op: "call", funcIdx: applyIdx },
            { op: "call", funcIdx: toStrIdx },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

const PRIMITIVE_WRAPPER_TYPES: ReadonlySet<string> = new Set(["Boolean", "Number", "String", "Symbol", "BigInt"]);

/**
 * (#6771 S6) `typeof this` in STRICT code whose `this` TypeScript types as a
 * primitive wrapper interface — the contextual `this` of a function assigned
 * to `Boolean.prototype.toString` — must not fold to `"object"`: §10.2.1.2
 * OrdinaryCallBindThis leaves a strict callee's `this` UNBOXED, so it is the
 * primitive (`primitive_this_value.js` expects `"boolean"`). Standalone only;
 * `"use strict"` prologue / class context only (module-goal strictness is not
 * inferred), so sloppy code keeps its fold.
 */
export function strictThisMayBePrimitive(ctx: CodegenContext, operand: ts.Expression, thisType: ts.Type): boolean {
  if (!ctx.standalone || operand.kind !== ts.SyntaxKind.ThisKeyword) return false;
  const name = thisType.getSymbol()?.getName();
  return name !== undefined && PRIMITIVE_WRAPPER_TYPES.has(name) && isStrictContext(operand, false);
}

/** Fill every reserved helper (see the header). */
export function fillBoolToLocaleString(ctx: CodegenContext): void {
  for (const helper of reserved.get(ctx) ?? []) fillHelper(ctx, helper);
}

function fillHelper(ctx: CodegenContext, helper: string): void {
  const fn = reservedFunc(ctx, helper);
  const boxIdx = ctx.funcMap.get("__box_boolean");
  const brandOff = builtinBrandOffsetOf("Boolean");
  if (fn === undefined || boxIdx === undefined || brandOff === undefined) return;
  const fctx = makeHelperFctx(helper, "b", { kind: "i32" });
  const box = allocLocal(fctx, "__btl_box", EXTERNREF);
  const native: Instr[] = [
    { op: "local.get", index: 0 },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [...nativeStringLiteralInstrs(ctx, "true"), { op: "extern.convert_any" }],
      else: [...nativeStringLiteralInstrs(ctx, "false"), { op: "extern.convert_any" }],
    },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: boxIdx },
    { op: "local.set", index: box },
    ...(HELPER_KEYS.get(helper) ?? []).flatMap((key) => consultArm(ctx, fctx, brandOff, key, box)),
    ...native,
  ];
  fn.locals = fctx.locals;
  fn.body = body;
}
