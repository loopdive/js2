// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6684) The body of `Object.create` read as a VALUE under
 * `--target standalone` — lodash-es's `_baseCreate`:
 *
 * ```js
 * var objectCreate = Object.create;
 * … if (objectCreate) { return objectCreate(proto); }
 * ```
 *
 * Before, the value was the generic two-slot refusal closure: the call site
 * (which casts the value to the closure type of the overload it resolved, the
 * one-parameter `create(o)`) failed that cast and threw
 * `Cannot access property on null or undefined` at lodash-es module init.
 *
 * The closure takes the ONE-argument shape — not the spec arity 2: the call
 * site casts the value to the closure type of the overload it resolved, and
 * `create(o)` is the one-parameter overload, so a two-slot closure failed that
 * cast at every call (the reflective `.length` comes from the builtin meta
 * table, not this ABI). It calls the SAME `__object_create` native the direct
 * `Object.create(proto)` lowering uses. That native stores a
 * `null` `[[Prototype]]` for any argument that is neither an open `$Object` nor
 * callable, which is right for `null` but would be a SILENT wrong answer for a
 * closed-struct literal (the direct lowering re-materialises those first) or a
 * primitive. So the body answers only the arguments the native models exactly
 * — `null`, a `$Object`, a callable — and throws a catchable TypeError for
 * every other one (§20.1.2.2 step 1 requires one for primitives/undefined;
 * for a closed struct it is the loud refusal, never a wrong prototype).
 *
 * Params: 0 = self, 1 = proto. Returns false to DECLINE (caller keeps the
 * previous refusal body) when a helper is unavailable.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

export function emitObjectCreateValueBody(ctx: CodegenContext, fctx: FunctionContext): boolean {
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__object_create", [{ kind: "externref" }], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__typeof_function", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (objectTypeIdx === undefined) return false;
  if (ctx.funcMap.get("__object_create") === undefined || ctx.funcMap.get("__typeof_function") === undefined) {
    return false;
  }
  const refusal: FunctionContext = { ...fctx, body: [] };
  emitThrowTypeError(ctx, refusal, "Object.create: this prototype is not yet supported in --target standalone");
  const createIdx = ctx.funcMap.get("__object_create")!;
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: typeofFunctionIdx },
        { op: "i32.or" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: refusal.body },
      ],
    },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: createIdx },
  );
  return true;
}
