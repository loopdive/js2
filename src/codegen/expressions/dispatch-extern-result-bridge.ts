// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6684) Keep a LIVE dispatch arm's externref result when the call site
 * expects a nullable WasmGC reference, under `--target standalone` / `wasi`.
 *
 * The closure-call dispatch ladders (`call-identifier.ts` for `f(x)`,
 * `calls-closures.ts` for `obj.f(x)`) test the callee's runtime funcref
 * against every candidate signature. When the matching candidate returns
 * `externref` but the call site's static result is a typed reference — a
 * JSDoc `@returns {string}` makes it the native-string carrier — no bridge
 * applied and the arm fell into the dead-arm placeholder: `drop` the result,
 * answer `ref.null`. That placeholder is right for arms that never run, but
 * for the LIVE arm it silently discarded the value. lodash-es's `toString`
 * (`@returns {string}`) is exported through a runtime-eval carrier whose
 * trampoline returns externref, so `toString("abc")` answered `undefined` in
 * the importer and `words(text).length` trapped on a null.
 *
 * The bridge is a GUARDED downcast, not `ref.cast`: the value survives when it
 * really is a `T`, and anything else still answers `null` — exactly the
 * previous answer — so it can never trap where the old code did not. It is a
 * pure reference test (no call, no import), which the ladders require of
 * every arm (#2174: a late import from a dead arm shifts baked indices).
 *
 * Returns null — caller keeps its placeholder — off the no-host lanes and for
 * a non-struct/array target.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";

export function guardedExternRefResultBridge(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
): Instr[] | null {
  if (from.kind !== "externref" && from.kind !== "ref_extern") return null;
  if (to.kind !== "ref_null" && to.kind !== "ref") return null;
  // `ref.test` from `anyref` is valid only against struct/array heap types.
  const toDef = ctx.mod.types[to.typeIdx];
  if (toDef?.kind !== "struct" && toDef?.kind !== "array") return null;
  const scratch = allocLocal(fctx, `__dispatch_ret_any_${fctx.locals.length}`, { kind: "anyref" });
  return [
    { op: "any.convert_extern" },
    { op: "local.tee", index: scratch },
    { op: "ref.test", typeIdx: to.typeIdx },
    {
      op: "if",
      // Same block type the ladder declares; its dead-arm placeholder
      // (`defaultValueInstrs`) answers `ref.null` for both kinds too.
      blockType: { kind: "val", type: to },
      then: [
        { op: "local.get", index: scratch },
        { op: "ref.cast", typeIdx: to.typeIdx },
      ],
      else: [{ op: "ref.null", typeIdx: to.typeIdx }],
    },
  ];
}

/**
 * (#7025) Box a LIVE dispatch arm's scalar / WasmGC-reference result into the
 * call site's `$AnyValue` union carrier, under `--target standalone` / `wasi`.
 *
 * A call through a value whose static type is a union of signatures —
 * `[syncTest, asyncTest][i]()`, `(() => number) | (() => string)` — expects
 * `$AnyValue`, while each candidate arm returns its own ABI (`f64`, a native
 * string ref, …). Those arms fell into the dead-arm placeholder (`drop` +
 * `ref.null`), so the live arm's value was discarded: React's standalone test
 * batches dispatch every lifted test through one such array, and every
 * synchronous `return 1` read back as null once a batch also held an async
 * test.
 *
 * Builds the box inline with the `__any_box_*` field layout (tag, i32val,
 * f64val, refval, externval; tags 2 i32 / 3 f64 / 4 bool / 5 string / 6 ref)
 * — a pure `struct.new`, because the ladders require every arm to be free of
 * calls and late registration (#2174), and the box helpers need not exist in
 * a module that only tests the carrier. Returns null — caller keeps its
 * placeholder — off the no-host lanes, for a non-`$AnyValue` target, or an
 * externref source.
 */
export function anyValueResultBridge(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
): Instr[] | null {
  const tag = anyValueBoxTag(ctx, from, to);
  if (tag === null) return null;
  if (tag === IDENTITY) return [];
  const scratch = allocLocal(fctx, `__dispatch_ret_box_${fctx.locals.length}`, from);
  const value: Instr = { op: "local.get", index: scratch };
  return [
    { op: "local.set", index: scratch },
    { op: "i32.const", value: tag },
    ...(from.kind === "i32" ? [value] : [{ op: "i32.const", value: 0 } as Instr]),
    ...(from.kind === "f64" ? [value] : [{ op: "f64.const", value: 0 } as Instr]),
    ...(tag === 6 ? [value] : [{ op: "ref.null", typeIdx: EQ_HEAP_TYPE } as Instr]),
    ...(tag === 5 ? [value, { op: "extern.convert_any" } as Instr] : [{ op: "ref.null.extern" } as Instr]),
    { op: "struct.new", typeIdx: ctx.anyValueTypeIdx },
  ];
}

/**
 * (#7025) The same live-arm loss for an `externref` call-site result: an arm
 * returning a plain `f64` / `i32` was dropped to `ref.null.extern` (JS `null`)
 * — `[syncTest, asyncTest][i]()` is `number | Promise<number>`, which lowers to
 * externref. Box through `__box_number` / `__box_boolean` when the module
 * ALREADY has them (no registration inside a ladder arm, #2174); otherwise keep
 * the placeholder. An undefined-sentinel f64 is left alone: the plain number
 * box would turn `undefined` into NaN.
 */
export function boxedScalarResultBridge(ctx: CodegenContext, from: ValType, to: ValType): Instr[] | null {
  if (!(ctx.standalone || ctx.wasi) || (to.kind !== "externref" && to.kind !== "ref_extern")) return null;
  const boxNumber = ctx.funcMap.get("__box_number");
  if (from.kind === "f64" && from.undefSentinel !== true && boxNumber !== undefined) {
    return [{ op: "call", funcIdx: boxNumber }];
  }
  if (from.kind !== "i32") return null;
  if ((from as { boolean?: true }).boolean === true) {
    const boxBoolean = ctx.funcMap.get("__box_boolean");
    return boxBoolean === undefined ? null : [{ op: "call", funcIdx: boxBoolean }];
  }
  return boxNumber === undefined ? null : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumber }];
}

