// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7011) Native `Atomics.*` (ECMA-262 §25.4) over the in-module TypedArray
 * carriers — the provider that replaces the old blanket "unsupported in
 * --target standalone" TypeError, so programs using `SharedArrayBuffer` +
 * `Atomics` compile host-free on every WasmGC profile.
 *
 * Semantics are single-agent: there is exactly one agent and no other memory
 * observer, so every atomic read-modify-write is an ordinary read followed by
 * a write and `notify` never finds a waiter (returns 0). Nothing could ever
 * wake a suspended agent, so this agent reports AgentCanSuspend() = false and
 * a synchronous `Atomics.wait` throws the spec's TypeError after its argument
 * validation and coercions (DoWait step 10; test262 `CanBlockIsFalse`).
 * BigInt64Array / BigUint64Array views run the same operations in i64 over
 * the element bytes (`emitBigIntOps`). `Atomics.waitAsync` keeps its
 * call-site TypeError (no timer-backed promise provider yet).
 *
 * One defined helper does the whole operation, so the spec's observable order
 * holds: ValidateIntegerTypedArray → ToIndex(index) → value coercions →
 * revalidation → access. Its ABI:
 *   `__atomics_op(op: i32, hint: i32, ta, index, v, w: externref) -> externref`
 * `hint` is the call site's static TypedArray kind (`TA_CTOR_KINDS` index, -1
 * when unknown). It is only needed for the fresh-allocation carriers
 * (`new Int32Array(n)` → `$__vec_i32_elem`, …) whose runtime shape is shared by
 * several element kinds; buffer-backed views carry their kind at run time.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  emitDynDecodeDispatch,
  emitDynEncodeDispatch,
  pushElemSizeForKind,
  pushTaDynViewInBoundsLen,
} from "../dataview-native.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "../index.js";
import { buildThrowJsErrorInstrs, noJsHost } from "../js-errors.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import {
  addFuncType,
  getOrRegisterSabType,
  getOrRegisterTaDynViewType,
  getOrRegisterTaViewType,
  taCtorKindOf,
} from "../registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";
import { coerceType } from "../type-coercion.js";

const OP = {
  add: 0,
  and: 1,
  or: 2,
  sub: 3,
  xor: 4,
  exchange: 5,
  store: 6,
  load: 7,
  compareExchange: 8,
  wait: 9,
  notify: 10,
  isLockFree: 11,
  pause: 12,
} as const;
type AtomicsMethod = keyof typeof OP;

const HELPER = "__atomics_op";
const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

function makeFctx(): FunctionContext {
  return {
    name: HELPER,
    params: [
      { name: "op", type: I32 },
      { name: "hint", type: I32 },
      { name: "ta", type: EXT },
      { name: "index", type: EXT },
      { name: "v", type: EXT },
      { name: "w", type: EXT },
    ],
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

/** Run `emit` into a detached instruction list (the fctx body swap idiom). */
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

/** `ToIntegerOrInfinity(ToNumber(param))` into `dst` (NaN → 0, trunc; -0 kept). */
function pushToIntegerOrInfinity(ctx: CodegenContext, fctx: FunctionContext, param: number, dst: number): void {
  fctx.body.push({ op: "local.get", index: param });
  coerceType(ctx, fctx, EXT, F64);
  fctx.body.push({ op: "local.set", index: dst });
  fctx.body.push(
    { op: "local.get", index: dst },
    { op: "f64.trunc" },
    { op: "f64.const", value: 0 },
    { op: "local.get", index: dst },
    { op: "local.get", index: dst },
    { op: "f64.eq" }, // false only for NaN
    { op: "select" },
    { op: "local.set", index: dst },
  );
}

/** ToInt32 of an already-integral f64 local: `x mod 2^32` (±∞ → 0), as i32. */
function toInt32Instrs(src: number): Instr[] {
  return [
    { op: "local.get", index: src },
    { op: "local.get", index: src },
    { op: "f64.const", value: 2 ** -32 },
    { op: "f64.mul" },
    { op: "f64.trunc" },
    { op: "f64.const", value: 2 ** 32 },
    { op: "f64.mul" },
    { op: "f64.sub" }, // exact; ∞ - ∞ = NaN → trunc_sat 0
    { op: "i64.trunc_sat_f64_s" },
    { op: "i32.wrap_i64" },
  ];
}

/** Narrow raw i32 bits in `bits` to the element kind's value domain. */
function narrowInstrs(bits: number, kind: number): Instr[] {
  const ifKind = (k: number, then: Instr[], other: Instr[]): Instr[] => [
    { op: "local.get", index: kind },
    { op: "i32.const", value: k },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "val", type: I32 }, then, else: other },
  ];
  const sext = (n: number): Instr[] => [
    { op: "local.get", index: bits },
    { op: "i32.const", value: n },
    { op: "i32.shl" },
    { op: "i32.const", value: n },
    { op: "i32.shr_s" },
  ];
  const mask = (m: number): Instr[] => [
    { op: "local.get", index: bits },
    { op: "i32.const", value: m },
    { op: "i32.and" },
  ];
  return ifKind(
    0,
    sext(24),
    ifKind(1, mask(255), ifKind(3, sext(16), ifKind(4, mask(65535), [{ op: "local.get", index: bits }]))),
  );
}

