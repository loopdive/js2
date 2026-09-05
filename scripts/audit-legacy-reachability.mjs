#!/usr/bin/env node
// #3090 Phase 0 — legacy front-end reachability audit.
//
// Classifies every top-level function in `src/` as SURVIVOR (still reachable
// when the legacy direct AST→Wasm *body dispatch* is deleted) or LEGACY-ONLY
// (reachable exclusively through the legacy dispatch pair
// `compileStatement` / `compileExpression`), by call-graph reachability.
//
// Model (see plan/log/3090-phase0-legacy-delete-list.md for the full
// write-up and caveats):
//
//   - Nodes: top-level function declarations + top-level `const x = fn/arrow`
//     in every `src/**/*.ts` file, plus one `<module>` pseudo-node per file
//     for top-level (table/side-effect) code.
//   - Edges: identifier references inside a node's span that resolve to a
//     same-file top-level function or to an imported name (named, default,
//     namespace `ns.foo`, and `export ... from` re-exports are followed).
//     Any reference counts (call, callback, table entry) — conservative:
//     over-approximates SHARED, never LEGACY-ONLY.
//   - Survivor roots: every node in `src/` OUTSIDE `src/codegen/`
//     (ir front-end/backend, runtime, cli, linear backend, index) — an
//     over-approximation of "code that outlives the legacy front-end".
//   - Cut: the legacy body-dispatch entries (`compileStatement` in
//     codegen/statements.ts, `compileExpression` in codegen/expressions.ts)
//     are REMOVED from the graph for the survivor pass. What the survivor
//     pass cannot reach, but full reachability can, dies with the legacy
//     front-end ("legacy-only").
//
// Output: per-file and per-function attribution as JSON
// (`.tmp/legacy-reachability.json`) + a ranked markdown table on stdout.
//
// Usage: node scripts/audit-legacy-reachability.mjs [--json <path>] [--md]

import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "src");

// The legacy front-end body-dispatch pair — the cut set.
const CUT = new Set(["src/codegen/statements.ts#compileStatement", "src/codegen/expressions.ts#compileExpression"]);

// ---------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const rel = (p) => path.relative(ROOT, p);

// ---------------------------------------------------------------------------
// Parse each file: top-level callables, imports, re-exports
// ---------------------------------------------------------------------------
/** @type {Map<string, {sf: import("typescript").SourceFile, fns: Map<string,{start:number,end:number,exported:boolean}>, imports: Map<string,{file:string,name:string}>, nsImports: Map<string,string>, reexports: {from:string,names:Map<string,string>|null}[], moduleRefs: Set<string>}>} */
const fileInfo = new Map();

function resolveModule(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // external package
  let base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const cand of [base + ".ts", path.join(base, "index.ts")]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

for (const file of files) {
  const text = readFileSync(file, "utf-8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const fns = new Map();
  const imports = new Map();
  const nsImports = new Map();
  const reexports = [];

  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      fns.set(stmt.name.text, {
        start: lineOf(stmt.getStart()),
        end: lineOf(stmt.end),
        exported: !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
        node: stmt,
      });
    } else if (ts.isVariableStatement(stmt)) {
      const exported = !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          fns.set(decl.name.text, {
            start: lineOf(stmt.getStart()),
            end: lineOf(stmt.end),
            exported,
            node: stmt,
          });
        }
      }
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveModule(file, stmt.moduleSpecifier.text);
      if (!target) continue;
      const t = rel(target);
      const ic = stmt.importClause;
      if (ic.name) imports.set(ic.name.text, { file: t, name: "default" });
      if (ic.namedBindings) {
        if (ts.isNamespaceImport(ic.namedBindings)) nsImports.set(ic.namedBindings.name.text, t);
        else
          for (const el of ic.namedBindings.elements)
            imports.set(el.name.text, { file: t, name: (el.propertyName ?? el.name).text });
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveModule(file, stmt.moduleSpecifier.text);
      if (!target) continue;
      const names = stmt.exportClause && ts.isNamedExports(stmt.exportClause) ? new Map() : null;
      if (names && stmt.exportClause && ts.isNamedExports(stmt.exportClause))
        for (const el of stmt.exportClause.elements) names.set(el.name.text, (el.propertyName ?? el.name).text);
      reexports.push({ from: rel(target), names });
    }
  }

  fileInfo.set(rel(file), { sf, fns, imports, nsImports, reexports, text });
}

