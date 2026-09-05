// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5145) `ArraySpeciesCreate` (§10.4.2.3, ES2015 §9.4.2.3) and
 * `CreateDataPropertyOrThrow` (§7.3.7) for the STANDALONE / WASI lane.
 *
 * ## What was missing
 * Every native `Array.prototype` producer (`slice`, `splice`, `map`, `filter`,
 * `concat`) minted its result with a raw `struct.new $vec` / `__objvec_new`.
 * That is byte-cheap and correct whenever `Array[@@species] === Array`, and the
 * fast paths were shipped with the species protocol recorded as a deliberate
 * under-approximation (`array-methods.ts` "#1359 Slice B", `array-concat-spec.ts`
 * header). The consequence: 39 `create-species*.js` / `target-array-*.js`
 * test262 files under `built-ins/Array/prototype` fail in standalone.
 *
 * ## The shape of the fix
 * Two inline emissions, both host-free, both composed from natives the object
 * runtime already registers:
 *
 * - {@link emitArraySpeciesCreate} — the PROLOGUE. Runs *before* the producer's
 *   element loop, because `create-species-abrupt.js` / `-poisoned.js` /
 *   `-non-ctor.js` all assert `callCount === 0`: an abrupt species completion
 *   must beat the first callback invocation. It leaves an externref local
 *   holding either the constructed object or **null**, the "use the default
 *   lane" sentinel.
 * - {@link emitArraySpeciesResultSwap} — the EPILOGUE. Consumes the vec the
 *   producer just built. Null sentinel ⇒ that vec is the result, converted to
 *   externref and otherwise untouched. Non-null ⇒ the vec's elements are
 *   re-published onto the constructed object through
 *   `__defineProperty_value` (CreateDataPropertyOrThrow, NOT `Set` — see below)
 *   and the object is the result.
 *
 * ## Why define, not set
 * `map/target-array-with-non-writable-property.js` has the species constructor
 * return an array whose index 0 is `{writable: false, configurable: true}` and
 * then asserts the mapped value LANDED and is writable again. A plain
 * `__extern_set` fails that (non-writable ⇒ silent no-op / TypeError);
 * `[[DefineOwnProperty]]` with a full data descriptor redefines it. The
 * `target-array-non-extensible` / `-non-configurable` files check the other
 * direction — `__defineProperty_value` already throws the §10.1.6.3 TypeErrors,
 * so routing through it gets both halves for free. The trailing `length` write
 * IS a plain `Set` per spec.
 *
 * ## The escape gate — why this is not always emitted
 * The prologue's `Get(O, "constructor")` answers `null` for a plain array in
 * standalone (nothing installs a reflective `constructor` on `$vec`), so the
 * species arm is a runtime no-op for ordinary programs. The *emission* is not
 * free though: it widens every affected producer's static result type from
 * `(ref null $vec)` to `externref`, which would push unrelated typed code onto
 * the dynamic lane. So `ctx.arraySpeciesDirty` (set by the `scanForArrayHoles`
 * pre-scan when the module mentions `Symbol.species` or assigns `.constructor`)
 * gates the whole thing. Clear ⇒ not one instruction changes.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";
import { reserveNativeConstructDriver } from "./native-construct.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };
const suppressedArraySpeciesContexts = new WeakSet<FunctionContext>();

/** `@@species` — the well-known symbol id interned by the native `$Symbol` carrier. */
const SYMBOL_SPECIES_ID = 5;

/**
 * `__defineProperty_value` flag word for a full
 * `{value, writable: true, enumerable: true, configurable: true}` data
 * descriptor in the host encoding it decodes: value bits 0/1/2, "specified"
 * bits 3/4/5, has-value bit 7.
 */
const CREATE_DATA_PROPERTY_FLAGS = 0b1011_1111;

