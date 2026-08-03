// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Eval declaration instantiation and private lexical environments (#2929).

import {
  ENV_DECLARATIVE,
  ENV_GLOBAL,
  ENV_OBJECT,
  EnvRec,
  RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY,
  type EvalBindingCell,
  type JSValue,
  type Regs,
} from "./types.js";

type Node = any;

/**
 * The lexical environment at the top of a frame is not necessarily that
 * frame's VariableEnvironment: a `with`, block, catch, or eval lexical record
 * may sit above it.  `$Frame` is a frozen cross-feature ABI, so keep this
 * association out-of-line instead of adding another struct field.  Every
 * environment constructor below propagates the association to its child.
 */
const VARIABLE_ENVIRONMENTS: WeakMap<object, EnvRec> = new WeakMap();

/** Rehydrate the declarative half of a GlobalEnvironmentRecord from the
 * caller-owned canonical cells stored on the shared realm object. The carrier
 * is alternating name/cell so no EnvRec layout or provider export changes. */
export function createRuntimeEvalGlobalEnvironment(globalObject: JSValue): EnvRec {
  const names: JSValue[] = [];
  const slots: Regs = [];
  const carrier: JSValue = globalObject[RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY];
  if (carrier !== undefined && carrier !== null) {
    for (let i = 0; i + 1 < carrier.length; i += 2) {
      names.push(carrier[i]);
      slots.push(carrier[i + 1] as EvalBindingCell);
    }
  }
  return new EnvRec(ENV_GLOBAL, null, names, slots, globalObject);
}

/** Associate an environment-chain head with the VariableEnvironment used by
 * direct eval originating from that chain. */
export function registerVariableEnvironment(env: EnvRec | null, variableEnv: EnvRec | null): void {
  if (env === null || variableEnv === null) return;
  VARIABLE_ENVIRONMENTS.set(env as object, variableEnv);
}

/** Resolve the VariableEnvironment for a lexical chain without changing the
 * frozen `$Frame` / `$EnvRec` layouts.  The parent walk is a defensive fallback
 * for environments created before their child association was installed. */
export function variableEnvironmentFor(env: EnvRec | null): EnvRec | null {
  let current = env;
  for (;;) {
    if (current === null) return null;
    const variableEnv = VARIABLE_ENVIRONMENTS.get(current as object);
    if (variableEnv !== undefined) return variableEnv;
    current = current.parent;
  }
}

/** Unique value held by an eval lexical binding before its declaration runs. */
export const EVAL_TDZ: JSValue = {};

export class EvalDeclarationPlan {
  varNames: string[];
  functionNames: string[];
  lexicalNames: string[];
  blockFunctionNames: string[];

  constructor() {
    this.varNames = [];
    this.functionNames = [];
    this.lexicalNames = [];
    this.blockFunctionNames = [];
  }
}

function appendUnique(names: string[], name: string): void {
  for (const existing of names) {
    if (existing === name) return;
  }
  names.push(name);
}

function planHasLexicalName(plan: EvalDeclarationPlan, name: string): boolean {
  for (const lexicalName of plan.lexicalNames) {
    if (lexicalName === name) return true;
  }
  return false;
}

function collectPatternName(pattern: Node, target: string[]): void {
  if (pattern.type === "Identifier") appendUnique(target, pattern.name);
}

/** Collect only declarations that are var-scoped through a nested statement.
 * Lexical declarations belong to the nested block/loop/switch environment and
 * must not be installed in the eval body's top-level lexical environment. */
