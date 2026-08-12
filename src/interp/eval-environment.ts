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
/** Direct eval keeps newly-created vars in a provider-owned persistent record,
 * while pre-existing caller vars remain in the caller activation record. This
 * side table records that second legitimate VariableEnvironment target for
 * B.3.3's synthetic block-function assignment. */
const EXISTING_VARIABLE_ENVIRONMENTS: WeakMap<object, EnvRec> = new WeakMap();
/** Caller-owned direct-eval activation state associated with a provider-local
 * declarative record. Keep this out-of-line: `EnvRec.backing` already carries
 * mapped-parameter names for function activations, and overloading that field
 * makes an eval-created binding named `arguments` look like an Arguments Exotic
 * Object activation. The side table also lets every retained closure consult
 * the canonical name cells instead of the names snapshot from its provider
 * entry. */
const DIRECT_EVAL_ACTIVATION_STATES: WeakMap<object, JSValue> = new WeakMap();
/** Opaque companion name for a D=true eval binding. `$EnvRec` and
 * `$EvalBindingCell` are frozen cross-module ABIs, so each source-visible name
 * occupies an even entry and this impossible identifier occupies the adjacent
 * odd entry. The flat string carrier is self-host-stable and introduces no new
 * GC rec-group shape. */
const DELETABLE_EVAL_BINDINGS_MARKER = "\0js2wasm:deletable-eval-binding";

export function isDeletableEvalBindingsMarker(value: JSValue): boolean {
  return value === DELETABLE_EVAL_BINDINGS_MARKER;
}

/** Associate one provider-local VariableEnvironment with the caller-owned
 * four-cell-per-binding state pool. No `EnvRec` field or provider ABI changes. */
export function registerDirectEvalActivationState(env: EnvRec, stateCells: JSValue): void {
  if (stateCells === undefined || stateCells === null) return;
  DIRECT_EVAL_ACTIVATION_STATES.set(env as object, stateCells);
}

/** Return the caller-owned state pool for `env`, or null for an ordinary
 * declarative record. The explicit null normalization is required by the
 * standalone compiler's nullable-class-reference representation. */
export function directEvalActivationStateFor(env: EnvRec): JSValue {
  const stateCells = DIRECT_EVAL_ACTIVATION_STATES.get(env as object);
  return stateCells === undefined || stateCells === null ? null : stateCells;
}

/** Find a visible binding group in the canonical state pool. Returned offsets
 * address the name cell; value and marker-name cells are +1 and +2. Marker
 * validation belongs to deletion: a malformed/non-deletable group can still be
 * read without granting it D=true semantics. */
function directEvalActivationStateBindingOffset(stateCells: JSValue, name: JSValue): number {
  for (let offset = 0; offset + 3 < stateCells.length; offset += 4) {
    const nameCell = stateCells[offset] as EvalBindingCell;
    if (nameCell !== undefined && nameCell !== null && nameCell.value === name) return offset;
  }
  return -1;
}

/** Resolve an own binding through the canonical caller-owned name cells.
 * Retained closures must not trust their provider-entry names snapshot: a later
 * direct eval can delete that binding and reuse the same group for another
 * name. */
export function directEvalActivationStateBindingCell(env: EnvRec, name: JSValue): EvalBindingCell | null {
  const stateCells = directEvalActivationStateFor(env);
  if (stateCells === null) return null;
  const offset = directEvalActivationStateBindingOffset(stateCells, name);
  if (offset < 0) return null;
  return stateCells[offset + 1] as EvalBindingCell;
}

/** Tombstone one four-cell caller-owned direct-eval state-pool group.
 *
 * A closure can outlive the provider call that created it. Its EnvRec retains
 * the provider-local names vector, while the out-of-line association retains
 * the flat caller-owned carrier. Updating the exact deleted group here prevents
 * a later provider entry from restoring the stale name without overloading the
 * mapped-arguments payload in `EnvRec.backing`. */
function tombstoneDirectEvalActivationState(env: EnvRec, bindingIndex: number): void {
  const stateCells = directEvalActivationStateFor(env);
  if (stateCells === null) return;
  const firstStateCell = bindingIndex * 2;
  const endStateCell = firstStateCell + 4;
  if (endStateCell > stateCells.length) return;
  for (let i = firstStateCell; i < endStateCell; i += 1) {
    const stateCell = stateCells[i] as EvalBindingCell;
    if (stateCell !== undefined && stateCell !== null) stateCell.value = undefined;
  }
}

/** Try to delete an own declarative binding.
 *
 * Returns -1 when absent, 0 when present but non-deletable, and 1 after a
 * successful eval-binding deletion. A tombstoned name is the existing state-
 * pool vacancy convention; the live value cell is retained for later reuse. */
