// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1936 — Async call-site census.
 *
 * Mirrors `check:ir-fallbacks`: walks a fixed corpus, classifies every consumer
 * of an async-call result, and classifies every async-function *definition* by
 * whether its await shape is CPS-lowerable. The output is the migration surface
 * for #1796 (the global `ASYNC_CPS_ENABLED` flip): the call sites that consume
 * an async result *as a raw value* and whose callee genuinely suspends are
 * exactly the contract breaks #1796 must teach to drive a Promise.
 *
 * This script is **report-only** (no gate / baseline). It re-implements the
 * classification with a checker-only async-call detector so it needs no
 * `CodegenContext`; the consumer classifier and the suspension predicate are the
 * same logic the compiler uses (`classifyAsyncConsumer` / `awaitIsStaticallyResolved`
 * / `splitBodyAtAwait` in `src/codegen/async-cps.ts`), kept in lock-step by
 * `tests/async-census.test.ts`.
 *
 * Consumer buckets (per async call site):
 *   - await    — consumed by an enclosing `await` (raw-T passthrough today).
 *   - value    — consumed through a non-Promise cast/assertion (`f() as number`):
 *                the synchronous-consumption contract that blocks the flip.
 *   - thenable — consumed as a real Promise (`.then`, `Promise.all`, typed
 *                binding, bare `return f()`): already spec-correct.
 *
 * Definition buckets (per async function/arrow/method):
 *   - no-await          — no await points; trivially sync.
 *   - await-elidable    — all awaits statically resolved; compiles as sync + a
 *                         fulfilled Promise (no CPS cost).
 *   - cps-able          — genuinely suspends AND `splitBodyAtAwait` accepts it.
 *   - cps-unsupported   — genuinely suspends but the body shape is unsupported
 *                         (await in loop/branch, multiple awaits, try-across-await):
 *                         stays on the legacy path with a migration diagnostic.
 *
 * Usage:
 *   node scripts/async-call-census.mjs            # human-readable table
 *   node scripts/async-call-census.mjs --json     # machine-readable JSON
 *   node scripts/async-call-census.mjs --verbose  # per-file breakdown
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const CORPUS_ROOTS = [join(REPO_ROOT, "website/playground/examples")];
const TEST_GLOB_ROOT = join(REPO_ROOT, "tests");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const verbose = args.has("--verbose");

// --- corpus collection ------------------------------------------------------

/** All `.ts` (non-`.d.ts`) under a root, recursively, sorted. */
function listTsFiles(root, predicate = () => true) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) stack.push(p);
      else if (s.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts") && predicate(name)) out.push(p);
    }
  }
  return out.sort();
}

const corpus = [
  ...CORPUS_ROOTS.flatMap((r) => listTsFiles(r)),
  // tests/**/*async*.ts — the async-shaped test fixtures
  ...listTsFiles(TEST_GLOB_ROOT, (name) => /async/i.test(name)),
];

// --- AST helpers (mirror src/codegen/async-cps.ts, checker-only) ------------

