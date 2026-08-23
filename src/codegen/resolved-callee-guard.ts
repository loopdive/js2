// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * §7.3.14 Call / §13.3.6.2 EvaluateCall step 5 — `recv.name(…)` where the
 * resolved `name` is not callable must throw **TypeError**, not answer
 * `undefined`.
 *
 * Extracted from `ensureObjectRuntime` (#4656) so the guard has an owner: it is
 * spliced into three arms of `__extern_method_call` (the `$Object` route, the
 * vec/closure else-route, and `buildProtoNamedMethodMissArm`'s terminal miss)
 * and it is the only place in the object runtime that decides callability.
 *
 * ## Why the guard is built from POSITIVE primitive brands
 *
 * (#4221) shipped the ABSENT half — `ref.is_null` after `__nullish_to_null` —
 * and deliberately stopped there:
 *
 * > A non-null but non-callable value keeps the legacy `__apply_closure`
 * > answer: the callable-brand classifier does not recognise every callable
 * > shape, and a false positive here turns a working call into a hard throw.
 *
 * That is an argument against `!isCallable(v)`, and it does not transfer to
 * `isPrimitive(v)` — the two tests have opposite failure modes. A callable
 * shape the classifier does not recognise answers **false** to
 * `__typeof_number` / `__typeof_string` / `__typeof_boolean`, so it can never
 * be mistaken for a primitive and can never be turned into a hard throw. Only
 * a value that positively brands as a number, string or boolean throws, and
 * calling one of those is a TypeError under every reading of §7.3.14.
 *
 * Measured on the campaign base (`language/expressions/call/11.2.3-3_4.js` —
 * an ACCESSOR whose getter returns 42):
 *
 * ```js
 * Object.defineProperty(o, "bar", {get: function () { return 42; }});
 * o.bar(foo());   // base: NO THROW AT ALL. The getter ran, the argument
 *                 // evaluated, the call answered undefined. Spec: TypeError.
 * ```
 *
 * Still deliberately NOT covered (absent-not-wrong): a non-callable OBJECT
 * (`new Number(1)`, a plain `{}`) reaches `__apply_closure`'s legacy
 * `undefined`. Branding those needs the negative classifier #4221 declined.
 *
 * ## Emission discipline
 *
 * - Standalone/WASI only (`noJsHost`). With a JS host the method call is a host
 *   import and the engine throws on its own, so the gc lane is byte-identical.
 * - A FACTORY, not a shared array: the guard is spliced into more than one arm,
 *   and finalize's DCE/remap walks double-remap a shared `Instr` object
 *   (`reference_shared_instr_object_dce_double_remap`).
 * - Each brand predicate is looked up, not required. A module that registered
 *   none of them emits the pre-#4656 bytes exactly.
 * - The guard APPENDS a local to `methodCallLocals`; the caller must not have
 *   baked any index past `3 + methodCallLocals.length` yet.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";

/** The primitive brands a resolved callee may positively carry. */
const PRIMITIVE_CALLEE_BRANDS = ["__typeof_number", "__typeof_string", "__typeof_boolean"] as const;

/**
 * Build `__extern_method_call`'s resolved-callee guard.
 *
 * Consumes the resolved callee from the stack and leaves it there again, having
 * thrown TypeError for the absent and provably-primitive cases. Returns a
 * factory producing `[]` when the lane needs no guard.
 */
export function buildResolvedCalleeGuard(
  ctx: CodegenContext,
  methodCallLocals: { name: string; type: ValType }[],
): () => Instr[] {
  if (!noJsHost(ctx)) return () => [];
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const throwTypeError = (): Instr[] =>
    buildThrowJsErrorInstrs(ctx, "TypeError", "called value is not a function", { forceInModuleCtor: true });
  if (throwTypeError().length === 0) return () => [];

  const methodLocalIdx = 3 + methodCallLocals.length;
  methodCallLocals.push({ name: "resolvedMethod", type: { kind: "externref" } });
  const brandIdxs = PRIMITIVE_CALLEE_BRANDS.map((name) => ctx.funcMap.get(name)).filter(
    (idx): idx is number => idx !== undefined,
  );
  return () => [
    { op: "local.tee", index: methodLocalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: throwTypeError() },
    ...brandIdxs.flatMap((funcIdx): Instr[] => [
      { op: "local.get", index: methodLocalIdx },
      { op: "call", funcIdx },
      { op: "if", blockType: { kind: "empty" }, then: throwTypeError() },
    ]),
    { op: "local.get", index: methodLocalIdx },
  ];
}