interface Substrate {
  isUndefined: number;
  typeofNumber: number;
  boxNumber: number;
  boxBoolean: number;
}

/** Parameter slots of `__atomics_op`. */
const P = { pOp: 0, pHint: 1, pTa: 2, pIdx: 3, pV: 4, pW: 5 } as const;

/** Shared state of one `__atomics_op` body build, threaded through the phases. */
interface Helper {
  ctx: CodegenContext;
  fctx: FunctionContext;
  b: Instr[];
  sub: Substrate;
  L: Record<
    | "any"
    | "mode"
    | "kind"
    | "len"
    | "es"
    | "base"
    | "shared"
    | "bufArr"
    | "dyn"
    | "stat"
    | "idxF"
    | "i"
    | "vF"
    | "wF"
    | "oldF"
    | "oldBits"
    | "newBits"
    | "vBits"
    | "off"
    | "le"
    | "writeF",
    number
  >;
  T: { dynIdx: number; staticIdx: number; sabIdx: number; bufVecIdx: number; bufArrIdx: number };
  E: Record<"notIntTa" | "notWaitable" | "detached" | "notShared" | "cannotSuspend" | "pauseErr" | "badIndex", Instr[]>;
  opIs(o: number): Instr[];
  kindIs(k: number): Instr[];
  modeIs(m: number): Instr[];
  ret(instrs: Instr[]): Instr[];
  boxF(local: number): Instr[];
}

/** Ensure `__atomics_op` exists; returns its function index (or undefined). */
function ensureAtomicsHelper(ctx: CodegenContext, callerFctx: FunctionContext): number | undefined {
  const existing = ctx.funcMap.get(HELPER);
  if (existing !== undefined) return existing;
  ensureObjectRuntime(ctx);
  // Every carrier type the helper dispatches over is registered up front: the
  // per-name static `$__ta_view_*` structs canonicalize to one runtime type, so
  // one registered witness covers views built by functions compiled later.
  const bufVecIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
  const T = {
    dynIdx: getOrRegisterTaDynViewType(ctx),
    staticIdx: getOrRegisterTaViewType(ctx, "Int32Array"),
    sabIdx: getOrRegisterSabType(ctx),
    bufVecIdx,
    bufArrIdx: getArrTypeIdxFromVec(ctx, bufVecIdx),
  };
  const sub = {
    isUndefined: ensureLateImport(ctx, "__extern_is_undefined", [EXT], [I32]),
    typeofNumber: ensureLateImport(ctx, "__typeof_number", [EXT], [I32]),
    boxNumber: ensureLateImport(ctx, "__box_number", [F64], [EXT]),
    boxBoolean: ensureLateImport(ctx, "__box_boolean", [I32], [EXT]),
  };
  if (Object.values(sub).some((v) => v === undefined)) return undefined;
  const typeErr = (msg: string) => buildThrowJsErrorInstrs(ctx, "TypeError", `TypeError: ${msg}`);
  const E = {
    notIntTa: typeErr("Atomics operation requires an integer TypedArray"),
    notWaitable: typeErr("Atomics.wait/notify requires an Int32Array or BigInt64Array"),
    detached: typeErr("Atomics operation on a detached or out-of-bounds TypedArray"),
    notShared: typeErr("Atomics.wait requires a TypedArray over a SharedArrayBuffer"),
    cannotSuspend: typeErr(
      "Atomics.wait: this agent cannot suspend (AgentCanSuspend() is false for the single host-free agent, #7011)",
    ),
    pauseErr: typeErr("Atomics.pause argument must be an integral Number"),
    badIndex: buildThrowJsErrorInstrs(ctx, "RangeError", "RangeError: Atomics access index out of range"),
  };
  flushLateImportShifts(ctx, callerFctx);
  const fctx = makeFctx();
  const local = (name: string, type: ValType) => allocLocal(fctx, name, type);
  const L = {
    any: local("any", { kind: "anyref" }),
    mode: local("mode", I32), // 1 = buffer view, 2 = i32 vec, 3 = i16 vec, 4 = i8 vec
    kind: local("kind", I32),
    len: local("len", I32),
    es: local("es", I32),
    base: local("base", I32),
    shared: local("shared", I32),
    bufArr: local("bufArr", { kind: "ref_null", typeIdx: T.bufArrIdx }),
    dyn: local("dyn", { kind: "ref_null", typeIdx: T.dynIdx }),
    stat: local("stat", { kind: "ref_null", typeIdx: T.staticIdx }),
    idxF: local("idxF", F64),
    i: local("i", I32),
    vF: local("vF", F64),
    wF: local("wF", F64),
    oldF: local("oldF", F64),
    oldBits: local("oldBits", I32),
    newBits: local("newBits", I32),
    vBits: local("vBits", I32),
    off: local("off", I32),
    le: local("le", I32),
    writeF: local("writeF", F64),
  };
  const eq = (index: number, value: number): Instr[] => [
    { op: "local.get", index },
    { op: "i32.const", value },
    { op: "i32.eq" },
  ];
  const h: Helper = {
    ctx,
    fctx,
    get b() {
      return fctx.body;
    },
    sub: sub as Substrate,
    L,
    T,
    E,
    opIs: (o) => eq(P.pOp, o),
    kindIs: (k) => eq(L.kind, k),
    modeIs: (m) => eq(L.mode, m),
    ret: (instrs) => [...instrs, { op: "return" }],
    boxF: (l) => [
      { op: "local.get", index: l },
      { op: "call", funcIdx: sub.boxNumber! },
    ],
  };
  emitNoTypedArrayOps(h);
  emitResolveCarrier(h);
  emitValidateAndIndex(h);
  emitValueCoercions(h);
  emitRevalidate(h);
  emitReadOld(h);
  emitModifyWrite(h);

  flushLateImportShifts(ctx, fctx);
  const typeIdx = addFuncType(ctx, [I32, I32, EXT, EXT, EXT, EXT], [EXT]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: HELPER, typeIdx, locals: fctx.locals, body: fctx.body, exported: false });
  return funcIdx;
}

