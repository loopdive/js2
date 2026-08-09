// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4218 Phase 1) In-house binder — scope + symbol resolution over the TS AST
 * WITHOUT a `ts.TypeChecker`.
 *
 * This is the substrate for {@link InHouseOracle} (`inhouse-oracle.ts`), the
 * checker-free `TypeOracle` backend. It answers exactly one question —
 * "which declaration does this identifier reference?" — plus the cheap
 * single-assignment bookkeeping a syntactic type engine needs on top of it.
 *
 * ## Why a binder and not the checker
 *
 * `ctx.oracle`'s top consumers (`valueDeclarationOf`, `variableDeclarationOf`,
 * `declaredNameOf`, and the binding half of `typeFactOf`/`staticJsTypeOf`) are
 * ordinary lexical scope analysis, not type inference. The checker is a very
 * expensive way to ask them, and it is the one piece of the `typescript`
 * package that has no TS7 programmatic replacement (see the issue's Problem
 * section). Binding is ~400 lines; owning it here makes the checker droppable
 * for plain-JS inputs.
 *
 * ## Design
 *
 * - **One walk, lazy resolution.** `bind()` builds the scope tree and its
 *   declaration tables in a single pass. Identifier→binding resolution is then
 *   pointwise and memoized: walk `.parent` to the nearest scope node, then
 *   chain-lookup by name. Oracle queries are pointwise, so eagerly resolving
 *   every identifier in the file would be pure waste.
 * - **Assignment bookkeeping is deferred.** Assignment targets are collected
 *   during the walk and resolved AFTER the tree is complete, because hoisting
 *   means `x = 1` can precede the `let x` it writes to.
 * - **Conservative by construction.** Anything the binder is not sure about is
 *   reported as "no binding" (`undefined`), never as a guess — matching the
 *   oracle's `unresolvable`-over-guess contract.
 */
import { ts } from "../ts-api.js";

/** How a name was introduced. Mirrors the declaration syntax, not a type. */
export type BindingKind =
  | "var"
  | "let"
  | "const"
  | "function"
  | "class"
  | "parameter"
  | "catch"
  | "import"
  | "enum"
  | "namespace"
  | "type"
  | "implicit";

export interface Binding {
  readonly name: string;
  kind: BindingKind;
  /** Declaration a *value* query reports (undefined for type-only/implicit). */
  valueDeclaration: ts.Declaration | undefined;
  /** Every declaration that introduced this name in this scope. */
  readonly declarations: ts.Declaration[];
  /** The binding's name is bound by a destructuring pattern. */
  destructured: boolean;
  /**
   * Written anywhere other than its own declaration initializer — assignment,
   * `++`/`--`, `for (x of …)`, a second initialized `var`, or a parameter. A
   * single-assignment binding lets the type engine trust its initializer.
   */
  reassigned: boolean;
  /** Right-hand sides of every plain `x = <expr>` write (for the type join). */
  readonly assignedExpressions: ts.Expression[];
  /** `x++` / `x--` / `x += <numeric>` seen: contributes a numeric-ish write. */
  incremented: boolean;
  /** A write we could not characterize (destructuring target, `for-in`, …). */
  opaquelyWritten: boolean;
}

export type ScopeKind = "source" | "function" | "block" | "class";

export interface Scope {
  readonly kind: ScopeKind;
  readonly node: ts.Node;
  readonly parent: Scope | undefined;
  readonly bindings: Map<string, Binding>;
}

/** Scopes that `var` hoists to. */
function isVarScope(scope: Scope): boolean {
  return scope.kind === "source" || scope.kind === "function";
}

function isValueFunctionLike(node: ts.Node): node is ts.SignatureDeclaration {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return true;
    default:
      return false;
  }
}

/**
 * Does `node` introduce a lexical scope? Returns the kind, or `undefined` when
 * it does not. A function BODY block is deliberately NOT its own scope: params
 * and body `let`s cannot collide (that is an early error), so merging them
 * keeps the chain one link shorter with no resolution difference.
 */
function scopeKindOfNode(node: ts.Node): ScopeKind | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.SourceFile:
      return "source";
    case ts.SyntaxKind.ClassStaticBlockDeclaration:
      return "function";
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return "class";
    case ts.SyntaxKind.ModuleBlock:
    case ts.SyntaxKind.CaseBlock:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.CatchClause:
      return "block";
    case ts.SyntaxKind.Block: {
      const parent = node.parent;
      if (parent && isValueFunctionLike(parent) && (parent as ts.FunctionLikeDeclaration).body === node) {
        return undefined;
      }
      if (parent && parent.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) return undefined;
      return "block";
    }
    default:
      return isValueFunctionLike(node) ? "function" : undefined;
  }
}