function isNestedFunctionScope(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function collectAwaitPoints(node, out) {
  if (isNestedFunctionScope(node)) return;
  if (ts.isAwaitExpression(node)) out.push(node);
  ts.forEachChild(node, (c) => collectAwaitPoints(c, out));
}

function bodyHasTryAcrossAwait(body) {
  if (!body) return false;
  let found = false;
  const walk = (node, insideTry) => {
    if (found || isNestedFunctionScope(node)) return;
    if (insideTry && ts.isAwaitExpression(node)) {
      found = true;
      return;
    }
    if (ts.isTryStatement(node)) {
      walk(node.tryBlock, true);
      if (node.catchClause) walk(node.catchClause, true);
      if (node.finallyBlock) walk(node.finallyBlock, insideTry);
      return;
    }
    ts.forEachChild(node, (c) => walk(c, insideTry));
  };
  walk(body, false);
  return found;
}

/** Mirror of `awaitIsStaticallyResolved` in async-cps.ts. */
function awaitIsStaticallyResolved(operand) {
  let expr = operand;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }
  if (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
  if (ts.isPrefixUnaryExpression(expr)) return awaitIsStaticallyResolved(expr.operand);
  if (ts.isVoidExpression(expr)) return awaitIsStaticallyResolved(expr.expression);
  if (ts.isBinaryExpression(expr)) {
    return awaitIsStaticallyResolved(expr.left) && awaitIsStaticallyResolved(expr.right);
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise" &&
    expr.expression.name.text === "resolve"
  ) {
    if (expr.arguments.length === 0) return true;
    if (expr.arguments.length === 1) return awaitIsStaticallyResolved(expr.arguments[0]);
    return false;
  }
  return false;
}

/** Mirror of `splitBodyAtAwait` acceptance — single top-level await in a canonical shape. */
function statementContainsNode(stmt, node) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (n === node) {
      found = true;
      return;
    }
    if (isNestedFunctionScope(n) && n !== stmt) return;
    ts.forEachChild(n, walk);
  };
  walk(stmt);
  return found;
}

function splitAccepts(fn, awaitPoints, hasTryAcrossAwait) {
  if (awaitPoints.length !== 1) return false;
  if (hasTryAcrossAwait) return false;
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return false;
  const stmts = body.statements;
  const awaitNode = awaitPoints[0];
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (!statementContainsNode(stmt, awaitNode)) continue;
    const suffix = stmts.slice(i + 1);
    if (ts.isReturnStatement(stmt) && stmt.expression && stmt.expression === awaitNode) {
      return suffix.length === 0;
    }
    if (ts.isVariableStatement(stmt)) {
      const decls = stmt.declarationList.declarations;
      if (decls.length !== 1) return false;
      const decl = decls[0];
      return decl.initializer === awaitNode && ts.isIdentifier(decl.name);
    }
    if (ts.isExpressionStatement(stmt) && stmt.expression === awaitNode) return true;
    return false;
  }
  return false;
}

function isPromiseType(type) {
  const symbol = type.getSymbol();
  if (!symbol) return false;
  return symbol.name === "Promise" && !!(type.flags & ts.TypeFlags.Object);
}

/** Mirror of `classifyAsyncConsumer` in async-cps.ts. */
function classifyAsyncConsumer(checker, expr) {
  let sawNonPromiseCast = false;
  let parent = expr.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent))
  ) {
    if (ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent)) {
      const castType = checker.getTypeAtLocation(parent);
      if (!isPromiseType(castType)) sawNonPromiseCast = true;
    }
    parent = parent.parent;
  }
  if (parent && ts.isAwaitExpression(parent)) return "await";
  return sawNonPromiseCast ? "value" : "thenable";
}

/** Checker-only async-call detector (subset of `isAsyncCallExpression`). */
function isAsyncCall(checker, expr) {
  // Exclude Promise static methods (they already return a Promise object).
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise"
  ) {
    return false;
  }
  const sig = checker.getResolvedSignature(expr);
  if (sig) {
    const decl = sig.getDeclaration();
    if (decl && ts.isFunctionLike(decl)) {
      if (decl.asteriskToken) return false; // async generator
      const mods = ts.canHaveModifiers(decl) ? ts.getModifiers(decl) : undefined;
      if (mods && mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return true;
    }
  }
  const calleeType = checker.getTypeAtLocation(expr.expression);
  for (const callSig of calleeType.getCallSignatures()) {
    if (isPromiseType(callSig.getReturnType())) return true;
  }
  return false;
}

// --- aggregation ------------------------------------------------------------

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  strict: true,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  noEmit: true,
};

const consumers = { await: 0, value: 0, thenable: 0 };
// The migration surface: value-consumed async calls whose callee genuinely
// suspends. (We approximate "callee suspends" conservatively at the call site
// as `value` — definition-level suspension is reported separately; #1796 joins
// them via the call graph.)
const definitions = { "no-await": 0, "await-elidable": 0, "cps-able": 0, "cps-unsupported": 0 };
const perFile = [];

