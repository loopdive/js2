// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4555) §10.6 step 14 — the STRICT arguments object's poisoned `callee`,
 * as a real accessor property, for `--target standalone`.
 *
 * #4243 gave the SLOPPY arguments object a real own `callee` data property
 * (`arguments-callee.ts`); its own header records that the strict half was left
 * on the table because "minting that [%ThrowTypeError%] needs a callable
 * throwing function value, which this module does not build". That is what this
 * module builds. The syntactic half (`arguments-callee-poison.ts`) already
 * makes a DIRECT `arguments.callee` read inside a strict function throw, but it
 * cannot answer a descriptor query, `hasOwnProperty`, or a write through an
 * arguments object that has escaped its function:
 *
 *     var argObj = function () { return arguments; }();   // strict
 *     Object.getOwnPropertyDescriptor(argObj, "callee")   // was undefined
 *     argObj.hasOwnProperty("callee")                     // was false
 *     argObj.callee = {}                                  // did not throw
 *
 * §10.6 step 14 specifies `{ get: %ThrowTypeError%, set: %ThrowTypeError%,
 * enumerable: false, configurable: false }`, which is exactly what is defined
 * here through the same native `__defineProperty_accessor` that a source-level
 * `Object.defineProperty(o, k, {get, set, …})` already lowers to on this lane —
 * so the descriptor shape, the non-enumerability and the throwing write all come
 * out by construction rather than needing arms of their own.
 *
 * The poison function is ONE module-level singleton shared by both halves of
 * the accessor and by every arguments object in the module, matching the spec's
 * single %ThrowTypeError% intrinsic. It takes one externref parameter so it can
 * serve the `[[Set]]` call shape; the `[[Get]]` call supplies fewer arguments
 * and the closure call path pads, which is immaterial to a body that only
 * throws.
 *
 * Gated on `noJsHost(ctx)`. The gc/host lane registers its arguments vecs with
 * the `__register_arguments` host import (#2743) and resolves `callee` there.
 */
import type { Instr, ValType } from "../ir/types.js";
import { emitCachedFuncClosureExternref } from "./closures/method-trampolines.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

const POISON_FUNC_NAME = "__args_callee_poison";

/**
 * §10.6 step 14 attributes in the host flag encoding `__defineProperty_accessor`
 * decodes: enumerable and configurable both SPECIFIED (bits 4/5) and both FALSE
 * (bits 1/2 clear), with the standalone applier's `[[Get]]`/`[[Set]]`
 * "specified" bits (8/9) set so the define replaces both halves rather than
 * merging (#2992 S3).
 */
const POISON_FLAGS = (1 << 4) | (1 << 5) | (1 << 8) | (1 << 9);

/** Mint (once) the module's %ThrowTypeError% function; `undefined` if unavailable. */
function ensureThrowTypeErrorFunc(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(POISON_FUNC_NAME);
  if (existing !== undefined) return existing;
  const params: ValType[] = [{ kind: "externref" }];
  const results: ValType[] = [{ kind: "externref" }];
  const typeIdx = addFuncType(ctx, params, results, `$${POISON_FUNC_NAME}_type`);
  const body: Instr[] = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions",
  );
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name: POISON_FUNC_NAME, typeIdx, locals: [], body, exported: false });
  ctx.funcMap.set(POISON_FUNC_NAME, funcIdx);
  return funcIdx;
}

/**
 * Install the §10.6 step 14 poison accessor on the just-built strict arguments
 * vec held in `argsLocalIdx`. A no-op off the host-free lane, or when any piece
 * of the machinery is unavailable — in which case the arguments object simply
 * keeps its pre-#4555 shape (a miss, never a wrong answer).
 */
export function seedStrictArgumentsCalleePoison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argsLocalIdx: number,
): void {
  if (!noJsHost(ctx)) return;
  ensureObjectRuntime(ctx);
  const poisonIdx = ensureThrowTypeErrorFunc(ctx);
  if (poisonIdx === undefined) return;

  // The closure access and the late import can both shift function indices, so
  // settle them BEFORE anything is pushed onto the live body — the same
  // discipline `seedArgumentsCallee` uses for its callee thunk.
  const savedBody = fctx.body;
  const poisonValue: Instr[] = [];
  fctx.body = poisonValue;
  ctx.liveBodies.add(savedBody);
  let ok = false;
  try {
    ok = emitCachedFuncClosureExternref(ctx, fctx, POISON_FUNC_NAME, poisonIdx, false);
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  if (!ok) return;

  const defineIdx = ensureLateImport(
    ctx,
    "__defineProperty_accessor",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (defineIdx === undefined) return;

  addStringConstantGlobal(ctx, "callee");
  fctx.body.push({ op: "local.get", index: argsLocalIdx });
  fctx.body.push({ op: "extern.convert_any" });
  for (const instr of stringConstantExternrefInstrs(ctx, "callee")) fctx.body.push(instr);
  // Both halves read the SAME lazy cache global, so `desc.get === desc.set`
  // holds exactly as the single %ThrowTypeError% intrinsic requires.
  for (const instr of poisonValue) fctx.body.push({ ...instr });
  for (const instr of poisonValue) fctx.body.push({ ...instr });
  fctx.body.push({ op: "f64.const", value: POISON_FLAGS });
  fctx.body.push({ op: "call", funcIdx: defineIdx });
  fctx.body.push({ op: "drop" });
}
