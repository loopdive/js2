// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7338) The selector's half of the `Object` statics table: the call plan on
 * the selector's lane, the table's carriers (`lowersToCarrier`) and where one
 * may be written (`holdsCarrier`), and the admission of a static's values. It
 * reads the selector's live state through {@link ObjectStaticSelectorState}.
 *
 * A table carrier is what the table introduces and nothing else, so code
 * without a table call routes exactly as it did before the table: an admitted
 * static's result; a binding initialised with one; on the table's lane a
 * #7280 dynamic home (`var o = {}`), the object the table's defines extend;
 * and a call to a user function that returns one or is passed one, which can
 * therefore answer it (`function id(x) { return x; }`). How it flows through
 * an expression is `producesCarrier`'s one definition, shared with from-ast.
 */

import { ts } from "../ts-api.js";
import { producesCarrier, type CarrierLeaves } from "./analysis/carrier-expression.js";
import { nullComparisonFolds } from "./analysis/operand-admissibility.js";
import type { IrBackendTargetCapability } from "./backend/legality.js";
import { localIsRewritten } from "./lattice-param-facts.js";
import { objectCreateDescriptorMap } from "./object-create-call.js";
import * as objectStatics from "./object-statics.js";

type Capability = Extract<IrBackendTargetCapability, "native-object-statics" | "native-dynamic-member-read">;

/** The selector state the table's admission reads, live. */
export interface ObjectStaticSelectorState {
  readonly supports: (capability: Capability) => boolean;
  readonly dynamicCodeMayRun: () => boolean;
  readonly isAmbientBinding: (node: ts.Identifier) => boolean;
  readonly isLibOnlyBinding: (node: ts.Identifier) => boolean;
  /** The checker-resolved module binding `expr` reads, with its value kind. */
  readonly moduleBinding: (
    expr: ts.Expression,
  ) => { readonly valueKind: { readonly kind: string }; readonly declaration: ts.Node } | undefined;
  /** The resolver's kind match of a write of `value` to module binding `id`. */
  readonly moduleBindingMatches: (id: ts.Identifier, value: ts.Expression) => boolean;
  readonly unannotatedLocal: (id: ts.Identifier) => ts.VariableDeclaration | undefined;
  readonly isDynamicHomeOpenCarrier: (decl: ts.VariableDeclaration) => boolean;
  /** #7335's own-property test on a dynamic home: it answers a boolean. */
  readonly isOwnPropertyTest: (call: ts.CallExpression) => boolean;
  readonly isDynamicParam: (id: ts.Identifier) => boolean;
}

/** What a static's value admission asks of the selector's current walk. */
export interface ObjectStaticValueRules {
  readonly isUndefinedOrNull: (value: ts.Expression) => boolean;
  /** For a #7128 open-carrier local: does this subject own it? Undefined for any other value. */
  readonly openCarrierIsOwn: (value: ts.Expression) => boolean | undefined;
  readonly isPhase1: (value: ts.Expression) => boolean;
  readonly boxesOntoCarrier: (value: ts.Expression) => boolean;
  readonly refuse: (detail: string, node: ts.Node) => false;
}