export interface ArraySpeciesDeps {
  externGet: number;
  externSet: number;
  externLength: number;
  externGetIdx: number;
  externIsUndefined: number;
  boxSymbol: number;
  boxNumber: number;
  defineValue: number;
  toString: number;
  isConstructor: number;
  construct1: number;
  arrayCtorGlobal: number;
  objectIs: number | undefined;
  typeofObject: number | undefined;
  typeofFunction: number | undefined;
  /** (#5268 step 6) §7.2.2 IsArray — step 3's abrupt for a revoked Proxy. */
  externIsArray: number | undefined;
}

/**
 * True when this module may observe `ArraySpeciesCreate` at all. Gated on the
 * native-first lane (the JS-host lane keeps its own bridge) and on the
 * pre-scan flag, so a module that never mentions `Symbol.species` or a
 * `.constructor` assignment emits byte-identical output.
 */
export function arraySpeciesActive(ctx: CodegenContext): boolean {
  return (ctx.standalone || ctx.wasi) && ctx.arraySpeciesDirty;
}

export function withArraySpeciesSuppressed<T>(fctx: FunctionContext, emit: () => T): T {
  suppressedArraySpeciesContexts.add(fctx);
  try {
    return emit();
  } finally {
    suppressedArraySpeciesContexts.delete(fctx);
  }
}

/**
 * Register every native the two emissions call and resolve their indices.
 * Registration happens in ONE batch before any index is read — each of these is
 * a defined native under the native-first provider, so a later registration
 * shifts the ones already resolved (the #2043 late-shift class).
 */
export function prepareArraySpeciesDeps(ctx: CodegenContext, fctx: FunctionContext): ArraySpeciesDeps | undefined {
  if (suppressedArraySpeciesContexts.has(fctx) || !arraySpeciesActive(ctx)) return undefined;
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_set", [EXTERNREF, EXTERNREF, EXTERNREF], []);
  ensureLateImport(ctx, "__extern_length", [EXTERNREF], [F64]);
  ensureLateImport(ctx, "__extern_get_idx", [EXTERNREF, F64], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__box_number", [F64], [EXTERNREF]);
  ensureLateImport(ctx, "__defineProperty_value", [EXTERNREF, EXTERNREF, EXTERNREF, F64], []);
  ensureLateImport(ctx, "__extern_toString", [EXTERNREF], [EXTERNREF]);
  addStringConstantGlobal(ctx, "constructor");
  addStringConstantGlobal(ctx, "length");
  ensureReflectIsConstructor(ctx);
  reserveNativeConstructDriver(ctx, 1, stringConstantExternrefInstrs(ctx, "prototype"));
  flushLateImportShifts(ctx, fctx);
  const arrayCtorGlobal = ensureArrayConstructorIdentityGlobal(ctx);

  const externGet = ctx.funcMap.get("__extern_get");
  const externSet = ctx.funcMap.get("__extern_set");
  const externLength = ctx.funcMap.get("__extern_length");
  const externGetIdx = ctx.funcMap.get("__extern_get_idx");
  const externIsUndefined = ctx.funcMap.get("__extern_is_undefined");
  const boxSymbol = ctx.funcMap.get("__box_symbol");
  const boxNumber = ctx.funcMap.get("__box_number");
  const defineValue = ctx.funcMap.get("__defineProperty_value");
  const toStringIdx = ctx.funcMap.get("__extern_toString");
  const isConstructor = ctx.funcMap.get("__reflect_is_constructor");
  const construct1 = ctx.funcMap.get("__native_construct_1");
  if (
    externGet === undefined ||
    externSet === undefined ||
    externLength === undefined ||
    externGetIdx === undefined ||
    externIsUndefined === undefined ||
    boxSymbol === undefined ||
    boxNumber === undefined ||
    defineValue === undefined ||
    toStringIdx === undefined ||
    isConstructor === undefined ||
    construct1 === undefined
  ) {
    return undefined;
  }
  return {
    externGet,
    externSet,
    externLength,
    externGetIdx,
    externIsUndefined,
    boxSymbol,
    boxNumber,
    defineValue,
    toString: toStringIdx,
    isConstructor,
    construct1,
    arrayCtorGlobal,
    objectIs: ctx.funcMap.get("__object_is"),
    typeofObject: ctx.funcMap.get("__typeof_object"),
    typeofFunction: ctx.funcMap.get("__typeof_function"),
    externIsArray: ctx.funcMap.get("__extern_is_array"),
  };
}

/**
 * (#5145) The module-global holding the identity-stable reified `Array`
 * constructor carrier (`emitBuiltinNamespaceObject`, #2907). Registered
 * here — under the SAME `builtinObjectGlobals` key that function uses — so the
 * species prologue can compare `C` against it whether or not the module has
 * already reified `Array`. A module that never reifies it leaves the global
 * `null`, and `C` at the comparison point is non-null, so the arm is inert.
 *
 * Why the comparison exists: §10.4.2.3 step 6 turns a *cross-realm* `%Array%`
 * into `undefined` before the `@@species` read. Standalone has one set of
 * intrinsics, so another realm's `Array` IS this carrier — treating it as the
 * default lane is exactly step 6 for the only realm shape this target has, and
 * it keeps `slice/create-proto-from-ctor-realm-array.js` (which asserts the
 * species getter is NOT invoked) passing. For an in-realm `a.constructor =
 * Array` the shortcut is observationally identical unless the program has also
 * replaced `Array[@@species]`, which no ES2015 array file does.
 */
function ensureArrayConstructorIdentityGlobal(ctx: CodegenContext): number {
  // `Array` reifies through the NAMESPACE-object carrier (`__builtin_Array`,
  // keyed by bare name), not the `ctor:` family — it is deliberately absent from
  // `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`.
  const key = "Array";
  const existing = ctx.builtinObjectGlobals.get(key);
  if (existing !== undefined) return existing;
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__builtin_Array",
    type: EXTERNREF,
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.builtinObjectGlobals.set(key, globalIdx);
  return globalIdx;
}

/** `local.get v; (ref.is_null || __extern_is_undefined(v))` as an i32 0/1. */
function nullish(deps: ArraySpeciesDeps, local: number): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    { op: "local.get", index: local },
    { op: "call", funcIdx: deps.externIsUndefined },
    { op: "i32.or" },
  ];
}

