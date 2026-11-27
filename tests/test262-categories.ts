// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * test262 discovery: which directories the runner walks and which files in
 * them are tests. Kept free of compiler imports so tools that only need the
 * file set (the #7551 current-edition scope) share it with the runner instead
 * of re-deriving it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Categories of test262 tests to scan */
export const TEST_CATEGORIES = [
  // ── harness self-tests ──
  "harness",
  // ── language ──
  "language/arguments-object",
  "language/asi",
  "language/block-scope",
  "language/comments",
  "language/computed-property-names",
  "language/destructuring",
  "language/directive-prologue",
  "language/eval-code",
  "language/export",
  "language/expressions",
  "language/function-code",
  "language/future-reserved-words",
  "language/global-code",
  "language/identifier-resolution",
  "language/identifiers",
  "language/import",
  "language/keywords",
  "language/line-terminators",
  "language/literals",
  "language/module-code",
  "language/punctuators",
  "language/reserved-words",
  "language/rest-parameters",
  "language/source-text",
  "language/statementList",
  "language/statements",
  "language/types",
  "language/white-space",
  // ── built-ins (consolidated — each entry covers all subdirectories) ──
  "built-ins/AbstractModuleSource",
  "built-ins/AggregateError",
  "built-ins/Array",
  "built-ins/ArrayBuffer",
  "built-ins/ArrayIteratorPrototype",
  "built-ins/AsyncDisposableStack",
  "built-ins/AsyncFromSyncIteratorPrototype",
  "built-ins/AsyncFunction",
  "built-ins/AsyncGeneratorFunction",
  "built-ins/AsyncGeneratorPrototype",
  "built-ins/AsyncIteratorPrototype",
  "built-ins/Atomics",
  "built-ins/BigInt",
  "built-ins/Boolean",
  "built-ins/DataView",
  "built-ins/Date",
  "built-ins/DisposableStack",
  "built-ins/Error",
  "built-ins/FinalizationRegistry",
  "built-ins/Function",
  "built-ins/GeneratorFunction",
  "built-ins/GeneratorPrototype",
  "built-ins/Infinity",
  "built-ins/Iterator",
  "built-ins/JSON",
  "built-ins/Map",
  "built-ins/MapIteratorPrototype",
  "built-ins/Math",
  "built-ins/NaN",
  "built-ins/NativeErrors",
  "built-ins/Number",
  "built-ins/Object",
  "built-ins/Promise",
  "built-ins/Proxy",
  "built-ins/Reflect",
  "built-ins/RegExp",
  "built-ins/RegExpStringIteratorPrototype",
  "built-ins/Set",
  "built-ins/SetIteratorPrototype",
  "built-ins/ShadowRealm",
  "built-ins/SharedArrayBuffer",
  "built-ins/String",
  "built-ins/StringIteratorPrototype",
  "built-ins/SuppressedError",
  "built-ins/Symbol",
  "built-ins/Temporal",
  "built-ins/ThrowTypeError",
  "built-ins/TypedArray",
  "built-ins/TypedArrayConstructors",
  "built-ins/Uint8Array",
  "built-ins/WeakMap",
  "built-ins/WeakRef",
  "built-ins/WeakSet",
  "built-ins/decodeURI",
  "built-ins/decodeURIComponent",
  "built-ins/encodeURI",
  "built-ins/encodeURIComponent",
  "built-ins/eval",
  "built-ins/global",
  "built-ins/isFinite",
  "built-ins/isNaN",
  "built-ins/parseFloat",
  "built-ins/parseInt",
  "built-ins/undefined",
  // ── annexB (legacy browser behaviors, standard test262 format) ──
  "annexB/built-ins",
  "annexB/language",
];

/** A test file, as opposed to a fixture or a module-graph helper. */
function isTest262TestFile(name: string): boolean {
  return name.endsWith(".js") && !name.includes("_FIXTURE") && !name.endsWith(".imports.js");
}

/** Every test file under `test/<category>`, sorted. */
export function findCategoryTestFiles(category: string, test262Root: string): string[] {
  const dir = join(test262Root, "test", category);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isTest262TestFile(entry.name)) files.push(full);
    }
  }
  walk(dir);
  return files.sort();
}
