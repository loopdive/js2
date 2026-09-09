import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { taCtorKindOf } from "./registry/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { coerceType, compileExpression, flushLateImportShifts } from "./shared.js";

const active = new WeakSet<ts.CallExpression>();

/** A packed typed array's explicit prototype wins over builtin toString. */
export function tryVecPrototypeToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  prop: ts.PropertyAccessExpression,
  receiverType: ts.Type,
): ValType | undefined {
  if (
    !ctx.standalone ||
    active.has(expr) ||
    prop.name.text !== "toString" ||
    !ts.isIdentifier(prop.expression) ||
    !fctx.localMap.has(prop.expression.text) ||
    taCtorKindOf(receiverType.symbol?.name ?? "") < 0 ||
    expr.arguments.some(ts.isSpreadElement)
  )
    return undefined;
  ensureObjectRuntime(ctx);
  reserveApplyClosure(ctx);
  ensureObjVecBuilders(ctx);
  addStringConstantGlobal(ctx, "toString");
  const refused = buildThrowJsErrorInstrs(ctx, "TypeError", "called value is not a function", { flush: fctx });
  flushLateImportShifts(ctx, fctx);
  const type = compileExpression(ctx, fctx, prop.expression);
  if (!type) return undefined;
  if (type.kind === "ref" || type.kind === "ref_null") fctx.body.push({ op: "extern.convert_any" });
  else if (type.kind !== "externref") coerceType(ctx, fctx, type, { kind: "externref" });
  const recv = allocLocal(fctx, "__vec_method_receiver", { kind: "externref" });
  const callee = allocLocal(fctx, "__vec_method_callee", { kind: "externref" });
  const args = allocLocal(fctx, "__vec_method_args", { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recv });
  const outer = fctx.body;
  const then: Instr[] = [];
  const otherwise: Instr[] = [];
  fctx.savedBodies.push(outer, then, otherwise, refused);
  try {
    fctx.body = then;
    // Resolve the getter before arguments; retain the callee even if an
    // argument mutates the prototype or reassigns the receiver binding.
    then.push(
      { op: "local.get", index: recv },
      ...stringConstantExternrefInstrs(ctx, "toString"),
      { op: "call", funcIdx: ctx.funcMap.get("__extern_get")! },
      { op: "local.set", index: callee },
      { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
      { op: "local.set", index: args },
    );
    for (const arg of expr.arguments) {
      then.push({ op: "local.get", index: args });
      const t = compileExpression(ctx, fctx, arg);
      if (t) coerceType(ctx, fctx, t, { kind: "externref" });
      else then.push({ op: "ref.null.extern" });
      then.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! });
    }
    then.push(
      { op: "local.get", index: callee },
      { op: "call", funcIdx: ctx.funcMap.get("__typeof_function")! },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: refused },
      { op: "local.get", index: callee },
      { op: "local.get", index: recv },
      { op: "local.get", index: args },
      { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
    );
    // Only a local identifier is admitted: before evaluating arguments, its
    // second read in the unchanged builtin branch has no observable effect.
    fctx.body = otherwise;
    active.add(expr);
    const fallback = compileExpression(ctx, fctx, expr);
    if (fallback) coerceType(ctx, fctx, fallback, { kind: "externref" });
    else otherwise.push({ op: "ref.null.extern" });
  } finally {
    active.delete(expr);
    fctx.body = outer;
    fctx.savedBodies.splice(-4);
  }
  outer.push(
    { op: "local.get", index: recv },
    { op: "call", funcIdx: ctx.funcMap.get("__vec_proto_has")! },
    { op: "if", blockType: { kind: "val", type: { kind: "externref" } }, then, else: otherwise },
  );
  return { kind: "externref" };
}
