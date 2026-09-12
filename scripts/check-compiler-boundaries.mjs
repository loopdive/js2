#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// D0 is a complete inventory and a fail-closed separation detector, not a ratchet.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { readFileSync, readdirSync, realpathSync, statSync, lstatSync } from "node:fs";
import { dirname, resolve, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const slash = (path) => path.split(sep).join("/");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const within = (path, root) => path === root || path.startsWith(root + sep);
const safePath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !isAbsolute(path) &&
  !path.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "");
const packageName = (name) => (name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]);

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    });
  } catch {
    return undefined;
  }
}

function read(path) {
  // Deterministic even under a privileged test runner; still propagate real I/O errors.
  if ((statSync(path).mode & 0o444) === 0) throw new Error("input has no read permission bits");
  return readFileSync(path, "utf8");
}

function references(file, options) {
  const edges = [];
  const add = (node, specifier, syntax, typeOnly = false) => {
    const usage =
      node.moduleSpecifier ?? node.arguments?.[0] ?? node.moduleReference?.expression ?? node.argument?.literal;
    edges.push({
      specifier,
      syntax,
      typeOnly,
      resolutionMode: usage ? ts.getModeForUsageLocation(file, usage, options) : undefined,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    });
  };
  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        !!clause?.isTypeOnly ||
        !!(
          clause &&
          !clause.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length &&
          named.elements.every((item) => item.isTypeOnly)
        );
      add(node, literal(node.moduleSpecifier), clause ? "import" : "side-effect-import", typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause;
      const typeOnly =
        !!node.isTypeOnly ||
        !!(
          named &&
          ts.isNamedExports(named) &&
          named.elements.length &&
          named.elements.every((item) => item.isTypeOnly)
        );
      add(node, literal(node.moduleSpecifier), named ? "export-from" : "export-star", typeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, literal(node.moduleReference.expression), "import-equals", !!node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : null, "import-type", true);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, literal(node.arguments[0]), "dynamic-import");
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require")
        add(node, literal(node.arguments[0]), "require");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const ref of file.referencedFiles) add(file, ref.fileName, "reference-path", true);
  for (const ref of file.typeReferenceDirectives) add(file, ref.fileName, "reference-types", true);
  return edges;
}

function validatePolicy(policy, error) {
  if (policy.schema !== "compiler-boundaries-v1") error("policy-schema", "expected compiler-boundaries-v1");
  if (!safePath(policy.sourceRoot) || !safePath(policy.tsconfig))
    error("policy-path", "sourceRoot and tsconfig must be relative paths");
  for (const key of ["layers", "files", "nonModules", "externalPackages", "moves", "evidence", "activationHistory"])
    if (!Array.isArray(policy[key])) error("policy-shape", key + " must be an array");
  if (
    !Array.isArray(policy.moduleExtensions) ||
    ![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].every((extension) =>
      policy.moduleExtensions?.includes(extension),
    )
  )
    error("policy-extensions", "all supported JS/TS module variants are required");
  if (!policy.allowedEdges || typeof policy.allowedEdges !== "object")
    error("policy-edges", "allowedEdges is required");
  for (const asset of policy.externalAssets ?? []) {
    if (!safePath(asset.path) || !asset.reason || !Array.isArray(asset.layers) || !asset.path.endsWith(".json"))
      error("external-asset-policy", "only explicitly classified JSON metadata may escape the source root");
  }
}

