// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6630) `%Function.prototype%.{call,apply,bind}` as REFLECTIVE VALUES in
 * `--target standalone`.
 *
 * ## The defect
 *
 * `makeGlue` (array-object-proto.ts) wired no body for these three
 * `Function`-family invokers — every route that reifies one as a first-class
 * value (a `Function.prototype.call` read, a companion-seeded own property,
 * a `gOPD` descriptor) minted the #2984 Phase-2 "degrade to a catchable
 * TypeError" body, so INVOKING the value threw
 * `Function.prototype.<m> is not yet implemented in --target standalone`.
 *
 * That refusal was latent as long as `%Function.prototype%` stayed
 * unmaterialized in a module that also called a closure with `.call`/
 * `.apply`/`.bind` syntax — the closure-specific dispatchers
 * (`closure-call-fast.ts`'s fast arm, `closure-props.ts`'s
 * `__closure_method_call` own-property route) handle that case directly and
 * never reach the native-proto glue. But `%Function.prototype%` is a real
 * `$Object` once materialized (any `Function.prototype` read, or any other
 * trigger of `ensureObjectRuntime`'s companion machinery), and it becomes the
 * closure's `[[Prototype]]` — so `__extern_get(closureReceiver, "call")`
 * legitimately WALKS the chain, finds the companion's seeded own-property
 * (the refusal closure, because this file did not exist), and every
 * "own-property miss ⇒ take the closure-specific fast path" guard in both
 * dispatchers now sees a HIT and defers to that value instead — which then
 * throws. See #6630's issue file for the full trace (WAT-verified).
 *
 * ## The fix
 *
 * Give the three invokers real, receiver-POLYMORPHIC bodies — this is more
 * general than papering over one materialization trigger, because it also
 * fixes every OTHER receiver kind that legitimately reaches this glue (a
 * bound function, a native builtin's singleton closure, …), not just genuine
 * user closures. Each forwards to the SAME generic "invoke any callable
 * value" primitives the rest of the runtime already uses for this exact
 * question:
 *
 *   - `call`  → unpack `this` (the target) + the packed arg vector into
 *     `thisArg` and a REST `$ObjVec`, then `__apply_closure(target, thisArg,
 *     restVec)` — the identical shape `__closure_method_call`'s own "call"
 *     route already builds (closure-props.ts), so the two paths answer
 *     identically for the receivers both can reach.
 *   - `apply` → forward `(target, thisArg, argArray)` straight to
 *     `__apply_closure`, unchanged — `__apply_closure` already reads its
 *     `args` param generically via `__extern_length`/`__extern_get_idx`, so
 *     a `null`/`undefined` `argArray` degrades to zero args exactly as it
 *     does for the existing "apply" route.
 *   - `bind`  → forward `(target, argsVec)` straight to `__bind_dyn` — the
 *     existing dynamic-bind helper (#3140) that already builds a
 *     `$__bound_fn` carrier for an `any`-typed receiver; unrelated glue, no
 *     bound-function construction logic duplicated here.
 *
 * All three share the receiver-polymorphism these generic primitives were
 * BUILT for: `__apply_closure`/`__bind_dyn` dispatch across every callable
 * carrier shape the closure-classifier knows about (user closures, bound
 * functions, builtin constructor singletons, …), not just the WasmGC closure
 * struct family. `IsCallable(this)` is enforced first (§20.2.3 step 2) via
 * the same `__typeof_function` predicate `emitFunctionProtoToStringBody`
 * uses for its own step-4 check.
 *
 * ## Declines
 *
 * Missing any dependency (object runtime not materialized enough to expose
 * `__extern_length`/`__extern_get_idx`/`$ObjVec` builders) → return `null`
 * having emitted NOTHING, so `makeGlue`'s `??` ladder falls through to the
 * existing refusal body and the module is byte-identical to before this file
 * existed. `makeGlue` composes these bodies with `??`, so "ask first, emit
 * second" is mandatory (see `emitNumberProtoToStringBody`'s note on the
 * orphaned-preamble hazard, restated here rather than re-explained).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import {
  ensureObjectRuntime,
  ensureObjVecBuilders,
  reserveApplyClosure,
  reserveBindDynHelper,
} from "./object-runtime.js";

const EXTERNREF_RESULT: ValType = { kind: "externref" };

/**
 * §20.2.3 step 2 — `IsCallable(this)` false throws a catchable TypeError.
 * Shared prologue for all three invokers; `local.get 1` is the raw `this`
 * externref (method-closure ABI: 0=self, 1=this, 2..=args — see
 * `emitFunctionProtoToStringBody`'s identical comment).
 */
function pushIsCallableGuard(ctx: CodegenContext, fctx: FunctionContext, member: string): boolean {
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  if (typeofFunctionIdx === undefined) return false;
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: typeofFunctionIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", `Function.prototype.${member} called on non-callable receiver`, {
        flush: fctx,
      }),
    },
  );
  return true;
}

