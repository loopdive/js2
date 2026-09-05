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
import type { Instr, TypeDef, ValType, WasmFunction } from "../ir/types.js";
import { addFuncType } from "./registry/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A, RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B } from "./runtime-eval-boundary.js";

const EXTERNREF: ValType = { kind: "externref" };
const DRIVER_PREFIX = "__native_construct_";
const TYPED_DRIVER_PREFIX = "__native_typed_construct_";

interface TypedNativeConstructDriver {
  readonly name: string;
  readonly arity: number;
  readonly func: WasmFunction;
}

const typedDriversByContext = new WeakMap<CodegenContext, TypedNativeConstructDriver[]>();
const typedDriverDedupByContext = new WeakMap<CodegenContext, WeakMap<TypeDef, Map<number, string>>>();

function typedDrivers(ctx: CodegenContext): TypedNativeConstructDriver[] {
  let drivers = typedDriversByContext.get(ctx);
  if (!drivers) {
    drivers = [];
    typedDriversByContext.set(ctx, drivers);
  }
  return drivers;
}

function structFields(definition: TypeDef | undefined) {
  if (definition?.kind === "struct") return definition.fields;
  if (definition?.kind === "sub" && definition.type.kind === "struct") return definition.type.fields;
  return undefined;
}

function defaultFieldInstrs(type: ValType): Instr[] {
  switch (type.kind) {
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    case "f32":
      return [{ op: "f32.const", value: 0 }];
    case "i32":
    case "i8":
    case "i16":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "externref":
    case "ref_extern":
      return [{ op: "ref.null.extern" }];
    case "ref":
    case "ref_null":
      return [{ op: "ref.null", typeIdx: type.typeIdx }];
    case "eqref":
    case "anyref":
      return [{ op: "ref.null.eq" }];
    case "funcref":
      return [{ op: "ref.null.func" }];
    default:
      return [{ op: "i32.const", value: 0 }];
  }
}

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

/**
 * Reserve a constructor-value driver whose fresh `this` has a checker-declared
 * structural result type.
 *
 * TypeScript's parser stores constructors behind namespace-local bindings such
 * as `var TokenConstructor: new (...) => Node`. The runtime value is an ordinary
 * compiled function, but its body declares `this: Mutable<Node>` and therefore
 * cannot run against the generic `$Object` (or a host-created JS object) used by
 * the ordinary dynamic-construct bridges. This driver allocates `$Node` first,
 * invokes the late-bound closure with that exact receiver, and returns either an
 * explicit object result or the initialized receiver per OrdinaryConstruct.
 *
 * The TypeDef object is the deduplication identity. It survives type-index
 * remapping, while the placeholder function's typed local is remapped by the
 * normal module walkers and becomes the authoritative final type at fill time.
 */
