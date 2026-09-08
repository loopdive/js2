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
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { createHash } from "node:crypto";

let movedReferenceContract = "strict";
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (["--root", "--json", "--why"].includes(arg)) {
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
    i++;
  } else if (arg.startsWith("--moved-reference-contract=")) {
    if (movedReferenceContract !== "strict" || arg !== "--moved-reference-contract=preservation-v1") {
      throw new Error(`unsupported/duplicate moved-reference contract: ${arg}`);
    }
    movedReferenceContract = "preservation-v1";
  } else if (!["--check", "--update", "--md"].includes(arg)) throw new Error(`unknown argument: ${arg}`);
}
if (movedReferenceContract !== "strict" && !process.argv.includes("--check")) {
  throw new Error("the preservation contract requires --check");
}

const rootIdx = process.argv.indexOf("--root");
if (rootIdx >= 0 && (!process.argv[rootIdx + 1] || process.argv[rootIdx + 1].startsWith("--"))) {
  throw new Error("--root requires a source tree path");
}
const ROOT =
  rootIdx >= 0
    ? path.resolve(process.argv[rootIdx + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
if (process.argv.includes("--check") && process.argv.includes("--update")) {
  throw new Error("--check and --update are mutually exclusive");
}

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
  const bytes = readFileSync(file);
  const text = bytes.toString("utf-8");
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

  fileInfo.set(rel(file), { sf, fns, imports, nsImports, reexports, text, bytes });
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

// #3518: this contract is independent of the historical broad-root ratchet.
// A move out of codegen must not turn a declaration into its own root.
// These are static reference paths, not execution or IR-only backend proof.
const PRODUCTION_ROOTS = ["src/index.ts#compile"];
const MOVED_FUNCTIONS = [
  ...["buildGrowLocals", "buildGrowBody", "buildEnqueueBody", "buildDrainLocals", "buildDrainBody"].map((name) => ({
    original: `src/codegen/prepared-native-async-runtime.ts#${name}`,
    canonical: `src/runtime/wasmgc/async/microtask-queue-bodies.ts#${name}`,
  })),
  {
    original: "src/emit/resolve-layout.ts#inLiveShiftRange",
    canonical: "src/wasm/physical/function-handles.ts#inLiveShiftRange",
  },
];

// These two AST contracts identify reviewed OPEN sites. They never contribute
// targets, graph edges or roots, and never exempt a strict failure.
const BOUNDARY_SHAPES = [
  {
    id: "optional-binaryen-provider-v1",
    source: "src/optimize.ts",
    owner: "getBinaryenModule",
    anchor: "globalThis-alias-nullish-binaryen-specifier-v1",
    loadPolicy: "runtime-configurable",
    defaultSpecifier: "binaryen",
  },
  {
    id: "platform-dynamic-import-v1",
    source: "src/runtime/platform-capability-adapter.ts",
    owner: "resolvePlatformCapabilityImport",
    anchor: "intent-dynamic_import-returned-specifier-arrow-v1",
    loadPolicy: "runtime-callback-argument",
    defaultSpecifier: null,
  },
];

function extensionReceipts({ checker, sourceFiles, moduleLoads, diagnostics, full, cut }) {
  const failures = [];
  const receipts = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(ROOT, "scripts/compiler-extension-boundaries.json"), "utf8"));
  } catch {
    return { receipts, failures: ["missing/malformed compiler-extension-boundaries.json"] };
  }
  if (
    !manifest ||
    Object.keys(manifest).sort().join(",") !== "records,schema" ||
    manifest.schema !== "compiler-extension-boundaries-v1" ||
    !Array.isArray(manifest.records) ||
    manifest.records.length !== 2
  ) {
    return { receipts, failures: ["extension manifest requires exactly two versioned records"] };
  }
  const unwrap = (node) => {
    while (
      node &&
      (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
    )
      node = node.expression;
    return node;
  };
  const declaration = (node, predicate) => checker.getSymbolAtLocation(node)?.declarations?.find(predicate);
  const inside = (node, ancestor) => {
    for (let current = node; current; current = current.parent) if (current === ancestor) return true;
    return false;
  };
  const matchAnchor = (load, owner, shape) => {
    if (
      !ts.isCallExpression(load) ||
      load.expression.kind !== ts.SyntaxKind.ImportKeyword ||
      load.arguments.length !== 1
    )
      return false;
    const argument = unwrap(load.arguments[0]);
    if (!argument || !ts.isIdentifier(argument) || argument.text !== "specifier") return false;
    if (shape.id === "optional-binaryen-provider-v1") {
      const binding = declaration(argument, ts.isVariableDeclaration);
      if (!binding || !inside(binding, owner)) return false;
      const initializer = unwrap(binding.initializer);
      if (
        !initializer ||
        !ts.isBinaryExpression(initializer) ||
        initializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
        !ts.isStringLiteral(initializer.right) ||
        initializer.right.text !== "binaryen"
      )
        return false;
      const override = unwrap(initializer.left);
      if (
        !override ||
        !ts.isPropertyAccessExpression(override) ||
        override.name.text !== "__js2wasmBinaryenModuleSpecifier" ||
        !ts.isIdentifier(override.expression) ||
        override.expression.text !== "globalObject"
      )
        return false;
      const globalBinding = declaration(override.expression, ts.isVariableDeclaration);
      const value = globalBinding && unwrap(globalBinding.initializer);
      return !!(
        globalBinding &&
        inside(globalBinding, owner) &&
        value &&
        ts.isIdentifier(value) &&
        value.text === "globalThis" &&
        checker.getSymbolAtLocation(value) === checker.resolveName("globalThis", undefined, ts.SymbolFlags.Value, false)
      );
    }
    const parameter = declaration(argument, ts.isParameter);
    const arrow = parameter?.parent;
    if (!arrow || !ts.isArrowFunction(arrow) || arrow.parameters.length !== 1 || unwrap(arrow.body) !== load)
      return false;
    const returned = arrow.parent;
    if (!ts.isReturnStatement(returned) || returned.expression !== arrow) return false;
    const arm = returned.parent;
    if (!ts.isCaseClause(arm) || !ts.isStringLiteral(arm.expression) || arm.expression.text !== "dynamic_import")
      return false;
    const selection = arm.parent.parent;
    if (
      !ts.isSwitchStatement(selection) ||
      !ts.isPropertyAccessExpression(selection.expression) ||
      selection.expression.name.text !== "type" ||
      !ts.isIdentifier(selection.expression.expression) ||
      selection.expression.expression.text !== "intent"
    )
      return false;
    const intent = declaration(selection.expression.expression, ts.isParameter);
    return !!intent && intent.parent === owner;
  };
  for (const shape of BOUNDARY_SHAPES) {
    const matching = manifest.records.filter((record) => record?.id === shape.id);
    if (matching.length !== 1) {
      failures.push(`${shape.id}: missing/duplicate receipt`);
      continue;
    }
    const record = matching[0];
    const expected = {
      ...shape,
      reviewedSourceRevision: record.reviewedSourceRevision,
      contentHash: record.contentHash,
      digestAlgorithm: "git-blob-sha1",
      importer: shape.source,
      resolutionBase: "original-importer",
      targetClass: "unconstrained",
      mayEnterRepository: true,
      runtimeImplementationInspected: false,
      sideEffects: "unbounded",
      strictFailureExemption: false,
      permittedEvidenceUse: "source-reference-preservation-only",
    };
    if (
      Object.keys(record).sort().join(",") !== Object.keys(expected).sort().join(",") ||
      Object.entries(expected).some(([key, value]) => record[key] !== value) ||
      !/^[a-f0-9]{40}$/.test(record.reviewedSourceRevision ?? "") ||
      !/^[a-f0-9]{40}$/.test(record.contentHash ?? "")
    ) {
      failures.push(`${shape.id}: invalid/unsupported provenance fields`);
      continue;
    }
    const sf = sourceFiles.find((file) => file && rel(file.fileName) === shape.source);
    const scanned = fileInfo.get(shape.source);
    if (!sf || !scanned || sf.text !== scanned.text) {
      failures.push(`${shape.id}: missing/inconsistent scanned source ${shape.source}`);
      continue;
    }
    const hash = createHash("sha1").update(`blob ${scanned.bytes.length}\0`).update(scanned.bytes).digest("hex");
    if (hash !== record.contentHash) {
      failures.push(`${shape.id}: stale source digest (actual ${hash})`);
      continue;
    }
    const owner = sf.statements.filter(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === shape.owner && node.body,
    );
    const candidates = [];
    if (owner.length === 1) {
      const visit = (node) => {
        if (matchAnchor(node, owner[0], shape)) candidates.push(node);
        ts.forEachChild(node, visit);
      };
      visit(owner[0]);
    }
    if (candidates.length !== 1) {
      failures.push(`${shape.id}: expected one bound AST site, found ${candidates.length}`);
      continue;
    }
    const siteId = `${shape.source}@${candidates[0].getStart()}`;
    const loads = moduleLoads.filter((load) => load.siteId === siteId);
    const issues = diagnostics.filter((diagnostic) => diagnostic.siteId === siteId);
    if (
      loads.length !== 1 ||
      loads[0].from !== `${shape.source}#${shape.owner}` ||
      loads[0].kind !== "dynamic import" ||
      loads[0].status !== "unknown" ||
      loads[0].specifier !== null ||
      loads[0].target !== null ||
      issues.length !== 1 ||
      issues[0].owner !== loads[0].from ||
      issues[0].code !== "nonliteral-module-target" ||
      issues[0].kind !== "dynamic import"
    ) {
      failures.push(`${shape.id}: missing/ambiguous unknown-site diagnostic`);
      continue;
    }
    receipts.push({
      ...record,
      siteId,
      diagnosticId: issues[0].id,
      fullReachable: full.has(loads[0].from),
      cutReachable: cut.has(loads[0].from),
    });
  }
  if (new Set(receipts.map((receipt) => receipt.siteId)).size !== receipts.length)
    failures.push("receipts must bind distinct sites");
  return { receipts, failures };
}

