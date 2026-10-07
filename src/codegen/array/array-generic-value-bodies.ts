// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6912, S3-m of #5385) `Array.prototype.pop` / `shift` / `toString` as
 * callable VALUES on the native regime.
 *
 * The generic forms — `obj.pop = Array.prototype.pop; obj.pop()`, or
 * `Array.prototype.shift.call(arrayLike)` — reach the native-proto closure
 * (the direct `arr.pop()` on a typed vec has its own fast lowering and never
 * comes here). The receiver is an arbitrary array-LIKE, so the bodies run on
 * the dynamic object substrate the other generic mutators use
 * (`__extern_length`, `__extern_get_idx`, `__extern_has_idx`,
 * `__extern_set_strict`, `__delete_property`), spec-literally:
 *
 *   pop      §23.1.3.22: len = 0 → Set(O, "length", 0, true), undefined; else
 *            Get(O, len-1), DeletePropertyOrThrow(O, len-1), Set(O, "length",
 *            len-1, true), return the element.
 *   shift    §23.1.3.27: len = 0 → as pop; else first = Get(O, "0"), move
 *            every present O[k] to O[k-1] (a hole deletes O[k-1]), delete
 *            O[len-1], Set(O, "length", len-1, true), return first.
 *   toString §23.1.3.36: func = Get(O, "join"); IsCallable(func) ? Call(func,
 *            O) : %Object.prototype.toString%(O).
 *
 * Every Set is Set(O, P, V, true) and every delete is DeletePropertyOrThrow:
 * a frozen / non-writable receiver throws a TypeError rather than silently
 * keeping its old state. None of the three takes an argument, so the closures
 * keep the fixed ABI `(self, this)`. Gated on the native regime.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { canonicalUndefinedExternInstrs } from "../any-helpers.js";
import { emitArrayProtoHofReceiverGuard } from "../array-reduce-proto-value.js";
import { prepareArrayLikeDefaultJoin } from "../array-like-native.js";
import { buildThrowJsErrorInstrs } from "../js-errors.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { ensureObjectProtoToStringRuntimeHelper } from "../object-proto-tostring.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";

const EXT: ValType = { kind: "externref" };
const F64: ValType = { kind: "f64" };
const I32: ValType = { kind: "i32" };

const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const f64 = (value: number): Instr => ({ op: "f64.const", value });

/**
 * Emit the pop / shift / toString closure body. Returns `undefined`, emitting
 * nothing, for any other member, off the native regime, or when the substrate
 * is unavailable — the caller keeps its refusal.
 */
export function emitArrayGenericValueMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | undefined {
  if (!ctx.standalone && !ctx.wasi) return undefined;
  if (member === "toString") return emitArrayToStringBody(ctx, fctx);
  return emitArrayLikePopShiftBody(ctx, fctx, member);
}

/**
 * §23.1.3.36 — `join` looked up on the receiver (an override, a transferred
 * method or the inherited `Array.prototype.join`), called with no arguments;
 * a non-callable `join` falls back to `Object.prototype.toString`.
 */
function emitArrayToStringBody(ctx: CodegenContext, fctx: FunctionContext): ValType | undefined {
  ensureObjectRuntime(ctx);
  // Mint the Object.prototype.toString classifier first (it may register its
  // own imports); every index is re-read by NAME after the flush below.
  if (ensureObjectProtoToStringRuntimeHelper(ctx) === undefined) return undefined;
  const defaultJoin = prepareArrayLikeDefaultJoin(ctx, fctx);
  if (defaultJoin === undefined) return undefined;
  ensureLateImport(ctx, "__extern_is_array", [EXT], [I32]);
  ensureLateImport(ctx, "__extern_get", [EXT, EXT], [EXT]);
  ensureLateImport(ctx, "__apply_closure", [EXT, EXT, EXT], [EXT]);
  ensureLateImport(ctx, "__is_callable", [EXT], [I32]);
  addStringConstantGlobal(ctx, "join");
  flushLateImportShifts(ctx, fctx);
  const objectToString = ctx.funcMap.get("__object_proto_to_string_runtime");
  const getProp = ctx.funcMap.get("__extern_get");
  const apply = ctx.funcMap.get("__apply_closure");
  const isCallable = ctx.funcMap.get("__is_callable");
  const isArray = ctx.funcMap.get("__extern_is_array");
  if (
    objectToString === undefined ||
    getProp === undefined ||
    apply === undefined ||
    isCallable === undefined ||
    isArray === undefined
  ) {
    return undefined;
  }
  emitArrayProtoHofReceiverGuard(ctx, fctx, "toString");
  const func = allocLocal(fctx, `__tostring_join_${fctx.locals.length}`, EXT);
  fctx.body.push(
    get(1),
    ...stringConstantExternrefInstrs(ctx, "join"),
    { op: "call", funcIdx: getProp },
    { op: "local.tee", index: func },
    { op: "call", funcIdx: isCallable },
    {
      op: "if",
      blockType: { kind: "val", type: EXT },
      then: [get(func), get(1), { op: "ref.null.extern" }, { op: "call", funcIdx: apply }],
      // A real Array whose `join` the dynamic read cannot see (the inherited
      // prototype method is not on the vec's dynamic property path) joins
      // natively with the default separator — what the inherited
      // `Array.prototype.join` does. Anything else is Object.prototype.toString.
      else: [
        get(1),
        { op: "call", funcIdx: isArray },
        {
          op: "if",
          blockType: { kind: "val", type: EXT },
          then: defaultJoin(),
          else: [{ op: "ref.null.extern" }, get(1), { op: "call", funcIdx: objectToString }],
        },
      ],
    },
  );
  return EXT;
}

function emitArrayLikePopShiftBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | undefined {
  if (member !== "pop" && member !== "shift") return undefined;

  // Every late-import-adding ensure BEFORE the first body instruction.
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_length", [EXT], [F64]);
  ensureLateImport(ctx, "__extern_get_idx", [EXT, F64], [EXT]);
  ensureLateImport(ctx, "__extern_has_idx", [EXT, F64], [I32]);
  ensureLateImport(ctx, "__delete_property", [EXT, EXT], [I32]);
  ensureLateImport(ctx, "__box_number", [F64], [EXT]);
  addStringConstantGlobal(ctx, "length");
  flushLateImportShifts(ctx, fctx);
  const names = ["__extern_length", "__extern_get_idx", "__extern_has_idx", "__delete_property", "__box_number"];
  const idx = names.map((n) => ctx.funcMap.get(n));
  const setStrict = ctx.funcMap.get("__extern_set_strict");
  if (idx.some((i) => i === undefined) || setStrict === undefined) return undefined;
  const [length, getIdx, hasIdx, del, box] = idx as number[];
  const undef = canonicalUndefinedExternInstrs(ctx);

  emitArrayProtoHofReceiverGuard(ctx, fctx, member);
  const len = allocLocal(fctx, `__${member}_len_${fctx.locals.length}`, F64);
  const k = allocLocal(fctx, `__${member}_k_${fctx.locals.length}`, F64);
  const res = allocLocal(fctx, `__${member}_res_${fctx.locals.length}`, EXT);

  const call = (funcIdx: number): Instr => ({ op: "call", funcIdx });
  const boxed = (value: Instr[]): Instr[] => [...value, call(box)];
  const setLength = (value: Instr[]): Instr[] => [
    get(1),
    ...stringConstantExternrefInstrs(ctx, "length"),
    ...boxed(value),
    call(setStrict),
  ];
  const deleteOrThrow = (key: Instr[]): Instr[] => [
    get(1),
    ...boxed(key),
    call(del),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(
        ctx,
        "TypeError",
        `Cannot delete property of the Array.prototype.${member} receiver`,
      ),
    },
  ];
  const lenMinusOne: Instr[] = [get(len), f64(1), { op: "f64.sub" }];

  let nonEmpty: Instr[];
  if (member === "pop") {
    nonEmpty = [
      get(1),
      ...lenMinusOne,
      call(getIdx),
      set(res),
      ...deleteOrThrow(lenMinusOne),
      ...setLength(lenMinusOne),
    ];
  } else {
    const kMinusOne: Instr[] = [get(k), f64(1), { op: "f64.sub" }];
    nonEmpty = [
      get(1),
      f64(0),
      call(getIdx),
      set(res),
      f64(1),
      set(k),
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              get(k),
              get(len),
              { op: "f64.ge" },
              { op: "br_if", depth: 1 },
              get(1),
              get(k),
              call(hasIdx),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [get(1), ...boxed(kMinusOne), get(1), get(k), call(getIdx), call(setStrict)],
                else: deleteOrThrow(kMinusOne),
              },
              get(k),
              f64(1),
              { op: "f64.add" },
              set(k),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      ...deleteOrThrow(lenMinusOne),
      ...setLength(lenMinusOne),
    ];
  }

  fctx.body.push(
    get(1),
    call(length),
    set(len),
    get(len),
    f64(0),
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...setLength([f64(0)]), ...undef, set(res)],
      else: nonEmpty,
    },
    get(res),
  );
  return EXT;
}