function collectNestedVarDeclarations(statement: Node, plan: EvalDeclarationPlan, lexicalAncestors: string[]): void {
  if (statement.type === "VariableDeclaration") {
    if (statement.kind === "var") {
      for (const declaration of statement.declarations) collectPatternName(declaration.id, plan.varNames);
    }
    return;
  }
  // A nested function is block-scoped. In sloppy eval Annex B additionally
  // synthesizes an outer var only when no root/ancestor lexical conflicts.
  if (statement.type === "FunctionDeclaration") {
    if (statement.id) {
      let conflict = planHasLexicalName(plan, statement.id.name);
      for (const name of lexicalAncestors) {
        if (name === statement.id.name) conflict = true;
      }
      if (!conflict) appendUnique(plan.blockFunctionNames, statement.id.name);
    }
    return;
  }
  if (statement.type === "ClassDeclaration") return;
  if (statement.type === "BlockStatement") {
    const nestedLexicals: string[] = [];
    for (const name of lexicalAncestors) nestedLexicals.push(name);
    for (const nested of statement.body) {
      if (nested.type === "VariableDeclaration" && nested.kind !== "var") {
        for (const declaration of nested.declarations) {
          if (declaration.id.type === "Identifier") nestedLexicals.push(declaration.id.name);
        }
      } else if (nested.type === "ClassDeclaration" && nested.id) {
        nestedLexicals.push(nested.id.name);
      }
    }
    for (const nested of statement.body) collectNestedVarDeclarations(nested, plan, nestedLexicals);
    return;
  }
  if (statement.type === "IfStatement") {
    collectNestedVarDeclarations(statement.consequent, plan, lexicalAncestors);
    if (statement.alternate) collectNestedVarDeclarations(statement.alternate, plan, lexicalAncestors);
    return;
  }
  if (
    statement.type === "WhileStatement" ||
    statement.type === "DoWhileStatement" ||
    statement.type === "LabeledStatement" ||
    statement.type === "WithStatement"
  ) {
    collectNestedVarDeclarations(statement.body, plan, lexicalAncestors);
    return;
  }
  if (statement.type === "ForStatement") {
    const loopLexicals: string[] = [];
    for (const name of lexicalAncestors) loopLexicals.push(name);
    if (statement.init && statement.init.type === "VariableDeclaration") {
      if (statement.init.kind === "var") {
        collectNestedVarDeclarations(statement.init, plan, lexicalAncestors);
      } else {
        for (const declaration of statement.init.declarations) {
          if (declaration.id.type === "Identifier") loopLexicals.push(declaration.id.name);
        }
      }
    }
    collectNestedVarDeclarations(statement.body, plan, loopLexicals);
    return;
  }
  if (statement.type === "ForInStatement" || statement.type === "ForOfStatement") {
    const loopLexicals: string[] = [];
    for (const name of lexicalAncestors) loopLexicals.push(name);
    if (statement.left && statement.left.type === "VariableDeclaration") {
      if (statement.left.kind === "var") {
        collectNestedVarDeclarations(statement.left, plan, lexicalAncestors);
      } else {
        for (const declaration of statement.left.declarations) {
          if (declaration.id.type === "Identifier") loopLexicals.push(declaration.id.name);
        }
      }
    }
    collectNestedVarDeclarations(statement.body, plan, loopLexicals);
    return;
  }
  if (statement.type === "TryStatement") {
    collectNestedVarDeclarations(statement.block, plan, lexicalAncestors);
    if (statement.handler) collectNestedVarDeclarations(statement.handler.body, plan, lexicalAncestors);
    if (statement.finalizer) collectNestedVarDeclarations(statement.finalizer, plan, lexicalAncestors);
    return;
  }
  if (statement.type === "SwitchStatement") {
    const switchLexicals: string[] = [];
    for (const name of lexicalAncestors) switchLexicals.push(name);
    for (const switchCase of statement.cases) {
      for (const consequent of switchCase.consequent) {
        if (consequent.type === "VariableDeclaration" && consequent.kind !== "var") {
          for (const declaration of consequent.declarations) {
            if (declaration.id.type === "Identifier") switchLexicals.push(declaration.id.name);
          }
        } else if (consequent.type === "ClassDeclaration" && consequent.id) {
          switchLexicals.push(consequent.id.name);
        }
      }
    }
    for (const switchCase of statement.cases) {
      for (const consequent of switchCase.consequent) {
        collectNestedVarDeclarations(consequent, plan, switchLexicals);
      }
    }
  }
}

