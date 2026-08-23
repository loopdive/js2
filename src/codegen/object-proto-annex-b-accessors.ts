// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4479 slice 2) Annex B §B.2.2 — `Object.prototype.__defineGetter__`,
 * `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` under
 * `--target standalone`.
 *
 * ## What was missing
 *
 * Nothing served these four names host-free. `Object.prototype.__defineGetter__`
 * read as `undefined`, and the ordinary spelling `subject.__defineGetter__(k, f)`
 * therefore died with `TypeError: called value is not a function`. Measured on
 * the standalone lane, `built-ins/Object/prototype/{__defineGetter__,
 * __defineSetter__,__lookupGetter__,__lookupSetter__}` was **0 / 54**.
 *
 * `object-proto-name-in.ts` names the gap explicitly — its
 * `OBJECT_PROTOTYPE_OWN_NAMES` excludes these four because "an `in` answer must
 * not claim a member the read side cannot serve". This module is the read side.
 *
 * ## Why two natives rather than inline emission
 *
 * Both entry points need the same body: the reflective member CLOSURE (reached
 * by `Object.prototype.__defineGetter__.call(o, k, f)` and by a plain value
 * read) and the direct call site (`o.__defineGetter__(k, f)`). The lookup half
 * is a `[[Prototype]]`-chain LOOP, which cannot be duplicated at a call site
 * without duplicating the loop; emitting one native and routing both callers to
 * it keeps a single copy of the semantics and one place to be wrong.
 *
 * ## Everything is composed from natives that already exist
 *
 * No new descriptor storage, no new runtime state:
 *
 * | step | existing native |
 * | --- | --- |
 * | RequireObjectCoercible | `ref.is_null` ∨ `__extern_is_undefined` |
 * | IsCallable | `__typeof_function` |
 * | ToPropertyKey | `__to_property_key` |
 * | DefinePropertyOrThrow (accessor) | `__defineProperty_accessor` |
 * | the extensibility half of its failure case | `__object_isExtensible` + `__hasOwnProperty` |
 * | `O.[[GetOwnProperty]]` | `__getOwnPropertyDescriptor` |
 * | `O.[[GetPrototypeOf]]` | `__getPrototypeOf` |
 * | `desc.[[Get]]` / `desc.[[Set]]` | `__extern_get` |
 *
 * The `__defineProperty_accessor` flag word is the `computeRuntimeFlags`
 * encoding documented in `class-proto-accessors.ts`: bits 4/5 mark
 * enumerable/configurable SPECIFIED, bits 1/2 carry their values, bits 8/9 mark
 * `[[Get]]`/`[[Set]]` SPECIFIED. §B.2.2.2's descriptor is
 * `{[[Get]]: getter, [[Enumerable]]: true, [[Configurable]]: true}` — note it
 * specifies exactly ONE half, which is what makes `__defineGetter__` on an
 * existing accessor PRESERVE its setter (test262 `define-existing.js`). Setting
 * both half-bits would silently clear the other half; leaving both clear means
 * "legacy: both specified", which does the same. So the single bit is
 * load-bearing, not decoration.
 *
 * ## Ordering is observable and is asserted by test262
 *
 * §B.2.2.2 runs RequireObjectCoercible, then IsCallable, then ToPropertyKey.
 * `getter-non-callable.js` passes a key whose `toString` increments a counter
 * and asserts the counter is **0** after five non-callable getters were
 * rejected — i.e. the callable check must precede ToPropertyKey. The native
 * body below is in that order for exactly this reason.
 *
 * ## Deliberate residuals
 *
 * - **Proxy traps.** `define-abrupt.js` / `lookup-*-{get,proto}-err.js` drive
 *   the operation through a Proxy whose `defineProperty` /
 *   `getOwnPropertyDescriptor` / `getPrototypeOf` trap throws. Whether those
 *   propagate is a property of the natives above, not of this module.
 * - **`in`.** `OBJECT_PROTOTYPE_OWN_NAMES` is left alone: widening it changes
 *   the `in` answer for every ordinary receiver, which is a separate blast
 *   radius from serving the four reads, and no row in this slice needs it.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { compileExpression } from "./expressions.js";