// ---------------------------------------------------------------------------
// Export resolution (follows re-export chains)
// ---------------------------------------------------------------------------
const exportCache = new Map();
function resolveExport(fileRel, name, seen = new Set()) {
  const key = fileRel + "#" + name;
  if (exportCache.has(key)) return exportCache.get(key);
  if (seen.has(key)) return null;
  seen.add(key);
  const info = fileInfo.get(fileRel);
  let result = null;
  if (info) {
    if (info.fns.has(name)) result = key;
    else {
      // re-exported from another module?
      for (const re of info.reexports) {
        if (re.names) {
          const orig = re.names.get(name);
          if (orig) {
            result = resolveExport(re.from, orig, seen);
            if (result) break;
          }
        } else {
          result = resolveExport(re.from, name, seen);
          if (result) break;
        }
      }
      // import-then-export (export { x } where x imported) — handled via imports
      if (!result && info.imports.has(name)) {
        const im = info.imports.get(name);
        result = resolveExport(im.file, im.name, seen);
      }
    }
  }
  exportCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Edge extraction
// ---------------------------------------------------------------------------
/** @type {Map<string, Set<string>>} */
const edges = new Map();
const addEdge = (from, to) => {
  if (!edges.has(from)) edges.set(from, new Set());
  edges.get(from).add(to);
};

for (const [fileRel, info] of fileInfo) {
  const { sf, fns, imports, nsImports } = info;

  const refsOf = (node, out) => {
    const visit = (n) => {
      if (ts.isIdentifier(n)) out.add(n.text);
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && nsImports.has(n.expression.text)) {
        const target = resolveExport(nsImports.get(n.expression.text), n.name.text);
        if (target) out.add("\0resolved:" + target);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };

  const linkRefs = (fromId, refs) => {
    for (const r of refs) {
      if (r.startsWith("\0resolved:")) {
        addEdge(fromId, r.slice("\0resolved:".length));
        continue;
      }
      if (fns.has(r)) addEdge(fromId, fileRel + "#" + r);
      if (imports.has(r)) {
        const im = imports.get(r);
        const target = resolveExport(im.file, im.name);
        if (target) addEdge(fromId, target);
        else addEdge(fromId, im.file + "#<module>"); // value/table import — keep module alive
      }
    }
  };

  // function nodes
  for (const [name, fn] of fns) {
    const refs = new Set();
    refsOf(fn.node, refs);
    refs.delete(name);
    linkRefs(fileRel + "#" + name, refs);
  }

  // module pseudo-node: top-level statements that are not function/import decls
  const modRefs = new Set();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) || ts.isImportDeclaration(stmt)) continue;
    // Export lists (`export { x }`, `export { x } from "y"`) are re-export
    // surface, not invocations — resolveExport() handles them for consumers.
    if (ts.isExportDeclaration(stmt)) continue;
    if (ts.isVariableStatement(stmt)) {
      // skip bodies already attributed to const-fn nodes
      let attributed = false;
      for (const decl of stmt.declarationList.declarations)
        if (ts.isIdentifier(decl.name) && fns.has(decl.name.text)) attributed = true;
      if (attributed) continue;
    }
    refsOf(stmt, modRefs);
  }
  linkRefs(fileRel + "#<module>", modRefs);
  // a live module implies its top-level tables can invoke what they reference,
  // and any function of the file being live implies the module executed:
  for (const name of fns.keys()) addEdge(fileRel + "#" + name, fileRel + "#<module>");
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------
function reach(roots, cut) {
  const seen = new Set();
  const stack = [...roots].filter((r) => !cut.has(r));
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of edges.get(n) ?? []) if (!cut.has(m) && !seen.has(m)) stack.push(m);
  }
  return seen;
}

const allNodes = [];
for (const [fileRel, info] of fileInfo) {
  allNodes.push(fileRel + "#<module>");
  for (const name of info.fns.keys()) allNodes.push(fileRel + "#" + name);
}

const survivorRoots = allNodes.filter((n) => !n.startsWith("src/codegen/"));
const rSurvive = reach(survivorRoots, CUT);
const rFull = reach([...survivorRoots, ...CUT], new Set());

