// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4492 wave-5) §20.1.3.7 `Object.prototype.valueOf` as a REFLECTIVE VALUE in
 * `--target standalone`.
 *
 * ## Why this is not cosmetic
 *
 * §20.1.3.7 is `return ? ToObject(this value)` — for an OBJECT receiver that is
 * the receiver itself. It is the inherited `valueOf` every §7.1.1.1
 * OrdinaryToPrimitive walk reaches when the receiver has no own one, and its
 * whole job there is to hand back a NON-primitive so the walk falls through to
 * `toString`. `makeGlue` wired no body, so the #2984 Phase-2 fallback threw
 * `Object.prototype.valueOf is not yet implemented in --target standalone`
 * instead — turning the most ordinary step of ToPrimitive into a hard error.
 *
 * Measured on campaign HEAD `c42bdbe3e` + the `Function.prototype.toString` arm
 * of this same commit: that message is what
 * `built-ins/String/prototype/substring/S15.5.4.15_A1_T5` fails on
 * (`__func.substring(null, Function())` needs ToNumber(`Function()`), whose
 * number-hint walk asks `valueOf` first).
 *
 * ## The primitive-receiver compromise, stated rather than hidden
 *
 * A full §7.1.18 ToObject would box a primitive `this` into its wrapper. This
 * body returns the receiver UNCHANGED instead — which is exactly what
 * `Object(x)` itself already does in standalone (`calls-guards.ts`: "Standalone
 * / no-JS-host keeps the historical identity fallback — a native ToObject is
 * separate work"). Introducing a second, differently-wrong ToObject here would
 * make the two spellings disagree; matching the module's existing one keeps
 * `Object(x)` and `Object.prototype.valueOf.call(x)` consistent, and a real
 * native ToObject fixes both at once when it lands.
 *
 * The null/undefined receiver is NOT part of that compromise: §7.1.18 throws a
 * TypeError there, and this body throws it. In standalone both values are the
 * null externref (see `__typeof_undefined`, object-runtime.ts), so one
 * `ref.is_null` is the complete test.
 *
 * Declines (returns `null` having emitted nothing) for any other member, so
 * `makeGlue`'s `??` ladder is byte-identical for them.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";

/**
 * Emit the `Object.prototype.valueOf` reflective closure body.
 * Params: 0 = self (closure struct), 1 = `this` (externref). Result externref.
 */
export function emitObjectProtoValueOfBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  if (member !== "valueOf" || !ctx.standalone) return null;
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", "Object.prototype.valueOf called on null or undefined", {
        flush: fctx,
      }),
    },
    { op: "local.get", index: 1 },
  );
  return { kind: "externref" };
}