/** `isLockFree(size)` / `pause(n)`: no TypedArray operand. */
function emitNoTypedArrayOps(h: Helper): void {
  const { ctx, fctx, b, sub, opIs } = h;
  const { pTa } = P;
  const { kind, vF } = h.L;
  const { pauseErr } = h.E;
  // ── isLockFree(size) / pause(n): no TypedArray operand ──
  {
    const lockFree = capture(fctx, () => pushToIntegerOrInfinity(ctx, fctx, pTa, vF));
    const isSize = (n: number): Instr[] => [
      { op: "local.get", index: vF },
      { op: "f64.const", value: n },
      { op: "f64.eq" },
    ];
    lockFree.push(...isSize(1), ...isSize(2), { op: "i32.or" }, ...isSize(4), { op: "i32.or" }, ...isSize(8), {
      op: "i32.or",
    });
    lockFree.push({ op: "call", funcIdx: sub.boxBoolean }, { op: "return" });
    b.push(...opIs(OP.isLockFree), {
      op: "if",
      blockType: { kind: "empty" },
      then: lockFree,
      else: [],
    });
    // §25.4.15: undefined, or an integral Number; anything else is a TypeError.
    const pause: Instr[] = [
      { op: "local.get", index: pTa },
      { op: "call", funcIdx: sub.isUndefined },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: pTa },
          { op: "call", funcIdx: sub.typeofNumber },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: pauseErr, else: [] },
          ...capture(fctx, () => {
            fctx.body.push({ op: "local.get", index: pTa });
            coerceType(ctx, fctx, EXT, F64);
          }),
          { op: "local.tee", index: vF },
          { op: "local.get", index: vF },
          { op: "f64.trunc" },
          { op: "f64.ne" }, // non-integral or NaN
          { op: "local.get", index: vF },
          { op: "local.get", index: vF },
          { op: "f64.sub" },
          { op: "local.get", index: vF },
          { op: "local.get", index: vF },
          { op: "f64.sub" },
          { op: "f64.ne" }, // ±∞ (∞-∞ = NaN ≠ NaN)
          { op: "i32.or" },
          { op: "if", blockType: { kind: "empty" }, then: pauseErr, else: [] },
        ],
        else: [],
      },
      ...canonicalUndefinedExternInstrs(ctx),
      { op: "return" },
    ];
    b.push(...opIs(OP.pause), {
      op: "if",
      blockType: { kind: "empty" },
      then: pause,
      else: [],
    });
  }
}

