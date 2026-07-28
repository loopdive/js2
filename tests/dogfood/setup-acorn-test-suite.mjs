// Acquisition for acorn's OWN real test suite (#3729) — a much more
// rigorous conformance check than the hand-written fixture corpus, but a
// DIFFERENT acquisition shape than setup-acorn.mjs's pinned-tarball pattern:
// npm does not publish acorn's `test/` directory (stripped by its package
// `files` field — confirmed empty on the committed tarball), so the test
// suite itself can only come from source.
//
// Pinned by exact commit SHA (acorn-test-suite-pin.json), not just a tag,
// verified post-clone — same integrity discipline as the dist tarball's
// pinned sha1, just via a different mechanism (git, not npm). REQUIRES
// run-time network (a real difference from setup-acorn.mjs's fully offline
// tarball extraction) — this harness cannot run in a fully air-gapped CI
// runner without a registry mirror for `git clone`.
//
// The dist module used to actually COMPILE (and as the native oracle) is
// still the already-integrity-checked npm-pack tarball from setup-acorn.mjs
// — this module only acquires the *test data*, and stitches the pinned dist
// files into the cloned checkout's `acorn/dist/` so the test files' own
// `require("../acorn")` resolves without running acorn's real rollup build
// (avoids pulling acorn's full devDependency tree just to get identical
// bytes we already have, verified, from the npm tarball).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupAcorn } from "./setup-acorn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @returns {{repo:string, tag:string, commit:string}} */
export function loadTestSuitePin() {
  return JSON.parse(readFileSync(join(HERE, "acorn-test-suite-pin.json"), "utf-8"));
}

/**
 * Ensure acorn's own test suite is cloned at the pinned commit, integrity
 * verified, and has a matching dist/ so its test files' internal
 * `require("../acorn")` resolves. Idempotent: reused if the checkout
 * already exists and its HEAD matches the pin.
 *
 * @param {{force?: boolean}} [opts]
 * @returns {{testDir:string, driverPath:string, pin:object}}
 */
export function setupAcornTestSuite(opts = {}) {
  const pin = loadTestSuitePin();
  const root = join(HERE, ".acorn-test-suite");
  const testDir = join(root, "test");
  const driverPath = join(testDir, "driver.js");

  if (opts.force && existsSync(root)) rmSync(root, { recursive: true, force: true });

  if (!existsSync(driverPath)) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repo, root], { stdio: "pipe" });
  }

  // Integrity gate: refuse to run against a checkout that drifted from the pin.
  const gotSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (gotSha !== pin.commit) {
    throw new Error(
      `[dogfood] acorn test-suite checkout integrity mismatch.\n` +
        `  expected commit ${pin.commit} (tag ${pin.tag})\n` +
        `  got      commit ${gotSha}\n` +
        `Refuse to run acorn's test suite against an unverified checkout.`,
    );
  }
  if (!existsSync(driverPath)) {
    throw new Error(`[dogfood] clone did not produce ${driverPath} — check acorn's repo layout at ${pin.tag}.`);
  }

  // Stitch in the already-verified pinned dist (avoids running acorn's own
  // rollup build just to reproduce bytes we already have from setup-acorn.mjs).
  const { root: acornPinnedRoot } = setupAcorn();
  const distSrc = join(acornPinnedRoot, "package", "dist");
  const distDst = join(root, "acorn", "dist");
  mkdirSync(distDst, { recursive: true });
  for (const f of ["acorn.js", "acorn.mjs", "acorn.d.ts", "bin.js"]) {
    const src = join(distSrc, f);
    if (existsSync(src)) copyFileSync(src, join(distDst, f));
  }

  return { testDir, driverPath, pin };
}
