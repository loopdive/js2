// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4222 ES5 residual) Eligibility proof for the bounded `new Array(n)`
// sparse carrier. Kept separate from the legacy array-hole flag scan so the
// optional carrier proof cannot make the generic vec path larger or broader.

import { forEachChild, ts } from "../ts-api.js";
import type { TypeOracle } from "../checker/oracle.js";
import type { CodegenContext } from "./context/types.js";

interface HoleyCandidate {
  expr: ts.NewExpression;
  declaration: ts.VariableDeclaration;
}

interface CarrierUses {
  filters: ts.CallExpression[];
  stores: ts.BinaryExpression[];
}

type StatementContainer = ts.SourceFile | ts.Block;

interface DirectStatement {
  container: StatementContainer;
  statement: ts.Statement;
  index: number;
}

/**
 * Populate the exact node identities that may materialize the dedicated sparse
 * carrier. This does not consult the module-global dirty flags: those flags
 * protect generic vec code, whereas this proof follows only the actual
 * declaration-to-filter execution path and rejects any reachable effect it
 * cannot model.
 */
export function planHoleyArrayCarrier(ctx: CodegenContext, root: ts.Node): void {
  const oracle = ctx.oracle;
  if (
    oracle === undefined ||
    ctx.holeyArrayDeclarations === undefined ||
    ctx.holeyArrayConstructorNodes === undefined ||
    ctx.holeyArrayFilterCallNodes === undefined
  ) {
    return;
  }

  // (#3437) Cheap textual pre-gate, mirroring `source-scan-predicates.ts`.
  // This pass is a SECOND full-tree traversal on top of `scanForArrayHoles`,
  // and the `check:harness-compile-budget` meter counts shared-`forEachChild`
  // invocations — so an unconditional walk here is a per-file scan the gate is
  // specifically built to catch (measured +3919 units on a fixture that has no
  // candidate at all, against a ceiling main had already consumed 96% of).
  //
  // Sound because a carrier requires BOTH halves textually: `carrierUses`
  // returns undefined unless `filters.length > 0`, and `isEligibleArrayConstructor`
  // demands a literal `new Array(<numeric literal>)`. Absence of either
  // substring is proof no candidate exists, so skipping is not a heuristic.
  const text = root.getSourceFile().text;
  if (!text.includes("Array") || !text.includes("filter")) return;

  const { candidates, references } = collectCandidates(oracle, root);
  for (const { expr, declaration } of candidates) {
    const uses = carrierUses(references, declaration);
    if (!uses || !candidateExecutionIsSafe(oracle, declaration, uses)) continue;
    ctx.holeyArrayDeclarations.add(declaration);
    ctx.holeyArrayConstructorNodes.add(expr);
    for (const filter of uses.filters) ctx.holeyArrayFilterCallNodes.add(filter);
  }
}

/**
 * TWO PHASE, and the split is load-bearing for compile time (#3437).
 *
 * Phase 1 finds the `new Array(<literal>)` candidates. Phase 2 collects the
 * identifier references, and runs ONLY if phase 1 found something — which for
 * almost every real file means not at all.
 *
 * The single-pass version called `oracle.variableDeclarationOf` on EVERY
 * identifier in the file before it knew whether any candidate existed. On
 * harness-shaped input that is thousands of checker queries per file for a
 * feature that applies to none of them: measured 111,568 → 131,151 units of
 * `check:harness-compile-budget` work (+17.5%, over its +15% ceiling).
 *
 * Phase 2 also filters by NAME before querying. Only a candidate's own binding
 * can matter, so an identifier whose text matches no candidate name is skipped
 * without touching the checker at all.
 */
function collectCandidates(
  oracle: TypeOracle,
  root: ts.Node,
): { candidates: HoleyCandidate[]; references: Map<ts.VariableDeclaration, ts.Identifier[]> } {
  const candidates: HoleyCandidate[] = [];
  const references = new Map<ts.VariableDeclaration, ts.Identifier[]>();

  const findCandidates = (node: ts.Node): void => {
    if (isEligibleArrayConstructor(oracle, node)) {
      const declaration = directVariableBinding(node);
      if (declaration && declaration.type === undefined) candidates.push({ expr: node, declaration });
    }
    forEachChild(node, findCandidates);
  };
  findCandidates(root);
  if (candidates.length === 0) return { candidates, references };

  const candidateNames = new Set(candidates.map((c) => (c.declaration.name as ts.Identifier).text));
  const collectReferences = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && candidateNames.has(node.text)) {
      const declaration = oracle.variableDeclarationOf(node);
      if (declaration) {
        const uses = references.get(declaration) ?? [];
        uses.push(node);
        references.set(declaration, uses);
      }
    }
    forEachChild(node, collectReferences);
  };
  collectReferences(root);
  return { candidates, references };
}

