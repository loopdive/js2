// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7462) Which provider resolves an identifier write: the write twin of `identifier-read.ts`. A binding the unit's
 * scope holds wins; otherwise a module binding the resolver answers for this write (a function writing a script
 * `var`). Pure: it emits nothing, but the resolver may refuse the write itself (the Prepared path's immutable module
 * binding), and that refusal propagates unchanged. A module binding the resolver will not take this value into is
 * never asked here: the ordinary selector refuses that write first, by the same resolver.
 */
import type ts from "typescript";
import type { IrFromAstResolver } from "./from-ast.js";

type ModuleBinding = NonNullable<ReturnType<NonNullable<IrFromAstResolver["resolveModuleBinding"]>>>;

export type IdentifierWrite<Binding> =
  | { readonly kind: "scope"; readonly binding: Binding }
  | { readonly kind: "module-binding"; readonly binding: ModuleBinding }
  | { readonly kind: "undeclared" };

interface IdentifierWriteContext<Binding> {
  readonly scope: ReadonlyMap<string, Binding>;
  readonly resolver?: IrFromAstResolver;
}

export function classifyIdentifierWrite<Binding>(
  id: ts.Identifier,
  writeValue: ts.Expression,
  cx: IdentifierWriteContext<Binding>,
): IdentifierWrite<Binding> {
  const binding = cx.scope.get(id.text);
  if (binding !== undefined) return { kind: "scope", binding };
  const writable = cx.resolver?.resolveModuleBinding?.(id, writeValue);
  return writable ? { kind: "module-binding", binding: writable } : { kind: "undeclared" };
}
