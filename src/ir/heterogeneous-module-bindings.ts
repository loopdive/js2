// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Binding-identity analysis for primitive-initialized module bindings whose
 * compatibility slot must widen after a heterogeneous assignment.
 *
 * This lives beside the IR module-binding resolver because both sides of the
 * compile-once boundary must consume the same verdict:
 *
 * - direct codegen allocates the legacy `__mod_*` slot as `externref`;
 * - IR selection must not claim that slot as an `f64`/`i32` binding while its
 *   dynamic read/write coercions remain outside the admitted module surface.
 *
 * The analysis is registry-free and queries only the TypeOracle. That keeps it
 * usable by both checker and in-house oracle lanes without importing codegen
 * into IR.
 */
import { TsCheckerOracle, type JsTag, type TypeOracle } from "../checker/oracle.js";
import { ts } from "../ts-api.js";

type HeterogeneousBindingOracle = Pick<TypeOracle, "staticJsTypeOf" | "variableDeclarationOf">;
type HeterogeneousBindingQuerySource = ts.TypeChecker | HeterogeneousBindingOracle;

const checkerOracles = new WeakMap<ts.TypeChecker, HeterogeneousBindingOracle>();
const analysisCache = new WeakMap<object, WeakMap<ts.SourceFile, ReadonlySet<string>>>();

function queryOracle(source: HeterogeneousBindingQuerySource): HeterogeneousBindingOracle {
  if ("staticJsTypeOf" in source && "variableDeclarationOf" in source) return source;
  let oracle = checkerOracles.get(source);
  if (!oracle) {
    oracle = new TsCheckerOracle(source);
    checkerOracles.set(source, oracle);
  }
  return oracle;
}

/** Primitive initializers whose specialized Wasm slots cannot hold another JS tag. */
export const HETEROGENEOUS_PRIMITIVE_SLOT_TAGS: ReadonlySet<JsTag> = new Set<JsTag>([
  "number",
  "string",
  "boolean",
  "bigint",
]);

/** True when `node` is hoisted to module scope, outside every function/class owner. */
function isModuleScoped(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined && !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isConstructorDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isModuleDeclaration(parent)
    ) {
      return false;
    }
  }
  return true;
}

/** Whether `assigned` can outgrow the specialized slot selected for `declTag`. */
function assignmentWidens(oracle: HeterogeneousBindingOracle, declTag: JsTag, assigned: ts.Expression): boolean {
  if (assigned.kind === ts.SyntaxKind.ThisKeyword) return true;
  const assignedTag = oracle.staticJsTypeOf(assigned);
  // `mixed` is unconstrainable, not evidence that the value keeps declTag.
  return assignedTag === "mixed" || assignedTag !== declTag;
}

/** True when `node` sits in the dynamically-resolved body of a `with`. */
function isInsideWithBody(node: ts.Node): boolean {
  let previous: ts.Node | undefined;
  for (let current: ts.Node | undefined = node; current; previous = current, current = current.parent) {
    if (previous !== undefined && ts.isWithStatement(current) && current.statement === previous) return true;
  }
  return false;
}

/** Module-scoped `var`/`let` declarations keyed by their source binding name. */
function collectModuleScopedVarsByName(sourceFile: ts.SourceFile): Map<string, ts.VariableDeclaration> {
  const byName = new Map<string, ts.VariableDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isModuleScoped(node)) {
      if (!byName.has(node.name.text)) byName.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return byName;
}

/**
 * Names of module bindings whose primitive initializer cannot constrain every
 * later plain assignment.
 *
 * The walk crosses nested functions because they may write module bindings.
 * Ordinary targets resolve by declaration identity. Only inside a `with` body,
 * where the checker intentionally cannot resolve a bare identifier, is a
 * source-local name fallback admissible.
 */
