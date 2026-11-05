// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Node platform capability: a portable `require()` for Node
 * builtins and the namespace walk that binds `require(ns).Class` extern
 * classes (#1044). Split out of `src/runtime.ts`.
 */

/**
 * Portable require() for loading Node.js builtin modules (#1044).
 * Works in both CJS (require is global) and ESM (createRequire from node:module).
 * Returns undefined in non-Node environments (browsers).
 */
let _nodeRequire: ((id: string) => any) | null | undefined;
export function getNodeRequire(): ((id: string) => any) | undefined {
  if (_nodeRequire !== undefined) return _nodeRequire ?? undefined;
  // CJS context
  if (typeof require === "function") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _nodeRequire = require;
    return _nodeRequire;
  }
  // ESM context in Node.js: use process.getBuiltinModule (Node 22.3+)
  // to synchronously access createRequire without a static `import` of node:module
  try {
    const nodeModule = (globalThis.process as any)?.getBuiltinModule?.("module");
    if (nodeModule?.createRequire) {
      const baseUrl = `file://${globalThis.process.cwd()}/index.js`;
      _nodeRequire = nodeModule.createRequire(baseUrl);
      return _nodeRequire!;
    }
  } catch {
    // Not Node.js or getBuiltinModule not available
  }
  _nodeRequire = null;
  return undefined;
}

/**
 * Resolve a class from a namespace path (#1044).
 * For Node builtins like `import * as http from 'http'`, resolves `http.Server`
 * by trying: deps override → require(root)[className].
 */
export function resolveNamespacedClass(
  namespacePath: string[],
  className: string,
  deps?: Record<string, any>,
): Function | undefined {
  // Check if deps provides the namespace root
  const root = namespacePath[0];
  let ns = deps?.[root];
  if (ns == null) {
    // Try require() for Node builtins (works in both CJS and ESM via createRequire)
    const req = getNodeRequire();
    if (req) {
      try {
        ns = req(root);
      } catch {
        // Not available
      }
    }
  }
  if (ns == null) return undefined;
  // Walk the namespace path beyond the root (e.g. for nested namespaces)
  for (let i = 1; i < namespacePath.length; i++) {
    ns = ns?.[namespacePath[i]];
    if (ns == null) return undefined;
  }
  const Ctor = ns[className];
  return typeof Ctor === "function" ? Ctor : undefined;
}