/**
 * `%Function.prototype%.apply(thisArg, argArray)` — fixed 2-slot ABI (params
 * 0=self, 1=this/target, 2=thisArg, 3=argArray). No unpacking needed:
 * `__apply_closure` already reads `argArray` generically.
 */
export function emitFunctionProtoApplyBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone && !ctx.wasi) return null;
  ensureObjectRuntime(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  if (!pushIsCallableGuard(ctx, fctx, "apply")) return null;
  fctx.body.push(
    { op: "local.get", index: 1 }, // target — invoked as itself
    { op: "local.get", index: 2 }, // thisArg
    { op: "local.get", index: 3 }, // argArray
    { op: "call", funcIdx: applyClosureIdx },
  );
  return EXTERNREF_RESULT;
}

/**
 * `%Function.prototype%.bind(thisArg, ...args)` — variadic ABI (params
 * 0=self, 1=this/target, 2=packed arg vec `[thisArg, ...boundArgs]`).
 * Forwards straight to `__bind_dyn`, which reads the vec generically via
 * `__extern_length`/`__extern_get_idx` (the packed vec subtypes the same
 * `$__vec_base` supertype those helpers dispatch on) and builds the
 * `$__bound_fn` carrier.
 */
export function emitFunctionProtoBindBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone && !ctx.wasi) return null;
  const bindDynIdx = reserveBindDynHelper(ctx);
  if (!pushIsCallableGuard(ctx, fctx, "bind")) return null;
  fctx.body.push(
    { op: "local.get", index: 1 }, // target — the function being bound
    { op: "local.get", index: 2 }, // packed [thisArg, ...boundArgs] vec
    { op: "extern.convert_any" },
    { op: "call", funcIdx: bindDynIdx },
  );
  return EXTERNREF_RESULT;
}

/**
 * `%Function.prototype%.call(thisArg, ...args)` — variadic ABI (params
 * 0=self, 1=this/target, 2=packed arg vec `[thisArg, ...restArgs]`).
 * Unpacks `thisArg` (element 0, or `undefined` when the vec is empty) and
 * repacks elements [1..) into a fresh `$ObjVec`, then forwards to
 * `__apply_closure(target, thisArg, restVec)` — the identical shape
 * `__closure_method_call`'s own "call" route builds (closure-props.ts).
 */
export function emitFunctionProtoCallBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (!ctx.standalone && !ctx.wasi) return null;
  ensureObjectRuntime(ctx);
  const objVecBuilders = ensureObjVecBuilders(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  if (externLengthIdx === undefined || externGetIdxIdx === undefined) return null;
  if (!pushIsCallableGuard(ctx, fctx, "call")) return null;

  const undef = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr];
  const argsLocal = allocLocal(fctx, "__fpc_args", { kind: "externref" });
  const lenLocal = allocLocal(fctx, "__fpc_len", { kind: "f64" });
  const thisArgLocal = allocLocal(fctx, "__fpc_thisarg", { kind: "externref" });
  const vecLocal = allocLocal(fctx, "__fpc_vec", { kind: "externref" });
  const kLocal = allocLocal(fctx, "__fpc_k", { kind: "f64" });

  fctx.body.push(
    // args = extern.convert_any(the packed vec param)
    { op: "local.get", index: 2 },
    { op: "extern.convert_any" },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: lenLocal },
    // thisArg = len >= 1 ? args[0] : undefined
    ...undef,
    { op: "local.set", index: thisArgLocal },
    { op: "local.get", index: lenLocal },
    { op: "f64.const", value: 1 },
    { op: "f64.ge" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: argsLocal },
        { op: "f64.const", value: 0 },
        { op: "call", funcIdx: externGetIdxIdx },
        { op: "local.set", index: thisArgLocal },
      ],
    },
    // restVec = objVecNew(); for (k=1; k<len; k++) push(restVec, args[k])
    { op: "call", funcIdx: objVecBuilders.newIdx },
    { op: "local.set", index: vecLocal },
    { op: "f64.const", value: 1 },
    { op: "local.set", index: kLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: kLocal },
            { op: "local.get", index: lenLocal },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: vecLocal },
            { op: "local.get", index: argsLocal },
            { op: "local.get", index: kLocal },
            { op: "call", funcIdx: externGetIdxIdx },
            { op: "call", funcIdx: objVecBuilders.pushIdx },
            { op: "local.get", index: kLocal },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: kLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // return __apply_closure(target, thisArg, restVec)
    { op: "local.get", index: 1 },
    { op: "local.get", index: thisArgLocal },
    { op: "local.get", index: vecLocal },
    { op: "call", funcIdx: applyClosureIdx },
  );
  return EXTERNREF_RESULT;
}
