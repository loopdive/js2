// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 V11) A writable `[[Prototype]]` on the builtin prototype objects under
 * `--target standalone`.
 *
 * ## The gap (measured on base)
 *
 * A builtin `.prototype` is the `$NativeProto` glue singleton, not a `$Object`,
 * so `Object.setPrototypeOf(Number.prototype, p)` fell through every writer arm
 * and was a silent no-op: `Object.getPrototypeOf(Number.prototype)` still
 * answered `%Object.prototype%`, and the companion consult chain
 * (`proto-index-store.ts`, "Chain depth is 2") jumped from the receiver's brand
 * companion straight to Object's. test262
 * `language/types/reference/put-value-prop-base-primitive.js` re-parents
 * Number/String/Boolean/Symbol.prototype onto a Proxy and expects
 * `0..x = null` to reach its `set` trap (§6.2.4.9 PutValue → ToObject →
 * OrdinarySet → parent.[[Set]](P, V, Receiver = the primitive)).
 *
 * ## The representation
 *
 * The new parent is stored where every other mutable state of a builtin
 * prototype already lives: on its brand COMPANION `$Object`, as that
 * companion's own `[[Prototype]]`. The write simply recurses into
 * `__object_setPrototypeOf(companion, V)`, so the §10.1.2.1 checks (SameValue,
 * extensibility, the cycle walk), the #6766 Proxy LINK encoding and the
 * explicit-null flag all apply unchanged. A companion is RE-PARENTED when its
 * `$proto` is non-null or it carries the explicit-null flag; a fresh companion
 * has neither, which keeps the implicit `brand → Object.prototype` chain.
 *
 * `%Object.prototype%` is an immutable-prototype exotic object (§10.4.7): a
 * request for anything but its current value (`null`) answers `false`.
 *
 * ## The arms (all prepended at FINALIZE, after the store's bodies are filled)
 *
 *  - `__object_setPrototypeOf{,_status}`: a `$NativeProto` receiver re-targets
 *    at its companion (minted on demand).
 *  - `__getPrototypeOf`: a `$NativeProto` with a re-parented companion answers
 *    the companion's `[[Prototype]]` (a link answers its Proxy).
 *  - `__protoidx_get_k` / `__protoidx_has_k`: a key the re-parented companion
 *    does not own continues at the STORED parent — `__reflect_get_receiver`
 *    with the ORIGINAL receiver, or `__extern_has` — instead of Object's
 *    companion. Both dispatch a Proxy parent to its trap.
 *  - `__protoidx_set_r` (when #4504 reserved it) and, otherwise, the head of
 *    `__extern_set` for a non-`$Object` receiver: `__reflect_set_receiver`
 *    on the stored parent with the original receiver.
 *
 * ## Gate — zero cost elsewhere
 *
 * Everything above is emitted only under `ctx.builtinProtoReparentDirty`, a
 * PRE-SCAN flag ({@link isBuiltinProtoReparentNode}): the module syntactically
 * re-parents `<BrandedBuiltin>.prototype` (`Object.setPrototypeOf`,
 * `Reflect.setPrototypeOf`, or a `.__proto__ =` write). A re-parent reached
 * only through an alias (`var p = Number.prototype; Object.setPrototypeOf(p, …)`)
 * or eval'd code keeps the pre-V11 silent no-op — recorded, not hidden.
 */
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { ts } from "../../ts-api.js";
import { addFuncType } from "../registry/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import {
  BUILTIN_BRAND_BASE,
  BUILTIN_BRAND_COUNT,
  builtinBrandOffsetOf,
  isBrandedBuiltinName,
} from "../../runtime/contracts/builtin-brands.js";

/** `$Object` layout (object-runtime.ts): `$proto` and `flags`. */
const OBJECT_PROTO_FIELD = 0;
const OBJECT_FLAGS_FIELD = 4;
/** MUST equal `OBJ_FLAG_NULL_PROTO` in object-runtime.ts. */
const OBJ_FLAG_NULL_PROTO = 0x80;
/** `$NativeProto.$brand` (prototype-layouts.ts). */
const NATIVE_PROTO_BRAND_FIELD = 0;
/** MUST equal `SET_DECISION_*` in proto-index-store.ts (not imported: SCC). */
const SET_DECISION_MISS = 0;
const SET_DECISION_HANDLED = 2;
const SET_DECISION_REFUSED = 3;
const OBJ_OFF = builtinBrandOffsetOf("Object")!;

