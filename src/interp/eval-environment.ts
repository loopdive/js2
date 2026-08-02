// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Eval declaration instantiation and private lexical environments (#2929).

import { ENV_DECLARATIVE, ENV_GLOBAL, EnvRec, type EvalBindingCell, type JSValue, type Regs } from "./types.js";

type Node = any;

/** Unique value held by an eval lexical binding before its declaration runs. */
export const EVAL_TDZ: JSValue = {};

export class EvalDeclarationPlan {
  varNames: string[];
  lexicalNames: string[];
  blockFunctionNames: string[];

  constructor() {
    this.varNames = [];
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

function collectPatternName(pattern: Node, target: string[]): void {
  if (pattern.type === "Identifier") appendUnique(target, pattern.name);
}

/** Collect only declarations that are var-scoped through a nested statement.
 * Lexical declarations belong to the nested block/loop/switch environment and
 * must not be installed in the eval body's top-level lexical environment. */
function collectNestedVarDeclarations(statement: Node, plan: EvalDeclarationPlan): void {
  if (statement.type === "VariableDeclaration") {
    if (statement.kind === "var") {
      for (const declaration of statement.declarations) collectPatternName(declaration.id, plan.varNames);
    }
    return;
  }
  // A function declaration nested in a block is block-scoped. Strict eval still
  // needs a private place for the Phase-1 emitter to initialize that closure;
  // sloppy Annex B may additionally synthesize a var binding, but only after
  // conflict checks, so it must not enter the ordinary varNames bucket here.
  if (statement.type === "FunctionDeclaration") {
    if (statement.id) appendUnique(plan.blockFunctionNames, statement.id.name);
    return;
  }
  if (statement.type === "ClassDeclaration") return;
  if (statement.type === "BlockStatement") {
    for (const nested of statement.body) collectNestedVarDeclarations(nested, plan);
    return;
  }
  if (statement.type === "IfStatement") {
    collectNestedVarDeclarations(statement.consequent, plan);
    if (statement.alternate) collectNestedVarDeclarations(statement.alternate, plan);
    return;
  }
  if (
    statement.type === "WhileStatement" ||
    statement.type === "DoWhileStatement" ||
    statement.type === "LabeledStatement" ||
    statement.type === "WithStatement"
  ) {
    collectNestedVarDeclarations(statement.body, plan);
    return;
  }
  if (statement.type === "ForStatement") {
    if (statement.init && statement.init.type === "VariableDeclaration") {
      collectNestedVarDeclarations(statement.init, plan);
    }
    collectNestedVarDeclarations(statement.body, plan);
    return;
  }
  if (statement.type === "ForInStatement" || statement.type === "ForOfStatement") {
    if (statement.left && statement.left.type === "VariableDeclaration") {
      collectNestedVarDeclarations(statement.left, plan);
    }
    collectNestedVarDeclarations(statement.body, plan);
    return;
  }
  if (statement.type === "TryStatement") {
    collectNestedVarDeclarations(statement.block, plan);
    if (statement.handler) collectNestedVarDeclarations(statement.handler.body, plan);
    if (statement.finalizer) collectNestedVarDeclarations(statement.finalizer, plan);
    return;
  }
  if (statement.type === "SwitchStatement") {
    for (const switchCase of statement.cases) {
      for (const consequent of switchCase.consequent) collectNestedVarDeclarations(consequent, plan);
    }
  }
}

/** Collect the declarations that PerformEval instantiates before execution. */
export function collectEvalDeclarations(program: Node): EvalDeclarationPlan {
  const plan = new EvalDeclarationPlan();
  for (const statement of program.body) {
    if (statement.type === "VariableDeclaration") {
      const target = statement.kind === "var" ? plan.varNames : plan.lexicalNames;
      for (const declaration of statement.declarations) collectPatternName(declaration.id, target);
    } else if (statement.type === "FunctionDeclaration") {
      if (statement.id) appendUnique(plan.varNames, statement.id.name);
    } else if (statement.type === "ClassDeclaration") {
      if (statement.id) appendUnique(plan.lexicalNames, statement.id.name);
    } else {
      collectNestedVarDeclarations(statement, plan);
    }
  }
  return plan;
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

function declarativeWithBindings(parent: EnvRec, bindingNames: string[], initialValue: JSValue): EnvRec {
  const names: JSValue[] = [];
  const slots: Regs = [];
  for (let i = 0; i < bindingNames.length; i += 1) {
    names.push(bindingNames[i]);
    const cell: EvalBindingCell = { value: initialValue };
    slots.push(cell);
  }
  return new EnvRec(ENV_DECLARATIVE, parent, names, slots, undefined);
}

function ensureVarBinding(env: EnvRec, name: string): void {
  if (env.kind === ENV_DECLARATIVE) {
    if (!declarativeHasOwnBinding(env, name)) addDeclarativeBinding(env, name, undefined);
    return;
  }
  if (env.kind === ENV_GLOBAL && !(name in env.backing)) env.backing[name] = undefined;
}

/**
 * Perform the environment-allocation part of EvalDeclarationInstantiation.
 * The emitter consumes the predeclared cells: `var` declarations do not reset
 * an existing binding, functions assign their closure during the prologue, and
 * lexical declarations initialize their TDZ cell at the declaration opcode.
 */
export function prepareEvalEnvironment(program: Node, variableEnv: EnvRec, strictEval: boolean): EnvRec {
  const plan = collectEvalDeclarations(program);
  let varEnv = variableEnv;
  if (strictEval) {
    const privateNames: string[] = [];
    for (const name of plan.varNames) appendUnique(privateNames, name);
    for (const name of plan.blockFunctionNames) appendUnique(privateNames, name);
    varEnv = declarativeWithBindings(variableEnv, privateNames, undefined);
  } else {
    for (const name of plan.varNames) ensureVarBinding(varEnv, name);
  }

  if (plan.lexicalNames.length === 0) return varEnv;
  return declarativeWithBindings(varEnv, plan.lexicalNames, EVAL_TDZ);
}
