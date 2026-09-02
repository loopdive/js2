// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Classify a JavaScript source (or a package's intra-package module graph) by
// the ECMAScript edition it REQUIRES — the newest edition whose features it
// actually uses. Two independent axes, because they cost the compiler
// different work and fail differently:
//
//   * SYNTAX  — what the parser and codegen must understand (`?.` is ES2020
//     grammar; no runtime can polyfill it).
//   * BUILTINS — what the runtime library must provide (`Object.entries` is
//     ES2017 library surface; the grammar is ES5).
//
// A published bundle is usually transpiled, so the two diverge routinely:
// lodash's syntax is ES5 while it feature-detects ES2015 builtins.
//
// The builtin map is DERIVED, not hand-written: TypeScript ships one
// `lib.es<year>.<area>.d.ts` per edition per area, which is the authoritative,
// maintained statement of which edition introduced which global, static and
// prototype member. Hand-curating that list would drift the moment a new
// edition lands; reading it from the installed TypeScript keeps it correct by
// construction and makes every classification traceable to a lib file.
//
// ECMA-402 (`lib.es*.intl.d.ts`) is deliberately excluded — Intl is a separate
// standard, not an ECMA-262 edition, and counting it would report a package as
// needing ES2020 for `Intl.DisplayNames`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import { ts } from "../../src/ts-api.js";

/** The edition every script is allowed to assume; nothing below this is evidence. */
export const BASELINE_EDITION = 5;

/** `lib.esnext.*` members are draft — reported separately, never as a year. */
export const ESNEXT = "ESNext";

/** Files the graph walk will read before it stops, so one huge package cannot stall a report. */
const MAX_GRAPH_FILES = 400;

/** Evidence entries kept per feature bucket — enough to explain, not enough to bloat the artifact. */
const MAX_EVIDENCE_PER_KIND = 12;

// ---------------------------------------------------------------------------
// Syntax → edition
// ---------------------------------------------------------------------------
//
// Keyed by what a reader would call the feature, valued by the edition that
// introduced it. Grammar is stable and small enough to state directly; unlike
// the library surface it does not grow every year in dozens of places.

const SYNTAX_EDITION = {
  // ES2015
  "arrow function": 2015,
  class: 2015,
  "template literal": 2015,
  "tagged template": 2015,
  "for-of": 2015,
  "let/const": 2015,
  destructuring: 2015,
  "default parameter": 2015,
  "rest parameter": 2015,
  spread: 2015,
  "shorthand property": 2015,
  "computed property name": 2015,
  "shorthand method": 2015,
  generator: 2015,
  "new.target": 2015,
  "ES module": 2015,
  // ES2016
  exponentiation: 2016,
  // ES2017
  async: 2017,
  await: 2017,
  // ES2018
  "object spread": 2018,
  "object rest": 2018,
  "for await": 2018,
  "async generator": 2018,
  "regexp dotAll flag": 2018,
  "regexp named capture group": 2018,
  "regexp lookbehind": 2018,
  "regexp unicode property escape": 2018,
  // ES2019
  "optional catch binding": 2019,
  // ES2020
  "optional chaining": 2020,
  "nullish coalescing": 2020,
  "dynamic import": 2020,
  "import.meta": 2020,
  "bigint literal": 2020,
  "export * as ns": 2020,
  // ES2021
  "logical assignment": 2021,
  "numeric separator": 2021,
  // ES2022
  "class field": 2022,
  "private class member": 2022,
  "static block": 2022,
  "top-level await": 2022,
  "regexp hasIndices flag": 2022,
  // ES2024
  "regexp unicodeSets flag": 2024,
  // ES2025
  "import attributes": 2025,
  "using declaration": 2025,
  "regexp modifiers": 2025,
};

// ---------------------------------------------------------------------------
// Builtin map, derived from the installed TypeScript lib files
// ---------------------------------------------------------------------------

