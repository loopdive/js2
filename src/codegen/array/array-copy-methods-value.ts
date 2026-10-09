// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6912, S3-m of #5385) The ES2023 change-array-by-copy members `toReversed`,
 * `with` and `toSpliced`, plus `copyWithin`, as callable VALUES on the native
 * regime.
 *
 * The receiver is an arbitrary array-LIKE (`Array.prototype.with.call(obj, …)`
 * is how the corpus exercises genericity), so the bodies read it through the
 * dynamic substrate (`__extern_length`, `__extern_get_idx`) and build the
 * result as the same native `$ObjVec` the `slice`/`splice` producers return
 * (`__objvec_new` / `__objvec_push`), spec-literally:
 *
 *   toReversed §23.1.3.33: A = ArrayCreate(len); A[k] = Get(O, len-k-1).
 *   with       §23.1.3.39: actualIndex from ToIntegerOrInfinity(index); out
 *              of [0, len) is a RangeError; A[k] = k === actualIndex ? value :
 *              Get(O, k).
 *   toSpliced  §23.1.3.35: actualStart / actualSkipCount exactly as `splice`
 *              (start absent → skip 0; skipCount absent → len - start); a new
 *              length above 2^53-1 is a TypeError; the copy is
 *              O[0, start) ++ items ++ O[start + skip, len).
 *
 * ArrayCreate's length check (> 2^32-1 → RangeError) runs before any element
 * is read. Arguments go through the coercion engine (observable `valueOf`).
 * `with` / `toSpliced` / `copyWithin` take the variadic ABI so argument
 * PRESENCE is visible; `copyWithin` delegates to the existing
 * `__arrprod_copyWithin(recv, args)` helper (#6651 H6). Gated on the native
 * regime.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { emitArrayProtoHofReceiverGuard, emitVariadicArgsUnpack } from "../array-reduce-proto-value.js";
import { buildThrowJsErrorInstrs } from "../js-errors.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { coerceType, ensureLateImport, flushLateImportShifts } from "../shared.js";
import { ensureNativeArrayCopyWithin } from "./array-copywithin-native.js";

const EXT: ValType = { kind: "externref" };
const F64: ValType = { kind: "f64" };

const VARIADIC: ReadonlySet<string> = new Set(["with", "toSpliced", "copyWithin"]);

/** True when the member's closure takes the packed variadic ABI. */
export function isArrayCopyMethodVariadicMember(ctx: CodegenContext, member: string): boolean {
  return VARIADIC.has(member) && (ctx.standalone || ctx.wasi);
}

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const f64 = (value: number): Instr => ({ op: "f64.const", value });

/** `while (k < end) { body; k++ }` over f64 locals. */
function countUp(k: number, end: Instr[], body: Instr[]): Instr {
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          get(k),
          ...end,
          { op: "f64.ge" },
          { op: "br_if", depth: 1 },
          ...body,
          get(k),
          f64(1),
          { op: "f64.add" },
          set(k),
          { op: "br", depth: 0 },
        ],
      },
    ],
  };
}

/**
 * Emit the closure body for `toReversed` / `with` / `toSpliced` / `copyWithin`.
 * Returns `undefined`, emitting nothing, for any other member, off the native
 * regime, or when a dependency is unavailable — the caller keeps its refusal.
 */
