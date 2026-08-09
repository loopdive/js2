import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const requireFromHere = createRequire(import.meta.url);

function sha1(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

function pinMarkerMatches(markerPath, pin, name) {
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    return (
      marker.name === name &&
      marker.version === pin.version &&
      marker.shasum === pin.shasum &&
      marker.entryModule === pin.entryModule
    );
  } catch {
    return false;
  }
}

/**
 * Expose the installed package's real dependency directory to an extracted
 * tarball.  This matters for pnpm: the package itself is hoisted at
 * `node_modules/<name>`, while its private dependencies live beside it in the
 * store and are not visible from `tests/dogfood/.npm-compat/<name>/package`.
 * The compiler intentionally resolves imports from the fixture's filesystem,
 * so without this link jsdom/ESLint fail for a missing graph before their real
 * compiler frontier is measured.
 */
function resolveInstalledPackageRoot(name) {
  let installedEntry;
  try {
    // Prefer the package entry so this also works for packages whose exports
    // map intentionally blocks `name/package.json` (lit, hono, three, ...).
    installedEntry = requireFromHere.resolve(name);
  } catch {
    return null;
  }

  let directory = dirname(realpathSync(installedEntry));
  while (true) {
    try {
      const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf-8"));
      if (packageJson.name === name) return directory;
    } catch {
      // Keep walking toward the repository root; an entry can sit below the
      // package root in `lib/` or `dist/`.
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function wireInstalledDependencies(root, name, pin) {
  const installedRoot = resolveInstalledPackageRoot(name);
  if (!installedRoot) {
    // Some fixture-only packages are not installed as direct dependencies. A
    // self-contained package remains valid without an importer-context link.
    return null;
  }
  const installedPackage = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf-8"));
  if (installedPackage.name !== name || installedPackage.version !== pin.version) {
    throw new Error(
      `[dogfood] installed ${name} does not match the pinned package: ` +
        `${installedPackage.name}@${installedPackage.version} (expected ${name}@${pin.version})`,
    );
  }
  // In a flat npm tree this is `<project>/node_modules`; in pnpm it is the
  // package's importer directory (`.pnpm/<pkg>/node_modules`) containing the
  // dependency symlinks.  The package-local `node_modules` directory itself
  // may be empty in pnpm and is not the dependency graph we need.
  const installedNodeModules = dirname(installedRoot);
  if (!existsSync(installedNodeModules)) return null;

  const dependencyRoot = join(root, "node_modules");
  let dependencyStat = null;
  try {
    dependencyStat = lstatSync(dependencyRoot);
  } catch {
    // No existing link/directory; create the importer-context link below.
  }
  if (dependencyStat) {
    try {
      if (dependencyStat.isSymbolicLink() && realpathSync(dependencyRoot) === realpathSync(installedNodeModules)) {
        return dependencyRoot;
      }
    } catch {
      // Replace a broken stale link below.
    }
    // Never remove package contents: only a link created by this helper is
    // replaceable, and a real directory is left for the package to own.
    if (!dependencyStat.isSymbolicLink()) return null;
    rmSync(dependencyRoot, { recursive: true, force: true });
  }
  symlinkSync(installedNodeModules, dependencyRoot, "dir");
  return dependencyRoot;
}

export function loadPinnedPackagePin(here, pinFile) {
  return JSON.parse(readFileSync(join(here, pinFile), "utf-8"));
}

export function setupPinnedPackage({
  here,
  name,
  pinFile,
  pin: suppliedPin,
  extractionDirectory,
  force = false,
  allowMissingEntry = false,
}) {
  const pin = suppliedPin ?? loadPinnedPackagePin(here, pinFile);
  const tarballPath = resolve(here, pin.tarball);
  if (!existsSync(tarballPath)) {
    throw new Error(`[dogfood] pinned ${name} tarball missing at ${tarballPath}`);
  }

  const actualSha1 = sha1(readFileSync(tarballPath));
  if (actualSha1 !== pin.shasum) {
    throw new Error(
      `[dogfood] ${name} tarball integrity mismatch.\n` +
        `  expected sha1 ${pin.shasum}\n` +
        `  got      sha1 ${actualSha1}`,
    );
  }

  const root = join(here, extractionDirectory);
  const entryModulePath = join(root, pin.entryModule);
  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  const markerPath = join(root, ".js2-pinned-package.json");
  if (existsSync(entryModulePath) && !pinMarkerMatches(markerPath, pin, name)) {
    // The tarball pin can advance while an ignored extraction cache remains.
    // Do not compile stale bytes just because the old entry path still exists.
    rmSync(root, { recursive: true, force: true });
  }
  if (!existsSync(entryModulePath)) {
    mkdirSync(root, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", root], { stdio: "pipe" });
    writeFileSync(
      markerPath,
      `${JSON.stringify({ name, version: pin.version, shasum: pin.shasum, entryModule: pin.entryModule }, null, 2)}\n`,
    );
  }
  if (!existsSync(entryModulePath) && !allowMissingEntry) {
    throw new Error(`[dogfood] extraction did not produce ${pin.entryModule} under ${root}`);
  }

  const dependencyNodeModulesPath = wireInstalledDependencies(root, name, pin);
  return {
    root,
    entryModulePath,
    entryExists: existsSync(entryModulePath),
    dependencyNodeModulesPath,
    version: pin.version,
    pin,
  };
}
