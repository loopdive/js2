import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPSTREAM_CACHE_ROOT = resolve(HERE, "..", "..", ".uuid-upstream-suite");

export function loadUuidUpstreamSuitePin() {
  return JSON.parse(readFileSync(join(HERE, "uuid-upstream-suite-pin.json"), "utf-8"));
}

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

export function isUuidUpstreamSuiteCheckoutValid(root, expectedCommit) {
  return checkoutCommit(root) === expectedCommit;
}

export function setupUuidUpstreamSuite({ force = false } = {}) {
  const pin = loadUuidUpstreamSuitePin();
  const root = UPSTREAM_CACHE_ROOT;

  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (checkoutCommit(root) === null) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repo, root], { stdio: "pipe" });
  }

  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (commit !== pin.commit) {
    throw new Error(
      `[dogfood] uuid upstream-suite checkout integrity mismatch.\n` +
        `  expected ${pin.commit} (tag ${pin.tag})\n` +
        `  got      ${commit}`,
    );
  }

  const testPaths = pin.testFiles.map((file) => join(root, file));
  const helperPaths = pin.helperFiles.map((file) => join(root, file));
  for (const file of [...testPaths, ...helperPaths]) {
    if (!existsSync(file)) throw new Error(`[dogfood] uuid source pin is missing expected file ${file}`);
  }
  return { root, pin, testPaths, helperPaths };
}
