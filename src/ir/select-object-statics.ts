// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7338) The selector's half of the `Object` statics table: the call plan on
 * the selector's lane, the table's carriers (`lowersToCarrier`) and where one
 * may be written (`holdsCarrier`), and the admission of a static's values. It
 * reads the selector's live state through {@link ObjectStaticSelectorState}.
 *
 * A table carrier is what the table introduces and nothing else, so a file
 * without a call the table admits routes exactly as it did before the table:
 * an admitted static's result; a binding initialised with one; and a #7280
 * dynamic home (`var o = {}`) that an admitted call takes, the object the
 * table's defines extend. How one flows through an expression is
 * `producesCarrier`'s one definition, shared with from-ast.
 *
 * A table result does not leave the unit that made it through a call boundary
 * (`escapesUnit`): no function returns one and no source function is passed
 * one, so no call to a user function answers one and nothing has to predict
 * what a callee returns.
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
  /** `node`'s unit (its top-level function or class, else the module's code) holds a call the table admits. */
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
  /**
   * Refuses (through `refuse`) a use from-ast has no lowering for: `<carrier>?.p` / `?.[k]` / `?.()`
   * on a table carrier (`expr-carrier-optional-chain`), and a table result that leaves its unit
   * (`expr-carrier-escapes-unit`, `escapesUnit`).
   */
  readonly admitsCarrierUse: (expression: ts.Expression, refuse: (detail: string, node: ts.Node) => false) => boolean;
  readonly moduleBindingTakes: (id: ts.Identifier, value: ts.Expression) => boolean;
  /** `Object.<static>(…)` or the JS environment's #7276 create, admitted; undefined for any other call. */
  readonly admit: (call: ts.CallExpression, rules: ObjectStaticValueRules) => boolean | undefined;
}

/** The unit a node belongs to: its top-level function or class, else the module's own code. */
function unitOf(node: ts.Node): ts.Node {
  let top = node;
  while (!ts.isSourceFile(top.parent)) top = top.parent;
  return ts.isFunctionDeclaration(top) || ts.isClassDeclaration(top) ? top : top.parent;
}

/** Per source file, every `Object.<name>(…)` call by its unit; the lane's plan says which the table admits. */
const objectCallIndexes = new WeakMap<ts.SourceFile, ReadonlyMap<ts.Node, readonly ts.CallExpression[]>>();

