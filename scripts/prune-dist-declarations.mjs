#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6794 — vite-plugin-dts emits a declaration for EVERY src/ module (~1,780
// files, 5.4 MB), but the package's public surface is the handful of entries
// whose `types` package.json advertises. Keep only the declarations those
// entries reach through their imports and delete the rest, so every shipped
// .d.ts still resolves. (`build:jsr` prunes its own, narrower closure in
// scripts/prepare-jsr-dist.mjs.)

import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");
const resolutionOptions = {
  allowJs: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

/** Every `types` path package.json advertises (top level + each export). */
function entryDeclarations() {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const found = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "types" && typeof value === "string") found.add(resolve(ROOT, value));
      else visit(value);
    }
  };
  if (typeof pkg.types === "string") found.add(resolve(ROOT, pkg.types));
  visit(pkg.exports);
  return [...found];
}

function insideDist(path) {
  const rel = relative(DIST, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function closure(entries) {
  const kept = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (kept.has(file)) continue;
    if (!existsSync(file)) throw new Error(`declaration entry/import is missing: ${relative(ROOT, file)}`);
    kept.add(file);
    const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const imported of info.importedFiles) {
      const hit = ts.resolveModuleName(imported.fileName, file, resolutionOptions, ts.sys).resolvedModule;
      if (hit && !hit.isExternalLibraryImport && insideDist(hit.resolvedFileName))
        queue.push(resolve(hit.resolvedFileName));
    }
    for (const referenced of info.referencedFiles) {
      const target = resolve(dirname(file), referenced.fileName);
      if (insideDist(target)) queue.push(target);
    }
  }
  return kept;
}

function listDeclarations(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) listDeclarations(path, out);
    else if (entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Remove directories left empty by the prune (deepest first). */
function removeEmptyDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(resolve(dir, entry.name));
  }
  if (dir !== DIST && readdirSync(dir).length === 0) rmdirSync(dir);
}

const entries = entryDeclarations();
const all = listDeclarations(DIST);
const kept = closure(entries);
for (const file of all) if (!kept.has(file)) unlinkSync(file);
removeEmptyDirs(DIST);
console.log(
  `dist declarations: kept ${kept.size} reachable from ${entries.length} package entries, removed ${all.length - kept.size}`,
);
