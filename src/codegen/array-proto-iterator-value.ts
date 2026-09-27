// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 RS1) `Array.prototype.{values,keys,entries}` as a FIRST-CLASS VALUE,
 * applied to an arbitrary array-LIKE, under `--target standalone` / `--target
 * wasi`.
 *
 * ## The gap
 *
 * `emitArrayProtoMemberBody` (`array-object-proto.ts`) has a real reflective
 * body for the mutators, the higher-order members and `slice`, and degrades
 * everything else to a catchable
 * `Array.prototype.<m> is not yet callable as a value in --target standalone`.
 * The three iterator factories were in that residue, which is the verbatim error
 * on `built-ins/Array/prototype/{values,keys,entries}/returns-iterator-from-object.js`:
 *
 * ```js
 * var iter = Array.prototype.values.call({ length: 2 });
 * assert.sameValue(Object.getPrototypeOf(iter),
 *                  Object.getPrototypeOf([][Symbol.iterator]()));
 * ```
 *
 * All three rows are **ES2015** (`features: [Symbol.iterator]`), not the
 * `Unclassified (untagged)` the plan file recorded for them — `classifyEdition`
 * reads the `features:` line, and these files have one.
 *
 * ## Shape, and why a snapshot vec is enough for these rows
 *
 * §23.1.3.35 is `CreateArrayIterator(? ToObject(this), <kind>)`. The receiver is
 * an ORDINARY object here, so the iteration has to go through the array-like
 * substrate (`__extern_length` / `__extern_get_idx`) rather than a typed `$Vec`
 * core — the same reason the #4394 `__hof_<name>` routing exists two arms above
 * this one.
 *
 * The record is built directly, exactly as `ensureTaDynIteratorHelper` (#6651
 * IT3) and the Map/Set reflective arm do: `ITER_KIND_VEC` over a canonical
 * externref vec, `family = ITER_FAMILY_ARRAY`. That family stamp is what makes
 * the row pass — `__iter_rec_proto` (#6484 S1) keys `%ArrayIteratorPrototype%`
 * off the family, so the identity against `[][Symbol.iterator]()` holds by
 * construction rather than by a second spelling of the prototype.
 *
 * **Documented residual, deliberate:** the vec is a SNAPSHOT taken when the
 * factory is called, so a receiver mutated mid-iteration is not observed. That
 * is the same residual IT3 recorded for the dyn-view factories, and it is
 * correct for a live *array* receiver only through the `__iterator` adoption arm
 * a typed `$Vec` gets — which an ordinary array-like object cannot take. Nothing
 * regresses: these members previously threw for every receiver.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getArrTypeIdxFromVec } from "./index.js";
import {
  ensureNativeIteratorRuntime,
  getOrRegisterIterRecType,
  ITER_FAMILY_ARRAY,
  ITER_KIND_VEC,
} from "./iterator-native.js";
import { noJsHost } from "./js-errors.js";
import { ensureObjectRuntime, ensureObjVecBuilders } from "./object-runtime.js";
import { getOrRegisterVecType } from "./registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { emitBrandCheckTypeError } from "./native-proto.js";

const EXT: ValType = { kind: "externref" };
const F64: ValType = { kind: "f64" };

/** The three §23.1.3 iterator factories this module answers for. */
const ARRAY_PROTO_ITERATOR_MEMBERS: ReadonlySet<string> = new Set(["values", "keys", "entries"]);

/**
 * Emit the reflective closure body for `Array.prototype.<member>` where
 * `member` is `values` / `keys` / `entries`. `this` is closure-param 1.
 *
 * Returns `undefined` — leaving the caller's pre-existing refusal in place, and
 * the module byte-identical — in the JS-host lane or when any dependency is
 * unregistered.
 */
export function emitArrayProtoIteratorMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (!noJsHost(ctx)) return undefined;
  if (!ARRAY_PROTO_ITERATOR_MEMBERS.has(member)) return undefined;

  // Dependencies FIRST, while a late import can still shift indices — the
  // discipline `emitArrayProtoMemberBody`'s sibling arms follow.
  ensureObjectRuntime(ctx);
  ensureNativeIteratorRuntime(ctx);
  ensureLateImport(ctx, "__extern_length", [EXT], [F64]);
  ensureLateImport(ctx, "__extern_get_idx", [EXT, F64], [EXT]);
  ensureLateImport(ctx, "__box_number", [F64], [EXT]);
  flushLateImportShifts(ctx, fctx);
  const lengthIdx = ctx.funcMap.get("__extern_length");
  const getIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  if (lengthIdx === undefined || getIdxIdx === undefined || boxNumberIdx === undefined) return undefined;

  const iterRecTypeIdx = getOrRegisterIterRecType(ctx);
  if (iterRecTypeIdx < 0) return undefined;
  const canonVecTypeIdx = getOrRegisterVecType(ctx, "externref", EXT);
  const canonArrTypeIdx = getArrTypeIdxFromVec(ctx, canonVecTypeIdx);
  if (canonVecTypeIdx < 0 || canonArrTypeIdx < 0) return undefined;
  let objVecNewIdx = 0;
  let objVecPushIdx = 0;
  if (member === "entries") {
    const builders = ensureObjVecBuilders(ctx);
    if (builders === undefined) return undefined;
    objVecNewIdx = builders.newIdx;
    objVecPushIdx = builders.pushIdx;
  }
  flushLateImportShifts(ctx, fctx);

  // §23.1.3.35 step 1 — `ToObject(this)`, so a nullish receiver is a TypeError
  // BEFORE any length read. Under the undefined-singleton regime `undefined` is
  // a NON-null sentinel externref, so `ref.is_null` alone misses
  // `.call(undefined)` (the sibling `__hof_<name>` arm records the same trap).
  const thisThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, thisThrow, `Array.prototype.${member} called on null or undefined`);
  fctx.body.push({ op: "local.get", index: 1 }, { op: "ref.is_null" });
  const isUndefinedIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefinedIdx }, { op: "i32.or" });
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thisThrow });

  const lenLocal = allocLocal(fctx, `__api_len_${fctx.locals.length}`, { kind: "i32" });
  const outLocal = allocLocal(fctx, `__api_out_${fctx.locals.length}`, { kind: "ref", typeIdx: canonArrTypeIdx });
  const iLocal = allocLocal(fctx, `__api_i_${fctx.locals.length}`, { kind: "i32" });
  const pairLocal = member === "entries" ? allocLocal(fctx, `__api_pair_${fctx.locals.length}`, EXT) : -1;

  // len = ToLength(Get(O, "length")); a negative or NaN length saturates to 0,
  // which is `array.new_default`'s valid empty case.
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: lengthIdx },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: lenLocal },
    { op: "local.get", index: lenLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: lenLocal },
      ],
    },
    { op: "local.get", index: lenLocal },
    { op: "array.new_default", typeIdx: canonArrTypeIdx },
    { op: "local.set", index: outLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: iLocal },
  );

  const idxAsF64: Instr[] = [{ op: "local.get", index: iLocal }, { op: "f64.convert_i32_s" }];
  const element = (): Instr[] => [{ op: "local.get", index: 1 }, ...idxAsF64, { op: "call", funcIdx: getIdxIdx }];
  const yielded = (): Instr[] => {
    if (member === "keys") return [...idxAsF64, { op: "call", funcIdx: boxNumberIdx }];
    if (member === "values") return element();
    // entries — a fresh two-slot `$ObjVec` holding [box(i), element], the same
    // pair carrier the `$Vec` path uses, so `pair[0]` / `pair.length` keep
    // routing through the native `$ObjVec` arms.
    return [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: pairLocal },
      { op: "local.get", index: pairLocal },
      ...idxAsF64,
      { op: "call", funcIdx: boxNumberIdx },
      { op: "call", funcIdx: objVecPushIdx },
      { op: "local.get", index: pairLocal },
      ...element(),
      { op: "call", funcIdx: objVecPushIdx },
      { op: "local.get", index: pairLocal },
    ];
  };

  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal },
    { op: "local.get", index: lenLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: outLocal },
    { op: "local.get", index: iLocal },
    ...yielded(),
    { op: "array.set", typeIdx: canonArrTypeIdx },
    { op: "local.get", index: iLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iLocal },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // struct.new $__IterRec(kind, vec, idx, userIter, family) — field order is
  // load-bearing (see getOrRegisterIterRecType).
  fctx.body.push(
    { op: "i32.const", value: ITER_KIND_VEC },
    { op: "local.get", index: lenLocal },
    { op: "local.get", index: outLocal },
    { op: "struct.new", typeIdx: canonVecTypeIdx },
    { op: "i32.const", value: 0 },
    { op: "ref.null.extern" },
    { op: "i32.const", value: ITER_FAMILY_ARRAY },
    { op: "struct.new", typeIdx: iterRecTypeIdx },
    { op: "extern.convert_any" },
  );
  return EXT;
}
