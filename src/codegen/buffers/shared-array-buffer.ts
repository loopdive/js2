// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7011) Native `SharedArrayBuffer` provider (ECMA-262 §25.2).
 *
 * A shared buffer is the `$__sab` struct — a subtype of the ArrayBuffer byte
 * vec (`getOrRegisterSabType`), so TypedArray/DataView views, element codecs
 * and `byteLength` reads work on it unchanged, and `ref.test $__sab` is
 * IsSharedArrayBuffer. There is one agent and no shared memory between Wasm
 * instances, so "shared" is the constructor identity, the brand checks of the
 * prototype members, and `Atomics.wait` admissibility — not a memory model.
 *
 * Every operation is a DEFINED helper with an externref ABI (the semantic
 * owner); the AST call sites and the reflective `SharedArrayBuffer.prototype`
 * member closures are thin adapters that only evaluate operands:
 *   `__sab_construct(length, options)`   §25.2.3.1
 *   `__sab_slice(this, start, end)`      §25.2.5.6 (no species lookup, see below)
 *   `__sab_grow(this, newLength)`        §25.2.5.3
 *   `__sab_get(this, which)`             byteLength / maxByteLength / growable getters
 * No host import is involved on any profile; the old `SharedArrayBuffer_*`
 * extern-class registration is gone (extern-declarations BUILTIN_SKIP).
 *
 * Residuals (recorded in the issue): `slice` does not consult
 * `constructor[@@species]` (always a fresh SharedArrayBuffer); a NewTarget
 * prototype (`Reflect.construct(SharedArrayBuffer, [], F)`) is not honoured;
 * views over a growable buffer do not length-track a later `grow`.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "../index.js";
import { buildThrowJsErrorInstrs, noJsHost } from "../js-errors.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { addFuncType, getOrRegisterSabType } from "../registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";
import { coerceType } from "../type-coercion.js";

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };
/** Largest byte length the i32-indexed backing array can hold. */
const MAX_BYTES = 2147483647;

type SabHelper = "construct" | "slice" | "grow" | "get";
const HELPER_PARAMS: Record<SabHelper, ValType[]> = {
  construct: [EXT, EXT],
  slice: [EXT, EXT, EXT],
  grow: [EXT, EXT],
  get: [EXT, I32],
};
/** Getter selector for `__sab_get`. */
const GETTER: Record<string, number> = {
  byteLength: 0,
  maxByteLength: 1,
  growable: 2,
};

function makeFctx(name: string, params: ValType[]): FunctionContext {
  return {
    name,
    params: params.map((type, i) => ({ name: `p${i}`, type })),
    locals: [],
    localMap: new Map(),
    returnType: EXT,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  } as unknown as FunctionContext;
}

function capture(fctx: FunctionContext, emit: () => void): Instr[] {
  const saved = fctx.body;
  const out: Instr[] = [];
  fctx.body = out;
  try {
    emit();
  } finally {
    fctx.body = saved;
  }
  return out;
}

/** `ToIntegerOrInfinity(ToNumber(param))` into the f64 local `dst`. */
function pushToInteger(ctx: CodegenContext, fctx: FunctionContext, param: number, dst: number): void {
  fctx.body.push({ op: "local.get", index: param });
  coerceType(ctx, fctx, EXT, F64);
  fctx.body.push(
    { op: "local.set", index: dst },
    { op: "local.get", index: dst },
    { op: "f64.trunc" },
    { op: "f64.const", value: 0 },
    { op: "local.get", index: dst },
    { op: "local.get", index: dst },
    { op: "f64.eq" },
    { op: "select" },
    { op: "local.set", index: dst },
  );
}

/** `ToIndex(param)` into `dst`: ToIntegerOrInfinity, then RangeError outside [0, 2^53-1]. */
function pushToIndex(ctx: CodegenContext, fctx: FunctionContext, param: number, dst: number, rangeErr: Instr[]): void {
  pushToInteger(ctx, fctx, param, dst);
  fctx.body.push(
    { op: "local.get", index: dst },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    { op: "local.get", index: dst },
    { op: "f64.const", value: 9007199254740991 },
    { op: "f64.gt" },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: rangeErr, else: [] },
  );
}

