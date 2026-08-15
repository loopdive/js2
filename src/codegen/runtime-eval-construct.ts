// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4438) `[[Construct]]` through a RUNTIME-EVAL callable in `--target
 * standalone` (ECMA-262 §10.2.2 OrdinaryCallEvaluateBody / §13.3.5.1).
 *
 * ## The gap
 * `var F = Function("this.p = 1"); new F()` evaluated to **null**. Measured on
 * the branch base (`--target standalone`, QuickJS provider linked): `typeof
 * (new F())` is `"object"` and the value is `null`, with no trap and no
 * diagnostic. That is `S15.3.5.3_A2_T5` (its CHECK#2), `S15.3.5.3_A3_T1`, and
 * the constructor-shaped part of the `language/statements/function/13.2-*`
 * family — every ES5 file that constructs through an eval-lane function value.
 *
 * ## Why the seam CAN express construction (this was verified, not assumed)
 * The `js2wasm:runtime-eval` ABI has exactly four entries
 * (`__runtime_direct_eval`, `__runtime_indirect_eval`, `__runtime_new_function`,
 * `__runtime_apply_interpreted`) and **no construct entry**. It does not need
 * one: the fourth takes a `thisArg`, and the provider's inward membrane makes a
 * compiled `$Object` receiver writable from inside the evaluated code. Probed on
 * the base before any of this was written:
 *
 *     var F = Function("this.prop=1; return 9;");
 *     var o = {}; F.call(o);        // → 9, and o.prop === 1   ✓ PASSES on base
 *
 * So `[[Construct]]` decomposes into operations that already work:
 * `OrdinaryCreateFromConstructor` (caller-side `__object_create`) + an ordinary
 * `[[Call]]` with the fresh object as receiver + the §10.2.2 step-13 result
 * rule. No ABI extension, no provider change, no artifact rebuild.
 *
 * ## The other half: a runtime-eval function had no `prototype` AT ALL
 * The construct path is worth nothing without a prototype object, and
 * `F.prototype` read `undefined` on base — measured, and contrary to the note in
 * #2660's M3 write-up, which had verified only the post-WRITE half. The reason
 * is structural: `qjsPublish` exposes a QuickJS function as the branded
 * `$RuntimeEvalInterpretedCallback` marker whose `target` is an EMPTY `$Object`
 * created solely to carry the box row (`qjsPushBoxRow(..., 0)` — deliberately
 * NOT mirrored). QuickJS's real `.prototype` never crosses, and the caller's
 * property-get trampoline has arms for `name`/`length`/`constructor` only.
 *
 * ### Where the prototype is minted, and why THERE
 * At the ONE emission site that knows, from the SOURCE, that the value is an
 * ordinary constructable function: `emitStandaloneDynamicFunctionRuntime`, the
 * `Function(...)` / `new Function(...)` lowering. §20.2.1.1 always creates a
 * function with a fresh `prototype` object whose `constructor` is the function,
 * so seeding it there is spec-mandated rather than a guess.
 *
 * The alternative — vivifying `prototype` inside the shared carrier
 * property-get trampoline whenever the key misses — was designed and REJECTED:
 * that trampoline also serves carriers wrapping arrows, prototype methods and
 * AOT declarations. An arrow must NOT have a `prototype` (§15.3), and an AOT
 * declaration already has one (its fnctor global), so a trampoline-side vivify
 * would both invent a property that must not exist and mint a SECOND, rival
 * prototype object for one that does — the exact split-brain #2660 M3 spent its
 * lap removing. Distinguishing the cases at runtime would need an
 * `IsConstructor` bit on the cross-module marker struct, i.e. an ABI widening.
 * Minting at the source-known site costs nothing and is exactly as narrow.
 *
 * The store is the carrier's own #3468 property BAG — the same table
 * `F.zz = 7` / `F.prototype = {…}` already round-trip through (both verified
 * working on base). It is written with `__defineProperty_value`, not
 * `__extern_set`, so the attributes are the spec's: `prototype` is
 * `{writable:true, enumerable:false, configurable:false}` (§20.2.3.2) and
 * `constructor` is `{writable:true, enumerable:false, configurable:true}`
 * (§10.2.5). Enumerability is load-bearing, not decoration — a bag entry
 * written by assignment is enumerable, and `for (var k in F)` would then report
 * `prototype`.
 *
 * ## The driver (§10.2.2, mirroring #4196's `__construct_bound`)
 *
 *     __construct_runtime_eval(callee, args) -> externref
 *       if callee is not a branded runtime-eval carrier: return null
 *       proto = __extern_get(callee, "prototype")        ;; §10.2.2 step 3
 *       if proto is not an Object:                 return null
 *       self   = __object_create(proto)                  ;; OrdinaryObjectCreate
 *       result = __apply_closure(callee, self, args)     ;; [[Call]] with this=self
 *       return IsObject(result) ? result : self          ;; §10.2.2 step 13
 *
 * **The `proto is not an Object → null` clause is the safety property of this
 * whole change, not an oversight.** It is what keeps the driver from turning a
 * carrier around an arrow — or around any callable that legitimately has no
 * `prototype` — into a silently-wrong constructed object: such a value reads
 * `undefined` there and keeps the site's pre-#4438 null, byte-for-byte the same
 * observable outcome as today. Only a callable that ACTUALLY has a prototype
 * object constructs, which after the seeding above is precisely the
 * `Function(src)` population this issue is about (plus any carrier the user
 * explicitly assigned a `prototype` to, where constructing is also correct).
 *
 * A returned FUNCTION is an Object per spec, hence the second arm of the
 * step-13 probe; and the null test is separate and FIRST, because
 * `__typeof_object(null)` is 1 by design (`typeof null === "object"`) and
 * folding the two would return null from `new`, reinstating the very bug this
 * fixes. Same trap #4196 documents.
 *
 * ## Why reserve-then-fill
 * The driver calls `__apply_closure`, whose body is filled at FINALIZE over the
 * complete closure-shape table, and it needs
 * `ctx.runtimeEvalAotCallableCarrier`, which a `new` site may compile BEFORE any
 * carrier is minted. So the call site reserves a stable funcIdx with an
 * `unreachable` stub and bakes `call <idx>`; {@link fillRuntimeEvalConstructDriver}
 * supplies the body at finalize. Same discipline as `construct-bound.ts`
 * (#4196), `native-construct.ts` (#3981) and `accessor-driver.ts` (#1888), and
 * it keeps the late-import index shifter (#329/#1899) authoritative via
 * `funcMap`.
 *
 * ## Degradation and byte-neutrality
 * A module whose source cannot reach the runtime-eval lane at all never
 * reserves the driver and never emits the retry, so its output is
 * byte-identical (gc/host included — every entry point is gated on
 * `ctx.standalone`). When the driver IS reserved but the module minted no
 * carrier, or an object-model helper is missing, the fill emits
 * `ref.null.extern` — the exact pre-#4438 outcome for that site, never a trap.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { RUNTIME_EVAL_AOT_CALLABLE_BRAND_A, RUNTIME_EVAL_AOT_CALLABLE_BRAND_B } from "./runtime-eval-boundary.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const DRIVER_NAME = "__construct_runtime_eval";

/**
 * §20.2.3.2 — a function created by the `Function` constructor has
 * `prototype` as `{writable: true, enumerable: false, configurable: false}`.
 * Bit layout is `__defineProperty_value`'s HOST encoding: 1 writable,
 * 2 enumerable, 4 configurable.
 */
const FUNCTION_PROTOTYPE_FLAGS = 0x01;

/** §10.2.5 — `constructor` on a function's prototype object is
 *  `{writable: true, enumerable: false, configurable: true}`. */
const PROTOTYPE_CONSTRUCTOR_FLAGS = 0x01 | 0x04;

/**
 * Reserve-time `"prototype"` key push, replayed into the driver body at
 * finalize. Held per-context in a `WeakMap` rather than as a `CodegenContext`
 * field, for the reason `construct-bound.ts` states: the context type is a
 * god-file under the #3102 LOC gate and one optional per-compile value has no
 * business widening it.
 */
const PROTO_KEY_BY_CTX = new WeakMap<CodegenContext, Instr[]>();

/** Memo for {@link nodeCanSeeRuntimeEvalCallable} — one AST walk per file. */
const MENTIONS_EVAL_LANE_BY_FILE = new WeakMap<ts.SourceFile, boolean>();

/**
 * Could this source file ever hold a runtime-eval callable?
 *
 * BYTE-NEUTRALITY GATE, same role as `nodeCanMintBoundFn` in
 * `construct-bound.ts`. Every runtime-eval carrier originates from a source
 * mention of `eval` or `Function` — the `Function(...)` lowering, the
 * direct/indirect eval routes, or the global-binding seed those routes install.
 * A file that names neither can never produce one, so emitting the retry at its
 * `new` sites would move the module's bytes for a branch provably never taken.
 *
 * Deliberately syntactic and deliberately over-approximate: a false positive
 * costs a not-taken branch, a false negative costs the fix. Matching a bare
 * NAME (identifier, property name, or string literal) rather than a resolved
 * symbol is part of that — a local shadow named `Function` is a miss in the
 * harmless direction.
 *
 * A **SYNTHESIZED** node — one a codegen desugaring built, with no parent chain
 * — has no source file, and `getSourceFile()` returns `undefined` rather than
 * throwing. Feeding that to the memo `WeakMap` is a hard
 * `Invalid value used as weak map key` crash that takes the whole compile down
 * (it cost #4196 seven passing files before its control sweep caught it), so
 * unknown provenance is treated as "cannot see one" — the fail-safe direction.
 */
function nodeCanSeeRuntimeEvalCallable(site: ts.Node): boolean {
  const file = typeof site.getSourceFile === "function" ? site.getSourceFile() : undefined;
  if (file === undefined || file === null || typeof file !== "object") return false;
  const memo = MENTIONS_EVAL_LANE_BY_FILE.get(file);
  if (memo !== undefined) return memo;
  let found = false;
  const names = new Set(["eval", "Function"]);
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      found = true;
      return;
    }
    if (ts.isStringLiteralLike(node) && names.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  MENTIONS_EVAL_LANE_BY_FILE.set(file, found);
  return found;
}

/**
 * (#4438) Seed the §20.2.1.1 `prototype` / `constructor` pair onto a freshly
 * minted runtime-eval callable.
 *
 * Consumes the carrier externref on the stack and leaves the SAME reference —
 * this is a decoration, never a replacement, so every identity the caller
 * already established (`F === F`, the memoized carrier) is untouched.
 *
 * Emits nothing at all (leaving the site byte-identical) when the object
 * runtime cannot supply `__new_plain_object` / `__defineProperty_value`.
 */
export function emitRuntimeEvalFunctionPrototypeSeed(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.standalone) return;
  ensureObjectRuntime(ctx);
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [EXTERNREF]);
  const defineIdx = ensureLateImport(
    ctx,
    "__defineProperty_value",
    [EXTERNREF, EXTERNREF, EXTERNREF, { kind: "f64" }],
    [EXTERNREF],
  );
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined || defineIdx === undefined) return;
  const liveNewObjIdx = ctx.funcMap.get("__new_plain_object") ?? newObjIdx;
  const liveDefineIdx = ctx.funcMap.get("__defineProperty_value") ?? defineIdx;

  addStringConstantGlobal(ctx, "prototype");
  addStringConstantGlobal(ctx, "constructor");

  const carrierLocal = allocLocal(fctx, `__rec_fn_${fctx.locals.length}`, EXTERNREF);
  const protoLocal = allocLocal(fctx, `__rec_proto_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "local.set", index: carrierLocal },
    { op: "call", funcIdx: liveNewObjIdx },
    { op: "local.set", index: protoLocal },
    // proto.constructor = F
    { op: "local.get", index: protoLocal },
    ...stringConstantExternrefInstrs(ctx, "constructor"),
    { op: "local.get", index: carrierLocal },
    { op: "f64.const", value: PROTOTYPE_CONSTRUCTOR_FLAGS },
    { op: "call", funcIdx: liveDefineIdx },
    { op: "drop" },
    // F.prototype = proto
    { op: "local.get", index: carrierLocal },
    ...stringConstantExternrefInstrs(ctx, "prototype"),
    { op: "local.get", index: protoLocal },
    { op: "f64.const", value: FUNCTION_PROTOTYPE_FLAGS },
    { op: "call", funcIdx: liveDefineIdx },
    { op: "drop" },
    { op: "local.get", index: carrierLocal },
  );
}

