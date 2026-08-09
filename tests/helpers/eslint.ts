// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3653 — resolve the committed ESLint devDependency from the test module,
// never from the process cwd or a container-specific absolute path.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromTests = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function findEslintPackageRoot(): string | null {
  // Keep the logical node_modules path when it exists. compileProject uses
  // that package boundary while tracing relative and package imports; turning
  // it into pnpm's physical store path breaks those lookups.
  const logicalRoot = resolve(repositoryRoot, "node_modules/eslint");
  if (existsSync(resolve(logicalRoot, "package.json"))) {
    return logicalRoot;
  }

  // Fall back to Node's resolver for non-standard dependency layouts.
  try {
    return dirname(requireFromTests.resolve("eslint/package.json"));
  } catch {
    return null;
  }
}

/** Visible suffix for tests that explicitly skip without installed devDependencies. */
export const ESLINT_DEV_DEPENDENCY_SKIP = "[requires installed eslint devDependency]";

/** Installed ESLint package root, preferring the repository's logical symlink. */
export const eslintPackageRoot = findEslintPackageRoot();

/** Resolve a file inside the installed ESLint package without assuming cwd/store layout. */
export function resolveEslintFile(relativePath: string): string | null {
  if (eslintPackageRoot === null) return null;
  const candidate = resolve(eslintPackageRoot, relativePath);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Convert a nullable optional-fixture path into a required path inside a test
 * body. Callers pair this with `it.skipIf(path === null)` so an unexpectedly
 * executed test fails clearly instead of returning early.
 */
export function requireEslintFile(path: string | null, relativePath: string): string {
  if (path === null) {
    throw new Error(`ESLint fixture '${relativePath}' is unavailable; install the repository devDependencies`);
  }
  return path;
}

/** Create a Node require scoped to ESLint's importer context. */
export function createRequireFromEslint(relativePath = "lib/linter/linter.js"): ReturnType<typeof createRequire> {
  const entry = requireEslintFile(resolveEslintFile(relativePath), relativePath);
  return createRequire(entry);
}