import { coerceType } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

/**
 * The four Annex B §B.2.2 accessor members and their spec arity. This is the
 * SINGLE declaration of that arity: `array-object-proto.ts` spreads it into
 * `PROTO_METHOD_LENGTH`, from which `ensureStandaloneNativeMethodClosure`
 * derives both the reported `.length` and the reflective closure's PARAM SLOT
 * COUNT — so a second copy that drifted would silently give the body fewer arg
 * locals than it reads.
 */
export const ANNEX_B_ACCESSOR_ARITY: Readonly<Record<string, number>> = {
  __defineGetter__: 2,
  __defineSetter__: 2,
  __lookupGetter__: 1,
  __lookupSetter__: 1,
};

/** True for a member name this module serves. */
function isAnnexBAccessorMember(member: string): boolean {
  return Object.prototype.hasOwnProperty.call(ANNEX_B_ACCESSOR_ARITY, member);
}

/**
 * §B.2.2.2 / §B.2.2.3 descriptor attributes in the `__defineProperty_accessor`
 * host flag word: enumerable specified-and-true, configurable
 * specified-and-true, and exactly one of `[[Get]]`/`[[Set]]` marked SPECIFIED.
 */
const ENUMERABLE_TRUE = (1 << 4) | (1 << 1);
const CONFIGURABLE_TRUE = (1 << 5) | (1 << 2);
const GET_SPECIFIED = 1 << 8;
const SET_SPECIFIED = 1 << 9;
const DEFINE_GETTER_FLAGS = ENUMERABLE_TRUE | CONFIGURABLE_TRUE | GET_SPECIFIED;
const DEFINE_SETTER_FLAGS = ENUMERABLE_TRUE | CONFIGURABLE_TRUE | SET_SPECIFIED;

/**
 * A `[[Prototype]]` walk is acyclic by construction here
 * (`__object_setPrototypeOf` refuses to build a cycle and `__getPrototypeOf`
 * answers null for every non-`$Object` link), so this bound can never be
 * reached by a real program. It exists so that a future representation change
 * cannot turn a lookup into a compiler-visible HANG — a wrong `undefined` is
 * recoverable, a hung test262 shard is not.
 */
const PROTO_WALK_LIMIT = 1024;

/** `(externref) -> i32`: the value is `null` OR `undefined` (RequireObjectCoercible). */
function nullishInstrs(valueLocal: number, isUndefinedIdx: number): Instr[] {
  return [
    { op: "local.get", index: valueLocal },
    { op: "ref.is_null" },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.or" },
  ];
}

/**
 * The funcIdxs both natives need. Resolved in ONE place, with every
 * import-adding call made BEFORE any body is built and every index re-fetched
 * BY NAME afterwards — the #2039 shift discipline. Returns `null` when any
 * piece is unavailable, so the callers keep their pre-existing behaviour rather
 * than emitting a half-body.
 */
