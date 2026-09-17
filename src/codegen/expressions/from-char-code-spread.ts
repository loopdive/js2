// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Spread-expanding `String.fromCharCode` / `String.fromCodePoint` (#6430).
 *
 * The non-spread family lowering (`compileFromCharCodeFamily`) walks
 * `expr.arguments` and compiles each NODE as one f64 code unit. A
 * `SpreadElement` has no lowering of its own there, so the generic passthrough
 * unwrapped `...codes` to `codes` — an array value — which coerced to `NaN`,
 * went through ToUint16 to `0`, and produced a single NUL character. hono's
 * `src/utils/cookie.ts` signs with
 * `btoa(String.fromCharCode(...new Uint8Array(signature)))`, so every signed
 * cookie came back as `macha.AA%3D%3D` (base64 of one zero byte) and every
 * signed-cookie READ correctly failed verification.
 *
 * This mirrors `compileMathMinMaxSpread` (#2054/#5361): the shared
 * `buildSpreadArgList` evaluates the whole argument list once, left to right,
 * expanding each spread source by its actual REPRESENTATION (tuple struct /
 * native vec / host iterable), and the per-element `post` sink applies the
 * same numeric coercion and 1-char helper call the non-spread fold uses,
 * concatenating into a string accumulator.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { hostStringRepr, nativeStringRepr, type StringRepr } from "../builtin-scaffold.js";
import { emitThrowRangeError } from "../js-errors.js";
import { noJsHost } from "../js-errors.js";
import { addStringImports } from "../registry/imports.js";
import { buildSpreadArgList, hasSpreadArgument } from "../spread-arg-list.js";

/** Options shared with the non-spread family lowering. */
export interface FromCharCodeFamilyOpts {
  native: boolean;
  helperIdx: number;
  isFromCodePoint?: boolean;
}

/** True when this call needs the spread-expanding lowering. */
export function needsFromCharCodeSpread(expr: ts.CallExpression): boolean {
  return hasSpreadArgument(expr.arguments, 0);
}

/**
 * §7.1.8 ToUint16 in the f64 domain, for the native helper's i32 argument:
 * `t = trunc(x); m = t − floor(t / 2^16) · 2^16`. Division by 2^16 is a pure
 * exponent shift, so every step is exact for finite f64s; NaN and ±∞ propagate
 * to a NaN `m`, which `i32.trunc_sat` maps to the spec's +0. A bare
 * `i32.trunc_sat_f64_s` would SATURATE first (+∞ → 0x7FFFFFFF → 0xFFFF after
 * the helper's low-16 mask) — the same reasoning as the non-spread arm.
 */
function toUint16Instrs(fctx: FunctionContext): Instr[] {
  const tmp = allocLocal(fctx, `__fccs_u16_${fctx.locals.length}`, { kind: "f64" });
  return [
    { op: "f64.trunc" },
    { op: "local.tee", index: tmp },
    { op: "local.get", index: tmp },
    { op: "f64.const", value: 65536 },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "f64.const", value: 65536 },
    { op: "f64.mul" },
    { op: "f64.sub" },
    { op: "i32.trunc_sat_f64_s" },
  ];
}

/**
 * §22.1.2.2 steps 2b/2c: each `fromCodePoint` code point, after ToNumber, must
 * be an INTEGRAL Number in [0, 0x10FFFF] or the call throws a RangeError.
 * Scoped to `noJsHost` exactly like the non-spread arm — the JS-host lane lets
 * its `String_fromCodePoint` import do the throwing.
 */
