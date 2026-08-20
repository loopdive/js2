// Extracts lit's REAL upstream unit tests from the pinned monorepo checkout.
//
// None of lit's tarballs ship tests, and lit's suite is welded to a browser:
// it runs under Web Test Runner against a real `document`, registers custom
// elements, and asserts on rendered DOM. There is no build-independent driver
// as there is for acorn.
//
// So this module does what the React harness does: it reads the upstream test
// FILES verbatim from the verified commit, transpiles their TypeScript (the
// tests are `.ts`, and the `decorators/` and `decorators-modern/` trees use
// LEGACY and STANDARD decorators respectively — each is transpiled with the
// setting upstream itself uses), and lifts each `test(...)` body out with its
// enclosing `suite` scope and `setup` prelude. Test names, bodies and
// assertions are upstream's; nothing is transcribed or reworded.
//
// EVERY upstream test is admitted by default (`admitAll`), including the ~90 %
// that need a DOM. They are expected to fail; a failure that is RUN and counted
// is more honest than a test filtered out before it runs. The native oracle —
// the same generated source run against the same published lit — is what sorts
// those into `harness-incompatible` so they are never blamed on the compiler.
//
// The only STRUCTURAL rejection is a `done`-callback signature, which cannot be
// turned into a callable function without a scheduler to invoke it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Constructs the harness cannot supply, used only in the conservative
// `admitAll: false` mode and for the prelude filter. Every rejection they make
// is recorded with its reason.
const INFRA_PATTERNS = [
  [/\bdocument\b/, "needs-dom"],
  [/\bcustomElements\b/, "needs-custom-elements"],
  [/\bwindow\b/, "needs-window"],
  [/\bHTMLElement\b/, "needs-dom"],
  [/\bShadowRoot\b/, "needs-shadow-dom"],
  [/\bgetComputedStyle\b/, "needs-dom"],
  [/\bCSSStyleSheet\b/, "needs-constructable-stylesheets"],
  [/litHtmlPolyfillSupport|litElementPolyfillSupport/, "needs-polyfill-support"],
  [/\bglobalThis\.litIssuedWarnings\b/, "needs-dev-mode-warnings"],
];

// chai is not compiled into the module — the shim implements the `assert`
// surface lit's tests actually use, and the SAME shim source runs on both
// sides so a divergence is always the compiler.
const CHAI_SPECIFIERS = new Set(["chai", "@esm-bundle/chai", "chai/chai.js"]);

// The three published packages under test. An import of anything else (lit's
// repo-internal `test-utils`, `@web/test-runner`, node builtins) is resolved to
// a stub that throws on use — the test still RUNS and still fails on both
// sides, rather than being dropped before it can be counted.
const IMPLEMENTATION_PACKAGES = /^(lit|lit-html|lit-element|@lit\/reactive-element)(\/.*)?$/;

const LIFECYCLE = new Set(["setup", "teardown", "suiteSetup", "suiteTeardown", "beforeEach", "afterEach"]);
const TEST_CALLS = new Set(["test", "it"]);
const SUITE_CALLS = new Set(["suite", "describe"]);

// `decorators-modern` uses TC39 standard decorators; `decorators` uses the
// legacy experimental ones. Transpiling either with the wrong flag silently
// emits the other semantics, so the path decides — same as upstream's own
// tsconfig split.
function transpileTypeScript(source, fileName) {
  const legacyDecorators = !fileName.includes("decorators-modern");
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: legacyDecorators,
      emitDecoratorMetadata: false,
      useDefineForClassFields: !legacyDecorators,
      removeComments: false,
    },
  }).outputText;
}

function calleeName(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return callee.expression.text;
  return null;
}

function isSkipped(node) {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.name) &&
    (callee.name.text === "skip" || callee.name.text === "todo")
  );
}

/**
 * Collects the bindings an import declaration introduces, and how to recover
 * each one from the bundled namespace object. Returns null for a type-only or
 * side-effect-only import, which contributes no binding.
 */
function readImport(statement) {
  const specifier = statement.moduleSpecifier;
  if (!ts.isStringLiteralLike(specifier)) return null;
  const from = specifier.text;
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) return null;

  const bindings = [];
  if (clause.name) bindings.push({ local: clause.name.text, imported: "default" });
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    bindings.push({ local: named.name.text, imported: "*" });
  } else if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      bindings.push({ local: element.name.text, imported: (element.propertyName ?? element.name).text });
    }
  }
  if (bindings.length === 0) return null;
  return { from, bindings, isChai: CHAI_SPECIFIERS.has(from), isImplementation: IMPLEMENTATION_PACKAGES.test(from) };
}

