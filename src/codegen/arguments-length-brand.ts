// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4658) Standalone `arguments` identity and configurable-length state.
 *
 * Arguments used to be branded by appending every observable arguments object
 * to the global vec-overlay table. That table is strongly held and linearly
 * scanned; Acorn's hot parser calls therefore changed a ~75 ms parse into a
 * progressively slower multi-second parse. The brand is now the concrete
 * `$__arguments_vec` WasmGC subtype. Its third field stores the rare
 * delete/revive state for the configurable own `length` property. Brand checks
 * are O(1) `ref.test`s and ordinary calls retain no global references.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const ARGUMENTS_VEC_STRUCT = "__arguments_vec";
export const ARGUMENTS_LENGTH_ABSENT_FIELD = 2;
const LENGTH_ABSENT_FIELD = ARGUMENTS_LENGTH_ABSENT_FIELD;
/** The ordinary `arguments.length` value, when it has been assigned a value
 * that is not representable by the vec's physical i32 length. */
export const ARGUMENTS_LENGTH_VALUE_FIELD = 3;
/** Whether `ARGUMENTS_LENGTH_VALUE_FIELD` contains the current own property. */
export const ARGUMENTS_LENGTH_OVERRIDE_FIELD = 4;

/**
 * A distinct subtype makes the arguments brand an O(1) WasmGC `ref.test`.
 * Field 2 records the configurable-own-property tombstone required by #4658.
 * Fields 3/4 preserve an arbitrary ordinary-object `length` assignment. The
 * vec's field 0 remains the physical/index-domain length used by array-like
 * operations; an arguments object's own `length` is not an Array exotic and
 * therefore must not coerce a string assignment into that field.
 */
export function getOrRegisterArgumentsVecType(ctx: CodegenContext, baseVecTypeIdx: number, arrTypeIdx: number): number {
  const existing = ctx.structMap.get(ARGUMENTS_VEC_STRUCT);
  if (existing !== undefined) return existing;
  const base = ctx.mod.types[baseVecTypeIdx];
  if (base && base.kind === "struct") base.final = false;
  const fields = [
    { name: "length", type: { kind: "i32" } as ValType, mutable: true },
    { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx } as ValType, mutable: true },
    { name: "lengthAbsent", type: { kind: "i32" } as ValType, mutable: true },
    { name: "lengthValue", type: EXT, mutable: true },
    { name: "lengthOverride", type: { kind: "i32" } as ValType, mutable: true },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: ARGUMENTS_VEC_STRUCT, superTypeIdx: baseVecTypeIdx, fields });
  ctx.structMap.set(ARGUMENTS_VEC_STRUCT, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, ARGUMENTS_VEC_STRUCT);
  ctx.structFields.set(ARGUMENTS_VEC_STRUCT, fields);
  return typeIdx;
}

/**
 * The subtype's `lengthAbsent` field records that this arguments object's
 * `length` has been DELETED. §10.4.4 makes `length` configurable, so `delete
 * args.length` must succeed AND the property must then be gone; the vec has no
 * per-key storage for `length` (`__vec_prop_set` refuses the key outright,
 * because the real vec length must never be shadowed by the bag), so the
 * deletion is recorded as subtype-local state rather than as a bag entry.
 *
 * Why the tombstone is required and not cosmetic: test262's
 * `propertyHelper.verifyProperty` does not read `configurable` off the
 * descriptor alone — `isConfigurable` performs `delete obj[name]` and then
 * asserts `!hasOwnProperty(obj, name)`. Without the tombstone
 * `language/arguments-object/10.6-6-2` and `10.6-7-1` keep failing with
 * "length descriptor should be configurable" even once gOPD answers `true`
 * (measured — that is exactly what the brand alone produced).
 */
const ABSENT_NAME = "__args_len_absent";
const DELETE_NAME = "__args_len_delete";
const REVIVE_NAME = "__args_len_revive";
/**
 * (#4491 wave-7) `__args_is_branded(vec) -> i32` — the plain "is this vec an
 * `arguments` exotic?" query, which #4658 minted the brand for but never
 * exposed on its own (every one of its four natives asks about `length`).
 * §20.1.3.6 step 12 needs exactly that question and nothing about `length`:
 * `Object.prototype.toString.call(<arguments>)` must be `[object Arguments]`,
 * and the runtime classifier's `ref.test $__vec_base` arm answers
 * `[object Array]` because both share `$Vec` (the same conflation #4667 records
 * for `Array.isArray`).
 *
 * Deliberately NOT routed through `Array.isArray`/`__is_vec`: #4667's landing
 * hazard is that narrowing THAT predicate flips test262's `propertyHelper`
 * onto a string-valued `length` probe that #4658's residual 1 cannot satisfy,
 * silently trading `10.6-6-2` away. This native is read by the class-tag
 * classifier only, so it cannot reach that harness branch.
 */
const IS_BRANDED_NAME = "__args_is_branded";