/** Resolve the carrier: mode, kind, length, bytes. */
function emitResolveCarrier(h: Helper): void {
  const { ctx, fctx, b } = h;
  const { pHint, pTa } = P;
  const { any, mode, kind, len, es, base, shared, bufArr, dyn, stat } = h.L;
  const { dynIdx, staticIdx, sabIdx, bufVecIdx } = h.T;
  const { detached } = h.E;
  // ── Resolve the carrier: mode, kind, length, bytes ──
  b.push({ op: "i32.const", value: -1 }, { op: "local.set", index: kind });
  b.push({ op: "local.get", index: pTa }, { op: "any.convert_extern" }, { op: "local.set", index: any });
  const viewArm = (viewIdx: number, viewLocal: number): Instr[] =>
    capture(fctx, () => {
      fctx.body.push(
        { op: "local.get", index: any },
        { op: "ref.cast", typeIdx: viewIdx },
        { op: "local.set", index: viewLocal },
        { op: "local.get", index: viewLocal },
        { op: "struct.get", typeIdx: viewIdx, fieldIdx: 3 },
        { op: "local.set", index: kind },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: mode },
        // detached buffer (length marker < 0) → TypeError (ValidateTypedArray)
        { op: "local.get", index: viewLocal },
        { op: "struct.get", typeIdx: viewIdx, fieldIdx: 1 },
        { op: "struct.get", typeIdx: bufVecIdx, fieldIdx: 0 },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        { op: "if", blockType: { kind: "empty" }, then: detached, else: [] },
        { op: "local.get", index: viewLocal },
        { op: "struct.get", typeIdx: viewIdx, fieldIdx: 1 },
        { op: "ref.test", typeIdx: sabIdx },
        { op: "local.set", index: shared },
        { op: "local.get", index: viewLocal },
        { op: "struct.get", typeIdx: viewIdx, fieldIdx: 1 },
        { op: "struct.get", typeIdx: bufVecIdx, fieldIdx: 1 },
        { op: "local.set", index: bufArr },
        { op: "local.get", index: viewLocal },
        { op: "struct.get", typeIdx: viewIdx, fieldIdx: 2 },
        { op: "local.set", index: base },
      );
      pushElemSizeForKind(fctx, kind);
      fctx.body.push({ op: "local.set", index: es });
      pushTaDynViewInBoundsLen(ctx, fctx, viewLocal, es, viewIdx);
      fctx.body.push({ op: "local.set", index: len });
    });
  // Fresh-allocation carriers: the static hint names the kind.
  const vecArm = (elemKey: string, m: number, kinds: number[], next: Instr[]): Instr[] => {
    const vecIdx = ctx.vecTypeMap.get(elemKey);
    if (vecIdx === undefined) return next;
    const hintOk: Instr[] = [];
    for (const k of kinds) {
      hintOk.push({ op: "local.get", index: pHint }, { op: "i32.const", value: k }, { op: "i32.eq" });
      if (hintOk.length > 3) hintOk.push({ op: "i32.or" });
    }
    return [
      { op: "local.get", index: any },
      { op: "ref.test", typeIdx: vecIdx },
      ...hintOk,
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: pHint },
          { op: "local.set", index: kind },
          { op: "i32.const", value: m },
          { op: "local.set", index: mode },
          { op: "local.get", index: any },
          { op: "ref.cast", typeIdx: vecIdx },
          { op: "struct.get", typeIdx: vecIdx, fieldIdx: 0 },
          { op: "local.set", index: len },
        ],
        else: next,
      },
    ];
  };
  const vecArms = vecArm("i32_elem", 2, [5, 6], vecArm("i16_byte", 3, [3, 4], vecArm("i8_byte", 4, [0, 1], [])));
  b.push(
    { op: "local.get", index: any },
    { op: "ref.test", typeIdx: dynIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: viewArm(dynIdx, dyn),
      else: [
        { op: "local.get", index: any },
        { op: "ref.test", typeIdx: staticIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: viewArm(staticIdx, stat),
          else: vecArms,
        },
      ],
    },
  );
}

