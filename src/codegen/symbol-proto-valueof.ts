// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4776) Native body for `Symbol.prototype.valueOf` under standalone.
 *
 * A native Symbol value is represented as a bare i32 in the expression
 * lowering, but crosses the reflective closure ABI as the identity-stable
 * `$Symbol` carrier. `thisSymbolValue(this)` therefore accepts that carrier
 * and returns it unchanged. Keep the wrapper arm too: if a future/native
 * `Object(symbol)` path supplies a `$Object` with the reserved internal slot,
 * the slot's `$Symbol` value is the required answer. Every other receiver is
 * a genuine incompatible receiver and must throw a catchable TypeError.
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { ensureObjectRuntime, FLAG_INTERNAL, WRAPPER_PRIMITIVE_KEY } from "./object-runtime.js";
import { ensureSymbolCarrier } from "./symbol-native.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/**
 * Emit the standalone `Symbol.prototype.valueOf` closure body.
 *
 * The value read can precede the first Symbol expression in source order, so
 * the native carrier is demanded here rather than relying on a later boxing
 * site. The `$Object` arm recognizes the internal `[[PrimitiveValue]]` slot
 * used by native primitive wrappers, while the flag and carrier checks keep a
 * user property with the same spelling from being mistaken for that slot.
 */
export function emitSymbolProtoValueOfBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone) return null;

  const symbolTypeIdx = ensureSymbolCarrier(ctx);
  ensureObjectRuntime(ctx);
  const objectTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (!objectTypes || objFindIdx === undefined) return null;

  const { objectTypeIdx, propEntryTypeIdx } = objectTypes;
  const entry = allocLocal(fctx, `__symvo_entry_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: propEntryTypeIdx,
  });
  const slot = allocLocal(fctx, `__symvo_slot_${fctx.locals.length}`, { kind: "anyref" });

  // Primitive Symbol receiver: the closure ABI has already boxed it into the
  // native carrier, so preserving the original externref preserves identity.
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: symbolTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 1 }, { op: "return" }],
    },
  );

  // Symbol wrapper receiver: recover the internal [[PrimitiveValue]] slot and
  // require both the internal flag and the native Symbol carrier brand.
  fctx.body.push(
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
                  then: [{ op: "local.get", index: slot }, { op: "extern.convert_any" }, { op: "return" }],
                },
              ],
            },
          ],
        },
      ],
    },
  );

  emitBrandCheckTypeError(ctx, fctx.body, "Symbol.prototype.valueOf called on incompatible receiver");
  return { kind: "externref" };
}
