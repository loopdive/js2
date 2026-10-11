// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6720) `new <Map|Set|WeakMap|WeakSet carrier held in a value>(…)` in
 * `--target standalone` / WASI.
 *
 * ## The gap
 * The realm object seeds `Map` / `Set` / `WeakMap` / `WeakSet` as the
 * identity-stable `__builtin_ctor_<Name>` `$Object` carriers (#5151). A bare
 * `new Set(xs)` is lowered statically, but once the constructor travels through
 * a VALUE — `var S = root.Set; new S(xs)`, lodash's
 * `var Set = getNative(root, 'Set')`, `new (Map || ListCache)`, a callback
 * parameter — every dynamic-`new` arm declines for a plain `$Object` and the
 * expression evaluated to **null with no trap**.
 *
 * #6711 (PR #6208) started seeding those carriers in the zero-import npm-compat
 * lane too (a runtime-eval module with no provider linked). lodash-es's feature
 * detection then SAW them, took its native-collection branches, and module init
 * died in `_createSet.js`'s `setToArray(new Set([,-0]))` →
 * `TypeError: Cannot access property on null or undefined at 10:22`
 * (`_setToArray.js`, `Array(set.size)`). The seed is right; the construct was
 * the missing half.
 *
 * ## The lowering
 * One helper, `__builtin_collection_dyn_construct(callee, arg0) -> externref`,
 * compares the callee by IDENTITY (`ref.eq`, the same test the Proxy-carrier arm
 * in `native-construct.ts` uses) against each collection carrier global the
 * module actually reserved, and builds the real branded `$Map` through the SAME
 * `__new_<Name>@<n>` constructors `class Sub extends Map` uses (#3972,
 * `standalone-subclass-ctors.ts`): Map/Set consume an array iterable, Weak*
 * build an empty collection when `arg0` is nullish. Any other callee — and a
 * Weak* call with an iterable, which the #3972 carrier does not honour — answers
 * null, the exact pre-#6720 outcome, so every existing dynamic-`new` arm keeps
 * its result.
 *
 * ## Reserve-then-fill, and why the constructors are registered EARLY
 * The helper is reserved (an `unreachable` stub) at the dynamic-`new` site and
 * filled at finalize, when the set of carrier globals is complete. The
 * per-collection constructors, however, bake a TypeError instance and a string
 * constant, which cannot be created at fill time — so they are registered
 * mid-compile, from whichever happens second: the site's reservation (carrier
 * already reserved) or the carrier's reservation (helper already reserved, see
 * `noteBuiltinCollectionCarrierReserved`). Nothing here runs outside
 * standalone/WASI, and a module with no dynamic-`new` site never reserves the
 * helper, so both stay byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { noJsHost } from "./js-errors.js";
import { addFuncType } from "./registry/types.js";
import { emitStandaloneCollectionSuperCtor } from "./standalone-subclass-ctors.js";
import { emitWasiErrorConstructor } from "./registry/error-constructor-delegates.js";

const HELPER_NAME = "__builtin_collection_dyn_construct";
const EXTERNREF: ValType = { kind: "externref" };
const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type
/** Map/Set consume their iterable (arity 1); Weak* are built empty (arity 0). */
const COLLECTIONS: ReadonlyMap<string, number> = new Map([
  ["Map", 1],
  ["Set", 1],
  ["WeakMap", 0],
  ["WeakSet", 0],
]);

/**
 * (#6775 S10) The Error family travels the same way — `var C = nativeErrors[i];
 * new C(msg)` (`NativeErrors/message_property_native_error.js`). Their bare
 * values are the #2907 NAMESPACE carriers (keyed by bare name), and the
 * construct is the same `__new_<Name>` the static `new RangeError(msg)` uses,
 * so the instance is a real `$Error_struct` with its own `message`.
 */
const ERRORS: readonly string[] = [
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
];

function carrierGlobal(ctx: CodegenContext, name: string): number | undefined {
  return ctx.builtinObjectGlobals.get(ERRORS.includes(name) ? name : `ctor:${name}`);
}

function ensureCollectionCtor(ctx: CodegenContext, name: string): void {
  const arity = COLLECTIONS.get(name);
  if (arity !== undefined) emitStandaloneCollectionSuperCtor(ctx, name, arity);
  else if (ERRORS.includes(name)) emitWasiErrorConstructor(ctx, name, 1);
}

/** Hook from the carrier-global reservations: a carrier minted after the site. */
export function noteBuiltinCollectionCarrierReserved(ctx: CodegenContext, name: string): void {
  if ((COLLECTIONS.has(name) || ERRORS.includes(name)) && ctx.funcMap.has(HELPER_NAME)) ensureCollectionCtor(ctx, name);
}

