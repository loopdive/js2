// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4220) `<array>.constructor` for a standalone array whose receiver is only
 * known at RUNTIME.
 *
 * ## The gap
 *
 * Every static spelling of `.constructor` on an array already resolves: #3133
 * routes an ARRAY-typed receiver to the `__builtin_Array` namespace-object
 * singleton, so `[1,2].constructor === Array` is genuinely true by `ref.eq`.
 * But that arm is **static-type driven** (`property-access-dispatch.ts`,
 * `classifyPlainCtorReceiverNamespace`). When the receiver's TS type is `any` —
 * a parameter, or the `externref` result of a reflective builtin closure — the
 * read falls through to the dynamic `__extern_get(obj, "constructor")` native,
 * whose `$__vec_base` arm (#3183) answers only `"length"` and numeric index
 * keys. Everything else misses, so a dynamically-typed array reads
 * `.constructor === undefined`.
 *
 * That is what blocks the ES5 `String.prototype.split` battery: those tests
 * transfer the method onto a non-string receiver and then assert
 * `__split.constructor === Array` on the (necessarily `any`-typed) result.
 *
 * ## The carrier
 *
 * The runtime arm must hand back the SAME object the bare `Array` identifier
 * reads, or the identity comparison is a null≡null tautology. That object is
 * the `__builtin_Array` global, and it is **lazily** materialized at each read
 * site (`emitBuiltinNamespaceObject`) — a bare `global.get` from inside
 * `__extern_get` would therefore read `null` whenever the array's
 * `.constructor` is evaluated BEFORE the module's first `Array` mention, which
 * is exactly the argument order of `assert.sameValue(a.constructor, Array)`.
 *
 * So this module mints a zero-argument accessor, `__vec_ctor_Array()`, holding
 * that same guarded lazy-init + `global.get`. The finalize-time `__extern_get`
 * vec arm calls it, which materializes the singleton on first demand from
 * either direction.
 *
 * ## Why it is demand-minted, not unconditional
 *
 * Minting the carrier drags the `Array` namespace object (and its static-method
 * closures) into the module. #4034 is the standing reminder of how expensive an
 * unconditional pull-in on the array path is — it cost ~21 kB of unstrippable
 * exports in every arith-only module. So the accessor is minted only where a
 * consumer asks for it, and `fillDynamicForinVecArms` installs the
 * `"constructor"` arm only when the accessor exists. A module that never
 * demands it emits byte-identical output.
 *
 * Minting must happen DURING ordinary codegen (it can register late imports),
 * never from finalize — callers do it alongside their other late-import-adding
 * setup and flush before reading any funcIdx by name.
 */

import type { Instr, ValType } from "../ir/types.js";
import { emitBuiltinNamespaceObject } from "./builtin-static-globals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";

/** Name of the minted accessor, and the key the finalize arm looks it up by. */
export const VEC_CONSTRUCTOR_CARRIER_FN = "__vec_ctor_Array";

/**
 * Mint (idempotently) `__vec_ctor_Array() -> externref` — the runtime accessor
 * for the `Array` namespace-object singleton. Returns its funcIdx, or
 * `undefined` outside standalone / when the carrier is unavailable.
 *
 * Call from ordinary codegen only, and treat it as a late-import adder: run it
 * before any funcIdx is captured by name and flush afterwards.
 */
export function ensureVecConstructorCarrier(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(VEC_CONSTRUCTOR_CARRIER_FN);
  if (existing !== undefined) return existing;

  const resultType: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [], [resultType]);
  const fctx: FunctionContext = {
    name: VEC_CONSTRUCTOR_CARRIER_FN,
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: resultType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // Emit BEFORE minting: `emitBuiltinNamespaceObject` mints the static-method
  // closures itself, and nested mints must get their ordinals first (the same
  // order `ensureStandaloneNativeMethodClosure` uses).
  if (emitBuiltinNamespaceObject(ctx, fctx, "Array") === null) return undefined;

  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: VEC_CONSTRUCTOR_CARRIER_FN,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  ctx.funcMap.set(VEC_CONSTRUCTOR_CARRIER_FN, funcIdx);
  return funcIdx;
}

/**
 * The `"constructor"` arm of `__extern_get`'s `$__vec_base` block (installed by
 * `fillDynamicForinVecArms`, object-runtime.ts).
 *
 * `keyEqualsConstructor` is the caller's `key == "constructor"` test (it owns
 * the param/local numbering); this returns the guarded delegation to the
 * accessor above. It answers `[]` — no arm at all — when either the accessor
 * was never demanded or the key test is unavailable, so a module that never
 * asked for the carrier emits byte-identical output and keeps today's
 * `undefined` miss.
 *
 * The accessor call, not a bare `global.get`, is what makes the read work when
 * it is the module's FIRST demand for `Array`: the singleton's lazy init rides
 * inside it. That case is not exotic — it is the argument order of
 * `assert.sameValue(a.constructor, Array)`.
 *
 * `constructor` is an ordinary writable INHERITED property, so an own write
 * (`a.constructor = 5`) must shadow it (§7.3.2). Unlike the sibling `"length"`
 * arm — whose key can never be an own expando — this one therefore consults the
 * #3537 expando side table first and declines to answer when the array carries
 * its own entry, letting the main body's `__vec_prop_get` miss arm return it.
 * Without the bag helper the guard degrades to the unconditional answer, which
 * is still strictly better than the `undefined` this replaces.
 */
export function vecConstructorArmInstrs(
  ctx: CodegenContext,
  keyEqualsConstructor: Instr[] | null,
  anyLocal: number,
): Instr[] {
  const byteArm = byteVecConstructorArmInstrs(ctx, keyEqualsConstructor, anyLocal);
  const carrierIdx = ctx.funcMap.get(VEC_CONSTRUCTOR_CARRIER_FN);
  if (carrierIdx === undefined || !keyEqualsConstructor) return byteArm;
  const bagHasIdx = ctx.funcMap.get("__carrier_bag_has");
  const answer: Instr[] = [{ op: "call", funcIdx: carrierIdx }, { op: "return" }];
  return [
    ...byteArm,
    ...keyEqualsConstructor,
    {
      op: "if",
      blockType: { kind: "empty" },
      then:
        bagHasIdx === undefined
          ? answer
          : [
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: bagHasIdx },
              { op: "i32.eqz" }, // no own `constructor` → the inherited carrier wins
              { op: "if", blockType: { kind: "empty" }, then: answer },
            ],
    },
  ];
}

