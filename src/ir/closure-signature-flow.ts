// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7003) Which functions can reach a callable parameter slot?
 *
 * The IR lowers `f(x)` on a function-typed parameter `f: (x: number) => number`
 * to `closure.call`, which casts the closure's funcref to the EXACT Wasm func
 * type of the annotation (`ref.cast` + `call_ref`). TypeScript, however, lets
 * a function with a different Wasm signature fill that slot:
 * `function h(x: number, y: number = 5)`, `(x, y?) => …`, a one-parameter
 * function in a two-parameter slot, a value-returning function in a `void`
 * slot. The closure such a value is wrapped in carries ITS OWN func type, so
 * the cast traps (`illegal cast`). Legacy handles it with a `ref.test` cascade
 * over arities (and a host fallback); the IR has no arity-adapting call yet.
 *
 * Until it does, the selector refuses to claim a function whose callable
 * parameter may receive a value of a different signature
 * (`closure-signature-mismatch`). This module answers that question
 * syntactically and conservatively: a slot is EXACTLY FED only when every
 * reference to its function is a direct call and every argument in that
 * position is provably a function of exactly the slot's signature — a
 * same-signature top-level function declaration, a matching arrow/function
 * expression, a `const` bound to one, or another callable parameter of the
 * same signature that is itself exactly fed. Anything else (a stored value, a
 * property read, a call result, a `let`, a value reference to the function
 * itself such as `const a = apply`) counts as "may differ".
 *
 * Known limit: a method invoked through an element access (`obj["m"](h)`,
 * `obj[k](h)`) is not attributed to its slot.
 */
import { forEachChild, ts } from "../ts-api.js";
import { closureSignatureEquals, irTypeEquals, type IrClosureSignature, type IrType } from "./nodes.js";

export interface ClosureSignatureFlowHooks {
  /** The slot's IR signature; must be the selector's own `irClosureSignatureFromFunctionTypeNode`. */
  readonly slotSignature: (node: ts.FunctionTypeNode) => IrClosureSignature | null;
  /** Checker-backed same-source declaration of a value identifier, when available. */
  readonly resolveValue?: (node: ts.Identifier) => ts.Declaration | undefined;
}

type SlotOwner = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration;

const identifierIndexCache = new WeakMap<ts.SourceFile, ReadonlyMap<string, readonly ts.Identifier[]>>();

/**
 * True when the callable parameter `parameter` may be handed a function whose
 * Wasm signature differs from its annotation — the IR `closure.call` through it
 * would trap. Parameters that are not identifier-named, function-typed slots
 * with an expressible signature are not this module's concern (false).
 */
export function callableParameterMayReceiveForeignSignature(
  parameter: ts.ParameterDeclaration,
  hooks: ClosureSignatureFlowHooks,
): boolean {
  if (!parameter.parent || !ts.isIdentifier(parameter.name)) return false;
  if (!parameter.type || !ts.isFunctionTypeNode(parameter.type)) return false;
  if (!hooks.slotSignature(parameter.type)) return false;
  return !slotIsExactlyFed(parameter, hooks, new Set());
}

function slotIsExactlyFed(
  parameter: ts.ParameterDeclaration,
  hooks: ClosureSignatureFlowHooks,
  inProgress: Set<ts.ParameterDeclaration>,
): boolean {
  // Coinductive: a cycle of pass-throughs introduces no foreign value itself.
  if (inProgress.has(parameter)) return true;
  const signature =
    parameter.type && ts.isFunctionTypeNode(parameter.type) ? hooks.slotSignature(parameter.type) : null;
  const owner = parameter.parent;
  if (!signature || !isSlotOwner(owner)) return false;
  const index = owner.parameters.indexOf(parameter);
  if (index < 0) return false;
  const calls = directCallSites(owner, hooks);
  if (calls === null) return false;
  inProgress.add(parameter);
  try {
    for (const call of calls) {
      const args = call.arguments ?? [];
      for (let i = 0; i <= index && i < args.length; i++) {
        if (ts.isSpreadElement(args[i]!)) return false;
      }
      const argument = args[index];
      if (argument && !valueHasExactSignature(argument, signature, hooks, inProgress)) return false;
    }
    return true;
  } finally {
    inProgress.delete(parameter);
  }
}

function isSlotOwner(node: ts.Node): node is SlotOwner {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node);
}