/** Reserve the helper (standalone/WASI only). Returns its funcIdx, or undefined. */
export function reserveBuiltinCollectionDynConstruct(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const existing = ctx.funcMap.get(HELPER_NAME);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF], `$${HELPER_NAME}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: HELPER_NAME,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(HELPER_NAME, funcIdx);
  for (const name of [...COLLECTIONS.keys(), ...ERRORS]) {
    if (carrierGlobal(ctx, name) !== undefined) ensureCollectionCtor(ctx, name);
  }
  return funcIdx;
}

/**
 * Stack `[externref prior] → [externref]`: when the prior dynamic-`new` result
 * is null, retry as a collection construct on the callee in `calleeAnyLocal`
 * (anyref) with the already-evaluated `argLocals` (externref). Nothing is
 * re-evaluated.
 */
export function emitBuiltinCollectionConstructOnNull(
  ctx: CodegenContext,
  fctx: FunctionContext,
  calleeAnyLocal: number,
  argLocals: readonly number[],
): void {
  const helperIdx = reserveBuiltinCollectionDynConstruct(ctx);
  if (helperIdx === undefined) return;
  const priorLocal = allocLocal(fctx, `__bcdc_prior_${fctx.locals.length}`, EXTERNREF);
  const arg0: Instr = argLocals.length > 0 ? { op: "local.get", index: argLocals[0]! } : { op: "ref.null.extern" };
  fctx.body.push(
    { op: "local.tee", index: priorLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        { op: "local.get", index: calleeAnyLocal },
        { op: "extern.convert_any" },
        arg0,
        { op: "call", funcIdx: ctx.funcMap.get(HELPER_NAME) ?? helperIdx },
      ],
      else: [{ op: "local.get", index: priorLocal }],
    },
  );
}

/**
 * `__native_construct_<arity>` arm (callee = local 0, first argument = local 2):
 * `if ((r = helper(callee, arg0)) != null) return r`. Empty when not reserved.
 */
export function builtinCollectionConstructArm(ctx: CodegenContext, arity: number, resultLocal: number): Instr[] {
  const helperIdx = ctx.funcMap.get(HELPER_NAME);
  if (helperIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    arity > 0 ? { op: "local.get", index: 2 } : { op: "ref.null.extern" },
    { op: "call", funcIdx: helperIdx },
    { op: "local.tee", index: resultLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: resultLocal }, { op: "return" }] },
  ];
}

/** Fill the reserved helper at finalize over the carrier globals that exist. */
export function fillBuiltinCollectionDynConstruct(ctx: CodegenContext): void {
  const helperIdx = ctx.funcMap.get(HELPER_NAME);
  if (helperIdx === undefined) return;
  const helper = definedFuncAt(ctx, helperIdx);
  if (!helper) return;
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const calleeIsEq: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
  ];
  const body: Instr[] = [
    ...calleeIsEq,
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
  ];
  for (const [name, arity] of COLLECTIONS) {
    const globalIdx = carrierGlobal(ctx, name);
    const ctorIdx = ctx.funcMap.get(`__new_${name}@${arity}`);
    if (globalIdx === undefined || ctorIdx === undefined) continue;
    let construct: Instr[] = [
      ...(arity === 1 ? [{ op: "local.get", index: 1 } as Instr] : []),
      { op: "call", funcIdx: ctorIdx },
      { op: "return" },
    ];
    if (arity === 0) {
      // A Weak* iterable is not honoured by the #3972 carrier: decline (null)
      // rather than hand back a collection missing its entries.
      const nullish: Instr[] = [{ op: "local.get", index: 1 }, { op: "ref.is_null" }];
      if (isUndefinedIdx !== undefined)
        nullish.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefinedIdx }, { op: "i32.or" });
      construct = [...nullish, { op: "if", blockType: { kind: "empty" }, then: construct }];
    }
    body.push(
      { op: "global.get", index: globalIdx },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "global.get", index: globalIdx },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "ref.eq" },
          { op: "if", blockType: { kind: "empty" }, then: construct },
        ],
      },
    );
  }
  for (const name of ERRORS) {
    const globalIdx = carrierGlobal(ctx, name);
    const ctorIdx = ctx.funcMap.get(`__new_${name}`);
    if (globalIdx === undefined || ctorIdx === undefined) continue;
    body.push(
      ...identityArm(globalIdx, [{ op: "local.get", index: 1 }, { op: "call", funcIdx: ctorIdx }, { op: "return" }]),
    );
  }
  body.push({ op: "ref.null.extern" });
  helper.body = body;
  helper.locals = [];
}

/** `if (callee === <carrier global>) { construct }` — the identity arm shared by every family. */
function identityArm(globalIdx: number, construct: Instr[]): Instr[] {
  return [
    { op: "global.get", index: globalIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "global.get", index: globalIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.eq" },
        { op: "if", blockType: { kind: "empty" }, then: construct },
      ],
    },
  ];
}

/**
 * (#6775 S10) `new C(msg, …)` whose callee is typed as a NativeError / Error
 * constructor but is not the global identifier — `var C = nativeErrors[i]`.
 * The class-name lowering only knows the GLOBAL spelling, so this shape reached
 * the terminal "Unsupported new expression" refusal and evaluated to
 * `undefined`. Evaluate the callee and every argument in order, then construct
 * through the identity helper above (`__new_<Name>(arg0)` for the Error-family
 * carrier the value IS). A value matching no carrier keeps the pre-existing
 * null outcome. Standalone/WASI only.
 */
export function tryEmitErrorFamilyValueConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  callee: import("../ts-api.js").ts.Expression,
  args: readonly import("../ts-api.js").ts.Expression[],
  compile: (e: import("../ts-api.js").ts.Expression) => ValType | null,
  toExtern: (t: ValType) => void,
): ValType | undefined {
  if (!noJsHost(ctx) || !ERRORS.includes(className)) return undefined;
  const helperIdx = reserveBuiltinCollectionDynConstruct(ctx);
  if (helperIdx === undefined) return undefined;
  const evalTo = (e: import("../ts-api.js").ts.Expression): number => {
    const t = compile(e);
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") toExtern(t);
    const local = allocLocal(fctx, `__efvc_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "local.set", index: local });
    return local;
  };
  const calleeLocal = evalTo(callee);
  const argLocals = args.map(evalTo);
  fctx.body.push(
    { op: "local.get", index: calleeLocal },
    argLocals.length > 0 ? { op: "local.get", index: argLocals[0]! } : { op: "ref.null.extern" },
    { op: "call", funcIdx: ctx.funcMap.get(HELPER_NAME) ?? helperIdx },
  );
  return EXTERNREF;
}
