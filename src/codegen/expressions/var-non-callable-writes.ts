// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { identifierWriteFact, type TypeFact } from "../../checker/oracle.js";
import { identifierWritesOf, type IdentifierWrite } from "../../shared/binding-writes.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * (#7334) A `var` (module or function-local) some write of which stores a
 * value no callable can be (`getter = function () {}; getter = 3`). The typed
 * identifier-call routes cast the slot to one closure signature: the one the
 * closure map records from the function write, or the checker's declared type
 * (`var getter = function () {}`). A non-callable value fails that cast, the
 * guard throws only for a nullish value, and the funcref fetch traps. Such a
 * binding takes the dynamic route, which tests IsCallable and throws a
 * catchable TypeError. A nullish write keeps the typed routes: their guard
 * throws for null and undefined (`emitNullCheckThrow`), with the message #7287
 * pins. A value the oracle cannot name (`any`) keeps them too.
 */
const varNonCallableWrites = new WeakMap<ts.VariableDeclaration, boolean>();

/** Facts of values that are never callable; a builtin may be `Function`, so it is not one. */
const NON_CALLABLE_FACTS: ReadonlySet<TypeFact["kind"]> = new Set<TypeFact["kind"]>([
  "number",
  "boolean",
  "string",
  "bigint",
  "symbol",
  "array",
  "tuple",
  "object",
  "class",
]);

export function varStoresNonCallable(ctx: CodegenContext, identifier: ts.Identifier): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(identifier);
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  let found = varNonCallableWrites.get(declaration);
  if (found !== undefined) return found;
  found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    for (const write of identifierWritesOf(node)) {
      if (ctx.oracle.valueDeclarationOf(write.target) === declaration && writeStoresNonCallable(ctx, write)) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(varScopeOf(declaration));
  varNonCallableWrites.set(declaration, found);
  return found;
}

function writeStoresNonCallable(ctx: CodegenContext, write: IdentifierWrite): boolean {
  // A ToNumeric write-back, a for-in key and a rest element store a Number or
  // BigInt, a string and an Array or Object.
  if (write.kind === "numeric" || write.kind === "key" || write.kind === "rest") return true;
  const fact = identifierWriteFact(ctx.oracle, write);
  return fact !== undefined && NON_CALLABLE_FACTS.has(fact.kind);
}

/** The function or source file whose body holds every write of a `var` declared in it. */
function varScopeOf(declaration: ts.VariableDeclaration): ts.Node {
  let scope: ts.Node = declaration;
  while (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  return scope;
}
