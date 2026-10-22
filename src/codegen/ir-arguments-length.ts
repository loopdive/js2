// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 S1e) The host-free lane's `dyn.arguments_length` support: one
 * wrapper, `__ir_arguments_length(formals: i32) -> f64`, whose body is EXACTLY
 * the count half of legacy's arguments-object prologue (`emitArgumentsVecBody`,
 * `statements/nested-declarations.ts`): read `__argc` (the call site's
 * published count; `-1` = unknown caller → the formal count), clear it to
 * `-1` so nested calls never see stale data, consume `__extras_argv` the same
 * way, and return `argc + extras.length` as the JS number `arguments.length`
 * is. Legacy runs this at function ENTRY, before any nested call; the IR
 * emits the instruction at the same point (`lowerFunctionAstToIr`).
 *
 * The wrapper exists so the IR's dynamic-lowering handle stays an opaque
 * `Instr[]`. Built in `preregisterDynamicSupport`, before any Phase-3 body.
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureArgcGlobal, ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import { noJsHost } from "./js-errors.js";

export const IR_ARGUMENTS_LENGTH_HELPER = "__ir_arguments_length";

/**
 * Reserve (once) the wrapper the IR `dyn.arguments_length` lowering calls.
 * Returns the function index, or undefined off the host-free lanes.
 */
export function ensureIrArgumentsLengthHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const existing = ctx.funcMap.get(IR_ARGUMENTS_LENGTH_HELPER);
  if (existing !== undefined) return existing;

  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const helper: FunctionContext = {
    name: IR_ARGUMENTS_LENGTH_HELPER,
    params: [{ name: "formals", type: i32 }],
    locals: [],
    localMap: new Map(),
    returnType: f64,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const argcLocal = allocLocal(helper, "__argc_local", i32);
  const extrasLocal = allocLocal(helper, "__extras_argv_local", { kind: "ref_null", typeIdx: extrasVecTypeIdx });
  const body: Instr[] = [
    // argc = __argc; if (argc == -1) argc = formals;
    { op: "global.get", index: argcGlobalIdx },
    { op: "local.tee", index: argcLocal },
    { op: "i32.const", value: -1 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.set", index: argcLocal },
      ],
      else: [],
    },
    // Clear __argc so nested calls don't see stale data.
    { op: "i32.const", value: -1 },
    { op: "global.set", index: argcGlobalIdx },
    // Consume the extras global: read it and immediately clear.
    { op: "global.get", index: extrasGlobalIdx },
    { op: "local.set", index: extrasLocal },
    { op: "ref.null", typeIdx: extrasVecTypeIdx },
    { op: "global.set", index: extrasGlobalIdx },
    // argc + (extras != null ? extras.length : 0), as f64.
    { op: "local.get", index: argcLocal },
    { op: "local.get", index: extrasLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: extrasLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: extrasVecTypeIdx, fieldIdx: 0 },
      ],
    },
    { op: "i32.add" },
    { op: "f64.convert_i32_s" },
  ];
  helper.body.push(...body);

  const typeIdx = addFuncType(ctx, [i32], [f64]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(IR_ARGUMENTS_LENGTH_HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_ARGUMENTS_LENGTH_HELPER,
    typeIdx,
    locals: helper.locals,
    body: helper.body,
    exported: false,
  });
  return funcIdx;
}

export const IR_PUBLISH_ARGC_HELPER = "__ir_publish_argc";

/**
 * (#7106 S1i) Reserve (once) the caller-side wrapper `dyn.publish_argc` calls:
 * `__ir_publish_argc(count: i32)` sets `__argc = count`, exactly legacy's
 * `emitSetArgc` at an under-arity direct call (`min(actual, formals)` is the
 * actual count there). The callee's entry prologue consumes and clears it.
 * Returns the function index, or undefined off the host-free lanes.
 */
export function ensureIrPublishArgcHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const existing = ctx.funcMap.get(IR_PUBLISH_ARGC_HELPER);
  if (existing !== undefined) return existing;
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const typeIdx = addFuncType(ctx, [{ kind: "i32" }], []);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(IR_PUBLISH_ARGC_HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_PUBLISH_ARGC_HELPER,
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "global.set", index: argcGlobalIdx },
    ],
    exported: false,
  });
  return funcIdx;
}