/**
 * (#6775 S6) An ArrayBuffer is the byte vec `$__vec_i32_byte` (a `$__vec_base`
 * subtype; `$__resizable_ab` subtypes it), so the `$__vec_base` arm above
 * answered `ab.constructor` with the ARRAY carrier — `ab.constructor === Array`
 * held, and `ArrayBuffer.prototype.slice`'s SpeciesConstructor then resolved C
 * to `Array` and threw "species is not a constructor" in any module where the
 * species ladder is live.
 */
function byteVecConstructorArmInstrs(
  ctx: CodegenContext,
  keyEqualsConstructor: Instr[] | null,
  anyLocal: number,
): Instr[] {
  const byteVecIdx = ctx.vecTypeMap.get("i32_byte");
  if (byteVecIdx === undefined) return [];
  return protoWalkConstructorArmInstrs(ctx, byteVecIdx, anyLocal, keyEqualsConstructor);
}

/**
 * (#6775 S6/S7) `__extern_get(obj, "constructor")` for a nominal builtin
 * carrier (`typeIdx`; `anyLocal` holds `obj` as anyref) whose own-property
 * table is empty: §7.3.2 — `constructor` is inherited from [[Prototype]], so
 * walk it. `__getPrototypeOf` answers the intrinsic prototype for the carrier
 * (`%ArrayBuffer.prototype%`, `%DataView.prototype%`), whose companion carries
 * the identity-seeded `constructor`. An own `constructor` in the expando bag
 * still shadows it. `keyEqualsConstructor` defaults to a string-guarded test
 * of param 1.
 */
export function protoWalkConstructorArmInstrs(
  ctx: CodegenContext,
  typeIdx: number,
  anyLocal: number,
  keyEqualsConstructor: Instr[] | null = constructorKeyTestInstrs(ctx),
): Instr[] {
  const getProtoIdx = ctx.funcMap.get("__getPrototypeOf");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (!keyEqualsConstructor || getProtoIdx === undefined || externGetIdx === undefined) return [];
  const bagHasIdx = ctx.funcMap.get("__carrier_bag_has");
  const walk: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: getProtoIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: externGetIdx },
    { op: "return" },
  ];
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...keyEqualsConstructor,
        {
          op: "if",
          blockType: { kind: "empty" },
          then:
            bagHasIdx === undefined
              ? walk
              : [
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: bagHasIdx },
                  { op: "i32.eqz" },
                  { op: "if", blockType: { kind: "empty" }, then: walk },
                ],
        },
      ],
    },
  ];
}

/** `param1 is a string equal to "constructor"` as an i32, or null without native strings. */
function constructorKeyTestInstrs(ctx: CodegenContext): Instr[] | null {
  const anyStr = ctx.anyStrTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (anyStr < 0 || flattenIdx === undefined || equalsIdx === undefined) return null;
  return [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStr },
        { op: "call", funcIdx: flattenIdx },
        ...nativeStringLiteralInstrs(ctx, "constructor"),
        { op: "call", funcIdx: equalsIdx },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}
