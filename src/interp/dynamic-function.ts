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
import {
  createRuntimeEvalGlobalEnvironment,
  isDeletableEvalBindingsMarker,
  prepareEvalEnvironment,
  preparePersistentEvalBindings,
  programIsStrict,
  registerDirectEvalActivationState,
  registerVariableEnvironment,
} from "./eval-environment.js";
import {
  installRuntimeEvalRealm,
  exposeRuntimeEvalSharedValue,
  interpEnter,
  makeInterpClosure,
  makeRuntimeEvalIntrinsic,
  makeRuntimeFunctionIntrinsic,
  registerRuntimeEvalCallerIntrinsic,
  runtimeEvalIntrinsic,
  type InterpCallable,
  type RuntimeDirectEvalHook,
  type RuntimeFunctionHook,
} from "./loop.js";
import { ENV_DECLARATIVE, ENV_OBJECT, EnvRec, type EvalBindingCell, type FuncMeta, type JSValue } from "./types.js";

/** Host-free Acorn entry shape. `source` uses the compiler's native string
 * carrier; both `options` and the result use the shared open-$Object carrier. */
export type DynamicParser = (source: string, options: JSValue) => JSValue;

/** Parse direct-eval source under the caller's strictness. Prefixing a strict
 * directive asks Acorn to apply strict Script early errors; removing that
 * synthetic statement afterwards preserves the source completion value. */
function parseDirectEvalScript(parse: DynamicParser, source: string, callerStrict: boolean): JSValue {
  const options: JSValue = {};
  options.ecmaVersion = 2025;
  options.sourceType = "script";
  if (!callerStrict) return parse(source, options);

  const ast = parse("'use strict';\n" + source, options);
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
  return ast;
}

/** Direct eval originating from bytecode already has a provider-local
 * environment chain, so declarations can attach directly to its live
 * VariableEnvironment without the cross-module caller-cell sidecar used by
 * executeDirectEval. */
function executeInterpretedDirectEval(
  parse: DynamicParser,
  source: JSValue,
  globalObject: JSValue,
  lexicalEnv: EnvRec | null,
  variableEnv: EnvRec | null,
  thisArg: JSValue,
  callerStrict: boolean,
): JSValue {
  if (typeof source !== "string") return source;
  const ast = parseDirectEvalScript(parse, source, callerStrict);
  const strictEval = callerStrict || programIsStrict(ast);
  const globalEnv = createRuntimeEvalGlobalEnvironment(globalObject);
  registerVariableEnvironment(globalEnv, globalEnv);
  const lex = lexicalEnv === null ? globalEnv : lexicalEnv;
  const vars = variableEnv === null ? globalEnv : variableEnv;
  registerRuntimeEvalCallerIntrinsic(lex);
  const env = prepareEvalEnvironment(ast, lex, vars, strictEval);
  const annexBCancelledNames: JSValue[] = [];
  if (!strictEval) {
    let current: EnvRec | null = lex;
    for (;;) {
      if (current === vars || current === null) break;
      if (current.kind !== ENV_OBJECT && current.names !== undefined && current.names !== null) {
        for (let i = 0; i < current.names.length; i += 1) annexBCancelledNames.push(current.names[i]);
      }
      current = current.parent;
    }
  }
  return interpEnter(emitProgram(ast, strictEval, true, annexBCancelledNames), env, thisArg, []);
}

/** Ensure the global object carries the provider-owned realm `%eval%` value.
 * Ordinary/aliased calls invoke indirect eval; the bytecode DirectEval builtin
 * separately invokes the realm's direct hook after checking exact identity. */
function ensureRuntimeEvalRealm(parse: DynamicParser, globalObject: JSValue): void {
  if (runtimeEvalIntrinsic(globalObject) !== undefined) return;
  const intrinsicEval = makeRuntimeEvalIntrinsic(globalObject);
  const intrinsicFunction = makeRuntimeFunctionIntrinsic(globalObject);
  // biome-ignore lint/complexity/useArrowFunction: The standalone self-compiler rejects this multiline typed arrow shape.
  const directEval: RuntimeDirectEvalHook = function (
    source: JSValue,
    lexicalEnv: EnvRec | null,
    variableEnv: EnvRec | null,
    thisArg: JSValue,
    callerStrict: boolean,
  ): JSValue {
    return executeInterpretedDirectEval(parse, source, globalObject, lexicalEnv, variableEnv, thisArg, callerStrict);
  };
  // biome-ignore lint/complexity/useArrowFunction: Keep the parser-injected runtime hook on the self-compiled function-expression path.
  const dynamicFunction: RuntimeFunctionHook = function (args: JSValue[]): JSValue {
    let paramString = "";
    const paramCount = args.length > 0 ? args.length - 1 : 0;
    for (let i = 0; i < paramCount; i += 1) {
      if (i > 0) paramString += ",";
      paramString += String(args[i]);
    }
    const bodyString = args.length === 0 ? "" : String(args[args.length - 1]);
    return createDynamicFunction(parse, paramString, bodyString, globalObject);
  };
  installRuntimeEvalRealm(globalObject, intrinsicEval, directEval, intrinsicFunction, dynamicFunction);
}

