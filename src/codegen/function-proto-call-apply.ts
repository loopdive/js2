// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6493 S1) §20.2.3.3 `Function.prototype.call` and §20.2.3.1
 * `Function.prototype.apply` as REFLECTIVE VALUES in `--target standalone`.
 *
 * ## The defect
 *
 * `makeGlue` (array-object-proto.ts) wires no body for these two members of the
 * `Function` family, so every route that reifies one as a first-class value —
 * `Function.prototype.call.bind(f)`, `Function.prototype.call.call(f, …)`, a
 * `gOPD(...).value` handed to a harness helper — minted the #2984 Phase-2
 * "degrade to a catchable TypeError" body and threw
 * `Function.prototype.call is not yet implemented in --target standalone`.
 *
 * The narrow AST alias recognisers already in the tree
 * (`resolveUncurriedBuiltinPrototypeMethod`, object-builtin-effects.ts) rewrite
 * the exact `Function.prototype.call.bind(<Builtin>.prototype.<m>)` spellings
 * of test262's `propertyHelper.js` for five whitelisted methods. They are a
 * SYNTACTIC fold, so a bind target that is a user function — or any other
 * spelling of the same operation — still reached the refusal.
 *
 * ## What these bodies do
 *
 * Both route through the existing open-`any` closure bridge `__apply_closure`
 * (object-runtime.ts), which is the module's one call ABI for "invoke this
 * runtime callable with this receiver and this argument vector". No second ABI
 * is introduced: `call` repacks its own variadic argument vector minus the
 * leading `thisArg`, `apply` forwards the array-like it was handed (the
 * bridge's generic reader IS CreateListFromArrayLike's `length` + indexed-get
 * walk).
 *
 * Step 1 of BOTH sections is `If IsCallable(func) is false, throw a TypeError`,
 * and several test262 rows assert exactly that (`Function/prototype/call/
 * S15.3.4.4_A*`, and the #4492 `FACTORY.prototype = Function.prototype` shape,
 * whose `obj.call()` must throw because `obj` has no [[Call]]). Answering
 * `undefined` there — which is what `__apply_closure` alone does for a
 * non-callable — would trade the old loud refusal for a silent wrong answer.
 *
 * ## Declines
 *
 * Non-standalone, or `__typeof_function` / the externref argument-vector
 * carrier unavailable → return `null` having emitted NOTHING into `fctx` and
 * having registered nothing new, so `makeGlue`'s `??` ladder reaches its
 * existing refusal and the module is byte-identical. `makeGlue` composes these
 * bodies with `??`, so the "ask first, emit second" discipline is mandatory
 * (see `emitFunctionProtoToStringBody`).
 *
 * ## Known residual
 *
 * §20.2.3.1 step 3 defers to CreateListFromArrayLike, which throws a TypeError
 * when `argArray` is neither `undefined`/`null` nor an Object. The guard below
 * covers the primitive carriers the runtime can name (`__typeof_number` /
 * `_string` / `_boolean` / `_bigint`); a Symbol `argArray` has no runtime
 * predicate here and still degrades to a zero-argument call rather than a
 * throw.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { flushLateImportShifts } from "./shared.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";

/** The canonical `$Vec` carrier pair, when `vecTypeIdx` holds externrefs. */
interface VecCarrier {
  vecTypeIdx: number;
  arrTypeIdx: number;
}

function externrefVecCarrier(ctx: CodegenContext, vecTypeIdx: number): VecCarrier | undefined {
  if (vecTypeIdx < 0) return undefined;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (arrDef?.kind !== "array" || arrDef.element.kind !== "externref") return undefined;
  return { vecTypeIdx, arrTypeIdx };
}

/**
 * §20.2.3.3 / §20.2.3.1 bodies for the `Function.prototype.{call,apply}`
 * reflective closures. Declines (returns `null`, emits nothing) for every other
 * family/member and whenever a dependency is missing.
 *
 * Param layout — `call` is registered variadic, `apply` is not:
 *   call : 0 = self, 1 = `this` (the target callable), 2 = argument vector
 *   apply: 0 = self, 1 = `this`, 2 = thisArg, 3 = argArray
 */
export function emitFunctionProtoCallApplyBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null {
  if (member !== "call" && member !== "apply") return null;
  if (!ctx.standalone) return null;
  ensureObjectRuntime(ctx);
  flushLateImportShifts(ctx, fctx);
  if (ctx.funcMap.get("__typeof_function") === undefined) return null;

  // `call` reads its arguments out of the receiver-aware variadic carrier it
  // was declared with; `apply` needs the canonical one only to synthesize the
  // empty argument list of a nullish `argArray`.
  const argsParam = fctx.params[2]?.type;
  const declaredVecTypeIdx = argsParam?.kind === "ref" || argsParam?.kind === "ref_null" ? argsParam.typeIdx : -1;
  if (member === "apply" && fctx.params.length < 4) return null;
  const carrier = externrefVecCarrier(
    ctx,
    member === "call" ? declaredVecTypeIdx : getOrRegisterVecType(ctx, "externref", { kind: "externref" }),
  );
  if (!carrier) return null;

  // Build BOTH guard throws before anything is baked: either may register an
  // error constructor as a late import, which shifts every function index.
  // Every funcIdx used below is read from `funcMap` afterwards.
  const notCallable = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    `Function.prototype.${member} called on a non-callable receiver`,
    { flush: fctx },
  );
  const notArrayLike =
    member === "apply"
      ? buildThrowJsErrorInstrs(ctx, "TypeError", "CreateListFromArrayLike called on a non-object", { flush: fctx })
      : [];
  const applyClosureIdx = reserveApplyClosure(ctx);
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;

  // §20.2.3.{1,3} step 1 — IsCallable(this). The `throw` makes the arm's tail
  // unreachable, so the empty-blocktype `if` validates.
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: typeofFunctionIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: notCallable },
  );

  if (member === "call") emitCallArgsRepack(fctx, carrier);
  else emitApplyArgList(ctx, fctx, carrier, notArrayLike);

  fctx.body.push({ op: "call", funcIdx: applyClosureIdx });
  return { kind: "externref" };
}