/**
 * Reserve the arguments-query helpers before finalize. Idempotent; returns the
 * first funcIdx, or `undefined` outside standalone where the host owns the MOP.
 */
export function reserveArgumentsLengthBrand(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(ABSENT_NAME);
  if (existing !== undefined) return existing;
  const reserve = (name: string, params: ValType[], results: ValType[], placeholder: Instr[]): number => {
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body: placeholder, exported: false });
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };
  // Placeholders are safe negative answers until finalize fills the bodies.
  const absentIdx = reserve(ABSENT_NAME, [EXT], [I32], [{ op: "i32.const", value: 0 }]);
  reserve(DELETE_NAME, [EXT, EXT], [I32], [{ op: "i32.const", value: 0 }]);
  reserve(REVIVE_NAME, [EXT], [], []);
  reserve(IS_BRANDED_NAME, [EXT], [I32], [{ op: "i32.const", value: 0 }]);
  return absentIdx;
}

/**
 * `i32` on the stack: has `length` been deleted from the branded arguments
 * object in param `objParam`? `[]` when nothing was ever branded, so the caller
 * must supply its own unconditional answer (see the call sites, which all keep
 * their pre-#4658 constant in that case).
 */
export function buildArgumentsLengthAbsentCall(ctx: CodegenContext, objParam = 0): Instr[] {
  const idx = ctx.funcMap.get(ABSENT_NAME);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objParam },
    { op: "call", funcIdx: idx },
  ];
}

/**
 * `if (__args_len_delete(obj, key)) return 1;` — the §10.4.4 arm for
 * `delete <argumentsObject>.length`. `[]` when nothing was branded.
 *
 * Placed AFTER the caller's `configurable` gate on purpose: a sealed or frozen
 * arguments object answers `configurable: false` from `__vec_gopd`, so the gate
 * refuses the delete before this arm can record a tombstone.
 */
export function buildArgumentsLengthDeleteArm(ctx: CodegenContext, objParam: number, keyLocal: number): Instr[] {
  const idx = ctx.funcMap.get(DELETE_NAME);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objParam },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: idx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
  ];
}

/**
 * `if (__args_len_absent(vec)) <miss>` for `__vec_gopd`'s `length` arm: a
 * branded arguments object whose `length` was deleted has no own `length` at
 * all, and gOPD must agree with the `__hasOwnProperty` arm that reads the same
 * tombstone bit.
 *
 * `miss` is a FACTORY so this payload never shares `Instr` identities with the
 * caller's own miss tail (`reference_shared_instr_object_dce_double_remap`).
 * `[]` when no arguments object was ever branded.
 */
export function buildArgumentsLengthDeletedBail(ctx: CodegenContext, miss: () => Instr[]): Instr[] {
  const call = buildArgumentsLengthAbsentCall(ctx, 0);
  if (call.length === 0) return [];
  return [...call, { op: "if", blockType: { kind: "empty" }, then: miss() }];
}

/**
 * `if (__args_len_absent(vec)) return 0;` — the presence tail for a site whose
 * next instruction is the unconditional "yes, `length` is here" answer
 * (`__hasOwnProperty` / `__object_hasOwn` / `__extern_has`). `[]` when nothing
 * was branded, so those sites keep their pre-#4658 constant.
 *
 * A FACTORY: this payload is spliced into several functions and a shared
 * `Instr` object reachable from more than one is remapped more than once by the
 * finalize walks (`reference_shared_instr_object_dce_double_remap`).
 */
export function buildArgumentsLengthAbsentTail(ctx: CodegenContext, objParam = 0): Instr[] {
  const call = buildArgumentsLengthAbsentCall(ctx, objParam);
  if (call.length === 0) return [];
  return [...call, { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] }];
}

/**
 * `if (__args_len_absent(vec)) return <miss>;` — the same tail for a VALUE site
 * (`__extern_get`'s `length` arm), where the absent answer is `undefined`
 * rather than `0`. `miss` is a factory for the same reason as above.
 */
export function buildArgumentsLengthAbsentMiss(ctx: CodegenContext, objParam: number, miss: () => Instr[]): Instr[] {
  const call = buildArgumentsLengthAbsentCall(ctx, objParam);
  if (call.length === 0) return [];
  return [...call, { op: "if", blockType: { kind: "empty" }, then: [...miss(), { op: "return" }] }];
}

/**
 * (#4491 wave-7) `i32` on the stack: is the vec in `objParam` a branded
 * `arguments` exotic? `[]` when the native was never reserved (host/gc lane),
 * so a caller must keep its own unconditional answer in that case.
 */
export function buildArgumentsIsBrandedCall(ctx: CodegenContext, objParam = 0): Instr[] {
  const idx = ctx.funcMap.get(IS_BRANDED_NAME);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objParam },
    { op: "call", funcIdx: idx },
  ];
}