function isEligibleArrayConstructor(oracle: TypeOracle, node: ts.Node): node is ts.NewExpression {
  if (
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "Array" ||
    (node.typeArguments?.length ?? 0) !== 0 ||
    node.arguments?.length !== 1 ||
    ts.isSpreadElement(node.arguments[0]!)
  ) {
    return false;
  }
  const declarations = oracle.declarationsOf(node.expression);
  if (declarations.length > 0 && !declarations.every((decl) => decl.getSourceFile().isDeclarationFile)) return false;
  return isBoundedLengthLiteral(node.arguments[0]!);
}

function directVariableBinding(expr: ts.NewExpression): ts.VariableDeclaration | undefined {
  let current: ts.Node = expr;
  let parent = current.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression?.(parent) ||
      ts.isSatisfiesExpression?.(parent)) &&
    (parent as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression === current
  ) {
    current = parent;
    parent = current.parent;
  }
  return parent && ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name)
    ? parent
    : undefined;
}

function isBoundedLengthLiteral(expr: ts.Expression): boolean {
  if (!ts.isNumericLiteral(expr)) return false;
  const value = Number(expr.text.replace(/_/g, ""));
  return Number.isInteger(value) && value >= 0 && value <= 0x7fff_ffff;
}

function carrierUses(
  references: ReadonlyMap<ts.VariableDeclaration, readonly ts.Identifier[]>,
  declaration: ts.VariableDeclaration,
): CarrierUses | undefined {
  const filters: ts.CallExpression[] = [];
  const stores: ts.BinaryExpression[] = [];
  for (const use of references.get(declaration) ?? []) {
    if (isDeclarationNameUse(use, declaration)) continue;
    const parent = use.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === use &&
      parent.name.text === "filter" &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      filters.push(parent.parent);
      continue;
    }
    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === use &&
      ts.isBinaryExpression(parent.parent) &&
      parent.parent.left === parent &&
      parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      stores.push(parent.parent);
      continue;
    }
    return undefined;
  }
  return filters.length > 0 ? { filters, stores } : undefined;
}

function isDeclarationNameUse(use: ts.Identifier, declaration: ts.VariableDeclaration): boolean {
  return (
    use === declaration.name ||
    (ts.isVariableDeclaration(use.parent) &&
      use.parent.name === use &&
      use.parent.pos === declaration.pos &&
      use.parent.end === declaration.end &&
      use.parent.getSourceFile() === declaration.getSourceFile())
  );
}

function candidateExecutionIsSafe(oracle: TypeOracle, declaration: ts.VariableDeclaration, uses: CarrierUses): boolean {
  const declarationSite = directStatementOf(declaration);
  if (
    !declarationSite ||
    !ts.isVariableStatement(declarationSite.statement) ||
    declarationSite.statement.declarationList.declarations.length !== 1
  ) {
    return false;
  }

  const filterSites = uses.filters.map((filter) => ({ filter, site: directStatementOf(filter) }));
  if (
    filterSites.some(
      ({ filter, site }) =>
        !site ||
        site.container !== declarationSite.container ||
        site.index <= declarationSite.index ||
        !directFilterStatement(filter, site.statement),
    )
  ) {
    return false;
  }

  const callbacks = filterSites.map(({ filter }) => callbackFunctionOf(oracle, filter.arguments[0]));
  if (callbacks.some((callback) => callback === undefined)) return false;
  const storeSet = new Set(uses.stores);
  if (!callbacks.every((callback) => callbackBodyIsSafe(callback!, storeSet))) return false;

  const lastFilterIndex = Math.max(...filterSites.map(({ site }) => site!.index));
  const directStores = new Set<ts.Statement>();
  for (const store of uses.stores) {
    const storeSite = directStatementOf(store);
    if (storeSite && storeSite.container === declarationSite.container) {
      if (
        storeSite.index <= declarationSite.index ||
        storeSite.index > lastFilterIndex ||
        !directStoreStatement(store, storeSite.statement) ||
        !isSafeCarrierStore(store)
      ) {
        return false;
      }
      directStores.add(storeSite.statement);
      continue;
    }
    if (!callbacks.some((callback) => callback !== undefined && containsNode(callback, store))) return false;
  }

  const filterStatements = new Set(filterSites.map(({ site }) => site!.statement));
  for (let index = 0; index <= lastFilterIndex; index++) {
    const statement = declarationSite.container.statements[index]!;
    if (statement === declarationSite.statement || filterStatements.has(statement) || directStores.has(statement))
      continue;
    if (!isInertDefinitionStatement(oracle, statement)) return false;
  }
  return true;
}

