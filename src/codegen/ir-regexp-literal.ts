// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 lever R) The host-free lanes' `extern.regex` provider: one wrapper per
 * (pattern, flags), `() -> externref`, whose body is EXACTLY legacy's static
 * RegExp construction (`compileStandaloneStaticRegExp`): a fresh
 * `$NativeRegExp` over the build-time compiled program, or the runtime
 * SyntaxError an invalid `new RegExp(…)` pair throws. Each evaluation of the
 * IR value calls it, so a literal yields a fresh object every time, as
 * §13.2.7.3 requires. No second engine and no host import: matching stays in
 * the in-module engine the carrier helpers call.
 *
 * Built while `attachIrExternSupport` prepares the final IR, before any
 * Phase-3 body, so minting the function is append-safe.
 */

import { irRuntimeFuncRef } from "../ir/callable-bindings.js";
import type { IrFuncRef } from "../ir/nodes.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { compileStandaloneStaticRegExp } from "./regexp-standalone.js";
import { addFuncType } from "./registry/types.js";
import { flushLateImportShifts } from "./shared.js";

const wrappers = new WeakMap<CodegenContext, Map<string, IrFuncRef>>();

/** The wrapper constructing `/pattern/flags`, built once per pair and context. */
export function irRegExpLiteralProvider(ctx: CodegenContext, pattern: string, flags: string): IrFuncRef {
  const byPair = wrappers.get(ctx) ?? new Map<string, IrFuncRef>();
  wrappers.set(ctx, byPair);
  const key = `${flags}/${pattern}`;
  const existing = byPair.get(key);
  if (existing !== undefined) return existing;

  const name = `__ir_regexp_literal_${byPair.size}`;
  const externref: ValType = { kind: "externref" };
  const wrapper: FunctionContext = {
    name,
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: externref,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  compileStandaloneStaticRegExp(ctx, wrapper, pattern, flags, undefined);
  wrapper.body.push({ op: "extern.convert_any" });
  // Late imports the construction registered mid-body shift every baked call index.
  flushLateImportShifts(ctx, wrapper);

  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx: addFuncType(ctx, [], [externref]),
    locals: wrapper.locals,
    body: wrapper.body,
    exported: false,
  });
  const provider = irRuntimeFuncRef(name);
  byPair.set(key, provider);
  return provider;
}
