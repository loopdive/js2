// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6683 — native standalone bodies for `slice`, `at` and `reverse` on a
 * DYNAMIC (`any`/externref) Array receiver.
 *
 * The #6447 producer family (`dyn-array-producers.ts`) served `concat`/`sort`
 * and (#2717) `flat`/`flatMap`, and named `slice`/`reverse` as the same defect
 * left for later. Under `--target standalone`
 *
 *     function id(v) { return v; }
 *     id([1, 2, 3]).slice(0);      // answered null
 *
 * because `slice` and `at` are ALSO `String.prototype` names: the guarded
 * native-string lowering (`compileGuardedNativeStringMethodCall`) claimed the
 * call, and its `ref.test $AnyString` miss arm answered the string method's
 * benign sentinel (`ref.null $AnyString` ⇒ null) — never an array. `reverse`
 * is not a string name; it reached the closed-method dispatcher, whose
 * open-`$Object` bottom arm answers `undefined` for a vec brand. This was
 * moment's standalone-dynamic blocker: `configFromStringAndFormat` ends with
 * `getParsingFlags(config).parsedDateParts = config._a.slice(0)` and `isValid`
 * then runs `some.call(flags.parsedDateParts, …)` on the null.
 *
 * Everything runs on the array-like substrate the #6447 helpers use
 * (`__extern_length`, `__extern_get_idx`, `__extern_set`, `__unbox_number`,
 * `__objvec_new`/`__objvec_push`), so a concrete `__vec_<k>`, the boxed-any
 * `$ObjVec` and an ordinary array-LIKE all take the same body. Emitted at
 * RESERVE time as append-only defined funcs (no funcIdx shift); the
 * dispatcher fill only READS `funcMap` (#1719). Standalone-only, the gate the
 * `__extern_get_idx` array-like arms carry.
 *
 * Deliberate under-approximations (recorded on #6683):
 *   - ArraySpeciesCreate is a plain `$ObjVec` (as for `concat`/`flat`).
 *   - A HOLE inside the sliced range is copied as `undefined` (a present
 *     element), not left absent; `reverse` likewise swaps a hole as
 *     `undefined` instead of deleting.
 *   - ToIntegerOrInfinity of an argument is `__unbox_number` — exact for
 *     number/boolean/string/null/undefined; an OBJECT argument skips
 *     ToPrimitive (the #2717 `flat` depth simplification).
 */
import type { Instr, ValType } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";

/** Method names served by {@link ensureNativeArraySlice}. */
export const NATIVE_SLICE_METHODS: ReadonlySet<string> = new Set(["slice", "at", "reverse"]);

/**
 * The subset that is ALSO a `String.prototype` name. The guarded native-string
 * lowering claims those calls on an `any` receiver, so it must route its
 * `$AnyString`-miss arm to the dispatcher (whose vec arm serves the array case)
 * instead of the string method's null sentinel.
 */
export const STRING_ARRAY_SHARED_METHODS: ReadonlySet<string> = new Set(["slice", "at"]);

/** Arity forms a dynamic-receiver dispatcher arm may claim. */
export function isNativeSliceForm(methodName: string, arity: number): boolean {
  if (methodName === "slice") return arity >= 0 && arity <= 2;
  if (methodName === "at") return arity === 0 || arity === 1;
  if (methodName === "reverse") return arity === 0;
  return false;
}

export interface SliceDeps {
  externLength: number;
  externGetIdx: number;
  externSet: number;
  externIsUndefined: number;
  unboxNumber: number;
  boxNumber: number;
  objVecNew: number;
  objVecPush: number;
}

export function resolveSliceDeps(ctx: CodegenContext): SliceDeps | undefined {
  ensureObjectRuntime(ctx);
  addUnionImportsViaRegistry(ctx);
  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const deps = {
    externLength: get("__extern_length"),
    externGetIdx: get("__extern_get_idx"),
    externSet: get("__extern_set"),
    externIsUndefined: get("__extern_is_undefined"),
    unboxNumber: get("__unbox_number"),
    boxNumber: get("__box_number"),
    objVecNew: get("__objvec_new"),
    objVecPush: get("__objvec_push"),
  };
  for (const v of Object.values(deps)) if (v === undefined) return undefined;
  return deps as SliceDeps;
}

const F64: ValType = { kind: "f64" };
const EXTERNREF: ValType = { kind: "externref" };

/** Throw the step-1 TypeError when `local` is null or undefined. */
export function requireObjectCoercible(ctx: CodegenContext, deps: SliceDeps, local: number, method: string): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    { op: "local.get", index: local },
    { op: "call", funcIdx: deps.externIsUndefined },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", `Array.prototype.${method} called on null or undefined`),
    },
  ];
}

/**
 * `args[argIdx]` as ToIntegerOrInfinity, or `dflt` when the argument is absent
 * (or, with `undefinedIsDefault`, explicitly `undefined`). Leaves an f64.
 */
export function integerArg(
  deps: SliceDeps,
  argsLocal: number,
  argIdx: number,
  tmpLocal: number,
  argLocal: number,
  dflt: Instr[],
  undefinedIsDefault: boolean,
): Instr[] {
  const present: Instr[] = [
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: deps.externLength },
    { op: "f64.const", value: argIdx },
    { op: "f64.gt" },
  ];
  if (undefinedIsDefault) {
    present.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: argsLocal },
        { op: "f64.const", value: argIdx },
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "call", funcIdx: deps.externIsUndefined },
        { op: "i32.eqz" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    });
  }
  return [
    ...present,
    {
      op: "if",
      blockType: { kind: "val", type: F64 },
      then: [
        { op: "local.get", index: argsLocal },
        { op: "f64.const", value: argIdx },
        { op: "call", funcIdx: deps.externGetIdx },
        { op: "local.set", index: argLocal },
        { op: "local.get", index: argLocal },
        { op: "call", funcIdx: deps.unboxNumber },
        { op: "local.tee", index: tmpLocal },
        { op: "local.get", index: tmpLocal },
        { op: "f64.ne" },
        {
          op: "if",
          blockType: { kind: "val", type: F64 },
          then: [{ op: "f64.const", value: 0 }],
          else: [{ op: "local.get", index: tmpLocal }, { op: "f64.trunc" }],
        },
      ],
      else: dflt,
    },
  ];
}

