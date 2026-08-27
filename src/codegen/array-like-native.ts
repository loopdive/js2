// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-free bodies for the generic Array.prototype mutators.
 *
 * A transferred `Array.prototype.push`/`reverse`/`unshift` value has the
 * receiver-aware native-prototype ABI `(self, thisValue, argsVec)`.  The
 * receiver is not necessarily a Wasm array: the ES5 genericity rows install
 * the function on an ordinary open `$Object` and then mutate numeric
 * properties through it.  Keep this implementation on the existing dynamic
 * object substrate (`__extern_length`, `__extern_get_idx`,
 * `__extern_has_idx`, `__extern_set`, and `__delete_property`) so explicit
 * `null`/`undefined`, inherited values, and accessor-backed properties retain
 * the same semantics as ordinary dynamic property operations.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { undefinedSingletonActive } from "./any-helpers.js";

interface ArrayLikeDeps {
  length: number;
  getIdx: number;
  hasIdx: number;
  set: number;
  deleteProperty: number;
  boxNumber: number;
}

/** Register the shared dynamic-object helpers before their indices are used. */
function prepareArrayLikeDeps(ctx: CodegenContext, fctx: FunctionContext): ArrayLikeDeps | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;

  // The native object runtime owns these names under the host-free semantic
  // provider.  Calling it first also makes the helper available when this is
  // the first native-prototype body requested by a module.
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__extern_has_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
  ensureLateImport(ctx, "__delete_property", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  addStringConstantGlobal(ctx, "length");
  flushLateImportShifts(ctx, fctx);

  const length = ctx.funcMap.get("__extern_length");
  const getIdx = ctx.funcMap.get("__extern_get_idx");
  const hasIdx = ctx.funcMap.get("__extern_has_idx");
  const set = ctx.funcMap.get("__extern_set");
  const deleteProperty = ctx.funcMap.get("__delete_property");
  const boxNumber = ctx.funcMap.get("__box_number");
  if (
    length === undefined ||
    getIdx === undefined ||
    hasIdx === undefined ||
    set === undefined ||
    deleteProperty === undefined ||
    boxNumber === undefined
  ) {
    return undefined;
  }
  return { length, getIdx, hasIdx, set, deleteProperty, boxNumber };
}

/** Append the Array.prototype ToObject guard shared by the three mutators. */
function emitArrayLikeReceiverGuard(ctx: CodegenContext, fctx: FunctionContext, member: string): void {
  const throwBody: Instr[] = [];
  emitBrandCheckTypeError(ctx, throwBody, `Array.prototype.${member} called on null or undefined`);
  fctx.body.push({ op: "local.get", index: 1 }, { op: "ref.is_null" });
  if (undefinedSingletonActive(ctx)) {
    const isUndefined = ctx.funcMap.get("__extern_is_undefined");
    if (isUndefined !== undefined) {
      fctx.body.push({ op: "local.get", index: 1 }, { op: "call", funcIdx: isUndefined }, { op: "i32.or" });
    }
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwBody });
}

function emitSetLength(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: ArrayLikeDeps,
  receiverIdx: number,
  lengthLocal: number,
): void {
  fctx.body.push({ op: "local.get", index: receiverIdx });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, "length"));
  fctx.body.push({ op: "local.get", index: lengthLocal }, { op: "call", funcIdx: deps.boxNumber });
  fctx.body.push({ op: "call", funcIdx: deps.set });
}

/** Emit `Array.prototype.push` for a dynamic receiver and an args vector. */
function emitArrayLikePush(ctx: CodegenContext, fctx: FunctionContext, deps: ArrayLikeDeps): ValType {
  const lengthF = allocLocal(fctx, "__array_like_push_length", { kind: "f64" });
  const argsLengthF = allocLocal(fctx, "__array_like_push_args_length", { kind: "f64" });
  const argsLength = allocLocal(fctx, "__array_like_push_args_count", { kind: "i32" });
  const index = allocLocal(fctx, "__array_like_push_index", { kind: "i32" });
  const newLength = allocLocal(fctx, "__array_like_push_new_length", { kind: "f64" });

  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: deps.length },
    { op: "local.set", index: lengthF },
  );
  fctx.body.push(
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: deps.length },
    { op: "local.tee", index: argsLengthF },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: argsLength },
  );
  fctx.body.push(
    { op: "local.get", index: lengthF },
    { op: "local.get", index: argsLengthF },
    { op: "f64.add" },
    { op: "local.set", index: newLength },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: index },
  );

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index },
          { op: "local.get", index: argsLength },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          // O[len + i] = args[i]
          { op: "local.get", index: 1 },
          { op: "local.get", index: lengthF },
          ...f64IndexFromLocal(index),
          { op: "f64.add" },
          { op: "call", funcIdx: deps.boxNumber },
          { op: "local.get", index: 2 },
          ...f64IndexFromLocal(index),
          { op: "call", funcIdx: deps.getIdx },
          { op: "call", funcIdx: deps.set },
          { op: "local.get", index },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });
  emitSetLength(ctx, fctx, deps, 1, newLength);
  fctx.body.push({ op: "local.get", index: newLength }, { op: "call", funcIdx: deps.boxNumber });
  return { kind: "externref" };
}