const REPARENTED = "__protoidx_reparented";
const REPARENT_SET = "__protoidx_reparent_set";
/** Reserved by `reserveProtoIndexStore` (identity stub) under the same gate. */
const REPARENT_GPO = "__protoidx_reparent_gpo";

const foldingNow = new WeakSet<ts.Node>();

/**
 * `Object.getPrototypeOf(X.prototype)` in a re-parenting module: the caller
 * pushes `X.prototype`, then re-compiles the call (which now takes the ordinary
 * fold), then calls the returned helper index, which answers the stored parent
 * when the companion is re-parented and the fold otherwise. `undefined` = not
 * armed (or already inside the fold) — compile as before.
 */
export function reparentGetPrototypeOfHelper(ctx: CodegenContext, call: ts.CallExpression): number | undefined {
  if (!ctx.standalone || ctx.builtinProtoReparentDirty !== true || foldingNow.has(call)) return undefined;
  const arg0 = call.arguments[0];
  if (arg0 === undefined || !isBuiltinPrototypeRef(arg0)) return undefined;
  return ctx.funcMap.get(REPARENT_GPO);
}

/** Run `compileFold` with the re-entry guard set for `call`. */
export function withReparentFold<T>(call: ts.CallExpression, compileFold: () => T): T {
  foldingNow.add(call);
  try {
    return compileFold();
  } finally {
    foldingNow.delete(call);
  }
}

/** `X.prototype` where `X` is a branded builtin global. */
function isBuiltinPrototypeRef(node: ts.Node): boolean {
  let cur = node;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return (
    ts.isPropertyAccessExpression(cur) &&
    cur.name.text === "prototype" &&
    ts.isIdentifier(cur.expression) &&
    isBrandedBuiltinName(cur.expression.text)
  );
}

/**
 * PRE-SCAN predicate: does `node` re-parent a builtin prototype?
 * `Object.setPrototypeOf(X.prototype, v)`, `Reflect.setPrototypeOf(X.prototype, v)`
 * or `X.prototype.__proto__ = v`.
 */
export function isBuiltinProtoReparentNode(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "setPrototypeOf" &&
      ts.isIdentifier(callee.expression) &&
      (callee.expression.text === "Object" || callee.expression.text === "Reflect") &&
      node.arguments.length > 0 &&
      isBuiltinPrototypeRef(node.arguments[0]!)
    );
  }
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === "__proto__" &&
    isBuiltinPrototypeRef(node.left.expression)
  );
}

/**
 * `true.x = v` / `''.x = v` / `Symbol().x = v` in SLOPPY code of a re-parenting
 * module: the write must reach `__extern_set`, because a re-parented wrapper
 * prototype can observe it (a Proxy parent's `set` trap). The base lowering
 * drops it (boolean / symbol) or folds it to a no-op.
 */
export function isReparentObservablePrimitiveWrite(
  ctx: CodegenContext,
  expr: ts.BinaryExpression,
  lhs: ts.Expression,
  isStrict: () => boolean,
): lhs is ts.PropertyAccessExpression & { name: ts.Identifier } {
  return (
    ctx.standalone === true &&
    ctx.builtinProtoReparentDirty === true &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(lhs) &&
    ts.isIdentifier(lhs.name) &&
    lhs.name.text !== "__proto__" &&
    ["boolean", "string", "symbol"].includes(ctx.oracle.staticJsTypeOf(lhs.expression)) &&
    !isStrict()
  );
}

/** Function indices the arms bake (all resolved at FINALIZE). */
export interface NativeProtoReparentDeps {
  readonly objectTypeIdx: number;
  readonly companionIdx: number;
  readonly brandOffIdx: number;
  readonly objFindIdx: number;
  /** The canonical `undefined` externref (or `ref.null.extern` off the singleton regime). */
  readonly undefinedValue: () => Instr[];
}

const l = (index: number): Instr => ({ op: "local.get", index });
const call = (funcIdx: number): Instr => ({ op: "call", funcIdx });
const ifThen = (then: Instr[]): Instr => ({ op: "if", blockType: { kind: "empty" }, then });

function fnByName(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const idx = ctx.funcMap.get(name);
  return idx === undefined ? undefined : definedFuncAt(ctx, idx);
}

/** Append one scratch local to `fn` and return its index (`paramCount` = the type's param count). */
function addLocal(fn: WasmFunction, paramCount: number, name: string, type: ValType): number {
  const index = paramCount + fn.locals.length;
  fn.locals.push({ name, type });
  return index;
}

function defineHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
): number {
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx: addFuncType(ctx, params, results), locals, body, exported: false });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * FINALIZE — splice every V11 arm. No-op unless the pre-scan armed the module
 * and the companion store, `$NativeProto` and the prototype natives all exist.
 */