/**
 * (#6701) ArraySpeciesCreate(O, count) → ArrayCreate(count) throws a RangeError
 * when `count` (an f64 on the stack) exceeds 2^32 − 1 (§10.4.2.2 step 1) —
 * before any element is copied, so an array-like with a huge `length` fails
 * the way the spec says instead of trapping on the result's growth.
 */
export function arrayCreateLengthCheck(ctx: CodegenContext): Instr[] {
  return [
    { op: "f64.const", value: 4294967295 },
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "RangeError", "Invalid array length"),
    },
  ];
}

/** Relative index (value on stack) clamped into [0, len] — §23.1.3.28 steps 4–5 / 7–8. */
export function clampRelative(tmpLocal: number, lenLocal: number): Instr[] {
  return [
    { op: "local.set", index: tmpLocal },
    { op: "local.get", index: tmpLocal },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "val", type: F64 },
      then: [
        { op: "local.get", index: lenLocal },
        { op: "local.get", index: tmpLocal },
        { op: "f64.add" },
        { op: "f64.const", value: 0 },
        { op: "f64.max" },
      ],
      else: [{ op: "local.get", index: tmpLocal }, { op: "local.get", index: lenLocal }, { op: "f64.min" }],
    },
  ];
}

/** `__arrprod_slice(recv, args) -> externref` — §23.1.3.28. */
function buildSliceBody(ctx: CodegenContext, deps: SliceDeps): { body: Instr[]; locals: ValType[] } {
  const RECV = 0;
  const ARGS = 1;
  const LEN = 2;
  const K = 3;
  const FIN = 4;
  const TMP = 5;
  const ARG = 6;
  const OUT = 7;
  const body: Instr[] = [
    ...requireObjectCoercible(ctx, deps, RECV, "slice"),
    { op: "local.get", index: RECV },
    { op: "call", funcIdx: deps.externLength },
    { op: "local.set", index: LEN },
    ...integerArg(deps, ARGS, 0, TMP, ARG, [{ op: "f64.const", value: 0 }], false),
    ...clampRelative(TMP, LEN),
    { op: "local.set", index: K },
    ...integerArg(deps, ARGS, 1, TMP, ARG, [{ op: "local.get", index: LEN }], true),
    ...clampRelative(TMP, LEN),
    { op: "local.set", index: FIN },
    { op: "local.get", index: FIN },
    { op: "local.get", index: K },
    { op: "f64.sub" },
    ...arrayCreateLengthCheck(ctx),
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: OUT },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: K },
            { op: "local.get", index: FIN },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: OUT },
            { op: "local.get", index: RECV },
            { op: "local.get", index: K },
            { op: "call", funcIdx: deps.externGetIdx },
            { op: "call", funcIdx: deps.objVecPush },
            { op: "local.get", index: K },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: OUT },
  ];
  return { body, locals: [F64, F64, F64, F64, EXTERNREF, EXTERNREF] };
}