/**
 * Is this identifier a REFERENCE to a binding (as opposed to a property name,
 * a label, a member name, or a declaration's own name)? Only reference
 * positions may resolve through the scope chain.
 */
export function isBindingReferencePosition(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return true;
  switch (parent.kind) {
    case ts.SyntaxKind.PropertyAccessExpression:
      return (parent as ts.PropertyAccessExpression).expression === id;
    case ts.SyntaxKind.QualifiedName:
      return (parent as ts.QualifiedName).left === id;
    case ts.SyntaxKind.PropertyAssignment:
      // `{ k: v }` — only `v` is a reference.
      return (parent as ts.PropertyAssignment).initializer === id;
    case ts.SyntaxKind.ShorthandPropertyAssignment:
      return true;
    case ts.SyntaxKind.BindingElement:
      // `{ a: b } = o` — `b` is the bound NAME (a declaration), `a` is a key.
      return false;
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.EnumMember:
    case ts.SyntaxKind.LabeledStatement:
    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement:
    case ts.SyntaxKind.ImportSpecifier:
    case ts.SyntaxKind.ExportSpecifier:
      return false;
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.NamespaceImport:
    case ts.SyntaxKind.ImportClause:
      // The declaration's own name is not a reference to an outer binding.
      return (parent as { name?: ts.Node }).name !== id;
    default:
      return true;
  }
}

/**
 * Per-source-file binding table. Construct once per `ts.SourceFile`; the
 * oracle caches instances in a WeakMap so a file is bound at most once.
 */
export class FileBinder {
  readonly sourceScope: Scope;
  private readonly scopeByNode = new Map<ts.Node, Scope>();
  private readonly resolutionCache = new WeakMap<ts.Identifier, Binding | null>();
  /** Deferred: assignment targets, resolved after the scope tree is complete. */
  private readonly pendingWrites: {
    id: ts.Identifier;
    rhs: ts.Expression | undefined;
    numericish: boolean;
    opaque: boolean;
  }[] = [];

  constructor(readonly sourceFile: ts.SourceFile) {
    this.sourceScope = this.createScope("source", sourceFile, undefined);
    this.walk(sourceFile, this.sourceScope);
    this.applyPendingWrites();
  }

