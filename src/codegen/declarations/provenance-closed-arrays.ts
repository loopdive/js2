// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4773) Provenance-closed module-level array literals.
 *
 * ## Why this exists
 *
 * The #4491 wave-4 vec-identity rule withdraws a `__vec_*` parameter narrowing
 * whenever {@link overlayRouteActive} is true. That flag is **module-wide**: one
 * accessor descriptor anywhere in the file sets it, and every vec-typed
 * parameter in the module then loses its narrowing. The rule itself is sound
 * and stays — narrowing a parameter to a concrete vec carrier makes the
 * argument boundary an element-wise COPY (`emitVecToVecBody` → a fresh
 * `struct.new`), and the #3251 overlay side table is keyed by vec IDENTITY
 * (`ref.eq`), so a descriptor-bearing array would arrive at the callee with no
 * descriptors at all.
 *
 * What this module adds is PRECISION, not permission. It answers one narrow
 * question:
 *
 * > Is every array that can reach this parameter a module-level array literal
 * > that nothing in the program can attach a descriptor to?
 *
 * If yes, no descriptor can exist on the incoming array, so the identity the
 * copy would destroy carries nothing — and the narrowing is safe even though
 * the module is descriptor-dirty somewhere else.
 *
 * ## The proof obligation, and why it is checkable syntactically
 *
 * A descriptor can only be attached to an object someone can NAME. The rule
 * below therefore requires the array's binding to be provenance-closed: bound
 * once, at module level, to a literal of primitive elements, and thereafter
 * referenced ONLY as an argument at the one parameter position under test. A
 * binding nothing else can reference is a binding nothing else can
 * `Object.defineProperty`.
 *
 * Every clause fails CLOSED. Anything not explicitly recognised — a computed
 * name, an aliasing assignment, an export, a second callee, a spread, a
 * property store, a `delete` — returns false and the caller withdraws exactly
 * as before. The default is unchanged behaviour; this is a whitelist.
 *
 * ## Deliberately NOT general reachability
 *
 * A full escape analysis would recover more, but its soundness argument needs
 * the descriptor-MOP context that #4491 owns. This slice is scoped so that its
 * correctness argument is self-contained: "a descriptor cannot reach an object
 * nothing else can reference."
 */
import { forEachChild, ts } from "../../ts-api.js";

/** Per-file cache — the scans below are O(programSize), run once per file. */
const closedArrayNamesBySourceFile = new WeakMap<ts.SourceFile, Set<string>>();
const identifierIndexBySourceFile = new WeakMap<ts.SourceFile, Map<string, ts.Identifier[]>>();

/**
 * Is `expr` an array literal whose every element is a primitive literal?
 *
 * Primitive means: numeric/string/boolean/null literal, or a unary `+`/`-`
 * applied to a numeric literal (`[-1, 2]` parses as a PrefixUnaryExpression).
 * Nested arrays, objects, identifiers, calls and holes (`[,]`, an
 * OmittedExpression) all fail — a hole is an absent element, which is exactly
 * the sparse shape the overlay exists to model.
 */