export function deleteOwnEnvironmentBinding(env: EnvRec, name: JSValue): number {
  if ((env.kind !== ENV_DECLARATIVE && env.kind !== ENV_GLOBAL) || env.slots === null) return -1;
  const stateCells = directEvalActivationStateFor(env);
  if (stateCells !== null) {
    const offset = directEvalActivationStateBindingOffset(stateCells, name);
    if (offset < 0) return -1;
    const markerNameCell = stateCells[offset + 2] as EvalBindingCell;
    if (
      markerNameCell === undefined ||
      markerNameCell === null ||
      !isDeletableEvalBindingsMarker(markerNameCell.value)
    ) {
      return 0;
    }
    const bindingIndex = offset / 2;
    const names: JSValue = env.names;
    if (names !== undefined && names !== null && bindingIndex + 1 < names.length) {
      names[bindingIndex] = undefined;
      names[bindingIndex + 1] = undefined;
    }
    const valueCell = stateCells[offset + 1] as EvalBindingCell;
    valueCell.value = undefined;
    tombstoneDirectEvalActivationState(env, bindingIndex);
    return 1;
  }
  const names: JSValue = env.names;
  if (names === undefined || names === null) return -1;
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] !== name) continue;
    const cell = env.slots[i] as EvalBindingCell;
    if (i + 1 >= names.length || !isDeletableEvalBindingsMarker(names[i + 1])) return 0;
    names[i] = undefined;
    names[i + 1] = undefined;
    cell.value = undefined;
    tombstoneDirectEvalActivationState(env, i);
    return 1;
  }
  return -1;
}

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

/**
 * A `Map`/`WeakMap` miss is `undefined` in TypeScript, but the standalone ABI
 * has no distinct `undefined` for a **nullable class reference**: the local
 * that receives `WeakMap<object, EnvRec>.get(missing)` holds `null`. Measured
 * on this compiler — `WeakMap.get(missing) === null` is false when evaluated
 * inline, yet `const v = WeakMap.get(missing); v === null` is true, so the
 * coercion happens at the local store, exactly where an absence test reads it.
 * An `x !== undefined` test therefore accepts a miss in the standalone lane and
 * hands a null reference to the next call. Both spellings mean "absent".
 */
function presentEnv(env: EnvRec | undefined | null): EnvRec | null {
  return env === undefined || env === null ? null : env;
}

/** Resolve the VariableEnvironment for a lexical chain without changing the
 * frozen `$Frame` / `$EnvRec` layouts.  The parent walk is a defensive fallback
 * for environments created before their child association was installed. */