/** Emit `Array.prototype.unshift` for a dynamic receiver and an args vector. */
function emitArrayLikeUnshift(ctx: CodegenContext, fctx: FunctionContext, deps: ArrayLikeDeps): ValType {
  const lengthF = allocLocal(fctx, "__array_like_unshift_length", { kind: "f64" });
  const length = allocLocal(fctx, "__array_like_unshift_count", { kind: "i32" });
  const argsLengthF = allocLocal(fctx, "__array_like_unshift_args_length", { kind: "f64" });
  const argsLength = allocLocal(fctx, "__array_like_unshift_args_count", { kind: "i32" });
  const index = allocLocal(fctx, "__array_like_unshift_index", { kind: "i32" });
  const fromF = allocLocal(fctx, "__array_like_unshift_from", { kind: "f64" });
  const toF = allocLocal(fctx, "__array_like_unshift_to", { kind: "f64" });
  const present = allocLocal(fctx, "__array_like_unshift_present", { kind: "i32" });
  const value = allocLocal(fctx, "__array_like_unshift_value", { kind: "externref" });
  const newLength = allocLocal(fctx, "__array_like_unshift_new_length", { kind: "f64" });

  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: deps.length },
    { op: "local.tee", index: lengthF },
  );
  fctx.body.push({ op: "i32.trunc_sat_f64_s" }, { op: "local.set", index: length });
  fctx.body.push(
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: deps.length },
    { op: "local.tee", index: argsLengthF },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: argsLength },
  );
  fctx.body.push(
    { op: "local.get", index: lengthF },
    { op: "local.get", index: argsLengthF },
    { op: "f64.add" },
    { op: "local.set", index: newLength },
    { op: "local.get", index: length },
    { op: "local.set", index: index },
  );

  // Move existing properties from right to left.  HasProperty/Get and Delete
  // are deliberately separate: a present-but-undefined value must move, and
  // a genuine hole must delete the destination rather than store undefined.
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index },
          { op: "i32.const", value: 0 },
          { op: "i32.le_s" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "f64.convert_i32_s" },
          { op: "local.set", index: fromF },
          { op: "local.get", index: fromF },
          { op: "local.get", index: argsLengthF },
          { op: "f64.add" },
          { op: "local.set", index: toF },
          { op: "local.get", index: 1 },
          { op: "local.get", index: fromF },
          { op: "call", funcIdx: deps.hasIdx },
          { op: "local.set", index: present },
          { op: "local.get", index: present },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "local.get", index: fromF },
              { op: "call", funcIdx: deps.getIdx },
              { op: "local.set", index: value },
              { op: "local.get", index: 1 },
              { op: "local.get", index: toF },
              { op: "call", funcIdx: deps.boxNumber },
              { op: "local.get", index: value },
              { op: "call", funcIdx: deps.set },
            ],
            else: [
              { op: "local.get", index: 1 },
              { op: "local.get", index: toF },
              { op: "call", funcIdx: deps.boxNumber },
              { op: "call", funcIdx: deps.deleteProperty },
              { op: "drop" },
            ],
          },
          { op: "local.get", index },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "local.set", index },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });

  // Write the new arguments in source order at indices 0..argsLength-1.
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index });
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index },
          { op: "local.get", index: argsLength },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: 1 },
          ...boxedIndexFromLocal(index, deps.boxNumber),
          { op: "local.get", index: 2 },
          ...f64IndexFromLocal(index),
          { op: "call", funcIdx: deps.getIdx },
          { op: "call", funcIdx: deps.set },
          { op: "local.get", index },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });
  emitSetLength(ctx, fctx, deps, 1, newLength);
  fctx.body.push({ op: "local.get", index: newLength }, { op: "call", funcIdx: deps.boxNumber });
  return { kind: "externref" };
}

