// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2928 E2 — parser-injected standalone Function-constructor factory.
//
// Parsing remains owned by #2927/Acorn and packaging by E6/#2527. This file is
// the interpreter-owned boundary between them: it accepts Acorn's native-string
// `parse(source, options) -> ESTree $Object` entry, emits a FuncMeta, roots the
// function at the module global environment, and materializes an ordinary
// callable through the interpreter's existing closure seam.

import { emitFunction, emitProgram } from "./emitter.js";
import { interpEnter, makeInterpClosure, type InterpCallable } from "./loop.js";
import { ENV_GLOBAL, EnvRec, type FuncMeta, type JSValue } from "./types.js";

/** Host-free Acorn entry shape. `source` uses the compiler's native string
 * carrier; both `options` and the result use the shared open-$Object carrier. */
export type DynamicParser = (source: string, options: JSValue) => JSValue;

/** Build the source text parsed by the Function constructor.
 *
 * The newlines are intentional: they keep a trailing line comment in the
 * parameter or body text from swallowing the wrapper delimiter. Parameter and
 * body strings have already undergone ToString and comma-flattening at the
 * call-site routing layer.
 */
export function dynamicFunctionSource(paramString: string, bodyString: string): string {
  return "function anonymous(" + paramString + "\n) {\n" + bodyString + "\n}";
}

/** Parse and emit a Function-constructor body without materializing a value. */
export function compileDynamicFunctionMeta(parse: DynamicParser, paramString: string, bodyString: string): FuncMeta {
  const options: JSValue = {};
  options.ecmaVersion = 2025;
  options.sourceType = "script";

  const ast: JSValue = parse(dynamicFunctionSource(paramString, bodyString), options);
  const body: JSValue = ast.body;
  const declaration: JSValue = body[0];
  if (declaration === undefined || declaration.type !== "FunctionDeclaration") {
    throw new SyntaxError("runtime parser did not return a FunctionDeclaration");
  }
  return emitFunction(declaration);
}

/** Construct a global-scope interpreted function from dynamic parameter/body
 * strings. Parse and early errors propagate at construction time; invocation
 * enters the interpreter through the ordinary closure call protocol. */
export function createDynamicFunction(
  parse: DynamicParser,
  paramString: string,
  bodyString: string,
  globalObject: JSValue,
): InterpCallable {
  const meta = compileDynamicFunctionMeta(parse, paramString, bodyString);
  const env = new EnvRec(ENV_GLOBAL, null, null, null, globalObject);
  return makeInterpClosure(meta, env);
}

/** Execute indirect eval in the global environment.
 *
 * ECMA-262 eval returns a non-string argument unchanged. String input is parsed
 * as Script and entered through the same global EnvRec used by dynamic
 * Function, so it cannot capture caller locals.
 */
export function executeIndirectEval(parse: DynamicParser, source: JSValue, globalObject: JSValue): JSValue {
  if (typeof source !== "string") return source;

  const options: JSValue = {};
  options.ecmaVersion = 2025;
  options.sourceType = "script";
  const ast = parse(source, options);
  const env = new EnvRec(ENV_GLOBAL, null, null, null, globalObject);
  return interpEnter(emitProgram(ast), env, globalObject, []);
}
