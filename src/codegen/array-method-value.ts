import ts from "typescript";
import type { ValType } from "../ir/types.js";
import { ARRAY_METHODS } from "./array-methods.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression } from "./expressions.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/**
 * (#4765 slice 1) `[].includes` read as a VALUE, not called.
 *
 * `arr.includes(x)` is inlined at the call site against the WasmGC vec, so the
 * method never needs to exist as a value — and it didn't: `[].includes`
 * evaluated to `null`, and `[].includes.call(obj, "a")` died with
 * "Cannot read properties of null (reading 'call')". That is the whole failure
 * mode of nine test262 `Array/prototype/includes` rows.
 *
 * The sibling spelling already worked: `Array.prototype.includes.call(obj, …)`
 * resolves through the host `Array` global and runs the real generic algorithm
 * (which is why the array-like rows written that way fail on their own merits —
 * getter observation, 2^53 lengths — rather than on a null). So the gap is
 * narrow: a vec-typed receiver in NON-CALL position has no route to the
 * intrinsic. Hand it the same host function the working spelling gets, so
 * `[].includes === Array.prototype.includes` and both run one algorithm.
 *
 * Modelled directly on the #2743b `vec[Symbol.iterator]` → `%Array.prototype.values%`
 * intercept: host/gc lane only, receiver evaluated for effect then dropped,
 * intrinsic fetched by a late import.
 *
 * **Host lane only, deliberately.** Standalone has no host `Array.prototype` to
 * borrow, and a native answer needs the generic array-like algorithm that
 * #4765's remaining slices build. Returning `undefined` here leaves standalone
 * exactly as it was rather than inventing a second, diverging implementation.
 */
export function tryCompileArrayMethodValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (ctx.standalone || ctx.wasi) return undefined;
  if (ts.isPrivateIdentifier(expr.name)) return undefined;
  const methodName = expr.name.text;
  if (!ARRAY_METHODS.has(methodName)) return undefined;

  // Call position keeps the inlined vec lowering — this must not divert
  // `arr.includes(x)`, which is the hot path and byte-identical today.
  const parent = expr.parent;
  if (parent && ts.isCallExpression(parent) && parent.expression === expr) return undefined;

  // Only a receiver the compiler knows to be an array. Anything else already
  // has its own (host or dynamic) route to the property. Asked through the
  // oracle (#1930), not the raw checker.
  const recvFact = ctx.oracle.typeFactOf(expr.expression);
  if (recvFact.kind !== "array" && recvFact.kind !== "tuple") return undefined;

  const methodIdx = ensureLateImport(ctx, "__array_proto_method", [{ kind: "externref" }], [{ kind: "externref" }]);
  if (methodIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);

  // The receiver may have side effects (`f().includes`), so evaluate it and
  // drop — the intrinsic is shared, not per-receiver.
  if (compileExpression(ctx, fctx, expr.expression) !== null) fctx.body.push({ op: "drop" });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
  fctx.body.push({ op: "call", funcIdx: methodIdx });
  return { kind: "externref" };
}
