// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/check-func-budget.mjs — R-FUNC per-FUNCTION LOC ceiling ratchet
// (#3400, implements #3102 slice 2).
//
// WHY THIS EXISTS
// ---------------
// `check-loc-budget.mjs` (#3102/#3131) enforces a FILE-size ceiling (1,500 LOC,
// shrink-only). Nothing enforces a FUNCTION-size ceiling. The 2026-07-18 census
// (#3399 §2) found 166 top-level functions over 300 LOC, including five
// call-shape functions of 1,800–3,100 LOC that #742's split of
// `compileCallExpression` produced (a 12,210-LOC god function fractured into
// five smaller gods, each an order of magnitude over the "no function > 300 LOC"
// elegance criterion). Every decomposition PR (#3108, #3111) shrinks functions,
// but without a ratchet the shrinkage is not banked and the next feature PR
// regrows them — the exact dynamic #3102 documents for files. R-FUNC is the
// function-granularity twin that banks that work permanently.
//
// This is a STRUCTURAL COPY of check-loc-budget.mjs; the ONLY new piece is the
// measurement (functions instead of files, via the TypeScript AST). The
// change-scoping, grandfathering, banking, and allow-key logic transfer 1:1
// (both reuse scripts/lib/change-scope.mjs).
//
// CHANGE-SCOPED AND SELF-CONTAINED (merge-queue AND merge-conflict safe):
//   - FAILS when the change-set grows a function that was already over 300 at
//     its base (regrowth), newly pushes a function over 300, or adds a
//     brand-new function over 300.
//   - GRANDFATHERS every function at its base size — blocks *growth of what you
//     touch*, never demands shrinkage; a decomposition PR that only shrinks
//     passes with zero ceremony.
//   - BANKS shrinkage automatically: once a shrink merges, every later
//     change-set's base already contains the smaller function.
//   - INTENTIONAL over-limit is granted per change-set via a `func-budget-allow:`
//     frontmatter key in the change-set's own plan/issues/*.md file (visible in
//     the diff; no shared-file conflict). Value = list of `"<relpath>::<name>"`
//     function keys.
//   - `--all` ignores change-scoping and audits the whole tree against the
//     committed baseline (local use).
//   - `--update` reseeds the committed baseline from current sizes — POST-MERGE/
//     main use only; skips the write when only the `generated` date would change.
//   - `--update-on-decrease` banks shrinkage into the committed baseline
//     (lowers, never raises) — the post-merge writer + local use.
//
// The committed baseline scripts/func-budget-baseline.json is the whole-tree
// snapshot for the `--all` audit + the no-git fallback ONLY; PRs must NOT commit
// changes to it (post-merge promote-baseline reseeds it, same as loc-budget).
//
// MEASUREMENT (the one new piece): a "function unit" is any TS AST node with a
// body — FunctionDeclaration, FunctionExpression, ArrowFunction (block body
// only), MethodDeclaration, GetAccessor, SetAccessor, Constructor. Size = the
// 1-based inclusive line span (endLine - startLine + 1), matching how a human
// reads "how long is this function". Nested functions are measured
// INDEPENDENTLY and a parent's span is NOT reduced by its children's (an outer
// 800-LOC function with a 400-LOC inner arrow is TWO entries). The TS compiler
// API is used (not a regex) so data-literal blocks are never mislabelled. The
// key `"<relpath>::<qualifiedName>"` is stable across edits above the function
// (no line number in the key); same-name collisions within a file get an
// ordinal suffix (`#2`, `#3`) in source order.
//
// USAGE
//   pnpm run check:func-budget                           # gate the change-set
//   pnpm run check:func-budget -- --all                  # audit the whole tree
//   pnpm run check:func-budget -- --update               # reseed (post-merge/main only)
//   pnpm run check:func-budget -- --update-on-decrease   # gate, bank decreases
//   pnpm run check:func-budget -- --json                 # machine-readable snapshot

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { resolveChangeBase, changedPaths, baseBlob, changeSetAllowances } from "./lib/change-scope.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/func-budget-baseline.json");
const SRC_ROOT = join(REPO_ROOT, "src");

// A function crossing this many lines becomes a tracked over-budget unit. 300
// LOC is the #3399 elegance criterion — the point past which a single function
// stops being readable in one sitting. Like loc-budget's 1,500, this is a
// ratchet floor ("shrink-only, no new over-limit function"), not a claim that
// 300 is magic.
const THRESHOLD = 300;

/** Recursively list `.ts` files under `src` (excluding `.d.ts`), sorted. */
function listSrcFiles() {
  const out = [];
  const stack = [SRC_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) stack.push(p);
      else if (s.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
    }
  }
  return out.sort();
}