function buildPolicyIndex(policy, error) {
  const layers = new Map();
  for (const layer of policy.layers) {
    if (!layer.id || layers.has(layer.id)) error("duplicate-layer", layer.id);
    if (
      !["planned", "active", "debt"].includes(layer.status) ||
      !Array.isArray(layer.roots) ||
      !layer.roots.every(safePath)
    )
      error("invalid-layer", layer.id);
    if (
      layer.status !== "debt" &&
      (!Array.isArray(layer.entries) ||
        !layer.entries.length ||
        !layer.entries.every(safePath) ||
        !Number.isInteger(layer.minModules) ||
        layer.minModules < 1)
    )
      error("invalid-activation", layer.id);
    layers.set(layer.id, layer);
  }
  const files = new Map();
  for (const entry of policy.files) {
    if (!safePath(entry.path) || !entry.path.startsWith(policy.sourceRoot + "/"))
      error("classification-path", entry.path);
    if (files.has(entry.path)) error("duplicate-classification", entry.path);
    if (!layers.has(entry.layer) || !["unmigrated", "clean", "compatibility-adapter"].includes(entry.state))
      error("invalid-classification", entry.path);
    if (entry.layer === "mixed-needs-split" && (!entry.owner || !entry.nextBoundary || !layers.has(entry.destination)))
      error("mixed-owner-required", entry.path);
    files.set(entry.path, entry);
  }
  for (const [from, targets] of Object.entries(policy.allowedEdges)) {
    if (!layers.has(from) || !Array.isArray(targets) || targets.some((target) => !layers.has(target)))
      error("invalid-allowed-edge", from);
  }
  const packages = new Map();
  for (const entry of policy.externalPackages) {
    if (
      !entry.name ||
      packages.has(entry.name) ||
      !Array.isArray(entry.layers) ||
      entry.layers.some((id) => !layers.has(id))
    )
      error("external-policy", entry.name);
    packages.set(entry.name, entry);
  }
  for (const activation of policy.activationHistory) {
    const layer = layers.get(activation.layer);
    if (
      layer?.status !== "active" ||
      layer.minModules < activation.minModules ||
      activation.entries?.some((path) => !layer.entries.includes(path))
    )
      error("activation-demoted", activation.layer);
  }
  return { layers, files, packages };
}

function inventory(root, policy, error) {
  const source = resolve(root, policy.sourceRoot);
  const modules = new Map();
  const assets = [];
  const excluded = new Map(policy.nonModules.map((entry) => [entry.path, entry.reason]));
  if (excluded.size !== policy.nonModules.length) error("duplicate-nonmodule", "duplicate nonmodule policy");
  const modulePath = (path) => policy.moduleExtensions.some((extension) => path.endsWith(extension));
  const walk = (directory, ancestors) => {
    let real;
    try {
      real = realpathSync(directory);
      if (!within(real, realpathSync(source))) {
        error("source-path-escape", slash(relative(root, directory)));
        return;
      }
      if (ancestors.has(real)) {
        error("symlink-cycle", slash(relative(root, directory)));
        return;
      }
      if ((statSync(directory).mode & 0o444) === 0) throw new Error("directory has no read permission bits");
      for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = resolve(directory, item.name);
        const path = slash(relative(root, absolute));
        try {
          const info = statSync(absolute);
          if (info.isDirectory()) {
            walk(absolute, new Set([...ancestors, real]));
            continue;
          }
          if (!info.isFile()) {
            error("unsupported-source-entry", path);
            continue;
          }
          if (!modulePath(path)) {
            const reason = excluded.get(path);
            if (!reason) error("unclassified-nonmodule", path);
            assets.push({ path, reason: reason ?? null, hash: hash(read(absolute)) });
            continue;
          }
          const realPath = realpathSync(absolute);
          if (!within(realPath, realpathSync(source))) {
            error("source-path-escape", path);
            continue;
          }
          const text = read(absolute);
          modules.set(path, {
            path,
            absolute,
            realPath: slash(relative(root, realPath)),
            text,
            hash: hash(text),
            symlink: lstatSync(absolute).isSymbolicLink() || realPath !== absolute,
          });
        } catch (cause) {
          error("unreadable-input", path + ": " + cause.message);
        }
      }
    } catch (cause) {
      error("unreadable-source", slash(relative(root, directory)) + ": " + cause.message);
    }
  };
  walk(source, new Set());
  for (const path of excluded.keys()) {
    if (!assets.some((entry) => entry.path === path)) error("stale-nonmodule", path);
    if (modulePath(path)) error("module-exclusion", path);
  }
  if (!modules.size) error("empty-inventory", "no implementation/type modules visited");
  return { modules, assets };
}