/** Collect the declarations that PerformEval instantiates before execution. */
export function collectEvalDeclarations(program: Node): EvalDeclarationPlan {
  const plan = new EvalDeclarationPlan();
  // Root lexical names must be complete before checking any nested Annex B
  // function, including one textually preceding the conflicting declaration.
  for (const statement of program.body) {
    if (statement.type === "VariableDeclaration") {
      const target = statement.kind === "var" ? plan.varNames : plan.lexicalNames;
      for (const declaration of statement.declarations) collectPatternName(declaration.id, target);
    } else if (statement.type === "FunctionDeclaration") {
      if (statement.id) {
        appendUnique(plan.varNames, statement.id.name);
        // EvalDeclarationInstantiation keeps only the last declaration for a
        // duplicate function name. `appendUnique` plus this replacement gives
        // the emitter and the global preflight one canonical name without
        // manufacturing a property for an earlier declaration.
        let existing = -1;
        for (let i = 0; i < plan.functionNames.length; i += 1) {
          if (plan.functionNames[i] === statement.id.name) existing = i;
        }
        if (existing >= 0) plan.functionNames.splice(existing, 1);
        plan.functionNames.push(statement.id.name);
      }
    } else if (statement.type === "ClassDeclaration") {
      if (statement.id) appendUnique(plan.lexicalNames, statement.id.name);
    }
  }
  for (const statement of program.body) {
    if (
      statement.type !== "VariableDeclaration" &&
      statement.type !== "FunctionDeclaration" &&
      statement.type !== "ClassDeclaration"
    ) {
      collectNestedVarDeclarations(statement, plan, []);
    }
  }
  return plan;
}

/** Materialize sloppy direct-eval vars in raw arrays before those arrays cross
 * the generic EnvRec field. The standalone carrier does not preserve a later
 * vector growth through that field, while writes to pre-existing cells remain
 * canonical across the provider boundary. */
export function preparePersistentEvalBindings(
  program: Node,
  names: JSValue[],
  slots: Regs,
  existingNames: JSValue,
): void {
  const plan = collectEvalDeclarations(program);
  const persistentNames: string[] = [];
  for (const name of plan.varNames) appendUnique(persistentNames, name);
  for (const name of plan.blockFunctionNames) {
    if (!planHasLexicalName(plan, name)) appendUnique(persistentNames, name);
  }
  for (const name of persistentNames) {
    let exists = false;
    for (let i = 0; i < existingNames.length; i += 1) {
      if (existingNames[i] === name) {
        exists = true;
        break;
      }
    }
    if (exists) continue;
    for (let i = 0; i < names.length; i += 1) {
      if (names[i] === name) {
        exists = true;
        break;
      }
    }
    if (exists) continue;
    let vacancy = -1;
    for (let i = 0; i < names.length; i += 1) {
      if (names[i] === undefined || names[i] === null) {
        vacancy = i;
        break;
      }
    }
    if (vacancy >= 0) {
      names[vacancy] = name;
      (slots[vacancy] as EvalBindingCell).value = undefined;
    } else {
      if (names.length >= 64) throw "direct eval activation binding capacity exceeded";
      names.push(name);
      const cell: EvalBindingCell = { value: undefined };
      slots.push(cell);
    }
  }
}

/** Directive-prologue strictness for an ESTree Program. */
export function programIsStrict(program: Node): boolean {
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement" || statement.expression.type !== "Literal") return false;
    if (statement.expression.value === "use strict") return true;
    if (typeof statement.expression.value !== "string") return false;
  }
  return false;
}

function declarativeHasOwnBinding(env: EnvRec, name: string): boolean {
  if (env.names === undefined || env.names === null || env.slots === null) return false;
  const names = env.names as JSValue[];
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] === name) return true;
  }
  return false;
}

function addDeclarativeBinding(env: EnvRec, name: string, value: JSValue): void {
  const names = env.names as JSValue[];
  const slots = env.slots as Regs;
  const cell: EvalBindingCell = { value };
  names.push(name);
  slots.push(cell);
}