/** Repo-relative path with forward slashes, so the baseline is OS-independent. */
function relPath(filePath) {
  return relative(REPO_ROOT, filePath).split(sep).join("/");
}

const isSrcTs = (p) => p.startsWith("src/") && p.endsWith(".ts") && !p.endsWith(".d.ts");

// ── Measurement (the one new piece vs check-loc-budget.mjs) ─────────────────

function propName(name) {
  if (!name) return "<anon>";
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return "[computed]";
  return "<anon>";
}

/** Best-effort name for an anonymous function/arrow from its binding site. */
function contextualName(node) {
  const p = node.parent;
  if (!p) return "<anonymous>";
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && p.name) return propName(p.name);
  if (ts.isPropertyDeclaration(p) && p.name) return propName(p.name);
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (ts.isIdentifier(p.left)) return p.left.text;
    if (ts.isPropertyAccessExpression(p.left)) return p.left.name.text;
  }
  return "<anonymous>";
}

/** The human-readable (unqualified-by-ordinal) name of a function unit. */
function functionName(node, className) {
  if (ts.isConstructorDeclaration(node)) return `${className ?? "<class>"}.constructor`;
  if (ts.isMethodDeclaration(node)) return className ? `${className}.${propName(node.name)}` : propName(node.name);
  if (ts.isGetAccessorDeclaration(node)) {
    const n = `get ${propName(node.name)}`;
    return className ? `${className}.${n}` : n;
  }
  if (ts.isSetAccessorDeclaration(node)) {
    const n = `set ${propName(node.name)}`;
    return className ? `${className}.${n}` : n;
  }
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "<default export>";
  if (ts.isFunctionExpression(node)) return node.name?.text ?? contextualName(node);
  if (ts.isArrowFunction(node)) return contextualName(node);
  return "<anonymous>";
}

/** True for a function-like node that carries a body (an ArrowFunction only if block-bodied). */
function isFunctionUnit(node) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body !== undefined;
  }
  if (ts.isArrowFunction(node)) return node.body !== undefined && ts.isBlock(node.body);
  return false;
}

/**
 * Parse `text` as `relPath` and return Map<functionKey, lineSpan> for every
 * function unit (nested included, each measured independently). The key is
 * `"<relPath>::<name>"`, with a `#N` ordinal for same-name collisions in
 * source order. Exported for unit testing.
 */
export function collectFunctionSizes(text, relPathStr) {
  const sf = ts.createSourceFile(relPathStr, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const sizes = new Map();
  const ordinals = new Map();

  const keyFor = (name) => {
    const base = `${relPathStr}::${name}`;
    const n = (ordinals.get(base) ?? 0) + 1;
    ordinals.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };

  const span = (node) => {
    const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    return endLine - startLine + 1;
  };

  const walk = (node, className) => {
    let cn = className;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      cn = node.name?.text ?? "<anonymous class>";
    }
    if (isFunctionUnit(node)) {
      sizes.set(keyFor(functionName(node, className)), span(node));
    }
    ts.forEachChild(node, (child) => walk(child, cn));
  };
  walk(sf, undefined);
  return sizes;
}

/** Whole-tree measurement: Map<functionKey, size> across every src .ts file. */
function measure() {
  const functions = {};
  for (const p of listSrcFiles()) {
    const rel = relPath(p);
    const text = readFileSync(p, "utf-8");
    for (const [key, size] of collectFunctionSizes(text, rel)) functions[key] = size;
  }
  return { functions };
}

