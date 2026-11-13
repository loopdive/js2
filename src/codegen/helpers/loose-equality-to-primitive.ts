// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7194) Loose equality over two boxed externref operands, and §7.2.14
 * IsLooselyEqual steps 11–12 for it: an Object compared with a primitive is
 * first reduced with ToPrimitive(Object, "default").
 *
 * `__any_eq` compares primitives only. Handed an Object against a number it
 * treats the Object as a string and traps (`illegal cast in __str_to_number`);
 * against a string it compares the wrong thing (`[2] != "2"` was `true`). The
 * reduction runs inside the provider `__extern_loose_eq`, after both operands
 * were evaluated and boxed, so it cannot reorder their evaluation; at most one
 * operand is converted.
 *
 * The rule, and why each condition is there:
 *
 * - **Object** is a non-null value whose `typeof` is `"object"`, or a function.
 *   Testing `__typeof_object` alone would leave a function unreduced and
 *   would treat `null` (`typeof null === "object"`) as an Object.
 * - **Exactly one** operand is an Object. Two Objects compare by identity
 *   (step 1); converting them would make two distinct `{ valueOf() { … } }`
 *   compare equal. The provider sends that pair to `__extern_strict_eq`.
 * - **The other operand is not `null` / `undefined`.** `o == null` is `false`
 *   without calling `valueOf` (steps 2–4 never reach 11–12), and calling it
 *   would be observable.
 *
 * A throwing `valueOf` / `toString` / `@@toPrimitive` propagates out as a
 * catchable exception, and a result that is still an Object is the runtime's
 * TypeError. The hint is the explicit string `"default"` (#6774 S19): unlike
 * the null hint, it keeps a Symbol `@@toPrimitive` result, which step 11 then
 * compares instead of rejecting.
 *
 * Host-free lanes only. In a JavaScript environment the reduction's runtime
 * functions would be new host imports, so there the provider keeps its
 * unreduced body and its bytes.
 */
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import { ensureAnyFromExternHelper, ensureExternStrictEqHelper } from "../any-helpers.js";
import { type CodegenContext, hostFreeEnvironment } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { keepBodyOnlyWithObjects } from "./module-object-liveness.js";
import { runtimeToPrimitiveInstrs } from "../coercion-engine.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { addFuncType } from "../registry/types.js";
import { ensureAnyHelpers, ensureLateImport } from "../shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const PROVIDER = "__extern_loose_eq";
/** The provider's locals 2 / 3: the Object classification of params 0 / 1. */
const OBJECT_CLASS_LOCALS = ["a_is_object", "b_is_object"] as const;
const CLASSIFIERS = ["__typeof_object", "__typeof_function", "__typeof_undefined"] as const;

/** The two externref operands and the two i32 scratch locals that receive their Object classification. */
export interface LooseEqualityOperands {
  readonly left: number;
  readonly right: number;
  readonly leftIsObject: number;
  readonly rightIsObject: number;
}

/**
 * Register every runtime function the reduction calls. On a host-free lane
 * each one is a defined native, so nothing here adds an import; call it before
 * capturing any function index all the same (#3219), so the order stays right
 * if that ever changes.
 */
function ensureLooseEqualityToPrimitive(ctx: CodegenContext): void {
  ensureObjectRuntime(ctx); // the native __to_primitive
  for (const name of CLASSIFIERS) ensureLateImport(ctx, name, [EXTERNREF], [I32]);
  addStringConstantGlobal(ctx, "default"); // the "default-symbol" hint
}

/**
 * Classify both operands into their i32 locals, then replace the one Object
 * operand with its ToPrimitive when the other is a non-nullish primitive.
 * `undefined` when a runtime function is missing.
 */
export function looseEqualityToPrimitiveInstrs(
  ctx: CodegenContext,
  operands: LooseEqualityOperands,
): Instr[] | undefined {
  const toPrimitive = runtimeToPrimitiveInstrs(ctx, "default-symbol");
  const [typeofObject, typeofFunction, typeofUndefined] = CLASSIFIERS.map((name) => ctx.funcMap.get(name));
  if (
    toPrimitive === null ||
    typeofObject === undefined ||
    typeofFunction === undefined ||
    typeofUndefined === undefined
  ) {
    return undefined;
  }
  const isObject = (value: number): Instr[] => [
    { op: "local.get", index: value },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "local.get", index: value },
    { op: "call", funcIdx: typeofObject },
    { op: "i32.and" },
    { op: "local.get", index: value },
    { op: "call", funcIdx: typeofFunction },
    { op: "i32.or" },
  ];
  /** `object = ToPrimitive(object, "default")` unless `other` is null or undefined. */
  const reduce = (object: number, other: number): Instr[] => [
    { op: "local.get", index: other },
    { op: "ref.is_null" },
    { op: "local.get", index: other },
    { op: "call", funcIdx: typeofUndefined },
    { op: "i32.or" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: object }, ...structuredClone(toPrimitive), { op: "local.set", index: object }],
    },
  ];
  const { left, right, leftIsObject, rightIsObject } = operands;
  return [
    ...isObject(left),
    { op: "local.set", index: leftIsObject },
    ...isObject(right),
    { op: "local.set", index: rightIsObject },
    { op: "local.get", index: leftIsObject },
    { op: "local.get", index: rightIsObject },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: leftIsObject },
        { op: "if", blockType: { kind: "empty" }, then: reduce(left, right), else: reduce(right, left) },
      ],
    },
  ];
}