function declarativeWithBindings(parent: EnvRec | null, bindingNames: JSValue, initialValue: JSValue): EnvRec {
  const names: JSValue[] = [];
  const slots: Regs = [];
  for (let i = 0; i < bindingNames.length; i += 1) {
    names.push(bindingNames[i]);
    const cell: EvalBindingCell = { value: initialValue };
    slots.push(cell);
  }
  return new EnvRec(ENV_DECLARATIVE, parent, names, slots, undefined);
}

/** Push a TDZ-initialized lexical block over the current interpreter
 * environment. Keeping construction outside the dispatch function preserves
 * the cross-module callable classifier's existing rec-group shape. */
export function createLexicalEnvironment(parent: EnvRec | null, bindingNames: JSValue): EnvRec {
  const env = declarativeWithBindings(parent, bindingNames, EVAL_TDZ);
  const variableEnv = variableEnvironmentFor(parent);
  registerVariableEnvironment(env, variableEnv === null ? parent : variableEnv);
  return env;
}

/** Push the Object Environment Record used by a sloppy `with` statement.
 * ECMAScript performs ToObject before entering the body, so null/undefined
 * throw while primitive values receive their ordinary boxed property view. */
export function createObjectEnvironment(parent: EnvRec | null, value: JSValue): EnvRec {
  if (value === undefined || value === null) {
    throw new TypeError("Cannot convert undefined or null to object");
  }
  const backing = typeof value === "object" || typeof value === "function" ? value : Object(value);
  const env = new EnvRec(ENV_OBJECT, parent, null, null, backing);
  const variableEnv = variableEnvironmentFor(parent);
  registerVariableEnvironment(env, variableEnv === null ? parent : variableEnv);
  return env;
}

function environmentHasOwnBinding(env: EnvRec, name: string): boolean {
  if ((env.kind === ENV_DECLARATIVE || env.kind === ENV_GLOBAL) && declarativeHasOwnBinding(env, name)) return true;
  return env.kind !== ENV_DECLARATIVE && name in env.backing;
}

function ensureVarBinding(env: EnvRec, name: string, existingVarEnv?: EnvRec): void {
  // The standalone ABI represents an omitted nullable class reference as null,
  // whereas ordinary TypeScript uses undefined. Treat both as "not supplied".
  if (existingVarEnv !== undefined && existingVarEnv !== null && environmentHasOwnBinding(existingVarEnv, name)) {
    return;
  }
  if (env.kind === ENV_DECLARATIVE) {
    if (!declarativeHasOwnBinding(env, name)) addDeclarativeBinding(env, name, undefined);
    return;
  }
  if (
    (env.kind === ENV_OBJECT || env.kind === ENV_GLOBAL) &&
    (env.kind !== ENV_GLOBAL || !declarativeHasOwnBinding(env, name)) &&
    !(name in env.backing)
  ) {
    env.backing[name] = undefined;
  }
}

function canDeclareGlobalFunction(globalObject: JSValue, name: string): boolean {
  const descriptor: JSValue = Object.getOwnPropertyDescriptor(globalObject, name);
  if (descriptor === undefined) return Object.isExtensible(globalObject);
  if (descriptor.configurable === true) return true;
  // §9.1.1.4.15: a non-configurable existing DATA property is compatible
  // only when it remains writable and enumerable. Accessor properties and
  // read-only builtins such as NaN are not function-declarable.
  return descriptor.writable === true && descriptor.enumerable === true;
}

function canDeclareGlobalVar(globalObject: JSValue, name: string): boolean {
  if (Object.getOwnPropertyDescriptor(globalObject, name) !== undefined) return true;
  return Object.isExtensible(globalObject);
}