function movedRuntimeReport() {
  // Bind identifiers to declarations: spelling alone cannot distinguish a
  // renamed/shadowed local from a production reference. No diagnostics-based
  // forgiveness, test roots, or compatibility-export roots are admitted.
  const productionFiles = files.filter((file) => !/(?:^|\/)(?:tests|__tests__)\/|\.(?:test|spec)\.ts$/.test(rel(file)));
  const program = ts.createProgram(productionFiles, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noLib: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const graph = new Map();
  const owners = new Map();
  const callables = new Set();
  const diagnostics = [];
  const diagnosticIds = new Set();
  const externalReferences = new Map();
  const moduleLoads = [];
  const sourceFiles = productionFiles.map((file) => program.getSourceFile(file));
  const error = (id, code, message, { siteId = null, kind = null, subject = null } = {}) => {
    const diagnosticId = `${id}:${code}:${siteId ?? subject ?? ""}`;
    if (!diagnosticIds.has(diagnosticId)) {
      diagnostics.push({ id: diagnosticId, owner: id, code, kind, message, siteId });
      diagnosticIds.add(diagnosticId);
    }
  };
  const edge = (from, to) => graph.get(from).add(to);
  const register = (id, node, callable = false) => {
    if (graph.has(id)) {
      // Overload signatures have no body; the implementation owns the node.
      if (!node.body) return;
    } else graph.set(id, new Set());
    owners.set(node, id);
    if (callable) callables.add(id);
  };
  for (const sf of sourceFiles) {
    if (!sf) throw new Error("moved-runtime gate: unresolved production source file");
    const file = rel(sf.fileName);
    const moduleId = `${file}#<module>`;
    register(moduleId, sf);
    for (const diagnostic of sf.parseDiagnostics) {
      error(moduleId, "source-parse-failure", ts.flattenDiagnosticMessageText(diagnostic.messageText, " "), {
        subject: `${diagnostic.code}@${diagnostic.start}`,
      });
    }
    for (const stmt of sf.statements) {
      if (
        ts.isImportDeclaration(stmt) &&
        !stmt.importClause?.isTypeOnly &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.moduleSpecifier.text.startsWith(".")
      ) {
        const target = resolveModule(sf.fileName, stmt.moduleSpecifier.text);
        if (!target || !productionFiles.includes(target))
          error(moduleId, "unresolved-production-module", `unresolved production module ${stmt.moduleSpecifier.text}`, {
            subject: stmt.moduleSpecifier.text,
          });
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) register(`${file}#${stmt.name.text}`, stmt, true);
      else if ((ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name)
        register(`${file}#${stmt.name.text}`, stmt);
      else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          register(
            `${file}#${decl.name.text}`,
            decl,
            !!decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)),
          );
        }
      }
    }
  }
  const ownerOf = (node) => {
    // Source files are initialization owners, not catch-all resolution for
    // missing functions, type declarations, or unsupported import aliases.
    for (let n = node; n && !ts.isSourceFile(n); n = n.parent) {
      if (owners.has(n)) return owners.get(n);
    }
    return null;
  };
  const declarationTarget = (node) =>
    ownerOf(node) ??
    (ts.isSourceFile(node) && graph.has(`${rel(node.fileName)}#<module>`) ? `${rel(node.fileName)}#<module>` : null);
  const resolvedAlias = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  };
  const hasKnownDeclaration = (symbol) =>
    symbol?.declarations?.some(
      (decl) => declarationTarget(decl) || program.isSourceFileFromExternalLibrary(decl.getSourceFile()),
    );
  const moduleLoad = (id, node, argument, kind) => {
    const location = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    const siteId = `${rel(node.getSourceFile().fileName)}@${node.getStart()}`;
    const record = {
      siteId,
      from: id,
      kind,
      line: location.line + 1,
      specifier: null,
      status: "unknown",
      target: null,
    };
    moduleLoads.push(record);
    if (!argument || !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      error(id, "nonliteral-module-target", `unknown nonliteral ${kind} module target at line ${record.line}`, {
        siteId,
        kind,
      });
      return;
    }
    record.specifier = argument.text;
    if (isBuiltin(argument.text)) {
      record.status = "resolved-external";
      record.target = argument.text;
      return;
    }
    const resolved = ts.resolveModuleName(
      argument.text,
      node.getSourceFile().fileName,
      program.getCompilerOptions(),
      ts.sys,
      undefined,
      undefined,
      kind === "dynamic import" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
    ).resolvedModule;
    if (!resolved) {
      error(id, "unresolved-module-target", `unresolved ${kind} module ${argument.text} at line ${record.line}`, {
        siteId,
        kind,
      });
      return;
    }
    const target = `${rel(resolved.resolvedFileName)}#<module>`;
    record.target = target;
    if (graph.has(target)) {
      record.status = "resolved-production";
      edge(id, target);
    } else if (resolved.isExternalLibraryImport) {
      record.status = "resolved-external";
    } else {
      error(
        id,
        "module-outside-production-graph",
        `unknown ${kind} module outside production graph ${argument.text} (${target}) at line ${record.line}`,
        { siteId, kind },
      );
    }
  };
  const relativeImport = (symbol) => {
    for (const decl of symbol?.declarations ?? []) {
      for (let n = decl; n && !ts.isSourceFile(n); n = n.parent) {
        if (
          ts.isImportEqualsDeclaration(n) &&
          ts.isExternalModuleReference(n.moduleReference) &&
          n.moduleReference.expression &&
          ts.isStringLiteral(n.moduleReference.expression) &&
          n.moduleReference.expression.text.startsWith(".")
        )
          return n.moduleReference.expression.text;
        if (
          (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
          n.moduleSpecifier &&
          ts.isStringLiteral(n.moduleSpecifier) &&
          n.moduleSpecifier.text.startsWith(".")
        )
          return n.moduleSpecifier.text;
      }
    }
    return null;
  };
  const reference = (id, node) => {
    let symbol =
      ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    const imported = relativeImport(symbol);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol?.declarations ?? [];
    let resolved = false;
    for (const decl of declarations) {
      const target = declarationTarget(decl);
      if (target) {
        resolved = true;
        if (target !== id) edge(id, target);
      } else if (program.isSourceFileFromExternalLibrary(decl.getSourceFile())) {
        // A resolved external declaration (e.g. ts-api's TypeScript export)
        // is a package boundary, never a source-function root or a fallback
        // for a missing local export. Keep explicit provenance in the report.
        resolved = true;
        if (!externalReferences.has(id)) externalReferences.set(id, new Set());
        externalReferences.get(id).add(`${rel(decl.getSourceFile().fileName)}#${node.text}`);
      }
    }
    if (imported && !resolved)
      error(id, "unresolved-relative-reference", `unresolved relative reference ${node.text} from ${imported}`, {
        subject: `${imported}#${node.text}`,
      });
    if (imported && resolved) {
      const module = resolveModule(node.getSourceFile().fileName, imported);
      if (module && graph.has(`${rel(module)}#<module>`)) edge(id, `${rel(module)}#<module>`);
    }
  };
  const visit = (id, node) => {
    if (ts.isImportEqualsDeclaration(node)) {
      if (node.isTypeOnly) return;
      if (ts.isExternalModuleReference(node.moduleReference)) {
        moduleLoad(id, node, node.moduleReference.expression, "import-equals");
        if (!hasKnownDeclaration(resolvedAlias(node.name)))
          error(id, "unresolved-import-equals-alias", `unresolved import-equals alias ${node.name.text}`, {
            subject: node.name.text,
          });
      } else {
        error(
          id,
          "unsupported-import-equals-alias",
          `unknown import-equals alias ${node.name.text}: unsupported entity-name module reference`,
          { subject: node.name.text },
        );
      }
      return;
    }
    if (ts.isExportAssignment(node) && node.isExportEquals) {
      if (!hasKnownDeclaration(resolvedAlias(node.expression))) {
        error(
          id,
          "unresolved-export-equals-reference",
          `unknown/unresolved export-equals reference ${node.expression.getText()}`,
          { subject: node.getStart() },
        );
      }
      // Exporting a callable creates a binding, not a production consumer.
      // Consumers resolve the alias through reference(), above.
      return;
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        moduleLoad(id, node, node.arguments[0], "dynamic import");
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        // Includes locally supplied require bindings: an unproven target must
        // not disappear merely because a factory provided the loader.
        moduleLoad(id, node, node.arguments[0], "require");
      }
    }
    if (
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    )
      return;
    if (ts.isIdentifier(node)) {
      // Declaration names and plain property keys are not value references.
      const p = node.parent;
      if (p.name === node && !ts.isShorthandPropertyAssignment(p) && !ts.isPropertyAccessExpression(p)) return;
      if (ts.isPropertyAccessExpression(p) && p.name === node) {
        // Namespace members are real imported references; arbitrary method
        // dispatch is outside this top-level static reference graph.
        if (!ts.isIdentifier(p.expression)) return;
        const ns = checker.getSymbolAtLocation(p.expression);
        if (!ns?.declarations?.some((decl) => ts.isNamespaceImport(decl) || ts.isImportEqualsDeclaration(decl))) return;
        reference(id, node);
        if (!checker.getSymbolAtLocation(node) && relativeImport(ns)) {
          error(id, "unresolved-namespace-edge", `unresolved namespace edge ${p.getText()}`, { subject: p.getStart() });
        }
        return;
      }
      // A namespace binding itself is not a callable edge; ns.member above
      // resolves the specific member rather than keeping an entire module live.
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol?.declarations?.some(ts.isNamespaceImport)) reference(id, node);
    }
    ts.forEachChild(node, (child) => visit(id, child));
  };
  for (const [node, id] of owners) {
    if (ts.isSourceFile(node)) {
      for (const stmt of node.statements) {
        if (
          ts.isImportDeclaration(stmt) &&
          !stmt.importClause &&
          ts.isStringLiteral(stmt.moduleSpecifier) &&
          stmt.moduleSpecifier.text.startsWith(".")
        ) {
          const target = resolveModule(node.fileName, stmt.moduleSpecifier.text);
          if (target && graph.has(`${rel(target)}#<module>`)) edge(id, `${rel(target)}#<module>`);
        }
        if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) continue;
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            const target = owners.get(decl);
            if (target && !callables.has(target)) edge(id, target);
            else if (!target) visit(id, decl);
          }
        } else visit(id, stmt);
      }
    } else {
      edge(id, `${rel(node.getSourceFile().fileName)}#<module>`);
      visit(id, node);
    }
  }
  const pathsFromRoots = (cut) => {
    const parent = new Map();
    const queue = [];
    for (const root of PRODUCTION_ROOTS) {
      if (callables.has(root) && !cut.has(root)) {
        parent.set(root, null);
        queue.push(root);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      for (const target of graph.get(queue[i]) ?? []) {
        if (!graph.has(target))
          error(queue[i], "unresolved-graph-edge", `unresolved graph edge ${target}`, { subject: target });
        else if (!cut.has(target) && !parent.has(target)) {
          parent.set(target, queue[i]);
          queue.push(target);
        }
      }
    }
    return parent;
  };
  const full = pathsFromRoots(new Set());
  const cut = pathsFromRoots(CUT);
  const pathTo = (parents, target) => {
    if (!parents.has(target)) return null;
    const result = [];
    for (let id = target; id !== null; id = parents.get(id)) result.push(id);
    return result.reverse();
  };
  const structuralFailures = PRODUCTION_ROOTS.filter((id) => !callables.has(id)).map(
    (id) => `missing production root ${id}`,
  );
  for (const root of PRODUCTION_ROOTS) {
    const [file, name] = root.split("#");
    const sf = program.getSourceFile(path.join(ROOT, file));
    const module = sf && checker.getSymbolAtLocation(sf);
    const exported = module && checker.getExportsOfModule(module).find((symbol) => symbol.name === name);
    if (!exported) {
      structuralFailures.push(`missing public production export ${root}`);
    } else {
      const binding = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      if (!binding.declarations?.some((declaration) => declarationTarget(declaration) === root)) {
        structuralFailures.push(`public production export does not resolve to root ${root}`);
      }
    }
  }
  const functions = MOVED_FUNCTIONS.map(({ original, canonical }) => {
    const canonicalFile = canonical.split("#")[0];
    const relocated = graph.has(`${canonicalFile}#<module>`);
    const target = relocated ? canonical : original;
    if (!callables.has(target)) structuralFailures.push(`missing moved function ${target}`);
    if (relocated && callables.has(original)) structuralFailures.push(`duplicate moved implementation ${original}`);
    const fullProductionPath = pathTo(full, target);
    const legacyDispatchCutPath = pathTo(cut, target);
    if (!fullProductionPath) structuralFailures.push(`no production reference path to ${target}`);
    return {
      original,
      canonical,
      target,
      fullProductionPath,
      legacyDispatchCutPath,
      classification: !fullProductionPath ? "unreferenced" : legacyDispatchCutPath ? "survivor" : "legacy-only",
    };
  });
  if (full.size === 0 || functions.length !== 6) structuralFailures.push("empty/incomplete moved-runtime report");
  const reachableDiagnostics = diagnostics.filter(({ owner }) => full.has(owner));
  // Human output keeps its historical grouping. Admission uses the structured
  // diagnostic IDs below; formatting/deduplication cannot change a verdict.
  const diagnosticMessages = (rows) => {
    const byOwner = new Map();
    for (const diagnostic of rows) {
      if (!byOwner.has(diagnostic.owner)) byOwner.set(diagnostic.owner, new Set());
      byOwner.get(diagnostic.owner).add(diagnostic.message);
    }
    return [...byOwner].flatMap(([owner, messages]) => [...messages].map((message) => `${owner}: ${message}`));
  };
  const failures = [...structuralFailures, ...diagnosticMessages(reachableDiagnostics)];
  const provenance = extensionReceipts({ checker, sourceFiles, moduleLoads, diagnostics, full, cut });
  const recordedDiagnostics = new Set(provenance.receipts.map((receipt) => receipt.diagnosticId));
  const unrecordedDiagnostics = reachableDiagnostics.filter((diagnostic) => !recordedDiagnostics.has(diagnostic.id));
  const preservationFailures = [
    ...provenance.failures,
    ...structuralFailures,
    ...diagnosticMessages(unrecordedDiagnostics),
  ];
  const fullWitnessCount = functions.filter((fn) => fn.fullProductionPath).length;
  const cutWitnessCount = functions.filter((fn) => fn.legacyDispatchCutPath).length;
  if (fullWitnessCount !== 6 || full.size === 0)
    preservationFailures.push("preservation requires 6/6 full source witnesses");
  if (cutWitnessCount !== 6 || cut.size === 0)
    preservationFailures.push("preservation requires 6/6 dispatch-cut source witnesses");
  const strictOK = structuralFailures.length === 0 && reachableDiagnostics.length === 0;
  const preservationSourceIntegrityOK =
    provenance.failures.length === 0 &&
    structuralFailures.length === 0 &&
    unrecordedDiagnostics.length === 0 &&
    fullWitnessCount === 6 &&
    cutWitnessCount === 6 &&
    full.size > 0 &&
    cut.size > 0;
  return {
    roots: PRODUCTION_ROOTS,
    evidence: "static production references; not execution or standalone/IR-only completion",
    fullProduction: { reachableNodes: full.size, witnessCount: fullWitnessCount },
    legacyDispatchCut: {
      cut: [...CUT],
      reachableNodes: cut.size,
      witnessCount: cutWitnessCount,
      moduleLoads: moduleLoads.filter(({ from }) => cut.has(from)),
      diagnostics: diagnostics.filter(({ owner }) => cut.has(owner)),
    },
    externalReferences: [...externalReferences]
      .filter(([from]) => full.has(from))
      .flatMap(([from, targets]) => [...targets].map((to) => ({ from, to }))),
    moduleLoads: moduleLoads.filter(({ from }) => full.has(from)),
    diagnostics: reachableDiagnostics,
    structuralFailures,
    graphState: strictOK ? "MODELED-SOURCE-RESOLVED" : "OPEN",
    closureCertified: false,
    retirementCertified: false,
    externalResolutionIsRuntimeClosure: false,
    preservation: {
      contract: "preservation-v1",
      scope: "source-reference-preservation-only",
      expectedSymbols: 6,
      fullWitnessCount,
      cutWitnessCount,
      receipts: provenance.receipts,
      unrecordedDiagnostics,
      sourceIntegrityOK: preservationSourceIntegrityOK,
      failures: preservationFailures,
      // The old ratchet is joined below, before any report/verdict is emitted.
      ok: false,
    },
    functions,
    failures,
    ok: strictOK,
  };
}
const movedRuntime = movedRuntimeReport();