/**
 * The provider's host-free prelude: the reduction, then two Objects compare by
 * identity (step 1), `return __extern_strict_eq(left, right)`.
 */
function objectPreludeInstrs(ctx: CodegenContext, operands: LooseEqualityOperands): Instr[] | undefined {
  const reduce = looseEqualityToPrimitiveInstrs(ctx, operands);
  const strictEqIdx = ctx.funcMap.get("__extern_strict_eq");
  if (reduce === undefined || strictEqIdx === undefined) return undefined;
  return [
    ...reduce,
    { op: "local.get", index: operands.leftIsObject },
    { op: "local.get", index: operands.rightIsObject },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: operands.left },
        { op: "local.get", index: operands.right },
        { op: "call", funcIdx: strictEqIdx },
        { op: "return" },
      ],
    },
  ];
}

/**
 * The primitive comparison: both carriers classified to `$AnyValue`, then
 * `__any_eq`. On a JavaScript environment this is the whole provider, and a
 * guest call site emits it inline (as it did before #7194).
 */
function unreducedLooseEqInstrs(ctx: CodegenContext, left: number, right: number): Instr[] | undefined {
  const fromExternIdx = ctx.funcMap.get("__any_from_extern");
  const anyEqIdx = ctx.funcMap.get("__any_eq");
  if (fromExternIdx === undefined || anyEqIdx === undefined) return undefined;
  return [
    { op: "local.get", index: left },
    { op: "call", funcIdx: fromExternIdx },
    { op: "local.get", index: right },
    { op: "call", funcIdx: fromExternIdx },
    { op: "call", funcIdx: anyEqIdx },
  ];
}

/**
 * The one lane decision: on a host-free lane loose equality is the reducing
 * provider; in a JavaScript environment it is the unreduced sequence, because
 * the reduction's runtime functions would be new host imports there.
 */
function reducesObjects(ctx: CodegenContext): boolean {
  return hostFreeEnvironment(ctx);
}

/**
 * Register the `(externref, externref) -> i32` provider `__extern_loose_eq`.
 * Every runtime function it calls is registered before the first index is
 * read (#3219). The reduction is provisional: its ToPrimitive call is the only
 * edge into the object runtime's ToPrimitive closure, so a module that can
 * hold no Object would carry that closure for a branch that never runs, and
 * `settleObjectPreludes` drops it there at finalize (review B1).
 */
export function ensureExternLooseEqHelper(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(PROVIDER);
  if (existing !== undefined) return existing;
  const reduces = reducesObjects(ctx);
  if (reduces) {
    ensureLooseEqualityToPrimitive(ctx);
    ensureExternStrictEqHelper(ctx);
  }
  ensureAnyFromExternHelper(ctx);
  ensureAnyHelpers(ctx);

  const operands: LooseEqualityOperands = { left: 0, right: 1, leftIsObject: 2, rightIsObject: 3 };
  const prelude = reduces ? objectPreludeInstrs(ctx, operands) : [];
  const compare = unreducedLooseEqInstrs(ctx, operands.left, operands.right);
  if (prelude === undefined || compare === undefined) return undefined;

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32], PROVIDER);
  const funcIdx = mintDefinedFunc(ctx);
  const fn: WasmFunction = {
    name: PROVIDER,
    typeIdx,
    locals: reduces ? OBJECT_CLASS_LOCALS.map((name) => ({ name, type: I32 })) : [],
    body: [...prelude, ...compare],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  if (reduces) keepBodyOnlyWithObjects(ctx.mod, fn, compare);
  ctx.funcMap.set(PROVIDER, funcIdx);
  ctx.anyHelpers.set(PROVIDER, funcIdx);
  return funcIdx;
}

/**
 * Prepare a guest call site's loose equality: the provider on a host-free lane,
 * its two runtime functions in a JavaScript environment. `false` when a
 * provider is unavailable. Flush late-import shifts before emitting.
 */
export function prepareExternLooseEq(ctx: CodegenContext): boolean {
  return reducesObjects(ctx)
    ? ensureExternLooseEqHelper(ctx) !== undefined
    : ensureAnyFromExternHelper(ctx) !== undefined && ctx.funcMap.has("__any_eq");
}

/** `left == right` over two externref locals, after `prepareExternLooseEq`. */
export function externLooseEqInstrs(ctx: CodegenContext, left: number, right: number): Instr[] {
  const instrs = reducesObjects(ctx) ? providerCallInstrs(ctx, left, right) : unreducedLooseEqInstrs(ctx, left, right);
  if (instrs === undefined) throw new Error("loose equality provider was not prepared");
  return instrs;
}

function providerCallInstrs(ctx: CodegenContext, left: number, right: number): Instr[] | undefined {
  const funcIdx = ctx.funcMap.get(PROVIDER);
  if (funcIdx === undefined) return undefined;
  return [
    { op: "local.get", index: left },
    { op: "local.get", index: right },
    { op: "call", funcIdx },
  ];
}
