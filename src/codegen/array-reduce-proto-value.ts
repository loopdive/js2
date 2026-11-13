/**
 * (#6709, S3-b of #5385) `Array.prototype.reduce` / `reduceRight` as callable
 * VALUES on the native regime.
 *
 * The reflective form — `Array.prototype.reduce.call(arrayLike, cb[, init])`,
 * or the method transferred onto an ordinary object — reaches the native-proto
 * closure body, not the direct-call lowering. Its sibling HOF members already
 * route to the native `__hof_<name>(recv, cb, thisArg)` loop (#4394); the reduce
 * family was held back because its loop takes `(recv, cb, init, hasInit)`, and
 * `hasInit` is a question the fixed-slot closure ABI cannot answer: §23.1.3.24
 * step 5 / §23.1.3.25 step 5 test whether `initialValue` is PRESENT, so an
 * explicit `undefined` seeds the accumulator while an omitted argument does not.
 * A padded slot reads the same `undefined` either way.
 *
 * So the reduce family takes the receiver-aware VARIADIC closure ABI
 * (`(self, this, (ref null $vec_externref))`, the one `join`/`push`/`concat`
 * use) and derives `hasInit` from the packed argument COUNT — the same rule the
 * direct-call lowering applies (`callExpr.arguments.length >= 2`, the #3098
 * dispatcher's `arity >= 2`). The ABI switch is confined to the native regime
 * (`ctx.standalone || ctx.wasi`), so host-assisted `gc` modules are untouched.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { canonicalUndefinedExternInstrs, undefinedSingletonActive } from "./any-helpers.js";
import { ensureNativeArrayHof, NATIVE_HOF_REDUCE } from "./hof-native.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";

/** True when `Array.prototype.<member>`'s closure uses the packed variadic ABI. */
export function isArrayReduceVariadicMember(ctx: CodegenContext, member: string): boolean {
  return NATIVE_HOF_REDUCE.has(member) && (ctx.standalone || ctx.wasi);
}

/**
 * §23.1.3 step 1 — ToObject(this): a null/undefined receiver (closure param 1)
 * is a TypeError BEFORE any iteration. Under the undefined-singleton regime
 * `undefined` is a NON-null sentinel externref, so `ref.is_null` alone misses
 * `.call(undefined)`; OR in `__extern_is_undefined`. The caller must have run
 * every late-import-adding ensure first so the fetched funcIdx is final.
 */
export function emitArrayProtoHofReceiverGuard(ctx: CodegenContext, fctx: FunctionContext, member: string): void {
  const thisThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, thisThrow, `Array.prototype.${member} called on null or undefined`);
  fctx.body.push({ op: "local.get", index: 1 }, { op: "ref.is_null" });
  const isUndefinedIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefinedIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefinedIdx }, { op: "i32.or" });
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thisThrow });
}

/**
 * Emit the reduce/reduceRight closure body: receiver guard, unpack `cb` and the
 * optional `initialValue` from the argument vector (param 2), then call
 * `__hof_<member>(recv, cb, init, hasInit)`. Returns `undefined` (emitting
 * nothing) when this is not a reduce member on the native regime, or the loop
 * helper / vector layout is unavailable — the caller keeps its refusal.
 */
export function emitArrayReduceProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (!isArrayReduceVariadicMember(ctx, member)) return undefined;
  // Every late-import-adding ensure BEFORE the first body instruction.
  if (variadicArgsVecType(ctx, fctx) === undefined) return undefined;
  const hofIdx = ensureNativeArrayHof(ctx, member);
  if (hofIdx === undefined) return undefined;
  const undef = canonicalUndefinedExternInstrs(ctx);

  emitArrayProtoHofReceiverGuard(ctx, fctx, member);
  const { argsLen, argAt } = emitVariadicArgsUnpack(ctx, fctx, "reduce")!;
  fctx.body.push({ op: "local.get", index: 1 }); // receiver (`this`)
  // An omitted callback is `undefined`, so the helper's IsCallable gate throws.
  fctx.body.push(...argAt(0, undef));
  fctx.body.push(...argAt(1, [{ op: "ref.null.extern" }])); // init (unused when !hasInit)
  // hasInit = argumentsCount >= 2 — presence, not undefined-ness.
  fctx.body.push({ op: "local.get", index: argsLen }, { op: "i32.const", value: 1 }, { op: "i32.gt_s" });
  fctx.body.push({ op: "call", funcIdx: hofIdx });
  return { kind: "externref" };
}

/** The packed `(ref null $vec_externref)` argument vector at closure param 2, if the ABI has one. */
function variadicArgsVecType(
  ctx: CodegenContext,
  fctx: FunctionContext,
): { vecTypeIdx: number; arrTypeIdx: number } | undefined {
  const argsParam = fctx.params[2]?.type;
  if (!argsParam || (argsParam.kind !== "ref" && argsParam.kind !== "ref_null")) return undefined;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, argsParam.typeIdx);
  const argsArrDef = ctx.mod.types[arrTypeIdx];
  if (argsArrDef?.kind !== "array" || argsArrDef.element.kind !== "externref") return undefined;
  return { vecTypeIdx: argsParam.typeIdx, arrTypeIdx };
}

/** The unpacked variadic argument vector: its length local and an `args[i]`-or-`absent` reader. */
export interface VariadicArgs {
  /** i32 local holding the argument COUNT (0 for a null vector). */
  readonly argsLen: number;
  /** `args[i]` when `argc > i`, else the `absent` instructions; leaves an externref. */
  readonly argAt: (i: number, absent: Instr[]) => Instr[];
  /** `args[i]` for a computed i32 index the caller has bounds-checked; leaves an externref. */
  readonly argAtDynamic: (index: Instr[]) => Instr[];
}

/**
 * (#6709, shared by #6912) Unpack the receiver-aware variadic closure ABI's
 * argument vector (param 2) into a count local + data local. Presence-sensitive
 * arguments (reduce's initialValue, lastIndexOf's fromIndex, ...) test the
 * count, never undefined-ness. Returns undefined, emitting nothing, when
 * param 2 is not a packed externref vector.
 */
export function emitVariadicArgsUnpack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  prefix: string,
): VariadicArgs | undefined {
  const vec = variadicArgsVecType(ctx, fctx);
  if (vec === undefined) return undefined;
  const { vecTypeIdx, arrTypeIdx: argsArrTypeIdx } = vec;
  const argsLen = allocLocal(fctx, `__${prefix}_args_len_${fctx.locals.length}`, { kind: "i32" });
  const argsData = allocLocal(fctx, `__${prefix}_args_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: argsArrTypeIdx,
  });
  // argsLen = vec == null ? 0 : vec.length ; argsData = vec.data
  fctx.body.push(
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: argsLen },
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.set", index: argsData },
      ],
    },
  );
  const argAt = (i: number, absent: Instr[]): Instr[] => [
    { op: "local.get", index: argsLen },
    { op: "i32.const", value: i },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: argsData },
        { op: "ref.as_non_null" },
        { op: "i32.const", value: i },
        { op: "array.get", typeIdx: argsArrTypeIdx },
      ],
      else: absent,
    },
  ];
  const argAtDynamic = (index: Instr[]): Instr[] => [
    { op: "local.get", index: argsData },
    { op: "ref.as_non_null" },
    ...index,
    { op: "array.get", typeIdx: argsArrTypeIdx },
  ];
  return { argsLen, argAt, argAtDynamic };
}
