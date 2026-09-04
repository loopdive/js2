// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5269 B-c) Native body for `Symbol.prototype.toString` under standalone —
 * the reflective sibling of `symbol-proto-valueof.ts` (#4776).
 *
 * §20.4.3.3: `sym = ? thisSymbolValue(this); return SymbolDescriptiveString(sym)`.
 * The `thisSymbolValue` prologue is the SAME two arms `valueOf` uses (the
 * interned `$Symbol` carrier the closure ABI boxes a primitive symbol into, and
 * a `$Object` wrapper's `[[SymbolData]]` internal slot); only the tail differs —
 * `valueOf` hands the carrier back, `toString` renders `Symbol(<desc>)` through
 * `emitSymbolToString`, the SAME builder the implicit `String(sym)` path uses,
 * so the two spellings cannot drift.
 *
 * Without this body the `Symbol` glue ladder fell to
 * `emitProtoMemberBodyRefusal`, and the reflective call
 * `Symbol.prototype.toString.call(sym)` answered a NULL externref — which then
 * trapped inside `__str_concat` at the first use rather than throwing anything
 * catchable.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, FLAG_INTERNAL, WRAPPER_PRIMITIVE_KEY } from "./object-runtime.js";
import { emitSymbolToString, ensureSymbolCarrier } from "./symbol-native.js";

/**
 * Emit the standalone `Symbol.prototype.toString` closure body (ABI: local 0 =
 * self, local 1 = `this`). Returns `null` — having emitted nothing — when the
 * substrate is unavailable, so the glue ladder falls through byte-identically.
 */
export function emitSymbolProtoToStringBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone) return null;

  const symbolTypeIdx = ensureSymbolCarrier(ctx);
  ensureObjectRuntime(ctx);
  const objectTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (!objectTypes || objFindIdx === undefined) return null;

  const { objectTypeIdx, propEntryTypeIdx } = objectTypes;
  const idLocal = allocLocal(fctx, `__symts_id_${fctx.locals.length}`, { kind: "i32" });
  const okLocal = allocLocal(fctx, `__symts_ok_${fctx.locals.length}`, { kind: "i32" });
  const entry = allocLocal(fctx, `__symts_entry_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: propEntryTypeIdx,
  });
  const slot = allocLocal(fctx, `__symts_slot_${fctx.locals.length}`, { kind: "anyref" });

  // thisSymbolValue arm 1 — the primitive symbol, already boxed into the
  // interned carrier by the reflective closure ABI.
  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "local.set", index: okLocal },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: symbolTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: symbolTypeIdx },
        { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: idLocal },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: okLocal },
      ],
    },
  );

  // thisSymbolValue arm 2 — a Symbol WRAPPER `$Object`. The internal flag and
  // the carrier brand are both required, so a user property spelled like the
  // reserved slot key cannot be mistaken for `[[SymbolData]]`.
  fctx.body.push(
    { op: "local.get", index: okLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            ...stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
            { op: "call", funcIdx: objFindIdx },
            { op: "local.tee", index: entry },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: entry },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                { op: "i32.const", value: FLAG_INTERNAL },
                { op: "i32.and" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: entry },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                    { op: "local.set", index: slot },
                    { op: "local.get", index: slot },
                    { op: "ref.test", typeIdx: symbolTypeIdx },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: slot },
                        { op: "ref.cast", typeIdx: symbolTypeIdx },
                        { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
                        { op: "local.set", index: idLocal },
                        { op: "i32.const", value: 1 },
                        { op: "local.set", index: okLocal },
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
  );

  // Every other receiver is genuinely incompatible — a catchable TypeError.
  const throwArm: Instr[] = [];
  emitBrandCheckTypeError(ctx, throwArm, "Symbol.prototype.toString called on incompatible receiver");
  fctx.body.push(
    { op: "local.get", index: okLocal },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwArm },
  );

  // SymbolDescriptiveString(sym) — the shared builder, so this answer is the
  // same string `String(sym)` produces.
  fctx.body.push({ op: "local.get", index: idLocal });
  emitSymbolToString(ctx, fctx);
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}
