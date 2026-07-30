// Deterministic ESLint acquisition for the npm-compat dogfood harness.
//
// ESLint differs from the existing single-bundle packages: lib/api.js expands
// into a large CommonJS dependency graph. The committed registry tarball is
// still the source-of-truth pin. We extract it, verify its canonical sha1, and
// compare every published file with the installed eslint devDependency before
// returning the installed entry path. The installed path is necessary because
// pnpm exposes ESLint's dependency graph relative to that importer context.
// Thus the compiler reads bytes proven identical to the pinned tarball while
// retaining the real package-resolution environment.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../..");
const requireFromHere = createRequire(import.meta.url);

/** @returns {{name:string,version:string,tarball:string,shasum:string,integrity:string,entryModule:string}} */
export function loadPin() {
  return JSON.parse(readFileSync(join(HERE, "eslint-pin.json"), "utf-8"));
}

function sha1(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

function listFiles(root, directory = root, files = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) listFiles(root, path, files);
    else if (stat.isFile()) files.push(relative(root, path));
  }
  return files;
}

function resolveInstalledRoot() {
  const logicalRoot = resolve(REPOSITORY_ROOT, "node_modules/eslint");
  if (existsSync(join(logicalRoot, "package.json"))) return logicalRoot;
  try {
    return dirname(requireFromHere.resolve("eslint/package.json"));
  } catch {
    throw new Error("[dogfood] eslint devDependency is unavailable; run pnpm install before the ESLint harness");
  }
}

function verifyInstalledPayload(pinnedRoot, installedRoot, pin) {
  const installedPackage = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf-8"));
  if (installedPackage.version !== pin.version) {
    throw new Error(
      `[dogfood] installed eslint version mismatch: expected ${pin.version}, got ${installedPackage.version}`,
    );
  }

  const mismatches = [];
  for (const relativePath of listFiles(pinnedRoot)) {
    const pinnedPath = join(pinnedRoot, relativePath);
    const installedPath = join(installedRoot, relativePath);
    if (!existsSync(installedPath)) {
      mismatches.push(`${relativePath}: missing from installed package`);
      continue;
    }
    const pinned = readFileSync(pinnedPath);
    const installed = readFileSync(installedPath);
    if (!pinned.equals(installed)) mismatches.push(`${relativePath}: bytes differ`);
    if (mismatches.length >= 10) break;
  }
  if (mismatches.length > 0) {
    throw new Error(
      `[dogfood] installed eslint payload does not match the pinned npm tarball:\n${mismatches
        .map((value) => `  - ${value}`)
        .join("\n")}`,
    );
  }
}

/**
 * @param {{force?: boolean}} [options]
 * @returns {{root:string, pinnedRoot:string, entryModulePath:string, version:string, pin:object}}
 */
export function setupEslint(options = {}) {
  const pin = loadPin();
  const tarballPath = resolve(HERE, pin.tarball);
  if (!existsSync(tarballPath)) {
    throw new Error(
      `[dogfood] pinned eslint tarball missing at ${tarballPath} — it must be committed (see eslint-pin.json)`,
    );
  }

  const buffer = readFileSync(tarballPath);
  const actualSha1 = sha1(buffer);
  if (actualSha1 !== pin.shasum) {
    throw new Error(
      `[dogfood] eslint tarball integrity mismatch.\n` +
        `  expected sha1 ${pin.shasum}\n` +
        `  got      sha1 ${actualSha1}`,
    );
  }

  const extractionRoot = join(HERE, ".eslint");
  const pinnedRoot = join(extractionRoot, "package");
  if (options.force && existsSync(extractionRoot)) rmSync(extractionRoot, { recursive: true, force: true });
  if (!existsSync(join(pinnedRoot, "package.json"))) {
    mkdirSync(extractionRoot, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", extractionRoot], { stdio: "pipe" });
  }

  const installedRoot = resolveInstalledRoot();
  verifyInstalledPayload(pinnedRoot, installedRoot, pin);
  const installedRelativeEntry = pin.entryModule.replace(/^package\//, "");
  const entryModulePath = join(installedRoot, installedRelativeEntry);
  if (!existsSync(entryModulePath)) {
    throw new Error(`[dogfood] eslint entry module not found at ${entryModulePath}`);
  }

  return {
    root: installedRoot,
    pinnedRoot,
    entryModulePath,
    version: pin.version,
    pin,
  };
}