/** `__arrprod_at(recv, args) -> externref` — §23.1.3.1 (ES2022 `at`). */
function buildAtBody(ctx: CodegenContext, deps: SliceDeps): { body: Instr[]; locals: ValType[] } {
  const RECV = 0;
  const ARGS = 1;
  const LEN = 2;
  const K = 3;
  const TMP = 4;
  const ARG = 5;
  const undef = undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } satisfies Instr];
  const body: Instr[] = [
    ...requireObjectCoercible(ctx, deps, RECV, "at"),
    { op: "local.get", index: RECV },
    { op: "call", funcIdx: deps.externLength },
    { op: "local.set", index: LEN },
    ...integerArg(deps, ARGS, 0, TMP, ARG, [{ op: "f64.const", value: 0 }], false),
    { op: "local.set", index: K },
    // k = relativeIndex >= 0 ? relativeIndex : len + relativeIndex
    { op: "local.get", index: K },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: LEN },
        { op: "local.get", index: K },
        { op: "f64.add" },
        { op: "local.set", index: K },
      ],
    },
    { op: "local.get", index: K },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    { op: "local.get", index: K },
    { op: "local.get", index: LEN },
    { op: "f64.ge" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: undef,
      else: [
        { op: "local.get", index: RECV },
        { op: "local.get", index: K },
        { op: "call", funcIdx: deps.externGetIdx },
      ],
    },
  ];
  return { body, locals: [F64, F64, F64, EXTERNREF] };
}

/** `__arrprod_reverse(recv, args) -> externref` — §23.1.3.26, in place, returns the receiver. */
function buildReverseBody(ctx: CodegenContext, deps: SliceDeps): { body: Instr[]; locals: ValType[] } {
  const RECV = 0;
  const LO = 2;
  const HI = 3;
  const LV = 4;
  const setAt = (idxLocal: number, valueLocal: number): Instr[] => [
    { op: "local.get", index: RECV },
    { op: "local.get", index: idxLocal },
    { op: "call", funcIdx: deps.boxNumber },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: deps.externSet },
  ];
  const body: Instr[] = [
    ...requireObjectCoercible(ctx, deps, RECV, "reverse"),
    { op: "f64.const", value: 0 },
    { op: "local.set", index: LO },
    { op: "local.get", index: RECV },
    { op: "call", funcIdx: deps.externLength },
    { op: "f64.const", value: 1 },
    { op: "f64.sub" },
    { op: "local.set", index: HI },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: LO },
            { op: "local.get", index: HI },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: RECV },
            { op: "local.get", index: LO },
            { op: "call", funcIdx: deps.externGetIdx },
            { op: "local.set", index: LV },
            // a[lo] = a[hi]  (the upper value is read straight into a temp slot)
            { op: "local.get", index: RECV },
            { op: "local.get", index: LO },
            { op: "call", funcIdx: deps.boxNumber },
            { op: "local.get", index: RECV },
            { op: "local.get", index: HI },
            { op: "call", funcIdx: deps.externGetIdx },
            { op: "call", funcIdx: deps.externSet },
            ...setAt(HI, LV),
            { op: "local.get", index: LO },
            { op: "f64.const", value: 1 },
            { op: "f64.add" },
            { op: "local.set", index: LO },
            { op: "local.get", index: HI },
            { op: "f64.const", value: 1 },
            { op: "f64.sub" },
            { op: "local.set", index: HI },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: RECV },
  ];
  return { body, locals: [F64, F64, EXTERNREF] };
}

