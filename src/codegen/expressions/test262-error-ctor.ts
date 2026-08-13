// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) `new Test262Error(msg)` in a module that DECLARES its own
 * `function Test262Error` — which the literal upstream harness always does
 * (sta.js), so this is every assembled test262 module.
 *
 * `tryCompileBuiltinGlobalNew` claims the name unconditionally and, in the
 * JS-host lane, lowers the construction to the `env::__new_Test262Error` host
 * import, which builds a real `Error` subclass. That leaves the constructed
 * object's `.constructor` pointing at the HOST class while the module's
 * `Test262Error` identifier reads a compiled WasmGC closure struct — two values
 * that can never be `===`, because compiled strict equality on two externrefs
 * internalises both operands and uses `ref.eq` when the right one is statically
 * a GC struct (it never reaches the `__host_eq` / `_hostStrictEqual` shim that
 * was written for this case).
 *
 * The visible consequence is `thrown.constructor !== expectedErrorConstructor`
 * inside `assert.throws` for every Test262Error, and the harness's own
 * self-tests reporting the tell-tale
 * `Expected a Test262Error, but a "Test262Error" was thrown.` — the message is
 * rendered from `err.constructor.name`, which is right; only the identity is
 * wrong.
 *
 * The repair keeps the host `Error` (the exception bridge, `String(err)` and
 * the failure renderer all depend on a real `Error` subclass) and passes the
 * module's own constructor value alongside the message, so the host can stamp
 * it as a non-enumerable own `constructor` back-pointer. The value comes from
 * compiling the SAME identifier node the comparison site compiles, so both
 * reads resolve to one carrier global and `ref.eq` holds.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { coerceType, compileExpression } from "../shared.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

/**
 * Emit the ctor-carrying `new Test262Error(...)` lowering, assuming the message
 * argument is already on the stack as an externref. Returns `true` when it
 * emitted the call (leaving the constructed error on the stack), `false` when
 * it declined — in which case nothing was emitted and the caller keeps its
 * existing `__new_Test262Error` path.
 */
export function emitTest262ErrorWithModuleCtor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  ctorName: string,
): boolean {
  // Standalone / WASI never reach here (they were claimed by the native
  // `$Error_struct` arm above), and a module that does not declare the name has
  // no other side for the identity comparison to hold.
  //
  // Classes are excluded: `ctx.classSet` members read through a different
  // identifier path (the `funcRefIdx` branch of `compileIdentifierValueRead`),
  // whose carrier precedence this does not model — the same carve-out
  // `error-ctor-carrier.ts` makes for `fillExternGetErrorProps`.
  if (
    ctorName !== "Test262Error" ||
    ctx.wasi ||
    ctx.standalone ||
    !ctx.topLevelFunctionNames.has(ctorName) ||
    ctx.classSet.has(ctorName)
  ) {
    return false;
  }

  // Reserve the import BEFORE compiling the constructor operand, so a late
  // funcIdx shift reaches already-emitted instructions through currentFunc.
  const ctorIdx = ensureLateImport(
    ctx,
    "__new_Test262Error_ctor",
    [{ kind: "externref" }, { kind: "externref" }], // message, constructor
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (ctorIdx === undefined) return false;

  const ctorValueType = compileExpression(ctx, fctx, expr.expression, { kind: "externref" });
  if (!ctorValueType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (ctorValueType.kind !== "externref") {
    coerceType(ctx, fctx, ctorValueType, { kind: "externref" });
  }
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__new_Test262Error_ctor") ?? ctorIdx });
  return true;
}
