// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4555 follow-up) §20.2.3.2 steps 5-8 — the `length` own property of a bound
 * function, for `--target standalone`.
 *
 * #3140 gave standalone a native bound-function carrier (`$__bound_fn`) and
 * wired its [[Call]]; #4196 wired [[Construct]]. Neither seeded the own
 * properties `Function.prototype.bind` is specified to create, so on this lane
 * a bound function had no `length` at all:
 *
 *     function bar(x, y) {}
 *     bar.bind(null).length      // was NaN, want 2
 *     bar.bind(null, 1).length   // was NaN, want 1
 *     Object.getOwnPropertyDescriptor(bar.bind(null), "length")  // was undefined
 *
 * The JS-host lane already answers all three, so this closes a lane divergence
 * rather than adding a behaviour.
 *
 * ## This depends on #4563, and measurably so
 *
 * A first cut of this seed measured **+2 rows / −2 rows** in
 * `built-ins/Function/prototype/bind`: seeding an own property put every bound
 * function into the #4563 state, where a non-empty carrier bag shadowed the
 * prototype walk, so `15.3.4.5-11-1` / `15.3.4.5-6-2` (a bound function must
 * inherit from `Function.prototype`) broke as fast as the `length` rows fixed.
 * It was reverted rather than shipped as a wash. #4563 landed first; this is
 * the same seed on top of it.
 *
 * ## Why the value is computed at RUNTIME
 *
 * §20.2.3.2 reads `length` off the TARGET, which is an arbitrary runtime value:
 * `Object.defineProperty(foo, "length", …)` can change it between declaration
 * and `bind`, and the target may itself be bound. Only the ARGUMENT COUNT is
 * static — it is the bind call site's own argument list.
 *
 * ## The three refusals in step 6, and why each is a real branch
 *
 *  - **No own `length`** (step 5/7) → L = 0. `__hasOwnProperty`, not a plain
 *    get: an inherited `length` does not count.
 *  - **Not a Number PRIMITIVE** (step 6.b) → L = 0, via a NON-COERCING test.
 *    `instance-length-default-value` sets `length` to `undefined`, `null`,
 *    `true`, `"1"`, a Symbol and a `new Number(1)` WRAPPER, and every one is 0.
 *    A coercing `__unbox_number` would answer 1 for the wrapper and the string
 *    and would THROW on the Symbol (§7.1.4 ToNumber) — a TypeError where the
 *    spec wants 0. `__typeof_number` is `typeof x === "number"`: false for both
 *    and never throws.
 *  - **`NaN`** → `ToInteger(NaN)` is `+0` (§7.1.5 step 2), but `f64.trunc(NaN)`
 *    is NaN and `f64.max(NaN, 0)` is NaN, so the self-compare guard must run
 *    BEFORE the subtraction, not after.
 *
 * `+Infinity` deliberately flows through: `ToInteger(+∞)` is `+∞` and the
 * spec's "larger of 0 and targetLen minus args" keeps it. That is why the value
 * is an f64 throughout and never an i32 — `instance-length-exceeds-int32`
 * expects 2147483648, past the i32 range.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { noJsHost } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/**
 * `{writable: false, enumerable: false, configurable: true}` in the flag
 * encoding `__defineProperty_value` decodes — bits 0/1/2 are the writable /
 * enumerable / configurable VALUES (the constant shape `arguments-callee.ts`
 * documents for §10.6 step 13.a). SetFunctionLength (§10.2.9) and
 * SetFunctionName (§10.2.8) share these attributes.
 */
const FN_META_FLAGS = 0x04;

/**
 * Seed `length` on the just-built `$__bound_fn` in `boundLocal`, reading the
 * target from `targetLocal`. `boundArgCount` is the number of PARTIAL arguments
 * the bind site supplied (excluding `thisArg`).
 *
 * A no-op off the host-free lane, and a no-op if any runtime helper is
 * unavailable — the bound function then keeps its pre-existing shape, which is
 * a miss rather than a wrong answer.
 */
/**
 * Stack-in / stack-out wrapper: takes the freshly built bound-function carrier
 * on the stack, seeds its own `length`, and leaves the same carrier on the
 * stack. The local plumbing lives here rather than at the call site so the
 * caller (a god-file) grows by exactly one line.
 */
export function seedBoundFunctionLengthOnStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  boundArgCount: number,
): void {
  if (!noJsHost(ctx)) return;
  const boundLocal = allocLocal(fctx, `__bindfn_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: boundLocal });
  fctx.body.push({ op: "drop" });
  seedBoundFunctionLength(ctx, fctx, boundLocal, targetLocal, boundArgCount);
  fctx.body.push({ op: "local.get", index: boundLocal });
}

export function seedBoundFunctionLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  boundLocal: number,
  targetLocal: number,
  boundArgCount: number,
): void {
  if (!noJsHost(ctx)) return;
  ensureObjectRuntime(ctx);
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  const getIdx = ctx.funcMap.get("__extern_get");
  const typeofNumberIdx = ctx.funcMap.get("__typeof_number");
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  const boxIdx = ctx.funcMap.get("__box_number");
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (
    hasOwnIdx === undefined ||
    getIdx === undefined ||
    typeofNumberIdx === undefined ||
    unboxIdx === undefined ||
    boxIdx === undefined ||
    defineIdx === undefined
  ) {
    return;
  }

  addStringConstantGlobal(ctx, "length");
  const key = (): Instr[] => stringConstantExternrefInstrs(ctx, "length").map((i) => ({ ...i }));
  const lenTmp = allocLocal(fctx, `__bindfn_len_${fctx.locals.length}`, { kind: "externref" });
  const numTmp = allocLocal(fctx, `__bindfn_lnum_${fctx.locals.length}`, { kind: "f64" });

  // ToInteger, with §7.1.5's NaN → +0 applied BEFORE the subtraction (see header).
  const toIntegerAndAdjust: Instr[] = [
    { op: "local.get", index: lenTmp },
    { op: "call", funcIdx: unboxIdx },
    { op: "f64.trunc" },
    { op: "local.tee", index: numTmp },
    { op: "f64.const", value: 0 },
    { op: "local.get", index: numTmp },
    { op: "local.get", index: numTmp },
    { op: "f64.eq" }, // false only for NaN
    { op: "select" },
    { op: "f64.const", value: boundArgCount },
    { op: "f64.sub" },
    { op: "f64.const", value: 0 },
    { op: "f64.max" },
  ];

  // L = hasOwn(target,"length") ? (typeof len === "number" ? adjust : 0) : 0
  fctx.body.push({ op: "local.get", index: targetLocal });
  fctx.body.push(...key());
  fctx.body.push({ op: "call", funcIdx: hasOwnIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: [
      { op: "local.get", index: targetLocal },
      ...key(),
      { op: "call", funcIdx: getIdx },
      { op: "local.tee", index: lenTmp },
      { op: "call", funcIdx: typeofNumberIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: toIntegerAndAdjust,
        else: [{ op: "f64.const", value: 0 }],
      },
    ],
    else: [{ op: "f64.const", value: 0 }],
  });
  fctx.body.push({ op: "local.set", index: numTmp });

  fctx.body.push({ op: "local.get", index: boundLocal });
  fctx.body.push(...key());
  fctx.body.push({ op: "local.get", index: numTmp });
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  fctx.body.push({ op: "f64.const", value: FN_META_FLAGS });
  fctx.body.push({ op: "call", funcIdx: defineIdx });
  fctx.body.push({ op: "drop" });
}