for (const filePath of corpus) {
  const source = readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true);
  const host = {
    getSourceFile: (name) => {
      if (name === filePath) return sf;
      if (existsSync(name)) return ts.createSourceFile(name, readFileSync(name, "utf-8"), ts.ScriptTarget.ES2022, true);
      return undefined;
    },
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => REPO_ROOT,
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (n) => existsSync(n),
    readFile: (n) => (existsSync(n) ? readFileSync(n, "utf-8") : undefined),
  };
  let checker;
  let sourceFile;
  try {
    const program = ts.createProgram([filePath], compilerOptions, host);
    checker = program.getTypeChecker();
    sourceFile = program.getSourceFile(filePath) ?? sf;
  } catch {
    continue;
  }

  const fileConsumers = { await: 0, value: 0, thenable: 0 };
  const fileDefs = { "no-await": 0, "await-elidable": 0, "cps-able": 0, "cps-unsupported": 0 };

  const visit = (node) => {
    // Async function definitions.
    if (isNestedFunctionScope(node) || ts.isFunctionDeclaration(node)) {
      const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      const isAsync = mods && mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (isAsync && !node.asteriskToken && node.body) {
        const awaitPoints = [];
        collectAwaitPoints(node.body, awaitPoints);
        let bucket;
        if (awaitPoints.length === 0) bucket = "no-await";
        else if (awaitPoints.every((a) => awaitIsStaticallyResolved(a.expression))) bucket = "await-elidable";
        else if (splitAccepts(node, awaitPoints, bodyHasTryAcrossAwait(node.body))) bucket = "cps-able";
        else bucket = "cps-unsupported";
        fileDefs[bucket]++;
      }
    }
    // Async call sites.
    if (ts.isCallExpression(node)) {
      try {
        if (isAsyncCall(checker, node)) {
          fileConsumers[classifyAsyncConsumer(checker, node)]++;
        }
      } catch {
        // type resolution glitch on a corpus file — skip this call site
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const k of Object.keys(consumers)) consumers[k] += fileConsumers[k];
  for (const k of Object.keys(definitions)) definitions[k] += fileDefs[k];
  const total =
    Object.values(fileConsumers).reduce((a, b) => a + b, 0) + Object.values(fileDefs).reduce((a, b) => a + b, 0);
  if (total > 0) perFile.push({ file: relative(REPO_ROOT, filePath), consumers: fileConsumers, definitions: fileDefs });
}

// --- report -----------------------------------------------------------------

const report = {
  generated: new Date().toISOString(),
  corpusFiles: corpus.length,
  consumers,
  definitions,
  // The set #1796 must migrate: async results consumed as a raw value.
  migrationSurface: consumers.value,
};

if (asJson) {
  process.stdout.write(JSON.stringify(verbose ? { ...report, perFile } : report, null, 2) + "\n");
} else {
  console.log("Async call-site census (#1936)");
  console.log(`  corpus files: ${corpus.length}`);
  console.log("\n  Consumers (per async call site):");
  console.log(`    await    : ${consumers.await}`);
  console.log(`    value    : ${consumers.value}   <- migration surface for #1796`);
  console.log(`    thenable : ${consumers.thenable}`);
  console.log("\n  Definitions (per async function):");
  console.log(`    no-await        : ${definitions["no-await"]}`);
  console.log(`    await-elidable  : ${definitions["await-elidable"]}`);
  console.log(`    cps-able        : ${definitions["cps-able"]}`);
  console.log(`    cps-unsupported : ${definitions["cps-unsupported"]}`);
  if (verbose) {
    console.log("\n  Per-file breakdown:");
    for (const f of perFile) {
      console.log(`    ${f.file}`);
      console.log(`      consumers   ${JSON.stringify(f.consumers)}`);
      console.log(`      definitions ${JSON.stringify(f.definitions)}`);
    }
  }
}
