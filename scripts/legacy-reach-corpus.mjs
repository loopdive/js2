// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7143 slice B0 — corpus for `scripts/measure-legacy-reach.mjs`.
 *
 * Every entry is one single-source compile: `{ id, family, fileName, source,
 * options?, bodyLine? }`. `bodyLine` (test262 only) is the last line of the
 * prepended harness; units declared at or above it belong to the harness, not
 * to the test, and are excluded from the measurement.
 *
 * Families (`CORPUS_FAMILIES`, all on by default):
 *   playground  — website/playground/examples/**.ts (the §1.3 sample)
 *   cutover     — scripts/standalone-ir-cutover-corpus.json sources (digest-checked)
 *   equivalence — source literals extracted from tests/equivalence/*.test.ts
 *   test262     — test262/test/language/** files the root tests/*.test.ts cite
 * Any other `--corpus` item is a file or directory path (`.ts`/`.js`).
 *
 * Entries are de-duplicated by (fileName, options, source); the first family
 * that yields a source owns it, so `cutover` contributes only what
 * `playground` does not already cover.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "../src/ts-api.js";

export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const CORPUS_FAMILIES = ["playground", "cutover", "equivalence", "test262"];

const rel = (path) => relative(REPO_ROOT, path).replaceAll("\\", "/");

function listSources(root) {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((d) => (d.isDirectory() ? listSources(join(root, d.name)) : [join(root, d.name)]))
    .filter((p) => /\.(ts|js)$/.test(p) && !p.endsWith(".d.ts"));
}

function fileEntry(family, path) {
  return { id: `${family}:${rel(path)}`, family, fileName: basename(path), source: readFileSync(path, "utf8") };
}

const playground = () =>
  listSources(join(REPO_ROOT, "website/playground/examples")).map((p) => fileEntry("playground", p));

async function cutover() {
  const { loadCorpusManifest } = await import("./run-standalone-ir-cutover-corpus.mjs");
  return loadCorpusManifest().sources.map((s) => fileEntry("cutover", join(REPO_ROOT, s.path)));
}

/** Callees whose first argument is a program source in the equivalence suite. */
const SOURCE_CALLEE = /^(assertEquivalent|assertStandaloneEquivalent|compile\w*|run\w*|expectSame\w*|evaluateAsJs)$/;

const literalText = (node) =>
  node && (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) ? node.text : undefined;

/**
 * Extract the program sources a vitest file hands to its compile helpers: the
 * literal first argument of a `SOURCE_CALLEE` call, or a file-unique `const`
 * initialised with a literal and passed by name. Template literals with
 * substitutions are skipped (their text is only known at run time).
 */
export function extractTestSources(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const consts = new Map();
  const calls = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      consts.set(name, consts.has(name) ? undefined : literalText(node.initializer));
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      if (ts.isIdentifier(callee) && SOURCE_CALLEE.test(callee.text)) calls.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const sources = calls.map((arg) => (ts.isIdentifier(arg) ? consts.get(arg.text) : literalText(arg)));
  return [...new Set(sources.filter((s) => s !== undefined && s.trim() !== ""))];
}

function equivalence() {
  return listSources(join(REPO_ROOT, "tests/equivalence"))
    .filter((p) => p.endsWith(".test.ts"))
    .flatMap((p) =>
      extractTestSources(p, readFileSync(p, "utf8")).map((source, i) => ({
        id: `equivalence:${rel(p)}#${i}`,
        family: "equivalence",
        fileName: "input.ts",
        source,
      })),
    );
}

const TEST262_REF = /["'`](?:test262\/test\/)?(language\/[\w./-]+\.js)["'`]/g;

async function test262() {
  const [{ assembleOriginalHarness }, { parseMeta }] = await Promise.all([
    import("../tests/test262-original-harness.ts"),
    import("../tests/test262-runner.ts"),
  ]);
  const cited = new Set();
  for (const p of listSources(join(REPO_ROOT, "tests")).filter((f) => /^tests\/[^/]+\.test\.ts$/.test(rel(f)))) {
    for (const m of readFileSync(p, "utf8").matchAll(TEST262_REF)) cited.add(m[1]);
  }
  const entries = [];
  for (const path of [...cited].sort()) {
    const abs = join(REPO_ROOT, "test262/test", path);
    if (!existsSync(abs)) continue;
    const raw = readFileSync(abs, "utf8");
    const meta = parseMeta(raw);
    if (meta.negative || meta.flags?.includes("module")) continue; // no codegen to measure / multi-module graph
    const { source, bodyLineOffset } = assembleOriginalHarness(raw, meta).primary;
    entries.push({
      id: `test262:${path}`,
      family: "test262",
      fileName: "test.js",
      source,
      options: { allowJs: true, skipSemanticDiagnostics: true },
      bodyLine: bodyLineOffset,
    });
  }
  return entries;
}

const FAMILY_LOADERS = { playground, cutover, equivalence, test262 };

/** Load the corpus for `items` (family names and/or paths), de-duplicated, in order. */
export async function loadCorpus(items = CORPUS_FAMILIES) {
  const seen = new Set();
  const entries = [];
  for (const item of items) {
    const loaded = FAMILY_LOADERS[item]
      ? await FAMILY_LOADERS[item]()
      : listSources(resolve(item)).map((p) => fileEntry("files", p));
    for (const entry of loaded) {
      const key = createHash("sha256")
        .update(`${entry.fileName}\0${JSON.stringify(entry.options ?? {})}\0${entry.source}`)
        .digest("hex");
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...entry, sha256: key });
    }
  }
  return entries;
}
