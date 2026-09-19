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

/**
 * (#6491 round 3) Classify a Test262 source as explicitly **Script** goal.
 *
 * NOT `!isModuleGoal(...)`, and the difference is the whole point. `isModuleGoal`
 * falls back to SYNTAX (`ts.isExternalModule`) when the metadata is silent, so
 * for `language/global-code/export.js` — a Script test whose body is
 * `export default null;` precisely because that is illegal in a Script — the
 * syntax fallback answers "module" and its negation answers "not a Script".
 * That is backwards for exactly the rows the Script-goal rules exist to catch.
 *
 * So this reads metadata ONLY: a test is Script goal when it carries no
 * `flags: [module]`, does not live under a module-only path, and is not `raw`
 * (a raw test has no harness and is deliberately left alone). Silence in the
 * metadata is meaningful here — test262 marks module tests explicitly — which
 * is what makes this a fact rather than the guess `!moduleGoal` would be for a
 * product compile.
 */
export function isScriptGoal(pathOrCategory, metaOrFlags) {
  if (hasAuthoritativeModulePath(pathOrCategory)) return false;
  if (hasModuleFlag(metaOrFlags)) return false;
  const flags = metaOrFlags?.flags ?? metaOrFlags;
  const raw = Array.isArray(flags) ? flags.includes("raw") : flags instanceof Set ? flags.has("raw") : false;
  return !raw;
}
