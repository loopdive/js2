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
 * ## The class-constructor exception (#6618)
 *
 * One negative-classifier case IS safe to brand, narrowly: a value that
 * `__typeof_function` recognises as function-shaped but `__is_callable`
 * (#6420) says has no [[Call]]. The two natives share every classifier arm
 * (closure wrapper, bound fn, proxy, revoker, branded builtin, link-boundary
 * bit) except ONE: `__is_callable` deliberately excludes a class-constructor
 * identity (module-local singleton OR the link-boundary `callableKind` bit 0)
 * that `__typeof_function` deliberately includes (§10.2.1 step 2's own
 * "class constructors are functions, but only [[Construct]]able" rule). So
 * `typeof_function && !is_callable` can ONLY be true for a class — anything
 * the callable classifier fails to recognise (the false-negative risk the
 * paragraph above warns about) is *equally* invisible to `__typeof_function`,
 * since it is built from the identical base arms, and the guard stays silent
 * for it rather than mis-throwing. This is the CALL-side twin of #6612's
 * `IsConstructor` guard: `recv.name(args)` reaches the resolved callee AFTER
 * the receiver's own arms have declined, exactly where #6612 reaches its
 * driver after every constructible-callee arm has declined.
 *
 * Measured (`built-ins/Temporal/PlainDate/constructor.js`, the real
 * `@js-temporal/polyfill` provider, standalone, linked): `Temporal.PlainDate`
 * is a PROPERTY of a provider-owned namespace object, so the call reaches
 * `__extern_method_call`'s `$Object` arm — NOT the bare dynamic-call
 * dispatch #6420 already guards (`tryEmitInlineDynamicCall`'s
 * `wantIsCallableGuard`, `expressions/calls.ts`). `const f =
 * Temporal.PlainDate; f(...)` already threw correctly (it IS a bare dynamic
 * call); `Temporal.PlainDate(...)` did not — it fell through to
 * `__apply_closure`, which does not recognise a class struct and answers its
 * legacy `null`.
 *
 * ## Emission discipline
 *
 * - Standalone/WASI only (`noJsHost`). With a JS host the method call is a host
 *   import and the engine throws on its own, so the gc lane is byte-identical.
 * - A FACTORY, not a shared array: the guard is spliced into more than one arm,
 *   and finalize's DCE/remap walks double-remap a shared `Instr` object
 *   (`reference_shared_instr_object_dce_double_remap`).
 * - Each brand predicate is looked up, not required. A module that registered
 *   none of them emits the pre-#4656 bytes exactly. The #6618 class check is
 *   the same discipline: `ctx.funcMap.get`, never `ensureLateImport` — this
 *   builder runs from inside `ensureObjectRuntime`'s bootstrap (#2039's
 *   `flushLateImportShifts(ctx, null)` at its top), which has no live
 *   `FunctionContext` to relocate a fresh import's index shift against, and
 *   force-registering `__is_callable`/`__typeof_function` here would grow
 *   every method-call-using module regardless of whether it ever calls a
 *   class through one — #6420's own arm already registers `__is_callable`
 *   for any module with a bare dynamic call (which `assert.throws(E, fn)`'s
 *   internal `fn()` makes true for virtually every test262 row that uses it),
 *   so this stays a look-up.
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
  // (#6618) The class-constructor exception (see the module docstring): fires
  // only when BOTH natives are already registered, since neither is force-
  // imported here. Captured once (this factory runs once, at the same point
  // `brandIdxs` above is captured); the `then:` body is rebuilt FRESH on every
  // invocation of the returned closure below, like `brandIdxs.flatMap`'s own
  // `throwTypeError()` calls — a shared `Instr[]` reference spliced into more
  // than one arm double-remaps at finalize (`reference_shared_instr_object_
  // dce_double_remap`, see "Emission discipline" above).
  const isCallableIdx = ctx.funcMap.get("__is_callable");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const buildClassNotCallableCheck = (): Instr[] =>
    isCallableIdx === undefined || typeofFunctionIdx === undefined
      ? []
      : [
          { op: "local.get", index: methodLocalIdx },
          { op: "call", funcIdx: typeofFunctionIdx },
          { op: "local.get", index: methodLocalIdx },
          { op: "call", funcIdx: isCallableIdx },
          { op: "i32.eqz" },
          { op: "i32.and" },
          { op: "if", blockType: { kind: "empty" }, then: throwTypeError() },
        ];
  return () => [
    { op: "local.tee", index: methodLocalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: throwTypeError() },
    ...brandIdxs.flatMap((funcIdx): Instr[] => [
      { op: "local.get", index: methodLocalIdx },
      { op: "call", funcIdx },
      { op: "if", blockType: { kind: "empty" }, then: throwTypeError() },
    ]),
    ...buildClassNotCallableCheck(),
    { op: "local.get", index: methodLocalIdx },
  ];
}