function directStatementOf(node: ts.Node): DirectStatement | undefined {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent) && !ts.isBlock(current.parent)) current = current.parent;
  const container = current.parent;
  if ((!ts.isSourceFile(container) && !ts.isBlock(container)) || !ts.isStatement(current)) return undefined;
  const index = container.statements.indexOf(current);
  return index < 0 ? undefined : { container, statement: current, index };
}

function directFilterStatement(call: ts.CallExpression, statement: ts.Statement): boolean {
  if (ts.isExpressionStatement(statement)) return unwrapTransparent(statement.expression) === call;
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return false;
  return unwrapTransparent(statement.declarationList.declarations[0]?.initializer ?? statement) === call;
}

function directStoreStatement(store: ts.BinaryExpression, statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) && unwrapTransparent(statement.expression) === store;
}

function isSafeCarrierStore(store: ts.BinaryExpression): boolean {
  const target = unwrapTransparent(store.left);
  return (
    ts.isElementAccessExpression(target) &&
    target.argumentExpression !== undefined &&
    ts.isNumericLiteral(unwrapTransparent(target.argumentExpression)) &&
    isInertExpression(store.right)
  );
}

function isInertDefinitionStatement(oracle: TypeOracle, statement: ts.Statement): boolean {
  if (ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement)) return true;
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.every(
      (decl) => ts.isIdentifier(decl.name) && (decl.initializer === undefined || isInertExpression(decl.initializer)),
    );
  }
  if (ts.isExpressionStatement(statement)) {
    return isHarmlessFunctionDefinition(oracle, statement.expression) || isInertExpression(statement.expression);
  }
  return false;
}

function isHarmlessFunctionDefinition(oracle: TypeOracle, expr: ts.Expression): boolean {
  const inner = unwrapTransparent(expr) as ts.Expression;
  if (
    !ts.isBinaryExpression(inner) ||
    inner.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !isInertExpression(inner.right)
  ) {
    return false;
  }
  const lhs = unwrapTransparent(inner.left);
  if (!ts.isPropertyAccessExpression(lhs)) return false;
  const root = functionRootOf(lhs.expression);
  return root !== undefined && oracle.declarationsOf(root).some((declaration) => ts.isFunctionDeclaration(declaration));
}

function functionRootOf(node: ts.Expression): ts.Identifier | undefined {
  let current = unwrapTransparent(node) as ts.Expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current : undefined;
}

function callbackFunctionOf(
  oracle: TypeOracle,
  argument: ts.Expression | undefined,
): ts.FunctionLikeDeclaration | undefined {
  if (!argument) return undefined;
  const direct = unwrapTransparent(argument) as ts.Expression;
  if (ts.isFunctionExpression(direct) || ts.isArrowFunction(direct)) return direct;
  if (!ts.isIdentifier(direct)) return undefined;
  const declaredFunction = oracle
    .declarationsOf(direct)
    .find(
      (declaration): declaration is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(declaration) && declaration.body !== undefined,
    );
  if (declaredFunction) return declaredFunction;
  const variable = oracle.variableDeclarationOf(direct);
  if (!variable || !variable.initializer) return undefined;
  const initializer = unwrapTransparent(variable.initializer) as ts.Expression;
  return ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer) ? initializer : undefined;
}

