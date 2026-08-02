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
import { prepareEvalEnvironment, preparePersistentEvalBindings, programIsStrict } from "./eval-environment.js";
import { interpEnter, makeInterpClosure, type InterpCallable } from "./loop.js";
import { ENV_DECLARATIVE, ENV_GLOBAL, EnvRec, type EvalBindingCell, type FuncMeta, type JSValue } from "./types.js";

/** Host-free Acorn entry shape. `source` uses the compiler's native string
 * carrier; both `options` and the result use the shared open-$Object carrier. */
export type DynamicParser = (source: string, options: JSValue) => JSValue;

/** Restore parallel provider-local names and caller-owned value cells from a
 * pool of alternating name/value cells. The provider never retains or grows a
 * foreign vector; all mutable values stay in canonical AOT-owned cells. */
export function restoreDirectEvalActivationState(stateCells: JSValue[], names: JSValue[], slots: JSValue[]): void {
  for (let i = 0; i + 1 < stateCells.length; i += 2) {
    const nameCell = stateCells[i] as EvalBindingCell;
    const valueCell = stateCells[i + 1] as EvalBindingCell;
    names.push(nameCell.value);
    slots.push(valueCell);
  }
}

/** Copy provider-local names back into their caller-owned name cells. Value
 * cells were shared with the interpreter and already contain live mutations. */
export function snapshotDirectEvalActivationState(stateCells: JSValue[], names: JSValue[]): void {
  for (let i = 0; i < names.length; i += 1) {
    const nameCell = stateCells[i * 2] as EvalBindingCell;
    nameCell.value = names[i];
  }
}

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
  const globalEnv = new EnvRec(ENV_GLOBAL, null, null, null, globalObject);
  const strictEval = programIsStrict(ast);
  const env = prepareEvalEnvironment(ast, globalEnv, globalEnv, strictEval);
  return interpEnter(emitProgram(ast, strictEval, true), env, globalObject, []);
}

/** Execute direct eval against live caller binding cells.
 *
 * Each names/slots pair is parallel and every slot is an `EvalBindingCell`.
 * The activation vectors are reused across calls in one AOT invocation, so a
 * sloppy eval-created `var` persists. Fresh lexical cells precede that record;
 * captured outer cells follow it. This prevents a new current-function var from
 * mutating an identically named outer capture while retaining direct aliasing.
 */
export function executeDirectEval(
  parse: DynamicParser,
  source: JSValue,
  globalObject: JSValue,
  thisArg: JSValue,
  createdVarNames: JSValue[],
  createdVarSlots: JSValue[],
  activationNames: JSValue,
  activationSlots: JSValue[],
  lexicalNames: JSValue,
  lexicalSlots: JSValue[],
  outerNames: JSValue,
  outerSlots: JSValue[],
  callerStrict: boolean,
  mappedParamNames: JSValue,
): JSValue {
  if (typeof source !== "string") return source;

  const options: JSValue = {};
  options.ecmaVersion = 2025;
  options.sourceType = "script";
  let ast: JSValue;
  if (callerStrict) {
    ast = parse("'use strict';\n" + source, options);
    const originalBody: JSValue[] = [];
    const parsedBody: JSValue = ast.body;
    let bodyStart = 0;
    if (
      parsedBody.length > 0 &&
      parsedBody[0].type === "ExpressionStatement" &&
      parsedBody[0].expression.type === "Literal" &&
      parsedBody[0].expression.value === "use strict"
    ) {
      bodyStart = 1;
    }
    for (let i = bodyStart; i < parsedBody.length; i += 1) originalBody.push(parsedBody[i]);
    ast.body = originalBody;
  } else {
    ast = parse(source, options);
  }
  const strictEval = callerStrict || programIsStrict(ast);
  if (!strictEval) {
    preparePersistentEvalBindings(ast, createdVarNames, createdVarSlots, activationNames);
  }
  const globalEnv = new EnvRec(ENV_GLOBAL, null, null, null, globalObject);
  const outerEnv = new EnvRec(ENV_DECLARATIVE, globalEnv, outerNames, outerSlots, undefined);
  const activationEnv = new EnvRec(ENV_DECLARATIVE, outerEnv, activationNames, activationSlots, mappedParamNames);
  const createdVarEnv = new EnvRec(ENV_DECLARATIVE, activationEnv, createdVarNames, createdVarSlots, undefined);
  const lexicalEnv = new EnvRec(ENV_DECLARATIVE, createdVarEnv, lexicalNames, lexicalSlots, undefined);
  const env = prepareEvalEnvironment(ast, lexicalEnv, createdVarEnv, strictEval, activationEnv);
  return interpEnter(emitProgram(ast, strictEval, true), env, thisArg, []);
}