/** `lib.<name>.d.ts` files that do not describe an ECMA-262 edition surface. */
function isEcma262Lib(fileName) {
  if (!/^lib\.es(\d{4}|next|5)\./.test(fileName) && fileName !== "lib.es5.d.ts") return false;
  // Aggregators (`lib.es2017.d.ts`, `lib.es2017.full.d.ts`) only `/// <reference>`
  // the real files, so reading them would double-count nothing but cost time.
  if (/\.(full|d)\.ts$/.test(fileName) && /^lib\.es(\d{4}|next)\.d\.ts$/.test(fileName)) return false;
  if (/^lib\.es\d{4}\.full\.d\.ts$/.test(fileName)) return false;
  if (/\.intl\.d\.ts$/.test(fileName)) return false; // ECMA-402, not ECMA-262
  return true;
}

function editionOfLib(fileName) {
  if (fileName === "lib.es5.d.ts") return BASELINE_EDITION;
  const next = /^lib\.esnext\./.test(fileName);
  if (next) return ESNEXT;
  const year = /^lib\.es(\d{4})\./.exec(fileName);
  return year ? Number(year[1]) : null;
}

/** An edition is "newer" than another when it would raise the reported requirement. */
function isNewer(candidate, current) {
  if (candidate === null || candidate === undefined) return false;
  if (current === null || current === undefined) return true;
  if (current === ESNEXT) return false;
  if (candidate === ESNEXT) return true;
  return candidate > current;
}

/** Keep the EARLIEST edition that declares a name — later libs only add overloads. */
function recordEarliest(map, key, edition) {
  const seen = map.get(key);
  if (seen === undefined || isNewer(seen, edition)) map.set(key, edition);
}

let cachedBuiltins = null;

/**
 * Read TypeScript's `lib.es*.d.ts` files into three lookups:
 *
 *   globals         `WeakRef` → 2021              (a `declare var` that did not exist before)
 *   statics         `Object.entries` → 2017       (a member of a `…Constructor` interface)
 *   instanceMembers `flat` → 2019                 (a member of an instance interface)
 *
 * `instanceMembers` is bare-named on purpose: `x.flat()` cannot be attributed
 * to `Array` without type information, so it is reported as a heuristic and
 * never raises the required edition on its own.
 */
export function loadBuiltinEditionMap(libDir = defaultLibDir()) {
  if (cachedBuiltins && cachedBuiltins.libDir === libDir) return cachedBuiltins;

  const globals = new Map();
  const statics = new Map();
  const instanceMembers = new Map();
  // `interface ObjectConstructor` is only reachable as `Object.…` because
  // `declare var Object: ObjectConstructor` says so. Collect that binding
  // first, then attribute each constructor interface's members to the global.
  const constructorInterfaceToGlobal = new Map();
  const pendingStatics = [];
  const libFiles = existsSync(libDir)
    ? readdirSync(libDir)
        .filter((name) => name.endsWith(".d.ts") && isEcma262Lib(name))
        .sort()
    : [];

  for (const fileName of libFiles) {
    const edition = editionOfLib(fileName);
    if (edition === null) continue;
    const source = ts.createSourceFile(
      fileName,
      readFileSync(join(libDir, fileName), "utf-8"),
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );

    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          recordEarliest(globals, declaration.name.text, edition);
          const typeNode = declaration.type;
          if (typeNode && ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
            constructorInterfaceToGlobal.set(typeNode.typeName.text, declaration.name.text);
          }
        }
        continue;
      }
      if (!ts.isInterfaceDeclaration(statement)) continue;
      const interfaceName = statement.name.text;
      const memberNames = [];
      for (const member of statement.members) {
        const name = member.name;
        if (!name) continue;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) memberNames.push(name.text);
      }
      if (memberNames.length === 0) continue;
      // Resolved after the whole sweep: a constructor interface can be
      // declared in an earlier lib file than its `declare var`.
      pendingStatics.push({ interfaceName, memberNames, edition });
    }
  }

  for (const { interfaceName, memberNames, edition } of pendingStatics) {
    const globalName = constructorInterfaceToGlobal.get(interfaceName);
    for (const memberName of memberNames) {
      if (globalName) recordEarliest(statics, `${globalName}.${memberName}`, edition);
      else recordEarliest(instanceMembers, memberName, edition);
    }
  }

  // A name that already exists in ES5 is never evidence, whichever interface
  // re-declares it later (`Array.prototype.includes` is ES2016, but `length`
  // must not be attributed to whatever lib file mentions it last).
  for (const map of [globals, statics, instanceMembers]) {
    for (const [key, edition] of map) if (edition === BASELINE_EDITION) map.delete(key);
  }

  // TypeScript models `globalThis` intrinsically rather than as a `declare var`
  // in any lib file, so the sweep above cannot see it. It is ES2020 surface and
  // common in published bundles, so state it explicitly rather than miss it.
  recordEarliest(globals, "globalThis", 2020);

  cachedBuiltins = { libDir, globals, statics, instanceMembers, libFiles: libFiles.length };
  return cachedBuiltins;
}