/** Build a fresh baseline: only functions over THRESHOLD (the grandfathered set). */
function seedBaseline(measured) {
  const functions = {};
  for (const [key, size] of Object.entries(measured.functions).sort()) {
    if (size > THRESHOLD) functions[key] = size;
  }
  return {
    generated: new Date().toISOString().slice(0, 10),
    threshold: THRESHOLD,
    functions,
  };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeBaseline(baseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}

function failWith({ regrown, newGiants }) {
  process.stderr.write("\nFunction budget gate FAILED (#3400 / R-FUNC):\n");
  if (regrown.length > 0) {
    process.stderr.write(`\n  Functions grown past their allowed size:\n`);
    for (const r of regrown.sort((a, b) => b.delta - a.delta)) {
      process.stderr.write(`    ${r.key}: ${r.size} > ${r.ceiling} (+${r.delta})\n`);
    }
  }
  if (newGiants.length > 0) {
    process.stderr.write(`\n  New over-budget functions (crossed the ${THRESHOLD}-LOC threshold):\n`);
    for (const g of newGiants.sort((a, b) => b.size - a.size)) {
      process.stderr.write(`    ${g.key}: ${g.size} (> ${THRESHOLD}, +${g.delta})\n`);
    }
  }
  process.stderr.write(
    `\nSplit the function into smaller units — see plan/log/compiler-consolidation-plan.md\n` +
      `and #3399. If the growth is genuinely intended, grant THIS change-set an\n` +
      `allowance: list the function key(s) under a \`func-budget-allow:\` key in the\n` +
      `YAML frontmatter of this PR's own issue file (any plan/issues/*.md the PR adds\n` +
      `or modifies), e.g.\n\n` +
      `  func-budget-allow:\n` +
      `    - src/codegen/expressions/calls.ts::compileReceiverMethodCall\n\n` +
      `Do NOT commit changes to scripts/func-budget-baseline.json in a PR — the\n` +
      `baseline is refreshed post-merge on main only (#3131/#3400).\n`,
  );
  process.exit(1);
}

/**
 * Pure per-file verdict — the heart of the change-scoped gate, exported for
 * unit testing. Given the current and base function-size maps for ONE file plus
 * the change-set's allow set, classify each current function:
 *   - regrown   : was already over `threshold` at base AND grew (unallowed)
 *   - newGiants : newly crossed `threshold` (prior <= threshold) or brand-new
 *                 over it (unallowed)
 *   - granted   : would fault but is listed in `allow`
 *   - shrunk    : dropped below its base size (banking candidate)
 * A shrunk-or-unchanged function never faults; a still-over-limit function that
 * shrank is grandfathered (only growth is blocked).
 *
 * @param {Map<string,number>} curFns
 * @param {Map<string,number>} baseFns
 * @param {Map<string,unknown>|Set<string>|null} allow
 * @param {number} threshold
 */
export function classifyFunctionChanges(curFns, baseFns, allow, threshold = THRESHOLD) {
  const regrown = [];
  const newGiants = [];
  const granted = [];
  const shrunk = [];
  const allowed = (key) => Boolean(allow && typeof allow.has === "function" && allow.has(key));
  for (const [key, size] of curFns) {
    const prior = baseFns.get(key); // undefined ⇒ new function
    if (prior !== undefined && size < prior) shrunk.push([key, size]);
    if (prior !== undefined && size <= prior) continue; // shrink/unchanged never faults
    if (allowed(key)) {
      granted.push({ key, prior: prior ?? 0, size });
      continue;
    }
    if (prior !== undefined && prior > threshold) {
      regrown.push({ key, ceiling: prior, size, delta: size - prior });
    } else if (size > threshold) {
      // Newly crossed the threshold (prior <= threshold) or brand-new over it.
      newGiants.push({ key, size, delta: size - threshold });
    }
  }
  return { regrown, newGiants, granted, shrunk };
}

/**
 * Change-scoped gate (#3131): judge ONLY this change-set, against its own base
 * tree — no committed baseline involved. Returns false when the diff against
 * `base` cannot be computed (caller falls back to legacy mode).
 */
function gateScoped(base, how, mode) {
  const changedAll = changedPaths(REPO_ROOT, base, "src");
  if (changedAll === undefined) return false;
  const changed = [...changedAll].filter(isSrcTs).sort();
  const allow = changeSetAllowances(REPO_ROOT, base, "func-budget-allow");

  const regrown = [];
  const newGiants = [];
  const granted = [];
  const shrunk = []; // for --update-on-decrease banking

  for (const path of changed) {
    const abs = join(REPO_ROOT, path);
    const curText = existsSync(abs) ? readFileSync(abs, "utf-8") : undefined; // deleted by this change-set
    const curFns = curText === undefined ? new Map() : collectFunctionSizes(curText, path);
    const baseText = baseBlob(REPO_ROOT, base, path);
    const baseFns = baseText === undefined ? new Map() : collectFunctionSizes(baseText, path);

    const v = classifyFunctionChanges(curFns, baseFns, allow, THRESHOLD);
    regrown.push(...v.regrown);
    newGiants.push(...v.newGiants);
    shrunk.push(...v.shrunk);
    for (const g of v.granted) {
      granted.push(
        `    ${g.key}: ${g.prior} → ${g.size} (+${g.size - g.prior}) granted by ${allow.get(g.key).join(", ")}`,
      );
    }
  }

  if (granted.length > 0) {
    process.stdout.write(
      `\nFunction budget gate: intentional growth allowed by this change-set's issue file:\n${granted.join("\n")}\n`,
    );
  }

  if (regrown.length > 0 || newGiants.length > 0) {
    failWith({ regrown, newGiants });
  }

  if (mode === "update-on-decrease" && shrunk.length > 0) bankDecreases(new Map(shrunk));

  process.stdout.write(
    `\nFunction budget gate: OK — no unallowed growth in ${changed.length} changed src file(s) (base: ${how}).\n`,
  );
  return true;
}

/**
 * Legacy whole-tree gate against the committed baseline — used by `--all` and
 * when no git base is resolvable. The baseline is kept fresh by the post-merge
 * writers (promote-baseline / baseline-summary-sync).
 */
function gateLegacy(measured, mode, auditAll) {
  const baseline = loadBaseline();
  if (!baseline) {
    process.stderr.write(`No baseline at ${relPath(BASELINE_PATH)}. Run with --update to create it.\n`);
    process.exit(1);
  }
  const threshold = baseline.threshold ?? THRESHOLD;
  const baseFns = baseline.functions ?? {};

  const regrown = [];
  const newGiants = [];

  for (const [key, size] of Object.entries(measured.functions)) {
    if (key in baseFns) {
      if (size > baseFns[key]) regrown.push({ key, ceiling: baseFns[key], size, delta: size - baseFns[key] });
    } else if (size > threshold) {
      newGiants.push({ key, size, delta: size - threshold });
    }
  }

  if (regrown.length > 0 || newGiants.length > 0) failWith({ regrown, newGiants });

  if (mode === "update-on-decrease") bankDecreases(new Map(Object.entries(measured.functions)));

  process.stdout.write(
    `\nFunction budget gate: OK — no regrowth in whole tree${auditAll ? " (--all)" : " (no git base — committed-baseline mode)"}. ` +
      `${Object.keys(baseFns).length} functions tracked (> ${threshold} LOC).\n`,
  );
}

/**
 * Bank shrinkage into the committed baseline: LOWER the ceilings of shrunk
 * functions (never raise, so unrelated drift is not silently banked). A
 * function that dropped to/below THRESHOLD is removed from the baseline
 * entirely (it is no longer tracked). Post-merge writer / local use only — PRs
 * must not commit the result (#3131).
 */
function bankDecreases(currentSizes) {
  const baseline = loadBaseline();
  if (!baseline) return;
  const baseFns = baseline.functions ?? {};
  const threshold = baseline.threshold ?? THRESHOLD;
  const nextFns = { ...baseFns };
  let any = false;
  for (const [key, size] of currentSizes) {
    if (key in nextFns && size < nextFns[key]) {
      if (size > threshold) nextFns[key] = size;
      else delete nextFns[key]; // shrank under the threshold → stop tracking
      any = true;
    }
  }
  if (!any) return;
  writeBaseline({ generated: new Date().toISOString().slice(0, 10), threshold, functions: nextFns });
  process.stdout.write(
    `\nFunction budget gate: ratcheted baseline (banked function shrink). ` +
      `Updated ${relPath(BASELINE_PATH)} — post-merge/main writer only, do NOT commit this from a PR (#3131/#3400).\n`,
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  const mode = args.has("--update")
    ? "update"
    : args.has("--update-on-decrease")
      ? "update-on-decrease"
      : args.has("--json")
        ? "json"
        : "gate";
  const auditAll = args.has("--all");

  if (mode === "json") {
    process.stdout.write(JSON.stringify(measure(), null, 2) + "\n");
    return;
  }

  if (mode === "update") {
    const prev = loadBaseline();
    const next = seedBaseline(measure());
    if (
      prev &&
      prev.threshold === next.threshold &&
      JSON.stringify(prev.functions) === JSON.stringify(next.functions)
    ) {
      process.stdout.write(
        `Baseline ${relPath(BASELINE_PATH)} already current (only the date would change) — not rewritten.\n`,
      );
      return;
    }
    writeBaseline(next);
    process.stdout.write(
      `Reseeded ${relPath(BASELINE_PATH)}: ${Object.keys(next.functions).length} functions > ${THRESHOLD} LOC.\n`,
    );
    return;
  }

  // Change-scoped path only reads changed files; the whole-tree measure is only
  // needed for --all / legacy fallback.
  if (!auditAll) {
    const { base, how } = resolveChangeBase(REPO_ROOT);
    if (base && gateScoped(base, how, mode)) return;
  }
  gateLegacy(measure(), mode, auditAll);
}

// Run only as a CLI; the pure measurement + classifier are imported by the unit
// test (which must not trigger a gate run on import).
const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) main();
