// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7487 yield tool: how many ES5 files whose first Prepared-path gap is the global `Function` would pass if every
 * all-literal `Function(...)` / `new Function(...)` site worked. A step-past bound, not the mechanism: each literal site
 * becomes a reference to a hoisted `function __dynfn_N(<params>\n) {\n<body>\n}` (shared across evaluations; strict
 * when the program is). See README.md for the exact command sequence.
 *
 *   node step-past.mjs classify <census.jsonl> <repo> <outDir>   # rows whose first gap names "Function", by site class
 *   node step-past.mjs build <outDir> <repo> <treeDir>           # rewrite the literal-only files into treeDir/test262
 *   node step-past.mjs stats <outDir>                            # pass counts per class + next gaps
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const [command, ...args] = process.argv.slice(2);
const ts = (repo) => createRequire(join(repo, "package.json"))("typescript");

function functionSites(tsApi, text) {
  const sf = tsApi.createSourceFile("t.js", text, tsApi.ScriptTarget.Latest, true, tsApi.ScriptKind.JS);
  const sites = [];
  const isFn = (e) => tsApi.isIdentifier(e) && e.text === "Function";
  const literal = (a) => tsApi.isStringLiteral(a) || tsApi.isNoSubstitutionTemplateLiteral(a);
  const compare = [tsApi.SyntaxKind.EqualsEqualsEqualsToken, tsApi.SyntaxKind.EqualsEqualsToken];
  compare.push(tsApi.SyntaxKind.ExclamationEqualsEqualsToken, tsApi.SyntaxKind.ExclamationEqualsToken);
  const visit = (n) => {
    if ((tsApi.isCallExpression(n) || tsApi.isNewExpression(n)) && isFn(n.expression)) {
      const xs = n.arguments ?? [];
      const all = xs.every(literal);
      const kind = (tsApi.isNewExpression(n) ? "new" : "call") + (all ? "-literal" : "-computed");
      sites.push({ kind, start: n.getStart(sf), end: n.end, args: all ? xs.map((a) => a.text) : null });
      xs.forEach(visit);
      return;
    }
    if (isFn(n)) {
      const p = n.parent;
      if ((tsApi.isPropertyAccessExpression(p) || tsApi.isPropertyAssignment(p)) && p.name === n) return;
      let kind = "value-other";
      if (tsApi.isPropertyAccessExpression(p) && p.expression === n) kind = "value-member";
      else if (tsApi.isBinaryExpression(p) && p.operatorToken.kind === tsApi.SyntaxKind.InstanceOfKeyword)
        kind = "value-instanceof";
      else if (tsApi.isBinaryExpression(p) && compare.includes(p.operatorToken.kind)) kind = "value-compare";
      sites.push({ kind, start: n.getStart(sf), end: n.end });
    }
    tsApi.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

const readJsonl = (path) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const readTsv = (path) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));

if (command === "classify") {
  const [census, repo, outDir] = args;
  const tsApi = ts(repo);
  mkdirSync(outDir, { recursive: true });
  const rows = readJsonl(census).filter((r) => r.status === "compile_error" && /"Function"/.test(r.detail ?? ""));
  const out = rows.map((r) => {
    const text = readFileSync(join(repo, "test262/test", r.file), "utf8");
    const kinds = [...new Set(functionSites(tsApi, text).map((s) => s.kind))].sort();
    const harness = r.origin === "harness:fnGlobalObject.js";
    const cls = harness
      ? kinds.length
        ? `fnGlobalObject+${kinds.join(",")}`
        : "fnGlobalObject-only"
      : kinds.join(",");
    return [r.file, r.origin, cls, r.detail].join("\t");
  });
  writeFileSync(join(outDir, "first-gap-function.tsv"), out.join("\n") + "\n");
  console.log(`${out.length} files whose first gap names "Function"`);
} else if (command === "build") {
  const [outDir, repo, treeDir] = args;
  const tsApi = ts(repo);
  // A fresh worktree's test262/ entries are symlinks into the shared checkout, so writing through them rewrites the
  // shared test262 (2026-11-26). Build the tree's test262/ from real copies, and refuse one that already exists.
  const root = join(treeDir, "test262");
  if (existsSync(root))
    throw new Error(`${root} exists; remove it (unlink its symlinks first: find ${root} -type l -delete)`);
  cpSync(join(repo, "test262/harness"), join(root, "harness"), { recursive: true, dereference: true });
  const rows = readTsv(join(outDir, "first-gap-function.tsv")).filter(([, , cls]) =>
    /literal|fnGlobalObject/.test(cls),
  );
  const meta = [];
  for (const [file, , cls] of rows) {
    let text = readFileSync(join(repo, "test262/test", file), "utf8");
    const sites = functionSites(tsApi, text)
      .filter((s) => s.kind.endsWith("-literal"))
      .sort((a, b) => b.start - a.start);
    const decls = sites.map((s, i) => {
      text = text.slice(0, s.start) + `__dynfn_${i}` + text.slice(s.end);
      return `function __dynfn_${i}(${s.args.slice(0, -1).join(",")}\n) {\n${s.args.at(-1) ?? ""}\n}`;
    });
    if (decls.length) text += "\n" + decls.join("\n") + "\n";
    mkdirSync(dirname(join(root, "test", file)), { recursive: true });
    writeFileSync(join(root, "test", file), text);
    const strict = /flags:\s*\[[^\]]*onlyStrict/.test(text);
    meta.push([file, cls, sites.length, strict ? "strict" : ""]);
  }
  const harnessFile = join(root, "harness/fnGlobalObject.js");
  const harness = readFileSync(harnessFile, "utf8");
  const site = 'var __globalObject = Function("return this;")();';
  if (!harness.includes(site)) throw new Error("fnGlobalObject.js no longer holds the expected site");
  writeFileSync(
    harnessFile,
    harness.replace(site, "var __globalObject = __dynfn_g();\nfunction __dynfn_g(\n) {\nreturn this;\n}"),
  );
  writeFileSync(join(outDir, "files.txt"), meta.map((m) => m[0]).join("\n") + "\n");
  writeFileSync(join(outDir, "files-meta.tsv"), meta.map((m) => m.join("\t")).join("\n") + "\n");
  console.log(`${meta.length} files rewritten into ${treeDir}/test262`);
} else if (command === "stats") {
  const [outDir] = args;
  const meta = readTsv(join(outDir, "files-meta.tsv"));
  const runs = ["base-real", "step-standin", "step-real"].map((name) => [
    name,
    new Map(readJsonl(join(outDir, `${name}.jsonl`)).map((r) => [r.file, r])),
  ]);
  const group = (cls) =>
    cls.startsWith("fnGlobalObject") ? "harness fnGlobalObject" : cls.includes("value") ? "literal + value use" : cls;
  const table = {};
  for (const [file, cls, , strict] of meta) {
    const row = (table[group(cls)] ??= { files: 0, strict: 0, ...Object.fromEntries(runs.map(([name]) => [name, 0])) });
    row.files++;
    if (strict) row.strict++;
    for (const [name, results] of runs) if (results.get(file)?.status === "pass") row[name]++;
  }
  console.table(table);
} else {
  throw new Error("usage: step-past.mjs classify|build|stats …");
}