/** ValidateIntegerTypedArray, the wait-shared check, ValidateAtomicAccess and notify. */
function emitValidateAndIndex(h: Helper): void {
  const { ctx, fctx, b, sub, opIs, kindIs } = h;
  const { pIdx, pV } = P;
  const { kind, len, shared, idxF, i, vF } = h.L;
  const { notIntTa, notWaitable, notShared, badIndex } = h.E;
  // ── ValidateIntegerTypedArray(ta, waitable) ──
  const isWaitOrNotify: Instr[] = [...opIs(OP.wait), ...opIs(OP.notify), { op: "i32.or" }];
  b.push({ op: "local.get", index: kind }, { op: "i32.const", value: 0 }, { op: "i32.lt_s" });
  b.push({ op: "if", blockType: { kind: "empty" }, then: notIntTa, else: [] });
  b.push(...isWaitOrNotify, {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      ...kindIs(5),
      ...kindIs(9),
      { op: "i32.or" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: notWaitable, else: [] },
    ],
    else: [
      // Uint8Clamped (2), Float32 (7), Float64 (8) are not integer-atomic kinds.
      ...kindIs(2),
      ...kindIs(7),
      { op: "i32.or" },
      ...kindIs(8),
      { op: "i32.or" },
      { op: "if", blockType: { kind: "empty" }, then: notIntTa, else: [] },
    ],
  });
  // DoWait step 3: a non-shared buffer is a TypeError before index coercion.
  b.push(...opIs(OP.wait), { op: "local.get", index: shared }, { op: "i32.eqz" }, { op: "i32.and" });
  b.push({ op: "if", blockType: { kind: "empty" }, then: notShared, else: [] });

  // ── ValidateAtomicAccess: ToIndex(index) < length ──
  pushToIntegerOrInfinity(ctx, fctx, pIdx, idxF);
  b.push(
    { op: "local.get", index: idxF },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    { op: "local.get", index: idxF },
    { op: "local.get", index: len },
    { op: "f64.convert_i32_s" },
    { op: "f64.ge" },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: badIndex, else: [] },
    { op: "local.get", index: idxF },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: i },
  );

  // ── notify(ta, index, count): count coerced, no waiter ever exists → 0 ──
  {
    const notify = capture(fctx, () => {
      fctx.body.push({ op: "local.get", index: pV }, { op: "call", funcIdx: sub.isUndefined }, { op: "i32.eqz" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: capture(fctx, () => pushToIntegerOrInfinity(ctx, fctx, pV, vF)),
        else: [],
      });
    });
    notify.push({ op: "f64.const", value: 0 }, { op: "call", funcIdx: sub.boxNumber }, { op: "return" });
    b.push(...opIs(OP.notify), {
      op: "if",
      blockType: { kind: "empty" },
      then: notify,
      else: [],
    });
  }
  b.push(
    ...kindIs(9),
    ...kindIs(10),
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: capture(h.fctx, () => emitBigIntOps(h)), else: [] },
  );
}

const BIG: ValType = { kind: "i64", bigint: true };

/**
 * BigInt64Array / BigUint64Array (buffer-backed views only): the same order as
 * the Number path — ToBigInt coercions, revalidation, then an i64 operation on
 * the 8 little-endian element bytes. Every branch returns. Results box through
 * the i64 BigInt carrier, so a BigUint64Array element ≥ 2^63 reads back as its
 * signed twin (the unsigned-carrier constructor is private to bigint-wide.ts).
 */
function emitBigIntOps(h: Helper): void {
  const { ctx, fctx, opIs, ret } = h;
  const { pV, pW } = P;
  const { bufArr, off, base, i, es, le } = h.L;
  const { bufArrIdx } = h.T;
  const { cannotSuspend, notIntTa } = h.E;
  const I64: ValType = { kind: "i64" };
  const vI = allocLocal(fctx, "vI", I64);
  const wI = allocLocal(fctx, "wI", I64);
  const oldI = allocLocal(fctx, "oldI", I64);
  const newI = allocLocal(fctx, "newI", I64);
  const toBig = (param: number, dst: number) => {
    fctx.body.push({ op: "local.get", index: param });
    coerceType(ctx, fctx, EXT, BIG);
    fctx.body.push({ op: "local.set", index: dst });
  };
  const boxBig = (local: number): Instr[] =>
    capture(fctx, () => {
      fctx.body.push({ op: "local.get", index: local });
      coerceType(ctx, fctx, BIG, EXT);
    });
  const b = () => fctx.body;
  // The fresh-allocation i64 vec carrier is not dispatched here.
  b().push(...h.modeIs(1), { op: "i32.eqz" }, { op: "if", blockType: { kind: "empty" }, then: notIntTa, else: [] });
  b().push(...opIs(OP.load), { op: "i32.eqz" });
  b().push({ op: "if", blockType: { kind: "empty" }, then: capture(fctx, () => toBig(pV, vI)), else: [] });
  b().push(...opIs(OP.compareExchange));
  b().push({ op: "if", blockType: { kind: "empty" }, then: capture(fctx, () => toBig(pW, wI)), else: [] });
  b().push(...opIs(OP.wait), {
    op: "if",
    blockType: { kind: "empty" },
    then: capture(fctx, () => {
      fctx.body.push({ op: "local.get", index: pW });
      coerceType(ctx, fctx, EXT, F64);
      fctx.body.push({ op: "drop" }, ...cannotSuspend);
    }),
    else: [],
  });
  emitRevalidate(h);
  b().push(
    { op: "local.get", index: base },
    { op: "local.get", index: i },
    { op: "local.get", index: es },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.set", index: off },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: le },
    { op: "i64.const", value: 0n },
    { op: "local.set", index: oldI },
  );
  // old = Σ byte[off + k] << 8k (little-endian), most significant first.
  for (let k = 7; k >= 0; k--) {
    b().push(
      { op: "local.get", index: oldI },
      { op: "i64.const", value: 8n },
      { op: "i64.shl" },
      { op: "local.get", index: bufArr },
      { op: "local.get", index: off },
      { op: "i32.const", value: k },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: bufArrIdx },
      { op: "i64.extend_i32_u" },
      { op: "i64.or" },
      { op: "local.set", index: oldI },
    );
  }
  b().push(...opIs(OP.load), { op: "if", blockType: { kind: "empty" }, then: ret(boxBig(oldI)), else: [] });
  const binop = (o: number, wasmOp: string, next: Instr[]): Instr[] => [
    ...opIs(o),
    {
      op: "if",
      blockType: { kind: "val", type: I64 },
      then: [{ op: "local.get", index: oldI }, { op: "local.get", index: vI }, { op: wasmOp } as Instr],
      else: next,
    },
  ];
  const cmpxchg: Instr[] = [
    { op: "local.get", index: oldI },
    { op: "local.get", index: vI },
    { op: "i64.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: I64 },
      then: [{ op: "local.get", index: wI }],
      else: [{ op: "local.get", index: oldI }],
    },
  ];
  const rest: Instr[] = [
    ...opIs(OP.compareExchange),
    { op: "if", blockType: { kind: "val", type: I64 }, then: cmpxchg, else: [{ op: "local.get", index: vI }] },
  ];
  b().push(
    ...binop(
      OP.add,
      "i64.add",
      binop(OP.and, "i64.and", binop(OP.or, "i64.or", binop(OP.sub, "i64.sub", binop(OP.xor, "i64.xor", rest)))),
    ),
    { op: "local.set", index: newI },
  );
  for (let k = 0; k < 8; k++) {
    b().push(
      { op: "local.get", index: bufArr },
      { op: "local.get", index: off },
      { op: "i32.const", value: k },
      { op: "i32.add" },
      { op: "local.get", index: newI },
      { op: "i64.const", value: BigInt(8 * k) },
      { op: "i64.shr_u" },
      { op: "i32.wrap_i64" },
      { op: "array.set", typeIdx: bufArrIdx },
    );
  }
  b().push(...opIs(OP.store), { op: "if", blockType: { kind: "empty" }, then: ret(boxBig(vI)), else: [] });
  b().push(...boxBig(oldI), { op: "return" });
}

