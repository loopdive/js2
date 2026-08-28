// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2847 — recover boolean brands for late/inferred struct fields.
 *
 * Untyped JavaScript commonly grows object shapes outside their constructor.
 * The checker can lower those fields to a plain i32 even when every write is
 * boolean (Acorn's `node.generator = this.eat(...)` family).  The carrier is
 * correct, but losing `{ boolean: true }` makes the host getter box it as 0/1.
 *
 * This finalize-time pass is deliberately whole-program and conservative: a
 * property name is branded only when every statically visible definition/write
 * of that name is boolean-producing.  A numeric `computed` field anywhere in
 * the same module therefore prevents global `computed` branding; no field-name
 * allowlist or Acorn-specific knowledge is involved.
 */
import { isSyntacticallyBooleanExpr } from "../checker/oracle.js";
import { forEachChild, ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { inferBooleanParamSlots, paramUnboxAbiEnabled } from "./param-unbox-abi.js";

type FunctionLike = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionLikeWithBody(node: ts.Node): node is FunctionLike {
  return ts.isFunctionLike(node) && "body" in node && node.body !== undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function assignmentPropertyName(lhs: ts.Expression): string | undefined {
  const target = unwrap(lhs);
  if (ts.isPropertyAccessExpression(target) && !ts.isPrivateIdentifier(target.name)) return target.name.text;
  if (
    ts.isElementAccessExpression(target) &&
    target.argumentExpression &&
    (ts.isStringLiteral(target.argumentExpression) || ts.isNumericLiteral(target.argumentExpression))
  ) {
    return target.argumentExpression.text;
  }
  return undefined;
}

function functionBindingName(fn: FunctionLike): string | undefined {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isBinaryExpression(parent) && parent.right === fn) return assignmentPropertyName(parent.left);
  if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
  return undefined;
}

function statementDefinitelyReturns(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return statementsDefinitelyReturn(stmt.statements);
  if (ts.isIfStatement(stmt) && stmt.elseStatement) {
    return statementDefinitelyReturns(stmt.thenStatement) && statementDefinitelyReturns(stmt.elseStatement);
  }
  return false;
}

function statementsDefinitelyReturn(statements: readonly ts.Statement[]): boolean {
  return statements.some(statementDefinitelyReturns);
}

function ownReturnExpressions(fn: FunctionLike): ts.Expression[] | undefined {
  if (!ts.isBlock(fn.body)) return [fn.body];
  if (!statementsDefinitelyReturn(fn.body.statements)) return undefined;
  const returns: ts.Expression[] = [];
  let bareReturn = false;
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLikeWithBody(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      else bareReturn = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(fn.body, visit);
  return !bareReturn && returns.length > 0 ? returns : undefined;
}

function callName(expr: ts.CallExpression): string | undefined {
  const callee = unwrap(expr.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  // Prototype-style boolean helpers are invoked as `this.method()`. Do not
  // aggregate arbitrary `obj.method()` calls by textual property name: a user
  // `find()` returning boolean and `array.find()` returning a number are
  // unrelated symbols and must not jointly brand a numeric field as boolean.
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
    !ts.isPrivateIdentifier(callee.name)
  ) {
    return callee.name.text;
  }
  return undefined;
}

function expressionIsBoolean(
  ctx: CodegenContext,
  expr: ts.Expression,
  booleanFunctions: ReadonlySet<string>,
  booleanValues: ReadonlySet<string> = new Set(),
): boolean {
  const value = unwrap(expr);
  if (ts.isIdentifier(value) && booleanValues.has(value.text)) return true;
  if (ctx.oracle.isBooleanProducing(value)) return true;
  if (ts.isCallExpression(value)) {
    const name = callName(value);
    if (name && booleanFunctions.has(name)) return true;
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return (
      expressionIsBoolean(ctx, value.left, booleanFunctions, booleanValues) &&
      expressionIsBoolean(ctx, value.right, booleanFunctions, booleanValues)
    );
  }
  if (ts.isConditionalExpression(value)) {
    return (
      expressionIsBoolean(ctx, value.whenTrue, booleanFunctions, booleanValues) &&
      expressionIsBoolean(ctx, value.whenFalse, booleanFunctions, booleanValues)
    );
  }
  return isSyntacticallyBooleanExpr(value, (name) => name === "Boolean" || booleanFunctions.has(name));
}

function inferBooleanFunctionNames(ctx: CodegenContext, byName: ReadonlyMap<string, FunctionLike[]>): Set<string> {
  const returnsByFunction = new Map<FunctionLike, ts.Expression[] | undefined>();
  for (const functions of byName.values()) {
    for (const fn of functions) returnsByFunction.set(fn, ownReturnExpressions(fn));
  }
  const candidates = new Set(byName.keys());
  let changed = true;
  let safety = candidates.size + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const name of [...candidates]) {
      const functions = byName.get(name) ?? [];
      const allBoolean =
        functions.length > 0 &&
        functions.every((fn) => {
          const returns = returnsByFunction.get(fn);
          return returns !== undefined && returns.every((expr) => expressionIsBoolean(ctx, expr, candidates));
        });
      if (!allBoolean) {
        candidates.delete(name);
        changed = true;
      }
    }
  }
  return candidates;
}

/**
 * (#4406 Phase 3) The callee name of ANY call/new, whatever the receiver —
 * `m(…)`, `o.m(…)`, `new m(…)`. Deliberately broader than {@link callName}:
 * the return verdict must not conflate a user `find()` with `array.find()`
 * (that would brand a numeric field boolean), but the PARAMETER verdict is
 * conjunctive over call sites, so folding unrelated `find` sites in can only
 * withdraw slots, never grant one wrongly.
 */
function anyCalleeName(expr: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = unwrap(expr.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && !ts.isPrivateIdentifier(callee.name)) return callee.name.text;
  return undefined;
}

interface BooleanFlowFacts {
  functionsByName: Map<string, FunctionLike[]>;
  definitions: Map<string, (ts.Expression | undefined)[]>;
  calls: Map<string, ts.Expression[][]>;
  /** (#4406 Phase 3) {@link calls}, widened to every receiver — see {@link anyCalleeName}. */
  anyCalls: Map<string, ts.Expression[][]>;
  parameters: { name: string; owner: string; index: number; initializer?: ts.Expression }[];
  propertyWrites: { name?: string; value?: ts.Expression; typedBoolean?: boolean }[];
}

/**
 * Index the source once for all three boolean-brand analyses. Keeping these
 * facts in one traversal is important for harness-shaped inputs: separate
 * function, value, and property scans each walked the same large prelude.
 */
function collectBooleanFlowFacts(ctx: CodegenContext, sourceFiles: readonly ts.SourceFile[]): BooleanFlowFacts {
  const facts: BooleanFlowFacts = {
    functionsByName: new Map(),
    definitions: new Map(),
    calls: new Map(),
    anyCalls: new Map(),
    parameters: [],
    propertyWrites: [],
  };
  const recordDefinition = (name: string, value: ts.Expression | undefined): void => {
    const list = facts.definitions.get(name);
    if (list) list.push(value);
    else facts.definitions.set(name, [value]);
  };

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (isFunctionLikeWithBody(node)) {
        const name = functionBindingName(node);
        if (name) {
          const list = facts.functionsByName.get(name);
          if (list) list.push(node);
          else facts.functionsByName.set(name, [node]);
        }
      }

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const anyName = anyCalleeName(node);
        if (anyName) {
          const anyArgs = [...(node.arguments ?? [])];
          const anyList = facts.anyCalls.get(anyName);
          if (anyList) anyList.push(anyArgs);
          else facts.anyCalls.set(anyName, [anyArgs]);
        }
      }

      if (ts.isCallExpression(node)) {
        const name = callName(node);
        if (name) {
          const list = facts.calls.get(name);
          const args = [...node.arguments];
          if (list) list.push(args);
          else facts.calls.set(name, [args]);
        }
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        // An uninitialized local contributes no value by itself. If later
        // writes exist, infer from those writes; if none exist, the name never
        // becomes a candidate.
        if (node.initializer) recordDefinition(node.name.text, node.initializer);
      } else if (
        ts.isBinaryExpression(node) &&
        ts.isIdentifier(unwrap(node.left)) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        recordDefinition((unwrap(node.left) as ts.Identifier).text, node.right);
      } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        const owner = isFunctionLikeWithBody(node.parent) ? functionBindingName(node.parent) : undefined;
        if (owner) {
          facts.parameters.push({
            name: node.name.text,
            owner,
            index: node.parent.parameters.indexOf(node),
            ...(node.initializer ? { initializer: node.initializer } : {}),
          });
        } else {
          recordDefinition(node.name.text, undefined);
        }
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        facts.propertyWrites.push({
          name: assignmentPropertyName(node.left),
          ...(node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? { value: node.right } : {}),
        });
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        facts.propertyWrites.push({ name: assignmentPropertyName(node.operand) });
      } else if (ts.isPropertyAssignment(node)) {
        facts.propertyWrites.push({ name: propertyNameText(node.name), value: node.initializer });
      } else if (ts.isShorthandPropertyAssignment(node)) {
        facts.propertyWrites.push({ name: node.name.text, value: node.name });
      } else if (ts.isPropertyDeclaration(node)) {
        const name = propertyNameText(node.name);
        facts.propertyWrites.push(
          node.initializer
            ? { name, value: node.initializer }
            : { name, typedBoolean: ctx.oracle.typeFactOf(node).kind === "boolean" },
        );
      } else if (ts.isPropertySignature(node)) {
        facts.propertyWrites.push({
          name: propertyNameText(node.name),
          typedBoolean: ctx.oracle.typeFactOf(node).kind === "boolean",
        });
      }

      // Tokens and identifier/literal leaves cannot contain another fact.
      // Avoiding a no-op traversal call for each one matters on harness-sized
      // inputs with thousands of repeated property descriptors and call args.
      if (node.kind > ts.SyntaxKind.LastToken) forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return facts;
}

