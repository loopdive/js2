// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4196 slice 1 — `[[Construct]]` through a bound function in `--target
 * standalone` / WASI (ECMA-262 §10.4.1.2).
 *
 * ## The gap
 * #3140 gave standalone a native bound-function carrier — `$__bound_fn
 * {target, thisArg, boundArgs}` — and wired its **[[Call]]** side: the
 * `__apply_closure` front-guard unwraps one bound layer per hop, prepends
 * `boundArgs`, and recurses with `[[BoundThis]]` as the receiver.
 *
 * Its **[[Construct]]** side was never wired. There is no `$__bound_fn` arm in
 * the `new` lowering at all, so `new (f.bind(o, …))()` reached the terminal
 * unknown-constructor fallthrough in `compileNewExpression`, which — with no
 * `__new_<name>` host import to call in a host-free target — emitted a bare
 * `ref.null.extern`. `new` on a bound function evaluated to **null**, with no
 * trap and no diagnostic. That is the 13/14-file
 * `built-ins/Function/prototype/bind/15.3.4.5.2-4-*` block (#4196).
 *
 * ## The lowering (§10.4.1.2 BoundFunctionExoticObject.[[Construct]])
 *
 *   __construct_bound(callee, args) -> externref
 *     if callee is not a $__bound_fn: return null          ;; exact status quo
 *     cur = callee; extra = args
 *     while cur is a $__bound_fn:                          ;; step 1/3/4
 *       extra = cur.boundArgs ++ extra
 *       cur   = cur.target
 *     proto  = __extern_get(cur, "prototype")               ;; §10.2.2 step 3
 *     self   = __object_create(proto)                       ;; OrdinaryCreateFromConstructor
 *     result = __apply_closure(cur, self, extra)            ;; call target with this=self
 *     return IsObject(result) ? result : self                ;; §10.2.2 step 13
 *
 * Three details are load-bearing:
 *
 *  - **`[[BoundThis]]` is IGNORED.** §10.4.1.2 threads `newTarget`, never
 *    `[[BoundThis]]` — the freshly created object is the receiver. This is the
 *    one place the construct path must NOT reuse `__apply_closure`'s front
 *    guard, which deliberately lets `[[BoundThis]]` beat the caller-supplied
 *    receiver (§10.4.1.1, the CALL rule). Hence the explicit unwrap loop here:
 *    we need the innermost target both to read `.prototype` from and to invoke
 *    with `self`. Handing the still-bound carrier to `__apply_closure` would
 *    silently construct with `[[BoundThis]]` as `this`.
 *  - **The chain is unwrapped to the INNERMOST target, not one hop.** Bound-of-
 *    bound composes by prepending each layer's `boundArgs` in
 *    outermost-last order, exactly as repeated §10.4.1.2 application would.
 *  - **`.prototype` comes from the TARGET.** A bound function has no own
 *    `prototype` property (§20.2.3.2 creates none), so the instance's prototype
 *    link is the target's — reading it off the carrier would produce a
 *    null-proto object and break `instanceof` / inherited reads.
 *
 * ## Why reserve-then-fill
 * The driver calls `__apply_closure`, whose own body is filled at FINALIZE over
 * the complete closure-shape table, and it needs `ctx.boundFnTypeIdx`, which is
 * only set once a `.bind(…)` site has compiled — a `new` site may compile
 * FIRST. So the call site reserves a stable funcIdx with an `unreachable` stub
 * and bakes `call <idx>`; {@link fillConstructBoundDriver} supplies the body at
 * finalize. Same discipline as `native-construct.ts` (#3981) and
 * `accessor-driver.ts` (#1888), and it keeps the late-import index shifter
 * (#329/#1899) authoritative via `funcMap`.
 *
 * ## Degradation and byte-neutrality
 * A module with no bound-construct site never reserves the driver, so its
 * output is byte-identical. When the driver IS reserved but the module turned
 * out to have no `$__bound_fn` type (no `.bind` site compiled) or is missing an
 * object-model helper, the fill emits `ref.null.extern` — the exact pre-#4196
 * outcome for that site, never a trap.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const DRIVER_NAME = "__construct_bound";

/**
 * Reserve-time `"prototype"` key push, replayed into the driver body at
 * finalize. Held per-context in a WeakMap rather than as a `CodegenContext`
 * field: the context type is a god-file under the #3102 LOC gate, and one
 * optional per-compile value has no business widening it.
 */
const PROTO_KEY_BY_CTX = new WeakMap<CodegenContext, Instr[]>();

/** Memo for {@link nodeCanMintBoundFn} — one AST walk per source file. */
const MENTIONS_BIND_BY_FILE = new WeakMap<ts.SourceFile, boolean>();

/**
 * Could this source file mint a `$__bound_fn` at all?
 *
 * BYTE-NEUTRALITY GATE. The carrier only ever comes from a `.bind(…)` property
 * call — the typed `compileFunctionBind` route or the dynamic `__bind_dyn` one
 * — so a file with no `bind` property access anywhere can never produce one,
 * and emitting the retry at its `new` sites would change the module's bytes for
 * a branch that provably never taken. Without this gate EVERY host-free
 * `new <any-typed binding>(…)` site in the corpus would move, which is a far
 * wider blast radius than the fix needs.
 *
 * The alternative — gate on `ctx.boundFnTypeIdx >= 0` — does not work: a `new`
 * site can compile BEFORE the `.bind` site that mints the type.
 *
 * A cross-file bound function (minted in another module of a multi-file
 * program) is a conservative MISS: the site keeps its pre-#4196 null. That is
 * the fail-safe direction — never a wrong construct, only a missing one.
 *
 * A **SYNTHESIZED** `new` node — one a codegen desugaring built, with no parent
 * chain — has no source file at all, and `getSourceFile()` on it returns
 * `undefined` rather than throwing. Feeding that to the memo `WeakMap` is a
 * hard `Invalid value used as weak map key` crash that takes the whole compile
 * down; it cost 7 passing `TypedArrayConstructors/…/
 * use-default-proto-if-custom-proto-is-not-object.js` files before the control
 * sweep caught it. Unknown provenance is treated as "cannot mint" — the same
 * fail-safe direction as the cross-file case.
 */
function nodeCanMintBoundFn(site: ts.Node): boolean {
  const file = typeof site.getSourceFile === "function" ? site.getSourceFile() : undefined;
  if (file === undefined || file === null || typeof file !== "object") return false;
  const memo = MENTIONS_BIND_BY_FILE.get(file);
  if (memo !== undefined) return memo;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "bind") {
      found = true;
      return;
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "bind"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  MENTIONS_BIND_BY_FILE.set(file, found);
  return found;
}

/**
 * Reserve `__construct_bound(callee, args) -> externref`.
 *
 * `protoKeyInstrs` pushes the `"prototype"` property key as an externref. The
 * caller builds it at RESERVE time (while the string-constant machinery is in
 * its normal mid-compile state) and it is replayed verbatim into the filled
 * body; string-constant globals are append-only and index-stable, so the baked
 * instructions stay valid across the intervening compilation.
 */
export function reserveConstructBoundDriver(ctx: CodegenContext, protoKeyInstrs: Instr[]): number {
  const existing = ctx.funcMap.get(DRIVER_NAME);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF], `$${DRIVER_NAME}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: DRIVER_NAME,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(DRIVER_NAME, funcIdx);
  PROTO_KEY_BY_CTX.set(ctx, protoKeyInstrs);
  return funcIdx;
}

