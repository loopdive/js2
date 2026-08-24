// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4492 wave-5) §20.2.3.5 `Function.prototype.toString` as a REFLECTIVE VALUE
 * in `--target standalone`.
 *
 * ## The defect
 *
 * `makeGlue` (array-object-proto.ts) wires no body for the `Function` family, so
 * every route that reifies `Function.prototype.toString` as a first-class value —
 * a `Function.prototype.toString` read, a `gOPD` descriptor, and (the one that
 * actually shows up in the corpus) the reflective ToString of a CALLABLE receiver
 * reached through a transferred `String.prototype.<m>` — minted the #2984 Phase-2
 * "degrade to a catchable TypeError" body and threw
 * `Function.prototype.toString is not yet implemented in --target standalone`.
 *
 * Measured on campaign HEAD `c42bdbe3e`, standalone: that exact message is the
 * failure of `built-ins/String/prototype/slice/S15.5.4.13_A1_T5` and
 * `built-ins/String/prototype/substring/S15.5.4.15_A1_T5` — both do
 * `Function.prototype.<m> = String.prototype.<m>` and then need
 * `ToString(Function())` for an argument.
 *
 * ## What it answers, and why that is conforming
 *
 * §20.2.3.5 has two arms. The `[[SourceText]]` arm is unavailable here: this is
 * ONE body shared by every callable in the module, invoked with an arbitrary
 * runtime `this`, so there is no compile-time receiver to key `ctx.funcSourceText`
 * by. Step 3 is the arm that applies — *an implementation-defined String source
 * code representation … NativeFunction* — and `"function () { [native code] }"`
 * is exactly that string. It is the same constant `callable-to-string.ts` (#4265)
 * settled on for the same question in the `+`-concat cascade and the same one
 * `installCompiledClosureToStringArm` (coercion-engine.ts) already returns from
 * `__extern_toString`'s closure arm, so this adds no new dialect.
 *
 * The receiver check is NOT decoration: §20.2.3.5 step 4 throws a **TypeError**
 * for a non-callable `this`, and several test262 rows in
 * `built-ins/Function/prototype/toString/` assert precisely that. Answering the
 * NativeFunction string for `Function.prototype.toString.call({})` would trade
 * the old loud refusal for a silent wrong answer, which the campaign's
 * absent-not-wrong rule forbids in that direction too.
 *
 * ## Declines
 *
 * Non-standalone, or `__typeof_function` / the string constant unavailable →
 * return `null` having emitted NOTHING, so `makeGlue`'s `??` ladder reaches its
 * existing refusal and the module is byte-identical. `makeGlue` composes these
 * bodies with `??`, so an "ask first, emit second" discipline is mandatory (see
 * `emitNumberProtoToStringBody`'s note on the orphaned-preamble hazard).
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { NATIVE_FUNCTION_SOURCE } from "./callable-to-string.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

/**
 * §20.2.3.5 body for the `Function.prototype.toString` reflective closure.
 * Params: 0 = self (closure struct), 1 = `this` (externref). Result externref.
 */
export function emitFunctionProtoToStringBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone) return null;
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  if (typeofFunctionIdx === undefined) return null;
  addStringConstantGlobal(ctx, NATIVE_FUNCTION_SOURCE);
  const lit = stringConstantExternrefInstrs(ctx, NATIVE_FUNCTION_SOURCE);
  if (lit.length === 0) return null;

  // §20.2.3.5 step 4 — a non-callable `this` is a TypeError. The `throw` makes
  // the arm's tail unreachable, so the empty-blocktype `if` validates.
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: typeofFunctionIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(
        ctx,
        "TypeError",
        "Function.prototype.toString requires that 'this' be a Function",
        {
          flush: fctx,
        },
      ),
    },
  );
  fctx.body.push(...lit);
  return { kind: "externref" };
}
