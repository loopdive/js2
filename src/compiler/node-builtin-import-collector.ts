// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import {
  isNodeBuiltin,
  nodeBuiltinClassStub,
  normalizeNodeBuiltin,
  type NodeBuiltinImport,
} from "../import-resolver.js";

/**
 * Collect graph-wide Node builtin bindings without rewriting module imports.
 * Multi-file TypeScript analysis keeps the declarations while codegen receives
 * the same host-import metadata as the single-file preprocessor.
 */
export function collectGraphNodeBuiltinImports(sources: Iterable<string>): NodeBuiltinImport[] {
  const builtins: NodeBuiltinImport[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const sf = ts.createSourceFile(
      "__node_builtin_collect__.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const moduleSpec = stmt.moduleSpecifier.text;
      if (!isNodeBuiltin(moduleSpec)) continue;
      const moduleName = normalizeNodeBuiltin(moduleSpec);
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue;

      let builtin: NodeBuiltinImport;
      if (!clause) {
        builtin = { localName: moduleName, moduleName };
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        builtin = { localName: clause.namedBindings.name.text, moduleName };
      } else {
        const namedBindings =
          clause.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements
                .filter((element) => !element.isTypeOnly)
                .map((element) => element.name.text)
                .filter((name) => nodeBuiltinClassStub(moduleName, name) === null)
            : [];
        if (!clause.name && namedBindings.length === 0 && clause.namedBindings) continue;
        builtin = {
          localName: clause.name?.text ?? namedBindings[0] ?? moduleName,
          moduleName,
          ...(namedBindings.length > 0 ? { namedBindings } : {}),
        };
      }

      const key = `${builtin.localName}\0${builtin.moduleName}\0${builtin.namedBindings?.join("\0") ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        builtins.push(builtin);
      }
    }
  }
  return builtins;
}