export function reserveTypedNativeConstructDriver(
  ctx: CodegenContext,
  arity: number,
  resultTypeIdx: number,
): { name: string; funcIdx: number } | undefined {
  // TypeScript's explicit `this` pseudo-parameter is erased from the closure's
  // JS-visible arity. The method dispatcher carries the allocated receiver in
  // its dedicated `this` channel, so only the source arguments count here.
  if (arity < 0 || arity > MAX_NATIVE_CONSTRUCT_ARITY) return undefined;
  const definition = ctx.mod.types[resultTypeIdx];
  if (!definition || !structFields(definition)) return undefined;

  let dedup = typedDriverDedupByContext.get(ctx);
  if (!dedup) {
    dedup = new WeakMap();
    typedDriverDedupByContext.set(ctx, dedup);
  }
  let byArity = dedup.get(definition);
  if (!byArity) {
    byArity = new Map();
    dedup.set(definition, byArity);
  }
  const existingName = byArity.get(arity);
  if (existingName) {
    const existingIdx = ctx.funcMap.get(existingName);
    if (existingIdx !== undefined) return { name: existingName, funcIdx: existingIdx };
  }

  const drivers = typedDrivers(ctx);
  let ordinal = drivers.length;
  let name = `${TYPED_DRIVER_PREFIX}${arity}_${ordinal}`;
  while (ctx.funcMap.has(name)) name = `${TYPED_DRIVER_PREFIX}${arity}_${++ordinal}`;
  const params = Array.from({ length: arity + 1 }, () => EXTERNREF);
  const typeIdx = addFuncType(ctx, params, [EXTERNREF], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  const func: WasmFunction = {
    name,
    typeIdx,
    // The first local intentionally carries the requested result heap type.
    // Fill reads it back after every type-index remap has completed.
    locals: [{ name: "__typed_ctor_self", type: { kind: "ref", typeIdx: resultTypeIdx } }],
    body: [{ op: "unreachable" }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, func);
  ctx.funcMap.set(name, funcIdx);
  drivers.push({ name, arity, func });
  byArity.set(arity, name);
  return { name, funcIdx };
}

/** Highest reserved driver arity, or -1 when no site reserved one. */
export function maxReservedNativeConstructArity(ctx: CodegenContext): number {
  let maxTyped = -1;
  for (const driver of typedDriversByContext.get(ctx) ?? []) maxTyped = Math.max(maxTyped, driver.arity);
  for (let arity = MAX_NATIVE_CONSTRUCT_ARITY; arity >= 0; arity--) {
    if (ctx.funcMap.has(driverName(arity))) return Math.max(arity, maxTyped);
  }
  return maxTyped;
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

    // (#5196 R3-0) `Proxy` read as a VALUE — `var OProxy =
    // $262.createRealm().global.Proxy; new OProxy(t, h)` — materialises the
    // namespace carrier (`builtin-static-globals.ts` `["Proxy", []]`), a plain
    // `$Object`. Without this arm the driver takes the ordinary
    // `callee.prototype` + `Object.create` tail and the result is not a proxy
    // at all (27 `*-realm*` rows). The decision travels with the VALUE: the
    // test is reference identity against the one carrier global, so EVERY
    // spelling that reaches this driver holding that reference (an alias, a
    // parameter, a property read, a realm-global read) constructs a proxy.
    const proxyCarrierGlobalIdx = ctx.builtinObjectGlobals.get("Proxy");
    const proxyCreateIdx = ctx.funcMap.get("__proxy_create");
    // None of `__proxy_create`, `__proxy_get_dispatch` or the carrier global is
    // a sufficient gate on its own: MEASURED 2026-09-03, all three are present
    // in a program that never mentions `Proxy` (the object runtime builds the
    // proxy natives unconditionally and the namespace globals are pre-seeded),
    // and gating on them changed a Proxy-free program's bytes.
    // `proxyConstructorValueNewSite` is set only by a `new <Proxy-constructor
    // value>` site, so every other module stays byte-identical.
    if (
      ctx.proxyConstructorValueNewSite === true &&
      proxyCarrierGlobalIdx !== undefined &&
      proxyCreateIdx !== undefined
    ) {
      const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type
      const argOrNull = (index: number): Instr =>
        index < arity ? { op: "local.get", index: index + 2 } : { op: "ref.null.extern" };
      body.push(
        // Both sides must be `eq` references for `ref.eq`; a null carrier
        // global (the namespace was never materialised) fails `ref.test` and
        // the arm simply does not fire.
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
        { op: "global.get", index: proxyCarrierGlobalIdx },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "global.get", index: proxyCarrierGlobalIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "ref.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // §28.2.1.1 ProxyCreate(target, handler): a missing argument
                // arrives as null, which `__proxy_create`'s `requireObject`
                // turns into the required TypeError.
                argOrNull(0),
                argOrNull(1),
                { op: "call", funcIdx: proxyCreateIdx },
                { op: "return" },
              ],
            },
          ],
        },
      );
    }

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

  for (const { arity, func: driver } of typedDriversByContext.get(ctx) ?? []) {
    const selfType = driver.locals[0]?.type;
    const selfTypeIdx = selfType?.kind === "ref" || selfType?.kind === "ref_null" ? selfType.typeIdx : undefined;
    const fields = selfTypeIdx === undefined ? undefined : structFields(ctx.mod.types[selfTypeIdx]);
    const closureArityIdx = ctx.funcMap.get("__closure_arity");
    const methodCallIdx = ctx.funcMap.get(`__call_fn_method_${arity}`);
    if (
      selfTypeIdx === undefined ||
      fields === undefined ||
      closureArityIdx === undefined ||
      methodCallIdx === undefined
    ) {
      driver.locals = [];
      driver.body = [{ op: "ref.null.extern" }];
      continue;
    }

    // params: callee=0, args=1..arity. Locals begin after those params.
    const selfLocal = arity + 1;
    const resultLocal = arity + 2;
    const body: Instr[] = [
      // Explicit TypeScript `this` parameters are erased from Function.length.
      // Match the closure's source arity; the dispatcher supplies the allocated
      // receiver through its separate `this` channel.
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: closureArityIdx },
      { op: "i32.const", value: arity },
      { op: "i32.ne" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
    ];
    for (const field of fields) body.push(...defaultFieldInstrs(field.type));
    body.push(
      { op: "struct.new", typeIdx: selfTypeIdx },
      { op: "local.set", index: selfLocal },
      { op: "local.get", index: selfLocal },
      { op: "extern.convert_any" },
      { op: "local.get", index: 0 },
    );
    for (let arg = 0; arg < arity; arg++) body.push({ op: "local.get", index: arg + 1 });
    body.push({ op: "call", funcIdx: methodCallIdx }, { op: "local.set", index: resultLocal });

    const boxedSelf: Instr[] = [{ op: "local.get", index: selfLocal }, { op: "extern.convert_any" }];
    body.push(
      { op: "local.get", index: resultLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: selfTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        // A constructor may explicitly return another instance of the declared
        // result family. Other object/primitive completions cannot satisfy this
        // typed ABI, so retain the initialized receiver.
        then: [{ op: "local.get", index: resultLocal }],
        else: boxedSelf,
      },
    );

    driver.locals = [
      { name: "__typed_ctor_self", type: { kind: "ref", typeIdx: selfTypeIdx } },
      { name: "__typed_ctor_result", type: EXTERNREF },
    ];
    driver.body = body;
  }
}
