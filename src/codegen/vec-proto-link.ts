// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2917) Prototype identity for standalone `class X extends Array` instances.
 *
 * ## The gap (measured on fb7607cd9e, `.tmp/mine.mts`)
 *
 * An `extends Array` instance is a plain `$__vec_externref` — the same carrier
 * as `[]` — so nothing on it says "J". The #5383 S2b method install copies the
 * methods and `constructor` onto the instance's #3537 expando bag, which makes
 * `x.m()` and `x.constructor` work through a dynamic receiver, but every
 * question about the PROTOTYPE still answered as if `x` were a plain array:
 *
 * | through an `any` receiver                        | node | before |
 * | ------------------------------------------------ | ---- | ------ |
 * | `id(new J(1)) instanceof J`                      | true | false  |
 * | `id(new K(1)) instanceof J` (`K extends J`)      | true | false  |
 * | `Object.getPrototypeOf(id(new J(1))) === J.prototype` | true | false |
 * | `Object.setPrototypeOf(x, J.prototype)` on a vec | links | no-op |
 * | `Object.getPrototypeOf(J.prototype) === Array.prototype` | true | false (folded to null) |
 *
 * ## The link (design B: a hidden slot on the existing bag)
 *
 * The bag is a `$Object`, so it already has a `$proto` field that nothing
 * reads: every consumer of the bag reads it OWN-only (`__vec_prop_get` guards
 * with `__hasOwnProperty`; `Object.keys`/`hasOwnProperty` enumerate own keys).
 * The construction site stores `C.prototype` there, and three natives learn
 * to honour it:
 *
 *  - `__getPrototypeOf(vec)` answers the link when present (else the
 *    unchanged native `Array.prototype` answer);
 *  - `__object_setPrototypeOf(vec, P)` writes it (an `$Object` `P`), or clears
 *    it (anything else — the vec then answers `Array.prototype` again);
 *  - `__vec_proto_instanceof(v, C.prototype)` walks it, then the ordinary
 *    `$Object.$proto` chain, with `ref.eq` — OrdinaryHasInstance over the
 *    only chain a vec can carry, so `K extends J` works with no per-class list.
 *
 * `C.prototype.$proto` cannot hold `Array.prototype` (a `$NativeProto`, not an
 * `$Object`), so the `J.prototype → Array.prototype` edge is answered where it
 * is asked instead: a `__getPrototypeOf` arm per Array-rooted class, and the
 * static `Object.getPrototypeOf(J.prototype)` fold.
 *
 * ## Why not design A (a `$__vec_externref` subtype with a proto field)
 *
 * It would need every vec producer/consumer that `ref.test`s the concrete vec
 * type to accept the subtype, and the bag is already per-instance state with
 * an identity-keyed lookup — the link needs no new carrier.
 *
 * ## Array.prototype in a vec-typed slot
 *
 * TypeScript types `Array.prototype` as `any[]`, so a slot of that type (a
 * `var p = Array.prototype`, an inferred function return) coerces the
 * `$NativeProto` externref into a vec — and the materializer built a FRESH
 * copy every time, so `f() === f()` was false. {@link wrapArrayProtoVecAlias}
 * makes that coercion answer one module-wide vec per target vec type instead.
 * This is identity WITHIN vec slots only: the alias vec and the `$NativeProto`
 * are still two values, so a comparison across the representations
 * (`p === Array.prototype` where one side stays externref) stays false.
 *
 * ## Byte-neutrality
 *
 * Standalone/WASI only. The construction install fires only for an
 * externref-backed class whose builtin root is `Array` and whose prototype is a
 * real `$Object`; the finalize arms only when such an install happened; the
 * alias wrap only when the module has already materialised `Array.prototype`.
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { standaloneClassProtoObjectApplies } from "./class-proto-object.js";
import { ensureArrayNativeProtoGlue } from "./array-object-proto.js";
import { emitLazyProtoGet } from "./expressions/extern.js";
import { buildLazyNativeProtoGetInstrs } from "./native-proto.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js";
import { allocLocal } from "./context/locals.js";
import { coerceType, compileExpression, flushLateImportShifts } from "./shared.js";

