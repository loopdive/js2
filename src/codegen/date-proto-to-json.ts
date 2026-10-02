// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6775 S8) Native body for `Date.prototype.toJSON` (§21.4.4.37) under
 * `--target standalone`. The method is intentionally generic — it never
 * requires a Date receiver:
 *
 *   1. `O = ? ToObject(this)` — `undefined` / `null` throw a TypeError.
 *   2. `tv = ? ToPrimitive(O, number)`.
 *   3. If `tv` is a Number and not finite, return `null`.
 *   4. `return ? Invoke(O, "toISOString")`.
 *
 * Before this the member refused ("not yet implemented"), so every reflective
 * spelling — `Date.prototype.toJSON.call(x)`, `var f = …; f.call(x)` — threw.
 * Step 2 is the coercion engine's ToPrimitive provider (an exotic `@@toPrimitive`
 * runs with hint "number"; a primitive passes through). Step 4 reads the
 * method with `__extern_get`, which walks a primitive's wrapper prototype
 * (`Number.prototype.toISOString` in `to-object.js`), and calls it through
 * the open-`any` apply bridge with the receiver as `this`.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureSymbolCarrier } from "./symbol-native.js";
import { linkSymbolWrapperPrototype } from "./expressions/calls-guards.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { ensureExternrefToNumberProvider, getToPrimitiveProvider } from "./coercion-engine.js";

const EXTERNREF: ValType = { kind: "externref" };

/** Emit the closure body (param 1 = `this`). `null` refuses when helpers are missing. */
export function emitDateProtoToJsonBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone) return null;
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__typeof_number", [EXTERNREF], [{ kind: "i32" }]);
  reserveApplyClosure(ctx);
  ensureObjVecBuilders(ctx);
  ensureSymbolCarrier(ctx);
  ensureLateImport(ctx, "__new_Symbol", [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__object_setPrototypeOf", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const idx = (name: string): number | undefined => ctx.funcMap.get(name);
  const toPrimitiveIdx = getToPrimitiveProvider(ctx);
  const externGetIdx = idx("__extern_get");
  const isUndefIdx = idx("__extern_is_undefined");
  const typeofNumberIdx = idx("__typeof_number");
  const unboxNumberIdx = ensureExternrefToNumberProvider(ctx, fctx);
  const applyIdx = idx("__apply_closure");
  const vecNewIdx = idx("__objvec_new");
  if (
    toPrimitiveIdx === undefined ||
    externGetIdx === undefined ||
    isUndefIdx === undefined ||
    typeofNumberIdx === undefined ||
    unboxNumberIdx === undefined ||
    applyIdx === undefined ||
    vecNewIdx === undefined
  ) {
    return null;
  }
  const tv = allocLocal(fctx, `__dtj_tv_${fctx.locals.length}`, EXTERNREF);
  const num = allocLocal(fctx, `__dtj_num_${fctx.locals.length}`, { kind: "f64" });
  const nullishThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, nullishThrow, "Date.prototype.toJSON called on null or undefined");
  addStringConstantGlobal(ctx, "toISOString");
  addStringConstantGlobal(ctx, "number");
  fctx.body.push(
    // Step 1 — RequireObjectCoercible (the ToObject throw).
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: isUndefIdx },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: nullishThrow },
    // Step 2 — tv = ToPrimitive(O, number): an exotic `@@toPrimitive` sees
    // the hint "number"; OrdinaryToPrimitive runs valueOf first.
    { op: "local.get", index: 1 },
    ...stringConstantExternrefInstrs(ctx, "number"),
    { op: "call", funcIdx: toPrimitiveIdx },
    { op: "local.tee", index: tv },
    // Step 3 — a non-finite Number answers null (a Symbol is not a Number).
    { op: "call", funcIdx: typeofNumberIdx },
    ...notSymbolInstrs(ctx, tv),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: tv },
        { op: "call", funcIdx: unboxNumberIdx },
        { op: "local.tee", index: num },
        { op: "local.get", index: num },
        { op: "f64.sub" },
        { op: "f64.const", value: 0 },
        { op: "f64.ne" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
      ],
    },
    // Step 4 — Invoke(O, "toISOString"), O = ToObject(this): a Symbol is
    // wrapped (its `[[Prototype]]` linked to %Symbol.prototype%) so a method
    // installed there is found; other primitives already walk their wrapper.
    ...symbolToObjectInstrs(ctx, fctx),
    { op: "local.get", index: 1 },
    ...stringConstantExternrefInstrs(ctx, "toISOString"),
    { op: "call", funcIdx: externGetIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: vecNewIdx },
    { op: "call", funcIdx: applyIdx },
  );
  return EXTERNREF;
}

/** `[i32] → [i32 && !(local is a boxed Symbol)]`; identity without a Symbol carrier. */
function notSymbolInstrs(ctx: CodegenContext, local: number): Instr[] {
  // The body may be minted before the module's first `Symbol()` registers
  // the carrier; a later symbol `this` must still be told apart.
  ensureSymbolCarrier(ctx);
  return [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
    { op: "i32.eqz" },
    { op: "i32.and" },
  ];
}

/** `this = Object(this)` when `this` (param 1) is a primitive Symbol. */
function symbolToObjectInstrs(ctx: CodegenContext, fctx: FunctionContext): Instr[] {
  const newSymbolIdx = ctx.funcMap.get("__new_Symbol");
  if (newSymbolIdx === undefined) return [];
  const wrap: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: newSymbolIdx },
  ];
  const saved = fctx.body;
  fctx.body = wrap;
  linkSymbolWrapperPrototype(ctx, fctx);
  fctx.body = saved;
  wrap.push({ op: "local.set", index: 1 });
  return [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: wrap },
  ];
}