/**
 * Reserve (or fetch) `__arrprod_<slice|at|reverse>(recv: externref, args:
 * externref) -> externref`, where `args` is a `$ObjVec` of the call's
 * arguments. Returns `undefined` outside standalone or when the object-runtime
 * substrate is unavailable, in which case callers keep their previous behaviour.
 */
export function ensureNativeArraySlice(ctx: CodegenContext, methodName: string): number | undefined {
  if (!ctx.standalone || !NATIVE_SLICE_METHODS.has(methodName)) return undefined;
  const helperName = `__arrprod_${methodName}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;
  const deps = resolveSliceDeps(ctx);
  if (deps === undefined) return undefined;
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(helperName, funcIdx);
  const { body, locals } =
    methodName === "slice"
      ? buildSliceBody(ctx, deps)
      : methodName === "at"
        ? buildAtBody(ctx, deps)
        : buildReverseBody(ctx, deps);
  pushDefinedFunc(ctx, funcIdx, {
    name: helperName,
    typeIdx,
    locals: locals.map((type, i) => ({ name: `l${i}`, type })),
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#6701) The reflective `Array.prototype.slice` closure value
 * (`[].slice.call(o, k)`, array-object-proto.ts) reads `end` with a plain
 * ToIntegerOrInfinity, so an omitted `end` — padded with the canonical
 * `undefined` by the reflective call site — became 0 and every
 * `[].slice.call(arguments, 1)` answered an empty array. Rewrites `endLocal`
 * (i32, already unboxed) to INT32_MAX when param 3 is `undefined`; the slice
 * core clamps it to the length. Standalone-only; emits nothing otherwise.
 */
export function emitSliceProtoEndDefault(ctx: CodegenContext, fctx: FunctionContext, endLocal: number): void {
  const isUndefined = ctx.funcMap.get("__extern_is_undefined");
  if (!ctx.standalone || isUndefined === undefined || fctx.params.length < 4) return;
  fctx.body.push(
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: isUndefined },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0x7fffffff },
        { op: "local.set", index: endLocal },
      ],
    },
  );
}

/**
 * (#6701) The non-vec `this` arm of the reflective `slice` closure: an
 * array-LIKE receiver (an `arguments` object, a `$ObjVec`, an open `$Object`
 * with a `length`) answered null. Serve it with `__arrprod_slice(this,
 * [begin, end])`, which also throws the step-1 TypeError on null/undefined.
 * Returns false (emitting nothing) when the native helper is unavailable.
 */
export function emitSliceProtoArrayLikeFallback(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (!ctx.standalone || fctx.params.length < 4) return false;
  const sliceIdx = ensureNativeArraySlice(ctx, "slice");
  const objVecNew = ctx.funcMap.get("__objvec_new");
  const objVecPush = ctx.funcMap.get("__objvec_push");
  if (sliceIdx === undefined || objVecNew === undefined || objVecPush === undefined) return false;
  const args = allocLocal(fctx, `__slice_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    // The guard's host arm leaves the receiver on the stack; `this` is re-read.
    { op: "drop" },
    { op: "call", funcIdx: objVecNew },
    { op: "local.set", index: args },
    { op: "local.get", index: args },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: objVecPush },
    { op: "local.get", index: args },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: objVecPush },
    { op: "local.get", index: 1 },
    { op: "local.get", index: args },
    { op: "call", funcIdx: sliceIdx },
  );
  return true;
}