/**
 * Every call that can invoke `owner`, or null when some reference to it is not
 * a direct call (so its arguments are unknown). Matching is by name, so an
 * unrelated same-named binding only adds call sites to check — never hides one.
 */
function directCallSites(
  owner: SlotOwner,
  hooks: ClosureSignatureFlowHooks,
): readonly (ts.CallExpression | ts.NewExpression)[] | null {
  const sourceFile = owner.getSourceFile();
  if (ts.isConstructorDeclaration(owner)) {
    const cls = owner.parent;
    if (!ts.isClassDeclaration(cls) || !cls.name) return null;
    return referenceCalls(sourceFile, cls.name.text, cls.name, "new", hooks, cls);
  }
  if (!owner.name || !ts.isIdentifier(owner.name)) return null;
  if (ts.isMethodDeclaration(owner)) {
    return referenceCalls(sourceFile, owner.name.text, owner.name, "member", hooks, owner);
  }
  return referenceCalls(sourceFile, owner.name.text, owner.name, "call", hooks, owner);
}

function referenceCalls(
  sourceFile: ts.SourceFile,
  name: string,
  declarationName: ts.Identifier,
  mode: "call" | "member" | "new",
  hooks: ClosureSignatureFlowHooks,
  declaration: ts.Declaration,
): (ts.CallExpression | ts.NewExpression)[] | null {
  const calls: (ts.CallExpression | ts.NewExpression)[] = [];
  for (const id of identifierIndex(sourceFile).get(name) ?? []) {
    if (id === declarationName || isTypePosition(id)) continue;
    const parent = id.parent;
    if (mode === "member") {
      // Only `.name` member accesses can reach an instance/static method; any
      // other same-named identifier is a different binding or a declaration.
      if (!ts.isPropertyAccessExpression(parent) || parent.name !== id) continue;
      const call = parent.parent;
      if (ts.isCallExpression(call) && call.expression === parent) calls.push(call);
      else return null;
      continue;
    }
    if (isNonReferenceName(id)) continue;
    const resolved = hooks.resolveValue?.(id);
    if (resolved !== undefined && !sameBinding(resolved, declaration)) continue;
    if (mode === "new" && ts.isNewExpression(parent) && parent.expression === id) calls.push(parent);
    else if (mode === "call" && ts.isCallExpression(parent) && parent.expression === id) calls.push(parent);
    else return null;
  }
  return calls;
}

/** Overload signatures and the implementation are one binding. */
function sameBinding(resolved: ts.Declaration, declaration: ts.Declaration): boolean {
  if (resolved === declaration) return true;
  return (
    ts.isFunctionDeclaration(resolved) &&
    ts.isFunctionDeclaration(declaration) &&
    resolved.parent === declaration.parent &&
    resolved.name !== undefined &&
    resolved.name.text === declaration.name?.text
  );
}

/** Declaration names, property names and labels named like the owner are not references to it. */
function isNonReferenceName(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
  if (ts.isQualifiedName(parent) && parent.right === id) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === id
  ) {
    return true;
  }
  return ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent);
}

function isTypePosition(id: ts.Identifier): boolean {
  for (let node: ts.Node = id; node.parent; node = node.parent) {
    if (ts.isTypeNode(node.parent) && !ts.isExpressionWithTypeArguments(node.parent)) return true;
    if (ts.isTypeAliasDeclaration(node.parent) || ts.isInterfaceDeclaration(node.parent)) return true;
    if (ts.isExpression(node.parent) || ts.isStatement(node.parent)) return false;
  }
  return false;
}

function identifierIndex(sourceFile: ts.SourceFile): ReadonlyMap<string, readonly ts.Identifier[]> {
  const cached = identifierIndexCache.get(sourceFile);
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
  visit(sourceFile);
  identifierIndexCache.set(sourceFile, index);
  return index;
}

function valueHasExactSignature(
  expression: ts.Expression,
  signature: IrClosureSignature,
  hooks: ClosureSignatureFlowHooks,
  inProgress: Set<ts.ParameterDeclaration>,
): boolean {
  const value = unwrapErasedExpression(expression);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return literalMatches(value, signature);
  if (!ts.isIdentifier(value)) return false;
  const declaration = hooks.resolveValue ? hooks.resolveValue(value) : lexicalDeclaration(value);
  if (!declaration) return false;
  if (ts.isFunctionDeclaration(declaration)) {
    const own = functionDeclarationSignature(declaration);
    return own !== null && closureSignatureEquals(own, signature);
  }
  if (ts.isParameter(declaration)) {
    if (!declaration.type || !ts.isFunctionTypeNode(declaration.type)) return false;
    const slot = hooks.slotSignature(declaration.type);
    return slot !== null && closureSignatureEquals(slot, signature) && slotIsExactlyFed(declaration, hooks, inProgress);
  }
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || !declaration.initializer) {
      return false;
    }
    return valueHasExactSignature(declaration.initializer, signature, hooks, inProgress);
  }
  return false;
}

function unwrapErasedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
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

/**
 * Fallback name resolution for bare selector callers without a checker-backed
 * resolver: the innermost enclosing parameter, function declaration or
 * variable of that name declared directly in a block/body on the scope chain.
 */
function lexicalDeclaration(id: ts.Identifier): ts.Declaration | undefined {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === id.text);
      if (parameter) return parameter;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === id.text) return statement;
        if (ts.isVariableStatement(statement)) {
          const found = statement.declarationList.declarations.find(
            (d) => ts.isIdentifier(d.name) && d.name.text === id.text,
          );
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}

/**
 * Same primitive mapping as the selector's `primitiveClosureTypeFromTypeNode`
 * (number→f64, boolean→i32, string→string). The SLOT side always goes through
 * the selector's own helper (`hooks.slotSignature`); a value-side divergence
 * can only make this module answer "may differ", never the reverse.
 */
function primitiveType(node: ts.TypeNode | undefined): IrType | null {
  if (!node) return null;
  if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: "val", val: { kind: "f64" } };
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: "val", val: { kind: "i32" } };
  if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
  return null;
}

/** A void annotation is the zero-result signature (`returnType: null`); undefined = inexpressible. */
function annotatedReturn(node: ts.TypeNode): IrType | null | undefined {
  if (node.kind === ts.SyntaxKind.VoidKeyword) return null;
  return primitiveType(node) ?? undefined;
}

function functionDeclarationSignature(declaration: ts.FunctionDeclaration): IrClosureSignature | null {
  if (
    !declaration.body ||
    declaration.asteriskToken ||
    (declaration.typeParameters?.length ?? 0) > 0 ||
    declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
    !declaration.type
  ) {
    return null;
  }
  const params: IrType[] = [];
  for (const parameter of declaration.parameters) {
    if (!plainParameter(parameter)) return null;
    const type = primitiveType(parameter.type);
    if (!type) return null;
    params.push(type);
  }
  const returnType = annotatedReturn(declaration.type);
  return returnType === undefined ? null : { params, returnType };
}

function plainParameter(parameter: ts.ParameterDeclaration): boolean {
  return (
    ts.isIdentifier(parameter.name) &&
    parameter.name.text !== "this" &&
    !parameter.questionToken &&
    !parameter.dotDotDotToken &&
    !parameter.initializer
  );
}

/**
 * An arrow / function expression in a slot of signature `signature`. Its own
 * Wasm arity is its declared parameter count, so a different count, an
 * optional/default/rest parameter, or a differing annotation is foreign.
 * Unannotated parameters take the slot's types contextually. An unannotated
 * result takes its inferred type: a value-returning literal in a `void` slot
 * is foreign, and a block that never returns a value in a valued slot is
 * treated as foreign too (it could only be a `never` body).
 */
function literalMatches(fn: ts.ArrowFunction | ts.FunctionExpression, signature: IrClosureSignature): boolean {
  if (
    (ts.isFunctionExpression(fn) && fn.asteriskToken) ||
    (fn.typeParameters?.length ?? 0) > 0 ||
    fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
    fn.parameters.length !== signature.params.length
  ) {
    return false;
  }
  for (let i = 0; i < fn.parameters.length; i++) {
    const parameter = fn.parameters[i]!;
    if (!plainParameter(parameter)) return false;
    if (parameter.type) {
      const type = primitiveType(parameter.type);
      if (!type || !irTypeEquals(type, signature.params[i]!)) return false;
    }
  }
  if (fn.type) {
    const own = annotatedReturn(fn.type);
    if (own === undefined) return false;
    return own === null || signature.returnType === null
      ? own === signature.returnType
      : irTypeEquals(own, signature.returnType);
  }
  if (!ts.isBlock(fn.body)) return signature.returnType !== null;
  return blockReturnsValue(fn.body) === (signature.returnType !== null);
}

/** Does this function body contain a `return <expr>` of its own (not of a nested function)? */
function blockReturnsValue(body: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return found;
}
