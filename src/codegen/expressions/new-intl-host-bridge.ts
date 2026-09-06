// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// new-intl-host-bridge.ts (#5355) — the standalone half of the
// `Intl.DateTimeFormat` host-mirror bridge.
//
// The host half is a plain extern-class registration (`extern-declarations.ts`,
// `importPrefix: "Intl_DateTimeFormat"`), which keeps the receiver as an opaque
// host externref and forwards `format` / `formatToParts` / `resolvedOptions` /
// `formatRange(ToParts)` to the real ICU-backed host object. That registration is
// deliberately gated on the JS-host lane so no unsatisfiable `Intl_*` import can
// reach a `--target standalone`/`wasi` binary (the #2961 no-leak ratchet).
//
// This module supplies what that gate leaves behind. Without it, standalone
// `new Intl.DateTimeFormat(...)` falls through every arm of
// `compileNewExpression` to its terminal `reportError`, which yields the value
// `undefined` — and the first method call on it then TRAPS ("dereferencing a
// null pointer"), the exact defect #5355 was filed for on the host lane. A trap
// is unrecoverable and uncatchable from JS; a `TypeError` is neither. So the
// declared standalone behaviour is a catchable throw naming the bound.
//
// The bound, stated once: there is no ICU in pure Wasm. Real calendar and
// time-zone formatting needs the CLDR/tzdata tables, which a compiled shim would
// have to carry. That is out of scope here by design (#5206 reached the same
// conclusion for the namespace itself), so standalone refuses rather than
// answering wrongly.

import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitThrowTypeError } from "../js-errors.js";

/**
 * Intl constructors whose only implementation is the host bridge. Keyed by the
 * class name `compileNewExpression` resolves (the rightmost identifier, so
 * `Intl.DateTimeFormat` → `DateTimeFormat`).
 *
 * `ListFormat` / `NumberFormat` are deliberately absent: they register
 * unconditionally (pre-#2961) and already emit host imports under standalone
 * with a leak warning. Adding them here would change their behaviour from
 * "works, with a warning" to "throws", which is a separate decision.
 */
const HOST_ONLY_INTL_CLASSES = new Set(["DateTimeFormat"]);

/** Whether the callee of a `new` expression names a member of the `Intl` namespace. */
function isIntlQualified(expr: ts.NewExpression): boolean {
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  return ts.isIdentifier(callee.expression) && callee.expression.text === "Intl";
}

/**
 * (#5355) Standalone/WASI arm for the Intl constructors that only exist as a
 * host bridge. Returns `undefined` when this is not one of them (the caller
 * falls through to its own unsupported-constructor reporting); otherwise emits a
 * catchable `TypeError` and reports `externref` for the caller's type contract —
 * the `throw` is terminal, so nothing is actually left on the value stack.
 *
 * Host lane always returns `undefined` here: on it the extern class IS
 * registered, so the extern-constructor arm claims the expression well before
 * this is reached. The `externClasses` probe (rather than a bare
 * `ctx.standalone` test) keeps those two facts from drifting apart — this arm
 * can only fire where the registration did not.
 */
export function tryCompileIntlHostOnlyNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  className: string | undefined,
): ValType | undefined {
  if (className === undefined || !HOST_ONLY_INTL_CLASSES.has(className)) return undefined;
  if (ctx.externClasses.has(className)) return undefined;
  if (!isIntlQualified(expr)) return undefined;
  emitThrowTypeError(
    ctx,
    fctx,
    `Intl.${className} is not available in --target standalone/wasi (no ICU data in pure Wasm)`,
  );
  return { kind: "externref" };
}