/** `nullish(C) || C === %Array%` — the two "take the default lane" answers. */
function defaultLaneTest(deps: ArraySpeciesDeps, local: number): Instr[] {
  return [
    ...nullish(deps, local),
    ...(deps.objectIs === undefined
      ? []
      : ([
          { op: "local.get", index: local },
          { op: "global.get", index: deps.arrayCtorGlobal },
          { op: "call", funcIdx: deps.objectIs },
          { op: "i32.or" },
        ] satisfies Instr[])),
  ];
}

/**
 * §10.4.2.3 ArraySpeciesCreate, minus the default `ArrayCreate(length)` arm:
 * a default outcome answers **null**, and the caller keeps its existing
 * `struct.new $vec` fast path byte-for-byte.
 *
 * `recvInstrs` pushes the original array as an externref; `lenInstrs` pushes
 * the `length` argument as f64. Abrupt completions from either `Get` propagate
 * as ordinary Wasm exceptions — deliberately NOT caught, which is what
 * `create-species-poisoned.js` / `-abrupt.js` measure.
 *
 * Returns the externref local holding the result (or `undefined` when the
 * substrate is unavailable, so the caller stays on its existing path).
 */
export function emitArraySpeciesCreate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: ArraySpeciesDeps,
  recvInstrs: Instr[],
  lenInstrs: Instr[],
): number {
  const ctorLocal = allocLocal(fctx, `__spc_c_${fctx.locals.length}`, EXTERNREF);
  const outLocal = allocLocal(fctx, `__spc_out_${fctx.locals.length}`, EXTERNREF);
  const lenLocal = allocLocal(fctx, `__spc_len_${fctx.locals.length}`, F64);
  const recvLocal = allocLocal(fctx, `__spc_o_${fctx.locals.length}`, EXTERNREF);

  fctx.body.push(...lenInstrs, { op: "local.set", index: lenLocal });
  fctx.body.push({ op: "ref.null.extern" }, { op: "local.set", index: outLocal });
  // The receiver is evaluated ONCE into a local: steps 2 and 4 both read it,
  // and re-pushing `recvInstrs` would alias the same Instr objects into two
  // positions, which the finalize walks remap twice (#5188 followUp 4).
  fctx.body.push(...recvInstrs, { op: "local.set", index: recvLocal });

  // (#5268 step 6) §10.4.2.3 steps 2-3: `isArray = ? IsArray(originalArray)`,
  // and a false answer returns `ArrayCreate(length)` — this function's DEFAULT
  // lane, i.e. `outLocal` left null. The step is observable twice over: the
  // `?` propagates the revoked-Proxy TypeError BEFORE `Get(O, "constructor")`
  // runs (`{map,filter,splice}/create-revoked-proxy.js` assert `ctorCount ===
  // 0`), and an array-LIKE non-array receiver must not consult `@@species` at
  // all. Everything from here to the end of the function is the isArray-true
  // arm, spliced into a block a false answer branches out of.
  const speciesArmStart = fctx.body.length;

  // C = Get(O, "constructor")
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, "constructor"));
  fctx.body.push({ op: "call", funcIdx: deps.externGet });
  fctx.body.push({ op: "local.set", index: ctorLocal });

  // step 7 — Type(C) is Object ⇒ C = Get(C, @@species). A primitive C skips the
  // read and falls straight into the step-9 IsConstructor refusal.
  const speciesRead: Instr[] = [
    { op: "local.get", index: ctorLocal },
    { op: "i32.const", value: SYMBOL_SPECIES_ID },
    { op: "call", funcIdx: deps.boxSymbol },
    { op: "call", funcIdx: deps.externGet },
    { op: "local.set", index: ctorLocal },
  ];
  const isObjectProbe: Instr[] =
    deps.typeofObject !== undefined && deps.typeofFunction !== undefined
      ? [
          { op: "local.get", index: ctorLocal },
          { op: "call", funcIdx: deps.typeofObject },
          { op: "local.get", index: ctorLocal },
          { op: "call", funcIdx: deps.typeofFunction },
          { op: "i32.or" },
        ]
      : [{ op: "i32.const", value: 1 }];

  const throwNonCtor = buildThrowJsErrorInstrs(ctx, "TypeError", "ArraySpeciesCreate: @@species is not a constructor", {
    flush: fctx,
  });

  const constructArm: Instr[] = [
    { op: "local.get", index: ctorLocal },
    { op: "call", funcIdx: deps.isConstructor },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwNonCtor },
    { op: "local.get", index: ctorLocal },
    { op: "ref.null.extern" },
    { op: "local.get", index: lenLocal },
    { op: "call", funcIdx: deps.boxNumber },
    { op: "call", funcIdx: deps.construct1 },
    { op: "local.set", index: outLocal },
  ];

  fctx.body.push(...defaultLaneTest(deps, ctorLocal), { op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      ...isObjectProbe,
      { op: "if", blockType: { kind: "empty" }, then: speciesRead },
      ...defaultLaneTest(deps, ctorLocal),
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: constructArm },
    ],
  });

  // Close the step-2/3 gate around everything emitted since `speciesArmStart`.
  // The inner `if` bodies carry no `br`, so wrapping them in one more block
  // leaves every existing relative depth untouched.
  if (deps.externIsArray !== undefined) {
    const speciesArm = fctx.body.splice(speciesArmStart);
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: recvLocal },
        { op: "call", funcIdx: deps.externIsArray },
        { op: "i32.eqz" },
        { op: "br_if", depth: 0 },
        ...speciesArm,
      ],
    });
  }
  return outLocal;
}