function resolveAnnexBDeps(ctx: CodegenContext): {
  isUndefined: number;
  toPropertyKey: number;
  typeofFunction: number;
  defineAccessor: number;
  isExtensible: number;
  hasOwn: number;
  gopd: number;
  getPrototypeOf: number;
  externGet: number;
} | null {
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__defineProperty_accessor", [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF, F64], [EXTERNREF]);
  ensureLateImport(ctx, "__object_isExtensible", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__hasOwnProperty", [EXTERNREF, EXTERNREF], [I32]);
  ensureLateImport(ctx, "__getOwnPropertyDescriptor", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__getPrototypeOf", [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, null);
  const names = [
    "__extern_is_undefined",
    "__to_property_key",
    "__typeof_function",
    "__defineProperty_accessor",
    "__object_isExtensible",
    "__hasOwnProperty",
    "__getOwnPropertyDescriptor",
    "__getPrototypeOf",
    "__extern_get",
  ] as const;
  const idxs = names.map((name) => ctx.funcMap.get(name));
  if (idxs.some((idx) => idx === undefined)) return null;
  const [
    isUndefined,
    toPropertyKey,
    typeofFunction,
    defineAccessor,
    isExtensible,
    hasOwn,
    gopd,
    getPrototypeOf,
    externGet,
  ] = idxs as number[];
  return {
    isUndefined: isUndefined!,
    toPropertyKey: toPropertyKey!,
    typeofFunction: typeofFunction!,
    defineAccessor: defineAccessor!,
    isExtensible: isExtensible!,
    hasOwn: hasOwn!,
    gopd: gopd!,
    getPrototypeOf: getPrototypeOf!,
    externGet: externGet!,
  };
}

/**
 * Register (idempotently) `__annexb_define_accessor(O, P, fn, isSetter) ->
 * externref` — §B.2.2.2 / §B.2.2.3. Returns the func handle, or -1 when a
 * dependency is unavailable.
 */
export function ensureAnnexBDefineAccessor(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__annexb_define_accessor");
  if (cached !== undefined) return cached;
  const deps = resolveAnnexBDeps(ctx);
  if (!deps) return -1;

  // Built BEFORE the body so neither can register a late import mid-emission.
  const undefInstrs = canonicalUndefinedExternInstrs(ctx);
  const throwNotCoercible = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Object.prototype.__defineGetter__/__defineSetter__ called on null or undefined",
    { forceInModuleCtor: true },
  );
  const throwNotCallable = buildThrowJsErrorInstrs(ctx, "TypeError", "Getter/setter must be a function", {
    forceInModuleCtor: true,
  });
  const throwNotExtensible = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Cannot define property, object is not extensible",
    {
      forceInModuleCtor: true,
    },
  );

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF, EXTERNREF, I32], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__annexb_define_accessor", funcIdx);

  const O = 0;
  const P = 1;
  const FN = 2;
  const IS_SETTER = 3;
  const KEY = 4;

  const body: Instr[] = [
    // 1. RequireObjectCoercible(this).
    ...nullishInstrs(O, deps.isUndefined),
    { op: "if", blockType: { kind: "empty" }, then: throwNotCoercible },
    // 2. If IsCallable(getter/setter) is false, throw — BEFORE ToPropertyKey.
    { op: "local.get", index: FN },
    { op: "call", funcIdx: deps.typeofFunction },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwNotCallable },
    // 3. key = ToPropertyKey(P).
    { op: "local.get", index: P },
    { op: "call", funcIdx: deps.toPropertyKey },
    { op: "local.set", index: KEY },
    // 4. DefinePropertyOrThrow's extensibility failure: a NEW key on a
    //    non-extensible object is a `false` return, which must THROW here.
    //    `__defineProperty_accessor` treats it as a lenient no-op (its own
    //    contract), so the check lives at this call site.
    { op: "local.get", index: O },
    { op: "call", funcIdx: deps.isExtensible },
    { op: "i32.eqz" },
    { op: "local.get", index: O },
    { op: "local.get", index: KEY },
    { op: "call", funcIdx: deps.hasOwn },
    { op: "i32.eqz" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: throwNotExtensible },
    // 5. DefinePropertyOrThrow(O, key, desc).
    { op: "local.get", index: O },
    { op: "local.get", index: KEY },
    { op: "local.get", index: IS_SETTER },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "ref.null.extern" }],
      else: [{ op: "local.get", index: FN }],
    },
    { op: "local.get", index: IS_SETTER },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: FN }],
      else: [{ op: "ref.null.extern" }],
    },
    { op: "local.get", index: IS_SETTER },
    {
      op: "if",
      blockType: { kind: "val", type: F64 },
      then: [{ op: "f64.const", value: DEFINE_SETTER_FLAGS }],
      else: [{ op: "f64.const", value: DEFINE_GETTER_FLAGS }],
    },
    { op: "call", funcIdx: deps.defineAccessor },
    { op: "drop" },
    // 6. Return undefined.
    ...undefInstrs,
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__annexb_define_accessor",
    typeIdx,
    locals: [{ name: "key", type: EXTERNREF }],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * Register (idempotently) `__annexb_lookup_accessor(O, P, half) -> externref` —
 * §B.2.2.4 / §B.2.2.5. `half` is the descriptor field name to read, `"get"` or
 * `"set"`, pushed by the caller so the loop needs no branch of its own.
 * Returns the func handle, or -1 when a dependency is unavailable.
 */
