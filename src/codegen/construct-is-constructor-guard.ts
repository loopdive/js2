// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6612 / #5383 S25) §13.3.5.1 EvaluateNew step 5 — `IsConstructor(constructor)`
 * — for the DYNAMIC `new <runtime value>(…)` driver under `--target standalone`
 * / WASI.
 *
 * ## The defect
 *
 * `__native_construct_<N>` (`native-construct.ts`, #3981) implements
 * §10.2.2 OrdinaryCallEvaluateBody and nothing else. Its ordinary tail is
 * unconditional:
 *
 *     proto  = suppliedProto ?? callee.prototype
 *     self   = Object.create(proto)
 *     result = __call_fn_method_<N>(self, callee, …)
 *     return IsObject(result) ? result : self
 *
 * Every arm ABOVE that tail (proxy carrier, `$Proxy`, class-object identity,
 * link boundary, runtime-eval marker) answers for a callee that HAS
 * [[Construct]]. Nothing answers for a callee that is callable but has NO
 * [[Construct]] — an arrow, a concise/prototype METHOD, an object-literal
 * method, a built-in function, or a foreign function whose
 * `__boundary_object_callable_kind` publishes bit 1 without bit 2. Such a
 * callee falls into the tail, `Object.create` succeeds, the body runs as an
 * ordinary call, and `new` QUIETLY EVALUATES TO AN OBJECT where the spec
 * demands a **TypeError**.
 *
 * Measured in ONE standalone module, no link (`.tmp/s25/p1.mjs`): `new`
 * through a value on `PD.compare`, `PD.prototype.ident`, `(x) => x + 1` and
 * `Math.max` all answered `"no-throw"`. Across the link (`.tmp/s25/p2.mts`)
 * `new NS.PD.compare()` answered `"no-throw object"`.
 *
 * test262 spells this `built-ins/Temporal/**\/not-a-constructor.js` — **123
 * files corpus-wide**, four of them inside the #5383 three-family sample.
 *
 * ## Why the check belongs INSIDE the driver
 *
 * §13.3.5.1 evaluates the constructor (step 2) and then the ARGUMENT LIST
 * (step 4) **before** the IsConstructor test (step 5). The call site already
 * spills callee and every argument into locals before it emits `call
 * <driver>`, so the driver's entry is the first program point where that exact
 * order holds — and it is ONE place instead of one per call site.
 *
 * ## Why `__reflect_is_constructor` is the right predicate
 *
 * It is the same predicate test262's own `isConstructor.js` harness reads
 * through `Reflect.construct(function(){}, [], f)`, and the second assertion of
 * every `not-a-constructor.js` row already passes — so the corpus itself is the
 * evidence that the predicate answers correctly for these callees. Probed
 * directly (`.tmp/s25/p3.mjs`, single standalone module):
 *
 * | callee | `__reflect_is_constructor` | spec |
 * | --- | --- | --- |
 * | `function f(){}` decl / expr / IIFE result | yes | yes |
 * | built-in ctor `Set`, bound plain fn | yes | yes |
 * | static method, prototype method, object-literal method | no | no |
 * | arrow, bound arrow, `Math.max` | no | no |
 *
 * The ONE disagreement found was a class VALUE answering "no" — but only in a
 * module with **no** dynamic-`new` site at all, because `classObjectIdentityArms`
 * is gated on `classConstructWanted`, which `markClassValueConstructSite` turns
 * on at exactly the sites that reach this driver. Inside the driver the class
 * arms are therefore always present, and a class value has additionally already
 * returned from the class-construct arm several instructions earlier.
 *
 * ## Three conservative narrowings (a wrong fire turns working code into a throw)
 *
 * 1. **`__typeof_function` must say "function".** A carrier the predicate
 *    cannot classify but that does not present as a function keeps its previous
 *    (possibly wrong) result rather than becoming a hard throw. This makes the
 *    guard strictly a "callable but not constructible" rule; `new {}` and
 *    friends are out of scope and unchanged.
 * 2. **The runtime-eval interpreted-callback marker is exempt.** It is a
 *    branded struct the predicate has no arm for, and the driver's own marker
 *    tail constructs through it via `__apply_closure`.
 * 3. **No-JS-host lanes only** (`usesNativeJsErrors`). The JS-host lane routes
 *    dynamic `new` through `__construct_closure`, never reaches here, and must
 *    stay byte-identical; it is also the only lane where building the throw
 *    would need a late IMPORT, which cannot be added at fill time.
 *
 * ## Byte-neutrality / reserve-then-fill
 *
 * The throw is a real `TypeError` INSTANCE (`buildThrowJsErrorInstrs`), built at
 * the CALL SITE during ordinary expression compilation — the same discipline
 * `reserveNativeConstructDriver` already uses for `protoKeyInstrs`, and for the
 * same reason: it touches the string-constant and error-constructor machinery,
 * which must not run at finalize. A module that never compiles a dynamic
 * `new <value>` site never arms the template, so `constructIsConstructorGuard`
 * returns `[]` and the driver emits exactly the bytes it emitted before.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs, usesNativeJsErrors } from "./js-errors.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";