function classifyBody(fn, text, admitAll, supportedInfrastructure) {
  // STRUCTURAL — a `done`-callback test never resolves without a scheduler to
  // call it. `async` bodies ARE runnable: they compile to an async export and
  // are awaited on both sides.
  if (fn.parameters.length > 0) return "needs-done-callback";
  if (admitAll) return null;
  for (const [pattern, reason] of INFRA_PATTERNS) {
    if (!supportedInfrastructure.has(reason) && pattern.test(text)) return reason;
  }
  return null;
}

/**
 * @returns {{ files: Array<object>, tests: Array<object>, rejected: Array<object>,
 *             rejectionCounts: Record<string, number> }}
 */
export function extractLitUpstreamTests({ root, testFiles, admitAll = true, supportedInfrastructure = new Set() }) {
  const tests = [];
  const rejected = [];
  const files = [];

  for (const relativePath of testFiles) {
    const raw = readFileSync(join(root, relativePath), "utf-8");
    let transpiled;
    try {
      transpiled = transpileTypeScript(raw, relativePath);
    } catch (error) {
      rejected.push({
        file: relativePath,
        suite: "",
        name: "<file>",
        fullName: relativePath,
        reason: `transpile-failed:${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const sourceFile = ts.createSourceFile(relativePath, transpiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    // Imports become the bundle entry for this file, not prelude text: the
    // bindings are recovered by destructuring the bundled namespace.
    const fileImports = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      const parsed = readImport(statement);
      if (parsed && !parsed.isChai) fileImports.push(parsed);
    }

    const fileRecord = { file: relativePath, imports: fileImports, tests: [] };

    const walk = (statements, suitePath, scopePrelude, eachPrelude) => {
      const localScope = [...scopePrelude];
      const localEach = [...eachPrelude];
      const pending = [];

      for (const statement of statements) {
        if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) continue;
        const expression = ts.isExpressionStatement(statement) ? statement.expression : null;
        const name = expression ? calleeName(expression) : null;

        if (name && SUITE_CALLS.has(name)) {
          pending.push({ kind: "suite", node: expression });
          continue;
        }
        if (name && TEST_CALLS.has(name)) {
          pending.push({ kind: "test", node: expression });
          continue;
        }
        if (name && LIFECYCLE.has(name)) {
          // `setup` is mocha's per-test hook — it is upstream's own prelude and
          // must run before each body or the test is not the test upstream wrote.
          if (name === "setup" || name === "beforeEach") {
            const fn = expression.arguments[0];
            if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) {
              for (const inner of fn.body.statements) localEach.push(inner.getText(sourceFile));
            }
          }
          continue;
        }
        const text = statement.getText(sourceFile);
        if (/^\s*['"]use strict['"]/.test(text)) continue;
        localScope.push(text);
      }

      for (const entry of pending) {
        const title = entry.node.arguments[0];
        const label = title && ts.isStringLiteralLike(title) ? title.text : "<computed>";

        if (entry.kind === "suite") {
          const fn = entry.node.arguments[1];
          if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) {
            walk(fn.body.statements, [...suitePath, label], localScope, localEach);
          }
          continue;
        }

        const fullName = [...suitePath, label].join(" › ");
        const record = { file: relativePath, suite: suitePath.join(" › "), name: label, fullName };

        if (isSkipped(entry.node)) {
          rejected.push({ ...record, reason: "upstream-skipped" });
          continue;
        }
        const fn = entry.node.arguments[1];
        if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !ts.isBlock(fn.body)) {
          rejected.push({ ...record, reason: "no-block-body" });
          continue;
        }

        const bodyText = fn.body.statements.map((statement) => statement.getText(sourceFile)).join("\n");
        const preludeText = [...localScope, ...localEach].join("\n");
        const reason = classifyBody(fn, `${preludeText}\n${bodyText}`, admitAll, supportedInfrastructure);
        if (reason) {
          rejected.push({ ...record, reason });
          continue;
        }

        const test = {
          ...record,
          prelude: preludeText,
          body: bodyText,
          isAsync: fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true,
        };
        tests.push(test);
        fileRecord.tests.push(test);
      }
    };

    walk(sourceFile.statements, [], [], []);
    files.push(fileRecord);
  }

  // Stable, collision-free identifiers for the generated Wasm exports.
  const seen = new Map();
  for (const test of tests) {
    const base = `t_${test.file.replace(/[^a-zA-Z0-9]/g, "_")}_${test.name.replace(/[^a-zA-Z0-9]/g, "_")}`.slice(0, 90);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    test.id = count === 0 ? base : `${base}_${count}`;
  }

  const rejectionCounts = {};
  for (const entry of rejected) rejectionCounts[entry.reason] = (rejectionCounts[entry.reason] ?? 0) + 1;

  return { files, tests, rejected, rejectionCounts };
}