  /** Nearest enclosing scope for any node (the node itself may be a scope). */
  scopeOf(node: ts.Node): Scope {
    for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
      const scope = this.scopeByNode.get(cur);
      if (scope) return scope;
    }
    return this.sourceScope;
  }

  /**
   * Resolve an identifier reference to its binding, or `undefined` when the
   * name is not bound anywhere in the file (a global / genuinely unresolvable)
   * or the identifier is not in a reference position.
   */
  resolve(id: ts.Identifier): Binding | undefined {
    const cached = this.resolutionCache.get(id);
    if (cached !== undefined) return cached ?? undefined;
    let found: Binding | undefined;
    if (isBindingReferencePosition(id)) {
      const name = id.text;
      for (let scope: Scope | undefined = this.scopeOf(id); scope; scope = scope.parent) {
        const binding = scope.bindings.get(name);
        if (binding) {
          found = binding;
          break;
        }
      }
    }
    this.resolutionCache.set(id, found ?? null);
    return found;
  }

  /** Resolve a bare NAME from a node's position (no reference-position test). */
  resolveNameAt(name: string, at: ts.Node): Binding | undefined {
    for (let scope: Scope | undefined = this.scopeOf(at); scope; scope = scope.parent) {
      const binding = scope.bindings.get(name);
      if (binding) return binding;
    }
    return undefined;
  }

  private createScope(kind: ScopeKind, node: ts.Node, parent: Scope | undefined): Scope {
    const scope: Scope = { kind, node, parent, bindings: new Map() };
    this.scopeByNode.set(node, scope);
    return scope;
  }

  private varScope(scope: Scope): Scope {
    let cur = scope;
    while (!isVarScope(cur) && cur.parent) cur = cur.parent;
    return cur;
  }

  private declare(
    name: string,
    kind: BindingKind,
    declaration: ts.Declaration | undefined,
    scope: Scope,
    options?: { destructured?: boolean; reassigned?: boolean },
  ): Binding {
    const existing = scope.bindings.get(name);
    if (existing) {
      if (declaration) existing.declarations.push(declaration);
      // A redeclaration (`var x = 1; var x = 2`) makes the first initializer
      // untrustworthy — treat it as a write.
      if (declaration && existing.valueDeclaration && declaration !== existing.valueDeclaration) {
        existing.reassigned = true;
        existing.opaquelyWritten = true;
      }
      if (!existing.valueDeclaration && declaration && kind !== "type") existing.valueDeclaration = declaration;
      if (existing.kind === "type" && kind !== "type") existing.kind = kind;
      if (options?.destructured) existing.destructured = true;
      if (options?.reassigned) existing.reassigned = true;
      return existing;
    }
    const binding: Binding = {
      name,
      kind,
      valueDeclaration: kind === "type" ? undefined : declaration,
      declarations: declaration ? [declaration] : [],
      destructured: options?.destructured ?? false,
      reassigned: options?.reassigned ?? false,
      assignedExpressions: [],
      incremented: false,
      opaquelyWritten: false,
    };
    scope.bindings.set(name, binding);
    return binding;
  }

  /** Declare every name bound by a binding name (identifier or pattern). */
  private declarePattern(
    name: ts.BindingName,
    kind: BindingKind,
    declaration: ts.Declaration,
    scope: Scope,
    destructured = false,
  ): void {
    if (ts.isIdentifier(name)) {
      this.declare(name.text, kind, declaration, scope, { destructured });
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      this.declarePattern(element.name, kind, element, scope, true);
    }
  }

  private variableKind(decl: ts.VariableDeclaration): BindingKind {
    const list = decl.parent;
    if (!list || !ts.isVariableDeclarationList(list)) return "var";
    if (list.flags & ts.NodeFlags.Const) return "const";
    if (list.flags & ts.NodeFlags.Let) return "let";
    return "var";
  }

  private walk(node: ts.Node, scope: Scope): void {
    // 1. Introduce declarations into the CURRENT scope.
    let childScope = scope;
    switch (node.kind) {
      case ts.SyntaxKind.VariableDeclaration: {
        const decl = node as ts.VariableDeclaration;
        const kind = this.variableKind(decl);
        const target = kind === "var" ? this.varScope(scope) : scope;
        this.declarePattern(decl.name, kind, decl, target);
        break;
      }
      case ts.SyntaxKind.FunctionDeclaration: {
        const decl = node as ts.FunctionDeclaration;
        if (decl.name) this.declare(decl.name.text, "function", decl, scope);
        break;
      }
      case ts.SyntaxKind.ClassDeclaration: {
        const decl = node as ts.ClassDeclaration;
        if (decl.name) this.declare(decl.name.text, "class", decl, scope);
        break;
      }
      case ts.SyntaxKind.EnumDeclaration: {
        const decl = node as ts.EnumDeclaration;
        this.declare(decl.name.text, "enum", decl, scope);
        break;
      }
      case ts.SyntaxKind.ModuleDeclaration: {
        const decl = node as ts.ModuleDeclaration;
        if (ts.isIdentifier(decl.name)) this.declare(decl.name.text, "namespace", decl, scope);
        break;
      }
      case ts.SyntaxKind.TypeAliasDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration: {
        const decl = node as ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
        this.declare(decl.name.text, "type", decl, scope);
        break;
      }
      case ts.SyntaxKind.ImportClause: {
        const clause = node as ts.ImportClause;
        if (clause.name) this.declare(clause.name.text, "import", clause, scope);
        break;
      }
      case ts.SyntaxKind.NamespaceImport: {
        const imp = node as ts.NamespaceImport;
        this.declare(imp.name.text, "import", imp, scope);
        break;
      }
      case ts.SyntaxKind.ImportSpecifier: {
        const spec = node as ts.ImportSpecifier;
        this.declare(spec.name.text, "import", spec, scope);
        break;
      }
      case ts.SyntaxKind.Parameter: {
        const param = node as ts.ParameterDeclaration;
        if (!ts.isIdentifier(param.name) || param.name.text !== "this") {
          // A parameter is written by the caller — never single-assignment.
          this.declarePattern(param.name, "parameter", param, scope);
          const binding = ts.isIdentifier(param.name) ? scope.bindings.get(param.name.text) : undefined;
          if (binding) binding.reassigned = true;
        }
        break;
      }
      default:
        break;
    }

    // 2. Open a child scope when this node introduces one.
    const kind = scopeKindOfNode(node);
    if (kind && node !== this.sourceFile) {
      childScope = this.createScope(kind, node, scope);
      if (kind === "class") {
        const cls = node as ts.ClassLikeDeclaration;
        // The class name is in scope inside its own body (§15.7.14).
        if (cls.name) this.declare(cls.name.text, "class", cls, childScope);
      } else if (node.kind === ts.SyntaxKind.FunctionExpression) {
        const fn = node as ts.FunctionExpression;
        if (fn.name) this.declare(fn.name.text, "function", fn, childScope);
      } else if (node.kind === ts.SyntaxKind.CatchClause) {
        const clause = node as ts.CatchClause;
        if (clause.variableDeclaration) {
          this.declarePattern(clause.variableDeclaration.name, "catch", clause.variableDeclaration, childScope);
        }
      }
      if (kind === "function" && node.kind !== ts.SyntaxKind.ArrowFunction) {
        // `arguments` is bound in every non-arrow function (no declaration).
        this.declare("arguments", "implicit", undefined, childScope);
      }
    }

    // 3. Record writes for the single-assignment analysis.
    this.recordWrites(node);

    ts.forEachChild(node, (child) => {
      this.walk(child, childScope);
    });
  }

  private recordWrites(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) {
        this.recordAssignmentTarget(node.left, node.right, false);
      } else if (isCompoundAssignmentOperator(op)) {
        this.recordAssignmentTarget(node.left, undefined, isNumericCompoundOperator(op));
      }
      return;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        this.recordAssignmentTarget(node.operand, undefined, true);
      }
      return;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const init = node.initializer;
      if (!ts.isVariableDeclarationList(init)) this.recordAssignmentTarget(init, undefined, false, true);
      return;
    }
  }

  private recordAssignmentTarget(
    target: ts.Expression,
    rhs: ts.Expression | undefined,
    numericish: boolean,
    opaque = false,
  ): void {
    let expr = target;
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr)
    ) {
      expr = expr.expression;
    }
    if (ts.isIdentifier(expr)) {
      this.pendingWrites.push({ id: expr, rhs, numericish, opaque });
      return;
    }
    // Destructuring assignment target: every identifier inside is written, and
    // we cannot characterize the written value cheaply.
    if (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) {
      const collect = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && isBindingReferencePosition(n)) {
          this.pendingWrites.push({ id: n, rhs: undefined, numericish: false, opaque: true });
          return;
        }
        ts.forEachChild(n, collect);
      };
      collect(expr);
    }
  }

  private applyPendingWrites(): void {
    for (const write of this.pendingWrites) {
      const binding = this.resolve(write.id);
      if (!binding) continue;
      binding.reassigned = true;
      if (write.opaque) binding.opaquelyWritten = true;
      else if (write.numericish) binding.incremented = true;
      else if (write.rhs) binding.assignedExpressions.push(write.rhs);
      else binding.opaquelyWritten = true;
    }
  }
}

function isCompoundAssignmentOperator(op: ts.SyntaxKind): boolean {
  return (
    op >= ts.SyntaxKind.FirstCompoundAssignment &&
    op <= ts.SyntaxKind.LastCompoundAssignment &&
    op !== ts.SyntaxKind.EqualsToken
  );
}

/** Compound operators whose result is always numeric (never string/bigint mix). */
function isNumericCompoundOperator(op: ts.SyntaxKind): boolean {
  switch (op) {
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
      return true;
    default:
      return false;
  }
}

const binderCache = new WeakMap<ts.SourceFile, FileBinder>();

/** Bind (and cache) a source file. */
export function binderFor(sourceFile: ts.SourceFile): FileBinder {
  let binder = binderCache.get(sourceFile);
  if (!binder) {
    binder = new FileBinder(sourceFile);
    binderCache.set(sourceFile, binder);
  }
  return binder;
}

/** The source file a node belongs to, without relying on node methods. */
export function sourceFileOf(node: ts.Node): ts.SourceFile | undefined {
  let cur: ts.Node | undefined = node;
  while (cur && cur.kind !== ts.SyntaxKind.SourceFile) cur = cur.parent;
  return cur as ts.SourceFile | undefined;
}