/** Restore parallel provider-local names and caller-owned value cells from a
 * pool of alternating name/value cells. A closure's persistent EnvRec retains
 * the flat carrier so later deletions can tombstone its canonical name cells,
 * but the provider never grows that foreign vector. */
export function restoreDirectEvalActivationState(stateCells: JSValue[], names: JSValue[], slots: JSValue[]): void {
  for (let i = 0; i + 1 < stateCells.length; i += 2) {
    const nameCell = stateCells[i] as EvalBindingCell;
    const valueCell = stateCells[i + 1] as EvalBindingCell;
    names.push(nameCell.value);
    slots.push(valueCell);
  }
}

/** Copy provider-local names back into their caller-owned name cells and
 * normalize values written into the shared cells for the caller module. */
export function snapshotDirectEvalActivationState(stateCells: JSValue[], names: JSValue[]): void {
  for (let i = 0; i < names.length; i += 1) {
    const nameCell = stateCells[i * 2] as EvalBindingCell;
    const valueCell = stateCells[i * 2 + 1] as EvalBindingCell;
    nameCell.value = names[i];
    if (!isDeletableEvalBindingsMarker(names[i])) {
      valueCell.value = exposeRuntimeEvalSharedValue(valueCell.value);
    }
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
  ensureRuntimeEvalRealm(parse, globalObject);
  const meta = compileDynamicFunctionMeta(parse, paramString, bodyString);
  const env = createRuntimeEvalGlobalEnvironment(globalObject);
  registerVariableEnvironment(env, env);
  registerRuntimeEvalCallerIntrinsic(env);
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

  ensureRuntimeEvalRealm(parse, globalObject);

  const options: JSValue = {};
  options.ecmaVersion = 2025;
  options.sourceType = "script";
  const ast = parse(source, options);
  const globalEnv = createRuntimeEvalGlobalEnvironment(globalObject);
  registerVariableEnvironment(globalEnv, globalEnv);
  registerRuntimeEvalCallerIntrinsic(globalEnv);
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
  activationState?: JSValue,
): JSValue {
  if (typeof source !== "string") return source;

  ensureRuntimeEvalRealm(parse, globalObject);
  const ast = parseDirectEvalScript(parse, source, callerStrict);
  const strictEval = callerStrict || programIsStrict(ast);
  if (!strictEval) {
    preparePersistentEvalBindings(ast, createdVarNames, createdVarSlots, activationNames, lexicalNames);
  }
  const globalEnv = createRuntimeEvalGlobalEnvironment(globalObject);
  registerVariableEnvironment(globalEnv, globalEnv);
  const outerEnv = new EnvRec(ENV_DECLARATIVE, globalEnv, outerNames, outerSlots, undefined);
  const activationEnv = new EnvRec(ENV_DECLARATIVE, outerEnv, activationNames, activationSlots, mappedParamNames);
  const createdVarEnv = new EnvRec(ENV_DECLARATIVE, activationEnv, createdVarNames, createdVarSlots, undefined);
  registerDirectEvalActivationState(createdVarEnv, activationState);
  const lexicalEnv = new EnvRec(ENV_DECLARATIVE, createdVarEnv, lexicalNames, lexicalSlots, undefined);
  registerRuntimeEvalCallerIntrinsic(lexicalEnv);
  const env = prepareEvalEnvironment(ast, lexicalEnv, createdVarEnv, strictEval, activationEnv);
  // Direct eval reuses the caller's ThisBinding. The AOT free-function ABI
  // represents a bare sloppy call with an absent receiver; perform the
  // ordinary sloppy-this substitution here before entering eval code. A
  // strict caller keeps null/undefined unchanged, and source-level strictness
  // inside eval does not alter the caller's already-established binding.
  let evalThis = thisArg;
  if (!callerStrict && (evalThis === undefined || evalThis === null)) evalThis = globalObject;
  return interpEnter(emitProgram(ast, strictEval, true, lexicalNames), env, evalThis, []);
}