const IS_VEC = "__is_vec_prop_carrier";
const BAG_LOOKUP = "__vec_bag_lookup";
const BAG_ENSURE = "__vec_bag_ensure";
const VEC_PROTO_INSTANCEOF = "__vec_proto_instanceof";
/** `$Object.flags` bit for an explicitly null prototype (object-runtime.ts). */
const OBJ_FLAG_NULL_PROTO = 0x80;
const EXTERNREF: ValType = { kind: "externref" };

interface LinkState {
  /** Classes whose construction installed the link. */
  linked: Set<string>;
  /** Target vec typeIdx → the `Array.prototype` alias global. */
  aliasGlobals: Map<number, number>;
}
const stateByCtx = new WeakMap<CodegenContext, LinkState>();
function linkState(ctx: CodegenContext): LinkState {
  let s = stateByCtx.get(ctx);
  if (!s) {
    s = { linked: new Set(), aliasGlobals: new Map() };
    stateByCtx.set(ctx, s);
  }
  return s;
}

/** The class that `extends Array` directly, walking up from `className`. */
function arrayRootClass(ctx: CodegenContext, className: string): string | undefined {
  let c: string | undefined = className;
  for (let depth = 0; c !== undefined && depth < 64; depth++) {
    const builtin = ctx.classBuiltinParentMap.get(c);
    if (builtin !== undefined) return builtin === "Array" ? c : undefined;
    c = ctx.classParentMap.get(c);
  }
  return undefined;
}

/** A standalone externref-backed class rooted at `Array` with a real `$Object` prototype. */
function linkApplies(ctx: CodegenContext, className: string): boolean {
  return (
    (ctx.standalone || ctx.wasi) &&
    ctx.classExternrefBackedSet.has(className) &&
    arrayRootClass(ctx, className) !== undefined &&
    standaloneClassProtoObjectApplies(ctx, className) &&
    ctx.objectRuntimeTypes !== undefined &&
    ctx.funcMap.has(BAG_ENSURE)
  );
}

/**
 * At construction, after `super(...)`: `bag(self).$proto = Sub.prototype`.
 * Emits nothing unless {@link linkApplies}.
 */
