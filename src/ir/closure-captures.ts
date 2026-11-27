// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { forEachChild, ts } from "../ts-api.js";
import { isLexicalBindingWrite, varDeclaratorWrittenNames } from "../shared/binding-writes.js";
import { collectPatternBindingNames } from "./analysis/ast-scope.js";
import type { IrType, IrValueId } from "./nodes.js";
import { demoteToLegacy } from "./outcomes.js";

/** A function whose body may capture outer bindings. */
type CapturingFunction =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** Conservatively collect writes in the function-like enclosing a lifted closure. */
function collectOuterWrites(fn: CapturingFunction): Set<string> {
  const writes = new Set<string>();
  let outer: ts.Node | undefined = fn.parent;
  while (
    outer &&
    !ts.isFunctionDeclaration(outer) &&
    !ts.isFunctionExpression(outer) &&
    !ts.isArrowFunction(outer) &&
    !ts.isMethodDeclaration(outer) &&
    !ts.isGetAccessorDeclaration(outer) &&
    !ts.isSetAccessorDeclaration(outer) &&
    !ts.isSourceFile(outer)
  ) {
    outer = outer.parent;
  }
  if (!outer || !("body" in outer) || !outer.body) return writes;
  const body = outer.body as ts.Node;
  // (#6992) Names declared so far, in source order: a later `var` declarator
  // with an initializer for one of them is a re-declaration, i.e. a write.
  const declared = new Set<string>();
  if ("parameters" in outer) {
    for (const p of (outer as ts.SignatureDeclaration).parameters) {
      for (const n of collectPatternBindingNames(p.name)) declared.add(n);
    }
  }
  const visit = (node: ts.Node): void => {
    if (node === fn) return;
    if (ts.isIdentifier(node) && isLexicalBindingWrite(node)) writes.add(node.text);
    for (const id of varDeclaratorWrittenNames(node)) if (declared.has(id.text)) writes.add(id.text);
    if (ts.isVariableDeclaration(node)) for (const n of collectPatternBindingNames(node.name)) declared.add(n);
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return writes;
}

/** Allocate shared storage before control flow can create an accessor capture. */
export function isCapturedByOrdinaryDescriptor(
  declaration: ts.VariableDeclaration | ts.BindingElement,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return false;
  let owner: ts.Node | undefined = declaration.parent;
  while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
  if (!owner || !("body" in owner) || !owner.body) return false;
  let captured = false;
  const visit = (node: ts.Node, nested: boolean, descriptor: boolean): void => {
    if (captured) return;
    const isClosure = ts.isFunctionLike(node);
    const inDescriptor =
      descriptor ||
      ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
        ts.isObjectLiteralExpression(node.parent));
    if (nested && inDescriptor && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      captured = true;
      return;
    }
    forEachChild(node, (child) => visit(child, nested || isClosure, inDescriptor));
  };
  visit(
    owner.body as ts.Node,
    false,
    (ts.isGetAccessorDeclaration(owner) || ts.isSetAccessorDeclaration(owner)) &&
      ts.isObjectLiteralExpression(owner.parent),
  );
  return captured;
}

/** Free lexical bindings needed by descendants must cross the enclosing environment. */
function collectTransitiveClosureCaptures(
  descendant: ts.Node,
  enclosing: ts.Node,
  checker: ts.TypeChecker,
): { readonly referenced: Set<string>; readonly written: Set<string> } {
  const referenced = new Set<string>();
  const written = new Set<string>();
  const declaredInside = (declaration: ts.Node): boolean => {
    for (let node: ts.Node | undefined = declaration; node; node = node.parent) if (node === enclosing) return true;
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const symbol =
        ts.isShorthandPropertyAssignment(parent) && parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node);
      // Property labels and named members are not lexical environment reads.
      if (symbol && symbol.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class)) {
        const declarations = symbol.declarations;
        if (declarations?.length && declarations.every((declaration) => !declaredInside(declaration))) {
          referenced.add(node.text);
          if (isLexicalBindingWrite(node)) written.add(node.text);
        }
      }
    }
    forEachChild(node, visit);
  };
  visit(descendant);
  return { referenced, written };
}

/** A captured outer binding of a closure or nested function, as the lifted body receives it. */
export interface NestedCapture {
  readonly name: string;
  /** Stored capture type. For a with-field this is the object receiver type. */
  readonly type: IrType;
  readonly mutable: boolean;
  readonly outerValue: IrValueId;
  /** Rehydrate an invocation-time object-property binding, not a value snapshot. */
  readonly withField?: { readonly name: string; readonly type: IrType };
}

/** The enclosing binding of a name: a local, a `with` field, a module global (no capture), or another kind. */
export type CaptureSource =
  | { readonly kind: "local"; readonly value: IrValueId; readonly type: IrType }
  | {
      readonly kind: "withField";
      readonly receiver: IrValueId;
      readonly receiverType: IrType;
      readonly field: string;
      readonly type: IrType;
    }
  | { readonly kind: "moduleGlobal" | "other" };