/**
 * Build the standalone OrdinaryToPrimitive arm for an arguments object.
 * Arguments and Arrays share the indexed/length vec carrier, but only the
 * latter uses Array.prototype.toString's join result as its intrinsic string.
 * The callbacks emit fresh instruction arrays for each method-order branch.
 */
export function buildArgumentsToPrimitiveArm(
  ctx: CodegenContext,
  isStringHint: Instr[],
  tryOrdinaryMethod: (name: "valueOf" | "toString", defaultObjectToStringOnMissing: boolean) => Instr[],
  stringExtern: (value: string) => Instr[],
): Instr[] {
  const brandCall = buildArgumentsIsBrandedCall(ctx, 0);
  if (brandCall.length === 0) return [];
  const argumentsTag = (): Instr[] => [...stringExtern("[object Arguments]"), { op: "return" }];
  return [
    ...brandCall,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...isStringHint,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...tryOrdinaryMethod("toString", false), ...tryOrdinaryMethod("valueOf", false), ...argumentsTag()],
          else: [...tryOrdinaryMethod("valueOf", false), ...tryOrdinaryMethod("toString", false), ...argumentsTag()],
        },
      ],
    },
  ];
}

/** `__args_len_revive(obj)` — a store to `length` recreates the property. */
export function buildArgumentsLengthReviveCall(ctx: CodegenContext, objParam = 0): Instr[] {
  const idx = ctx.funcMap.get(REVIVE_NAME);
  if (idx === undefined) return [];
  return [
    { op: "local.get", index: objParam },
    { op: "call", funcIdx: idx },
  ];
}

/** Fill the reserved helpers with subtype tests and field accesses. */
export function fillArgumentsLengthBrand(
  ctx: CodegenContext,
  _objectTypeIdx: number,
  _overlayEnsureIdx: number,
  _overlayLookupIdx: number,
): void {
  const argumentsTypeIdx = ctx.structMap.get(ARGUMENTS_VEC_STRUCT);
  if (argumentsTypeIdx === undefined) return;
  const setFn = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };
  const isArguments = (param = 0): Instr[] => [
    { op: "local.get", index: param },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: argumentsTypeIdx },
  ];
  const castArguments = (param = 0): Instr[] => [
    { op: "local.get", index: param },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: argumentsTypeIdx },
  ];

  setFn(
    ABSENT_NAME,
    [],
    [
      ...isArguments(),
      {
        op: "if",
        blockType: { kind: "val", type: I32 },
        then: [...castArguments(), { op: "struct.get", typeIdx: argumentsTypeIdx, fieldIdx: LENGTH_ABSENT_FIELD }],
        else: [{ op: "i32.const", value: 0 }],
      },
    ],
  );

  // ── __args_len_delete(vec, key) -> i32 (1 = handled) ─────────────────────
  const keyIsLength = buildKeyIsLengthInstrs(ctx, 1);
  setFn(
    DELETE_NAME,
    [],
    keyIsLength === null
      ? [{ op: "i32.const", value: 0 }]
      : [
          ...keyIsLength,
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
          ...isArguments(),
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
          ...castArguments(),
          { op: "i32.const", value: 1 },
          { op: "struct.set", typeIdx: argumentsTypeIdx, fieldIdx: LENGTH_ABSENT_FIELD },
          ...castArguments(),
          { op: "i32.const", value: 0 },
          { op: "struct.set", typeIdx: argumentsTypeIdx, fieldIdx: ARGUMENTS_LENGTH_OVERRIDE_FIELD },
          { op: "i32.const", value: 1 },
        ],
  );

  // ── __args_len_revive(vec) ───────────────────────────────────────────────
  setFn(
    REVIVE_NAME,
    [],
    [
      ...isArguments(),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...castArguments(),
          { op: "i32.const", value: 0 },
          { op: "struct.set", typeIdx: argumentsTypeIdx, fieldIdx: LENGTH_ABSENT_FIELD },
        ],
      },
    ],
  );

  // ── __args_is_branded(vec) -> i32 ────────────────────────────────────────
  // (#4491 wave-7) Pure type-identity query; no overlay lookup or allocation.
  setFn(IS_BRANDED_NAME, [], isArguments());
}

/**
 * `key === "length"` over the externref key in `keyLocal`, i32 on the stack.
 * `null` when the native-string helpers this module cannot mint are absent, so
 * the caller degrades to "never mine".
 */
function buildKeyIsLengthInstrs(ctx: CodegenContext, keyLocal: number): Instr[] | null {
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (strFlattenIdx === undefined || strEqualsIdx === undefined || ctx.anyStrTypeIdx < 0) return null;
  return [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: keyLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "call", funcIdx: strEqualsIdx },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/** `i32` on the stack: is `objParam` an arguments-vec subtype? */
export function buildArgumentsBrandBit(objParam: number, argumentsTypeIdx: number | undefined): Instr[] {
  if (argumentsTypeIdx === undefined) return [{ op: "i32.const", value: 0 }];
  return [
    { op: "local.get", index: objParam },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: argumentsTypeIdx },
  ];
}