function rangeGuardInstrs(ctx: CodegenContext, fctx: FunctionContext): Instr[] {
  const cpTmp = allocLocal(fctx, `__fccs_cp_${fctx.locals.length}`, { kind: "f64" });
  const throwBuf: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = throwBuf;
  try {
    emitThrowRangeError(ctx, fctx, "RangeError: Invalid code point");
  } finally {
    fctx.body = savedBody;
  }
  return [
    { op: "local.tee", index: cpTmp },
    // integral: trunc(cp) != cp — also true for NaN
    { op: "local.get", index: cpTmp },
    { op: "f64.trunc" },
    { op: "f64.ne" },
    // range: cp < 0
    { op: "local.get", index: cpTmp },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    // range: cp > 0x10FFFF (±∞ caught here)
    { op: "local.get", index: cpTmp },
    { op: "f64.const", value: 0x10ffff },
    { op: "f64.gt" },
    { op: "i32.or" },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: throwBuf },
    { op: "local.get", index: cpTmp },
  ];
}

/**
 * Lower `String.fromCharCode(a, ...src, b)` (and the `fromCodePoint` twin).
 * Returns the result `ValType`, or `null` when no spread substrate could be
 * built — in which case NOTHING has been emitted and the caller keeps its
 * existing path.
 */
export function compileFromCharCodeFamilySpread(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  opts: FromCharCodeFamilyOpts,
): ValType | null {
  const { native, isFromCodePoint } = opts;
  // A spread of N elements concatenates N one-char strings, so the host lane
  // needs `concat` regardless of the SYNTACTIC argument count (the non-spread
  // caller registers it only for `arguments.length > 1`, and a lone
  // `String.fromCharCode(...src)` has exactly one argument node).
  if (!native) addStringImports(ctx);
  const makeRepr = (): StringRepr | undefined => (native ? nativeStringRepr(ctx) : hostStringRepr(ctx));
  const reprAtEntry = makeRepr();
  if (reprAtEntry === undefined) return null;

  // Evaluate the argument list once, left to right. Emits nothing before it
  // can decline, so a `null` return leaves the caller a clean slate.
  const built = buildSpreadArgList(ctx, fctx, expr.arguments, 0, { kind: "f64" }, "fccs");
  if (!built) return null;

  // Re-read every funcidx AFTER the build: compiling an argument may add a late
  // import, which shifts defined-function indices. The per-node fold survives
  // that because its call instructions are already inside `ctx.liveBodies`
  // buffers the shift rewrites; the `post` sink below does not exist yet when
  // the shift happens, so its indices must come from the registries now.
  // (Both fall back to what the caller resolved rather than returning `null`:
  // past this point the argument list is already emitted, so declining would
  // leave the per-node fold a dirty stack.)
  const repr = makeRepr() ?? reprAtEntry;
  const helperIdx =
    (native
      ? ctx.nativeStrHelpers.get(isFromCodePoint === true ? "__str_fromCodePoint" : "__str_fromCharCode")
      : ctx.funcMap.get(isFromCodePoint === true ? "String_fromCodePoint" : "String_fromCharCode")) ?? opts.helperIdx;

  const accLocal = allocLocal(fctx, `__fccs_acc_${fctx.locals.length}`, repr.resultType);
  fctx.body.push(...repr.literal(""));
  fctx.body.push({ op: "local.set", index: accLocal });

  // Per element: [f64 code] → coerce → 1-char string → acc = acc ++ part.
  const emitRangeGuard = isFromCodePoint === true && noJsHost(ctx);
  const post: Instr[] = [];
  if (emitRangeGuard) post.push(...rangeGuardInstrs(ctx, fctx));
  if (native) {
    // The guard already left a validated f64; otherwise apply ToUint16.
    post.push(...(emitRangeGuard ? [{ op: "i32.trunc_sat_f64_s" } as Instr] : toUint16Instrs(fctx)));
  }
  post.push({ op: "call", funcIdx: helperIdx });
  const partTmp = allocLocal(fctx, `__fccs_part_${fctx.locals.length}`, repr.resultType);
  post.push({ op: "local.set", index: partTmp });
  post.push(...repr.concat([{ op: "local.get", index: accLocal }], [{ op: "local.get", index: partTmp }]), {
    op: "local.set",
    index: accLocal,
  });

  built.emitStores({ pre: [], post });
  fctx.body.push({ op: "local.get", index: accLocal });
  return repr.resultType;
}