export interface ObjectStaticSelector {
  readonly plan: (call: ts.CallExpression) => objectStatics.ObjectStaticPlan | undefined;
  readonly isLiteralDefine: (call: ts.CallExpression) => boolean;
  readonly lowersToCarrier: (expression: ts.Expression) => boolean;
  /** `node`'s file calls some `Object.x(…)`, so the table may make code reachable that was not before. */
  readonly tableMayReach: (node: ts.Node) => boolean;
  readonly holdsCarrier: (expression: ts.Expression) => boolean;
  /**
   * An equality with a table carrier and `null` (`nullCompare`) or the global `undefined`:
   * `refused` when loose against `null` (`tryFoldNullCompare` folds only the strict compare; a
   * loose one types `null` as f64), else `folded`, since the fold or the carrier equality
   * (`tryLowerDynamicEq`) lowers it before `lowerBinary`'s family rule. `void 0` is no such
   * identifier: it lowers to the f64 sentinel, which the family rule judges.
   */
  readonly compareVerdict: (
    expr: ts.BinaryExpression,
    nullCompare: boolean,
    isUndefined: (side: ts.Expression) => boolean,
  ) => "refused" | "folded" | undefined;
  /** `<carrier>?.p` / `?.[k]` / `?.()`: from-ast has no optional chain on a table carrier. */
  readonly chainsOptionallyOnCarrier: (expression: ts.Expression) => boolean;
  readonly moduleBindingTakes: (id: ts.Identifier, value: ts.Expression) => boolean;
  /** `Object.<static>(…)` or the JS environment's #7276 create, admitted; undefined for any other call. */
  readonly admit: (call: ts.CallExpression, rules: ObjectStaticValueRules) => boolean | undefined;
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/** Per source file: each function a call by name may reach, every call by name, and every `Object.x(id, …)` by `id`. */
interface CallIndex {
  readonly functions: ReadonlyMap<string, readonly FunctionLike[]>;
  readonly calls: ReadonlyMap<string, readonly ts.CallExpression[]>;
  readonly objectCallsOn: ReadonlyMap<string, readonly ts.CallExpression[]>;
  /** The file calls some `Object.x(…)`: without one there is no table carrier, and nothing routes differently. */
  readonly callsObject: boolean;
}

const callIndexes = new WeakMap<ts.SourceFile, CallIndex>();

function callIndexOf(file: ts.SourceFile): CallIndex {
  let index = callIndexes.get(file);
  if (index !== undefined) return index;
  const functions = new Map<string, FunctionLike[]>();
  const calls = new Map<string, ts.CallExpression[]>();
  const objectCallsOn = new Map<string, ts.CallExpression[]>();
  let callsObject = false;
  const add = <T>(map: Map<string, T[]>, name: string, value: T) => map.set(name, [...(map.get(name) ?? []), value]);
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) add(functions, node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
    ) {
      add(functions, node.name.text, node.initializer);
    }
    if (ts.isCallExpression(node)) {
      const [target] = node.arguments;
      const callee = node.expression;
      callsObject ||=
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object";
      if (ts.isIdentifier(node.expression)) add(calls, node.expression.text, node);
      else if (target && ts.isIdentifier(target) && ts.isPropertyAccessExpression(node.expression)) {
        add(objectCallsOn, target.text, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  index = { functions, calls, objectCallsOn, callsObject };
  callIndexes.set(file, index);
  return index;
}

/** The return expressions of `fn`'s own body (nested functions excluded); an arrow's expression body is one. */
function returnedExpressions(fn: FunctionLike): ts.Expression[] {
  if (fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const returned: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return returned;
}

export function createObjectStaticSelector(state: ObjectStaticSelectorState): ObjectStaticSelector {
  const plan = (call: ts.CallExpression) =>
    objectStatics.objectStaticCallPlan(call, {
      isAmbientBinding: state.isAmbientBinding,
      dynamicCodeMayRun: state.dynamicCodeMayRun(),
      supportsBackendCapability: state.supports,
    });

  const holdsCarrier = (expression: ts.Expression) => state.moduleBinding(expression)?.valueKind.kind === "dynamic";

  /**
   * One query's answers, so each binding, function and callee name is judged once: a key met
   * again while its own answer is pending (a cycle) answers no carrier.
   */
  type Answers = Map<ts.Node | string, boolean | undefined>;
  const answer = (answers: Answers, key: ts.Node | string, compute: () => boolean): boolean => {
    if (answers.has(key)) return answers.get(key) === true;
    answers.set(key, undefined);
    const result = compute();
    answers.set(key, result);
    return result;
  };

  /** A call by name whose callee returns a table carrier or is passed one, and so can answer it. */
  const callsCarrierFunction = (call: ts.CallExpression, answers: Answers): boolean => {
    if (!ts.isIdentifier(call.expression)) return false;
    const index = callIndexOf(call.getSourceFile());
    const name = call.expression.text;
    return answer(answers, name, () => {
      const returns = (index.functions.get(name) ?? []).some((fn) =>
        returnedExpressions(fn).some((returned) => carrier(returned, answers)),
      );
      const passed = (index.calls.get(name) ?? []).some((site) =>
        site.arguments.some((argument) => carrier(argument, answers)),
      );
      return returns || passed;
    });
  };

  const tableLeaves = (answers: Answers): CarrierLeaves => ({
    // A function local or a dynamic module home holds what its initializer answers.
    binding: (node) => {
      if (!ts.isIdentifier(node)) return false;
      const declaration =
        state.unannotatedLocal(node) ?? (holdsCarrier(node) ? state.moduleBinding(node)?.declaration : undefined);
      if (declaration === undefined || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
      // A #7280 dynamic home a table call takes is the object the table's defines extend.
      const takenByTable = () =>
        (callIndexOf(node.getSourceFile()).objectCallsOn.get(node.text) ?? []).some(
          (call) => plan(call)?.kind === "call",
        );
      if (state.isDynamicHomeOpenCarrier(declaration) && takenByTable()) return true;
      return answer(answers, declaration, () => carrier(declaration.initializer!, answers));
    },
    // An admitted static answers the carrier, and so does a user function that can return one;
    // #7335's own-property test on a dynamic home answers a boolean.
    call: (call) => {
      if (plan(call)?.kind === "call" || callsCarrierFunction(call, answers)) return true;
      return state.isOwnPropertyTest(call) ? false : undefined;
    },
  });

  const carrier = (expression: ts.Expression, answers: Answers): boolean =>
    producesCarrier(expression, tableLeaves(answers));
  const lowersToCarrier = (expression: ts.Expression) =>
    callIndexOf(expression.getSourceFile()).callsObject && carrier(expression, new Map());

  /** A static's value crosses as a carrier, so any carrier qualifies: a dynamic home or parameter too. */
  const isCarrierValue = (value: ts.Expression): boolean => {
    const leaves = tableLeaves(new Map());
    return producesCarrier(value, {
      ...leaves,
      binding: (node) =>
        holdsCarrier(node) || (ts.isIdentifier(node) && state.isDynamicParam(node)) || leaves.binding(node),
    });
  };

  const admit = (call: ts.CallExpression, rules: ObjectStaticValueRules): boolean | undefined => {
    // The JS environment's #7276 create applies only off the table's lane, so at most one of the two answers.
    const create = objectCreateDescriptorMap(call, {
      supportsBackendCapability: state.supports,
      isLibOnlyBinding: state.isLibOnlyBinding,
    });
    if (create !== null) return true;
    const admitted = plan(call);
    if (admitted?.kind === "refused") return rules.refuse(`expr-object-static-${admitted.refusal}`, call);
    return objectStatics.admittedValues(admitted)?.every((operand) => {
      let value = operand;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      if (rules.isUndefinedOrNull(value)) return true;
      const own = rules.openCarrierIsOwn(value);
      if (own === undefined && !rules.isPhase1(value)) return false;
      const carried = own ?? (isCarrierValue(value) || (rules.boxesOntoCarrier(value) && !isRewrittenParameter(value)));
      return carried || rules.refuse("expr-object-static-operand", value);
    });
  };

  return {
    plan,
    isLiteralDefine: (call) => objectStatics.isLiteralDefine(plan(call)),
    lowersToCarrier,
    tableMayReach: (node) => callIndexOf(node.getSourceFile()).callsObject,
    holdsCarrier,
    compareVerdict: (expr, nullCompare, isUndefined) => {
      const sides = [expr.left, expr.right];
      if (!sides.some(lowersToCarrier)) return undefined;
      if (nullCompare) return nullComparisonFolds(expr.operatorToken.kind, "dynamic") ? "folded" : "refused";
      return sides.some(isUndefined) ? "folded" : undefined;
    },
    chainsOptionallyOnCarrier: (e) =>
      (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) &&
      e.questionDotToken !== undefined &&
      lowersToCarrier(e.expression),
    // A carrier goes only into its home; a function local holds one only as its own initializer.
    moduleBindingTakes: (id, value) =>
      state.moduleBindingMatches(id, value) && (holdsCarrier(id) || !lowersToCarrier(value)),
    admit,
  };
}

/**
 * A parameter (of the nearest function that declares one by this name) that
 * its function writes anywhere, nested functions included: the lattice's
 * write index (`localIsRewritten`) gives it no fact, so from-ast cannot prove
 * what the write stored and `n = n + 1` demotes after the claim whether or not
 * a static reads `n`. A static refuses it rather than claim the function.
 */
function isRewrittenParameter(value: ts.Expression): boolean {
  if (!ts.isIdentifier(value)) return false;
  const declares = (parameter: ts.ParameterDeclaration) =>
    ts.isIdentifier(parameter.name) && parameter.name.text === value.text;
  const owner = ts.findAncestor(value, (node) => ts.isFunctionLike(node) && node.parameters.some(declares));
  const parameter = owner && (owner as ts.SignatureDeclaration).parameters.find(declares);
  return parameter !== undefined && localIsRewritten(parameter);
}