export function variableEnvironmentFor(env: EnvRec | null): EnvRec | null {
  let current = env;
  for (;;) {
    if (current === null) return null;
    // A miss must CONTINUE the parent walk. Returning it (which is `null` under
    // the standalone ABI, not `undefined`) truncated the walk at the first
    // unregistered record, so `variableEnvironmentFor` answered "no variable
    // environment" and B.3.3's synthetic assignment was silently skipped.
    const variableEnv = presentEnv(VARIABLE_ENVIRONMENTS.get(current as object));
    if (variableEnv !== null) return variableEnv;
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

/** Append every name a binding pattern binds. Used for a NON-simple catch
 * parameter: B.3.5 exempts only `CatchParameter : BindingIdentifier`, so a
 * destructuring parameter's bound names must shadow the handler descent and
 * cancel B.3.3's synthetic var for those names. */
export function appendPatternBoundNames(pattern: Node, target: string[]): void {
  if (!pattern) return;
  if (pattern.type === "Identifier") {
    appendUnique(target, pattern.name);
  } else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      if (property.type === "RestElement") appendPatternBoundNames(property.argument, target);
      else appendPatternBoundNames(property.value, target);
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) appendPatternBoundNames(element, target);
  } else if (pattern.type === "AssignmentPattern") {
    appendPatternBoundNames(pattern.left, target);
  } else if (pattern.type === "RestElement") {
    appendPatternBoundNames(pattern.argument, target);
  }
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
    if (statement.handler) {
      // A SIMPLE catch parameter is B.3.5-exempt and deliberately does NOT
      // shadow the handler descent; a destructuring one is not exempt.
      const handlerLexicals: string[] = [];
      for (const name of lexicalAncestors) handlerLexicals.push(name);
      const param = statement.handler.param;
      if (param && param.type !== "Identifier") appendPatternBoundNames(param, handlerLexicals);
      collectNestedVarDeclarations(statement.handler.body, plan, handlerLexicals);
    }
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
  lexicalNames?: JSValue,
): void {
  const plan = collectEvalDeclarations(program);

  // The raw vectors must be grown before they are stored in an EnvRec, but a
  // failed declaration instantiation must not leave a partial persistent
  // binding behind. Preflight every ordinary var name against the caller's
  // intervening lexical layer before allocating the first cell.
  if (lexicalNames !== undefined && lexicalNames !== null) {
    for (const name of plan.varNames) {
      for (let i = 0; i < lexicalNames.length; i += 1) {
        if (lexicalNames[i] === name) throw new SyntaxError(`Identifier '${name}' has already been declared`);
      }
    }
  }

  const persistentNames: string[] = [];
  for (const name of plan.varNames) appendUnique(persistentNames, name);
  for (const name of plan.blockFunctionNames) {
    let blocked = planHasLexicalName(plan, name);
    if (!blocked && lexicalNames !== undefined && lexicalNames !== null) {
      for (let i = 0; i < lexicalNames.length; i += 1) {
        if (lexicalNames[i] === name) blocked = true;
      }
    }
    // Annex B's synthetic outer var is cancelled, rather than rejected, when
    // an intervening declarative environment already binds the name.
    if (!blocked) appendUnique(persistentNames, name);
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
    for (let i = 0; i + 1 < names.length; i += 2) {
      if ((names[i] === undefined || names[i] === null) && (names[i + 1] === undefined || names[i + 1] === null)) {
        vacancy = i;
        break;
      }
    }
    if (vacancy >= 0) {
      names[vacancy] = name;
      names[vacancy + 1] = DELETABLE_EVAL_BINDINGS_MARKER;
      (slots[vacancy] as EvalBindingCell).value = undefined;
    } else {
      if (names.length >= 128) throw "direct eval activation binding capacity exceeded";
      names.push(name);
      const cell: EvalBindingCell = { value: undefined };
      slots.push(cell);
      names.push(DELETABLE_EVAL_BINDINGS_MARKER);
      const markerCell: EvalBindingCell = { value: undefined };
      slots.push(markerCell);
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
  const stateCells = directEvalActivationStateFor(env);
  if (stateCells !== null) return directEvalActivationStateBindingOffset(stateCells, name) >= 0;
  if (env.names === undefined || env.names === null || env.slots === null) return false;
  const names = env.names as JSValue[];
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] === name) return true;
  }
  return false;
}

function setOwnEnvironmentBinding(env: EnvRec, name: string, value: JSValue): boolean {
  const stateCells = directEvalActivationStateFor(env);
  if (stateCells !== null) {
    const offset = directEvalActivationStateBindingOffset(stateCells, name);
    if (offset < 0) return false;
    (stateCells[offset + 1] as EvalBindingCell).value = value;
    return true;
  }
  if (
    (env.kind === ENV_DECLARATIVE || env.kind === ENV_GLOBAL) &&
    env.names !== undefined &&
    env.names !== null &&
    env.slots !== null
  ) {
    const names = env.names as JSValue[];
    const slots = env.slots as Regs;
    for (let i = 0; i < names.length; i += 1) {
      if (names[i] === name) {
        (slots[i] as EvalBindingCell).value = value;
        return true;
      }
    }
  }
  if (env.kind !== ENV_DECLARATIVE && name in env.backing) {
    env.backing[name] = value;
    return true;
  }
  return false;
}

/** Assign B.3.3's synthetic outer function value to the binding selected by
 * EvalDeclarationInstantiation. Prefer an eval-created persistent var; when
 * allocation was skipped because the caller activation already owns the name,
 * update that exact caller cell. Never walk into captured-outer or lexical
 * records, where the Annex-B binding may have been cancelled. */
export function setEvalVariableEnvironmentBinding(env: EnvRec, name: string, value: JSValue): boolean {
  if (setOwnEnvironmentBinding(env, name, value)) return true;
  // `existing !== undefined` alone let a standalone-ABI miss (`null`, see
  // `presentEnv`) through and dereferenced it in `setOwnEnvironmentBinding` —
  // the null-pointer trap that killed every eval-code B.3.3 test whose caller
  // activation was not registered here.
  const existing = presentEnv(EXISTING_VARIABLE_ENVIRONMENTS.get(env as object));
  return existing !== null && setOwnEnvironmentBinding(existing, name, value);
}

function addDeclarativeBinding(env: EnvRec, name: string, value: JSValue): void {
  const names = env.names as JSValue[];
  const slots = env.slots as Regs;
  const cell: EvalBindingCell = { value };
  names.push(name);
  slots.push(cell);
}