/**
 * §20.2.3.3 steps 2-4: split the variadic vector into `thisArg` (element 0, or
 * the omitted-argument sentinel when the call carried none) and a FRESH vector
 * holding elements 1.. . Leaves `(func, thisArg, argList)` on the stack for
 * `__apply_closure`.
 *
 * Every local is (re)initialised on entry rather than trusting its zero value:
 * the closure is one shared function body executed once per call site hit, so a
 * state that survived the previous execution would leak into the next.
 */
function emitCallArgsRepack(fctx: FunctionContext, carrier: VecCarrier): void {
  const { vecTypeIdx, arrTypeIdx } = carrier;
  const n = allocLocal(fctx, `__fpc_n_${fctx.locals.length}`, { kind: "i32" });
  const rest = allocLocal(fctx, `__fpc_rest_${fctx.locals.length}`, { kind: "i32" });
  const data = allocLocal(fctx, `__fpc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const out = allocLocal(fctx, `__fpc_out_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const thisArg = allocLocal(fctx, `__fpc_this_${fctx.locals.length}`, { kind: "externref" });

  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "local.set", index: n },
    { op: "ref.null", typeIdx: arrTypeIdx },
    { op: "local.set", index: data },
    { op: "ref.null.extern" },
    { op: "local.set", index: thisArg },
    // A null vector is the zero-argument call: `n` and `data` stay as reset.
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: n },
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.set", index: data },
      ],
    },
    // thisArg = n >= 1 ? data[0] : <omitted>
    { op: "local.get", index: n },
    { op: "i32.const", value: 1 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: data },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "array.get", typeIdx: arrTypeIdx },
        { op: "local.set", index: thisArg },
      ],
    },
    // rest = max(n - 1, 0)
    { op: "local.get", index: n },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: rest },
    { op: "local.get", index: rest },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: rest },
      ],
    },
    { op: "local.get", index: rest },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: out },
    { op: "local.get", index: rest },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: out },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: data },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: 1 },
        { op: "local.get", index: rest },
        { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
      ],
    },
    // (func, thisArg, argList)
    { op: "local.get", index: 1 },
    { op: "local.get", index: thisArg },
    { op: "local.get", index: rest },
    { op: "local.get", index: out },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
  );
}

/**
 * §20.2.3.1 steps 2-3. A nullish `argArray` is the empty list (step 2); a
 * primitive one is the step-3 CreateListFromArrayLike TypeError; anything else
 * is forwarded unchanged. Leaves `(func, thisArg, argList)` on the stack.
 */
function emitApplyArgList(
  ctx: CodegenContext,
  fctx: FunctionContext,
  carrier: VecCarrier,
  notArrayLike: Instr[],
): void {
  const { vecTypeIdx, arrTypeIdx } = carrier;
  const args = allocLocal(fctx, `__fpa_args_${fctx.locals.length}`, { kind: "externref" });

  // Step 3's rejection set, restricted to the primitive carriers the runtime
  // can actually name — see the module header's residual note.
  const primitive: Instr[] = [];
  for (const name of ["__typeof_number", "__typeof_string", "__typeof_boolean", "__typeof_bigint"]) {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) continue;
    primitive.push({ op: "local.get", index: 3 }, { op: "call", funcIdx: idx });
    if (primitive.length > 2) primitive.push({ op: "i32.or" });
  }

  // `undefined` is a distinct non-null sentinel in standalone, so `ref.is_null`
  // alone misses `f.apply(x)`.
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  fctx.body.push({ op: "local.get", index: 3 }, { op: "local.set", index: args });
  fctx.body.push({ op: "local.get", index: 3 }, { op: "ref.is_null" });
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: 3 }, { op: "call", funcIdx: isUndefinedIdx }, { op: "i32.or" });
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: arrTypeIdx },
      { op: "struct.new", typeIdx: vecTypeIdx },
      { op: "extern.convert_any" },
      { op: "local.set", index: args },
    ],
    else:
      primitive.length === 0
        ? []
        : [...primitive, { op: "if", blockType: { kind: "empty" }, then: notArrayLike } as Instr],
  });

  fctx.body.push({ op: "local.get", index: 1 }, { op: "local.get", index: 2 }, { op: "local.get", index: args });
}