export function emitVecProtoLinkInstall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  selfLocal: number,
  subName: string,
): void {
  if (!linkApplies(ctx, subName)) return;
  const objectTypeIdx = ctx.objectRuntimeTypes!.objectTypeIdx;
  // The finalize arms embed the `Array.prototype` singleton read; register its
  // glue, global and string constants NOW, in the ordinary compile regime.
  const arrayBrand = ensureArrayNativeProtoGlue(ctx);
  if (arrayBrand === undefined || buildLazyNativeProtoGetInstrs(ctx, arrayBrand) === null) return;
  const snap = snapshotSpeculative(ctx, fctx);
  // The bag goes through a TYPED local: `fixups.ts`'s struct.set receiver
  // repair walks back over net-zero instructions and would re-cast the vec
  // itself if the receiver were `local.get <externref>; call; cast`.
  const bagLocal = allocLocal(fctx, `__vec_link_bag_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: objectTypeIdx,
  });
  fctx.body.push(
    { op: "local.get", index: selfLocal },
    { op: "call", funcIdx: ctx.funcMap.get(BAG_ENSURE)! },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: bagLocal },
    { op: "local.get", index: bagLocal },
  );
  if (!emitLazyProtoGet(ctx, fctx, subName)) {
    rollbackSpeculative(ctx, fctx, snap);
    return;
  }
  // The prototype builder can register late imports; `fctx.body` (holding the
  // `call` above) is shift-repaired by the flush.
  flushLateImportShifts(ctx, fctx);
  fctx.body.push(
    { op: "any.convert_extern" },
    { op: "ref.cast_null", typeIdx: objectTypeIdx },
    { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 0 },
  );
  linkState(ctx).linked.add(subName);
}

/**
 * `Object.getPrototypeOf(C.prototype)` for a class that directly `extends
 * Array`: the `Array.prototype` singleton. Returns `false` (emitting nothing)
 * for every other class.
 */
export function emitArrayRootedProtoParent(ctx: CodegenContext, fctx: FunctionContext, className: string): boolean {
  if (!(ctx.standalone || ctx.wasi)) return false;
  if (ctx.classBuiltinParentMap.get(className) !== "Array") return false;
  const arrayBrand = ensureArrayNativeProtoGlue(ctx);
  const instrs = arrayBrand === undefined ? null : buildLazyNativeProtoGetInstrs(ctx, arrayBrand);
  if (!instrs) return false;
  fctx.body.push(...instrs);
  return true;
}

/**
 * `v instanceof C` through a dynamic value, for an Array-rooted class `C`:
 * `__vec_proto_instanceof(v, C.prototype)`. `null` when not applicable.
 */
export function tryEmitVecLinkedInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  ctorName: string,
): ValType | null {
  if (!linkApplies(ctx, ctorName)) return null;
  reserveInstanceofHelper(ctx);
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (leftType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (leftType.kind !== "externref") coerceType(ctx, fctx, leftType, EXTERNREF);
  if (!emitLazyProtoGet(ctx, fctx, ctorName)) fctx.body.push({ op: "ref.null.extern" });
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(VEC_PROTO_INSTANCEOF)! });
  return { kind: "i32" };
}

function reserveInstanceofHelper(ctx: CodegenContext): void {
  if (ctx.funcMap.has(VEC_PROTO_INSTANCEOF)) return;
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [{ kind: "i32" }], `$${VEC_PROTO_INSTANCEOF}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  // Filled at finalize; the placeholder answers `false`, never traps.
  const placeholder: WasmFunction = {
    name: VEC_PROTO_INSTANCEOF,
    typeIdx,
    locals: [],
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, placeholder);
  ctx.funcMap.set(VEC_PROTO_INSTANCEOF, funcIdx);
}

/**
 * Coerce-to-vec twin: when the externref in `externLocal` IS the
 * `Array.prototype` singleton, answer one module-wide vec of type `toIdx`
 * instead of `materialize` (a fresh copy). Returns `materialize` untouched when
 * the module has no `Array.prototype` singleton yet.
 */
export function wrapArrayProtoVecAlias(
  ctx: CodegenContext,
  externLocal: number,
  toIdx: number,
  arrTypeIdx: number,
  materialize: Instr[],
): Instr[] {
  if (!(ctx.standalone || ctx.wasi)) return materialize;
  const brand = ctx.builtinBrandMap?.get("Array");
  const protoGlobal = brand === undefined ? undefined : ctx.nativeProtoGlobals?.get(brand);
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  if (protoGlobal === undefined || npTypeIdx === undefined) return materialize;
  const aliases = linkState(ctx).aliasGlobals;
  let aliasGlobal = aliases.get(toIdx);
  if (aliasGlobal === undefined) {
    aliasGlobal = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__array_proto_vec_alias_${toIdx}`,
      type: { kind: "ref_null", typeIdx: toIdx },
      mutable: true,
      init: [{ op: "ref.null", typeIdx: toIdx }],
    });
    aliases.set(toIdx, aliasGlobal);
  }
  const result: ValType = { kind: "ref_null", typeIdx: toIdx };
  return [
    { op: "local.get", index: externLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: npTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: externLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: npTypeIdx },
        { op: "global.get", index: protoGlobal },
        { op: "any.convert_extern" },
        { op: "ref.cast_null", typeIdx: npTypeIdx },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    {
      op: "if",
      blockType: { kind: "val", type: result },
      then: [
        { op: "global.get", index: aliasGlobal },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "array.new_fixed", typeIdx: arrTypeIdx, length: 0 },
            { op: "struct.new", typeIdx: toIdx },
            { op: "global.set", index: aliasGlobal },
          ],
        },
        { op: "global.get", index: aliasGlobal },
      ],
      else: materialize,
    },
  ];
}

// ── Finalize ──────────────────────────────────────────────────────────────────

/**
 * Fill `__vec_proto_instanceof` (when reserved) and, when any construction
 * installed a link, prepend the vec arms to `__getPrototypeOf` and
 * `__object_setPrototypeOf`. Runs in the same finalize window as
 * `fillStandaloneClassInstanceProtoArm`.
 */
export function fillVecProtoLinkArms(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const isVecIdx = ctx.funcMap.get(IS_VEC);
  const lookupIdx = ctx.funcMap.get(BAG_LOOKUP);
  const ensureIdx = ctx.funcMap.get(BAG_ENSURE);
  if (objectTypeIdx === undefined || isVecIdx === undefined || lookupIdx === undefined || ensureIdx === undefined) {
    return;
  }
  const deps = { objectTypeIdx, isVecIdx, lookupIdx, ensureIdx };
  fillInstanceofHelper(ctx, deps);
  const state = stateByCtx.get(ctx);
  if (!state || state.linked.size === 0) return;
  prependGetPrototypeOfArm(ctx, deps, state);
  prependSetPrototypeOfArm(ctx, deps);
}

interface LinkDeps {
  objectTypeIdx: number;
  isVecIdx: number;
  lookupIdx: number;
  ensureIdx: number;
}

function namedFunction(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const idx = ctx.funcMap.get(name);
  return idx === undefined ? undefined : definedFuncAt(ctx, idx);
}

/** `bag(vec).$proto` into `protoLocal` (null when the vec has no bag). Stack-neutral. */
function loadVecLink(deps: LinkDeps, vecParam: number, bagLocal: number, protoLocal: number): Instr[] {
  const { objectTypeIdx } = deps;
  return [
    { op: "ref.null", typeIdx: objectTypeIdx },
    { op: "local.set", index: protoLocal },
    { op: "local.get", index: vecParam },
    { op: "call", funcIdx: deps.lookupIdx },
    { op: "local.tee", index: bagLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: bagLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: protoLocal },
      ],
    },
  ];
}

// params: 0 = value, 1 = C.prototype. locals: 2 any, 3 bag, 4 p, 5 target.
function fillInstanceofHelper(ctx: CodegenContext, deps: LinkDeps): void {
  const fn = namedFunction(ctx, VEC_PROTO_INSTANCEOF);
  if (!fn) return;
  const { objectTypeIdx } = deps;
  const objRefNull: ValType = { kind: "ref_null", typeIdx: objectTypeIdx };
  fn.locals = [
    { name: "__any", type: { kind: "anyref" } },
    { name: "__bag", type: EXTERNREF },
    { name: "__p", type: objRefNull },
    { name: "__target", type: objRefNull },
  ];
  fn.body = [
    // target = C.prototype as $Object, else false
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 2 },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: 5 },
    // p = vec ? bag.$proto : ($Object ? $proto : return false)
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.isVecIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: loadVecLink(deps, 0, 3, 4),
      else: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: 2 },
        { op: "ref.test", typeIdx: objectTypeIdx },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 4 },
      ],
    },
    // Walk the `$proto` chain. `__object_setPrototypeOf` refuses cycles, so
    // the chain is finite.
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: 4 },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        { op: "local.get", index: 4 },
        { op: "local.get", index: 5 },
        { op: "ref.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
        { op: "local.get", index: 4 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 4 },
        { op: "br", depth: 0 },
      ],
    },
    { op: "i32.const", value: 0 },
  ];
}

/**
 * `__getPrototypeOf` arms: (1) a vec with a link answers it; (2) the
 * unmodified prototype of a class that directly `extends Array` answers
 * `Array.prototype`. Both only RETURN on a hit; a miss falls through to the
 * unchanged body.
 */
function prependGetPrototypeOfArm(ctx: CodegenContext, deps: LinkDeps, state: LinkState): void {
  const fn = namedFunction(ctx, "__getPrototypeOf");
  if (!fn?.body) return;
  const { objectTypeIdx } = deps;
  const arrayBrand = ctx.builtinBrandMap?.get("Array");
  if (arrayBrand === undefined) return;
  // __getPrototypeOf has exactly one param; appended locals never renumber.
  const bagLocal = 1 + fn.locals.length;
  const protoLocal = bagLocal + 1;
  fn.locals.push(
    { name: "__vec_link_bag", type: EXTERNREF },
    { name: "__vec_link_proto", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
  );
  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.isVecIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...loadVecLink(deps, 0, bagLocal, protoLocal),
        { op: "local.get", index: protoLocal },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: protoLocal }, { op: "extern.convert_any" }, { op: "return" }],
        },
      ],
    },
  ];
  const roots = new Set<string>();
  for (const name of state.linked) {
    const root = arrayRootClass(ctx, name);
    if (root !== undefined) roots.add(root);
  }
  for (const root of [...roots].sort()) {
    const protoGlobal = ctx.protoGlobals.get(root);
    const arrayProto = buildLazyNativeProtoGetInstrs(ctx, arrayBrand);
    if (protoGlobal === undefined || !arrayProto) continue;
    // value is this class's prototype `$Object`, still with its original
    // (implicit) [[Prototype]] — neither re-linked nor made null-prototype.
    arm.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.tee", index: protoLocal },
          { op: "global.get", index: protoGlobal },
          { op: "any.convert_extern" },
          { op: "ref.cast_null", typeIdx: objectTypeIdx },
          { op: "ref.eq" },
          { op: "local.get", index: protoLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
          { op: "ref.is_null" },
          { op: "i32.and" },
          { op: "local.get", index: protoLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: OBJ_FLAG_NULL_PROTO },
          { op: "i32.and" },
          { op: "i32.eqz" },
          { op: "i32.and" },
          { op: "if", blockType: { kind: "empty" }, then: [...arrayProto, { op: "return" }] },
        ],
      },
    );
  }
  fn.body.unshift(...arm);
}

/**
 * `__object_setPrototypeOf(vec, P)`: an `$Object` `P` becomes the link; any
 * other `P` clears it. Returns the vec, as the native does for every receiver.
 */
function prependSetPrototypeOfArm(ctx: CodegenContext, deps: LinkDeps): void {
  const fn = namedFunction(ctx, "__object_setPrototypeOf");
  if (!fn?.body) return;
  const { objectTypeIdx } = deps;
  // two params (obj, proto); appended locals never renumber. The bag is held
  // TYPED so the struct.set receiver is never an externref producer (see the
  // install's note on `fixups.ts`).
  const bagLocal = 2 + fn.locals.length;
  const objLocal = bagLocal + 1;
  fn.locals.push(
    { name: "__vec_link_bag", type: EXTERNREF },
    { name: "__vec_link_obj", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
  );
  const arm: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.isVecIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: deps.ensureIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            { op: "local.set", index: objLocal },
            { op: "local.get", index: objLocal },
            { op: "local.get", index: 1 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: objectTypeIdx },
            { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 0 },
          ],
          else: [
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: deps.lookupIdx },
            { op: "local.tee", index: bagLocal },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: bagLocal },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: objectTypeIdx },
                { op: "local.set", index: objLocal },
                { op: "local.get", index: objLocal },
                { op: "ref.null", typeIdx: objectTypeIdx },
                { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: 0 },
        { op: "return" },
      ],
    },
  ];
  fn.body.unshift(...arm);
}