/**
 * Reserve `__construct_runtime_eval(callee, args) -> externref`.
 *
 * `protoKeyInstrs` pushes the `"prototype"` property key as an externref. The
 * caller builds it at RESERVE time (while the string-constant machinery is in
 * its normal mid-compile state) and it is replayed verbatim into the filled
 * body; string-constant globals are append-only and index-stable, so the baked
 * instructions stay valid across the intervening compilation.
 */
function reserveRuntimeEvalConstructDriver(ctx: CodegenContext, protoKeyInstrs: Instr[]): number {
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
 * Retry an already-emitted host-free `new` as §10.2.2 [[Construct]] on a
 * runtime-eval callable when the value on the stack is null.
 *
 * Consumes the externref currently on the stack and leaves an externref. Both
 * the callee (as an `anyref` local, the form the caller already has) and the
 * arguments are read from LOCALS the caller evaluated — nothing is re-compiled,
 * so no argument side effect runs twice.
 *
 * Chains AFTER `emitBoundConstructOnNull`: a `$__bound_fn` is not a
 * runtime-eval carrier and vice versa, so each retry declines (returning null)
 * for the other's shape and the two compose without ordering hazard.
 */
export function emitRuntimeEvalConstructOnNull(
  ctx: CodegenContext,
  fctx: FunctionContext,
  site: ts.Node,
  calleeAnyLocal: number,
  argLocals: readonly number[],
): void {
  if (!ctx.standalone) return;
  if (!nodeCanSeeRuntimeEvalCallable(site)) return;
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
  const driverIdx = reserveRuntimeEvalConstructDriver(ctx, stringConstantExternrefInstrs(ctx, "prototype"));

  const priorLocal = allocLocal(fctx, `__rec_prior_${fctx.locals.length}`, EXTERNREF);
  const argvLocal = allocLocal(fctx, `__rec_argv_${fctx.locals.length}`, EXTERNREF);
  const arm: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: argvLocal },
  ];
  for (const argLocal of argLocals) {
    arm.push(
      { op: "local.get", index: argvLocal },
      { op: "local.get", index: argLocal },
      { op: "call", funcIdx: objVecPushIdx },
    );
  }
  arm.push(
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
      then: arm,
      else: [{ op: "local.get", index: priorLocal }],
    },
  );
}

