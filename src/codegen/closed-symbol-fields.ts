// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { wellKnownSymbolId } from "../runtime/contracts/well-known-symbols.js";

/** Use declarations, not TypeScript's unstable escaped-name numeric suffix. */
export function closedWellKnownSymbolFields(ctx: CodegenContext): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const [type, name] of ctx.anonTypeMap) {
    const keys = new Map<string, number>();
    for (const property of type.getProperties()) {
      const declarations = property.getDeclarations();
      if (!declarations?.length) continue;
      const ids: number[] = [];
      for (const declaration of declarations) {
        const member = declaration as ts.NamedDeclaration;
        if (!member.name || !ts.isComputedPropertyName(member.name)) break;
        const key = member.name.expression;
        if (!ts.isPropertyAccessExpression(key) || !ts.isIdentifier(key.expression) || key.expression.text !== "Symbol")
          break;
        const symbol = ctx.checker.getSymbolAtLocation(key.expression);
        // A local binding called Symbol cannot authorize a well-known key.
        if (
          !symbol?.declarations?.length ||
          !symbol.declarations.every((node) => node.getSourceFile().isDeclarationFile)
        )
          break;
        const id = wellKnownSymbolId(key.name.text);
        if (id === undefined) break;
        ids.push(id);
      }
      if (ids.length === declarations.length && ids.every((id) => id === ids[0])) keys.set(property.name, ids[0]!);
    }
    if (keys.size) result.set(name, keys);
  }
  return result;
}