function callbackBodyIsSafe(fn: ts.FunctionLikeDeclaration, stores: ReadonlySet<ts.BinaryExpression>): boolean {
  if (!fn.body) return false;
  const statementIsSafe = (statement: ts.Statement): boolean => {
    if (ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement)) return true;
    if (ts.isBlock(statement)) return statement.statements.every(statementIsSafe);
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.every(
        (decl) => ts.isIdentifier(decl.name) && (decl.initializer === undefined || isInertExpression(decl.initializer)),
      );
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      return statement.expression === undefined || isInertExpression(statement.expression);
    }
    if (ts.isIfStatement(statement)) {
      return (
        isInertExpression(statement.expression) &&
        statementIsSafe(statement.thenStatement) &&
        (statement.elseStatement === undefined || statementIsSafe(statement.elseStatement))
      );
    }
    if (ts.isExpressionStatement(statement)) {
      const expression = unwrapTransparent(statement.expression) as ts.Expression;
      return (
        (stores.has(expression as ts.BinaryExpression) && isSafeCarrierStore(expression as ts.BinaryExpression)) ||
        isScalarBindingMutation(expression) ||
        isInertExpression(expression)
      );
    }
    return false;
  };
  return ts.isBlock(fn.body) ? fn.body.statements.every(statementIsSafe) : isInertExpression(fn.body);
}

function isScalarBindingMutation(expr: ts.Expression): boolean {
  const inner = unwrapTransparent(expr) as ts.Expression;
  const mutableIdentifier = (node: ts.Expression): boolean => ts.isIdentifier(node);
  if (ts.isPrefixUnaryExpression(inner) || ts.isPostfixUnaryExpression(inner)) {
    return (
      (inner.operator === ts.SyntaxKind.PlusPlusToken || inner.operator === ts.SyntaxKind.MinusMinusToken) &&
      mutableIdentifier(inner.operand)
    );
  }
  return (
    ts.isBinaryExpression(inner) &&
    inner.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    inner.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    mutableIdentifier(inner.left) &&
    isInertExpression(inner.right)
  );
}

function containsNode(ancestor: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function isInertExpression(expr: ts.Expression): boolean {
  const inner = unwrapTransparent(expr) as ts.Expression;
  if (
    ts.isIdentifier(inner) ||
    inner.kind === ts.SyntaxKind.ThisKeyword ||
    inner.kind === ts.SyntaxKind.NullKeyword ||
    inner.kind === ts.SyntaxKind.TrueKeyword ||
    inner.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isLiteralExpression(inner) ||
    ts.isRegularExpressionLiteral(inner) ||
    ts.isNoSubstitutionTemplateLiteral(inner) ||
    ts.isFunctionExpression(inner) ||
    ts.isArrowFunction(inner)
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements.every(
      (element) => ts.isOmittedExpression(element) || (!ts.isSpreadElement(element) && isInertExpression(element)),
    );
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) return false;
      if (ts.isPropertyAssignment(property))
        return isSimplePropertyName(property.name) && isInertExpression(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) return isSimplePropertyName(property.name);
      return (
        (ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)) &&
        isSimplePropertyName(property.name)
      );
    });
  }
  if (ts.isPrefixUnaryExpression(inner)) {
    return (
      inner.operator !== ts.SyntaxKind.PlusPlusToken &&
      inner.operator !== ts.SyntaxKind.MinusMinusToken &&
      isInertExpression(inner.operand)
    );
  }
  if (ts.isTypeOfExpression(inner) || ts.isVoidExpression(inner)) return isInertExpression(inner.expression);
  if (ts.isConditionalExpression(inner)) {
    return (
      isInertExpression(inner.condition) && isInertExpression(inner.whenTrue) && isInertExpression(inner.whenFalse)
    );
  }
  if (ts.isBinaryExpression(inner)) {
    return (
      (inner.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
        inner.operatorToken.kind > ts.SyntaxKind.LastAssignment) &&
      inner.operatorToken.kind !== ts.SyntaxKind.InKeyword &&
      inner.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword &&
      isInertExpression(inner.left) &&
      isInertExpression(inner.right)
    );
  }
  if (ts.isTemplateExpression(inner)) return inner.templateSpans.every((span) => isInertExpression(span.expression));
  return false;
}

function isSimplePropertyName(name: ts.PropertyName | undefined): boolean {
  return name !== undefined && !ts.isComputedPropertyName(name);
}

function unwrapTransparent(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression?.(current) || ts.isSatisfiesExpression?.(current)) {
      current = (current as ts.TypeAssertion | ts.SatisfiesExpression).expression;
      continue;
    }
    return current;
  }
}