function defaultLibDir() {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve("typescript"));
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Single-source classification
// ---------------------------------------------------------------------------

/** RegExp flags introduced after ES5, and the edition that introduced each. */
const REGEXP_FLAG_FEATURES = { s: "regexp dotAll flag", d: "regexp hasIndices flag", v: "regexp unicodeSets flag" };

function classifyRegExpLiteral(text, hit) {
  const lastSlash = text.lastIndexOf("/");
  if (lastSlash <= 0) return;
  const flags = text.slice(lastSlash + 1);
  const body = text.slice(1, lastSlash);
  for (const flag of flags) {
    const feature = REGEXP_FLAG_FEATURES[flag];
    if (feature) hit(feature);
  }
  if (/\(\?<[=!]/.test(body)) hit("regexp lookbehind");
  else if (/\(\?<[A-Za-z_$]/.test(body)) hit("regexp named capture group");
  if (/\\[pP]\{/.test(body)) hit("regexp unicode property escape");
  // `(?i:…)` / `(?-i:…)` — ES2025 inline modifiers. Requiring at least one
  // modifier letter (or a `-`) is what separates them from a plain `(?:…)`
  // non-capturing group, which every regex-heavy bundle uses constantly.
  if (/\(\?[ims]*-[ims]*:/.test(body) || /\(\?[ims]+:/.test(body)) hit("regexp modifiers");
}

/**
 * Walk one parsed source file, reporting every post-ES5 feature it uses.
 * `report(feature, kind, node)` is called once per occurrence; the caller
 * decides how much evidence to keep.
 */
/**
 * Every name the file binds itself. Used to suppress a global-builtin hit when
 * the source declares its own `Promise`/`Symbol` — deliberately a whole-file
 * over-approximation (any same-named binding anywhere suppresses the global),
 * because under-reporting an edition is honest while over-reporting is not.
 */
function collectBoundNames(sourceFile) {
  const bound = new Set();
  const addName = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) bound.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (!ts.isOmittedExpression(element)) addName(element.name);
    }
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) addName(node.name);
    else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) addName(node.name);
    else if (ts.isImportClause(node)) addName(node.name);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) addName(node.name);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return bound;
}

