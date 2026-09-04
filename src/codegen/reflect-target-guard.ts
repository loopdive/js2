// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Shared ECMAScript-Object admission guard for native Reflect operations. */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { ensureNativeReflectTargetClassifier } from "./reflect-construct-native.js";

export interface NativeReflectTargetGuardOptions {
  /** Optional JavaScript-boundary admission predicate used by direct calls. */
  boundaryAdmissionFuncIdx?: number;
}

/**
 * Reject a Reflect target unless it is one of the compiler's ECMAScript
 * Object carriers. The object runtime reserves the closure and instance
 * classifiers before their source-order-independent finalize fills run.
 *
 * Extracted Reflect method closures deliberately omit boundary admission: only
 * a direct call site owns the target-profile decision that permits a caller-
 * supplied JavaScript object to cross that boundary.
 */
export function emitNativeReflectTargetGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  message: string,
  options: NativeReflectTargetGuardOptions = {},
): void {
  const runtime = ensureObjectRuntime(ctx);
  const closureCarrierIdx = ctx.funcMap.get("__is_closure_prop_carrier");
  const instanceCarrierIdx = ctx.funcMap.get("__is_instance_expando_carrier");
  const nativeTargetIdx = ensureNativeReflectTargetClassifier(ctx);
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const typeofUndefinedIdx = ctx.funcMap.get("__typeof_undefined");

  const beforeThrow = fctx.body.length;
  emitThrowTypeError(ctx, fctx, message);
  const throwInstrs = fctx.body.splice(beforeThrow);

  const appendClassifier = (funcIdx: number | undefined): void => {
    if (funcIdx === undefined) return;
    fctx.body.push({ op: "local.get", index: targetLocal }, { op: "call", funcIdx }, { op: "i32.or" });
  };

  // Reflect's target precondition is the ECMAScript Type(V) is Object test,
  // not membership in any one compiler carrier family. The finalized typeof
  // predicates own that semantic union across arrays, collection/error
  // instances, nominal prototypes, native builtin views, and callable closure
  // wrappers. Keep the concrete classifiers below as source-order-safe
  // backstops while late carrier registrations are still settling.
  if (typeofObjectIdx !== undefined && typeofFunctionIdx !== undefined) {
    fctx.body.push(
      { op: "local.get", index: targetLocal },
      { op: "call", funcIdx: typeofObjectIdx },
      { op: "local.get", index: targetLocal },
      { op: "call", funcIdx: typeofFunctionIdx },
      { op: "i32.or" },
      // Under the undefined-singleton representation, null deliberately makes
      // `__typeof_object` true (matching JavaScript's `typeof null`). Reflect
      // still rejects null because Type(null) is Null, not Object.
      { op: "local.get", index: targetLocal },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      { op: "i32.and" },
    );
    // Reject both the singleton and legacy undefined representations. The
    // legacy one is already caught by ref.is_null; retaining the semantic
    // predicate here keeps the guard correct in either representation.
    if (typeofUndefinedIdx !== undefined) {
      fctx.body.push(
        { op: "local.get", index: targetLocal },
        { op: "call", funcIdx: typeofUndefinedIdx },
        { op: "i32.eqz" },
        { op: "i32.and" },
      );
    }
    // The current native `__typeof_object` helper predates the standalone
    // Symbol carrier and therefore needs this one primitive exclusion until
    // that helper can absorb the carrier without changing its stable ABI.
    if (ctx.symbolTypeIdx >= 0) {
      fctx.body.push(
        { op: "local.get", index: targetLocal },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
        { op: "i32.eqz" },
        { op: "i32.and" },
      );
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }

  fctx.body.push(
    { op: "local.get", index: targetLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: runtime.objectTypeIdx },
    { op: "i32.or" },
    { op: "local.get", index: targetLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: runtime.proxyTypeIdx },
    { op: "i32.or" },
  );
  appendClassifier(closureCarrierIdx);
  appendClassifier(nativeTargetIdx);
  appendClassifier(instanceCarrierIdx);
  appendClassifier(options.boundaryAdmissionFuncIdx);
  fctx.body.push({ op: "i32.eqz" }, { op: "if", blockType: { kind: "empty" }, then: throwInstrs });
}

/**
 * (#5196 R3 review F2) Reject a Reflect target only when it POSITIVELY brands
 * as a non-Object — null, undefined, or one of the primitive box carriers.
 *
 * Why a second emitter rather than a fix to {@link emitNativeReflectTargetGuard}:
 * that guard is an OR of positive OBJECT brands, so an unrecognised wrapped
 * representation — the shape a value takes after flowing through a mixed array
 * that also holds a class instance — matches none of them and is thrown out.
 * Measured 2026-09-04, standalone: with the positive-object guard on
 * `Reflect.get`/`Reflect.has`, 13 of 14 ordinary target kinds (arrays, Map,
 * Set, Date, RegExp, Error, boxed wrappers, class instances, bound functions,
 * arrows, plain object literals) threw a TypeError where node answers a value
 * and the base tree answered `undefined`/`false`. Turning a stable wrong value
 * into a throw is a regression of base behaviour.
 *
 * This is the `Reflect.apply` arm's rationale applied to the target position:
 * brand the things that are provably NOT objects and admit everything else.
 * The intended win survives — `Reflect.get(1, "x")` and `Reflect.has(1, "x")`
 * still throw the §28.1.5/§28.1.8 step-1 TypeError — while an unrecognised
 * object shape keeps its previous lowering. A `null`/`undefined` target is the
 * one spelling the win does NOT cover (see the arm comments below): it answers
 * `undefined`/`false`, which is what base answers, so it is a win declined and
 * not a regression.
 *
 * The six guard sites this change-set inherited from `origin/main`
 * (deleteProperty / ownKeys / getOwnPropertyDescriptor / defineProperty(3) /
 * isExtensible / preventExtensions) deliberately keep the stricter emitter:
 * their admission behaviour is pre-existing and is not this review's to widen.
 */
export function emitNativeReflectNonObjectGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  message: string,
): void {
  ensureObjectRuntime(ctx);

  const beforeThrow = fctx.body.length;
  emitThrowTypeError(ctx, fctx, message);
  const throwInstrs = fctx.body.splice(beforeThrow);

  // A NULL externref is deliberately NOT rejected here, and this is the whole
  // difference between a spec-shaped guard and one that is never worse than
  // base. Under this compiler's representation a null externref is not a
  // reliable witness of JavaScript `null`: the pre-existing alias/element
  // widening defect (documented in `proxy-value-provenance.ts`) nulls ORDINARY
  // objects read out of a heterogeneous `any[]`. Measured 2026-09-04,
  // standalone: with the null arm in, `Reflect.get(vals[i], "k")` over
  // `[[1,2], new C(), {k:4}]` threw for the array and the literal where base
  // answers a stable `undefined`. Base does not throw for a literal `null`
  // target either, so declining to brand null costs nothing against base and
  // buys back every nulled-but-real object.
  fctx.body.push({ op: "i32.const", value: 0 });

  // The primitive box carriers. Each is a `ref.test` on the box struct, so a
  // WRAPPER object (`new Number(1)`) is a different carrier and stays admitted,
  // exactly as §28.1.5 requires.
  //
  // `__typeof_undefined` is NOT among them, for the same reason `ref.is_null`
  // is not: measured 2026-09-04, standalone, it answers TRUE for an ordinary
  // object that the widening defect has nulled — including under the
  // undefined-SINGLETON representation, where the two were expected to be
  // distinguishable. With it in the list, `Reflect.get(vals[0], "length")`
  // read from inside a nested function threw where base answers `undefined`.
  // The cost is that a literal `undefined` target answers `undefined` instead
  // of throwing — which is exactly what base does, so it is not a regression;
  // the number/string/boolean/bigint/symbol rejections are the win that
  // survives.
  for (const name of ["__typeof_number", "__typeof_string", "__typeof_boolean", "__typeof_bigint"]) {
    const funcIdx = ctx.funcMap.get(name);
    if (funcIdx === undefined) continue;
    fctx.body.push({ op: "local.get", index: targetLocal }, { op: "call", funcIdx }, { op: "i32.or" });
  }

  // Standalone registers no `__typeof_symbol`; the carrier test is the brand.
  if (ctx.symbolTypeIdx >= 0) {
    fctx.body.push(
      { op: "local.get", index: targetLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
      { op: "i32.or" },
    );
  }

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs });
}