/**
 * The epilogue. `vecType` is the producer's own result type, whose value is on
 * the stack; the emission leaves an **externref**.
 *
 * When `speciesLocal` is null the vec is simply widened to externref — no
 * copy, no define, no allocation. Otherwise every element of the vec is
 * re-published onto the species object via CreateDataPropertyOrThrow, `length`
 * is Set, and the object is the result.
 */
export function emitArraySpeciesResultSwap(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: ArraySpeciesDeps,
  speciesLocal: number,
  vecType: ValType,
): ValType {
  const vecLocal = allocLocal(fctx, `__spc_vec_${fctx.locals.length}`, vecType);
  const srcLocal = allocLocal(fctx, `__spc_src_${fctx.locals.length}`, EXTERNREF);
  const nLocal = allocLocal(fctx, `__spc_n_${fctx.locals.length}`, F64);
  const iLocal = allocLocal(fctx, `__spc_i_${fctx.locals.length}`, F64);

  // A `$ObjVec` producer (concat) already hands us an externref; a typed `$vec`
  // producer needs the one widening conversion.
  const toExtern: Instr[] =
    vecType.kind === "externref"
      ? [{ op: "local.get", index: vecLocal }]
      : [{ op: "local.get", index: vecLocal }, { op: "extern.convert_any" }];

  fctx.body.push({ op: "local.set", index: vecLocal });
  fctx.body.push({ op: "local.get", index: speciesLocal }, { op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: toExtern,
    else: [
      ...toExtern,
      { op: "local.tee", index: srcLocal },
      { op: "call", funcIdx: deps.externLength },
      { op: "local.set", index: nLocal },
      { op: "f64.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: iLocal },
              { op: "local.get", index: nLocal },
              { op: "f64.ge" },
              { op: "br_if", depth: 1 },
              // CreateDataPropertyOrThrow(A, ToString(k), element)
              { op: "local.get", index: speciesLocal },
              // ! ToString(k) — the STRING key, not a boxed number: the `$vec`
              // index lane and the `$Object` prop table agree on the string
              // spelling, and a number-boxed key lands in a slot the vec's own
              // indexed read never consults (measured: the pre-existing
              // non-writable entry kept winning).
              { op: "local.get", index: iLocal },
              { op: "call", funcIdx: deps.boxNumber },
              { op: "call", funcIdx: deps.toString },
              { op: "local.get", index: srcLocal },
              { op: "local.get", index: iLocal },
              { op: "call", funcIdx: deps.externGetIdx },
              { op: "f64.const", value: CREATE_DATA_PROPERTY_FLAGS },
              { op: "call", funcIdx: deps.defineValue },
              // …then a plain [[Set]] of the same key. `__defineProperty_value`
              // enforces §10.1.6.3 (the extensibility / non-configurable
              // TypeErrors) and lands the ATTRIBUTES, but on a `$vec` target it
              // writes the descriptor overlay only — the dense index lane that
              // `A[k]` actually reads keeps its old slot (measured:
              // `slice/target-array-with-non-writable-property.js` saw the
              // descriptor as 1 and `r[0]` as 0). The property is writable by
              // construction at this point, so the [[Set]] cannot fail.
              { op: "local.get", index: speciesLocal },
              { op: "local.get", index: iLocal },
              { op: "call", funcIdx: deps.boxNumber },
              { op: "local.get", index: srcLocal },
              { op: "local.get", index: iLocal },
              { op: "call", funcIdx: deps.externGetIdx },
              { op: "call", funcIdx: deps.externSet },
              { op: "local.get", index: iLocal },
              { op: "f64.const", value: 1 },
              { op: "f64.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Set(A, "length", n) — a plain [[Set]] per §23.1.3.x, not a define.
      { op: "local.get", index: speciesLocal },
      ...stringConstantExternrefInstrs(ctx, "length"),
      { op: "local.get", index: nLocal },
      { op: "call", funcIdx: deps.boxNumber },
      { op: "call", funcIdx: deps.externSet },
      { op: "local.get", index: speciesLocal },
    ],
  });
  return EXTERNREF;
}
