// Extracts React's REAL upstream unit tests from the pinned source checkout.
//
// React's published tarball ships no tests, and — unlike acorn, whose
// `test/driver.js` is deliberately decoupled from any acorn build — React's
// suite is welded to Jest, `internal-test-utils`, ReactDOM and a jsdom
// document. There is no upstream entry point that can be handed a `React` and
// asked to run.
//
// So this module does the next most faithful thing: it reads the upstream test
// FILES verbatim from the verified commit, transpiles their JSX with the
// classic runtime (`<div/>` -> `React.createElement('div', null)`, which is
// exactly what React's own jest transform does), and lifts each `it(...)` body
// out with its enclosing `describe` scope and `beforeEach` prelude. Test names,
// bodies and assertions are upstream's — nothing is transcribed or reworded.
//
// EVERY upstream test is admitted by default (`admitAll`), including the ones
// that reach for ReactDOM, `act`, the console-assertion helpers, `jest.*`, a
// `document` or `__DEV__`, and including `async` bodies — those compile to
// async exports and are awaited on both sides. They are expected to fail; a
// failure that is RUN and counted is more honest than a test filtered out
// before it runs.
//
// The only STRUCTURAL rejection left is a `done`-callback signature, which
// cannot be turned into a callable function without a scheduler to invoke it.
// `INFRA_PATTERNS` / `SUPPORTED_MATCHERS` below are therefore no longer an
// admission filter by default — they are the conservative mode kept behind
// `admitAll: false` (`DOGFOOD_REACT_ADMIT_ALL=0`), still used for the prelude
// filter, and every rejection they do make is recorded with its reason.
//
// What protects the pass rate is the NATIVE ORACLE, not the filter: a test the
// oracle also fails is `harness-incompatible` and sits outside the score.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Constructs the harness cannot supply. Order matters only for which reason
// gets reported first.
const INFRA_PATTERNS = [
  [/\bReactDOM\w*\b/, "needs-react-dom"],
  [/\bReactNoop\b/, "needs-react-noop"],
  [/\bReactTestUtils\b/, "needs-test-utils"],
  [/(^|[^.\w])act\s*\(/, "needs-act"],
  [/assertConsole\w*/, "needs-console-assertions"],
  [/\bjest\b/, "needs-jest-runtime"],
  [/\bdocument\b/, "needs-dom"],
  [/\b__DEV__\b/, "dev-build-only"],
  [/ReactFeatureFlags/, "needs-feature-flags"],
  [/\bScheduler\b/, "needs-scheduler"],
  [/\bwaitFor\w*\s*\(/, "needs-scheduler"],
  [/\bconsole\s*\./, "asserts-on-console"],
  [/require\(\s*['"](?!react['"])/, "needs-external-module"],
];

// Matchers the in-module `expect` shim implements. A test using anything else
// is rejected rather than silently mis-scored.
const SUPPORTED_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toThrow",
  "toThrowError",
  "toContain",
  "toBeNull",
  "toBeUndefined",
  "toBeDefined",
  "toBeTruthy",
  "toBeFalsy",
  "toBeInstanceOf",
  "toHaveLength",
]);

function transpileJsx(source, fileName) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      reactNamespace: "React",
      removeComments: false,
    },
  }).outputText;
}

const LIFECYCLE = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);
const TEST_CALLS = new Set(["it", "test"]);

function calleeName(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  // `it.only` / `it.each` / `describe.skip`
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

// A prelude statement is kept unless it only exists to wire up Jest module
// mocking or to pull in infrastructure this harness deliberately does not have.
// `React = require('react')` is rewritten to bind the module under test.
function filterPreludeStatement(statement, sourceFile) {
  const text = statement.getText(sourceFile);
  if (/^\s*['"]use strict['"]/.test(text)) return null;
  // Scaffolding that only exists to wire up the infrastructure this harness
  // deliberately does not have (`let ReactDOMClient;`, the `internal-test-utils`
  // destructure, `jest.resetModules()`). Dropping it here rather than rejecting
  // the whole test is what makes React's pure-API tests reachable at all: they
  // sit in the same `describe` as the ReactDOM ones and share its prelude. A
  // test that actually USES one of these names still gets rejected, because
  // `classifyBody` re-scans the surviving prelude together with the body.
  for (const [pattern] of INFRA_PATTERNS) if (pattern.test(text)) return null;
  if (/require\(\s*['"]react['"]\s*\)/.test(text)) {
    return text.replace(/require\(\s*['"]react['"]\s*\)/g, "__REACT__");
  }
  return text;
}

// Every binding a statement introduces (declaration, function/class name, or
// plain assignment target). Used to reject a test whose body reaches for a name
// that only existed on a prelude statement this harness had to drop — otherwise
// the test would fail with `X is not defined` and read as a compiler bug.
function declaredNames(node, into = new Set()) {
  const addBinding = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) into.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      for (const element of name.elements) if (ts.isBindingElement(element)) addBinding(element.name);
  };

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) addBinding(declaration.name);
  } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    addBinding(node.name);
  } else if (ts.isExpressionStatement(node)) {
    let expression = node.expression;
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = expression.left;
      if (ts.isIdentifier(target)) into.add(target.text);
      else if (ts.isObjectLiteralExpression(target))
        for (const property of target.properties) {
          if (ts.isShorthandPropertyAssignment(property)) into.add(property.name.text);
          else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer))
            into.add(property.initializer.text);
        }
    }
  }
  return into;
}