function objectCallsByUnit(file: ts.SourceFile): ReadonlyMap<ts.Node, readonly ts.CallExpression[]> {
  const index = objectCallIndexes.get(file);
  if (index !== undefined) return index;
  const byUnit = new Map<ts.Node, ts.CallExpression[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object"
    ) {
      const unit = unitOf(node);
      const calls = byUnit.get(unit);
      if (calls) calls.push(node);
      else byUnit.set(unit, [node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  objectCallIndexes.set(file, byUnit);
  return byUnit;
}

export function createObjectStaticSelector(state: ObjectStaticSelectorState): ObjectStaticSelector {
  const plan = (call: ts.CallExpression) =>
    objectStatics.objectStaticCallPlan(call, {
      isAmbientBinding: state.isAmbientBinding,
      dynamicCodeMayRun: state.dynamicCodeMayRun(),
      supportsBackendCapability: state.supports,
    });

  const holdsCarrier = (expression: ts.Expression) => state.moduleBinding(expression)?.valueKind.kind === "dynamic";

  /** Whether the lane's plan admits one of a unit's (or the file's) `Object.<name>(…)` calls, per lane. */
  const tableGates = new WeakMap<ts.Node, { readonly lane: string; readonly admits: boolean }>();
  const admitsTableCall = (key: ts.Node, calls: () => readonly ts.CallExpression[]): boolean => {
    const lane = `${state.supports("native-object-statics")}:${state.dynamicCodeMayRun()}`;
    const known = tableGates.get(key);
    if (known?.lane === lane) return known.admits;
    const admits = calls().some((call) => plan(call)?.kind === "call");
    tableGates.set(key, { lane, admits });
    return admits;
  };
  const fileCallsTable = (file: ts.SourceFile) =>
    admitsTableCall(file.endOfFileToken, () => [...objectCallsByUnit(file).values()].flat());
  const unitCallsTable = (node: ts.Node) => {
    const unit = unitOf(node);
    return admitsTableCall(unit, () => objectCallsByUnit(node.getSourceFile()).get(unit) ?? []);
  };

  /** A #7280 dynamic home that an admitted table call takes: the object the table's defines extend. */
  const takenByTable = (declaration: ts.Declaration): boolean =>
    [...objectCallsByUnit(declaration.getSourceFile()).values()].some((calls) =>
      calls.some((call) => {
        const [target] = call.arguments;
        return (
          target !== undefined &&
          state.moduleBinding(target)?.declaration === declaration &&
          plan(call)?.kind === "call"
        );
      }),
    );

  /**
   * `visited`: the declarations whose initializer is being judged; met again (a cycle), one answers
   * no carrier. `homes`: whether a dynamic home a table call takes counts, as it does for its
   * consumers; it is main's carrier already, so where it goes across a call is main's too.
   */
  const tableLeaves = (visited: Set<ts.Declaration>, homes: boolean): CarrierLeaves => ({
    // A function local or a dynamic module home holds what its initializer answers.
    binding: (node) => {
      if (!ts.isIdentifier(node)) return false;
      const declaration =
        state.unannotatedLocal(node) ?? (holdsCarrier(node) ? state.moduleBinding(node)?.declaration : undefined);
      if (declaration === undefined || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
      if (homes && state.isDynamicHomeOpenCarrier(declaration) && takenByTable(declaration)) return true;
      if (visited.has(declaration)) return false;
      visited.add(declaration);
      return producesCarrier(declaration.initializer, tableLeaves(visited, homes));
    },
    // An admitted static answers the carrier; #7335's own-property test on a dynamic home a boolean.
    call: (call) => (plan(call)?.kind === "call" ? true : state.isOwnPropertyTest(call) ? false : undefined),
  });

  const carrier = (expression: ts.Expression, homes: boolean) =>
    fileCallsTable(expression.getSourceFile()) && producesCarrier(expression, tableLeaves(new Set(), homes));
  const lowersToCarrier = (expression: ts.Expression) => carrier(expression, true);

  /**
   * A table result (a static's answer, or a binding initialised with one) leaves the unit that made
   * it only where the IR binds a type across a call: returned from a function, or passed to a source
   * function called by name. Refusing both keeps every user function's parameters and result off the
   * table, so no call answers a table result.
   */
  const escapesUnit = (expression: ts.Expression): boolean => {
    const parent = expression.parent;
    const returned =
      (ts.isReturnStatement(parent) && parent.expression === expression) ||
      (ts.isArrowFunction(parent) && parent.body === expression);
    const passed =
      ts.isCallExpression(parent) &&
      parent.expression !== expression &&
      ts.isIdentifier(parent.expression) &&
      !state.isAmbientBinding(parent.expression) &&
      !state.isLibOnlyBinding(parent.expression);
    return (returned || passed) && carrier(expression, false);
  };

  /** A static's value crosses as a carrier, so any carrier qualifies: a dynamic home or parameter too. */
  const isCarrierValue = (value: ts.Expression): boolean => {
    const leaves = tableLeaves(new Set(), true);
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
    tableMayReach: unitCallsTable,
    holdsCarrier,
    compareVerdict: (expr, nullCompare, isUndefined) => {
      const sides = [expr.left, expr.right];
      if (!sides.some(lowersToCarrier)) return undefined;
      if (nullCompare) return nullComparisonFolds(expr.operatorToken.kind, "dynamic") ? "folded" : "refused";
      return sides.some(isUndefined) ? "folded" : undefined;
    },
    admitsCarrierUse: (e, refuse) => {
      const chained = ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e);
      if (chained && e.questionDotToken !== undefined && lowersToCarrier(e.expression)) {
        return refuse("expr-carrier-optional-chain", e);
      }
      return !escapesUnit(e) || refuse("expr-carrier-escapes-unit", e);
    },
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
