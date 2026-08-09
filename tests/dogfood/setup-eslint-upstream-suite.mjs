import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadEslintUpstreamSuitePin() {
  return JSON.parse(readFileSync(join(HERE, "eslint-upstream-suite-pin.json"), "utf-8"));
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

export function isEslintUpstreamSuiteCheckoutValid(root, expectedCommit) {
  return checkoutCommit(root) === expectedCommit;
}

export function setupEslintUpstreamSuite({ force = false } = {}) {
  const pin = loadEslintUpstreamSuitePin();
  const root = join(HERE, ".eslint-upstream-suite");

  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (checkoutCommit(root) === null) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repo, root], { stdio: "pipe" });
  }

  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (commit !== pin.commit) {
    throw new Error(
      `[dogfood] ESLint upstream-suite checkout integrity mismatch.\n` +
        `  expected ${pin.commit} (tag ${pin.tag})\n` +
        `  got      ${commit}`,
    );
  }

  const testPaths = pin.testFiles.map((file) => join(root, file));
  for (const file of testPaths) {
    if (!existsSync(file)) throw new Error(`[dogfood] ESLint source pin is missing expected test file ${file}`);
  }
  return { root, pin, testPaths };
}
