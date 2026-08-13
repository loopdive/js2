// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3981 — Wasm-native ordinary [[Construct]] for a first-class function VALUE
 * (`--target standalone` / WASI).
 *
 * ## The gap
 * `new C()` works when `C` is a statically-resolvable function DECLARATION or a
 * class: those reach `compileNewFunctionDeclaration` / the class paths. When the
 * constructor arrives as a first-class VALUE — `const C = mk()`, an IIFE result,
 * an alias of a function expression — standalone had no [[Construct]] at all.
 * The dynamic-`new` tag-dispatch chain's `ref.test`s all decline for a plain
 * closure and the arm falls through to `ref.null.extern`, so `new C()` evaluated
 * to **null with no trap and no diagnostic**.
 *
 * That is the `cookie` package's `standalone · runtime dynamic` failure:
 * `parseCookie` returns `new NullObject()` where `NullObject` is an IIFE-returned
 * function expression, so every caller got null and the first property read threw
 * "Cannot access property on null or undefined".
 *
 * The JS-host lane is unaffected because it routes to the `__construct_closure`
 * bridge, whose `_wrapCallableForHost` construct trap runs the same three steps
 * this driver does natively.
 *
 * ## The lowering (ECMA-262 §10.2.2 OrdinaryCallEvaluateBody, ordinary ctor)
 * One private driver per call-site arity:
 *
 *   __native_construct_<N>(callee, proto, a0 … a<N-1>) -> externref
 *     if (proto == null) proto = __extern_get(callee, "prototype")
 *     self   = __object_create(proto)              ;; fresh $Object, $proto = proto
 *     result = __call_fn_method_<N>(self, callee, a0 … a<N-1>)
 *     return IsObject(result) ? result : self
 *
 * `proto` is passed IN because standalone keeps a user constructor's prototype
 * in two different places. A `F.prototype = …` that `resolveUserFnctorName`
 * recognises is intercepted by #2660 S2 and stored in the per-fnctor module
 * global `$__fnctor_proto_F`; everything else lands in the closure own-property
 * side table (#3468) where `__extern_get` finds it. The call site supplies the
 * global when it resolves and null otherwise, so BOTH storage locations feed the
 * one `$Object.$proto` link — reading only the side table left the instance
 * unlinked and every inherited property read returned undefined.
 *
 * All three helpers already exist in standalone and are the same ones the rest of
 * the object model uses, so the instance is an ordinary `$Object`: dynamic
 * property set/get works, and `Object.getPrototypeOf(new C()) === C.prototype`
 * holds through the ONE `$Object.$proto` link (#2660's invariant).
 *
 * `__call_fn_method_<N>` installs `self` into the `__current_this` global across
 * the inner `call_ref`, which is how the constructor BODY's `this.x = …` reaches
 * the fresh instance. This is the "call a closure with a `this`" channel that
 * #3981 recorded as missing — it exists, it was simply never wired to `new`.
 *
 * ## Why reserve-then-fill
 * `__call_fn_method_<N>` is emitted at FINALIZE, over the complete closure-shape
 * table — it is not in `funcMap` while expression bodies are being compiled. So
 * the call site reserves a stable driver funcIdx with an `unreachable` stub and
 * bakes `call <idx>`; the body is filled in post-processing once the dispatchers
 * exist. Identical discipline to `host-fnctor-method-driver.ts` (#3668) and
 * `accessor-driver.ts` (#1888), and it keeps the late-import index shifter
 * (#329/#1899) authoritative via `funcMap`.
 *
 * ## Byte-neutrality
 * Nothing here is reachable unless a standalone/WASI call site reserved a driver.
 * The JS-host lane never reserves one, so its output is byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A, RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B } from "./runtime-eval-boundary.js";

const EXTERNREF: ValType = { kind: "externref" };
const DRIVER_PREFIX = "__native_construct_";

/** Highest call-site arity a driver is minted for; above it the caller declines. */
export const MAX_NATIVE_CONSTRUCT_ARITY = 8;

function driverName(arity: number): string {
  return `${DRIVER_PREFIX}${arity}`;
}

/**
 * Reserve a stable `(callee, proto, ...args) -> externref` construct driver.
 *
 * `protoKeyInstrs` pushes the `"prototype"` property key as an externref. The
 * caller builds it at RESERVE time (while the string-constant machinery is in
 * its normal mid-compile state) and it is replayed verbatim into the filled
 * body; string-constant globals are append-only and index-stable, so the baked
 * instructions stay valid across the intervening compilation.
 */
export function reserveNativeConstructDriver(ctx: CodegenContext, arity: number, protoKeyInstrs: Instr[]): number {
  const name = driverName(arity);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const params = Array.from({ length: arity + 2 }, () => EXTERNREF);
  const typeIdx = addFuncType(ctx, params, [EXTERNREF], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  ctx.nativeConstructProtoKey.set(arity, protoKeyInstrs);
  return funcIdx;
}

/** Highest reserved driver arity, or -1 when no site reserved one. */
export function maxReservedNativeConstructArity(ctx: CodegenContext): number {
  for (let arity = MAX_NATIVE_CONSTRUCT_ARITY; arity >= 0; arity--) {
    if (ctx.funcMap.has(driverName(arity))) return arity;
  }
  return -1;
}

/**
 * Fill every reserved driver once the public closure-method dispatchers exist.
 *
 * A missing dispatcher or object-model helper leaves the driver returning null
 * rather than trapping: that is the pre-#3981 outcome for the affected site, so
 * a partially-equipped module degrades to the old behaviour instead of taking
 * down an unrelated call.
 */
export function fillNativeConstructDrivers(ctx: CodegenContext): void {
  for (let arity = 0; arity <= MAX_NATIVE_CONSTRUCT_ARITY; arity++) {
    const driverIdx = ctx.funcMap.get(driverName(arity));
    if (driverIdx === undefined) continue;
    const driver = definedFuncAt(ctx, driverIdx);
    if (!driver) continue;

    const externGetIdx = ctx.funcMap.get("__extern_get");
    const objectCreateIdx = ctx.funcMap.get("__object_create");
    const methodCallIdx = ctx.funcMap.get(`__call_fn_method_${arity}`);
    const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
    const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
    const runtimeCallbackTypeIdx = ctx.runtimeEvalInterpretedCallbackTypeIdx;
    const applyClosureIdx = ctx.funcMap.get("__apply_closure");
    const objVecNewIdx = ctx.funcMap.get("__objvec_new");
    const objVecPushIdx = ctx.funcMap.get("__objvec_push");
    const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
    const proxyConstructDispatchIdx = ctx.funcMap.get("__proxy_construct_dispatch");
    const boundaryCallableKindIdx = ctx.funcMap.get("__boundary_object_callable_kind");
    const boundaryConstructIdx = ctx.funcMap.get("__boundary_object_construct");
    const protoKeyInstrs = ctx.nativeConstructProtoKey.get(arity);
    if (externGetIdx === undefined || objectCreateIdx === undefined || protoKeyInstrs === undefined) {
      driver.body = [{ op: "ref.null.extern" }];
      driver.locals = [];
      continue;
    }

    // 0 = callee, 1 = caller-supplied prototype (may be null), 2..arity+1 = args
    const protoLocal = arity + 2;
    const selfLocal = arity + 3;
    const resultLocal = arity + 4;
    const argsVecLocal = arity + 5;

    const buildArgsVec = (): Instr[] => {
      if (objVecNewIdx === undefined || objVecPushIdx === undefined) return [];
      const instrs: Instr[] = [
        { op: "call", funcIdx: objVecNewIdx },
        { op: "local.set", index: argsVecLocal },
      ];
      for (let arg = 0; arg < arity; arg++) {
        instrs.push(
          { op: "local.get", index: argsVecLocal },
          { op: "local.get", index: arg + 2 },
          { op: "call", funcIdx: objVecPushIdx },
        );
      }
      return instrs;
    };

    const body: Instr[] = [];
    const canProxyConstruct =
      proxyTypeIdx !== undefined &&
      proxyConstructDispatchIdx !== undefined &&
      objVecNewIdx !== undefined &&
      objVecPushIdx !== undefined;
    if (canProxyConstruct) {
      body.push(
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: proxyTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...buildArgsVec(),
            { op: "local.get", index: 0 },
            { op: "local.get", index: argsVecLocal },
            // Ordinary `new proxy(...)` uses the proxy itself as NewTarget.
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: proxyConstructDispatchIdx },
            { op: "local.tee", index: resultLocal },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "val", type: EXTERNREF },
              // Missing trap: Construct(proxy.[[ProxyTarget]], args,
              // proxy). Passing the already-selected proxy prototype through
              // preserves the ordinary result's prototype without copying.
              then: [
                { op: "local.get", index: 0 },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: proxyTypeIdx },
                { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: 1 },
                { op: "extern.convert_any" },
                { op: "local.get", index: 1 },
                ...Array.from({ length: arity }, (_, arg) => ({
                  op: "local.get" as const,
                  index: arg + 2,
                })),
                { op: "call", funcIdx: driverIdx },
              ],
              else: [{ op: "local.get", index: resultLocal }],
            },
            { op: "return" },
          ],
        },
      );
    }
    const canBoundaryConstruct =
      boundaryCallableKindIdx !== undefined &&
      boundaryConstructIdx !== undefined &&
      objVecNewIdx !== undefined &&
      objVecPushIdx !== undefined;
    if (canBoundaryConstruct) {
      body.push(
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: boundaryCallableKindIdx },
        { op: "i32.const", value: 2 },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...buildArgsVec(),
            { op: "local.get", index: 0 },
            { op: "local.get", index: argsVecLocal },
            // Null asks the boundary adapter to use the actual constructor as
            // NewTarget. This keeps caller JS identity intact and is the exact
            // ordinary-forward result when no distinct NewTarget is exposed.
            { op: "ref.null.extern" },
            { op: "call", funcIdx: boundaryConstructIdx },
            { op: "return" },
          ],
        },
      );
    }
    body.push(
      // proto = suppliedProto ?? callee.prototype. The `__extern_get` arm reads
      // the closure own-property side table (#3468), which is where a
      // `.prototype` the #2660 S2 interception did not claim ends up. A
      // never-assigned `.prototype` yields null, and `__object_create(null)` is
      // a null-prototype `$Object` — still an ordinary object with working own
      // properties, which is what the construct result must be.
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        then: [{ op: "local.get", index: 0 }, ...protoKeyInstrs, { op: "call", funcIdx: externGetIdx }],
        else: [{ op: "local.get", index: 1 }],
      },
      { op: "local.set", index: protoLocal },

      // self = Object.create(proto)
      { op: "local.get", index: protoLocal },
      { op: "call", funcIdx: objectCreateIdx },
      { op: "local.set", index: selfLocal },
    );

    // result = callee.[[Call]](self, args). Ordinary caller-owned closures keep
    // the proven receiver-aware dispatcher. A provider-owned runtime Function
    // marker cannot enter that module-local classifier, so an exact type+brand
    // arm packs the already-evaluated args and invokes `__apply_closure`.
    const ordinaryCall: Instr[] = [];
    if (methodCallIdx !== undefined) {
      ordinaryCall.push({ op: "local.get", index: selfLocal }, { op: "local.get", index: 0 });
      for (let arg = 0; arg < arity; arg++) ordinaryCall.push({ op: "local.get", index: arg + 2 });
      ordinaryCall.push({ op: "call", funcIdx: methodCallIdx });
    } else {
      // A module may reserve this driver solely for Proxy -> admitted-JS
      // construction. That path has no module-local closure dispatcher, but it
      // must not leave the whole driver as its null placeholder. Only the
      // ordinary Wasm-closure tail is unavailable in that shape.
      ordinaryCall.push({ op: "ref.null.extern" });
    }

    const canApplyRuntimeMarker =
      runtimeCallbackTypeIdx !== undefined &&
      applyClosureIdx !== undefined &&
      objVecNewIdx !== undefined &&
      objVecPushIdx !== undefined;
    if (canApplyRuntimeMarker) {
      const markerBrandsMatch: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: runtimeCallbackTypeIdx },
        { op: "struct.get", typeIdx: runtimeCallbackTypeIdx, fieldIdx: 1 },
        { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A },
        { op: "i32.eq" },
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: runtimeCallbackTypeIdx },
        { op: "struct.get", typeIdx: runtimeCallbackTypeIdx, fieldIdx: 2 },
        { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B },
        { op: "i32.eq" },
        { op: "i32.and" },
      ];
      const markerCall: Instr[] = [
        { op: "call", funcIdx: objVecNewIdx },
        { op: "local.set", index: argsVecLocal },
      ];
      for (let arg = 0; arg < arity; arg++) {
        markerCall.push(
          { op: "local.get", index: argsVecLocal },
          { op: "local.get", index: arg + 2 },
          { op: "call", funcIdx: objVecPushIdx },
        );
      }
      markerCall.push(
        { op: "local.get", index: 0 },
        { op: "local.get", index: selfLocal },
        { op: "local.get", index: argsVecLocal },
        { op: "call", funcIdx: applyClosureIdx },
      );
      body.push(
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: runtimeCallbackTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: markerBrandsMatch,
          else: [{ op: "i32.const", value: 0 }],
        },
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: markerCall,
          else: ordinaryCall,
        },
      );
    } else {
      body.push(...ordinaryCall);
    }
    body.push({ op: "local.set", index: resultLocal });

    // §10.2.2 step 13: `return result` only when the body returned an Object;
    // any other completion value yields the fresh instance.
    //
    // The null test must come FIRST and separately: `__typeof_object(null)` is
    // 1 by design (JS `typeof null === "object"`), so folding null into the
    // typeof probe would return null from `new` — reinstating the exact bug
    // this driver fixes. A returned FUNCTION is also an Object per spec, hence
    // the `__typeof_function` arm.
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

    body.push(
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
    );

    driver.locals = [
      { name: "__ctor_proto", type: EXTERNREF },
      { name: "__ctor_self", type: EXTERNREF },
      { name: "__ctor_result", type: EXTERNREF },
      ...(canApplyRuntimeMarker || canProxyConstruct || canBoundaryConstruct
        ? [{ name: "__ctor_args", type: EXTERNREF }]
        : []),
    ];
    driver.body = body;
  }
}