function prepareGlobalFunctionBinding(globalObject: JSValue, name: string): void {
  const descriptor: JSValue = Object.getOwnPropertyDescriptor(globalObject, name);
  if (descriptor === undefined || descriptor.configurable === true) {
    // Eval's D argument is true: a newly-created/reconfigured function binding
    // is deletable. The emitter installs the actual closure immediately after
    // this declaration-instantiation prelude.
    Object.defineProperty(globalObject, name, {
      value: undefined,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function prepareGlobalVarBinding(globalObject: JSValue, name: string): void {
  if (Object.getOwnPropertyDescriptor(globalObject, name) !== undefined) return;
  Object.defineProperty(globalObject, name, {
    value: undefined,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Perform the GlobalEnvironmentRecord portion atomically. Every declaration
 * is validated before any binding is created, so a later non-definable
 * function (for example `function NaN(){}`) cannot leak preceding vars/functions
 * when EvalDeclarationInstantiation throws. */
function prepareGlobalDeclarations(plan: EvalDeclarationPlan, globalEnv: EnvRec): void {
  const globalObject = globalEnv.backing;
  // GlobalEnvironmentRecord.HasLexicalDeclaration precedes every
  // CanDeclareGlobal* check. A Script-level let/const/class must make a sloppy
  // indirect-eval var/function collision a SyntaxError without leaking a
  // partial object property.
  for (const name of plan.varNames) {
    if (declarativeHasOwnBinding(globalEnv, name)) {
      throw new SyntaxError(`Identifier '${name}' has already been declared`);
    }
  }
  for (const name of plan.blockFunctionNames) {
    if (declarativeHasOwnBinding(globalEnv, name)) {
      throw new SyntaxError(`Identifier '${name}' has already been declared`);
    }
  }
  for (const name of plan.functionNames) {
    if (!canDeclareGlobalFunction(globalObject, name)) {
      throw new TypeError(`Cannot declare global function ${name}`);
    }
  }
  for (const name of plan.varNames) {
    let isFunction = false;
    for (const functionName of plan.functionNames) {
      if (functionName === name) isFunction = true;
    }
    if (!isFunction && !canDeclareGlobalVar(globalObject, name)) {
      throw new TypeError(`Cannot declare global variable ${name}`);
    }
  }
  for (const name of plan.functionNames) prepareGlobalFunctionBinding(globalObject, name);
  for (const name of plan.varNames) {
    let isFunction = false;
    for (const functionName of plan.functionNames) {
      if (functionName === name) isFunction = true;
    }
    if (!isFunction) prepareGlobalVarBinding(globalObject, name);
  }
}

/**
 * Perform the environment-allocation part of EvalDeclarationInstantiation.
 * The emitter consumes the predeclared cells: `var` declarations do not reset
 * an existing binding, functions assign their closure during the prologue, and
 * lexical declarations initialize their TDZ cell at the declaration opcode.
 */
export function prepareEvalEnvironment(
  program: Node,
  lexicalEnv: EnvRec,
  variableEnv: EnvRec,
  strictEval: boolean,
  existingVarEnv?: EnvRec,
): EnvRec {
  const plan = collectEvalDeclarations(program);
  let varEnv = variableEnv;
  let executionEnv = lexicalEnv;
  registerVariableEnvironment(variableEnv, variableEnv);
  registerVariableEnvironment(lexicalEnv, variableEnv);
  if (strictEval) {
    const privateNames: string[] = [];
    for (const name of plan.varNames) appendUnique(privateNames, name);
    varEnv = declarativeWithBindings(lexicalEnv, privateNames, undefined);
    executionEnv = varEnv;
    registerVariableEnvironment(varEnv, varEnv);
  } else {
    if (varEnv.kind === ENV_GLOBAL) {
      prepareGlobalDeclarations(plan, varEnv);
    } else {
      for (const name of plan.varNames) ensureVarBinding(varEnv, name, existingVarEnv);
    }
    for (const name of plan.blockFunctionNames) {
      if (!planHasLexicalName(plan, name)) ensureVarBinding(varEnv, name, existingVarEnv);
    }
  }

  if (plan.lexicalNames.length === 0) {
    registerVariableEnvironment(executionEnv, varEnv);
    return executionEnv;
  }
  const result = declarativeWithBindings(executionEnv, plan.lexicalNames, EVAL_TDZ);
  registerVariableEnvironment(result, varEnv);
  return result;
}