/** Op-dependent value coercions; a sync wait ends here (cannot suspend). */
function emitValueCoercions(h: Helper): void {
  const { ctx, fctx, b, opIs } = h;
  const { pV, pW } = P;
  const { kind, vF, wF } = h.L;
  const { cannotSuspend } = h.E;
  // ── value coercions (op-dependent) ──
  b.push(...opIs(OP.load), { op: "i32.eqz" });
  b.push({
    op: "if",
    blockType: { kind: "empty" },
    then: capture(fctx, () => pushToIntegerOrInfinity(ctx, fctx, pV, vF)),
    else: [],
  });
  b.push(...opIs(OP.compareExchange));
  b.push({
    op: "if",
    blockType: { kind: "empty" },
    then: capture(fctx, () => pushToIntegerOrInfinity(ctx, fctx, pW, wF)),
    else: [],
  });
  // wait: timeout = ? ToNumber(timeout), then DoWait step 10 — this agent can
  // never suspend (nothing could ever wake it), so a sync wait is a TypeError.
  b.push(...opIs(OP.wait), {
    op: "if",
    blockType: { kind: "empty" },
    then: capture(fctx, () => {
      fctx.body.push({ op: "local.get", index: pW });
      coerceType(ctx, fctx, EXT, F64);
      fctx.body.push({ op: "drop" }, ...cannotSuspend);
    }),
    else: [],
  });
}

/** RevalidateAtomicAccess after the user-observable coercions. */
function emitRevalidate(h: Helper): void {
  const { ctx, fctx, b } = h;
  const { any, mode, kind, len, es, bufArr, dyn, stat, i } = h.L;
  const { dynIdx, staticIdx, bufVecIdx } = h.T;
  const { detached, badIndex } = h.E;
  // ── RevalidateAtomicAccess after the coercions ──
  b.push({ op: "local.get", index: mode }, { op: "i32.const", value: 1 }, { op: "i32.eq" });
  b.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: any },
      { op: "ref.test", typeIdx: dynIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: capture(fctx, () => {
          fctx.body.push(
            { op: "local.get", index: dyn },
            { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 },
            { op: "struct.get", typeIdx: bufVecIdx, fieldIdx: 0 },
          );
          fctx.body.push(
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: detached,
              else: [],
            },
          );
          pushTaDynViewInBoundsLen(ctx, fctx, dyn, es, dynIdx);
          fctx.body.push({ op: "local.set", index: len });
          // the coercions may have swapped the buffer's data array (grow/resize)
          fctx.body.push(
            { op: "local.get", index: dyn },
            { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 },
            { op: "struct.get", typeIdx: bufVecIdx, fieldIdx: 1 },
            { op: "local.set", index: bufArr },
          );
        }),
        else: capture(fctx, () => {
          fctx.body.push(
            { op: "local.get", index: stat },
            { op: "struct.get", typeIdx: staticIdx, fieldIdx: 1 },
            { op: "struct.get", typeIdx: bufVecIdx, fieldIdx: 0 },
          );
          fctx.body.push(
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: detached,
              else: [],
            },
          );
          pushTaDynViewInBoundsLen(ctx, fctx, stat, es, staticIdx);
          fctx.body.push({ op: "local.set", index: len });
          fctx.body.push(
            { op: "local.get", index: stat },
            { op: "struct.get", typeIdx: staticIdx, fieldIdx: 1 },
            { op: "struct.get", typeIdx: bufVecIdx, fieldIdx: 1 },
            { op: "local.set", index: bufArr },
          );
        }),
      },
    ],
    else: [],
  });
  b.push({ op: "local.get", index: i }, { op: "local.get", index: len }, { op: "i32.ge_u" });
  b.push({ op: "if", blockType: { kind: "empty" }, then: badIndex, else: [] });
}