// --why <substr>: print a shortest survivor-path to each matching node.
const whyIdx = process.argv.indexOf("--why");
if (whyIdx > -1 && !process.argv.includes("--check")) {
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
let baseline;
try {
  const entries = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry !== "string") ||
    new Set(entries).size !== entries.length
  ) {
    throw new Error("invalid dead-export baseline");
  }
  baseline = new Set(entries);
} catch {
  movedRuntime.preservation.failures.push("missing/unreadable dead-export baseline");
}
const added = baseline ? currentDead.filter((id) => !baseline.has(id)) : null;
const removed = baseline ? [...baseline].filter((id) => !currentDead.includes(id)) : null;
const oldRatchet = {
  baselineCount: baseline?.size ?? null,
  currentCount: currentDead.length,
  added,
  removed,
  ok: !!baseline && added.length === 0,
  unchanged: !!baseline && added.length === 0 && removed.length === 0,
};
if (baseline && !oldRatchet.unchanged)
  movedRuntime.preservation.failures.push("preservation requires an unchanged old dead-export ratchet");
movedRuntime.preservation.oldRatchet = oldRatchet;
movedRuntime.preservation.ok = movedRuntime.preservation.sourceIntegrityOK && oldRatchet.unchanged;
mkdirSync(path.dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify({ cut: [...CUT], perFile, movedRuntime }, null, 1));
if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, JSON.stringify(currentDead, null, 1) + "\n");
  console.log(`dead-export baseline updated: ${currentDead.length} entries`);
  process.exit(0);
}
if (process.argv.includes("--check")) {
  if (!movedRuntime.ok) {
    console.error("moved-runtime gate: FAIL (production-rooted evidence incomplete)");
    for (const failure of movedRuntime.failures) console.error(`  ${failure}`);
  } else {
    console.log(`moved-runtime gate: OK (6/6 production paths from ${PRODUCTION_ROOTS.join(", ")})`);
  }
  if (!baseline) {
    console.error(`dead-export gate: missing/unreadable ${rel(BASELINE_PATH)} — run with --update to seed it.`);
    process.exit(1);
  }
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
  if (movedReferenceContract === "preservation-v1") {
    const preservation = movedRuntime.preservation;
    console.log(
      `preservation-only ${preservation.ok ? "PASS" : "FAIL"}: ${preservation.fullWitnessCount}/6 full source witnesses, ${preservation.cutWitnessCount}/6 cut witnesses`,
    );
    console.log(`graph ${movedRuntime.graphState}; strict modeled closure ${movedRuntime.ok ? "PASS" : "FAIL"}`);
    console.log("retirement/deletion NOT CERTIFIED");
    for (const failure of preservation.failures) console.error(`  preservation: ${failure}`);
    process.exit(preservation.ok ? 0 : 1);
  }
  if (!movedRuntime.ok) process.exit(1);
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