function walkSource(sourceFile, builtins, report) {
  const hit = (feature, node) => report(feature, "syntax", node);
  const boundNames = collectBoundNames(sourceFile);

  /** True when this identifier is a READ of a free variable, not a name in a declaration or member position. */
  const isFreeVariableRead = (node) => {
    const parent = node.parent;
    if (!parent) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isQualifiedName(parent) && parent.right === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
    if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) return parent.name !== node;
    if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return parent.name !== node;
    if (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isFunctionExpression(parent)) {
      return parent.name !== node;
    }
    if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
    return true;
  };

  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.ArrowFunction:
        hit("arrow function", node);
        break;
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression:
        hit("class", node);
        break;
      case ts.SyntaxKind.TemplateExpression:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        hit("template literal", node);
        break;
      case ts.SyntaxKind.TaggedTemplateExpression:
        hit("tagged template", node);
        break;
      case ts.SyntaxKind.ForOfStatement:
        hit(node.awaitModifier ? "for await" : "for-of", node);
        break;
      case ts.SyntaxKind.ObjectBindingPattern:
      case ts.SyntaxKind.ArrayBindingPattern:
        hit("destructuring", node);
        break;
      case ts.SyntaxKind.SpreadElement:
        hit("spread", node);
        break;
      case ts.SyntaxKind.SpreadAssignment:
        hit("object spread", node);
        break;
      case ts.SyntaxKind.ShorthandPropertyAssignment:
        hit("shorthand property", node);
        break;
      case ts.SyntaxKind.ComputedPropertyName:
        hit("computed property name", node);
        break;
      case ts.SyntaxKind.MethodDeclaration:
        hit("shorthand method", node);
        break;
      case ts.SyntaxKind.MetaProperty:
        hit(node.keywordToken === ts.SyntaxKind.ImportKeyword ? "import.meta" : "new.target", node);
        break;
      case ts.SyntaxKind.ImportDeclaration:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.ExportAssignment:
      case ts.SyntaxKind.ImportEqualsDeclaration:
        hit("ES module", node);
        if (node.attributes ?? node.assertClause) hit("import attributes", node);
        if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamespaceExport(node.exportClause)) {
          hit("export * as ns", node);
        }
        break;
      case ts.SyntaxKind.PropertyDeclaration:
        hit("class field", node);
        break;
      case ts.SyntaxKind.ClassStaticBlockDeclaration:
        hit("static block", node);
        break;
      case ts.SyntaxKind.PrivateIdentifier:
        hit("private class member", node);
        break;
      case ts.SyntaxKind.BigIntLiteral:
        hit("bigint literal", node);
        break;
      case ts.SyntaxKind.RegularExpressionLiteral:
        classifyRegExpLiteral(node.getText(sourceFile), (feature) => hit(feature, node));
        break;
      case ts.SyntaxKind.AwaitExpression:
        hit("await", node);
        break;
      case ts.SyntaxKind.PropertyAccessExpression:
      case ts.SyntaxKind.ElementAccessExpression:
      case ts.SyntaxKind.CallExpression:
        if (node.questionDotToken) hit("optional chaining", node);
        break;
      default:
        break;
    }

    if (ts.isVariableDeclarationList(node)) {
      // `AwaitUsing` is `Const | Using`, so testing it directly matches every
      // plain `const`. `Using` is the discriminating bit and covers both forms.
      if ((node.flags & ts.NodeFlags.Using) !== 0) hit("using declaration", node);
      else if ((node.flags & ts.NodeFlags.BlockScoped) !== 0) hit("let/const", node);
    }
    if (ts.isCatchClause(node) && !node.variableDeclaration) hit("optional catch binding", node);
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AsteriskAsteriskToken || op === ts.SyntaxKind.AsteriskAsteriskEqualsToken) {
        hit("exponentiation", node);
      } else if (op === ts.SyntaxKind.QuestionQuestionToken) {
        hit("nullish coalescing", node);
      } else if (
        op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        op === ts.SyntaxKind.BarBarEqualsToken ||
        op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      ) {
        hit("logical assignment", node);
      }
    }
    if (ts.isNumericLiteral(node) && node.getText(sourceFile).includes("_")) hit("numeric separator", node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) hit("dynamic import", node);
    if (ts.isFunctionLike(node)) {
      const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
      const isAsync = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
      if (isAsync && node.asteriskToken) hit("async generator", node);
      else if (isAsync) hit("async", node);
      else if (node.asteriskToken) hit("generator", node);
      for (const parameter of node.parameters ?? []) {
        if (parameter.dotDotDotToken) hit("rest parameter", parameter);
        else if (parameter.initializer) hit("default parameter", parameter);
      }
    }
    if (ts.isObjectBindingPattern(node)) {
      for (const element of node.elements) if (element.dotDotDotToken) hit("object rest", element);
    }

    // Builtins. Only unambiguous forms raise the requirement: `Object.entries`
    // names the global it reads, and a bare `WeakRef` is a global unless the
    // file shadows it. A bare `.flat()` could be any user object, so it is
    // recorded as a heuristic instead.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ts.isIdentifier(node.name)) {
      const qualified = `${node.expression.text}.${node.name.text}`;
      const staticEdition = builtins.statics.get(qualified);
      if (staticEdition !== undefined) report(qualified, "builtin", node, staticEdition);
      else {
        const memberEdition = builtins.instanceMembers.get(node.name.text);
        if (memberEdition !== undefined) report(`.${node.name.text}`, "builtin-heuristic", node, memberEdition);
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      const memberEdition = builtins.instanceMembers.get(node.name.text);
      if (memberEdition !== undefined) report(`.${node.name.text}`, "builtin-heuristic", node, memberEdition);
    } else if (ts.isIdentifier(node) && !boundNames.has(node.text) && isFreeVariableRead(node)) {
      // A global the file neither declares nor imports: `new WeakRef(…)` needs
      // ES2021 from the runtime however old the surrounding grammar is.
      const globalEdition = builtins.globals.get(node.text);
      if (globalEdition !== undefined) report(node.text, "builtin", node, globalEdition);
    }

    ts.forEachChild(node, visit);
  };

  // A module's own top level is the one place `await` means ES2022, so classify
  // it before the generic walk reaches the AwaitExpression above.
  const markTopLevelAwait = (statements) => {
    const scan = (node) => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
        report("top-level await", "syntax", node);
      }
      ts.forEachChild(node, scan);
    };
    for (const statement of statements) scan(statement);
  };
  if (ts.isExternalModule(sourceFile)) markTopLevelAwait(sourceFile.statements);

  for (const statement of sourceFile.statements) visit(statement);
}