export function emitArrayCopyMethodMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (member !== "toReversed" && member !== "with" && member !== "toSpliced" && member !== "copyWithin") {
    return undefined;
  }
  if (!ctx.standalone && !ctx.wasi) return undefined;
  if (member === "copyWithin") {
    if (fctx.params.length < 3) return undefined;
    const helper = ensureNativeArrayCopyWithin(ctx);
    if (helper === undefined) return undefined;
    fctx.body.push(get(1), get(2), { op: "extern.convert_any" }, { op: "call", funcIdx: helper });
    return EXT;
  }

  // Every late-import-adding ensure BEFORE the first body instruction.
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_length", [EXT], [F64]);
  ensureLateImport(ctx, "__extern_get_idx", [EXT, F64], [EXT]);
  ensureLateImport(ctx, "__objvec_new", [], [EXT]);
  ensureLateImport(ctx, "__objvec_push", [EXT, EXT], []);
  const realBody = fctx.body;
  fctx.body = [{ op: "ref.null.extern" }]; // pre-register the ToNumber lowering's imports
  try {
    coerceType(ctx, fctx, EXT, F64);
  } finally {
    fctx.body = realBody;
  }
  flushLateImportShifts(ctx, fctx);
  const idx = ["__extern_length", "__extern_get_idx", "__objvec_new", "__objvec_push"].map((n) => ctx.funcMap.get(n));
  if (idx.some((i) => i === undefined)) return undefined;
  const [length, getIdx, vecNew, vecPush] = idx as number[];
  const undef = canonicalUndefinedExternInstrs(ctx);

  emitArrayProtoHofReceiverGuard(ctx, fctx, member);
  const args = member === "toReversed" ? undefined : emitVariadicArgsUnpack(ctx, fctx, member);
  if (member !== "toReversed" && args === undefined) {
    throw new Error(`Array.prototype.${member} value body lacks its argument vector`);
  }
  const len = allocLocal(fctx, `__${member}_len_${fctx.locals.length}`, F64);
  const k = allocLocal(fctx, `__${member}_k_${fctx.locals.length}`, F64);
  const out = allocLocal(fctx, `__${member}_out_${fctx.locals.length}`, EXT);
  const call = (funcIdx: number): Instr => ({ op: "call", funcIdx });

  /** ToIntegerOrInfinity(args[i] ?? undefined) → f64 on the stack. */
  const integerArg = (i: number, tmp: number): Instr[] => {
    const conv: Instr[] = [];
    fctx.body = conv;
    try {
      fctx.body.push(...args!.argAt(i, undef));
      coerceType(ctx, fctx, EXT, F64);
    } finally {
      fctx.body = realBody;
    }
    return [
      ...conv,
      { op: "local.tee", index: tmp },
      get(tmp),
      { op: "f64.ne" },
      { op: "if", blockType: { kind: "val", type: F64 }, then: [f64(0)], else: [get(tmp), { op: "f64.trunc" }] },
    ];
  };
  /** ArrayCreate(n) for the f64 on the stack: RangeError above 2^32-1. */
  const arrayCreate = (n: Instr[]): Instr[] => [
    ...n,
    f64(4294967295),
    { op: "f64.gt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "RangeError", "Invalid array length"),
    },
    call(vecNew),
    set(out),
  ];
  const pushFrom = (index: Instr[]): Instr[] => [get(out), get(1), ...index, call(getIdx), call(vecPush)];

  fctx.body.push(get(1), call(length), set(len));
  if (member === "toReversed") {
    fctx.body.push(
      ...arrayCreate([get(len)]),
      f64(0),
      set(k),
      countUp(k, [get(len)], pushFrom([get(len), get(k), { op: "f64.sub" }, f64(1), { op: "f64.sub" }])),
    );
  } else if (member === "with") {
    const at = allocLocal(fctx, `__with_index_${fctx.locals.length}`, F64);
    fctx.body.push(
      ...integerArg(0, at),
      set(at),
      get(at),
      f64(0),
      { op: "f64.lt" },
      { op: "if", blockType: { kind: "empty" }, then: [get(len), get(at), { op: "f64.add" }, set(at)] },
      get(at),
      get(len),
      { op: "f64.ge" },
      get(at),
      f64(0),
      { op: "f64.lt" },
      { op: "i32.or" },
      { op: "if", blockType: { kind: "empty" }, then: buildThrowJsErrorInstrs(ctx, "RangeError", "Invalid index") },
      ...arrayCreate([get(len)]),
      f64(0),
      set(k),
      countUp(
        k,
        [get(len)],
        [
          get(k),
          get(at),
          { op: "f64.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [get(out), ...args!.argAt(1, undef), call(vecPush)],
            else: pushFrom([get(k)]),
          },
        ],
      ),
    );
  } else {
    // toSpliced
    const start = allocLocal(fctx, `__toSpliced_start_${fctx.locals.length}`, F64);
    const skip = allocLocal(fctx, `__toSpliced_skip_${fctx.locals.length}`, F64);
    const items = allocLocal(fctx, `__toSpliced_items_${fctx.locals.length}`, F64);
    const newLen = allocLocal(fctx, `__toSpliced_newlen_${fctx.locals.length}`, F64);
    const argc: Instr[] = [get(args!.argsLen), { op: "f64.convert_i32_s" }];
    fctx.body.push(
      // actualStart: relative start clamped into [0, len]
      ...integerArg(0, start),
      set(start),
      get(start),
      f64(0),
      { op: "f64.lt" },
      {
        op: "if",
        blockType: { kind: "val", type: F64 },
        then: [get(len), get(start), { op: "f64.add" }, f64(0), { op: "f64.max" }],
        else: [get(start), get(len), { op: "f64.min" }],
      },
      set(start),
      // insertCount = max(argc - 2, 0)
      ...argc,
      f64(2),
      { op: "f64.sub" },
      f64(0),
      { op: "f64.max" },
      set(items),
      // actualSkipCount
      get(args!.argsLen),
      { op: "i32.const", value: 0 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: F64 },
        then: [f64(0)],
        else: [
          get(args!.argsLen),
          { op: "i32.const", value: 1 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "val", type: F64 },
            then: [get(len), get(start), { op: "f64.sub" }],
            else: [
              ...integerArg(1, skip),
              f64(0),
              { op: "f64.max" },
              get(len),
              get(start),
              { op: "f64.sub" },
              { op: "f64.min" },
            ],
          },
        ],
      },
      set(skip),
      get(len),
      get(items),
      { op: "f64.add" },
      get(skip),
      { op: "f64.sub" },
      set(newLen),
      get(newLen),
      f64(9007199254740991),
      { op: "f64.gt" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "TypeError", "Array.prototype.toSpliced result length exceeds 2^53-1"),
      },
      ...arrayCreate([get(newLen)]),
      // O[0, start)
      f64(0),
      set(k),
      countUp(k, [get(start)], pushFrom([get(k)])),
      // items (args[2 ..])
      f64(0),
      set(k),
      countUp(
        k,
        [get(items)],
        [
          get(out),
          // args[2 + k]; in bounds because k < insertCount = argc - 2
          ...args!.argAtDynamic([
            get(k),
            { op: "i32.trunc_sat_f64_s" },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
          ]),
          call(vecPush),
        ],
      ),
      // O[start + skip, len)
      get(start),
      get(skip),
      { op: "f64.add" },
      set(k),
      countUp(k, [get(len)], pushFrom([get(k)])),
    );
  }
  fctx.body.push(get(out));
  return EXT;
}