/**
 * Infer untyped local/parameter names that carry booleans. Name aggregation is
 * conservative across the whole module: every declaration, reassignment, and
 * observed call argument for that name must agree.
 */
function inferBooleanValueNames(
  ctx: CodegenContext,
  facts: BooleanFlowFacts,
  booleanFunctions: ReadonlySet<string>,
  // (#4406 Phase 3) Which call map feeds the parameter-flow half. `facts.calls`
  // is the shipped, `this.m()`-only one; the parameter ABI passes the widened
  // `facts.anyCalls` so a `recv.m(nonBoolean)` site cannot be invisible to a
  // verdict that narrows a CALLER. Working on a COPY of `facts.definitions`
  // rather than mutating it is what makes the two calls independent.
  callArgs: ReadonlyMap<string, ts.Expression[][]> = facts.calls,
): Set<string> {
  const definitions = new Map<string, (ts.Expression | undefined)[]>();
  for (const [name, values] of facts.definitions) definitions.set(name, [...values]);
  const record = (name: string, value: ts.Expression | undefined): void => {
    const list = definitions.get(name);
    if (list) list.push(value);
    else definitions.set(name, [value]);
  };
  for (const parameter of facts.parameters) {
    const values: (ts.Expression | undefined)[] = [];
    if (parameter.initializer) values.push(parameter.initializer);
    for (const args of callArgs.get(parameter.owner) ?? []) values.push(args[parameter.index]);
    if (values.length === 0) values.push(undefined);
    for (const value of values) record(parameter.name, value);
  }

  const candidates = new Set(definitions.keys());
  let changed = true;
  let safety = candidates.size + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const name of [...candidates]) {
      const values = definitions.get(name) ?? [];
      if (
        values.length === 0 ||
        !values.every((value) => value !== undefined && expressionIsBoolean(ctx, value, booleanFunctions, candidates))
      ) {
        candidates.delete(name);
        changed = true;
      }
    }
  }
  return candidates;
}

