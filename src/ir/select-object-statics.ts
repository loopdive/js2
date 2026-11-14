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
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";
import { outermostParenthesized } from "../shared/binding-writes.js";

type Capability = Extract<
  IrBackendTargetCapability,
  "native-object-statics" | "native-own-property-test" | "native-dynamic-member-read"
>;

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
  /** (#7339) An admitted own-property test (`R.hasOwnProperty(k)`) that answers the i32 boolean. */
  readonly answersBoolean: (call: ts.CallExpression) => boolean;
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

/** A source file's calls spelled as a table row, all and by unit; the lane's plan says which the table admits. */
interface ObjectCallIndex {
  readonly all: readonly ts.CallExpression[];
  readonly byUnit: ReadonlyMap<ts.Node, readonly ts.CallExpression[]>;
}

const objectCallIndexes = new WeakMap<ts.SourceFile, ObjectCallIndex>();

function objectCallsOf(file: ts.SourceFile): ObjectCallIndex {
  const known = objectCallIndexes.get(file);
  if (known !== undefined) return known;
  const all: ts.CallExpression[] = [];
  const byUnit = new Map<ts.Node, ts.CallExpression[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      objectStatics.isTableCallName(node.expression.name.text)
    ) {
      all.push(node);
      const unit = unitOf(node);
      const calls = byUnit.get(unit);
      if (calls) calls.push(node);
      else byUnit.set(unit, [node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const index = { all, byUnit };
  objectCallIndexes.set(file, index);
  return index;
}

/**
 * A cache of one answer per key, kept with the lane it was taken on: the plan reads the lane
 * (capability, dynamic code), so an answer holds only for that lane.
 */
function laneAnswers<K extends object>(): (key: K, lane: string, compute: () => boolean) => boolean {
  const answers = new WeakMap<K, { readonly lane: string; readonly answer: boolean }>();
  return (key, lane, compute) => {
    const known = answers.get(key);
    if (known?.lane === lane) return known.answer;
    const answer = compute();
    answers.set(key, { lane, answer });
    return answer;
  };
}

/** (#7339) The receivers the selector found to be dynamic homes, for from-ast's plan ({@link selectedDynamicHomeReceiver}). */
const dynamicHomeReceivers = new WeakSet<ts.Expression>();

/**
 * (#7339) The selector's answer for a test's receiver, read by from-ast's plan so both sides plan the same
 * representation, as #7335's arm recorded its admitted calls on main.
 */
export function selectedDynamicHomeReceiver(receiver: ts.Expression): boolean {
  return dynamicHomeReceivers.has(receiver);
}

export function createObjectStaticSelector(state: ObjectStaticSelectorState): ObjectStaticSelector {
  /** A script `var o = {}` that legacy keeps as an open `$Object` on the dynamic slot: #7335's receivers on main. */
  const isDynamicHomeReceiver = (receiver: ts.Expression): boolean => {
    const declaration = ts.isIdentifier(receiver) ? state.moduleBinding(receiver)?.declaration : undefined;
    const home =
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      objectStatics.isEmptyObjectLiteral(declaration.initializer) &&
      state.isDynamicHomeOpenCarrier(declaration);
    if (home) dynamicHomeReceivers.add(receiver);
    else dynamicHomeReceivers.delete(receiver);
    return home;
  };
  const plan = (call: ts.CallExpression) =>
    objectStatics.objectStaticCallPlan(call, {
      isAmbientBinding: state.isAmbientBinding,
      dynamicCodeMayRun: state.dynamicCodeMayRun(),
      supportsBackendCapability: state.supports,
      isDynamicHomeReceiver,
    });

  const holdsCarrier = (expression: ts.Expression) => state.moduleBinding(expression)?.valueKind.kind === "dynamic";

  const lane = () => `${state.supports("native-object-statics")}:${state.dynamicCodeMayRun()}`;
  /** An admitted static: it answers or extends an object. */
  const objectCall = (call: ts.CallExpression) => plan(call)?.kind === "call";
  const answersBoolean = (call: ts.CallExpression) => {
    const admitted = plan(call);
    return admitted?.kind === "test" && admitted.test.answer === "boolean";
  };
  /** Whether the file holds a call `matches` accepts, per file and lane. */
  const fileHolds = (matches: (call: ts.CallExpression) => boolean) => {
    const answers = laneAnswers<ts.SourceFile>();
    return (file: ts.SourceFile) => answers(file, lane(), () => objectCallsOf(file).all.some(matches));
  };
  /** The file holds an admitted static: the table makes carriers. */
  const fileCallsTable = fileHolds(objectCall);
  /** (#7339) The file holds an admitted own-property test. */
  const fileCallsTest = fileHolds((call) => plan(call)?.kind === "test");
  /** Whether `node`'s unit holds a call `matches` accepts, per unit and lane. */
  const unitHolds = (matches: (call: ts.CallExpression) => boolean) => {
    const answers = laneAnswers<ts.Node>();
    return (node: ts.Node) => {
      const unit = unitOf(node);
      const calls = objectCallsOf(node.getSourceFile()).byUnit.get(unit) ?? [];
      return answers(unit, lane(), () => calls.some(matches));
    };
  };
  /** A call the lane's plan admits, of any row: the table may make the unit reachable. */
  const unitCallsTable = unitHolds((call) => {
    const kind = plan(call)?.kind;
    return kind === "call" || kind === "test";
  });

  /** A #7280 dynamic home that an admitted table call takes: the object the table's defines extend. */
  const takenByTable = (declaration: ts.Declaration): boolean =>
    objectCallsOf(declaration.getSourceFile()).all.some((call) => {
      const [target] = call.arguments;
      return target !== undefined && state.moduleBinding(target)?.declaration === declaration && objectCall(call);
    });

  /** The declaration a function local or a dynamic module home reads, when it has an initializer. */
  const initializedDeclaration = (node: ts.Identifier | ts.ThisExpression): ts.VariableDeclaration | undefined => {
    if (!ts.isIdentifier(node)) return undefined;
    const declaration =
      state.unannotatedLocal(node) ?? (holdsCarrier(node) ? state.moduleBinding(node)?.declaration : undefined);
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer
      ? declaration
      : undefined;
  };
  /**
   * The binding holds what its initializer answers under `leaves`. `visited`: the declarations
   * whose initializer is being judged; met again (a cycle), one answers no carrier.
   */
  const holdsInitializer = (
    declaration: ts.VariableDeclaration,
    visited: Set<ts.Declaration>,
    leaves: (visited: Set<ts.Declaration>) => CarrierLeaves,
  ): boolean => {
    if (visited.has(declaration)) return false;
    visited.add(declaration);
    return producesCarrier(declaration.initializer!, leaves(visited));
  };
  /**
   * An admitted static answers the carrier; (#7339) an own-property test its boolean, boxed onto the carrier except
   * on a dynamic home (the plan's `answer`, which from-ast reads too).
   */
  const staticCall: CarrierLeaves["call"] = (call) => {
    const admitted = plan(call);
    if (admitted?.kind === "test") return admitted.test.answer === "dynamic";
    return admitted?.kind === "call" ? true : undefined;
  };
  /** A table result is a static's object: a test's boolean, boxed or not, crosses a call as main's values do. */
  const resultCall: CarrierLeaves["call"] = (call) => {
    const kind = plan(call)?.kind;
    return kind === "call" ? true : kind === "test" ? false : undefined;
  };

  /** The table's results: a static's answer, and a binding initialised with one. */
  const resultLeaves = (visited: Set<ts.Declaration>): CarrierLeaves => ({
    binding: (node) => {
      const declaration = initializedDeclaration(node);
      return declaration !== undefined && holdsInitializer(declaration, visited, resultLeaves);
    },
    call: resultCall,
  });
  /** The table's carriers, as its consumers read them: its results, and a dynamic home a table call takes. */
  const carrierLeaves = (visited: Set<ts.Declaration>): CarrierLeaves => ({
    binding: (node) => {
      const declaration = initializedDeclaration(node);
      if (declaration === undefined) return false;
      if (state.isDynamicHomeOpenCarrier(declaration) && takenByTable(declaration)) return true;
      return holdsInitializer(declaration, visited, carrierLeaves);
    },
    call: staticCall,
  });
  /** A static's own values, which cross as carriers: the table's carriers, and main's dynamic bindings and parameters. */
  const valueLeaves = (visited: Set<ts.Declaration>): CarrierLeaves => ({
    binding: (node) =>
      holdsCarrier(node) ||
      (ts.isIdentifier(node) && state.isDynamicParam(node)) ||
      carrierLeaves(visited).binding(node),
    call: staticCall,
  });

  const lowersToCarrier = (expression: ts.Expression) =>
    fileCallsTable(expression.getSourceFile()) && producesCarrier(expression, carrierLeaves(new Set()));

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
    // A dynamic home a table call takes is main's carrier already: where it goes across a call is main's.
    return (
      (returned || passed) &&
      fileCallsTable(expression.getSourceFile()) &&
      producesCarrier(expression, resultLeaves(new Set()))
    );
  };

  /**
   * (#7339) `<carrier>.<key>` read as a value, for a key `%Object.prototype%` owns other than `toString`: the
   * open `$Object` member read answers the realm's inherited member only for `toString` (main's gap, #7304). The
   * gap holds with or without a test in the file; refusing it only where the file holds an admitted test is a
   * deliberate scope limit, not a soundness argument: this PR closes what its tests newly reach and leaves the
   * statics' units on main's routing, wrong answers included, for #7304. An admitted test's callee is no such read.
   */
  const readsInheritedMember = (e: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(e) || e.name.text === "toString" || !OBJECT_PROTOTYPE_KEYS.has(e.name.text)) {
      return false;
    }
    const call = outermostParenthesized(e).parent;
    if (ts.isCallExpression(call) && call.expression === outermostParenthesized(e) && plan(call)?.kind === "test") {
      return false;
    }
    return fileCallsTest(e.getSourceFile()) && (holdsCarrier(e.expression) || lowersToCarrier(e.expression));
  };

  /** A static's value crosses as a carrier, so any carrier qualifies: a dynamic home or parameter too. */
  const isCarrierValue = (value: ts.Expression): boolean => producesCarrier(value, valueLeaves(new Set()));

  const admit = (call: ts.CallExpression, rules: ObjectStaticValueRules): boolean | undefined => {
    // The JS environment's #7276 create applies only off the table's lane, so at most one of the two answers.
    const create = objectCreateDescriptorMap(call, {
      supportsBackendCapability: state.supports,
      isLibOnlyBinding: state.isLibOnlyBinding,
    });
    if (create !== null) return true;
    const admitted = plan(call);
    if (admitted?.kind === "refused") return rules.refuse(`expr-object-static-${admitted.refusal}`, call);
    const values = objectStatics.admittedValues(admitted);
    // (#7339) A test's receiver is a value already on the carrier: one the IR types as an array, a string or a
    // struct would answer for that representation, not for the object legacy builds.
    const receiver = admitted?.kind === "test" ? admitted.test.receiver : undefined;
    return values?.every((operand) => {
      let value = operand;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      if (rules.isUndefinedOrNull(value)) return true;
      const own = rules.openCarrierIsOwn(value);
      if (own === undefined && !rules.isPhase1(value)) return false;
      const boxes = operand !== receiver && rules.boxesOntoCarrier(value) && !isRewrittenParameter(value);
      const carried = own ?? (isCarrierValue(value) || boxes);
      return carried || rules.refuse("expr-object-static-operand", value);
    });
  };

  return {
    plan,
    isLiteralDefine: (call) => objectStatics.isLiteralDefine(plan(call)),
    lowersToCarrier,
    answersBoolean,
    tableMayReach: unitCallsTable,
    holdsCarrier,
    compareVerdict: (expr, nullCompare, isUndefined) => {
      const sides = [expr.left, expr.right];
      const folds = nullComparisonFolds(expr.operatorToken.kind, "dynamic");
      if (!sides.some(lowersToCarrier)) {
        // (#7339) A loose `null` compare on a dynamic module binding fails after the claim (main's gap, #7214);
        // in a program where an own-property test may make units reachable, it is refused instead.
        const gap = nullCompare && !folds && sides.some(holdsCarrier);
        return gap && fileCallsTest(expr.getSourceFile()) ? "refused" : undefined;
      }
      if (nullCompare) return folds ? "folded" : "refused";
      return sides.some(isUndefined) ? "folded" : undefined;
    },
    admitsCarrierUse: (e, refuse) => {
      const chained = ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e);
      if (chained && e.questionDotToken !== undefined && lowersToCarrier(e.expression)) {
        return refuse("expr-carrier-optional-chain", e);
      }
      if (readsInheritedMember(e)) return refuse("expr-carrier-inherited-member", e);
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