/**
 * Retry an already-emitted host-free `new` as §10.4.1.2 [[Construct]] when the
 * value on the stack is null.
 *
 * Consumes the externref currently on the stack and leaves an externref. Both
 * the callee (as an `anyref` local, the form the caller already has) and the
 * arguments are read from LOCALS the caller evaluated — nothing is re-compiled,
 * so no argument side effect runs twice.
 *
 * This is the shape the dominant standalone site needs. `new <any-typed
 * binding>(…)` is claimed by the #2872 dynamic-`$__ta_ctor` arm, which — by
 * design — yields `ref.null.extern` for a runtime value that is not a TypedArray
 * constructor. A `$__bound_fn` is never a `$__ta_ctor`, so it always lands in
 * that null. Retrying on null keeps the TypedArray arm authoritative where it
 * applies and is a pure addition everywhere else: a callee that is neither a TA
 * constructor nor a bound function still ends as null.
 *
 * Emits NOTHING (leaving the module byte-identical) when `site`'s file cannot
 * mint a bound function — see {@link fileCanMintBoundFn}.
 */
export function emitBoundConstructOnNull(
  ctx: CodegenContext,
  fctx: FunctionContext,
  site: ts.Node,
  calleeAnyLocal: number,
  argLocals: readonly number[],
): void {
  if (!nodeCanMintBoundFn(site)) return;
  ensureObjectRuntime(ctx);
  ensureObjVecBuilders(ctx);
  reserveApplyClosure(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__object_create", [EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (objVecNewIdx === undefined || objVecPushIdx === undefined) return;

  addStringConstantGlobal(ctx, "prototype");
  const driverIdx = reserveConstructBoundDriver(ctx, stringConstantExternrefInstrs(ctx, "prototype"));

  const priorLocal = allocLocal(fctx, `__cb_prior_${fctx.locals.length}`, EXTERNREF);
  const argvLocal = allocLocal(fctx, `__cb_argv_${fctx.locals.length}`, EXTERNREF);
  const boundArm: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: argvLocal },
  ];
  for (const argLocal of argLocals) {
    boundArm.push(
      { op: "local.get", index: argvLocal },
      { op: "local.get", index: argLocal },
      { op: "call", funcIdx: objVecPushIdx },
    );
  }
  boundArm.push(
    { op: "local.get", index: calleeAnyLocal },
    { op: "extern.convert_any" },
    { op: "local.get", index: argvLocal },
    { op: "call", funcIdx: ctx.funcMap.get(DRIVER_NAME) ?? driverIdx },
  );

  fctx.body.push(
    { op: "local.tee", index: priorLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: boundArm,
      else: [{ op: "local.get", index: priorLocal }],
    },
  );
}