// Any `.toSomething(` / `.resolves` / `.rejects` call the shim would have to
// honour. Over-collecting is harmless (a supported matcher costs nothing);
// under-collecting is not, because an unimplemented matcher would silently
// score a test the shim never actually checked.
function matcherRejection(text) {
  for (const match of text.matchAll(/\.\s*([a-zA-Z][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (!/^(to[A-Z]|resolves|rejects)/.test(name)) continue;
    if (!SUPPORTED_MATCHERS.has(name)) return `unsupported-matcher:${name}`;
  }
  return null;
}

function classifyBody(fn, text, bodyText, droppedNames, admitAll) {
  // STRUCTURAL rejection — a `done`-callback test never resolves without a
  // scheduler to call it, so it cannot be turned into a callable function at
  // all. `async` bodies ARE runnable: they compile to an async export and are
  // awaited on both sides (see `isAsync` below).
  if (fn.parameters.length > 0) return "needs-done-callback";

  // CAPABILITY rejections — the test is shaped fine, the harness just cannot
  // supply what it reaches for. `admitAll` runs them anyway: they are expected
  // to fail, and a failure that is RUN and counted is more honest than a test
  // that is quietly filtered out. The native oracle still sorts them into
  // `harness-incompatible` rather than blaming the compiler.
  if (admitAll) return null;

  for (const [pattern, reason] of INFRA_PATTERNS) if (pattern.test(text)) return reason;
  // Only the BODY is checked against dropped names. The surviving prelude may
  // still *declare* one (`let act;` sits above the `internal-test-utils`
  // destructure that was dropped), which is harmless — an unused binding. A
  // dropped name in the body is not: it would throw `X is not defined` and read
  // as a compiler bug.
  for (const name of droppedNames) {
    if (new RegExp(`\\b${name}\\b`).test(bodyText)) return "needs-dropped-scaffolding";
  }
  return matcherRejection(text);
}

/**
 * @returns {{ tests: Array<object>, rejected: Array<object>, rejectionCounts: Record<string, number> }}
 */
export function extractReactUpstreamTests({ root, testFiles, admitAll = false }) {
  const tests = [];
  const rejected = [];

  for (const relativePath of testFiles) {
    const raw = readFileSync(join(root, relativePath), "utf-8");
    const transpiled = transpileJsx(raw, relativePath);
    const sourceFile = ts.createSourceFile(relativePath, transpiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

    /**
     * Walks a statement list, threading the accumulated describe-scope prelude
     * (plain statements) and beforeEach prelude down into nested describes,
     * exactly matching Jest's scoping.
     */
    const walk = (statements, suitePath, scopePrelude, eachPrelude, droppedNames) => {
      const localScope = [...scopePrelude];
      const localEach = [...eachPrelude];
      const localDropped = new Set(droppedNames);
      const pending = [];

      const keep = (statement, sink) => {
        const kept = filterPreludeStatement(statement, sourceFile);
        if (kept === null) declaredNames(statement, localDropped);
        else sink.push(kept);
      };

      for (const statement of statements) {
        const expression = ts.isExpressionStatement(statement) ? statement.expression : null;
        const name = expression ? calleeName(expression) : null;

        if (name === "describe") {
          pending.push({ kind: "describe", node: expression, statement });
          continue;
        }
        if (name && TEST_CALLS.has(name)) {
          pending.push({ kind: "test", node: expression, statement });
          continue;
        }
        if (name && LIFECYCLE.has(name)) {
          if (name === "beforeEach") {
            const fn = expression.arguments[0];
            if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) {
              for (const inner of fn.body.statements) keep(inner, localEach);
            }
          }
          continue;
        }
        keep(statement, localScope);
      }

      for (const entry of pending) {
        const title = entry.node.arguments[0];
        const label = title && ts.isStringLiteralLike(title) ? title.text : "<computed>";

        if (entry.kind === "describe") {
          const fn = entry.node.arguments[1];
          if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) {
            walk(fn.body.statements, [...suitePath, label], localScope, localEach, localDropped);
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
        const reason = classifyBody(fn, `${preludeText}\n${bodyText}`, bodyText, localDropped, admitAll);
        if (reason) {
          rejected.push({ ...record, reason });
          continue;
        }

        tests.push({
          ...record,
          prelude: preludeText,
          body: bodyText,
          isAsync: fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true,
        });
      }
    };

    walk(sourceFile.statements, [], [], [], new Set());
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

  return { tests, rejected, rejectionCounts };
}