/** Relative index clamp of §25.2.5.6 steps 6-11, in f64 (handles ±∞). */
function clampRelativeInstrs(rel: number, lenF: number): Instr[] {
  return [
    { op: "local.get", index: rel },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "val", type: F64 },
      then: [
        { op: "local.get", index: lenF },
        { op: "local.get", index: rel },
        { op: "f64.add" },
        { op: "f64.const", value: 0 },
        { op: "f64.max" },
      ],
      else: [{ op: "local.get", index: rel }, { op: "local.get", index: lenF }, { op: "f64.min" }],
    },
    { op: "local.set", index: rel },
  ];
}

interface Deps {
  sabIdx: number;
  arrIdx: number;
  isUndefined: number;
  typeofObject: number;
  typeofFunction: number;
  externGet: number;
  boxNumber: number;
  boxBoolean: number;
}

/** Ensure the `__sab_<which>` helper exists; returns its index or undefined. */
export function ensureSabHelper(
  ctx: CodegenContext,
  which: SabHelper,
  callerFctx?: FunctionContext,
): number | undefined {
  const name = `__sab_${which}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  ensureObjectRuntime(ctx);
  const sabIdx = getOrRegisterSabType(ctx);
  const arrIdx = getArrTypeIdxFromVec(ctx, getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" }));
  const deps: Partial<Deps> = {
    sabIdx,
    arrIdx,
    isUndefined: ensureLateImport(ctx, "__extern_is_undefined", [EXT], [I32]),
    typeofObject: ensureLateImport(ctx, "__typeof_object", [EXT], [I32]),
    typeofFunction: ensureLateImport(ctx, "__typeof_function", [EXT], [I32]),
    externGet: ensureLateImport(ctx, "__extern_get", [EXT, EXT], [EXT]),
    boxNumber: ensureLateImport(ctx, "__box_number", [F64], [EXT]),
    boxBoolean: ensureLateImport(ctx, "__box_boolean", [I32], [EXT]),
  };
  if (arrIdx < 0 || Object.values(deps).some((v) => v === undefined)) return undefined;
  addStringConstantGlobal(ctx, "maxByteLength");
  const fctx = makeFctx(name, HELPER_PARAMS[which]);
  const d = deps as Deps;
  if (which === "construct") emitConstructBody(ctx, fctx, d);
  else if (which === "slice") emitSliceBody(ctx, fctx, d);
  else if (which === "grow") emitGrowBody(ctx, fctx, d);
  else emitGetBody(ctx, fctx, d);
  flushLateImportShifts(ctx, fctx);
  if (callerFctx) flushLateImportShifts(ctx, callerFctx);
  const typeIdx = addFuncType(ctx, HELPER_PARAMS[which], [EXT]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}

/** Brand check: param 0 must be a `$__sab` (optionally a growable one); casts into `local`. */
function pushBrand(fctx: FunctionContext, d: Deps, local: number, err: Instr[], requireGrowable = false): void {
  const any = allocLocal(fctx, `__sab_any_${fctx.locals.length}`, {
    kind: "anyref",
  });
  fctx.body.push(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: any },
    { op: "ref.test", typeIdx: d.sabIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: err, else: [] },
    { op: "local.get", index: any },
    { op: "ref.cast", typeIdx: d.sabIdx },
    { op: "local.set", index: local },
  );
  if (requireGrowable) {
    fctx.body.push(
      { op: "local.get", index: local },
      { op: "struct.get", typeIdx: d.sabIdx, fieldIdx: 3 },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: err, else: [] },
    );
  }
}

function emitConstructBody(ctx: CodegenContext, fctx: FunctionContext, d: Deps): void {
  const rangeErr = buildThrowJsErrorInstrs(ctx, "RangeError", "RangeError: Invalid shared array buffer length");
  const maxErr = buildThrowJsErrorInstrs(
    ctx,
    "RangeError",
    "RangeError: SharedArrayBuffer byteLength exceeds maxByteLength",
  );
  const lenF = allocLocal(fctx, "lenF", F64);
  const maxF = allocLocal(fctx, "maxF", F64);
  const hasMax = allocLocal(fctx, "hasMax", I32);
  const maxV = allocLocal(fctx, "maxV", EXT);
  const lenI = allocLocal(fctx, "lenI", I32);
  const b = fctx.body;
  // Step 2: byteLength = ? ToIndex(length).
  pushToIndex(ctx, fctx, 0, lenF, rangeErr);
  // Step 3: GetArrayBufferMaxByteLengthOption — only an Object options is read.
  b.push(
    { op: "local.get", index: 1 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: d.typeofObject },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: d.typeofFunction },
    { op: "i32.or" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        ...stringConstantExternrefInstrs(ctx, "maxByteLength"),
        { op: "call", funcIdx: d.externGet },
        { op: "local.tee", index: maxV },
        { op: "call", funcIdx: d.isUndefined },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: capture(fctx, () => {
            // ToIndex(maxByteLength) reads the value, which lives in a local:
            // stage it through param slot 1 (options is no longer needed).
            fctx.body.push({ op: "local.get", index: maxV }, { op: "local.set", index: 1 });
            pushToIndex(ctx, fctx, 1, maxF, rangeErr);
            fctx.body.push({ op: "i32.const", value: 1 }, { op: "local.set", index: hasMax });
          }),
          else: [],
        },
      ],
      else: [],
    },
  );
  // AllocateSharedArrayBuffer: byteLength > maxByteLength before allocation;
  // a block the i32-indexed array cannot hold is "impossible to create".
  b.push(
    { op: "local.get", index: hasMax },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenF },
        { op: "local.get", index: maxF },
        { op: "f64.gt" },
        { op: "if", blockType: { kind: "empty" }, then: maxErr, else: [] },
        { op: "local.get", index: maxF },
        { op: "f64.const", value: MAX_BYTES },
        { op: "f64.gt" },
        { op: "if", blockType: { kind: "empty" }, then: rangeErr, else: [] },
      ],
      else: [],
    },
    { op: "local.get", index: lenF },
    { op: "f64.const", value: MAX_BYTES },
    { op: "f64.gt" },
    { op: "if", blockType: { kind: "empty" }, then: rangeErr, else: [] },
    { op: "local.get", index: lenF },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: lenI },
    { op: "local.get", index: lenI },
    { op: "array.new_default", typeIdx: d.arrIdx },
    { op: "local.get", index: hasMax },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "local.get", index: maxF }, { op: "i32.trunc_sat_f64_s" }],
      else: [{ op: "local.get", index: lenI }],
    },
    { op: "local.get", index: hasMax },
    { op: "struct.new", typeIdx: d.sabIdx },
    { op: "extern.convert_any" },
  );
}

function emitSliceBody(ctx: CodegenContext, fctx: FunctionContext, d: Deps): void {
  const brandErr = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "TypeError: SharedArrayBuffer.prototype.slice called on incompatible receiver",
  );
  const src = allocLocal(fctx, "src", { kind: "ref_null", typeIdx: d.sabIdx });
  const lenF = allocLocal(fctx, "lenF", F64);
  const first = allocLocal(fctx, "first", F64);
  const fin = allocLocal(fctx, "final", F64);
  const newLen = allocLocal(fctx, "newLen", I32);
  const dst = allocLocal(fctx, "dst", { kind: "ref_null", typeIdx: d.arrIdx });
  const b = fctx.body;
  pushBrand(fctx, d, src, brandErr);
  b.push({ op: "local.get", index: src }, { op: "struct.get", typeIdx: d.sabIdx, fieldIdx: 0 });
  b.push({ op: "f64.convert_i32_s" }, { op: "local.set", index: lenF });
  pushToInteger(ctx, fctx, 1, first);
  b.push(...clampRelativeInstrs(first, lenF));
  b.push({ op: "local.get", index: 2 }, { op: "call", funcIdx: d.isUndefined });
  b.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: lenF },
      { op: "local.set", index: fin },
    ],
    else: capture(fctx, () => {
      pushToInteger(ctx, fctx, 2, fin);
      fctx.body.push(...clampRelativeInstrs(fin, lenF));
    }),
  });
  b.push(
    { op: "local.get", index: fin },
    { op: "local.get", index: first },
    { op: "f64.sub" },
    { op: "f64.const", value: 0 },
    { op: "f64.max" },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: newLen },
    { op: "array.new_default", typeIdx: d.arrIdx },
    { op: "local.set", index: dst },
    { op: "local.get", index: dst },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: src },
    { op: "struct.get", typeIdx: d.sabIdx, fieldIdx: 1 },
    { op: "local.get", index: first },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.get", index: newLen },
    { op: "array.copy", dstTypeIdx: d.arrIdx, srcTypeIdx: d.arrIdx },
    { op: "local.get", index: newLen },
    { op: "local.get", index: dst },
    { op: "local.get", index: newLen },
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: d.sabIdx },
    { op: "extern.convert_any" },
  );
}

function emitGrowBody(ctx: CodegenContext, fctx: FunctionContext, d: Deps): void {
  const brandErr = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "TypeError: SharedArrayBuffer.prototype.grow called on a non-growable receiver",
  );
  const rangeErr = buildThrowJsErrorInstrs(ctx, "RangeError", "RangeError: Invalid shared array buffer length");
  const shrinkErr = buildThrowJsErrorInstrs(ctx, "RangeError", "RangeError: SharedArrayBuffer cannot shrink");
  const src = allocLocal(fctx, "src", { kind: "ref_null", typeIdx: d.sabIdx });
  const newF = allocLocal(fctx, "newF", F64);
  const newLen = allocLocal(fctx, "newLen", I32);
  const dst = allocLocal(fctx, "dst", { kind: "ref_null", typeIdx: d.arrIdx });
  const b = fctx.body;
  pushBrand(fctx, d, src, brandErr, true);
  pushToIndex(ctx, fctx, 1, newF, rangeErr);
  b.push(
    { op: "local.get", index: newF },
    { op: "local.get", index: src },
    { op: "struct.get", typeIdx: d.sabIdx, fieldIdx: 2 },
    { op: "f64.convert_i32_s" },
    { op: "f64.gt" },
    { op: "if", blockType: { kind: "empty" }, then: rangeErr, else: [] },
    { op: "local.get", index: newF },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: newLen },
    { op: "local.get", index: src },
    { op: "struct.get", typeIdx: d.sabIdx, fieldIdx: 0 },
    { op: "i32.lt_s" },
    { op: "if", blockType: { kind: "empty" }, then: shrinkErr, else: [] },
    // Reallocate and swap the data array in place: views hold the struct.
    { op: "local.get", index: newLen },
    { op: "array.new_default", typeIdx: d.arrIdx },
    { op: "local.set", index: dst },
    { op: "local.get", index: dst },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: src },
    { op: "struct.get", typeIdx: d.sabIdx, fieldIdx: 1 },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: src },
    { op: "struct.get", typeIdx: d.sabIdx, fieldIdx: 0 },
    { op: "array.copy", dstTypeIdx: d.arrIdx, srcTypeIdx: d.arrIdx },
    { op: "local.get", index: src },
    { op: "local.get", index: dst },
    { op: "ref.as_non_null" },
    { op: "struct.set", typeIdx: d.sabIdx, fieldIdx: 1 },
    { op: "local.get", index: src },
    { op: "local.get", index: newLen },
    { op: "struct.set", typeIdx: d.sabIdx, fieldIdx: 0 },
    ...canonicalUndefinedExternInstrs(ctx),
  );
}

function emitGetBody(ctx: CodegenContext, fctx: FunctionContext, d: Deps): void {
  const brandErr = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "TypeError: SharedArrayBuffer.prototype getter called on incompatible receiver",
  );
  const src = allocLocal(fctx, "src", { kind: "ref_null", typeIdx: d.sabIdx });
  pushBrand(fctx, d, src, brandErr);
  const field = (i: number): Instr[] => [
    { op: "local.get", index: src },
    { op: "struct.get", typeIdx: d.sabIdx, fieldIdx: i },
  ];
  fctx.body.push(
    { op: "local.get", index: 1 },
    {
      op: "if",
      blockType: { kind: "val", type: EXT },
      then: [
        { op: "local.get", index: 1 },
        { op: "i32.const", value: GETTER.growable! },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: EXT },
          then: [...field(3), { op: "call", funcIdx: d.boxBoolean }],
          else: [...field(2), { op: "f64.convert_i32_s" }, { op: "call", funcIdx: d.boxNumber }],
        },
      ],
      else: [...field(0), { op: "f64.convert_i32_s" }, { op: "call", funcIdx: d.boxNumber }],
    },
  );
}

/** Evaluate `args[0..count)` (missing → undefined, extras for effects) into externref locals. */
function evalArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  count: number,
  compileExpr: (e: ts.Expression) => ValType | null,
): number[] {
  const locals: number[] = [];
  for (let n = 0; n < Math.max(count, args.length); n++) {
    if (n >= args.length) {
      fctx.body.push(...canonicalUndefinedExternInstrs(ctx));
    } else {
      const t = compileExpr(args[n]!);
      if (n >= count) {
        if (t) fctx.body.push({ op: "drop" });
        continue;
      }
      if (t === null) fctx.body.push(...canonicalUndefinedExternInstrs(ctx));
      else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXT);
    }
    const local = allocLocal(fctx, `__sab_a${n}_${fctx.locals.length}`, EXT);
    fctx.body.push({ op: "local.set", index: local });
    locals.push(local);
  }
  return locals;
}

/** `new SharedArrayBuffer(length, options)` → `__sab_construct`. */
export function emitSabConstruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  compileExpr: (e: ts.Expression) => ValType | null,
): ValType | undefined {
  if (!noJsHost(ctx) || ensureSabHelper(ctx, "construct", fctx) === undefined) return undefined;
  const locals = evalArgs(ctx, fctx, args, 2, compileExpr);
  flushLateImportShifts(ctx, fctx);
  for (const l of locals) fctx.body.push({ op: "local.get", index: l });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__sab_construct")! });
  return EXT;
}

/** `sab.slice(a, b)` / `sab.grow(n)` with a statically shared receiver. */
export function emitSabMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  receiver: ts.Expression,
  args: readonly ts.Expression[],
  compileExpr: (e: ts.Expression) => ValType | null,
): ValType | undefined {
  if ((method !== "slice" && method !== "grow") || !noJsHost(ctx)) return undefined;
  if (ensureSabHelper(ctx, method, fctx) === undefined) return undefined;
  const [recvLocal] = evalArgs(ctx, fctx, [receiver], 1, compileExpr);
  const locals = evalArgs(ctx, fctx, args, method === "slice" ? 2 : 1, compileExpr);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "local.get", index: recvLocal! });
  for (const l of locals) fctx.body.push({ op: "local.get", index: l });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(`__sab_${method}`)! });
  return EXT;
}

/** `sab.maxByteLength` / `sab.growable` (and `byteLength`) on a shared receiver. */
export function emitSabGetter(
  ctx: CodegenContext,
  fctx: FunctionContext,
  prop: string,
  receiver: ts.Expression,
  compileExpr: (e: ts.Expression) => ValType | null,
): ValType | undefined {
  const which = GETTER[prop];
  if (which === undefined || !noJsHost(ctx) || ensureSabHelper(ctx, "get", fctx) === undefined) return undefined;
  const [recvLocal] = evalArgs(ctx, fctx, [receiver], 1, compileExpr);
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({ op: "local.get", index: recvLocal! }, { op: "i32.const", value: which });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__sab_get")! });
  return EXT;
}

/** Reflective-closure argument slots per member (spec `.length` is separate). */
export function sabProtoMemberParamSlots(member: string): number {
  return member === "slice" ? 2 : member === "grow" ? 1 : 0;
}

/**
 * Reflective `SharedArrayBuffer.prototype.<member>` closure body. Closure ABI:
 * param 0 = wrapper, 1 = this, 2.. = arguments (padded with undefined).
 */
export function emitSabProtoMemberBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  const helper: SabHelper | undefined =
    member === "slice" || member === "grow" ? member : GETTER[member] !== undefined ? "get" : undefined;
  if (helper === undefined || !noJsHost(ctx)) return null;
  const idx = ensureSabHelper(ctx, helper, fctx);
  if (idx === undefined) return null;
  fctx.body.push({ op: "local.get", index: 1 });
  if (helper === "get") {
    fctx.body.push({ op: "i32.const", value: GETTER[member]! });
  } else {
    for (let slot = 2; slot < 2 + sabProtoMemberParamSlots(member); slot++) {
      if (slot < fctx.params.length) fctx.body.push({ op: "local.get", index: slot });
      else fctx.body.push(...canonicalUndefinedExternInstrs(ctx));
    }
  }
  fctx.body.push({ op: "call", funcIdx: idx });
  return EXT;
}
