import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadLitUpstreamSuitePin() {
  return JSON.parse(readFileSync(join(HERE, "lit-upstream-suite-pin.json"), "utf-8"));
}

function sha1(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

// The three tarballs that actually contain lit's implementation. `lit` itself
// ships a barrel that re-exports them, so compiling `lit/index.js` compiles
// nothing — these are the published bytes under test.
export function setupLitImplementation({ force = false } = {}) {
  const pin = loadLitUpstreamSuitePin();
  const root = join(HERE, ".lit-implementation");
  const nodeModules = join(root, "node_modules");

  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });

  const packages = [];
  for (const entry of pin.implementation) {
    const tarballPath = resolve(HERE, entry.tarball);
    if (!existsSync(tarballPath)) {
      throw new Error(`[dogfood] pinned ${entry.name} tarball missing at ${tarballPath}`);
    }
    const actualSha1 = sha1(readFileSync(tarballPath));
    if (actualSha1 !== entry.shasum) {
      throw new Error(
        `[dogfood] ${entry.name} tarball integrity mismatch.\n` +
          `  expected sha1 ${entry.shasum}\n` +
          `  got      sha1 ${actualSha1}`,
      );
    }

    const packageRoot = join(root, entry.linkAs.replace("/", "__"));
    const entryModulePath = join(packageRoot, entry.entryModule);
    if (!existsSync(entryModulePath)) {
      mkdirSync(packageRoot, { recursive: true });
      execFileSync("tar", ["-xzf", tarballPath, "-C", packageRoot], { stdio: "pipe" });
    }
    if (!existsSync(entryModulePath)) {
      throw new Error(`[dogfood] extraction did not produce ${entry.entryModule} under ${packageRoot}`);
    }
    packages.push({ ...entry, packageRoot, packageDir: join(packageRoot, "package"), entryModulePath });
  }

  // A real `node_modules` layout so the bundler resolves each package through
  // its OWN published `exports` map rather than through a hand-rolled path
  // rewrite that could silently pick a file npm would never serve.
  rmSync(nodeModules, { recursive: true, force: true });
  mkdirSync(join(nodeModules, "@lit"), { recursive: true });
  for (const entry of packages) symlinkSync(entry.packageDir, join(nodeModules, entry.linkAs));

  return { root, nodeModules, packages, pin };
}

// lit's tests ship in no tarball. Acquire the exact monorepo tag that produced
// the pinned packages and verify its immutable commit before any test is
// attributed to upstream lit.
export function setupLitUpstreamSuite({ force = false } = {}) {
  const pin = loadLitUpstreamSuitePin();
  const root = join(HERE, ".lit-upstream-suite");

  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (!existsSync(join(root, ".git"))) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repo, root], { stdio: "pipe" });
  }

  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (commit !== pin.commit) {
    throw new Error(
      `[dogfood] lit upstream-suite checkout integrity mismatch.\n` +
        `  expected ${pin.commit} (tag ${pin.tag})\n` +
        `  got      ${commit}`,
    );
  }

  // The tag must carry the same versions the tarball pins name, or the tests
  // and the implementation under test are not the same lit.
  for (const entry of pin.implementation) {
    const manifest = join(root, "packages", entry.name === "@lit/reactive-element" ? "reactive-element" : entry.name, "package.json");
    const version = JSON.parse(readFileSync(manifest, "utf-8")).version;
    if (version !== entry.version) {
      throw new Error(
        `[dogfood] lit version skew: tag ${pin.tag} carries ${entry.name}@${version} ` +
          `but the pinned tarball is ${entry.name}@${entry.version}`,
      );
    }
  }

  const testPaths = pin.testFiles.map((file) => join(root, file));
  for (const file of testPaths) {
    if (!existsSync(file)) throw new Error(`[dogfood] lit source pin is missing expected test file ${file}`);
  }
  return { root, pin, testPaths };
}
