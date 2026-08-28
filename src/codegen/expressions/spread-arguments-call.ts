// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5093) Spread call into a callee that HAS formals and reads `arguments`.
 *
 * `compileSpreadCallArgs` binds formals by a STATIC accounting of argument
 * positions: each spread is assumed to cover exactly the parameter slots left
 * over after the trailing positional args are reserved (#2053). That is enough
 * to fill parameter slots, but it cannot answer the two questions the
 * `arguments` object needs:
 *
 *   - how many call-site arguments there were (`arguments.length`), which is a
 *     RUNTIME sum once any spread source has a runtime length, and
 *   - which flattened elements are left over after the formals are bound
 *     (`__extras_argv`), whose split point is equally dynamic.
 *
 * So the zero-formal arm routes everything through `__extras_argv` (#1053,
 * #2202) while this arm routed nothing — a formal-ful callee saw
 * `arguments.length === <formal count>` and no spread element at all.
 *
 * The model here is the spec one: flatten first, then bind. `emitSetExtrasArgv`
 * already materialises the fully flattened argument list with a runtime length
 * (evaluating every argument exactly once), so this helper reuses it for the
 * WHOLE list, then splits the result:
 *
 *   formals   := flat[0 .. formalCount)      (missing slots get their default)
 *   extras    := flat[formalCount .. total)  (a fresh vec in `__extras_argv`)
 *   __argc    := min(total, formalCount)
 *
 * `arguments` in the callee is `formals[0 .. argc) ++ extras`
 * (`emitArgumentsVecTail`), so that split reconstructs the exact call-site list
 * for every shape, including a spread whose length is only known at runtime.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import { popBody, pushBody } from "../context/bodies.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "../context/types.js";
import { getArrTypeIdxFromVec } from "../index.js";
import { noJsHost } from "../js-errors.js";
import { coerceType } from "../shared.js";
import { pushDefaultValue, pushParamSentinel } from "../type-coercion.js";
import { emitSetExtrasArgv, ensureArgcGlobal, ensureExtrasArgvGlobal } from "../statements/nested-declarations.js";
import { getFuncParamTypes } from "./helpers.js";

/**
 * Fields of a TUPLE struct (`_0`, `_1`, …) — how an inline array literal with
 * statically-known elements lowers in a value context. It is NOT a `__vec_`,
 * so the vec readers do not apply; each element is a `struct.get fieldIdx`.
 * Returns null for any other carrier.
 */
export function tupleStructFields(
  ctx: CodegenContext,
  typeIdx: number,
): { readonly name?: string; readonly type: ValType }[] | null {
  const def = ctx.mod.types[typeIdx];
  if (!def || def.kind !== "struct") return null;
  const fields = def.fields as { readonly name?: string; readonly type: ValType }[];
  if (fields.length === 0) return null;
  return fields.every((f, idx) => f.name === `_${idx}`) ? fields : null;
}

/** Emit `instrs` into a detached body so they can be used as a branch arm. */
function collect(fctx: FunctionContext, emit: () => void): Instr[] {
  const saved = pushBody(fctx);
  emit();
  const collected = fctx.body;
  popBody(fctx, saved);
  return collected;
}

/**
 * Bind the formals of a spread call from the flattened argument list and hand
 * the leftovers to the callee's `arguments` object.
 *
 * Every precondition is checked BEFORE anything is emitted, so a `false` return
 * leaves `fctx.body` untouched and the caller can fall back to
 * `compileSpreadCallArgs`. On `true` the caller must NOT also emit padding or
 * `maybeSetArgcForKnownCall` — both are done here.
 *
 * @param paramOffset leading Wasm params that are not user-visible formals
 *                    (the `self` receiver of a method, or lifted captures).
 *                    Those operands are already on the stack.
 */
export function compileSpreadCallArgsWithArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcIdx: number,
  paramOffset: number,
  funcName: string,
): boolean {
  const args = expr.arguments as readonly ts.Expression[];
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  const optInfo: readonly OptionalParamInfo[] | undefined = ctx.funcOptionalParams.get(funcName);
  if (!paramTypes) return false;
  const formalCount = paramTypes.length - paramOffset;
  if (formalCount <= 0) return false;
  if (!args.some((a) => ts.isSpreadElement(a))) return false;
  // WASI without the standalone object runtime has neither the host readers nor
  // the native materializer, so `emitSetExtrasArgv` degrades to a static path
  // that does NOT flatten spreads. Binding formals off that list would be worse
  // than the status quo; leave those targets on the existing lowering.
  if (noJsHost(ctx) && !ctx.standalone) return false;

  const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);
  if (arrTypeIdx < 0) return false;
  const argcGlobalIdx = ensureArgcGlobal(ctx);

  // ── 1. Flatten the WHOLE argument list into `__extras_argv` (runtime length).
  emitSetExtrasArgv(ctx, fctx, args as ts.Expression[], 0);

  // ── 2. Take it out of the global into locals; `total` is 0 for a null vec.
  const flatType: ValType = { kind: "ref_null", typeIdx: extrasVecTypeIdx };
  const flatLocal = allocLocal(fctx, `__sa_flat_${fctx.locals.length}`, flatType);
  fctx.body.push({ op: "global.get", index: extrasGlobalIdx });
  fctx.body.push({ op: "local.set", index: flatLocal });
  const totalLocal = allocLocal(fctx, `__sa_total_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 0 }],
    else: [
      { op: "local.get", index: flatLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: extrasVecTypeIdx, fieldIdx: 0 },
    ],
  });
  fctx.body.push({ op: "local.set", index: totalLocal });

  // ── 3. Bind the formals: flat[i] when it exists, the ordinary default when
  // the call was short. Reading through the flattened list is what makes a
  // spread whose length is only known at runtime bind by POSITION.
  for (let i = 0; i < formalCount; i++) {
    const paramType = paramTypes[i + paramOffset]!;
    const present = collect(fctx, () => {
      fctx.body.push({ op: "local.get", index: flatLocal });
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "struct.get", typeIdx: extrasVecTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
      if (paramType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, paramType);
    });
    const opt = optInfo?.find((candidate) => candidate.index === i);
    const missing = collect(fctx, () => {
      if (opt) pushParamSentinel(fctx, paramType, ctx, opt);
      else pushDefaultValue(fctx, paramType, ctx);
    });
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "local.get", index: totalLocal });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({ op: "if", blockType: { kind: "val", type: paramType }, then: present, else: missing });
  }

  // ── 4. Republish the leftovers as the extras vec. `array.copy` traps on an
  // out-of-range source offset, so a short call (total <= formalCount) gets a
  // freshly allocated empty array instead.
  const extrasLenLocal = allocLocal(fctx, `__sa_xlen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: totalLocal });
  fctx.body.push({ op: "i32.const", value: formalCount });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.tee", index: extrasLenLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 0 },
      { op: "local.set", index: extrasLenLocal },
    ],
    else: [],
  });
  const extrasArrLocal = allocLocal(fctx, `__sa_xarr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: extrasLenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: extrasArrLocal });
  fctx.body.push({ op: "local.get", index: extrasLenLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: extrasArrLocal },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: flatLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: extrasVecTypeIdx, fieldIdx: 1 },
      { op: "i32.const", value: formalCount },
      { op: "local.get", index: extrasLenLocal },
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
    ],
    else: [],
  });
  fctx.body.push({ op: "local.get", index: extrasLenLocal });
  fctx.body.push({ op: "local.get", index: extrasArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: extrasVecTypeIdx });
  fctx.body.push({ op: "global.set", index: extrasGlobalIdx });

  // ── 5. `__argc` is the number of formal slots the call actually filled.
  fctx.body.push({ op: "local.get", index: totalLocal });
  fctx.body.push({ op: "i32.const", value: formalCount });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: totalLocal }],
    else: [{ op: "i32.const", value: formalCount }],
  });
  fctx.body.push({ op: "global.set", index: argcGlobalIdx });
  return true;
}
