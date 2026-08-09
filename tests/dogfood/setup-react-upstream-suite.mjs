import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadReactUpstreamSuitePin() {
  return JSON.parse(readFileSync(join(HERE, "react-upstream-suite-pin.json"), "utf-8"));
}

function readReactUpstreamSuiteCheckoutCommit(root) {
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

/**
 * Check the checkout itself, rather than only checking that `.git` exists.
 *
 * A generated suite can be left behind as a directory containing a copied
 * `.git` entry (or a worktree whose HEAD was removed).  `existsSync(root/.git)`
 * used to accept that state and the subsequent `git rev-parse` then failed
 * before the harness could repair it.  Comparing the repository root also
 * prevents accidentally accepting a parent checkout through Git's upward
 * search.
 */
export function isReactUpstreamSuiteCheckoutValid(root, expectedCommit) {
  return readReactUpstreamSuiteCheckoutCommit(root) === expectedCommit;
}

// React's published tarball omits its Jest tests. Acquire only the exact
// source tag that supplies the selected public-API vectors, then verify HEAD
// before any test is attributed to upstream React.
export function setupReactUpstreamSuite({ force = false } = {}) {
  const pin = loadReactUpstreamSuitePin();
  const root = join(HERE, ".react-upstream-suite");

  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  // Recover malformed generated checkouts (for example a stale directory with
  // no HEAD) by removing only this cache and recloning the pinned source.
  // A malformed/missing checkout is repaired automatically.  A valid checkout
  // at the wrong revision is not silently replaced: it remains an integrity
  // error below, preserving the old fail-closed pin behavior.
  if (readReactUpstreamSuiteCheckoutCommit(root) === null) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repo, root], { stdio: "pipe" });
  }

  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (commit !== pin.commit) {
    throw new Error(
      `[dogfood] React upstream-suite checkout integrity mismatch.\n` +
        `  expected ${pin.commit} (tag ${pin.tag})\n` +
        `  got      ${commit}`,
    );
  }

  const testPaths = pin.testFiles.map((file) => join(root, file));
  for (const file of testPaths) {
    if (!existsSync(file)) throw new Error(`[dogfood] React source pin is missing expected test file ${file}`);
  }
  return { root, pin, testPaths };
}