/**
 * Fill the reserved driver once `__apply_closure`, the carrier types and the
 * object-model helpers are registered. No-op when no site reserved one.
 */
export function fillRuntimeEvalConstructDriver(ctx: CodegenContext): void {
  const driverIdx = ctx.funcMap.get(DRIVER_NAME);
  if (driverIdx === undefined) return;
  const driver = definedFuncAt(ctx, driverIdx);
  if (!driver) return;

  const carrier = ctx.runtimeEvalAotCallableCarrier;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const objectCreateIdx = ctx.funcMap.get("__object_create");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const protoKeyInstrs = PROTO_KEY_BY_CTX.get(ctx);
  // `__apply_closure` can only invoke a callee with an explicit receiver via a
  // `__call_fn_method_<N>` dispatcher. The multi-file finalize path emits only
  // `__call_fn_0`/`__call_fn_1`, so without one of these the bridge returns its
  // undefined sentinel and the driver would hand back an EMPTY instance instead
  // of the pre-#4438 null. Decline rather than invent one. (#4196's fill states
  // the same constraint for the same reason.)
  const hasReceiverDispatcher = [0, 1, 2, 3, 4, 5, 6, 7, 8].some(
    (n) => ctx.funcMap.get(`__call_fn_method_${n}`) !== undefined,
  );

  if (
    carrier === undefined ||
    !hasReceiverDispatcher ||
    externGetIdx === undefined ||
    objectCreateIdx === undefined ||
    applyClosureIdx === undefined ||
    typeofObjectIdx === undefined ||
    protoKeyInstrs === undefined
  ) {
    // Missing machinery (most commonly: the module never minted a runtime-eval
    // carrier). Degrade to the pre-#4438 value for this site rather than
    // trapping.
    driver.body = [{ op: "ref.null.extern" }];
    driver.locals = [];
    return;
  }

  // 0 = callee, 1 = call-site args ($ObjVec externref)
  const protoLocal = 2;
  const selfLocal = 3;
  const resultLocal = 4;

  const castCarrier: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: carrier.structTypeIdx },
  ];
  const brandEq = (fieldIdx: number, brand: number): Instr[] => [
    ...castCarrier,
    { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx },
    { op: "i32.const", value: brand },
    { op: "i32.eq" },
  ];

  // §10.2.2 step 13, and the null-first ordering the header explains.
  const isObjectProbe: Instr[] = [
    { op: "local.get", index: resultLocal },
    { op: "call", funcIdx: typeofObjectIdx },
  ];
  if (typeofFunctionIdx !== undefined) {
    isObjectProbe.push(
      { op: "local.get", index: resultLocal },
      { op: "call", funcIdx: typeofFunctionIdx },
      { op: "i32.or" },
    );
  }

  driver.body = [
    // Not a branded runtime-eval carrier → the site's pre-#4438 value. Keeps
    // this driver a pure ADDITION for every other dynamic-`new` callee.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: carrier.structTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
    ...brandEq(3, RUNTIME_EVAL_AOT_CALLABLE_BRAND_A),
    ...brandEq(4, RUNTIME_EVAL_AOT_CALLABLE_BRAND_B),
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },

    // proto = Get(F, "prototype") — §10.2.2 step 3.
    { op: "local.get", index: 0 },
    ...protoKeyInstrs,
    { op: "call", funcIdx: externGetIdx },
    { op: "local.set", index: protoLocal },
    // NOT an Object ⇒ keep the pre-#4438 null. This is the clause that makes a
    // callable with no prototype (an arrow, a method) construct nothing rather
    // than something wrong — see the header.
    { op: "local.get", index: protoLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
    { op: "local.get", index: protoLocal },
    { op: "call", funcIdx: typeofObjectIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },

    // self = OrdinaryObjectCreate(proto)
    { op: "local.get", index: protoLocal },
    { op: "call", funcIdx: objectCreateIdx },
    { op: "local.set", index: selfLocal },

    // result = F.[[Call]](self, args)
    { op: "local.get", index: 0 },
    { op: "local.get", index: selfLocal },
    { op: "local.get", index: 1 },
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
    { name: "__rec_proto", type: EXTERNREF },
    { name: "__rec_self", type: EXTERNREF },
    { name: "__rec_result", type: EXTERNREF },
  ];
}