/** What the capture analysis reads of the enclosing function. */
export interface CaptureAnalysisHost {
  readonly checker: ts.TypeChecker | undefined;
  readonly funcName: string;
  readonly lookup: (name: string) => CaptureSource | undefined;
}

/**
 * Walk a closure / nested-function's parameter initializers and body, collecting identifiers that
 * reference outer-scope `local` bindings. Classifies each capture as
 * mutable (the body OR the outer writes to it) or read-only.
 *
 * Outer writes are conservatively detected by walking the entire
 * outer body — any identifier-LHS write to `name` upgrades it to
 * mutable, even if the closure body itself is read-only. This is the
 * safe-and-simple approach the legacy path uses too.
 */
export function analyseClosureCaptures(
  fn: CapturingFunction,
  host: CaptureAnalysisHost,
  orderedCaptureNames?: readonly string[],
): NestedCapture[] {
  const referenced = new Set<string>();
  const written = new Set<string>();
  const ownParams = new Set<string>();
  if (ts.isFunctionExpression(fn) && fn.name) ownParams.add(fn.name.text);
  for (const p of fn.parameters) {
    for (const name of collectPatternBindingNames(p.name)) ownParams.add(name);
  }

  const visit = (node: ts.Node): void => {
    // Descendants lower separately, but their free outer bindings must first
    // be transported through this closure's environment.
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      if (host.checker) {
        const transitive = collectTransitiveClosureCaptures(node, fn, host.checker);
        transitive.referenced.forEach((name) => referenced.add(name));
        transitive.written.forEach((name) => written.add(name));
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      referenced.add(node.text);
      // (#6992) Every write form, destructuring and for-in/for-of heads included.
      if (isLexicalBindingWrite(node)) written.add(node.text);
    }
    forEachChild(node, visit);
  };
  for (const parameter of fn.parameters) {
    if (parameter.initializer) visit(parameter.initializer);
  }
  if (fn.body) {
    if (ts.isBlock(fn.body)) {
      for (const s of fn.body.statements) visit(s);
    } else {
      visit(fn.body);
    }
  }

  const outerWrites = collectOuterWrites(fn);

  if (orderedCaptureNames) {
    validateExactCapturePlan(
      orderedCaptureNames,
      referenced,
      ownParams,
      (name) => {
        const source = host.lookup(name);
        return source === undefined ? undefined : source.kind === "local" ? "local" : "other";
      },
      host.funcName,
    );
  }

  const captures: NestedCapture[] = [];
  const captureOrder: Iterable<string> = orderedCaptureNames ?? referenced;
  for (const name of captureOrder) {
    if (ownParams.has(name)) continue;
    const binding = host.lookup(name);
    if (!binding) continue;
    if (binding.kind === "withField") {
      if (binding.receiverType.kind !== "object") {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: with binding "${name}" has a non-object receiver in ${host.funcName}`,
        );
      }
      captures.push({
        name,
        type: binding.receiverType,
        mutable: false,
        outerValue: binding.receiver,
        withField: { name: binding.field, type: binding.type },
      });
      continue;
    }
    // (#7130) A module-scope binding is a global, not an environment slot:
    // the lifted body reaches the same `__mod_` storage itself.
    if (binding.kind === "moduleGlobal") continue;
    if (binding.kind !== "local") {
      // A slot, a nested function's name or another non-local binding has no capture field.
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: closure inside ${host.funcName} captures non-local binding "${name}" — not in slice 3`,
      );
    }
    // If the local is already a refcell (a sibling closure boxed it),
    // the capture's logical type is the inner IrType — we deref on
    // read in `lowerClosureExpression`. #1926 — boxed.inner is already an
    // IrType, so use it directly (no irVal re-wrap).
    const logicalType: IrType = binding.type.kind === "boxed" ? binding.type.inner : binding.type;
    const isMutable = binding.type.kind === "boxed" || written.has(name) || outerWrites.has(name);
    captures.push({
      name,
      type: logicalType,
      mutable: isMutable,
      outerValue: binding.value,
    });
  }
  return captures;
}

/** An exact closure plan names exactly the locals the body captures. */
function validateExactCapturePlan(
  orderedNames: readonly string[],
  referencedNames: ReadonlySet<string>,
  ownParams: ReadonlySet<string>,
  lookup: (name: string) => "local" | "other" | undefined,
  funcName: string,
): void {
  const ordered = new Set(orderedNames);
  for (const name of referencedNames) {
    if (ownParams.has(name)) continue;
    const kind = lookup(name);
    if (kind !== undefined && (kind !== "local" || !ordered.has(name))) {
      // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
      throw new Error(`ir/from-ast: exact closure capture plan omitted binding "${name}" (${funcName})`);
    }
  }
  for (const name of orderedNames) {
    if (lookup(name) !== "local") {
      // invariant (producer-promise): the prepared exact proof promised this shape — #4502.
      throw new Error(`ir/from-ast: exact closure capture "${name}" is not a local in scope (${funcName})`);
    }
  }
}