/** Allocate one binding in a retained direct-eval activation. This is mainly
 * exercised when an interpreted closure performs another direct eval after the
 * original provider entry has returned. The fixed caller pool remains the
 * authoritative storage and keeps its existing 64-visible-binding ceiling. */
function addDirectEvalActivationStateBinding(env: EnvRec, name: string, value: JSValue): boolean {
  const stateCells = directEvalActivationStateFor(env);
  if (stateCells === null) return false;
  for (let offset = 0; offset + 3 < stateCells.length; offset += 4) {
    const nameCell = stateCells[offset] as EvalBindingCell;
    const valueCell = stateCells[offset + 1] as EvalBindingCell;
    const markerNameCell = stateCells[offset + 2] as EvalBindingCell;
    const markerValueCell = stateCells[offset + 3] as EvalBindingCell;
    if (
      (nameCell.value === undefined || nameCell.value === null) &&
      (markerNameCell.value === undefined || markerNameCell.value === null)
    ) {
      nameCell.value = name;
      valueCell.value = value;
      markerNameCell.value = DELETABLE_EVAL_BINDINGS_MARKER;
      markerValueCell.value = undefined;
      return true;
    }
  }
  throw "direct eval activation binding capacity exceeded";
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

function interveningNonObjectEnvironmentHasBinding(lexicalEnv: EnvRec, variableEnv: EnvRec, name: string): boolean {
  let current: EnvRec | null = lexicalEnv;
  for (;;) {
    if (current === variableEnv) return false;
    if (current === null) throw new SyntaxError("eval VariableEnvironment is not on the lexical environment chain");
    if (current.kind !== ENV_OBJECT && environmentHasOwnBinding(current, name)) return true;
    current = current.parent;
  }
}

/**
 * Perform EvalDeclarationInstantiation's non-strict var-environment walk.
 *
 * A direct eval can begin in a lexical environment above the caller's
 * VariableEnvironment (parameter-expression, block, catch, or another eval
 * lexical record). Before creating any var-scoped binding, every intervening
 * non-object record must reject a same-named binding. Object Environment
 * Records are deliberately skipped: a `with` object's properties are not
 * declarative-name collisions for this step.
 *
 * Keep this as a preflight over the complete name set so a later collision
 * cannot leak an earlier var/function binding into the caller.
 */
function validateNonStrictEvalVarNames(plan: EvalDeclarationPlan, lexicalEnv: EnvRec, variableEnv: EnvRec): void {
  if (lexicalEnv === variableEnv) return;

  let current: EnvRec | null = lexicalEnv;
  for (;;) {
    if (current === variableEnv) return;
    // The spec asserts that VariableEnvironment is on this outer chain. A
    // malformed provider chain must fail closed instead of creating bindings
    // in an unrelated record.
    if (current === null) throw new SyntaxError("eval VariableEnvironment is not on the lexical environment chain");
    if (current.kind !== ENV_OBJECT) {
      for (const name of plan.varNames) {
        if (environmentHasOwnBinding(current, name)) {
          throw new SyntaxError(`Identifier '${name}' has already been declared`);
        }
      }
    }
    current = current.parent;
  }
}

function ensureVarBinding(env: EnvRec, name: string, existingVarEnv?: EnvRec): void {
  // The standalone ABI represents an omitted nullable class reference as null,
  // whereas ordinary TypeScript uses undefined. Treat both as "not supplied".
  if (existingVarEnv !== undefined && existingVarEnv !== null && environmentHasOwnBinding(existingVarEnv, name)) {
    return;
  }
  if (env.kind === ENV_DECLARATIVE) {
    if (!declarativeHasOwnBinding(env, name)) {
      if (!addDirectEvalActivationStateBinding(env, name, undefined)) {
        addDeclarativeBinding(env, name, undefined);
        addDeclarativeBinding(env, DELETABLE_EVAL_BINDINGS_MARKER, undefined);
      }
    }
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
    validateNonStrictEvalVarNames(plan, lexicalEnv, varEnv);
    if (existingVarEnv !== undefined && existingVarEnv !== null) {
      EXISTING_VARIABLE_ENVIRONMENTS.set(varEnv as object, existingVarEnv);
    }
    if (varEnv.kind === ENV_GLOBAL) {
      prepareGlobalDeclarations(plan, varEnv);
    } else {
      for (const name of plan.varNames) ensureVarBinding(varEnv, name, existingVarEnv);
    }
    for (const name of plan.blockFunctionNames) {
      if (!planHasLexicalName(plan, name) && !interveningNonObjectEnvironmentHasBinding(lexicalEnv, varEnv, name)) {
        ensureVarBinding(varEnv, name, existingVarEnv);
      }
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