/**
 * (#7025) The live-arm result bridge of the closure-call ladders on the no-host
 * lanes: box into `$AnyValue`, box a scalar into externref, else #6684's
 * guarded downcast. Null keeps the caller's dead-arm placeholder.
 */
export function liveResultBridge(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
): Instr[] | null {
  return (
    anyValueResultBridge(ctx, fctx, from, to) ??
    boxedScalarResultBridge(ctx, from, to) ??
    guardedExternRefResultBridge(ctx, fctx, from, to)
  );
}

/**
 * (#7025) Whether a no-host ladder can keep a live candidate's `from` result in
 * a `to` slot through {@link anyValueResultBridge} / {@link boxedScalarResultBridge}
 * — so the candidate is admitted instead of ending in the TypeError terminal.
 */
export function liveResultBridgeable(ctx: CodegenContext, from: ValType, to: ValType): boolean {
  return boxedScalarResultBridge(ctx, from, to) !== null || anyValueBoxTag(ctx, from, to) !== null;
}

/**
 * The `$AnyValue` tag {@link anyValueResultBridge} boxes `from` with, `IDENTITY`
 * when `from` already is the carrier, or null when it does not bridge. Pure —
 * the dispatch ladders also use it to admit a candidate before building arms.
 */
export function anyValueBoxTag(ctx: CodegenContext, from: ValType, to: ValType): number | null {
  if (!(ctx.standalone || ctx.wasi) || ctx.anyValueTypeIdx < 0) return null;
  if ((to.kind !== "ref_null" && to.kind !== "ref") || to.typeIdx !== ctx.anyValueTypeIdx) return null;
  if (from.kind === "f64") return from.undefSentinel === true ? null : 3; // a NaN box would lose undefined
  if (from.kind === "i32") return (from as { boolean?: true }).boolean === true ? 4 : 2;
  if (from.kind !== "ref" && from.kind !== "ref_null") return null;
  if (from.typeIdx === ctx.anyValueTypeIdx) return IDENTITY;
  if (ctx.anyStrTypeIdx >= 0 && from.typeIdx === ctx.anyStrTypeIdx) return 5; // a native string (#42)
  const def = ctx.mod.types[from.typeIdx];
  return def?.kind === "struct" || def?.kind === "array" ? 6 : null;
}

const IDENTITY = -1;

/** WasmGC `eq` abstract heap type, as `registerAnyBoxHelpers` receives it. */
const EQ_HEAP_TYPE = -19;
