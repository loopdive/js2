// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";

const MODULE_GOAL_PATH_PREFIXES = ["language/module-code", "language/import", "language/export"];

function normalizedTest262Path(pathOrCategory) {
  return String(pathOrCategory ?? "")
    .replaceAll("\\", "/")
    .replace(/^.*\/test262\/test\//, "")
    .replace(/^\.\//, "")
    .replace(/^test\//, "")
    .replace(/^\/+/, "");
}

function hasAuthoritativeModulePath(pathOrCategory) {
  const normalized = normalizedTest262Path(pathOrCategory);
  return MODULE_GOAL_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function hasModuleFlag(metaOrFlags) {
  const flags = metaOrFlags?.flags ?? metaOrFlags;
  if (Array.isArray(flags)) return flags.includes("module");
  if (flags instanceof Set) return flags.has("module");
  return Boolean(flags?.module);
}

/**
 * Detect JavaScript syntax that selects Module goal without treating dynamic
 * import() as a Module marker. TypeScript's external-module AST signal covers
 * static imports, every export form, and import.meta while ignoring trivia and
 * literal contents.
 */
export function hasModuleSyntax(source, fileName = "test.js") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return ts.isExternalModule(sourceFile);
}

/**
 * Classify a Test262 source as Script or Module goal.
 *
 * Test262 metadata and the runner's module-only path categories are
 * authoritative. Other paths fall back to parser/AST syntax classification.
 * `metaOrFlags` accepts either project-runner metadata (`{ flags: [...] }`) or
 * test262.fyi's flag map (`{ module: true }`).
 */
export function isModuleGoal(pathOrCategory, metaOrFlags, source) {
  if (hasAuthoritativeModulePath(pathOrCategory)) return true;
  if (hasModuleFlag(metaOrFlags)) return true;
  return hasModuleSyntax(source, normalizedTest262Path(pathOrCategory) || "test.js");
}