/**
 * Fill the reserved driver once `__apply_closure` and the object-model helpers
 * are registered. No-op when no site reserved one.
 */
export function fillConstructBoundDriver(ctx: CodegenContext): void {
  const driverIdx = ctx.funcMap.get(DRIVER_NAME);
  if (driverIdx === undefined) return;
  const driver = definedFuncAt(ctx, driverIdx);
  if (!driver) return;

  const bfIdx = ctx.boundFnTypeIdx;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const objectCreateIdx = ctx.funcMap.get("__object_create");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const protoKeyInstrs = PROTO_KEY_BY_CTX.get(ctx);
  // `__apply_closure` can only invoke the target with an explicit receiver via
  // a `__call_fn_method_<N>` dispatcher. The multi-file finalize path emits
  // only `__call_fn_0`/`__call_fn_1`, so without one of these the bridge would
  // return its undefined sentinel and the driver would hand back an EMPTY
  // instance instead of the pre-#4196 null. Decline rather than invent one.
  const hasReceiverDispatcher = [0, 1, 2, 3, 4, 5, 6, 7, 8].some(
    (n) => ctx.funcMap.get(`__call_fn_method_${n}`) !== undefined,
  );

  if (
    bfIdx < 0 ||
    !hasReceiverDispatcher ||
    externGetIdx === undefined ||
    externGetIdxIdx === undefined ||
    externLengthIdx === undefined ||
    objectCreateIdx === undefined ||
    applyClosureIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    protoKeyInstrs === undefined
  ) {
    // Missing machinery (most commonly: no `.bind` site ever minted the
    // carrier, so there is no `$__bound_fn` type). Degrade to the pre-#4196
    // value for this site rather than trapping.
    driver.body = [{ op: "ref.null.extern" }];
    driver.locals = [];
    return;
  }

  // 0 = callee, 1 = call-site args ($ObjVec externref)
  const curLocal = 2;
  const extraLocal = 3;
  const bfLocal = 4;
  const mergedLocal = 5;
  const srcLocal = 6;
  const kLocal = 7;
  const lenLocal = 8;
  const protoLocal = 9;
  const selfLocal = 10;
  const resultLocal = 11;

  const isBoundFn = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: bfIdx },
  ];

  /** `for (k = 0; k < len(src); k++) objvec_push(merged, get_idx(src, k))`. */
  const copyLoop = (): Instr[] => [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: srcLocal },
        { op: "ref.is_null" },
        { op: "br_if", depth: 0 },
        { op: "local.get", index: srcLocal },
        { op: "call", funcIdx: externLengthIdx },
        { op: "local.set", index: lenLocal },
        { op: "f64.const", value: 0 },
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
                { op: "local.get", index: mergedLocal },
                { op: "local.get", index: srcLocal },
                { op: "local.get", index: kLocal },
                { op: "call", funcIdx: externGetIdxIdx },
                { op: "call", funcIdx: objVecPushIdx },
                { op: "local.get", index: kLocal },
                { op: "f64.const", value: 1 },
                { op: "f64.add" },
                { op: "local.set", index: kLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];

  // §10.2.2 step 13: return `result` only when the body returned an Object.
  // The null test comes FIRST and separately — `__typeof_object(null)` is 1 by
  // design (JS `typeof null === "object"`), so folding null into the typeof
  // probe would return null from `new`, reinstating the very bug this fixes.
  // A returned FUNCTION is also an Object per spec, hence the second arm.
  const isObjectProbe: Instr[] = [];
  if (typeofObjectIdx !== undefined) {
    isObjectProbe.push({ op: "local.get", index: resultLocal }, { op: "call", funcIdx: typeofObjectIdx });
    if (typeofFunctionIdx !== undefined) {
      isObjectProbe.push(
        { op: "local.get", index: resultLocal },
        { op: "call", funcIdx: typeofFunctionIdx },
        { op: "i32.or" },
      );
    }
  } else {
    isObjectProbe.push({ op: "i32.const", value: 0 });
  }

  driver.body = [
    // Not a bound function → the site's pre-#4196 value. Keeps this driver a
    // pure ADDITION for every other dynamic-`new` callee that reaches it.
    ...isBoundFn(0),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "return" }],
    },

    { op: "local.get", index: 0 },
    { op: "local.set", index: curLocal },
    { op: "local.get", index: 1 },
    { op: "local.set", index: extraLocal },

    // Unwrap the whole bound chain: extra = boundArgs ++ extra, cur = target.
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            ...isBoundFn(curLocal),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: curLocal },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: bfIdx },
            { op: "local.set", index: bfLocal },
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.set", index: mergedLocal },
            { op: "local.get", index: bfLocal },
            { op: "struct.get", typeIdx: bfIdx, fieldIdx: 2 },
            { op: "local.set", index: srcLocal },
            ...copyLoop(),
            { op: "local.get", index: extraLocal },
            { op: "local.set", index: srcLocal },
            ...copyLoop(),
            { op: "local.get", index: mergedLocal },
            { op: "local.set", index: extraLocal },
            { op: "local.get", index: bfLocal },
            { op: "struct.get", typeIdx: bfIdx, fieldIdx: 0 },
            { op: "local.set", index: curLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // proto = target.prototype; self = OrdinaryObjectCreate(proto)
    { op: "local.get", index: curLocal },
    ...protoKeyInstrs,
    { op: "call", funcIdx: externGetIdx },
    { op: "local.set", index: protoLocal },
    { op: "local.get", index: protoLocal },
    { op: "call", funcIdx: objectCreateIdx },
    { op: "local.set", index: selfLocal },

    // result = target.[[Call]](self, extra)
    { op: "local.get", index: curLocal },
    { op: "local.get", index: selfLocal },
    { op: "local.get", index: extraLocal },
    { op: "call", funcIdx: applyClosureIdx },
    { op: "local.set", index: resultLocal },

    { op: "local.get", index: resultLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: selfLocal }],
      else: [
        ...isObjectProbe,
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: [{ op: "local.get", index: resultLocal }],
          else: [{ op: "local.get", index: selfLocal }],
        },
      ],
    },
  ];

  driver.locals = [
    { name: "__cb_cur", type: EXTERNREF },
    { name: "__cb_extra", type: EXTERNREF },
    { name: "__cb_bf", type: { kind: "ref_null", typeIdx: bfIdx } },
    { name: "__cb_merged", type: EXTERNREF },
    { name: "__cb_src", type: EXTERNREF },
    { name: "__cb_k", type: { kind: "f64" } },
    { name: "__cb_len", type: { kind: "f64" } },
    { name: "__cb_proto", type: EXTERNREF },
    { name: "__cb_self", type: EXTERNREF },
    { name: "__cb_result", type: EXTERNREF },
  ];
}