export function ensureAnnexBLookupAccessor(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__annexb_lookup_accessor");
  if (cached !== undefined) return cached;
  const deps = resolveAnnexBDeps(ctx);
  if (!deps) return -1;

  const undefInstrs = canonicalUndefinedExternInstrs(ctx);
  const throwNotCoercible = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Object.prototype.__lookupGetter__/__lookupSetter__ called on null or undefined",
    { forceInModuleCtor: true },
  );

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF, EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__annexb_lookup_accessor", funcIdx);

  const O = 0;
  const P = 1;
  const HALF = 2;
  const KEY = 3;
  const CUR = 4;
  const DESC = 5;
  const RESULT = 6;
  const GUARD = 7;

  const body: Instr[] = [
    // 1. RequireObjectCoercible(this).
    ...nullishInstrs(O, deps.isUndefined),
    { op: "if", blockType: { kind: "empty" }, then: throwNotCoercible },
    // 2. key = ToPropertyKey(P) ; cur = O ; result = undefined.
    { op: "local.get", index: P },
    { op: "call", funcIdx: deps.toPropertyKey },
    { op: "local.set", index: KEY },
    { op: "local.get", index: O },
    { op: "local.set", index: CUR },
    ...undefInstrs,
    { op: "local.set", index: RESULT },
    // 3. Walk the prototype chain. Branch depths inside the `if` bodies:
    //    0 = the if, 1 = the loop, 2 = the enclosing block.
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // d. If cur is null, return undefined.
            ...nullishInstrs(CUR, deps.isUndefined),
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "br", depth: 2 }] },
            // a. desc = cur.[[GetOwnProperty]](key)
            { op: "local.get", index: CUR },
            { op: "local.get", index: KEY },
            { op: "call", funcIdx: deps.gopd },
            { op: "local.set", index: DESC },
            // b. If desc is not undefined, answer from it and stop — a DATA
            //    descriptor reads back `undefined` for the accessor half, which
            //    is step b.ii's answer, so no IsAccessorDescriptor test is
            //    needed to distinguish the two.
            ...nullishInstrs(DESC, deps.isUndefined),
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: DESC },
                { op: "local.get", index: HALF },
                { op: "call", funcIdx: deps.externGet },
                { op: "local.set", index: RESULT },
                { op: "br", depth: 2 },
              ],
            },
            // c. cur = cur.[[GetPrototypeOf]]()
            { op: "local.get", index: CUR },
            { op: "call", funcIdx: deps.getPrototypeOf },
            { op: "local.set", index: CUR },
            // Loop-bound backstop (see PROTO_WALK_LIMIT).
            { op: "local.get", index: GUARD },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.tee", index: GUARD },
            { op: "i32.const", value: PROTO_WALK_LIMIT },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: RESULT },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__annexb_lookup_accessor",
    typeIdx,
    locals: [
      { name: "key", type: EXTERNREF },
      { name: "cur", type: EXTERNREF },
      { name: "desc", type: EXTERNREF },
      { name: "result", type: EXTERNREF },
      { name: "guard", type: I32 },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * The reflective member-closure body for the four Annex B accessors, for
 * `makeGlue`'s `Object` arm. The closure ABI is `(self, this, …args)`, so the
 * receiver is local 1 and the first argument local 2 — `ANNEX_B_ACCESSOR_ARITY`
 * is what guarantees those arg slots exist.
 *
 * Returns `null` to DECLINE for any other member (and when the natives are
 * unavailable), so the caller keeps its existing refusal.
 */
export function emitObjectProtoAnnexBAccessorBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null {
  if (!isAnnexBAccessorMember(member)) return null;
  if (!ctx.standalone) return null;
  const isDefine = member === "__defineGetter__" || member === "__defineSetter__";
  const isSetterHalf = member === "__defineSetter__" || member === "__lookupSetter__";
  const nativeIdx = isDefine ? ensureAnnexBDefineAccessor(ctx) : ensureAnnexBLookupAccessor(ctx);
  if (nativeIdx < 0) return null;
  const half = isSetterHalf ? "set" : "get";
  if (!isDefine) addStringConstantGlobal(ctx, half);
  flushLateImportShifts(ctx, fctx);
  const resolvedIdx = ctx.funcMap.get(isDefine ? "__annexb_define_accessor" : "__annexb_lookup_accessor");
  if (resolvedIdx === undefined) return null;

  const argSlot = (i: number): Instr =>
    fctx.params.length > i ? { op: "local.get", index: i } : { op: "ref.null.extern" };

  fctx.body.push({ op: "local.get", index: 1 }); // `this`
  fctx.body.push(argSlot(2)); // P
  if (isDefine) {
    fctx.body.push(argSlot(3)); // getter / setter
    fctx.body.push({ op: "i32.const", value: isSetterHalf ? 1 : 0 });
  } else {
    for (const instr of stringConstantExternrefInstrs(ctx, half)) fctx.body.push(instr);
  }
  fctx.body.push({ op: "call", funcIdx: resolvedIdx });
  return EXTERNREF;
}

/**
 * True when `name` on this call site resolves to a USER declaration rather than
 * the (undeclared) Annex B builtin. `lib.es5.d.ts` does not declare these four
 * names at all, so any declaration the oracle can find in a non-declaration
 * file is the program's own — and the fold must decline rather than hijack it.
 */
function memberIsUserDeclared(ctx: CodegenContext, nameNode: ts.MemberName): boolean {
  const decls = ctx.oracle.declarationsOf(nameNode);
  return decls.some((decl) => !decl.getSourceFile().isDeclarationFile);
}

/**
 * The DIRECT call site — `subject.__defineGetter__(k, f)` /
 * `subject.__lookupGetter__(k)` on an ordinary receiver, which is how every
 * test262 row but `this-non-obj.js` spells it.
 *
 * Returns `undefined` to DECLINE (leaving the caller's existing dispatch
 * untouched) for every non-standalone lane, every other member name, a
 * user-declared member of the same name, and any arity the spec does not
 * define. Declining costs nothing new; a wrong claim would shadow a real
 * user method.
 */
export function tryCompileAnnexBAccessorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  expr: ts.CallExpression,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  const member = propAccess.name.text;
  if (!isAnnexBAccessorMember(member)) return undefined;
  if (expr.arguments.some((arg) => ts.isSpreadElement(arg))) return undefined;
  if (memberIsUserDeclared(ctx, propAccess.name)) return undefined;
  const isDefine = member === "__defineGetter__" || member === "__defineSetter__";
  const isSetterHalf = member === "__defineSetter__" || member === "__lookupSetter__";
  const nativeIdx = isDefine ? ensureAnnexBDefineAccessor(ctx) : ensureAnnexBLookupAccessor(ctx);
  if (nativeIdx < 0) return undefined;
  const half = isSetterHalf ? "set" : "get";
  if (!isDefine) addStringConstantGlobal(ctx, half);
  flushLateImportShifts(ctx, fctx);
  const resolvedIdx = ctx.funcMap.get(isDefine ? "__annexb_define_accessor" : "__annexb_lookup_accessor");
  if (resolvedIdx === undefined) return undefined;

  const pushAsExternref = (node: ts.Expression | undefined): void => {
    if (node === undefined) {
      fctx.body.push({ op: "ref.null.extern" });
      return;
    }
    const t = compileExpression(ctx, fctx, node, EXTERNREF);
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  };

  pushAsExternref(propAccess.expression);
  pushAsExternref(expr.arguments[0]);
  if (isDefine) {
    pushAsExternref(expr.arguments[1]);
    fctx.body.push({ op: "i32.const", value: isSetterHalf ? 1 : 0 });
  } else {
    for (const instr of stringConstantExternrefInstrs(ctx, half)) fctx.body.push(instr);
  }
  fctx.body.push({ op: "call", funcIdx: resolvedIdx });
  return EXTERNREF;
}
