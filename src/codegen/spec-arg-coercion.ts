// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 H1) Spec ToString / ToNumber for a `String.prototype.*` ARGUMENT in
 * the standalone lane.
 *
 * ## Why an argument site does not reuse the `+`-concat operand coercion
 *
 * `emitArgAsNativeString` / `compileStringIntegerArg` used to share the
 * `+`/template operand cascade, which is deliberately LENIENT in two ways that
 * §7.1.17 ToString and §7.1.4 ToNumber of an argument are not:
 *
 *  1. An `any`-typed argument went through `__extern_toString`, which renders a
 *     Symbol (it also backs `String(sym)`, §22.1.1.1 step 1.a). Every
 *     String.prototype method instead runs `? ToString(arg)`, which throws —
 *     `"".indexOf(Object(Symbol()))` must throw a TypeError.
 *  2. An object-LITERAL argument is a closed WasmGC struct, and the static
 *     dispatchers (`tryStructToString`, `coerceType(ref → f64)`) only resolve
 *     the shapes they can name at compile time. A non-callable `valueOf`
 *     (`{valueOf: null, toString(){…}}`) answered NaN instead of being skipped
 *     (§7.1.1.1 step 2.b), and two non-callable members answered
 *     `"[object Object]"` / NaN instead of throwing (step 3).
 *
 * The runtime engine already implements the full §7.1.1 walk for exactly these
 * values: `__to_primitive` reaches a closed struct through the per-struct
 * `__call_valueOf`/`__call_toString` dispatchers and `__class_to_primitive`'s
 * runtime walk. So an object-literal argument is handed to it as an externref,
 * and the string result is taken through `__extern_to_string_spec`.
 *
 * Scoped to object-LITERAL structs (`__anon_*`): class instances, vecs, Dates,
 * RegExps and every other nominal carrier keep their existing lowering, and the
 * `+`/template operand cascade is untouched.
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { requireExhaustiveClassToPrimitive } from "./class-to-primitive.js";
import { ensureSpecExternrefToStringProvider } from "./coercion-engine.js";
import { ensureExternrefToStringProvider } from "./shared.js";

/**
 * When `t` (on the stack) is an object-literal struct — the compiler names
 * those `__anon_<n>` — externalize it for the runtime §7.1.1 walk, arm that
 * walk to finish the algorithm in this module, and answer true.
 */
export function externalizeObjectLiteralArg(ctx: CodegenContext, fctx: FunctionContext, t: ValType | null): boolean {
  if (!ctx.standalone || t === null || (t.kind !== "ref" && t.kind !== "ref_null")) return false;
  if (ctx.typeIdxToStructName.get(t.typeIdx)?.startsWith("__anon_") !== true) return false;
  fctx.body.push({ op: "extern.convert_any" });
  requireExhaustiveClassToPrimitive(ctx);
  return true;
}

/**
 * The §7.1.17 ToString provider for an argument: `__extern_to_string_spec`
 * (its Symbol-wrapper arm lives in symbol-to-primitive-arms.ts), or the plain
 * provider where the spec one cannot be built. Consumes an externref.
 */
export function ensureSpecArgToString(ctx: CodegenContext, fctx: FunctionContext): number {
  const plainIdx = ensureExternrefToStringProvider(ctx, fctx, "string");
  const specIdx = ensureSpecExternrefToStringProvider(ctx, fctx);
  const idx = specIdx ?? plainIdx;
  if (idx === undefined) throw new Error("ToString provider unavailable");
  return idx;
}
