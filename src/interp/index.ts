// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — public API for the standalone bytecode interpreter library
// (Tier 2 of the eval ladder; doc §16 slice E1). This module is deliberately
// **import-clean**: it pulls in nothing from the compiler (`src/codegen`,
// `src/ir`, `typescript`, …) and — per the "two producers, one consumer" design
// (doc §12.1) — it does NOT parse. The core consumes an already-parsed **ESTree**
// (node-acorn in E1's tests, compiled-acorn `$Object`s in E2). Parsing lives in
// the caller. That keeps the self-compile surface E2 inherits minimal.

import { emitProgram } from "./emitter.js";
import { createRuntimeEvalGlobalEnvironment, prepareEvalEnvironment, programIsStrict } from "./eval-environment.js";
import { interpEnter } from "./loop.js";
import { EnvRec, type FuncMeta, type JSValue } from "./types.js";

export { Op, Builtin, OP_INFO, OP_COUNT } from "./opcodes.js";
export { Encoder } from "./encoder.js";
export { emitFunction, emitProgram, UnsupportedNodeError } from "./emitter.js";
export { disassemble, decodeInstr } from "./disasm.js";
export { interpEnter, makeInterpClosure, isInterpClosure, InterpInternalError, type InterpCallable } from "./loop.js";
export {
  compileDynamicFunctionMeta,
  createDynamicFunction,
  dynamicFunctionSource,
  executeIndirectEval,
  type DynamicParser,
} from "./dynamic-function.js";
export { FuncMeta, Frame, EnvRec, type JSValue } from "./types.js";

/** Build a global environment record whose backing is `globalObject`. */
export function createGlobalEnv(globalObject: JSValue): EnvRec {
  return createRuntimeEvalGlobalEnvironment(globalObject);
}

/** Options for {@link runScript}. */
export interface RunScriptOptions {
  /** The global object (globalThis) free identifiers resolve against and the
   *  script's `this`. Defaults to a fresh `Object.create(globalThis)` so real
   *  globals (Math, Object, …) resolve through the prototype while declarations
   *  stay isolated from the real global (E1 test hygiene). */
  globalObject?: JSValue;
}

/**
 * Compile a parsed ESTree `Program` to bytecode and run it to completion,
 * returning the script's completion value (the last value-producing statement —
 * `eval("1+2;3+4")` is 7; `eval("var x=5")` is undefined). Indirect-eval /
 * `new Function` global-scope semantics (§20.2.1.1 / §19.2.1): no caller-scope
 * capture. Throws propagate as raw JS exceptions across the boundary.
 */
export function runScript(ast: JSValue, options: RunScriptOptions = {}): JSValue {
  const globalObject = options.globalObject !== undefined ? options.globalObject : Object.create(globalThis);
  const strictScript = programIsStrict(ast);
  const globalEnv = createGlobalEnv(globalObject);
  const env = prepareEvalEnvironment(ast, globalEnv, globalEnv, strictScript);
  const meta: FuncMeta = emitProgram(ast, strictScript, true);
  // Script `this` is the global object (indirect-eval semantics).
  return interpEnter(meta, env, globalObject, []);
}

/** Compile a parsed ESTree `Program` to its top-level {@link FuncMeta} (no run).
 *  Handy for disassembly/inspection in tests. */
export function compileScript(ast: JSValue): FuncMeta {
  return emitProgram(ast);
}