/** Read the old element value (exact f64); `load` returns it. */
function emitReadOld(h: Helper): void {
  const { ctx, fctx, b, opIs, kindIs, modeIs, ret, boxF } = h;
  const { any, kind, es, base, bufArr, i, oldF, off, le } = h.L;
  const { bufArrIdx } = h.T;
  // ── read the old element value (exact f64) ──
  const vecRead = (elemKey: string, signedKind: number, wide: boolean): Instr[] => {
    const vecIdx = ctx.vecTypeMap.get(elemKey);
    if (vecIdx === undefined) return [{ op: "f64.const", value: 0 }];
    const arrIdx = getArrTypeIdxFromVec(ctx, vecIdx);
    const get = (signed: boolean): Instr[] =>
      [
        { op: "local.get", index: any },
        { op: "ref.cast", typeIdx: vecIdx },
        { op: "struct.get", typeIdx: vecIdx, fieldIdx: 1 },
        { op: "local.get", index: i },
        wide ? { op: "array.get", typeIdx: arrIdx } : { op: signed ? "array.get_s" : "array.get_u", typeIdx: arrIdx },
        { op: signed ? "f64.convert_i32_s" : "f64.convert_i32_u" },
      ] as Instr[];
    return [
      ...kindIs(signedKind),
      {
        op: "if",
        blockType: { kind: "val", type: F64 },
        then: get(true),
        else: get(false),
      },
    ];
  };
  b.push(
    { op: "i32.const", value: 1 },
    { op: "local.set", index: le },
    { op: "local.get", index: base },
    { op: "local.get", index: i },
    { op: "local.get", index: es },
    { op: "i32.mul" },
    { op: "i32.add" },
    { op: "local.set", index: off },
  );
  const viewRead = capture(fctx, () => {
    fctx.body.push(...emitDynDecodeDispatch(ctx, fctx, kind, bufArr, off, le, bufArrIdx));
  });
  b.push(...modeIs(1), {
    op: "if",
    blockType: { kind: "val", type: F64 },
    then: viewRead,
    else: [
      ...modeIs(2),
      {
        op: "if",
        blockType: { kind: "val", type: F64 },
        then: vecRead("i32_elem", 5, true),
        else: [
          ...modeIs(3),
          {
            op: "if",
            blockType: { kind: "val", type: F64 },
            then: vecRead("i16_byte", 3, false),
            else: vecRead("i8_byte", 0, false),
          },
        ],
      },
    ],
  });
  b.push({ op: "local.set", index: oldF });

  // ── load: done ──
  b.push(...opIs(OP.load), {
    op: "if",
    blockType: { kind: "empty" },
    then: ret(boxF(oldF)),
    else: [],
  });
}