function evidenceReport(policy, modules, error) {
  const moves = new Map();
  for (const move of policy.moves) {
    if (!safePath(move.from) || !safePath(move.to) || moves.has(move.from)) error("invalid-move", move.from);
    moves.set(move.from, move.to);
  }
  return policy.evidence.map((record) => {
    if (
      record.scope !== "external-held-checkpoint" ||
      record.status !== "unresolved" ||
      !record.sourceRevision ||
      !Array.isArray(record.symbols) ||
      record.symbols.length !== record.expectedCount ||
      !record.expectedCount
    )
      error("evidence-policy", record.id + ": D0 cannot settle production evidence");
    const keys = new Set();
    const symbols = (record.symbols ?? []).map((item) => {
      const key = item.originalPath + "#" + item.symbol;
      if (!safePath(item.originalPath) || !item.symbol || keys.has(key)) error("evidence-symbol", key);
      keys.add(key);
      const paths = [item.originalPath, moves.get(item.originalPath)].filter(Boolean);
      const present = paths.filter((path) => modules.has(path));
      const found = present.filter((path) => {
        const tree = ts.createSourceFile(path, modules.get(path).text, ts.ScriptTarget.Latest, true);
        let match = false;
        const visit = (node) => {
          if (
            (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
            node.name?.getText(tree) === item.symbol
          )
            match = true;
          ts.forEachChild(node, visit);
        };
        visit(tree);
        return match;
      });
      if (present.length && !found.length) error("evidence-symbol-missing", key);
      return {
        ...item,
        mappedPaths: paths,
        presentPaths: found,
        status: found.length ? "bound-unresolved" : "external-unbound",
        resolved: false,
      };
    });
    return {
      id: record.id,
      sourceRevision: record.sourceRevision,
      expectedCount: record.expectedCount,
      accounted: symbols.length,
      resolved: 0,
      symbols,
    };
  });
}

/** Both CLI modes and fixture tests use this exact implementation. */
export function checkCompilerBoundaries({
  root = DEFAULT_ROOT,
  config = "scripts/compiler-boundaries.json",
  mode = "complete",
  base,
} = {}) {
  root = resolve(root);
  // macOS temporary/worktree paths may enter through /var or /tmp symlinks.
  try {
    root = realpathSync(root);
  } catch {
    /* Missing roots are reported by inventory. */
  }
  const errors = [];
  const error = (code, detail) => errors.push({ code, detail });
  const report = {
    schema: "compiler-boundary-report-v1",
    mode,
    status: "invalid-inventory",
    architectureComplete: false,
    sourceRevision: git(root, ["rev-parse", "HEAD"])?.trim() ?? null,
    errors,
  };
  if (!["complete", "inventory"].includes(mode)) {
    error("mode", "mode must be complete or inventory");
    return { report, exitCode: 2 };
  }
  let policy;
  const configPath = resolve(root, config);
  try {
    const text = read(configPath);
    report.policyHash = hash(text);
    policy = JSON.parse(text);
  } catch (cause) {
    error("missing-or-invalid-policy", cause.message);
    return { report, exitCode: 2 };
  }
  validatePolicy(policy, error);
  if (errors.length) return { report, exitCode: 2 };
  const { layers, files, packages } = buildPolicyIndex(policy, error);
  if (errors.length) return { report, exitCode: 2 };
  const requestedBase = base ?? "HEAD";
  const baseRevision = git(root, ["rev-parse", "--verify", "--end-of-options", requestedBase + "^{commit}"])?.trim();
  report.comparisonBase = {
    requested: requestedBase,
    revision: baseRevision ?? null,
    policyPresent: null,
    policyHash: null,
  };
  let previousText;
  if (!baseRevision) {
    if (base !== undefined || policy.requireGitProvenance)
      error("comparison-base", "cannot resolve comparison commit " + requestedBase);
  } else {
    const configRelative = slash(relative(root, configPath));
    if (!safePath(configRelative))
      error("comparison-policy-path", "policy must be inside the repository for historical comparison");
    else {
      const entry = git(root, ["ls-tree", "-z", baseRevision, "--", configRelative]);
      if (entry === undefined) error("comparison-policy-read", "cannot inspect policy at comparison commit");
      else if (!entry) report.comparisonBase.policyPresent = false;
      else {
        report.comparisonBase.policyPresent = true;
        previousText = git(root, ["show", baseRevision + ":" + configRelative]);
        if (previousText === undefined)
          error("comparison-policy-read", "cannot read existing policy at comparison commit");
        else report.comparisonBase.policyHash = hash(previousText);
      }
    }
  }
  if (previousText !== undefined) {
    try {
      const previous = JSON.parse(previousText);
      validatePolicy(previous, (code, detail) => error("comparison-" + code, detail));
      for (const prior of previous.layers ?? []) {
        const now = layers.get(prior.id);
        if (
          prior.status === "active" &&
          (now?.status !== "active" ||
            now.minModules < prior.minModules ||
            prior.entries.some((entry) => !now.entries.includes(entry)))
        )
          error("activation-demoted", prior.id);
      }
      for (const prior of previous.evidence ?? []) {
        const now = policy.evidence.find((record) => record.id === prior.id);
        if (
          !now ||
          now.sourceRevision !== prior.sourceRevision ||
          now.expectedCount !== prior.expectedCount ||
          prior.symbols.some(
            (symbol) =>
              !now.symbols.some((item) => item.originalPath === symbol.originalPath && item.symbol === symbol.symbol),
          )
        )
          error("evidence-denominator-changed", prior.id);
      }
    } catch {
      error("previous-policy", "cannot validate prior activation state");
    }
  }
  const { modules, assets } = inventory(root, policy, error);
  for (const path of modules.keys()) if (!files.has(path)) error("unclassified-module", path);
  for (const path of files.keys()) if (!modules.has(path)) error("stale-classification", path);
  const activatedRoots = [];
  const plannedLayers = [];
  for (const layer of layers.values()) {
    const population = [...modules.keys()].filter((path) =>
      layer.roots.some((prefix) => path === prefix || path.startsWith(prefix + "/")),
    );
    if (layer.status === "planned")
      plannedLayers.push({
        layer: layer.id,
        modules: population.length,
        empty: !population.length,
        required: !!layer.required,
        entries: layer.entries,
        minModules: layer.minModules,
      });
    if (layer.status !== "active") continue;
    const visitedEntries = layer.entries.filter((entry) => modules.has(entry));
    activatedRoots.push({
      layer: layer.id,
      entries: layer.entries,
      visitedEntries,
      modules: population.length,
      minModules: layer.minModules,
    });
    if (population.length < layer.minModules || visitedEntries.length !== layer.entries.length)
      error("missing-activated-root", layer.id);
    for (const path of population)
      if (files.get(path)?.state !== "clean" || files.get(path)?.layer !== layer.id)
        error("unclean-active-layer", path);
  }
  for (const entry of files.values())
    if (entry.state === "clean") {
      const layer = layers.get(entry.layer);
      if (
        layer.status !== "active" ||
        !layer.roots.some((prefix) => entry.path.startsWith(prefix + "/") || entry.path === prefix)
      )
        error("clean-outside-active-layer", entry.path);
    }
  const configInputs = new Map();
  const configHost = {
    ...ts.sys,
    readFile(path) {
      try {
        const text = read(path);
        configInputs.set(slash(relative(root, path)), hash(text));
        return text;
      } catch {
        return undefined;
      }
    },
  };
  const loaded = ts.readConfigFile(resolve(root, policy.tsconfig), configHost.readFile);
  if (loaded.error) error("tsconfig", ts.flattenDiagnosticMessageText(loaded.error.messageText, " "));
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config ?? {},
    configHost,
    dirname(resolve(root, policy.tsconfig)),
  );
  for (const diagnostic of parsed.errors)
    error("tsconfig", ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  report.resolver = {
    engine: "typescript",
    version: ts.version,
    options: parsed.options,
    configInputs: Object.fromEntries(configInputs),
  };
  const cache = ts.createModuleResolutionCache(root, (path) => path, parsed.options);
  const edges = [];
  const unknownEdges = [];
  const unresolvedEdges = [];
  const forbiddenEdges = [];
  const enforced = (path) =>
    files.get(path)?.state === "clean" || layers.get(files.get(path)?.layer)?.status === "active";
  const forbidden = (edge, reason) => {
    const violation = { ...edge, reason, enforced: enforced(edge.from) };
    forbiddenEdges.push(violation);
    if (violation.enforced) error("forbidden-clean-edge", edge.from + ": " + reason);
  };
  for (const module of modules.values()) {
    const tree = ts.createSourceFile(module.absolute, module.text, ts.ScriptTarget.Latest, true);
    tree.impliedNodeFormat = ts.getImpliedNodeFormatForFile(module.absolute, undefined, ts.sys, parsed.options);
    for (const diagnostic of tree.parseDiagnostics)
      error("parse-error", module.path + ": " + ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    const refs = references(tree, parsed.options);
    if (module.realPath !== module.path)
      refs.push({ specifier: module.realPath, syntax: "symlink", typeOnly: false, line: 1 });
    for (const ref of refs) {
      const edge = { from: module.path, ...ref };
      if (ref.specifier === null) {
        unknownEdges.push(edge);
        if (enforced(module.path)) error("unknown-clean-edge", module.path + ": " + ref.syntax);
        continue;
      }
      let resolved;
      if (ref.syntax === "symlink") resolved = { resolvedFileName: resolve(root, ref.specifier) };
      else if (ref.syntax === "reference-path")
        resolved = { resolvedFileName: resolve(dirname(module.absolute), ref.specifier) };
      else if (isBuiltin(ref.specifier))
        resolved = { builtin: ref.specifier.startsWith("node:") ? ref.specifier : "node:" + ref.specifier };
      else if (ref.syntax === "reference-types")
        resolved = ts.resolveTypeReferenceDirective(
          ref.specifier,
          module.absolute,
          parsed.options,
          ts.sys,
        ).resolvedTypeReferenceDirective;
      else
        resolved = ts.resolveModuleName(
          ref.specifier,
          module.absolute,
          parsed.options,
          ts.sys,
          cache,
          undefined,
          ref.resolutionMode,
        ).resolvedModule;
      if (!resolved) {
        unresolvedEdges.push(edge);
        error("unresolved-module", module.path + ": " + ref.specifier);
        continue;
      }
      let target;
      try {
        target = resolved.builtin ? undefined : realpathSync(resolved.resolvedFileName);
      } catch {
        unresolvedEdges.push(edge);
        error("unreadable-target", module.path + ": " + ref.specifier);
        continue;
      }
      if (target && within(target, resolve(root, policy.sourceRoot))) {
        edge.to = slash(relative(root, target));
        if (!modules.has(edge.to) || !files.has(edge.to)) {
          error("unclassified-target", edge.to);
          unresolvedEdges.push(edge);
          continue;
        }
        edge.targetLayer = files.get(edge.to).layer;
        const sourceLayer = files.get(edge.from)?.layer;
        if (!(policy.allowedEdges[sourceLayer] ?? []).includes(edge.targetLayer))
          forbidden(edge, "layer " + sourceLayer + " -> " + edge.targetLayer);
        if (enforced(edge.from) && files.get(edge.to).state !== "clean")
          forbidden(edge, "clean layer reaches migration debt");
        if (edge.to === policy.frontendWrapper && sourceLayer !== "frontend-ts")
          forbidden(edge, "frontend wrapper is frontend-only, including types");
      } else if (target && policy.externalAssets?.some((asset) => resolve(root, asset.path) === target)) {
        const asset = policy.externalAssets.find((asset) => resolve(root, asset.path) === target);
        edge.asset = asset.path;
        edge.contentHash = hash(read(target));
        if (!asset.layers.includes(files.get(edge.from)?.layer))
          forbidden(edge, "external asset is forbidden in this layer");
      } else if (
        resolved.builtin ||
        (!ref.specifier.startsWith(".") &&
          (resolved.isExternalLibraryImport || target?.includes(sep + "node_modules" + sep)))
      ) {
        edge.external = resolved.builtin ?? resolved.packageId?.name ?? packageName(ref.specifier);
        edge.resolvedPath = resolved.builtin ?? slash(relative(root, target));
        const rule = packages.get(edge.external) ?? (resolved.builtin ? packages.get("node:*") : undefined);
        if (!rule) {
          error("unclassified-external", edge.external);
          forbidden(edge, "no external package policy");
        } else if (!rule.layers.includes(files.get(edge.from)?.layer))
          forbidden(edge, "external package is forbidden in this layer");
        if (["typescript", "typescript7"].includes(edge.external) && files.get(edge.from)?.layer !== "frontend-ts")
          forbidden(edge, "parser/checker packages are frontend-only, including types");
      } else {
        edge.to = target ? slash(relative(root, target)) : null;
        forbidden(edge, "source path escape");
        error("source-path-escape", edge.from + ": " + ref.specifier);
      }
      edges.push(edge);
    }
  }
  const adjacency = new Map();
  const terminals = new Map();
  for (const edge of [...edges.filter((edge) => edge.external || edge.asset), ...unknownEdges, ...unresolvedEdges]) {
    if (!terminals.has(edge.from)) terminals.set(edge.from, []);
    terminals.get(edge.from).push(edge);
  }
  for (const edge of edges)
    if (edge.to && modules.has(edge.to)) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      adjacency.get(edge.from).push(edge);
    }
  const transitiveViolations = [];
  for (const start of modules.keys()) {
    if (!enforced(start)) continue;
    const queue = [[start, [start]]];
    const seen = new Set([start]);
    for (let i = 0; i < queue.length; i++) {
      const [node, path] = queue[i];
      const startLayer = files.get(start)?.layer;
      for (const edge of terminals.get(node) ?? []) {
        const rule = edge.asset
          ? policy.externalAssets.find((asset) => asset.path === edge.asset)
          : (packages.get(edge.external) ?? (edge.external?.startsWith("node:") ? packages.get("node:*") : undefined));
        if (
          !rule?.layers.includes(startLayer) ||
          (["typescript", "typescript7"].includes(edge.external) && startLayer !== "frontend-ts")
        ) {
          const next = [...path, edge.external ?? edge.asset ?? edge.specifier ?? "<unknown dependency>"];
          transitiveViolations.push({ from: start, path: next, typeOnly: edge.typeOnly });
          error("forbidden-transitive-path", next.join(" -> "));
        }
      }
      for (const edge of adjacency.get(node) ?? []) {
        const next = [...path, edge.to];
        if (
          !(policy.allowedEdges[startLayer] ?? []).includes(files.get(edge.to)?.layer) ||
          files.get(edge.to)?.state !== "clean" ||
          (edge.to === policy.frontendWrapper && startLayer !== "frontend-ts")
        ) {
          transitiveViolations.push({ from: start, path: next, typeOnly: edge.typeOnly });
          error("forbidden-transitive-path", next.join(" -> "));
          continue;
        }
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push([edge.to, next]);
        }
      }
    }
  }
  const trackedText = git(root, ["ls-files", "-z", "--", policy.sourceRoot]);
  const tracked = trackedText === undefined ? null : new Set(trackedText.split("\0").filter(Boolean));
  if (policy.requireGitProvenance && (!report.sourceRevision || !tracked))
    error("git-provenance", "source revision/tracked inventory unavailable");
  const counts = {
    total: modules.size,
    tracked: tracked ? [...modules.keys()].filter((path) => tracked.has(path)).length : null,
    untracked: tracked ? [...modules.keys()].filter((path) => !tracked.has(path)).length : null,
    excludedNonModules: assets.length,
    byState: {},
    byLayer: {},
    edgesBySyntax: {},
    edgesByType: { typeOnly: 0, runtime: 0 },
    resolvedEdgesBySyntax: {},
    resolvedEdgesByType: { typeOnly: 0, runtime: 0 },
  };
  for (const path of modules.keys()) {
    const entry = files.get(path);
    counts.byState[entry?.state ?? "unclassified"] = (counts.byState[entry?.state ?? "unclassified"] ?? 0) + 1;
    counts.byLayer[entry?.layer ?? "unclassified"] = (counts.byLayer[entry?.layer ?? "unclassified"] ?? 0) + 1;
  }
  for (const edge of [...edges, ...unknownEdges, ...unresolvedEdges]) {
    counts.edgesBySyntax[edge.syntax] = (counts.edgesBySyntax[edge.syntax] ?? 0) + 1;
    counts.edgesByType[edge.typeOnly ? "typeOnly" : "runtime"]++;
  }
  const evidence = evidenceReport(policy, modules, error);
  for (const edge of edges) {
    counts.resolvedEdgesBySyntax[edge.syntax] = (counts.resolvedEdgesBySyntax[edge.syntax] ?? 0) + 1;
    counts.resolvedEdgesByType[edge.typeOnly ? "typeOnly" : "runtime"]++;
  }
  const debt = [...modules.keys()]
    .filter((path) => files.get(path)?.state !== "clean" || files.get(path)?.layer === "mixed-needs-split")
    .map((path) => ({ ...files.get(path), path }));
  report.dirtyContentFingerprint = hash(
    JSON.stringify({
      modules: [...modules.values()].map(({ path, realPath, hash }) => ({ path, realPath, hash })),
      policyHash: report.policyHash,
      configInputs: report.resolver.configInputs,
      assets,
      externalAssets: edges.filter((edge) => edge.asset),
    }),
  );
  Object.assign(report, {
    counts,
    edges,
    modules: [...modules.values()].map(({ path, realPath, hash }) => ({
      ...files.get(path),
      path,
      realPath,
      hash,
      tracked: tracked ? tracked.has(path) : null,
    })),
    resolvedEdgeCount: edges.length,
    unknownEdges,
    unresolvedEdges,
    forbiddenEdges,
    transitiveViolations,
    plannedLayers,
    plannedEmptyLayers: plannedLayers.filter((layer) => layer.empty),
    activatedRoots,
    debt,
    excludedNonModules: assets,
    evidence,
    graphComplete: !unknownEdges.length && !unresolvedEdges.length,
    inventoryValid: !errors.length,
  });
  report.architectureComplete =
    report.inventoryValid &&
    !debt.length &&
    !plannedLayers.some((layer) => layer.required) &&
    !unknownEdges.length &&
    !unresolvedEdges.length &&
    !forbiddenEdges.length &&
    !evidence.some((record) => record.accounted > record.resolved);
  report.status = !report.inventoryValid
    ? "invalid-inventory"
    : report.architectureComplete
      ? "architecture-complete"
      : "inventory-valid-architecture-incomplete";
  return { report, exitCode: report.inventoryValid && (mode === "inventory" || report.architectureComplete) ? 0 : 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--json") continue;
      if (!["--root", "--config", "--mode", "--base"].includes(args[i]) || !args[i + 1])
        throw new Error("unknown or incomplete option " + args[i]);
      options[args[i].slice(2)] = args[++i];
    }
    const { report, exitCode } = checkCompilerBoundaries(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = exitCode;
  } catch (cause) {
    console.log(
      JSON.stringify({
        mode: "unknown",
        status: "checker-error",
        architectureComplete: false,
        errors: [{ code: "checker-error", detail: cause.message }],
      }),
    );
    process.exitCode = 2;
  }
}