// --why <substr>: print a shortest survivor-path to each matching node.
const whyIdx = process.argv.indexOf("--why");
if (whyIdx > -1) {
  const needle = process.argv[whyIdx + 1];
  // BFS with parents from survivor roots (cut applied)
  const parent = new Map();
  const queue = survivorRoots.filter((r) => !CUT.has(r));
  for (const r of queue) parent.set(r, null);
  while (queue.length) {
    const n = queue.shift();
    for (const m of edges.get(n) ?? []) {
      if (CUT.has(m) || parent.has(m)) continue;
      parent.set(m, n);
      queue.push(m);
    }
  }
  for (const n of allNodes) {
    if (!n.includes(needle) || !parent.has(n)) continue;
    const chain = [];
    for (let c = n; c; c = parent.get(c)) chain.push(c);
    console.log(chain.reverse().join("\n  -> "));
    console.log("");
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Bucket classification (#3090 three-way split, refined)
//   frontend — AST→Wasm dispatch/lowering the IR front-end replaces (delete
//              candidates, gated; see the Phase 0 doc)
//   deferred — lowering for kinds the IR will never adopt (eval/with/async
//              CPS) — never touch while the feature is supported
//   runtime  — stdlib *behavior* emission (incl. builtin-call dispatch) the
//              IR backend still needs — keep
//   stays    — substrate/orchestrator (module emission, type/import
//              registries, coercion, strings substrate, backend passes) — keep
// ---------------------------------------------------------------------------
const BUCKET_PREFIX = [
  ["src/codegen/context/", "stays"],
  ["src/codegen/registry/", "stays"],
  ["src/codegen/helpers/", "stays"],
  ["src/codegen/regex/", "runtime"],
  ["src/codegen/expressions/", "frontend"],
  ["src/codegen/statements/", "frontend"],
];
const BUCKET_FILE = {
  "expressions/eval-inline.ts": "deferred",
  "with-scope.ts": "deferred",
  "async-cps.ts": "deferred",
  "expressions.ts": "frontend",
  "statements.ts": "frontend",
  "binary-ops.ts": "frontend",
  "literals.ts": "frontend",
  "typeof-delete.ts": "frontend",
  "closures.ts": "frontend",
  "new-target.ts": "frontend",
  // stdlib behavior emission + builtin-call dispatch (issue puts
  // property-access here; object-ops/string-ops are the same shape)
  "array-element-typing.ts": "runtime",
  "array-holes.ts": "runtime",
  "array-methods.ts": "runtime",
  "array-object-proto.ts": "runtime",
  "array-reduce-fusion.ts": "runtime",
  "array-to-primitive.ts": "runtime",
  "async-activation.ts": "runtime",
  "async-frame.ts": "runtime",
  "async-scheduler.ts": "runtime",
  "builtin-fn-meta.ts": "runtime",
  "builtin-scaffold.ts": "runtime",
  "builtin-static-globals.ts": "runtime",
  "case-convert-native.ts": "runtime",
  "case-tables.ts": "runtime",
  "class-to-primitive.ts": "runtime",
  "custom-iterable.ts": "runtime",
  "dataview-native.ts": "runtime",
  "date-parse-native.ts": "runtime",
  "deno-api.ts": "runtime",
  "escape-native.ts": "runtime",
  "generators-native.ts": "runtime",
  "hof-native.ts": "runtime",
  "html-wrapper-native.ts": "runtime",
  "iterator-native.ts": "runtime",
  "json-codec-native.ts": "runtime",
  "json-runtime.ts": "runtime",
  "json-standalone.ts": "runtime",
  "map-runtime.ts": "runtime",
  "math-helpers.ts": "runtime",
  "native-proto-value-read.ts": "runtime",
  "native-proto.ts": "runtime",
  "native-regex.ts": "runtime",
  "node-fs-api.ts": "runtime",
  "number-format-native.ts": "runtime",
  "number-ryu.ts": "runtime",
  "object-ops.ts": "runtime",
  "object-runtime.ts": "runtime",
  "parse-number-native.ts": "runtime",
  "promise-combinators.ts": "runtime",
  "promise-executor.ts": "runtime",
  "property-access.ts": "runtime",
  "raw-wasi-api.ts": "runtime",
  "regexp-standalone.ts": "runtime",
  "set-algebra.ts": "runtime",
  "set-runtime.ts": "runtime",
  "string-ops.ts": "runtime",
  "symbol-native.ts": "runtime",
  "temporal-native.ts": "runtime",
  "timsort.ts": "runtime",
  "uri-encoding-native.ts": "runtime",
  "weak-collections-runtime.ts": "runtime",
  "wellformed-native.ts": "runtime",
};
// Buckets are ASSERTED, not measured (#5286). `bucketOf` is a lookup on the
// file path and consumes nothing from the reachability analysis above — it
// encodes R10's *intent* (`deferred` means eval / `with` / async-CPS are out of
// scope by decision, not by reachability). Returning the basis alongside the
// bucket is what lets the report say which of its numbers is an assertion and
// which is a measurement; it deliberately does NOT re-derive the bucket.
//
// basis: "named"   — a hand-typed BUCKET_FILE entry
//        "prefix"  — a BUCKET_PREFIX match (two of the six are directories, so
//                    any file added under them joins that bucket automatically)
//        "default" — no rule matched; falls through to "stays"
function bucketOf(fileRel) {
  const short = fileRel.replace("src/codegen/", "");
  if (BUCKET_FILE[short]) return [BUCKET_FILE[short], "named"];
  for (const [pre, b] of BUCKET_PREFIX) if (fileRel.startsWith(pre)) return [b, "prefix"];
  return ["stays", "default"];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const perFile = [];
for (const [fileRel, info] of fileInfo) {
  if (!fileRel.startsWith("src/codegen/") || fileRel.startsWith("src/codegen-linear/")) continue;
  let legacyLoc = 0,
    sharedLoc = 0,
    deadLoc = 0;
  const fns = [];
  for (const [name, fn] of info.fns) {
    const id = fileRel + "#" + name;
    const loc = fn.end - fn.start + 1;
    const cls = CUT.has(id) ? "dispatch" : rSurvive.has(id) ? "shared" : rFull.has(id) ? "legacy-only" : "unreferenced";
    if (cls === "legacy-only" || cls === "dispatch") legacyLoc += loc;
    else if (cls === "shared") sharedLoc += loc;
    else deadLoc += loc;
    fns.push({ name, loc, cls, exported: fn.exported, start: fn.start });
  }
  const totalLines = info.text.split("\n").length;
  const [bucket, bucketBasis] = bucketOf(fileRel);
  // The asserted bucket contradicted by the measured classes: the file is in
  // R10's deletion scope, yet most of its function lines survive the cut. This
  // does NOT re-bucket the file — it reports the disagreement (#5286).
  const bucketConflict = bucket === "frontend" && sharedLoc > legacyLoc;
  perFile.push({ file: fileRel, bucket, bucketBasis, bucketConflict, totalLines, legacyLoc, sharedLoc, deadLoc, fns });
}

perFile.sort((a, b) => b.legacyLoc - a.legacyLoc);

const jsonIdx = process.argv.indexOf("--json");
const jsonPath = jsonIdx > -1 ? process.argv[jsonIdx + 1] : path.join(ROOT, ".tmp", "legacy-reachability.json");
mkdirSync(path.dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify({ cut: [...CUT], perFile }, null, 1));

// ---------------------------------------------------------------------------
// --check / --update — dead-export ratchet (#3090 Phase 2)
//
// `--check` fails when a NEW unreferenced top-level function appears in
// `src/codegen/` vs `scripts/dead-export-baseline.json` (entries that
// disappear are fine — that's deletion progress; refresh with `--update`).
// False-positive escape hatches: a function referenced only from `tests/`
// (the graph does not include tests) or only from class-method bodies
// (not indexed) shows as unreferenced — verify with
// `grep -rn <name> tests/` and, if live, bank it via `--update` with a
// PR note.
// ---------------------------------------------------------------------------
const BASELINE_PATH = path.join(ROOT, "scripts", "dead-export-baseline.json");
const currentDead = perFile
  .flatMap((f) => f.fns.filter((fn) => fn.cls === "unreferenced").map((fn) => f.file + "#" + fn.name))
  .sort();
if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, JSON.stringify(currentDead, null, 1) + "\n");
  console.log(`dead-export baseline updated: ${currentDead.length} entries`);
  process.exit(0);
}
if (process.argv.includes("--check")) {
  let baseline;
  try {
    baseline = new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf-8")));
  } catch {
    console.error(`dead-export gate: missing/unreadable ${rel(BASELINE_PATH)} — run with --update to seed it.`);
    process.exit(1);
  }
  const added = currentDead.filter((id) => !baseline.has(id));
  const removed = [...baseline].filter((id) => !currentDead.includes(id));
  if (removed.length)
    console.log(
      `dead-export gate: ${removed.length} baseline entries gone (progress — refresh with --update when convenient).`,
    );
  if (added.length) {
    console.error(`dead-export gate: ${added.length} NEW unreferenced top-level function(s) in src/codegen/:`);
    for (const id of added) console.error(`  ${id}`);
    console.error(
      "Either delete the dead function, or — if it is referenced only from tests/ or class-method bodies (audit blind spots) — verify with grep and refresh the baseline: node scripts/audit-legacy-reachability.mjs --update",
    );
    process.exit(1);
  }
  console.log(`dead-export gate: OK (${currentDead.length} known entries, 0 new)`);
  process.exit(0);
}

const byBucket = { frontend: [], deferred: [], runtime: [], stays: [] };
for (const f of perFile) byBucket[f.bucket].push(f);

const sum = (arr, k) => arr.reduce((a, f) => a + f[k], 0);

// How a bucket's membership was decided, e.g. "100 prefix / 7 named". The
// file COUNT is an assertion (a path lookup); the fn-line columns beside it
// are measurements. Spelling out the basis is what keeps the two apart (#5286).
const basisBreakdown = (arr) =>
  ["named", "prefix", "default"]
    .map((k) => [k, arr.filter((f) => f.bucketBasis === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(" / ") || "—";

console.log(`# Legacy front-end reachability (src/codegen, ${perFile.length} files)`);
console.log(`# JSON: ${rel(jsonPath)}  (per-function detail)`);
console.log("");
console.log(
  "| Bucket | files | membership basis (asserted) | legacy-only fn-lines | shared fn-lines | unreferenced fn-lines |",
);
console.log("| --- | --: | --- | --: | --: | --: |");
for (const b of ["frontend", "deferred", "runtime", "stays"]) {
  const fs = byBucket[b];
  console.log(
    `| ${b} | ${fs.length} | ${basisBreakdown(fs)} | ${sum(fs, "legacyLoc")} | ${sum(fs, "sharedLoc")} | ${sum(fs, "deadLoc")} |`,
  );
}
console.log("");
console.log(
  "Bucket and file count are ASSERTED by `bucketOf` — a path lookup (`BUCKET_FILE` by name, `BUCKET_PREFIX` by",
);
console.log(
  "directory, else `stays`) that reads nothing from the reachability analysis. The fn-line columns are MEASURED.",
);
console.log("A file can therefore sit in a bucket its own measured classes contradict — see `## bucket conflicts`.");
console.log("");

// ---------------------------------------------------------------------------
// Bucket conflicts (#5286) — asserted `frontend` vs measured survivorship.
// Reported, never resolved: the bucket taxonomy is R10's editorial call, and a
// shared/legacy ratio cannot express intent. No bucket is changed here.
// ---------------------------------------------------------------------------
const conflicts = perFile.filter((f) => f.bucketConflict).sort((a, b) => b.sharedLoc - a.sharedLoc);
console.log("## bucket conflicts");
console.log("");
console.log(
  `${conflicts.length} file(s) asserted \`frontend\` (R10 deletion scope) whose measured shared fn-lines exceed their`,
);
console.log(
  `legacy-only fn-lines — ${sum(conflicts, "sharedLoc")} shared lines counted as deletion scope. Not re-bucketed here.`,
);
console.log("");
console.log("| File | basis | legacy-only fn-lines | shared fn-lines |");
console.log("| --- | --- | --: | --: |");
for (const f of conflicts) {
  console.log(`| ${f.file.replace("src/codegen/", "")} | ${f.bucketBasis} | ${f.legacyLoc} | ${f.sharedLoc} |`);
}
console.log("");
for (const b of ["frontend", "deferred", "runtime"]) {
  console.log(`## ${b}`);
  console.log("| File | file lines | legacy-only fn-lines | shared fn-lines | unreferenced |");
  console.log("| --- | --: | --: | --: | --: |");
  for (const f of byBucket[b]) {
    if (f.legacyLoc === 0 && f.deadLoc === 0) continue;
    console.log(
      `| ${f.file.replace("src/codegen/", "")} | ${f.totalLines} | ${f.legacyLoc} | ${f.sharedLoc} | ${f.deadLoc} |`,
    );
  }
  console.log("");
}
console.log("## unreferenced functions (knip/Phase-2 candidates, all buckets)");
console.log("| File | function | lines |");
console.log("| --- | --- | --: |");
for (const f of perFile)
  for (const fn of f.fns)
    if (fn.cls === "unreferenced")
      console.log(`| ${f.file.replace("src/codegen/", "")} | ${fn.name} (:${fn.start}) | ${fn.loc} |`);