/** Emit `Array.prototype.reverse` for a dynamic receiver. */
function emitArrayLikeReverse(fctx: FunctionContext, deps: ArrayLikeDeps): ValType {
  const length = allocLocal(fctx, "__array_like_reverse_length", { kind: "i32" });
  const left = allocLocal(fctx, "__array_like_reverse_left", { kind: "i32" });
  const right = allocLocal(fctx, "__array_like_reverse_right", { kind: "i32" });
  const leftPresent = allocLocal(fctx, "__array_like_reverse_left_present", { kind: "i32" });
  const rightPresent = allocLocal(fctx, "__array_like_reverse_right_present", { kind: "i32" });
  const leftValue = allocLocal(fctx, "__array_like_reverse_left_value", { kind: "externref" });
  const rightValue = allocLocal(fctx, "__array_like_reverse_right_value", { kind: "externref" });

  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: deps.length },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: length },
    { op: "local.set", index: right },
    { op: "local.get", index: right },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: right },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: left },
  );

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: left },
          { op: "local.get", index: right },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: 1 },
          ...f64IndexFromLocal(left),
          { op: "call", funcIdx: deps.hasIdx },
          { op: "local.set", index: leftPresent },
          { op: "local.get", index: 1 },
          ...f64IndexFromLocal(right),
          { op: "call", funcIdx: deps.hasIdx },
          { op: "local.set", index: rightPresent },
          { op: "local.get", index: leftPresent },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              ...f64IndexFromLocal(left),
              { op: "call", funcIdx: deps.getIdx },
              { op: "local.set", index: leftValue },
            ],
          },
          { op: "local.get", index: rightPresent },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              ...f64IndexFromLocal(right),
              { op: "call", funcIdx: deps.getIdx },
              { op: "local.set", index: rightValue },
            ],
          },
          { op: "local.get", index: leftPresent },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: rightPresent },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // Both present: swap the values.
                  { op: "local.get", index: 1 },
                  ...boxedIndexFromLocal(left, deps.boxNumber),
                  { op: "local.get", index: rightValue },
                  { op: "call", funcIdx: deps.set },
                  { op: "local.get", index: 1 },
                  ...boxedIndexFromLocal(right, deps.boxNumber),
                  { op: "local.get", index: leftValue },
                  { op: "call", funcIdx: deps.set },
                ],
                else: [
                  // Only the left index exists: move it right and delete left.
                  { op: "local.get", index: 1 },
                  ...boxedIndexFromLocal(right, deps.boxNumber),
                  { op: "local.get", index: leftValue },
                  { op: "call", funcIdx: deps.set },
                  { op: "local.get", index: 1 },
                  ...boxedIndexFromLocal(left, deps.boxNumber),
                  { op: "call", funcIdx: deps.deleteProperty },
                  { op: "drop" },
                ],
              },
            ],
            else: [
              { op: "local.get", index: rightPresent },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // Only the right index exists: move it left and delete right.
                  { op: "local.get", index: 1 },
                  ...boxedIndexFromLocal(left, deps.boxNumber),
                  { op: "local.get", index: rightValue },
                  { op: "call", funcIdx: deps.set },
                  { op: "local.get", index: 1 },
                  ...boxedIndexFromLocal(right, deps.boxNumber),
                  { op: "call", funcIdx: deps.deleteProperty },
                  { op: "drop" },
                ],
              },
            ],
          },
          { op: "local.get", index: left },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: left },
          { op: "local.get", index: right },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "local.set", index: right },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });
  // reverse returns the original receiver object, not a numeric/array result.
  fctx.body.push({ op: "local.get", index: 1 });
  return { kind: "externref" };
}

function f64IndexFromLocal(index: number): Instr[] {
  return [{ op: "local.get", index }, { op: "f64.convert_i32_s" }];
}

function boxedIndexFromLocal(index: number, boxNumber: number): Instr[] {
  return [...f64IndexFromLocal(index), { op: "call", funcIdx: boxNumber }];
}

/**
 * Emit one of the generic mutator bodies. `this` is closure param 1 and the
 * variadic argument vector is closure param 2 for push/unshift.
 */
export function emitArrayLikeNativeMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null | undefined {
  if (member !== "push" && member !== "reverse" && member !== "unshift") return undefined;
  const deps = prepareArrayLikeDeps(ctx, fctx);
  if (deps === undefined) return undefined;
  emitArrayLikeReceiverGuard(ctx, fctx, member);
  if (member === "push") return emitArrayLikePush(ctx, fctx, deps);
  if (member === "unshift") return emitArrayLikeUnshift(ctx, fctx, deps);
  return emitArrayLikeReverse(fctx, deps);
}