/** The two name-keyed verdicts this module's single traversal produces. */
export interface BooleanNameVerdicts {
  /** Property names whose complete visible source write set is boolean. */
  properties: Set<string>;
  /**
   * (#4406) Function NAMES that return a boolean on EVERY path — the greatest
   * fixpoint `inferBooleanFunctionNames` already computed for the property
   * verdict, published rather than discarded. `refinedTwinReturnType` uses it
   * to mint a typed-`this` twin whose wasm result is a boolean-branded `i32`
   * instead of an `externref` the caller has to unbox.
   */
  functions: Set<string>;
  /**
   * (#4406 Phase 3) Function NAME → the parameter SLOTS that only ever receive
   * booleans, across every call site in the program. The mirror of
   * {@link functions}: that one lets a callee return an unboxed boolean, this
   * one lets a caller PASS one. `refinedTwinParamTypes` consumes it.
   */
  paramSlots: Map<string, Set<number>>;
}

/**
 * Compute both boolean name verdicts in ONE traversal.
 *
 * The function verdict is a by-product of the property one — the property rule
 * needs "does `this.eat(x)` produce a boolean" to classify
 * `node.generator = this.eat(...)`, which is exactly the same question — so
 * publishing it costs nothing beyond the return shape.
 */
export function analyzeBooleanNames(ctx: CodegenContext, sourceFiles: readonly ts.SourceFile[]): BooleanNameVerdicts {
  const facts = collectBooleanFlowFacts(ctx, sourceFiles);
  const booleanFunctions = inferBooleanFunctionNames(ctx, facts.functionsByName);
  const booleanValues = inferBooleanValueNames(ctx, facts, booleanFunctions);
  const state = new Map<string, { saw: boolean; allBoolean: boolean }>();

  const record = (name: string | undefined, value: ts.Expression | undefined, typedBoolean?: boolean): void => {
    if (!name) return;
    const isBoolean =
      typedBoolean ?? (value !== undefined && expressionIsBoolean(ctx, value, booleanFunctions, booleanValues));
    const current = state.get(name);
    if (current) {
      current.saw = true;
      current.allBoolean &&= isBoolean;
    } else {
      state.set(name, { saw: true, allBoolean: isBoolean });
    }
  };

  for (const write of facts.propertyWrites) record(write.name, write.value, write.typedBoolean);

  // (#4406 Phase 3) The parameter verdict runs the value-name fixpoint a SECOND
  // time over the widened call map. It cannot reuse `booleanValues` above:
  // that one is fed by `facts.calls` (`this.m()` only), which is complete
  // enough to classify a RETURN but leaves `recv.m(nonBoolean)` invisible —
  // and this verdict narrows CALLERS, where an invisible site is a miscompile
  // rather than a missed optimisation.
  // It is also the one part of this module that is NOT free: a second fixpoint
  // plus a body walk per declaration. The return verdict was published
  // unconditionally because it was already computed; this one is skipped
  // outright when the flag is off, which is what keeps a flag-off compile both
  // byte-identical and no slower than before.
  const paramValues = paramUnboxAbiEnabled()
    ? inferBooleanValueNames(ctx, facts, booleanFunctions, facts.anyCalls)
    : undefined;
  return {
    properties: new Set([...state].filter(([, info]) => info.saw && info.allBoolean).map(([name]) => name)),
    functions: booleanFunctions,
    paramSlots:
      paramValues === undefined
        ? new Map<string, Set<number>>()
        : inferBooleanParamSlots({
            functionsByName: facts.functionsByName,
            callArgsByName: facts.anyCalls,
            isBoolean: (expr) => expressionIsBoolean(ctx, expr, booleanFunctions, paramValues),
          }),
  };
}

// (#4406 Phase 4) The property-only view `analyzeBooleanPropertyNames` is gone.
// Its single caller — the numeric analysis host's `excludeNames` — now asks for
// the FUNCTION verdict from the same traversal too, so the view had no consumer
// left and `check:dead-exports` would have flagged it.

/** Brand numeric struct fields whose complete source write set is boolean. */
export function recoverBooleanStructFieldBrands(ctx: CodegenContext): void {
  const booleanFields = ctx.booleanPropertyNames;
  if (booleanFields.size === 0) return;

  for (const fields of ctx.structFields.values()) {
    for (const field of fields) {
      if (
        (field.type.kind === "i32" || field.type.kind === "f64") &&
        !(field.type.kind === "i32" && field.type.boolean === true) &&
        !field.name.startsWith("$") &&
        booleanFields.has(field.name)
      ) {
        field.jsBoolean = true;
        if (field.type.kind === "i32") field.type.boolean = true;
      }
    }
  }
}