function isPrimitiveArrayLiteral(expr: ts.Expression): boolean {
  if (!ts.isArrayLiteralExpression(expr)) return false;
  for (const element of expr.elements) {
    if (ts.isNumericLiteral(element) || ts.isStringLiteral(element)) continue;
    if (
      element.kind === ts.SyntaxKind.TrueKeyword ||
      element.kind === ts.SyntaxKind.FalseKeyword ||
      element.kind === ts.SyntaxKind.NullKeyword
    ) {
      continue;
    }
    if (
      ts.isPrefixUnaryExpression(element) &&
      (element.operator === ts.SyntaxKind.MinusToken || element.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(element.operand)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/** All identifier occurrences in the file, keyed by name. Cached per file. */
function identifierIndex(sourceFile: ts.SourceFile): Map<string, ts.Identifier[]> {
  const cached = identifierIndexBySourceFile.get(sourceFile);
  if (cached) return cached;
  const index = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const bucket = index.get(node.text);
      if (bucket) bucket.push(node);
      else index.set(node.text, [node]);
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  identifierIndexBySourceFile.set(sourceFile, index);
  return index;
}

/**
 * Does the file contain a construct that can reach a binding without naming it
 * in a scannable position — `eval` (the name lives in a string) or `with` (a
 * bare name may resolve to a property of the with-object)?
 */
function fileHasOpaqueScopeConstruct(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isWithStatement(node) || (ts.isIdentifier(node) && node.text === "eval")) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  return found;
}

/** Is this variable statement directly at module level (not nested in a function/block)? */
function isModuleLevelDeclaration(declaration: ts.VariableDeclaration): boolean {
  const list = declaration.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return false;
  const statement = list.parent;
  if (!statement || !ts.isVariableStatement(statement)) return false;
  // An exported binding is reachable from outside the module — not closed.
  if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return false;
  return statement.parent !== undefined && ts.isSourceFile(statement.parent);
}

/**
 * The one occurrence that is the binding's own declaration name.
 * Any OTHER declaration of the same name (a shadowing local, a parameter, a
 * second `var`) disqualifies the name outright — this analysis is name-keyed,
 * so it must not confuse two bindings that share a spelling.
 */
function isOwnDeclarationName(id: ts.Identifier, declaration: ts.VariableDeclaration): boolean {
  return id.parent === declaration && declaration.name === id;
}

/**
 * Names bound once, at module level, to a primitive array literal, and
 * referenced ONLY as direct arguments of calls to a plain identifier callee.
 *
 * This is the file-wide half of the proof. The per-parameter half — that every
 * one of those argument positions is the SAME parameter under test — is
 * {@link paramReceivesOnlyProvenanceClosedArrayLiterals}, because it depends on
 * which parameter is asking.
 */
function closedArrayLiteralNames(sourceFile: ts.SourceFile): Set<string> {
  const cached = closedArrayNamesBySourceFile.get(sourceFile);
  if (cached) return cached;

  // `eval("Object.defineProperty(a, …)")` names the binding inside a STRING,
  // and `with (o) { … }` can resolve a bare name to a property of `o`. Both
  // reference a binding without its identifier appearing in a position this
  // scan can see, which would silently defeat the whole analysis. A file
  // containing either has no closed names at all.
  if (fileHasOpaqueScopeConstruct(sourceFile)) {
    const empty = new Set<string>();
    closedArrayNamesBySourceFile.set(sourceFile, empty);
    return empty;
  }

  const candidates = new Map<string, ts.VariableDeclaration>();
  const disqualified = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      // A second declaration of the same spelling makes the name ambiguous.
      if (candidates.has(name) || disqualified.has(name)) disqualified.add(name);
      else if (
        node.initializer !== undefined &&
        isPrimitiveArrayLiteral(node.initializer) &&
        isModuleLevelDeclaration(node)
      ) {
        candidates.set(name, node);
      } else disqualified.add(name);
    } else if (
      (ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      // A parameter / binding element / function of the same name shadows it.
      disqualified.add(node.name.text);
    }
    forEachChild(node, collect);
  };
  forEachChild(sourceFile, collect);

  const closed = new Set<string>();
  const index = identifierIndex(sourceFile);
  for (const [name, declaration] of candidates) {
    if (disqualified.has(name)) continue;
    let ok = true;
    for (const id of index.get(name) ?? []) {
      if (isOwnDeclarationName(id, declaration)) continue;
      const parent = id.parent as ts.Node | undefined;
      // The ONLY admitted reference shape: a direct argument of `f(…)` whose
      // callee is a plain identifier. This rejects, by construction:
      //   Object.defineProperty(a, …) / Object.create(a) — callee is a
      //     property access, so the descriptor entry points cannot slip in;
      //   a.push(…) / a.length / a[i] — receiver of a member access;
      //   a = x / a[i] = x / delete a[i] — store positions;
      //   f(...a) — a spread argument's parent is a SpreadElement, not the call;
      //   new F(a), export { a }, `a` as a callee, a return value, …
      if (parent === undefined || !ts.isCallExpression(parent)) {
        ok = false;
        break;
      }
      if (parent.expression === id || !ts.isIdentifier(parent.expression)) {
        ok = false;
        break;
      }
      if (!parent.arguments.some((argument) => argument === id)) {
        ok = false;
        break;
      }
    }
    if (ok) closed.add(name);
  }
  closedArrayNamesBySourceFile.set(sourceFile, closed);
  return closed;
}

/**
 * Is the parameter at `paramIndex` of `funcName` used in a way that could
 * attach a descriptor to, or leak, the array it receives?
 *
 * Read-only means the binding is only ever READ: `p.length`, `p[i]` in value
 * position, and comparisons. Any store (`p[i] = …`, `p.x = …`, `p = …`),
 * any `delete p[i]`, and any onward pass (`g(p)` — including
 * `Object.defineProperty(p, …)`) makes it not read-only.
 *
 * Returns false (not read-only) when the declaration cannot be found or is
 * ambiguous — fail closed.
 */
function parameterIsReadOnlyInBody(funcName: string, paramIndex: number, sourceFile: ts.SourceFile): boolean {
  let declaration: ts.FunctionDeclaration | undefined;
  let ambiguous = false;
  const find = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === funcName) {
      if (declaration !== undefined) ambiguous = true;
      declaration = node;
    }
    forEachChild(node, find);
  };
  forEachChild(sourceFile, find);
  if (ambiguous || declaration === undefined) return false;

  const parameter = declaration.parameters[paramIndex];
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) return false;
  const paramName = parameter.name.text;
  const body = declaration.body;
  if (body === undefined) return false;

  let readOnly = true;
  const scan = (node: ts.Node): void => {
    if (!readOnly) return;
    if (ts.isIdentifier(node) && node.text === paramName) {
      const parent = node.parent as ts.Node | undefined;
      if (parent === undefined) {
        readOnly = false;
        return;
      }
      // The parameter's own declaration name.
      if (ts.isParameter(parent) && parent.name === node) return;
      // `p[i]` / `p.length` as a READ — the access must not be a store target
      // and must not be `delete`d.
      if (
        (ts.isElementAccessExpression(parent) && parent.expression === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.expression === node)
      ) {
        const access = parent;
        const grand = access.parent as ts.Node | undefined;
        if (grand !== undefined) {
          if (ts.isBinaryExpression(grand) && grand.left === access && isAssignmentOperator(grand.operatorToken.kind)) {
            readOnly = false;
            return;
          }
          if (ts.isDeleteExpression(grand)) {
            readOnly = false;
            return;
          }
          if (
            (ts.isPrefixUnaryExpression(grand) || ts.isPostfixUnaryExpression(grand)) &&
            (grand.operator === ts.SyntaxKind.PlusPlusToken || grand.operator === ts.SyntaxKind.MinusMinusToken)
          ) {
            readOnly = false;
            return;
          }
        }
        return;
      }
      // A bare read used as a value in a comparison / arithmetic context is
      // fine; being an ARGUMENT, a callee, an assignment target, a spread, a
      // return value or an initializer is an escape.
      if (ts.isBinaryExpression(parent)) {
        if (parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) {
          readOnly = false;
        }
        return;
      }
      readOnly = false;
      return;
    }
    forEachChild(node, scan);
  };
  forEachChild(body, scan);
  return readOnly;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * (#4773) Does EVERY argument reaching `funcName`'s parameter `paramIndex` come
 * from a provenance-closed module-level array literal — and does the callee
 * only read it?
 *
 * True ⇒ no descriptor can exist on any array this parameter can receive, so
 * the #4491 wave-4 vec-identity withdrawal has nothing to protect here and the
 * narrowing may stand. False ⇒ withdraw exactly as before.
 *
 * Requires at least one call site: with none, there is no evidence and the
 * answer is false.
 */
export function paramReceivesOnlyProvenanceClosedArrayLiterals(
  funcName: string,
  paramIndex: number,
  sourceFile: ts.SourceFile,
): boolean {
  if (!parameterIsReadOnlyInBody(funcName, paramIndex, sourceFile)) return false;
  const closed = closedArrayLiteralNames(sourceFile);
  if (closed.size === 0) return false;

  const reaching = new Set<string>();
  let sawSite = false;
  let ok = true;
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      sawSite = true;
      const argument = node.arguments[paramIndex];
      // Under-applied, or not a bare identifier naming a closed literal.
      if (argument === undefined || !ts.isIdentifier(argument) || !closed.has(argument.text)) {
        ok = false;
        return;
      }
      reaching.add(argument.text);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      // `new funcName(…)` is a call site for the same parameters (#743). This
      // slice does not model constructor provenance — fail closed.
      ok = false;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  if (!ok || !sawSite) return false;

  // Closure: each reaching array must be passed ONLY to this exact parameter
  // position. `closedArrayLiteralNames` already proved every reference is a
  // call argument with an identifier callee; this pins those calls to
  // (funcName, paramIndex), so the array cannot also flow into some other
  // function that might descriptor-touch it.
  const index = identifierIndex(sourceFile);
  for (const name of reaching) {
    for (const id of index.get(name) ?? []) {
      const parent = id.parent as ts.Node | undefined;
      if (parent === undefined || !ts.isCallExpression(parent)) continue; // the declaration name
      if (!ts.isIdentifier(parent.expression) || parent.expression.text !== funcName) return false;
      if (parent.arguments[paramIndex] !== id) return false;
    }
  }
  return true;
}
