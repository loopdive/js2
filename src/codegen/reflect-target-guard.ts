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
