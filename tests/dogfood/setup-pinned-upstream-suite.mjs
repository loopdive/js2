import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

function checkoutCommit(root) {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const topLevel = resolve(
      execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    if (topLevel !== resolve(root)) return null;
    return execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function walk(root, directory, accept, out = []) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(root, path, accept, out);
    else if (entry.isFile() && accept(path)) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

export function inventoryDigest(paths) {
  return createHash("sha256")
    .update(`${[...paths].sort().join("\n")}\n`)
    .digest("hex");
}

export function loadUpstreamSuitePin(here, pinFile) {
  return JSON.parse(readFileSync(join(here, pinFile), "utf-8"));
}

export function isPinnedUpstreamCheckoutValid(root, expectedCommit) {
  return checkoutCommit(root) === expectedCommit;
}

/**
 * Acquire and verify an immutable upstream source tag, then verify the whole
 * unit-test inventory. The inventory hash catches a stale/incomplete checkout
 * without checking test files into this repository.
 */
export function setupPinnedUpstreamSuite({ here, pinFile, cacheDirectory, inventoryDirectory, accept, force = false }) {
  const pin = loadUpstreamSuitePin(here, pinFile);
  const root = join(here, cacheDirectory);

  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (checkoutCommit(root) === null) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(root), { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repo, root], { stdio: "pipe" });
  }

  const commit = checkoutCommit(root);
  if (commit !== pin.commit) {
    throw new Error(
      `[dogfood] ${pin.name} upstream-suite checkout integrity mismatch.\n` +
        `  expected ${pin.commit} (tag ${pin.tag})\n` +
        `  got      ${commit ?? "no commit"}`,
    );
  }

  const testFiles = walk(root, inventoryDirectory, accept).sort();
  const digest = inventoryDigest(testFiles);
  if (testFiles.length !== pin.testFileCount || digest !== pin.testFilePathSha256) {
    throw new Error(
      `[dogfood] ${pin.name} upstream test inventory mismatch.\n` +
        `  expected ${pin.testFileCount} files / ${pin.testFilePathSha256}\n` +
        `  got      ${testFiles.length} files / ${digest}`,
    );
  }

  for (const selected of pin.selectedFiles ?? []) {
    if (!testFiles.includes(selected)) {
      throw new Error(`[dogfood] ${pin.name} selected upstream test is outside the verified inventory: ${selected}`);
    }
  }

  return {
    root,
    pin,
    testFiles,
    testPaths: testFiles.map((file) => join(root, file)),
    selectedPaths: (pin.selectedFiles ?? []).map((file) => join(root, file)),
    relativePath(path) {
      return relative(root, path).replace(/\\/g, "/");
    },
  };
}