/**
 * Classify a single source text. `fileName` only labels the evidence.
 */
export function classifySource(source, fileName = "input.js", options = {}) {
  return classifySources([{ fileName, source }], options);
}

/**
 * Classify a set of already-read sources as ONE unit — a package's own module
 * graph, for example. The reported edition is the newest any file requires.
 */
export function classifySources(files, options = {}) {
  const builtins = options.builtins ?? loadBuiltinEditionMap();
  const featureEditions = new Map();
  const evidence = { syntax: [], builtin: [], "builtin-heuristic": [] };
  const counts = { syntax: 0, builtin: 0, "builtin-heuristic": 0 };
  let syntaxEdition = null;
  let builtinEdition = null;
  const parseErrors = [];

  for (const { fileName, source } of files) {
    let sourceFile;
    try {
      sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    } catch (error) {
      parseErrors.push({ fileName, message: error instanceof Error ? error.message : String(error) });
      continue;
    }

    walkSource(sourceFile, builtins, (feature, kind, node, editionOverride) => {
      const edition = editionOverride ?? SYNTAX_EDITION[feature];
      if (edition === undefined || edition === null) return;
      counts[kind] += 1;
      if (!featureEditions.has(feature)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        featureEditions.set(feature, edition);
        // Collect every DISTINCT feature (bounded by the feature maps, not by
        // file size) and trim only after sorting by edition. Trimming during
        // collection dropped whichever feature happened to be encountered late
        // — including the one that set the headline edition, which then had no
        // evidence behind it at all (stylelint read "ES2025" with nothing above
        // ES2020 listed).
        evidence[kind].push({ feature, edition, file: fileName, line: line + 1 });
      }
      if (kind === "syntax" && isNewer(edition, syntaxEdition)) syntaxEdition = edition;
      if (kind === "builtin" && isNewer(edition, builtinEdition)) builtinEdition = edition;
    });
  }

  const required = isNewer(builtinEdition, syntaxEdition) ? builtinEdition : (syntaxEdition ?? builtinEdition);
  // Newest first, so the entries that justify the headline edition survive the
  // trim and read first.
  const sortEvidence = (list) =>
    list.sort((a, b) => editionRank(b.edition) - editionRank(a.edition)).slice(0, MAX_EVIDENCE_PER_KIND);

  return {
    required: required ?? BASELINE_EDITION,
    syntax: syntaxEdition ?? BASELINE_EDITION,
    builtins: builtinEdition ?? BASELINE_EDITION,
    evidence: {
      syntax: sortEvidence(evidence.syntax),
      builtins: sortEvidence(evidence.builtin),
      // Kept apart because it never raises `required`: a bare `.flat()` may
      // well be a user method, and saying so is the difference between a
      // classification and a guess.
      heuristic: sortEvidence(evidence["builtin-heuristic"]),
    },
    featureCounts: counts,
    scannedFiles: files.length,
    parseErrors,
  };
}