/** §13.3.5.1 step 5's message, matching the wording the host lane throws. */
const NOT_A_CONSTRUCTOR_MESSAGE = "value is not a constructor";

/**
 * The armed throw template, per module. A `WeakMap` rather than a
 * `CodegenContext` field: nothing outside this file reads it, and an unarmed
 * module must be indistinguishable from one compiled before #6612.
 */
const armedThrow = new WeakMap<CodegenContext, Instr[]>();

/**
 * Arm the guard for this module, at a dynamic `new <runtime value>` site.
 *
 * Call during ordinary expression compilation, alongside the other
 * driver-reservation work. `fctx` is the body the late-import index shifter
 * must relocate against — omitting it is the #1839 hazard, since code has
 * already been emitted into it by the time the callee is spilled.
 *
 * Returns `true` when the guard is now armed (no-JS-host lanes only).
 */
export function armConstructIsConstructorGuard(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (!usesNativeJsErrors(ctx)) return false;
  if (armedThrow.has(ctx)) return true;
  // Reserve-then-fill: the predicate is filled over the complete constructible
  // closure table at finalize, so only its stable funcIdx is baked here.
  ensureReflectIsConstructor(ctx);
  armedThrow.set(ctx, buildThrowJsErrorInstrs(ctx, "TypeError", NOT_A_CONSTRUCTOR_MESSAGE, { flush: fctx }));
  return true;
}

/**
 * The guard, for splicing into `__native_construct_<N>`'s body immediately
 * before the ordinary §10.2.2 tail — i.e. after every arm that answers for a
 * callee which DOES have [[Construct]] has declined.
 *
 * `calleeLocalIdx` is the driver's callee parameter. Returns `[]` (and changes
 * nothing) unless the module armed the template and both runtime helpers exist.
 */
export function constructIsConstructorGuard(
  ctx: CodegenContext,
  calleeLocalIdx: number,
  opts: { typeofFunctionIdx: number | undefined; runtimeCallbackTypeIdx: number | undefined },
): Instr[] {
  const throwInstrs = armedThrow.get(ctx);
  if (throwInstrs === undefined || throwInstrs.length === 0) return [];
  const { typeofFunctionIdx, runtimeCallbackTypeIdx } = opts;
  if (typeofFunctionIdx === undefined) return [];
  const isConstructorIdx = ctx.funcMap.get("__reflect_is_constructor");
  if (isConstructorIdx === undefined) return [];

  // Narrowing 2: the interpreted-callback marker constructs through the
  // driver's own `__apply_closure` tail and has no predicate arm.
  const notTheMarker: Instr[] =
    runtimeCallbackTypeIdx === undefined
      ? []
      : [
          { op: "local.get", index: calleeLocalIdx },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: runtimeCallbackTypeIdx },
          { op: "i32.eqz" },
        ];

  const condition: Instr[] = [
    // Narrowing 1: callable, per the same `typeof` the program observes.
    { op: "local.get", index: calleeLocalIdx },
    { op: "call", funcIdx: typeofFunctionIdx },
    // …and NOT a constructor.
    { op: "local.get", index: calleeLocalIdx },
    { op: "call", funcIdx: isConstructorIdx },
    { op: "i32.eqz" },
    { op: "i32.and" },
  ];
  if (notTheMarker.length > 0) condition.push(...notTheMarker, { op: "i32.and" });

  return [...condition, { op: "if", blockType: { kind: "empty" }, then: [...throwInstrs] }];
}