export function spliceNativeProtoReparentArms(ctx: CodegenContext, deps: NativeProtoReparentDeps): void {
  if (!ctx.standalone || ctx.builtinProtoReparentDirty !== true) return;
  if (ctx.funcMap.has(REPARENTED)) return;
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  const getProtoIdx = ctx.funcMap.get("__getPrototypeOf");
  const setProto = fnByName(ctx, "__object_setPrototypeOf");
  const setProtoIdx = ctx.funcMap.get("__object_setPrototypeOf");
  if (npTypeIdx === undefined || getProtoIdx === undefined || !setProto || setProtoIdx === undefined) return;
  const { objectTypeIdx: obj, companionIdx, brandOffIdx, objFindIdx } = deps;
  const ext: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const asObject = (local: number): Instr[] => [
    l(local),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: obj },
  ];

  // __protoidx_reparented(off) -> the brand's companion when it is RE-PARENTED, else null.
  const reparented = defineHelper(
    ctx,
    REPARENTED,
    [i32],
    [ext],
    [{ name: "c", type: ext }],
    [
      l(0),
      { op: "i32.const", value: OBJ_OFF },
      { op: "i32.eq" },
      ifThen([{ op: "ref.null.extern" }, { op: "return" }]),
      l(0),
      { op: "i32.const", value: 0 },
      call(companionIdx),
      { op: "local.tee", index: 1 },
      { op: "ref.is_null" },
      ifThen([{ op: "ref.null.extern" }, { op: "return" }]),
      ...asObject(1),
      { op: "struct.get", typeIdx: obj, fieldIdx: OBJECT_PROTO_FIELD },
      { op: "ref.is_null" },
      ifThen([
        ...asObject(1),
        { op: "struct.get", typeIdx: obj, fieldIdx: OBJECT_FLAGS_FIELD },
        { op: "i32.const", value: OBJ_FLAG_NULL_PROTO },
        { op: "i32.and" },
        { op: "i32.eqz" },
        ifThen([{ op: "ref.null.extern" }, { op: "return" }]),
      ]),
      l(1),
    ],
  );

  /**
   * `if (P = reparented(<off>)) && !own(P, key) { P = [[GetPrototypeOf]](P); <onParent> }`
   * — `onParent` sees the stored parent in `pLocal` and must return.
   */
  const continueAtParent = (off: Instr[], keyLocal: number, pLocal: number, onParent: Instr[]): Instr[] => [
    ...off,
    call(reparented),
    { op: "local.tee", index: pLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    ifThen([
      ...asObject(pLocal),
      l(keyLocal),
      call(objFindIdx),
      { op: "ref.is_null" },
      ifThen([l(pLocal), call(getProtoIdx), { op: "local.set", index: pLocal }, ...onParent]),
    ]),
  ];

  // [[SetPrototypeOf]] / its boolean: a `$NativeProto` re-targets at its companion.
  const spliceSetter = (fn: WasmFunction, selfIdx: number, status: boolean): void => {
    const off = addLocal(fn, 2, "__v11_off", i32);
    fn.body.unshift(
      l(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: npTypeIdx },
      ifThen([
        l(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: npTypeIdx },
        { op: "struct.get", typeIdx: npTypeIdx, fieldIdx: NATIVE_PROTO_BRAND_FIELD },
        { op: "i32.const", value: BUILTIN_BRAND_BASE },
        { op: "i32.sub" },
        { op: "local.tee", index: off },
        { op: "i32.const", value: OBJ_OFF },
        { op: "i32.eq" },
        // §10.4.7.1 SetImmutablePrototype: true only for SameValue(V, null).
        ifThen(status ? [l(1), { op: "ref.is_null" }, { op: "return" }] : [l(0), { op: "return" }]),
        l(off),
        { op: "i32.const", value: BUILTIN_BRAND_COUNT },
        { op: "i32.lt_u" },
        ifThen([
          l(off),
          { op: "i32.const", value: 1 },
          call(companionIdx),
          l(1),
          call(selfIdx),
          ...(status ? [] : ([{ op: "drop" }, l(0)] satisfies Instr[])),
          { op: "return" },
        ]),
      ]),
    );
  };
  spliceSetter(setProto, setProtoIdx, false);
  const statusIdx = ctx.funcMap.get("__object_setPrototypeOf_status");
  const status = fnByName(ctx, "__object_setPrototypeOf_status");
  if (status && statusIdx !== undefined) spliceSetter(status, statusIdx, true);

  // The compile-time getPrototypeOf fold's runtime override (reserved by the store).
  const gpo = fnByName(ctx, REPARENT_GPO);
  if (gpo) {
    gpo.locals = [];
    gpo.body = [
      l(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: npTypeIdx },
      ifThen([
        l(0),
        call(brandOffIdx),
        call(reparented),
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        ifThen([l(0), call(getProtoIdx), { op: "return" }]),
      ]),
      l(1),
    ];
  }

  // [[GetPrototypeOf]] of a re-parented builtin prototype.
  const getProto = fnByName(ctx, "__getPrototypeOf");
  if (getProto) {
    const p = addLocal(getProto, 1, "__v11_p", ext);
    getProto.body.unshift(
      l(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: npTypeIdx },
      ifThen([
        l(0),
        call(brandOffIdx),
        call(reparented),
        { op: "local.tee", index: p },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        ifThen([l(p), call(getProtoIdx), { op: "return" }]),
      ]),
    );
  }

  // [[Get]] through the companions: (recv, key, off).
  const getK = fnByName(ctx, "__protoidx_get_k");
  const reflectGet = ctx.funcMap.get("__reflect_get_receiver");
  if (getK && reflectGet !== undefined) {
    const p = addLocal(getK, 3, "__v11_p", ext);
    getK.body.unshift(
      ...continueAtParent([l(2)], 1, p, [
        l(p),
        { op: "ref.is_null" },
        ifThen([...deps.undefinedValue(), { op: "return" }]),
        l(p),
        l(1),
        l(0),
        call(reflectGet),
        { op: "return" },
      ]),
    );
  }

  // [[HasProperty]] through the companions: (key, off).
  const hasK = fnByName(ctx, "__protoidx_has_k");
  const externHas = ctx.funcMap.get("__extern_has");
  if (hasK && externHas !== undefined) {
    const p = addLocal(hasK, 2, "__v11_p", ext);
    hasK.body.unshift(
      ...continueAtParent([l(1)], 0, p, [
        l(p),
        { op: "ref.is_null" },
        ifThen([{ op: "i32.const", value: 0 }, { op: "return" }]),
        l(p),
        l(0),
        call(externHas),
        { op: "return" },
      ]),
    );
  }

  // [[Set]]: (recv, key, value) -> SET_DECISION_*.
  const reflectSet = ctx.funcMap.get("__reflect_set_receiver");
  if (reflectSet === undefined) return;
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  const reparentSet = defineHelper(
    ctx,
    REPARENT_SET,
    [ext, ext, ext],
    [i32],
    [{ name: "p", type: ext }],
    [
      // An OWN property of the receiver (a string's `length`/indices, a bag
      // expando) is not this arm's business.
      ...(hasOwnIdx === undefined
        ? []
        : [l(0), l(1), call(hasOwnIdx), ifThen([{ op: "i32.const", value: SET_DECISION_MISS }, { op: "return" }])]),
      ...continueAtParent([l(0), call(brandOffIdx)], 1, 3, [
        // Explicit-null parent: no inherited descriptor — the ordinary create.
        l(3),
        { op: "ref.is_null" },
        ifThen([{ op: "i32.const", value: SET_DECISION_MISS }, { op: "return" }]),
        l(3),
        l(1),
        l(2),
        l(0),
        call(reflectSet),
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [{ op: "i32.const", value: SET_DECISION_HANDLED }],
          else: [{ op: "i32.const", value: SET_DECISION_REFUSED }],
        },
        { op: "return" },
      ]),
      { op: "i32.const", value: SET_DECISION_MISS },
    ],
  );
  const setR = fnByName(ctx, "__protoidx_set_r");
  if (setR) {
    // params 0..2; local 3 (`firstOff`) is rewritten by the body before use.
    setR.body.unshift(
      l(0),
      l(1),
      l(2),
      call(reparentSet),
      { op: "local.tee", index: 3 },
      ifThen([l(3), { op: "return" }]),
    );
    return;
  }
  // No #4504 decision channel: a non-`$Object`, non-`$NativeProto` receiver
  // (a primitive, a vec, a closure) asks here before its no-bag no-op.
  const externSet = fnByName(ctx, "__extern_set");
  if (!externSet) return;
  externSet.body.unshift(
    l(0),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: obj },
    l(0),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: npTypeIdx },
    { op: "i32.or" },
    { op: "i32.eqz" },
    ifThen([l(0), l(1), l(2), call(reparentSet), ifThen([{ op: "return" }])]),
  );
}