export function collectHeterogeneouslyAssignedModuleVarNames(
  source: HeterogeneousBindingQuerySource,
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const oracle = queryOracle(source);
  let bySource = analysisCache.get(oracle);
  if (!bySource) {
    bySource = new WeakMap();
    analysisCache.set(oracle, bySource);
  }
  const cached = bySource.get(sourceFile);
  if (cached) return cached;

  const widened = new Set<string>();
  const propagationEdges = new Map<string, string[]>();
  const moduleVarsByName = sourceFile.text.includes("with")
    ? collectModuleScopedVarsByName(sourceFile)
    : new Map<string, ts.VariableDeclaration>();
  const declTagCache = new WeakMap<ts.VariableDeclaration, JsTag | "none">();

  const initializerTagOf = (declaration: ts.VariableDeclaration): JsTag | "none" => {
    const cachedTag = declTagCache.get(declaration);
    if (cachedTag !== undefined) return cachedTag;
    let tag: JsTag | "none" = "none";
    if (
      declaration.type === undefined &&
      declaration.initializer &&
      ts.isIdentifier(declaration.name) &&
      isModuleScoped(declaration)
    ) {
      // An explicit TypeScript annotation is the representation contract. The
      // diagnostics-off compiler consistently treats an assignment that
      // violates it as user error; widening from the initializer would make
      // codegen disagree with the checker-backed IR binding ABI. JavaScript
      // and inferred TypeScript declarations remain fully flow-widened.
      const candidate = oracle.staticJsTypeOf(declaration.initializer);
      if (candidate !== "mixed" && HETEROGENEOUS_PRIMITIVE_SLOT_TAGS.has(candidate)) tag = candidate;
    }
    declTagCache.set(declaration, tag);
    return tag;
  };

  const unwrapIdentifier = (expression: ts.Expression): ts.Identifier | undefined => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    return ts.isIdentifier(current) ? current : undefined;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      !widened.has(node.left.text)
    ) {
      const declaration = oracle.variableDeclarationOf(node.left);
      if (declaration !== undefined && declaration.getSourceFile() === sourceFile) {
        const declTag = initializerTagOf(declaration);
        if (declTag !== "none") {
          if (assignmentWidens(oracle, declTag, node.right)) widened.add(node.left.text);
          const rhs = unwrapIdentifier(node.right);
          if (rhs !== undefined) {
            const rhsDeclaration = oracle.variableDeclarationOf(rhs);
            if (
              rhsDeclaration !== undefined &&
              ts.isIdentifier(rhsDeclaration.name) &&
              rhsDeclaration.getSourceFile() === sourceFile &&
              isModuleScoped(rhsDeclaration)
            ) {
              const targets = propagationEdges.get(rhsDeclaration.name.text) ?? [];
              targets.push(node.left.text);
              propagationEdges.set(rhsDeclaration.name.text, targets);
            }
          }
        }
      } else if (declaration === undefined && moduleVarsByName.size > 0 && isInsideWithBody(node.left)) {
        // `with` can dynamically resolve the target to the object environment,
        // so only an unresolved identifier may use this deliberately name-keyed
        // fallback. A normally resolved local or cross-file binding of the same
        // name cannot widen it.
        const named = moduleVarsByName.get(node.left.text);
        if (named !== undefined && initializerTagOf(named) !== "none") widened.add(node.left.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // A specialized binding can also receive values through another mutable
  // binding. Resolve that small dependency graph to keep dynamic assignments
  // in the same externref carrier (`var a = false; var b = a; a = null;
  // b = a`). The direct pass above seeds the graph; propagation is bounded by
  // the number of module bindings and does not inspect unrelated locals.
  const pending = [...widened];
  for (let index = 0; index < pending.length; index++) {
    const sourceName = pending[index]!;
    for (const target of propagationEdges.get(sourceName) ?? []) {
      if (widened.has(target)) continue;
      widened.add(target);
      pending.push(target);
    }
  }
  bySource.set(sourceFile, widened);
  return widened;
}

/** Whether one exact declaration owns a legacy slot widened by the analysis. */
export function heterogeneousAssignmentRetypesModuleBinding(
  source: HeterogeneousBindingQuerySource,
  declaration: ts.VariableDeclaration,
): boolean {
  return (
    ts.isIdentifier(declaration.name) &&
    collectHeterogeneouslyAssignedModuleVarNames(source, declaration.getSourceFile()).has(declaration.name.text)
  );
}