/** Read-modify-write in the i32 bit domain, write back, return. */
function emitModifyWrite(h: Helper): void {
  const { ctx, fctx, b, sub, opIs, kindIs, modeIs, boxF } = h;
  const { any, kind, bufArr, i, vF, wF, oldF, oldBits, newBits, vBits, off, le, writeF } = h.L;
  const { bufArrIdx } = h.T;
  // ── read-modify-write in the i32 bit domain ──
  b.push(
    { op: "local.get", index: oldF },
    { op: "i64.trunc_sat_f64_s" },
    { op: "i32.wrap_i64" },
    { op: "local.set", index: oldBits },
  );
  b.push(...toInt32Instrs(vF), { op: "local.set", index: vBits });
  const binop = (o: number, wasmOp: string, next: Instr[]): Instr[] => [
    ...opIs(o),
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "local.get", index: oldBits }, { op: "local.get", index: vBits }, { op: wasmOp } as Instr],
      else: next,
    },
  ];
  // compareExchange: replace only when the narrowed expected value matches.
  const cmpxchg: Instr[] = [
    ...narrowInstrs(vBits, kind),
    ...narrowInstrs(oldBits, kind),
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: toInt32Instrs(wF),
      else: [{ op: "local.get", index: oldBits }],
    },
  ];
  b.push(
    ...binop(
      OP.add,
      "i32.add",
      binop(
        OP.and,
        "i32.and",
        binop(
          OP.or,
          "i32.or",
          binop(
            OP.sub,
            "i32.sub",
            binop(OP.xor, "i32.xor", [
              ...opIs(OP.compareExchange),
              {
                op: "if",
                blockType: { kind: "val", type: I32 },
                then: cmpxchg,
                else: [{ op: "local.get", index: vBits }],
              },
            ]),
          ),
        ),
      ),
    ),
  );
  b.push({ op: "local.set", index: newBits });

  // ── write back ──
  const unsignedKind: Instr[] = [...kindIs(1), ...kindIs(4), { op: "i32.or" }, ...kindIs(6), { op: "i32.or" }];
  const viewWrite = capture(fctx, () => {
    fctx.body.push(
      ...unsignedKind,
      {
        op: "if",
        blockType: { kind: "val", type: F64 },
        then: [{ op: "local.get", index: newBits }, { op: "f64.convert_i32_u" }],
        else: [{ op: "local.get", index: newBits }, { op: "f64.convert_i32_s" }],
      },
      { op: "local.set", index: writeF },
    );
    fctx.body.push(...emitDynEncodeDispatch(ctx, fctx, kind, bufArr, off, writeF, le, bufArrIdx));
  });
  const vecWrite = (elemKey: string): Instr[] => {
    const vecIdx = ctx.vecTypeMap.get(elemKey);
    if (vecIdx === undefined) return [];
    const arrIdx = getArrTypeIdxFromVec(ctx, vecIdx);
    return [
      { op: "local.get", index: any },
      { op: "ref.cast", typeIdx: vecIdx },
      { op: "struct.get", typeIdx: vecIdx, fieldIdx: 1 },
      { op: "local.get", index: i },
      { op: "local.get", index: newBits },
      { op: "array.set", typeIdx: arrIdx },
    ];
  };
  b.push(...modeIs(1), {
    op: "if",
    blockType: { kind: "empty" },
    then: viewWrite,
    else: [
      ...modeIs(2),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: vecWrite("i32_elem"),
        else: [
          ...modeIs(3),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: vecWrite("i16_byte"),
            else: vecWrite("i8_byte"),
          },
        ],
      },
    ],
  });

  // store returns ToIntegerOrInfinity(v) (with -0 normalized); the rest the old value.
  b.push(...opIs(OP.store), {
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: vF },
      { op: "f64.const", value: 0 },
      { op: "f64.add" },
      { op: "call", funcIdx: sub.boxNumber },
      { op: "return" },
    ],
    else: [],
  });
  b.push(...boxF(oldF));
}

/**
 * Thin direct-call adapter for `Atomics.<method>(...)`: evaluates the
 * arguments left to right (extra ones for their effects), then delegates the
 * whole operation to `__atomics_op`. Returns undefined for a method this
 * provider does not own (`waitAsync`), leaving the caller's fallback in place.
 */
export function emitNativeAtomicsCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  args: readonly ts.Expression[],
  compileExpr: (expr: ts.Expression) => ValType | null,
): ValType | undefined {
  if (!noJsHost(ctx) || !Object.prototype.hasOwnProperty.call(OP, method)) return undefined;
  const op = OP[method as AtomicsMethod];
  if (ensureAtomicsHelper(ctx, fctx) === undefined) return undefined;
  const builtin = args.length > 0 ? ctx.oracle.builtinReceiverOf(args[0]!) : undefined;
  const hint = builtin !== undefined ? taCtorKindOf(builtin) : -1;
  const slots: number[] = [];
  for (let n = 0; n < args.length; n++) {
    const t = compileExpr(args[n]!);
    if (n >= 4) {
      if (t) fctx.body.push({ op: "drop" });
      continue;
    }
    if (t === null) fctx.body.push(...canonicalUndefinedExternInstrs(ctx));
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXT);
    const local = allocLocal(fctx, `__atomics_a${n}_${fctx.locals.length}`, EXT);
    fctx.body.push({ op: "local.set", index: local });
    slots.push(local);
  }
  flushLateImportShifts(ctx, fctx);
  const helperIdx = ctx.funcMap.get(HELPER)!;
  fctx.body.push({ op: "i32.const", value: op }, { op: "i32.const", value: hint });
  for (let n = 0; n < 4; n++) {
    if (n < slots.length) fctx.body.push({ op: "local.get", index: slots[n]! });
    else fctx.body.push(...canonicalUndefinedExternInstrs(ctx));
  }
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return EXT;
}