function editionRank(edition) {
  return edition === ESNEXT ? Number.MAX_SAFE_INTEGER : Number(edition) || 0;
}

/** `2020` → `"ES2020"`, `5` → `"ES5"`, `"ESNext"` → `"ESNext"`. */
export function formatEdition(edition) {
  if (edition === ESNEXT) return ESNEXT;
  if (edition === BASELINE_EDITION) return "ES5";
  return `ES${edition}`;
}

// ---------------------------------------------------------------------------
// Package module graph
// ---------------------------------------------------------------------------

const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs"];

function resolveWithinPackage(specifier, fromFile, packageRoot) {
  if (!specifier.startsWith(".")) return null; // a dependency, not this package's code
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, ...SCRIPT_EXTENSIONS.map((ext) => base + ext)];
  for (const ext of SCRIPT_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (extname(candidate) === "") continue; // a directory that matched `base`
    const inside = relative(packageRoot, candidate);
    if (inside.startsWith("..") || isAbsolute(inside)) return null;
    return candidate;
  }
  return null;
}

/** Every `import`/`export … from`/`require()`/`import()` specifier in a source. */
function collectSpecifiers(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const first = node.arguments[0];
      if ((isRequire || isDynamicImport) && first && ts.isStringLiteral(first)) specifiers.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

/**
 * Read the package's own module graph starting at `entryPath`, following only
 * relative specifiers so the walk stops at the package boundary.
 *
 * Following the graph rather than reading the entry alone is what makes the
 * answer honest for a gate module: react's `index.js` is five lines that
 * `require` one of two real builds, and classifying those five lines would
 * report ES5 for a package whose implementation is not ES5 at all. External
 * dependencies are counted, not followed — a barrel package that re-exports
 * siblings gets a visible `externalDependencies` number instead of a silent
 * "ES5".
 */
export function readPackageGraph(entryPath, packageRoot, options = {}) {
  const limit = options.maxFiles ?? MAX_GRAPH_FILES;
  const files = [];
  const seen = new Set();
  const external = new Set();
  const queue = [resolve(entryPath)];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (files.length >= limit) {
      truncated = true;
      break;
    }
    let source;
    try {
      source = readFileSync(current, "utf-8");
    } catch {
      continue;
    }
    files.push({ fileName: relative(packageRoot, current) || current, source, path: current });
    let sourceFile;
    try {
      sourceFile = ts.createSourceFile(current, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    } catch {
      continue;
    }
    for (const specifier of collectSpecifiers(sourceFile)) {
      const resolved = resolveWithinPackage(specifier, current, packageRoot);
      if (resolved) queue.push(resolved);
      else if (!specifier.startsWith(".")) external.add(specifier);
    }
  }

  return { files, externalDependencies: [...external].sort(), truncated };
}

/**
 * Classify a package: read its graph from `entryPath`, then classify every file
 * in it as one unit.
 */
export function classifyPackage(entryPath, packageRoot, options = {}) {
  const graph = readPackageGraph(entryPath, packageRoot, options);
  if (graph.files.length === 0) {
    return { required: null, syntax: null, builtins: null, unavailable: "entry module could not be read" };
  }
  const classification = classifySources(graph.files, options);
  return {
    ...classification,
    externalDependencies: graph.externalDependencies,
    graphTruncated: graph.truncated,
  };
}
